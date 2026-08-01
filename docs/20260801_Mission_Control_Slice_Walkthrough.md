<!-- ABOUTME: Records the validation sign-in investigation and Mission Control slice evidence.
ABOUTME: Separates resolved slot-keychain access from the externally blocked run. -->

# Mission Control slice walkthrough

## Outcome

The offline launch-box slice is committed in `5c314258`. A rebuilt validation instance reached the authenticated shell, and two consecutive `--no-build` relaunches restored it without a visible prompt. The slot-keychain verification is resolved for the authorized binary. The later Mission Control run remains incomplete because the external MCP gateway returned HTTP 503 and native provider fallbacks were unavailable; those are run-coverage bounds, not keychain failures.

This report is part of #3511. Issue [#3529](https://github.com/serenorg/seren-desktop/issues/3529) records the validation sign-in history; its closure evidence is in [the closing comment](https://github.com/serenorg/seren-desktop/issues/3529#issuecomment-5151275967).

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

## Keychain verification — RESOLVED

The rebuilt binary launched on slot 1422 at 11:34:51 and reached the signed-in shell. It was then stopped and relaunched twice with `SEREN_VALIDATION_DEV_PORT=1422 pnpm tauri:validation:dev -- --no-build`; the direct binary path reused the already-authorized build. Both no-build launches reached the signed-in shell without a human answering a Keychain prompt. The validation control responses for the two no-build launches contained these authenticated-shell rows:

```json
{"selector":"span:nth-visible(9)","text":"Employees"}
{"selector":"div:nth-visible(12)","text":"Approval inbox"}
{"selector":"span:nth-visible(14)","text":"Bounties"}
{"selector":"div:nth-visible(652)","text":"Mission control"}
```

The first no-build control server was `http://127.0.0.1:57784` at 11:35:28; the second was `http://127.0.0.1:57844` at 11:35:53. Their logs each showed reads of the slot access-token entry and successful token refresh, and neither log contained a Keychain prompt. The initial built launch's `dumpText` also included `$3.07`, `Employees`, `New employee`, `Approval inbox`, and `Bounties`, with no sign-in form. This proves store and read-back for the slot keychain across the built launch plus two no-build relaunches.

The corresponding earlier issue evidence is recorded in [the #3529 validation-history comment](https://github.com/serenorg/seren-desktop/issues/3529#issuecomment-5151085576).

The earlier same-slot prompt was caused by rebuilding an unsigned development binary. The dialog asked for the scratch keychain's generated `login` password, not Taariq's macOS password. The `--no-build` mode records the per-rebuild bound: a rebuild may require a fresh operator authorization, while relaunching the same already-authorized binary does not. The local-only screenshot and the generated slot password are not committed.

## Final no-build evidence pass — 2026-08-01

The first phase-27 no-build launcher attempt exited 143 before creating a fresh control discovery file. The repository's full Cargo gate from the preceding phase had overwritten `src-tauri/target/debug/Seren` with the default-feature binary: its fingerprint recorded `features=["default"]`, while the existing `src-tauri/target/debug/deps/Seren-7ab2b1a71896a2bd` executable recorded `features=["validation"]` and contained the validation control server. I restored that existing validation-feature executable to the launcher path with a recoverable copy of the default binary outside the worktree. No source file was changed and no validation rebuild was run. This derived-artifact repair is the phase deviation from the strict no-rebuild assumption.

The repaired no-build launch at 12:24:08 used control server `http://127.0.0.1:59105`. Its health response was `{"ok":true,"frontendReady":true}` and `dumpText` showed `Employees`, `Approval inbox`, `Bounties`, `$1.67`, and `Mission control`; the process log showed slot-keychain reads and `Token refreshed successfully`. No Keychain prompt appeared.

For the required restart attempt, the process was stopped at 12:24:12 while `cf306239-d710-4301-aff6-335b4a3ebe02` still had non-terminal tasks. The same binary relaunched at 12:25:26 on control server `http://127.0.0.1:59231`. Its health response was again `{"ok":true,"frontendReady":true}` and `dumpText` again showed `Employees`, `Approval inbox`, `Bounties`, and `Mission control`, with no Keychain prompt. The fresh frontend showed the launch box rather than an interrupted banner: `runStore` starts with no active run and does not hydrate an existing database run on mount. Read-only SQL confirmed that the `cf306239…` row remained `running`, with no new `run_interrupted` or `run_relaunched` event and no attempt 2. I therefore did not click a nonexistent `run-relaunch` control and did not create a duplicate run.

The final read-only excerpts from the validation slot database were:

```text
runs:
  a9c83443-d70a-4f5d-a9aa-a05d41caa5d6  interrupted  interrupted_at=1785584239863
  cf306239-d710-4301-aff6-335b4a3ebe02  running       interrupted_at=NULL

cf306239-d710-4301-aff6-335b4a3ebe02 events:
  sequence 1 run_created
  sequence 10 attempt_started
  sequence 12 attempt_started
  sequence 16 attempt_started
  sequence 17 coverage_gap_recorded
  sequence 18 attempt_finished

cf306239-d710-4301-aff6-335b4a3ebe02 attempts:
  cc7a2696-6d4a-4891-86e8-11e1595c20c7  attempt=1  session=47fee3e1-8efc-45fc-9c27-78ec6fa8b1ab
  2d772e75-c087-4b63-872e-3c5f35e52f21  attempt=1  session=05b7bd2a-a757-4040-961b-811d6f1db7c4  outcome=parse_failed
  999911d2-b397-4a82-8f6d-221c1c945376  attempt=1  session=ceb0b07d-d0f4-4ab5-8b49-3cd0aded3316

coverage gap:
  d0447d07-880f-4aad-bc0b-987aab166b8a  unparseable  Summarize non-git release documents
```

## Proven / not proven

| Area | Result | Evidence and bound |
| --- | --- | --- |
| Slot keychain store/read across relaunch | Proven | One repaired no-build launch plus the following same-binary restart restored the authenticated shell with no Keychain dialog; process logs show keyring reads and token refresh. |
| Three-way dispatcher start / concurrency observation | Partially proven | `cf306239…` has three real agent sessions and three attempt-1 rows; the run did not produce complete parseable output. |
| Run-owned sessions | Not proven | Session IDs are present in readonly SQL, but the restart pass did not expose a durable UI state from which ownership could be independently verified. |
| Startup interruption | Proven for prior run | `a9c83443…` has `run_interrupted` at sequence 27 and `interrupted_at=1785584239863`; the fresh process-kill pass did not add an interruption event for `cf306239…`. |
| Relaunch and attempt numbering across restart | Not proven | No `run_relaunched` row or attempt number 2 exists; no interrupted banner was rendered after restart because the frontend did not hydrate the existing run. |
| Coverage-gap honesty | Proven | The parse failure created the `unparseable` coverage-gap row and left the task in `review`; no finding was synthesized. |
| Evidence findings and email approval | Not proven | `run_findings` is empty, so there is no `evidence_json`, email artifact, `open → accepted` transition, or `finding_status_changed` event. |
| Leases and worktree provisioning | Not proven | Outside the dispatcher exercised by this walkthrough. |

The final bounds are: validation used the existing signed-in slot and the no-build binary-reuse path; rebuilding may require fresh operator keychain authorization; the current run was not duplicated; no live email was sent; screenshots were local-only; MCP/provider availability and model output were not treated as evidence; and no credential or generated slot password is part of this artifact.

## Partial real run evidence

The current no-build session created one fresh real run after the keychain proof. The scheduler also reconciled the previous in-flight run when this command path started. Read-only SQL from the slot database confirmed:

```text
run cf306239-d710-4301-aff6-335b4a3ebe02  status=running
tasks:
  cc7a2696-6d4a-4891-86e8-11e1595c20c7  running
  2d772e75-c087-4b63-872e-3c5f35e52f21  review
  999911d2-b397-4a82-8f6d-221c1c945376  running
agent sessions:
  47fee3e1-8efc-45fc-9c27-78ec6fa8b1ab
  05b7bd2a-a757-4040-961b-811d6f1db7c4
  ceb0b07d-d0f4-4ab5-8b49-3cd0aded3316
attempt_number=1 for each of the three attempts
coverage gap:
  d0447d07-880f-4aad-bc0b-987aab166b8a  unparseable  Summarize non-git release documents
```

The previous in-flight run `a9c83443-d70a-4f5d-a9aa-a05d41caa5d6` has a `run_interrupted` event at sequence 27 and `interrupted_at=1785584239863`, proving startup reconciliation. The new run's three sessions were real, but no attempt completed with a parseable `seren-findings` block. No finding was inserted, so this real run does not satisfy the evidence or approval portion of the walkthrough.

The dispatcher now treats `seren` as a signed-in cloud-chat fallback, resolves the live Seren model catalog when the stored model is `auto`, falls back to that path when a native provider cannot start, records a provider-boundary coverage gap, and keeps parse failures in review. The titlebar now has the missing Mission Control trigger needed to open the launch box. The catalog fix was verified by focused dispatcher tests. The live run instead encountered a transient MCP gateway HTTP 503, a Codex HTTP 401, and local shell approvals; no evidence was synthesized from those blocked attempts.

## Phase 9 merged-build verification — 2026-08-01

The cleanup completed before this pass: the merged `origin/main` checkout was
at `ccf40b388d829a2f76a77125931d290f23774b95`, the retired rehydration
worktree was removed, and the documentation worktree was created from the
merged build. `pnpm install --prefer-offline` and `pnpm prepare:mcp-servers`
completed successfully.

The one supervised rebuilt launch completed compilation and started the
validation binary on slot 1422. The native validation-control bridge, rather
than a browser tab pointed at the Vite server, drove the sign-in form. Its
initial `dumpText` showed the signed-out shell. After the one in-memory vault
credential submission, the native shell displayed exactly:

```text
Sign in to Seren
Authentication failed (network: Gateway request failed: error sending request for url (https://api.serendb.com/auth/login))
```

The process log recorded successful keyring entry creation and deletion for
the slot access and refresh token accounts, but no token was returned and no
authenticated shell was reached. No Keychain dialog or secure-storage error
was visible in this attempt. A shell-level diagnostic POST to the same
endpoint returned HTTP 422 for an intentionally empty body, establishing that
the endpoint was reachable from the operator shell while the Tauri Gateway
bridge failed before receiving an HTTP status. This is an external runtime
transport bound, not evidence of a keychain denial.

Because sign-in did not complete, the required `--no-build` relaunch was not
started, the launch box was not used, and no new run was created. A
readonly query of this phase's slot database returned zero rows from `runs`.
The restart-cycle, interrupted-banner, relaunch, findings, and approval
assertions therefore remain unproven in this pass. The previous historical
SQL evidence and the earlier no-build keychain evidence above remain intact;
this attempt adds no contradictory keychain result.

### Phase 9 proven / not proven

| Area | Result | Evidence and bound |
| --- | --- | --- |
| Cleanup and merged-build launch | Proven | `git worktree list`, the merged `origin/main` commit, successful validation compilation, and the native control bridge log. |
| Native sign-in on the merged build | Not proven | Native `dumpText` ended at the Gateway transport error above; the attempt stopped after the single supervised submission. |
| Promptless `--no-build` rehydration | Not proven in this pass | No no-build relaunch was attempted after the sign-in transport failure; this slot had no `runs` row to hydrate. |
| Interrupted/relaunch cycle and attempt 2 | Not proven in this pass | No run was created, so there can be no new `run_interrupted`, `run_relaunched`, or attempt-2 row. |
| Findings and email approval | Not proven in this pass | The run never reached the launch box; no new finding or `finding_status_changed` row exists. |
| Keychain root-cause and prior reuse evidence | Retained | The two-layer history and earlier authenticated same-binary evidence remain above; this pass saw keyring operations without a secure-storage error. |

The phase-9 coverage bound is one rebuilt merged-main launch, one native
sign-in submission, and a readonly inspection of that phase's slot database.
It does not include a no-build restart, a run dispatch, a task completion, an
approval, or a relaunch. The external Gateway transport must be restored
before the remaining live walkthrough evidence can be collected.

## Walkthrough bounds and remaining gap

The following required live proof remains absent and is intentionally not synthesized:

- no run has yet completed the three requested tasks with two evidenced findings and an email artifact;
- no `open → accepted` email finding or `finding_status_changed` approval event was produced;
- the new run has not completed a restart/relaunch cycle with `run_relaunched`, attempt number 2, and a terminal post-relaunch status; startup reconciliation did produce `run_interrupted` for the prior in-flight run when the new run command started;
- leases and worktree provisioning were not exercised by the dispatcher;
- screenshots remain local-only; provider behavior and model output remain potentially flaky;
- the current final-pass gap occurred before any run existed: the Tauri Gateway transport could not complete `/auth/login`; keychain access was not the failing layer observed in this attempt.

The remaining work is the external Gateway/provider path: restore native
Gateway transport, sign in, run the three tasks without duplicating a run,
approve an actual email artifact, and capture the relaunch rows with
`sqlite3 -readonly`. The earlier keychain evidence remains resolved for the
reused binary, but this phase does not close the Mission Control tracking
issue on partial evidence.

Part of #3511
