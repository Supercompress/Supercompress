const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'check-versions.js');
const fixtures = [];

afterEach(() => {
  while (fixtures.length) fs.rmSync(fixtures.pop(), { recursive: true, force: true });
});

function writeJson(root, relativePath, value) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(value));
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supercompress-version-check-'));
  fixtures.push(root);
  const version = '1.2.3';

  writeJson(root, 'packages/proxy/package.json', { version });
  writeJson(root, 'packages/proxy/package-lock.json', { version });
  writeJson(root, 'package.json', { dependencies: { 'supercompress-proxy': '^1.2.0' } });
  writeJson(root, 'package-lock.json', {
    packages: {
      'node_modules/supercompress-proxy': {
        version,
        resolved: `https://example.test/supercompress-proxy-${version}.tgz`,
        integrity: 'sha512-test',
      },
    },
  });
  fs.mkdirSync(path.join(root, 'web/docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web/docs/coding-agents.html'), `v${version}\n# → ${version}`);
  fs.writeFileSync(path.join(root, 'web/index.html'), `"softwareVersion": "${version}"`);
  fs.writeFileSync(path.join(root, 'web/ai-search.json'), `supercompress-proxy@${version}`);
  fs.writeFileSync(path.join(root, 'web/llms.txt'), `supercompress-proxy@${version}`);
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, SUPERCOMPRESS_REPO_ROOT: root },
  });
}

test('passes when all version surfaces agree', () => {
  const result = run(createFixture());
  assert.equal(result.status, 0, result.stderr);
});

test('reports affected fields and a remediation command for a mismatch', () => {
  const root = createFixture();
  writeJson(root, 'packages/proxy/package-lock.json', { version: '1.2.4' });

  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /packages\/proxy\/package-lock\.json/);
  assert.match(result.stderr, /version/);
  assert.match(result.stderr, /npm install/);
});
