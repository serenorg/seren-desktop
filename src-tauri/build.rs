fn main() {
    // Pass the target triple to the compiled code for sidecar binary discovery
    println!(
        "cargo:rustc-env=TARGET={}",
        std::env::var("TARGET").unwrap()
    );

    // Skip Tauri build validation when SKIP_TAURI_BUILD is set.
    // The sidecar build script sets this to avoid a circular dependency: tauri_build::build()
    // validates that externalBin sidecar files exist, but when building the sidecar itself,
    // those files don't exist yet.
    if std::env::var("SKIP_TAURI_BUILD").is_ok() {
        return;
    }

    tauri_build::build()
}
