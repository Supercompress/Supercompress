/**
 * SuperCompress Connectors — clean, one-page install recipes for each harness.
 * Product name: "connector". Auto-wired hosts come from the detector catalog;
 * app/SDK connectors cover drop-in middleware.
 */

const path = require("path");
const os = require("os");

const HOME = os.homedir();

/** Manual / recipe cards that aren't just MCP auto-detect. */
const APP_CONNECTORS = [
  {
    id: "mcp-stdio",
    name: "Any MCP client",
    harness: "Any agent that speaks MCP (stdio)",
    kind: "mcp",
    auto: false,
    oneLiner: "supercompress agents connect",
    install: [
      "npm i -g supercompress-proxy",
      "supercompress setup",
      "supercompress agents connect",
    ],
    configHint: "Paste stdio: command supercompress-mcp (env SUPERCOMPRESS_CONFIG_DIR=~/.supercompress)",
    tweetHook: "Drop SuperCompress into any MCP client with one stdio server.",
  },
  {
    id: "vercel-ai-sdk",
    name: "Vercel AI SDK",
    harness: "Next.js / AI SDK apps",
    kind: "sdk",
    auto: false,
    oneLiner: "Wrap your language model with SuperCompress before generateText",
    install: [
      "export SUPERCOMPRESS_API_KEY=sc_…",
      "# copy integrations/vercel-ai-sdk.ts into your app",
    ],
    configHint: "integrations/vercel-ai-sdk.ts — wrapLanguageModel",
    repoPath: "integrations/vercel-ai-sdk.ts",
    tweetHook: "Vercel AI SDK connector — compress context before generateText / streamText.",
  },
  {
    id: "openai-python",
    name: "OpenAI Python SDK",
    harness: "openai Python client",
    kind: "sdk",
    auto: false,
    oneLiner: "Wrap your OpenAI client — compress prompts on the way in",
    install: ["pip install supercompress", "# see integrations/openai_middleware.py"],
    configHint: "integrations/openai_middleware.py",
    repoPath: "integrations/openai_middleware.py",
    tweetHook: "OpenAI Python connector — middleware that shrinks prompts before the API call.",
  },
  {
    id: "anthropic-python",
    name: "Anthropic Python SDK",
    harness: "anthropic Python client",
    kind: "sdk",
    auto: false,
    oneLiner: "Same pattern for Claude API calls",
    install: ["pip install supercompress", "# see integrations/anthropic_middleware.py"],
    configHint: "integrations/anthropic_middleware.py",
    repoPath: "integrations/anthropic_middleware.py",
    tweetHook: "Anthropic SDK connector — compress Claude prompts without changing your app logic.",
  },
  {
    id: "langchain",
    name: "LangChain",
    harness: "LangChain callbacks",
    kind: "sdk",
    auto: false,
    oneLiner: "Callback handler that compresses before the LLM",
    install: ["pip install supercompress", "# see integrations/langchain_callback.py"],
    configHint: "integrations/langchain_callback.py",
    repoPath: "integrations/langchain_callback.py",
    tweetHook: "LangChain connector — drop-in callback, fewer tokens on every chain.",
  },
  {
    id: "express",
    name: "Express / Node API",
    harness: "Express or Next.js API routes",
    kind: "sdk",
    auto: false,
    oneLiner: "Middleware for your compress-or-proxy route",
    install: ["npm i supercompress-proxy", "# see integrations/express-middleware.ts"],
    configHint: "integrations/express-middleware.ts",
    repoPath: "integrations/express-middleware.ts",
    tweetHook: "Express connector — compress bulky request context before it hits your LLM route.",
  },
];

/** Canonical MCP path hints for tweet/docs cards. */
const MCP_PATH_HINTS = {
  Cursor: "~/.cursor/mcp.json + hooks",
  "Claude Code": "~/.claude.json + hooks",
  Codex: "~/.codex/config.toml + hooks",
  Goose: "~/.config/goose/config.yaml (extensions)",
  OpenCode: "opencode.json(c) mcp.supercompress",
  Zed: "settings.json context_servers",
  "Grok Build": "~/.grok/config.toml + hooks",
  fx: "~/.fx/mcp.json + skill",
  Hermes: "~/.hermes/config.yaml",
  OpenClaw: "~/.openclaw/openclaw.json",
  Windsurf: "windsurf mcp_config.json",
  Continue: "~/.continue/config.json (MCP servers)",
  "Gemini CLI": "~/.gemini/settings.json",
  FreeBuff: "~/.agents/mcp.json",
  "Claude Desktop": "claude_desktop_config.json",
};

function slugify(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function harnessConnectors() {
  const { AGENT_CATALOG, AUTO_MCP_AGENTS } = require("./detector");
  return AGENT_CATALOG.map((agent) => {
    const auto = Boolean(agent.autoMcp || AUTO_MCP_AGENTS.has(agent.name));
    const id = slugify(agent.name);
    return {
      id,
      name: agent.name,
      harness: agent.name,
      kind: "harness",
      auto,
      oneLiner: auto
        ? `supercompress plugin   # wires ${agent.name}`
        : `supercompress agents connect   # then point ${agent.name} at MCP`,
      install: auto
        ? ["npm i -g supercompress-proxy", "supercompress setup", "supercompress plugin", "supercompress doctor"]
        : ["npm i -g supercompress-proxy", "supercompress setup", "supercompress agents connect"],
      configHint: MCP_PATH_HINTS[agent.name] || (auto ? "auto MCP via setup/plugin" : "agents connect / base URL"),
      tweetHook: auto
        ? `SuperCompress connector for ${agent.name} — one command, native MCP.`
        : `SuperCompress connector for ${agent.name} — MCP via agents connect.`,
    };
  });
}

function allConnectors() {
  const seen = new Set();
  const out = [];
  for (const c of [...harnessConnectors(), ...APP_CONNECTORS]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out.sort((a, b) => {
    if (a.auto !== b.auto) return a.auto ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "harness" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function findConnector(query) {
  const q = slugify(query);
  if (!q) return null;
  const all = allConnectors();
  return (
    all.find((c) => c.id === q) ||
    all.find((c) => slugify(c.name) === q) ||
    all.find((c) => slugify(c.harness) === q) ||
    all.find((c) => c.id.includes(q) || slugify(c.name).includes(q)) ||
    null
  );
}

function printConnectorList({ json = false } = {}) {
  const all = allConnectors();
  const auto = all.filter((c) => c.auto);
  const sdk = all.filter((c) => c.kind === "sdk" || c.id === "mcp-stdio");
  const recipe = all.filter((c) => c.kind === "harness" && !c.auto);
  if (json) {
    console.log(JSON.stringify({ connectors: all, counts: { total: all.length, auto: auto.length, sdk: sdk.length, recipe: recipe.length } }, null, 2));
    return all;
  }
  console.log("");
  console.log("  SuperCompress connectors");
  console.log("  ────────────────────────");
  console.log(`  ${all.length} total · ${auto.length} auto MCP · ${sdk.length} app/SDK · ${recipe.length} recipe`);
  console.log("");
  console.log("  Auto (setup / plugin wires these):");
  for (const c of auto) {
    console.log(`    ${c.id.padEnd(22)} ${c.harness}`);
  }
  console.log("");
  console.log("  App / SDK:");
  for (const c of sdk) {
    console.log(`    ${c.id.padEnd(22)} ${c.harness}`);
  }
  console.log("");
  console.log("  Recipe (agents connect):");
  for (const c of recipe.slice(0, 20)) {
    console.log(`    ${c.id.padEnd(22)} ${c.harness}`);
  }
  if (recipe.length > 20) console.log(`    … +${recipe.length - 20} more`);
  console.log("");
  console.log("  Show one:  supercompress connector <id>");
  console.log("  Example:   supercompress connector cursor");
  console.log("  Install:   supercompress setup && supercompress plugin");
  console.log("");
  return all;
}

function printConnectorCard(query, { json = false } = {}) {
  const c = findConnector(query);
  if (!c) {
    console.error(`  ✗ Unknown connector "${query}". Run: supercompress connectors`);
    process.exitCode = 1;
    return null;
  }
  if (json) {
    console.log(JSON.stringify(c, null, 2));
    return c;
  }
  console.log("");
  console.log(`  ◆ Connector · ${c.name}`);
  console.log("  ────────────────────────────");
  console.log(`  Harness     ${c.harness}`);
  console.log(`  Kind        ${c.kind}${c.auto ? " · auto MCP" : ""}`);
  console.log(`  Config      ${c.configHint}`);
  console.log("");
  console.log("  Install");
  for (const line of c.install) {
    console.log(`    ${line}`);
  }
  console.log("");
  console.log(`  One-liner   ${c.oneLiner}`);
  if (c.tweetHook) console.log(`  Pitch       ${c.tweetHook}`);
  console.log("");
  console.log("  Docs        https://docs.supercompress.dev/coding-agents");
  console.log("");
  return c;
}

/** Short card for social — no automation, just copy. */
function tweetDraftFor(query) {
  const c = findConnector(query);
  if (!c) return null;
  const lines = [
    `SuperCompress connector: ${c.name}`,
    "",
    `Harness: ${c.harness}`,
    c.auto ? "Install: npm i -g supercompress-proxy && supercompress setup" : `Install: ${c.oneLiner}`,
    "",
    "Compress bulky agent context. Keep the answer.",
    "https://docs.supercompress.dev/coding-agents",
  ];
  return { connector: c, text: lines.join("\n") };
}

module.exports = {
  APP_CONNECTORS,
  allConnectors,
  findConnector,
  printConnectorList,
  printConnectorCard,
  tweetDraftFor,
  slugify,
};
