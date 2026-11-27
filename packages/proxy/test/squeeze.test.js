#!/usr/bin/env node
/**
 * Shell-output squeeze: the path that keeps tokens out of an agent's context.
 *
 * Covers the squeezer's safety rules, the PreToolUse rewrite decisions, the
 * runner's exit status in real bash and zsh, and install / uninstall against a
 * throwaway HOME (never the developer's real agent configuration).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const { squeeze } = require("../src/squeeze.js");
const hook = require("../src/cursor-hooks/pre-tool-squeeze.js");

const lines = (n, fmt) => Array.from({ length: n }, (_, i) => fmt(i)).join("\n");

function tmpHome(prefix = "sc-squeeze-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("collapses repeated lines and keeps errors, failures and the tail", () => {
  const raw = [
    lines(400, (i) => `    ✓ handles case ${i} (${i % 9} ms)`),
    " FAIL  src/billing/ledger.test.ts",
    "    ✕ credits a top-up exactly once (14 ms)",
    "    Expected: 1",
    "    Received: 2",
    "      at Object.<anonymous> (src/billing/ledger.test.ts:42:27)",
    lines(300, (i) => `INFO heartbeat ok id=${i}`),
    "Tests:       1 failed, 400 passed, 401 total",
  ].join("\n");
  const r = squeeze(raw);
  assert.ok(r.applied);
  assert.ok(r.kept_tokens < r.original_tokens / 5, `${r.kept_tokens} vs ${r.original_tokens}`);
  for (const must of ["FAIL  src/billing", "✕ credits a top-up", "Expected: 1", "Received: 2", "ledger.test.ts:42:27", "Tests:       1 failed"]) {
    assert.ok(r.text.includes(must), `dropped: ${must}`);
  }
  assert.match(r.text, /similar lines omitted/);
});

test("passes small or distinct output through unchanged", () => {
  const small = lines(20, (i) => `line ${i}`);
  assert.strictEqual(squeeze(small).text, small);
  assert.strictEqual(squeeze(small).applied, false);
  const r = squeeze(lines(600, (i) => `src/${["alpha", "beta", "gamma", "delta"][i % 4]}/${i.toString(36)}-${(i * 7919).toString(36)}.ts: export function ${(i * 104729).toString(36)}Handler()`));
  assert.strictEqual(r.applied, false, "grep-style hit lists must not be collapsed");
});

test("never drops a repeated error line", () => {
  const raw = lines(200, (i) => `ERROR request ${i} failed: ECONNRESET`);
  const r = squeeze(raw);
  assert.strictEqual((r.text.match(/ECONNRESET/g) || []).length, 200);
});

test("rewrites only commands that are safe to wrap", () => {
  const bypass = (command, extra = {}) =>
    hook.decide({ tool_name: "Bash", permission_mode: "bypassPermissions", tool_input: { command, ...extra } });
  const normal = (command) => hook.decide({ tool_name: "Bash", permission_mode: "default", tool_input: { command } });

  assert.ok(bypass("npm test && npm run lint"));
  assert.ok(bypass("git status"));
  for (const c of ["cd pkg && npm test", "export X=1; make", "source .venv/bin/activate", "npm run dev &", "tail -f app.log", "cat README.md", "git diff HEAD~1", "vim x", "SC_RAW=1 npm test"]) {
    assert.strictEqual(bypass(c), null, `should skip: ${c}`);
  }
  assert.strictEqual(bypass("npm test", { run_in_background: true }), null);
  assert.strictEqual(hook.decide({ tool_name: "Read", permission_mode: "bypassPermissions", tool_input: { file_path: "x" } }), null);

  // Permission-checked modes: plain pipe, single known-noisy commands only.
  assert.match(normal("npm test").hookSpecificOutput.updatedInput.command, /^npm test 2>&1 \| \S*squeeze-run\.js$/);
  assert.match(normal("pytest -q 2>&1").hookSpecificOutput.updatedInput.command, /^pytest -q 2>&1 \| /);
  for (const c of ["git status", "npm test && npm run lint", "npm test | tail -5", "make $TARGET"]) {
    assert.strictEqual(normal(c), null, `should skip in default mode: ${c}`);
  }
  assert.strictEqual(normal("npm test").hookSpecificOutput.permissionDecision, undefined, "must never auto-approve");
});

test("runner keeps the real exit status and output in bash and zsh", () => {
  const home = tmpHome();
  const loud = `python3 -c "import sys;[print(f'INFO tick {i}') for i in range(3000)];print('ERROR boom at worker.py:42');sys.exit(2)"`;
  for (const shell of ["bash", "zsh"]) {
    if (spawnSync("which", [shell]).status !== 0) continue;
    const env = { ...process.env, HOME: home, SUPERCOMPRESS_CONFIG_DIR: path.join(home, ".supercompress") };
    for (const [cmd, code] of [[loud, 2], ["echo ok; exit 3", 3], ["echo hi # trailing comment", 0], ["cat <<EOF\nheredoc line\nEOF", 0]]) {
      const res = spawnSync(shell, ["-c", hook.wrapCommand(cmd)], { encoding: "utf8", env });
      assert.strictEqual(res.status, code, `${shell}: ${cmd} → ${res.status} ${res.stderr}`);
      if (cmd === loud) {
        assert.match(res.stdout, /ERROR boom at worker\.py:42/);
        assert.match(res.stdout, /\[supercompress: \d+→\d+ tokens/);
        const file = res.stdout.match(/Full output: (\S+\.log)/)[1];
        assert.ok(fs.readFileSync(file, "utf8").includes("INFO tick 2999"), "raw output must be saved in full");
      }
    }
    const plain = spawnSync(shell, ["-c", hook.wrapPlain(loud)], { encoding: "utf8", env });
    assert.strictEqual(plain.status, 0);
    assert.match(plain.stdout, /Exit status not visible/);
  }
  const ledger = fs.readFileSync(path.join(home, ".supercompress", "savings.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(ledger.length >= 1 && ledger.every((e) => e.applied && e.kept_tokens < e.original_tokens));
  assert.ok(ledger.every((e) => !("output" in e) && !("command" in e)), "ledger must not store output or full commands");
});

test("setup swaps the additive hooks for the squeeze hook; uninstall removes it", () => {
  const home = tmpHome("sc-squeeze-install-");
  const oldHook = path.join(home, ".cursor", "hooks", "supercompress", "post-tool-compress.js");
  const userHook = { type: "command", command: "/usr/local/bin/my-own-hook.sh" };
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(npm test:*)"] },
      hooks: {
        UserPromptSubmit: [{ hooks: [userHook, { type: "command", command: oldHook.replace("post-tool-compress", "user-prompt-submit") }] }],
        PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `SUPERCOMPRESS_AGENT_NAME="Claude Code" ${oldHook}` }] }],
      },
    })
  );
  fs.writeFileSync(
    path.join(home, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `SUPERCOMPRESS_AGENT_NAME=Codex ${oldHook}` }] }] } })
  );
  const script = `
    const d = require(${JSON.stringify(path.join(ROOT, "src", "detector.js"))});
    d.writeCursorHooks();
    d.writeAgentPromptHooks();
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home, GROK_HOME: path.join(home, ".grok") };
  const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", env });
  assert.strictEqual(res.status, 0, res.stderr);

  const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  const pre = claude.hooks.PreToolUse;
  assert.strictEqual(pre.length, 1);
  assert.strictEqual(pre[0].matcher, "Bash");
  assert.match(pre[0].hooks[0].command, /supercompress[\\/]pre-tool-squeeze\.js$/);
  assert.strictEqual(claude.hooks.PostToolUse, undefined, "additive PostToolUse hook must be gone");
  assert.ok(!JSON.stringify(claude.hooks.UserPromptSubmit || []).includes("supercompress"), "additive prompt hook must be gone");
  assert.ok(JSON.stringify(claude.hooks.UserPromptSubmit || []).includes("my-own-hook.sh") || !claude.hooks.UserPromptSubmit, "user hook kept");
  assert.ok(claude.permissions.allow.includes("Bash(npm test:*)"), "user rule kept");
  const rule = claude.permissions.allow.find((r) => r.includes("squeeze-run.js"));
  assert.ok(rule, "runner allow rule added");

  const hooksDir = path.join(home, ".cursor", "hooks", "supercompress");
  for (const f of ["pre-tool-squeeze.js", "squeeze-run.js", "squeeze.js"]) assert.ok(fs.existsSync(path.join(hooksDir, f)), `${f} installed`);
  const runner = path.join(hooksDir, "squeeze-run.js");
  assert.strictEqual(rule, `Bash(${hook.shellQuote(runner)}:*)`, "rule matches the command text the hook writes");

  const codex = JSON.parse(fs.readFileSync(path.join(home, ".codex", "hooks.json"), "utf8"));
  assert.ok(!JSON.stringify(codex).includes("post-tool-compress"), "Codex additive hook removed");

  const cursor = JSON.parse(fs.readFileSync(path.join(home, ".cursor", "hooks.json"), "utf8"));
  assert.ok(!cursor.hooks.postToolUse && !cursor.hooks.beforeSubmitPrompt, "Cursor additive hooks removed");

  // The installed copy works on its own (squeeze.js beside it).
  const installed = spawnSync("bash", ["-c", `python3 -c "[print(f'INFO tick {i}') for i in range(3000)]" 2>&1 | ${runner}`], {
    encoding: "utf8",
    env: { ...env, SUPERCOMPRESS_CONFIG_DIR: path.join(home, ".supercompress") },
  });
  assert.match(installed.stdout, /\[supercompress: \d+→\d+ tokens/);

  const un = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(ROOT, "src", "detector.js"))}).removePluginArtifacts()`], { encoding: "utf8", env });
  assert.strictEqual(un.status, 0, un.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.ok(!JSON.stringify(after).includes("squeeze"), "uninstall removes the hook and the allow rule");
  assert.ok(after.permissions.allow.includes("Bash(npm test:*)"), "uninstall keeps user rules");
});
