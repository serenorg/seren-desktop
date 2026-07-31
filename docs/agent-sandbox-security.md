# Local agent sandbox security matrix

This note records the security behavior of local Claude Code sessions. It is a
regression contract for the launch-spec builder, the provider runtime, and the
platform sandbox backends. Full Access is an explicit opt-out from every
boundary below.

| Platform | Mode | Project files | Outside-project files | Network setting |
| --- | --- | --- | --- | --- |
| macOS | Read Only | Read allowed; writes denied | Reads limited to enumerated system/runtime paths; credential and Seren app-data paths denied | Enabled allows network; disabled denies network |
| macOS | Workspace Write | Read/write allowed | Same read allowlist; writes denied; credential and Seren app-data paths remain denied even if nested in the project | Enabled allows network; disabled denies network |
| Linux | Read Only | Read allowed; writes denied | Reads limited to enumerated system/command paths and exact generated config files; credential and Seren app-data paths denied | Enabled allows network; disabled restricts TCP when Landlock ABI V4 is available, but cannot restrict UDP |
| Linux | Workspace Write | Read/write allowed | Same read allowlist; writes denied; a sensitive path overlapping an allowed path fails the launch closed | Enabled allows network; disabled restricts TCP when Landlock ABI V4 is available, but cannot restrict UDP |
| Native Windows | Read Only or Workspace Write | No child starts | No child starts | No child starts |
| Any | Full Access | Host-user access | Host-user access | Host-user access |

## Native Windows containment

The current Windows restricted-token backend uses `WRITE_RESTRICTED`. That
primitive applies the restricting SID check to writes, while reads continue to
use the signed-in user's ordinary access. A workspace capability ACL therefore
does not create a read allowlist.

Until a real Windows read boundary is implemented and proven on-box, the
trusted `__seren-sandbox-spec` path refuses every bounded native-Windows Claude
launch. The renderer reports the mode as unavailable, the provider runtime
fails before spawning Claude, and bounded Windows policy settings keep Bash
denied even if a stale launcher-shaped object is supplied. Full Access remains
available only as an explicit unconfined choice.

Restoring bounded Windows sessions requires live child and grandchild canaries
for outside-workspace reads and writes, sensitive paths inside the workspace,
path aliases and reparse points, plus an installed-app walkthrough. Merely
serializing a launch spec is not evidence that those controls are effective.

See issue #3514 for the security audit and permanent-backend acceptance
criteria.
