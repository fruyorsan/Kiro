# Kiro FPS Boost

Kiro's FPS boost is a capability, not a checklist the user has to configure per
game. It has two halves: **silent, self-reverting work while a game runs** and an
**honest hardware audit** that says what is actually costing frames.

Everything below is implemented in `src-tauri/src/fps_boost.rs` and runs from the
existing foreground watcher, next to `perf.rs` and `game_boost.rs`.

## 1. Session boost (automatic, reversible)

Engages ~1.2 s after a fullscreen game takes the foreground and releases ~2.5 s
after it goes away, so alt-tab and notifications do not flap it.

| What | API | Why it matters |
| --- | --- | --- |
| Raise the game process | `SetPriorityClass` → `HIGH_PRIORITY_CLASS` (4+ cores) / `ABOVE_NORMAL` | Background work cannot preempt the render thread |
| Turn off EcoQoS for the game | `SetProcessInformation(ProcessPowerThrottling)` with `EXECUTION_SPEED` cleared | Windows otherwise parks game threads on efficiency cores |
| Raise memory priority | `SetProcessInformation(ProcessMemoryPriority)` = 7 | The game's pages stop being the first trim candidates mid-frame |
| Mute toast notifications | `Notifications\Settings\NOC_GLOBAL_SETTING_TOASTS_ENABLED = 0` | A toast is a new topmost window: DWM composites one frame over the game and that shows up in 1% lows |

None of these need a reboot, none touch the game's files, and none are
persistent:

- priority, EcoQoS and memory priority are per-process and die with the game;
- the toast setting is written back on release, on quit, and — if Kiro is
  killed — from `fps-toast-backup.json` on the next launch.

Anti-cheat protected processes reject `OpenProcess`; Kiro then simply does
nothing for that game. It never injects a DLL and never opens the game's memory.

Browsers, players, editors and the shell are excluded (`boostable`), because they
go fullscreen for reasons that have nothing to do with gaming.

## 2. Per-application profile (after the second sighting)

The two biggest wins on a hybrid laptop are registry settings Windows already
exposes in **Settings › Display › Graphics**:

| Value | Where | Effect |
| --- | --- | --- |
| `GpuPreference=2;` | `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`, value name = full exe path | Routes the game to the discrete GPU instead of rendering on the iGPU |
| `~ DISABLEDXMAXIMIZEDWINDOWEDMODE` | `HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers` | Disables fullscreen optimizations for that exe, giving it a real exclusive flip chain |

Kiro writes these only after it has seen the **same executable** play fullscreen
twice, so launchers, trailers and one-off benchmark tools never get a profile.
The previous value of each key is stored in `fps-profiles.json` first; Settings
shows every profile with an **Undo** button and a **Undo all** action.

## 3. Optional system gaming settings

Off by default, one switch in Settings. Each value is backed up in
`fps-system-backup.json` and restored exactly when the switch is turned off:

- `System\GameConfigStore\GameDVR_Enabled = 0` — no background recording
- `Software\Microsoft\Windows\CurrentVersion\GameDVR\AppCaptureEnabled = 0`
- `Software\Microsoft\GameBar\AutoGameModeEnabled = 1`
- `Software\Microsoft\DirectX\GraphicsSettings\SwapEffectUpgradeEnable = 1` —
  optimizations for windowed games

## 4. Hardware audit

Reads the machine and returns findings with measured ranges instead of a
promise:

- display GPU (`nvidia-smi display_active`) → MUX / hybrid routing loss
- enforced GPU power limit vs max → Dynamic Boost / laptop performance mode
- RAM modules → Flex Mode (asymmetric capacities lose dual-channel)
- refresh rate → suggested frame cap for thermal headroom
- HAGS, storage type

This is deliberately the part that tells the user *"in this scene your GPU is at
96%, CPU tweaks will not show up"*. Selling more tweaks than the machine can
show is how the rest of this category loses trust.

## What Kiro deliberately does not do

- No DLL injection into the game process (anti-cheat bans).
- No RAM/standby emptying during play (`EmptyWorkingSet` adds page faults).
- No service disabling, MSI-mode/IRQ tricks, or TCP "optimizations".
- No claiming a frame-generation multiplier it cannot deliver.

The remaining ceiling on an OS-level tool is small; the honest win is that Kiro
removes everything *around* the game that steals frames, and then tells the user
where the real bottleneck is.
