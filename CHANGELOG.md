# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **Auto-renewable subscriptions** — 12 tools: `asc_list_subscription_groups`, `asc_create_subscription_group`, `asc_set_subscription_group_localization`, `asc_create_subscription`, `asc_get_subscription`, `asc_set_subscription_localization`, `asc_list_subscription_price_points`, `asc_set_subscription_price` (base territory + auto-equalize, with `preserveCurrentPrice`), `asc_set_subscription_availability`, `asc_set_subscription_intro_offer` (free trial / pay-as-you-go / pay-up-front), `asc_upload_subscription_review_screenshot`, and `asc_submit_subscription_for_review` (group-level).
- **In-App Purchases (v2)** — 9 tools covering the full IAP path: `asc_list_in_app_purchases`, `asc_get_in_app_purchase`, `asc_create_in_app_purchase`, `asc_set_iap_localization` (upsert display name + description per locale), `asc_list_iap_price_points`, `asc_set_iap_price` (base territory + auto-equalize), `asc_set_iap_availability`, `asc_upload_iap_review_screenshot` (reuses the existing asset-upload runner), and `asc_submit_iap_for_review`.
- **App pricing** — `asc_list_app_price_points`, `asc_get_app_price_schedule`, and `asc_set_app_price` (free or paid; base territory + auto-equalize, or an explicit price point). The app's own price, distinct from in-app-purchase pricing.
- **Phased release control** — `asc_set_phased_release` enables / pauses / resumes / completes the 7-day staged rollout (`appStoreVersionPhasedRelease`), idempotently.
- **Compliance declarations** — `asc_set_content_rights` (third-party content rights on the app), plus `asc_get_age_rating` / `asc_set_age_rating` (the age-rating questionnaire; resolves the editable AppInfo + declaration, PATCHes only the fields passed, with an `additionalDeclarations` escape hatch for Apple's 2024–25 questionnaire changes).
- **App privacy** — 6 tools for the data-collection "nutrition label": `asc_list_privacy_options` (category/purpose/data-protection ids), `asc_get_privacy_details`, `asc_add_data_usage`, `asc_remove_data_usage`, `asc_declare_no_data_collected` (shortcut), and `asc_publish_privacy`.
- `asc_list_territories` — territory codes for the pricing and availability tools.
- `asc_submit_for_review` now accepts an `inAppPurchaseV2` item in `additionalItems`, so an IAP can be bundled into an app version's submission.
- `asc_release_status` now reports an `inAppPurchases` summary (count, states, and any in `MISSING_METADATA`/`DEVELOPER_ACTION_NEEDED`).
- 50 new handler tests (mock-server based) across the IAP, subscription, app-pricing, phased-release, compliance, and app-privacy handlers; full suite is 60 green.

### Notes
- New tools inherit the server's pre-live-validation status. Spec details inferred from sibling APIs are flagged with `[VERIFY]` in `src/tools/iap.ts`, `src/tools/subscriptions.ts`, `src/tools/pricing.ts`, `src/tools/compliance.ts`, and `src/tools/privacy.ts` (relationship key names, submission paths, price auto-equalization, the age-rating questionnaire, and the App Privacy data-usage / publish shapes). Remaining gaps: promotional offers, offer codes, and win-back offers.

## [0.1.0-alpha.1] — 2026-04-28

First publishable cut. The foundation works and the spec coverage is current as of Apple's OpenAPI v4.3 + WWDC 2025, but the server has not yet been exercised against the live App Store Connect API end-to-end with a real IPA. Treat as alpha until that flight test happens.

### Added
- MCP server (TypeScript, stdio transport) exposing **39 tools** across discovery, build, upload, metadata, screenshots/previews, review submission, and TestFlight.
- ES256 JWT minter with 18-minute cached tokens (Apple's hard cap is 1199s).
- JSON:API REST client with retry on 429/5xx (honors `Retry-After`), pagination via `links.next`, and structured error surfacing (code + title + JSON pointer).
- `xcodebuild archive` + `xcodebuild -exportArchive` wrappers (macOS-only).
- IPA upload via REST `/v1/buildUploads` (WWDC 2025, cross-platform), with `xcrun altool --upload-package` as the documented fallback.
- Asset reservation runner (chunked PUT + MD5 commit) shared across screenshots, previews, and the new build upload flow.
- Modern `reviewSubmissions` submission flow (the legacy `appStoreVersionSubmissions` POST is gone in v4.3).
- `asc_release_status` orchestrator: one-shot snapshot of editable version, build state, localization coverage, screenshot coverage per device class, review details, and a blockers checklist.
- `--diagnose` CLI mode: validates credentials, mints a JWT, makes a real API call, checks for Xcode/altool, and exits with a clear go/no-go.
- 10 unit tests against in-process mock servers (JWT signing, retry/pagination, JSON:API errors, no-Authorization-on-presigned-PUT, chunked upload byte ranges + MD5).
- GitHub Actions CI: typecheck + tests on push and PR.

### Known limitations
- `POST /v1/apps` does not exist in the App Store Connect REST API. First-time bundle ID registration must still happen in the App Store Connect web UI.
- `xc_archive`, `xc_export_ipa`, and `asc_validate_ipa` require macOS with Xcode.
- Two `[VERIFY]` items from the WWDC 2025 buildUploads spec — the exact `Platform` enum spelling and the full `BuildUploadFile.assetType` enum — are inferred from sibling APIs and may need adjustment when surfaced in real responses.

[Unreleased]: https://github.com/warunacds/appstore-connect-mcp/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/warunacds/appstore-connect-mcp/releases/tag/v0.1.0-alpha.1
