'use strict';
/**
 * auth.js — Quark QR-code (scan) login flow, mirroring the official desktop
 * client handshake:
 *
 *   1. GET  uop.quark.cn/cas/ajax/getTokenForQrcodeLogin        -> token
 *   2. render  su.quark.cn/4_eMHBJ?token=...  as a QR code
 *   3. GET  uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken -> status/ticket
 *   4. GET  pan.quark.cn/desktop/account/login?st=<ticket>      -> session cookies
 *
 * SECURITY: the QR URL embeds a live login token. It is treated as a secret:
 * never written to logs, never persisted, and the redacted form strips the
 * token value.
 */
const { AuthError } = require('./http.js');
const crypto = require('node:crypto');

const UOP_BASE = 'https://uop.quark.cn/cas/ajax';
const SCAN_PAGE = 'https://su.quark.cn/4_eMHBJ';
const PAN_LOGIN_URL = 'https://pan.quark.cn/desktop/account/login';

const CLIENT_ID = '386';
const CLIENT_VER = '1.2';
const APP_VERSION = '3.24.0';
const CHANNEL = 'pckk@information_ch';

// getServiceTicketByQrcodeToken business statuses
const ST_CONFIRMED = 2000000;
const ST_WAITING = 50004001; // "Query result is empty" while the QR is unscanned
const ST_EXPIRED = 50004002;

const QR_TTL_MS = 3 * 60 * 1000; // codes rotate; the official client uses ~3 min

/**
 * Correlation nonce for the cas handshake. Uses the crypto PRNG, not the
 * non-cryptographic one: it is not a session secret, but every other value in
 * this codebase that a server could conceivably bind to replay/CSRF
 * protection is CSPRNG-sourced (audit finding C-3).
 */
function uniqueRequestId() {
  const rnd = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  return String(Date.now()) + rnd;
}

/** Replace the token value in a scan URL with a redacted placeholder. */
function redactQrUrl(qrUrl) {
  try {
    const u = new URL(qrUrl);
    if (u.searchParams.has('token')) u.searchParams.set('token', '<redacted>');
    return u.toString();
  } catch (_e) {
    return '<scan-url>';
  }
}

class QrLogin {
  /**
   * @param {{
   *   http: import('./http.js').HttpClient,
   *   device: import('../device.js').Device,
   *   logger?: {debug: Function, info: Function, warn: Function},
   * }} deps
   */
  constructor(deps) {
    this.http = deps.http;
    this.device = deps.device;
    this.logger = deps.logger || { debug() {}, info() {}, warn() {} };
    /** @type {{token: string, qrUrl: string, createdAt: number}|null} */
    this.pending = null;
  }

  /** Common query parameters shared by the cas endpoints. */
  _baseParams() {
    return {
      pr: 'ucpro',
      fr: 'pc',
      sys: 'win32',
      client_id: CLIENT_ID,
      v: CLIENT_VER,
      request_id: uniqueRequestId(),
      uc_param_str: 'utprfr',
      ut: this.device.ut,
      mi: this.device.mi,
    };
  }

  /**
   * Step 1+2: fetch a login token and build the QR URL.
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{token: string, qrUrl: string, redactedUrl: string, expiresAt: number}>}
   */
  async start(opts = {}) {
    const out = await this.http.requestJson('GET', UOP_BASE + '/getTokenForQrcodeLogin', {
      query: this._baseParams(),
      signal: opts.signal,
    });
    const token = out && out.data && out.data.members && out.data.members.token;
    if (!out || out.status !== ST_CONFIRMED || !token) {
      throw new Error('getTokenForQrcodeLogin failed: status=' + (out && out.status) +
        ' message=' + (out && out.message));
    }
    const qrUrl = this._buildScanUrl(token);
    this.pending = { token, qrUrl, createdAt: Date.now() };
    this.logger.debug('qr login: code ready (' + redactQrUrl(qrUrl) + ')');
    return {
      token,
      qrUrl,
      redactedUrl: redactQrUrl(qrUrl),
      expiresAt: this.pending.createdAt + QR_TTL_MS,
    };
  }

  /** Build the scan URL the Quark app camera reads. */
  _buildScanUrl(token) {
    const u = new URL(SCAN_PAGE);
    u.searchParams.set('token', token);
    u.searchParams.set('client_id', CLIENT_ID);
    u.searchParams.set('sch', CHANNEL);
    u.searchParams.set('sve', APP_VERSION);
    u.searchParams.set('ssb', 'weblogin');
    u.searchParams.set('uc_param_str', '');
    u.searchParams.set('uc_biz_str', 'S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0');
    return u.toString();
  }

  /**
   * Step 3: poll the scan status once.
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{status: 'waiting'|'confirmed'|'expired', ticket?: string, rawStatus?: number, message?: string}>}
   */
  async poll(opts = {}) {
    if (!this.pending) throw new Error('qr login: call start() first');
    const out = await this.http.requestJson('GET', UOP_BASE + '/getServiceTicketByQrcodeToken', {
      query: { ...this._baseParams(), token: this.pending.token },
      signal: opts.signal,
    });
    const rawStatus = out && out.status;
    const ticket = out && out.data && out.data.members && out.data.members.service_ticket;
    if (rawStatus === ST_CONFIRMED) {
      if (!ticket) throw new Error('qr login: confirmed but no service_ticket');
      return { status: 'confirmed', ticket, rawStatus };
    }
    if (rawStatus === ST_EXPIRED) return { status: 'expired', rawStatus, message: out.message };
    if (rawStatus === ST_WAITING) return { status: 'waiting', rawStatus, message: out.message };
    return { status: 'waiting', rawStatus, message: (out && out.message) || ('status=' + rawStatus) };
  }

  /**
   * Step 4: exchange the service ticket for session cookies.
   * The response's Set-Cookie headers are ingested by the HttpClient jar.
   * @param {string} ticket
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{cookies: Record<string,string>, body: any}>}
   */
  async complete(ticket, opts = {}) {
    const res = await this.http.request('GET', PAN_LOGIN_URL, {
      query: { st: ticket, fr: 'pc', pr: 'ucpro', mi: this.device.mi, ut: this.device.ut },
      signal: opts.signal,
    });
    if (res.status >= 400) {
      throw new AuthError({ http: res.status, message: 'pan login http ' + res.status, url: PAN_LOGIN_URL });
    }
    const cookies = this.http.cookieJar.toJSON();
    if (!this.http.cookieJar.looksAuthenticated()) {
      throw new AuthError({
        code: 'NO_SESSION_COOKIE',
        message: 'login returned no session cookie (__puus)',
        url: PAN_LOGIN_URL,
      });
    }
    this.pending = null;
    this.logger.info('qr login: session established (' + Object.keys(cookies).length + ' cookies)');
    let body = null;
    try { body = JSON.parse(res.body.toString('utf8')); } catch (_e) { /* html/empty body is fine */ }
    return { cookies, body };
  }

  /**
   * Full flow: start → poll until confirmed/expired → complete.
   *
   * @param {{
   *   onQr?: (info: {qrUrl: string, redactedUrl: string, expiresAt: number}) => void,
   *   onStatus?: (msg: string) => void,
   *   intervalMs?: number,
   *   timeoutMs?: number,
   *   signal?: {aborted: boolean, addEventListener?: Function},
   *   sleep?: (ms: number) => Promise<void>,
   * }} [opts]
   * @returns {Promise<{cookies: Record<string,string>}>}
   */
  async run(opts = {}) {
    const intervalMs = opts.intervalMs || 2000;
    const timeoutMs = opts.timeoutMs || QR_TTL_MS;
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    const started = await this.start({ signal: opts.signal });
    if (opts.onQr) opts.onQr(started);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (opts.signal && opts.signal.aborted) throw new Error('qr login aborted');
      const poll = await this.poll({ signal: opts.signal });
      if (poll.status === 'confirmed') {
        if (opts.onStatus) opts.onStatus('scan confirmed');
        return this.complete(poll.ticket, { signal: opts.signal });
      }
      if (poll.status === 'expired') {
        // Refresh the code once and keep waiting (official client behaviour).
        if (opts.onStatus) opts.onStatus('qr expired, refreshing');
        const refreshed = await this.start({ signal: opts.signal });
        if (opts.onQr) opts.onQr(refreshed);
      } else if (opts.onStatus) {
        opts.onStatus('waiting for scan');
      }
      if (Date.now() > deadline) throw new Error('qr login timeout');
      await sleep(intervalMs);
    }
  }
}

module.exports = {
  QrLogin,
  redactQrUrl,
  UOP_BASE,
  SCAN_PAGE,
  PAN_LOGIN_URL,
  ST_CONFIRMED,
  ST_WAITING,
  ST_EXPIRED,
  CLIENT_ID,
  CHANNEL,
  APP_VERSION,
};
