"use strict";

const STAGE_ORDER = [
  "auth",
  "admission",
  "reservation",
  "ledger",
  "compress",
  "route",
  "provider",
  "stream",
  "finalize",
];

/**
 * Ordered pipeline shell. Stages are async functions (ctx) => ctx.
 * Records stage names executed for contract tests.
 */
function createPipeline(stageFns = {}) {
  const missing = STAGE_ORDER.filter((s) => typeof stageFns[s] !== "function");
  if (missing.length) {
    const err = new Error(`pipeline_missing_stages:${missing.join(",")}`);
    err.code = "pipeline_missing_stages";
    throw err;
  }

  async function run(initialCtx = {}) {
    let ctx = {
      ...initialCtx,
      stages_executed: [],
      aborted: false,
    };
    // Always run all stages so ledger/finalize can record rejects/timeouts.
    // Individual stages no-op when ctx.aborted (except ledger+finalize).
    for (const name of STAGE_ORDER) {
      ctx.stages_executed.push(name);
      ctx = (await stageFns[name](ctx)) || ctx;
    }
    return ctx;
  }

  return { run, STAGE_ORDER: [...STAGE_ORDER] };
}

function stubStages(overrides = {}) {
  const stubs = {};
  for (const name of STAGE_ORDER) {
    stubs[name] =
      overrides[name] ||
      (async (ctx) => {
        ctx.stubbed = ctx.stubbed || [];
        ctx.stubbed.push(name);
        return ctx;
      });
  }
  return stubs;
}

module.exports = {
  STAGE_ORDER,
  createPipeline,
  stubStages,
};
