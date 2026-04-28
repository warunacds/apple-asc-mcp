# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [SemVer](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/your-org/appstore-connect-mcp/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/your-org/appstore-connect-mcp/releases/tag/v0.1.0-alpha.1
