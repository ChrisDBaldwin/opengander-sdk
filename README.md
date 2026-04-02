# OpenGander Web SDK

Browser-based Real User Monitoring SDK that tracks page views, SPA navigation, Web Vitals, user interactions, errors, and marketing attribution via OpenTelemetry.

This is the source code for the script that runs on sites using [OpenGander](https://opengander.io). It's published here so you can read exactly what it does.

## Why Open Source?

This repo exists for transparency. The SDK runs on your site, in your visitors' browsers — you should be able to read every line of it. This isn't a community project looking for contributors; it's a read-only reference so you can verify what the code does, audit the data it collects, and confirm it matches what's served from our CDN. Fork it if you want. The companion [browser extension](https://github.com/opengander/opengander-extension) is published for the same reason.

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

One script tag is all you need — consent is bundled.

## What Gets Tracked

- **Page views** — every page load and SPA navigation
- **Web Vitals** — LCP, FID, CLS, TTFB, INP
- **Navigation timing** — DNS, TCP, request, response, DOM processing
- **User interactions** — clicks and form submissions
- **Errors** — JavaScript errors and unhandled promise rejections
- **Marketing attribution** — UTM parameters, referrer, traffic source classification

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
  sessionTimeout: 1800,   // 30 min default
  customAttributes: {}
});
```

## Consent

Consent is built into the SDK — best-effort, default-on. It is enabled by default and designed to be kept on. The consent module detects the visitor's jurisdiction and shows the appropriate UI:

- **STRICT** jurisdictions (EU/EEA, UK, Brazil, Japan, South Korea, India, etc.) — full-page gate. No tracking until the visitor explicitly consents.
- **STANDARD** jurisdictions (US, Canada, Australia, etc.) — bottom banner. Non-intrusive but still requires an explicit accept or decline.
- **Do Not Track** — honored globally. The SDK never initializes.

Jurisdiction detection uses `Intl.DateTimeFormat().resolvedOptions().timeZone` (primary) and `navigator.language` (secondary). Defaults to STRICT if detection fails (fail-safe).

**Important:** Timezone-based jurisdiction detection is a heuristic, not a legal guarantee. VPNs, international travel, and timezone spoofing can cause misclassification. The SDK provides privacy tooling as a strong default, but site operators remain responsible for their own GDPR/CCPA compliance. If your site has specific regulatory requirements, use the programmatic API above to integrate with your own consent management platform.

### Consent Configuration

```javascript
initOtelBrowser({
  serviceName: 'my-site',
  collectorUrl: '...',
  consent: {
    privacyUrl: '/privacy',   // Link to privacy policy (recommended)
    theme: 'auto',            // 'light' | 'dark' | 'auto' (default: 'auto')
    expiry: 365,              // Days to remember consent (default: 365)
    onConsent: (granted, jurisdiction) => { ... },
    text: {                   // Custom copy (optional)
      heading: null,
      body: null,
      accept: null,
      decline: null
    }
  }
});
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

## Custom Event Tracking

```javascript
window.otel.trackEvent('button.clicked', { 'button.id': 'signup' });
window.otel.setAttributes({ 'user.id': '12345' });
```

## How It Works

The SDK initializes asynchronously and fetches a short-lived JWT (5-min TTL) from OpenGander's token service before sending telemetry. Events triggered before initialization completes are automatically queued. Use `await initOtelBrowser()` if you need to guarantee readiness, or `window.waitForOtel(timeout)` for a timeout-based check.

Privacy is built in: the SDK redacts sensitive URL parameters (token, password, key, secret), strips authorization and cookie headers, and limits text content to 100 characters.

## Design Decisions

- **Vanilla JavaScript, no build step.** Single `.js` file that works anywhere — Ghost blogs, static HTML, SPAs. No TypeScript, no bundler, no npm install.
- **Token-based auth over API keys.** Short-lived JWTs bound to origin + IP replace static API keys that anyone could copy.
- **Ghost inline variant.** `ghost-inline.html` bundles everything into a single paste-able `<script>` block for Ghost's code injection.

## Files

| File | Purpose |
|------|---------|
| `opengander-sdk.js` | Main SDK with bundled consent |
| `opengander-consent.js` | Standalone consent module (bundled into the SDK — provided for reference) |
| `ghost-inline.html` | Self-contained version for Ghost blogs |
| `test-*.html` | Local test pages for development |

## License

[MIT](LICENSE)
