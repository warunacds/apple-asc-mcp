# Contributing

Thanks for considering a contribution. This project's goal is to let Claude drive an App Store release end-to-end without human babysitting; everything else is in service of that.

## Development

```bash
git clone https://github.com/warunacds/appstore-connect-mcp
cd appstore-connect-mcp
npm install
npm run build
npm test
```

`npm run dev` runs the server through `tsx` for fast iteration. `npm run diagnose` runs the credential / Xcode preflight.

## Style

- TypeScript, strict mode, `noUncheckedIndexedAccess`. Don't introduce `any`; prefer narrow types or `unknown` + a parser.
- One tool per logical operation. Tools live under `src/tools/` and register through `src/tools/index.ts`. New tools go in the file whose name matches their family (`discovery.ts`, `metadata.ts`, `screenshots.ts`, `reviews.ts`, `testflight.ts`, `upload.ts`, `xcode_tools.ts`, `status.ts`).
- Tool descriptions are read by Claude, not humans. Be concrete: what it does, what it requires, what it returns. Mention sister tools by name (`Use asc_find_or_create_screenshot_set first to get setId.`).
- Inputs are zod schemas with `.strict()` so typos in arg names surface as errors. Use `.describe()` liberally — Claude relies on those hints.
- Don't add comments that restate code. Comments earn their place by explaining *why* (a hidden constraint, a workaround, an Apple quirk that would surprise a reader).

## Testing

Unit tests are `node --test` against in-process mock HTTP servers in `test/`. They cover the load-bearing pieces: JWT signing, retry/pagination, asset upload byte ranges + MD5, JSON:API error surfacing.

Before opening a PR:

```bash
npm run typecheck
npm test
```

If you add a new tool that talks to the API, add a unit test against a mock server. If your change touches `auth.ts`, `client.ts`, or `upload.ts` (the foundation), tests are mandatory.

## Adding a new tool

1. Find the right file under `src/tools/`. Add the tool with `tool({ name, description, inputSchema, handler })`.
2. Export it from that file.
3. Import and add it to the array in `src/tools/index.ts`.
4. Add a row to the tool reference table in `README.md`.
5. If the tool calls a previously-untouched endpoint, write a short test that mocks the JSON:API response.

## Commit messages

Imperative mood, ≤72 chars on the subject line. Body explains the *why* and any non-obvious decision. Keep one logical change per commit.

## Reporting issues

Please include: the tool name, the input you sent (redact secrets), the full error message including the JSON:API `code` and `pointer`, the App Store Connect API key role, and your Node + Xcode versions.

`~/logs/appstore-connect-mcp/<date>.log` has the full request/response trail (with secrets redacted) — attaching the relevant slice is hugely helpful.

## Releases

Maintainers only. The release flow is:

```bash
npm run typecheck && npm test && npm run build
# Bump version in package.json + CHANGELOG.md
git tag vX.Y.Z
git push --tags
npm publish
```

`prepublishOnly` runs typecheck + build + tests automatically.
