// ABOUTME: Path-argument normalisation shared by file tools and Tauri commands.
// ABOUTME: Expands a leading `~` to the user's home so model-supplied paths land where users expect.

use std::path::PathBuf;

/// Expand a leading `~` or `~/` in `path` to the user's home directory.
///
/// Rules (see GH #1583):
/// - `~` alone -> `$HOME`
/// - `~/foo` -> `$HOME/foo`
/// - Anything else (`/abs`, `relative/x`, `~user/x`) is returned unchanged.
///   `~user` is intentionally NOT expanded: resolving other users' homes is
///   not portable across platforms and is not something the model should ask
///   for.
///
/// Returns an error on empty input or when the home directory cannot be
/// resolved (e.g. `$HOME` unset on unix). The error message is phrased so
/// callers can surface it directly to the LLM as a tool-result error.
pub fn expand_tilde(path: &str) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err("Path is empty".to_string());
    }
    if path == "~" || path.starts_with("~/") {
        let home = dirs::home_dir().ok_or_else(|| {
            "Cannot expand '~': unable to resolve home directory".to_string()
        })?;
        if path == "~" {
            return Ok(home);
        }
        // `~/foo` -> join `foo`; strip exactly one `~/` prefix.
        let rest = &path[2..];
        return Ok(home.join(rest));
    }
    Ok(PathBuf::from(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_table() {
        let home = dirs::home_dir().expect("home dir required for test");

        // `~` alone -> $HOME
        assert_eq!(expand_tilde("~").unwrap(), home);

        // `~/foo` -> $HOME/foo
        assert_eq!(expand_tilde("~/foo").unwrap(), home.join("foo"));

        // `~/deep/path/file.txt` -> $HOME/deep/path/file.txt
        assert_eq!(
            expand_tilde("~/Downloads/Ishan/OhHello.pdf").unwrap(),
            home.join("Downloads/Ishan/OhHello.pdf")
        );

        // Absolute path -> untouched
        assert_eq!(
            expand_tilde("/abs/path").unwrap(),
            PathBuf::from("/abs/path")
        );

        // Relative path (no tilde) -> untouched (caller's cwd responsibility)
        assert_eq!(
            expand_tilde("relative/path").unwrap(),
            PathBuf::from("relative/path")
        );

        // `~user/...` is NOT expanded (other-user homes not portable)
        assert_eq!(
            expand_tilde("~alice/foo").unwrap(),
            PathBuf::from("~alice/foo")
        );

        // `~.bashrc` is NOT expanded — it's a literal filename that starts with `~`
        // (no slash after the tilde).
        assert_eq!(expand_tilde("~.bashrc").unwrap(), PathBuf::from("~.bashrc"));

        // Empty -> error
        assert!(expand_tilde("").is_err());
    }
}
