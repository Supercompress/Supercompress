const assert = require("node:assert/strict");
const { dispatchRpc, extractApiKey, TOOLS, handleToolCall } = require("./mcp-http");

async function main() {
  assert.ok(TOOLS.some((t) => t.name === "compress_context"));
  assert.ok(TOOLS.some((t) => t.name === "connect_account"));
  assert.ok(TOOLS.some((t) => t.name === "usage_summary"));

  const init = await dispatchRpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    },
    ""
  );
  assert.equal(init.result.serverInfo.name, "supercompress");
  assert.ok(init.result.capabilities.tools);

  const listed = await dispatchRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "");
  assert.equal(listed.result.tools.length, 3);

  const note = await dispatchRpc(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ""
  );
  assert.equal(note, null);

  const connect = await handleToolCall("connect_account", {}, "");
  assert.match(connect.content[0].text, /supercompress\.dev\/dashboard/);
  assert.match(connect.content[0].text, /OAuth|API key|Bearer sc_/i);

  const noKey = await handleToolCall(
    "compress_context",
    { context: "x".repeat(500), query: "what failed?" },
    ""
  );
  assert.equal(noKey.isError, true);
  assert.match(noKey.content[0].text, /Not connected|connect_account|API key/i);

  const key = extractApiKey({
    headers: { authorization: "Bearer sc_test_key_for_shape_only" },
    url: "/api/mcp",
  });
  assert.equal(key, "sc_test_key_for_shape_only");

  const key2 = extractApiKey({
    headers: { "x-api-key": "sc_from_header" },
    url: "/api/mcp",
  });
  assert.equal(key2, "sc_from_header");

  console.log("✔ mcp-http unit");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
