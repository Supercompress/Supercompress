"use strict";

/**
 * Shared upstream call helpers: a fetch that times out and stops when the client goes away,
 * and the mapping from upstream errors to gateway errors.
 */

const { providerError } = require("./sse");

const DEFAULT_TIMEOUT_MS = 300_000;

function upstreamTimeoutMs(env = process.env) {
  const n = Number(env.SC_CP_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * fetch() bounded by a timeout and by ctx.abort_signal (set by the HTTP edge when the client
 * disconnects). The timer covers the whole response, including a streamed body, so a hung
 * provider cannot hold a request slot forever. Call done() once the body is fully read.
 */
async function fetchUpstream(fetchImpl, url, init, ctx = {}, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || upstreamTimeoutMs();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const clientSignal = ctx.abort_signal;
  const onClientAbort = () => controller.abort();
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }
  const done = () => {
    clearTimeout(timer);
    if (clientSignal) clientSignal.removeEventListener("abort", onClientAbort);
  };
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    return { res, done, isTimedOut: () => timedOut };
  } catch (err) {
    done();
    throw abortError(err, timedOut, clientSignal);
  }
}

function abortError(err, timedOut, clientSignal) {
  if (timedOut) {
    const e = new Error("upstream_timeout");
    e.status = 504;
    e.code = "upstream_timeout";
    return e;
  }
  if (clientSignal?.aborted) {
    const e = new Error("client_closed_request");
    e.status = 499;
    e.code = "client_closed_request";
    return e;
  }
  if (err && !err.status) {
    const e = new Error(`upstream_network_error: ${err.code || err.message || "fetch failed"}`);
    e.status = 502;
    e.code = "upstream_unavailable";
    return e;
  }
  return err;
}

/**
 * Errors caused by SuperCompress's own provider account (bad key, no quota, billing) are
 * not the customer's fault and must not leak our account details: report them as a 502.
 */
function upstreamHttpError(name, status, parsed) {
  const code = String(parsed?.error?.code || parsed?.error?.type || parsed?.type || "");
  const accountProblem =
    status === 401 ||
    status === 403 ||
    code === "insufficient_quota" ||
    code === "billing_hard_limit_reached" ||
    code === "authentication_error" ||
    code === "permission_error";
  if (accountProblem) {
    const err = providerError(`upstream_provider_unavailable:${name}`, 502, undefined);
    err.code = "upstream_provider_unavailable";
    err.upstream_status = status;
    return err;
  }
  const message = parsed?.error?.message || parsed?.message || `${name}_http_${status}`;
  const err = providerError(message, status, parsed);
  if (code) err.upstream_code = code;
  return err;
}

module.exports = { fetchUpstream, abortError, upstreamHttpError, upstreamTimeoutMs, DEFAULT_TIMEOUT_MS };
