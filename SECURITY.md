# Security

This document is a guide for security reviewers and auditors. The SDK is published as open source so you can verify exactly what runs on your site.

## Data Flow

```
Browser → SDK → Token Service (JWT) → OTEL Collector
```

1. **SDK loads** on the page via a `<script>` tag.
2. **Consent check** runs first. In STRICT jurisdictions (EU/EEA, UK, Brazil, etc.), a full-page gate blocks all tracking until the visitor explicitly consents. In STANDARD jurisdictions (US, Canada, etc.), a banner is shown. If Do Not Track is set, the SDK never initializes.
3. **Token fetch.** The SDK requests a short-lived JWT (2–5 min TTL) from the configured `tokenEndpoint`. Tokens are bound to origin and IP — they cannot be reused from a different site.
4. **Telemetry export.** Spans are sent as JSON via `fetch` with `keepalive` to the configured OTEL collector endpoint, authenticated with the JWT in an `Authorization: Bearer` header.

## What Data Is Collected

| Category | Details |
|----------|---------|
| **Page views** | URL, referrer, page title, SPA navigation events |
| **Web Vitals** | LCP, FID, CLS, TTFB, INP |
| **Navigation timing** | DNS, TCP, request, response, DOM processing durations |
| **User interactions** | Click and form submit events — tag name, element ID, class, text (truncated to 100 chars), href |
| **Errors** | Exception type, message, stack trace, filename, line/column |
| **Marketing attribution** | UTM parameters, referrer, traffic source classification |
| **Session** | Session ID (random, stored in sessionStorage), session duration |
| **Device context** | Viewport size, user agent, connection type, language |

The SDK does **not** collect: passwords, form field values (other than submit events), keystrokes, cookies, localStorage contents (other than its own consent/session keys), or any personally identifiable information by default.

## What Is Redacted

- **Sensitive URL parameters** — `token`, `password`, `key`, `secret` and similar parameters are stripped from captured URLs.
- **Authorization headers** — not included in any telemetry span.
- **Cookie headers** — not included in any telemetry span.
- **Text content** — truncated to 100 characters (`target.innerText.substring(0, 100)`).
- **Bot traffic** — known bots and crawlers are filtered out entirely and generate no telemetry.

## Consent Module

The consent module is bundled into the SDK (no separate script needed). It uses timezone-based jurisdiction detection:

- **Primary signal:** `Intl.DateTimeFormat().resolvedOptions().timeZone` mapped against a table of IANA timezone prefixes.
- **Secondary signal:** `navigator.language` as a fallback.
- **Fail-safe:** Defaults to STRICT if detection fails.

**Limitation:** Timezone detection is a heuristic. VPNs, international travel, and timezone spoofing can cause misclassification. Site operators remain responsible for their own compliance obligations.

Consent state is stored in `localStorage` under the `og_consent` key and honored on subsequent visits for the configured expiry period (default: 365 days).

## Verifying the Served SDK

To confirm the SDK served from OpenGander's CDN matches this source:

```bash
# Download the served version and compute its hash
curl -s https://app.opengander.io/sdk/opengander-sdk.js | shasum -a 256

# Compute the hash of this source file
shasum -a 256 opengander-sdk.js
```

If the hashes match, the served file is identical to this source. If they differ, the served version may include minification or patches — compare the actual content with `diff` for details.

## Reporting Security Issues

If you find a security vulnerability, please email security@opengander.io rather than opening a public issue.
