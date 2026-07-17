// frymarket-x402 — x402 pay-per-request marketplace data API for fry.market.
// Data-only sidecar: every paid route proxies a read GET on the FastAPI backend
// (localhost:6000) and returns JSON. Non-custodial, no tx builders (v2). Mirrors
// the fry.farm fry-x402 x402 wiring (@x402-avm/express, GoPlausible facilitator).
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402-avm/express";
import { registerExactAvmScheme } from "@x402-avm/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402-avm/core/server";
import { ALGORAND_MAINNET_CAIP2, USDC_MAINNET_ASA_ID } from "@x402-avm/avm";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";

const PORT = Number(process.env.PORT || 6402);
const BIND = process.env.BIND || "127.0.0.1";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:6000";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://facilitator.goplausible.xyz";
const PAY_TO = process.env.PAY_TO || "E2F2LT2INE75DBOYHQXTCTOP2PAP5MHAXQRXTTCCXFKHQTVG36DJONBQZE";
// Edge (Bunny -> frontend nginx) strips /x402 and terminates TLS; pin public resource per route.
const PUBLIC_X402_BASE = process.env.PUBLIC_X402_BASE || "https://fry.market/x402";

const PRICE = {
  collections: "$0.005",
  collection: "$0.008",
  listings: "$0.008",
  bids: "$0.005",
  genesis: "$0.005",
  history: "$0.01",
};

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
// Defense-in-depth: x402 responses must never be cached (fresh 402 nonce per request).
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const server = new x402ResourceServer(facilitatorClient);
registerExactAvmScheme(server);

const X402_META = {
  scheme: "exact",
  network: ALGORAND_MAINNET_CAIP2,
  asset: String(USDC_MAINNET_ASA_ID),
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  facilitator: FACILITATOR_URL,
  x402Version: 2,
};

function priceToAtomic(p) {
  return Math.round(Number(String(p).replace("$", "")) * 1e6);
}

// Bazaar discovery input schema from a params doc map (same data as /catalog).
function paramDiscovery(params = {}) {
  const properties = {};
  for (const [k, d] of Object.entries(params)) {
    properties[k] = { type: "string", description: String(d) };
  }
  const required = Object.keys(params).filter((k) => !/optional/i.test(String(params[k])));
  return { properties, required };
}
function exampleQuery(params = {}) {
  const q = {};
  for (const [k, d] of Object.entries(params)) {
    if (/optional/i.test(String(d))) continue;
    q[k] = /address/.test(k) ? "<algorand address>" : /id/i.test(k) ? "<id>" : "<value>";
  }
  return q;
}

const accept = (price, description, publicPath, outputExample, params) => ({
  accepts: { scheme: "exact", network: ALGORAND_MAINNET_CAIP2, payTo: PAY_TO, price, extra: { asset: USDC_MAINNET_ASA_ID } },
  description,
  resource: PUBLIC_X402_BASE + publicPath,
  extensions: declareDiscoveryExtension({
    ...(params && Object.keys(params).length ? { input: exampleQuery(params), inputSchema: paramDiscovery(params) } : {}),
    output: { example: outputExample },
  }),
});

// --- read-GET proxy to the FastAPI backend ---
async function bget(path, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(BACKEND_URL + path, { headers: { accept: "application/json" }, signal: ctl.signal });
    if (!r.ok) throw new Error(`upstream ${path} -> ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Endpoint registry — drives the payment routes map, the free /catalog, and the handlers.
const endpoints = {
  "market/collections": {
    price: PRICE.collections,
    summary: "All fry.market NFT collections with metadata and listed-NFT references.",
    params: {},
    outputExample: [{ collection_name: "Example", collection_address: "S3UZ…", listed_nfts: [], image_url: "https://…", description: "…" }],
    handler: async () => ({ collections: await bget("/get-all-collections") }),
  },
  "market/collection": {
    price: PRICE.collection,
    summary: "Detail for one collection by address (metadata + NFTs).",
    params: { address: "collection_address (Algorand address)" },
    outputExample: { collection: { collection_name: "Example", collection_address: "S3UZ…" }, nfts: [] },
    handler: async (q) => {
      const address = reqStr(q.address, "address");
      const [collection, nfts] = await Promise.all([
        bget(`/get-collection/${encodeURIComponent(address)}`).catch(() => null),
        bget(`/collection-nfts/${encodeURIComponent(address)}`).catch(() => ({ nfts: [] })),
      ]);
      return { collection, nfts };
    },
  },
  "market/listings": {
    price: PRICE.listings,
    summary: "Active marketplace listings snapshot (paged).",
    params: {},
    outputExample: { listings: [], total: 0, page: 1, pages: 0 },
    handler: async () => bget("/get-active-listings"),
  },
  "market/bids": {
    price: PRICE.bids,
    summary: "Bid book for a listing by listingId.",
    params: { listingId: "listing id" },
    outputExample: { bids: [] },
    handler: async (q) => ({ bids: await bget(`/get-bids/${encodeURIComponent(reqStr(q.listingId, "listingId"))}`) }),
  },
  "market/genesis": {
    price: PRICE.genesis,
    summary: "Fry Genesis NFT global mint stats (supply, minted, price, paused).",
    params: {},
    outputExample: { total_supply: 1000, total_minted: 12, price_usdc: 175, mint_asset_id: 31566704, paused: 0 },
    handler: async () => bget("/genesis/mint-stats"),
  },
  "market/history": {
    price: PRICE.history,
    summary: "Marketplace transaction history for a wallet address.",
    params: { address: "wallet address (Algorand address)" },
    outputExample: { history: [] },
    handler: async (q) => ({ history: await bget(`/transaction-history/${encodeURIComponent(reqStr(q.address, "address"))}`) }),
  },
};

function reqStr(v, field) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`missing required query param '${field}'`);
  return v.trim();
}

// Payment routes map (the gate only intercepts these).
const routes = {};
for (const [key, def] of Object.entries(endpoints)) {
  routes[`GET /${key}`] = accept(def.price, def.summary, `/${key}`, def.outputExample, def.params);
}

// Free machine-readable catalog (identical schema to fry.farm's).
function catalogJson() {
  const dataEndpoints = Object.entries(endpoints).map(([key, def]) => ({
    action: key,
    method: "GET",
    path: `/x402/${key}`,
    priceUsdc: def.price,
    priceAtomic: priceToAtomic(def.price),
    params: def.params,
    returns: def.summary,
    x402: X402_META,
  }));
  return {
    service: "fry.market x402 marketplace data",
    description: "Paid, read-only marketplace data for autonomous agents — collections, listings, bids, Genesis stats, and wallet history on fry.market (Algorand NFT marketplace). x402 payment is the only auth — no API keys, no accounts.",
    network: "algorand-mainnet",
    networkCaip2: ALGORAND_MAINNET_CAIP2,
    asset: { name: "USDC", id: String(USDC_MAINNET_ASA_ID), decimals: 6 },
    payTo: PAY_TO,
    facilitator: FACILITATOR_URL,
    x402Version: 2,
    dataEndpoints,
  };
}

app.get("/health", (_req, res) => res.json({ status: "ok", service: "frymarket-x402" }));
app.get("/catalog", (_req, res) => res.json(catalogJson()));
app.get("/", (_req, res) => {
  const rows = Object.entries(endpoints)
    .map(([k, d]) => `<tr><td><code>/x402/${k}</code></td><td>${d.price} USDC</td><td>${d.summary}</td></tr>`)
    .join("");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>fry.market x402 API</title>
<style>:root{color-scheme:dark}body{margin:0;background:#0b0e14;color:#e6edf3;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.wrap{max-width:860px;margin:0 auto;padding:48px 22px}h1{font-size:1.9rem;margin:0 0 .2em;background:linear-gradient(90deg,#7cf,#4ade80);-webkit-background-clip:text;background-clip:text;color:transparent}table{width:100%;border-collapse:collapse;margin:1em 0}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #1c2230}code{background:#161b26;padding:2px 7px;border-radius:5px;color:#9ece6a}.pill{display:inline-block;background:#132a1c;color:#4ade80;border:1px solid #1f5133;border-radius:999px;padding:2px 10px;font-size:.78rem;margin-bottom:14px}a{color:#7cf}.mut{color:#8b98a5}</style></head><body><div class="wrap">
<div class="pill">Algorand mainnet · x402 · GoPlausible facilitator</div>
<h1>fry.market x402 API</h1>
<p class="mut">Pay-per-request marketplace data for AI agents — priced in USDC, no API keys. Full machine-readable spec: <a href="/x402/catalog"><code>/x402/catalog</code></a>.</p>
<table><thead><tr><th>Endpoint</th><th>Price</th><th>Returns</th></tr></thead><tbody>${rows}</tbody></table>
<p class="mut">payTo: <code>${PAY_TO}</code> · USDC ASA <code>31566704</code> · Facilitator <a href="${FACILITATOR_URL}">${FACILITATOR_URL}</a></p>
</div></body></html>`);
});

// Payment gate — only intercepts the routes map above.
app.use(paymentMiddleware(routes, server));

// Paid handlers (registered after the gate).
for (const [key, def] of Object.entries(endpoints)) {
  app.get(`/${key}`, async (req, res) => {
    try {
      const out = await def.handler(req.query || {});
      res.json({ resource: key, generatedAt: new Date().toISOString(), source: "fry.market", ...out });
    } catch (e) {
      res.status(/missing required/.test(String(e.message)) ? 400 : 502).json({ error: "data_failed", detail: String(e.message || e) });
    }
  });
}

app.listen(PORT, BIND, () => {
  console.log(`frymarket-x402 listening on ${BIND}:${PORT} | payTo=${PAY_TO} | facilitator=${FACILITATOR_URL} | endpoints=${Object.keys(endpoints).length}`);
});
