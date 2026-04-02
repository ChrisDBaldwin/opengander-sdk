/**
 * OpenGander Browser SDK
 *
 * Real User Monitoring (RUM) with built-in privacy consent.
 *
 * Captures:
 * - Page views and navigation
 * - User interactions (clicks, form submissions)
 * - Web Vitals (LCP, FID, CLS, TTFB, INP)
 * - HTTP requests (fetch/XHR)
 * - Errors and exceptions
 *
 * CONSENT (built-in, automatic):
 * - Consent is bundled into this SDK. No second script tag needed.
 * - STRICT jurisdictions (EU, UK, Brazil, etc.) → full-page gate
 * - STANDARD jurisdictions (US, Canada, Australia) → bottom banner
 * - Do Not Track → honored globally, SDK never initializes
 * - Configure via `consent: { ... }` in initOtelBrowser():
 *     consent: {
 *       privacyUrl: '/privacy',   // Link to privacy policy (recommended)
 *       theme: 'auto',            // 'light' | 'dark' | 'auto'
 *       expiry: 365,              // Days to remember consent
 *       onConsent: null,          // Callback: (granted, jurisdiction) => void
 *       text: { heading, body, accept, decline }  // Custom copy
 *     }
 * - Programmatic API: window.OpenGanderConsent
 *     .getStatus()        → 'granted' | 'denied' | 'pending'
 *     .getRecord()        → full consent record
 *     .getJurisdiction()  → detected jurisdiction
 *     .grant() / .deny()  → programmatic consent (for custom CMP)
 *     .revoke()           → clear consent + all OpenGander data
 *     .reset()            → re-prompt on next page load
 *     .show(options)      → show consent UI standalone
 *
 * Usage:
 *   <script src="opengander-sdk.js"></script>
 *   <script>
 *     initOtelBrowser({
 *       serviceName: 'my-website',
 *       collectorUrl: 'https://collect.opengander.io/v1/traces',
 *       tokenEndpoint: 'https://token.opengander.io/api/telemetry-token',
 *       consent: { privacyUrl: '/privacy' }
 *     });
 *   </script>
 *
 * AUTHENTICATION:
 * - If tokenEndpoint is provided, the SDK will fetch short-lived JWT tokens automatically
 * - Tokens expire in 2-5 minutes and are automatically refreshed
 * - Token-based auth provides better security than static API keys
 */

(function() {
  'use strict';

  // Known bot/crawler patterns - update as needed
  const BOT_PATTERNS = [
    /googlebot/i, /bingbot/i, /slurp/i,           // Search engines
    /duckduckbot/i, /baiduspider/i, /yandexbot/i,
    /sogou/i, /exabot/i, /facebot/i, /ia_archiver/i,
    /mj12bot/i, /ahrefsbot/i, /semrushbot/i,      // SEO tools
    /dotbot/i, /rogerbot/i, /screaming frog/i,
    /httpclient/i, /python-requests/i, /curl/i,   // HTTP libraries
    /wget/i, /libwww/i, /apache-httpclient/i,
    /headlesschrome/i, /phantomjs/i, /puppeteer/i // Headless browsers
  ];

  // AI agent patterns - browsers acting on behalf of AI services
  const AGENT_PATTERNS = [
    /claude-web/i,           // Anthropic Claude
    /chatgpt-user/i,         // OpenAI ChatGPT
    /perplexitybot/i,        // Perplexity AI
    /applebot/i,             // Apple Intelligence
    /cohere-ai/i,            // Cohere
    /anthropic-ai/i,         // Anthropic direct
    /oai-searchbot/i,        // OpenAI search
  ];

  function isBot(userAgent) {
    if (!userAgent) return false;
    return BOT_PATTERNS.some(pattern => pattern.test(userAgent));
  }

  function detectTrafficType(userAgent) {
    if (!userAgent) return 'human';
    if (AGENT_PATTERNS.some(pattern => pattern.test(userAgent))) return 'agent';
    return 'human';
  }

  // OpenTelemetry SDK imports (use CDN or bundle these)
  // CDN: https://cdn.jsdelivr.net/npm/@opentelemetry/api@latest/build/esm/index.js
  const OTEL_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@opentelemetry';
  const OTEL_VERSION = '1.21.0';

  // Configuration defaults
  const DEFAULT_CONFIG = {
    serviceName: window.location.hostname,
    collectorUrl: null,  // REQUIRED - no default, forces user to configure
    debug: false,
    sampleRate: 1.0, // 100% sampling by default
    captureConsole: false,
    captureInteractions: true,
    captureWebVitals: true,
    captureErrors: true,
    customAttributes: {},
    requireToken: false, // Fail initialization if token fetch fails
    maxQueueSize: 100,   // Maximum queued events before dropping
    sessionTimeout: 1800, // Session timeout in seconds (default: 30 minutes)
    experiments: [],     // Array of { id, variant, cohort } for A/B testing

    // Pattern-based configuration for generic usage
    patterns: {
      // Content type patterns (replaces hardcoded /resume, /musings/, etc.)
      contentTypes: {},  // User defines their own, e.g. { 'blog_post': { path: '/blog/*' } }

      // Conversion event patterns (replaces hardcoded resume/cv detection)
      conversions: [],   // User defines, e.g. [{ name: 'signup', match: { href: '/signup/complete' } }]

      // Search engines to add to defaults
      searchEngines: [],

      // Social networks to add to defaults
      socialNetworks: []
    }
  };

  let config = { ...DEFAULT_CONFIG };
  let tracer;
  let provider;

  // SDK ready state tracking
  let sdkReady = false;
  let eventQueue = [];
  const MAX_QUEUE_SIZE = 100; // Prevent memory leaks

  // Token cache for short-lived JWT tokens
  // Structure: { token: string, expiresAt: number, tenantId: string|null }
  let tokenCache = null;
  let tokenFetchPromise = null; // Prevent concurrent token fetches

  // Session cache to avoid repeated localStorage reads and detect session boundaries
  // Structure: { userId, sessionId, visitCount, ... } from initUserSession()
  // Note: session.id attribute provides cross-trace correlation (not sessionTraceId)
  let cachedSession = null;
  let cachedSessionLastActivity = 0;

  // Session sequence counter — monotonically increasing step number within session
  // Incremented on each page_view, persisted in localStorage across navigations
  let sessionSequence = 0;

  // Contact Protocol state
  // Set to 'contact' after successful handshake, stays 'unilateral' otherwise
  let contactProtocol = 'unilateral';

  // BroadcastChannel for sharing spans with Contact Protocol extension
  let contactChannel = null;

  // Helper to get session timeout in milliseconds from config
  function getSessionTimeoutMs() {
    return (config.sessionTimeout || 1800) * 1000;
  }

  /**
   * Attempt Contact Protocol handshake with browser extension.
   * Checks for window.__contact, proposes terms, waits for accept/decline.
   * Must be called after consent is resolved, before first page view.
   *
   * @returns {Promise<'contact'|'unilateral'>} The resolved protocol
   */
  function attemptContactHandshake() {
    return new Promise((resolve) => {
      // Discovery: check if extension has announced itself
      if (!window.__contact || !window.__contact.ready) {
        if (config.debug) {
          console.log('[OTEL] No Contact Protocol extension detected');
        }
        resolve('unilateral');
        return;
      }

      if (config.debug) {
        console.log('[OTEL] Contact Protocol extension detected, version:', window.__contact.version);
      }

      // Timeout: don't block SDK init waiting for extension response
      const HANDSHAKE_TIMEOUT_MS = 2000;
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          if (config.debug) {
            console.log('[OTEL] Contact Protocol handshake timed out, falling back to unilateral');
          }
          resolve('unilateral');
        }
      }, HANDSHAKE_TIMEOUT_MS);

      function onAccept(event) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          cleanup();
          if (config.debug) {
            console.log('[OTEL] Contact Protocol accepted', event.detail);
          }
          resolve('contact');
        }
      }

      function onDecline() {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          cleanup();
          if (config.debug) {
            console.log('[OTEL] Contact Protocol declined by extension');
          }
          resolve('unilateral');
        }
      }

      function cleanup() {
        document.removeEventListener('contact:accept', onAccept);
        document.removeEventListener('contact:decline', onDecline);
      }

      // Listen for response before proposing
      document.addEventListener('contact:accept', onAccept);
      document.addEventListener('contact:decline', onDecline);

      // Propose terms
      document.dispatchEvent(new CustomEvent('contact:propose', {
        detail: {
          session_timeout_ms: getSessionTimeoutMs(),
          ring: 'traffic',
          attributes_collected: ['page_url', 'referrer', 'web_vitals', 'timing'],
          collector_endpoint: config.collectorUrl,
          service_name: config.serviceName
        }
      }));
    });
  }

  /**
   * Load OpenTelemetry SDK from CDN
   * In production, you should bundle these dependencies or use a build step
   */
  async function loadOtelSDK() {
    if (window.OtelSDKLoaded) return;

    // For production, replace this with bundled/built code
    // This is a placeholder - actual implementation would use proper SDK
    console.log('OTEL SDK initialization placeholder');
    window.OtelSDKLoaded = true;
  }

  /**
   * Fetch a new telemetry token from the token endpoint
   * Implements retry logic and prevents concurrent fetches
   * 
   * Returns: Promise<string> - The JWT token
   */
  async function fetchTelemetryToken() {
    // If a fetch is already in progress, wait for it
    if (tokenFetchPromise) {
      return tokenFetchPromise;
    }
    
    // Create new fetch promise
    tokenFetchPromise = (async () => {
      try {
        const endpoint = config.tokenEndpoint || '/api/telemetry-token';
        const response = await fetch(endpoint, {
          method: 'GET',
          credentials: 'same-origin', // Include cookies if needed
          headers: {
            'Accept': 'application/json'
          }
        });
        
        if (!response.ok) {
          throw new Error(`Token fetch failed: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (!data.token) {
          throw new Error('Token response missing token field');
        }
        
        // Calculate expiry time (subtract 30 seconds for safety margin)
        const expiresIn = data.expiresIn || 300; // Default 5 minutes
        const expiresAt = Date.now() + (expiresIn * 1000) - 30000; // 30s safety margin

        // Cache the token and tenantId
        tokenCache = {
          token: data.token,
          expiresAt: expiresAt,
          tenantId: data.tenantId || null
        };

        if (config.debug) {
          console.log('[OTEL] Token fetched, expires in', expiresIn, 'seconds, tenantId:', data.tenantId || 'none');
        }

        return data.token;
      } catch (error) {
        if (config.debug) {
          console.error('[OTEL] Token fetch failed:', error);
        }
        throw error;
      } finally {
        tokenFetchPromise = null;
      }
    })();
    
    return tokenFetchPromise;
  }
  
  /**
   * Get a valid telemetry token, fetching a new one if needed
   * Checks cache first, refreshes if expired or about to expire
   * Falls back to static apiKey if token fetching fails
   * 
   * Returns: Promise<string> - The authentication token
   */
  async function getTelemetryToken() {
    // If static API key is provided, use it (backward compatibility)
    if (config.apiKey) {
      return config.apiKey;
    }
    
    // If no token endpoint configured, return null (no auth)
    if (!config.tokenEndpoint) {
      return null;
    }
    
    // Check if cached token is still valid (with 30 second safety margin)
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now) {
      return tokenCache.token;
    }
    
    // Token expired or missing, fetch new one
    try {
      return await fetchTelemetryToken();
    } catch (error) {
      // If token fetch fails, log error but don't block telemetry sending
      // The server will reject unauthorized requests
      if (config.debug) {
        console.warn('[OTEL] Using expired/invalid token due to fetch failure:', error);
      }
      
      // Return cached token if available (even if expired) as last resort
      // Server will reject it, but at least we tried
      return tokenCache ? tokenCache.token : null;
    }
  }

  /**
   * Initialize OpenTelemetry Browser SDK
   */
  async function initOtelBrowser(userConfig = {}) {
    // Validate required fields
    if (!userConfig.collectorUrl) {
      throw new Error(
        '[OTEL SDK v2] collectorUrl is required.\n' +
        'Example: collectorUrl: "https://otel.yourdomain.com/v1/traces"\n' +
        'For self-hosting guide, see: https://github.com/yourorg/web-analytics-sdk'
      );
    }

    config = { ...DEFAULT_CONFIG, ...userConfig };

    // Filter bots - they don't need telemetry
    if (isBot(navigator.userAgent)) {
      if (config.debug) console.log('[OTEL] Bot detected, skipping initialization');
      return;
    }

    if (config.debug) {
      console.log('[OTEL] Initializing with config:', config);
    }

    // Fetch token BEFORE marking SDK as ready
    if (config.tokenEndpoint && !config.apiKey) {
      try {
        if (config.debug) {
          console.log('[OTEL] Fetching initial token...');
        }
        await fetchTelemetryToken();
        if (config.debug) {
          console.log('[OTEL] Initial token fetched successfully');
        }
      } catch (err) {
        console.error('[OTEL] Initial token fetch failed:', err);

        // Decide: fail fast or degrade gracefully?
        if (config.requireToken) {
          // Fail fast mode: don't initialize if token fetch fails
          console.error('[OTEL] SDK initialization failed (requireToken=true)');
          return;
        }

        // Graceful degradation: continue without token (telemetry will be rejected)
        console.warn('[OTEL] Continuing without token (telemetry may fail)');
      }
    }

    // Attempt Contact Protocol handshake (non-blocking with timeout)
    contactProtocol = await attemptContactHandshake();

    if (contactProtocol === 'contact') {
      try {
        contactChannel = new BroadcastChannel('contact:spans');
        if (config.debug) {
          console.log('[OTEL] BroadcastChannel opened for Contact Protocol span sharing');
        }
      } catch (e) {
        if (config.debug) {
          console.warn('[OTEL] BroadcastChannel not available, Contact Protocol span sharing disabled:', e);
        }
        // Don't downgrade contactProtocol — it was accepted, channel just failed
      }
    }

    // Send telemetry using fetch with authentication
    const sendTelemetry = async (endpoint, data) => {
      const url = `${config.collectorUrl.replace('/v1/traces', '')}${endpoint}`;
      const payload = JSON.stringify(data);

      // Build headers
      const headers = {
        'Content-Type': 'application/json'
      };

      // Get authentication token (JWT token or static API key)
      try {
        const authToken = await getTelemetryToken();
        if (authToken) {
          headers['Authorization'] = `Bearer ${authToken}`;
        }
      } catch (error) {
        if (config.debug) {
          console.error('[OTEL] Failed to get auth token:', error);
        }
        // Continue without auth - server will reject if required
      }

      // Use fetch with keepalive for reliability (sendBeacon doesn't support custom headers)
      fetch(url, {
        method: 'POST',
        headers: headers,
        body: payload,
        keepalive: true
      }).catch(err => {
        if (config.debug) console.error('[OTEL] Send failed:', err);
      });
    };

    // Active span context for tracking parent-child relationships
    // Each page_view starts a new trace; child spans inherit that trace ID
    let activeSpanContext = {
      activePageViewTraceId: null,   // Current page view's trace ID (new per page_view)
      activePageViewSpanId: null     // Current page view span ID (parent for page events)
    };

    // Initialize session cache at SDK startup (for session.id correlation attribute)
    getOrRefreshSession();

    // Simple span creation helper
    // Uses per-page-view trace ID; session correlation via session.id attribute
    const createSpan = (name, attributes = {}, parentSpanId = null) => {
      // Refresh session cache (updates session.id attribute if session boundary crossed)
      getOrRefreshSession();

      // Get base marketing attributes (includes session.id for cross-trace correlation)
      const marketingAttrs = getBaseMarketingAttributes();

      const span = {
        traceId: activeSpanContext.activePageViewTraceId, // Per-page-view trace ID
        spanId: generateSpanId(),
        parentSpanId: parentSpanId,  // Set parent span ID (null for root spans)
        name,
        timestamp: Date.now() * 1000000, // nanoseconds
        duration: 0,
        attributes: {
          'service.name': config.serviceName,
          'telemetry.sdk.name': 'opentelemetry-js-browser',
          'telemetry.sdk.language': 'javascript',
          'telemetry.sdk.version': '1.0.0',
          ...marketingAttrs,           // Add marketing attributes (includes session.id)
          ...config.customAttributes,
          ...attributes                // Event-specific attributes can still override
        }
      };
      return span;
    };

    const sendSpan = async (span) => {
      // If SDK not ready, queue the event
      if (!sdkReady) {
        const maxQueue = config.maxQueueSize || 100;
        if (eventQueue.length < maxQueue) {
          eventQueue.push(span);
          if (config.debug) {
            console.log('[OTEL] SDK not ready, queued event:', span.name);
          }
        } else {
          console.warn('[OTEL] Event queue full, dropping event:', span.name);
        }
        return;
      }

      if (Math.random() > config.sampleRate) return; // Sampling

      // Build OTLP span structure with optional parentSpanId
      const otlpSpan = {
        traceId: span.traceId,
        spanId: span.spanId,
        name: span.name,
        kind: 1, // SPAN_KIND_INTERNAL
        startTimeUnixNano: String(span.timestamp),
        endTimeUnixNano: String(span.timestamp + span.duration),
        attributes: Object.entries(span.attributes).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) }
        }))
      };

      // Only include parentSpanId if it exists (root spans have no parent)
      if (span.parentSpanId) {
        otlpSpan.parentSpanId = span.parentSpanId;
      }

      // Build resource attributes, including TenantId if available
      const resourceAttrs = [
        { key: 'service.name', value: { stringValue: config.serviceName } },
        { key: 'deployment.environment', value: { stringValue: 'production' } }
      ];

      // Add TenantId from token cache (set during token fetch)
      if (tokenCache && tokenCache.tenantId) {
        resourceAttrs.push({ key: 'TenantId', value: { stringValue: tokenCache.tenantId } });
      }

      const trace = {
        resourceSpans: [{
          resource: {
            attributes: resourceAttrs
          },
          scopeSpans: [{
            scope: { name: 'browser-instrumentation' },
            spans: [otlpSpan]
          }]
        }]
      };

      // sendTelemetry is now async, but we don't need to await it
      // Fire and forget - errors are handled internally
      sendTelemetry('/v1/traces', trace);

      // Share span with Contact Protocol extension via BroadcastChannel
      if (contactChannel) {
        try {
          contactChannel.postMessage({
            type: 'span',
            timestamp: Date.now(),
            payload: trace
          });
        } catch (e) {
          if (config.debug) {
            console.warn('[OTEL] BroadcastChannel postMessage failed:', e);
          }
        }
      }
    };

    // Flush queued events when SDK becomes ready
    const flushEventQueue = () => {
      const queue = [...eventQueue]; // Copy to prevent mutation during iteration
      eventQueue.length = 0; // Clear queue

      queue.forEach(span => {
        // Don't re-queue events during flush
        const originalReady = sdkReady;
        sdkReady = true;
        sendSpan(span);
        sdkReady = originalReady;
      });
    };

    // Track page view
    // Each page_view starts a new trace (new trace ID). Child spans inherit this trace ID.
    // Session correlation happens via session.id attribute, not shared trace ID.
    const trackPageView = () => {
      // Generate new trace ID for this page view - it becomes the root of a new trace
      activeSpanContext.activePageViewTraceId = generateTraceId();
      activeSpanContext.activePageViewSpanId = null; // Will be set after span creation

      // Increment session sequence (1-based: first page_view in session = 1)
      sessionSequence++;
      try { localStorage.setItem('otel_session_sequence', sessionSequence.toString()); } catch (e) {}

      const span = createSpan('page_view', {
        // Event classification
        'event.name': 'page_view',
        'event.category': 'navigation',

        // Existing attributes
        'http.url': window.location.href,
        'http.target': window.location.pathname,
        'http.host': window.location.hostname,
        'http.scheme': window.location.protocol.replace(':', ''),
        'user_agent.original': navigator.userAgent,
        'page.referrer': document.referrer || 'direct',
        'page.title': document.title,
        'screen.width': window.screen.width,
        'screen.height': window.screen.height,
        'viewport.width': window.innerWidth,
        'viewport.height': window.innerHeight
      }, null); // page_view is the root span (no parent)

      span.duration = 0;

      // Set this page view as the active parent for subsequent events
      activeSpanContext.activePageViewSpanId = span.spanId;

      sendSpan(span);

      if (config.debug) console.log('[OTEL] Page view tracked (new trace):', span.traceId, span);
    };

    // Track Web Vitals
    if (config.captureWebVitals) {
      // Largest Contentful Paint (LCP)
      const observeLCP = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        const span = createSpan('web.vital.lcp', {
          'web.vital.name': 'LCP',
          'web.vital.value': lastEntry.renderTime || lastEntry.loadTime,
          'web.vital.rating': lastEntry.renderTime < 2500 ? 'good' : lastEntry.renderTime < 4000 ? 'needs-improvement' : 'poor',
          'web.vital.element': lastEntry.element?.tagName || 'unknown'
        }, activeSpanContext.activePageViewSpanId); // Child of page_view
        span.duration = (lastEntry.renderTime || lastEntry.loadTime) * 1000000;
        sendSpan(span);
      });
      try {
        observeLCP.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch (e) {
        if (config.debug) console.warn('[OTEL] LCP not supported');
      }

      // First Input Delay (FID)
      const observeFID = new PerformanceObserver((list) => {
        const firstInput = list.getEntries()[0];
        const span = createSpan('web.vital.fid', {
          'web.vital.name': 'FID',
          'web.vital.value': firstInput.processingStart - firstInput.startTime,
          'web.vital.rating': firstInput.processingStart - firstInput.startTime < 100 ? 'good' : 'poor',
          'interaction.type': firstInput.name
        }, activeSpanContext.activePageViewSpanId); // Child of page_view
        span.duration = (firstInput.processingStart - firstInput.startTime) * 1000000;
        sendSpan(span);
      });
      try {
        observeFID.observe({ type: 'first-input', buffered: true });
      } catch (e) {
        if (config.debug) console.warn('[OTEL] FID not supported');
      }

      // Cumulative Layout Shift (CLS)
      let clsValue = 0;
      const observeCLS = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        }
      });
      try {
        observeCLS.observe({ type: 'layout-shift', buffered: true });
      } catch (e) {
        if (config.debug) console.warn('[OTEL] CLS not supported');
      }

      // Report CLS on page hide
      window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && clsValue > 0) {
          const span = createSpan('web.vital.cls', {
            'web.vital.name': 'CLS',
            'web.vital.value': clsValue,
            'web.vital.rating': clsValue < 0.1 ? 'good' : clsValue < 0.25 ? 'needs-improvement' : 'poor'
          }, activeSpanContext.activePageViewSpanId); // Child of page_view
          sendSpan(span);
        }
      });
    }

    // Close Contact Protocol BroadcastChannel on page unload
    window.addEventListener('pagehide', () => {
      if (contactChannel) {
        try { contactChannel.close(); } catch (e) {}
        contactChannel = null;
      }
    });

    // Track user interactions
    if (config.captureInteractions) {
      ['click', 'submit'].forEach(eventType => {
        document.addEventListener(eventType, (e) => {
          const target = e.target;

          // Determine event name and category based on context
          let eventName = `user_${eventType}`;
          let eventCategory = 'engagement';

          // Pattern-based conversion detection (generic, not site-specific)
          if (eventType === 'click') {
            const href = target.href || target.closest('a')?.href || '';

            // Check user-defined conversion patterns
            const conversion = config.patterns.conversions.find(conv =>
              matchConversion(target, conv)
            );

            if (conversion) {
              eventName = conversion.name;
              eventCategory = conversion.category || 'conversion';
            } else if (href) {
              // Check for outbound links (generic, not site-specific)
              try {
                const hrefUrl = new URL(href, window.location.origin);
                if (hrefUrl.hostname !== window.location.hostname) {
                  eventName = 'outbound_click';
                }
              } catch (e) {
                // Invalid URL, ignore
              }
            }
          }

          const span = createSpan(eventName, {
            'event.name': eventName,
            'event.category': eventCategory,
            'interaction.type': eventType,
            'interaction.target.tag': target.tagName,
            'interaction.target.id': target.id || '',
            'interaction.target.class': target.className || '',
            'interaction.target.text': target.innerText?.substring(0, 100) || '',
            'interaction.target.href': target.href || target.closest('a')?.href || ''
          }, activeSpanContext.activePageViewSpanId); // Child of page_view
          sendSpan(span);
        }, { passive: true });
      });
    }

    // Track errors
    if (config.captureErrors) {
      window.addEventListener('error', (event) => {
        const span = createSpan('error', {
          'exception.type': event.error?.name || 'Error',
          'exception.message': event.message,
          'exception.stacktrace': event.error?.stack || '',
          'error.filename': event.filename,
          'error.lineno': event.lineno,
          'error.colno': event.colno
        }, activeSpanContext.activePageViewSpanId); // Child of page_view
        sendSpan(span);
      });

      window.addEventListener('unhandledrejection', (event) => {
        const span = createSpan('unhandled_rejection', {
          'exception.type': 'UnhandledRejection',
          'exception.message': event.reason?.message || String(event.reason)
        }, activeSpanContext.activePageViewSpanId); // Child of page_view
        sendSpan(span);
      });
    }

    // Track navigation timing
    window.addEventListener('load', () => {
      setTimeout(() => {
        const perfData = performance.getEntriesByType('navigation')[0];
        if (perfData) {
          const span = createSpan('navigation', {
            'navigation.type': perfData.type,
            'navigation.dns': perfData.domainLookupEnd - perfData.domainLookupStart,
            'navigation.tcp': perfData.connectEnd - perfData.connectStart,
            'navigation.request': perfData.responseStart - perfData.requestStart,
            'navigation.response': perfData.responseEnd - perfData.responseStart,
            'navigation.dom_processing': perfData.domComplete - perfData.domInteractive,
            'navigation.load_time': perfData.loadEventEnd - perfData.fetchStart
          }, activeSpanContext.activePageViewSpanId); // Child of page_view
          span.duration = (perfData.loadEventEnd - perfData.fetchStart) * 1000000;
          sendSpan(span);
        }
      }, 0);
    });

    // Track initial page view
    trackPageView();

    // Track SPA navigation (for history.pushState/replaceState)
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function(...args) {
      originalPushState.apply(this, args);
      trackPageView();
    };

    history.replaceState = function(...args) {
      originalReplaceState.apply(this, args);
      trackPageView();
    };

    window.addEventListener('popstate', trackPageView);

    // Mark SDK as ready AFTER all setup complete
    sdkReady = true;

    // Flush any queued events
    if (eventQueue.length > 0) {
      if (config.debug) {
        console.log(`[OTEL] Flushing ${eventQueue.length} queued events`);
      }
      flushEventQueue();
    }

    if (config.debug) {
      console.log('[OTEL] Browser instrumentation initialized and ready');
    }

    // Expose API for custom tracking
    window.otel = {
      trackEvent: (name, attributes) => {
        const span = createSpan(name, attributes, activeSpanContext.activePageViewSpanId);
        sendSpan(span);
      },
      setAttributes: (attrs) => {
        config.customAttributes = { ...config.customAttributes, ...attrs };
      },

      // Experiment management
      setExperiment: (experimentId, variant, cohort = null) => {
        // Add or update experiment
        const existing = config.experiments.find(e => e.id === experimentId);
        if (existing) {
          existing.variant = variant;
          if (cohort) existing.cohort = cohort;
        } else {
          config.experiments.push({ id: experimentId, variant, cohort });
        }
      },

      clearExperiment: (experimentId) => {
        config.experiments = config.experiments.filter(e => e.id !== experimentId);
      },

      // Get user and traffic info
      getUserInfo: () => {
        return initUserSession();
      },

      getTrafficSource: () => {
        return parseTrafficSource();
      }
    };
  }

  // Helper functions
  function generateTraceId() {
    return Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  }

  function generateSpanId() {
    return Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
  }

  /**
   * Simple glob pattern matcher
   * Supports * (any characters) and ** (any path segments)
   */
  function matchGlob(pattern, str) {
    if (!pattern || !str) return false;
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i'  // Case insensitive
    );
    return regex.test(str);
  }

  /**
   * Check if element matches conversion pattern
   */
  function matchConversion(element, conversionConfig) {
    const href = element.href || element.closest('a')?.href || '';
    const text = (element.innerText || '').toLowerCase();
    const match = conversionConfig.match;

    // Check href pattern
    if (match.href && !matchGlob(match.href, href)) {
      return false;
    }

    // Check text pattern
    if (match.text && !matchGlob(match.text, text)) {
      return false;
    }

    // Check file extension
    if (match.fileExtension) {
      const extensions = Array.isArray(match.fileExtension)
        ? match.fileExtension
        : [match.fileExtension];
      if (!extensions.some(ext => href.endsWith(ext))) {
        return false;
      }
    }

    return true;
  }

  /**
   * Parse content metadata from URL pathname
   * Supports meta tag override for explicit content classification
   */
  function parseContentFromUrl(pathname, metaTags = {}) {
    // Extract from meta tags if available
    if (metaTags.contentSlug || metaTags.contentSection || metaTags.contentType) {
      return {
        slug: metaTags.contentSlug || pathname,
        section: metaTags.contentSection || (pathname.split('/').filter(Boolean)[0] || 'home'),
        type: metaTags.contentType || inferContentType(pathname)
      };
    }

    // Parse from URL structure
    const parts = pathname.split('/').filter(Boolean);
    const section = parts[0] || 'home';
    const type = inferContentType(pathname, parts);

    return { slug: pathname, section, type };
  }

  /**
   * Infer content type from URL pathname using configurable patterns
   */
  function inferContentType(pathname, parts = null) {
    parts = parts || pathname.split('/').filter(Boolean);

    // Check user-defined patterns first
    for (const [type, pattern] of Object.entries(config.patterns.contentTypes)) {
      if (pattern.path === pathname || matchGlob(pattern.path, pathname)) {
        return type;
      }
    }

    // Fallback: use first path segment or 'landing_page' for root
    return pathname === '/' ? 'landing_page' : (parts[0] || 'page');
  }

  /**
   * Parse UTM parameters from current URL
   */
  function parseUtmParams() {
    const params = new URLSearchParams(window.location.search);

    return {
      source: params.get('utm_source') || null,
      medium: params.get('utm_medium') || null,
      campaign: params.get('utm_campaign') || null,
      term: params.get('utm_term') || null,
      content: params.get('utm_content') || null
    };
  }

  /**
   * Determine traffic source and channel using Google Analytics default grouping
   */
  function parseTrafficSource() {
    const utm = parseUtmParams();
    const referrer = document.referrer;
    let referrerUrl = null;
    let referrerDomain = null;

    try {
      if (referrer) {
        referrerUrl = new URL(referrer);
        referrerDomain = referrerUrl.hostname;
      }
    } catch (e) {
      // Invalid referrer URL, ignore
    }

    // If UTM parameters present, use them
    if (utm.source || utm.medium) {
      const channel = determineChannel(utm.source, utm.medium, referrerDomain);

      return {
        source: utm.source || referrerDomain || 'direct',
        medium: utm.medium || 'none',
        campaign: utm.campaign,
        term: utm.term,
        content: utm.content,
        channel: channel
      };
    }

    // Infer from referrer
    if (referrer && referrerDomain && referrerDomain !== window.location.hostname) {
      const inferredSource = classifyReferrer(referrerDomain);

      return {
        source: referrerDomain,
        medium: inferredSource.medium,
        campaign: null,
        term: null,
        content: null,
        channel: inferredSource.channel
      };
    }

    // Direct traffic
    return {
      source: 'direct',
      medium: 'none',
      campaign: null,
      term: null,
      content: null,
      channel: 'Direct'
    };
  }

  /**
   * Google Analytics default channel grouping rules
   */
  function determineChannel(source, medium, referrerDomain) {
    const mediumLower = (medium || '').toLowerCase();
    const sourceLower = (source || '').toLowerCase();

    // Paid Search
    if ((mediumLower.includes('cpc') || mediumLower.includes('ppc') || mediumLower === 'paid') &&
        isSearchEngine(sourceLower)) {
      return 'Paid Search';
    }

    // Organic Search
    if (mediumLower === 'organic' || isSearchEngine(sourceLower) || isSearchEngine(referrerDomain)) {
      return 'Organic Search';
    }

    // Paid Social
    if ((mediumLower.includes('social') || mediumLower.includes('cpc') || mediumLower.includes('paid')) &&
        isSocialNetwork(sourceLower)) {
      return 'Paid Social';
    }

    // Organic Social
    if (mediumLower === 'social' || isSocialNetwork(sourceLower) || isSocialNetwork(referrerDomain)) {
      return 'Organic Social';
    }

    // Email
    if (mediumLower === 'email' || mediumLower === 'e-mail') {
      return 'Email';
    }

    // Referral
    if (mediumLower === 'referral' || referrerDomain) {
      return 'Referral';
    }

    // Display
    if (mediumLower.includes('display') || mediumLower.includes('banner') || mediumLower.includes('cpm')) {
      return 'Display';
    }

    // Direct
    if (mediumLower === 'none' || mediumLower === '(none)' || !medium) {
      return 'Direct';
    }

    // Other
    return 'Other';
  }

  /**
   * Check if domain is a search engine (with user extensions)
   */
  function isSearchEngine(domain) {
    if (!domain) return false;

    const defaultEngines = [
      'google', 'bing', 'yahoo', 'duckduckgo', 'baidu', 'yandex', 'ask',
      'chatgpt', 'openai',  // ChatGPT and OpenAI
      'perplexity',         // Perplexity AI
      'you.com', 'you',     // You.com search
      'brave',              // Brave Search
      'ecosia'              // Ecosia
    ];

    // Combine defaults with user additions
    const allEngines = [...defaultEngines, ...(config.patterns.searchEngines || [])];

    return allEngines.some(engine => {
      if (typeof engine === 'string') {
        return domain.includes(engine);
      } else if (engine.domain) {
        return domain.includes(engine.domain);
      }
      return false;
    });
  }

  /**
   * Check if domain is a social network (with user extensions)
   */
  function isSocialNetwork(domain) {
    if (!domain) return false;

    const defaultNetworks = [
      'facebook', 'instagram', 'twitter', 'x.com', 'linkedin', 'pinterest',
      'reddit', 'tiktok', 'youtube', 'snapchat', 'whatsapp', 'telegram'
    ];

    // Combine defaults with user additions
    const allNetworks = [...defaultNetworks, ...(config.patterns.socialNetworks || [])];

    return allNetworks.some(network => {
      if (typeof network === 'string') {
        return domain.includes(network);
      } else if (network.domain) {
        return domain.includes(network.domain);
      }
      return false;
    });
  }

  /**
   * Classify referrer domain
   */
  function classifyReferrer(domain) {
    if (isSearchEngine(domain)) {
      return { medium: 'organic', channel: 'Organic Search' };
    }
    if (isSocialNetwork(domain)) {
      return { medium: 'social', channel: 'Organic Social' };
    }
    return { medium: 'referral', channel: 'Referral' };
  }

  /**
   * Detect device category, OS, and browser
   */
  function detectDevice() {
    const ua = navigator.userAgent;
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    };

    // Device category from viewport (primary method)
    let category = 'desktop';
    if (viewport.width < 768) {
      category = 'mobile';
    } else if (viewport.width < 1024) {
      category = 'tablet';
    }

    // OS detection from user agent
    let os = 'Unknown';
    if (/Windows/i.test(ua)) os = 'Windows';
    else if (/Macintosh|MacIntel|MacPPC|Mac68K/i.test(ua)) os = 'macOS';
    else if (/iPhone|iPad|iPod/i.test(ua)) {
      os = 'iOS';
      category = /iPad/i.test(ua) ? 'tablet' : 'mobile'; // Override for iOS devices
    }
    else if (/Android/i.test(ua)) {
      os = 'Android';
      // Android tablets often report tablet in UA
      if (/tablet/i.test(ua)) category = 'tablet';
    }
    else if (/Linux/i.test(ua)) os = 'Linux';

    // Browser detection
    let browser = 'Unknown';
    if (/Edg\//i.test(ua)) browser = 'Edge';
    else if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) browser = 'Chrome';
    else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
    else if (/Firefox/i.test(ua)) browser = 'Firefox';
    else if (/MSIE|Trident/i.test(ua)) browser = 'Internet Explorer';

    return { category, os, browser };
  }

  /**
   * Initialize user session tracking with persistent localStorage
   */
  function initUserSession() {
    const STORAGE_KEY_USER = 'otel_user_id';
    const STORAGE_KEY_FIRST_SEEN = 'otel_user_first_seen';
    const STORAGE_KEY_VISIT_COUNT = 'otel_user_visit_count';
    const STORAGE_KEY_SESSION = 'otel_session_id';
    const STORAGE_KEY_SESSION_START = 'otel_session_start';
    const STORAGE_KEY_SESSION_TRACE = 'otel_session_trace_id';
    const STORAGE_KEY_TRAFFIC_SOURCE = 'otel_traffic_source';
    const STORAGE_KEY_TRAFFIC_MEDIUM = 'otel_traffic_medium';
    const STORAGE_KEY_TRAFFIC_CHANNEL = 'otel_traffic_channel';
    const STORAGE_KEY_TRAFFIC_CAMPAIGN = 'otel_traffic_campaign';
    const STORAGE_KEY_TRAFFIC_TERM = 'otel_traffic_term';
    const STORAGE_KEY_TRAFFIC_CONTENT = 'otel_traffic_content';
    const STORAGE_KEY_SESSION_SEQUENCE = 'otel_session_sequence';
    const SESSION_TIMEOUT = getSessionTimeoutMs();

    let userId = localStorage.getItem(STORAGE_KEY_USER);
    let firstSeen = localStorage.getItem(STORAGE_KEY_FIRST_SEEN);
    let visitCount = parseInt(localStorage.getItem(STORAGE_KEY_VISIT_COUNT) || '0', 10);

    // Generate anonymous user ID if first visit
    if (!userId) {
      userId = generateTraceId(); // Reuse existing random ID generator
      localStorage.setItem(STORAGE_KEY_USER, userId);
      firstSeen = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY_FIRST_SEEN, firstSeen);
    }

    // Check if new session (or increment visit count)
    const lastSessionStart = parseInt(localStorage.getItem(STORAGE_KEY_SESSION_START) || '0', 10);
    const now = Date.now();
    const isNewSession = (now - lastSessionStart) > SESSION_TIMEOUT;

    // Capture or reuse traffic source
    let trafficSource = null;

    if (isNewSession) {
      visitCount++;
      localStorage.setItem(STORAGE_KEY_VISIT_COUNT, visitCount.toString());

      // Reset session sequence for new session
      sessionSequence = 0;
      localStorage.setItem(STORAGE_KEY_SESSION_SEQUENCE, '0');

      // Capture traffic source for new session
      const traffic = parseTrafficSource(); // Call existing function
      localStorage.setItem(STORAGE_KEY_TRAFFIC_SOURCE, traffic.source);
      localStorage.setItem(STORAGE_KEY_TRAFFIC_MEDIUM, traffic.medium);
      localStorage.setItem(STORAGE_KEY_TRAFFIC_CHANNEL, traffic.channel);
      localStorage.setItem(STORAGE_KEY_TRAFFIC_CAMPAIGN, traffic.campaign || '');
      localStorage.setItem(STORAGE_KEY_TRAFFIC_TERM, traffic.term || '');
      localStorage.setItem(STORAGE_KEY_TRAFFIC_CONTENT, traffic.content || '');

      trafficSource = traffic;
    } else {
      // Load session sequence from localStorage
      sessionSequence = parseInt(localStorage.getItem(STORAGE_KEY_SESSION_SEQUENCE) || '0', 10);

      // Reuse traffic source from localStorage
      trafficSource = {
        source: localStorage.getItem(STORAGE_KEY_TRAFFIC_SOURCE) || 'direct',
        medium: localStorage.getItem(STORAGE_KEY_TRAFFIC_MEDIUM) || 'none',
        channel: localStorage.getItem(STORAGE_KEY_TRAFFIC_CHANNEL) || 'Direct',
        campaign: localStorage.getItem(STORAGE_KEY_TRAFFIC_CAMPAIGN) || null,
        term: localStorage.getItem(STORAGE_KEY_TRAFFIC_TERM) || null,
        content: localStorage.getItem(STORAGE_KEY_TRAFFIC_CONTENT) || null
      };
    }

    // Generate or reuse session ID
    let sessionId = localStorage.getItem(STORAGE_KEY_SESSION);
    let sessionTraceId = localStorage.getItem(STORAGE_KEY_SESSION_TRACE);
    if (isNewSession || !sessionId) {
      sessionId = generateTraceId();
      sessionTraceId = generateTraceId(); // One traceId per session
      localStorage.setItem(STORAGE_KEY_SESSION, sessionId);
      localStorage.setItem(STORAGE_KEY_SESSION_TRACE, sessionTraceId);
    }
    localStorage.setItem(STORAGE_KEY_SESSION_START, now.toString());

    return {
      userId,
      firstSeen,
      visitCount,
      sessionId,
      sessionTraceId,
      isNewSession,
      newVsReturning: visitCount === 1 ? 'new' : 'returning',
      trafficSource  // Session-level traffic source (captured once per session)
    };
  }

  /**
   * Get or refresh the cached session, detecting session boundary changes.
   *
   * This function:
   * 1. Returns the cached session if still valid (within config.sessionTimeout)
   * 2. Extends session lifetime on each call (activity-based timeout)
   * 3. Detects when a new session starts (after timeout idle)
   * 4. Returns both the session data AND a flag indicating if session changed
   *
   * @returns {{ session: object, sessionChanged: boolean }}
   */
  function getOrRefreshSession() {
    const now = Date.now();
    const timeoutMs = getSessionTimeoutMs();

    // Check if cached session is still valid (within timeout window)
    if (cachedSession && (now - cachedSessionLastActivity) < timeoutMs) {
      // Session still active - update last activity timestamp (extends session)
      cachedSessionLastActivity = now;
      return { session: cachedSession, sessionChanged: false };
    }

    // Session expired or first call - reinitialize from localStorage
    const session = initUserSession();
    const sessionChanged = cachedSession !== null && session.isNewSession;

    // Update cache
    cachedSession = session;
    cachedSessionLastActivity = now;

    if (config.debug && sessionChanged) {
      console.log('[OTEL] Session boundary detected, new session.id:', session.sessionId);
    }

    return { session, sessionChanged };
  }

  /**
   * Get session entry page (first page viewed in current session)
   */
  function getSessionEntryPage() {
    const STORAGE_KEY_ENTRY = 'otel_session_entry_page';
    const STORAGE_KEY_ENTRY_TIME = 'otel_session_entry_time';
    const sessionTimeout = getSessionTimeoutMs();

    const entryTime = parseInt(localStorage.getItem(STORAGE_KEY_ENTRY_TIME) || '0', 10);
    const now = Date.now();

    // If new session or no entry page stored
    if ((now - entryTime) > sessionTimeout || !localStorage.getItem(STORAGE_KEY_ENTRY)) {
      const entryPage = window.location.pathname;
      localStorage.setItem(STORAGE_KEY_ENTRY, entryPage);
      localStorage.setItem(STORAGE_KEY_ENTRY_TIME, now.toString());
      return entryPage;
    }

    return localStorage.getItem(STORAGE_KEY_ENTRY);
  }

  /**
   * Get experiment attributes for A/B testing
   */
  function getExperimentAttributes() {
    if (!config.experiments || config.experiments.length === 0) {
      return {};
    }

    // Support multiple concurrent experiments
    const attrs = {};
    config.experiments.forEach((exp, index) => {
      const prefix = index === 0 ? 'experiment' : `experiment.${index}`;
      attrs[`${prefix}.id`] = exp.id;
      attrs[`${prefix}.variant`] = exp.variant;
      if (exp.cohort) {
        attrs[`${prefix}.cohort`] = exp.cohort;
      }
    });

    return attrs;
  }

  /**
   * Build comprehensive marketing attributes for all spans
   * Includes content, traffic, device, user, session, and experiment data
   *
   * NOTE: Uses cachedSession which is refreshed by getOrRefreshSession() in createSpan().
   * This avoids redundant localStorage reads on every span.
   */
  function getBaseMarketingAttributes() {
    // Content fields
    const metaTags = {
      contentSlug: document.querySelector('meta[name="content.slug"]')?.content,
      contentSection: document.querySelector('meta[name="content.section"]')?.content,
      contentType: document.querySelector('meta[name="content.type"]')?.content
    };
    const content = parseContentFromUrl(window.location.pathname, metaTags);

    // User & session - use cached session (already refreshed by createSpan via getOrRefreshSession)
    // Fall back to initUserSession() only if cache is somehow null (defensive)
    const user = cachedSession || initUserSession();
    const entryPage = getSessionEntryPage();
    const entryContent = parseContentFromUrl(entryPage, {});

    // Traffic source (use cached value from session)
    const traffic = user.trafficSource;

    // Device
    const device = detectDevice();

    // Consent state (invariant within a session per session-spans-design spec)
    let consentStatus = 'granted';
    let consentJurisdiction = 'STANDARD';
    let consentVersion = '1';
    try {
      const consentRaw = localStorage.getItem('og_consent');
      if (consentRaw) {
        const consentRecord = JSON.parse(consentRaw);
        consentStatus = consentRecord.status || 'granted';
        consentJurisdiction = (consentRecord.consentLevel || 'standard').toUpperCase();
        consentVersion = String(consentRecord.version || 1);
      }
    } catch (e) {}

    // Build attribute object
    const attrs = {
      // Content
      'content.slug': content.slug,
      'content.section': content.section,
      'content.type': content.type,

      // Traffic source
      'traffic.source': traffic.source,
      'traffic.medium': traffic.medium,
      'traffic.channel': traffic.channel,

      // Traffic classification
      'traffic.type': detectTrafficType(navigator.userAgent),

      // Device
      'device.category': device.category,
      'device.os': device.os,
      'device.browser': device.browser,

      // User
      'user.id': user.userId,
      'user.first_seen': user.firstSeen,
      'user.visit_count': user.visitCount,
      'user.new_vs_returning': user.newVsReturning,

      // Session
      'session.id': user.sessionId,
      'session.index': user.visitCount,
      'session.entry_page': entryPage,
      'session.entry_content_type': entryContent.type,
      'session.sequence': sessionSequence,
      'session.timeout_ms': getSessionTimeoutMs(),

      // Consent (per session-spans-design spec)
      'consent.status': consentStatus,
      'consent.jurisdiction': consentJurisdiction,
      'consent.ring': 'traffic',
      'consent.version': consentVersion,
      'consent.protocol': contactProtocol
    };

    // Add optional UTM fields only if present
    if (traffic.campaign) attrs['traffic.campaign'] = traffic.campaign;
    if (traffic.term) attrs['traffic.term'] = traffic.term;
    if (traffic.content) attrs['traffic.content'] = traffic.content;

    // Add experiment attributes
    const experimentAttrs = getExperimentAttributes();
    Object.assign(attrs, experimentAttrs);

    return attrs;
  }

  // Initialization promise tracking
  let initPromise = null;

  // Wrap initOtelBrowser to return promise and prevent duplicate initialization
  const originalInit = initOtelBrowser;
  window.initOtelBrowser = async function(userConfig) {
    if (initPromise) {
      console.warn('[OTEL] Already initialized, returning existing promise');
      return initPromise;
    }

    initPromise = originalInit(userConfig);
    return initPromise;
  };

  // Add ready check helper
  window.otelReady = function() {
    return sdkReady;
  };

  // Add wait helper with timeout
  window.waitForOtel = async function(timeout = 5000) {
    if (sdkReady) return true;

    return new Promise((resolve) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        if (sdkReady) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          console.warn('[OTEL] Timeout waiting for SDK ready');
          resolve(false);
        }
      }, 100);
    });
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ═══ CONSENT MODULE ═══════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Mandatory consent layer. Automatically detects visitor jurisdiction
  // and presents the appropriate consent experience (gate or banner).
  // This code runs inside the SDK IIFE — no separate script tag needed.

  if (!window.__ogConsentLoaded) {
    window.__ogConsentLoaded = true;

    var CONSENT_STORAGE_KEY = 'og_consent';

    // ─── Jurisdiction Detection ─────────────────────────────────────────

    var STRICT_TIMEZONE_PREFIXES = [
      // EU / EEA member states
      'Europe/',
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
      // UAE
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

    var STRICT_LANGUAGE_PREFIXES = [
      'de', 'fr', 'it', 'es', 'pt', 'nl', 'pl', 'cs', 'sk', 'hu', 'ro',
      'bg', 'hr', 'sl', 'et', 'lv', 'lt', 'fi', 'sv', 'da', 'el', 'ga',
      'mt', 'no', 'is', 'ko', 'ja', 'th', 'hi', 'ta', 'te', 'mr', 'bn'
    ];

    function detectJurisdiction() {
      if (window.__ogJurisdictionOverride) {
        return window.__ogJurisdictionOverride;
      }

      var signals = { timezone: null, language: null, languages: [] };

      try {
        signals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch (e) {}

      signals.language = navigator.language || '';
      signals.languages = Array.from(navigator.languages || []);

      if (signals.timezone) {
        var tzMatch = STRICT_TIMEZONE_PREFIXES.some(function(prefix) {
          return signals.timezone.indexOf(prefix) === 0;
        });
        if (tzMatch) {
          return { level: 'strict', jurisdiction: signals.timezone, signals: signals };
        }
        return { level: 'standard', jurisdiction: signals.timezone, signals: signals };
      }

      var langCode = signals.language.split('-')[0].toLowerCase();
      var langMatch = STRICT_LANGUAGE_PREFIXES.some(function(prefix) {
        return langCode === prefix;
      });
      if (langMatch) {
        return { level: 'strict', jurisdiction: 'lang:' + signals.language, signals: signals };
      }

      if (!signals.timezone && !signals.language) {
        return { level: 'strict', jurisdiction: 'unknown', signals: signals };
      }

      return { level: 'standard', jurisdiction: signals.timezone || 'lang:' + signals.language, signals: signals };
    }

    // ─── Consent State Management ───────────────────────────────────────

    function getStoredConsent() {
      try {
        var raw = localStorage.getItem(CONSENT_STORAGE_KEY);
        if (!raw) return null;
        var consent = JSON.parse(raw);
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
          version: 1
        }));
      } catch (e) {}
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
        // Soft shadow
        '<ellipse cx="60" cy="108" rx="22" ry="3.5" fill="#00000010"/>' +
        // Tail feathers (left side)
        '<path d="M28 66 Q20 56 22 48" fill="none" stroke="#D1D5DB" stroke-width="2" stroke-linecap="round"/>' +
        '<path d="M30 70 Q18 62 18 52" fill="none" stroke="#E5E7EB" stroke-width="2" stroke-linecap="round"/>' +
        // Body (classic white)
        '<ellipse cx="56" cy="76" rx="32" ry="28" fill="#F8F9FA" stroke="#374151" stroke-width="1.5"/>' +
        // Belly highlight
        '<ellipse cx="56" cy="84" rx="22" ry="16" fill="#FFFFFF" opacity="0.5"/>' +
        // Wing (light grey with feather detail)
        '<path d="M62 62 Q44 54 34 60 Q36 76 56 80" fill="#E5E7EB" stroke="#374151" stroke-width="1.2"/>' +
        '<path d="M56 64 Q46 60 40 64" fill="none" stroke="#D1D5DB" stroke-width="0.8" stroke-linecap="round"/>' +
        '<path d="M54 70 Q46 66 40 70" fill="none" stroke="#D1D5DB" stroke-width="0.8" stroke-linecap="round"/>' +
        '<path d="M52 76 Q46 72 42 76" fill="none" stroke="#D1D5DB" stroke-width="0.8" stroke-linecap="round"/>' +
        // Black neck (filled shape, no center line)
        '<path d="M68 52 Q72 40 76 28 Q78 18 76 10 Q74 8 72 10 Q70 18 68 28 Q64 40 62 52 Z" fill="#2D2D2D" stroke="#1a1a1a" stroke-width="0.5"/>' +
        // Black head
        '<ellipse cx="75" cy="12" rx="11" ry="10" fill="#2D2D2D" stroke="#1a1a1a" stroke-width="0.5"/>' +
        // White chinstrap (signature Canadian goose marking)
        '<path d="M72 18 Q76 22 82 18 Q84 16 82 14 Q78 17 74 14 Q72 16 72 18 Z" fill="#F8F9FA"/>' +
        // Cute eye (bright against dark head)
        '<ellipse cx="80" cy="11" rx="3" ry="3.5" fill="#1a1a1a"/>' +
        '<ellipse cx="81" cy="10" rx="1.3" ry="1.6" fill="#FFFFFF" opacity="0.9"/>' +
        '<circle cx="79" cy="12.5" r="0.5" fill="#FFFFFF"/>' +
        // Beak (orange, facing right)
        '<path d="M86 13 Q92 11 94 14 Q92 17 86 15" fill="#F59E0B" stroke="#D97706" stroke-width="0.8" stroke-linejoin="round"/>' +
        // Cute round feet (orange)
        '<ellipse cx="46" cy="104" rx="8" ry="4" fill="#F59E0B" stroke="#D97706" stroke-width="1"/>' +
        '<ellipse cx="66" cy="104" rx="8" ry="4" fill="#F59E0B" stroke="#D97706" stroke-width="1"/>' +
        // Toe lines
        '<line x1="40" y1="104" x2="38" y2="107" stroke="#D97706" stroke-width="0.8" stroke-linecap="round"/>' +
        '<line x1="46" y1="104" x2="46" y2="108" stroke="#D97706" stroke-width="0.8" stroke-linecap="round"/>' +
        '<line x1="52" y1="104" x2="54" y2="107" stroke="#D97706" stroke-width="0.8" stroke-linecap="round"/>' +
        '<line x1="60" y1="104" x2="58" y2="107" stroke="#D97706" stroke-width="0.8" stroke-linecap="round"/>' +
        '<line x1="66" y1="104" x2="66" y2="108" stroke="#D97706" stroke-width="0.8" stroke-linecap="round"/>' +
        '<line x1="72" y1="104" x2="74" y2="107" stroke="#D97706" stroke-width="0.8" stroke-linecap="round"/>' +
        '</svg>';
    }

    // ─── Styles ─────────────────────────────────────────────────────────

    function injectConsentStyles(position, theme) {
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

        '.og-consent-jurisdiction {' +
          'font-size: 10px; color: ' + colors.textMuted + ';' +
          'margin-top: 8px; opacity: 0.5;' +
        '}' +

        '.og-contact-invite {' +
          'position: fixed; bottom: 24px; right: 24px; z-index: 2147483646;' +
          'background: ' + colors.bg + ';' +
          'border: 1px solid ' + colors.border + ';' +
          'border-radius: 12px; padding: 16px 20px;' +
          'box-shadow: 0 8px 32px rgba(0,0,0,0.12);' +
          'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
          'max-width: 360px; animation: og-scale-in 0.3s ease-out;' +
        '}' +

        '.og-contact-invite-heading {' +
          'font-size: 14px; font-weight: 600; color: ' + colors.text + ';' +
          'margin-bottom: 6px; line-height: 1.4;' +
        '}' +

        '.og-contact-invite-body {' +
          'font-size: 13px; color: ' + colors.textMuted + '; line-height: 1.5; margin-bottom: 12px;' +
        '}' +

        '.og-contact-invite-actions { display: flex; gap: 8px; align-items: center; }' +

        '.og-contact-invite-link {' +
          'display: inline-block; padding: 6px 16px; border-radius: 6px;' +
          'background: ' + colors.acceptBg + '; color: ' + colors.acceptText + ';' +
          'font-size: 13px; font-weight: 500; text-decoration: none;' +
          'transition: all 0.15s ease;' +
        '}' +
        '.og-contact-invite-link:hover { background: ' + colors.acceptHover + '; }' +

        '.og-contact-invite-dismiss {' +
          'background: none; border: none; color: ' + colors.textMuted + ';' +
          'font-size: 12px; cursor: pointer; padding: 4px 8px;' +
        '}' +
        '.og-contact-invite-dismiss:hover { opacity: 0.7; }' +

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

        '@media (max-width: 640px) {' +
          '.og-consent-banner-inner { flex-direction: column; text-align: center; }' +
          '.og-consent-actions { width: 100%; justify-content: center; }' +
          '.og-consent-gate-card { padding: 24px; }' +
        '}';

      document.head.appendChild(style);
    }

    // ─── Render ─────────────────────────────────────────────────────────

    function renderConsentBanner(consentConfig, onAccept, onDecline) {
      injectConsentStyles('bottom', consentConfig.theme);

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
        el.style.animation = 'og-slide-in 0.2s ease-in reverse';
        setTimeout(function() { el.remove(); }, 200);
        onAccept();
      });

      el.querySelector('[data-action="decline"]').addEventListener('click', function() {
        el.style.animation = 'og-slide-in 0.2s ease-in reverse';
        setTimeout(function() { el.remove(); }, 200);
        onDecline();
      });

      document.body.appendChild(el);
    }

    function renderConsentGate(consentConfig, jurisdiction, onAccept, onDecline) {
      injectConsentStyles('bottom', consentConfig.theme);

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
        el.style.animation = 'og-fade-in 0.2s ease-in reverse';
        setTimeout(function() { el.remove(); }, 200);
        onAccept();
      });

      el.querySelector('[data-action="decline"]').addEventListener('click', function() {
        el.style.animation = 'og-fade-in 0.2s ease-in reverse';
        setTimeout(function() { el.remove(); }, 200);
        onDecline();
      });

      document.body.appendChild(el);
    }

    // ─── Extension CTA (post-consent) ─────────────────────────────────

    var CONTACT_INVITE_SEEN_KEY = 'og_contact_invite_seen';

    function shouldShowExtensionCTA(extensionUrl) {
      if (!extensionUrl) return false;
      // Don't show if extension is already installed
      if (window.__contact && window.__contact.ready) return false;
      // Don't show if user previously dismissed
      try {
        if (localStorage.getItem(CONTACT_INVITE_SEEN_KEY)) return false;
      } catch (e) {}
      return true;
    }

    function renderExtensionCTA(extensionUrl) {
      if (!shouldShowExtensionCTA(extensionUrl)) return;

      // Small delay so it doesn't collide with the consent banner animating out
      setTimeout(function() {
        var el = document.createElement('div');
        el.className = 'og-contact-invite';
        el.setAttribute('role', 'complementary');
        el.setAttribute('aria-label', 'Browser extension');

        el.innerHTML =
          '<div style="display: flex; align-items: flex-start; gap: 12px;">' +
            '<div style="flex-shrink: 0; margin-top: 2px;">' + getGooseSVG(40) + '</div>' +
            '<div>' +
              '<div class="og-contact-invite-heading">Want your own copy of this data?</div>' +
              '<div class="og-contact-invite-body">' +
                'The OpenGander extension gives you a bilateral record of every session \u2014 ' +
                'the same data the site sees, in your browser.' +
              '</div>' +
              '<div class="og-contact-invite-actions">' +
                '<a class="og-contact-invite-link" target="_blank" rel="noopener">Get the extension</a>' +
                '<button class="og-contact-invite-dismiss" data-action="dismiss">Not now</button>' +
              '</div>' +
            '</div>' +
          '</div>';

        el.querySelector('.og-contact-invite-link').href = extensionUrl;

        el.querySelector('[data-action="dismiss"]').addEventListener('click', function() {
          el.style.animation = 'og-scale-in 0.2s ease-in reverse';
          setTimeout(function() { el.remove(); }, 200);
          try { localStorage.setItem(CONTACT_INVITE_SEEN_KEY, '1'); } catch (e) {}
        });

        // Auto-dismiss after 15 seconds
        setTimeout(function() {
          if (el.parentNode) {
            el.style.animation = 'og-scale-in 0.2s ease-in reverse';
            setTimeout(function() { if (el.parentNode) el.remove(); }, 200);
          }
        }, 15000);

        document.body.appendChild(el);
      }, 500);
    }

    // ─── SDK Interception ───────────────────────────────────────────────

    var realInit = window.initOtelBrowser;

    if (realInit) {
      window.initOtelBrowser = async function(userConfig) {
        var consentConfig = Object.assign({
          theme: 'auto', privacyUrl: null, expiry: 365, onConsent: null, text: {}
        }, userConfig.consent || {});
        consentConfig.text = Object.assign({
          heading: null, body: null, accept: null, decline: null
        }, consentConfig.text || {});

        if (checkDNT()) {
          if (userConfig.debug) {
            console.log('[OpenGander] Do Not Track detected \u2014 SDK will not initialize');
          }
          if (consentConfig.onConsent) consentConfig.onConsent(false, 'dnt');
          return;
        }

        var jurisdiction = detectJurisdiction();

        if (userConfig.debug) {
          console.log('[OpenGander] Jurisdiction detected:', jurisdiction.level.toUpperCase(),
            '(' + jurisdiction.jurisdiction + ')',
            'Signals:', jurisdiction.signals);
        }

        var stored = getStoredConsent();

        if (stored) {
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

        return new Promise(function(resolve) {
          function onAccept() {
            storeConsent('granted', consentConfig.expiry, jurisdiction.jurisdiction, jurisdiction.level);
            if (userConfig.debug) {
              console.log('[OpenGander] Consent granted (' + jurisdiction.level + '), initializing SDK');
            }
            if (consentConfig.onConsent) consentConfig.onConsent(true, jurisdiction.jurisdiction);
            // Show extension CTA after consent if configured
            if (consentConfig.extensionUrl) {
              renderExtensionCTA(consentConfig.extensionUrl);
            }
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
              renderConsentGate(consentConfig, jurisdiction, onAccept, onDecline);
            } else {
              renderConsentBanner(consentConfig, onAccept, onDecline);
            }
          }

          if (document.body) {
            show();
          } else {
            document.addEventListener('DOMContentLoaded', show);
          }
        });
      };
    }

    // ─── Public API ─────────────────────────────────────────────────────

    window.OpenGanderConsent = {
      getStatus: function() {
        var stored = getStoredConsent();
        return stored ? stored.status : 'pending';
      },
      getRecord: function() {
        return getStoredConsent();
      },
      getJurisdiction: function() {
        return detectJurisdiction();
      },
      grant: function() {
        var j = detectJurisdiction();
        storeConsent('granted', 365, j.jurisdiction, j.level);
      },
      deny: function() {
        var j = detectJurisdiction();
        storeConsent('denied', 365, j.jurisdiction, j.level);
      },
      revoke: function() {
        localStorage.removeItem(CONSENT_STORAGE_KEY);
        var keys = Object.keys(localStorage);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf('otel_') === 0 || keys[i].indexOf('og_') === 0) {
            localStorage.removeItem(keys[i]);
          }
        }
      },
      reset: function() {
        localStorage.removeItem(CONSENT_STORAGE_KEY);
      },
      show: function(options) {
        options = options || {};
        var consentConfig = {
          theme: options.theme || 'auto',
          privacyUrl: options.privacyUrl || null,
          text: options.text || {}
        };

        var jurisdiction = detectJurisdiction();

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
          renderConsentGate(consentConfig, jurisdiction, onAccept, onDecline);
        } else {
          renderConsentBanner(consentConfig, onAccept, onDecline);
        }

        return jurisdiction;
      }
    };
  } // end consent module

  // ═══ END CONSENT MODULE ═══════════════════════════════════════════════

  // Backward compatibility config for voidtalker.com
  // This preserves the exact behavior from v1 using the new pattern system
  window.VOIDTALKER_COMPAT_PATTERNS = {
    contentTypes: {
      'landing_page': { path: '/' },
      'resume': { path: '/resume' },
      'cv': { path: '/cv' },
      'blog_post': { path: '/musings/*' },
      'about_page': { path: '/about*' }
    },
    conversions: [
      {
        name: 'resume_download',
        match: { href: '*resume*', fileExtension: '.pdf' },
        category: 'conversion'
      },
      {
        name: 'cv_download',
        match: { href: '*cv*', fileExtension: '.pdf' },
        category: 'conversion'
      }
    ]
  };
})();
