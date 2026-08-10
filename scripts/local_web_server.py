#!/usr/bin/env python3
"""Local FastAPI static+compress demo. Production is Vercel (api/* + web/)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from supercompress import compress_for_turn

api = FastAPI(title="SuperCompress Web", version="0.1.0")
api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class CompressRequest(BaseModel):
    context: str = Field(..., min_length=1, max_length=120_000)
    query: str = Field(default="Summarize this context.", max_length=2000)
    budget_ratio: float = Field(default=0.35, ge=0.05, le=1.0)


@api.get("/api/health")
def health() -> dict:
    return {"ok": True, "service": "supercompress-web", "deploy": "local-dev"}


@api.post("/api/compress")
@api.post("/api/demo/compress")
def compress(body: CompressRequest) -> dict:
    try:
        result = compress_for_turn(
            context=body.context,
            user_query=body.query,
            budget_ratio=body.budget_ratio,
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    out = result.to_dict()
    out["original_chars"] = len(body.context)
    out["compressed_chars"] = len(result.compressed_text)
    out["char_savings_pct"] = round(
        (1 - len(result.compressed_text) / max(len(body.context), 1)) * 100, 2
    )
    return out


@api.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "index.html")


@api.get("/dashboard")
@api.get("/dashboard.html")
def dashboard() -> FileResponse:
    return FileResponse(WEB / "dashboard.html")


api.mount("/assets", StaticFiles(directory=WEB / "assets"), name="assets")


def main() -> None:
    import os

    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8790"))
    uvicorn.run(api, host=host, port=port)


if __name__ == "__main__":
    main()
