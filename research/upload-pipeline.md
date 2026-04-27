# App Store Connect Binary Upload Pipeline — 2026 Reference

A practical reference for the binary upload "side channel" that sits next to the App Store Connect REST API. The REST API itself manages metadata, builds, versions, submissions, etc., but historically did **not** accept the actual `.ipa` / `.pkg` binary. As of WWDC25 there is now a REST-native build upload path, but the older command-line tools remain the dominant approach for automation in 2026.

This document is current as of April 2026. Where something is uncertain or where I had to interpolate, it is marked with **`[VERIFY]`**.

---

## 0. TL;DR — what changed in 2025–2026

| Change | Status | Notes |
|---|---|---|
| `method = app-store` in ExportOptions.plist | **Deprecated** (still accepted) | Use `app-store-connect`. Warning: `Command line name 'app-store' is deprecated. Use 'app-store-connect' instead.` |
| `method = ad-hoc` | Deprecated | Use `release-testing` |
| `method = development` | Deprecated | Use `debugging` |
| `uploadBitcode` / `compileBitcode` | **Bitcode is dead** | Apple removed bitcode in Xcode 14. These keys are still parsed but have no effect for App Store builds. Set `false` or omit. |
| `xcrun altool` | Still supported, modern syntax | Works for App Store uploads. The `notarytool` migration (TN3147) deprecated altool **for notarization only**, not for App Store uploads. |
| `altool --upload-app -f` | Still works; legacy spelling | Modern equivalent is `--upload-package <file>` |
| `xcrun altool --notarize-app` | **Removed** | Use `xcrun notarytool` (Developer ID notarization, not App Store) |
| Username/password auth (`-u`/`-p`) | Deprecated, app-specific passwords still work | Use `--apiKey` + `--apiIssuer` |
| `iTMSTransporter -f` | **Required to switch in 2026** | Apple announced: "Starting in 2026, you'll be required to use the `-assetFile` command instead of `-f` with your `.ipa` or `.pkg` files." |
| Aspera / Signiant transfer | Requires updated Transporter in 2026 | Default HTTPS transport unaffected |
| Xcode minimum to upload | **Xcode 14+** (starting 2026) | Older Xcode versions can no longer upload |
| **REST API build upload** | **NEW** in WWDC25, GA | `POST /v1/buildUploads` → `POST /v1/buildUploadFiles` → chunked `PUT` → `PATCH uploaded:true`. First time the REST API can accept binaries directly. |

---

## 1. xcodebuild — building and archiving from CLI

### 1.1 Archive

```bash
xcodebuild \
  -workspace MyApp.xcworkspace \
  -scheme MyApp \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath build/MyApp.xcarchive \
  archive \
  | xcbeautify   # optional; raw output is enormous
```

Notes:
- For projects without a workspace, use `-project MyApp.xcodeproj`.
- `-destination "generic/platform=iOS"` is important for archives — without it, xcodebuild may pick a simulator slice.
- For macOS: `-destination "generic/platform=macOS"`. For tvOS: `generic/platform=tvOS`. For visionOS: `generic/platform=visionOS`. For watchOS: `generic/platform=watchOS`.
- Archive output is a directory bundle (`MyApp.xcarchive`) containing `Products/Applications/MyApp.app`, `dSYMs/MyApp.app.dSYM`, and `Info.plist`.
- Optional flags worth knowing: `CODE_SIGNING_ALLOWED=NO` (you almost never want this for archive), `OTHER_CODE_SIGN_FLAGS`, `DEVELOPMENT_TEAM=ABCD123456`.

### 1.2 Export the IPA

```bash
xcodebuild \
  -exportArchive \
  -archivePath build/MyApp.xcarchive \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export \
  -allowProvisioningUpdates
```

Outputs in `build/export/`:
- `MyApp.ipa` — the app binary you upload
- `DistributionSummary.plist` — what got signed and how
- `ExportOptions.plist` — a copy of the plist used
- `Packaging.log` — useful when debugging

`-allowProvisioningUpdates` lets xcodebuild fetch / regenerate profiles via App Store Connect when signed in. Required for unattended CI when using automatic signing. Pair with `-authenticationKeyPath`, `-authenticationKeyID`, `-authenticationKeyIssuerID` to feed it an API key directly instead of relying on Xcode's stored credentials.

### 1.3 ExportOptions.plist for App Store

Minimum modern (2026) plist for app-store distribution with manual signing:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>

  <key>destination</key>
  <string>export</string>           <!-- "export" = local IPA; "upload" = let Xcode upload it -->

  <key>teamID</key>
  <string>ABCD123456</string>

  <key>signingStyle</key>
  <string>manual</string>            <!-- or "automatic" -->

  <key>signingCertificate</key>
  <string>Apple Distribution</string>

  <key>provisioningProfiles</key>
  <dict>
    <key>com.example.app</key>
    <string>App Store Profile Name (or UUID)</string>
    <key>com.example.app.WidgetExtension</key>
    <string>Widget App Store Profile</string>
  </dict>

  <key>uploadSymbols</key>
  <true/>

  <key>stripSwiftSymbols</key>
  <true/>

  <key>manageAppVersionAndBuildNumber</key>
  <false/>                           <!-- true lets Xcode auto-bump build #; false respects what xcodebuild built -->
</dict>
</plist>
```

Full key reference (current as of Xcode 16 / 2026):

| Key | Type | Purpose |
|---|---|---|
| `method` | String | `app-store-connect` (was `app-store`), `release-testing` (was `ad-hoc`), `enterprise`, `debugging` (was `development`), `developer-id`, `mac-application`, `validation`, `package` |
| `destination` | String | `export` (write IPA to disk) or `upload` (have Xcode upload via the new REST flow) |
| `teamID` | String | 10-char Team ID |
| `signingStyle` | String | `manual` or `automatic` (default `automatic`) |
| `signingCertificate` | String | E.g. `Apple Distribution`, `iPhone Distribution`, `Developer ID Application`, or a SHA-1 / certificate name |
| `installerSigningCertificate` | String | macOS only; e.g. `3rd Party Mac Developer Installer` or `Developer ID Installer` |
| `provisioningProfiles` | Dict | Map bundle identifier → profile name or UUID. Required for manual signing. |
| `uploadSymbols` | Bool | Default `true`. Include dSYMs in the IPA so Apple can symbolicate. |
| `uploadBitcode` | Bool | **Dead.** Bitcode was removed in Xcode 14. |
| `compileBitcode` | Bool | **Dead.** |
| `stripSwiftSymbols` | Bool | Default `true`. |
| `thinning` | String | `<none>`, `<thin-for-all-variants>`, or specific device |
| `iCloudContainerEnvironment` | String | `Development` or `Production` |
| `manageAppVersionAndBuildNumber` | Bool | Xcode 13+. If `true`, Xcode will set the build number to the next available value before upload. **`false` for reproducible builds.** |
| `generateAppStoreInformation` | Bool | Default `false`. Generates a metadata report. |
| `distributionBundleIdentifier` | String | For exporting only a sub-bundle |
| `embedOnDemandResourcesAssetPacksInBundle` | Bool | ODR |
| `onDemandResourcesAssetPacksBaseURL` | String | ODR hosting URL |

`xcodebuild -help` prints the canonical list — diff against this if a project breaks after an Xcode update.

### 1.4 Output paths to know

After successful archive + export:

- IPA: `build/export/MyApp.ipa`
- dSYM: `build/MyApp.xcarchive/dSYMs/MyApp.app.dSYM` (also `*.framework.dSYM` for embedded frameworks)
- App: `build/MyApp.xcarchive/Products/Applications/MyApp.app`
- Archive metadata: `build/MyApp.xcarchive/Info.plist`

---

## 2. Uploading the .ipa — the four current options

### 2.1 `xcrun altool --upload-package` (preferred CLI)

This is the workhorse for CI in 2026. Modern syntax:

```bash
xcrun altool \
  --upload-package build/export/MyApp.ipa \
  --type ios \
  --apple-id 6471234567 \
  --bundle-id com.example.app \
  --bundle-version 42 \
  --bundle-short-version-string 1.4.0 \
  --apiKey ABCDEF1234 \
  --apiIssuer 11111111-2222-3333-4444-555555555555 \
  --output-format json \
  --show-progress
```

Legacy spelling, still functional and widely seen:

```bash
xcrun altool --upload-app -f build/export/MyApp.ipa -t ios \
  --apiKey ABCDEF1234 --apiIssuer 11111111-2222-3333-4444-555555555555
```

`--type` / `-t` values: `macos`, `ios`, `appletvos`, `visionos`. (The man page calls it `--platform`; both `-t` and `--type` map to the same thing in current builds.) **`[VERIFY]`** — the man page on `keith.github.io/xcode-man-pages/altool.1.html` shows `-t, --platform`; older docs say `--type`. Both work in Xcode 15/16; standardize on `-t` for compatibility.

Notes on the metadata flags:
- `--apple-id`, `--bundle-id`, `--bundle-version`, `--bundle-short-version-string` are technically optional for `--upload-package` because altool reads them from the IPA's embedded `Info.plist`. They become required for some other subcommands (`--build-status`, `--validate-app` in some configurations) and **always make errors more readable** — pass them.
- `--apple-id` is the numeric App ID (the App Store ID, also called the SKU's `apple-id`), not the developer's email. Get it from `GET /v1/apps`.
- `--show-progress` writes progress lines to stderr.
- `--wait` (after `--upload-package`) blocks until App Store Connect leaves the PROCESSING state and returns the final status. Convenient for one-shot scripts; **avoid** in long-lived CI because processing can take 5–60 minutes.

### 2.2 `xcrun altool --validate-app` (pre-flight)

```bash
xcrun altool \
  --validate-app \
  -f build/export/MyApp.ipa \
  -t ios \
  --apiKey ABCDEF1234 \
  --apiIssuer 11111111-2222-3333-4444-555555555555 \
  --output-format json
```

Cheap. Catches signing errors, mismatched bundle IDs, missing entitlements, ITMS-90xxx failures *before* uploading. Worth always running first in automation.

### 2.3 `xcrun iTMSTransporter` (Transporter command line)

Lower-level than altool. altool is internally a wrapper around iTMSTransporter for some operations.

Locations on a typical macOS Xcode install:
- `xcrun iTMSTransporter` (preferred — uses the bundled copy)
- `/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter` (when the GUI Transporter app is installed)
- Standalone download for Linux/Windows: Apple distributes a Java-based Transporter with the same CLI

Modern asset-file upload (the form **required from 2026**):

```bash
xcrun iTMSTransporter \
  -m upload \
  -assetFile build/export/MyApp.ipa \
  -apiKey ABCDEF1234 \
  -apiIssuer 11111111-2222-3333-4444-555555555555
```

The legacy `-f path/to/MyApp.itmsp` form (which expects an `.itmsp` directory containing `metadata.xml` + the binary) is being phased out for app/IPA uploads in 2026. For pure `.ipa` / `.pkg` / `.dmg` / `.zip` uploads, **always use `-assetFile`**. The `.itmsp` flow remains for in-app-purchase metadata, screenshots, and similar non-binary deliverables.

When to use iTMSTransporter directly instead of altool:
- You need fine-grained network control (proxy, transfer protocol).
- You want to upload from Linux or Windows. **altool requires macOS + Xcode.** iTMSTransporter is cross-platform Java.
- Apple's announcements deprecate altool further (not the case in 2026, but worth knowing).

### 2.4 Transporter.app (GUI)

The Transporter Mac App Store app — drag-and-drop UI for uploading. Out of scope for an MCP automation server; mention it only because users sometimes confuse it with `iTMSTransporter` (the CLI ships separately and inside Xcode).

### 2.5 NEW — App Store Connect REST API build upload

Announced WWDC25 (session 324, "Automate your development process with the App Store Connect API"). This is the first time the REST API itself accepts the binary. Three steps, all JWT-authenticated against `https://api.appstoreconnect.apple.com`:

#### Step 1: Create a `BuildUpload`

```http
POST /v1/buildUploads
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "data": {
    "type": "buildUploads",
    "attributes": {
      "bundleVersion": "42",
      "platform": "IOS"
    }
  }
}
```

Platform values: `IOS`, `MAC_OS`, `TV_OS`, `VISION_OS`. **`[VERIFY]`** — the WWDC transcript uses generic `<target_platform>`; these are the standard values used elsewhere in the API (`Platform` enum) and are the natural fit. Confirm against the live API before shipping.

Response `201 Created`:
```json
{
  "data": {
    "id": "<buildUploadId>",
    "type": "buildUploads",
    "attributes": { "bundleVersion": "42", "platform": "IOS", "state": "AWAITING_UPLOAD" }
  }
}
```

#### Step 2: Create a `BuildUploadFile`

```http
POST /v1/buildUploadFiles
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "data": {
    "type": "buildUploadFiles",
    "attributes": {
      "fileName": "MyApp.ipa",
      "fileSize": 87654321,
      "assetType": "BUILD"
    },
    "relationships": {
      "buildUpload": {
        "data": { "id": "<buildUploadId>", "type": "buildUploads" }
      }
    }
  }
}
```

`assetType`: `"BUILD"` for the main IPA/PKG. **`[VERIFY]`** — Apple's session described "asset type" as a required string; `BUILD` is the documented value for the main binary. Other valid values likely exist for accompanying assets (e.g. dSYMs) but were not enumerated in the talk.

Response `201 Created` includes **`uploadOperations`** — Apple-provided pre-signed URLs you must hit:

```json
{
  "data": {
    "id": "<buildUploadFileId>",
    "type": "buildUploadFiles",
    "attributes": {
      "fileName": "MyApp.ipa",
      "fileSize": 87654321,
      "assetType": "BUILD",
      "uploadOperations": [
        {
          "method": "PUT",
          "url": "https://<apple-upload-host>/...",
          "length": 10485760,
          "offset": 0,
          "requestHeaders": [
            { "name": "Content-Type", "value": "application/octet-stream" },
            { "name": "x-apple-..." , "value": "..." }
          ]
        },
        {
          "method": "PUT",
          "url": "https://<apple-upload-host>/...",
          "length": 10485760,
          "offset": 10485760,
          "requestHeaders": [ ... ]
        }
      ]
    }
  }
}
```

Hit each operation in order:
- HTTP method: as specified (`PUT`).
- Body: bytes `[offset, offset+length)` of your IPA.
- Headers: exactly the `requestHeaders` returned. Do not add `Authorization` — these URLs carry their own signed credentials.
- Treat any non-2xx as a fatal upload failure for that chunk; retry the chunk with a fresh exchange.

#### Step 3: Mark as uploaded

```http
PATCH /v1/buildUploads/<buildUploadId>
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "data": {
    "type": "buildUploads",
    "id": "<buildUploadId>",
    "attributes": { "uploaded": true }
  }
}
```

Response `200 OK`:
```json
{
  "data": {
    "id": "<buildUploadId>",
    "attributes": { "state": "COMPLETE", ... }
  }
}
```

This kicks off processing on Apple's side. The build then appears in `GET /v1/builds` with `processingState=PROCESSING`, the same state machine altool/Transporter feed into.

#### Webhooks
Apple also documented (WWDC25) a webhook mechanism that notifies you when a build finishes processing. Notifications are signed with HMAC-SHA256 in the `X-Apple-SIGNATURE` header — verify the signature against your shared secret. **`[VERIFY]`** the exact endpoint registration shape against current docs before relying on it.

#### Why this matters for your MCP
- **REST-only** = works from any platform (Linux MCP host, no macOS needed for the upload step itself — though you still need macOS to *build* the IPA).
- One auth credential (the App Store Connect API key) for everything: metadata, builds, upload.
- Cleaner error model — JSON errors instead of altool's wrapped Java/iTMS messages.
- **But:** as of April 2026 this is brand new; battle-tested production tooling (fastlane, codemagic, Xcode Cloud) still defaults to altool / iTMSTransporter. Apple's own `xcodebuild -exportArchive -exportOptionsPlist <plist with destination=upload>` is migrating to it under the hood. Build it as the *primary* path and keep altool as a tested fallback for the first year.

---

## 3. Authentication — App Store Connect API Key

### 3.1 The `.p8` private key

Generate from App Store Connect → Users and Access → Integrations → App Store Connect API. Each key has:
- **Key ID** — a 10-char string like `ABCDEF1234` (used as `--apiKey` and JWT `kid`).
- **Issuer ID** — a UUID like `11111111-2222-3333-4444-555555555555` (one per team; `--apiIssuer` / JWT `iss`).
- **`.p8` private key file** — downloaded once, can never be re-downloaded. Store securely.

### 3.2 Where altool / Transporter look for the `.p8`

altool searches these directories, in order, for `AuthKey_<keyId>.p8`:
1. `./private_keys`
2. `~/private_keys`
3. `~/.private_keys`
4. `~/.appstoreconnect/private_keys`

So the canonical install location is `~/.appstoreconnect/private_keys/AuthKey_ABCDEF1234.p8`.

Override with `--apiKeyPath /custom/path/AuthKey_ABCDEF1234.p8` (Xcode 15+).

### 3.3 Team key vs Individual key

Two flavors:
- **Team API key** — created by an Account Holder/Admin under Users and Access. Works everywhere.
- **Individual API key** — tied to a single user. Use `--api-key-subject user` with altool, or include `sub: "user"` in the JWT. Some upload flows have historically had bugs with individual keys (fastlane has long-standing issues with individual keys at the upload step). **Recommendation: use a Team API key for upload automation.**

### 3.4 JWT for direct REST API calls

```
Header:
  { "alg": "ES256", "kid": "<keyId>", "typ": "JWT" }
Payload:
  {
    "iss": "<issuerId>",
    "iat": <unix-now>,
    "exp": <unix-now + 1200>,         # max 20 minutes
    "aud": "appstoreconnect-v1",
    "scope": [ "GET /v1/apps?filter[...]=..." ]   # optional, narrows what the token can do
  }
```

Sign with ES256 using the contents of the `.p8`. **Tokens expire after 20 minutes (1200 s)** — do not try to issue longer-lived tokens; Apple rejects them with 401. Cache and rotate.

Node libs that do this cleanly: `jsonwebtoken` (ES256 + the raw `.p8`), or `appstore-connect-jwt-generator-core`. For the MCP, just use `jsonwebtoken` directly:

```js
import fs from "node:fs";
import jwt from "jsonwebtoken";
const privateKey = fs.readFileSync(process.env.ASC_API_KEY_PATH, "utf8");
const token = jwt.sign({}, privateKey, {
  algorithm: "ES256",
  issuer: process.env.ASC_ISSUER_ID,
  expiresIn: "19m",                         // stay safely under 20m
  audience: "appstoreconnect-v1",
  header: { kid: process.env.ASC_KEY_ID, typ: "JWT" },
});
```

### 3.5 App-specific passwords (legacy fallback)

`-u developer@example.com -p @keychain:AC_PASSWORD` or `-p abcd-efgh-ijkl-mnop`. App-specific passwords come from `appleid.apple.com → Sign-In and Security → App-Specific Passwords`. Still functional but **avoid** for new automation: doesn't work with 2FA-protected accounts cleanly, doesn't carry team scoping, can't be revoked granularly.

---

## 4. dSYM / Symbol upload

Two cases:

### 4.1 dSYMs uploaded with the build (default)
If `uploadSymbols=true` in ExportOptions.plist (the default), Xcode bundles the dSYMs into the IPA before upload. App Store Connect extracts them, uses them for crash symbolication in the Crashes section, and exposes them for download via the Organizer or REST API.

### 4.2 dSYMs uploaded separately
You'd do this when:
- Bitcode was used (irrelevant in 2026 — bitcode is gone).
- You stripped symbols at build time and want to upload them later (e.g. for Firebase Crashlytics, Sentry, Bugsnag — those services accept dSYMs through *their own* APIs, not Apple's).
- You're using Apple's `.symbols` format for crash submission. The newer flow exports a `.symbols` directory rather than `.dSYM`.

There is **no documented public REST endpoint to attach a dSYM zip to an existing build** as of April 2026. **`[VERIFY]`** — the Build Upload API's `assetType` field hints at non-`BUILD` asset types but Apple has not enumerated them publicly. For now, rely on bundling dSYMs into the IPA and downloading them later via `GET /v1/builds/<id>/buildBundles` → `dSYMUrl`.

To download dSYMs from App Store Connect:
- Xcode Organizer (Window → Organizer → select archive → Download Debug Symbols)
- fastlane `download_dsyms` action
- Hand-rolled: `GET /v1/builds/<id>/buildBundles` then follow `dSYMUrl` in each bundle.

---

## 5. Polling for processing

After altool/Transporter/REST upload returns success, the build is in `PROCESSING` for typically 5–30 minutes (sometimes hours). Poll:

```http
GET /v1/builds?filter[app]=<appId>
              &filter[preReleaseVersion.version]=1.4.0
              &filter[version]=42
              &fields[builds]=version,processingState,uploadedDate,expirationDate
              &include=preReleaseVersion
              &sort=-uploadedDate
              &limit=10
Authorization: Bearer <JWT>
```

`processingState` values returned by the REST API:
- `PROCESSING` — still working
- `VALID` — done, available for TestFlight / submission
- `INVALID` — processing failed (signing/entitlements/etc.)
- `FAILED` — explicit failure
- `EXPIRED` — past 90-day TestFlight window (only relevant later)

Note: the App Store Connect *web UI* uses friendlier strings like "Ready to Submit", "In Beta Review", "Invalid Binary" — these come from a different state field (build status / TestFlight review state), not `processingState`. For the upload pipeline you only care about `processingState`.

Polling cadence: 30 s for the first 5 minutes, then back off to 60–120 s. Cap at 90 minutes; error out if still `PROCESSING` past that.

---

## 6. macOS uploads (Mac App Store)

`.app` → `.pkg` → upload. Two distinct signing certificates required:
- **Apple Distribution** (or `3rd Party Mac Developer Application`) for the `.app`.
- **3rd Party Mac Developer Installer** for the `.pkg`.

Build flow:

```bash
# 1. Archive (same as iOS)
xcodebuild -workspace MyMacApp.xcworkspace -scheme MyMacApp \
  -configuration Release -destination "generic/platform=macOS" \
  -archivePath build/MyMacApp.xcarchive archive

# 2. Export. method=app-store-connect, destination=export
xcodebuild -exportArchive -archivePath build/MyMacApp.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath build/export

# 3. xcodebuild produces a .pkg directly (signed with installer cert).
#    For non-Xcode toolchains, fall back to:
#    productbuild --component MyMacApp.app /Applications \
#        --sign "3rd Party Mac Developer Installer: Acme (ABCD1234)" \
#        MyMacApp.pkg

# 4. Upload
xcrun altool --upload-package build/export/MyMacApp.pkg \
  --type macos \
  --apiKey ABCDEF1234 --apiIssuer <issuer-uuid> \
  --output-format json
```

### notarytool vs altool (clarification)

- **App Store distribution (Mac App Store):** use `altool` or the new REST API. **No notarization needed** — Apple's review step covers it.
- **Direct distribution (Developer ID, outside the Store):** use `xcrun notarytool submit ... --apple-id ... --team-id ... --password ... --wait`. `altool --notarize-app` was removed; this is what TN3147 deprecated. **It does not affect App Store uploads.**

So for an MCP focused on App Store releases, `notarytool` is irrelevant.

---

## 7. Common errors and how to surface them

### 7.1 ITMS-90xxx error code map (high-traffic ones)

| Code | Meaning | Fix |
|---|---|---|
| ITMS-90000 | Generic transport error (often network) | Retry; check connectivity |
| ITMS-90022 / 90023 | Missing required icon (1024x1024, etc.) | Add icon assets |
| ITMS-90032 | Invalid `Info.plist` value | Read message — usually missing/empty key |
| ITMS-90034 | Missing or invalid signature | Re-sign, check provisioning profile |
| ITMS-90049 / 90060 | Unsupported architectures (arm7, i386) | Strip 32-bit slices |
| ITMS-90061 | Missing required architecture | Add the missing slice |
| ITMS-90087 | Unsupported architectures present in framework | Strip simulator slices from xcframework |
| ITMS-90161 / 90164 | Provisioning profile / entitlements mismatch | Regenerate profile with the right caps |
| ITMS-90171 | Invalid bundle structure | Check embedded bundles and frameworks |
| ITMS-90174 | Missing provisioning profile | Re-export with a profile in `provisioningProfiles` |
| ITMS-90189 | Redundant binary upload (same build/version) | Bump `CFBundleVersion` |
| ITMS-90283 | Invalid volume URL | Usually transient; retry |
| ITMS-90334 | Missing bundle display name | Set `CFBundleDisplayName` |
| ITMS-90338 | Non-public API usage | Audit symbols |
| ITMS-90683 | Missing `Privacy - X Usage Description` | Add the Info.plist string |
| ITMS-90742 | Missing `NSPrivacyAccessedAPITypes` (privacy manifest) | Add `PrivacyInfo.xcprivacy` |

**`[VERIFY]`** — codes evolve. Do not encode the table in the MCP as a closed enum; surface whatever Apple returns and pattern-match `ITMS-\d+` for highlighting.

### 7.2 altool JSON output shape

With `--output-format json`, altool writes a single JSON document to stdout on completion:

```json
{
  "tool-version": "8.0.0.1",
  "tool-path": "/Applications/Xcode.app/Contents/SharedFrameworks/ContentDeliveryServices.framework/...",
  "os-version": "14.4",
  "success-message": "No errors uploading 'MyApp.ipa'."
}
```

On failure:

```json
{
  "tool-version": "8.0.0.1",
  "os-version": "14.4",
  "product-errors": [
    {
      "message": "Asset validation failed (90034) Missing or invalid signature. The bundle ...",
      "userInfo": {
        "NSLocalizedDescription": "Asset validation failed",
        "NSLocalizedFailureReason": "Missing or invalid signature...",
        "iris-code": "ENTITY_ERROR.VALIDATION.NOT_VALID"
      },
      "code": 90034
    }
  ]
}
```

Parsing strategy:
- Read `--output-format json` from **stdout** (not stderr — progress goes to stderr).
- If the document has a top-level `product-errors` array, treat it as failure even if the exit code is 0 (yes, this happens with some altool versions).
- Otherwise check exit code: 0 = success, non-zero = failure.
- Extract `product-errors[*].code` (numeric, matches the ITMS code) and `.message` for surfacing.

Known exit code gotchas:
- `0` with `product-errors` populated — bug, treat as failure.
- `1` — generic failure, see stderr/JSON.
- `-1` (= 255 unsigned) — altool died without writing JSON. Common in Xcode 15.x. Retry once.
- `239` — historically tied to notarization failures; avoid by not using altool for notarization.

### 7.3 stderr is not JSON
altool prints progress, warnings, and JWT-acquisition messages to stderr. Capture stderr separately for diagnostics; parse stdout for the JSON document. Treat the absence of valid JSON on stdout as an upload-tool malfunction (vs an upload rejection).

---

## 8. Fastlane (informational)

We are **not** using fastlane. But:
- `fastlane pilot upload` wraps `iTMSTransporter` (TestFlight upload + tester management).
- `fastlane deliver` (alias `upload_to_app_store`) wraps `iTMSTransporter` for builds + the REST API for metadata/screenshots.
- `fastlane gym` wraps `xcodebuild archive` + `xcodebuild -exportArchive`.
- `fastlane match` is unrelated — it manages signing certs/profiles via a Git repo.

Useful as a reality check: when our pipeline misbehaves, look at what fastlane does in that exact step. The tools they invoke (`xcodebuild`, `iTMSTransporter`, `altool`) are what we wrap directly.

---

## 9. Platform requirement (macOS-only)

- `xcodebuild` — **macOS only**, requires Xcode + command-line tools.
- `xcrun altool` — **macOS only**, ships inside Xcode.
- `xcrun iTMSTransporter` — bundled in Xcode (macOS), but Apple also ships a standalone Java-based Transporter for Linux and Windows. Same CLI surface, different distribution. For an MCP, treat the bundled `xcrun iTMSTransporter` as macOS-only and require explicit configuration to point at a non-bundled install.
- **App Store Connect REST API (incl. new build upload)** — pure HTTPS, runs from anywhere.

The MCP must detect the host OS at startup. On non-macOS:
- Build operations (`xcodebuild`) — fail fast with a structured error: `{ code: "PLATFORM_UNSUPPORTED", platform: process.platform, requires: "darwin" }`.
- altool/iTMSTransporter wrappers — same.
- REST-only operations — work fine.
- Build upload via REST — works, **but** the IPA must already exist; you can't *build* an iOS app on Linux. Document clearly that the build step is macOS-bound.

A check like `process.platform === "darwin" && fs.existsSync("/usr/bin/xcrun")` is enough at boot. For runtime, also probe `xcrun --find altool` to confirm altool is reachable (some macOS hosts have only command-line tools, not full Xcode).

---

## 10. Tool wrapper recipes (Node.js)

Every wrapper should:
1. Validate platform + tool availability.
2. Build argv (no shell — pass as array to `child_process.spawn`).
3. Capture stdout + stderr separately.
4. Parse JSON from stdout where applicable.
5. Map exit code + JSON to a structured result.

### 10.1 `xcodebuild archive`

```
argv: [
  "xcodebuild",
  "-workspace", workspacePath,
  "-scheme", scheme,
  "-configuration", configuration,    // "Release"
  "-destination", `generic/platform=${platformName}`,  // iOS, macOS, tvOS, visionOS
  "-archivePath", archivePath,
  ...(allowProvisioningUpdates ? ["-allowProvisioningUpdates"] : []),
  ...(authenticationKeyPath ? [
    "-authenticationKeyPath", authenticationKeyPath,
    "-authenticationKeyID", keyId,
    "-authenticationKeyIssuerID", issuerId,
  ] : []),
  "archive",
]
env: { ...process.env, NSUnbufferedIO: "YES" }
expected stdout: human-readable build log (very large; consider piping through xcbeautify)
success: exit code 0 AND archivePath exists AND `${archivePath}/Info.plist` exists
failure: exit code != 0; scrape stderr for `error:` lines; surface as { tool: "xcodebuild", phase: "archive", exitCode, errors: [...] }
```

### 10.2 `xcodebuild -exportArchive`

```
argv: [
  "xcodebuild",
  "-exportArchive",
  "-archivePath", archivePath,
  "-exportOptionsPlist", exportOptionsPlistPath,
  "-exportPath", exportDir,
  ...(allowProvisioningUpdates ? ["-allowProvisioningUpdates"] : []),
]
env: same
success: exit 0 AND a single `*.ipa` (or `*.pkg` for macOS) exists in exportDir
failure: exit != 0; parse `${exportDir}/Packaging.log` if present for the most useful error text
```

### 10.3 `xcrun altool --validate-app`

```
argv: [
  "xcrun", "altool",
  "--validate-app",
  "-f", ipaPath,
  "-t", platformShort,           // "ios" | "macos" | "appletvos" | "visionos"
  "--apiKey", keyId,
  "--apiIssuer", issuerId,
  "--output-format", "json",
]
env: { ...process.env }
expected stdout: JSON document. Success has `success-message`; failure has `product-errors`.
success: exit 0 AND parsed JSON has no `product-errors`
failure: exit != 0 OR `product-errors` non-empty.
        Map each product-error to { code, message, userInfo }.
        ITMS code is integer in `code`; render as `ITMS-${code}`.
```

### 10.4 `xcrun altool --upload-package`

```
argv: [
  "xcrun", "altool",
  "--upload-package", ipaPath,
  "-t", platformShort,
  // optional but recommended for cleaner errors:
  "--apple-id", appleId,
  "--bundle-id", bundleId,
  "--bundle-version", bundleVersion,
  "--bundle-short-version-string", bundleShortVersion,
  "--apiKey", keyId,
  "--apiIssuer", issuerId,
  "--output-format", "json",
  // do NOT pass --wait in CI; poll via REST instead
]
env: { ...process.env, API_PRIVATE_KEYS_DIR: process.env.API_PRIVATE_KEYS_DIR ?? "" }
note: altool searches ~/.appstoreconnect/private_keys for AuthKey_<keyId>.p8.
      If --apiKeyPath is supported by the installed Xcode (15+), prefer passing it explicitly.
expected stdout: JSON. Success has `success-message`. Failure has `product-errors`.
success: exit 0 AND no `product-errors`
failure: exit != 0 OR `product-errors`. Retry once on exit code -1 (255) with no JSON.
post-success: queue a poll on GET /v1/builds for processingState transitions.
```

### 10.5 `xcrun iTMSTransporter -m upload`

```
argv: [
  "xcrun", "iTMSTransporter",
  "-m", "upload",
  "-assetFile", ipaPath,         // 2026 form; do not use -f
  "-apiKey", keyId,
  "-apiIssuer", issuerId,
  // optional: "-v", "informational",
]
env: same
expected stdout: line-based human text, NOT JSON. Look for "Package Summary" and "transferred successfully".
success: exit 0 AND stdout contains "Package Summary" AND no line matching /\bERROR\b/
failure: exit != 0 OR ERROR lines present. Errors usually formatted "ERROR ITMS-NNNNN: ..." — pattern-extract.
note: stderr carries Java stack traces on infrastructure failures; preserve them in error.
```

### 10.6 REST: build upload (the new path)

Recommended primary upload path; altool kept as fallback.

```
1. POST /v1/buildUploads
     body: { data: { type: "buildUploads", attributes: { bundleVersion, platform } } }
     success: 201, capture data.id as buildUploadId
     failure: 4xx with errors[]; surface as { errors: [{ status, code, title, detail }] }

2. POST /v1/buildUploadFiles
     body: { data: {
       type: "buildUploadFiles",
       attributes: { fileName, fileSize, assetType: "BUILD" },
       relationships: { buildUpload: { data: { id: buildUploadId, type: "buildUploads" } } },
     } }
     success: 201; capture data.attributes.uploadOperations[]
     failure: 4xx as above

3. For each uploadOperation in order:
     fetch(operation.url, {
       method: operation.method,                 // "PUT"
       headers: Object.fromEntries(operation.requestHeaders.map(h => [h.name, h.value])),
       body: ipaBuffer.subarray(operation.offset, operation.offset + operation.length),
       duplex: "half",                           // for streaming in undici/Node fetch
     })
     success: response.ok (2xx)
     failure: !ok → retry up to 3x with exponential backoff; after 3, abort whole upload.
     IMPORTANT: do NOT add Authorization header here — the URLs are pre-signed.

4. PATCH /v1/buildUploads/<buildUploadId>
     body: { data: { type: "buildUploads", id: buildUploadId, attributes: { uploaded: true } } }
     success: 200, data.attributes.state === "COMPLETE"
     failure: 4xx; surface errors[]

5. (poll) GET /v1/builds?filter[app]=...&filter[version]=...
     until processingState in {VALID, INVALID, FAILED}
```

### 10.7 REST: poll build state

```
argv: pure HTTPS, no shell.
GET https://api.appstoreconnect.apple.com/v1/builds
    ?filter[app]=<appId>
    &filter[version]=<bundleVersion>
    &fields[builds]=version,processingState,uploadedDate,expirationDate
    &sort=-uploadedDate
    &limit=10
Authorization: Bearer <JWT>     (rotate every ~19 min)
success: 200, data[0].attributes.processingState === "VALID"
failure: 200 with INVALID/FAILED/EXPIRED → terminal
ongoing: PROCESSING → wait and re-poll
```

### 10.8 Generic shape for surfacing errors to MCP clients

```ts
type UploadError = {
  tool: "xcodebuild" | "altool" | "iTMSTransporter" | "rest-api";
  phase: "archive" | "export" | "validate" | "upload" | "complete" | "poll";
  exitCode?: number;          // CLI tools only
  httpStatus?: number;        // REST only
  itmsCode?: number;          // numeric ITMS-NNNNN if found
  message: string;
  details?: unknown;          // raw JSON or stderr excerpt
  retryable: boolean;
};
```

Mark retryable:
- Network-flavor errors (5xx, exit -1 with no JSON, ITMS-90000, ITMS-90283).
- Anything starting with "Could not find" / "transient" in iTMSTransporter output.

Mark non-retryable:
- Signing/entitlements failures (most ITMS-90034, 90161, 90164, 90174).
- Duplicate version (ITMS-90189).
- Anything 4xx from REST that is not 408/429.

---

## Sources

- [Upload builds — App Store Connect Help (Apple)](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
- [App Store Connect API — Build uploads (Apple)](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads)
- [WWDC25 Session 324 — Automate your development process with the App Store Connect API](https://developer.apple.com/videos/play/wwdc2025/324/)
- [WWDC25 session writeup — Appcircle blog](https://appcircle.io/blog/wwdc25-automate-your-development-process-with-the-app-store-connect-api)
- [WWDC25 session writeup — DEV Community](https://dev.to/arshtechpro/wwdc-2025-automate-dev-process-with-app-store-connect-api-22f7)
- [WWDC 2025 transcripts gist (auramagi)](https://gist.github.com/auramagi/9c040c2233dfe71c24c76942e186f788)
- [`altool(1)` man page mirror (keith.github.io)](https://keith.github.io/xcode-man-pages/altool.1.html)
- [Apple Developer Forums — `app-store` deprecation in ExportOptions](https://developer.apple.com/forums/thread/773749)
- [ExportOptions.plist key reference (DanBodnar gist)](https://gist.github.com/DanBodnar/020e7a10bc286dc3e5946e7ccc20dd7b)
- [ExportOptions.plist organised by section (jessedc gist)](https://gist.github.com/jessedc/12a74aff88d06e669cf1c9999408c62c)
- [App build statuses — App Store Connect Help](https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-build-statuses/)
- [Builds endpoint — App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/builds)
- [TN3147: Migrating to the latest notarization tool](https://developer.apple.com/documentation/technotes/tn3147-migrating-to-the-latest-notarization-tool)
- [Generating Tokens for API Requests](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)
- [Authenticating to App Store Connect API from Node.js (Félix Paradis)](https://felixparadis.medium.com/authenticating-to-apples-new-app-store-connect-api-from-node-js-using-jwt-6811a09c4b11)
- [Uploading IPA via altool with API key (memo@ecpplus)](https://memo.ecp.plus/upload_ipa/)
- [Uploading macOS Builds to App Store Connect (Xojo blog, Jan 2025)](https://blog.xojo.com/2025/01/14/uploading-macos-builds-to-app-store-connect/)
- [fastlane upload_to_app_store action](https://docs.fastlane.tools/actions/upload_to_app_store/)
- [fastlane Using App Store Connect API](https://docs.fastlane.tools/app-store-connect-api/)
- [Codemagic feature request — iTMSTransporter vs altool (issue #278)](https://github.com/codemagic-ci-cd/cli-tools/issues/278)
- [App Store Connect API — Apple Developer landing](https://developer.apple.com/app-store-connect/api/)
