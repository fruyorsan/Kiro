# Releasing

Every user-visible change ships as a new release, because installed copies
update themselves. This is the whole loop:

```powershell
bun run bump 1.9.6                 # bumps all six version files + both lockfiles
git add -A
git commit -m "fix(notch): ..."
git tag -a v1.9.6 -m "Kiro v1.9.6"
git push origin main
git push origin v1.9.6             # <- this starts the release
```

Pushing the tag runs `.github/workflows/release.yml`, which verifies that every
version file matches the tag, builds both platforms, signs the artifacts,
verifies each signature against the key compiled into the app, and publishes the
release with `latest.json`. Nothing else has to be pressed.

## What users get

| Setting | Behaviour |
| --- | --- |
| Auto-update on (default) | Checks once a day, downloads in the background, installs silently, and Kiro restarts on the new version. |
| Auto-update off | The notch shows an update badge; the user installs it from Settings. |

A release must be at least 24 hours old before it auto-installs
(`MIN_AUTO_INSTALL_AGE_SECS` in `src-tauri/src/updater.rs`). That window is the
protection against a broken release reaching everyone within minutes of being
published: there is time to delete a bad release before it spreads.

The badge never comes from a stale cache: `update-state.json` is ignored when it
was written by a different app version.

## Windows and Linux are separate downloads

Both platforms are built from the same tag, by the same workflow, into one
release — but the artifacts never overlap:

| Platform | Job | Assets | Updater manifest key |
| --- | --- | --- | --- |
| Windows | `windows-latest` | `Kiro-Setup-<v>.exe` (custom installer), `Kiro_<v>_x64-setup.exe` (NSIS, feeds the silent updater), `kiro-<v>-portable-windows-x64.zip` | `windows-x86_64`, `windows-x86_64-nsis` |
| Linux | `ubuntu-22.04` | `Kiro_<v>_amd64.AppImage` (primary, self-updating), `kiro_<v>_amd64.deb` | `linux-x86_64`, `linux-x86_64-appimage` |

`latest.json` holds every key, and tauri-plugin-updater only reads the one for
the platform it runs on, so a Linux install can never be handed a `.exe` and the
other way round.

The two jobs run with `max-parallel: 1` on purpose: tauri-action merges the
platforms it already finds in `latest.json`, so two jobs writing the manifest at
the same time could drop the other platform's entry. The Linux job re-reads the
published `latest.json` at the end and fails if the Windows key is gone.

Linux is bundled with `src-tauri/tauri.linux.conf.json`, a JSON Merge Patch on
top of `tauri.conf.json` that only swaps `bundle.targets` to `deb` + `appimage`
and adds the Linux icon set and `deb.depends`. The Windows NSIS settings in
`tauri.conf.json` are untouched, which is why one file stays the source of truth
for versions and app identity.

## Before tagging

1. `cargo test` in `src-tauri` — all green.
2. `node node_modules\typescript\bin\tsc --noEmit` — clean.
3. `bun run build` — the frontend must build, since `beforeBuildCommand` runs it.
4. Both platform code paths must type-check. There is no Linux machine in the
   Windows development loop, so the Linux (`unix/`, `#[cfg(not(kiro_windows))]`)
   code is checked on Windows with the cfg forced:

   ```powershell
   cd src-tauri
   $env:KIRO_FORCE_UNIX = "1"
   cargo check    # Linux paths
   cargo test     # Linux behaviour, Windows-only tests are compiled out
   ```

5. Windows-only constructs leaking into Linux-reachable code are invisible to
   the check above, because `std::os::windows` and the `windows` crate still
   exist on a Windows host. The guard script lists them:

   ```powershell
   node <path>\unix-guard.mjs src-tauri\src
   # 0 Windows-only construct(s) still reachable on Linux.
   ```

6. Optional but recommended, and required after any key rotation: verify a real
   signature. This is the check CI repeats for every release:

   ```powershell
   cd src-tauri
   $env:KIRO_UPDATE_SIGNATURE = "target\release\bundle\nsis\Kiro_1.9.5_x64-setup.exe.sig"
   $env:KIRO_UPDATE_ARTIFACT  = "target\release\bundle\nsis\Kiro_1.9.5_x64-setup.exe"
   cargo test -- --ignored real_release_signature --nocapture
   ```

   The test reads `platforms[<os>-<arch>]` from a manifest, or the raw `.sig`
   text; `KIRO_UPDATE_PLATFORM` overrides the key when checking another
   platform's entry.

## Installing locally

**Windows**

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-local.ps1
```

It builds, replaces `%LOCALAPPDATA%\Kiro`, and waits until Kiro is actually
running (the installer's own copy can lose the single-instance race).

**Linux**

```bash
scripts/install-local.sh              # build AppImage, install to ~/.local/share/kiro, launch
scripts/install-local.sh --no-launch  # same, without starting it
scripts/install-local.sh --deb        # build and install the .deb instead
```

The AppImage is installed to a stable path (`~/.local/share/kiro/Kiro.AppImage`)
with a `~/.local/bin/kiro` symlink and a `.desktop` entry, because the updater
replaces the file it is running from: a version-numbered filename would leave
the next update pointing at a path that no longer exists.

## Secrets

`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must exist
in the repository secrets. `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`
must be the matching public key. If the two disagree, the release still builds
and publishes, but every install fails with "signature verification failed" —
which is exactly what the verification steps in the workflow exist to catch.

That key only covers the **updater** signature. The Windows SmartScreen publisher
warning needs a separate Authenticode certificate, and signing the installer after
the updater signature was produced invalidates it. The order of operations is in
[docs/SIGNING.md](SIGNING.md).

The same key signs both platforms: the signature is verified against the pubkey
compiled into the binary, so a Windows-only key rotation would break Linux
updates and the Linux job's verification step would fail the release.

## Manual publishing (no CI)

`scripts/release.ps1 -Version 1.9.6` does the same work locally, but it needs
`TAURI_SIGNING_PRIVATE_KEY` in the environment and `gh` logged in. It only
produces the Windows assets; a Linux release must come from the workflow.
