// ABOUTME: Backend authorization boundary for model-originated local file tools.
// ABOUTME: Resolves canonical project scope without changing editor/file-tree commands.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

use super::types::EffectiveAgentPolicy;
use crate::path_util::expand_tilde;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileAccessKind {
    Read,
    Write,
}

impl FileAccessKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFileAccess {
    pub path: PathBuf,
    pub grant_directory: PathBuf,
    pub kind: FileAccessKind,
    pub sensitive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileAccessDecision {
    Allow(ResolvedFileAccess),
    RequireApproval(ResolvedFileAccess),
    Deny(String),
}

#[derive(Debug, Clone)]
pub struct FileAccessPolicy {
    settings: EffectiveAgentPolicy,
    project_root: Option<PathBuf>,
}

impl FileAccessPolicy {
    pub fn new(settings: EffectiveAgentPolicy, project_root: Option<&str>) -> Result<Self, String> {
        let project_root = project_root
            .filter(|root| !root.trim().is_empty())
            .map(|root| {
                let expanded = expand_tilde(root)?;
                std::fs::canonicalize(&expanded)
                    .map_err(|_| "The selected project folder is unavailable.".to_string())
            })
            .transpose()?;

        Ok(Self {
            settings,
            project_root,
        })
    }

    pub fn evaluate(&self, requested: &str, kind: FileAccessKind) -> FileAccessDecision {
        let resolved = match self.resolve_target(requested) {
            Ok(path) => path,
            Err(message) => return FileAccessDecision::Deny(message),
        };
        let grant_directory = grant_directory(&resolved, kind);
        let sensitive = is_sensitive_path(&resolved);
        let access = ResolvedFileAccess {
            path: resolved.clone(),
            grant_directory,
            kind,
            sensitive,
        };

        let full_access = matches!(
            self.settings.sandbox_mode.as_str(),
            "full-access" | "danger-full-access"
        );
        if full_access {
            return FileAccessDecision::Allow(access);
        }

        // Read Only precedes the sensitive check, matching
        // bin/browser-local/file-access-policy.mjs. Reversed, a write to a
        // credential path resolved to an approval prompt while an ordinary
        // path was denied outright. #3140
        if kind == FileAccessKind::Write && self.settings.sandbox_mode == "read-only" {
            return FileAccessDecision::Deny(
                "File write denied: Agent Sandbox Mode is Read Only.".to_string(),
            );
        }

        if sensitive {
            return self.approval_or_deny(access);
        }

        let in_project = self
            .project_root
            .as_ref()
            .is_some_and(|root| path_is_within(&resolved, root));

        if in_project && !sensitive {
            if kind == FileAccessKind::Read && !self.settings.auto_approve_reads {
                return self.approval_or_deny(access);
            }
            return FileAccessDecision::Allow(access);
        }

        self.approval_or_deny(access)
    }

    fn approval_or_deny(&self, access: ResolvedFileAccess) -> FileAccessDecision {
        match self.settings.approval_policy.as_str() {
            "on-request" | "untrusted" => FileAccessDecision::RequireApproval(access),
            _ => FileAccessDecision::Deny(
                "File access denied by the current project scope. Select Full Access or use an approval-enabled policy for external files."
                    .to_string(),
            ),
        }
    }

    fn resolve_target(&self, requested: &str) -> Result<PathBuf, String> {
        if requested.is_empty() || requested.contains('\0') {
            return Err("File access denied: invalid path.".to_string());
        }
        let expanded = expand_tilde(requested)?;
        if expanded
            .components()
            .any(|component| component == Component::ParentDir)
        {
            return Err("File access denied: parent traversal is not allowed.".to_string());
        }

        let candidate = if expanded.is_absolute() {
            expanded
        } else if let Some(root) = &self.project_root {
            root.join(expanded)
        } else {
            return Err(
                "File access denied: choose a project folder before using a relative path."
                    .to_string(),
            );
        };

        canonicalize_existing_or_parent(&candidate)
    }
}

fn canonicalize_existing_or_parent(candidate: &Path) -> Result<PathBuf, String> {
    if candidate.exists() {
        return std::fs::canonicalize(candidate)
            .map_err(|_| "File access denied: path could not be resolved.".to_string());
    }

    let mut ancestor = candidate;
    let mut missing: Vec<OsString> = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| "File access denied: path has no existing ancestor.".to_string())?;
        missing.push(name.to_os_string());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "File access denied: path has no existing ancestor.".to_string())?;
    }

    let mut resolved = std::fs::canonicalize(ancestor)
        .map_err(|_| "File access denied: path ancestor could not be resolved.".to_string())?;
    for component in missing.into_iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn grant_directory(path: &Path, kind: FileAccessKind) -> PathBuf {
    if kind == FileAccessKind::Read && path.is_dir() {
        return path.to_path_buf();
    }
    path.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| path.to_path_buf())
}

#[cfg(not(windows))]
pub fn path_is_within(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

#[cfg(windows)]
pub fn path_is_within(path: &Path, root: &Path) -> bool {
    let normalize = |value: &Path| {
        value
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    let path = normalize(path);
    let root = normalize(root);
    path == root || path.starts_with(&format!("{}\\", root))
}

fn is_sensitive_path(path: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let sensitive_directories = [
        home.join(".ssh"),
        home.join(".aws"),
        home.join(".gnupg"),
        home.join(".seren"),
        home.join(".config/seren"),
        home.join(".config/gcloud"),
        home.join(".config/autostart"),
        home.join("Library/LaunchAgents"),
    ];
    if sensitive_directories
        .iter()
        .any(|directory| path_is_within(path, directory))
    {
        return true;
    }

    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        file_name.to_ascii_lowercase().as_str(),
        ".bashrc"
            | ".bash_profile"
            | ".zshrc"
            | ".zprofile"
            | ".profile"
            | ".gitconfig"
            | ".npmrc"
            | ".netrc"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(root: &Path, sandbox: &str, approval: &str) -> FileAccessPolicy {
        FileAccessPolicy::new(
            EffectiveAgentPolicy {
                sandbox_mode: sandbox.to_string(),
                approval_policy: approval.to_string(),
                auto_approve_reads: true,
                network_enabled: true,
            },
            root.to_str(),
        )
        .expect("policy")
    }

    #[test]
    fn project_reads_and_nonexistent_writes_are_automatic() {
        let root = tempfile::tempdir().expect("root");
        let read = root.path().join("input.txt");
        std::fs::write(&read, "ok").expect("fixture");
        let policy = policy(root.path(), "workspace-write", "on-request");

        assert!(matches!(
            policy.evaluate(read.to_str().unwrap(), FileAccessKind::Read),
            FileAccessDecision::Allow(_)
        ));
        assert!(matches!(
            policy.evaluate("nested/output.txt", FileAccessKind::Write),
            FileAccessDecision::Allow(_)
        ));
    }

    #[test]
    fn prefix_collision_and_parent_traversal_do_not_escape_project() {
        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("project");
        let sibling = parent.path().join("project-secret");
        std::fs::create_dir_all(&root).expect("root");
        std::fs::create_dir_all(&sibling).expect("sibling");
        let policy = policy(&root, "workspace-write", "never");

        assert!(matches!(
            policy.evaluate(sibling.to_str().unwrap(), FileAccessKind::Read),
            FileAccessDecision::Deny(_)
        ));
        assert!(matches!(
            policy.evaluate("../project-secret", FileAccessKind::Read),
            FileAccessDecision::Deny(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_resolves_outside_project_before_authorization() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("project");
        let outside = parent.path().join("outside");
        std::fs::create_dir_all(&root).expect("root");
        std::fs::create_dir_all(&outside).expect("outside");
        symlink(&outside, root.join("link")).expect("symlink");
        let policy = policy(&root, "workspace-write", "never");

        assert!(matches!(
            policy.evaluate("link/secret.txt", FileAccessKind::Write),
            FileAccessDecision::Deny(_)
        ));
    }

    #[test]
    fn read_only_denies_writes_and_full_access_allows_external_paths() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        assert!(matches!(
            policy(root.path(), "read-only", "on-request")
                .evaluate("output.txt", FileAccessKind::Write),
            FileAccessDecision::Deny(_)
        ));
        assert!(matches!(
            policy(root.path(), "full-access", "never")
                .evaluate(outside.path().to_str().unwrap(), FileAccessKind::Read),
            FileAccessDecision::Allow(_)
        ));
    }

    #[test]
    fn read_only_denies_sensitive_writes_instead_of_prompting() {
        // Read Only must not become approvable just because the target is a
        // credential path — the JS twin denies both. #3140
        let root = tempfile::tempdir().expect("root");
        let home = dirs::home_dir().expect("home");
        let credentials = home.join(".aws").join("credentials");

        assert!(matches!(
            policy(root.path(), "read-only", "on-request")
                .evaluate(credentials.to_str().unwrap(), FileAccessKind::Write),
            FileAccessDecision::Deny(_)
        ));
    }

    #[test]
    fn disabling_auto_read_requires_one_scoped_approval() {
        let root = tempfile::tempdir().expect("root");
        let mut settings = EffectiveAgentPolicy::default();
        settings.auto_approve_reads = false;
        let policy = FileAccessPolicy::new(settings, root.path().to_str()).expect("policy");

        assert!(matches!(
            policy.evaluate(root.path().to_str().unwrap(), FileAccessKind::Read),
            FileAccessDecision::RequireApproval(_)
        ));
    }
}
