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

/** Resolves true when the count was accepted, false otherwise. */
function ping({ action, surface }, env = process.env) {
  if (pingDisabled(env)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(env.SUPERCOMPRESS_LIMITCHECK_URL || DEFAULT_URL);
    } catch {
      resolve(false);
      return;
    }
    const body = JSON.stringify({ action: String(action || "unknown"), surface: surface === "mcp" ? "mcp" : "cli" });
    const req = (url.protocol === "http:" ? http : https).request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode >= 200 && res.statusCode < 300));
        res.on("error", () => resolve(false));
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end(body);
  });
}

module.exports = { ping, pingDisabled, DEFAULT_URL };
