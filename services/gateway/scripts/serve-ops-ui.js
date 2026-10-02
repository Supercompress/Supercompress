#!/usr/bin/env node
"use strict";

/**
 * Local ops UI server (confidential).
 *
 *   node services/gateway/scripts/serve-ops-ui.js
 *   open http://127.0.0.1:7789/
 *
 * Serves static ops-ui + /demo-insights JSON. Does not enable production flags.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildDemoInsights } = require("../ops-ui/demo-insights");

const ROOT = path.join(__dirname, "../ops-ui");
const PORT = Number(process.env.SC_CP_OPS_UI_PORT || 7789);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/demo-insights") {
    const insights = buildDemoInsights({ budget_usd: 5 });
    // Refresh demo.json on disk for static hosts
    try {
      fs.writeFileSync(path.join(ROOT, "demo.json"), JSON.stringify(insights, null, 2));
    } catch {
      /* ignore */
    }
    return send(res, 200, JSON.stringify(insights), TYPES[".json"]);
  }

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    return send(res, 403, "forbidden");
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, "not found");
  }
  const ext = path.extname(file);
  send(res, 200, fs.readFileSync(file), TYPES[ext] || "application/octet-stream");
});

server.listen(PORT, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ok: true,
      confidential: true,
      url: `http://127.0.0.1:${PORT}/`,
      demo: `http://127.0.0.1:${PORT}/demo-insights`,
    })
  );
});
