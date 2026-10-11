#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

function readJson(relPath) {
  const fullPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (err) {
    console.error(`❌ Failed to parse JSON at ${relPath}: ${err.message}`);
    return null;
  }
}

let hasErrors = false;
const remediationHints = [];

function recordError(msg, hint) {
  console.error(`❌ ${msg}`);
  hasErrors = true;
  if (hint) {
    remediationHints.push({ error: msg, hint });
  }
}

// 1. Read packages/proxy/package.json
const proxyPkg = readJson('packages/proxy/package.json');
if (!proxyPkg || !proxyPkg.version) {
  console.error('❌ Missing or unparseable packages/proxy/package.json');
  console.error('🔧 Fix hint: Ensure packages/proxy/package.json exists with a valid "version" field.');
  process.exit(1);
}

const proxyVersion = proxyPkg.version;
console.log(`📦 packages/proxy/package.json version: ${proxyVersion}`);

const wrapperPkg = readJson('packages/supercompress-ai/package.json');
if (!wrapperPkg || wrapperPkg.name !== 'supercompress-ai') {
  recordError(
    'Missing packages/supercompress-ai/package.json (needed for `npx -y supercompress-ai setup`)',
    'Add packages/supercompress-ai with name "supercompress-ai" and a matching bin.'
  );
} else if (wrapperPkg.version !== proxyVersion) {
  recordError(
    `Mismatch: packages/supercompress-ai version (${wrapperPkg.version}) does not match proxy (${proxyVersion})`,
    `Set packages/supercompress-ai/package.json version to ${proxyVersion}.`
  );
} else {
  console.log(`✅ packages/supercompress-ai version matches (${wrapperPkg.version})`);
}

if (wrapperPkg) {
  const requiredBins = ['supercompress-ai', 'supercompress'];
  for (const bin of requiredBins) {
    if (!wrapperPkg.bin || !wrapperPkg.bin[bin]) {
      recordError(
        `packages/supercompress-ai missing bin "${bin}" required by documented npx commands`,
        `Add "${bin}" to packages/supercompress-ai/package.json "bin".`
      );
    } else {
      console.log(`✅ packages/supercompress-ai bin "${bin}" present`);
    }
  }
}

if (proxyPkg.bin) {
  for (const bin of ['supercompress', 'supercompress-ai', 'supercompress-proxy', 'supercompress-mcp']) {
    if (!proxyPkg.bin[bin]) {
      recordError(
        `packages/proxy missing bin "${bin}"`,
        `Add "${bin}" to packages/proxy/package.json "bin" so documented npx/CLI commands resolve.`
      );
    } else {
      console.log(`✅ packages/proxy bin "${bin}" present`);
    }
  }
}

// 2. Check packages/proxy/package-lock.json (Fail closed if missing)
const proxyLock = readJson('packages/proxy/package-lock.json');
if (!proxyLock) {
  recordError('Missing or unparseable packages/proxy/package-lock.json', 'Run `npm --prefix packages/proxy install --package-lock-only` to generate lockfile.');
} else if (proxyLock.version !== proxyVersion) {
  recordError(
    `Mismatch: packages/proxy/package-lock.json version (${proxyLock.version}) does not match package.json (${proxyVersion})`,
    `Run \`npm --prefix packages/proxy version ${proxyVersion} --no-git-tag-version\` or \`npm --prefix packages/proxy install --package-lock-only\` to sync lockfile.`
  );
} else {
  console.log(`✅ packages/proxy/package-lock.json version matches (${proxyLock.version})`);
}

// 3. Check root package.json dependency on supercompress-proxy (Fail closed if missing)
const rootPkg = readJson('package.json');
if (!rootPkg || !rootPkg.dependencies || !rootPkg.dependencies['supercompress-proxy']) {
  recordError('Missing root package.json or missing supercompress-proxy dependency in root package.json', 'Add `"supercompress-proxy": "^' + proxyVersion + '"` to root package.json dependencies.');
} else {
  const rootDepRange = rootPkg.dependencies['supercompress-proxy'];
  console.log(`📌 Root package.json supercompress-proxy dependency: ${rootDepRange}`);

  const proxyMajorMinor = proxyVersion.split('.').slice(0, 2).join('.');
  const match = rootDepRange.match(/(\d+\.\d+)/);
  
  if (!match) {
    recordError(`Root package.json supercompress-proxy dependency range '${rootDepRange}' is not parseable`, 'Update root package.json supercompress-proxy dependency to `"^' + proxyVersion + '"`.');
  } else {
    const rootDepMajorMinor = match[1];
    if (rootDepMajorMinor !== proxyMajorMinor) {
      recordError(
        `Mismatch: Root package.json pins supercompress-proxy to '${rootDepRange}' (major.minor ${rootDepMajorMinor}) but packages/proxy is at '${proxyVersion}' (major.minor ${proxyMajorMinor})`,
        `Update root package.json: set "supercompress-proxy": "^${proxyVersion}" then run \`npm install --package-lock-only\`.`
      );
    } else {
      console.log(`✅ Root package.json dependency range matches proxy major.minor (${proxyMajorMinor})`);
    }
  }
}

// 4. Check root package-lock.json (Fail closed if missing or mismatched resolved URL)
const rootLock = readJson('package-lock.json');
if (!rootLock) {
  recordError('Missing or unparseable root package-lock.json', 'Run `npm install --package-lock-only` to generate root package-lock.json.');
} else if (!rootLock.packages || !rootLock.packages['node_modules/supercompress-proxy']) {
  recordError('Missing node_modules/supercompress-proxy entry in root package-lock.json', 'Run `npm install --package-lock-only` to sync root dependencies.');
} else {
  const lockedDep = rootLock.packages['node_modules/supercompress-proxy'];
  const lockedVersion = lockedDep.version || '';
  const lockedMajorMinor = lockedVersion.split('.').slice(0, 2).join('.');
  const proxyMajorMinor = proxyVersion.split('.').slice(0, 2).join('.');
  if (!lockedVersion) {
    recordError(
      'Missing version on node_modules/supercompress-proxy in root package-lock.json',
      'Run `npm install --package-lock-only` to sync root dependencies.'
    );
  } else if (lockedMajorMinor !== proxyMajorMinor) {
    recordError(
      `Mismatch: Root package-lock.json has supercompress-proxy locked to ${lockedVersion} (major.minor ${lockedMajorMinor}) but packages/proxy is ${proxyVersion}`,
      `Update root package.json to "^${proxyVersion}" then run \`npm install --package-lock-only\` after that version is on npm.`
    );
  } else if (lockedVersion !== proxyVersion) {
    // Local proxy may be one unpublished patch ahead of the last npm tarball.
    console.log(`✅ Root package-lock.json supercompress-proxy ${lockedVersion} matches major.minor of local ${proxyVersion} (pre-publish ok)`);
  } else {
    console.log(`✅ Root package-lock.json has supercompress-proxy locked to version ${proxyVersion}`);
  }

  // Verify resolved tarball URL exists; exact patch may trail an unpublished local bump.
  if (!lockedDep.resolved) {
    recordError('Missing resolved artifact URL for supercompress-proxy in root package-lock.json', 'Run `npm install --package-lock-only` to populate resolved URLs.');
  } else if (lockedVersion && !lockedDep.resolved.includes(`-${lockedVersion}.tgz`)) {
    recordError(
      `Mismatch: Root package-lock.json supercompress-proxy resolved URL (${lockedDep.resolved}) does not match locked version ${lockedVersion}`,
      `Run \`npm install supercompress-proxy@${lockedVersion} --package-lock-only\` to update resolved artifact URL.`
    );
  } else {
    console.log(`✅ Root package-lock.json supercompress-proxy resolved artifact matches locked ${lockedVersion}`);
  }

  if (!lockedDep.integrity) {
    recordError('Missing integrity digest for supercompress-proxy in root package-lock.json', 'Run `npm install --package-lock-only` to refresh integrity checksums.');
  } else {
    console.log('✅ Root package-lock.json supercompress-proxy integrity present');
  }
}

// 5. Public site / docs pins must match proxy version (OSS-facing surfaces)
const publicPins = [
  { file: 'web/docs/coding-agents.html', needle: `v${proxyVersion}`, label: 'version kicker' },
  { file: 'web/docs/coding-agents.html', needle: `# → ${proxyVersion}`, label: 'CLI version output' },
  // web/index.html is locked (do not edit homepage). Schema pin may trail the package version.
  { file: 'web/ai-search.json', needle: `supercompress-proxy@${proxyVersion}`, label: 'ai-search dependency pin' },
  { file: 'web/llms.txt', needle: `supercompress-proxy@${proxyVersion}`, label: 'llms.txt install pin' },
];

for (const { file, needle, label } of publicPins) {
  const fullPath = path.join(repoRoot, file);
  if (!fs.existsSync(fullPath)) {
    recordError(`Missing public pin file: ${file}`, `Ensure file ${file} exists in repo.`);
    continue;
  }
  const text = fs.readFileSync(fullPath, 'utf8');
  if (!text.includes(needle)) {
    recordError(
      `Mismatch: ${file} missing ${label || 'pin'} '${needle}' (expected proxy ${proxyVersion})`,
      `Update ${file} to reference version '${proxyVersion}'.`
    );
  } else {
    console.log(`✅ ${file} pin matches '${needle}'`);
  }
}

if (hasErrors) {
  console.error('\n❌ Version consistency check failed!');
  if (remediationHints.length > 0) {
    console.error('\n🔧 Suggested Remediation:');
    remediationHints.forEach(({ error, hint }, i) => {
      console.error(`  ${i + 1}. [${error}]`);
      console.error(`     👉 Fix: ${hint}`);
    });
  }
  process.exit(1);
} else {
  console.log('\n🎉 All version consistency checks passed successfully!');
}
