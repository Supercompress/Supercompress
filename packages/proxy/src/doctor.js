/**
 * `supercompress doctor` — one clean health matrix for every detected harness.
 * No boxes, no walls of tips — just account / MCP / per-agent status.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const HOME = os.homedir();

function fileHasSupercompress(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return /supercompress/i.test(text);
  } catch {
    return false;
  }
}

function mark(ok) {
  return ok ? "✓" : "·";
}

async function checkMcpTools(configDir) {
  const mcpPath = path.join(__dirname, "mcp.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [mcpPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SUPERCOMPRESS_CONFIG_DIR: configDir },
    });
    let out = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({ ok: false, tools: [], error: "timeout" });
    }, 6000);
    const send = (obj) => {
      try {
        child.stdin.write(`${JSON.stringify(obj)}\n`);
      } catch {}
    };
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, tools: [], error: e.message });
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "supercompress-doctor", version: "1.0.0" },
      },
    });
    const tick = setInterval(() => {
      if (out.includes('"id":1') || out.includes('"id": 1')) {
        clearInterval(tick);
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      }
    }, 40);
    const done = setInterval(() => {
      if (!(out.includes('"id":2') || out.includes('"id": 2'))) return;
      clearInterval(done);
      clearInterval(tick);
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      try {
        const lines = out.split("\n").filter(Boolean);
        const listLine = [...lines]
          .reverse()
          .find((l) => l.includes("tools") && (l.includes('"id":2') || l.includes('"id": 2')));
        const parsed = JSON.parse(listLine);
        const tools = ((parsed.result && parsed.result.tools) || []).map((t) => t.name);
        const need = ["compress_context", "connect_account", "usage_summary"];
        const missing = need.filter((n) => !tools.includes(n));
        resolve({ ok: missing.length === 0, tools, missing });
      } catch (e) {
        resolve({ ok: false, tools: [], error: e.message });
      }
    }, 40);
  });
}

/**
 * Pretty install summary shared by `setup` / `plugin`.
 */
function printInstallSummary(result, { version } = {}) {
  const found = result.found || [];
  const mcp = new Set(result.mcpConfigured || []);
  const hooks = new Set(result.agentHooks?.installed || []);
  const instructions = new Set(result.instructions || []);
  const hermesBits = result.hermes?.installed || [];
  const openclawBits = result.openclaw?.installed || [];

  const detector = require("./detector");
  const stats = detector.catalogStats();
  console.log("");
  console.log(`  SuperCompress plugin${version ? `  v${version}` : ""}`);
  console.log("  ────────────────────");
  console.log(
    `  ${stats.catalogued}+ harnesses catalogued · ${stats.autoMcp} get auto MCP`
  );
  if (!found.length) {
    console.log("  No coding agents detected yet.");
    console.log("  Install Cursor / Claude Code / Codex, then re-run `supercompress plugin`.");
  } else {
    console.log("  Agent              MCP   Hooks  Instructions");
    for (const agent of found) {
      const name = String(agent.name || "").padEnd(18);
      const hasMcp =
        mcp.has(agent.name) ||
        (agent.name === "Codex" && [...mcp].some((n) => /codex/i.test(n)));
      const hasHooks =
        hooks.has(agent.name) ||
        (agent.name === "Cursor" && !!result.hooks?.hooksPath) ||
        (agent.name === "Hermes" && hermesBits.length > 0) ||
        (agent.name === "OpenClaw" && openclawBits.length > 0);
      const hasInstr =
        instructions.has(agent.name) ||
        (agent.name === "Hermes" && hermesBits.includes("instructions")) ||
        (agent.name === "OpenClaw" && openclawBits.includes("instructions"));
      console.log(
        `  ${name} ${mark(hasMcp)}      ${mark(hasHooks)}      ${mark(hasInstr)}`
      );
    }
  }
  if (result.rulePath) {
    console.log(`  Cursor rule        ${mark(true)}  ${result.rulePath.replace(HOME, "~")}`);
  }
  console.log("");
  console.log("  Restart your agents so MCP + hooks reload.");
  console.log("  Then: `supercompress doctor` anytime.");
  console.log("");
}

async function runDoctor({ CONFIG_DIR, loadConfig, version } = {}) {
  const detector = require("./detector");
  const cfg = typeof loadConfig === "function" ? loadConfig() : null;
  const linked = !!(cfg && cfg.api_key && String(cfg.api_key).startsWith("sc_"));
  const found = detector.detectAll();
  const mcpCheck = await checkMcpTools(CONFIG_DIR);

  const stats = detector.catalogStats();
  console.log("");
  console.log(`  SuperCompress doctor${version ? `  v${version}` : ""}`);
  console.log("  ───────────────────");
  console.log(`  Account     ${linked ? "✓ linked" : "· not linked — run `supercompress setup`"}`);
  console.log(
    `  MCP server  ${
      mcpCheck.ok
        ? `✓ ${mcpCheck.tools.join(", ")}`
        : `· broken${mcpCheck.error ? ` (${mcpCheck.error})` : mcpCheck.missing ? ` missing ${mcpCheck.missing.join(", ")}` : ""}`
    }`
  );
  console.log(
    `  Harnesses   ${stats.catalogued} catalogued · ${stats.autoMcp} auto-plugin · ${found.length} on this machine`
  );
  console.log("");

  if (!found.length) {
    console.log("  No agents detected.");
    console.log("  → `supercompress plugin` after you install an agent.");
    console.log("");
    return { linked, mcpOk: mcpCheck.ok, agents: [], stats };
  }

  const MCP_PATHS = detector.mcpPathMap();

  const rows = [];
  for (const agent of found) {
    const name = agent.name;
    const mcpCandidates = MCP_PATHS[name] || (agent.configPath ? [agent.configPath] : []);
    const mcpOk = mcpCandidates.some((p) => fileHasSupercompress(p));
    let hooksOk = false;
    let instrOk = false;
    if (name === "Cursor") {
      hooksOk =
        fileHasSupercompress(path.join(HOME, ".cursor", "hooks.json")) ||
        fs.existsSync(path.join(HOME, ".cursor", "hooks", "supercompress-before-submit.js")) ||
        fs.existsSync(path.join(HOME, ".cursor", "hooks", "supercompress-post-tool.js"));
      instrOk =
        fileHasSupercompress(path.join(HOME, ".cursor", "rules", "supercompress.mdc")) ||
        fileHasSupercompress(path.join(HOME, ".cursor", "rules", "supercompress.md"));
    } else if (name === "Claude Code") {
      hooksOk = fileHasSupercompress(path.join(HOME, ".claude", "settings.json"));
      instrOk = fileHasSupercompress(path.join(HOME, ".claude", "CLAUDE.md"));
    } else if (name === "Codex") {
      hooksOk = fileHasSupercompress(path.join(HOME, ".codex", "hooks.json"));
      instrOk = fileHasSupercompress(path.join(HOME, ".codex", "AGENTS.md"));
    } else if (name === "Grok Build") {
      const grok = process.env.GROK_HOME || path.join(HOME, ".grok");
      hooksOk = fileHasSupercompress(path.join(grok, "hooks", "supercompress.json"));
      instrOk = fileHasSupercompress(path.join(grok, "AGENTS.md"));
    } else if (name === "fx") {
      instrOk = fileHasSupercompress(path.join(HOME, ".fx", "AGENTS.md"));
      hooksOk = fs.existsSync(path.join(HOME, ".fx", "skills", "supercompress", "SKILL.md"));
    } else if (name === "Hermes") {
      const h = path.join(HOME, ".hermes");
      hooksOk =
        fs.existsSync(path.join(h, "hooks")) || fileHasSupercompress(path.join(h, "config.yaml"));
      instrOk = fileHasSupercompress(path.join(h, "AGENTS.md"));
    } else if (name === "OpenClaw") {
      const o = path.join(HOME, ".openclaw");
      hooksOk = fs.existsSync(path.join(o, "extensions", "supercompress"));
      instrOk = fileHasSupercompress(path.join(o, "AGENTS.md"));
    } else if (name === "OpenCode") {
      instrOk = fileHasSupercompress(path.join(HOME, ".config", "opencode", "AGENTS.md"));
    } else if (name === "Goose") {
      instrOk = fileHasSupercompress(path.join(HOME, ".config", "goose", "AGENTS.md"));
    } else if (name === "Aider") {
      instrOk = fileHasSupercompress(path.join(HOME, ".aider", "CONVENTIONS.md"));
    }
    rows.push({ name, mcpOk, hooksOk, instrOk });
  }

  console.log("  Agent              MCP   Hooks  Instructions");
  for (const row of rows) {
    console.log(
      `  ${String(row.name).padEnd(18)} ${mark(row.mcpOk)}      ${mark(row.hooksOk)}      ${mark(row.instrOk)}`
    );
  }

  // Only nudge when an auto-configurable host is missing MCP (ignore "folder exists" noise).
  const weak = found.filter((agent) => {
    if (!agent.autoConfigurable) return false;
    const row = rows.find((r) => r.name === agent.name);
    return row && !row.mcpOk;
  });
  console.log("");
  if (!linked || !mcpCheck.ok || weak.length) {
    console.log("  Fix:");
    if (!linked) console.log("    supercompress setup");
    else console.log("    supercompress plugin");
    if (!mcpCheck.ok) console.log("    supercompress mcp-check");
    if (weak.length) {
      console.log(`    (needs MCP: ${weak.map((w) => w.name).join(", ")})`);
    }
  } else {
    console.log("  Auto-plugin harnesses look good. Restart agents if you just installed.");
  }
  console.log("");
  return { linked, mcpOk: mcpCheck.ok, agents: rows, stats };
}

module.exports = {
  runDoctor,
  printInstallSummary,
  checkMcpTools,
  fileHasSupercompress,
};
