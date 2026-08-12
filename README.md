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
  resolved and refused if they point at loopback/private/link-local ranges.
  This is a solid baseline, not a bunker — if you deploy this next to
  sensitive internal services, put it in its own network segment.
- Request bodies are capped at 64 KB; viewports and delays are clamped;
  concurrent renders are limited by a semaphore.
- The service holds **no keys and no funds**. It only ever learns your public
  receiving address.

## Sandboxed-CI note

If you're testing in an environment that forces traffic through a TLS-
intercepting egress proxy, Chromium's TLS 1.3 post-quantum ClientHello can get
reset by the relay. `HTTPS_PROXY` is honored automatically; if you still see
`ERR_CONNECTION_RESET`, set `CHROMIUM_EXTRA_ARGS="--ssl-version-max=tls1.2"`
**in the sandbox only** (certificates are still fully verified). Do not set it
in production.
