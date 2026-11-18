import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: bun run bump <major.minor.patch>");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function updateJson(relativePath) {
  const path = resolve(root, relativePath);
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

function updateCargoToml() {
  const path = resolve(root, "src-tauri/Cargo.toml");
  const content = readFileSync(path, "utf8");
  writeFileSync(path, content.replace(/^version = "[^"]*"/m, `version = "${version}"`));
}

function updateCargoLock(relativePath, packageName) {
  const path = resolve(root, relativePath);
  const content = readFileSync(path, "utf8");
  // Cargo writes CRLF on Windows, so a plain "\n" between the package header
  // and the version never matched and every bump left the lockfile on the old
  // version (the build then rewrote it, leaving the tree dirty).
  const pattern = new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${packageName}"\\r?\\nversion = ")[^"]*(")`
  );
  const next = content.replace(pattern, `$1${version}$2`);
  if (next === content) {
    throw new Error(`Could not update ${relativePath}: package "${packageName}" not found`);
  }
  writeFileSync(path, next);
}

function updateInstallerCargoToml() {
  const path = resolve(root, "installer-app/src-tauri/Cargo.toml");
  const content = readFileSync(path, "utf8");
  writeFileSync(path, content.replace(/^version = "[^"]*"/m, `version = "${version}"`));
}

function updatePackageLockJson(relativePath) {
  const path = resolve(root, relativePath);
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  if (json.packages?.[""]) json.packages[""].version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

function updateReleaseBadge() {
  const path = resolve(root, "README.md");
  const content = readFileSync(path, "utf8");
  writeFileSync(path, content.replace(/shieldcn\.dev\/badge\/release-v[\d.]+\.svg/, `shieldcn.dev/badge/release-v${version}.svg`));
}

updateJson("package.json");
updateJson("src-tauri/tauri.conf.json");
updateCargoToml();
updateCargoLock("src-tauri/Cargo.lock", "kiro");
updatePackageLockJson("package-lock.json");

updateJson("installer-app/package.json");
updateJson("installer-app/src-tauri/tauri.conf.json");
updateInstallerCargoToml();
updateCargoLock("installer-app/src-tauri/Cargo.lock", "kiro-installer");
updatePackageLockJson("installer-app/package-lock.json");
updateReleaseBadge();

console.log(`Bumped package.json, tauri.conf.json, Cargo.toml, Cargo.lock and package-lock.json (main app + installer-app) to ${version}`);
