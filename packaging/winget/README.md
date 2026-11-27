# winget

Manifests for [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs), so
Kiro can be installed with `winget install fruyorsan.Kiro` (or
`winget install kiro-taskbar`).

## Per release

```bash
bun run bump 1.10.8        # bump the app
# publish the GitHub release, then:
bun run winget             # writes manifests + downloads the asset for its sha256
winget validate --manifest packaging/winget/manifests/f/fruyorsan/Kiro/1.10.8
```

`scripts/winget-manifest.mjs` reads the version from `src-tauri/tauri.conf.json`,
fetches the published installer and hashes it. It never hashes a local build:
winget verifies the file it downloads.

## Submitting

1. Fork `microsoft/winget-pkgs` and clone it (shallow is fine: `git clone --depth 1`).
2. Copy `packaging/winget/manifests/f/fruyorsan/Kiro/<version>/` into the fork at
   `manifests/f/fruyorsan/Kiro/<version>/`.
3. Commit as `New package: fruyorsan.Kiro version <version>` and open a PR titled
   the same way.
4. The first PR needs the Microsoft CLA signed (a bot comments with a link; one
   click). Later PRs skip it.
5. The validation pipeline installs the package in a VM and checks the ARP entry.
   `Kiro` is also the display name of `Amazon.Kiro` (the AWS IDE), so the check
   looks at version and install location to tell them apart. That is why the
   manifest pins `DefaultInstallLocation: %LocalAppData%\Kiro` and
   `Moniker: kiro-taskbar`.

## Notes

- `InstallerType: nullsoft` with `/S` — Tauri's NSIS bundle, per-user install.
- `Scope: user` matches `installMode: currentUser` in `src-tauri/tauri.conf.json`.
- The installer is currently unsigned. winget accepts that, but SmartScreen will
  still warn on first run until Authenticode signing is in place (see
  `docs/SIGNING.md`).
