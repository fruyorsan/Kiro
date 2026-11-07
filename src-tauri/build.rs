fn main() {
    // The exe/taskbar icon is compiled into a resource by tauri-build. Without
    // these two lines the build script is not re-run when only the artwork
    // changes, so a fresh icon.ico kept getting ignored and the old icon stayed
    // in the exe (and every shortcut pointing at it).
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    tauri_build::build()
}
