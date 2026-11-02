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

## Moat

LiteLLM routes the client-sent context. SuperCompress routes **retained** tokens after keep, surfaces unlocks + `$` avoided, and exports OTel without asks/prompts.

Do not publish screenshots until Arjun clears launch.
