# SuperCompress Neural Keep

Hosted **query-conditioned line-keep** compression using the v4-large ModernBERT cross-encoder that cleared `launch_bench_30` (30/30 keep floor vs Headroom 28/30).

Production Vercel API calls this service when `SC_NEURAL_KEEP_URL` is set.

## Local dev

```bash
export SC_NEURAL_DIR="$PWD/../../checkpoints/sc-keep-crossencoder-v4-large"
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8789 --reload
```

Smoke:

```bash
bash ../../scripts/neural-keep-smoke.sh http://127.0.0.1:8789
```

## Fly deploy

```bash
bash ../../scripts/deploy-neural-keep.sh
```

Weights (~1.5GB) live on a Fly volume at `/data/model` — sync from local checkpoint:

```bash
bash ../../scripts/sync-neural-weights-fly.sh
```

Set on Vercel (API project):

| Variable | Example |
|----------|---------|
| `SC_NEURAL_KEEP_URL` | `https://sc-neural-keep.fly.dev` |
| `SC_NEURAL_KEEP_SECRET` | shared bearer (optional) |

## API

`POST /v1/compress`

```json
{ "context": "...", "query": "why did checkout fail?" }
```

Returns `compressed_text`, token stats, `mode: neural-keep`.

Auth (optional): `Authorization: Bearer <SC_NEURAL_KEEP_SECRET>` or `X-API-Key`.
