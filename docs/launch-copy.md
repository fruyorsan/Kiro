# Launch copy

Paste-ready text for reaching people outside Turkey. Nothing here is clever for
its own sake: every block is short, specific and ends with one action.

Rules that matter more than the wording:

- One link per message, and never in the first message of a cold DM.
- Personalise the first line every time. A message that could have been sent to
  anyone reads as spam and gets reported as spam.
- 10–15 DMs a day from one account, not 100. The limit is the ban threshold.
- Comment on a post before DMing the account. A real comment first, the DM the
  next day.
- Send the 15-second clip, not a wall of text. People share what is already made.

## Cold DM, English

> Hey — the [specific video] you posted is great.
>
> I build Kiro, a free open-source Windows shell: dynamic-island notch, dock,
> seasonal themes, AI in the notch, and a game layer that steps aside for
> fullscreen play.
>
> 10-second clip you can use as-is: [link]
>
> Repo: github.com/fruyorsan/Kiro
>
> If it fits your feed, take it — no strings. Either way, thanks for the desktop
> content.

Follow-up, only if they reply, never as a second cold message:

> Everything is free and GPLv3, screenshots and a press kit are here:
> github.com/fruyorsan/Kiro/blob/main/PRESS.md

## Cold DM, Turkish

> Selam, [şu video]'nuz çok iyi olmuş.
>
> Windows için Kiro diye ücretsiz, açık kaynak bir shell yaptım: çentik, dock,
> mevsim temaları, çentikte yapay zekâ, oyunlarda kendi kendine kenara çekilen
> bir katman.
>
> 10 saniyelik hazır klip: [link]
>
> Repo: github.com/fruyorsan/Kiro
>
> İşinize yararsa kullanın, hiçbir şart yok.

## X / Twitter

> I replaced the Windows taskbar with a notch.
>
> Rust + Tauri, GPLv3, no telemetry.
>
> Seasonal themes, Claude/ChatGPT/Gemini in the notch, and it hides itself when a
> game goes fullscreen.
>
> github.com/fruyorsan/Kiro

Second variant, for a quote-tweet of your own clip:

> every time a game goes fullscreen, this thing removes itself from the compositor
> so the game keeps its direct-to-screen flip.
>
> that was the whole reason I built it. everything else — notch, dock, seasons, AI
> — came after.

## Reddit

Read each subreddit's self-promotion rule before posting; r/Windows11 removes
most project posts, r/desktopmods and r/software are friendlier. Post the video
first, put the link in a comment if the rules demand it.

**r/desktopmods**

> **I built a taskbar replacement that hides itself when a game goes fullscreen**
>
> Three weeks ago I got tired of the Windows taskbar eating frames in fullscreen
> games, so I wrote a replacement in Rust. It grew into a notch and a dock.
>
> - notch: music, Wi-Fi/Bluetooth/volume/brightness, calendar, notes, file shelf
> - dock: mirrors the real taskbar, same pinned apps and order
> - themes: four surface styles, four seasonal effects, custom accent and mascot
> - AI: Claude/ChatGPT/Gemini answer inside the notch
> - fullscreen: raises the game's priority, mutes toasts, hides its own windows at
>   the OS level, reverts on exit. No injection, anti-cheat processes untouched.
>
> Free, GPLv3, no telemetry, no account. Windows 10/11 and Linux.
> github.com/fruyorsan/Kiro

**r/software**

> **Kiro – open-source Windows shell replacement (notch + dock + seasonal themes)**
>
> Free, GPLv3, no telemetry. Replaces the taskbar with a dynamic-island notch and
> a dock, ships four surface styles and four seasonal effects, and puts Claude,
> ChatGPT and Gemini in the notch. It steps aside automatically for fullscreen
> games.
>
> Windows 10/11, Linux. Source and installers: github.com/fruyorsan/Kiro

## Hacker News (Show HN)

Title: `Show HN: Kiro – a Windows shell replacement written in Rust`

> I wanted the taskbar to stop costing frames in fullscreen games, so I replaced
> it. Kiro is a Tauri app with a Rust backend: a notch and a dock instead of the
> taskbar, four surface styles and four seasonal effects, and an AI panel that
> talks to Claude, ChatGPT or Gemini.
>
> The part I care about is the fullscreen path. When a game goes fullscreen, Kiro
> raises the game's process and memory priority, clears EcoQoS throttling, mutes
> toast notifications, and hides its own always-on-top windows at the OS level so
> the game keeps its direct-to-screen flip. All of it reverts on exit. It never
> injects a DLL and never opens the game's memory, so anti-cheat processes are
> left alone.
>
> GPLv3, no telemetry. Windows 10/11, Linux.
>
> github.com/fruyorsan/Kiro

## Product Hunt

Tagline (60 chars max):

> A Windows shell with a notch, seasons and AI

Description:

> Kiro replaces the Windows taskbar with a dynamic-island notch and a dock, ships
> four surface styles and four seasonal effects, and puts Claude, ChatGPT and
> Gemini inside the notch. When a game goes fullscreen it hides itself at the OS
> level so the game keeps its frames. Free, open source, no telemetry.

## Reels / TikTok / Shorts captions

> I deleted my Windows taskbar.
>
> notch + dock, four seasons, AI in the notch, and it disappears when you launch a
> game. free and open source.

Hashtags: `#windows11 #desksetup #windowsdesktop #opensource #rust #techtok`

## First OEM email

The first real money is here, not on social. Send to gaming cafés, kiosk and
digital-signage integrators, and esports venues. Ten a day, personalised, with a
30-second clip attached.

Subject: `Your PCs, your logo, no Windows taskbar`

> Hi [name],
>
> I make Kiro, an open-source Windows shell that replaces the taskbar with a notch
> and a dock (30-second clip attached).
>
> For venues it solves a specific problem: the taskbar is the one piece of Windows
> your customers can rearrange, and it is the one piece you cannot brand. Kiro can
> ship as a white-label build — your name, your logo, your accent colour, a fixed
> layout, guests unable to reconfigure it, silent install across the room.
>
> It is €800 one-off for a white-label build, or €500 a year for a commercial
> licence if you are bundling it into your own product. Managed deployment with a
> central configuration is €300.
>
> Happy to send a build for one machine so you can see it before deciding.
>
> Furkan
> github.com/fruyorsan/Kiro
