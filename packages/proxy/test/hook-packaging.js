#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-hook-packaging-"));
const scenarios = [
  ["Cursor install", "detector", "writeCursorHooks", [".cursor/hooks/supercompress"]],
  ["shared hook sync", "detector", "writeAgentPromptHooks", [".cursor/hooks/supercompress"]],
  ["OpenClaw install", "agent-plugins", "writeOpenClawAutoCompress", [
    ".openclaw/hooks/supercompress-bootstrap",
    ".openclaw/hooks/supercompress-compact",
    ".openclaw/extensions/supercompress",
  ]],
  ["Hermes install", "agent-plugins", "writeHermesAutoCompress", [
    ".hermes/agent-hooks/supercompress",
  ]],
];

try {
  for (const [name, moduleName, method, destinations] of scenarios) {
    const isolatedHome = path.join(home, method);
    fs.mkdirSync(isolatedHome, { recursive: true });
    const env = {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      PATH: "",
      NODE_PATH: "",
      NODE_OPTIONS: "",
      SUPERCOMPRESS_CONFIG_DIR: path.join(isolatedHome, ".supercompress"),
      SUPERCOMPRESS_TELEMETRY: "0",
    };
    const install = () => {
      const result = spawnSync(process.execPath, ["-e",
        `require(${JSON.stringify(path.join(ROOT, "src", moduleName))})[${JSON.stringify(method)}]();`,
      ], { cwd: isolatedHome, env, encoding: "utf8", timeout: 30000 });
      assert.strictEqual(result.status, 0, `${name}: ${result.error || result.stderr}`);
    };
    const helperPaths = [...new Set(destinations.map(destination => path.resolve(isolatedHome, destination, "..", "mcp-response.js")))];
    const originals = new Map();
    for (const helper of helperPaths) {
      fs.mkdirSync(path.dirname(helper), { recursive: true });
      const original = `user helper for ${name}\n`;
      fs.writeFileSync(helper, original);
      originals.set(helper, original);
    }
    install();
    for (const destination of destinations) {
      const filename = destination === ".openclaw/extensions/supercompress" ? "compress-prompt-lib.cjs" : "compress-prompt-lib.js";
      const library = path.join(isolatedHome, destination, filename);
      if (filename.endsWith(".cjs")) {
        const entry = fs.readFileSync(path.join(isolatedHome, destination, "index.js"), "utf8");
        assert(entry.includes('path.join(__dirname, "compress-prompt-lib.cjs")'), "OpenClaw entry loads the CommonJS library");
      }
      const result = spawnSync(process.execPath, ["-e", `
        const assert = require("assert");
        const hooks = require(${JSON.stringify(library)});
        assert.strictEqual(typeof hooks.compressContext, "function");
        assert.strictEqual(typeof hooks.compressIncremental, "function");
        if (${JSON.stringify(filename)}.endsWith(".cjs")) {
          (async () => {
            const entry = require("url").pathToFileURL(${JSON.stringify(path.join(isolatedHome, destination, "index.js"))}).href;
            const plugin = (await import(entry)).default;
            const handlers = {};
            hooks.readInboxDigest = () => "packaged session digest";
            plugin.register({ logger: { info() {}, warn(message) { throw new Error(message); } }, on(event, handler) { handlers[event] = handler; } });
            const result = await handlers.before_prompt_build({ sessionId: "packaging-test" }, {});
            assert(result?.prependContext.includes("packaged session digest"), "OpenClaw entry uses the packaged library");
          })().catch(error => { console.error(error); process.exitCode = 1; });
        }
      `], { cwd: isolatedHome, env, encoding: "utf8", timeout: 10000 });
      assert.strictEqual(result.status, 0, `${name} standalone require (${destination}): ${result.error || result.stderr}`);
      const helper = path.resolve(path.dirname(library), "..", "mcp-response.js");
      assert.strictEqual(fs.readFileSync(helper, "utf8"), fs.readFileSync(path.join(ROOT, "src", "mcp-response.js"), "utf8"));
    }
    for (const destination of destinations) {
      const helper = path.resolve(isolatedHome, destination, "..", "mcp-response.js");
      fs.writeFileSync(helper, "stale helper\n");
    }
    install();
    for (const destination of destinations) {
      const helper = path.resolve(isolatedHome, destination, "..", "mcp-response.js");
      assert.strictEqual(fs.readFileSync(helper, "utf8"), fs.readFileSync(path.join(ROOT, "src", "mcp-response.js"), "utf8"), `${name} refreshes helper`);
    }
    const uninstall = spawnSync(process.execPath, ["-e",
      `require(${JSON.stringify(path.join(ROOT, "src", "detector"))}).revertAll();`,
    ], { cwd: isolatedHome, env, encoding: "utf8", timeout: 30000 });
    assert.strictEqual(uninstall.status, 0, `${name} uninstall: ${uninstall.error || uninstall.stderr}`);
    for (const [helper, original] of originals) {
      assert.strictEqual(fs.readFileSync(helper, "utf8"), original, `${name} restores pre-existing helper`);
    }
    console.log(`PASS ${name}: standalone require, helper refresh and uninstall restore`);
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
