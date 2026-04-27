# appstore-connect-mcp

A Model Context Protocol server that lets Claude Code drive an App Store release end-to-end:

```
xcodebuild → archive → export → upload → metadata → screenshots → submit for review
```

Claude does the work; you review the result in App Store Connect and tap **Submit for Review**.

---

## What it does

- **Discovery** — list apps, builds, versions, localizations, categories, and a one-shot `asc_release_status` "what's blocking submission" snapshot.
- **Build & upload** — `xc_archive`, `xc_export_ipa`, `asc_validate_ipa`, and `asc_upload_ipa`. Upload uses the new REST `/v1/buildUploads` flow (WWDC 2025) by default; falls back to `xcrun altool --upload-package` if you ask.
- **Versioning & metadata** — create versions, attach builds, upsert per-locale description/keywords/promotional text/what's new, set categories, set App Review demo credentials.
- **Screenshots & previews** — idempotent set-find-or-create, then chunked reservation → multipart PUT → MD5 commit. Same code path covers iPhone/iPad/Watch/TV/Vision Pro/Mac.
- **Submit for review** — full modern `reviewSubmissions` flow (the legacy `appStoreVersionSubmissions` POST is gone).
- **TestFlight** — list beta groups, set "What to test", distribute a build, submit for beta review.

39 tools total. See [`src/tools/index.ts`](src/tools/index.ts) for the registry.

## Install

Requires **Node 20+**. macOS 13+ with Xcode is needed for `xc_archive`, `xc_export_ipa`, and the `altool` upload fallback. Everything else runs cross-platform.

```bash
npm install
npm run build
```

## Configure App Store Connect credentials

Create an API key in **App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys**. The role you want for release automation is **App Manager**. Download the `.p8` file (you only get one chance).

Set these environment variables:

| Variable | Required | Notes |
|---|---|---|
| `APP_STORE_CONNECT_KEY_ID` | yes | 10-character Key ID shown next to the key |
| `APP_STORE_CONNECT_ISSUER_ID` | yes | UUID at the top of the Integrations page |
| `APP_STORE_CONNECT_PRIVATE_KEY_PATH` | one of these two | Path to the `AuthKey_<KEYID>.p8` file |
| `APP_STORE_CONNECT_PRIVATE_KEY` | | PEM contents inline (alternative to the path) |
| `APP_STORE_CONNECT_PREFER_REST_UPLOAD` | no | `true` (default) uses `/v1/buildUploads`; `false` falls back to altool |

If neither path nor inline PEM is set, the server looks in altool's canonical locations:
`~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8`,
`~/.private_keys/AuthKey_<KEYID>.p8`,
`./private_keys/AuthKey_<KEYID>.p8`,
`./AuthKey_<KEYID>.p8`.

## Wire into Claude Code

```bash
claude mcp add appstore-connect-mcp -- node /absolute/path/to/dist/index.js
```

…or add it to `~/.claude.json` directly:

```json
{
  "mcpServers": {
    "appstore-connect-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/appstore-connect-api/dist/index.js"],
      "env": {
        "APP_STORE_CONNECT_KEY_ID": "ABCDEFGHIJ",
        "APP_STORE_CONNECT_ISSUER_ID": "11111111-2222-3333-4444-555555555555",
        "APP_STORE_CONNECT_PRIVATE_KEY_PATH": "/Users/me/.appstoreconnect/private_keys/AuthKey_ABCDEFGHIJ.p8"
      }
    }
  }
}
```

Verify with:

```
> Use asc_whoami to check the App Store Connect connection.
```

## End-to-end release flow

The flow Claude follows when you say "ship 1.4.0 to the App Store":

1. **Snapshot.** `asc_release_status appId=…` returns the editable version, latest VALID build, missing localizations, missing screenshots, and a blockers list. This is the planning input for everything else.
2. **Build & upload (optional, if a fresh build is needed).**
   - `xc_archive { workspacePath, scheme, archivePath }`
   - `xc_export_ipa { archivePath, exportPath, exportOptions: { method: "app-store-connect", teamID, signingStyle, … } }`
   - `asc_validate_ipa { ipaPath, … }` (cheap pre-flight)
   - `asc_upload_ipa { ipaPath, bundleVersion, platform: "IOS" }`
   - `asc_wait_for_build_processing { appId, bundleVersion }` polls until `VALID`.
3. **Version.**
   - `asc_create_version { appId, versionString: "1.4.0", platform: "IOS", buildId }`
   - or `asc_attach_build_to_version { versionId, buildId }` if the version exists.
4. **Localizations.** For each locale call `asc_set_version_localization` with `description`, `keywords`, `whatsNew`, `promotionalText`, etc.
5. **App-level info (one-time per release window).** `asc_get_editable_app_info → asc_set_app_categories → asc_set_app_info_localization` (name, subtitle, privacy URL).
6. **Screenshots.** For each `(locale, displayType)` pair: `asc_find_or_create_screenshot_set` → loop `asc_upload_screenshot` for each PNG/JPG → optional `asc_reorder_screenshots`. Same shape for `asc_upload_preview`.
7. **Review details.** `asc_set_review_details` with contact info and demo credentials if your app has a login.
8. **Submit.** `asc_submit_for_review { appId, versionId, platform }` creates the `reviewSubmission`, adds the version as an item, and PATCHes `submitted: true`.
9. **Track.** `asc_get_review_submission { submissionId }` for state. Use `asc_release_to_store` to push a `PENDING_DEVELOPER_RELEASE` build live after Apple approves.

For TestFlight: `asc_set_beta_whats_new` → `asc_distribute_to_beta_groups` (internal-only) or `asc_submit_for_beta_review` (external testers).

See [`examples/release.example.json`](examples/release.example.json) for a sample metadata payload Claude can hydrate from.

## Known boundaries

- **No `POST /v1/apps`.** The REST API can't create a new app record from scratch. The first time you upload a build for a brand-new bundle ID, App Store Connect materializes the App row server-side; before that, you must register the bundle ID and create the App in App Store Connect's UI.
- **`xc_archive` / `xc_export_ipa` / `asc_validate_ipa`** require macOS with Xcode.
- **REST `/v1/buildUploads` (the cross-platform binary upload path, WWDC 2025)** is GA but newer than the rest of the API; if you hit a rough edge, set `APP_STORE_CONNECT_PREFER_REST_UPLOAD=false` to fall back to `xcrun altool` on macOS.
- **Rate limits.** Apple's team key has a 3,600-req/hour ceiling and an undocumented ~300/min soft cap. The client honors `Retry-After`, backs off on 429/5xx, and logs the `X-Rate-Limit` header so you can see the remaining budget.
- **JWT lifetime is 18 minutes** (Apple rejects ≥1200s). Tokens are cached and re-minted ~60s before expiry.

## Files

```
src/
  index.ts          MCP server (stdio transport)
  auth.ts           ES256 JWT minter with caching
  client.ts         JSON:API REST client w/ retry, pagination, structured error surfacing
  upload.ts         Asset reservation runner: chunked PUT + MD5 (used for screenshots, previews, builds)
  xcode.ts          xcodebuild & altool subprocess wrappers
  config.ts         Env + .p8 loader
  log.ts            Logs to stderr + ~/logs/appstore-connect-mcp/
  tools/            One file per tool family; all flow into tools/index.ts → ALL_TOOLS
test/               node:test against in-process mock servers (no real Apple traffic)
research/           Reference docs from the design phase (api-reference.md, upload-pipeline.md)
```

## Development

```bash
npm run build       # tsc → dist/
npm run dev         # tsx, hot path for iteration
npm run typecheck   # tsc --noEmit
npm test            # node --test --import tsx
```

Logs are written to `~/logs/appstore-connect-mcp/<date>.log` and mirrored to stderr.

## Sources

The implementation is based on Apple's official OpenAPI spec v4.3 and the WWDC 2025 session "Automate your development process with the App Store Connect API." Full design notes are in `research/api-reference.md` and `research/upload-pipeline.md`.
