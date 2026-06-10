> **⚠️ This repository has moved.** Development continues in the OpenGander monorepo:
> [github.com/opengander/opengander](https://github.com/opengander/opengander) (`packages/web-sdk`).
> This repo is kept as a read-only archive.

# OpenGander Web SDK

> [OpenGander](https://opengander.com) is privacy-first web analytics built on OpenTelemetry. [Get started free](https://opengander.com).

This is the source code for the script that runs on sites using OpenGander. You can read every line, [verify the build matches what's served](SECURITY.md#verifying-the-served-sdk), and [audit the data it collects](PRIVACY.md). The companion [browser extension](https://github.com/ChrisDBaldwin/opengander-extension) gives visitors their own copy of the telemetry. Together, they make the full [Contact Protocol](https://github.com/ChrisDBaldwin/opengander-extension/blob/main/PROTOCOL.md) auditable end to end.

This isn't a community project looking for contributors. It's a read-only reference. Fork it if you want.

## Quick Start

```html
<script src="https://app.opengander.io/sdk/opengander-sdk.js"></script>
<script>
  initOtelBrowser({
    serviceName: 'my-website',
    collectorUrl: 'https://collect.opengander.io/v1/traces',
    tokenEndpoint: 'https://token.opengander.io/api/telemetry-token',
    consent: { privacyUrl: '/privacy' }
  });
</script>
```

One script tag — consent is bundled, no build step required. This sends data to your [OpenGander dashboard](https://opengander.com), where you get real-time page views, Web Vitals, marketing attribution, and error tracking.

## What Gets Tracked

| Category | Details |
|----------|---------|
| Page views | Every page load and SPA navigation |
| Web Vitals | LCP, FID, CLS, TTFB, INP |
| Navigation timing | DNS, TCP, request, response, DOM processing |
| User interactions | Clicks and form submissions |
| Errors | JavaScript errors and unhandled promise rejections |
| Marketing attribution | UTM parameters, referrer, traffic source classification |

See [PRIVACY.md](PRIVACY.md) for the full data dictionary, what's redacted, and what's never collected.

## Configuration

```javascript
initOtelBrowser({
  serviceName: 'my-website',
  collectorUrl: 'https://collect.opengander.io/v1/traces',
  tokenEndpoint: 'https://token.opengander.io/api/telemetry-token',
  debug: false,
  sampleRate: 1.0,
  captureConsole: false,
  captureInteractions: true,
  captureWebVitals: true,
  captureErrors: true,
  requireToken: false,
  maxQueueSize: 100,
  sessionTimeout: 1800,
  customAttributes: {}
});
```

## Consent

Consent is built in and designed to stay on. The module detects the visitor's jurisdiction and shows the appropriate UI:

- **STRICT** (EU/EEA, UK, Brazil, Japan, South Korea, India, etc.) — full-page gate. No tracking until the visitor explicitly consents.
- **STANDARD** (US, Canada, Australia, etc.) — bottom banner. Still requires an explicit accept or decline.
- **Do Not Track** — honored globally. The SDK never initializes.

Detection uses `Intl.DateTimeFormat().resolvedOptions().timeZone` with `navigator.language` as a fallback. Defaults to STRICT if detection fails.

> **Note:** Timezone detection is a heuristic — VPNs and travel can cause misclassification. The SDK provides strong privacy defaults, but site operators remain responsible for their own GDPR/CCPA compliance.

### Consent Options

```javascript
consent: {
  privacyUrl: '/privacy',       // Privacy policy link (recommended; required for GDPR)
  theme: 'auto',                // 'light' | 'dark' | 'auto'
  expiry: 365,                  // Days to remember consent
  onConsent: (granted, jurisdiction) => { ... },
  text: {                       // Custom copy (optional)
    heading: null,
    body: null,
    accept: null,
    decline: null
  }
}
```

### Programmatic API

For sites with an existing consent management platform:

```javascript
OpenGanderConsent.getStatus();        // 'granted' | 'denied' | 'pending'
OpenGanderConsent.getRecord();        // Full record: status, jurisdiction, timestamp
OpenGanderConsent.getJurisdiction();  // { level, jurisdiction, signals }
OpenGanderConsent.grant();            // Set consent (e.g., from your CMP)
OpenGanderConsent.deny();             // Deny consent
OpenGanderConsent.revoke();           // Clear consent + ALL OpenGander data
OpenGanderConsent.reset();            // Re-prompt on next page load
OpenGanderConsent.show(options);      // Show consent UI standalone
```

## Custom Events

```javascript
window.otel.trackEvent('button.clicked', { 'button.id': 'signup' });
window.otel.setAttributes({ 'user.id': '12345' });
```

## How It Works

The SDK fetches a short-lived JWT (5-min TTL, bound to origin + IP) from OpenGander's token service, then sends telemetry spans to the configured OTEL collector. Events triggered before initialization are automatically queued.

```javascript
await initOtelBrowser({ ... });  // Wait for readiness
// or
window.waitForOtel(5000);        // Timeout-based check
```

Sensitive URL parameters are redacted, authorization and cookie headers are stripped, and text content is truncated to 100 characters. See [SECURITY.md](SECURITY.md) for the full list.

## Files

| File | Purpose |
|------|---------|
| `opengander-sdk.js` | Main SDK with bundled consent |
| `opengander-consent.js` | Standalone consent module (bundled into SDK — for reference) |
| `ghost-inline.html` | Self-contained version for Ghost blogs |
| `test/*.html` | Local test pages |
| [SECURITY.md](SECURITY.md) | Auditor's guide — data flow, redactions, verification |
| [PRIVACY.md](PRIVACY.md) | Data collection and privacy documentation |

## License

[MIT](LICENSE)
