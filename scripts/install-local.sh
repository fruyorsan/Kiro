#!/usr/bin/env bash
# Linux counterpart to install-local.ps1: builds Kiro from the current working
# tree, replaces the installed copy, and (unless --no-launch) starts it.
#
#   scripts/install-local.sh [--no-launch] [--deb]
#
# Default is the AppImage path, because that is what the auto-updater can
# replace in place: the file lives at a stable path, and the updater rewrites it
# and restarts. --deb installs the .deb through dpkg instead (system package,
# auto-update then goes through dpkg and needs root).
#
# Settings live in ~/.config/com.fruyorsan.kiro and are never touched.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

launch=1
wanted=appimage
for arg in "$@"; do
    case "$arg" in
        --no-launch) launch=0 ;;
        --deb) wanted=deb ;;
        -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

version=$(bun -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")

echo "==> Stopping running Kiro"
pkill -x kiro 2>/dev/null || true
sleep 0.5

echo "==> Building Kiro $version ($wanted)"
bun run tauri build --config src-tauri/tauri.linux.conf.json --bundles "$wanted"

bundle_dir="src-tauri/target/release/bundle"

if [ "$wanted" = "deb" ]; then
    deb="$(ls "$bundle_dir"/deb/*.deb | head -n1)"
    echo "==> Installing $(basename "$deb")"
    sudo dpkg -i "$deb" || sudo apt-get install -f -y
    app_cmd=kiro
else
    appimage="$(ls "$bundle_dir"/appimage/*.AppImage | head -n1)"
    apps_dir="${XDG_DATA_HOME:-$HOME/.local/share}/kiro"
    bin_dir="$HOME/.local/bin"
    mkdir -p "$apps_dir" "$bin_dir"

    # A stable path matters: the updater replaces the file it is running from,
    # so a version-numbered filename would leave the update pointing at a path
    # that no longer exists.
    echo "==> Installing $(basename "$appimage")"
    install -m 0755 "$appimage" "$apps_dir/Kiro.AppImage"
    ln -sf "$apps_dir/Kiro.AppImage" "$bin_dir/kiro"

    desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$desktop_dir"
    cat > "$desktop_dir/kiro.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Kiro
Comment=Notch-style dock for your desktop
Exec=$apps_dir/Kiro.AppImage
Icon=kiro
Terminal=false
Categories=Utility;
StartupWMClass=Kiro
DESKTOP

    icon_dir="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
    for size in 32 64 128 256 512; do
        for src in "$root/src-tauri/icons/${size}x${size}.png" "$root/src-tauri/icons/icon.png"; do
            [ -f "$src" ] || continue
            mkdir -p "$icon_dir/${size}x${size}/apps"
            cp "$src" "$icon_dir/${size}x${size}/apps/kiro.png"
            break
        done
    done

    command -v update-desktop-database >/dev/null && update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true
    app_cmd="$apps_dir/Kiro.AppImage"

    case ":$PATH:" in
        *":$bin_dir:"*) ;;
        *) echo "note: $bin_dir is not in PATH, run the app from $app_cmd" ;;
    esac
fi

if [ "$launch" = 1 ]; then
    echo "==> Launching Kiro"
    setsid "$app_cmd" >/dev/null 2>&1 < /dev/null &
    sleep 2
    if pgrep -x kiro >/dev/null || pgrep -f 'Kiro.AppImage' >/dev/null; then
        echo "Kiro is running ($version)"
    else
        echo "Kiro did not stay running; start it from a terminal to see why" >&2
        exit 1
    fi
else
    echo "Installed $version without launching"
fi
