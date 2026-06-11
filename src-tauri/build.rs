fn main() {
    embed_windows_common_controls_manifest();

    // Pass the target triple to the compiled code for sidecar binary discovery
    println!(
        "cargo:rustc-env=TARGET={}",
        std::env::var("TARGET").unwrap()
    );

    // Embed git commit hash at compile time
    if let Ok(output) = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
    {
        let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
        println!("cargo:rustc-env=BUILT_COMMIT={commit}");
    } else {
        println!("cargo:rustc-env=BUILT_COMMIT=unknown");
    }

    // Embed build date at compile time (ISO 8601)
    if let Ok(output) = std::process::Command::new("date")
        .args(["-u", "+%Y-%m-%dT%H:%M:%SZ"])
        .output()
    {
        let date = String::from_utf8_lossy(&output.stdout).trim().to_string();
        println!("cargo:rustc-env=BUILT_DATE={date}");
    } else {
        println!("cargo:rustc-env=BUILT_DATE=unknown");
    }

    // Embed release tag at compile time (e.g. v0.1.0-alpha.24)
    if let Ok(output) = std::process::Command::new("git")
        .args(["describe", "--tags", "--abbrev=0"])
        .output()
    {
        let tag = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !tag.is_empty() {
            println!("cargo:rustc-env=BUILT_RELEASE_TAG={tag}");
        } else {
            println!("cargo:rustc-env=BUILT_RELEASE_TAG=dev");
        }
    } else {
        println!("cargo:rustc-env=BUILT_RELEASE_TAG=dev");
    }

    // Embed Rust version at compile time
    if let Ok(output) = std::process::Command::new("rustc")
        .args(["--version"])
        .output()
    {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        println!("cargo:rustc-env=BUILT_RUST_VERSION={version}");
    } else {
        println!("cargo:rustc-env=BUILT_RUST_VERSION=unknown");
    }

    run_tauri_build()
}

fn embed_windows_common_controls_manifest() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }

    let manifest_path =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("common-controls-v6.manifest");
    let manifest = manifest_path.display();

    println!("cargo:rerun-if-changed={manifest}");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{manifest}");
}

fn run_tauri_build() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let attributes = tauri_build::Attributes::new().windows_attributes(windows);
        tauri_build::try_build(attributes).expect("failed to run Tauri build script");
    } else {
        tauri_build::build();
    }
}
