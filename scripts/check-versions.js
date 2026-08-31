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
  if (!lockedDep.version || lockedDep.version !== proxyVersion) {
    recordError(
      `Mismatch: Root package-lock.json has supercompress-proxy locked to version ${lockedDep.version || 'unknown'}, expected ${proxyVersion}`,
      `Run \`npm install supercompress-proxy@${proxyVersion} --package-lock-only\` to sync root lockfile.`
    );
  } else {
    console.log(`✅ Root package-lock.json has supercompress-proxy locked to version ${proxyVersion}`);
  }

  // Verify resolved tarball URL matches current version
  if (!lockedDep.resolved) {
    recordError('Missing resolved artifact URL for supercompress-proxy in root package-lock.json', 'Run `npm install --package-lock-only` to populate resolved URLs.');
  } else if (!lockedDep.resolved.includes(`-${proxyVersion}.tgz`)) {
    recordError(
      `Mismatch: Root package-lock.json supercompress-proxy resolved URL (${lockedDep.resolved}) does not match current version ${proxyVersion}`,
      `Run \`npm install supercompress-proxy@${proxyVersion} --package-lock-only\` to update resolved artifact URL.`
    );
  } else {
    console.log(`✅ Root package-lock.json supercompress-proxy resolved artifact matches ${proxyVersion}`);
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
  { file: 'web/index.html', needle: `"softwareVersion": "${proxyVersion}"`, label: 'schema softwareVersion' },
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
