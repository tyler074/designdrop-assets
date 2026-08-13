# snap402

Headless-browser rendering for AI agents, paid per call with USDC via
[x402](https://www.x402.org/). No accounts, no API keys, no billing dashboard:
an agent hits the endpoint, gets an HTTP 402 quote, pays on Base, and gets its
pixels.

**Why this service:** most agents run in sandboxes without a browser. Rendering
a URL to a PNG or PDF is one of the most common things they can't do
themselves — and at $0.005/call they don't need a subscription to do it.

## Endpoints

| Endpoint | Price | Description |
|---|---|---|
| `GET /` | free | Machine-readable service + pricing discovery |
| `GET /healthz` | free | Liveness probe |
| `POST /v1/screenshot` | `$0.005` | Render a public URL to PNG/JPEG |
| `POST /v1/pdf` | `$0.01` | Render a public URL to PDF |
| `POST /v1/markdown` | `$0.003` | Extract a URL's main content as clean Markdown (JS-rendered, Readability) |
| `POST /v1/pdf-text` | `$0.004` | Extract text from a PDF at a public URL (15MB max) |
| `POST /v1/html` | `$0.005` | Render raw HTML you POST into PNG, JPEG, or PDF |
| `POST /v1/unfurl` | `$0.002` | Extract link-preview metadata (OpenGraph/Twitter/title/image/favicon) |

## Try it free (no wallet)

```bash
curl -sX POST https://designdrop-assets-production.up.railway.app/v1/demo \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'
```

Returns truncated Markdown (or `"mode":"screenshot"` for a small JPEG as
base64). Rate-limited to 5/hour per client and deliberately truncated — it
exists so you can judge output quality before funding a wallet. Paid endpoints
have no such limits.

## Install as an agent skill

```bash
curl -s https://designdrop-assets-production.up.railway.app/skill.md > SKILL.md
```

Free, no signup. Source: [`skill/SKILL.md`](skill/SKILL.md).

## Client

Any x402-capable HTTP client works. A ready-to-use wrapper lives in
[`examples/snap402-client.mjs`](examples/snap402-client.mjs):

```js
import { makeClient } from "./examples/snap402-client.mjs";
const snap = makeClient(process.env.PRIVATE_KEY); // Base wallet with a little USDC

const png     = await snap.screenshot("https://example.com"); // Buffer
const article = await snap.markdown("https://example.com");   // { markdown, ... }
const preview = await snap.unfurl("https://example.com");     // { title, image, ... }
```

The first call to each endpoint returns HTTP 402 with a price; `x402-fetch`
signs the USDC payment and retries automatically. Your key signs an EIP-3009
authorization — it is never transmitted.

### `POST /v1/screenshot`

```json
{
  "url": "https://example.com",     // required, public http(s) only
  "width": 1280,                     // 320-3840
  "height": 800,                     // 320-2160
  "fullPage": false,
  "format": "png",                  // or "jpeg"
  "waitUntil": "load",              // or "domcontentloaded" | "networkidle"
  "delayMs": 0                       // extra settle time, max 5000
}
```

Returns raw image bytes. `POST /v1/pdf` takes `{url, scale}` and returns PDF bytes.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `PAY_TO_ADDRESS` | *(unset)* | Your wallet address. **Unset = free dev mode, loud warning.** |
| `X402_NETWORK` | `base-sepolia` | `base` for mainnet USDC |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | Payment facilitator (testnet default) |
| `PRICE_SCREENSHOT` | `$0.005` | Per-call price |
| `PRICE_PDF` | `$0.01` | Per-call price |
| `PORT` | `8402` | Listen port |
| `MAX_CONCURRENT` | `4` | Simultaneous renders |
| `NAV_TIMEOUT_MS` | `25000` | Page-load timeout |
| `CHROMIUM_PATH` | *(auto)* | Explicit Chromium binary; otherwise playwright-core resolves |
| `CHROMIUM_EXTRA_ARGS` | *(unset)* | Extra Chromium flags (see sandbox note) |

## Run it

```bash
npm ci
PAY_TO_ADDRESS=0xYourAddress node server.js
```

Or Docker:

```bash
docker build -t snap402 .
docker run -p 8402:8402 -e PAY_TO_ADDRESS=0xYourAddress -e X402_NETWORK=base snap402
```

### Going to mainnet

The default facilitator only settles **Base Sepolia (testnet)** payments. For
real USDC on Base, pick a mainnet facilitator:

**Option A — open facilitator, no signup (e.g. PayAI):**

```
X402_NETWORK=base
FACILITATOR_URL=https://facilitator.payai.network
```

**Option B — Coinbase CDP (requires CDP account/API key):**

```
X402_NETWORK=base
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
```

The server switches to the Coinbase facilitator automatically when the CDP
variables are present. Either way, payments land directly in `PAY_TO_ADDRESS`
as USDC — the facilitator only verifies/settles; it never holds your funds,
and neither does this server.

## Paying the endpoint (client side)

Any x402-capable client works, e.g. `x402-fetch`:

```js
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const fetchWithPay = wrapFetchWithPayment(fetch, privateKeyToAccount(PRIVATE_KEY));
const res = await fetchWithPay("https://your-host/v1/screenshot", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com" }),
});
```

## Security notes

- **SSRF guard**: the target URL *and every subresource the page requests* are
  resolved and refused if they point at loopback / private / link-local /
  carrier-grade-NAT ranges, including IPv6 forms (v4-mapped `::ffff:`, `::`,
  `::1`). Anything unparseable fails closed.
- **Connection-scoped pinning** (`/v1/pdf-text`, direct mode): the fetch
  resolves and validates the host, then pins that public IP set for the
  request and forces the socket to connect only to a pinned address, with a
  post-connect re-check of the actual peer. This closes the resolve-then-trust
  TOCTOU (DNS rebinding): a record that flips to loopback *after* validation
  can't take effect, because loopback was never in the pinned set. Legitimate
  round-robin still works — any rotation stays inside the pinned set.
  - When an egress **proxy** is configured (`HTTPS_PROXY`), the proxy owns DNS
    and the socket and is the egress trust boundary, so app-side IP pinning is
    not applicable; each redirect hop's hostname is still validated. The
    `receipt.egress` field reports which mode ran (`"direct"` or `"proxy"`).
- **Redirects** are followed manually (max 3 hops), re-validating every hop —
  no auto-follow that could smuggle a public→private redirect past the guard.
- **Audit receipt**: `/v1/pdf-text` returns a `receipt` — final URL, redirect
  chain, egress mode, verified peer IP, byte count — so a caller can prove
  where the bytes actually came from. A guard without an audit trail is a vibe.
- **Browser-path caveat**: for the rendering endpoints (`/v1/screenshot`,
  `/v1/pdf`, `/v1/markdown`, `/v1/html`) Chromium performs its own DNS
  resolution, so those paths re-validate each request's hostname at the request
  layer but do **not** yet have socket-level peer pinning — a narrow TOCTOU
  window remains. Fully closing it needs a forward proxy that validates at
  connect time; that's the next hardening step. Until then, if you deploy next
  to sensitive internal services, put this in its own network segment.
- Request bodies are capped (64 KB JSON, 2 MB for `/v1/html`); viewports and
  delays are clamped; concurrent renders are limited by a semaphore.
- The service holds **no keys and no funds**. It only ever learns your public
  receiving address.

## Sandboxed-CI note

If you're testing in an environment that forces traffic through a TLS-
intercepting egress proxy, Chromium's TLS 1.3 post-quantum ClientHello can get
reset by the relay. `HTTPS_PROXY` is honored automatically; if you still see
`ERR_CONNECTION_RESET`, set `CHROMIUM_EXTRA_ARGS="--ssl-version-max=tls1.2"`
**in the sandbox only** (certificates are still fully verified). Do not set it
in production.
