# Contributing to Kiro

Thanks for wanting to help. Bug reports, ideas, translations and pull requests are all welcome.

## Before you start

- **Found a bug?** Open an [issue](https://github.com/fruyorsan/Kiro/issues/new/choose) with the bug form. The version, your Windows build, and **Copy Diagnostics** from Settings > About make a big difference.
- **Have a question or an idea?** Start a [discussion](https://github.com/fruyorsan/Kiro/discussions) first, or a feature request if it is concrete.
- **Want to send a pull request for a new feature?** Please open an issue or discussion first so we can agree on it before you spend time on it. Bug fixes, translations and documentation fixes can go straight to a pull request.
- **Security problem?** Do not open an issue. Report it privately in the [Security tab](https://github.com/fruyorsan/Kiro?tab=security-ov-file#).

## Setting up

You need [Rust](https://rustup.rs/) and [Bun](https://bun.sh/), on Windows.

```bash
git clone https://github.com/fruyorsan/Kiro.git
cd Kiro
bun install
bun run tauri dev
```

Useful checks before you push:

```bash
npx tsc --noEmit
cd src-tauri && cargo test --bin kiro
```

To try a release build, run `bun run tauri build --no-bundle`. The exe is `src-tauri/target/debug/kiro.exe` for dev and `src-tauri/target/release/kiro.exe` for a release build.

### Working on Kiro without losing your taskbar

Kiro's dock replaces the taskbar, so a dev session normally hides it too. In a
debug build, set `KIRO_KEEP_TASKBAR=1` to leave the taskbar alone:

```powershell
$env:KIRO_KEEP_TASKBAR="1"; bun run tauri dev
```

Nothing is hidden in that mode, so the shutdown and crash-recovery paths have
nothing to undo and behave exactly as in a normal run. A release build ignores
the variable.


## Pull requests

- Keep one change per pull request. A small, focused change is reviewed much faster.
- Say what changed and why, and which Windows version and monitor setup you tested on.
- Test on a real build. Many things, like the dock, the taskbar and the tray flyout, behave differently in a dev server than in the real app.
- If you add or change a `kiro-*` setting, document it in [SETTINGS.md](SETTINGS.md) in the same pull request.
- User-facing text goes in `src/locales/en.json`. Add the same keys to the other languages if you can; missing keys fall back to English.
- Keep code comments to a minimum. Match the style of the code around your change.
- Do not commit generated files, build output or your own settings.

## Translations

Translations live in `src/locales/<code>.json`. To add a language, add the file, list it in `src/i18n.ts`, and add it to `LOCALES` in `src-tauri/src/i18n.rs` so the tray menu is translated too. A partial translation is fine.

## License

Kiro is licensed under the [GPLv3](LICENSE). By sending a pull request you agree that your contribution is released under the same license. Third-party attribution is listed in [NOTICE.md](NOTICE.md).
