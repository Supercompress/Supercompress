#!/usr/bin/env node
/**
 * Protocol / runtime safety assertions for compressor + forwarder.
 */
const assert = require("assert");
const path = require("path");

const compressor = require("../src/compressor");
const forwarder = require("../src/forwarder");

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✘ ${name}`);
    throw err;
  }
}

async function main() {
  console.log("\n── protocol-safety ──\n");

  await test("native fetch — no node-fetch require in forwarder", () => {
    const src = require("fs").readFileSync(
      path.join(__dirname, "../src/forwarder.js"),
      "utf8"
    );
    assert.doesNotMatch(src, /require\(["']node-fetch["']\)/);
  });

  await test("hasStructuredProtocol detects tool_calls", () => {
    assert.equal(
      compressor.hasStructuredProtocol([
        { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      ]),
      true
    );
    assert.equal(
      compressor.hasStructuredProtocol([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
      false
    );
  });

  await test("assembleMessages keeps all system messages", () => {
    const { systemMsgs, query, context } = compressor.assembleMessages([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "older" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "ask now" },
    ]);
    assert.equal(systemMsgs.length, 2);
    assert.equal(query, "ask now");
    assert.match(context, /\[user\]: older/);
    assert.match(context, /\[assistant\]: reply/);
  });

  await test("compress skips structured protocol without API call", async () => {
    const messages = [
      { role: "user", content: "x".repeat(500) },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "grep", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "result " + "y".repeat(200) },
      { role: "user", content: "continue" },
    ];
    const out = await compressor.compress(messages, "test");
    assert.equal(out.skip_reason, "structured_protocol");
    assert.deepEqual(out.messages, messages);
  });

  await test("responsesInputHasStructuredItems detects function_call", () => {
    assert.equal(
      forwarder.responsesInputHasStructuredItems([
        { type: "function_call", call_id: "c1", name: "grep", arguments: "{}" },
      ]),
      true
    );
    assert.equal(
      forwarder.responsesInputHasStructuredItems([
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ]),
      false
    );
  });

  await test("PID helpers only match our process command", () => {
    const bin = require("fs").readFileSync(
      path.join(__dirname, "../bin/supercompress.js"),
      "utf8"
    );
    assert.match(bin, /isOurProxyProcess/);
    assert.match(bin, /Never SIGTERM an unrelated listener/);
    assert.match(bin, /process\.execPath/);
  });

  console.log("\n✔ protocol-safety passed\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
