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
