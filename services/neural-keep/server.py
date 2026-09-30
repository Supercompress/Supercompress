"""HTTP service for SuperCompress Neural Keep (Fly / local)."""

from __future__ import annotations

import os
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from inference import NeuralKeepModel

app = FastAPI(title="SuperCompress Neural Keep", version="1.0.0")

_model: NeuralKeepModel | None = None
_loaded_at: float | None = None


def _pick_device() -> str:
    forced = os.environ.get("SC_NEURAL_DEVICE", "").strip().lower()
    if forced in ("cpu", "cuda", "mps"):
        return forced
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _model_dir() -> str:
    return os.environ.get("SC_NEURAL_DIR", "/data/model")


def _auth_secret() -> str:
    return os.environ.get("SC_NEURAL_KEEP_SECRET", "").strip()


def get_model() -> NeuralKeepModel:
    global _model, _loaded_at
    if _model is None:
        d = _model_dir()
        if not os.path.isdir(d):
            raise RuntimeError(f"SC_NEURAL_DIR not found: {d}")
        _model = NeuralKeepModel(d, device=_pick_device())
        _loaded_at = time.time()
    return _model


class CompressRequest(BaseModel):
    context: str = Field(..., min_length=1)
    query: str = Field(default="")
    threshold: float | None = Field(default=None, ge=0.0, le=1.0)


class CompressResponse(BaseModel):
    compressed_text: str
    original_tokens: int
    kept_tokens: int
    tokens_saved_pct: float
    lines_in: int
    lines_kept: int
    threshold: float
    policy_name: str
    mode: str
    latency_ms: float


@app.on_event("startup")
def startup() -> None:
    # Fail fast when misconfigured — health stays red until weights exist.
    if os.environ.get("SC_NEURAL_LAZY_LOAD", "").strip() not in ("1", "true", "yes"):
        get_model()


@app.get("/health")
def health() -> dict[str, Any]:
    d = _model_dir()
    ready = _model is not None
    return {
        "ok": ready or os.path.isdir(d),
        "service": "neural-keep",
        "model_dir": d,
        "model_loaded": ready,
        "loaded_at": _loaded_at,
        "device": _pick_device() if ready else None,
    }


def _check_auth(authorization: str | None, x_api_key: str | None) -> None:
    secret = _auth_secret()
    if not secret:
        return
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    elif x_api_key:
        token = x_api_key.strip()
    if token != secret:
        raise HTTPException(status_code=401, detail="unauthorized")


@app.post("/v1/compress", response_model=CompressResponse)
def compress(
    body: CompressRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> CompressResponse:
    _check_auth(authorization, x_api_key)
    t0 = time.time()
    try:
        model = get_model()
        out = model.compress(body.context, body.query, threshold=body.threshold)
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    ms = (time.time() - t0) * 1000.0
    return CompressResponse(latency_ms=round(ms, 2), **out)


# ── Compression Arena comparators ───────────────────────────────────────────
# Each endpoint runs the REAL tool inside this container. Nothing simulated.


class ArenaRequest(BaseModel):
    context: str = Field(..., min_length=1, max_length=200_000)
    query: str = Field(default="")


class ArenaResponse(BaseModel):
    text: str
    ms: float
    source: str


@app.post("/arena/headroom", response_model=ArenaResponse)
def arena_headroom(
    body: ArenaRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> ArenaResponse:
    _check_auth(authorization, x_api_key)
    t0 = time.time()
    text = ""
    try:
        from headroom.transforms.kompress_compressor import KompressCompressor

        k = KompressCompressor()
        if not k.is_ready():
            k.preload()
        r = k.compress(body.context, question=body.query)
        text = str(getattr(r, "compressed", "") or "")
        source = "headroom KompressCompressor"
    except Exception:
        try:
            from headroom import compress as hr_compress

            messages = [
                {"role": "system", "content": "Use the provided context to answer."},
                {"role": "user", "content": f"CONTEXT:\n{body.context}\n\nREQUEST: {body.query}"},
            ]
            result = hr_compress(messages, model="gpt-4o-mini", model_limit=128000, optimize=True)
            for m in getattr(result, "messages", None) or []:
                role = m.get("role") if isinstance(m, dict) else getattr(m, "role", None)
                content = m.get("content") if isinstance(m, dict) else getattr(m, "content", None)
                if role == "user" and content:
                    text = str(content)
                    break
            source = "headroom compress()"
        except Exception as e:
            raise HTTPException(status_code=503, detail=f"headroom failed: {e}") from e
    if not text.strip():
        raise HTTPException(status_code=503, detail="headroom returned empty output")
    return ArenaResponse(text=text, ms=round((time.time() - t0) * 1000.0, 2), source=source)


@app.post("/arena/rtk", response_model=ArenaResponse)
def arena_rtk(
    body: ArenaRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> ArenaResponse:
    _check_auth(authorization, x_api_key)
    import subprocess
    import tempfile

    t0 = time.time()
    # RTK filters files/command output, not raw stdin — write the dump to a
    # temp file and run its log filter (its own dedupe/noise logic, unmodified).
    with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as f:
        f.write(body.context)
        path = f.name
    try:
        proc = subprocess.run(
            ["rtk", "log", path],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "NO_COLOR": "1", "RTK_NO_TELEMETRY": "1"},
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            proc = subprocess.run(
                ["rtk", "read", path],
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, "NO_COLOR": "1", "RTK_NO_TELEMETRY": "1"},
            )
        if proc.returncode != 0:
            raise HTTPException(
                status_code=503,
                detail=f"rtk failed: {(proc.stderr or proc.stdout or '')[:300]}",
            )
        text = proc.stdout
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"rtk failed: {e}") from e
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if not text.strip():
        raise HTTPException(status_code=503, detail="rtk returned empty output")
    return ArenaResponse(text=text, ms=round((time.time() - t0) * 1000.0, 2), source="rtk log filter")
