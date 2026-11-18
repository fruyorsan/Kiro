# Releasing

Every user-visible change ships as a new release, because installed copies
update themselves. This is the whole loop:

```powershell
bun run bump 1.9.5                 # bumps all six version files + both lockfiles
git add -A
git commit -m "fix(notch): ..."
git tag -a v1.9.5 -m "Kiro v1.9.5"
git push origin main
git push origin v1.9.5             # <- this starts the release
```

Pushing the tag runs `.github/workflows/release.yml`, which verifies that every
version file matches the tag, builds the app, signs the installer, verifies the
signature against the key compiled into the app, and publishes the release with
`latest.json`. Nothing else has to be pressed.

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

## Before tagging

1. `cargo test` in `src-tauri` — all green.
2. `node node_modules\typescript\bin\tsc --noEmit` — clean.
3. `bun run build` — the frontend must build, since `beforeBuildCommand` runs it.
4. Optional but recommended, and required after any key rotation: verify a real
   signature. This is the check CI repeats for every release:

   ```powershell
   cd src-tauri
   $env:KIRO_UPDATE_SIGNATURE = "target\release\bundle\nsis\Kiro_1.9.5_x64-setup.exe.sig"
   $env:KIRO_UPDATE_ARTIFACT  = "target\release\bundle\nsis\Kiro_1.9.5_x64-setup.exe"
   cargo test -- --ignored real_release_signature --nocapture
   ```

## Installing locally

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-local.ps1
```

It builds, replaces `%LOCALAPPDATA%\Kiro`, and waits until Kiro is actually
running (the installer's own copy can lose the single-instance race).

## Secrets

`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must exist
in the repository secrets. `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`
must be the matching public key. If the two disagree, the release still builds
and publishes, but every install fails with "signature verification failed" —
which is exactly what the verification step in the workflow exists to catch.

## Manual publishing (no CI)

`scripts/release.ps1 -Version 1.9.5` does the same work locally, but it needs
`TAURI_SIGNING_PRIVATE_KEY` in the environment and `gh` logged in.
