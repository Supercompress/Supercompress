#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-harness-"));
const script = `
process.env.HOME = ${JSON.stringify(tmp)};
process.env.SUPERCOMPRESS_CONFIG_DIR = ${JSON.stringify(path.join(tmp, ".supercompress"))};
const d = require(${JSON.stringify(path.join(ROOT, "src/detector.js"))});
const fs = require("fs");
const path = require("path");
const goose = path.join(process.env.HOME, ".config", "goose", "config.yaml");
fs.mkdirSync(path.dirname(goose), { recursive: true });
fs.writeFileSync(goose, "GOOSE_PROVIDER: openai\\nkeep: true\\n");
d.writeGooseYaml(goose);
const g = fs.readFileSync(goose, "utf8");
if (!/extensions:[\\s\\S]*supercompress:[\\s\\S]*type: stdio/.test(g)) throw new Error("goose\\n" + g);
if (!/keep: true/.test(g)) throw new Error("goose wiped");
d.writeGooseYaml(goose); // idempotent
const g2 = fs.readFileSync(goose, "utf8");
if ((g2.match(/supercompress:/g) || []).length !== 1) throw new Error("goose duplicated");
const cont = path.join(process.env.HOME, ".continue", "config.json");
fs.mkdirSync(path.dirname(cont), { recursive: true });
fs.writeFileSync(cont, JSON.stringify({ models: [{ title: "x" }], mcpServers: { supercompress: { command: "bad" } } }, null, 2));
d.writeContinueMcp(cont);
const c = JSON.parse(fs.readFileSync(cont, "utf8"));
if (c.mcpServers && c.mcpServers.supercompress) throw new Error("continue left cursor mcpServers");
if (!c.experimental.modelContextProtocolServers[0].transport.command) throw new Error("continue missing");
if (!c.models) throw new Error("continue wiped");
const s = d.catalogStats();
if (s.catalogued < 50 || s.autoMcp < 20) throw new Error("catalog too small " + JSON.stringify(s));
console.log("harness-writers ok", JSON.stringify(s));
`;
const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
if (r.status !== 0) {
  process.stderr.write(r.stderr || r.stdout || "fail\\n");
  process.exit(r.status || 1);
}
process.stdout.write(r.stdout);
assert.match(r.stdout, /harness-writers ok/);
