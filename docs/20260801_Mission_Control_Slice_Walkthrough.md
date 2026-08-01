<!-- ABOUTME: Records the validation sign-in investigation for the Mission Control vertical slice.
ABOUTME: The live run was not started because macOS secure-storage authorization remained blocked. -->

# Mission Control slice walkthrough

## Outcome

The offline launch-box slice is committed in `5c314258`. The live walkthrough stopped at sign-in after one instrumented attempt and one retry after the launcher fix. No live run, task, agent session, finding, approval transition, or validation-instance SQL evidence was produced.

The validation sign-in blocker is tracked in [issue #3529](https://github.com/serenorg/seren-desktop/issues/3529). This report is part of #3511.

## Root cause and evidence

Root cause: the validation launcher set `HOME` to the per-slot scratch directory in `scripts/validation-env.ts:23-25`, but that scratch HOME had no macOS default User keychain. The fresh-session OS-keychain path introduced by commit `e5617753` therefore failed before a token could be stored. The configured login endpoint remained `https://api.serendb.com/auth/login`; an exact-method, exact-body-shape shell request returned HTTP 200, so the gateway and authentication response were not the failing layer.

Captured evidence before the launcher change:

```text
POST https://api.serendb.com/auth/login
HTTP_STATUS=200

HOME=/Users/taariqlewis/Projects/Seren_Projects/seren-desktop/.worktrees/slice-walkthrough/artifacts/validation-home/slot1422 security default-keychain
security: SecKeychainCopyDefault: A default keychain could not be found.

UI: OS credential store could not store Seren access token: Platform secure storage failure: A default keychain could not be found.
```

The launcher was changed to provision and unlock a persistent keychain inside the validation slot before starting Tauri. This is the smallest validation-environment fix for the missing default-keychain condition. The single retry reached token persistence, but macOS then returned an interactive authorization failure:

```text
UI screenshot: OS credential store could not store Seren access token: Platform secure storage failure: User canceled the operation.
validation stdout: keyring set-password reached access-token.v1, but no successful token write or signed-in shell followed
```

The shell check and the UI error together bound the failure to macOS Keychain authorization for the validation binary, rather than the API route. No authorization bypass was attempted. The screenshot was retained locally at `/tmp/seren-slice-signin-stall.png` and is not committed because screenshots from the signed-in validation environment are local-only.

Relevant configuration and history:

- `src/lib/config.ts:9-10` resolves the API root to `https://api.serendb.com` when no Vite override is supplied.
- `scripts/validation-dev.ts` passes the slot HOME and does not replace the API root with another host.
- `src/lib/tauri-fetch.ts` routes the login request through the gateway bridge; the observed failure occurs later while storing the returned access token.
- `src-tauri/capabilities/default.json` permits the API origin, and no validation-specific capability file narrows that HTTP scope.
- `e5617753` moved desktop access and refresh tokens into the native OS keychain, which is why a fresh scratch HOME exposes this validation-only condition.
- `078ba82a` changed desktop API-key scope handling but did not change the login transport or token-storage path.

## Diagnostic code change

`src/services/auth.ts` now includes the resolved login URL and either the HTTP status or a short transport error in failed-login diagnostics. The tests cover an HTTP 503 response and a no-response gateway failure. The console diagnostic contains only URL/status/error metadata; no credential is logged.

Focused verification:

```text
pnpm vitest run tests/unit/auth-service-refresh-login.test.ts tests/unit/validation-env.test.ts
8 tests passed; 5 tests passed; exit 0
```

## Walkthrough coverage

Because the signed-in shell was never reached, the following evidence is intentionally absent rather than synthesized:

- no real run id, task ids, agent session ids, attempt numbering, or restart/relaunch cycle;
- no `interrupted` status history, `run_events` sequence dump, `run_tasks` dump, or `run_attempts` dump from a validation database;
- no findings with git or non-git evidence, coverage-gap row, email artifact, or `finding_status_changed` approval event;
- no proof of dispatcher concurrency, model fallback behavior, leases, or worktree provisioning.

The non-git target preparation and offline UI tests are separate from this blocked live proof. If macOS Keychain access is authorized for the validation binary, the next walkthrough must reuse the slot database, run the three declared tasks, approve the email artifact, interrupt a non-terminal run, relaunch it, and capture the required `sqlite3 -readonly` evidence. Local screenshots remain outside the repository.

Part of #3511
