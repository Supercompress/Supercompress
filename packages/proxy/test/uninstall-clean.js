#!/usr/bin/env node
/**
 * `supercompress uninstall` must leave nothing behind.
 *
 * uninstall reported success while leaving the Cursor rule, the Cursor hook
 * scripts and registrations, and the agent instruction blocks in place:
 * revertAll only ever walked the provider base-URL configs, and the writers
 * responsible recorded no backup for the uninstaller to restore from.
 *
 * Every command runs against a throwaway HOME, so the suite never touches the
 * developer's real agent configuration.
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
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.strictEqual(res.status, 0, `${args.join(" ")} exited ${res.status}: ${res.stderr}`);
  return res.stdout;
}

function newHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sc-uninstall-"));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  return home;
}

/** Every file under `dir` that still mentions SuperCompress. */
function residue(dir) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (/supercompress/i.test(e.name)) { hits.push(full); continue; }
      try {
        if (/supercompress/i.test(fs.readFileSync(full, "utf8"))) hits.push(full);
      } catch { /* binary or unreadable */ }
    }
  };
  walk(dir);
  return hits;
}

const USER_NOTES = "# My personal notes\n\nKeep this.\n";
let passed = 0;

// 1. Install then uninstall must restore the starting state exactly.
{
  const home = newHome();
  const claudeMd = path.join(home, ".claude", "CLAUDE.md");
  const settings = path.join(home, ".claude", "settings.json");
  const settingsBefore = '{"model":"opus","theme":"dark"}\n';
  fs.writeFileSync(claudeMd, USER_NOTES);
  fs.writeFileSync(settings, settingsBefore);

  run(home, "plugin");
  assert.ok(
    fs.readFileSync(settings, "utf8").includes("supercompress"),
    "precondition: plugin should have installed hooks into settings.json"
  );

  run(home, "uninstall");

  assert.strictEqual(
    fs.readFileSync(claudeMd, "utf8"),
    USER_NOTES,
    "uninstall must restore CLAUDE.md to its pre-install content"
  );
  assert.strictEqual(
    JSON.parse(fs.readFileSync(settings, "utf8")).hooks,
    undefined,
    "uninstall must remove the hooks it added to settings.json"
  );
  const left = residue(home);
  assert.deepStrictEqual(left, [], `uninstall left artifacts behind:\n  ${left.join("\n  ")}`);
  fs.rmSync(home, { recursive: true, force: true });
  console.log("✔ uninstall removes every artifact and restores user content");
  passed++;
}

// 2. Installs from releases that recorded no backups must still uninstall
//    cleanly, and unrelated Cursor hooks must survive.
{
  const home = newHome();
  const claudeMd = path.join(home, ".claude", "CLAUDE.md");
  const hooksJson = path.join(home, ".cursor", "hooks.json");
  const scHooks = path.join(home, ".cursor", "hooks", "supercompress");
  fs.mkdirSync(scHooks, { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor", "rules"), { recursive: true });

  fs.writeFileSync(
    claudeMd,
    `${USER_NOTES}\n# SuperCompress (always on · context only)\n\nCompress bulky **context**.\n\n1. Read the digest.\n`
  );
  fs.writeFileSync(path.join(home, ".cursor", "rules", "supercompress.mdc"), "legacy rule\n");
  fs.writeFileSync(path.join(scHooks, "session-start.js"), "// legacy\n");
  fs.writeFileSync(
    hooksJson,
    JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [{ command: path.join(scHooks, "session-start.js") }],
        myOwnHook: [{ command: "/usr/bin/true" }],
      },
    })
  );

  run(home, "uninstall");

  assert.strictEqual(
    fs.readFileSync(claudeMd, "utf8"),
    USER_NOTES,
    "uninstall must strip the instruction block without eating user content"
  );
  const hooks = JSON.parse(fs.readFileSync(hooksJson, "utf8")).hooks;
  assert.ok(hooks.myOwnHook, "unrelated Cursor hooks must survive uninstall");
  assert.strictEqual(hooks.sessionStart, undefined, "SuperCompress hook entry must be removed");
  const left = residue(home);
  assert.deepStrictEqual(left, [], `legacy uninstall left artifacts behind:\n  ${left.join("\n  ")}`);
  fs.rmSync(home, { recursive: true, force: true });
  console.log("✔ legacy installs uninstall cleanly and spare unrelated hooks");
  passed++;
}

// 3. A user's own file at one of our paths is backed up and restored — the
//    artifact sweep must not then delete what the restore just put back.
{
  const home = newHome();
  const rulePath = path.join(home, ".cursor", "rules", "supercompress.mdc");
  const mine = "MY OWN CURSOR RULE - not supercompress\n";
  fs.mkdirSync(path.dirname(rulePath), { recursive: true });
  fs.writeFileSync(rulePath, mine);

  run(home, "plugin");
  run(home, "uninstall");

  assert.ok(fs.existsSync(rulePath), "a pre-existing user file must survive uninstall");
  assert.strictEqual(
    fs.readFileSync(rulePath, "utf8"),
    mine,
    "a pre-existing user file must be restored to its original contents"
  );
  fs.rmSync(home, { recursive: true, force: true });
  console.log("✔ a user's own file at one of our paths is restored, not deleted");
  passed++;
}

// 4. Stripping the instruction block must stop at the next heading of any
//    level, or a user section starting with "##" is swallowed with it.
{
  const { stripInstructionBlock } = require(path.join(ROOT, "src", "detector.js"));
  const input = [
    "# My notes", "", "Keep this.", "",
    "# SuperCompress (always on · context only)", "", "Compress bulky context.", "",
    "## My own subsection", "", "This must survive.", "",
  ].join("\n");
  const out = stripInstructionBlock(input);
  assert.ok(out.includes("Keep this."), "content before the block must survive");
  assert.ok(out.includes("## My own subsection"), "a following h2 section must survive");
  assert.ok(out.includes("This must survive."), "content under a following h2 must survive");
  assert.ok(!out.includes("SuperCompress (always on"), "the block itself must be removed");
  console.log("✔ block stripping stops at the next heading of any level");
  passed++;
}

// 5. Claude/Codex hook registrations from an install that recorded no backup
//    must still be removed — including Windows-style backslash paths.
{
  const home = newHome();
  const settings = path.join(home, ".claude", "settings.json");
  const codexHooks = path.join(home, ".codex", "hooks.json");
  fs.writeFileSync(
    settings,
    JSON.stringify({
      model: "opus",
      hooks: {
        PostToolUse: [
          { hooks: [{ type: "command", command: "C:\\Users\\me\\.cursor\\hooks\\supercompress\\post-tool-compress.js" }], matcher: ".*" },
        ],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "/usr/bin/mine" }] }],
      },
    })
  );
  fs.writeFileSync(
    codexHooks,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "SUPERCOMPRESS_AGENT_NAME=Codex /home/u/.cursor/hooks/supercompress/user-prompt-submit.js" }] },
        ],
      },
    })
  );

  run(home, "uninstall");

  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.strictEqual(
    after.hooks && after.hooks.PostToolUse,
    undefined,
    "Windows-path SuperCompress hook must be removed from settings.json"
  );
  assert.ok(after.hooks && after.hooks.UserPromptSubmit, "the user's own hook must survive");
  assert.strictEqual(after.model, "opus", "unrelated settings must survive");
  assert.ok(!fs.existsSync(codexHooks), "a Codex hooks.json holding only our entries must be removed");
  fs.rmSync(home, { recursive: true, force: true });
  console.log("✔ Claude/Codex hook registrations are removed, Windows paths included");
  passed++;
}

console.log(`\nuninstall-clean: ${passed} checks passed`);
