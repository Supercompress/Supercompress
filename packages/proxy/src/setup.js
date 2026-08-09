/**
 * Setup — interactive one-time setup for SuperCompress.
 *
 * Default path (subscription / login safe):
 *   1. Link SuperCompress account
 *   2. Auto-detect coding agents
 *   3. Install MCP plugin + Cursor rule
 *   4. Clear provider base-URL overrides (no API-key proxy mode)
 *
 * Optional: pass --proxy to also wire localhost:8080 base URLs + start proxy.
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const readline = require("readline");

const detector = require("./detector");
const registerService = require("./service");

function ask(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function connectViaBrowser() {
  // 128-bit pairing code (was 32-bit) — hardens device-link against enumeration
  const code = crypto.randomBytes(16).toString("hex");
  const connectUrl = `https://www.supercompress.dev/dashboard?connect=${code}&source=setup`;
  const openCommand = process.platform === "darwin" ? "open" :
    process.platform === "win32" ? "start" : "xdg-open";
  try {
    execSync(`${openCommand} "${connectUrl}"`, { stdio: "ignore" });
  } catch {}

  console.log("  → Finish sign-in in the browser to connect your account.");
  console.log(`  → If the tab is already open on the dashboard, refresh it.`);
  console.log(`  → Connection code: ${code}`);
  console.log(`  → Link: ${connectUrl}`);

  const started = Date.now();
  const timeoutMs = 180000;
  let lastTick = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(
        `https://www.supercompress.dev/api/connect-device?code=${encodeURIComponent(code)}`
      );
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.status === "linked" && body.secret) {
        return body.secret;
      }
    } catch (err) {
      // network blip — keep polling
    }
    const elapsed = Date.now() - started;
    if (elapsed - lastTick >= 8000) {
      lastTick = elapsed;
      const left = Math.max(0, Math.ceil((timeoutMs - elapsed) / 1000));
      console.log(`  → Still waiting for browser link… (${left}s left)`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("");
  console.log("  ✗ Timed out waiting for browser sign-in.");
  console.log("  → Paste an API key from https://www.supercompress.dev/dashboard (Keys) instead.");
  const pasted = await ask("  → API key (sc_…), or Enter to abort: ");
  if (pasted && pasted.startsWith("sc_")) return pasted.trim();
  throw new Error("Timed out waiting for browser sign-in.");
}

module.exports = async function setup({ CONFIG_DIR, CONFIG_PATH, PID_PATH, LOG_PATH, loadConfig, saveConfig }) {
  const wantProxy = process.argv.includes("--proxy");

  console.log("  ┌─────────────────────────────────────────────┐");
  console.log("  │          SuperCompress Setup              │");
  console.log("  └─────────────────────────────────────────────┘");
  console.log("");
  console.log(wantProxy
    ? "  Mode: MCP plugin + optional API proxy (--proxy)"
    : "  Mode: auto-detect + MCP plugin (subscription/login safe)");
  console.log("");

  const existingConfig = loadConfig();
  let apiKey = existingConfig && existingConfig.api_key;

  if (apiKey) {
    console.log("  ✓ Existing SuperCompress account link found.");
    const answer = await ask("  → Reconnect account? (y/N): ");
    if (answer.toLowerCase() === "y") apiKey = null;
  }

  if (!apiKey) {
    console.log("");
    console.log("  Step 1: Connect your SuperCompress account");
    console.log("  ─────────────────────────────");
    console.log("  Browser sign-in links this install automatically.");
    console.log("");
    console.log("  → Connecting your account in the browser...");
    try {
      apiKey = await connectViaBrowser();
    } catch (err) {
      console.log(`  ✗ ${err.message}`);
      return;
    }
    console.log("  ✓ Account linked.");
  }

  const config = {
    ...(existingConfig || {}),
    api_key: apiKey,
    port: (existingConfig && existingConfig.port) || 8080,
    configured_at: new Date().toISOString(),
    mode: wantProxy ? "proxy" : "mcp",
    configured_agents: [],
  };
  saveConfig(config);

  console.log("");
  console.log("  Step 2: Detect agents + install MCP plugin");
  console.log("  ──────────────────────────────────────────");
  const found = detector.detectAll();
  if (found.length === 0) {
    console.log("  ○ No coding agents detected yet.");
  } else {
    console.log("  Found:");
    for (const agent of found) {
      console.log(`    ✓ ${agent.name}`);
    }
  }

  const auto = detector.installAutoPlugin();
  config.configured_agents = auto.mcpConfigured;
  saveConfig(config);

  if (auto.mcpConfigured.length) {
    console.log(`  ✓ MCP plugin installed for: ${auto.mcpConfigured.join(", ")}`);
  } else {
    console.log("  ○ No MCP-capable agent configs found to update.");
  }
  console.log(`  ✓ Cursor rule written: ${auto.rulePath}`);
  console.log(`  ✓ Cursor hooks written: ${auto.hooks.hooksPath}`);
  console.log("    → beforeSubmitPrompt compresses every submit with context (ask stays the query)");
  console.log("    → postToolUse auto-compresses large tool dumps (main savings path)");
  if (auto.agentHooks.installed.length) {
    console.log(`  ✓ Prompt/tool hooks: ${auto.agentHooks.installed.join(", ")}`);
  }
  if (auto.instructions.length) {
    console.log(`  ✓ Always-on instructions: ${auto.instructions.join(", ")}`);
  }
  if (auto.cleared.length) {
    console.log(`  ✓ Cleared provider API-key proxy overrides: ${auto.cleared.join(", ")}`);
  }
  console.log("  → Works with Cursor / Claude / Codex login — no provider API-key mode.");
  console.log("  → Restart agents so MCP/hooks reload.");

  if (!wantProxy) {
    console.log("");
    console.log("  ┌─────────────────────────────────────────────┐");
    console.log("  │           Setup Complete!                  │");
    console.log("  └─────────────────────────────────────────────┘");
    console.log("");
    console.log("  Next steps:");
    console.log("    1. Restart your coding agent so MCP/hooks reload");
    console.log("    2. Big dumps auto-compress via hooks; use compress_context for large pastes");
    console.log("");
    console.log("  Tip: `supercompress plugin` re-runs detect + install anytime.");
    console.log("  Tip: `supercompress setup --proxy` only if you need durable base-URL rewrite.");
    console.log("");
    return;
  }

  // Optional proxy path (provider API-key mode)
  console.log("");
  console.log("  Step 3: Optional proxy mode (--proxy)");
  console.log("  ─────────────────────────────────────");
  const configured = detector.configureAll();
  config.configured_agents = [...new Set([...auto.mcpConfigured, ...configured])];
  config.mode = "proxy";
  saveConfig(config);
  for (const name of configured) {
    console.log(`  ✓ ${name} base URL → http://localhost:8080/v1`);
  }

  console.log("");
  console.log("  Step 4: Background proxy service");
  console.log("  ────────────────────────────────");
  const serviceRegistered = registerService(CONFIG_DIR, CONFIG_PATH);
  if (serviceRegistered) {
    console.log("  ✓ Background service registered!");
  } else {
    console.log("  ⚠ Could not register background service; starting local process.");
  }

  console.log("");
  console.log("  → Starting the proxy now...");
  if (serviceRegistered) {
    try {
      await waitForHealth(config.port);
      console.log(`  ✓ Background proxy is healthy on localhost:${config.port}`);
      return;
    } catch (err) {
      console.log(`  ⚠ Background service not yet healthy: ${err.message}`);
    }
  }
  const serverPath = path.join(__dirname, "server.js");
  const logPath = path.join(CONFIG_DIR, "proxy.log");
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [serverPath, String(config.port)], {
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
    await waitForHealth(config.port);
    console.log(`  ✓ Proxy is healthy on localhost:${config.port} (PID ${child.pid})`);
  } catch (err) {
    try { process.kill(child.pid, "SIGTERM"); } catch {}
    try { fs.unlinkSync(PID_PATH); } catch {}
    console.log(`  ✗ Proxy failed to start: ${err.message}`);
  }
};

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
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Proxy did not become healthy on localhost:${port}`));
      setTimeout(check, 100);
    };
    check();
  });
}
