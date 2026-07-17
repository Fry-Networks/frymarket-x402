# frymarket-x402

x402 pay-per-request marketplace data API for [fry.market](https://fry.market) — Algorand NFT marketplace.

Read-only data sidecar: six paid USDC endpoints ($0.005–$0.01) on Algorand mainnet — collections, listings, bids, Genesis mint stats, and wallet history. x402 (v2, scheme `exact`) payment is the only auth; non-custodial; payments settle via the GoPlausible facilitator. Free machine-readable catalog at `/x402/catalog`.

Runs as a host-network sidecar on `127.0.0.1:6402`; the fry.market frontend nginx proxies `/x402/` to it. Sources data from the fry.market FastAPI backend read endpoints.
