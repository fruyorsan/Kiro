fn main() {
    // The exe/taskbar icon is compiled into a resource by tauri-build. Without
    // these two lines the build script is not re-run when only the artwork
    // changes, so a fresh icon.ico kept getting ignored and the old icon stayed
    // in the exe (and every shortcut pointing at it).
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");

    // `kiro_windows` is the switch every platform-specific item in the crate
    // uses. It normally follows the target OS, but `KIRO_FORCE_UNIX=1` builds
    // the Linux code paths on a Windows host so the port can be type-checked
    // without a Linux machine:
    //
    //   $env:KIRO_FORCE_UNIX="1"; cargo check
    //
    // Release builds never set it, so the shipped binaries always take their
    // real platform branch.
    println!("cargo:rustc-check-cfg=cfg(kiro_windows)");
    println!("cargo:rerun-if-env-changed=KIRO_FORCE_UNIX");

    let target_windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let forced_unix = std::env::var_os("KIRO_FORCE_UNIX").is_some();
    if target_windows && !forced_unix {
        println!("cargo:rustc-cfg=kiro_windows");
    }

    tauri_build::build()
}
