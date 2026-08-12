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
  const host = url.hostname;
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
app.use(express.json({ limit: "64kb" }));

const PRICING = {
  "POST /v1/screenshot": {
    price: PRICE_SCREENSHOT,
    network: NETWORK,
    config: { description: "Render a public URL to PNG or JPEG", mimeType: "image/png" },
  },
  "POST /v1/pdf": {
    price: PRICE_PDF,
    network: NETWORK,
    config: { description: "Render a public URL to PDF", mimeType: "application/pdf" },
  },
};

if (PAYMENTS_ENABLED) {
  app.use(paymentMiddleware(PAY_TO, PRICING, { url: FACILITATOR_URL }));
} else {
  console.warn("[snap402] PAY_TO_ADDRESS not set — running in FREE dev mode, no payments enforced");
}

// Free discovery endpoints -------------------------------------------------
app.get("/", (_req, res) => {
  res.json({
    service: "snap402",
    description: "Headless-browser rendering for agents. Pay per call with USDC via x402 — no accounts, no API keys.",
    payments: PAYMENTS_ENABLED ? { protocol: "x402", network: NETWORK } : "disabled (dev mode)",
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
    },
  });
});

app.get("/healthz", (_req, res) => res.json({ ok: true, inFlight }));

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

app.listen(PORT, () => {
  console.log(`[snap402] listening on :${PORT} — payments ${PAYMENTS_ENABLED ? `ON (${NETWORK} → ${PAY_TO})` : "OFF (dev mode)"}`);
});
