"use strict";

/**
 * Deterministic stub provider for tests / flags-off local runs.
 */
async function callStubProvider(ctx) {
  const model = ctx.model_routed || ctx.normalized?.model || "stub-model";
  const text = "ok";
  const stream = ctx.normalized?.stream === true;
  ctx.provider_result = {
    model,
    provider: "stub",
    output: { content: text },
    usage: {
      input_tokens: ctx.compression?.retained_tokens || 0,
      output_tokens: 3,
    },
  };
  if (stream) {
    ctx.provider_result.stream = (async function* () {
      yield text;
    })();
  }
  return ctx;
}

module.exports = { callStubProvider };
