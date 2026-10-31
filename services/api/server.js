/**
 * Fly-hosted SuperCompress API — Vercel-compatible adapter for api/*.js handlers.
 * Website / marketing stays on Vercel.
 */

"use strict";

const http = require("http");
const { URL } = require("url");
const { resolveRoute } = require("./routes");

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = Number(process.env.SC_API_MAX_BODY_BYTES || 200_000);

function wrapRes(res) {
  if (res.__scWrapped) return res;
  res.__scWrapped = true;

  const origEnd = res.end.bind(res);
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    if (!res.getHeader("content-type")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    const payload = JSON.stringify(body);
    return origEnd(payload);
  };
  res.send = (body) => {
    if (body != null && typeof body === "object" && !Buffer.isBuffer(body)) {
      return res.json(body);
    }
    return origEnd(body);
  };
  res.redirect = (statusOrUrl, maybeUrl) => {
    let status = 302;
    let location = statusOrUrl;
    if (typeof statusOrUrl === "number") {
      status = statusOrUrl;
      location = maybeUrl;
    }
    res.statusCode = status;
    res.setHeader("Location", location);
    return origEnd();
  };
  return res;
}

function readBufferedBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const err = new Error(`Request body too large (max ${limit} bytes)`);
        err.status = 413;
        reject(err);
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseBody(buf, contentType) {
  if (!buf || buf.length === 0) return {};
  const ct = String(contentType || "").toLowerCase();
  const text = buf.toString("utf8");
  if (ct.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  if (ct.includes("application/json") || text.trim().startsWith("{") || text.trim().startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      const err = new Error("Invalid JSON body");
      err.status = 400;
      throw err;
    }
  }
  return text;
}

async function dispatch(req, res, routeResolver = resolveRoute) {
  wrapRes(res);
  res.setHeader("X-SC-Host", "fly");

  try {
    const url = new URL(req.url || "/", "http://localhost");
    const route = routeResolver(url.pathname, url.searchParams);

    if (!route) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ detail: "Not found", host: "fly" }));
      return;
    }

    req.query = { ...(route.query || {}) };
    for (const [k, v] of url.searchParams.entries()) {
      if (req.query[k] == null) req.query[k] = v;
    }

    if (route.rawBody) {
      // Stripe webhook reads the stream itself
      await route.handler(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      req.body = {};
    } else if (req.body == null) {
      const buf = await readBufferedBody(req, route.maxBodyBytes || MAX_BODY);
      req.body = parseBody(buf, req.headers["content-type"]);
    }

    await route.handler(req, res);
  } catch (err) {
    const proposedStatus = err.status || err.statusCode || (err instanceof URIError ? 400 : 500);
    const status = Number.isInteger(proposedStatus) && proposedStatus >= 400 && proposedStatus <= 599
      ? proposedStatus : 500;
    if (!res.headersSent) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          detail: status >= 500 ? "Internal server error" : err.message,
          host: "fly",
        })
      );
    } else if (!res.writableEnded) res.destroy();
    if (status >= 500) {
      console.error("sc-api error:", err);
    }
  }
}

function createServer(routeResolver = resolveRoute) {
  return http.createServer((req, res) => {
    // Fast liveness path — never waits on compress/auth/neural work.
    const pathOnly = String(req.url || "/").split("?")[0];
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      (pathOnly === "/health" || pathOnly === "/api/health")
    ) {
      wrapRes(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-SC-Host", "fly");
      res.end(
        JSON.stringify({
          ok: true,
          service: process.env.FLY_APP_NAME ? "supercompress-fly" : "supercompress-vercel",
        })
      );
      return;
    }
    dispatch(req, res, routeResolver);
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`sc-api listening on :${PORT}`);
  });
  function shutdown(sig) {
    console.log(`sc-api shutting down (${sig})`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 170_000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = { createServer };
