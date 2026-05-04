#!/usr/bin/env bash
# ABOUTME: Conventional-commit validator. Single source of truth for the regex.
# ABOUTME: Used by .githooks/commit-msg locally and by CI on every PR commit.

set -e

if [ "$#" -eq 0 ]; then
  echo "usage: $(basename "$0") <commit-msg-file-or-string>" >&2
  exit 2
fi

# Subject length cap. #1778 made this a hard rule after multi-thousand-char
# subjects landed on main from the agent harness bundling full implementation
# summaries into the subject line. Override with MAX_SUBJECT_LEN=<n> for local
# experiments — CI pins the cap.
MAX_SUBJECT_LEN="${MAX_SUBJECT_LEN:-72}"

# Accept either a file path (local hook passes the .git/COMMIT_EDITMSG path)
# or a literal message string (CI passes the line via xargs -I or process subst).
# An empty-string arg is allowed — git aborts before the hook ever runs on
# an empty message, but be defensive.
if [ -n "$1" ] && [ -f "$1" ]; then
  msg="$(head -n 1 "$1")"
else
  msg="$1"
fi

# Strip leading/trailing whitespace from the first line.
msg="${msg#"${msg%%[![:space:]]*}"}"
msg="${msg%"${msg##*[![:space:]]}"}"

# Empty messages are git-aborts; let git handle them.
if [ -z "$msg" ]; then
  exit 0
fi

# Allowlist generated prefixes.
case "$msg" in
  "Merge "*|"Revert "*|"fixup! "*|"squash! "*|"amend! "*)
    exit 0
    ;;
esac

# Conventional-commit pattern: <type>(<scope>)?!?: <description>
# Types: feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert, hotfix
pattern='^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert|hotfix)(\([^)]+\))?!?: .+'

if ! echo "$msg" | grep -Eq "$pattern"; then
  cat >&2 <<EOF
✗ Commit message does not follow conventional-commit format.

  Got: $msg

  Expected: <type>(<scope>)?!?: <description>

  Allowed types: feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert, hotfix

  Examples:
    fix(agent): drop --resume when first spawn fails
    feat(cli-updater): scan tarball before install
    chore(deps): bump tokio from 1.51.1 to 1.52.1

  See https://www.conventionalcommits.org/ for the full spec.
  Bypass with --no-verify only in emergencies.
EOF
  exit 1
fi

# Format passed; now enforce subject length (#1778).
subject_len="${#msg}"
if [ "$subject_len" -gt "$MAX_SUBJECT_LEN" ]; then
  cat >&2 <<EOF
✗ Commit subject is $subject_len chars; max is $MAX_SUBJECT_LEN.

  Got: $msg

  Move implementation detail into the commit body (a blank line below the
  subject), keeping the first line a short Conventional Commit summary.

  Examples:
    fix(agent): close #1234 — short summary here
    (blank line)
    Long-form rationale, file paths, line numbers, and trade-offs go here.

  See https://www.conventionalcommits.org/ §1 (subject) and §2 (body).
EOF
  exit 1
fi

exit 0
