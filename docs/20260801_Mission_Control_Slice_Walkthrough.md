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

## Walkthrough bounds and remaining gap

The following required live proof remains absent and is intentionally not synthesized:

- no run has yet completed the three requested tasks with two evidenced findings and an email artifact;
- no `open → accepted` email finding or `finding_status_changed` approval event was produced;
- the new run has not completed a restart/relaunch cycle with `run_relaunched`, attempt number 2, and a terminal post-relaunch status; startup reconciliation did produce `run_interrupted` for the prior in-flight run when the new run command started;
- leases and worktree provisioning were not exercised by the dispatcher;
- screenshots remain local-only; provider behavior and model output remain potentially flaky;
- the current run gap is the external MCP gateway/provider path; keychain access is not the failing layer.

The remaining work is the external-provider run path: restore the MCP gateway, rerun the three tasks without duplicating the run, approve an actual email artifact, and capture the relaunch rows with `sqlite3 -readonly`. Keychain access itself is resolved for the reused binary and issue #3529 can be closed on that evidence.

Part of #3511
