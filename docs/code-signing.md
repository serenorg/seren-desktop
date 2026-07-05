# Code Signing Setup for Seren Desktop

This document explains how to set up code signing for production releases of Seren Desktop.

## Overview

Code signing is required for:
- **macOS**: Gatekeeper blocks unsigned apps
- **Windows**: SmartScreen warns on unsigned apps
- **Auto-updater**: Verifies update authenticity

## GitHub Secrets Required

Add these secrets to the repository settings (Settings → Secrets → Actions):

### Update Signing (Required)

| Secret | Description |
|--------|-------------|
| `TAURI_SIGNING_PRIVATE_KEY` | Ed25519 private key (base64) for signing updates |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key |

### macOS Signing

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE` | Developer ID Application certificate (.p12, base64 encoded) |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 file |
| `APPLE_SIGNING_IDENTITY` | Full signing identity, e.g., "Developer ID Application: SerenAI (TEAMID)" |
| `APPLE_TEAM_ID` | Apple Developer Team ID (10 characters) |
| `APPLE_ID` | Apple ID email for notarization |
| `APPLE_PASSWORD` | App-specific password for notarization |
| `KEYCHAIN_PASSWORD` | Temporary password for CI keychain (any secure random string) |

### Windows Signing

| Secret | Description |
|--------|-------------|
| `ES_USERNAME` | SSL.com eSigner account username |
| `ES_PASSWORD` | SSL.com eSigner account password |
| `ES_TOTP_SECRET` | SSL.com eSigner TOTP seed used by the CKA login step |

### Release Variables

| Variable | Description |
|----------|-------------|
| `MAX_SIGNATURES` | Warning threshold for SSL.com cloud hash-signing operations in one Windows release job. Defaults to `850` in `release.yml`; raise only after reviewing `sign-targets.txt` and the Windows signing job summary. |

## Certificate Setup

### Step 1: Generate Update Signing Keys

```bash
# Generate Ed25519 keypair
openssl genpkey -algorithm ed25519 -out update-private.pem
openssl pkey -in update-private.pem -pubout -out update-public.pem

# Convert private key to base64 for secrets
base64 -i update-private.pem

# The public key goes in tauri.conf.json
cat update-public.pem
```

Update `src-tauri/tauri.conf.json` with the public key:
```json
{
  "plugins": {
    "updater": {
      "pubkey": "YOUR_PUBLIC_KEY_HERE"
    }
  }
}
```

### Step 2: macOS Developer Certificate

1. **Join Apple Developer Program** ($99/year)
   - https://developer.apple.com/programs/

2. **Create Developer ID Application Certificate**
   - Open Keychain Access on Mac
   - Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority
   - Enter email, leave CA email blank, select "Saved to disk"
   - Go to https://developer.apple.com/account/resources/certificates
   - Click "+" → Developer ID Application
   - Upload the CSR file, download certificate, double-click to install

3. **Export as .p12**
   ```bash
   # In Keychain Access:
   # - Find "Developer ID Application: Your Name"
   # - Right-click → Export → Save as .p12

   # Convert to base64
   base64 -i certificate.p12
   ```

4. **Get Team ID**
   - https://developer.apple.com/account → Membership → Team ID

5. **Create App-Specific Password**
   - https://appleid.apple.com → Sign In & Security → App-Specific Passwords
   - Generate password for "Seren Desktop Notarization"

### Step 3: Windows Code Signing Certificate

Production Windows signing uses SSL.com eSigner CKA (Cloud Key Adapter), not a
checked-in or CI-imported `.pfx`. The release workflow installs the CKA client,
logs in with the `ES_*` secrets, loads the EV code-signing certificate into
`Cert:\CurrentUser\My`, and exports `WINDOWS_SIGN_THUMBPRINT` for the signer
wrapper and Tauri `signCommand` overlay.

## Windows Signing Coverage (What Smart App Control Evaluates)

A signed outer setup `.exe` is not enough. Smart App Control / Defender
evaluates **every** executable and library that is actually loaded on the
user's machine, including binaries extracted from the installer at runtime.
The Windows release path therefore signs three distinct surfaces, each before
the artifact that embeds it is produced:

1. **Embedded runtime payload** (`#2235`) — `node.exe`, the Git-for-Windows
   portable tree, the bundled Python DLLs/`.pyd`, sidecars under
   `embedded-runtime/`, and `mcp-servers/**/*.node`. These are signed *before*
   `tauri build` so the signatures land inside both the NSIS installer and the
   `.nsis.zip` updater bundle. The signable set is discovered by
   `scripts/print-windows-signables.ts` and signed in place by
   `scripts/sign-windows-payload.ps1` (signtool + eSigner CKA, throttled
   batches under SSL.com's rate limit, `#2282`, with `MAX_SIGNATURES`
   budget telemetry from `#2818`/`#2821`).

2. **NSIS stock plugin DLLs** (`#2237`, `#2299`) — `System.dll`, `nsExec.dll`,
   `StartMenu.dll`, and `nsDialogs.dll` ship inside the `tauri-bundler` NSIS
   toolset cache (`%LOCALAPPDATA%\tauri\NSIS\Plugins`) and `makensis` compiles
   them *into* the setup `.exe`; at install they are extracted to
   `%TEMP%\nsXXXX.tmp` and loaded. The bundler's own `signCommand` pipeline
   signs build-local *copies* of these, but makensis never reads stock plugins
   from that copy (tauri#14147 — fixed upstream in tauri#15422, unreleased, and
   upstream's sign list misses `nsExec.dll`, which `installer-hooks.nsh` uses).
   `scripts/stage-signed-nsis-toolset.ps1` therefore seeds the toolset cache
   exactly as the bundler would (same pinned URL/SHA1, including the
   hash-pinned `nsis_tauri_utils.dll`, which stays unsigned in the cache so the
   bundler does not re-download it) and EV-signs the stock plugin DLLs in
   place before the build. `nsis_tauri_utils.dll` itself is signed by the
   bundler on the build-local copy, the one plugin dir makensis does take from
   the copy.

3. **Seren.exe, the uninstaller, and the setup `.exe`** (`#2294`) — signed by
   the bundler itself via a CI-only `signCommand` config overlay
   (`scripts/print-windows-sign-overlay.ts`) at the only correct points in its
   pipeline: the main exe after bundle-type patching, the uninstaller via the
   `!uninstfinalize` hook, and the setup `.exe` after makensis. Because Tauri
   builds the `.nsis.zip` updater bundle during the same pipeline, the bundle
   is re-packed from the signed `.exe` and its `.nsis.zip.sig` re-signed with
   the Tauri updater key (`#2236`).

### Budget telemetry (release CI, warning-only)

Each Windows release writes a **Windows signing budget** section to the GitHub
job summary. Recent audits found roughly 715-729 embedded-runtime signables,
plus the NSIS/tooling and Tauri wrapper signings. The default warning threshold
is `850`, leaving limited headroom for normal drift while making unexpected
growth visible without blocking a production release. Review the discovered,
skipped, and cloud-signatures-spent counts before changing `MAX_SIGNATURES`; a
threshold bump should be paired with an audit of the added files and why they
must be signed.

### Verification gates (release CI, hard-fail)

- Loose `.exe`/`.dll` under `bundle/` are all `Valid` (`#2235`).
- Every `.exe`/`.dll` extracted from `.nsis.zip` is `Valid` (`#2236`).
- The setup `.exe` is unpacked with 7-Zip and **every** embedded
  `.exe`/`.dll`/`.node` — including the `$PLUGINSDIR` helper DLLs — is `Valid`
  (`#2237`). This is the closest CI proxy for what Smart App Control sees.

### SEREN_TAURI_SKIP_PREP

`build/prepare-tauri-build.ts` honours `SEREN_TAURI_SKIP_PREP=1` by skipping
runtime preparation entirely. The release workflow sets it on every
`tauri build` that runs **after** the embedded runtime has been staged and
signed, so the build cannot re-download and clobber the signed binaries.

## Testing Locally

### macOS
```bash
# Check if certificate is installed
security find-identity -v -p codesigning

# Build with signing
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" pnpm tauri build
```

### Windows
```powershell
# List installed certificates
Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert

# Build with signing (certificate must be in store)
pnpm tauri build
```

## Release Process

1. Create and push a version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

2. The release workflow will:
   - Build for all platforms
   - Sign macOS and Windows binaries
   - Notarize macOS app with Apple
   - Create a GitHub release with all artifacts

3. The release is created as a draft initially. Review and publish when ready.

## Troubleshooting

### macOS: "The signature is invalid"
- Ensure the certificate is a "Developer ID Application" (not Mac Developer)
- Check that entitlements.plist exists in src-tauri/

### macOS: Notarization fails
- Verify APPLE_ID and APPLE_PASSWORD are correct
- Check that app-specific password is used (not account password)
- Ensure APPLE_TEAM_ID matches the certificate

### Windows: SmartScreen warning
- EV certificates get immediate reputation
- Standard certificates need to build reputation over time
- Consider using EV for production releases

### Update signature missing
- Check TAURI_SIGNING_PRIVATE_KEY is set correctly
- Verify the key is base64 encoded
- Ensure password matches the key
