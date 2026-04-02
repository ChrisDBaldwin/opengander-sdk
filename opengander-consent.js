/**
 * OpenGander Consent Module — Standalone Version
 *
 * NOTE: Consent is bundled into opengander-sdk.js by default. You do NOT
 * need this file for normal installations. This standalone version exists
 * for demos, custom CMP integrations, or environments where the bundled
 * SDK cannot be used.
 *
 * If the bundled SDK has already loaded, this file is a no-op (double-load
 * guard via window.__ogConsentLoaded).
 *
 * Behavior:
 *   - STRICT jurisdictions (EU/EEA, UK, Brazil, etc.) → Full-page gate.
 *     No tracking whatsoever until the visitor explicitly consents.
 *   - STANDARD jurisdictions (US, Canada, Australia, etc.) → Bottom banner.
 *     Non-intrusive but still requires an explicit accept or decline.
 *   - Do Not Track → Honored globally. SDK never initializes.
 *
 * Usage (standalone only — not needed with opengander-sdk.js):
 *   <script src="opengander-sdk.js"></script>
 *   <script src="opengander-consent.js"></script>
 *   <script>
 *     initOtelBrowser({
 *       serviceName: 'my-site',
 *       collectorUrl: 'https://otel.example.com/v1/traces',
 *       tokenEndpoint: '/api/telemetry-token',
 *       consent: {
 *         privacyUrl: '/privacy',
 *         theme: 'auto',
 *         expiry: 365,
 *         onConsent: null,
 *         text: { heading: null, body: null, accept: null, decline: null }
 *       }
 *     });
 *   </script>
 */

(function() {
  'use strict';

  // Double-load guard: if the bundled SDK already loaded consent, skip
  if (window.__ogConsentLoaded) return;
  window.__ogConsentLoaded = true;

  var CONSENT_STORAGE_KEY = 'og_consent';
  var _debugEnabled = false;

  // ─── Jurisdiction Detection ─────────────────────────────────────────

  /**
   * Consent levels:
   *   'strict' → Full-page gate (GDPR, LGPD, POPIA, etc.)
   *   'standard' → Banner (CCPA, PIPEDA, APPs, etc.)
   *
   * The customer does NOT choose. The visitor's location determines this.
   */

  // IANA timezone → jurisdiction mapping
  // Timezones that require strict (gate) consent
  var STRICT_TIMEZONE_PREFIXES = [
    // EU / EEA member states
    'Europe/',           // All of Europe (covers EU, EEA, UK, Switzerland)

    // Brazil (LGPD)
    'America/Sao_Paulo', 'America/Noronha', 'America/Bahia', 'America/Fortaleza',
    'America/Recife', 'America/Araguaina', 'America/Maceio', 'America/Belem',
    'America/Santarem', 'America/Porto_Velho', 'America/Boa_Vista',
    'America/Manaus', 'America/Cuiaba', 'America/Campo_Grande',
    'America/Rio_Branco', 'America/Eirunepe',

    // South Africa (POPIA)
    'Africa/Johannesburg',

    // South Korea (PIPA)
    'Asia/Seoul',

    // Japan (APPI)
    'Asia/Tokyo',

    // India (DPDPA 2023)
    'Asia/Kolkata', 'Asia/Calcutta',

    // Thailand (PDPA)
    'Asia/Bangkok',

    // Singapore (PDPA)
    'Asia/Singapore',

    // UAE / Middle East with strict data protection
    'Asia/Dubai',

    // Kenya (Data Protection Act)
    'Africa/Nairobi',

    // Nigeria (NDPR)
    'Africa/Lagos',

    // Argentina (PDPL)
    'America/Argentina/',

    // Chile
    'America/Santiago',

    // Colombia
    'America/Bogota',

    // Iceland (EEA)
    'Atlantic/Reykjavik'
  ];

  // Language codes that suggest strict jurisdiction (secondary signal)
  var STRICT_LANGUAGE_PREFIXES = [
    'de', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'cs', 'sk', 'hu', 'ro',
    'bg', 'hr', 'sl', 'et', 'lv', 'lt', 'fi', 'sv', 'da', 'el', 'ga',
    'mt', 'no', 'is', 'ko', 'ja', 'th', 'hi', 'ta', 'te', 'mr', 'bn'
  ];

  /**
   * Detect the visitor's jurisdiction and return the consent level.
   *
   * Returns: { level: 'strict'|'standard', jurisdiction: string, signals: object }
   */
  function detectJurisdiction() {
    // Testing-only: jurisdiction override requires debug: true in SDK config
    if (_debugEnabled && window.__ogJurisdictionOverride) {
      return window.__ogJurisdictionOverride;
    }

    var signals = {
      timezone: null,
      language: null,
      languages: []
    };

    // Signal 1: Timezone (most reliable — hard to spoof accidentally)
    try {
      signals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
      // Intl not supported
    }

    // Signal 2: Language
    signals.language = navigator.language || '';
    signals.languages = Array.from(navigator.languages || []);

    // ── Evaluate timezone ──
    if (signals.timezone) {
      var tzMatch = STRICT_TIMEZONE_PREFIXES.some(function(prefix) {
        return signals.timezone.indexOf(prefix) === 0;
      });

      if (tzMatch) {
        return {
          level: 'strict',
          jurisdiction: signals.timezone,
          signals: signals
        };
      }

      // If we got a valid timezone and it's NOT in strict list → standard
      return {
        level: 'standard',
        jurisdiction: signals.timezone,
        signals: signals
      };
    }

    // ── Fallback: Language-based detection ──
    var langCode = signals.language.split('-')[0].toLowerCase();
    var langMatch = STRICT_LANGUAGE_PREFIXES.some(function(prefix) {
      return langCode === prefix;
    });

    if (langMatch) {
      return {
        level: 'strict',
        jurisdiction: 'lang:' + signals.language,
        signals: signals
      };
    }

    // ── No signals or ambiguous → default to STRICT (fail-safe) ──
    // Better to over-protect than under-protect
    if (!signals.timezone && !signals.language) {
      return {
        level: 'strict',
        jurisdiction: 'unknown',
        signals: signals
      };
    }

    return {
      level: 'standard',
      jurisdiction: signals.timezone || 'lang:' + signals.language,
      signals: signals
    };
  }

  // ─── Consent State Management ───────────────────────────────────────

  function getStoredConsent() {
    try {
      var raw = localStorage.getItem(CONSENT_STORAGE_KEY);
      if (!raw) return null;

      var consent = JSON.parse(raw);

      // Check expiry
      var stored = new Date(consent.timestamp);
      var expiryMs = (consent.expiry || 365) * 24 * 60 * 60 * 1000;
      if (Date.now() - stored.getTime() > expiryMs) {
        localStorage.removeItem(CONSENT_STORAGE_KEY);
        return null;
      }

      return consent;
    } catch (e) {
      return null;
    }
  }

  function storeConsent(status, expiryDays, jurisdiction, consentLevel) {
    try {
      localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify({
        status: status,
        timestamp: new Date().toISOString(),
        expiry: expiryDays,
        jurisdiction: jurisdiction,
        consentLevel: consentLevel,
        version: 1  // Schema version for future migrations
      }));
    } catch (e) {
      // localStorage unavailable — consent is session-only
    }
  }

  function checkDNT() {
    return navigator.doNotTrack === '1' ||
           navigator.doNotTrack === 'yes' ||
           window.doNotTrack === '1';
  }

  // ─── Goose SVG ──────────────────────────────────────────────────────

  function getGooseSVG(size) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" ' +
      'width="' + size + '" height="' + size + '" role="img" aria-label="OpenGander goose mascot">' +
      '<ellipse cx="60" cy="78" rx="30" ry="24" fill="#F8F9FA" stroke="#374151" stroke-width="2"/>' +
      '<path d="M52 58 Q48 38 42 28 Q38 20 44 16" fill="none" stroke="#F8F9FA" stroke-width="12"/>' +
      '<path d="M52 58 Q48 38 42 28 Q38 20 44 16" fill="none" stroke="#374151" stroke-width="2"/>' +
      '<circle cx="44" cy="16" r="10" fill="#F8F9FA" stroke="#374151" stroke-width="2"/>' +
      '<circle cx="41" cy="14" r="2.5" fill="#374151"/>' +
      '<circle cx="40.5" cy="13.5" r="0.8" fill="#FFFFFF"/>' +
      '<path d="M34 17 L26 19 L34 21 Z" fill="#F59E0B" stroke="#D97706" stroke-width="1"/>' +
      '<path d="M55 65 Q72 60 80 70 Q75 80 58 78" fill="#E5E7EB" stroke="#374151" stroke-width="1.5"/>' +
      '<path d="M48 100 L42 108 L52 108 Z" fill="#F59E0B" stroke="#D97706" stroke-width="1"/>' +
      '<path d="M68 100 L62 108 L72 108 Z" fill="#F59E0B" stroke="#D97706" stroke-width="1"/>' +
      '<rect x="70" y="50" width="18" height="24" rx="2" fill="#FEF3C7" stroke="#D97706" stroke-width="1.5"/>' +
      '<rect x="74" y="48" width="10" height="5" rx="1" fill="none" stroke="#D97706" stroke-width="1.5"/>' +
      '<line x1="74" y1="58" x2="84" y2="58" stroke="#D97706" stroke-width="1" opacity="0.5"/>' +
      '<line x1="74" y1="62" x2="84" y2="62" stroke="#D97706" stroke-width="1" opacity="0.5"/>' +
      '<line x1="74" y1="66" x2="80" y2="66" stroke="#D97706" stroke-width="1" opacity="0.5"/>' +
      '</svg>';
  }

  // ─── Styles ─────────────────────────────────────────────────────────

  function injectStyles(position, theme) {
    var isDark = theme === 'dark' ||
      (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    var colors = isDark ? {
      bg: '#1F2937', text: '#F9FAFB', textMuted: '#9CA3AF', border: '#374151',
      acceptBg: '#F59E0B', acceptText: '#1F2937', acceptHover: '#D97706',
      declineBg: 'transparent', declineText: '#9CA3AF', declineBorder: '#4B5563',
      overlay: 'rgba(0, 0, 0, 0.7)', tagBg: '#374151'
    } : {
      bg: '#FFFFFF', text: '#1F2937', textMuted: '#6B7280', border: '#E5E7EB',
      acceptBg: '#F59E0B', acceptText: '#1F2937', acceptHover: '#D97706',
      declineBg: 'transparent', declineText: '#6B7280', declineBorder: '#D1D5DB',
      overlay: 'rgba(0, 0, 0, 0.5)', tagBg: '#F3F4F6'
    };

    var style = document.createElement('style');
    style.id = 'og-consent-styles';
    style.textContent =
      '[class^="og-consent"] { box-sizing: border-box; margin: 0; padding: 0; }' +
      '[class^="og-consent"] * { box-sizing: border-box; margin: 0; padding: 0; }' +

      '.og-consent-banner {' +
        'position: fixed;' +
        (position === 'top' ? 'top: 0;' : 'bottom: 0;') +
        'left: 0; right: 0; z-index: 2147483647;' +
        'background: ' + colors.bg + ';' +
        'border-' + (position === 'top' ? 'bottom' : 'top') + ': 1px solid ' + colors.border + ';' +
        'box-shadow: 0 -4px 20px rgba(0,0,0,0.1);' +
        'padding: 16px 24px;' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
        'animation: og-slide-in 0.3s ease-out;' +
      '}' +

      '.og-consent-banner-inner {' +
        'max-width: 1200px; margin: 0 auto;' +
        'display: flex; align-items: center; gap: 16px; flex-wrap: wrap;' +
      '}' +

      '.og-consent-gate {' +
        'position: fixed; top: 0; left: 0; right: 0; bottom: 0;' +
        'z-index: 2147483647;' +
        'background: ' + colors.overlay + ';' +
        'display: flex; align-items: center; justify-content: center;' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
        'animation: og-fade-in 0.3s ease-out;' +
      '}' +

      '.og-consent-gate-card {' +
        'background: ' + colors.bg + ';' +
        'border-radius: 16px; padding: 40px;' +
        'max-width: 480px; width: 90%; text-align: center;' +
        'box-shadow: 0 25px 50px rgba(0,0,0,0.25);' +
        'animation: og-scale-in 0.3s ease-out;' +
      '}' +

      '.og-consent-goose { flex-shrink: 0; animation: og-waddle 2s ease-in-out infinite; }' +
      '.og-consent-text { flex: 1; min-width: 200px; }' +

      '.og-consent-heading {' +
        'font-size: 16px; font-weight: 600; color: ' + colors.text + ';' +
        'margin-bottom: 4px; line-height: 1.4;' +
      '}' +

      '.og-consent-body {' +
        'font-size: 14px; color: ' + colors.textMuted + '; line-height: 1.5;' +
      '}' +
      '.og-consent-body a { color: ' + colors.acceptBg + '; text-decoration: underline; }' +

      '.og-consent-gate .og-consent-heading { font-size: 22px; margin-bottom: 8px; }' +
      '.og-consent-gate .og-consent-body { font-size: 15px; margin-bottom: 24px; }' +

      '.og-consent-actions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; }' +
      '.og-consent-gate .og-consent-actions { justify-content: center; gap: 12px; }' +

      '.og-consent-btn {' +
        'padding: 8px 20px; border-radius: 8px; font-size: 14px;' +
        'font-weight: 500; cursor: pointer; border: none;' +
        'transition: all 0.15s ease; line-height: 1.4; white-space: nowrap;' +
      '}' +

      '.og-consent-btn-accept { background: ' + colors.acceptBg + '; color: ' + colors.acceptText + '; }' +
      '.og-consent-btn-accept:hover { background: ' + colors.acceptHover + '; transform: scale(1.02); }' +

      '.og-consent-btn-decline {' +
        'background: ' + colors.declineBg + '; color: ' + colors.declineText + ';' +
        'border: 1px solid ' + colors.declineBorder + ';' +
      '}' +
      '.og-consent-btn-decline:hover { opacity: 0.8; }' +

      '.og-consent-details {' +
        'font-size: 12px; color: ' + colors.textMuted + ';' +
        'margin-top: 12px; padding-top: 12px;' +
        'border-top: 1px solid ' + colors.border + '; text-align: left;' +
      '}' +
      '.og-consent-details span {' +
        'display: inline-block; margin: 2px 4px; padding: 2px 8px;' +
        'border-radius: 4px; background: ' + colors.tagBg + '; font-size: 11px;' +
      '}' +

      '.og-consent-powered {' +
        'font-size: 11px; color: ' + colors.textMuted + '; margin-top: 12px; opacity: 0.7;' +
      '}' +
      '.og-consent-powered a { color: inherit; text-decoration: none; }' +
      '.og-consent-powered a:hover { text-decoration: underline; }' +

      // Jurisdiction badge (shows in debug / gate mode)
      '.og-consent-jurisdiction {' +
        'font-size: 10px; color: ' + colors.textMuted + ';' +
        'margin-top: 8px; opacity: 0.5;' +
      '}' +

      '@keyframes og-slide-in {' +
        'from { transform: translateY(' + (position === 'top' ? '-100%' : '100%') + '); }' +
        'to { transform: translateY(0); }' +
      '}' +
      '@keyframes og-fade-in { from { opacity: 0; } to { opacity: 1; } }' +
      '@keyframes og-scale-in { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }' +
      '@keyframes og-waddle {' +
        '0%, 100% { transform: rotate(0deg); }' +
        '25% { transform: rotate(3deg); }' +
        '75% { transform: rotate(-3deg); }' +
      '}' +

      // Extension CTA styles
      '.og-contact-invite {' +
        'max-width: 1200px; margin: 0 auto; padding: 12px 24px 4px;' +
        'display: flex; align-items: center; justify-content: center; gap: 8px;' +
        'animation: og-fade-in 0.3s ease-out;' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
      '}' +
      '.og-contact-invite-text {' +
        'font-size: 13px; color: ' + colors.textMuted + ';' +
      '}' +
      '.og-contact-invite a {' +
        'color: ' + colors.acceptBg + '; text-decoration: underline; font-weight: 500;' +
      '}' +
      '.og-contact-invite a:hover { color: ' + colors.acceptHover + '; }' +
      '.og-contact-invite-close {' +
        'background: none; border: none; color: ' + colors.textMuted + ';' +
        'cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1; opacity: 0.6;' +
      '}' +
      '.og-contact-invite-close:hover { opacity: 1; }' +

      '@media (max-width: 640px) {' +
        '.og-consent-banner-inner { flex-direction: column; text-align: center; }' +
        '.og-consent-actions { width: 100%; justify-content: center; }' +
        '.og-consent-gate-card { padding: 24px; }' +
      '}';

    document.head.appendChild(style);
  }

  // ─── Extension CTA ──────────────────────────────────────────────────

  var CONTACT_INVITE_SEEN_KEY = 'og_contact_invite_seen';

  /**
   * Show post-consent extension CTA if:
   * - extensionUrl is configured (opt-in by site owner)
   * - Extension is not already installed (no window.__contact)
   * - User hasn't dismissed it before
   *
   * @param {HTMLElement} container - Element to append the CTA to
   * @param {string} extensionUrl - Chrome Web Store URL
   * @param {function} onDismiss - Called after CTA is removed (for cleanup)
   */
  function showExtensionCTA(container, extensionUrl, onDismiss) {
    // Skip if not configured
    if (!extensionUrl) return false;

    // Skip if extension already installed
    if (window.__contact) return false;

    // Skip if previously dismissed
    try {
      if (localStorage.getItem(CONTACT_INVITE_SEEN_KEY)) return false;
    } catch (e) { /* localStorage unavailable */ }

    var cta = document.createElement('div');
    cta.className = 'og-contact-invite';
    cta.innerHTML =
      '<span class="og-contact-invite-text">' +
        'Want your own copy of this data? <a class="og-contact-invite-link" target="_blank" rel="noopener">Get the extension</a>' +
      '</span>' +
      '<button class="og-contact-invite-close" aria-label="Dismiss" data-action="dismiss-cta">&times;</button>';

    cta.querySelector('.og-contact-invite-link').href = extensionUrl;

    cta.querySelector('[data-action="dismiss-cta"]').addEventListener('click', function() {
      try { localStorage.setItem(CONTACT_INVITE_SEEN_KEY, '1'); } catch (e) {}
      cta.style.animation = 'og-fade-in 0.2s ease-in reverse';
      setTimeout(function() {
        cta.remove();
        if (onDismiss) onDismiss();
      }, 200);
    });

    container.appendChild(cta);
    return true;
  }

  // ─── Render ─────────────────────────────────────────────────────────

  function renderBanner(consentConfig, onAccept, onDecline) {
    injectStyles('bottom', consentConfig.theme);

    var heading = consentConfig.text.heading || 'Honk! Quick heads-up.';
    var body = consentConfig.text.body ||
      'This site uses <strong>OpenGander</strong> to understand page performance and how visitors find us. ' +
      'We collect page views, load times, and traffic sources \u2014 <strong>no personal info, no cross-site tracking</strong>.' +
      (consentConfig.privacyUrl ? ' <a href="' + consentConfig.privacyUrl + '">Learn more</a>.' : '');
    var acceptText = consentConfig.text.accept || 'Sounds good';
    var declineText = consentConfig.text.decline || 'No thanks';

    var el = document.createElement('div');
    el.className = 'og-consent-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Analytics consent');

    el.innerHTML =
      '<div class="og-consent-banner-inner">' +
        '<div class="og-consent-goose">' + getGooseSVG(56) + '</div>' +
        '<div class="og-consent-text">' +
          '<div class="og-consent-heading"></div>' +
          '<div class="og-consent-body"></div>' +
        '</div>' +
        '<div class="og-consent-actions">' +
          '<button class="og-consent-btn og-consent-btn-accept" data-action="accept"></button>' +
          '<button class="og-consent-btn og-consent-btn-decline" data-action="decline"></button>' +
        '</div>' +
      '</div>';

    el.querySelector('.og-consent-heading').textContent = heading;
    // body accepts trusted HTML (defaults include <strong> tags and links)
    el.querySelector('.og-consent-body').innerHTML = body;
    el.querySelector('[data-action="accept"]').textContent = acceptText;
    el.querySelector('[data-action="decline"]').textContent = declineText;

    el.querySelector('[data-action="accept"]').addEventListener('click', function() {
      onAccept();
      // Show extension CTA if configured, then dismiss
      var ctaShown = showExtensionCTA(el, consentConfig.extensionUrl, function() {
        el.style.animation = 'og-slide-in 0.2s ease-in reverse';
        setTimeout(function() { el.remove(); }, 200);
      });
      if (!ctaShown) {
        el.style.animation = 'og-slide-in 0.2s ease-in reverse';
        setTimeout(function() { el.remove(); }, 200);
      } else {
        // Hide the consent content, keep the banner for CTA
        el.querySelector('.og-consent-banner-inner').style.display = 'none';
        // Auto-dismiss after 8 seconds
        setTimeout(function() {
          if (el.parentNode) {
            el.style.animation = 'og-slide-in 0.2s ease-in reverse';
            setTimeout(function() { el.remove(); }, 200);
          }
        }, 8000);
      }
    });

    el.querySelector('[data-action="decline"]').addEventListener('click', function() {
      el.style.animation = 'og-slide-in 0.2s ease-in reverse';
      setTimeout(function() { el.remove(); }, 200);
      onDecline();
    });

    document.body.appendChild(el);
  }

  function renderGate(consentConfig, jurisdiction, onAccept, onDecline) {
    injectStyles('bottom', consentConfig.theme);

    var heading = consentConfig.text.heading || 'Before you come in...';
    var body = consentConfig.text.body ||
      'This site uses <strong>OpenGander</strong> analytics to measure page performance and understand how visitors arrive. ' +
      'Here\u2019s exactly what we track:';
    var acceptText = consentConfig.text.accept || 'That\u2019s fine, let me in';
    var declineText = consentConfig.text.decline || 'I\u2019d rather not';

    var el = document.createElement('div');
    el.className = 'og-consent-gate';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Analytics consent');

    el.innerHTML =
      '<div class="og-consent-gate-card">' +
        '<div class="og-consent-goose" style="margin-bottom: 16px;">' + getGooseSVG(80) + '</div>' +
        '<div class="og-consent-heading"></div>' +
        '<div class="og-consent-body"></div>' +
        '<div class="og-consent-details">' +
          '<span>Page views</span>' +
          '<span>Load times</span>' +
          '<span>Traffic source</span>' +
          '<span>Device type</span>' +
          '<span>JS errors</span>' +
          '<span>Click events</span>' +
        '</div>' +
        '<div class="og-consent-details" style="border-top: none; padding-top: 4px; font-style: italic;">' +
          'No names, emails, passwords, or personal info. Ever.' +
        '</div>' +
        '<div class="og-consent-actions" style="margin-top: 20px;">' +
          '<button class="og-consent-btn og-consent-btn-accept" data-action="accept"></button>' +
          '<button class="og-consent-btn og-consent-btn-decline" data-action="decline"></button>' +
        '</div>' +
        '<div class="og-consent-powered">Powered by <a href="https://opengander.com" target="_blank" rel="noopener">OpenGander</a></div>' +
        '<div class="og-consent-jurisdiction" title="Detected jurisdiction"></div>' +
      '</div>';

    el.querySelector('.og-consent-heading').textContent = heading;
    // body accepts trusted HTML (defaults include <strong> tags)
    el.querySelector('.og-consent-body').innerHTML = body;
    if (consentConfig.privacyUrl) {
      var privLink = document.createElement('a');
      privLink.href = consentConfig.privacyUrl;
      privLink.textContent = 'Full privacy policy';
      el.querySelector('.og-consent-body').appendChild(document.createTextNode(' '));
      el.querySelector('.og-consent-body').appendChild(privLink);
      el.querySelector('.og-consent-body').appendChild(document.createTextNode('.'));
    }
    el.querySelector('[data-action="accept"]').textContent = acceptText;
    el.querySelector('[data-action="decline"]').textContent = declineText;
    el.querySelector('.og-consent-jurisdiction').textContent = jurisdiction.jurisdiction;

    el.querySelector('[data-action="accept"]').addEventListener('click', function() {
      onAccept();
      var card = el.querySelector('.og-consent-gate-card');
      var ctaShown = showExtensionCTA(card, consentConfig.extensionUrl, function() {
        el.style.animation = 'og-fade-in 0.2s ease-in reverse';
        setTimeout(function() { el.remove(); }, 200);
      });
      if (!ctaShown) {
        el.style.animation = 'og-fade-in 0.2s ease-in reverse';
        setTimeout(function() { el.remove(); }, 200);
      } else {
        // Hide gate content, show CTA briefly
        var children = card.children;
        for (var i = 0; i < children.length; i++) {
          if (!children[i].classList.contains('og-contact-invite')) {
            children[i].style.display = 'none';
          }
        }
        // Auto-dismiss after 8 seconds
        setTimeout(function() {
          if (el.parentNode) {
            el.style.animation = 'og-fade-in 0.2s ease-in reverse';
            setTimeout(function() { el.remove(); }, 200);
          }
        }, 8000);
      }
    });

    el.querySelector('[data-action="decline"]').addEventListener('click', function() {
      el.style.animation = 'og-fade-in 0.2s ease-in reverse';
      setTimeout(function() { el.remove(); }, 200);
      onDecline();
    });

    document.body.appendChild(el);
  }

  // ─── SDK Interception ───────────────────────────────────────────────

  // Grab the real init function if the SDK is loaded.
  // If not, the public API (OpenGanderConsent) still works standalone —
  // only the initOtelBrowser wrapper requires the SDK.
  var realInit = window.initOtelBrowser;

  if (realInit) {
    window.initOtelBrowser = async function(userConfig) {
    _debugEnabled = !!userConfig.debug;
    var consentConfig = Object.assign({
      theme: 'auto',
      privacyUrl: null,
      expiry: 365,
      onConsent: null,
      text: {}
    }, userConfig.consent || {});

    consentConfig.text = Object.assign({
      heading: null, body: null, accept: null, decline: null
    }, consentConfig.text || {});

    // ── Always respect Do Not Track ──
    if (checkDNT()) {
      if (userConfig.debug) {
        console.log('[OpenGander] Do Not Track detected \u2014 SDK will not initialize');
      }
      if (consentConfig.onConsent) consentConfig.onConsent(false, 'dnt');
      return;
    }

    // ── Detect jurisdiction ──
    var jurisdiction = detectJurisdiction();

    if (userConfig.debug) {
      console.log('[OpenGander] Jurisdiction detected:', jurisdiction.level.toUpperCase(),
        '(' + jurisdiction.jurisdiction + ')',
        'Signals:', jurisdiction.signals);
    }

    if (jurisdiction.level === 'strict' && !consentConfig.privacyUrl) {
      console.warn('[OpenGander] GDPR requires a link to your privacy policy at the point of consent. ' +
        'Set consent.privacyUrl in your config to comply with STRICT jurisdiction requirements.');
    }

    // ── Check stored consent ──
    var stored = getStoredConsent();

    if (stored) {
      // If the visitor moved to a stricter jurisdiction since last consent,
      // re-prompt with the higher level (e.g., traveled from US to EU)
      var storedIsStrict = stored.consentLevel === 'strict';
      var currentIsStrict = jurisdiction.level === 'strict';

      if (currentIsStrict && !storedIsStrict) {
        if (userConfig.debug) {
          console.log('[OpenGander] Jurisdiction escalated from standard to strict \u2014 re-prompting');
        }
        localStorage.removeItem(CONSENT_STORAGE_KEY);
        stored = null;
      }
    }

    if (stored) {
      if (stored.status === 'granted') {
        if (userConfig.debug) {
          console.log('[OpenGander] Previously granted (' + stored.consentLevel + '), initializing SDK');
        }
        return realInit(userConfig);
      } else {
        if (userConfig.debug) {
          console.log('[OpenGander] Previously denied, SDK will not initialize');
        }
        if (consentConfig.onConsent) consentConfig.onConsent(false, jurisdiction.jurisdiction);
        return;
      }
    }

    // ── No stored consent \u2192 show appropriate UI ──
    return new Promise(function(resolve) {
      function onAccept() {
        storeConsent('granted', consentConfig.expiry, jurisdiction.jurisdiction, jurisdiction.level);
        if (userConfig.debug) {
          console.log('[OpenGander] Consent granted (' + jurisdiction.level + '), initializing SDK');
        }
        if (consentConfig.onConsent) consentConfig.onConsent(true, jurisdiction.jurisdiction);
        realInit(userConfig).then(resolve);
      }

      function onDecline() {
        storeConsent('denied', consentConfig.expiry, jurisdiction.jurisdiction, jurisdiction.level);
        if (userConfig.debug) {
          console.log('[OpenGander] Consent denied, SDK will not initialize');
        }
        if (consentConfig.onConsent) consentConfig.onConsent(false, jurisdiction.jurisdiction);
        resolve();
      }

      function show() {
        if (jurisdiction.level === 'strict') {
          renderGate(consentConfig, jurisdiction, onAccept, onDecline);
        } else {
          renderBanner(consentConfig, onAccept, onDecline);
        }
      }

      if (document.body) {
        show();
      } else {
        document.addEventListener('DOMContentLoaded', show);
      }
    });
  };
  } // end if (realInit)

  // ── Public API (always available, even without the SDK) ─────────────

  window.OpenGanderConsent = {
    /** Get current consent status: 'granted' | 'denied' | 'pending' */
    getStatus: function() {
      var stored = getStoredConsent();
      return stored ? stored.status : 'pending';
    },

    /** Get full consent record (includes jurisdiction, level, timestamp) */
    getRecord: function() {
      return getStoredConsent();
    },

    /** Get detected jurisdiction without showing UI */
    getJurisdiction: function() {
      return detectJurisdiction();
    },

    /** Programmatically grant consent (for custom CMP integration) */
    grant: function() {
      var j = detectJurisdiction();
      storeConsent('granted', 365, j.jurisdiction, j.level);
    },

    /** Programmatically deny consent */
    deny: function() {
      var j = detectJurisdiction();
      storeConsent('denied', 365, j.jurisdiction, j.level);
    },

    /** Revoke consent AND clear all OpenGander data from localStorage */
    revoke: function() {
      localStorage.removeItem(CONSENT_STORAGE_KEY);
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('otel_') === 0 || keys[i].indexOf('og_') === 0) {
          localStorage.removeItem(keys[i]);
        }
      }
    },

    /** Reset consent state (will re-prompt on next page load) */
    reset: function() {
      localStorage.removeItem(CONSENT_STORAGE_KEY);
    },

    /**
     * Show the consent UI standalone (without initializing the SDK).
     * Useful for demos, previews, and testing.
     *
     * @param {object} options
     * @param {string} options.theme - 'light' | 'dark' | 'auto'
     * @param {string} options.privacyUrl - Link to privacy policy
     * @param {object} options.text - Custom copy overrides
     * @param {function} options.onConsent - Callback: (granted, jurisdiction) => void
     */
    show: function(options) {
      options = options || {};
      _debugEnabled = !!options.debug;
      var consentConfig = {
        theme: options.theme || 'auto',
        privacyUrl: options.privacyUrl || null,
        text: options.text || {}
      };

      var jurisdiction = detectJurisdiction();

      // Remove existing UI first
      var existing = document.querySelector('.og-consent-banner, .og-consent-gate');
      if (existing) existing.remove();
      var existingStyles = document.getElementById('og-consent-styles');
      if (existingStyles) existingStyles.remove();

      function onAccept() {
        storeConsent('granted', options.expiry || 365, jurisdiction.jurisdiction, jurisdiction.level);
        if (options.onConsent) options.onConsent(true, jurisdiction.jurisdiction);
      }

      function onDecline() {
        storeConsent('denied', options.expiry || 365, jurisdiction.jurisdiction, jurisdiction.level);
        if (options.onConsent) options.onConsent(false, jurisdiction.jurisdiction);
      }

      if (jurisdiction.level === 'strict') {
        renderGate(consentConfig, jurisdiction, onAccept, onDecline);
      } else {
        renderBanner(consentConfig, onAccept, onDecline);
      }

      return jurisdiction;
    }
  };

})();
