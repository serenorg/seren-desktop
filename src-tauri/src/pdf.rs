// ABOUTME: Native PDF rendering for model tool calls — no HTML intermediate on disk.
// ABOUTME: Shells out to headless Chrome/Chromium or wkhtmltopdf under one atomic tool.

//! Implements the `write_pdf_from_html` local tool (GH #1585).
//!
//! The previous HTML→convert pattern produced a two-round workflow with an
//! orphan HTML intermediate file whenever the conversion step was skipped
//! (interrupted, Stop clicked, network error). This module bundles
//! "write HTML + convert to PDF + remove intermediate" into a single atomic
//! operation so the model uses one tool round and the user always sees either
//! a PDF at the requested path or a clean error.
//!
//! The HTML intermediate is written into the system temp directory
//! (`std::env::temp_dir()`), NEVER alongside the output PDF — this keeps
//! generated HTML out of the Tauri dev file-watcher's scope (GH #1584) and
//! out of the user's output folder.
//!
//! Converter discovery order is deliberate:
//!  1. `google-chrome` / `chromium` on `$PATH` (most deterministic).
//!  2. macOS `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
//!     (the default install location on Mac — no $PATH entry required).
//!  3. `wkhtmltopdf` (legacy, still common on Linux).
//! If none are present, we surface a clear error pointing the user at the
//! cheapest install. We deliberately do NOT fall back to `print` dialogs or
//! anything that needs UI.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

use crate::path_util::expand_tilde;

const CONVERSION_TIMEOUT_SECS: u64 = 60;

/// Write `html` as a PDF at `path` in a single atomic step.
///
/// `path` may start with `~/` — it's expanded via `expand_tilde`. Parent
/// directories are created if missing. The HTML intermediate is written to
/// the system temp dir and removed after conversion (even on failure). On
/// success, returns the absolute resolved path as a display string for the
/// tool result.
pub async fn write_pdf_from_html(path: &str, html: &str) -> Result<String, String> {
    if html.is_empty() {
        return Err("Missing required parameter: html".to_string());
    }
    let resolved = expand_tilde(path)?;

    // Ensure parent directory exists.
    if let Some(parent) = resolved.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Failed to create parent directory '{}': {}",
                    parent.display(),
                    e
                )
            })?;
        }
    }

    // Write HTML to system temp (NOT alongside output). Unique filename
    // prevents concurrent calls from clobbering each other.
    let tmp_html = std::env::temp_dir().join(format!(
        "seren-pdf-{}.html",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp_html, html)
        .map_err(|e| format!("Failed to write HTML intermediate: {}", e))?;

    // Always clean up the intermediate, even on conversion failure.
    let conversion_result = run_converter(&tmp_html, &resolved).await;
    let _ = std::fs::remove_file(&tmp_html);
    conversion_result?;

    // Sanity-check: file exists and looks like a PDF.
    let bytes = std::fs::metadata(&resolved)
        .map_err(|e| format!("PDF was not created at '{}': {}", resolved.display(), e))?
        .len();
    if bytes < 4 {
        return Err(format!(
            "Converter produced an empty file at '{}' ({}B)",
            resolved.display(),
            bytes
        ));
    }
    let mut header = [0u8; 4];
    use std::io::Read;
    if let Ok(mut f) = std::fs::File::open(&resolved) {
        let _ = f.read(&mut header);
    }
    if &header != b"%PDF" {
        return Err(format!(
            "Converter produced a file at '{}' but it is not a valid PDF (header: {:?})",
            resolved.display(),
            header
        ));
    }

    Ok(format!(
        "Successfully wrote PDF: {} ({} bytes)",
        resolved.display(),
        bytes
    ))
}

async fn run_converter(html_path: &Path, pdf_path: &Path) -> Result<(), String> {
    let mut errors: Vec<String> = Vec::new();

    for converter in converter_candidates() {
        match converter.run(html_path, pdf_path).await {
            Ok(()) => return Ok(()),
            Err(ConverterError::NotFound) => {
                // Try the next one silently.
            }
            Err(ConverterError::Failed(msg)) => {
                errors.push(format!("{}: {}", converter.name(), msg));
            }
        }
    }

    if errors.is_empty() {
        Err("No PDF converter found. Install Google Chrome, Chromium, or wkhtmltopdf and retry.".to_string())
    } else {
        Err(format!(
            "PDF converters were present but failed:\n  - {}",
            errors.join("\n  - ")
        ))
    }
}

enum ConverterError {
    /// The converter binary was not found on this system.
    NotFound,
    /// The converter was found but exited non-zero or timed out.
    Failed(String),
}

struct Converter {
    name_: &'static str,
    binary: PathBuf,
    kind: ConverterKind,
}

#[derive(Clone, Copy)]
enum ConverterKind {
    /// Headless Chrome family: `<binary> --headless --disable-gpu --no-sandbox --print-to-pdf=<pdf> file://<html>`
    Chromium,
    /// wkhtmltopdf: `wkhtmltopdf [opts] <html> <pdf>`
    Wkhtmltopdf,
}

impl Converter {
    fn name(&self) -> &'static str {
        self.name_
    }

    async fn run(&self, html: &Path, pdf: &Path) -> Result<(), ConverterError> {
        if !self.binary.exists() {
            return Err(ConverterError::NotFound);
        }
        let mut cmd = Command::new(&self.binary);
        match self.kind {
            ConverterKind::Chromium => {
                cmd.arg("--headless=new")
                    .arg("--disable-gpu")
                    .arg("--no-sandbox")
                    // Chrome prints to the cwd by default; force absolute.
                    .arg(format!("--print-to-pdf={}", pdf.display()))
                    .arg(format!("file://{}", html.display()));
            }
            ConverterKind::Wkhtmltopdf => {
                cmd.arg("--quiet").arg(html).arg(pdf);
            }
        }
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let child = cmd
            .spawn()
            .map_err(|e| ConverterError::Failed(format!("spawn failed: {}", e)))?;
        let output = tokio::time::timeout(
            Duration::from_secs(CONVERSION_TIMEOUT_SECS),
            child.wait_with_output(),
        )
        .await
        .map_err(|_| ConverterError::Failed("conversion timed out".to_string()))?
        .map_err(|e| ConverterError::Failed(format!("wait failed: {}", e)))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ConverterError::Failed(format!(
                "exit {:?}: {}",
                output.status.code(),
                stderr.trim()
            )));
        }
        Ok(())
    }
}

fn converter_candidates() -> Vec<Converter> {
    let mut out = Vec::new();

    // 1. Chromium-family binaries on $PATH (name-order matters: prefer
    //    `google-chrome` and then `chromium` for consistency across distros).
    for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] {
        if let Some(p) = which_on_path(name) {
            out.push(Converter {
                name_: "chromium",
                binary: p,
                kind: ConverterKind::Chromium,
            });
        }
    }

    // 2. macOS default install paths for Chrome. Order: Chrome > Chromium > Edge.
    #[cfg(target_os = "macos")]
    {
        for hard in [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ] {
            let p = PathBuf::from(hard);
            if p.exists() {
                out.push(Converter {
                    name_: "chromium",
                    binary: p,
                    kind: ConverterKind::Chromium,
                });
            }
        }
    }

    // 3. wkhtmltopdf — legacy fallback, still widely packaged.
    if let Some(p) = which_on_path("wkhtmltopdf") {
        out.push(Converter {
            name_: "wkhtmltopdf",
            binary: p,
            kind: ConverterKind::Wkhtmltopdf,
        });
    }

    out
}

/// Minimal `which`: scan `$PATH` for a binary by name. Avoids pulling in a
/// new crate. Returns the first hit.
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for entry in std::env::split_paths(&path_var) {
        let candidate = entry.join(name);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file()
        && std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(p: &Path) -> bool {
    p.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end smoke: when a Chromium-family converter is present on the
    /// test machine, `write_pdf_from_html` produces a valid PDF (first four
    /// bytes are `%PDF`) at a `~/…` path without leaking an HTML intermediate
    /// into cwd. Skipped if no converter is available (e.g. stripped CI).
    #[tokio::test]
    async fn write_pdf_from_html_produces_valid_pdf_header() {
        if converter_candidates().is_empty() {
            eprintln!("skipping: no PDF converter on this machine");
            return;
        }
        let home = dirs::home_dir().expect("home dir");
        let unique = format!(".serendesktop-pdf-test-{}", uuid::Uuid::new_v4().simple());
        let rel = format!("~/{}/out.pdf", unique);

        let html = "<!DOCTYPE html><html><body><h1>hello</h1></body></html>";
        let msg = write_pdf_from_html(&rel, html)
            .await
            .expect("write_pdf_from_html ok");
        assert!(msg.contains(".pdf"));

        let expected = home.join(&unique).join("out.pdf");
        assert!(expected.exists(), "expected PDF at {}", expected.display());

        // Header check: PDF files start with "%PDF-".
        let mut buf = [0u8; 4];
        use std::io::Read;
        let mut f = std::fs::File::open(&expected).expect("open pdf");
        f.read_exact(&mut buf).expect("read header");
        assert_eq!(&buf, b"%PDF", "not a PDF at {}", expected.display());

        // No HTML intermediate leaked into the output directory.
        let siblings: Vec<String> = std::fs::read_dir(home.join(&unique))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            !siblings.iter().any(|n| n.ends_with(".html")),
            "html intermediate leaked next to PDF: {:?}",
            siblings
        );

        let _ = std::fs::remove_dir_all(home.join(&unique));
    }
}
