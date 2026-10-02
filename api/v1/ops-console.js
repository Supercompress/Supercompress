/**
 * GET /api/v1/ops-console  (also /v1/ops/console)
 *
 * Serves the private ops UI HTML shell when SC_CP_OPS=1; else 404.
 * Static assets are loaded relative to this page via /api/v1/ops-ui/*
 * or the local serve-ops-ui.js script for development.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { json } = require("../_lib/http");
const { isOpsEnabled } = require("../../services/gateway/ops");

const UI_ROOT = path.join(__dirname, "../../services/gateway/ops-ui");

module.exports = async function opsConsole(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    return json(res, 405, { error: { message: "Method not allowed", type: "invalid_request_error" } });
  }
  if (!isOpsEnabled()) {
    return json(res, 404, { error: { message: "Not found", type: "not_found" } });
  }

  const url = new URL(req.url || "/", "http://localhost");
  let name = "index.html";
  if (url.pathname.includes("styles.css") || url.searchParams.get("asset") === "css") {
    name = "styles.css";
  } else if (url.pathname.includes("app.js") || url.searchParams.get("asset") === "js") {
    name = "app.js";
  } else if (url.pathname.includes("demo.json") || url.searchParams.get("asset") === "demo") {
    name = "demo.json";
  }

  const file = path.join(UI_ROOT, name);
  if (!file.startsWith(UI_ROOT) || !fs.existsSync(file)) {
    return json(res, 404, { error: { message: "Not found", type: "not_found" } });
  }

  const types = {
    "index.html": "text/html; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
    "app.js": "text/javascript; charset=utf-8",
    "demo.json": "application/json; charset=utf-8",
  };
  let body = fs.readFileSync(file);
  if (name === "index.html") {
    // Asset URLs work under local serve-ops-ui.js and under this flag-gated endpoint.
    body = Buffer.from(
      body
        .toString("utf8")
        .replaceAll("./styles.css", "/api/v1/ops-console?asset=css")
        .replaceAll("./app.js", "/api/v1/ops-console?asset=js")
        .replaceAll("./demo.json", "/api/v1/ops-console?asset=demo"),
      "utf8"
    );
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", types[name] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.end(body);
};
