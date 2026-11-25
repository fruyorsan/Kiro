//! Notch AI: ask Claude, ChatGPT or Gemini from the notch and read the answer
//! right there.
//!
//! Claude has two backends and picks one automatically:
//!
//! 1. the Anthropic API when the user stored a key (`kiro-ai-key`), which is a
//!    single HTTPS request from the Kiro process and costs no extra memory;
//! 2. the local Claude Code CLI (`claude -p`) otherwise, so an existing Claude
//!    subscription works without any key.
//!
//! ChatGPT (`kiro-ai-key-openai`) and Gemini (`kiro-ai-key-gemini`) always use
//! their HTTP APIs. The provider is stored in `kiro-ai-provider` and defaults to
//! Claude. `kiro-ai-backend` can force `cli` or `api` for Claude; the default
//! `auto` uses the API key when present and falls back to the CLI.

use serde::Deserialize;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const MAX_PROMPT: usize = 4000;
const CLI_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a single socket read may stall before the request is treated as
/// dead. This is an *idle* timeout, not a deadline for the whole answer:
/// `reqwest`'s `timeout()` covers "until the response body has finished", so
/// using it here cut every streamed answer off mid-sentence once it took longer
/// than that -- and the partial text was then stored as if it were complete.
const HTTP_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a provider may stay silent before it answers with even the response
/// *headers*. Google is the reason this exists: when a model is overloaded it
/// accepts the request and only then replies `503 high demand`, which was
/// measured at 99 seconds -- and one attempt never came back at all. The idle
/// timeout cannot catch that because it never sees a byte, so the notch sat on
/// "Düşünüyor…" for minutes while the fallback chain had not even started.
///
/// Gemini does not send headers early, so in practice this bounds the wait for
/// the first token. Measured on a real key: 9.8 s for `gemini-3.1-flash-lite`
/// and 15.3 s for `gemini-3.5-flash`, so the bound has to clear a healthy but
/// slow model while still cutting the hundred-second failures.
const HTTP_START_TIMEOUT: Duration = Duration::from_secs(25);

/// Long answers used to stop mid-sentence because every request asked for only
/// 1024 output tokens. The limit is generous now, and if a model still runs out
/// of room the request is repeated with the partial answer so it can finish the
/// sentence instead of leaving the user with half a reply.
const MAX_OUTPUT_TOKENS: u32 = 4096;
const MAX_CONTINUATIONS: usize = 2;
/// English keeps the continuation in whatever language the answer was already
/// written in; a Turkish instruction made English answers switch language
/// halfway through.
const CONTINUE_PROMPT: &str =
    "Your previous answer was cut off. Continue exactly where it stopped. Do not repeat anything and do not start over.";

/// One client for every provider. Building a `reqwest::Client` per question
/// pulled in a fresh TLS configuration and connection pool each time; asking a
/// few questions left several of those resident. A single pool keeps the idle
/// connection count at one and lets it expire quickly after the answer.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> Result<&'static reqwest::Client, String> {
    if let Some(client) = HTTP_CLIENT.get() {
        return Ok(client);
    }
    let client = reqwest::Client::builder()
        // No total deadline: a long answer that keeps streaming is healthy.
        // A stalled connection is caught by the idle read timeout instead.
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .read_timeout(HTTP_IDLE_TIMEOUT)
        .pool_max_idle_per_host(1)
        // Keep the TLS connection warm between questions. Re-handshaking for
        // every short prompt added a visible delay before the model even
        // started, and an idle notch does not keep the socket alive by itself.
        .pool_idle_timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(HTTP_CLIENT.get_or_init(|| client))
}

/// Send a request and give up if the provider does not even start answering
/// within `HTTP_START_TIMEOUT`. A timeout is reported as a connection error so
/// the Gemini fallback chain retries it on the next model right away instead of
/// leaving the notch waiting.
///
/// Only streamed requests are bounded this tightly: their headers arrive before
/// the model writes a token, so silence means an overloaded or stuck model. A
/// plain `generateContent` request sends its headers together with the finished
/// body, so the old idle timeout stays in charge there.
async fn send_start(request: reqwest::RequestBuilder, streaming: bool) -> Result<reqwest::Response, String> {
    let send = request.send();
    if !streaming {
        return send.await.map_err(|e| format!("Bağlantı hatası: {e}"));
    }
    match tokio::time::timeout(HTTP_START_TIMEOUT, send).await {
        Ok(result) => result.map_err(|e| format!("Bağlantı hatası: {e}")),
        Err(_) => Err(format!(
            "Bağlantı hatası: {} saniye içinde yanıt başlamadı",
            HTTP_START_TIMEOUT.as_secs()
        )),
    }
}

/// The Gemini model id that last answered successfully. Google retires ids
/// every few months, so the first question after an upgrade can cost three
/// failed round-trips. Remembering the winner makes every later question go
/// straight to a model that works.
static GEMINI_MODEL: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// How long a model stays out of the fallback chain after it answered
/// `503 high demand` or never started answering. Google's overload usually
/// clears within minutes, so the id is tried again after this window instead of
/// being dropped forever.
const GEMINI_COOLDOWN: Duration = Duration::from_secs(180);

/// Model ids that recently failed to answer, with the moment they may be tried
/// again. Without this every question re-paid the start timeout for the same
/// overloaded model before reaching one that works.
static GEMINI_DOWN: std::sync::Mutex<Vec<(String, Instant)>> = std::sync::Mutex::new(Vec::new());

fn gemini_is_down(model: &str) -> bool {
    let Ok(mut slot) = GEMINI_DOWN.lock() else {
        return false;
    };
    let now = Instant::now();
    // Drop only entries whose cooldown has ended; the model being asked about
    // must stay in the list, or every lookup would clear its own verdict.
    slot.retain(|(_, until)| *until > now);
    slot.iter().any(|(name, _)| name == model)
}

fn gemini_mark_down(model: &str) {
    if let Ok(mut slot) = GEMINI_DOWN.lock() {
        let until = Instant::now() + GEMINI_COOLDOWN;
        match slot.iter_mut().find(|(name, _)| name == model) {
            Some(entry) => entry.1 = until,
            None => slot.push((model.to_string(), until)),
        }
    }
}

fn gemini_mark_up(model: &str) {
    if let Ok(mut slot) = GEMINI_DOWN.lock() {
        slot.retain(|(name, _)| name != model);
    }
}

/// The reasoning setting the provider accepted last time, together with the
/// model it was accepted for. A model that rejects `thinkingBudget` answers with
/// an error, and the retry chain costs two extra round-trips — which the user
/// reads as "the first answer of a session is slow". Remembering the working
/// mode makes that first question as fast as every later one.
///
/// The model id is part of the memory because the two families accept opposite
/// fields: a mode remembered for `gemini-3.8-flash` is rejected by a 2.5 model,
/// and trusting it blindly cost the extra round-trip it was meant to avoid.
static GEMINI_THINKING: std::sync::Mutex<Option<(String, ThinkingMode)>> =
    std::sync::Mutex::new(None);

/// The remembered thinking form, but only when it was learned from the same
/// model family the request is going to.
fn remembered_thinking(model: &str) -> Option<ThinkingMode> {
    let slot = GEMINI_THINKING.lock().ok()?;
    let (remembered_model, mode) = slot.as_ref()?;
    let same_family = thinking_family(remembered_model) == thinking_family(model);
    same_family.then_some(*mode)
}

fn remember_thinking(model: &str, mode: ThinkingMode) {
    if let Ok(mut slot) = GEMINI_THINKING.lock() {
        let already = matches!(slot.as_ref(), Some((m, known)) if m == model && *known == mode);
        if !already {
            *slot = Some((model.to_string(), mode));
        }
    }
}

/// The coarse family that decides which thinking field a model accepts.
fn thinking_family(model: &str) -> &'static str {
    match preferred_thinking(model) {
        ThinkingMode::LevelLow => "level",
        _ => "budget",
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Provider {
    Claude,
    OpenAI,
    Gemini,
}

impl Provider {
    fn from_setting(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai" | "chatgpt" | "gpt" => Provider::OpenAI,
            "gemini" | "google" => Provider::Gemini,
            _ => Provider::Claude,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::OpenAI => "ChatGPT",
            Provider::Gemini => "Gemini",
        }
    }

    fn default_model(self) -> &'static str {
        match self {
            Provider::Claude => "claude-sonnet-4-5",
            Provider::OpenAI => "gpt-4o-mini",
            // Google retires concrete ids every few months (`gemini-2.5-flash`
            // is already closed to new users). This is the current stable Flash
            // model; a retired id is retried with whatever Google suggests.
            // Google's moving "latest flash" alias. Measured with a real key:
            // gemini-3.5-flash and gemini-3.6-flash need 14-16 s even for a
            // one-line answer, gemini-3.8-flash ~4 s, the alias ~2.5 s. The
            // alias also follows a retirement without a code change.
            Provider::Gemini => "gemini-flash-latest",
        }
    }

    /// Claude keeps the original setting names so an existing key/model keeps
    /// working after the multi-provider update.
    fn key_setting(self) -> &'static str {
        match self {
            Provider::Claude => "kiro-ai-key",
            Provider::OpenAI => "kiro-ai-key-openai",
            Provider::Gemini => "kiro-ai-key-gemini",
        }
    }

    fn model_setting(self) -> &'static str {
        match self {
            Provider::Claude => "kiro-ai-model",
            Provider::OpenAI => "kiro-ai-model-openai",
            Provider::Gemini => "kiro-ai-model-gemini",
        }
    }
}

#[derive(Deserialize)]
struct ApiError {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Option<Vec<AnthropicBlock>>,
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
struct AnthropicBlock {
    #[serde(default)]
    text: String,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    choices: Option<Vec<OpenAiChoice>>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
    #[serde(default, rename = "finishReason")]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiPart>>,
}

#[derive(Deserialize)]
struct GeminiPart {
    #[serde(default)]
    text: Option<String>,
    /// Thought summaries are flagged separately. They are never shown as the
    /// answer, and with thinking switched off this stays false.
    #[serde(default)]
    thought: bool,
}

/// How to ask a Gemini model not to think. Gemini 3+ has thinking on, so every
/// question would first spend its budget on invisible reasoning: the notch sits
/// on "Düşünüyor…" for ten seconds and the thoughts are charged against
/// `maxOutputTokens`, which can leave no visible answer at all. Custom ids
/// disagree about the field name, so the next form is tried when the API
/// rejects this one.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ThinkingMode {
    BudgetZero,
    LevelLow,
    Off,
}

/// Which form to try first for a model id. The two ways of switching thinking
/// off are not interchangeable: Gemini 3 and later know `thinkingLevel` and
/// reject `thinkingBudget: 0`, while the older ids do the opposite. Guessing
/// wrong costs a failed request plus the retry, which is exactly the slow first
/// answer. Every current Gemini 3/4 text model accepts `low`, and `low` is the
/// lowest latency level on the ones that do not offer `minimal`.
fn preferred_thinking(model: &str) -> ThinkingMode {
    let id = model.to_ascii_lowercase();
    if id.contains("gemini-3")
        || id.contains("gemini-4")
        || id.contains("flash-latest")
        || id.contains("pro-latest")
    {
        ThinkingMode::LevelLow
    } else {
        ThinkingMode::BudgetZero
    }
}

/// The order to try the thinking forms in. A wrong family guess is cheap: the
/// second entry is the other supported form, so a model never falls straight
/// from a rejected setting to "thinking on" (the slow default) before it has
/// had its correct form tried.
fn thinking_chain(model: &str) -> [ThinkingMode; 3] {
    match preferred_thinking(model) {
        ThinkingMode::LevelLow => [
            ThinkingMode::LevelLow,
            ThinkingMode::BudgetZero,
            ThinkingMode::Off,
        ],
        _ => [
            ThinkingMode::BudgetZero,
            ThinkingMode::LevelLow,
            ThinkingMode::Off,
        ],
    }
}

/// Gemini can spend the whole visible budget on reasoning and return no text at
/// all. When that happens the request is retried with a bigger budget before the
/// question is declared empty.
const MAX_GEMINI_TOKENS: u32 = 16_384;

fn gemini_body(contents: &[serde_json::Value], thinking: ThinkingMode, max_tokens: u32) -> serde_json::Value {
    let mut config = serde_json::json!({ "maxOutputTokens": max_tokens });
    match thinking {
        ThinkingMode::BudgetZero => {
            config["thinkingConfig"] = serde_json::json!({ "thinkingBudget": 0 });
        }
        ThinkingMode::LevelLow => {
            config["thinkingConfig"] = serde_json::json!({ "thinkingLevel": "low" });
        }
        ThinkingMode::Off => {}
    }
    serde_json::json!({ "contents": contents, "generationConfig": config })
}

/// Did the API reject the request over the thinking field? Only then is a retry
/// without it worth the extra round-trip.
fn thinking_rejected(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("thinking") || lower.contains("thought")
}

/// One incremental token batch pushed to the webview while a provider is still
/// writing. The frontend appends every `delta` for the matching `id`, so the
/// answer starts appearing in the notch after the first token instead of after
/// the whole response (which could take many seconds).
#[derive(Clone, serde::Serialize)]
struct AiStreamEvent {
    id: String,
    delta: String,
}

struct StreamSink<'a> {
    app: &'a AppHandle,
    id: &'a str,
    /// Number of non-empty deltas pushed for this request. Used to avoid
    /// retrying another model after part of an answer is already on screen.
    emitted: std::sync::atomic::AtomicUsize,
}

impl StreamSink<'_> {
    fn emit(&self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        self.emitted
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = self.app.emit(
            "ai-stream",
            AiStreamEvent {
                id: self.id.to_string(),
                delta: delta.to_string(),
            },
        );
    }

    fn emitted(&self) -> usize {
        self.emitted.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// Read a server-sent-event response line by line. Chunks can split a UTF-8
/// character in half, so the buffer stays as bytes and only complete lines are
/// decoded.
async fn read_sse<F>(response: &mut reqwest::Response, mut on_data: F) -> Result<(), String>
where
    F: FnMut(&str) + Send,
{
    let mut buffer: Vec<u8> = Vec::new();
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|e| format!("Bağlantı hatası: {e}"))?;
        let Some(chunk) = chunk else { break };
        buffer.extend_from_slice(&chunk);
        while let Some(position) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=position).collect();
            if let Some(data) = sse_data(&line) {
                on_data(data);
            }
        }
    }
    if let Some(data) = sse_data(&buffer) {
        on_data(data);
    }
    Ok(())
}

fn sse_data(line: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(line).ok()?.trim();
    text.strip_prefix("data:")
        .map(str::trim)
        .filter(|data| !data.is_empty() && *data != "[DONE]")
}

/// Text + stop reason from one Anthropic stream event. Pure so the SSE wiring
/// can be tested without a live key.
fn anthropic_stream_event(data: &str) -> (String, Option<String>) {
    let Ok(event) = serde_json::from_str::<AnthropicStreamEvent>(data) else {
        return (String::new(), None);
    };
    match event.kind.as_str() {
        "content_block_delta" => match event.delta {
            Some(delta) if delta.kind == "text_delta" => {
                (delta.text.unwrap_or_default(), None)
            }
            _ => (String::new(), None),
        },
        "message_delta" => (
            String::new(),
            event.delta.and_then(|delta| delta.stop_reason),
        ),
        _ => (String::new(), None),
    }
}

fn openai_stream_chunk(data: &str) -> (String, Option<String>) {
    let Ok(chunk) = serde_json::from_str::<OpenAiStreamChunk>(data) else {
        return (String::new(), None);
    };
    let mut text = String::new();
    let mut finish_reason = None;
    for choice in chunk.choices {
        if let Some(delta) = choice.delta {
            if let Some(content) = delta.content {
                text.push_str(&content);
            }
        }
        if choice.finish_reason.is_some() {
            finish_reason = choice.finish_reason;
        }
    }
    (text, finish_reason)
}

fn gemini_stream_chunk(data: &str) -> (String, Option<String>) {
    let Ok(chunk) = serde_json::from_str::<GeminiResponse>(data) else {
        return (String::new(), None);
    };
    let Some(candidate) = chunk.candidates.unwrap_or_default().into_iter().next() else {
        return (String::new(), None);
    };
    let text = candidate
        .content
        .map(|content| content.parts.unwrap_or_default())
        .unwrap_or_default()
        .into_iter()
        .filter(|part| !part.thought)
        .filter_map(|part| part.text)
        .collect::<Vec<_>>()
        .join("");
    (text, candidate.finish_reason)
}

#[derive(Deserialize)]
struct AnthropicStreamEvent {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    delta: Option<AnthropicStreamDelta>,
}

#[derive(Deserialize)]
struct AnthropicStreamDelta {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiStreamChunk {
    #[serde(default)]
    choices: Vec<OpenAiStreamChoice>,
}

#[derive(Deserialize)]
struct OpenAiStreamChoice {
    #[serde(default)]
    delta: Option<OpenAiStreamDelta>,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiStreamDelta {
    #[serde(default)]
    content: Option<String>,
}

fn setting(app: &AppHandle, key: &str) -> Option<String> {
    crate::utils::get_setting_str(app, key).filter(|value| !value.trim().is_empty())
}

fn provider_key(app: &AppHandle, provider: Provider) -> Option<String> {
    setting(app, provider.key_setting()).or_else(|| {
        // Older builds stored the Claude key without a provider suffix.
        (provider == Provider::Claude)
            .then(|| setting(app, "kiro-ai-key"))
            .flatten()
    })
}

fn provider_model(app: &AppHandle, provider: Provider) -> String {
    let stored = setting(app, provider.model_setting())
        .or_else(|| {
            (provider == Provider::Claude)
                .then(|| setting(app, "kiro-ai-model"))
                .flatten()
        })
        .unwrap_or_else(|| provider.default_model().to_string());
    normalize_model(provider, &stored)
}

/// Old builds stored concrete Gemini ids and Google has since retired some of
/// them (`gemini-2.0-flash` now answers "no longer available"). Map those to
/// the current alias instead of failing every question until the user opens
/// the setup panel again.
///
/// The 3.5 and 3.6 flash releases are still served but take 14-16 s for a
/// one-line answer with a normal key, so a settings file that pinned one is
/// moved to the fast alias as well.
fn normalize_model(provider: Provider, model: &str) -> String {
    let id = model.trim();
    if id.is_empty() {
        return provider.default_model().to_string();
    }
    if provider == Provider::Gemini {
        let lower = id.to_ascii_lowercase();
        if lower.starts_with("gemini-1.0")
            || lower.starts_with("gemini-1.5")
            || lower.starts_with("gemini-2.0")
            || lower.starts_with("gemini-2.5")
            || lower == "gemini-3.5-flash"
            || lower == "gemini-3.6-flash"
        {
            return provider.default_model().to_string();
        }
    }
    id.to_string()
}

fn error_message(text: &str) -> String {
    #[derive(Deserialize)]
    struct Wrapper {
        error: Option<ApiError>,
    }
    serde_json::from_str::<Wrapper>(text)
        .ok()
        .and_then(|parsed| parsed.error.map(|error| error.message))
        .filter(|message| !message.trim().is_empty())
        .unwrap_or_else(|| text.chars().take(300).collect())
}

/// Providers answer with English machine text ("You exceeded your current
/// quota"). On their own these are unreadable in a 340 px notch and never say
/// what to do next, so map the frequent ones to a short Turkish instruction
/// and keep the original wording in brackets for anyone who wants the details.
fn friendly_error(provider: &str, status: u16, text: &str) -> String {
    let raw = error_message(text);
    let lower = raw.to_ascii_lowercase();
    let quota = lower.contains("quota")
        || lower.contains("insufficient")
        || lower.contains("billing")
        || lower.contains("credit balance")
        || lower.contains("exceeded your current");
    let auth = lower.contains("api key")
        || lower.contains("api_key")
        || lower.contains("invalid key")
        || lower.contains("unauthorized")
        || lower.contains("permission")
        || status == 401
        || status == 403;
    let rate = lower.contains("rate limit")
        || lower.contains("too many requests")
        || lower.contains("resource_exhausted")
        || status == 429;
    // Google answers a busy model with 503 and "experiencing high demand".
    // Passing that English sentence through to the notch reads like a crash, so
    // it gets the same short, actionable line as the rest.
    let busy = status == 503
        || lower.contains("high demand")
        || lower.contains("overloaded")
        || lower.contains("temporarily unavailable")
        || lower.contains("service unavailable");
    let model = lower.contains("not found")
        || lower.contains("does not exist")
        || lower.contains("unsupported")
        || status == 404;
    let offline = lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("connection")
        || lower.contains("dns")
        || lower.contains("network");

    let hint = if quota {
        "kota doldu. Faturalama sayfasından limiti artır ya da üstteki çiplerden başka bir sağlayıcıya geç"
    } else if rate {
        "çok fazla istek. Birkaç saniye bekleyip tekrar dene"
    } else if busy {
        "sunucu şu an yoğun. Birkaç saniye sonra tekrar dene"
    } else if auth {
        "anahtar geçersiz ya da yetkisiz. Anahtar düğmesinden yenile"
    } else if model {
        "seçili model bu anahtarla kullanılamıyor. Ayarlar > Çentik AI bölümünden modeli değiştir"
    } else if offline {
        "sunucuya ulaşılamadı. Bağlantıyı kontrol edip tekrar dene"
    } else {
        ""
    };

    if hint.is_empty() {
        return format!("{provider} API hatası: {raw}");
    }
    // Google's overload sentence is long and English; the hint already says
    // everything the user needs, so the raw text is left out.
    if busy {
        return format!("{provider} API hatası: {hint}");
    }
    format!("{provider} API hatası: {hint} ({raw})")
}

/// An image attached to a question. The frontend already downscales it and
/// hands over a `data:image/...;base64,...` URL, so what travels from the
/// webview to here is a few hundred kilobytes, not a camera raw.
struct InlineImage {
    mime: String,
    data: String,
}

/// Hard limits: a paste of four huge screenshots must not balloon the process.
const MAX_IMAGES: usize = 4;
const MAX_IMAGE_BASE64: usize = 8 * 1024 * 1024;

fn parse_data_url(url: &str) -> Option<InlineImage> {
    let rest = url.trim().strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?.trim().to_ascii_lowercase();
    if !mime.starts_with("image/") || data.is_empty() || data.len() > MAX_IMAGE_BASE64 {
        return None;
    }
    Some(InlineImage {
        mime,
        data: data.to_string(),
    })
}

fn parse_images(images: Vec<String>) -> Vec<InlineImage> {
    images
        .into_iter()
        .filter_map(|url| parse_data_url(&url))
        .take(MAX_IMAGES)
        .collect()
}

async fn ask_anthropic(
    key: &str,
    model: &str,
    prompt: &str,
    images: &[InlineImage],
    stream: Option<&StreamSink<'_>>,
) -> Result<String, String> {
    let content = if images.is_empty() {
        serde_json::json!(prompt)
    } else {
        let mut blocks: Vec<serde_json::Value> = images
            .iter()
            .map(|image| {
                serde_json::json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.mime.as_str(),
                        "data": image.data.as_str()
                    }
                })
            })
            .collect();
        blocks.push(serde_json::json!({ "type": "text", "text": prompt }));
        serde_json::Value::Array(blocks)
    };
    let mut messages = vec![serde_json::json!({ "role": "user", "content": content })];
    let client = http_client()?;
    let mut answer = String::new();

    for round in 0..=MAX_CONTINUATIONS {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "stream": stream.is_some(),
            "messages": messages
        });
        let request = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .body(body.to_string());
        let response = send_start(request, stream.is_some()).await;

        let (text, stop_reason) = match response {
            Ok(mut response) => {
                let status = response.status();
                if !status.is_success() {
                    let body = response.text().await.unwrap_or_default();
                    let error = friendly_error("Claude", status.as_u16(), &body);
                    // A failed continuation must not throw away the part that
                    // already arrived on screen.
                    if round > 0 && !answer.trim().is_empty() {
                        break;
                    }
                    return Err(error);
                }
                if let Some(sink) = stream {
                    let mut round_text = String::new();
                    let mut stop_reason: Option<String> = None;
                    let read = read_sse(&mut response, |data| {
                        let (text, reason) = anthropic_stream_event(data);
                        if !text.is_empty() {
                            round_text.push_str(&text);
                            sink.emit(&text);
                        }
                        if reason.is_some() {
                            stop_reason = reason;
                        }
                    })
                    .await;
                    if let Err(error) = read {
                        if !round_text.trim().is_empty() {
                            answer.push_str(&round_text);
                        }
                        if !answer.trim().is_empty() {
                            break;
                        }
                        return Err(error);
                    }
                    (round_text, stop_reason)
                } else {
                    let body = response.text().await.map_err(|e| e.to_string())?;
                    let parsed = match serde_json::from_str::<AnthropicResponse>(&body) {
                        Ok(parsed) => parsed,
                        Err(error) => {
                            if round > 0 && !answer.trim().is_empty() {
                                break;
                            }
                            return Err(error.to_string());
                        }
                    };
                    let text = parsed
                        .content
                        .unwrap_or_default()
                        .into_iter()
                        .map(|block| block.text)
                        .collect::<Vec<_>>()
                        .join("");
                    (text, parsed.stop_reason)
                }
            }
            Err(error) => {
                if round > 0 && !answer.trim().is_empty() {
                    break;
                }
                return Err(error);
            }
        };

        if text.trim().is_empty() {
            if answer.trim().is_empty() {
                return Err("Claude boş yanıt döndürdü".into());
            }
            break;
        }
        answer.push_str(&text);
        if stop_reason.as_deref() != Some("max_tokens") {
            break;
        }
        messages.push(serde_json::json!({ "role": "assistant", "content": text }));
        messages.push(serde_json::json!({ "role": "user", "content": CONTINUE_PROMPT }));
    }

    Ok(answer.trim().to_string())
}

async fn ask_openai(
    key: &str,
    model: &str,
    prompt: &str,
    images: &[InlineImage],
    stream: Option<&StreamSink<'_>>,
) -> Result<String, String> {
    let content = if images.is_empty() {
        serde_json::json!(prompt)
    } else {
        let mut parts: Vec<serde_json::Value> = images
            .iter()
            .map(|image| {
                serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", image.mime, image.data)
                    }
                })
            })
            .collect();
        parts.push(serde_json::json!({ "type": "text", "text": prompt }));
        serde_json::Value::Array(parts)
    };
    let mut messages = vec![serde_json::json!({ "role": "user", "content": content })];
    let client = http_client()?;
    let mut answer = String::new();

    for round in 0..=MAX_CONTINUATIONS {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "stream": stream.is_some(),
            "messages": messages
        });
        let request = client
            .post("https://api.openai.com/v1/chat/completions")
            .header("authorization", format!("Bearer {key}"))
            .header("content-type", "application/json")
            .body(body.to_string());
        let response = send_start(request, stream.is_some()).await;

        let (text, finish_reason) = match response {
            Ok(mut response) => {
                let status = response.status();
                if !status.is_success() {
                    let body = response.text().await.unwrap_or_default();
                    let error = friendly_error("ChatGPT", status.as_u16(), &body);
                    if round > 0 && !answer.trim().is_empty() {
                        break;
                    }
                    return Err(error);
                }
                if let Some(sink) = stream {
                    let mut round_text = String::new();
                    let mut finish_reason: Option<String> = None;
                    let read = read_sse(&mut response, |data| {
                        let (text, reason) = openai_stream_chunk(data);
                        if !text.is_empty() {
                            round_text.push_str(&text);
                            sink.emit(&text);
                        }
                        if reason.is_some() {
                            finish_reason = reason;
                        }
                    })
                    .await;
                    if let Err(error) = read {
                        if !round_text.trim().is_empty() {
                            answer.push_str(&round_text);
                        }
                        if !answer.trim().is_empty() {
                            break;
                        }
                        return Err(error);
                    }
                    (round_text, finish_reason)
                } else {
                    let body = response.text().await.map_err(|e| e.to_string())?;
                    let parsed = match serde_json::from_str::<OpenAiResponse>(&body) {
                        Ok(parsed) => parsed,
                        Err(error) => {
                            if round > 0 && !answer.trim().is_empty() {
                                break;
                            }
                            return Err(error.to_string());
                        }
                    };
                    let choice = parsed.choices.unwrap_or_default().into_iter().next();
                    let Some(choice) = choice else {
                        if answer.trim().is_empty() {
                            return Err("ChatGPT boş yanıt döndürdü".into());
                        }
                        break;
                    };
                    (choice.message.content.unwrap_or_default(), choice.finish_reason)
                }
            }
            Err(error) => {
                if round > 0 && !answer.trim().is_empty() {
                    break;
                }
                return Err(error);
            }
        };

        let truncated = finish_reason.as_deref() == Some("length");
        if text.trim().is_empty() {
            if answer.trim().is_empty() {
                return Err("ChatGPT boş yanıt döndürdü".into());
            }
            break;
        }
        answer.push_str(&text);
        if !truncated {
            break;
        }
        messages.push(serde_json::json!({ "role": "assistant", "content": text }));
        messages.push(serde_json::json!({ "role": "user", "content": CONTINUE_PROMPT }));
    }

    Ok(answer.trim().to_string())
}

async fn ask_gemini(
    key: &str,
    model: &str,
    prompt: &str,
    images: &[InlineImage],
    stream: Option<&StreamSink<'_>>,
) -> Result<String, String> {
    let mut parts: Vec<serde_json::Value> = images
        .iter()
        .map(|image| {
            serde_json::json!({
                "inline_data": {
                    "mime_type": image.mime.as_str(),
                    "data": image.data.as_str()
                }
            })
        })
        .collect();
    parts.push(serde_json::json!({ "text": prompt }));
    let mut contents = vec![serde_json::json!({ "role": "user", "parts": parts })];
    let client = http_client()?;
    let url = if stream.is_some() {
        format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse",
            model
        )
    } else {
        format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            model
        )
    };
    let mut answer = String::new();

    for round in 0..=MAX_CONTINUATIONS {
        // Ask the model not to think much first. Gemini 3+ reports
        // `thinking: true`, so by default every question spends its budget on
        // invisible reasoning: the notch sits on "Düşünüyor..." for ten-plus
        // seconds, and the thoughts are charged against `maxOutputTokens`,
        // which can leave no visible answer at all. Custom ids disagree about
        // the field name, so a rejected request steps to the next form and
        // tries the same round again. Start from the form this model family
        // accepts and from whatever worked last time, so the common path is a
        // single request.
        let remembered = remembered_thinking(model);
        let mut attempts: Vec<ThinkingMode> = Vec::with_capacity(4);
        if let Some(mode) = remembered {
            attempts.push(mode);
        }
        for mode in thinking_chain(model) {
            if !attempts.contains(&mode) {
                attempts.push(mode);
            }
        }
        let mut attempt = 0;
        let mut thinking = attempts[0];
        let mut budget = MAX_OUTPUT_TOKENS;
        let (text, finish_reason) = 'attempt: loop {
            let request = client
                .post(&url)
                // Header auth works for both classic `AIza...` keys and the
                // newer keys AI Studio hands out; the query parameter is
                // deprecated for some key formats and failed silently as a
                // slow 403.
                .header("x-goog-api-key", key)
                .header("content-type", "application/json")
                .body(gemini_body(&contents, thinking, budget).to_string());
            let response = send_start(request, stream.is_some()).await;

            let mut response = match response {
                Ok(response) => response,
                Err(error) => {
                    if round > 0 && !answer.trim().is_empty() {
                        break 'attempt (String::new(), None);
                    }
                    return Err(error);
                }
            };

            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                // A remembered form can be wrong after a model change; walk the
                // chain rather than jumping straight to "thinking on".
                if thinking != ThinkingMode::Off && thinking_rejected(&body) {
                    attempt += 1;
                    match attempts.get(attempt) {
                        Some(next) => {
                            thinking = *next;
                            continue;
                        }
                        None => {
                            return Err(friendly_error("Gemini", status.as_u16(), &body));
                        }
                    }
                }
                if round > 0 && !answer.trim().is_empty() {
                    break 'attempt (String::new(), None);
                }
                return Err(friendly_error("Gemini", status.as_u16(), &body));
            }

            // The request body was accepted: remember this thinking form (for
            // this model family) so the next session's first question skips the
            // rejected attempt.
            remember_thinking(model, thinking);

            if let Some(sink) = stream {
                let mut round_text = String::new();
                let mut reason: Option<String> = None;
                let read = read_sse(&mut response, |data| {
                    let (text, stop) = gemini_stream_chunk(data);
                    if !text.is_empty() {
                        round_text.push_str(&text);
                        sink.emit(&text);
                    }
                    if stop.is_some() {
                        reason = stop;
                    }
                })
                .await;
                if let Err(error) = read {
                    if !round_text.trim().is_empty() {
                        answer.push_str(&round_text);
                    }
                    if !answer.trim().is_empty() {
                        break 'attempt (String::new(), None);
                    }
                    return Err(error);
                }
                // Reasoning can eat the whole budget before a single visible
                // token is written. Ask again with more room instead of
                // reporting an empty answer.
                if round_text.trim().is_empty()
                    && reason.as_deref() == Some("MAX_TOKENS")
                    && budget < MAX_GEMINI_TOKENS
                {
                    budget = (budget * 4).min(MAX_GEMINI_TOKENS);
                    continue;
                }
                // A model can also accept the "think less" field and still spend
                // its whole answer on thoughts, which reached the user as
                // "Gemini boş yanıt döndürdü". The plain form (no thinking field
                // at all) is the last rung of the chain, so try it instead of
                // failing with nothing to show.
                if round_text.trim().is_empty() {
                    if let Some(next_attempt) = off_attempt(&attempts, attempt) {
                        attempt = next_attempt;
                        thinking = attempts[attempt];
                        continue;
                    }
                }
                break 'attempt (round_text, reason);
            }

            let body = response.text().await.map_err(|e| e.to_string())?;
            let parsed = match serde_json::from_str::<GeminiResponse>(&body) {
                Ok(parsed) => parsed,
                Err(error) => {
                    if round > 0 && !answer.trim().is_empty() {
                        break 'attempt (String::new(), None);
                    }
                    return Err(error.to_string());
                }
            };
            let candidate = parsed.candidates.unwrap_or_default().into_iter().next();
            let Some(candidate) = candidate else {
                if answer.trim().is_empty() {
                    return Err("Gemini boş yanıt döndürdü".into());
                }
                break 'attempt (String::new(), None);
            };
            let text = candidate
                .content
                .map(|content| content.parts.unwrap_or_default())
                .unwrap_or_default()
                .into_iter()
                .filter(|part| !part.thought)
                .filter_map(|part| part.text)
                .collect::<Vec<_>>()
                .join("");
            if text.trim().is_empty()
                && candidate.finish_reason.as_deref() == Some("MAX_TOKENS")
                && budget < MAX_GEMINI_TOKENS
            {
                budget = (budget * 4).min(MAX_GEMINI_TOKENS);
                continue;
            }
            break 'attempt (text, candidate.finish_reason);
        };

        let truncated = finish_reason.as_deref() == Some("MAX_TOKENS");
        if text.trim().is_empty() {
            if answer.trim().is_empty() {
                return Err("Gemini boş yanıt döndürdü".into());
            }
            break;
        }
        answer.push_str(&text);
        if !truncated {
            break;
        }
        contents.push(serde_json::json!({ "role": "model", "parts": [{ "text": text }] }));
        contents.push(serde_json::json!({ "role": "user", "parts": [{ "text": CONTINUE_PROMPT }] }));
    }

    Ok(answer.trim().to_string())
}

/// The index of the "no thinking field at all" attempt in the chain, if it has
/// not been tried yet. The chain always ends with `Off`, so this either returns
/// the last rung or `None` — which is what stops the retry from looping.
fn off_attempt(attempts: &[ThinkingMode], current: usize) -> Option<usize> {
    let off = attempts.iter().position(|mode| *mode == ThinkingMode::Off)?;
    (off > current).then_some(off)
}

fn claude_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(kiro_windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            out.push(PathBuf::from(&appdata).join("npm").join("claude.cmd"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            out.push(PathBuf::from(&local).join("Programs").join("claude").join("claude.exe"));
            out.push(PathBuf::from(&local).join("Programs").join("Claude").join("claude.exe"));
        }
    }
    // Node installs the CLI next to the npm prefix, which is ~/.local/bin for a
    // default per-user prefix and /usr/local/bin for a system-wide one; distro
    // packages and `bun` land in the other usual places.
    #[cfg(not(kiro_windows))]
    {
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            out.push(home.join(".local").join("bin").join("claude"));
            out.push(home.join(".npm-global").join("bin").join("claude"));
            out.push(home.join(".bun").join("bin").join("claude"));
        }
        out.push(PathBuf::from("/usr/local/bin/claude"));
        out.push(PathBuf::from("/usr/bin/claude"));
        out.push(PathBuf::from("/snap/bin/claude"));
    }
    out
}

fn ask_cli(prompt: &str) -> Result<String, String> {
    #[cfg(kiro_windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(kiro_windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = claude_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("claude"));
    #[cfg(kiro_windows)]
    let is_script = exe
        .extension()
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    let mut command = {
        #[cfg(kiro_windows)]
        {
            if is_script {
                let mut cmd = std::process::Command::new("cmd");
                cmd.arg("/C").arg(&exe);
                cmd
            } else {
                std::process::Command::new(&exe)
            }
        }
        #[cfg(not(kiro_windows))]
        {
            std::process::Command::new(&exe)
        }
    };
    command
        .args(["-p", "--output-format", "text"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(kiro_windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command.spawn().map_err(|_| {
        "Claude Code CLI bulunamadı. Ayarlardan bir API anahtarı girebilirsin.".to_string()
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    // Drain the pipes on their own threads: a long answer would otherwise fill
    // the pipe buffer and deadlock the child while we poll for exit.
    let mut stdout = child.stdout.take().ok_or("stdout yok")?;
    let mut stderr = child.stderr.take().ok_or("stderr yok")?;
    let out_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let err_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > CLI_TIMEOUT {
                    let _ = child.kill();
                    return Err("Claude zamanında yanıt vermedi".into());
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(error) => return Err(error.to_string()),
        }
    }

    let answer = out_reader.join().unwrap_or_default().trim().to_string();
    if answer.is_empty() {
        let hint = err_reader.join().unwrap_or_default();
        let hint = hint.trim();
        return Err(if hint.is_empty() {
            "Claude boş yanıt döndürdü".to_string()
        } else {
            format!("Claude hatası: {}", hint.chars().take(300).collect::<String>())
        });
    }
    Ok(answer)
}

/// Warm the connection the assistant will use. Building the pool on the first
/// question put a DNS lookup plus a TLS handshake in front of the first token,
/// which is the most visible delay in the whole panel: the answer arrives fast
/// on the second question and slow on the first. A cheap HEAD to the provider's
/// host (no key, no tokens) leaves a pooled connection ready.
pub fn warm_up(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(client) = http_client() else { return };
        let requested =
            Provider::from_setting(&setting(&app, "kiro-ai-provider").unwrap_or_default());
        let root = match requested {
            Provider::OpenAI => "https://api.openai.com/",
            Provider::Gemini => "https://generativelanguage.googleapis.com/",
            Provider::Claude => "https://api.anthropic.com/",
        };
        let _ = client
            .head(root)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
    });
}

/// Called when the assistant panel opens, so typing a question does not race a
/// DNS lookup and a TLS handshake. Cheap and idempotent: the pool keeps the
/// socket, and a second call reuses it.
#[tauri::command]
pub fn ai_warm(app: AppHandle) {
    warm_up(app);
}

#[tauri::command]
pub async fn ai_ask(
    app: AppHandle,
    prompt: String,
    images: Option<Vec<String>>,
    stream_id: Option<String>,
) -> Result<String, String> {
    let images = parse_images(images.unwrap_or_default());
    // An empty id would make every event target nobody; treat it like "no
    // streaming" and use the plain request path.
    let stream_id = stream_id.filter(|id| !id.trim().is_empty());
    let result = ask_provider(app, prompt, images, stream_id.as_deref()).await;
    // The response body, the JSON parse, the base64 images and the answer
    // string are the only big allocations in this path. They are dropped by
    // now; ask the idle reclaim worker to push the freed pages out once the
    // user stops typing/reading, so an idle notch keeps a tiny working set.
    crate::memory_saver::trim_soon();
    result
}

async fn ask_provider(
    app: AppHandle,
    prompt: String,
    images: Vec<InlineImage>,
    stream_id: Option<&str>,
) -> Result<String, String> {
    let prompt: String = prompt.trim().chars().take(MAX_PROMPT).collect();
    if prompt.is_empty() && images.is_empty() {
        return Err("Boş mesaj".into());
    }

    let sink = stream_id.map(|id| StreamSink {
        app: &app,
        id,
        emitted: std::sync::atomic::AtomicUsize::new(0),
    });
    let sink = sink.as_ref();

    let requested =
        Provider::from_setting(&setting(&app, "kiro-ai-provider").unwrap_or_default());
    let backend = setting(&app, "kiro-ai-backend").unwrap_or_else(|| "auto".into());

    // Claude without a key silently degrades to the local Claude Code CLI. That
    // CLI can be logged out (or missing), and then the notch sits on
    // "Düşünüyor…" for several seconds only to show a login error. If the user
    // already stored a key for another provider, answer with that instead —
    // and if that key turns out to be dead too, try the next one.
    let candidates = provider_candidates(requested, &backend, |candidate| {
        provider_key(&app, candidate).is_some()
    });
    let total = candidates.len();

    let mut last_error = String::new();
    for (index, provider) in candidates.into_iter().enumerate() {
        let more = index + 1 < total;
        // Tell the notch which assistant is really answering when the backend
        // had to substitute; the header would otherwise keep the old brand.
        if provider != requested {
            let _ = app.emit("ai-provider-used", ProviderId::of(provider));
        }
        match ask_one(&app, provider, &backend, &prompt, &images, sink).await {
            Ok(answer) => return Ok(answer),
            Err(error) => {
                if more && is_provider_switchable(&error) {
                    last_error = error;
                    continue;
                }
                return Err(error);
            }
        }
    }
    Err(last_error)
}

/// Provider ids cross the IPC boundary as the same lowercase strings the
/// settings file uses.
struct ProviderId;

impl ProviderId {
    fn of(provider: Provider) -> &'static str {
        match provider {
            Provider::Claude => "claude",
            Provider::OpenAI => "openai",
            Provider::Gemini => "gemini",
        }
    }
}

/// A dead key on an automatically chosen provider must not be the end of the
/// question: switch to the next keyed provider instead. Only key/auth problems
/// qualify — a quota error or a network blip would just repeat on the next
/// provider.
fn is_provider_switchable(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("anahtar geçersiz")
        || lower.contains("invalid api key")
        || lower.contains("invalid_key")
        || lower.contains("incorrect api key")
        || lower.contains("unauthorized")
        || lower.contains("yetkisiz")
        || lower.contains("api key not valid")
        || lower.contains("api anahtarı yok")
}

/// Providers to try, in order. Normally just the configured one; when Claude
/// has no key and the CLI was not pinned, every keyed HTTP provider in
/// preference order.
fn provider_candidates(
    requested: Provider,
    backend: &str,
    has_key: impl Fn(Provider) -> bool + Copy,
) -> Vec<Provider> {
    if requested != Provider::Claude || backend == "cli" || has_key(Provider::Claude) {
        return vec![requested];
    }
    let mut out: Vec<Provider> = [Provider::Gemini, Provider::OpenAI]
        .into_iter()
        .filter(|candidate| has_key(*candidate))
        .collect();
    if out.is_empty() {
        out.push(Provider::Claude);
    }
    out
}

/// One provider, one answer.
async fn ask_one(
    app: &AppHandle,
    provider: Provider,
    backend: &str,
    prompt: &str,
    images: &[InlineImage],
    sink: Option<&StreamSink<'_>>,
) -> Result<String, String> {
    // Claude can run through the local Code CLI when there is no API key.
    if provider == Provider::Claude && backend != "cli" {
        if let Some(key) = provider_key(app, provider) {
            let model = provider_model(app, provider);
            return ask_anthropic(&key, &model, prompt, images, sink).await;
        }
        if backend == "api" || !images.is_empty() {
            // The CLI takes a plain text prompt only, so an attached screenshot
            // would be silently dropped. Ask for the key instead of answering
            // as if it had seen the image.
            return Err(if images.is_empty() {
                "Claude API anahtarı yok. Çentikteki anahtar simgesine tıklayıp ekleyebilirsin."
                    .into()
            } else {
                "Görsel göndermek için Claude API anahtarı gerekiyor. Çentikteki anahtar simgesine tıklayıp ekleyebilirsin."
                    .into()
            });
        }
    }
    if provider == Provider::Claude {
        let prompt = prompt.to_string();
        return tauri::async_runtime::spawn_blocking(move || ask_cli(&prompt))
            .await
            .map_err(|error| error.to_string())?;
    }

    let key = provider_key(app, provider).ok_or_else(|| {
        format!(
            "{} API anahtarı yok. Çentikteki anahtar simgesine tıklayıp ekleyebilirsin.",
            provider.label()
        )
    })?;
    let model = provider_model(app, provider);
    match provider {
        Provider::OpenAI => ask_openai(&key, &model, prompt, images, sink).await,
        Provider::Gemini => {
            // Google retires ids without notice. Try the model that answered
            // last time first (a retired id costs two failed round-trips on
            // every question otherwise), then the configured one, then follow
            // the id Google suggests and finally a small list of stable ids.
            let remembered = GEMINI_MODEL.lock().ok().and_then(|slot| slot.clone());
            let mut candidates: Vec<String> = Vec::new();
            for candidate in remembered.into_iter().chain(std::iter::once(model.clone())) {
                if !candidates.contains(&candidate) {
                    candidates.push(candidate);
                }
            }
            for fallback in [
                // When `gemini-flash-latest` and `gemini-3.8-flash` both answer
                // `503 high demand`, the lite id still replies in a few
                // seconds, so it sits right after the configured model instead
                // of being the last resort.
                "gemini-3.1-flash-lite",
                "gemini-flash-latest",
                "gemini-3.8-flash",
            ] {
                if !candidates.iter().any(|c| c == fallback) {
                    candidates.push(fallback.to_string());
                }
            }
            // Skip ids that just told us they are overloaded. Without this every
            // question paid the start timeout for the same dead model again.
            candidates.retain(|candidate| !gemini_is_down(candidate));
            if candidates.is_empty() {
                candidates.push(model.clone());
            }
            let mut index = 0;
            // Set when the configured model itself turned out to be retired.
            // Only then does the winner replace it in Settings: without this
            // guard a remembered fallback quietly overwrote a model the user had
            // picked, so the choice appeared to reset by itself.
            let mut replaced_configured = false;
            loop {
                let current = candidates[index].clone();
                let emitted_before = sink.map(|sink| sink.emitted()).unwrap_or(0);
                match ask_gemini(&key, &current, prompt, images, sink).await {
                    Ok(answer) => {
                        // Remember the winner so the next question skips the
                        // fallback chain entirely. Also write it to settings, so
                        // a retired id does not cost the same three failures on
                        // the next launch: the in-memory slot dies with the app.
                        gemini_mark_up(&current);
                        if let Ok(mut slot) = GEMINI_MODEL.lock() {
                            if slot.as_deref() != Some(current.as_str()) {
                                *slot = Some(current.clone());
                            }
                        }
                        if replaced_configured && current != model {
                            let _ = crate::commands::save_setting(
                                app.clone(),
                                "kiro-ai-model-gemini".into(),
                                serde_json::Value::String(current.clone()),
                            );
                        }
                        return Ok(answer);
                    }
                    Err(error) => {
                        // Once part of an answer reached the screen, switching
                        // to another model would append a second beginning to
                        // it. Stop with the partial answer instead.
                        if sink.map(|sink| sink.emitted()).unwrap_or(0) > emitted_before {
                            return Err(error);
                        }
                        // Retired/unknown ids and overloaded models can be
                        // retried; a bad key or a quota error cannot.
                        let retryable = is_retired_model_error(&error)
                            || is_empty_answer_error(&error)
                            || error.to_ascii_lowercase().contains("high demand")
                            || error.to_ascii_lowercase().contains("bağlantı hatası");
                        if !retryable {
                            return Err(error);
                        }
                        // A model that is loaded or too slow to answer stays out
                        // of the chain for a while, so the next question does not
                        // wait for it again. A retired id is not put aside: the
                        // remembered winner or the configured list replaces it.
                        if !is_retired_model_error(&error) {
                            gemini_mark_down(&current);
                        }
                        // Google sometimes names the exact replacement id.
                        if let Some(next) = next_gemini_model(&error, &current) {
                            if !candidates.iter().any(|c| c == &next) {
                                candidates.insert(index + 1, next);
                            }
                        }
                        // Only a retired id earns a new entry in Settings: that
                        // failure is permanent, and without the write every
                        // launch would re-discover it. An overloaded or silent
                        // model is a bad minute, not a bad choice — its
                        // replacement is remembered in memory for this session
                        // and the user's picked id comes back next start.
                        if current == model && is_retired_model_error(&error) {
                            replaced_configured = true;
                        }
                        if index + 1 >= candidates.len() {
                            return Err(error);
                        }
                        index += 1;
                    }
                }
            }
        }
        Provider::Claude => unreachable!(),
    }
}

/// Pick a replacement Gemini model from the API error. Google writes
/// "Please update your code to use models/gemini-3.8-flash" for a retired id,
/// and "experiencing high demand" for a temporarily overloaded one.
fn next_gemini_model(error: &str, current: &str) -> Option<String> {
    let lower = error.to_ascii_lowercase();
    if let Some(index) = lower.find("use models/") {
        let rest = &lower[index + "use models/".len()..];
        let id: String = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '.' || *c == '_')
            .collect();
        if !id.is_empty() && id != current {
            return Some(id);
        }
    }
    if lower.contains("high demand") && current != Provider::Gemini.default_model() {
        return Some(Provider::Gemini.default_model().to_string());
    }
    if is_retired_model_error(error) && current != Provider::Gemini.default_model() {
        return Some(Provider::Gemini.default_model().to_string());
    }
    None
}
fn is_retired_model_error(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("no longer available")
        || lower.contains("not found")
        || lower.contains("does not exist")
        || lower.contains("not supported")
}

/// A model that answers with nothing at all (only silence, or only thoughts) is
/// as unusable for this question as a retired id: the next model in the chain
/// usually replies. Retrying the same id would just repeat the wait.
fn is_empty_answer_error(message: &str) -> bool {
    message.contains("boş yanıt")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_data_strips_prefix_and_skips_terminators() {
        assert_eq!(sse_data(b"data: {\"a\":1}\n"), Some("{\"a\":1}"));
        assert_eq!(sse_data(b"data:{\"a\":1}\r\n"), Some("{\"a\":1}"));
        assert_eq!(sse_data(b"data: [DONE]\n"), None);
        assert_eq!(sse_data(b"event: message\n"), None);
        assert_eq!(sse_data(b"\n"), None);
        // A chunk split through a multi-byte character decodes to None instead
        // of panicking; the next complete line still gets through.
        assert_eq!(sse_data(&[0xC3]), None);
    }

    #[test]
    fn anthropic_events_yield_text_and_stop_reason() {
        let (text, stop) = anthropic_stream_event(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Mer"}}"#,
        );
        assert_eq!(text, "Mer");
        assert_eq!(stop, None);

        let (text, stop) = anthropic_stream_event(
            r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#,
        );
        assert!(text.is_empty());
        assert_eq!(stop.as_deref(), Some("max_tokens"));

        // Ping/other events must be ignored silently.
        let (text, stop) = anthropic_stream_event(r#"{"type":"ping"}"#);
        assert!(text.is_empty());
        assert_eq!(stop, None);
        let (text, stop) = anthropic_stream_event("not json");
        assert!(text.is_empty());
        assert_eq!(stop, None);
    }

    #[test]
    fn openai_events_yield_deltas_and_finish_reason() {
        let (text, finish) =
            openai_stream_chunk(r#"{"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}"#);
        assert_eq!(text, "hello");
        assert_eq!(finish, None);

        let (text, finish) = openai_stream_chunk(r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#);
        assert!(text.is_empty());
        assert_eq!(finish.as_deref(), Some("length"));
    }

    #[test]
    fn gemini_events_yield_parts_and_finish_reason() {
        let (text, finish) = gemini_stream_chunk(
            r#"{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}"#,
        );
        assert_eq!(text, "ab");
        assert_eq!(finish, None);

        let (text, finish) =
            gemini_stream_chunk(r#"{"candidates":[{"content":{"parts":[]},"finishReason":"MAX_TOKENS"}]}"#);
        assert!(text.is_empty());
        assert_eq!(finish.as_deref(), Some("MAX_TOKENS"));
    }

    #[test]
    fn gemini_events_ignore_thought_parts() {
        // Reasoning summaries arrive in their own parts; showing them as the
        // answer is what made the notch paint nothing while the model thought.
        let (text, finish) = gemini_stream_chunk(
            r#"{"candidates":[{"content":{"parts":[{"text":"secret","thought":true},{"text":"answer"}]}}]}"#,
        );
        assert_eq!(text, "answer");
        assert_eq!(finish, None);

        let (text, _) = gemini_stream_chunk(
            r#"{"candidates":[{"content":{"parts":[{"text":"only thought","thought":true}]},"finishReason":"STOP"}]}"#,
        );
        assert!(text.is_empty());
    }

    #[test]
    fn gemini_bodies_switch_thinking_off() {
        let contents = vec![serde_json::json!({ "role": "user", "parts": [{ "text": "hi" }] })];

        let body = gemini_body(&contents, ThinkingMode::BudgetZero, MAX_OUTPUT_TOKENS);
        assert_eq!(body["generationConfig"]["thinkingConfig"]["thinkingBudget"], 0);
        assert_eq!(body["generationConfig"]["maxOutputTokens"], MAX_OUTPUT_TOKENS);
        assert_eq!(body["contents"][0]["role"], "user");

        let body = gemini_body(&contents, ThinkingMode::LevelLow, MAX_OUTPUT_TOKENS);
        assert_eq!(body["generationConfig"]["thinkingConfig"]["thinkingLevel"], "low");
        assert!(body["generationConfig"]["thinkingConfig"].get("thinkingBudget").is_none());

        // A model that rejects both forms still gets a plain request.
        let body = gemini_body(&contents, ThinkingMode::Off, 1024);
        assert!(body["generationConfig"].get("thinkingConfig").is_none());
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
    }

    #[test]
    fn thinking_chain_starts_with_the_form_the_family_accepts() {
        // Gemini 3 and newer reject `thinkingBudget`, so the first request must
        // use `thinkingLevel`; a wrong guess would make the first answer of a
        // session pay for a rejected round-trip.
        assert_eq!(
            thinking_chain("gemini-flash-latest"),
            [
                ThinkingMode::LevelLow,
                ThinkingMode::BudgetZero,
                ThinkingMode::Off
            ]
        );
        assert_eq!(
            thinking_chain("gemini-3.8-flash"),
            [
                ThinkingMode::LevelLow,
                ThinkingMode::BudgetZero,
                ThinkingMode::Off
            ]
        );
        assert_eq!(
            thinking_chain("gemini-4-hydrogen"),
            [
                ThinkingMode::LevelLow,
                ThinkingMode::BudgetZero,
                ThinkingMode::Off
            ]
        );
        // A legacy/custom id keeps the older form first.
        assert_eq!(
            thinking_chain("gemini-2.5-flash"),
            [
                ThinkingMode::BudgetZero,
                ThinkingMode::LevelLow,
                ThinkingMode::Off
            ]
        );
    }

    #[test]
    fn only_thinking_errors_trigger_a_downgrade() {
        assert!(thinking_rejected(
            r#"{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \"thinkingConfig\" at 'generation_config'."}}"#
        ));
        assert!(thinking_rejected(
            r#"{"error":{"message":"Thinking level is not supported for this model."}}"#
        ));
        assert!(!thinking_rejected(r#"{"error":{"message":"API key not valid."}}"#));
        assert!(!thinking_rejected(r#"{"error":{"message":"Quota exceeded."}}"#));
    }

    #[test]
    fn a_busy_gemini_says_so_in_turkish() {
        // The raw Google sentence is not a useful thing to show in the notch.
        let message = friendly_error(
            "Gemini",
            503,
            r#"{"error":{"code":503,"message":"This model is currently experiencing high demand."}}"#,
        );
        assert!(message.contains("sunucu şu an yoğun"), "{message}");
        assert!(!message.contains("high demand"), "{message}");
        // A retired id keeps the model hint, not the busy one.
        let message = friendly_error(
            "Gemini",
            404,
            r#"{"error":{"message":"models/gemini-2.0-flash is not found for API version v1beta"}}"#,
        );
        assert!(message.contains("seçili model"), "{message}");
    }

    #[test]
    fn provider_chain_prefers_keyed_http_providers() {
        // Claude has no key: Gemini wins over OpenAI.
        let chain = provider_candidates(Provider::Claude, "auto", |candidate| {
            matches!(candidate, Provider::Gemini | Provider::OpenAI)
        });
        assert_eq!(chain, vec![Provider::Gemini, Provider::OpenAI]);

        let chain = provider_candidates(Provider::Claude, "auto", |candidate| {
            matches!(candidate, Provider::OpenAI)
        });
        assert_eq!(chain, vec![Provider::OpenAI]);

        // A pinned CLI keeps the CLI even when other keys exist.
        let chain = provider_candidates(Provider::Claude, "cli", |candidate| {
            candidate == Provider::OpenAI
        });
        assert_eq!(chain, vec![Provider::Claude]);

        // A Claude key is used as-is; explicit providers are never rewritten.
        let chain = provider_candidates(Provider::Claude, "auto", |_| true);
        assert_eq!(chain, vec![Provider::Claude]);
        let chain = provider_candidates(Provider::OpenAI, "auto", |_| true);
        assert_eq!(chain, vec![Provider::OpenAI]);

        // No keys at all: keep Claude so the CLI path still gets a chance.
        let chain = provider_candidates(Provider::Claude, "auto", |_| false);
        assert_eq!(chain, vec![Provider::Claude]);
    }

    #[test]
    fn only_key_problems_switch_providers() {
        assert!(is_provider_switchable(
            "Gemini API hatası: anahtar geçersiz ya da yetkisiz. Anahtar düğmesinden yenile (API key not valid)"
        ));
        assert!(is_provider_switchable("401 Unauthorized"));
        // Quota and network errors would repeat on the next provider.
        assert!(!is_provider_switchable("kota doldu"));
        assert!(!is_provider_switchable("Bağlantı hatası: timed out"));
        assert!(!is_provider_switchable("seçili model kullanılamıyor"));
    }

    #[test]
    fn retired_gemini_ids_are_mapped_to_current_default() {
        assert_eq!(normalize_model(Provider::Gemini, "gemini-2.5-flash"), "gemini-flash-latest");
        assert_eq!(normalize_model(Provider::Gemini, "gemini-3.5-flash"), "gemini-flash-latest");
        assert_eq!(normalize_model(Provider::Gemini, "gemini-3.6-flash"), "gemini-flash-latest");
        // A deliberately chosen newer or lite model is left alone.
        assert_eq!(normalize_model(Provider::Gemini, "gemini-3.8-flash"), "gemini-3.8-flash");
        assert_eq!(normalize_model(Provider::Gemini, "gemini-3.1-flash-lite"), "gemini-3.1-flash-lite");
        assert_eq!(
            next_gemini_model(
                "models/gemini-2.0-flash is no longer available. Please update your code to use models/gemini-3.8-flash",
                "gemini-2.0-flash"
            )
            .as_deref(),
            Some("gemini-3.8-flash")
        );
    }

    #[test]
    fn overloaded_models_are_skipped_until_their_cooldown_ends() {
        let model = "gemini-3.8-flash";
        gemini_mark_up(model);
        assert!(!gemini_is_down(model));

        gemini_mark_down(model);
        assert!(gemini_is_down(model));
        // Other ids are unaffected, and a winner clears its own entry.
        assert!(!gemini_is_down("gemini-3.1-flash-lite"));
        gemini_mark_up(model);
        assert!(!gemini_is_down(model));

        // An expired entry no longer blocks the model.
        if let Ok(mut slot) = GEMINI_DOWN.lock() {
            slot.push((model.to_string(), Instant::now() - Duration::from_secs(1)));
        }
        assert!(!gemini_is_down(model));
    }

    #[test]
    fn a_silent_provider_is_given_up_on_quickly() {
        // Google holds an overloaded request for around 100 seconds before it
        // answers `503 high demand`; the notch cannot wait that long.
        assert!(HTTP_START_TIMEOUT <= Duration::from_secs(30));
        // A healthy but slow model still needs room: `gemini-3.5-flash` was
        // measured at 15.3 s to its first token, because Gemini sends the
        // headers only once that token exists.
        assert!(HTTP_START_TIMEOUT >= Duration::from_secs(20));
        // The bound only covers the start, so it must stay well under the idle
        // read timeout that protects a long streamed answer.
        assert!(HTTP_START_TIMEOUT < HTTP_IDLE_TIMEOUT);
    }

    /// End-to-end check of the SSE reader against a local socket: the body is
    /// written in pieces and one multi-byte character is split across two
    /// writes, which is exactly what a real TLS stream does.
    #[test]
    fn sse_reader_reassembles_split_utf8_and_lines() {
        use std::io::Write as _;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        std::thread::spawn(move || {
            use std::io::Read as _;
            let (mut socket, _) = listener.accept().unwrap();
            // Read the request head first: answering before hyper has sent its
            // request makes the client reject the response as unexpected.
            let mut request = Vec::new();
            let mut byte = [0u8; 1];
            while !request.ends_with(b"\r\n\r\n") {
                match socket.read(&mut byte) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => request.push(byte[0]),
                }
            }
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
                )
                .unwrap();
            // "data: {\"text\":\"Gün\"}\n\ndata: [DONE]\n\n" as two chunks, with
            // the two bytes of `ü` split across the chunk boundary.
            let first: &[u8] = b"data: {\"text\":\"G\xc3";
            let second: &[u8] = b"\xbcn\"}\n\ndata: [DONE]\n\n";
            socket
                .write_all(format!("{:x}\r\n", first.len()).as_bytes())
                .unwrap();
            socket.write_all(first).unwrap();
            socket.write_all(b"\r\n").unwrap();
            socket.flush().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(30));
            socket
                .write_all(format!("{:x}\r\n", second.len()).as_bytes())
                .unwrap();
            socket.write_all(second).unwrap();
            socket.write_all(b"\r\n0\r\n\r\n").unwrap();
            socket.flush().unwrap();
        });

        let collected = tauri::async_runtime::block_on(async move {
            let client = reqwest::Client::new();
            let mut response = client.get(format!("http://{addr}/")).send().await.unwrap();
            let mut out = Vec::new();
            read_sse(&mut response, |data| out.push(data.to_string()))
                .await
                .unwrap();
            out
        });

        assert_eq!(collected, vec!["{\"text\":\"Gün\"}".to_string()]);
    }
}

/// Open the provider's key page from the notch. Only these URLs can be opened,
/// so a malformed setting can never turn this into a generic URL launcher.
#[tauri::command]
pub fn ai_open_console(provider: String) -> Result<(), String> {
    let url = match provider.trim().to_ascii_lowercase().as_str() {
        "openai" | "chatgpt" | "gpt" => "https://platform.openai.com/api-keys",
        "gemini" | "google" => "https://aistudio.google.com/app/apikey",
        _ => "https://console.anthropic.com/settings/keys",
    };
    open_url(url)
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(kiro_windows)]
    {
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let verb: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let target: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                None,
                windows::core::PCWSTR(verb.as_ptr()),
                windows::core::PCWSTR(target.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        return if result.0 as usize <= 32 {
            Err(format!("Tarayıcı açılamadı (kod {})", result.0 as usize))
        } else {
            Ok(())
        };
    }

    // xdg-open is the freedesktop entry point every desktop ships; it honours the
    // user's default browser.
    #[cfg(not(kiro_windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Tarayıcı açılamadı: {e}"))
    }
}
