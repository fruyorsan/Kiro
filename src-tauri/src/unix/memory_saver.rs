//! Linux stand-in for the Windows working-set trimmer.
//!
//! Windows lets Kiro ask the kernel to drop pages from other processes
//! (`EmptyWorkingSet`) and it does so aggressively while the machine is idle.
//! Linux has no equivalent that is safe to call from a normal app (dropping
//! page cache is a root operation and would hurt more than it helps), so every
//! entry point stays but does nothing. Keeping the API identical means the rest
//! of the codebase does not need a second flavour of every call site.

#![allow(dead_code)]

pub fn init() {}

pub fn mark_interaction() {}

pub fn set_busy(_busy: bool) {}

pub fn trim_soon() {}

pub fn trim_tree() -> usize {
    0
}

pub fn start_reclaim_worker(_app: tauri::AppHandle) {}
