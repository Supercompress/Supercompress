# Control Plane Ops UI (confidential)

Private dashboard that proves **compress → route** economics vs LiteLLM-class gateways.

## Local

```bash
node services/gateway/scripts/serve-ops-ui.js
# → http://127.0.0.1:7789/
```

Demo mode works offline (`demo.json` from real `computeRouteEconomics` math).

## Live

1. `SC_CP_OPS=1` (+ `SC_CP_TRACE=1` for rich traces)
2. Open `/v1/ops/console` on the API host (404 when flag off)
3. Paste `sc_` key → **Load live**

## Moat

LiteLLM routes the client-sent context. SuperCompress routes **retained** tokens after keep, surfaces unlocks + `$` avoided, and exports OTel without asks/prompts.

Do not publish screenshots until Arjun clears launch.
