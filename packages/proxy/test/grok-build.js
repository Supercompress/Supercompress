#!/usr/bin/env node
/**
 * Grok Build wiring: AGENTS.md (not rules/), native TOML MCP, hook env{}, skill.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "supercompress.js");

function run(home, ...args) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GROK_HOME: path.join(home, ".grok"),
    },
  });
  assert.strictEqual(res.status, 0, `${args.join(" ")} exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-grok-"));
const grok = path.join(home, ".grok");
fs.mkdirSync(grok, { recursive: true });
fs.writeFileSync(
  path.join(grok, "config.toml"),
  `[cli]\ninstaller = "internal"\n`
);
fs.mkdirSync(path.join(grok, "rules"), { recursive: true });
fs.writeFileSync(path.join(grok, "rules", "supercompress.md"), "# leftover from 0.5.25\n");

run(home, "plugin");

const agentsMd = fs.readFileSync(path.join(grok, "AGENTS.md"), "utf8");
assert.match(agentsMd, /SuperCompress \(always on/, "writes ~/.grok/AGENTS.md");
assert.match(agentsMd, /updatedToolOutput|replaces the model's copy|PostToolUse replaces/i, "documents Grok PostToolUse replace");
assert.match(agentsMd, /supercompress__compress_context/, "documents Grok MCP tool names");
assert.match(agentsMd, /PostToolUse|inbox/, "documents Grok hook/inbox playbook");
assert.ok(
  !fs.existsSync(path.join(grok, "rules", "supercompress.md")),
  "removes the unread ~/.grok/rules/supercompress.md leftover"
);

const toml = fs.readFileSync(path.join(grok, "config.toml"), "utf8");
assert.match(toml, /\[mcp_servers\.supercompress\]/, "registers Grok MCP");
assert.match(toml, /env = \{/, "uses Grok inline env table");
assert.match(toml, /SUPERCOMPRESS_AGENT_NAME = "Grok Build"/, "sets Grok agent name");
assert.doesNotMatch(toml, /\[mcp_servers\.supercompress\.env\]/, "does not use nested env table");
assert.match(toml, /max_output_bytes = 2000000/, "raises Grok MCP output cap");
assert.match(toml, /\[cli\]/, "preserves existing Grok config");

const hooks = JSON.parse(fs.readFileSync(path.join(grok, "hooks", "supercompress.json"), "utf8"));
const promptHook = hooks.hooks.UserPromptSubmit[0].hooks[0];
const postHook = hooks.hooks.PostToolUse[0].hooks[0];
assert.equal(promptHook.env.SUPERCOMPRESS_AGENT_NAME, "Grok Build");
assert.equal(postHook.env.SUPERCOMPRESS_AGENT_NAME, "Grok Build");
assert.ok(!/^SUPERCOMPRESS_/.test(promptHook.command), "hook command is a path, not an env prefix");
assert.ok(promptHook.timeout >= 60, "compress hooks get a long enough timeout");
assert.match(promptHook.command, /user-prompt-submit\.js/);
assert.match(postHook.command, /post-tool-compress\.js/);

const installedHelper = path.join(home, ".cursor", "hooks", "supercompress", "grok-post-tool.js");
assert.ok(fs.existsSync(installedHelper), "plugin copies grok-post-tool.js into hook dir");

const skill = fs.readFileSync(path.join(grok, "skills", "supercompress", "SKILL.md"), "utf8");
assert.match(skill, /supercompress__compress_context/);
assert.match(skill, /updatedToolOutput|replaces the model's copy/i, "skill documents Grok PostToolUse replace");

const postSrc = fs.readFileSync(path.join(ROOT, "src", "cursor-hooks", "post-tool-compress.js"), "utf8");
assert.match(postSrc, /toolResult/, "PostToolUse reads Grok's toolResult field");
assert.match(postSrc, /buildGrokHookResponse|emitGrokReplacement/, "PostToolUse special-cases Grok");
assert.match(postSrc, /grok-post-tool/, "PostToolUse loads Grok replace helpers");

const promptSrc = fs.readFileSync(path.join(ROOT, "src", "cursor-hooks", "user-prompt-submit.js"), "utf8");
assert.match(promptSrc, /readFreshInboxDigest/, "UserPromptSubmit can inject inbox digest for hosts that accept it");
assert.match(promptSrc, /isGrokAgent|grok/i, "UserPromptSubmit still aware of Grok");

const grokHelpers = require(path.join(ROOT, "src", "cursor-hooks", "grok-post-tool.js"));
assert.ok(grokHelpers.isGrokAgent("Grok Build"), "detects Grok Build agent");
const longOut =
  Array.from({ length: 80 }, (_, i) => `line ${i}: noise padding`).join("\n") +
  "\nCRITICAL: disk full at /var/log/app.log\n";
const bashResult = {
  type: "Bash",
  command: "pytest -q",
  exit_code: 1,
  output_for_prompt: longOut,
};
const digest = "# Session memory\n\nCRITICAL: disk full at /var/log/app.log";
const replacePayload = grokHelpers.buildGrokHookResponse({
  toolResult: bashResult,
  toolResultTruncated: false,
  toolName: "run_terminal_command",
  meta: "200→40 (−80%) · delta-only",
  compressed: digest,
});
assert.equal(replacePayload.hookSpecificOutput.hookEventName, "PostToolUse");
assert.ok(replacePayload.hookSpecificOutput.updatedToolOutput, "emits updatedToolOutput");
assert.equal(replacePayload.hookSpecificOutput.updatedToolOutput.type, "Bash");
assert.match(
  replacePayload.hookSpecificOutput.updatedToolOutput.output_for_prompt,
  /SuperCompress auto/
);
assert.match(
  replacePayload.hookSpecificOutput.updatedToolOutput.output_for_prompt,
  /disk full/
);
assert.ok(
  replacePayload.hookSpecificOutput.updatedToolOutput.output_for_prompt.length < longOut.length,
  "replacement is shorter than the raw dump"
);
assert.match(replacePayload.hookSpecificOutput.additionalContext || "", /SuperCompress auto/);
assert.match(replacePayload.hookSpecificOutput.updatedMCPToolOutput || "", /disk full/);

const truncatedPayload = grokHelpers.buildGrokHookResponse({
  toolResult: longOut,
  toolResultTruncated: true,
  toolName: "run_terminal_command",
  meta: "200→40 (−80%) · delta-only",
  compressed: digest,
});
assert.ok(
  !truncatedPayload.hookSpecificOutput.updatedToolOutput,
  "truncated toolResult skips updatedToolOutput"
);
assert.match(
  truncatedPayload.hookSpecificOutput.additionalContext || "",
  /SuperCompress auto/,
  "truncated path still sends a short note"
);

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-grok-cfg-"));
process.env.SUPERCOMPRESS_CONFIG_DIR = cfgDir;
delete require.cache[require.resolve(path.join(ROOT, "src", "cursor-hooks", "compress-prompt-lib.js"))];
const lib = require(path.join(ROOT, "src", "cursor-hooks", "compress-prompt-lib.js"));
const sessionPath = lib.writeInbox("ask", "DIGEST_MIRROR_KEEP", "9→1", {
  session_id: "grok-mirror-test",
  kind: "test",
});
assert.ok(sessionPath.includes(`${path.sep}grok-mirror-test${path.sep}`), "session inbox path");
const globalMd = path.join(lib.INBOX_DIR, "latest.md");
assert.ok(fs.existsSync(globalMd), "mirrors to inbox/latest.md for AGENTS.md");
assert.match(fs.readFileSync(globalMd, "utf8"), /DIGEST_MIRROR_KEEP/);
assert.match(lib.readFreshInboxDigest("grok-mirror-test"), /DIGEST_MIRROR_KEEP/);

// Live PostToolUse smoke when a real account key is available (skip offline).
const homeConfig = path.join(os.homedir(), ".supercompress", "config.json");
let liveKey = false;
try {
  const cfg = JSON.parse(fs.readFileSync(homeConfig, "utf8"));
  liveKey = Boolean(cfg.api_key && String(cfg.api_key).startsWith("sc_"));
} catch {
  /* no live account */
}
if (liveKey) {
  const postHookScript = path.join(ROOT, "src", "cursor-hooks", "post-tool-compress.js");
  const post = spawnSync(process.execPath, [postHookScript], {
    encoding: "utf8",
    timeout: 120000,
    input: JSON.stringify({
      toolName: "run_terminal_command",
      toolResult: bashResult,
      sessionId: `grok-replace-live-${Date.now()}`,
    }),
    env: {
      ...process.env,
      SUPERCOMPRESS_AGENT_NAME: "Grok Build",
      // Use real ~/.supercompress — empty CONFIG_DIR has no key and fail-opens.
      SUPERCOMPRESS_CONFIG_DIR: path.join(os.homedir(), ".supercompress"),
    },
  });
  assert.strictEqual(post.status, 0, `live post hook failed: ${post.stderr}`);
  assert.match(post.stdout, /updatedToolOutput/, "live Grok PostToolUse returns updatedToolOutput");
  const postJson = JSON.parse(post.stdout);
  const replaced = postJson.hookSpecificOutput.updatedToolOutput;
  assert.equal(replaced.type, "Bash", "keeps Bash toolResult shape");
  assert.match(replaced.output_for_prompt, /SuperCompress auto/, "replaces output_for_prompt");
}

// Offline UserPromptSubmit inject path (best-effort for hosts that accept it)
const promptHookScript = path.join(ROOT, "src", "cursor-hooks", "user-prompt-submit.js");
const inject = spawnSync(process.execPath, [promptHookScript], {
  encoding: "utf8",
  timeout: 15000,
  input: JSON.stringify({
    prompt: "what failed?",
    sessionId: "grok-mirror-test",
  }),
  env: {
    ...process.env,
    SUPERCOMPRESS_AGENT_NAME: "Grok Build",
    SUPERCOMPRESS_CONFIG_DIR: cfgDir,
  },
});
assert.strictEqual(inject.status, 0, `prompt hook failed: ${inject.stderr}`);
assert.match(inject.stdout, /DIGEST_MIRROR_KEEP/, "UserPromptSubmit can still emit a digest payload");
assert.match(inject.stdout, /additionalContext|additional_context/);
fs.rmSync(cfgDir, { recursive: true, force: true });

run(home, "uninstall");
assert.ok(
  !fs.existsSync(path.join(grok, "skills", "supercompress", "SKILL.md")),
  "uninstall removes Grok skill"
);
if (fs.existsSync(path.join(grok, "AGENTS.md"))) {
  assert.doesNotMatch(
    fs.readFileSync(path.join(grok, "AGENTS.md"), "utf8"),
    /SuperCompress \(always on/
  );
}
const tomlAfter = fs.existsSync(path.join(grok, "config.toml"))
  ? fs.readFileSync(path.join(grok, "config.toml"), "utf8")
  : "";
assert.doesNotMatch(tomlAfter, /mcp_servers\.supercompress/, "uninstall removes Grok MCP");

fs.rmSync(home, { recursive: true, force: true });
console.log("✔ Grok Build AGENTS.md + inline MCP env + hook env{} + skill + PostToolUse replace");
