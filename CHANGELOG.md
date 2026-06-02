# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [SemVer](https://semver.org/).

## [Unreleased]

### Documentation
- README: added a **"Use with any MCP client"** section (Codex `config.toml` + Cursor/Windsurf/VS Code/Zed
  snippets) — it's a standard stdio MCP server, not Claude-specific — plus a heads-up that the ~150-tool
  surface is cheap in lazy-loading clients (Claude Code) but token-heavy in clients that register every
  schema up front.

## [0.2.0] — 2026-06-02

First public release. Grew from 39 tools to **158**, covering nearly the entire App Store Connect API
surface, and cross-checked every write shape against Apple's OpenAPI spec. The core release/monetization
paths are live-validated against a real app; the newer domains are spec-confirmed but not yet exercised
against live Apple traffic.

### Fixed
- **OpenAPI cross-check (round-4 audit).** Validated every remaining `[VERIFY]` write shape against the
  App Store Connect OpenAPI spec and corrected the mismatches — cheaper and safer than discovering them
  via live 400s:
  - `asc_create_encryption_declaration` — used the wrong attributes (`usesEncryption`/`exempt`/`platform`,
    none of which exist). The real `appEncryptionDeclarations` create is `appDescription` plus the
    `containsProprietaryCryptography` / `containsThirdPartyCryptography` / `availableOnFrenchStore` booleans
    (all required); HTTPS-only apps answer false to both crypto flags.
  - `asc_set_app_availability` — the v2 `territoryAvailabilities` relationship references inline
    `territoryAvailabilities` resources (each carrying its own `territory` + `available`), not plain
    `territories` refs. Now built with the placeholder-id inline pattern.
  - `asc_create_webhook` — `secret` is required (Apple signs every delivery with it).
  - `asc_create_offer_code` — added the required `offerEligibility`
    (`STACK_WITH_INTRO_OFFERS` / `REPLACE_INTRO_OFFERS`) and a required price for every mode.
  - `asc_create_offer_code_one_time_codes` — `expirationDate` is required.
  - `asc_create_promotional_offer` — a price is required for every mode (previously skipped for FREE_TRIAL).
  - `asc_create_win_back_offer` — added the required customer-eligibility window
    (`customerEligibilityPaidSubscriptionDurationInMonths` + a `timeSinceLastSubscribedMonths`
    minimum/maximum range), `priority` (HIGH/NORMAL), and `startDate`, plus optional `promotionIntent`.
  - `asc_create_leaderboard` — uses `scoreSortType` (ASC/DESC), not a `sortAscending` boolean;
    `defaultFormatter` is now a validated enum.
  - `asc_create_achievement` — `showBeforeEarned` and `repeatable` are required (now always sent).
  - `asc_set_age_rating` — added the 2024–25 questionnaire fields as typed inputs (`gunsOrOtherWeapons`,
    `advertising`, `healthOrWellnessTopics`, `lootBox`, `messagingAndChat`, `parentalControls`,
    `ageAssurance`, `userGeneratedContent`) instead of relying on the `additionalDeclarations` escape hatch.
- First live run against a real App Store Connect app surfaced and corrected several `[VERIFY]` issues:
  `asc_get_app_availability` (relationship is `territoryAvailabilities`, not `availableTerritories`),
  `asc_list_encryption_declarations` (drop the unsupported `sort`), `asc_get_game_center_detail`
  (`challengeEnabled` isn't a valid field), `asc_get_app_price_schedule` (degrade gracefully when no
  price is set), `asc_list_subscription_price_points` (drop the invalid `proceedsForYear1` field),
  `asc_set_age_rating` (Apple requires the *whole* questionnaire per write — now merges onto the current
  declaration), and `asc_set_subscription_price` (omit the optional `territory`; the price point encodes it).
- Confirmed working live: auth, app/version/build/category/territory reads, `asc_set_content_rights`,
  the full IAP flow (create → localize → price → availability), and the full subscription flow (create →
  localize → availability → price). `asc_set_subscription_price` works once the subscription has
  availability set first (`asc_set_subscription_availability`) — otherwise Apple 409s on the price point.

### Removed
- **App Privacy "nutrition label" tools** (6) — verified against the App Store Connect OpenAPI spec that
  these data-collection resources are **not in the public API** (no `appDataUsage*` paths or schemas; an app
  exposes no such relationship). The data is App Store Connect UI-only, so the tools were dropped rather
  than shipped broken.

### Added
- **Product Page Optimization — A/B experiments** (8 tools) — `asc_list_experiments`, `asc_create_experiment`
  (v2 app-level: name + platform + `trafficProportion`), `asc_get_experiment` (with its treatments),
  `asc_update_experiment` (`started: true` launches it; also rename / re-weight / stop), `asc_create_experiment_treatment`
  (a variant, optional alternate `appIconName`), `asc_set_experiment_treatment_localization` (find-or-create — its id
  feeds the screenshot tools), `asc_delete_experiment_treatment`, and `asc_delete_experiment`. Submit a review-required
  experiment via `asc_submit_for_review` with an `{type:"appStoreVersionExperimentV2"}` item.
- `asc_find_or_create_screenshot_set` / `asc_find_or_create_preview_set` now also accept an
  `experimentTreatmentLocalizationId`, so experiment-treatment visuals reuse the existing upload flow (joining the
  default page and Custom Product Page parents — exactly one must be given).
- **In-App Events** (7 tools) — `asc_list_app_events`, `asc_create_app_event` (referenceName + badge / priority /
  purpose / deepLink), `asc_update_app_event` (sets `territorySchedules` — the per-territory publish/start/end
  windows), `asc_set_app_event_localization` (name + short/long description per locale), `asc_upload_app_event_screenshot`
  and `asc_upload_app_event_video_clip` (EVENT_CARD / EVENT_DETAILS_PAGE art, reusing the asset-upload runner), and
  `asc_delete_app_event`. Submit via `asc_submit_for_review` with a `{type:"appEvent"}` item.
- **Custom Product Pages** (5 tools) — `asc_list_custom_product_pages`, `asc_create_custom_product_page` (returns the
  draft version id), `asc_get_custom_product_page` (url + visibility + version + localizations),
  `asc_set_custom_product_page_localization` (promotional text per locale), and `asc_delete_custom_product_page`.
  Submit a finished version via `asc_submit_for_review` with a `{type:"appCustomProductPageVersion"}` item.
- `asc_find_or_create_screenshot_set` / `asc_find_or_create_preview_set` now accept a `customProductPageLocalizationId`
  (instead of `localizationId`) so Custom Product Page visuals reuse the existing screenshot/preview upload flow.
- **Delete tools for monetization resources** (4) — `asc_delete_in_app_purchase` (DELETE `/v2/inAppPurchases/{id}`),
  `asc_delete_subscription` (DELETE `/v1/subscriptions/{id}`), `asc_delete_subscription_group` (DELETE
  `/v1/subscriptionGroups/{id}`; the group must be empty first), and `asc_delete_win_back_offer` (DELETE
  `/v1/winBackOffers/{id}`, mirroring the existing `asc_delete_promotional_offer`). Each completes the CRUD
  surface for a resource that previously could only be created via the API. Deletes are only accepted while
  the resource is still editable (Apple rejects them once approved/in review).
- **Auto-renewable subscriptions** — 12 tools: `asc_list_subscription_groups`, `asc_create_subscription_group`, `asc_set_subscription_group_localization`, `asc_create_subscription`, `asc_get_subscription`, `asc_set_subscription_localization`, `asc_list_subscription_price_points`, `asc_set_subscription_price` (base territory + auto-equalize, with `preserveCurrentPrice`), `asc_set_subscription_availability`, `asc_set_subscription_intro_offer` (free trial / pay-as-you-go / pay-up-front), `asc_upload_subscription_review_screenshot`, and `asc_submit_subscription_for_review` (group-level).
- **In-App Purchases (v2)** — 9 tools covering the full IAP path: `asc_list_in_app_purchases`, `asc_get_in_app_purchase`, `asc_create_in_app_purchase`, `asc_set_iap_localization` (upsert display name + description per locale), `asc_list_iap_price_points`, `asc_set_iap_price` (base territory + auto-equalize), `asc_set_iap_availability`, `asc_upload_iap_review_screenshot` (reuses the existing asset-upload runner), and `asc_submit_iap_for_review`.
- **App pricing** — `asc_list_app_price_points`, `asc_get_app_price_schedule`, and `asc_set_app_price` (free or paid; base territory + auto-equalize, or an explicit price point). The app's own price, distinct from in-app-purchase pricing.
- **Phased release control** — `asc_set_phased_release` enables / pauses / resumes / completes the 7-day staged rollout (`appStoreVersionPhasedRelease`), idempotently.
- **Compliance declarations** — `asc_set_content_rights` (third-party content rights on the app), plus `asc_get_age_rating` / `asc_set_age_rating` (the age-rating questionnaire; resolves the editable AppInfo + declaration, PATCHes only the fields passed, with an `additionalDeclarations` escape hatch for Apple's 2024–25 questionnaire changes).
- **Subscription promotional offers** — 4 tools: `asc_list_promotional_offers`, `asc_create_promotional_offer` (FREE_TRIAL / PAY_AS_YOU_GO / PAY_UP_FRONT; resolves a `customerPrice` to a price point or takes an explicit `pricePointId`), `asc_add_promotional_offer_price` (per-territory), and `asc_delete_promotional_offer`. Discounts for existing/lapsed subscribers, distinct from introductory offers.
- **Provisioning / code signing** — 13 tools across bundle IDs (`asc_list_bundle_ids` / `asc_create_bundle_id` / `asc_delete_bundle_id`), capabilities (`asc_enable_bundle_capability` / `asc_disable_bundle_capability`), certificates (`asc_list_certificates` / `asc_create_certificate` / `asc_revoke_certificate`), devices (`asc_list_devices` / `asc_register_device`), and profiles (`asc_list_profiles` / `asc_create_profile` / `asc_delete_profile`).
- **Submission gates** — `asc_get_app_availability` / `asc_set_app_availability` (territories the app is sold in) and `asc_list_encryption_declarations` / `asc_create_encryption_declaration` / `asc_assign_encryption_declaration` (export compliance).
- **Customer reviews** — `asc_list_customer_reviews`, `asc_get_customer_review`, `asc_respond_to_review` (upsert the developer response), and `asc_delete_review_response`.
- **Subscription offer codes & win-back offers** — `asc_list_offer_codes`, `asc_create_offer_code`, `asc_create_offer_code_custom_codes`, `asc_create_offer_code_one_time_codes`, plus `asc_list_win_back_offers` / `asc_create_win_back_offer`.
- **Webhooks** — `asc_list_webhooks` / `asc_create_webhook` / `asc_update_webhook` / `asc_delete_webhook`, plus `asc_ping_webhook` and `asc_list_webhook_deliveries`.
- **Users & access** — `asc_list_users` / `asc_get_user` / `asc_update_user` and `asc_list_user_invitations` / `asc_invite_user` / `asc_cancel_user_invitation` (Admin key required).
- **Xcode Cloud** — `asc_list_ci_products`, `asc_list_ci_workflows`, `asc_get_ci_workflow`, `asc_start_ci_build`, `asc_list_ci_build_runs`, `asc_get_ci_build_run`.
- **Reporting** — `asc_get_sales_report` / `asc_get_finance_report` (gzipped-TSV download via a new `client.getRaw`, parsed to rows) and `asc_request_analytics_report` / `asc_list_analytics_reports`.
- **Game Center** — `asc_get_game_center_detail`, achievements (`asc_list_achievements` / `asc_create_achievement` / `asc_set_achievement_localization`), and leaderboards (`asc_list_leaderboards` / `asc_create_leaderboard` / `asc_set_leaderboard_localization`).
- **Alternative distribution (EU DMA)** — `asc_get_alt_distribution_key` / `asc_create_alt_distribution_key`, `asc_list_alt_distribution_packages`, and `asc_list_marketplace_domains` / `asc_create_marketplace_domain`.
- `client.getRaw` — authenticated raw-bytes GET, added to support gzipped report downloads.
- `asc_list_territories` — territory codes for the pricing and availability tools.
- `asc_submit_for_review` now accepts an `inAppPurchaseV2` item in `additionalItems`, so an IAP can be bundled into an app version's submission.
- `asc_release_status` now reports an `inAppPurchases` summary (count, states, and any in `MISSING_METADATA`/`DEVELOPER_ACTION_NEEDED`).
- 85 new handler tests (mock-server based) across all the new tool families, plus a `client.getRaw` test; full suite is 95 green.

### Notes
- New tools inherit the server's pre-live-validation status; spec details inferred from sibling APIs are flagged `[VERIFY]` throughout `src/tools/`. The six newest domains are the least certain: **reporting** (filter names; Sales/Finance return gzipped TSV — needs the ACCESS_TO_REPORTS role, Finance needs Finance/Admin), **users & access** (Admin key required; role enum), **Xcode Cloud** (git-reference relationship), **Game Center** (attribute shapes), **webhooks** (event-type values), and **alternative distribution** (EU-DMA, newest/most speculative).
- The App Store Connect API surface is now broadly covered end to end (release, monetization, compliance, provisioning, CI, reporting, Game Center, webhooks, team access, EU distribution). App Privacy "nutrition label" data is not in the public API (UI-only). Everything remains alpha until exercised against live Apple traffic.

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

[Unreleased]: https://github.com/warunacds/app-store-connect-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/warunacds/app-store-connect-mcp/compare/v0.1.0-alpha.1...v0.2.0
[0.1.0-alpha.1]: https://github.com/warunacds/app-store-connect-mcp/releases/tag/v0.1.0-alpha.1
