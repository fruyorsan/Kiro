<div align="center">

## Kiro

**A notch and a dock for Windows.** Physics-animated, reactive, and built to replace your taskbar.

<img src="docs/logo.png" width="128" alt="Kiro logo" />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/wordmark-dark.png" />
  <img src="docs/wordmark-light.png" height="44" alt="Kiro" />
</picture>

[![Latest release](https://shieldcn.dev/badge/release-v1.8.2.svg?logo=lu:Tag)](https://github.com/fruyorsan/Kiro/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/fruyorsan/Kiro/total.svg)](https://github.com/fruyorsan/Kiro/releases)
[![License](https://shieldcn.dev/github/license/fruyorsan/Kiro.svg?logo=lu:Scale)](LICENSE)
[![Platform](https://shieldcn.dev/badge/platform-Windows.svg?logo=ri:FaWindows)](https://www.microsoft.com/windows)

[**Download**](https://github.com/fruyorsan/Kiro/releases/latest) &nbsp;·&nbsp; [Features](#features) &nbsp;·&nbsp; [Install](#install) &nbsp;·&nbsp; [Settings](SETTINGS.md) &nbsp;·&nbsp; [Report a bug](https://github.com/fruyorsan/Kiro/issues/new/choose)

<br />

<img src="docs/screenshots/desktop.webp" width="860" alt="Kiro's notch and dock on a Windows desktop" />

</div>

<br />

> **Antivirus warnings:** Windows, Avast and Kaspersky may flag Kiro because the executable is not code-signed yet. Kiro is open source, has no telemetry or tracking, and you can read every line or build it yourself from this repository.

## Features

| What you get | How |
| --- | --- |
| **A notch that does things** | Music, a Control Center you arrange yourself, status, a calendar and a file shelf in one spring-animated island. |
| **A dock that replaces your taskbar** | Mirrors your real taskbar, same pinned apps and order, with real icons and names, and a dot on apps that want your attention. |
| **Native where it counts** | The tray opens the real Windows flyout, and Quit ends an app like Task Manager's End task. |
| **Out of your way** | Fixed, Smart or Peek modes, and both stay hidden over fullscreen games. |
| **Made for your setup** | Every monitor, one monitor, or a specific one. Solid, glass or Material You styles with your own accent color. English and Turkish. Every option lives in a plain `settings.json`. |
| **Light on the system** | Audio capture, cursor tracking and thumbnail work pause themselves when nothing needs them. |
| **Automatic Performance Mode** | When a fullscreen game or app is in front, Kiro stops capturing previews/icons, slows background polling, disables blur and animation work, stops trimming memory, and hides its always-on-top windows at the OS level so the game keeps direct-to-screen flip. Everything returns on exit. |
| **Kiro FPS Boost** | While a game runs: the game process gets priority, Windows' efficiency throttling is switched off for it, and notifications are muted so they cannot break the game's flip path. The second time Kiro sees the same game it pins it to the high-performance GPU and disables fullscreen optimizations for it. A hardware audit reports what is actually costing frames. Every change is reversible. |

<div align="center">
<table>
  <tr>
    <td align="center"><img src="docs/screenshots/island.png" height="130" alt="The Kiro notch" /></td>
    <td align="center"><img src="docs/screenshots/dock.png" height="130" alt="The Kiro dock" /></td>
  </tr>
  <tr>
    <td align="center"><sub>The notch</sub></td>
    <td align="center"><sub>The dock</sub></td>
  </tr>
</table>
</div>

## Install

1. Download `Kiro-Setup-<version>.exe` from the [latest release](https://github.com/fruyorsan/Kiro/releases/latest).
2. Choose **Just me** or **All users**. An all-users install asks for administrator permission once.
3. Kiro starts with a short splash, then the notch and dock appear together.

Kiro updates itself: a green dot on the notch means an update is ready, and **Auto Update** in **Settings › About** installs it for you. Turn on **Get pre-releases** there to receive early builds before the weekly release. **Uninstall** from Windows Settings › Apps or from **Settings › About** puts your taskbar back.

<details>
<summary>Verify your download</summary>

<br />

Only download Kiro from the [releases page](https://github.com/fruyorsan/Kiro/releases) of this repository. Each release has a `SHA256SUMS.txt`. Compare the output of this command with the matching line:

```powershell
Get-FileHash .\Kiro-Setup-<version>.exe -Algorithm SHA256
```

</details>

## Usage

**Notch panels.** Scroll or swipe on the notch to change panel.

| Panel | What it does |
| --- | --- |
| **Music** | Album art, track info, playback controls, a visualizer, and a switch between several playing apps. |
| **Control Center** | Wi-Fi, Bluetooth, Do Not Disturb, volume and brightness. Drag tiles, buttons and sliders into your own layout. |
| **Status** | Battery (hidden on desktops without one) and weather, in a layout you choose. |
| **Calendar** | Day, week, month and agenda views, a timer, a stopwatch and Pomodoro. |
| **Shelf** | Drop files or text on the notch and drag them out later. |

**Visibility modes.** The notch and the dock each have their own.

| Mode | Behavior |
| --- | --- |
| **Fixed** | Always visible. The dock reserves screen space like a normal taskbar. |
| **Smart** | Hides when another window overlaps it and reveals on hover. |
| **Peek** | Hidden until the cursor reaches the screen edge, or a media event arrives. |

In Smart and Peek both stay hidden, and click-through, while a fullscreen app is in front.

**Multiple monitors.** Under **Show On**, pick **Primary Monitor** (the default), **All Monitors** or a **Specific Monitor** for the dock and the notch separately. Each extra monitor gets its own windows, so **All Monitors** uses more memory than a single display.

## Troubleshooting

<details>
<summary><b>The dock shows over my game</b></summary>

<br />

Kiro hides the dock and notch whenever a fullscreen game covers the whole monitor, in every dock mode. It does this natively (`ShowWindow`), not just by moving them off-screen, because a visible topmost window forces Windows to composite the game instead of letting it flip straight to the display. Only the monitor with the game is affected and everything comes back when you exit. Turn **Fullscreen Game Boost** off in Settings › General if you want the dock to stay visible. If something still appears, open an issue with the game and its display mode (fullscreen, borderless or windowed).

</details>

<details>
<summary><b>The Windows taskbar did not come back</b></summary>

<br />

Start Kiro again; it restores the taskbar on launch even after a crash. Uninstalling from Windows Settings › Apps or from **Settings › About** brings it back too.

</details>

<details>
<summary><b>Kiro uses a lot of memory</b></summary>

<br />

Every window runs in its own WebView2 process, so each monitor adds a notch and a dock. Set **Show On** to one monitor to cut it down.

</details>

<details>
<summary><b>Brightness does not change on my external monitor</b></summary>

<br />

External monitors are controlled over DDC/CI. Turn DDC/CI on in the monitor's own menu, and connect it directly if you use a dock or adapter, since some do not pass it on.

</details>

<details>
<summary><b>Something else is broken</b></summary>

<br />

Open **Settings › About › Copy Diagnostics** and paste the result into a [bug report](https://github.com/fruyorsan/Kiro/issues/new/choose). It includes your versions, monitors and recent log.

</details>

## Build from source

You need [Rust](https://rustup.rs/) and [Bun](https://bun.sh/) on Windows.

```bash
git clone https://github.com/fruyorsan/Kiro.git
cd Kiro
bun install
bun run tauri dev
```

`bun run tauri build` makes a release build. Before a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

These are ideas under consideration, not promises.

- [ ] Background tray programs (antivirus, VPN) in the notch
- [ ] Lower memory use, with Settings loaded on demand
- [ ] Code signing for the installer
- [x] Stable and pre-release update channels
- [x] Multiple media sessions, Task Manager in the dock menu, show desktop corner

See the [open issues](https://github.com/fruyorsan/Kiro/issues) for requests and known bugs.

## Built with

[![Tauri](https://img.shields.io/badge/Tauri-24C8D8?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)

## License

Kiro is open source under the [GPLv3](LICENSE).

## Credits

Kiro began as a fork of [Nectar](https://github.com/kua8/Nectar) by [kua8](https://github.com/kua8), which itself began as a fork of [Bloom](https://github.com/SehajveerSingh2005/bloom) by Sehajveer Singh. The original concept and the code it grew from are theirs. Kiro is now maintained independently under the Kiro name.
