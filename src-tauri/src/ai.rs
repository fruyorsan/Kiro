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
use tauri::AppHandle;

const MAX_PROMPT: usize = 4000;
const CLI_TIMEOUT: Duration = Duration::from_secs(120);
const HTTP_TIMEOUT: Duration = Duration::from_secs(90);

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
        .timeout(HTTP_TIMEOUT)
        .pool_max_idle_per_host(1)
        .pool_idle_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(HTTP_CLIENT.get_or_init(|| client))
}

#[derive(Clone, Copy, PartialEq, Eq)]
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
            Provider::Gemini => "gemini-3.5-flash",
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
}

#[derive(Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiPart>>,
}

#[derive(Deserialize)]
struct GeminiPart {
    #[serde(default)]
    text: Option<String>,
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

async fn ask_anthropic(key: &str, model: &str, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{ "role": "user", "content": prompt }]
    });
    let client = http_client()?;
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Bağlantı hatası: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Claude API hatası: {}", error_message(&text)));
    }
    let parsed: AnthropicResponse = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let answer = parsed
        .content
        .unwrap_or_default()
        .into_iter()
        .map(|block| block.text)
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string();
    if answer.is_empty() {
        return Err("Claude boş yanıt döndürdü".into());
    }
    Ok(answer)
}

async fn ask_openai(key: &str, model: &str, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "messages": [{ "role": "user", "content": prompt }]
    });
    let client = http_client()?;
    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("authorization", format!("Bearer {key}"))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Bağlantı hatası: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("ChatGPT API hatası: {}", error_message(&text)));
    }
    let parsed: OpenAiResponse = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let answer = parsed
        .choices
        .unwrap_or_default()
        .into_iter()
        .filter_map(|choice| choice.message.content)
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string();
    if answer.is_empty() {
        return Err("ChatGPT boş yanıt döndürdü".into());
    }
    Ok(answer)
}

async fn ask_gemini(key: &str, model: &str, prompt: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "maxOutputTokens": 1024 }
    });
    let client = http_client()?;
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );
    let response = client
        .post(url)
        .query(&[("key", key)])
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Bağlantı hatası: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Gemini API hatası: {}", error_message(&text)));
    }
    let parsed: GeminiResponse = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let answer = parsed
        .candidates
        .unwrap_or_default()
        .into_iter()
        .filter_map(|candidate| candidate.content)
        .flat_map(|content| content.parts.unwrap_or_default())
        .filter_map(|part| part.text)
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string();
    if answer.is_empty() {
        return Err("Gemini boş yanıt döndürdü".into());
    }
    Ok(answer)
}

fn claude_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(appdata) = std::env::var_os("APPDATA") {
        out.push(PathBuf::from(&appdata).join("npm").join("claude.cmd"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        out.push(PathBuf::from(&local).join("Programs").join("claude").join("claude.exe"));
        out.push(PathBuf::from(&local).join("Programs").join("Claude").join("claude.exe"));
    }
    out
}

fn ask_cli(prompt: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let exe = claude_candidates()
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("claude"));
    let is_script = exe
        .extension()
        .map(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    let mut command = if is_script {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg(&exe);
        cmd
    } else {
        std::process::Command::new(&exe)
    };
    command
        .args(["-p", "--output-format", "text"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

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

#[tauri::command]
pub async fn ai_ask(app: AppHandle, prompt: String) -> Result<String, String> {
    let result = ask_provider(app, prompt).await;
    // The response body, the JSON parse and the answer string are the only big
    // allocations in this path. They are dropped by now; ask the idle reclaim
    // worker to push the freed pages out once the user stops typing/reading.
    crate::memory_saver::trim_soon();
    result
}

async fn ask_provider(app: AppHandle, prompt: String) -> Result<String, String> {
    let prompt: String = prompt.trim().chars().take(MAX_PROMPT).collect();
    if prompt.is_empty() {
        return Err("Boş mesaj".into());
    }

    let provider =
        Provider::from_setting(&setting(&app, "kiro-ai-provider").unwrap_or_default());
    let backend = setting(&app, "kiro-ai-backend").unwrap_or_else(|| "auto".into());

    // Claude can run through the local Code CLI when there is no API key.
    if provider == Provider::Claude && backend != "cli" {
        if let Some(key) = provider_key(&app, provider) {
            let model = provider_model(&app, provider);
            return ask_anthropic(&key, &model, &prompt).await;
        }
        if backend == "api" {
            return Err(
                "Claude API anahtarı yok. Çentikteki anahtar simgesine tıklayıp ekleyebilirsin."
                    .into(),
            );
        }
    }
    if provider == Provider::Claude {
        return tauri::async_runtime::spawn_blocking(move || ask_cli(&prompt))
            .await
            .map_err(|error| error.to_string())?;
    }

    let key = provider_key(&app, provider).ok_or_else(|| {
        format!(
            "{} API anahtarı yok. Çentikteki anahtar simgesine tıklayıp ekleyebilirsin.",
            provider.label()
        )
    })?;
    let model = provider_model(&app, provider);
    match provider {
        Provider::OpenAI => ask_openai(&key, &model, &prompt).await,
        Provider::Gemini => {
            let mut current = model;
            let mut attempt = ask_gemini(&key, &current, &prompt).await;
            // Google retires ids without notice and sometimes answers "high
            // demand" for the newest model. Its own error text names the
            // replacement, so follow that and retry instead of failing.
            for _ in 0..2 {
                let next = match &attempt {
                    Ok(_) => None,
                    Err(error) => next_gemini_model(error, &current),
                };
                let Some(next) = next else {
                    break;
                };
                current = next;
                attempt = ask_gemini(&key, &current, &prompt).await;
            }
            attempt
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
    if lower.contains("high demand") && current != "gemini-3.5-flash" {
        return Some("gemini-3.5-flash".to_string());
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
    if result.0 as usize <= 32 {
        Err(format!("Tarayıcı açılamadı (kod {})", result.0 as usize))
    } else {
        Ok(())
    }
}
