const assert = require("node:assert/strict");
const test = require("node:test");
const { paywallError } = require("../packages/proxy/src/paywall");

test("a dashboard upgrade URL is not described as a recharge confirmation", () => {
  const error = paywallError(402, JSON.stringify({ upgrade_url: "https://www.supercompress.dev/dashboard#billing" }));
  assert.match(error.message, /Add credits/);
  assert.doesNotMatch(error.message, /Auto-recharge/);
  assert.equal(error.checkout_url, null);
  assert.equal(error.paywall, true);
});

test("real recharge links are retained; invalid links fall back safely", () => {
  const url = "https://checkout.stripe.com/c/pay/test";
  assert.equal(paywallError(402, JSON.stringify({ checkout_url: url })).checkout_url, url);
  assert.equal(paywallError(402, JSON.stringify({ checkout_url: "javascript:bad()" })).checkout_url, null);
  assert.equal(paywallError(402, "unparseable").upgrade_url, "https://www.supercompress.dev/dashboard#billing");
  assert.equal(paywallError(503, "unavailable"), null);
});

test("both ordinary and structured protocol callers receive actionable paywalls", async () => {
  const previousKey = process.env.SUPERCOMPRESS_API_KEY;
  const previousFetch = global.fetch;
  process.env.SUPERCOMPRESS_API_KEY = "sc_live_offline_test_123456789";
  global.fetch = async () => new Response(JSON.stringify({ detail: "Insufficient allowance" }), { status: 402 });
  try {
    const { compress } = require("../packages/proxy/src/compressor");
    const messages = [
      { role: "user", content: "database connection pool exhausted ".repeat(150) },
      { role: "user", content: "Why did checkout fail?" },
    ];
    await assert.rejects(compress(messages, "test"), (error) => error.paywall && /dashboard#billing/.test(error.message));
    await assert.rejects(compress([
      ...messages.slice(0, 1),
      ...Array.from({ length: 3 }, () => ({ role: "assistant", content: "Earlier response" })),
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "test", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "done" },
      messages[1],
    ], "test"), (error) => error.paywall && /dashboard#billing/.test(error.message));
  } finally {
    global.fetch = previousFetch;
    if (previousKey == null) delete process.env.SUPERCOMPRESS_API_KEY;
    else process.env.SUPERCOMPRESS_API_KEY = previousKey;
  }
});
