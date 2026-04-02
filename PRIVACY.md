# Privacy & Data Collection

This document explains what data the OpenGander SDK collects, where it goes, and what protections are built in.

## What the SDK Collects

| Category | Examples |
|----------|----------|
| **Page views** | Page URL, referrer, title, SPA navigation events |
| **Web Vitals** | LCP, FID, CLS, TTFB, INP performance metrics |
| **Navigation timing** | DNS, TCP, request/response, DOM processing durations |
| **User interactions** | Click and form submit events — element tag, ID, class, text (first 100 chars), link href |
| **Errors** | JavaScript exception type, message, and stack trace |
| **Marketing attribution** | UTM parameters from the URL, referrer domain, traffic source classification |
| **Session metadata** | Random session ID, session duration, viewport size, user agent, connection type |

## What the SDK Does NOT Collect

- Passwords or form field values
- Keystrokes or input content
- Cookies or localStorage contents (other than its own consent/session keys)
- IP addresses (the SDK has no access to these; your collector may log them server-side)
- Names, emails, or any PII by default

## Where Data Goes

Telemetry is sent to the OTEL collector endpoint configured by the site operator (the `collectorUrl` parameter). The SDK authenticates via short-lived JWT tokens fetched from the configured `tokenEndpoint`. Data flows:

```
Visitor's browser → SDK → Token service (JWT) → OTEL collector
```

The SDK does not send data to any third-party service. All endpoints are controlled by the site operator's OpenGander configuration.

## Built-in Redactions

- **Sensitive URL parameters** — parameters like `token`, `password`, `key`, and `secret` are stripped from captured URLs.
- **Authorization and cookie headers** — never included in telemetry.
- **Text truncation** — interaction target text is limited to 100 characters.
- **Bot filtering** — known bots and crawlers generate no telemetry.
- **Do Not Track** — if the visitor's browser has DNT enabled, the SDK never initializes.

## Consent

The SDK includes a built-in consent module that runs before any data collection:

- **STRICT jurisdictions** (EU/EEA, UK, Brazil, Japan, South Korea, India, etc.) — full-page gate. Zero tracking until explicit consent.
- **STANDARD jurisdictions** (US, Canada, Australia, etc.) — bottom banner requiring explicit accept or decline.
- **Do Not Track** — honored globally.

Jurisdiction is detected via the visitor's timezone (`Intl.DateTimeFormat`) with language as a fallback. This is a heuristic — VPNs, travel, and timezone settings can cause misclassification.

## Operator Responsibility

The SDK provides privacy tooling as a strong default, but **site operators remain responsible for their own GDPR, CCPA, and other regulatory compliance**. Specifically:

- You should provide a privacy policy (via the `privacyUrl` config option) that discloses your use of analytics.
- If you have specific jurisdictional requirements, use the programmatic consent API to integrate with your own consent management platform.
- The timezone-based jurisdiction detection is best-effort, not a legal guarantee.
