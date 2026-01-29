fn main() {
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

    tauri_build::build()
}
