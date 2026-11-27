import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Generates the three winget manifests for a release. winget-pkgs pins the
// installer URL and its SHA256, so every release needs its own folder under
// packaging/winget/manifests/f/fruyorsan/Kiro/<version>/ before a PR to
// microsoft/winget-pkgs. Run after the GitHub release is published:
//
//   bun run winget            # version from src-tauri/tauri.conf.json
//   bun run winget 1.10.8     # or name one explicitly
//
// The hash is computed from the real asset, never from a local build: the
// published file is what winget downloads and verifies.

const SCHEMA = "1.28.0";
const IDENTIFIER = "fruyorsan.Kiro";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = process.argv[2] ?? config.version;

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Not a version: ${version}`);
  process.exit(1);
}

const tag = `v${version}`;
const asset = `Kiro_${version}_x64-setup.exe`;
const url = `https://github.com/fruyorsan/Kiro/releases/download/${tag}/${asset}`;

console.log(`Fetching ${url}`);
const response = await fetch(url, { redirect: "follow" });
if (!response.ok) {
  console.error(`HTTP ${response.status}. Is the release published? Draft releases are not downloadable.`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
console.log(`${bytes.length} bytes, sha256 ${sha256}`);

const released = new Date().toISOString().slice(0, 10);
const dir = resolve(root, "packaging/winget/manifests/f/fruyorsan/Kiro", version);
mkdirSync(dir, { recursive: true });

const header = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${SCHEMA}.schema.json\n\n`;

writeFileSync(
  resolve(dir, `${IDENTIFIER}.yaml`),
  header("version") +
    `PackageIdentifier: ${IDENTIFIER}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${SCHEMA}
`
);

writeFileSync(
  resolve(dir, `${IDENTIFIER}.installer.yaml`),
  header("installer") +
    `PackageIdentifier: ${IDENTIFIER}
PackageVersion: ${version}
InstallerType: nullsoft
UpgradeBehavior: install
ReleaseDate: ${released}
Installers:
- Architecture: x64
  Scope: user
  InstallerUrl: ${url}
  InstallerSha256: ${sha256}
  InstallerSwitches:
    Silent: /S
    SilentWithProgress: /S
  InstallationMetadata:
    DefaultInstallLocation: '%LocalAppData%\\Kiro'
  AppsAndFeaturesEntries:
  - DisplayName: Kiro
    DisplayVersion: ${version}
ManifestType: installer
ManifestVersion: ${SCHEMA}
`
);

// The locale file is stable across versions; keep the hand-written copy and
// only stamp the version into it, so edits to the description are not lost.
const localePath = resolve(dir, `${IDENTIFIER}.locale.en-US.yaml`);
const locale = `PackageIdentifier: ${IDENTIFIER}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Furkan Taha Akkose
PublisherUrl: https://github.com/fruyorsan
PublisherSupportUrl: https://github.com/fruyorsan/Kiro/issues
Author: Furkan Taha Akkose
PackageName: Kiro
PackageUrl: https://github.com/fruyorsan/Kiro
License: GPL-3.0-only
LicenseUrl: https://github.com/fruyorsan/Kiro/blob/main/LICENSE
Copyright: Copyright (c) Furkan Taha Akkose
ShortDescription: Taskbar replacement for Windows 10 and 11 with a dynamic-island notch, a dock and a game-boost layer.
Description: |-
  Kiro replaces the Windows taskbar with a dynamic-island style notch, a dock and a game-boost layer. It steps aside automatically when a fullscreen game starts, so games keep every frame. Customisable through settings.json, with themes, per-app rules, media and system controls on the notch.
  No telemetry, no account, no analytics. Free and open source under the GPLv3, with no paid tier.
Moniker: kiro-taskbar
Tags:
- taskbar
- taskbar-replacement
- dock
- dynamic-island
- notch
- shell
- desktop-customization
- windows-11
- windows-10
- game-boost
- rust
- tauri
ReleaseNotesUrl: https://github.com/fruyorsan/Kiro/releases/tag/${tag}
ManifestType: defaultLocale
ManifestVersion: ${SCHEMA}
`;
writeFileSync(localePath, header("defaultLocale") + locale);

console.log(`Wrote ${dir}`);
console.log(`Validate: winget validate --manifest "${dir}"`);
