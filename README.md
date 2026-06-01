# appstore-connect-mcp

[![CI](https://github.com/warunacds/appstore-connect-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/warunacds/appstore-connect-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/appstore-connect-mcp.svg)](https://www.npmjs.com/package/appstore-connect-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node ≥20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

A Model Context Protocol server that lets Claude Code drive an App Store release end-to-end:

```
xcodebuild → archive → export → upload → metadata → screenshots → submit for review
```

Claude does the work; you review the result in App Store Connect and tap **Submit for Review**.

> **Status: 0.1.0-alpha.1.** The architecture is solid and the API coverage is current as of Apple's OpenAPI v4.3 + WWDC 2025, but the server has not yet been exercised against the live App Store Connect API end-to-end with a real IPA. Treat as alpha until that flight test happens. See [Known limitations](#known-limitations).

---

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Apple setup walkthrough](#apple-setup-walkthrough)
- [Configuration](#configuration)
- [Wire into Claude Code](#wire-into-claude-code)
- [End-to-end release flow](#end-to-end-release-flow)
- [Tool reference](#tool-reference)
- [Troubleshooting](#troubleshooting)
- [Security & secret handling](#security--secret-handling)
- [Comparison with fastlane / Transporter](#comparison-with-fastlane--transporter)
- [Known limitations](#known-limitations)
- [Development](#development)
- [License](#license)

---

## What it does

68 MCP tools split across:

- **Discovery** (11) — `asc_whoami`, list/get apps, builds, versions, localizations, categories, territories, plus `asc_release_status`: a one-shot snapshot that tells Claude what's blocking submission.
- **Build & upload** (5) — `xc_archive`, `xc_export_ipa`, `asc_validate_ipa`, `asc_upload_ipa` (defaults to the new REST `/v1/buildUploads` flow from WWDC 2025; falls back to `xcrun altool` on demand), `asc_wait_for_build_processing`.
- **Versioning & metadata** (10) — create/update versions, attach builds, upsert per-locale description/keywords/promo text/what's new, set categories, set App Review demo credentials, and control the 7-day phased release (`asc_set_phased_release`).
- **App pricing** (3) — list price points, read the price schedule, set the app's price (free or paid; base territory + auto-equalize).
- **Compliance declarations** (3) — set the content-rights declaration, read/set the age-rating questionnaire.
- **Screenshots & previews** (7) — idempotent set-find-or-create, full reservation → multipart PUT → MD5 commit. Same code path covers iPhone/iPad/Watch/TV/Vision Pro/Mac and iMessage variants.
- **Review submission** (4) — modern `reviewSubmissions` flow.
- **TestFlight** (4) — list beta groups, set "What to test", distribute, submit for beta review.
- **In-App Purchases** (9) — create products, upsert per-locale name/description, price (base territory + auto-equalize), set availability, attach a review screenshot, submit. Consumable / Non-Consumable / Non-Renewing Subscription.
- **Subscriptions** (12) — subscription groups + group localizations, create auto-renewable subscriptions, per-locale name/description, pricing (base + auto-equalize), availability, introductory offers (free trial / pay-as-you-go / pay-up-front), review screenshot, and group-level submission.

See the [tool reference](#tool-reference) for the full table.

## Quick start

Requires **Node 20+**. macOS 13+ with Xcode is needed for the build/archive tools and the altool upload fallback. Everything else runs cross-platform.

```bash
# 1. Install
npm install -g appstore-connect-mcp
# or use it without installing:
# npx appstore-connect-mcp --diagnose

# 2. Set credentials (see Apple setup walkthrough below)
export APP_STORE_CONNECT_KEY_ID=ABCDEFGHIJ
export APP_STORE_CONNECT_ISSUER_ID=11111111-2222-3333-4444-555555555555
export APP_STORE_CONNECT_PRIVATE_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_ABCDEFGHIJ.p8

# 3. Verify your setup
appstore-connect-mcp --diagnose

# 4. Wire into Claude Code
claude mcp add appstore-connect-mcp -- appstore-connect-mcp
```

That's it. In Claude Code:

```
> Use asc_release_status for bundleId com.example.myapp to see what's blocking submission.
> Now create version 1.4.0 attached to the latest valid build.
> Set the en-US "What's New": "• Faster sync\n• HealthKit integration\n• Bug fixes"
> Submit for review.
```

## Apple setup walkthrough

### Create an App Store Connect API key

1. Sign in to **[App Store Connect](https://appstoreconnect.apple.com/)** with an Account Holder or Admin role.
2. Go to **Users and Access → Integrations → App Store Connect API → Team Keys**.
3. Click **(+)**. Pick a name (e.g. "MCP release automation") and a **role**. Recommended: **App Manager** — it can manage versions, metadata, submissions, and TestFlight, but cannot edit users or pricing. For pricing/IAP automation, you'll need **Admin** or **Finance**.
4. Click **Generate**. Apple will show a **Download API Key** link **once**. Click it. The file `AuthKey_<KEYID>.p8` is now in your Downloads folder. **You cannot re-download it.** If you lose it, you have to revoke the key and create a new one.
5. Note the **Issuer ID** (UUID at the top of the Integrations page) and the **Key ID** (10 characters next to your new key).

### Place the .p8

The recommended location, which both `altool` and this MCP look in by default:

```bash
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_*.p8 ~/.appstoreconnect/private_keys/
chmod 600 ~/.appstoreconnect/private_keys/*.p8
```

### Verify

```bash
appstore-connect-mcp --diagnose
```

You should see all checks pass. If anything fails, the diagnose output names the file/env var to fix.

## Configuration

| Variable | Required | Notes |
|---|---|---|
| `APP_STORE_CONNECT_KEY_ID` | yes | 10-character Key ID shown next to the key in App Store Connect |
| `APP_STORE_CONNECT_ISSUER_ID` | yes | UUID at the top of the Integrations page |
| `APP_STORE_CONNECT_PRIVATE_KEY_PATH` | one of these | Path to the `AuthKey_<KEYID>.p8` file |
| `APP_STORE_CONNECT_PRIVATE_KEY` | | PEM contents inline (alternative to the path) |
| `APP_STORE_CONNECT_PREFER_REST_UPLOAD` | no | `true` (default) uses `/v1/buildUploads`; `false` falls back to altool |

If neither path nor inline PEM is set, the server looks in altool's canonical locations:

```
~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8
~/.private_keys/AuthKey_<KEYID>.p8
./private_keys/AuthKey_<KEYID>.p8
./AuthKey_<KEYID>.p8
```

## Wire into Claude Code

```bash
claude mcp add appstore-connect-mcp -- appstore-connect-mcp
```

…or add it to `~/.claude.json` directly:

```json
{
  "mcpServers": {
    "appstore-connect-mcp": {
      "command": "appstore-connect-mcp",
      "env": {
        "APP_STORE_CONNECT_KEY_ID": "ABCDEFGHIJ",
        "APP_STORE_CONNECT_ISSUER_ID": "11111111-2222-3333-4444-555555555555",
        "APP_STORE_CONNECT_PRIVATE_KEY_PATH": "/Users/me/.appstoreconnect/private_keys/AuthKey_ABCDEFGHIJ.p8"
      }
    }
  }
}
```

Verify it loaded with:

```
> Use asc_whoami to check the App Store Connect connection.
```

## End-to-end release flow

The flow Claude follows when you say "ship 1.4.0 to the App Store":

1. **Snapshot.** `asc_release_status appId=…` returns the editable version, latest VALID build, missing localizations, missing screenshots, and a blockers list. Always start here.
2. **Build & upload (if a fresh build is needed).**
   - `xc_archive { workspacePath, scheme, archivePath }`
   - `xc_export_ipa { archivePath, exportPath, exportOptions: { method: "app-store-connect", teamID, signingStyle, … } }`
   - `asc_validate_ipa { ipaPath, … }` (cheap pre-flight; catches signing / entitlement / ITMS errors before upload)
   - `asc_upload_ipa { ipaPath, bundleVersion, platform: "IOS" }`
   - `asc_wait_for_build_processing { appId, bundleVersion }` polls until `VALID`
3. **Version.**
   - `asc_create_version { appId, versionString: "1.4.0", platform: "IOS", buildId }`, **or**
   - `asc_attach_build_to_version { versionId, buildId }` if the version already exists.
4. **Localizations.** For each locale, `asc_set_version_localization` with `description`, `keywords`, `whatsNew`, `promotionalText`, `marketingUrl`, `supportUrl`.
5. **App-level info.** `asc_get_editable_app_info` → `asc_set_app_categories` → `asc_set_app_info_localization` (name, subtitle, privacy URL).
6. **Screenshots.** Per `(locale, displayType)`: `asc_find_or_create_screenshot_set` → loop `asc_upload_screenshot` for each PNG/JPG → optional `asc_reorder_screenshots`. Same shape for `asc_upload_preview`.
7. **Review details.** `asc_set_review_details` with contact info and demo credentials (required if your app has a login).
8. **Submit.** `asc_submit_for_review { appId, versionId, platform }` creates the `reviewSubmission`, adds the version as an item, and PATCHes `submitted: true`.
9. **Track.** `asc_get_review_submission { submissionId }`. Use `asc_release_to_store` after Apple approves to push a `PENDING_DEVELOPER_RELEASE` build live.

For TestFlight: `asc_set_beta_whats_new` → `asc_distribute_to_beta_groups` (internal-only) or `asc_submit_for_beta_review` (external testers).

See [`examples/release.example.json`](examples/release.example.json) for a sample metadata payload.

## Tool reference

### Discovery & status

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_whoami` | — | Verify auth works; lists 1 app to confirm |
| `asc_list_apps` | — | List visible apps; filter by `bundleId` or `name` |
| `asc_get_app` | `appId` or `bundleId` | Single app, with sideloaded versions/builds/appInfos |
| `asc_list_builds` | `appId` | Builds; filter by `processingState`, `version`, `expired` |
| `asc_get_build` | `buildId` | Single build, with preReleaseVersion + appStoreVersion |
| `asc_list_versions` | `appId` | Versions for an app; filter by `platform`, `appVersionState` |
| `asc_get_version` | `versionId` | Single version + build + localizations + review detail |
| `asc_list_version_localizations` | `versionId` | Per-locale marketing copy under a version |
| `asc_list_categories` | — | Discover category ids for `asc_set_app_categories` |
| `asc_list_territories` | — | Territory codes (USA, GBR, …) for the pricing/availability tools |
| **`asc_release_status`** | `appId` or `bundleId` | **One-shot "what's blocking submission" snapshot** |

### Build, validate, upload (macOS for the first three)

| Tool | Required inputs | Purpose |
|---|---|---|
| `xc_archive` | `scheme`, `archivePath`, one of `workspacePath`/`projectPath` | `xcodebuild ... archive` |
| `xc_export_ipa` | `archivePath`, `exportPath`, one of `exportOptionsPlist`/`exportOptions` | `xcodebuild -exportArchive` (auto-generates plist if you pass `exportOptions`) |
| `asc_validate_ipa` | `ipaPath` | Pre-flight via `xcrun altool --validate-app` |
| `asc_upload_ipa` | `ipaPath`, `bundleVersion` | REST `/v1/buildUploads` (default) or `altool` |
| `asc_wait_for_build_processing` | `appId`, `bundleVersion` | Polls until VALID/INVALID/timeout |

### Version & metadata

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_create_version` | `appId`, `versionString` | New App Store Version; optionally attach a build |
| `asc_update_version` | `versionId` | Edit `versionString`/`copyright`/`releaseType`/etc. |
| `asc_attach_build_to_version` | `versionId`, `buildId` | Set or swap the binary on a version |
| `asc_set_version_localization` | `versionId`, `locale` | Upsert description, keywords, whatsNew, etc. |
| `asc_release_to_store` | `versionId` | Manually release a `PENDING_DEVELOPER_RELEASE` build |
| `asc_set_phased_release` | `versionId` | Enable / pause / resume / complete the 7-day phased rollout |
| `asc_get_editable_app_info` | `appId` | Find the editable AppInfo (state=PREPARE_FOR_SUBMISSION) |
| `asc_set_app_categories` | `appInfoId`, `primaryCategoryId` | Set primary/secondary categories |
| `asc_set_app_info_localization` | `appInfoId`, `locale` | Upsert name, subtitle, privacy URL |
| `asc_set_review_details` | `versionId` | Contact info + demo credentials |

### App pricing

The app's *own* price (free or paid), distinct from in-app-purchase pricing. Apple uses fixed, server-defined price points per territory — you pick a tier, you don't type an amount. `asc_set_app_price` resolves a `customerPrice` like `"4.99"` to the matching point in the base territory (or `free: true` for the $0 tier); territories you don't list auto-equalize.

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_list_app_price_points` | `appId` | Valid price tiers for a territory |
| `asc_get_app_price_schedule` | `appId` | The app's current price schedule |
| `asc_set_app_price` | `appId` | Set price (`free`, `customerPrice`, or `pricePointId`); auto-equalizes |

> **Validation status.** Like the rest of the server, these are not yet exercised against live Apple traffic; the price-schedule shape is inferred from `research/api-reference.md` §12. If a call 400s, attach the JSON:API error body to an issue.

### Compliance declarations

Submission gates beyond metadata. (App-privacy "nutrition label" data usages are a larger surface, not covered yet.)

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_set_content_rights` | `appId`, `usesThirdPartyContent` | Declare third-party content rights on the app |
| `asc_get_age_rating` | `appId` | Read the age-rating questionnaire |
| `asc_set_age_rating` | `appId` | Set questionnaire answers (resolves the editable AppInfo + declaration) |

> **Validation status.** `[VERIFY]` — and note Apple overhauled the age-rating questionnaire in 2024–25 (new bands/questions). `asc_set_age_rating` PATCHes only the fields you pass and takes an `additionalDeclarations` escape hatch for questions not in the typed list.

### Screenshots & previews

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_list_screenshot_sets` | `localizationId` | List sets under a localization |
| `asc_find_or_create_screenshot_set` | `localizationId`, `displayType` | Idempotent set get/create |
| `asc_upload_screenshot` | `setId`, `filePath` | Reservation → multipart PUT → MD5 commit |
| `asc_delete_screenshot` | `screenshotId` | Remove one screenshot |
| `asc_reorder_screenshots` | `setId`, `screenshotIds[]` | Change display order |
| `asc_find_or_create_preview_set` | `localizationId`, `previewType` | Idempotent video set get/create |
| `asc_upload_preview` | `setId`, `filePath` | Same flow as screenshots, for video |

### Review submission

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_submit_for_review` | `appId`, `versionId` | End-to-end: create submission → add item → PATCH submitted=true |
| `asc_get_review_submission` | `submissionId` | State + items |
| `asc_list_review_submissions` | `appId` | Recent submissions |
| `asc_cancel_review_submission` | `submissionId` | Pull back if not yet picked up |

### TestFlight

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_list_beta_groups` | `appId` | Internal + external groups |
| `asc_set_beta_whats_new` | `buildId`, `locale`, `whatsNew` | Per-locale "What to Test" |
| `asc_distribute_to_beta_groups` | `buildId`, `groupIds[]` | Push a build to one or more groups |
| `asc_submit_for_beta_review` | `buildId` | Required before external distribution |

### In-App Purchases

Covers Consumable, Non-Consumable, and Non-Renewing Subscription products. Auto-renewable subscriptions and offers are deliberately a later phase.

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_list_in_app_purchases` | `appId` | List IAPs; filter by `inAppPurchaseType`/`state` |
| `asc_get_in_app_purchase` | `inAppPurchaseId` | Single IAP + localizations + price schedule + availability |
| `asc_create_in_app_purchase` | `appId`, `name`, `productId`, `inAppPurchaseType` | Create the product (productId is immutable) |
| `asc_set_iap_localization` | `inAppPurchaseId`, `locale` | Upsert customer-facing name (≤30) + description (≤45) |
| `asc_list_iap_price_points` | `inAppPurchaseId` | Discover valid price tiers for a territory |
| `asc_set_iap_price` | `inAppPurchaseId` | Base territory + `customerPrice`/`pricePointId`; other territories auto-equalize |
| `asc_set_iap_availability` | `inAppPurchaseId` | Territory availability (codes or `availableInAllTerritories`) |
| `asc_upload_iap_review_screenshot` | `inAppPurchaseId`, `filePath` | Reservation → PUT → MD5 commit (App Review screenshot) |
| `asc_submit_iap_for_review` | `inAppPurchaseId` | Standalone IAP submission (or bundle via `asc_submit_for_review`) |

Typical flow:

```
> Create a non-consumable IAP "Pro Upgrade" productId com.example.app.pro for appId 12345.
> Set its en-US name "Pro Upgrade" and description "Unlock every feature, forever."
> Price it at $4.99 (base territory USA) — other territories auto-equalize.
> Make it available in all territories, upload ~/screens/iap-review.png as the review screenshot, and submit it for review.
```

> **Pricing model.** Apple uses fixed, server-defined price points per territory — you pick a tier, you don't type an amount. `asc_set_iap_price` resolves a `customerPrice` like `"4.99"` to the matching point in the base territory; pass an explicit `pricePointId` (from `asc_list_iap_price_points`) for precision. Territories you don't list are auto-derived from the base.

> **Validation status.** Like the rest of the server, the IAP tools have not been exercised against live Apple traffic. Four spec details are marked `[VERIFY]` in `src/tools/iap.ts` (the `inAppPurchaseV2` vs `inAppPurchase` relationship keys, the standalone `inAppPurchaseSubmissions` submit path, and price-schedule auto-equalization). If one 400s, attach the JSON:API error body to an issue.

### Subscriptions

Auto-renewable subscriptions. A subscription lives inside a subscription **group**; a customer can hold only one active subscription per group, and `groupLevel` ranks the upgrade/downgrade tiers. Submission happens at the **group** level.

| Tool | Required inputs | Purpose |
|---|---|---|
| `asc_list_subscription_groups` | `appId` | Groups + their subscriptions |
| `asc_create_subscription_group` | `appId`, `referenceName` | Create a group (internal name) |
| `asc_set_subscription_group_localization` | `subscriptionGroupId`, `locale` | Upsert customer-facing group name (+ optional customAppName) |
| `asc_create_subscription` | `groupId`, `name`, `productId`, `subscriptionPeriod` | Create an auto-renewable subscription in a group |
| `asc_get_subscription` | `subscriptionId` | Single subscription + localizations/prices/availability/offers |
| `asc_set_subscription_localization` | `subscriptionId`, `locale` | Upsert customer-facing name (≤30) + description (≤45) |
| `asc_list_subscription_price_points` | `subscriptionId` | Discover valid price tiers for a territory |
| `asc_set_subscription_price` | `subscriptionId` | Base territory + `customerPrice`/`pricePointId`; auto-equalizes |
| `asc_set_subscription_availability` | `subscriptionId` | Territory availability |
| `asc_set_subscription_intro_offer` | `subscriptionId`, `offerMode`, `duration` | Free trial / pay-as-you-go / pay-up-front offer |
| `asc_upload_subscription_review_screenshot` | `subscriptionId`, `filePath` | Reservation → PUT → MD5 commit |
| `asc_submit_subscription_for_review` | `subscriptionGroupId` | Submit the whole group for review |

Typical flow:

```
> Create a subscription group "Pro" for appId 12345 and set its en-US name "Pro".
> Add a monthly auto-renewable subscription "Pro Monthly" productId com.example.app.pro.monthly, groupLevel 1.
> Set its en-US name "Pro Monthly" and description "Everything in Pro, billed monthly."
> Price it at $9.99 (base USA), give it a 1-month free trial, make it available everywhere.
> Upload ~/screens/sub-review.png and submit the Pro group for review.
```

> **Validation status.** Same `[VERIFY]` caveats apply (see `src/tools/subscriptions.ts`): the `subscription`/`subscriptionGroup` relationship keys, subscription-price auto-equalization (subscriptions have no price-schedule resource — prices are created per territory), the introductory-offer territory/price-point shape, and the group-level `subscriptionGroupSubmissions` submit path.

## Troubleshooting

Run `appstore-connect-mcp --diagnose` first — it diagnoses about 80% of setup issues directly.

### Authentication errors

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 NOT_AUTHORIZED` | Clock skew on your machine | Sync NTP. Apple rejects JWTs with `iat` in the future. |
| `401 NOT_AUTHORIZED`, was working yesterday | Key revoked or expired in App Store Connect | Re-create the key, download the new `.p8`, update env vars |
| `401 NOT_AUTHORIZED`, only on certain endpoints | Key role too low | Promote to App Manager (or Admin/Finance for pricing/IAP) |
| `401`, JWT looks fine | Token cached past `exp` | We mint 18-min tokens with a 60s refresh lead; if you fork the code, don't loosen this — Apple's hard cap is 1199 seconds |
| `Could not import the .p8 private key as PKCS#8 / ES256` | The `.p8` was edited / re-saved and lost its line breaks | Re-download from App Store Connect — keep the file byte-identical |

### Upload errors (ITMS-90xxx)

altool and the REST upload surface return Apple's structured error codes. The most common:

| Code | Meaning | Common fix |
|---|---|---|
| `ITMS-90049` | Bundle is missing a required key in `Info.plist` | Apple's error includes the key — usually `CFBundleIcons`, `LSApplicationCategoryType`, or `NSPhotoLibraryUsageDescription` |
| `ITMS-90189` | Redundant binary upload — same `CFBundleVersion` already exists | Bump build number; build numbers must be unique per `(bundleId, version)` |
| `ITMS-90683` | Missing purpose string for a usage-permission API | Add `NS<Capability>UsageDescription` to `Info.plist` |
| `ITMS-90161` | Invalid provisioning profile | Profile doesn't include the App ID, or uses a wrong certificate. Re-export with `-allowProvisioningUpdates` and a valid `ExportOptions.plist`. |
| `ITMS-90685` | `CFBundleVersion` value not greater than the previous upload | App Store wants strictly increasing build numbers within a marketing version |
| `ITMS-90809` | Use of deprecated SDK / API | Apple's error names the API; address it or set `manageAppVersionAndBuildNumber=false` if it was a tooling-side rewrite |
| `ITMS-91065` | Missing privacy manifest declarations | Add a `PrivacyInfo.xcprivacy` to your bundle declaring required-reason API usage |
| `STATE_ERROR.SCREENSHOTS_REQUIRED` | Submitting a version with no screenshots in the primary locale | Upload at least one set (e.g. `APP_IPHONE_67`) for the primary locale before submitting |
| `STATE_ERROR.MISSING_METADATA` | Required localization fields empty | Fill `description` and `keywords` for the primary locale |

### Build stuck in PROCESSING

- Normal: 5–30 minutes. Larger bundles, watch/visionOS extensions, on-demand resources, and Apple Silicon-only Mac builds can take 60+ minutes.
- If still PROCESSING after 60 minutes, check **App Store Connect → My Apps → TestFlight → Build Activity** for an error. The REST API will eventually move it to `INVALID` if processing fails server-side.
- `asc_wait_for_build_processing` defaults to a 45-minute timeout. Bump `timeoutMinutes` if needed.

### Screenshot rejected at commit time

If `assetDeliveryState.state` comes back `FAILED` after `asc_upload_screenshot`:

- **Wrong dimensions** for the display type (most common). All screenshots in a set must share dimensions; see the table in [§7.1 of the API reference](research/api-reference.md).
- **Transparency / alpha channel** — Apple rejects PNGs with alpha.
- **Interlaced PNG** — also rejected.

The fix is always: regenerate the asset, delete the failed screenshot, and re-upload.

### "No editable App Store Version"

Means the previous version is still in flight (e.g. `IN_REVIEW`). You can't create a new editable version until the current one resolves. Either wait, or `asc_cancel_review_submission` if you need to pull back.

### Logs

Detailed request/response logs (with secrets redacted) live at `~/logs/appstore-connect-mcp/<date>.log`. Attaching the relevant slice to a bug report is the single most useful thing you can do.

## Security & secret handling

- **The `.p8` is a long-lived team-wide credential.** Anyone with this file plus the Key ID and Issuer ID can act as the role you assigned. Treat it like a production API key:
  - `chmod 600 ~/.appstoreconnect/private_keys/*.p8`
  - **Never commit it to git.** A `.gitignore` entry for `*.p8` is included in this repo.
  - Don't paste it into chat logs. The MCP redacts known secret arg names (`password`, `apiKey`, etc.) from its own logs, but it can't redact what you paste.
- **Pick the minimum role.** App Manager is enough for everything in this MCP except pricing changes (Finance/Admin).
- **Rotate when in doubt.** If you suspect compromise, revoke the key in App Store Connect → Integrations and create a new one. Old `.p8` files become inert immediately on revocation.
- **Per-MCP-instance keys are fine.** You can create multiple API keys for the same team — one per machine, one per CI environment, one per developer. Track them by name.
- **JWT scoping.** Apple supports a `scope` claim limiting a JWT to specific endpoints. This MCP doesn't set it because the tool surface spans many endpoints; if you want defense-in-depth, fork and add a scope allowlist to `auth.ts`.

## Comparison with fastlane / Transporter

Honest answer: **fastlane is more battle-tested**. It's been wrapping App Store Connect since 2014, supports IAPs and pricing in depth, and has a huge community. If you have a deterministic CI pipeline and a Ruby allergy isn't a problem, fastlane (`pilot` + `deliver` + `match`) is a fine choice.

Where this MCP wins:

- **Conversational.** "Ship 1.4.0 with the screenshots in `~/screens/`, demo creds from 1Password" reads like an instruction; the equivalent fastlane setup is hundreds of lines of Ruby.
- **One-shot snapshots.** `asc_release_status` returns the entire submission-readiness picture in one call, designed for an LLM to reason over. fastlane gives you many small `lanes` you can call but no equivalent aggregator.
- **Modern API surface.** Uses `reviewSubmissions` (the current submission flow) and `/v1/buildUploads` (REST-native binary upload from WWDC 2025) — both of which fastlane supports but which most blog posts haven't caught up to.
- **No Ruby.** Single Node binary; works wherever Node 20 runs.

Where fastlane wins:

- **Coverage.** IAPs, subscriptions, custom product pages, age ratings, Game Center — fastlane handles all of these. This MCP focuses on the release path and deliberately punts IAP/subscription metadata to v2.
- **Plugins.** A decade of ecosystem.
- **Battle-testing.** This MCP is alpha; fastlane has shipped tens of thousands of apps.

A reasonable hybrid: use fastlane for IAP-heavy workflows you've already automated, use this MCP for the conversational "drive a release" loop.

## Known limitations

These are spec/platform constraints, not TODOs — they cannot be worked around in code:

- **No `POST /v1/apps`.** Apple's REST API does not let you create a new App record from scratch. The first time you upload a build for a brand-new bundle ID, App Store Connect materializes the App row server-side; before that, you must register the bundle ID and create the App in App Store Connect's web UI.
- **`xc_archive`, `xc_export_ipa`, and `asc_validate_ipa` require macOS with Xcode.** The REST upload path is cross-platform, but you still need a Mac to *produce* the IPA.
- **Bitcode is dead.** `uploadBitcode` / `compileBitcode` keys in `ExportOptions.plist` are no-ops since Xcode 14.

These items are working but **not yet validated against live Apple traffic** — flagged in the code with `[VERIFY]` comments:

- The `Platform` enum spelling on `POST /v1/buildUploads` (we use `IOS` / `MAC_OS` / `TV_OS` / `VISION_OS`, matching every other endpoint in the API; WWDC 2025 transcripts used a generic placeholder).
- The full `BuildUploadFile.assetType` enum. We hardcode `"BUILD"` for the main IPA, which Apple's session described, but other values may exist for accompanying assets (dSYMs, etc.).

If you hit a 400 from the REST upload, **set `APP_STORE_CONNECT_PREFER_REST_UPLOAD=false` to fall back to `xcrun altool`** and please file an issue with the JSON:API error body — that's the fastest way to nail down the spec details.

Out of scope for v1 (will probably ship in v2):

- In-App Purchases / Subscriptions (the API has 30+ endpoints for this; needs its own design pass).
- App Pricing (`appPriceSchedules` with the v3 `appPricePoints` model — needs Finance/Admin role and a fair amount of territory bookkeeping).
- App Custom Product Pages and A/B Test Experiments.
- Age Rating Declaration full questionnaire automation (we expose read; the questionnaire is a moving target).
- Provisioning profile / certificate management (`bundleIds`, `profiles`, `certificates`, `devices`). The API supports these and they fit the same auth/client; just not on the critical path for "ship a release."

## Development

```bash
git clone https://github.com/warunacds/appstore-connect-mcp
cd appstore-connect-mcp
npm install

npm run build       # tsc → dist/
npm run dev         # tsx, hot path for iteration
npm run typecheck   # tsc --noEmit
npm test            # node --test --import tsx
npm run diagnose    # run the preflight against your env
```

Logs at `~/logs/appstore-connect-mcp/<date>.log` (mirrored to stderr).

### Layout

```
src/
  index.ts          MCP server entry (stdio transport) + --diagnose CLI
  diagnose.ts       Preflight check runner
  auth.ts           ES256 JWT minter with caching
  client.ts         JSON:API REST client w/ retry, pagination, structured errors
  upload.ts         Asset reservation runner: chunked PUT + MD5 (used for screenshots, previews, builds)
  xcode.ts          xcodebuild & altool subprocess wrappers
  config.ts         Env + .p8 loader
  log.ts            Logs to stderr + ~/logs/appstore-connect-mcp/
  tools/            One file per tool family; all flow into tools/index.ts → ALL_TOOLS
test/               node:test against in-process mock servers (no real Apple traffic)
research/           Reference docs from the design phase
examples/           Sample metadata + ExportOptions.plist
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the bar for new tools and tests.

## License

[MIT](LICENSE) © 2026 appstore-connect-mcp contributors

## Sources

- Apple's [App Store Connect API documentation](https://developer.apple.com/documentation/appstoreconnectapi)
- The official OpenAPI spec v4.3
- [WWDC 2025 session 324 — Automate your development process with the App Store Connect API](https://developer.apple.com/videos/play/wwdc2025/324/)

Full design notes are in [`research/api-reference.md`](research/api-reference.md) and [`research/upload-pipeline.md`](research/upload-pipeline.md).
