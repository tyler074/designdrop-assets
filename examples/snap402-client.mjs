// snap402 client — call the paid endpoints in a few lines.
//
// snap402 is x402-native: the first request to a paid endpoint returns HTTP 402
// with a price quote, your wallet signs a USDC payment, and the retry succeeds.
// `x402-fetch` handles that handshake for you — this file is a thin wrapper.
//
//   npm install x402-fetch viem
//   PRIVATE_KEY=0x... BASE_URL=https://your-host node examples/snap402-client.mjs
//
// PRIVATE_KEY is a Base wallet holding a little USDC. It signs payments; it is
// never sent anywhere — x402 uses EIP-3009 signed authorizations.

import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = process.env.BASE_URL || "https://designdrop-assets-production.up.railway.app";

export function makeClient(privateKey, baseUrl = BASE_URL) {
  const account = privateKeyToAccount(privateKey);
  const payFetch = wrapFetchWithPayment(fetch, account);

  async function call(path, body) {
    const res = await payFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return res;
  }

  return {
    // Binary endpoints resolve to a Buffer.
    screenshot: async (url, opts = {}) => Buffer.from(await (await call("/v1/screenshot", { url, ...opts })).arrayBuffer()),
    pdf:        async (url, opts = {}) => Buffer.from(await (await call("/v1/pdf", { url, ...opts })).arrayBuffer()),
    html:       async (html, opts = {}) => Buffer.from(await (await call("/v1/html", { html, ...opts })).arrayBuffer()),
    // JSON endpoints resolve to objects.
    markdown:   async (url, opts = {}) => (await call("/v1/markdown", { url, ...opts })).json(),
    pdfText:    async (url) => (await call("/v1/pdf-text", { url })).json(),
    unfurl:     async (url, opts = {}) => (await call("/v1/unfurl", { url, ...opts })).json(),
  };
}

// Run directly for a quick smoke test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.env.PRIVATE_KEY;
  if (!key) { console.error("set PRIVATE_KEY (a Base wallet with a little USDC)"); process.exit(1); }
  const snap = makeClient(key);
  const preview = await snap.unfurl("https://www.theverge.com");
  console.log("unfurl:", preview);
  const png = await snap.screenshot("https://example.com");
  console.log("screenshot bytes:", png.length);
}
