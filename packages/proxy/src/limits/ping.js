/**
 * One anonymous count per runway check, for the public total at
 * limitcheck.supercompress.dev. The body is only the verdict (go / land /
 * wait / unknown) and the surface (cli / mcp): no ids, usage numbers,
 * prompts or paths. It never throws and gives up after TIMEOUT_MS.
 *
 * Opt out: SUPERCOMPRESS_TELEMETRY=0, DO_NOT_TRACK=1 or SUPERCOMPRESS_RUNWAY=0.
 */
const http = require("http");
const https = require("https");

const DEFAULT_URL = "https://limitcheck.supercompress.dev/api/limitcheck";
const TIMEOUT_MS = 1500;

const isOff = (v) => /^(0|false|no|off)$/i.test(String(v ?? "").trim());
const isOn = (v) => /^(1|true|yes)$/i.test(String(v ?? "").trim());

function pingDisabled(env = process.env) {
  return isOff(env.SUPERCOMPRESS_TELEMETRY) || isOn(env.DO_NOT_TRACK) || isOff(env.SUPERCOMPRESS_RUNWAY);
}

/** Resolves true when the count was accepted, false otherwise. Never rejects. */
function ping({ action, surface }, env = process.env) {
  if (pingDisabled(env)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (req && !ok) req.destroy();
      resolve(ok);
    };
    // Hard cap on the whole exchange (DNS, connect, a slow-dribbling reply);
    // the socket timeout alone only catches inactivity.
    const deadline = setTimeout(() => finish(false), TIMEOUT_MS);
    try {
      const url = new URL(env.SUPERCOMPRESS_LIMITCHECK_URL || DEFAULT_URL);
      if (url.protocol !== "https:" && url.protocol !== "http:") return finish(false);
      const body = JSON.stringify({ action: String(action || "unknown"), surface: surface === "mcp" ? "mcp" : "cli" });
      req = (url.protocol === "http:" ? http : https).request(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          res.on("end", () => finish(res.statusCode >= 200 && res.statusCode < 300));
          res.on("error", () => finish(false));
        }
      );
      req.on("timeout", () => finish(false));
      req.on("error", () => finish(false));
      req.end(body);
    } catch {
      finish(false);
    }
  });
}

module.exports = { ping, pingDisabled, DEFAULT_URL };
