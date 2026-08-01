<!-- ABOUTME: Records the validation sign-in investigation and Mission Control slice evidence.
ABOUTME: Separates the authenticated partial run from the incomplete restart walkthrough. -->

# Mission Control slice walkthrough

## Outcome

The offline launch-box slice is committed in `5c314258`. A real validation instance reached the authenticated shell once, and a real three-task dispatch was started in slot 1422. The full restart/relaunch walkthrough is not complete: later same-slot launches stopped before publishing a fresh validation-control endpoint while macOS Keychain authorization was pending.

This report is part of #3511. Issue [#3529](https://github.com/serenorg/seren-desktop/issues/3529) records the validation sign-in history.

## Root-cause history

### Layer 1: scratch HOME had no default keychain

The validation launcher set `HOME` to the per-slot scratch directory in `scripts/validation-env.ts`, but that HOME initially had no macOS default User keychain. The fresh-session OS-keychain path introduced by commit `e5617753` therefore failed before a token could be stored. The configured login endpoint remained `https://api.serendb.com/auth/login`; an exact-method, exact-body-shape shell request returned HTTP 200, so the gateway and authentication response were not the failing layer.

Captured evidence:

```text
POST https://api.serendb.com/auth/login
HTTP_STATUS=200

HOME=.../artifacts/validation-home/slot1422 security default-keychain
security: SecKeychainCopyDefault: A default keychain could not be found.

UI: OS credential store could not store Seren access token: Platform secure storage failure: A default keychain could not be found.
```

The launcher now provisions a persistent keychain in the slot, disables automatic locking, unlocks it, makes it the default keychain, and restricts the security-tool search list to that slot. Every mutation is guarded so it can run only under `artifacts/validation-home/`.

### Layer 2: per-slot application authorization

After the first layer was provisioned, one instrumented sign-in reached token persistence but macOS returned an interactive authorization failure. The prompt was for the generated slot keychain's `login` password, not Taariq's macOS account password. The earlier UI error was:

```text
OS credential store could not store Seren access token: Platform secure storage failure: User canceled the operation.
```

The launcher prints the generated slot password locally for an assisted prompt; it is deliberately absent from source, commits, this document, and the PR. The current launcher additionally configures the slot keychain's partition list and keeps the slot HOME explicit.

## Definitive sign-in evidence

The second instrumented sign-in attempt in this phase reached the signed-in shell without a human answering a prompt. The validation control response for `waitFor button[aria-label^="SerenBucks balance"]` was:

```json
{"found":"button[aria-label^=\"SerenBucks balance\"]"}
```

The following `dumpText` then included `$3.07`, `Employees`, `New employee`, `Approval inbox`, and `Bounties`, with no sign-in form. This proves the API login and local token persistence path succeeded at least once in the slot.

The corresponding issue evidence is recorded in [the #3529 resolution-history comment](https://github.com/serenorg/seren-desktop/issues/3529#issuecomment-5151085576).

A later same-slot launch visibly displayed the Keychain dialog asking for the `login` keychain password. At the time of capture it had not been answered; the app log then ended with a keyring lookup followed by `tauri_runtime_wry: web content process terminated`, and the discovery file still contained the prior PID. The local-only screenshot is `/tmp/seren-validation-slot1422-current.png`; it is not committed.

## Partial real run evidence

Before the restart-only control failure, slot 1422 created two real runs. The first stopped after `run_create` because the original renderer bridge used snake_case Tauri argument names. The second used the corrected camelCase bridge and created three assignments, three tasks, and three dispatcher attempts:

```text
run 7696ed9d-e978-480b-bfa5-26924cad6fb9  status=running
tasks:
  e848877d-c5f6-418b-ab7a-7073bbf07fab  failed
  38633e7c-fc1e-4897-ae05-7eeae90c3ce2  review
  7d81ed6a-4b63-46a0-a71b-741ea5f3a416  failed
agent sessions:
  b699874e-b427-4567-9a5f-864d5c1adfa0
  aa581134-e01f-42db-b358-a166729e48a7
  3dff59f9-b214-499b-8e0f-448a15cbd21f
attempt_number=1 for each of the three attempts
```

Read-only SQL from the slot database (`.../chat.db`) confirmed the rows above. It also recorded three coverage gaps: an unknown `seren` native agent type, a failed local agent session, and an unparseable agent response. No finding was inserted, so this partial run does not satisfy the evidence or approval portion of the walkthrough.

The dispatcher now treats `seren` as a signed-in cloud-chat fallback, falls back to that path when a native provider cannot start, records a provider-boundary coverage gap, and keeps parse failures in review. The titlebar now has the missing Mission Control trigger needed to open the launch box.

## Walkthrough bounds and remaining gap

The following required live proof remains absent and is intentionally not synthesized:

- no run has yet completed the three requested tasks with two evidenced findings and an email artifact;
- no `open → accepted` email finding or `finding_status_changed` approval event was produced;
- no restart cycle has produced `run_interrupted`, a fresh attempt number, `run_relaunched`, or a terminal post-relaunch status;
- leases and worktree provisioning were not exercised by the dispatcher;
- screenshots remain local-only; provider behavior and model output remain potentially flaky;
- the current restart failure is limited to the validation process/control path after the Keychain prompt, not established as a production fresh-sign-in defect.

The next run must reuse slot 1422, confirm a fresh discovery PID, complete the launch-box run, approve the email artifact, interrupt a non-terminal task, click `run-relaunch`, and capture all SQL with `sqlite3 -readonly`.

Part of #3511
