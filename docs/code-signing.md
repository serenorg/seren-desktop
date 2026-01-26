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
| `WINDOWS_CERTIFICATE` | Code signing certificate (.pfx, base64 encoded) |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the .pfx file |

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

**Option A: DigiCert (Recommended)**
1. https://www.digicert.com/signing/code-signing-certificates
2. Choose Standard or EV Code Signing
3. Complete verification (1-3 days for EV)
4. Download .pfx file

**Option B: Other Providers**
- Sectigo: https://sectigo.com/code-signing-certificates
- GlobalSign: https://www.globalsign.com/code-signing

Convert to base64:
```bash
base64 -i certificate.pfx
```

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
