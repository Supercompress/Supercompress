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

console.log('🔍 Checking version consistency across SuperCompress packages...');

let hasErrors = false;

// 1. Read packages/proxy/package.json
const proxyPkg = readJson('packages/proxy/package.json');
if (!proxyPkg || !proxyPkg.version) {
  console.error('❌ Missing or unparseable packages/proxy/package.json');
  process.exit(1);
}

const proxyVersion = proxyPkg.version;
console.log(`📦 packages/proxy/package.json version: ${proxyVersion}`);

// 2. Check packages/proxy/package-lock.json (Fail closed if missing)
const proxyLock = readJson('packages/proxy/package-lock.json');
if (!proxyLock) {
  console.error('❌ Missing or unparseable packages/proxy/package-lock.json');
  hasErrors = true;
} else if (proxyLock.version !== proxyVersion) {
  console.error(`❌ Mismatch: packages/proxy/package-lock.json version (${proxyLock.version}) does not match package.json (${proxyVersion})`);
  hasErrors = true;
} else {
  console.log(`✅ packages/proxy/package-lock.json version matches (${proxyLock.version})`);
}

// 3. Check root package.json dependency on supercompress-proxy (Fail closed if missing)
const rootPkg = readJson('package.json');
if (!rootPkg || !rootPkg.dependencies || !rootPkg.dependencies['supercompress-proxy']) {
  console.error('❌ Missing root package.json or missing supercompress-proxy dependency in root package.json');
  hasErrors = true;
} else {
  const rootDepRange = rootPkg.dependencies['supercompress-proxy'];
  console.log(`📌 Root package.json supercompress-proxy dependency: ${rootDepRange}`);

  const proxyMajorMinor = proxyVersion.split('.').slice(0, 2).join('.');
  const match = rootDepRange.match(/(\d+\.\d+)/);
  
  if (!match) {
    console.error(`❌ Root package.json supercompress-proxy dependency range '${rootDepRange}' is not parseable`);
    hasErrors = true;
  } else {
    const rootDepMajorMinor = match[1];
    if (rootDepMajorMinor !== proxyMajorMinor) {
      console.error(`❌ Mismatch: Root package.json pins supercompress-proxy to '${rootDepRange}' (major.minor ${rootDepMajorMinor}) but packages/proxy is at '${proxyVersion}' (major.minor ${proxyMajorMinor})`);
      hasErrors = true;
    } else {
      console.log(`✅ Root package.json dependency range matches proxy major.minor (${proxyMajorMinor})`);
    }
  }
}

// 4. Check root package-lock.json (Fail closed if missing or mismatched resolved URL)
const rootLock = readJson('package-lock.json');
if (!rootLock) {
  console.error('❌ Missing or unparseable root package-lock.json');
  hasErrors = true;
} else if (!rootLock.packages || !rootLock.packages['node_modules/supercompress-proxy']) {
  console.error('❌ Missing node_modules/supercompress-proxy entry in root package-lock.json');
  hasErrors = true;
} else {
  const lockedDep = rootLock.packages['node_modules/supercompress-proxy'];
  if (!lockedDep.version || lockedDep.version !== proxyVersion) {
    console.error(`❌ Mismatch: Root package-lock.json has supercompress-proxy locked to version ${lockedDep.version || 'unknown'}, expected ${proxyVersion}`);
    hasErrors = true;
  } else {
    console.log(`✅ Root package-lock.json has supercompress-proxy locked to version ${proxyVersion}`);
  }

  // Verify resolved tarball URL matches current version
  if (!lockedDep.resolved) {
    console.error('❌ Missing resolved artifact URL for supercompress-proxy in root package-lock.json');
    hasErrors = true;
  } else if (!lockedDep.resolved.includes(`-${proxyVersion}.tgz`)) {
    console.error(`❌ Mismatch: Root package-lock.json supercompress-proxy resolved URL (${lockedDep.resolved}) does not match current version ${proxyVersion}`);
    hasErrors = true;
  } else {
    console.log(`✅ Root package-lock.json supercompress-proxy resolved artifact matches ${proxyVersion}`);
  }

  if (!lockedDep.integrity) {
    console.error('❌ Missing integrity digest for supercompress-proxy in root package-lock.json');
    hasErrors = true;
  } else {
    console.log('✅ Root package-lock.json supercompress-proxy integrity present');
  }
}

// 5. Public site / docs pins must match proxy version (OSS-facing surfaces)
const publicPins = [
  { file: 'web/docs/coding-agents.html', needle: `v${proxyVersion}` },
  { file: 'web/docs/coding-agents.html', needle: `# → ${proxyVersion}` },
  { file: 'web/index.html', needle: `"softwareVersion": "${proxyVersion}"` },
  { file: 'web/ai-search.json', needle: `supercompress-proxy@${proxyVersion}` },
  { file: 'web/llms.txt', needle: `supercompress-proxy@${proxyVersion}` },
];

for (const { file, needle } of publicPins) {
  const fullPath = path.join(repoRoot, file);
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ Missing public pin file: ${file}`);
    hasErrors = true;
    continue;
  }
  const text = fs.readFileSync(fullPath, 'utf8');
  if (!text.includes(needle)) {
    console.error(`❌ Mismatch: ${file} missing pin '${needle}' (expected proxy ${proxyVersion})`);
    hasErrors = true;
  } else {
    console.log(`✅ ${file} pin matches '${needle}'`);
  }
}

if (hasErrors) {
  console.error('\n❌ Version consistency check failed!');
  process.exit(1);
} else {
  console.log('\n🎉 All version consistency checks passed successfully!');
}
