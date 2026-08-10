#!/usr/bin/env python3
"""Local compress playground — API key proxy + real Python fallback on PORT (default 8791)."""

from __future__ import annotations

import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
sys.path.insert(0, str(ROOT))

API_URL = os.environ.get("SC_API_URL", "https://supercompress.dev/api/v1/compress")
PORT = int(os.environ.get("PORT", "8791"))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".mp4": "video/mp4",
}


def resolve_static(path: str) -> Path | None:
    path = path.split("?", 1)[0]
    if path in ("/", ""):
        return WEB / "playground.html"
    if path == "/landing":
        path = "/index.html"
    elif path == "/dashboard":
        path = "/dashboard.html"
    rel = path.lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    candidate = (WEB / rel).resolve()
    try:
        candidate.relative_to(WEB.resolve())
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def compress_local(context: str, query: str, budget_ratio: float) -> dict:
    from supercompress import compress_for_turn

    result = compress_for_turn(context, query, budget_ratio=budget_ratio)
    return {
        "compressed_text": result.compressed_text,
        "original_tokens": result.original_tokens,
        "kept_tokens": result.kept_tokens,
        "tokens_saved_pct": round(result.tokens_saved_pct, 2),
        "kept_line_ratio": round(result.kept_line_ratio, 3),
        "policy_name": result.policy_name,
        "budget_ratio": result.keep_ratio,
        "mode": "local-python",
    }


def compress_hosted(context: str, query: str, budget_ratio: float, api_key: str) -> dict:
    req = urllib.request.Request(
        API_URL,
        data=json.dumps(
            {"context": context, "query": query, "budget_ratio": budget_ratio}
        ).encode(),
        headers={"Content-Type": "application/json", "X-API-Key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read())
    out["mode"] = "hosted-api"
    return out


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def _respond(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-API-Key")
        self.end_headers()

    def do_GET(self):
        file_path = resolve_static(self.path)
        if not file_path:
            return self._respond(404, b"Not found", "text/plain")
        suffix = file_path.suffix.lower()
        ctype = MIME.get(suffix) or mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        return self._respond(200, file_path.read_bytes(), ctype)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/compress":
            return self._respond(404, b'{"error":"Not found"}', "application/json")

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._respond(400, b'{"error":"Invalid JSON"}', "application/json")

        context = (body.get("context") or "").strip()
        query = (body.get("query") or "Summarize this context.").strip()
        budget = float(body.get("budget_ratio", 0.35))
        api_key = (self.headers.get("X-API-Key") or body.get("api_key") or "").strip()
        force_local = bool(body.get("force_local"))

        if not context:
            return self._respond(422, json.dumps({"error": "context required"}).encode(), "application/json")
        if not 0.05 <= budget <= 1:
            return self._respond(422, json.dumps({"error": "budget_ratio must be 0.05–1"}).encode(), "application/json")

        try:
            if api_key and not force_local:
                result = compress_hosted(context, query, budget, api_key)
            else:
                result = compress_local(context, query, budget)
            payload = json.dumps(result).encode()
            return self._respond(200, payload, "application/json")
        except urllib.error.HTTPError as e:
            detail = e.read().decode()
            try:
                detail = json.loads(detail).get("detail", detail)
            except json.JSONDecodeError:
                pass
            return self._respond(e.code, json.dumps({"error": detail}).encode(), "application/json")
        except Exception as exc:
            return self._respond(500, json.dumps({"error": str(exc)}).encode(), "application/json")


def main() -> None:
    if not WEB.is_dir():
        raise SystemExit(f"Missing web folder: {WEB}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"SuperCompress playground → http://127.0.0.1:{PORT}")
    print("Paste your API key · load presets · compress long context")
    print(f"Hosted API: {API_URL}")
    print(f"Full landing page: http://127.0.0.1:{PORT}/landing")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
