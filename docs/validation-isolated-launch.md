# Validation-Isolated Launch

Use this workflow when a PR needs real Seren Desktop walkthrough evidence while the installed production app is still running.

## Commands

Run the validation app and walkthrough:

```bash
pnpm validate:walkthrough app-ready
```

Run the validation app manually:

```bash
pnpm tauri:validation:dev
```

Both development commands automatically lease the first available port from
`1422` through `1431`. The lease also selects a distinct Tauri identifier, so
up to ten validation apps can run concurrently without sharing a Vite server,
app-data root, or single-instance service. Set `SEREN_VALIDATION_DEV_PORT` to a
specific free port when a diagnostic run needs a stable override.

Build a validation bundle:

```bash
pnpm tauri:validation:build
```

## Isolation Guarantees

The validation Tauri config uses base bundle identifier `com.serendb.desktop.validation`, product name `SerenDesktop (Validation)`, and deep-link scheme `seren-validation`. Development launches extend that identifier with the leased port and pass a matching Vite `beforeDevCommand` and Tauri `devUrl` through a runtime config overlay. Validation builds retain the base identifier because they do not start a dev server.

At runtime the validation build sets isolated roots for app config, Seren skill authoring, and Claude skills under the validation app-data directory. The app-wide OAuth callback server binds an isolated loopback port and frontend OAuth flows ask the running app for the active callback URL.

The validation control channel is compiled only with the `validation` Cargo feature and only starts for the base validation identifier or one of its numeric slot identifiers. It writes a tokenized loopback discovery file and accepts only typed commands: navigate, click, fill, press, waitFor, dumpText, and screenshot.

## Evidence

Walkthrough artifacts are written to `artifacts/validation-walkthrough/`.

Required files for PR evidence:

- `manifest.json`: scenario, validation app identifier, control URL, process ID, and artifact directory.
- `ui-text.json`: extracted visible UI text from the real Tauri WebView.
- `screenshot.json`: DOM-raster evidence. If WebKit rejects DOM rasterization, the artifact records `rasterSuccess: false` and includes a text-canvas PNG fallback instead of silently producing a blank image.
- `native-screenshot.json`: native window preview PNG captured through the app-window recording backend, including matched window PID, bounds, image size, and data URL.
- `result.json`: scenario success/failure.

For macOS native pixels, grant Screen Recording permission to the validation app or terminal host before relying on `native-screenshot.json`. A valid native artifact must have `nativeAvailable: true`, `rasterSuccess: true`, and a `data:image/png;base64,...` URL.

## CI

The `validation-walkthrough` workflow is label-gated. Add the `needs-validation` PR label to run `pnpm validate:walkthrough app-ready` on macOS and upload the artifact directory.
