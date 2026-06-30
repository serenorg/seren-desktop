<!-- ABOUTME: Adversarial audit prompt for the validation-isolated launch mode design; an independent
ABOUTME: reviewer follows this to attack the design and write findings to the audit doc. -->

# Adversarial Audit Prompt — Validation-Isolated Launch Mode

**Subject under audit:** `docs/validation-isolated-launch.md`
**Tracking:** serenorg/seren-desktop#2776 · **Origin:** #2775 · **PR:** #2777
**Your output:** `docs/validation-isolated-launch-audit.md`

---

## 1. Your role

You are an **independent, adversarial reviewer**. Assume the design is flawed and your job is to **prove how it breaks**, not to bless it. A clean bill of health that misses a real defect is the **worst possible outcome** of this audit — worse than finding nothing because you were too aggressive.

You are not the author. Do not defer to the design doc's confidence. Every load-bearing claim in it is a hypothesis you must independently confirm or refute against the **live code and live external behavior**.

## 2. Inputs — read before you start

1. The design under audit: `docs/validation-isolated-launch.md` (read it fully).
2. The motivating issue #2775 and its acceptance criteria; tracking #2776; PR #2777.
3. The **actual code** the design cites — open each and verify the design's description matches reality:
   - `src-tauri/tauri.conf.json` (identifier, bundle config)
   - `src-tauri/src/lib.rs` (single-instance plugin ~`:535`; store consts ~`:68`; runtime env)
   - `src-tauri/src/oauth_callback_server.rs` (hardcoded `127.0.0.1:8787`)
   - `src-tauri/src/commands/auth.rs` (REDIRECT_URI), `src/services/{oauth,social-login,publisher-oauth}.ts`
   - `src-tauri/src/services/database.rs` (`app_data_dir().join("chat.db")`)
   - `src-tauri/src/skills.rs` (`seren_config_dir()`, `XDG_CONFIG_HOME`)
   - `src-tauri/src/embedded_runtime.rs`, `src-tauri/src/provider_runtime.rs` (runtime dirs + dynamic port)
   - The recording subsystem's ScreenCaptureKit window-capture path (recent commits `bc45fa84`, `5f74d1ce`)
   - Wherever auth tokens are actually stored — **trace it to ground**: tauri-plugin-store file vs OS keychain.
4. Hard-won project lessons that are directly relevant — treat these as known landmines:
   - **Refresh-token rotation race** previously caused mid-session forced logout. The design seeds a token into the validation store; ask whether validation runs can rotate/invalidate any shared credential.
   - **PRs on this repo merge instantly with no CI gating.** A label-gated check that isn't actually required, or that can be merged around, provides false assurance.
   - **Off-Space / occluded WKWebView does not paint** (the root cause behind #2774's blank surface).

## 3. Ground rules

- **Verify, don't trust.** For each claim, check the code or the live external behavior. Cite `file:line`.
- **Reproduce where you can.** Build the validation overlay (`tauri ... --config src-tauri/tauri.validation.conf.json` once it exists, or reason precisely about what it would produce), launch it, and probe isolation/capture/auth empirically. If you cannot reproduce, say so explicitly.
- **Label every finding** `CONFIRMED` (you reproduced or verified it in code) or `PLAUSIBLE` (reasoned, not yet verified). Do not present PLAUSIBLE as CONFIRMED.
- **Do not assert third-party capability from memory.** Tauri config-merge behavior, WKWebView paint/canvas semantics, macOS TCC/Screen-Recording grant scoping, and GitHub Actions fork-secret behavior all change — verify against docs or a live check and state what you checked.
- **"I guessed without checking" is a failed audit.**

## 4. Attack surface — go hard at each

For every item: state the threat, attempt to demonstrate it, rate severity, and propose the minimal fix.

1. **Control-channel prod leak.** The loopback server can drive the UI and `eval` arbitrary JS. Prove the feature-gate **and** runtime-gate are airtight — that the production binary cannot link or enable it. Is it a Cargo `--features` gate (code physically absent) or only a runtime `if`? Could a release build accidentally enable it? Is binding truly `127.0.0.1` (never `0.0.0.0`)?
2. **On-box token theft.** The discovery file holds `{port, token}` in the isolated app-data dir. Any local process running as the same user can read it, then drive the validation app and **exfiltrate the seeded test-account token** via `eval`/`dumpText`. Is that acceptable? File permissions? Token lifetime? Is the threat model "single-user dev box only" stated and sufficient?
3. **Secret exfiltration via CI.** Confirm the workflow uses `pull_request` (never `pull_request_target`) for any job that runs untrusted PR code. Can a malicious forked PR alter the workflow/scenario to print the secret? Could the seeded token end up in uploaded artifacts, logs, screenshots, or `dumpText` output?
4. **Isolation completeness — the keychain question.** The design assumes `app_data_dir()` isolation covers auth because tokens live in `tauri-plugin-store`. **Verify that nothing stores secrets in the macOS/Windows OS keychain under a fixed service name** — if it does, the validation identity could read or clobber the **production** account's credential. Enumerate ALL shared OS resources beyond the data dir: keychain entries, other fixed ports/sockets, lockfiles, temp dirs, the `mcp-servers/` staging dir, messaging adapter bindings, deep-link scheme registration (`seren://`).
5. **DOM-raster technical validity.** Challenge "immune to the blank-surface bug." Does SVG-`foreignObject`/canvas rasterization actually render a WKWebView's DOM faithfully, including the ScreenCaptureKit `<img>` thumbnails — or does canvas **taint** on those images and throw on `toDataURL`? Does WKWebView throttle JS/canvas/`requestAnimationFrame` when occluded or off-Space, defeating the "independent of paint" premise? Verify empirically.
6. **Native capture viability when headless.** A **new** bundle identity (`com.serendb.desktop.validation`) starts with **no** Screen-Recording TCC grant; the first capture pops a TCC prompt that a headless agent cannot click. Determine whether native capture is therefore effectively unusable headlessly/on first run, and whether the design over-claims by listing it as satisfying "native screenshot returns real UI pixels." Does the new identity inherit the prod app's grant? (Assume not — verify.)
7. **Auth-seeding correctness & rotation contamination.** Is writing the token into the store before the UI loads racy with store-plugin init? When the seeded refresh token is used and **rotated**, can it invalidate a session that matters? Is the test account truly disjoint from anything a developer is logged into?
8. **Race conditions.** Discovery file read before the server is listening (partial/empty file). Teardown wiping the data dir while the app is still writing. Correlation-id matching in the `eval` bridge under concurrent commands — can replies cross? `waitFor` timeout semantics.
9. **CI correctness & honesty.** Does `types: [labeled, synchronize]` re-run correctly when the label is added after a push? Given instant-merge with no gating, is the check actually enforced or merely advisory? The scenario-selection convention is explicitly unresolved in §10 — pressure-test each candidate. Does the path filter miss relevant changes?
10. **Acceptance-criteria honesty.** For each #2775 criterion, decide whether the design *actually* satisfies it or hand-waves. In particular: "the validation build renders a **visible** WebView window" — DOM-raster proves the DOM exists, not that a window is visible on a display. Flag any criterion that is claimed-met but not truly met.
11. **Scope / YAGNI.** Is the control-channel + dual-capture complexity justified, or is there a materially simpler design that still unblocks #2774-class evidence? Name it if so.

## 5. Load-bearing claims to challenge head-on

- "DOM-raster is immune to the blank-surface bug." → Is it, really, on WKWebView with tainted images and occlusion throttling?
- "The identifier swap isolates auth for free." → Only if no secret is in the OS keychain. Prove it.
- "Native capture reuses the validation identity's own Screen-Recording grant." → A new identity has no grant; a headless agent can't grant it.
- "The control server is absent from the production binary." → Show the gating mechanism and that release builds exclude it.
- "Forked PRs get an empty secret, so it's safe." → Confirm the trigger and that no secret-bearing job runs untrusted code.

## 6. Severity rubric

- **Blocker** — ships a vuln, leaks a secret, contaminates production state, or fails to meet a #2775 criterion it claims to meet.
- **High** — likely to fail in real use or create a maintenance/security hazard; needs a fix before relying on the feature.
- **Medium** — real defect with a workaround or limited blast radius.
- **Low** — correctness/robustness nit.
- **Nit** — style/clarity.

## 7. Required output — write to `docs/validation-isolated-launch-audit.md`

1. **Verdict** (one line): `SHIP` / `SHIP WITH CHANGES` / `BLOCK`.
2. **Findings table**, most-severe first: `ID | Severity | Area | CONFIRMED/PLAUSIBLE | file:line | Repro | Impact | Recommended fix`.
3. **Per-finding detail** for everything High and above: the concrete failure scenario (inputs/state → wrong/dangerous outcome) and the minimal fix.
4. **Verified-true list** — design claims you checked and confirmed correct (so the author knows what survived scrutiny).
5. **Coverage statement** — exactly what you examined, what you reproduced, and **what you did not examine** (no silent gaps).

Rank findings by severity. If you found nothing in a section, say why you're confident — not just that you looked.
