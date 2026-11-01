'use strict';
/**
 * http.js — minimal HTTP layer for the Quark desktop protocol.
 *
 * Responsibilities:
 *  - flat cookie jar (the official client sends one Cookie header with every
 *    session cookie, regardless of which host set it)
 *  - manual redirect following so Set-Cookie on every hop is ingested
 *  - transport-level auth failure detection (401/403, HTML login pages)
 *  - streaming responses for downloads
 *
 * Zero dependencies; `fetchImpl` is injectable for tests.
 */

/** Business/transport-level "session is no longer valid" error. */
class AuthError extends Error {
  /**
   * @param {{code?: string, message: string, http?: number, url?: string}} opts
   */
  constructor(opts) {
    super(opts.message || 'authentication required');
    this.name = 'AuthError';
    this.code = opts.code || null;
    this.http = opts.http || null;
    this.url = opts.url || null;
  }
}

/**
 * Parse a single Set-Cookie header value into { name, value }.
 * Attributes (Path, Expires, HttpOnly, ...) are ignored — we keep the value.
 * @returns {{name: string, value: string}|null}
 */
function parseSetCookie(header) {
  if (typeof header !== 'string') return null;
  const first = header.split(';', 1)[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;
  return { name, value };
}

/** Extract Set-Cookie values from a fetch Headers object (Node >= 18.14). */
function getSetCookies(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    try { return headers.getSetCookie() || []; } catch (_e) { /* fall through */ }
  }
  const single = headers.get ? headers.get('set-cookie') : null;
  return single ? [single] : [];
}

class CookieJar {
  /** @param {Record<string,string>} [initial] */
  constructor(initial) {
    /** @type {Map<string,string>} */
    this.cookies = new Map();
    if (initial && typeof initial === 'object') {
      for (const [k, v] of Object.entries(initial)) {
        if (typeof v === 'string' && v !== '') this.cookies.set(k, v);
      }
    }
  }

  /** Ingest Set-Cookie header values. An empty value deletes the cookie. */
  ingest(setCookieHeaders) {
    for (const h of setCookieHeaders || []) {
      const parsed = parseSetCookie(h);
      if (!parsed) continue;
      if (parsed.value === '') this.cookies.delete(parsed.name);
      else this.cookies.set(parsed.name, parsed.value);
    }
  }

  /**
   * Ingest Set-Cookie values only when they come from a Quark API host.
   * @param {string[]} setCookieHeaders
   * @param {string} host the host that set them
   */
  ingestFrom(setCookieHeaders, host) {
    if (!COOKIE_HOSTS.has(String(host || '').toLowerCase())) return;
    this.ingest(setCookieHeaders);
  }

  /** Build the Cookie header value ("" when empty). */
  header() {
    return [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }

  get size() { return this.cookies.size; }

  /** True when the jar looks like an authenticated session. */
  looksAuthenticated() {
    // The desktop session always carries __puus (and usually __pus).
    return this.cookies.has('__puus') || this.cookies.has('__pus');
  }

  toJSON() {
    return Object.fromEntries(this.cookies);
  }

  static fromJSON(obj) {
    return new CookieJar(obj && typeof obj === 'object' ? obj : {});
  }
}

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Hosts whose Set-Cookie we accept into the session jar. The download CDN and
 * OSS hosts are deliberately excluded — their cookies are not session
 * credentials and must never be replayed to the API hosts.
 */
const COOKIE_HOSTS = new Set([
  'pan.quark.cn',
  'drive-pc.quark.cn',
  'uop.quark.cn',
  'quark.cn',
]);

class HttpClient {
  /**
   * @param {{
   *   cookieJar?: CookieJar,
   *   userAgent?: string,
   *   timeoutMs?: number,
   *   fetchImpl?: typeof fetch,
   *   maxRedirects?: number,
   *   logger?: {debug: Function, warn: Function},
   * }} [opts]
   */
  constructor(opts = {}) {
    this.cookieJar = opts.cookieJar || new CookieJar();
    this.userAgent = opts.userAgent || 'QuarkDrive/0.1';
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl || fetch;
    this.maxRedirects = opts.maxRedirects == null ? 10 : opts.maxRedirects;
    this.logger = opts.logger || { debug() {}, warn() {} };
  }

  /**
   * Perform a request with manual redirect handling.
   *
   * @param {string} method
   * @param {string} rawUrl
   * @param {{
   *   query?: Record<string,string|number|undefined>,
   *   body?: string|Buffer|null,
   *   headers?: Record<string,string>,
   *   timeoutMs?: number,
   *   signal?: AbortSignal,     // external cancellation (e.g. client disconnect)
   *   raw?: boolean,           // return the raw Response instead of buffering
   *   noCookie?: boolean,      // do not send the session cookie (e.g. OSS uploads)
   * }} [opts]
   * @returns {Promise<{status: number, headers: Headers, url: string, body: Buffer, response: Response}>}
   */
  async request(method, rawUrl, opts = {}) {
    let url = new URL(rawUrl);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const firstHost = url.host;
    /** cookies are only ever sent to the host we originally targeted */
    let maySendCookies = true;
    let redirects = 0;

    for (;;) {
      const headers = {
        'User-Agent': this.userAgent,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://pan.quark.cn/',
        'Origin': 'https://pan.quark.cn/',
      };
      const cookieHeader = (opts.noCookie || !maySendCookies) ? '' : this.cookieJar.header();
      if (cookieHeader) headers.Cookie = cookieHeader;
      if (opts.body != null) headers['Content-Type'] = 'application/json';
      Object.assign(headers, opts.headers || {});

      const timeoutMs = opts.timeoutMs || this.timeoutMs;
      /** @type {ReturnType<typeof setTimeout>|null} */
      let timer = null;
      const signals = [opts.signal].filter(Boolean);
      let signal = undefined;
      if (timeoutMs > 0 || signals.length) {
        const ac = new AbortController();
        signal = ac.signal;
        for (const s of signals) {
          if (s.aborted) ac.abort(s.reason);
          else s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
        }
        if (timeoutMs > 0) {
          timer = setTimeout(() => ac.abort(new Error('request timeout after ' + timeoutMs + 'ms')), timeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        }
      }

      let response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: opts.body == null ? undefined : opts.body,
          redirect: 'manual',
          signal,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Ingest cookies from this hop — but only from Quark API hosts
      // (session rotation). CDN/OSS hosts never contribute to the jar.
      this.cookieJar.ingestFrom(getSetCookies(response.headers), url.host);

      const location = response.headers.get ? response.headers.get('location') : null;
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (isRedirect && redirects < this.maxRedirects) {
        redirects++;
        const next = new URL(location, url);
        if (next.host !== firstHost) maySendCookies = false; // never leak the session cross-host
        url = next;
        // GET/HEAD keep the body across redirects; other methods drop it.
        if (method !== 'GET' && method !== 'HEAD') opts = { ...opts, body: null };
        continue;
      }

      if (opts.raw) return this._finish(response, url, opts);
      const body = Buffer.from(await response.arrayBuffer());
      return { status: response.status, headers: response.headers, url: url.toString(), body, response };
    }
  }

  _finish(response, url, _opts) {
    return { status: response.status, headers: response.headers, url: url.toString(), body: null, response };
  }

  /**
   * JSON convenience wrapper with transport-level auth detection.
   * Business-code auth detection (31001/31004/NO_AUTH) lives in api.js.
   *
   * @returns {Promise<any>} parsed JSON
   */
  async requestJson(method, rawUrl, opts = {}) {
    const res = await this.request(method, rawUrl, opts);
    const text = res.body.toString('utf8');

    if (res.status === 401 || res.status === 403) {
      throw new AuthError({ http: res.status, message: 'http ' + res.status, url: rawUrl });
    }
    const ct = res.headers.get ? (res.headers.get('content-type') || '') : '';
    if (ct.toLowerCase().includes('text/html')) {
      throw new AuthError({
        code: 'EXCEPTION_BODY',
        message: 'server returned HTML (session likely invalid)',
        http: res.status,
        url: rawUrl,
      });
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      if (res.status >= 400) {
        throw new AuthError({ http: res.status, message: text.slice(0, 200), url: rawUrl });
      }
      throw new Error('invalid JSON from ' + rawUrl + ': ' + text.slice(0, 200));
    }
  }
}

module.exports = { HttpClient, CookieJar, AuthError, parseSetCookie };
