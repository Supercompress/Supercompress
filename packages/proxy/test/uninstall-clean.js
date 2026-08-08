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

console.log(`\nuninstall-clean: ${passed} checks passed`);
