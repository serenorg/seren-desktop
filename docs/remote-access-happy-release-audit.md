<!-- ABOUTME: Records the pre-release audit of the merged Happy remote-access integration. -->
<!-- ABOUTME: This report contains redacted evidence and does not contain pairing material. -->

# Happy remote-access release audit

Audit baseline: merged main commit `a1986cb360d32a1d0364b0579313a9028f4726ac`.
The audit was run without creating a release tag or GitHub release.

## Audit item 1 — agent startup flow: PASS

- `bin/browser-local/claude-runtime.mjs:2472-2521` owns process creation and
  installs the process error/exit listeners before the stream handlers.
- `bin/browser-local/claude-runtime.mjs:2499` supplies the extended runtime
  path to the child process.
- `bin/browser-local/cli-scanner.mjs` and `bin/browser-local/cli-updater.mjs`
  remain CLI discovery/update helpers; the Happy bridge does not alter their
  startup ordering.
- `src-tauri/src/provider_runtime.rs:345-455` still resolves the embedded
  node binary, starts the provider runtime, and supplies its computed PATH.

Finding: no startup-order regression was found in the Happy diff. The bridge
is started by its own supervisor after the provider runtime is available
(`src-tauri/src/happy_bridge.rs:108-149`).

## Audit item 2 — embedded runtime discovery: PASS

- `src-tauri/src/embedded_runtime.rs:140-158` maps the supported layouts to
  `darwin|linux|win32` plus `x64|arm64`.
- `src-tauri/src/embedded_runtime.rs:163-195` checks the platform-specific
  resource directory first and retains the flat-layout fallback.
- `src-tauri/src/happy_bridge.rs:479-503` searches both platform-specific and
  flat packaged locations, then the development fallback.
- `scripts/build-provider-runtime.ts:75-87` copies both
  `happy-bridge.mjs` and the complete `happy-bridge/` module directory into
  every generated provider-runtime destination.
- `src-tauri/src/embedded_runtime.rs:308-351` prepends discovered runtime
  directories using the platform separator and preserves the existing PATH.

Finding: the source-level three-layout audit passed. The local embedded
runtime execution below additionally exercised the macOS arm64 layout.

## Audit item 3 — leaks, races, and silent failures: PASS / FINDING

PASS evidence:

- `src-tauri/src/happy_bridge.rs:324-348` aborts the monitor and synchronously
  terminates the child process with the platform-appropriate hard kill.
- `src-tauri/src/happy_bridge.rs:108-200` starts the provider first, writes the
  bridge configuration through stdin, sends roots, and then starts output
  monitoring.
- `bin/browser-local/providers.mjs:220-249` separates in-flight and resolved
  arbitration state, so concurrent duplicate responses are success-shaped.
- `bin/browser-local/providers.mjs:1461-1485` broadcasts permission resolution
  with its origin and releases in-flight state on failure.
- `bin/browser-local/providers.mjs:2080-2097` applies the same behavior to diff
  proposals.
- `bin/happy-bridge/happy-layer.mjs:219-230` removes pending approvals when a
  resolution event arrives; `:432-437` remaps and deletes the temporary spawn
  bookkeeping key; `:503-509` applies roots updates before capability refresh.
- `gh issue view 2981 --json state,title,body,comments` reports the earlier
  hardening issue CLOSED; its three listed follow-ups are present in merged
  main (`json_extract`, bounded supervisor reading, and own-property checks).

FINDING: the live two-client arbitration walkthrough remains unverified. The
  real app was exercised, but the selected runtime did not emit a permission
  request, so no second-client answer or reverse-direction resolution could be
  observed without inventing evidence. This is a release validation gap, not
  a source-level defect found by this audit.

## Audit item 4 — embedded tool invocation: PASS

The following transcript was captured from the actual embedded macOS arm64
node binary at
`src-tauri/target/debug/embedded-runtime/darwin-arm64/node/bin/node`.
The scratch directory was removed after the run.

```text
$ <embedded-node> --version
v22.12.0
$ npm init -y && npm install --ignore-scripts --no-audit --no-fund ws@8.18.0
[npm] npm install ws@8.18.0: success
$ <embedded-node> bin/provider-runtime.mjs --host 127.0.0.1 --port <ephemeral> ...
{"ok":true,"mode":"desktop-native","host":"127.0.0.1","port":<ephemeral>,"credential":"[REDACTED]"}
$ <embedded-node> bin/happy-bridge.mjs  # JSON configuration supplied on stdin
happy-bridge: config ok, 0 sessions
happy-bridge: fetch failed
```

The bridge connected to the real provider runtime and logged the live session
count. Its subsequent hosted-relay authorization attempt failed; no local,
fake, or Docker relay was substituted, and no pairing material was recorded.

## CI and release decision

`git log -1 --oneline` on main: `a1986cb3 feat(remote): add Happy remote access settings (#2991)`.
`git status --porcelain`: empty.
`gh pr checks 2991`: Ubuntu, macOS, and Windows builds PASS; frontend, Rust,
lint, and production-bundle E2E checks PASS.

No P0 or P1 was found in this audit, so no repair issue or repair PR was
opened. The only outstanding validation gap is the physical-phone pairing and
decryption walkthrough, which requires a real phone and the release build.
No P2 or non-blocking defect was identified.

Verdict: **BLOCKED: complete the real-phone pairing/decryption walkthrough
and the two-client permission walkthrough before tagging.**

The tag that would be cut after that gate is `v3.70.2`. The exact command is
intentionally un-run:

```sh
git tag -a v3.70.2 -m "Seren Desktop v3.70.2" && git push origin v3.70.2
```

`git tag --points-at HEAD` is empty and `gh release list --limit 10` still
shows `Seren Desktop v3.70.1` as latest.

Network declaration: no api.serendb.com publisher slug/path was touched; provider-runtime RPC/events and Happy's hosted relay are the only changed/observed network surfaces.
