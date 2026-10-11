#!/usr/bin/env node
/**
 * Documented install commands must resolve to a real bin on the matching package.
 * `npx -y <pkg> setup` requires package.json name === bin name.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

const proxy = readJson("packages/proxy/package.json");
const wrapper = readJson("packages/supercompress-ai/package.json");

assert.strictEqual(proxy.name, "supercompress-proxy");
assert.strictEqual(wrapper.name, "supercompress-ai");
assert.strictEqual(wrapper.version, proxy.version, "supercompress-ai version must match supercompress-proxy");

const documented = [
  {
    command: "npx -y supercompress-ai setup",
    pkg: wrapper,
    bin: "supercompress-ai",
    file: "packages/supercompress-ai/package.json",
  },
  {
    command: "npx -y -p supercompress-ai supercompress setup",
    pkg: wrapper,
    bin: "supercompress",
    file: "packages/supercompress-ai/package.json",
  },
  {
    command: "npx -y supercompress-proxy setup",
    pkg: proxy,
    bin: "supercompress-proxy",
    file: "packages/proxy/package.json",
  },
  {
    command: "supercompress setup",
    pkg: proxy,
    bin: "supercompress",
    file: "packages/proxy/package.json",
  },
];

for (const { command, pkg, bin, file } of documented) {
  assert.ok(pkg.bin && pkg.bin[bin], `${file} missing bin "${bin}" required by documented command: ${command}`);
  const rel = pkg.bin[bin];
  const abs = path.join(ROOT, path.dirname(file), rel);
  assert.ok(fs.existsSync(abs), `${file} bin "${bin}" points at missing file ${rel}`);
}

// Homepage / docs one-liner (do not edit web/index.html in this check).
const docsNeedles = [
  { file: "packages/supercompress-ai/README.md", needle: "npx -y supercompress-ai setup" },
  { file: "packages/proxy/README.md", needle: "supercompress setup" },
];
for (const { file, needle } of docsNeedles) {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  assert.ok(text.includes(needle), `${file} should document: ${needle}`);
}

console.log("check-bins.test.js: ok");
