#!/usr/bin/env node

/**
 * SuperCompress Proxy — CLI entry point
 *
 * Commands:
 *   setup     One-time setup: account link, agent detection, service registration
 *   start     Start the background proxy
 *   stop      Stop the background proxy
 *   status    Check if the proxy is running
 *   usage     Show plan + token savings / per-agent stats
 *   uninstall Remove the proxy and revert agent configs
 */

const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const crypto = require("crypto");
const VERSION = require("../package.json").version;
const USAGE_URL = process.env.SUPERCOMPRESS_USAGE_URL || "https://www.supercompress.dev/api/usage";
const ME_URL = process.env.SUPERCOMPRESS_ME_URL || "https://www.supercompress.dev/api/me";
const ACTIVITY_URL = process.env.SUPERCOMPRESS_ACTIVITY_URL || "https://www.supercompress.dev/api/account?op=compress-log";

const CONFIG_DIR = process.env.SUPERCOMPRESS_CONFIG_DIR || path.join(require("os").homedir(), ".supercompress");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const PID_PATH = path.join(CONFIG_DIR, "proxy.pid");
const LOG_PATH = path.join(CONFIG_DIR, "proxy.log");

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {}
  return null;
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {}
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(CONFIG_PATH, payload, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {}
}

function printLogo() {
  console.log("");
  console.log("  ╔══════════════════════════════════════╗");
  console.log(`  ║         SuperCompress v${VERSION.padEnd(8)}       ║`);
  console.log("  ║   Cut your coding agent costs ~65%   ║");
  console.log("  ╚══════════════════════════════════════╝");
  console.log("");
}

function printHelp() {
  console.log("Usage: supercompress <command>");
  console.log("");
  console.log("  Commands:");
  console.log("  setup       Recommended — link account, auto-detect agents, install MCP + hooks");
  console.log("  plugin      Re-run detect + install MCP/hooks/instructions for every agent");
  console.log("  connect     Link this install to your SuperCompress account");
  console.log("  account     Show the connected SuperCompress account");
  console.log("  usage       Plan, quota, and token savings by coding agent");
  console.log("  start       Start the optional local proxy server");
  console.log("  stop        Stop the proxy server");
  console.log("  status      Check if the proxy is running");
  console.log("  agents      Show supported agents and detected integrations");
  console.log("  agents add  Register a custom MCP-capable agent (pluggable)");
  console.log("  agents rm   Remove a custom agent plugin");
  console.log("  mcp-check   Verify the SuperCompress MCP server responds");
  console.log("  restart     Restart the proxy server");
  console.log("  uninstall   Remove SuperCompress configs and revert agent integrations");
  console.log("");
  console.log("Examples:");
  console.log("  supercompress setup");
  console.log("  supercompress plugin");
  console.log("  supercompress account");
  console.log("  supercompress usage");
  console.log("  supercompress usage --json");
  console.log("  supercompress status");
}

async function connectAccount() {
  // 128-bit pairing code (was 32-bit) — hardens device-link against enumeration
  const code = crypto.randomBytes(16).toString("hex");
  const connectUrl = `https://www.supercompress.dev/dashboard?connect=${code}&source=cli`;
  const openCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try { require("child_process").execFileSync(openCommand, [connectUrl], { stdio: "ignore" }); } catch {}
  console.log(`  → Finish sign-in in the browser to link this install.`);
  console.log(`  → If the dashboard is already open, refresh that tab.`);
  console.log(`  → Connection code: ${code}`);
  console.log(`  → Link: ${connectUrl}`);
  const apiKey = await waitForDeviceConnect(code);
  const config = loadConfig() || {};
  saveConfig({ ...config, api_key: apiKey, connected_at: new Date().toISOString() });
  console.log("  ✓ SuperCompress account connected. No raw API key needed.");
}

async function main() {
  const cmd = process.argv[2] || "help";

  printLogo();

  switch (cmd) {
    case "connect":
      try { await connectAccount(); } catch (err) { console.error(`  ✗ ${err.message}`); process.exit(1); }
      break;
    case "account":
    case "whoami":
      try { await printAccount(); } catch (err) { console.error(`  ✗ ${err.message}`); process.exit(1); }
      break;
    case "usage":
    case "stats":
      try {
        await printUsageCommand(process.argv.slice(3));
      } catch (err) {
        console.error(`  ✗ ${err.message}`);
        process.exit(1);
      }
      break;
    case "plugin": {
      const detector = require("../src/detector");
      const result = detector.installAutoPlugin();
      console.log(`  Detected ${result.found.length} coding agent(s):`);
      for (const agent of result.found) {
        console.log(`    ✓ ${agent.name}`);
      }
      if (result.mcpConfigured.length) {
        console.log(`  ✓ MCP plugin installed for: ${result.mcpConfigured.join(", ")}`);
      } else {
        console.log("  ○ No MCP-capable agent configs found to update.");
      }
      console.log(`  ✓ Cursor rule written: ${result.rulePath}`);
      console.log(`  ✓ Cursor hooks written: ${result.hooks.hooksPath}`);
      console.log("    → beforeSubmitPrompt compresses every submit with context (ask stays the query)");
      console.log("    → postToolUse auto-compresses large tool dumps (main savings path)");
      if (result.agentHooks.installed.length) {
        console.log(`  ✓ Prompt/tool hooks: ${result.agentHooks.installed.join(", ")}`);
      }
      if (result.instructions.length) {
        console.log(`  ✓ Always-on instructions: ${result.instructions.join(", ")}`);
      }
      if (result.hermes?.installed?.length) {
        console.log(`  ✓ Hermes auto-compress: ${result.hermes.installed.join(", ")}`);
        console.log("    → pre_llm_call + post_tool_call hooks + transform plugin + native compact");
      }
      if (result.cleared.length) {
        console.log(`  ✓ Cleared provider API-key proxy overrides: ${result.cleared.join(", ")}`);
      }
      console.log("  → Restart agents so MCP/hooks reload.");
      break;
    }
    case "wrap": {
      console.log("  ✗ `supercompress wrap` is deprecated and unreliable with login-based agents.");
      console.log("  → Run `supercompress setup` instead — it auto-installs MCP + hooks for every detected agent.");
      console.log("  → Docs: https://docs.supercompress.dev/coding-agents");
      process.exit(1);
      break;
    }
    case "setup":
      await require("../src/setup")({ CONFIG_DIR, CONFIG_PATH, PID_PATH, LOG_PATH, loadConfig, saveConfig });
      break;

    case "start": {
      const config = loadConfig();
      if (!config || !config.api_key) {
        console.log("  ✗ Not configured. Run `supercompress setup` first.");
        process.exit(1);
      }
      const port = config.port || 8080;
      // A launchd/systemd-managed proxy does not create our PID file. The
      // health endpoint is the source of truth for both managed and manual runs.
      const health = await fetchHealth(port);
      if (health) {
        if (health.version && health.version !== VERSION) {
          console.log(
            `  → Restarting proxy (running v${health.version}, package is v${VERSION})`
          );
          stopServer(port);
          await new Promise((r) => setTimeout(r, 400));
        } else {
          console.log("  ✓ Proxy is already running on port " + port);
          return;
        }
      }
      if (isRunning()) stopServer(port);
      await startServer(config);
      break;
    }

    case "stop": {
      const config = loadConfig();
      stopServer(config?.port || 8080);
      break;
    }

    case "status": {
      const config = loadConfig();
      if (!config) {
        console.log("  ○ Not configured. Run `supercompress setup` first.");
        return;
      }
      const port = config.port || 8080;
      const running = await isHealthy(port);
      if (running) {
        console.log(`  ✓ Proxy is RUNNING on localhost:${port}`);
        const agents = config.configured_agents || [];
        if (agents.length > 0) {
          console.log(`  → Configured for: ${agents.join(", ")}`);
        }
        await printAccountSummary(config.api_key).catch(() => {});
        await printUsageSummary(config.api_key, { compact: true }).catch((err) => {
          console.log(`  → Usage summary unavailable: ${err.message}`);
        });
        console.log("  → Full stats: `supercompress usage`");
      } else {
        console.log(`  ○ Proxy is STOPPED (configured for localhost:${port})`);
        console.log("  → Run `supercompress setup` to reconnect and start it, or `supercompress start` to restart manually.");
        await printAccountSummary(config.api_key).catch(() => {});
        await printUsageSummary(config.api_key, { compact: true }).catch((err) => {
          console.log(`  → Usage summary unavailable: ${err.message}`);
        });
        console.log("  → Full stats: `supercompress usage`");
      }
      break;
    }

    case "agents": {
      const sub = process.argv[3];
      if (sub === "add") {
        const args = process.argv.slice(4);
        const opts = {};
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (a === "--id" || a === "--name") opts[a.slice(2)] = args[++i];
          else if (a === "--format") opts.format = args[++i];
          else if (a === "--config") opts.configPath = args[++i];
          else if (a === "--cmd") {
            opts.detectCommands = opts.detectCommands || [];
            opts.detectCommands.push(args[++i]);
          } else if (a === "--dir") {
            opts.detectDirs = opts.detectDirs || [];
            opts.detectDirs.push(args[++i]);
          } else if (a === "--instructions") opts.instructionPath = args[++i];
          else if (a === "--wrap-bin") opts.wrapBin = args[++i];
        }
        if (!opts.id && !opts.name) {
          console.log("  Usage: supercompress agents add --name MyAgent [--format mcp-json] [--config ~/.myagent/mcp.json]");
          console.log("  Formats: mcp-json | hermes-yaml | openclaw-json | opencode-json | codex-toml | instruction-only");
          console.log("  Optional: --cmd <bin> --dir .<folder> --instructions ~/.../AGENTS.md --wrap-bin <bin>");
          console.log("  Drop-in:  put JSON in ~/.supercompress/plugins/<id>.json then run `supercompress plugin`");
          process.exit(1);
        }
        if (!opts.id) opts.id = opts.name;
        try {
          const { addCustomPlugin } = require("../src/agent-plugins");
          const { plugin, file } = addCustomPlugin(opts);
          console.log(`  ✓ Registered custom agent plugin: ${plugin.name} (${plugin.format})`);
          console.log(`  → Registry: ${file}`);
          if (plugin.configPath) console.log(`  → MCP config: ${plugin.configPath}`);
          if (plugin.instructionPath) console.log(`  → Instructions: ${plugin.instructionPath}`);
          console.log("  → Re-run `supercompress plugin` anytime to refresh all agents.");
        } catch (err) {
          console.error(`  ✗ ${err.message}`);
          process.exit(1);
        }
        break;
      }
      if (sub === "rm" || sub === "remove") {
        const id = process.argv[4];
        if (!id) {
          console.log("  Usage: supercompress agents rm <id>");
          process.exit(1);
        }
        try {
          const { removeCustomPlugin } = require("../src/agent-plugins");
          const { removed } = removeCustomPlugin(id);
          console.log(`  ✓ Removed plugin: ${removed.name}`);
        } catch (err) {
          console.error(`  ✗ ${err.message}`);
          process.exit(1);
        }
        break;
      }
      const { AGENT_CATALOG, detectAll, agentPlugins } = require("../src/detector");
      const detected = new Map(detectAll().map((agent) => [agent.name, agent]));
      console.log(`  Supported coding agents (${AGENT_CATALOG.length} catalogued):`);
      for (const agent of AGENT_CATALOG) {
        const state = detected.get(agent.name);
        console.log(`    ${state ? "✓" : "·"} ${agent.name}${state ? ` — ${state.autoConfigurable ? "detected and configurable" : "detected; manual setup"}` : " — not detected"}`);
      }
      const customs = agentPlugins.loadCustomPlugins();
      if (customs.length) {
        console.log("\n  Custom plugins:");
        for (const p of customs) {
          console.log(`    • ${p.name} (${p.id}) — ${p.format} → ${p.configPath}`);
        }
      }
      console.log("    ✓ Any new MCP-compatible client — use `supercompress-mcp`");
      console.log("\n  New or unlisted agent:");
      console.log("    supercompress agents add --name MyAgent --format mcp-json --config ~/.myagent/mcp.json");
      console.log("    Or point its OpenAI-compatible base URL to http://localhost:8080/v1");
      console.log("\n  Limits and upgrade status: run `supercompress usage`.");
      break;
    }

    case "mcp-check": {
      const { spawn } = require("child_process");
      const mcpPath = path.join(__dirname, "../src/mcp.js");
      const child = spawn(process.execPath, [mcpPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
      const timer = setTimeout(() => {
        child.kill();
        console.error("  ✗ MCP check timed out");
        if (err) console.error(err.slice(0, 500));
        process.exit(1);
      }, 8000);
      child.on("error", (e) => {
        clearTimeout(timer);
        console.error(`  ✗ Failed to start MCP: ${e.message}`);
        process.exit(1);
      });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "supercompress-mcp-check", version: "1.0.0" },
        },
      });
      const onData = () => {
        if (!out.includes('"id":1') && !out.includes('"id": 1')) return;
        child.stdout.off("data", onData);
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      };
      child.stdout.on("data", onData);
      const done = setInterval(() => {
        if (!out.includes('"id":2') && !out.includes('"id": 2')) return;
        clearInterval(done);
        clearTimeout(timer);
        child.kill();
        try {
          const lines = out.split("\n").filter(Boolean);
          const listLine = lines.reverse().find((l) => l.includes("tools") && (l.includes('"id":2') || l.includes('"id": 2')));
          const parsed = JSON.parse(listLine);
          const tools = (parsed.result && parsed.result.tools) || [];
          const names = tools.map((t) => t.name);
          const need = ["compress_context", "connect_account", "usage_summary"];
          const missing = need.filter((n) => !names.includes(n));
          if (missing.length) {
            console.error(`  ✗ MCP missing tools: ${missing.join(", ")}`);
            process.exit(1);
          }
          console.log(`  ✓ MCP ok — tools: ${names.join(", ")}`);
          if (/ready v/i.test(err)) console.log(`  → ${err.trim().split("\n").pop()}`);
        } catch (e) {
          console.error(`  ✗ MCP response parse failed: ${e.message}`);
          console.error(out.slice(0, 800));
          process.exit(1);
        }
      }, 50);
      break;
    }

    case "restart":
      stopServer();
      await new Promise((r) => setTimeout(r, 500));
      const cfg = loadConfig();
      if (cfg) await startServer(cfg);
      break;

    case "uninstall": {
      console.log("  → Stopping proxy...");
      stopServer();
      require("../src/service").unregister();
      console.log("  → Reverting agent configurations...");
      const { revertAll, removeMcp } = require("../src/detector");
      const undone = revertAll();
      undone.forEach((a) => console.log(`  → ${a}`));
      removeMcp().forEach((a) => console.log(`  → Removed ${a} MCP registration`));
      // Remove config dir
      if (fs.existsSync(CONFIG_DIR)) {
        fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
      }
      console.log("  ✓ SuperCompress uninstalled.");
      break;
    }

    case "help":
    default:
      printHelp();
      break;
  }
}

function readPidFile() {
  try {
    if (!fs.existsSync(PID_PATH)) return null;
    const pid = parseInt(fs.readFileSync(PID_PATH, "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True only if pid looks like our proxy server.js (not a reused PID). */
function isOurProxyProcess(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /supercompress|packages[\\/]+proxy[\\/]+src[\\/]+server\.js|proxy[\\/]+src[\\/]+server\.js/i.test(out);
  } catch {
    return false;
  }
}

function isRunning() {
  const pid = readPidFile();
  if (!pid) return false;
  if (isOurProxyProcess(pid)) return true;
  // Stale or reused PID — drop the file so we never SIGTERM a stranger.
  try { fs.unlinkSync(PID_PATH); } catch {}
  return false;
}

function waitForHealth(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const request = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 800 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(body);
              if (parsed.status === "ok" && parsed.service === "supercompress") return resolve(parsed);
            } catch {}
          }
          retry();
        });
      });
      request.on("error", retry);
      request.on("timeout", () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`Proxy did not become healthy on localhost:${port}`));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

async function fetchHealth(port) {
  try {
    return await waitForHealth(port, 700);
  } catch {
    return null;
  }
}

async function isHealthy(port) {
  return Boolean(await fetchHealth(port));
}

function killListenerOnPort(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return false;
    let killed = false;
    for (const line of out.split("\n")) {
      const pid = parseInt(line.trim(), 10);
      if (!pid || pid === process.pid) continue;
      // Never SIGTERM an unrelated listener (dev servers, Docker, etc.).
      if (!isOurProxyProcess(pid)) continue;
      try {
        process.kill(pid, "SIGTERM");
        killed = true;
      } catch {}
    }
    return killed;
  } catch {
    return false;
  }
}

async function startServer(config) {
  const serverPath = path.join(__dirname, "..", "src", "server.js");
  const port = config.port || 8080;
  const logPath = path.join(CONFIG_DIR, "proxy.log");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [serverPath, String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      SUPERCOMPRESS_API_KEY: config.api_key,
      SUPERCOMPRESS_CONFIG_DIR: CONFIG_DIR,
    },
  });
  child.on("close", () => {
    try { fs.closeSync(logFd); } catch {}
  });

  fs.writeFileSync(PID_PATH, String(child.pid));

  child.unref();

  try {
    await waitForHealth(port);
  } catch (err) {
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    try { fs.unlinkSync(PID_PATH); } catch {}
    throw err;
  }

  console.log(`  ✓ Proxy is healthy on localhost:${port} (PID ${child.pid})`);
  console.log(`  → Configure your coding agents to use: http://localhost:${port}/v1`);
  console.log("  → Run `supercompress status` to check.");
}

function stopServer(port) {
  let stopped = false;
  try {
    const pid = readPidFile();
    if (pid && isOurProxyProcess(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        stopped = true;
      } catch {}
    }
    try { fs.unlinkSync(PID_PATH); } catch {}
  } catch {}
  // Also clear orphaned SuperCompress listeners only (never foreign processes).
  const targetPort = port || loadConfig()?.port || 8080;
  if (killListenerOnPort(targetPort)) stopped = true;
  if (stopped) console.log("  ✓ Proxy stopped.");
  else console.log("  ○ Proxy was not running.");
}

async function printAccount() {
  const config = loadConfig();
  if (!config?.api_key) {
    console.log("  ○ No linked account. Run `supercompress setup` or `supercompress connect`.");
    return;
  }
  const data = await fetchJson(ME_URL, config.api_key);
  console.log("  Connected SuperCompress account");
  console.log(`  → Email: ${data.email || "(none)"}`);
  if (data.display_name) console.log(`  → Name: ${data.display_name}`);
  console.log(`  → Plan: ${data.plan_name || data.plan || "free"}`);
  console.log(`  → UID: ${data.uid}`);
  if (data.agent_plugin?.linked) {
    console.log(`  → Coding agents: linked${data.agent_plugin.linked_at ? ` (${data.agent_plugin.linked_at})` : ""}`);
  } else {
    console.log("  → Coding agents: not linked yet (run setup / connect)");
  }
  if (config.connected_at) console.log(`  → This machine linked: ${config.connected_at}`);
  console.log(`  → Key prefix: ${(config.api_key || "").slice(0, 16)}…`);
  console.log(`  → Dashboard: ${data.dashboard_url || "https://www.supercompress.dev/dashboard"}`);
  printPlanStatus(data);

  try {
    const log = await fetchJson(`${ACTIVITY_URL}?limit=5`, config.api_key);
    const entries = log.entries || [];
    if (entries.length) {
      console.log("\n  Recent compress activity (previews only):");
      for (const e of entries.slice(0, 5)) {
        const pct = Number(e.tokens_saved_pct || 0);
        console.log(
          `    • ${e.at || "?"} · ${pct}% · ${formatNum(e.tokens_in)}→${formatNum(e.tokens_out)} · ${(e.query || "").slice(0, 60)}`
        );
      }
      console.log("  → Full log: dashboard → Activity");
    }
  } catch (_) {
    /* optional */
  }
}

async function printAccountSummary(apiKey) {
  if (!apiKey) return;
  try {
    const data = await fetchJson(ME_URL, apiKey);
    console.log(`  → Account: ${data.email || data.uid || "linked"} (${data.plan_name || data.plan || "free"})`);
  } catch (_) {
    /* optional */
  }
}

async function fetchJson(url, apiKey) {
  const response = await fetch(url, {
    method: "GET",
    headers: { "X-API-Key": apiKey },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.detail || `HTTP ${response.status}`);
  }
  return data;
}

async function printUsageCommand(args = []) {
  const jsonOut = args.includes("--json") || args.includes("-j");
  const config = loadConfig();
  if (!config?.api_key) {
    console.log("  ○ No linked account. Run `supercompress setup` or `supercompress connect`.");
    process.exitCode = 1;
    return;
  }

  const data = await fetchJson(USAGE_URL, config.api_key);
  if (data.auth === "required" || data.ok === false) {
    throw new Error(data.detail || "Authorization required — reconnect with `supercompress connect`");
  }

  if (jsonOut) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log("  Usage");
  printPlanStatus(data);

  const saved = data.total_tokens_saved || 0;
  const tokensIn = data.total_tokens_in || 0;
  const tokensOut = data.total_tokens_out || 0;
  const requests = data.total_requests || 0;
  const savingsPct = tokensIn > 0 ? Math.round((saved / tokensIn) * 1000) / 10 : 0;

  console.log("");
  console.log("  Totals");
  console.log(`  → Requests:      ${formatNum(requests)}`);
  console.log(`  → Tokens in:     ${formatNum(tokensIn)}`);
  console.log(`  → Tokens out:    ${formatNum(tokensOut)}`);
  console.log(`  → Tokens saved:  ${formatNum(saved)}${tokensIn > 0 ? ` (−${savingsPct}%)` : ""}`);

  if (data.payg_enabled && Number(data.billable_tokens || 0) > 0) {
    console.log(`  → Billable:      ${formatNum(data.billable_tokens)} (~$${Number(data.estimated_overage_usd || 0).toFixed(2)})`);
  }
  if (data.credit_wallet) {
    console.log(
      `  → Credits:       $${Number(data.credit_balance_usd || 0).toFixed(2)} / $${Number(data.credit_limit_usd || 0).toFixed(2)} limit`
    );
  }

  const entries = Object.entries(data.coding_agent_usage || {}).sort(
    (a, b) => (b[1].tokens_saved || 0) - (a[1].tokens_saved || 0)
  );
  console.log("");
  console.log("  By coding agent");
  if (!entries.length) {
    console.log("  → No compress activity yet. Run a coding agent with SuperCompress enabled.");
  } else {
    for (const [agent, snap] of entries) {
      const inTok = snap.tokens_in || 0;
      const savedTok = snap.tokens_saved || 0;
      const pct = inTok > 0 ? Math.round((savedTok / inTok) * 1000) / 10 : 0;
      console.log(
        `    • ${agent}: ${formatNum(savedTok)} saved (−${pct}%), ${snap.requests || 0} req, ${formatNum(inTok)} → ${formatNum(snap.tokens_out || 0)}`
      );
    }
  }

  if (data.agent_plugin?.linked) {
    console.log("");
    console.log(
      `  → Agent plugin linked${data.agent_plugin.linked_at ? ` (${data.agent_plugin.linked_at})` : ""}`
    );
  }

  console.log("");
  console.log("  → Dashboard: https://www.supercompress.dev/dashboard");
  console.log("  → Tip: `supercompress usage --json` for machine-readable output");
}

async function printUsageSummary(apiKey, opts = {}) {
  if (!apiKey) {
    console.log("  → No linked account found; usage summary unavailable.");
    return;
  }

  const data = await fetchJson(USAGE_URL, apiKey);
  if (data.auth === "required" || data.ok === false) {
    throw new Error(data.detail || "Authorization required");
  }

  printPlanStatus(data);
  const agentCount = Object.keys(data.coding_agent_usage || {}).length;
  console.log(
    `  → Saved ${formatNum(data.total_tokens_saved || 0)} tokens across ${agentCount} coding agent${agentCount === 1 ? "" : "s"} (${formatNum(data.total_requests || 0)} requests)`
  );
  if (opts.compact) return;

  const entries = Object.entries(data.coding_agent_usage || {});
  if (!entries.length) {
    console.log("  → No per-agent usage yet.");
    return;
  }
  for (const [agent, snap] of entries) {
    console.log(
      `    • ${agent}: ${formatNum(snap.tokens_saved || 0)} saved, ${snap.requests || 0} requests, ${formatNum(snap.tokens_in || 0)} in → ${formatNum(snap.tokens_out || 0)} out`
    );
  }
}

function printPlanStatus(data) {
  if (!data.plan_name) return;
  if (data.unlimited) {
    console.log(`  → Plan: ${data.plan_name} (unlimited usage)`);
    return;
  }

  const used = formatNum(data.tokens_used_this_period || 0);
  const limit = formatNum(data.tokens_per_month || 0);
  const pct = Number(data.usage_pct || 0).toFixed(data.usage_pct % 1 ? 1 : 0);
  console.log(`  → Plan: ${data.plan_name} — ${used} / ${limit} tokens used (${pct}%)`);
  if (data.limit_reached || data.tokens_remaining === 0) {
    console.log(`  ⚠ Monthly limit reached. Upgrade to keep compressing: ${data.upgrade_url || "https://supercompress.dev/dashboard#billing"}`);
  } else if (Number(data.usage_pct || 0) >= 80) {
    console.log(`  ⚠ ${formatNum(data.tokens_remaining)} tokens remaining this period. Upgrade before you run out: ${data.upgrade_url || "https://supercompress.dev/dashboard#billing"}`);
  }
}

function formatNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

async function waitForDeviceConnect(code, timeoutMs = 180000) {
  const start = Date.now();
  let lastTick = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`https://www.supercompress.dev/api/connect-device?code=${encodeURIComponent(code)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.status === "linked" && data.secret) {
        return data.secret;
      }
    } catch (_) {
      /* keep polling */
    }
    const elapsed = Date.now() - start;
    if (elapsed - lastTick >= 8000) {
      lastTick = elapsed;
      console.log(`  → Still waiting for browser link… (${Math.ceil((timeoutMs - elapsed) / 1000)}s left)`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("Timed out waiting for browser sign-in. Re-run `supercompress setup`, or paste a key from the dashboard.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
