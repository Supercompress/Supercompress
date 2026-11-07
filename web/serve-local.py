#!/usr/bin/env python3
"""Local static server with Vercel-like cleanUrls + custom 404.html."""
from __future__ import annotations

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8799


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".md": "text/markdown; charset=utf-8",
        ".svg": "image/svg+xml",
        ".txt": "text/plain; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".xml": "application/xml; charset=utf-8",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _split(self):
        parts = urlsplit(self.path)
        path = unquote(parts.path)
        suffix = ""
        if parts.query:
            suffix += "?" + parts.query
        if parts.fragment:
            suffix += "#" + parts.fragment
        return path, suffix

    def _resolve(self):
        path, suffix = self._split()
        if path in ("", "/"):
            return "/index.html" + suffix, False

        rel = path.lstrip("/")
        candidate = (ROOT / rel).resolve()
        try:
            candidate.relative_to(ROOT)
        except ValueError:
            return None, True

        if candidate.is_file():
            return "/" + rel + suffix, False

        if candidate.is_dir():
            index = candidate / "index.html"
            if index.is_file():
                return "/" + str(index.relative_to(ROOT)).replace("\\", "/") + suffix, False
            return None, True

        if not candidate.suffix:
            html = candidate.with_suffix(".html")
            if html.is_file():
                return "/" + str(html.relative_to(ROOT)).replace("\\", "/") + suffix, False

        return None, True

    def _serve_404(self):
        body = (ROOT / "404.html").read_bytes()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        resolved, missing = self._resolve()
        if missing or resolved is None:
            self._serve_404()
            return
        self.path = resolved
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_HEAD(self):
        resolved, missing = self._resolve()
        if missing or resolved is None:
            self._serve_404()
            return
        self.path = resolved
        return SimpleHTTPRequestHandler.do_HEAD(self)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving {ROOT} on http://127.0.0.1:{PORT} (custom 404)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
