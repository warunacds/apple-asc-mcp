# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately via [GitHub's "Report a vulnerability"](https://github.com/warunacds/appstore-connect-mcp/security/advisories/new)
(Security → Advisories on the repo), or email **warunacds@gmail.com** with `SECURITY` in the subject.

Include enough to reproduce: affected version, the call or code path, and the impact. You'll get an
acknowledgement within a few days. Once a fix is out, we're happy to credit you (or keep you anonymous —
your call).

## What this server touches

This MCP server authenticates to App Store Connect with an **ES256 private key (`.p8`)**. Keep that in mind
when handling it:

- **The private key never leaves your machine.** It's read locally, used only to mint short-lived JWTs
  (≤20 min) sent to Apple's API over HTTPS. It is never logged, transmitted to any third party, or written
  anywhere by this server.
- **Credentials come from your environment / config**, not from arguments echoed into chat. The server
  redacts known-sensitive argument names from its own logs, but it cannot redact what you paste into a
  prompt — don't paste your key or tokens into the conversation.
- **Logs** (under `~/logs/…`, if enabled) contain request/response metadata with secrets redacted. Review a
  log slice before attaching it to a bug report.
- **Scope your API key.** Use the least-privileged App Store Connect role that does the job (e.g. App
  Manager for releases; Admin/Finance only where pricing or user management is actually needed). Revoke and
  rotate keys you no longer use.

## Supported versions

This project is pre-1.0 (`0.x`); security fixes land on the latest released minor. Pin a version and
upgrade deliberately.
