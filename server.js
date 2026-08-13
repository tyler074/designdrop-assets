"use strict";

const express = require("express");
const net = require("net");
const dns = require("dns").promises;
const { chromium } = require("playwright-core");
const { paymentMiddleware } = require("x402-express");

const PORT = parseInt(process.env.PORT || "8402", 10);
const PAY_TO = process.env.PAY_TO_ADDRESS || "";
const NETWORK = process.env.X402_NETWORK || "base-sepolia";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const PRICE_SCREENSHOT = process.env.PRICE_SCREENSHOT || "$0.005";
const PRICE_PDF = process.env.PRICE_PDF || "$0.01";
const PRICE_MARKDOWN = process.env.PRICE_MARKDOWN || "$0.003";
const PRICE_PDF_TEXT = process.env.PRICE_PDF_TEXT || "$0.004";
const PRICE_HTML = process.env.PRICE_HTML || "$0.005";
const PRICE_UNFURL = process.env.PRICE_UNFURL || "$0.002";
const MAX_FETCH_BYTES = 15 * 1024 * 1024;
// Explicit CHROMIUM_PATH wins; otherwise fall back to playwright-core's own
// browser resolution (PLAYWRIGHT_BROWSERS_PATH or its default install dir).
const CHROMIUM_PATH = [process.env.CHROMIUM_PATH, "/opt/pw-browsers/chromium"]
  .filter(Boolean)
  .find((p) => { try { return require("fs").existsSync(p); } catch { return false; } });
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "4", 10);
const NAV_TIMEOUT_MS = parseInt(process.env.NAV_TIMEOUT_MS || "25000", 10);

const PAYMENTS_ENABLED = Boolean(PAY_TO);

// ---------------------------------------------------------------------------
// SSRF guard: refuse to render anything that resolves to a private network.
// Applied to the target URL and to every subresource request the page makes.
// ---------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::" || low === "::1") return true;
    if (low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd")) return true;
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7)); // v4-mapped
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true; // fail closed
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

async function assertPublicHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("invalid url"), { status: 400 });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("only http/https urls are allowed"), { status: 400 });
  }
  // WHATWG URL returns IPv6 literals wrapped in brackets; strip them so
  // net.isIP recognizes the address instead of falling through to DNS.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw Object.assign(new Error("private addresses are not allowed"), { status: 403 });
    return url;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw Object.assign(new Error("hostname does not resolve"), { status: 400 });
  }
  if (records.some((r) => isPrivateIp(r.address))) {
    throw Object.assign(new Error("private addresses are not allowed"), { status: 403 });
  }
  return url;
}

// ---------------------------------------------------------------------------
// Browser pool: one shared browser, a fresh context per request, and a
// simple semaphore so a burst of requests can't OOM the box.
// ---------------------------------------------------------------------------
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
    const extraArgs = (process.env.CHROMIUM_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);
    browserPromise = chromium
      .launch({
        ...(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {}),
        args: ["--no-sandbox", "--disable-dev-shm-usage", ...extraArgs],
        ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
      })
      .then((b) => {
        b.on("disconnected", () => { browserPromise = null; });
        return b;
      })
      .catch((err) => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

let inFlight = 0;
const waiters = [];
async function withSlot(fn) {
  if (inFlight >= MAX_CONCURRENT) await new Promise((resolve) => waiters.push(resolve));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    const next = waiters.shift();
    if (next) next();
  }
}

async function withPage(fn) {
  return withSlot(async () => {
    const browser = await getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: true });
    try {
      const page = await context.newPage();
      // Block subresource fetches into private networks too.
      await page.route("**/*", async (route) => {
        const reqUrl = route.request().url();
        try {
          await assertPublicHttpUrl(reqUrl);
          await route.continue();
        } catch {
          await route.abort("blockedbyclient");
        }
      });
      return await fn(page);
    } finally {
      await context.close().catch(() => {});
    }
  });
}

function clamp(n, lo, hi, dflt) {
  const v = parseInt(n, 10);
  if (Number.isNaN(v)) return dflt;
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", true); // behind Railway/Fly TLS-terminating proxies
app.use(express.json({ limit: "2mb" })); // /v1/html accepts raw HTML payloads

// `config.inputSchema` / `config.outputSchema` are forwarded verbatim into the
// x402 discovery entry (the Bazaar catalog), so agents browsing for a service
// can see the request/response shape and searchable tags without calling us.
const jsonBody = (fields) => ({ type: "http", bodyType: "application/json", bodyFields: fields });
const PRICING = {
  "POST /v1/screenshot": {
    price: PRICE_SCREENSHOT,
    network: NETWORK,
    config: {
      description: "Render a public URL to a PNG or JPEG screenshot (headless Chromium, JS-rendered)",
      mimeType: "image/png",
      inputSchema: jsonBody({ url: "public http(s) URL (required)", width: "320-3840", height: "320-2160", fullPage: "boolean", format: "png|jpeg", waitUntil: "load|domcontentloaded|networkidle", delayMs: "0-5000" }),
      outputSchema: { type: "binary", contentType: "image/png or image/jpeg", tags: ["screenshot", "render", "browser", "webpage", "image"] },
    },
  },
  "POST /v1/pdf": {
    price: PRICE_PDF,
    network: NETWORK,
    config: {
      description: "Render a public URL to a PDF (headless Chromium)",
      mimeType: "application/pdf",
      inputSchema: jsonBody({ url: "public http(s) URL (required)", scale: "0.5-2" }),
      outputSchema: { type: "binary", contentType: "application/pdf", tags: ["pdf", "render", "browser", "webpage", "print"] },
    },
  },
  "POST /v1/markdown": {
    price: PRICE_MARKDOWN,
    network: NETWORK,
    config: {
      description: "Extract a public URL's main content as clean Markdown (JS-rendered, Readability-extracted)",
      mimeType: "application/json",
      inputSchema: jsonBody({ url: "public http(s) URL (required)", waitUntil: "load|domcontentloaded|networkidle", delayMs: "0-5000" }),
      outputSchema: { type: "json", fields: { title: "string", byline: "string", siteName: "string", markdown: "string", textLength: "number" }, tags: ["markdown", "extract", "readability", "content", "scrape", "article"] },
    },
  },
  "POST /v1/pdf-text": {
    price: PRICE_PDF_TEXT,
    network: NETWORK,
    config: {
      description: "Extract text from a PDF at a public URL (connection-pinned fetch, 15MB max)",
      mimeType: "application/json",
      inputSchema: jsonBody({ url: "public http(s) URL of a PDF (required)" }),
      outputSchema: { type: "json", fields: { text: "string", pages: "number", info: "object", receipt: "object" }, tags: ["pdf", "text", "extract", "ocr-alternative", "document"] },
    },
  },
  "POST /v1/html": {
    price: PRICE_HTML,
    network: NETWORK,
    config: {
      description: "Render raw HTML you POST into a PNG, JPEG, or PDF (for invoices, cards, reports)",
      mimeType: "image/png",
      inputSchema: jsonBody({ html: "raw HTML string, max 2MB (required)", format: "png|jpeg|pdf", width: "320-3840", height: "320-2160", fullPage: "boolean" }),
      outputSchema: { type: "binary", contentType: "image/png, image/jpeg, or application/pdf", tags: ["html", "render", "pdf", "image", "invoice", "report", "template"] },
    },
  },
  "POST /v1/unfurl": {
    price: PRICE_UNFURL,
    network: NETWORK,
    config: {
      description: "Extract link-preview metadata (OpenGraph/Twitter/title/description/image/favicon) from a public URL",
      mimeType: "application/json",
      inputSchema: jsonBody({ url: "public http(s) URL (required)", waitUntil: "load|domcontentloaded|networkidle" }),
      outputSchema: { type: "json", fields: { title: "string", description: "string", image: "string", siteName: "string", favicon: "string", type: "string", canonical: "string" }, tags: ["unfurl", "link-preview", "opengraph", "metadata", "embed", "card"] },
    },
  },
};

if (PAYMENTS_ENABLED) {
  // Facilitator selection: with CDP credentials use Coinbase's facilitator
  // (required for mainnet `base`); otherwise the URL-based one (testnet default).
  let facilitatorConfig = { url: FACILITATOR_URL };
  if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
    facilitatorConfig = require("@coinbase/x402").facilitator;
    console.log("[snap402] using Coinbase CDP facilitator");
  } else if (NETWORK === "base" && FACILITATOR_URL === "https://x402.org/facilitator") {
    console.warn("[snap402] WARNING: network is 'base' (mainnet) but FACILITATOR_URL is the testnet default — set FACILITATOR_URL to a mainnet facilitator (e.g. https://facilitator.payai.network) or provide CDP keys");
  }
  app.use(paymentMiddleware(PAY_TO, PRICING, facilitatorConfig));
} else {
  console.warn("[snap402] PAY_TO_ADDRESS not set — running in FREE dev mode, no payments enforced");
}

// Free discovery endpoints -------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    service: "snap402",
    description: "Headless-browser rendering for agents. Pay per call with USDC via x402 — no accounts, no API keys.",
    payments: PAYMENTS_ENABLED ? { protocol: "x402", network: NETWORK } : "disabled (dev mode)",
    try_before_you_pay: {
      "POST /v1/demo": {
        price: "free",
        body: { url: "public http(s) URL", mode: "'markdown' (default) | 'screenshot'" },
        returns: "Truncated markdown, or a small JPEG as base64. Proves output quality before you fund a wallet.",
        limits: `${DEMO_PER_IP}/hour per client; output is truncated. Paid endpoints have no such limits.`,
      },
      "GET /skill.md": { price: "free", returns: "Installable agent skill describing every endpoint" },
    },
    endpoints: {
      "POST /v1/screenshot": {
        price: PRICE_SCREENSHOT,
        body: {
          url: "required — public http(s) URL",
          width: "viewport width px, 320-3840, default 1280",
          height: "viewport height px, 320-2160, default 800",
          fullPage: "boolean, default false",
          format: "'png' | 'jpeg', default png",
          waitUntil: "'load' | 'domcontentloaded' | 'networkidle', default load",
          delayMs: "extra settle time after load, 0-5000, default 0",
        },
        returns: "image bytes",
      },
      "POST /v1/pdf": {
        price: PRICE_PDF,
        body: { url: "required — public http(s) URL", scale: "0.5-2, default 1" },
        returns: "PDF bytes",
      },
      "POST /v1/markdown": {
        price: PRICE_MARKDOWN,
        body: {
          url: "required — public http(s) URL",
          waitUntil: "'load' | 'domcontentloaded' | 'networkidle', default load",
          delayMs: "extra settle time after load, 0-5000, default 0",
        },
        returns: "JSON: {title, byline, siteName, markdown, textLength}",
      },
      "POST /v1/pdf-text": {
        price: PRICE_PDF_TEXT,
        body: { url: "required — public http(s) URL of a PDF (max 15MB)" },
        returns: "JSON: {text, pages, info}",
      },
      "POST /v1/html": {
        price: PRICE_HTML,
        body: {
          html: "required — raw HTML to render (max 2MB)",
          format: "'png' | 'jpeg' | 'pdf', default png",
          width: "viewport width px, 320-3840, default 1280",
          height: "viewport height px, 320-2160, default 800",
          fullPage: "boolean, default false (png/jpeg only)",
        },
        returns: "image or PDF bytes",
      },
      "POST /v1/unfurl": {
        price: PRICE_UNFURL,
        body: {
          url: "required — public http(s) URL",
          waitUntil: "'load' | 'domcontentloaded' | 'networkidle', default domcontentloaded",
        },
        returns: "JSON: {url, title, description, image, siteName, favicon, type}",
      },
    },
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true, inFlight }));

// ---------------------------------------------------------------------------
// Free demo. Agents evaluating a service shouldn't have to fund a wallet just
// to find out whether the output is any good — so this proves quality in one
// call. Deliberately limited: truncated output, small viewport, per-IP and
// global caps, so it demonstrates the service without replacing it.
// ---------------------------------------------------------------------------
const DEMO_PER_IP = parseInt(process.env.DEMO_PER_IP || "5", 10);
const DEMO_IP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEMO_GLOBAL_PER_DAY = parseInt(process.env.DEMO_GLOBAL_PER_DAY || "500", 10);
const DEMO_MARKDOWN_CHARS = 1200;
const DEMO_TIMEOUT_MS = parseInt(process.env.DEMO_TIMEOUT_MS || "12000", 10);

const demoHits = new Map(); // ip -> timestamps[]
let demoGlobal = { day: 0, count: 0 };

function demoRateLimit(ip, nowMs) {
  const day = Math.floor(nowMs / 86400000);
  if (demoGlobal.day !== day) demoGlobal = { day, count: 0 };
  if (demoGlobal.count >= DEMO_GLOBAL_PER_DAY) {
    return { ok: false, reason: "daily demo capacity reached — paid endpoints are unaffected", retryAfter: 3600 };
  }
  const hits = (demoHits.get(ip) || []).filter((t) => nowMs - t < DEMO_IP_WINDOW_MS);
  if (hits.length >= DEMO_PER_IP) {
    return { ok: false, reason: `demo limit is ${DEMO_PER_IP} calls/hour per client`, retryAfter: Math.ceil((DEMO_IP_WINDOW_MS - (nowMs - hits[0])) / 1000) };
  }
  hits.push(nowMs);
  demoHits.set(ip, hits);
  demoGlobal.count++;
  // Keep the map from growing without bound.
  if (demoHits.size > 5000) {
    for (const [k, v] of demoHits) if (!v.some((t) => nowMs - t < DEMO_IP_WINDOW_MS)) demoHits.delete(k);
  }
  return { ok: true, remaining: DEMO_PER_IP - hits.length };
}

app.post("/v1/demo", async (req, res) => {
  const { url, mode } = req.body || {};
  const nowMs = Date.now();
  const gate = demoRateLimit(req.ip || "unknown", nowMs);
  if (!gate.ok) {
    res.set("Retry-After", String(gate.retryAfter));
    return res.status(429).json({ error: gate.reason, paid_endpoints_have_no_such_limit: true });
  }
  try {
    const target = await assertPublicHttpUrl(String(url || ""));
    const want = mode === "screenshot" ? "screenshot" : "markdown";
    const out = await withPage(async (page) => {
      await page.setViewportSize({ width: 1024, height: 640 });
      // Demos must feel instant; heavy ad-laden pages can stall "load" for a
      // long time. Paid endpoints let the caller choose waitUntil/delayMs.
      await page.goto(target.href, { timeout: DEMO_TIMEOUT_MS, waitUntil: "domcontentloaded" });
      if (want === "screenshot") {
        const buf = await page.screenshot({ type: "jpeg", quality: 55, timeout: DEMO_TIMEOUT_MS });
        return { screenshot_jpeg_base64: buf.toString("base64"), bytes: buf.length };
      }
      await page.addScriptTag({ content: READABILITY_SRC });
      const article = await page.evaluate(() => {
        // eslint-disable-next-line no-undef
        const parsed = new Readability(document.cloneNode(true), { charThreshold: 100 }).parse();
        return parsed || { title: document.title, content: document.body.innerHTML };
      });
      const md = new TurndownService({ headingStyle: "atx" }).turndown(article.content || "");
      return {
        title: article.title || null,
        markdown: md.slice(0, DEMO_MARKDOWN_CHARS),
        truncated: md.length > DEMO_MARKDOWN_CHARS,
        full_length: md.length,
      };
    });
    res.json({
      demo: true,
      mode: want,
      url: target.href,
      ...out,
      note: want === "markdown"
        ? `Demo truncates at ${DEMO_MARKDOWN_CHARS} chars. POST /v1/markdown ($0.003) returns the full document.`
        : "Demo renders a 1024x640 JPEG. POST /v1/screenshot ($0.005) gives full size, PNG, and fullPage.",
      demo_calls_remaining_this_hour: gate.remaining,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || "demo failed" });
  }
});

// Free, installable skill file: `curl -s <host>/skill.md > SKILL.md`
app.get("/skill.md", (_req, res) => {
  res.type("text/markdown").sendFile(require("path").join(__dirname, "skill", "SKILL.md"));
});

// Paid endpoints -------------------------------------------------------------
app.post("/v1/screenshot", async (req, res) => {
  const { url, width, height, fullPage, format, waitUntil, delayMs } = req.body || {};
  try {
    const target = await assertPublicHttpUrl(String(url || ""));
    const type = format === "jpeg" ? "jpeg" : "png";
    const buf = await withPage(async (page) => {
      await page.setViewportSize({
        width: clamp(width, 320, 3840, 1280),
        height: clamp(height, 320, 2160, 800),
      });
      await page.goto(target.href, {
        timeout: NAV_TIMEOUT_MS,
        waitUntil: ["load", "domcontentloaded", "networkidle"].includes(waitUntil) ? waitUntil : "load",
      });
      const settle = clamp(delayMs, 0, 5000, 0);
      if (settle) await page.waitForTimeout(settle);
      return page.screenshot({ type, fullPage: Boolean(fullPage), timeout: 15000 });
    });
    res.type(type === "jpeg" ? "image/jpeg" : "image/png").send(buf);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || "render failed" });
  }
});

app.post("/v1/pdf", async (req, res) => {
  const { url, scale } = req.body || {};
  try {
    const target = await assertPublicHttpUrl(String(url || ""));
    const buf = await withPage(async (page) => {
      await page.goto(target.href, { timeout: NAV_TIMEOUT_MS, waitUntil: "load" });
      return page.pdf({ scale: Math.min(2, Math.max(0.5, parseFloat(scale) || 1)), timeout: 15000 });
    });
    res.type("application/pdf").send(buf);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || "render failed" });
  }
});

const http = require("http");
const https = require("https");
const EGRESS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || "";

// Resolve a hostname and return only its public IPs, or throw. Used to pin the
// connection to addresses we validated, so DNS cannot rebind to a private
// target between the check and the connect.
async function resolvePublicIps(hostname) {
  const host = hostname.replace(/^\[|\]$/g, ""); // unwrap IPv6 literals
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw Object.assign(new Error("private addresses are not allowed"), { status: 403 });
    return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch {
    throw Object.assign(new Error("hostname does not resolve"), { status: 400 });
  }
  if (!records.length || records.some((r) => isPrivateIp(r.address))) {
    throw Object.assign(new Error("private addresses are not allowed"), { status: 403 });
  }
  return records;
}

// Connection-scoped fetch. Two modes, chosen by whether an egress proxy is set:
//
//   • No proxy (production): resolve+validate the host, pin the resolved public
//     IP set for THIS request, and force Node's connect to use only a pinned
//     address (custom `lookup`). On socket connect we re-check the actual peer
//     address. This closes the resolve-then-trust TOCTOU: a rebind to loopback
//     after validation can't take effect because loopback was never pinned.
//     Round-robin still works — any legitimate rotation stays inside the set.
//
//   • Proxy present (sandbox/controlled egress): the proxy owns DNS and the
//     socket, so app-side IP pinning is neither possible nor meaningful — the
//     proxy is the egress trust boundary. We still validate each hop's hostname
//     and route the bytes through the proxy via the browser's request stack.
//
// Returns { buffer, receipt }. The receipt is the audit trail the m/general
// thread argued is the real deliverable: redirect chain, resolved class, peer.
async function fetchPublicResource(startUrl) {
  const redirectChain = [];
  if (EGRESS_PROXY) {
    return withSlot(async () => {
      const browser = await getBrowser();
      const context = await browser.newContext();
      try {
        let url = startUrl;
        for (let hop = 0; hop <= 3; hop++) {
          await assertPublicHttpUrl(url);
          redirectChain.push(url);
          const resp = await context.request.get(url, { maxRedirects: 0, timeout: NAV_TIMEOUT_MS });
          const status = resp.status();
          if (status >= 300 && status < 400) {
            const loc = resp.headers()["location"];
            if (!loc) throw Object.assign(new Error("redirect without location"), { status: 502 });
            url = new URL(loc, url).href;
            continue;
          }
          if (status !== 200) throw Object.assign(new Error(`upstream returned ${status}`), { status: 502 });
          const len = parseInt(resp.headers()["content-length"] || "0", 10);
          if (len > MAX_FETCH_BYTES) throw Object.assign(new Error("resource too large (15MB max)"), { status: 413 });
          const buffer = await resp.body();
          if (buffer.length > MAX_FETCH_BYTES) throw Object.assign(new Error("resource too large (15MB max)"), { status: 413 });
          return { buffer, receipt: { finalUrl: url, redirectChain, hops: redirectChain.length, egress: "proxy", bytes: buffer.length } };
        }
        throw Object.assign(new Error("too many redirects"), { status: 502 });
      } finally {
        await context.close().catch(() => {});
      }
    });
  }

  // Direct mode with connect-time IP pinning.
  return withSlot(async () => {
    let url = startUrl;
    for (let hop = 0; hop <= 3; hop++) {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw Object.assign(new Error("only http/https urls are allowed"), { status: 400 });
      }
      redirectChain.push(url);
      const pinned = await resolvePublicIps(u.hostname);
      const pinnedSet = new Set(pinned.map((r) => r.address));
      const result = await new Promise((resolve, reject) => {
        const lib = u.protocol === "https:" ? https : http;
        const pick = pinned[0];
        // Force resolution to the pinned, pre-validated address set only.
        // Node's Happy-Eyeballs (autoSelectFamily) calls lookup with {all:true}
        // and expects an array; the 3-arg form is used otherwise.
        const pinnedLookup = (_host, opts, cb) =>
          opts && opts.all
            ? cb(null, pinned.map((r) => ({ address: r.address, family: r.family })))
            : cb(null, pick.address, pick.family);
        const request = lib.request(
          url,
          {
            method: "GET",
            timeout: NAV_TIMEOUT_MS,
            lookup: pinnedLookup,
          },
          (resp) => {
            // Belt-and-suspenders: verify the socket's real peer is pinned + public.
            const peer = resp.socket.remoteAddress?.replace(/^::ffff:/, "");
            if (!peer || !pinnedSet.has(peer) || isPrivateIp(peer)) {
              resp.destroy();
              return reject(Object.assign(new Error("peer address failed validation"), { status: 403 }));
            }
            const status = resp.statusCode;
            if (status >= 300 && status < 400) {
              resp.resume();
              const loc = resp.headers.location;
              if (!loc) return reject(Object.assign(new Error("redirect without location"), { status: 502 }));
              return resolve({ redirect: new URL(loc, url).href });
            }
            if (status !== 200) {
              resp.resume();
              return reject(Object.assign(new Error(`upstream returned ${status}`), { status: 502 }));
            }
            const len = parseInt(resp.headers["content-length"] || "0", 10);
            if (len > MAX_FETCH_BYTES) {
              resp.destroy();
              return reject(Object.assign(new Error("resource too large (15MB max)"), { status: 413 }));
            }
            const chunks = [];
            let size = 0;
            resp.on("data", (c) => {
              size += c.length;
              if (size > MAX_FETCH_BYTES) {
                resp.destroy();
                return reject(Object.assign(new Error("resource too large (15MB max)"), { status: 413 }));
              }
              chunks.push(c);
            });
            resp.on("end", () => resolve({ buffer: Buffer.concat(chunks), peer }));
          }
        );
        request.on("timeout", () => request.destroy(Object.assign(new Error("upstream timed out"), { status: 504 })));
        request.on("error", (e) => reject(Object.assign(e, { status: e.status || 502 })));
        request.end();
      });
      if (result.redirect) { url = result.redirect; continue; }
      return {
        buffer: result.buffer,
        receipt: { finalUrl: url, redirectChain, hops: redirectChain.length, egress: "direct", peer: result.peer, bytes: result.buffer.length },
      };
    }
    throw Object.assign(new Error("too many redirects"), { status: 502 });
  });
}

const { PDFParse } = require("pdf-parse");

app.post("/v1/pdf-text", async (req, res) => {
  const { url } = req.body || {};
  try {
    const target = await assertPublicHttpUrl(String(url || ""));
    const { buffer: buf, receipt } = await fetchPublicResource(target.href);
    if (buf.slice(0, 5).toString() !== "%PDF-") {
      throw Object.assign(new Error("resource is not a PDF"), { status: 422 });
    }
    const parser = new PDFParse({ data: buf });
    try {
      const result = await parser.getText();
      const info = await parser.getInfo().catch(() => null);
      res.json({
        text: result.text,
        pages: result.total,
        info: { title: info?.info?.Title || null, author: info?.info?.Author || null },
        receipt,
      });
    } finally {
      await parser.destroy().catch(() => {});
    }
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || "pdf extraction failed" });
  }
});

app.post("/v1/html", async (req, res) => {
  const { html, format, width, height, fullPage } = req.body || {};
  try {
    if (typeof html !== "string" || !html.trim()) {
      throw Object.assign(new Error("html (string) is required"), { status: 400 });
    }
    const fmt = ["png", "jpeg", "pdf"].includes(format) ? format : "png";
    const buf = await withPage(async (page) => {
      await page.setViewportSize({
        width: clamp(width, 320, 3840, 1280),
        height: clamp(height, 320, 2160, 800),
      });
      await page.setContent(html, { timeout: NAV_TIMEOUT_MS, waitUntil: "load" });
      if (fmt === "pdf") return page.pdf({ timeout: 15000 });
      return page.screenshot({ type: fmt, fullPage: Boolean(fullPage), timeout: 15000 });
    });
    res.type(fmt === "pdf" ? "application/pdf" : `image/${fmt}`).send(buf);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || "render failed" });
  }
});

app.post("/v1/unfurl", async (req, res) => {
  const { url, waitUntil } = req.body || {};
  try {
    const target = await assertPublicHttpUrl(String(url || ""));
    const meta = await withPage(async (page) => {
      await page.goto(target.href, {
        timeout: NAV_TIMEOUT_MS,
        waitUntil: ["load", "domcontentloaded", "networkidle"].includes(waitUntil) ? waitUntil : "domcontentloaded",
      });
      return page.evaluate(() => {
        const pick = (sels) => {
          for (const s of sels) {
            const el = document.querySelector(s);
            const v = el && (el.getAttribute("content") || el.getAttribute("href") || el.textContent);
            if (v && v.trim()) return v.trim();
          }
          return null;
        };
        const abs = (u) => { try { return u ? new URL(u, document.baseURI).href : null; } catch { return null; } };
        return {
          title: pick(['meta[property="og:title"]', 'meta[name="twitter:title"]', "title"]),
          description: pick(['meta[property="og:description"]', 'meta[name="twitter:description"]', 'meta[name="description"]']),
          image: abs(pick(['meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]'])),
          siteName: pick(['meta[property="og:site_name"]']),
          type: pick(['meta[property="og:type"]']),
          favicon: abs(pick(['link[rel="icon"]', 'link[rel="shortcut icon"]', 'link[rel="apple-touch-icon"]']) || "/favicon.ico"),
          canonical: abs(pick(['link[rel="canonical"]'])),
        };
      });
    });
    res.json({ url: target.href, ...meta });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || "unfurl failed" });
  }
});

const READABILITY_SRC = require("fs").readFileSync(
  require.resolve("@mozilla/readability/Readability.js"),
  "utf8"
);
const TurndownService = require("turndown");

app.post("/v1/markdown", async (req, res) => {
  const { url, waitUntil, delayMs } = req.body || {};
  try {
    const target = await assertPublicHttpUrl(String(url || ""));
    const article = await withPage(async (page) => {
      await page.goto(target.href, {
        timeout: NAV_TIMEOUT_MS,
        waitUntil: ["load", "domcontentloaded", "networkidle"].includes(waitUntil) ? waitUntil : "load",
      });
      const settle = clamp(delayMs, 0, 5000, 0);
      if (settle) await page.waitForTimeout(settle);
      await page.addScriptTag({ content: READABILITY_SRC });
      return page.evaluate(() => {
        // eslint-disable-next-line no-undef
        const parsed = new Readability(document.cloneNode(true), { charThreshold: 100 }).parse();
        if (parsed) return parsed;
        // Readability found no article — fall back to the raw body.
        return { title: document.title, byline: null, siteName: null, content: document.body.innerHTML };
      });
    });
    const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    const markdown = td.turndown(article.content || "");
    res.json({
      title: article.title || null,
      byline: article.byline || null,
      siteName: article.siteName || null,
      markdown,
      textLength: markdown.length,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message || "extraction failed" });
  }
});

app.listen(PORT, () => {
  console.log(`[snap402] listening on :${PORT} — payments ${PAYMENTS_ENABLED ? `ON (${NETWORK} → ${PAY_TO})` : "OFF (dev mode)"}`);
});
