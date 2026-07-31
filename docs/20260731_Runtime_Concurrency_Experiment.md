<!-- ABOUTME: Records the real embedded Claude runtime concurrency experiment and its evidence. -->
<!-- ABOUTME: Includes per-session identity/timing data, the cap decision, and queue-proof evidence. -->

# Runtime concurrency experiment

Date: 2026-07-31
Host: macOS 26.5.2
Embedded Node: v26.5.0
Claude CLI: 2.1.220 (Claude Code)
Runtime: bin/provider-runtime.mjs, desktop-native mode, port 4317
Project: /Users/taariqlewis/Projects/Seren_Projects/seren-desktop/.worktrees/runtime-concurrency

## Method

The harness used the real authenticated claude-code provider through the
embedded runtime WebSocket. It called provider_check_agent_available,
provider_spawn, provider_prompt, and provider_terminate. Session A stayed
alive while B was spawned in the same runtime process; after concurrent prompt
round-trips, C was spawned and prompted in that same process. The experiment
used SEREN_CONCURRENCY_SANDBOX_MODE=full-access because the host's
workspace-write policy denied the Claude login credential path even though the
direct CLI login was valid.

## Raw per-session results

| Label | Runtime port | Local session id | Native session id | Spawn to ready (ms) | Prompt round-trip (ms) | Result | Error |
| --- | ---: | --- | --- | ---: | ---: | --- | --- |
| A | 4317 | 87e9a214-15d7-4a8a-a52a-44521ed55cb9 | 059b035a-2f0b-43ea-bd64-3622858c6de4 | 805 | 1475 | PONG_A | — |
| B | 4317 | f81d7e8c-fc73-4857-a31d-9b22c8037d08 | 4076b029-c582-40df-a1ad-d6717720b493 | 898 | 1715 | PONG_B | — |
| C | 4317 | 3a2c16ee-f1d5-42d5-b1fa-0b742cb6b916 | 8f36d942-4073-494c-8596-dda780d047cf | 833 | 1614 | PONG_C | — |

The exact no-argument run completed with exit code 0. The emitted machine
result reported cliVersion as 2.1.220 (Claude Code) and three ready sessions
in one process.

## Diagnostic boundary

With SEREN_CONCURRENCY_SANDBOX_MODE=workspace-write, the same real runtime
reached ready but the first prompt returned the verbatim error
Not logged in · Please run /login. A direct non-interactive CLI probe in the
same worktree returned AUTH_PROBE, so this is a credential-store boundary of
the sandboxed child path, not an account-authentication result. The concurrency
verdict below therefore covers the full-access embedded runtime path; the
workspace-write auth path remains a separate integration risk.

OUTCOME: coexist

The observed verdict supports a default admission limit of 3 Claude sessions
per runtime process.

## Queue proof

The node scripts/experiment-claude-concurrency.mjs --queue-proof run set
SEREN_CLAUDE_SESSION_LIMIT=1 and used the same real runtime. The queued
session remained unresolved while A was active, and the gate released it only
after A termination:

[queue-proof] queued sessionId=359678a4-1676-4e44-a242-375c792acb27 position=1 activeTerminationsBeforeRelease=0 promiseUnresolvedBeforeRelease=true

[queue-proof] sessionId=359678a4-1676-4e44-a242-375c792acb27 queuedDurationMs=922 reachedReadyAfterFirstTermination=true

[queue-proof] passed
