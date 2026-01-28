fn main() {
    // Pass the target triple to the compiled code for sidecar binary discovery
    println!(
        "cargo:rustc-env=TARGET={}",
        std::env::var("TARGET").unwrap()
    );

    tauri_build::build()
}
