# Control Plane Ops UI (confidential)

Private dashboard that proves **compress → route** economics vs LiteLLM-class gateways.

## Local

```bash
node services/gateway/scripts/serve-ops-ui.js
# → http://127.0.0.1:7789/
```

Demo mode works offline (`demo.json` from real `computeRouteEconomics` math).

## Live

The console is not served by the API (it was unauthenticated). Run it locally with the
script above and point it at `/v1/ops/insights` with an `sc_` key; the data API needs
`SC_CP_OPS=1` (+ `SC_CP_TRACE=1` for rich traces).

## What it shows

Renders the `gateway` block of `/v1/ops/insights`: requests, error rate and errors by code,
latency and TTFT p50/p95, spend, and savings split by routing vs compression; plus the most
recent requests with requested → routed model, provider, auto/passthrough, classifier tier,
route reason, tokens before → after compression, cost and savings. Each row is the request's
`meta.obs` record, keyed by the id the API returns in `x-sc-request-id`. Metadata only.

Do not publish screenshots until Arjun clears launch.
