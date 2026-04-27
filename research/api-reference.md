# App Store Connect API — Reference for MCP Server Implementation

**Sources:** Apple's [App Store Connect API documentation](https://developer.apple.com/documentation/appstoreconnectapi), the [App Store Connect API portal](https://developer.apple.com/app-store-connect/api/), and the official OpenAPI specification (currently **v4.3**, mirrored at [EvanBacon/App-Store-Connect-OpenAPI-Spec](https://github.com/EvanBacon/App-Store-Connect-OpenAPI-Spec)).

**Verified facts at a glance:**
- Base URL: `https://api.appstoreconnect.apple.com`
- All current production endpoints live under `/v1/`. (Some collection-level operations have been retired and only their `/{id}` form remains — see §9.)
- 923 paths in the current spec; this reference covers the ~80 endpoints that matter for the MCP server's "build → upload → metadata → submit" use case.
- Wire format is **JSON:API 1.0** (`{"data": {"type": "...", "id": "...", "attributes": {...}, "relationships": {...}}}`). All responses include `links`, `meta` (paging), and optional `included` (sideloaded relationships).
- All endpoints other than the asset PUT URLs require `Authorization: Bearer <JWT>`.

---

## 1. Authentication

### 1.1 JWT structure

**Header**
```json
{ "alg": "ES256", "kid": "<KEY_ID>", "typ": "JWT" }
```
- `alg` — must be `ES256` (ECDSA with P-256 + SHA-256). RS256/HS256 are rejected.
- `kid` — the 10-character **Key ID** shown next to the API key in App Store Connect.
- `typ` — must be `JWT`.

**Payload (team key)**
```json
{
  "iss": "<ISSUER_ID>",            // UUID from "Users and Access" → Integrations → App Store Connect API
  "iat": 1714175000,                // optional but recommended
  "exp": 1714176199,                // MUST be < iat + 1200 (20 min). Apple rejects ≥ 20 min.
  "aud": "appstoreconnect-v1",      // exact string
  "scope": ["GET /v1/apps?filter[platform]=IOS"]  // optional; per-token endpoint allow-list
}
```

**Payload (individual / "user-based" key)** — the only difference: `iss` is the **issuer ID for individual keys**, and `sub` MUST be set to `"user"`. Use `iss = <ISSUER_ID_FOR_INDIVIDUAL_KEYS>` and add `"sub": "user"`. Apple's docs call this the "individual API key" model — it scopes the token to the human user who created the key, with the same role/permissions as that user. Required for endpoints that touch user-personal data (e.g. some Customer Reviews flows). For everything we care about (apps, builds, versions, screenshots, submissions, TestFlight), the **team key** model is what you want.

### 1.2 Generating the token

1. **Create the key once** in App Store Connect → Users and Access → Integrations → App Store Connect API → **Team Keys** tab → **+** button. Pick a role (Admin, App Manager, Developer, Marketing, etc.). Download the **`.p8` private key file immediately** — Apple shows it exactly once and the link is permanent.
2. Note the **Issuer ID** (top of the page) and the **Key ID** (next to your new key). Both are needed for every JWT.
3. The `.p8` is a PEM-encoded PKCS#8 ECDSA private key on the P-256 curve. Sign the header.payload concatenation with it. Use a battle-tested library (`jsonwebtoken` in Node, `PyJWT` with `cryptography` in Python, `jose` in Go, Apple's own `JSONWebToken` Swift package) — do not hand-roll.
4. Cache the token client-side. **Re-use it across requests until ~1 minute before `exp`, then mint a new one.** Generating a JWT per request is the #1 cause of avoidable latency in client libraries.

### 1.3 Sending the token

```
Authorization: Bearer eyJhbGciOi...
```

### 1.4 Gotchas
- **`exp ≥ now + 1200s` returns 401.** Set `exp = now + 1180` to be safe.
- Clock skew matters: if your server's clock is fast, `iat` in the future also fails. Set `iat = now - 5`.
- `scope` is an **array of strings** of the form `"<METHOD> <PATH>?<QUERY>"` (e.g. `"GET /v1/apps"`). If you set scope, ANY request outside that scope is rejected. Most clients leave it off.
- Team keys can be **revoked or restricted** at any time by an Admin. Plan for 401s mid-flow.
- Roles cap what a key can do, regardless of the JWT being valid. The `App Manager` role is usually the right minimum for a release-automation MCP — it can manage versions, metadata, submissions, and TestFlight, but not edit users or pricing. For pricing/IAP, use `Admin` or `Finance`.

---

## 2. Apps

### 2.1 List apps — `GET /v1/apps`

**Filtering & queries (most useful):**
- `filter[bundleId]` — comma-separated list. Exact match.
- `filter[name]` — exact match (not a substring search).
- `filter[sku]` — comma-separated.
- `filter[id]` — comma-separated app IDs.
- `filter[appStoreVersions.appStoreState]` — see state enum below.
- `filter[appStoreVersions.platform]` — `IOS | MAC_OS | TV_OS | VISION_OS`.
- `filter[appStoreVersions.appVersionState]` — newer state machine, see §4.
- `filter[reviewSubmissions.state]`, `filter[reviewSubmissions.platform]`.
- `exists[gameCenterEnabledVersions]` — boolean.
- `sort` — `name | -name | bundleId | -bundleId | sku | -sku`.
- `limit` — 1..200 (collection cap on `/v1/apps`).
- `fields[apps]` — sparse fieldset; e.g. `name,bundleId,sku,primaryLocale`.
- `include` — sideloads. Allowed values include: `appStoreVersions, builds, preReleaseVersions, betaGroups, betaAppLocalizations, betaLicenseAgreement, betaAppReviewDetail, appInfos, appClips, endUserLicenseAgreement, inAppPurchases, inAppPurchasesV2, subscriptionGroups, gameCenterEnabledVersions, appCustomProductPages, promotedPurchases, appEvents, reviewSubmissions, gameCenterDetail, appStoreVersionExperimentsV2, ciProduct, appStoreIcon`.
- `limit[<related>]` — e.g. `limit[builds]=50` (cap is 50 on most relationships).

### 2.2 Read one app — `GET /v1/apps/{id}`

Same `fields[*]` / `include` / `limit[*]` query options.

### 2.3 Update an app — `PATCH /v1/apps/{id}`

Updatable attributes are **few** — `bundleId` is **immutable** post-creation; you can update `primaryLocale`, `subscriptionStatusUrl(*)`, `contentRightsDeclaration` (`DOES_NOT_USE_THIRD_PARTY_CONTENT | USES_THIRD_PARTY_CONTENT`), `availableInNewTerritories`, etc. There is **no `POST /v1/apps`** — apps are created either via App Store Connect's UI or by the legacy iTMSTransporter when uploading the first build with a previously-unseen bundle ID. **An MCP cannot create an app from scratch via REST.**

### 2.4 Sub-resources of an app (most useful)

- `GET /v1/apps/{id}/appStoreVersions` — versions for this app.
- `GET /v1/apps/{id}/builds` — builds.
- `GET /v1/apps/{id}/preReleaseVersions` — TestFlight pre-release "trains" (one per `version`+`platform`).
- `GET /v1/apps/{id}/appInfos` — current and editable app info objects.
- `GET /v1/apps/{id}/betaGroups`, `.../betaTesters` (via betaTesters search).
- `GET /v1/apps/{id}/reviewSubmissions` — modern submissions.
- `GET /v1/apps/{id}/buildUploads` — in-flight binary uploads (WWDC25).
- `GET /v1/apps/{id}/appPriceSchedule` — current pricing schedule.

### 2.5 App attributes (selectable in `fields[apps]`)
`accessibilityUrl, name, bundleId, sku, primaryLocale, isOrEverWasMadeForKids, subscriptionStatusUrl, contentRightsDeclaration, streamlinedPurchasingEnabled` plus all the relationship names listed above.

---

## 3. Builds

### 3.1 List builds — `GET /v1/builds`

**Filters:**
- `filter[app]` — app ID(s).
- `filter[version]` — build/CFBundleVersion (e.g. `42`).
- `filter[preReleaseVersion.version]` — marketing version (e.g. `1.4.0`).
- `filter[preReleaseVersion.platform]` — `IOS | MAC_OS | TV_OS | VISION_OS`.
- `filter[processingState]` — **`PROCESSING | FAILED | INVALID | VALID`**.
- `filter[expired]` — boolean.
- `filter[usesNonExemptEncryption]` — boolean.
- `filter[buildAudienceType]` — `INTERNAL_ONLY | APP_STORE_ELIGIBLE`.
- `filter[betaAppReviewSubmission.betaReviewState]` — `WAITING_FOR_REVIEW | IN_REVIEW | REJECTED | APPROVED`.
- `filter[preReleaseVersion]`, `filter[appStoreVersion]`, `filter[betaGroups]`, `filter[id]`.
- `sort` — including `uploadedDate` and `-uploadedDate` (newest first is most common).
- `include` — `app, appStoreVersion, preReleaseVersion, individualTesters, betaGroups, betaBuildLocalizations, buildBetaDetail, betaAppReviewSubmission, appEncryptionDeclaration, icons, buildBundles, buildUpload, perfPowerMetrics, diagnosticSignatures`.

### 3.2 Build attributes
`version, uploadedDate, expirationDate, expired, minOsVersion, lsMinimumSystemVersion, computedMinMacOsVersion, computedMinVisionOsVersion, iconAssetToken, processingState, buildAudienceType, usesNonExemptEncryption`.

### 3.3 Build state machine

```
                upload → PROCESSING ──┬──→ VALID  (ready for TestFlight / submission)
                                      ├──→ INVALID (build rejected by App Store processing)
                                      └──→ FAILED  (transient infra / asset failure)
```
- `PROCESSING` typically lasts 5–30 min for a normal app, longer for very large bundles.
- **Builds expire 90 days after upload.** `expirationDate` is set on processing completion.
- Once a build is associated with an `appStoreVersion`, you can't delete it — only expire/replace.

### 3.4 Read one build — `GET /v1/builds/{id}`
Plus per-build sub-resources:
- `GET/PATCH /v1/builds/{id}/buildBetaDetail` — controls `autoNotifyEnabled` (auto-distribute to testers when ready) and `internalBuildState`/`externalBuildState`.
- `GET /v1/builds/{id}/betaBuildLocalizations` — per-locale "What's new for testers".
- `GET /v1/builds/{id}/betaAppReviewSubmission` — TestFlight review submission for external testers.
- `GET /v1/builds/{id}/preReleaseVersion`.

### 3.5 Update a build — `PATCH /v1/builds/{id}`
Editable: `expired` (true/false — manually expire), `usesNonExemptEncryption`, relationship `appEncryptionDeclaration`.

---

## 4. App Store Versions

An "App Store Version" is a release record (versionString + platform) for an app. There are **two state machines** exposed:

### 4.1 The two states (Apple is migrating from `appStoreState` → `appVersionState`)

**`appVersionState` (current, prefer this):**
```
PREPARE_FOR_SUBMISSION
  → READY_FOR_REVIEW        (after submitting the version-level submission)
  → WAITING_FOR_REVIEW
  → IN_REVIEW
  → ACCEPTED ─┐
              ├→ PENDING_DEVELOPER_RELEASE   (releaseType=MANUAL, awaiting your release request)
              ├→ PENDING_APPLE_RELEASE       (releaseType=AFTER_APPROVAL, scheduled by Apple)
              └→ READY_FOR_DISTRIBUTION      (after release request fired)
  → REJECTED | DEVELOPER_REJECTED | METADATA_REJECTED | INVALID_BINARY
  → WAITING_FOR_EXPORT_COMPLIANCE
  → REPLACED_WITH_NEW_VERSION
  → PROCESSING_FOR_DISTRIBUTION
```
**`appStoreState` (deprecated alias):** same idea, additionally `READY_FOR_SALE`, `REMOVED_FROM_SALE`, `DEVELOPER_REMOVED_FROM_SALE`, `PROCESSING_FOR_APP_STORE`, `PENDING_CONTRACT`, `PREORDER_READY_FOR_SALE`, `NOT_APPLICABLE`. Available for filtering but treat as read-only legacy.

### 4.2 Create a version — `POST /v1/appStoreVersions`

**Required attributes:** `versionString`, `platform`.
**Optional:** `copyright`, `releaseType` (`MANUAL | AFTER_APPROVAL | SCHEDULED`), `earliestReleaseDate` (ISO-8601, only valid with `releaseType=SCHEDULED`), `reviewType` (`APP_STORE | NOTARIZATION`), `usesIdfa` (deprecated; use `idfaDeclarations` resource).

**Relationships:** `app` (required), `build` (optional — can attach later via PATCH), `appStoreVersionLocalizations` (optional; usually created separately).

```json
POST /v1/appStoreVersions
{
  "data": {
    "type": "appStoreVersions",
    "attributes": {
      "platform": "IOS",
      "versionString": "1.4.0",
      "copyright": "© 2026 Acme",
      "releaseType": "AFTER_APPROVAL"
    },
    "relationships": {
      "app": { "data": { "type": "apps", "id": "1234567890" } },
      "build": { "data": { "type": "builds", "id": "9876543210" } }
    }
  }
}
```

### 4.3 Read — `GET /v1/appStoreVersions/{id}`
Includes available: `app, appStoreVersionLocalizations, build, appStoreVersionPhasedRelease, gameCenterAppVersion, routingAppCoverage, appStoreReviewDetail, appStoreVersionSubmission (deprecated), appClipDefaultExperience, appStoreVersionExperiments, appStoreVersionExperimentsV2, customerReviews, alternativeDistributionPackage`.

### 4.4 Update — `PATCH /v1/appStoreVersions/{id}`
Editable attributes: `versionString, copyright, reviewType, releaseType, earliestReleaseDate, downloadable`. Relationship `build` can be added/swapped while in `PREPARE_FOR_SUBMISSION` or after a rejection.

### 4.5 Delete — `DELETE /v1/appStoreVersions/{id}`
Only allowed in `PREPARE_FOR_SUBMISSION` (and a couple of rejection states).

### 4.6 Sub-resources
- `GET/POST /v1/appStoreVersions/{id}/appStoreVersionLocalizations` — list / create new localizations under this version. (See §5 for actual create payload.)
- `GET /v1/appStoreVersions/{id}/build` (read), and **PATCH the relationship**: `PATCH /v1/appStoreVersions/{id}/relationships/build` with body `{"data": {"type": "builds", "id": "..."}}` swaps the binary attached to a version.
- `GET /v1/appStoreVersions/{id}/appStoreVersionPhasedRelease`, `appStoreReviewDetail`, etc.
- **Release request:** `POST /v1/appStoreVersionReleaseRequests` with relationship `appStoreVersion` — manually releases a `PENDING_DEVELOPER_RELEASE` version. (One-shot resource; no list/get.)

### 4.7 App Store Review Detail — `POST /v1/appStoreReviewDetails`

The contact info / demo creds Apple's reviewers see. Required if your app has a login.
Attributes: `contactFirstName, contactLastName, contactPhone, contactEmail, demoAccountName, demoAccountPassword, demoAccountRequired, notes`. Relationship: `appStoreVersion`.

`POST /v1/appStoreReviewAttachments` follows the same upload-reservation pattern as screenshots (see §7) for attaching screenshots/videos for App Review.

---

## 5. App Store Version Localizations

A localization is the per-locale (e.g. `en-US`, `ja`) marketing copy attached to a specific version.

### 5.1 Create — `POST /v1/appStoreVersionLocalizations`

**Required:** `locale` (BCP-47-style, must be one of Apple's supported locales — `en-US`, `en-GB`, `de-DE`, `fr-FR`, `ja`, `zh-Hans`, `zh-Hant`, etc.).
**Optional:** `description, keywords, marketingUrl, promotionalText, supportUrl, whatsNew`.
Length caps:
- `description` ≤ 4000
- `keywords` ≤ 100 (comma-separated, no leading spaces — counts whole string)
- `promotionalText` ≤ 170
- `whatsNew` ≤ 4000
- `marketingUrl`, `supportUrl` ≤ 255 and must be `http(s)://`.

```json
POST /v1/appStoreVersionLocalizations
{
  "data": {
    "type": "appStoreVersionLocalizations",
    "attributes": {
      "locale": "en-US",
      "description": "...",
      "keywords": "fitness,running,health",
      "promotionalText": "New: HealthKit integration!",
      "whatsNew": "• Bug fixes • Faster sync",
      "marketingUrl": "https://acme.example/app",
      "supportUrl": "https://acme.example/support"
    },
    "relationships": {
      "appStoreVersion": { "data": { "type": "appStoreVersions", "id": "..." } }
    }
  }
}
```

### 5.2 Read — `GET /v1/appStoreVersionLocalizations/{id}`
### 5.3 Update — `PATCH /v1/appStoreVersionLocalizations/{id}`
Same attributes (no `locale`).
### 5.4 Delete — `DELETE /v1/appStoreVersionLocalizations/{id}`
### 5.5 Sub-resources
- `GET/POST /v1/appStoreVersionLocalizations/{id}/appScreenshotSets` — see §7.
- `GET/POST /v1/appStoreVersionLocalizations/{id}/appPreviewSets` — see §8.

### 5.6 Gotcha
The **primary locale** (the app's `primaryLocale` attribute) cannot be removed. All other localizations can be added/removed freely while the version is `PREPARE_FOR_SUBMISSION`.

---

## 6. App Info & App Info Localizations

`AppInfo` is the **non-version-specific** marketing data (name, subtitle, primary/secondary categories, privacy policy URL). One AppInfo is "live" (current); subsequent ones are editable for the next submission.

### 6.1 Read — `GET /v1/apps/{id}/appInfos` (list of historical app-infos)
- `GET /v1/appInfos/{id}` — single.
- AppInfo attributes: `state` (`PREPARE_FOR_SUBMISSION | READY_FOR_REVIEW | WAITING_FOR_REVIEW | IN_REVIEW | ACCEPTED | REJECTED | DEVELOPER_REJECTED | PENDING_RELEASE | READY_FOR_DISTRIBUTION | REPLACED_WITH_NEW_INFO`). The deprecated age-rating fields (`appStoreAgeRating`, `australiaAgeRating`, `brazilAgeRating`, etc.) are still present but are read-only — set them via the AgeRatingDeclaration resource (§11).

### 6.2 Update — `PATCH /v1/appInfos/{id}`
Only **relationships** are editable here: `primaryCategory, primarySubcategoryOne, primarySubcategoryTwo, secondaryCategory, secondarySubcategoryOne, secondarySubcategoryTwo`. Each points to an `appCategories` resource (look up via `GET /v1/appCategories?filter[platforms]=IOS`).

### 6.3 App Info Localizations

`POST /v1/appInfoLocalizations` — required: `locale`, `name`. Optional: `subtitle, privacyPolicyUrl, privacyChoicesUrl, privacyPolicyText` (only used by some markets).
- `name` ≤ 30 chars, `subtitle` ≤ 30 chars.
- Relationship: `appInfo`.

`PATCH /v1/appInfoLocalizations/{id}` — update attributes (no `locale`).
`DELETE /v1/appInfoLocalizations/{id}` — only allowed for editable AppInfos.

### 6.4 Workflow note
When you create a new App Store Version, the **editable AppInfo** is the one with `state = PREPARE_FOR_SUBMISSION`. If your app is already live and you haven't submitted a metadata change, App Store Connect creates a new editable AppInfo automatically — your MCP just needs to find it via `GET /v1/apps/{id}/appInfos?filter[state]=PREPARE_FOR_SUBMISSION`.

---

## 7. App Screenshot Sets & App Screenshots

### 7.1 Display types (`ScreenshotDisplayType` enum, full list from spec)

| Identifier | Device class |
|---|---|
| `APP_IPHONE_67` | 6.9" iPhone (iPhone 17 Pro Max, 16 Pro Max, 15 Pro Max, 14 Pro Max, 16 Plus, 15 Plus) — 1290×2796 |
| `APP_IPHONE_65` | 6.5" iPhone (14 Plus, 13 Pro Max, 12 Pro Max, 11 Pro Max, 11, XS Max, XR) — 1284×2778 / 1242×2688 |
| `APP_IPHONE_61` | 6.1" iPhone (16, 15, 14, 13, 12, 11 Pro, XS, X) — 1179×2556 / 1170×2532 |
| `APP_IPHONE_58` | 5.8" iPhone (X, XS, 11 Pro) — 1125×2436 |
| `APP_IPHONE_55` | 5.5" iPhone (Plus models 6/6S/7/8) — 1242×2208 |
| `APP_IPHONE_47` | 4.7" iPhone (SE 2/3, 6/6S/7/8) — 750×1334 |
| `APP_IPHONE_40` | 4.0" iPhone (SE 1, 5/5S/5C) — 640×1136 |
| `APP_IPHONE_35` | 3.5" iPhone (4/4S) — 640×960 |
| `APP_IPAD_PRO_3GEN_129` | 12.9" iPad Pro 3rd–6th gen + 13" iPad Pro M4/M5 + iPad Air M2/M3/M4 — 2048×2732 (also 2064×2752 for 13") |
| `APP_IPAD_PRO_3GEN_11` | 11" iPad Pro 1st–4th gen / iPad Air 4–5 — 1668×2388 |
| `APP_IPAD_PRO_129` | 12.9" iPad Pro 1st–2nd gen — 2048×2732 |
| `APP_IPAD_105` | 10.5" iPad Pro / iPad Air 3 / iPad 7–9 — 1668×2224 |
| `APP_IPAD_97` | 9.7" iPad — 1536×2048 |
| `APP_DESKTOP` | Mac — 1280×800, 1440×900, 2560×1600, or 2880×1800 |
| `APP_WATCH_ULTRA` | Apple Watch Ultra — 410×502 |
| `APP_WATCH_SERIES_10` | Series 10/11 — 416×496 |
| `APP_WATCH_SERIES_7` | Series 7/8/9 — 396×484 |
| `APP_WATCH_SERIES_4` | Series 4–6, SE — 368×448 |
| `APP_WATCH_SERIES_3` | Series 3 — 312×390 |
| `APP_APPLE_TV` | Apple TV — 1920×1080 or 3840×2160 |
| `APP_APPLE_VISION_PRO` | Vision Pro — 3840×2160 |
| `IMESSAGE_APP_IPHONE_*` / `IMESSAGE_APP_IPAD_*` | iMessage app variants for the same device buckets |

(Apple's marketing-side spec page also references "APP_IPHONE_69" / "APP_IPHONE_63" / `APP_WATCH_ULTRA2` / `APP_WATCH_SERIES_11` / `APP_WATCH_ULTRA3` etc. for newer hardware — these may appear in a future spec bump. The list above is what's in v4.3 as I write this.)

### 7.2 Constraints
- **1–10 screenshots per set, per locale.**
- **All screenshots in a set must share dimensions.**
- Allowed formats: `.png`, `.jpg`, `.jpeg`. No interlaced PNGs, no transparency on the App Store side.
- The set is keyed by `(appStoreVersionLocalization, screenshotDisplayType)`.

### 7.3 Create a set — `POST /v1/appScreenshotSets`

```json
{
  "data": {
    "type": "appScreenshotSets",
    "attributes": { "screenshotDisplayType": "APP_IPHONE_67" },
    "relationships": {
      "appStoreVersionLocalization": { "data": { "type": "appStoreVersionLocalizations", "id": "<loc id>" } }
    }
  }
}
```

You can attach a set instead to:
- `appCustomProductPageLocalization` (custom product pages)
- `appStoreVersionExperimentTreatmentLocalization` (A/B test treatments)

### 7.4 Reorder screenshots within a set — `PATCH /v1/appScreenshotSets/{id}/relationships/appScreenshots`
Body is the full ordered list of screenshot IDs. JSON:API "to-many relationship update" semantics.

### 7.5 Delete a set — `DELETE /v1/appScreenshotSets/{id}`
This deletes its screenshots too.

### 7.6 The asset-upload three-step (this is the same pattern for screenshots, previews, app icons in custom pages, IAP screenshots, app-info icons, and review attachments)

#### Step A — Create the reservation
```
POST /v1/appScreenshots
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "data": {
    "type": "appScreenshots",
    "attributes": { "fileName": "screen-01.png", "fileSize": 528413 },
    "relationships": {
      "appScreenshotSet": { "data": { "type": "appScreenshotSets", "id": "<set id>" } }
    }
  }
}
```
**Response (201)** includes `data.attributes.uploadOperations` — an array of `UploadOperation`:
```json
{
  "method": "PUT",
  "url": "https://upload.itunes.apple.com/upload/...?token=...",
  "offset": 0,
  "length": 524288,
  "requestHeaders": [
    { "name": "Content-Type", "value": "image/png" },
    { "name": "x-apple-something", "value": "..." }
  ]
}
```
For files larger than ~5 MB, Apple usually splits the upload into multiple operations (often 5 MB chunks). Smaller files come back with a single op covering offset 0..filesize.

#### Step B — Upload each part
For each operation:
```
PUT <url>
<every requestHeaders entry verbatim>
Content-Length: <length>

<bytes from offset..offset+length of the source file>
```
**Do NOT send the Authorization header** — these URLs are pre-signed. Most clients drop their default Authorization for these PUTs.
Treat 200/201/204 as success. On failure, the operation can be retried; do NOT recompute checksums between retries.

#### Step C — Commit
```
PATCH /v1/appScreenshots/{id}
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "data": {
    "type": "appScreenshots",
    "id": "<id>",
    "attributes": {
      "uploaded": true,
      "sourceFileChecksum": "<hex MD5 of the entire file>"
    }
  }
}
```
**`sourceFileChecksum` = MD5 of the whole file**, lowercase hex, no separators. Apple verifies the bytes server-side and rejects mismatches.

### 7.7 Read screenshots — `GET /v1/appScreenshots/{id}`
Attributes returned post-commit: `fileSize, fileName, sourceFileChecksum, imageAsset (templateUrl, height, width), assetToken, assetDeliveryState (state, errors[], warnings[])`. **Watch `assetDeliveryState.state`** — values are `AWAITING_UPLOAD`, `UPLOAD_COMPLETE`, `COMPLETE`, `FAILED`. If `FAILED`, your file was uploaded but the asset failed validation (wrong dimensions, alpha channel, etc.) — re-create the screenshot.

### 7.8 Delete — `DELETE /v1/appScreenshots/{id}`

---

## 8. App Preview Sets / App Previews

App previews are 15–30 second silent (or with audio) videos shown alongside screenshots.

### 8.1 `PreviewType` enum (note: no `APP_` prefix, unlike screenshots)
`IPHONE_67, IPHONE_61, IPHONE_65, IPHONE_58, IPHONE_55, IPHONE_47, IPHONE_40, IPHONE_35, IPAD_PRO_3GEN_129, IPAD_PRO_3GEN_11, IPAD_PRO_129, IPAD_105, IPAD_97, DESKTOP, APPLE_TV, APPLE_VISION_PRO`.

### 8.2 Endpoints (mirror §7 exactly)
- `POST /v1/appPreviewSets` — `attributes.previewType`, relationship `appStoreVersionLocalization` (or custom-page / experiment localization).
- `GET /v1/appPreviewSets/{id}/appPreviews` — list previews in a set.
- `POST /v1/appPreviews` — reservation. Required attributes: `fileName, fileSize`. **Optional**: `previewFrameTimeCode` (poster frame, e.g. `"00:00:05:01"`), `mimeType`. Relationship: `appPreviewSet`.
- `PATCH /v1/appPreviews/{id}` — commit with `uploaded: true` + `sourceFileChecksum` (MD5). Also accepts `previewFrameTimeCode` if you want to update the poster.
- `DELETE /v1/appPreviews/{id}`.
- Reorder: `PATCH /v1/appPreviewSets/{id}/relationships/appPreviews`.

### 8.3 Format constraints
- M4V / MP4 / MOV. H.264 or HEVC. Stereo audio. Frame rate ≥ 30fps. 15–30 seconds.
- Per device class, dimensions must match the screenshot dimensions for that class (within tolerance).

---

## 9. Submitting for Review

**There are TWO APIs. Use Review Submissions for new code.** The legacy `appStoreVersionSubmissions` POST endpoint has been retired in the current spec (only `GET /v1/appStoreVersionSubmissions/{id}` and `DELETE` remain on existing rows). All new code should use `reviewSubmissions`.

### 9.1 (LEGACY) App Store Version Submissions

- `GET /v1/appStoreVersionSubmissions/{id}` — read.
- `DELETE /v1/appStoreVersionSubmissions/{id}` — pull a submission back.
- `GET /v1/appStoreVersions/{id}/appStoreVersionSubmission` — fetch the (singular) submission row for a version.

There is **no longer** a `POST /v1/appStoreVersionSubmissions` endpoint in the current spec. Old code that creates a submission directly on a version is obsolete.

### 9.2 (CURRENT) Review Submissions

A `reviewSubmission` is a *bundle* of one or more `reviewSubmissionItems`. Each item is one of: an App Store Version, an App Custom Product Page Version, an App Store Version Experiment, an App Event, a Background Asset Version, a Game Center version, etc. This is the modern model — it lets you submit (e.g.) a version + an in-app event in a single review pass.

#### 9.2.1 Create the submission shell — `POST /v1/reviewSubmissions`
```json
{
  "data": {
    "type": "reviewSubmissions",
    "attributes": { "platform": "IOS" },
    "relationships": {
      "app": { "data": { "type": "apps", "id": "<app id>" } }
    }
  }
}
```
Response: 201 with state `READY_FOR_REVIEW` candidate (actually starts as the equivalent of "draft"; only after `submitted: true` does it move forward).

#### 9.2.2 Add items — `POST /v1/reviewSubmissionItems`
Per item (one item per resource you want reviewed):
```json
{
  "data": {
    "type": "reviewSubmissionItems",
    "relationships": {
      "reviewSubmission": { "data": { "type": "reviewSubmissions", "id": "<sub id>" } },
      "appStoreVersion":  { "data": { "type": "appStoreVersions",  "id": "<version id>" } }
    }
  }
}
```
Other valid one-of relationships: `appCustomProductPageVersion, appStoreVersionExperiment, appStoreVersionExperimentV2, appEvent, backgroundAssetVersion, gameCenterAchievementVersion, gameCenterActivityVersion, gameCenterChallengeVersion, gameCenterLeaderboardSetVersion, gameCenterLeaderboardVersion`.

#### 9.2.3 Submit — `PATCH /v1/reviewSubmissions/{id}`
```json
{ "data": { "type": "reviewSubmissions", "id": "<sub id>", "attributes": { "submitted": true } } }
```
This **finalizes** and pushes the submission into Apple's queue. Once `submitted: true` succeeds, the only mutation possible is `canceled: true` (pull back if not yet picked up).

#### 9.2.4 State — `GET /v1/reviewSubmissions/{id}`
Attributes: `platform, submittedDate, state` where state is one of:
- `READY_FOR_REVIEW` — drafted with items but not yet submitted.
- `WAITING_FOR_REVIEW` — submitted, queued.
- `IN_REVIEW` — being reviewed.
- `UNRESOLVED_ISSUES` — Apple flagged something; metadata-rejected items, etc.
- `CANCELING` — your `canceled: true` is being processed.
- `COMPLETING` — almost done.
- `COMPLETE` — done (approved or rejected — drill into items for per-item state).

#### 9.2.5 List — `GET /v1/reviewSubmissions?filter[app]=<appId>`
`filter[app]` is **required** on the collection endpoint. Other filters: `filter[state]`, `filter[platform]`.

#### 9.2.6 List items in a submission — `GET /v1/reviewSubmissions/{id}/items`

#### 9.2.7 Delete an item — `DELETE /v1/reviewSubmissionItems/{id}` (only while in `READY_FOR_REVIEW`).

### 9.3 Decision: when to use which?
**Always use `reviewSubmissions`.** The legacy form is read-only in current Apple infra and exists in the spec only for backward compatibility with submissions that were created before the migration. fastlane/match/etc. moved to `reviewSubmissions` in 2022.

---

## 10. TestFlight (Beta)

### 10.1 Pre-release versions — `GET /v1/preReleaseVersions`
A "pre-release version" is the (`platform`, `version`) tuple Apple groups builds under. Filterable by `filter[builds]`, `filter[builds.expired]`, `filter[builds.processingState]`, `filter[platform]`, `filter[version]`, `filter[app]`.

### 10.2 Build beta details — `GET/PATCH /v1/buildBetaDetails/{id}`
Attributes: `autoNotifyEnabled` (when true, on processing-complete TestFlight pushes to associated groups), `internalBuildState`, `externalBuildState`.

### 10.3 Beta build localizations — `POST /v1/betaBuildLocalizations`
"What's new for testers", per-locale. Required: `locale`. Optional: `whatsNew` (≤4000). Relationship: `build`.
- `PATCH /v1/betaBuildLocalizations/{id}` — update.
- `DELETE /v1/betaBuildLocalizations/{id}`.

### 10.4 Beta groups — `POST /v1/betaGroups`
Required: `name`. Optional: `isInternalGroup, hasAccessToAllBuilds, publicLinkEnabled, publicLinkLimitEnabled, publicLinkLimit, feedbackEnabled, iosBuildsAvailableForAppleSiliconMac, iosBuildsAvailableForAppleVision`. Relationships: `app`, `betaTesters`, `builds`.
- `PATCH /v1/betaGroups/{id}` — update name/flags.
- `POST /v1/betaGroups/{id}/relationships/builds` — attach builds (sends to testers).
- `DELETE /v1/betaGroups/{id}/relationships/builds` — detach.
- `POST /v1/betaGroups/{id}/relationships/betaTesters` — add testers.

### 10.5 Beta testers — `POST /v1/betaTesters`
Required: `email`. Optional: `firstName, lastName`. Relationships: `betaGroups[]`, `builds[]`.
- `DELETE /v1/betaTesters/{id}` — remove from app.
- `POST /v1/betaTesterInvitations` — re-send invite (relationship to a `betaTester` and an `app`).

### 10.6 Beta App Review (external testing only)
External testers require Apple to review the build first.
- `POST /v1/betaAppReviewSubmissions` — relationship `build`. Submits the build for TestFlight beta review.
- `GET /v1/betaAppReviewSubmissions/{id}` — state: `WAITING_FOR_REVIEW | IN_REVIEW | APPROVED | REJECTED`.
- `GET/PATCH /v1/betaAppReviewDetails/{id}` — same fields as the App Store review detail (contact + demo creds + notes).

### 10.7 Beta app localization — `POST /v1/betaAppLocalizations`
Per-locale TestFlight description. Attributes: `feedbackEmail, marketingUrl, privacyPolicyUrl, tvOsPrivacyPolicy, description, locale`.

### 10.8 Beta license agreement — `GET/PATCH /v1/betaLicenseAgreements/{id}`
The TestFlight EULA (defaults to Apple's standard one).

---

## 11. Age Rating Declaration

Endpoints: `GET /v1/ageRatingDeclarations/{id}`, `PATCH /v1/ageRatingDeclarations/{id}`. There is **no POST/list** — the AgeRatingDeclaration is created automatically when the AppInfo is created and is reachable via `GET /v1/appInfos/{id}/ageRatingDeclaration`.

### 11.1 Required attributes (yes/no booleans + frequency enums)
Frequency enum: `NONE | INFREQUENT_OR_MILD | FREQUENT_OR_INTENSE` (older `INFREQUENT | FREQUENT` aliases still accepted).

Boolean fields: `advertising, gambling, healthOrWellnessTopics, lootBox, messagingAndChat, parentalControls, ageAssurance, unrestrictedWebAccess, seventeenPlus, kidsAgeBand` (this last is an enum, see below).

Frequency fields: `alcoholTobaccoOrDrugUseOrReferences, contests, gamblingSimulated, gunsOrOtherWeapons, medicalOrTreatmentInformation, profanityOrCrudeHumor, sexualContentGraphicAndNudity, sexualContentOrNudity, horrorOrFearThemes, matureOrSuggestiveThemes, violenceCartoonOrFantasy, violenceRealistic, violenceRealisticProlongedGraphicOrSadistic, drugUseOrReferences`.

`kidsAgeBand` enum: `FIVE_AND_UNDER, SIX_TO_EIGHT, NINE_TO_ELEVEN, TWELVE_AND_OVER` (only valid if you've opted into Made for Kids).

### 11.2 Gotcha
Apple periodically adds new questions (e.g. `ageAssurance` was added in 2024). When that happens, every existing AgeRatingDeclaration becomes invalid until PATCHed. Build your client to **not error on unknown attribute keys** in responses, and to **PATCH only fields you recognize**.

---

## 12. App Pricing (v3 model)

### 12.1 Concepts
- An **`appPriceSchedule`** is the singular pricing record for an app. There's exactly one per app.
- A schedule references one **`baseTerritory`** (the territory whose price drives the rest) and a list of **`manualPrices`** (each one is an `appPrices` resource: `(price point, territory, start date)`).
- `appPricePoints` are *server-defined* tiers (USD 0.99, 1.99, 2.99, etc., plus their per-territory equivalents). You select a tier — you don't enter raw amounts.

### 12.2 Endpoints
- `GET /v1/apps/{id}/appPriceSchedule` — fetch current.
- `GET /v1/apps/{id}/appPricePoints?filter[territory]=USA` — list valid price points for a territory.
- `POST /v1/appPriceSchedules` — create/replace. Required relationships: `app, baseTerritory, manualPrices` (array of price entries you've already created or referenced). The schedule overwrites any prior one.
- `GET /v1/appPriceSchedules/{id}/manualPrices`, `automaticPrices`, `baseTerritory` — sub-resources.

### 12.3 Workflow
For an MVP that just needs to set a price:
1. `GET /v1/territories` (cached) → find the territory ID for your base territory.
2. `GET /v1/apps/{appId}/appPricePoints?filter[territory]=<territoryId>` to find the right price point.
3. Build an `appPrices` array (each has type `appPrices` and references the price point + territory).
4. `POST /v1/appPriceSchedules` with relationships `{ app, baseTerritory, manualPrices }`.

### 12.4 Free apps
For a free app, use the price point with `customerPrice = 0` for your base territory. Apple does not have a special "free" flag — it's just the $0 price tier.

---

## 13. In-App Purchases / Subscriptions (high-level — out of scope for MVP)

Endpoints exist; they are extensive. List for awareness only:
- `inAppPurchasesV2` — non-subscription IAPs (Consumable, Non-Consumable, Non-Renewing Subscription).
- `inAppPurchaseLocalizations`, `inAppPurchaseImages`, `inAppPurchaseAppStoreReviewScreenshots`, `inAppPurchasePriceSchedules`, `inAppPurchaseAvailabilities`, `inAppPurchaseSubmissions`.
- `subscriptionGroups`, `subscriptions`, `subscriptionLocalizations`, `subscriptionPrices`, `subscriptionAvailabilities`, `subscriptionIntroductoryOffers`, `subscriptionOfferCodes` (custom + one-time-use), `subscriptionPromotionalOffers`, `subscriptionImages`, `subscriptionAppStoreReviewScreenshots`, `subscriptionGroupSubmissions`.
- `inAppPurchaseOfferCodes` (and their `customCodes` / `oneTimeUseCodes`), `promotedPurchases`.

Submission for IAP/subscription metadata changes also goes through the **`reviewSubmissions`** flow — the item types `inAppPurchase` items aren't directly listed in the `reviewSubmissionItems` create schema, but IAP submissions have their own `inAppPurchaseSubmissions` and `subscriptionGroupSubmissions` resources. Treat as out-of-scope for v1 MCP unless a user explicitly asks.

---

## 14. Provisioning (Bundle IDs / Capabilities / Devices / Profiles / Certificates)

These exist on the same API and same auth. Useful for `create-new-app` flows.

### 14.1 Bundle IDs — `POST /v1/bundleIds`
Required attributes: `name, platform, identifier`. `platform` here uses `BundleIdPlatform` enum: **`IOS | MAC_OS | UNIVERSAL`** (note: no `TV_OS`, no `VISION_OS` — those live under `IOS`/`UNIVERSAL`).
Optional: `seedId`. The returned `id` is the bundle ID's resource ID (numeric), not the reverse-DNS string.
- `GET /v1/bundleIds`, `GET /v1/bundleIds/{id}`, `PATCH`, `DELETE`.
- `GET /v1/bundleIds/{id}/app` — link to the app (if one exists).
- `GET /v1/bundleIds/{id}/profiles`, `bundleIdCapabilities`.

### 14.2 Capabilities — `POST /v1/bundleIdCapabilities`
Attributes: `capabilityType` + optional `settings[]`.
**`CapabilityType` enum:** `ICLOUD, IN_APP_PURCHASE, GAME_CENTER, PUSH_NOTIFICATIONS, WALLET, INTER_APP_AUDIO, MAPS, ASSOCIATED_DOMAINS, PERSONAL_VPN, APP_GROUPS, HEALTHKIT, HOMEKIT, WIRELESS_ACCESSORY_CONFIGURATION, APPLE_PAY, DATA_PROTECTION, SIRIKIT, NETWORK_EXTENSIONS, MULTIPATH, HOT_SPOT, NFC_TAG_READING, CLASSKIT, AUTOFILL_CREDENTIAL_PROVIDER, ACCESS_WIFI_INFORMATION, NETWORK_CUSTOM_PROTOCOL, COREMEDIA_HLS_LOW_LATENCY, SYSTEM_EXTENSION_INSTALL, USER_MANAGEMENT, APPLE_ID_AUTH`. (Newer ones like `WEATHERKIT`, `GROUP_ACTIVITIES`, `JOURNALING_SUGGESTIONS` may have appeared since the spec snapshot — accept unknowns.)
Relationship: `bundleId`.
- `PATCH /v1/bundleIdCapabilities/{id}`, `DELETE`.

### 14.3 Devices — `POST /v1/devices`
Required: `name, udid, platform` (BundleIdPlatform).
- `GET /v1/devices`, `PATCH /v1/devices/{id}` (only `name` and `status: ENABLED|DISABLED` are editable).
- Apple does **not** allow programmatic deletion — only disabling. Twice-yearly device list resets via the Member Center.

### 14.4 Certificates — `POST /v1/certificates`
Required: `csrContent` (PEM-encoded CSR), `certificateType`.
**`CertificateType` enum:** `DEVELOPMENT, DISTRIBUTION, IOS_DEVELOPMENT, IOS_DISTRIBUTION, MAC_APP_DISTRIBUTION, MAC_APP_DEVELOPMENT, MAC_INSTALLER_DISTRIBUTION, DEVELOPER_ID_APPLICATION, DEVELOPER_ID_APPLICATION_G2, DEVELOPER_ID_KEXT, DEVELOPER_ID_KEXT_G2, APPLE_PAY, APPLE_PAY_MERCHANT_IDENTITY, APPLE_PAY_PSP_IDENTITY, APPLE_PAY_RSA, IDENTITY_ACCESS, PASS_TYPE_ID, PASS_TYPE_ID_WITH_NFC`.
- Returns the certificate as base64 DER (`certificateContent`) plus `serialNumber, expirationDate`.
- `GET /v1/certificates`, `GET /v1/certificates/{id}`, `DELETE /v1/certificates/{id}` (revoke).

### 14.5 Profiles — `POST /v1/profiles`
Required: `name, profileType`. Required relationships: `bundleId, certificates`. Optional relationships: `devices` (required for development/ad-hoc/inhouse).
**`ProfileType` enum:** `IOS_APP_DEVELOPMENT, IOS_APP_STORE, IOS_APP_ADHOC, IOS_APP_INHOUSE, MAC_APP_DEVELOPMENT, MAC_APP_STORE, MAC_APP_DIRECT, TVOS_APP_DEVELOPMENT, TVOS_APP_STORE, TVOS_APP_ADHOC, TVOS_APP_INHOUSE, MAC_CATALYST_APP_DEVELOPMENT, MAC_CATALYST_APP_STORE, MAC_CATALYST_APP_DIRECT`.
- Returns `profileContent` (base64 of the .mobileprovision), `uuid, expirationDate, profileState`.
- `GET /v1/profiles`, `DELETE /v1/profiles/{id}` (regenerate by deleting and re-creating).

---

## 15. Cross-cutting: pagination, rate limits, errors, asset upload, build upload

### 15.1 Pagination

JSON:API cursor pagination. Each list response has:
```json
{
  "data": [...],
  "links": {
    "self": "https://api.appstoreconnect.apple.com/v1/apps?limit=20",
    "next": "https://api.appstoreconnect.apple.com/v1/apps?cursor=Mw.PQ&limit=20",
    "first": "..."
  },
  "meta": {
    "paging": { "total": 184, "limit": 20 }
  }
}
```
- `limit` ranges from 1 to **200** on most root collections, **50** on relationship collections (`limit[<rel>]`).
- **Use `links.next` verbatim** — don't try to construct the next URL yourself. The cursor is opaque (typically a base64-encoded position token).
- `meta.paging.total` is best-effort and may be **omitted** for very large collections (Apple won't compute it).

### 15.2 Rate limits

- **Hourly limit per Team Key: 3,600 requests/hour** (the documented default; enterprise/contract tiers may be different).
- Returned header on every response:
  ```
  X-Rate-Limit: user-hour-lim:3600;user-hour-rem:3214;
  ```
  `user-hour-lim` = ceiling, `user-hour-rem` = remaining this hour.
- Over-limit returns **HTTP 429** with body:
  ```json
  { "errors": [{ "status": "429", "code": "RATE_LIMIT_EXCEEDED", "title": "...", "detail": "..." }] }
  ```
- **Undocumented per-minute soft cap:** community testing shows ~300–350 req/min triggers 429s even when hourly remaining is fine. Throttle to ≤ 5 req/sec sustained.
- Honor `Retry-After` if present; otherwise back off 30–60s.

### 15.3 Standard error response
```json
{
  "errors": [
    {
      "status": "409",
      "code": "STATE_ERROR.SCREENSHOTS_REQUIRED",
      "title": "The provided entity is in an invalid state.",
      "detail": "App Store Version must have at least one screenshot for each enabled localization.",
      "source": { "pointer": "/data/relationships/build" }
    }
  ]
}
```
Error codes are **stable, machine-readable, dotted strings** — match on them rather than parsing `detail`.

### 15.4 Sparse fieldsets and includes (use them aggressively)
- `fields[<type>]` on every request to slash payload size.
- `include` to avoid round-trips: e.g. `GET /v1/apps?include=appStoreVersions,builds&limit=20&fields[apps]=name,bundleId&fields[appStoreVersions]=versionString,appStoreState&fields[builds]=version,processingState`.
- Apple **forbids** including a relationship more than 2 hops deep. Use a follow-up request for deeper data.

### 15.5 Asset upload — full canonical sequence

Applies to `appScreenshots, appPreviews, appStoreReviewAttachments, appCustomProductPageImages, inAppPurchaseImages, subscriptionImages, etc.` — wherever you see a resource with `uploadOperations` and `sourceFileChecksum` / `uploaded` attributes.

```
1. Compute MD5 of file (as bytes) → hex string.
2. POST /v1/<assetResource>
   { data: { type, attributes: { fileName, fileSize }, relationships: { <parent>: {...} } } }
   → 201, returns data.attributes.uploadOperations[]
3. For each op in uploadOperations:
     PUT op.url
       (each header from op.requestHeaders[])
       Body = bytes[op.offset .. op.offset + op.length]
     Expect 200/201/204. NO Authorization header.
4. PATCH /v1/<assetResource>/{id}
   { data: { type, id, attributes: { uploaded: true, sourceFileChecksum: "<md5 hex>" } } }
   → 200; asset moves to assetDeliveryState.state = COMPLETE asynchronously.
5. Poll GET /v1/<assetResource>/{id} until assetDeliveryState.state == COMPLETE
   (or FAILED — re-create on failure).
```

### 15.6 Build (binary) upload — REST flow (WWDC25)

This is **new and important**: as of WWDC 2025, Apple ships a REST endpoint set that uploads `.ipa` (and `.pkg` for macOS) without Transporter/altool. The MCP should prefer this over Transporter where the user's environment is non-macOS or where shelling out is undesirable.

```
1. POST /v1/buildUploads
   { data: { type: "buildUploads",
     attributes: { cfBundleVersion, cfBundleShortVersionString, platform },
     relationships: { app: { data: { type: "apps", id: "..." } } } } }
   → 201, returns build upload {id}, state.state = AWAITING_UPLOAD.

2. POST /v1/buildUploadFiles  (one per file you need to send — usually just the IPA)
   { data: { type: "buildUploadFiles",
     attributes: {
       fileName: "MyApp.ipa", fileSize: 67108864,
       uti: "com.apple.ipa",          // OR com.apple.pkg / com.apple.binary-property-list / com.apple.xml-property-list / com.pkware.zip-archive
       assetType: "ASSET"             // OR ASSET_DESCRIPTION / ASSET_SPI
     },
     relationships: { buildUpload: { data: { type: "buildUploads", id: "..." } } } } }
   → 201, returns data.attributes.uploadOperations[] (DeliveryFileUploadOperation, includes partNumber + entityTag for multipart S3-style upload).

3. For each op (parts can be uploaded in parallel):
     PUT op.url
       Headers = op.requestHeaders
       Body = bytes[op.offset .. op.offset + op.length]
     Capture the response's ETag header per part (matches op.entityTag).

4. PATCH /v1/buildUploadFiles/{fileId}
   { data: { type: "buildUploadFiles", id,
     attributes: { uploaded: true, sourceFileChecksums: { file: { hash, algorithm } } } } }
   → asset transitions through AWAITING_UPLOAD → PROCESSING → COMPLETE.

5. Poll GET /v1/buildUploads/{id}
   state.state moves: AWAITING_UPLOAD → PROCESSING → COMPLETE  (or FAILED with state.errors[]).
   On COMPLETE, a new Build resource appears for the app at processingState=PROCESSING.

6. Poll GET /v1/builds?filter[app]=...&filter[processingState]=PROCESSING for the build that matches your cfBundleVersion. Once it flips to VALID, attach to your AppStoreVersion via PATCH /v1/appStoreVersions/{id}/relationships/build.
```

### 15.7 What still requires Transporter / altool?

- **Nothing strictly requires it any more** for App Store distribution as of the WWDC25 `buildUploads` API. You can drive an end-to-end IPA upload over plain HTTPS.
- Practical reasons people still use Transporter / altool:
  1. Older clients/CI configured years ago.
  2. **Aspera/Signiant fast-transfer protocols** — only Transporter speaks them. For very large macOS `.pkg` builds in low-bandwidth environments, Aspera via Transporter can be 3–10× faster.
  3. Custom asset packs (`.appex`, ODR) that pre-date the REST API — most have moved to `buildUploads`, a few legacy variants haven't.
- **App-creation-from-scratch** — there is no `POST /v1/apps`. The first build of a new bundle ID still has to be uploaded via Xcode/Transporter to provision the app record. Once the app exists, the REST API can do everything else.

---

## 16. Implementation priority for the MCP server (MVP → full)

Ranked by "usefulness per LOC" for a Claude-Code-driven release agent. Each row lists the user-facing tool the MCP should expose and the endpoints that back it.

### Tier 0 — Foundational plumbing (build first)

1. **JWT auth helper** — sign ES256, cache 18-min tokens.
2. **HTTP client + JSON:API serde + error mapping** — sparse `fields[*]` by default, decode `errors[].code`.
3. **Pagination follower** — auto-traverse `links.next` with safety cap.
4. **Rate-limit handler** — read `X-Rate-Limit`, sleep on 429 with `Retry-After`.

### Tier 1 — Read-only "what's the state of my release?" (~1 day)

5. `list_apps` → `GET /v1/apps` (with `filter[bundleId]`).
6. `get_app` → `GET /v1/apps/{id}` (include `appStoreVersions, builds, appInfos`).
7. `list_builds` → `GET /v1/builds?filter[app]=…&sort=-uploadedDate&limit=20`.
8. `get_build` → `GET /v1/builds/{id}` (include `preReleaseVersion, betaGroups, betaBuildLocalizations, appStoreVersion`).
9. `list_versions` → `GET /v1/apps/{id}/appStoreVersions`.
10. `get_version` → `GET /v1/appStoreVersions/{id}` (include `build, appStoreVersionLocalizations, appStoreReviewDetail`).

### Tier 2 — Author the next release (the highest-value tools)

11. `create_version` → `POST /v1/appStoreVersions`.
12. `attach_build_to_version` → `PATCH /v1/appStoreVersions/{id}/relationships/build`.
13. `upsert_version_localization` → `POST/PATCH /v1/appStoreVersionLocalizations` (one tool with create-or-update behavior keyed on `(version, locale)`).
14. `set_review_details` → `POST/PATCH /v1/appStoreReviewDetails`.
15. `submit_for_review` → `POST /v1/reviewSubmissions` + `POST /v1/reviewSubmissionItems` (one item, the version) + `PATCH /v1/reviewSubmissions/{id}` `{submitted: true}`. Bundle these as ONE tool — Claude will always want all three.
16. `get_review_status` → `GET /v1/reviewSubmissions/{id}`.
17. `cancel_review_submission` → `PATCH /v1/reviewSubmissions/{id}` `{canceled: true}`.

### Tier 3 — Visual assets (most code, but highest "wow" factor)

18. `upload_screenshot` → 3-step reservation/PUT/PATCH flow against `/v1/appScreenshots`. Needs robust MD5, multi-part, retries.
19. `create_screenshot_set` → `POST /v1/appScreenshotSets`.
20. `reorder_screenshots` → `PATCH /v1/appScreenshotSets/{id}/relationships/appScreenshots`.
21. `upload_preview` → mirror of `upload_screenshot` against `/v1/appPreviews`.
22. (Same engine handles app icon, custom-product-page assets, IAP screenshots later — keep the upload helper generic.)

### Tier 4 — TestFlight

23. `list_testflight_groups` → `GET /v1/apps/{id}/betaGroups`.
24. `add_build_to_group` → `POST /v1/betaGroups/{id}/relationships/builds`.
25. `set_whats_new_for_testers` → `POST/PATCH /v1/betaBuildLocalizations`.
26. `submit_build_for_beta_review` → `POST /v1/betaAppReviewSubmissions`.
27. `add_tester` → `POST /v1/betaTesters` (with `betaGroups` rel).

### Tier 5 — Binary upload (the headline feature)

28. `upload_ipa` → `POST /v1/buildUploads` → `POST /v1/buildUploadFiles` → multipart PUT → `PATCH /v1/buildUploadFiles/{id}` → poll `GET /v1/buildUploads/{id}`. This is the Transporter replacement and is the single biggest UX win the MCP can ship.

### Tier 6 — App configuration (covers the long tail)

29. `set_categories` → `PATCH /v1/appInfos/{id}` (relationships `primaryCategory`, etc.).
30. `set_app_info_localization` → `POST/PATCH /v1/appInfoLocalizations` (name, subtitle, privacyPolicyUrl).
31. `set_age_rating` → `PATCH /v1/ageRatingDeclarations/{id}` (forgiving on unknown fields).
32. `set_pricing` → `POST /v1/appPriceSchedules` (free or single-tier flow only for MVP).

### Tier 7 — Provisioning (only if user asks for "create-app-from-scratch")

33. `create_bundle_id`, `add_capability`, `register_device`, `create_certificate`, `create_profile`. All low complexity once auth is in place.

### Tier 8 — Deferred / out of scope for v1 MCP

- In-app purchase / subscription management (huge surface, niche use case).
- Analytics / sales reports / Power & Performance metrics.
- Game Center, Xcode Cloud, App Clips, App Custom Product Pages, A/B experiments.
- App Store Server API (different API, different auth scope — receipts/transactions).

---

## Quick reference — all endpoints I'd expose in the MCP, in one block

```
# Discovery & state
GET    /v1/apps
GET    /v1/apps/{id}
GET    /v1/apps/{id}/appStoreVersions
GET    /v1/apps/{id}/builds
GET    /v1/apps/{id}/appInfos
GET    /v1/apps/{id}/betaGroups
GET    /v1/apps/{id}/preReleaseVersions
GET    /v1/apps/{id}/reviewSubmissions

GET    /v1/builds
GET    /v1/builds/{id}

GET    /v1/appStoreVersions/{id}
GET    /v1/appStoreVersionLocalizations/{id}
GET    /v1/appInfos/{id}
GET    /v1/appInfoLocalizations/{id}
GET    /v1/ageRatingDeclarations/{id}

# Authoring a release
POST   /v1/appStoreVersions
PATCH  /v1/appStoreVersions/{id}
PATCH  /v1/appStoreVersions/{id}/relationships/build
DELETE /v1/appStoreVersions/{id}

POST   /v1/appStoreVersionLocalizations
PATCH  /v1/appStoreVersionLocalizations/{id}
DELETE /v1/appStoreVersionLocalizations/{id}

POST   /v1/appInfoLocalizations
PATCH  /v1/appInfoLocalizations/{id}
PATCH  /v1/appInfos/{id}
PATCH  /v1/ageRatingDeclarations/{id}

POST   /v1/appStoreReviewDetails
PATCH  /v1/appStoreReviewDetails/{id}
POST   /v1/appStoreReviewAttachments
PATCH  /v1/appStoreReviewAttachments/{id}

# Screenshots / previews
POST   /v1/appScreenshotSets
GET    /v1/appScreenshotSets/{id}/appScreenshots
PATCH  /v1/appScreenshotSets/{id}/relationships/appScreenshots
DELETE /v1/appScreenshotSets/{id}

POST   /v1/appScreenshots
PATCH  /v1/appScreenshots/{id}
GET    /v1/appScreenshots/{id}
DELETE /v1/appScreenshots/{id}

POST   /v1/appPreviewSets
PATCH  /v1/appPreviewSets/{id}/relationships/appPreviews
DELETE /v1/appPreviewSets/{id}

POST   /v1/appPreviews
PATCH  /v1/appPreviews/{id}
DELETE /v1/appPreviews/{id}

# Submitting for review (CURRENT model)
POST   /v1/reviewSubmissions
GET    /v1/reviewSubmissions
GET    /v1/reviewSubmissions/{id}
GET    /v1/reviewSubmissions/{id}/items
PATCH  /v1/reviewSubmissions/{id}        # body { attributes: { submitted: true } } or { canceled: true }

POST   /v1/reviewSubmissionItems
DELETE /v1/reviewSubmissionItems/{id}

POST   /v1/appStoreVersionReleaseRequests   # release a PENDING_DEVELOPER_RELEASE version

# TestFlight
POST   /v1/betaGroups
PATCH  /v1/betaGroups/{id}
POST   /v1/betaGroups/{id}/relationships/builds
DELETE /v1/betaGroups/{id}/relationships/builds
POST   /v1/betaGroups/{id}/relationships/betaTesters

POST   /v1/betaTesters
DELETE /v1/betaTesters/{id}
POST   /v1/betaTesterInvitations

POST   /v1/betaBuildLocalizations
PATCH  /v1/betaBuildLocalizations/{id}
DELETE /v1/betaBuildLocalizations/{id}

POST   /v1/betaAppReviewSubmissions
GET    /v1/betaAppReviewSubmissions/{id}
GET    /v1/betaAppReviewDetails/{id}
PATCH  /v1/betaAppReviewDetails/{id}

# Binary upload (Transporter replacement, WWDC25)
POST   /v1/buildUploads
GET    /v1/buildUploads/{id}
GET    /v1/buildUploads/{id}/buildUploadFiles
POST   /v1/buildUploadFiles
GET    /v1/buildUploadFiles/{id}
PATCH  /v1/buildUploadFiles/{id}

# Pricing
GET    /v1/apps/{id}/appPriceSchedule
GET    /v1/apps/{id}/appPricePoints
POST   /v1/appPriceSchedules

# Provisioning
GET/POST/PATCH/DELETE /v1/bundleIds[/{id}]
GET/POST/PATCH/DELETE /v1/bundleIdCapabilities[/{id}]
GET/POST/PATCH        /v1/devices[/{id}]
GET/POST/DELETE       /v1/certificates[/{id}]
GET/POST/DELETE       /v1/profiles[/{id}]
```

---

## Sources

- Apple — [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi)
- Apple — [App Store Connect API portal (overview, OpenAPI download)](https://developer.apple.com/app-store-connect/api/)
- Apple — [Generating Tokens for API Requests](https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests)
- Apple — [Identifying Rate Limits](https://developer.apple.com/documentation/appstoreconnectapi/identifying-rate-limits)
- Apple — [Build uploads](https://developer.apple.com/documentation/appstoreconnectapi/build-uploads)
- Apple — [Review Submissions](https://developer.apple.com/documentation/appstoreconnectapi/review-submissions)
- Apple — [App Store Version Submissions](https://developer.apple.com/documentation/appstoreconnectapi/app-store-version-submissions)
- Apple — [App Screenshots](https://developer.apple.com/documentation/appstoreconnectapi/app-screenshots)
- Apple — [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/)
- WWDC25 — [Automate your development process with the App Store Connect API](https://developer.apple.com/videos/play/wwdc2025/324/)
- OpenAPI mirror — [EvanBacon/App-Store-Connect-OpenAPI-Spec (latest.json, v4.3)](https://github.com/EvanBacon/App-Store-Connect-OpenAPI-Spec/blob/main/specs/latest.json)
- Runway — [A hitchhiker's guide to the App Store Connect API](https://www.runway.team/blog/a-hitchhikers-guide-to-the-app-store-connect-api)
- Runway — [How to upload assets using the App Store Connect API](https://www.runway.team/blog/how-to-upload-assets-using-the-app-store-connect-api)
- Forge — [App Store Connect API: A Practical Getting Started Guide](https://forgeasc.com/blog/app-store-connect-api-getting-started)
