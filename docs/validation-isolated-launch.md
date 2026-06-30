<!-- ABOUTME: Design + spec for the validation-isolated launch mode that lets a headless agent
ABOUTME: validate a branch build side-by-side with installed prod and capture real-app evidence. -->

# Validation-Isolated Launch Mode

**Status:** Design approved — implementation pending
**Tracking issue:** serenorg/seren-desktop#2776
**Addresses:** serenorg/seren-desktop#2775
**Delivery:** Single unified PR (no phasing). Work is dependency-ordered within the one PR.

---

## 1. Problem

Production bugfix PRs that require **real native-app walkthrough evidence** (screenshots + extracted UI-row text from the real Tauri runtime, not browser mocks) can become unmergeable. During #2774 validation on macOS:

- The installed `/Applications/SerenDesktop.app` hosts the active agent session and owns production single-instance state (socket derived from the bundle identifier) and the OAuth callback port `127.0.0.1:8787`. Quitting it would kill the session.
- Launching a branch packaged app side-by-side got focus-stolen into the installed instance; removing the single-instance socket let a branch process start but it still collided with production runtime state.
- The branch app's WKWebView content was **blank/uninspectable** through external macOS screenshot and accessibility paths.
- Browser-based inspection of the Vite frontend is not acceptable evidence — it is not the Tauri runtime and native IPC is unavailable by design.

Net: a UI-visible fix cannot produce its required merge-gate evidence without terminating the active session.

## 2. Goals / Non-goals

**Goals**
- A branch/validation build launches **side-by-side** with installed prod — no collision on single-instance socket, OAuth callback port, config/data dir, store, skills dir, or provider runtime.
- A **headless agent** (no human, no hands to click) can drive the real Tauri WebView and extract evidence: native screenshots + visible UI-row text.
- Evidence is **never silently blank** — a failed capture is explicit.
- Credentials for the validation test account **never enter the repo** and are safe under public-fork conditions.

**Non-goals**
- No general-purpose browser-automation framework. The control surface is the minimum needed for merge-gate walkthroughs.
- No always-on "does the app render" smoke test — explicitly rejected as false confidence for UI/UX correctness.
- No change to the production auth, OAuth, or runtime behavior. Validation code is absent from the production binary.

## 3. Consumer

The primary (only) consumer is a **headless automated agent** running merge-gate validation with shell/file/HTTP tools and **no ability to click native UI**. Every design choice below follows from that: the app must *produce its own evidence from inside its real runtime*, because external macOS screen-capture/accessibility is the path that already failed.

## 4. Decision log

| Fork | Decision | Why |
|---|---|---|
| Consumer | Headless agent | The blocked case (#2774) was an agent with no hands and no usable external capture. |
| Evidence channel | In-app loopback control channel (drive + capture) | macOS WKWebView speaks neither CDP (Playwright, Windows-only via WebView2) nor an Apple WebDriver; the only external hook is `webinspectord`/Safari Web Inspector — GUI-bound, no headless client. The ecosystem's answer (`tauri-plugin-playwright`) is an **in-app socket bridge**, not external debugging. |
| Isolation | Hybrid: build-time identifier overlay + runtime flag | Tauri derives data dir + single-instance socket from the identifier, so a build-time identifier swap isolates them **for free**; a runtime flag covers the two knobs identifier does not (OAuth port, skills dir). A pure runtime flag cannot change `app_data_dir()` without hand-overriding every path. |
| Screenshots | DOM-raster default + native ScreenCaptureKit opt-in | DOM-raster is computed from the DOM, so it is **immune to the blank-surface bug** (offscreen/occluded/off-Space WKWebView doesn't paint). Native capture is higher fidelity but reintroduces the visibility requirement, so it's opt-in with a degraded fallback. |
| Auth | Dedicated test account, secret-only, fork-safe, token-injection | A fresh isolated data dir boots signed-out; most real bugs live behind the login wall. Inject a secret-sourced token directly into the isolated store; never scrape the user's keychain; never commit the secret. |
| Delivery | Full scope, single PR, no phasing | Owner decision. Internal build order is dependency-driven, not gated releases. |
| CI | Label-gated, scenario-driven walkthrough — **no baseline smoke** | A baseline "app renders" smoke proves nothing about UI/UX correctness. The PR author deliberately labels the PR that needs the full real-app test, and CI runs the **targeted scenario**. |

## 5. Architecture

### 5.1 Validation identity & isolation

Introduce a second app identity **`com.serendb.desktop.validation`** (productName *"SerenDesktop (Validation)"*) produced **without forking** `tauri.conf.json`, via a checked-in overlay merged at build/dev time:

```
tauri build --config src-tauri/tauri.validation.conf.json
```

Tauri v2 merges `--config` into the base config using RFC-7396 JSON Merge Patch; the overlay swaps only `identifier` + `productName`. (Tauri docs explicitly name "isolated beta application with a separate name and identifier" as this feature's intended use.)

The identifier swap buys most isolation **for free**, because Tauri derives paths/locks from it:

- **`app_data_dir()` → separate directory** → separate `chat.db` (`src-tauri/src/services/database.rs:404`) and separate `tauri-plugin-store` files `auth.json` / `providers.json` / `oauth.json` (`src-tauri/src/lib.rs:68`).
- **Single-instance socket derives from identifier** (`src-tauri/src/lib.rs:535`) → different lock → launches side-by-side instead of focus-stealing into prod.
- **macOS treats it as a distinct app** → its own TCC / Screen-Recording grant (needed by native capture, §5.3).

Two knobs the identifier does **not** cover are handled by a runtime flag **`SEREN_VALIDATION_INSTANCE=1`** (launch tooling sets it; the validation identity also implies it):

- **OAuth callback port:** `8787` is hardcoded in `src-tauri/src/oauth_callback_server.rs:37`, `src-tauri/src/commands/auth.rs:9`, `src/services/social-login.ts:39`, `src/services/oauth.ts:51`, `src/services/publisher-oauth.ts:154`. Make it env-driven (`SEREN_OAUTH_CALLBACK_PORT`); in validation mode default to an **auto-picked free port** and publish it (see §5.5). Frontend reads the active port via a Tauri command rather than the hardcoded literal.
- **Skills dir:** `seren_config_dir()` honors `XDG_CONFIG_HOME` (`src-tauri/src/skills.rs:65`). In validation mode point it at the isolated config dir.

**Provider runtime** already binds an auto-picked free port (`src-tauri/src/provider_runtime.rs:295`) → no work.

Net: **zero collision** on socket, ports, DB, store, or skills.

### 5.2 Control channel (drive + capture)

A **loopback HTTP control server** inside the Rust core, compiled behind a `validation` Cargo feature and enabled at runtime only when `is_validation_instance()` (identifier ends in `.validation` **or** `SEREN_VALIDATION_INSTANCE=1`). It:

- binds `127.0.0.1` on an **auto-picked free port** (reuse the `tiny_http` dependency already used by `oauth_callback_server.rs`);
- mints a **per-launch random token**;
- writes `{port, token}` to a discovery file `validation-control.json` in the isolated app-data dir.

The agent reads the discovery file and sends the token as a header on every request. Unreachable in prod (feature-absent + runtime-gated), off-box (loopback), and unforgeable on-box (token).

**Command surface** (thin, Playwright-shaped):

| Command | Effect |
|---|---|
| `navigate(route)` | drive the SolidJS router to a view |
| `click(selector)` / `fill(selector, value)` / `press(key)` | interact |
| `waitFor(selector, timeout)` | synchronize before acting/capturing |
| `dumpText(selector)` | extract structured visible UI-row text |
| `screenshot(opts)` | DOM-raster default / native opt-in (§5.3) |
| `eval(js)` | escape hatch |

**Mechanism:** a request lands in Rust → Rust injects JS into the webview via `webview.eval()` → the injected bridge performs the DOM op/query and returns its result to Rust through a Tauri `invoke` callback, matched by a correlation id so Rust can `await` the reply and return it over HTTP. All real work happens **inside the live Tauri runtime over native IPC** — the layer external tools couldn't reach — and is identical across all three OSes.

The injected bridge lives in `src/services/validation-control.ts`, loaded only in validation builds.

### 5.3 Evidence capture

**UI-row text** (`dumpText`) walks the target DOM subtree and returns structured visible text. Because it reads the DOM, it is correct regardless of paint state.

**Screenshot — default DOM-raster.** Injected JS rasterizes the target element (or document) to PNG via canvas (SVG-`foreignObject` serialization, dependency-free; html2canvas only if a dependency is approved). Computed from the DOM → **independent of whether the OS painted the window** → immune to the #2774 blank-surface bug. Limit: cannot capture cross-origin/tainted images or truly native-composited layers — but the recording-picker thumbnails are ScreenCaptureKit images embedded as same-origin/data-URL `<img>` (commit `bc45fa84`), so they render.

**Screenshot — opt-in native** (`screenshot{native:true}`). Reuses the recording subsystem's ScreenCaptureKit path to grab the app's **own window** using the validation identity's own Screen-Recording grant. Real pixels of everything. Since it needs the window truly rendered, the command first forces it **on the active Space + unminimized + foregrounded** (directly addressing the recent off-Space commits `5f74d1ce`/`bc45fa84`). If it still can't guarantee visibility, it **falls back to DOM-raster and marks `degraded:true`** rather than return a blank frame.

**Never silently blank.** Every capture result carries metadata: method used, window-visibility state, `degraded` flag, route, selector, build identity, git SHA, timestamp.

**Output.** The app writes artifacts (PNG + sidecar JSON) into the isolated app-data dir's `validation-artifacts/`; the harness collects them into the repo's `artifacts/` dir for PR attachment, tied together by a per-walkthrough `manifest.json`.

### 5.4 Auth / state seeding

The validation build boots signed-out (empty isolated data dir). Seed it using the dedicated test account, credential supplied **only** through the environment.

- **Env contract:** `SEREN_VALIDATION_ACCOUNT_TOKEN` — a refresh token or scoped API key (not username/password → no interactive login / 2FA / OAuth browser dance). Optional `SEREN_VALIDATION_ACCOUNT_PROVIDERS` (JSON) seeds `providers.json` for agent flows.
- **Mechanism:** at validation startup, when the flag is set and the token env is present, Rust writes the credential directly into the isolated `auth.json` store — the same `TOKEN_KEY` / `REFRESH_TOKEN_KEY` the app already reads (`src-tauri/src/lib.rs:68`) — **before** the UI loads. The app boots already-authenticated, **bypassing the `8787` OAuth callback for primary sign-in**. (OAuth-port isolation from §5.1 then only matters for secondary publisher/MCP OAuth a walkthrough exercises.)
- **Fork safety:** GitHub withholds repo secrets from **forked-PR** workflows under the `pull_request` trigger (they resolve to empty). So token present → authed validation; token absent → validation boots signed-out, runs **pre-auth scope only**, emits an explicit *"no validation credential — authed checks skipped"* marker (never a silent pass, never a crash). Fork contributors supply **their own** test account via the same env var.
- **Handling:** the seeded token lives only in the ephemeral isolated data dir — gitignored, wiped on teardown — and is **never logged**. `pull_request_target` is never used for any job that runs untrusted PR code.

### 5.5 Walkthrough harness

`pnpm validate:walkthrough` (`scripts/validate-walkthrough.ts`):

1. Build the validation app (`tauri build --config src-tauri/tauri.validation.conf.json`) — or `tauri dev` with the overlay + flag for fast local iteration.
2. Launch with `SEREN_VALIDATION_INSTANCE=1` + the account-token env, isolated ports/dirs.
3. Wait for the `validation-control.json` discovery file.
4. Run a **scenario** — `tests/validation/scenarios/<name>.ts`, a module that receives a typed control client and issues `navigate`/`click`/`dumpText`/`screenshot`.
5. Collect artifacts (PNGs + sidecar JSON + `manifest.json`) into `artifacts/`.
6. Tear down — kill the app, wipe the isolated data dir.

The agent then attaches artifacts to the PR/issue via `gh`.

### 5.6 CI wiring

A GitHub Actions job, **`pull_request` trigger gated to the `needs-validation` label** (`types: [labeled, synchronize]`), on a macOS runner, with a path filter (`src/**`, `src-tauri/**`). **No baseline smoke.** When the label is present it runs the **targeted scenario** for that PR.

- **Scenario selection:** the labeled PR specifies its scenario (convention: a scenario file added/changed under `tests/validation/scenarios/` in that PR, or named in the PR body). CI runs that scenario; it never invents one.
- **Trusted same-repo PR** → has the secret → full authed walkthrough; uploads artifacts; optional PR comment.
- **Forked PR** → no secret → pre-auth scope; explicit "authed validation skipped (fork)" note.
- **Honest CI caveat:** GitHub-hosted macOS runners are effectively headless and granting Screen-Recording TCC non-interactively is unreliable, so **native capture degrades to DOM-raster in CI** (the guaranteed floor). Native capture is a local-Mac-with-a-display affordance; the `degraded` flag makes this visible.

Create the `needs-validation` label as part of this work.

## 6. Security

- The control server, native capture, and auth seeding are all compiled behind the `validation` Cargo feature **and** runtime-gated. The production binary is built **without** the feature → the code is physically absent, not merely disabled.
- Control server: loopback-only + per-launch token; token never logged.
- Auth seed: secret-sourced from env only; never committed; never logged; isolated data dir gitignored and wiped on teardown.
- `pull_request_target` is never used for jobs running untrusted PR code.
- No production auth/OAuth/runtime behavior changes; OAuth port parameterization defaults to the existing `8787` outside validation mode.

## 7. Acceptance criteria → component

| #2775 acceptance criterion | Component |
|---|---|
| Side-by-side launch, no collision (socket, port, config dir, provider runtime) | §5.1 identity overlay + runtime knobs |
| Validation build renders a visible WebView window on macOS | §5.1 launch + §5.3 visibility-forcing |
| Native screenshot returns real UI pixels, not blank | §5.3 native capture (+ DOM-raster floor) |
| UI-row text extractable via approved native-app path | §5.2 `dumpText` |
| Documented merge-gate workflow | §5.6 + §8 docs |
| #2774-class PR completes walkthrough without killing the session | whole loop |

## 8. Implementation plan (single PR, dependency-ordered)

1. **Identity overlay** — `src-tauri/tauri.validation.conf.json`; `package.json` scripts `tauri:validation:dev` / `tauri:validation:build`.
2. **Validation mode + isolation knobs** — `src-tauri/src/validation/mod.rs` (`is_validation_instance()`); parameterize OAuth port (`oauth_callback_server.rs`, `commands/auth.rs`, frontend services via a `get_oauth_callback_port` command); isolate skills dir via `XDG_CONFIG_HOME`.
3. **Control channel** — `src-tauri/src/validation/control_server.rs` (feature-gated, `tiny_http`, token, discovery file); `src/services/validation-control.ts` injected bridge; register marshalling command in `lib.rs`.
4. **Evidence capture** — DOM-raster util (frontend, dependency-free); `src-tauri/src/validation/native_capture.rs` reusing ScreenCaptureKit + visibility-forcing + degraded fallback; artifact/manifest writer.
5. **Auth seeding** — write secret token into isolated store at startup; optional providers seed; markers for absent-secret.
6. **Harness** — `scripts/validate-walkthrough.ts`; `pnpm validate:walkthrough`; scenario format under `tests/validation/scenarios/`.
7. **CI** — `.github/workflows/validation-walkthrough.yml` (label-gated, macOS, path filter); create `needs-validation` label.
8. **Docs** — this file + a merge-gate guide (build/launch, run a scenario, collect + attach evidence, env-var contract, fork-contributor guidance).
9. **Gitignore** — isolated artifact/data paths.

## 9. Testing strategy

Per project TDD rules, test the security-/correctness-critical pieces, not UI scaffolding:
- `is_validation_instance()` gating (identifier + flag matrix).
- OAuth port resolution (default `8787` outside validation; env override; auto-pick in validation).
- Control-server token enforcement (reject missing/wrong token).
- Auth-seed absent-secret path emits the marker and does not crash / does not log the token.
- Production build (feature off) does **not** link the control server (compile-time assertion / `#[cfg]` coverage).

## 10. Risks / open questions

- **DOM-raster fidelity** for native-composited content → mitigated by native opt-in; documented limit.
- **html2canvas dependency** — prefer the dependency-free SVG-`foreignObject` path; only add a dep with explicit approval.
- **CI native capture degradation** on headless macOS runners → DOM-raster floor + `degraded` flag; documented.
- **CI scenario-selection convention** — settle the exact rule (scenario file in the PR vs PR-body reference vs label-mapped) during implementation.
- **macOS signing/notarization** of the validation identity sufficient for TCC prompts on a real Mac — confirm against current signing setup before relying on native capture locally.

## 11. References

- Tauri — Configuration Files (`--config` RFC-7396 merge; isolated beta identity): https://v2.tauri.app/develop/configuration-files/
- Tauri — CLI reference: https://v2.tauri.app/reference/cli/
- Tauri WebDriver (no WKWebView WebDriver on macOS): https://v2.tauri.app/develop/tests/webdriver/
- `tauri-plugin-playwright` (in-app socket bridge, not CDP): https://github.com/srsholmes/tauri-playwright
- WebKit — Enabling Inspection of Web Content (`isInspectable`): https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/
- GitHub Docs — Secure use (secrets withheld from forked-PR workflows): https://docs.github.com/en/actions/reference/security/secure-use
