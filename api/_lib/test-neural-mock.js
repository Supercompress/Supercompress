/**
 * Test helper — mock neural-keep HTTP for unit tests without Fly.
 */
function installNeuralKeepMock(handler) {
  process.env.SC_NEURAL_KEEP_URL = process.env.SC_NEURAL_KEEP_URL || "https://neural.test";
  delete process.env.SC_NEURAL_KEEP;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body || "{}");
    const context = String(body.context || "");
    const query = String(body.query || "");
    const out = handler(context, query);
    return {
      ok: true,
      json: async () => out,
    };
  };
}

function lineKeepFilter(context, query, keepFn) {
  const lines = String(context || "").split("\n");
  const kept = lines.filter((line) => keepFn(line, query));
  const compressed = kept.join("\n");
  const original_tokens = Math.max(1, Math.round(context.length / 4));
  const kept_tokens = Math.max(1, Math.round(compressed.length / 4));
  return {
    compressed_text: compressed,
    original_tokens,
    kept_tokens,
    tokens_saved_pct: (1 - kept_tokens / original_tokens) * 100,
    policy_name: "SuperCompress Neural Keep",
    mode: "neural-keep",
    latency_ms: 5,
    lines_in: lines.length,
    lines_kept: kept.length,
    threshold: 0.12,
  };
}

module.exports = { installNeuralKeepMock, lineKeepFilter };
