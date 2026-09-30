"""HTTP service for SuperCompress Neural Keep (Fly / local).

Reliability rules:
- /health is liveness-only and must never wait on the model.
- Inference runs in a **single child process** so torch's GIL cannot stall
  the HTTP event loop (that was the 502 / health-hang root cause).
- At most one compress at a time; overflow returns 503 busy after a short wait.
- On inference timeout the worker process is killed and respawned (no zombie lock).
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FuturesTimeout
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="SuperCompress Neural Keep", version="1.3.1")

_model_loaded_flag = False
_loaded_at: float | None = None
_load_error: str | None = None
_inflight = 0
_inflight_lock = threading.Lock()
_busy_since: float | None = None
_last_ok_at: float | None = None
_last_err: str | None = None
_jobs_ok = 0
_jobs_fail = 0
_jobs_busy = 0
_jobs_timeout = 0
_started_at = time.time()
_exit_scheduled = False
_weights_info: dict[str, Any] | None = None

_pool: ProcessPoolExecutor | None = None
_pool_lock = threading.Lock()
_POOL_MODEL = None  # set inside worker process only

_INFER_TIMEOUT_S = float(os.environ.get("SC_NEURAL_INFER_TIMEOUT_S", "90"))
_MAX_CONTEXT_CHARS = int(os.environ.get("SC_NEURAL_MAX_CONTEXT_CHARS", "120000"))
_BUSY_WAIT_S = float(os.environ.get("SC_NEURAL_BUSY_WAIT_S", "3.0"))
_EXPECTED_BYTES = int(os.environ.get("SC_NEURAL_EXPECTED_BYTES", "1583351632"))
_EXPECTED_PARAMS_M = float(os.environ.get("SC_NEURAL_EXPECTED_PARAMS_M", "395.83"))
_CHECKPOINT_ID = os.environ.get("SC_NEURAL_CHECKPOINT", "sc-keep-crossencoder-v4-large")


def _cap_threads() -> None:
    n = str(os.environ.get("TORCH_NUM_THREADS", "4"))
    for key in (
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "TORCH_NUM_THREADS",
    ):
        os.environ.setdefault(key, n)
    try:
        import torch

        torch.set_num_threads(int(os.environ.get("TORCH_NUM_THREADS", "4")))
        if hasattr(torch, "set_num_interop_threads"):
            try:
                torch.set_num_interop_threads(1)
            except RuntimeError:
                pass
    except Exception:
        pass


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


def _scan_weights() -> dict[str, Any]:
    """Read checkpoint identity from disk (no torch) so /health can prove the right weights."""
    import hashlib
    import json
    from pathlib import Path

    d = Path(_model_dir())
    sf = d / "model.safetensors"
    meta_p = d / "sc_meta.json"
    cfg_p = d / "config.json"
    info: dict[str, Any] = {
        "checkpoint": _CHECKPOINT_ID,
        "weights_present": sf.is_file(),
        "weights_bytes": int(sf.stat().st_size) if sf.is_file() else 0,
        "expected_bytes": _EXPECTED_BYTES,
        "expected_params_m": _EXPECTED_PARAMS_M,
        "weights_match_expected": False,
        "base_model": None,
        "architectures": None,
        "hidden_size": None,
        "num_hidden_layers": None,
        "inference_threshold": None,
        "sha256_8mb": None,
        "sha256_tail1mb": None,
        "private": True,
    }
    if cfg_p.is_file():
        try:
            cfg = json.loads(cfg_p.read_text())
            info["architectures"] = cfg.get("architectures")
            info["hidden_size"] = cfg.get("hidden_size")
            info["num_hidden_layers"] = cfg.get("num_hidden_layers")
            info["model_type"] = cfg.get("model_type")
        except Exception as e:
            info["config_error"] = str(e)
    if meta_p.is_file():
        try:
            meta = json.loads(meta_p.read_text())
            info["base_model"] = meta.get("base_model")
            info["inference_threshold"] = meta.get("inference_threshold")
        except Exception as e:
            info["meta_error"] = str(e)
    if sf.is_file():
        try:
            h = hashlib.sha256()
            with sf.open("rb") as fh:
                h.update(fh.read(8 * 1024 * 1024))
            info["sha256_8mb"] = h.hexdigest()[:16]
            with sf.open("rb") as fh:
                fh.seek(max(0, sf.stat().st_size - 1024 * 1024))
                info["sha256_tail1mb"] = hashlib.sha256(fh.read()).hexdigest()[:16]
        except Exception as e:
            info["hash_error"] = str(e)
        info["weights_match_expected"] = info["weights_bytes"] == _EXPECTED_BYTES
        # Known fingerprint for private v4-large (ModernBERT-large ~395.8M).
        if info["sha256_8mb"] == "607db82e7024ad35" and info["sha256_tail1mb"] == "9f43a81f93e059bf":
            info["weights_match_expected"] = True
            info["params_m"] = _EXPECTED_PARAMS_M
        elif info["weights_match_expected"]:
            info["params_m"] = _EXPECTED_PARAMS_M
    return info


def _weights() -> dict[str, Any]:
    global _weights_info
    if _weights_info is None:
        try:
            _weights_info = _scan_weights()
        except Exception as e:
            _weights_info = {"error": str(e), "weights_match_expected": False}
    return _weights_info


def _pool_init() -> None:
    """Runs once inside the inference child process."""
    global _POOL_MODEL
    _cap_threads()
    from inference import NeuralKeepModel

    d = _model_dir()
    if not os.path.isdir(d):
        raise RuntimeError(f"SC_NEURAL_DIR not found: {d}")
    _POOL_MODEL = NeuralKeepModel(d, device=_pick_device())
    print(f"[neural-keep] worker model loaded device={_pick_device()}", flush=True)


def _pool_compress(context: str, query: str, threshold: float | None) -> dict[str, Any]:
    if _POOL_MODEL is None:
        raise RuntimeError("worker model not initialized")
    return _POOL_MODEL.compress(context, query, threshold=threshold)


def _ensure_pool() -> ProcessPoolExecutor:
    global _pool, _model_loaded_flag, _loaded_at, _load_error
    with _pool_lock:
        if _pool is not None:
            return _pool
        _cap_threads()
        _pool = ProcessPoolExecutor(
            max_workers=1,
            initializer=_pool_init,
        )
        # Warm the worker so first user request isn't a cold load.
        fut = _pool.submit(_pool_compress, "warmup", "warmup", None)
        try:
            fut.result(timeout=300)
            _model_loaded_flag = True
            _loaded_at = time.time()
            _load_error = None
        except Exception as e:
            _load_error = str(e)
            _model_loaded_flag = False
            print(f"[neural-keep] worker warmup failed: {e}", flush=True)
        return _pool


def _kill_pool(reason: str) -> None:
    global _pool, _model_loaded_flag
    print(f"[neural-keep] killing inference pool: {reason}", flush=True)
    with _pool_lock:
        if _pool is not None:
            try:
                _pool.shutdown(wait=False, cancel_futures=True)
            except Exception as e:
                print(f"[neural-keep] pool shutdown err: {e}", flush=True)
            _pool = None
            _model_loaded_flag = False


def _schedule_process_exit(reason: str, code: int = 75) -> None:
    """Last-resort: Fly restarts the whole machine."""
    global _exit_scheduled
    if _exit_scheduled:
        return
    _exit_scheduled = True
    print(f"[neural-keep] scheduling process exit ({code}): {reason}", flush=True)

    def _boom() -> None:
        time.sleep(0.8)
        os._exit(code)

    threading.Thread(target=_boom, name="nk-exit", daemon=True).start()


class CompressRequest(BaseModel):
    context: str = Field(..., min_length=1, max_length=_MAX_CONTEXT_CHARS)
    query: str = Field(default="", max_length=8_000)
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
    truncated: bool = False
    checkpoint: str | None = None
    params_m: float | None = None
    weights_match_expected: bool | None = None


@app.on_event("startup")
def startup() -> None:
    # Spawn avoids forking a threaded uvicorn parent (deadlocks / hung workers).
    try:
        import multiprocessing as mp

        mp.set_start_method("spawn", force=True)
    except RuntimeError:
        pass

    # Fingerprint weights on boot (no torch) so operators can verify the private checkpoint.
    try:
        _weights()
    except Exception as e:
        print(f"[neural-keep] weight scan failed: {e}", flush=True)

    lazy = os.environ.get("SC_NEURAL_LAZY_LOAD", "").strip().lower() in ("1", "true", "yes")

    def _boot() -> None:
        try:
            _ensure_pool()
        except Exception as e:
            print(f"[neural-keep] boot pool failed: {e}", flush=True)

    if not lazy:
        threading.Thread(target=_boot, name="nk-boot", daemon=True).start()


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness only — never waits on torch / locks."""
    d = _model_dir()
    busy_for = round(time.time() - _busy_since, 1) if _busy_since is not None else 0.0
    wedged = bool(_busy_since is not None and busy_for > _INFER_TIMEOUT_S + 15)
    w = _weights()
    return {
        "ok": True,
        "service": "neural-keep",
        "version": app.version,
        "model_dir": d,
        "model_dir_present": os.path.isdir(d),
        "model_loaded": _model_loaded_flag,
        "load_error": _load_error,
        "loaded_at": _loaded_at,
        "inflight": _inflight,
        "busy_for_s": busy_for,
        "wedged": wedged,
        "last_ok_at": _last_ok_at,
        "last_err": _last_err,
        "jobs_ok": _jobs_ok,
        "jobs_fail": _jobs_fail,
        "jobs_busy": _jobs_busy,
        "jobs_timeout": _jobs_timeout,
        "uptime_s": round(time.time() - _started_at, 1),
        "device": _pick_device() if _model_loaded_flag else None,
        "infer_timeout_s": _INFER_TIMEOUT_S,
        "isolation": "process",
        "checkpoint": w.get("checkpoint"),
        "base_model": w.get("base_model"),
        "params_m": w.get("params_m") or w.get("expected_params_m"),
        "weights_bytes": w.get("weights_bytes"),
        "weights_match_expected": w.get("weights_match_expected"),
        "sha256_8mb": w.get("sha256_8mb"),
        "private_weights": True,
    }


@app.get("/ready")
async def ready() -> dict[str, Any]:
    if not _model_loaded_flag:
        threading.Thread(target=_ensure_pool, name="nk-boot", daemon=True).start()
        raise HTTPException(
            status_code=503,
            detail={"ready": False, "reason": _load_error or "model_loading"},
        )
    if _exit_scheduled:
        raise HTTPException(status_code=503, detail={"ready": False, "reason": "restarting"})
    return {"ready": True, "model_loaded": True, "loaded_at": _loaded_at}


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


def _run_compress_in_pool(context: str, query: str, threshold: float | None) -> dict[str, Any]:
    pool = _ensure_pool()
    fut = pool.submit(_pool_compress, context, query, threshold)
    try:
        return fut.result(timeout=_INFER_TIMEOUT_S)
    except FuturesTimeout as e:
        _kill_pool("inference_timeout")
        # Pool respawn after a wedged torch child is unreliable on 8GB shared CPU —
        # exit so Fly brings a clean machine (TCP health already tolerates restart).
        _schedule_process_exit("inference_timeout")
        raise TimeoutError("inference_timeout") from e


@app.post("/v1/compress", response_model=CompressResponse)
async def compress(
    body: CompressRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> CompressResponse:
    global _inflight, _busy_since, _last_ok_at, _last_err
    global _jobs_ok, _jobs_fail, _jobs_busy, _jobs_timeout

    _check_auth(authorization, x_api_key)
    if _exit_scheduled:
        raise HTTPException(status_code=503, detail="restarting", headers={"Retry-After": "15"})
    if not _model_loaded_flag:
        threading.Thread(target=_ensure_pool, name="nk-boot", daemon=True).start()
        raise HTTPException(
            status_code=503,
            detail="model_loading",
            headers={"Retry-After": "10"},
        )

    deadline = time.time() + max(0.0, _BUSY_WAIT_S)
    while True:
        with _inflight_lock:
            if _inflight < 1:
                _inflight += 1
                _busy_since = time.time()
                break
        if time.time() >= deadline:
            _jobs_busy += 1
            raise HTTPException(
                status_code=503,
                detail="busy",
                headers={"Retry-After": "5"},
            )
        await asyncio.sleep(0.15)

    t0 = time.time()
    try:
        try:
            out = await asyncio.to_thread(
                _run_compress_in_pool, body.context, body.query, body.threshold
            )
        except TimeoutError as e:
            _jobs_timeout += 1
            _last_err = "inference_timeout"
            raise HTTPException(status_code=504, detail="inference_timeout") from e
        except Exception as e:
            _jobs_fail += 1
            _last_err = str(e)
            raise HTTPException(status_code=503, detail=str(e)) from e
        ms = (time.time() - t0) * 1000.0
        _jobs_ok += 1
        _last_ok_at = time.time()
        _last_err = None
        w = _weights()
        return CompressResponse(
            latency_ms=round(ms, 2),
            checkpoint=str(w.get("checkpoint") or _CHECKPOINT_ID),
            params_m=float(w.get("params_m") or w.get("expected_params_m") or _EXPECTED_PARAMS_M),
            weights_match_expected=bool(w.get("weights_match_expected")),
            **out,
        )
    finally:
        with _inflight_lock:
            _inflight = max(0, _inflight - 1)
            if _inflight == 0:
                _busy_since = None


# ── Compression Arena comparators (opt-in; off by default to save RAM) ───────


class ArenaRequest(BaseModel):
    context: str = Field(..., min_length=1, max_length=200_000)
    query: str = Field(default="")


class ArenaResponse(BaseModel):
    text: str
    ms: float
    source: str


def _arena_enabled() -> bool:
    return os.environ.get("SC_ARENA", "").strip().lower() in ("1", "true", "yes")


@app.post("/arena/headroom", response_model=ArenaResponse)
def arena_headroom(
    body: ArenaRequest,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> ArenaResponse:
    if not _arena_enabled():
        raise HTTPException(status_code=404, detail="arena disabled")
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
    if not _arena_enabled():
        raise HTTPException(status_code=404, detail="arena disabled")
    _check_auth(authorization, x_api_key)
    import subprocess
    import tempfile

    t0 = time.time()
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
