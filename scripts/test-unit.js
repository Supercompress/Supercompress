#!/usr/bin/env node
/**
 * Fast local test runner for SuperCompress unit tests and repository guards.
 * Run via: npm test  or  node scripts/test-unit.js
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const testSuites = [
  // Core API & Ledger tests
  { name: 'billing-ledger', file: 'api/_lib/billing-ledger.test.js' },
  { name: 'credit-amount', file: 'api/_lib/credit-amount.test.js' },
  { name: 'coding-agent-usage', file: 'api/_lib/coding-agent-usage.test.js' },
  { name: 'compress-quality', file: 'api/_lib/compress-quality.test.js' },
  { name: 'http-soft-probe', file: 'api/_lib/http-soft-probe.test.js' },
  { name: 'firebase-off', file: 'api/_lib/firebase-off.test.js' },
  { name: 'power-user', file: 'api/_lib/power-user.test.js' },
  { name: 'retention', file: 'api/_lib/retention.test.js' },
  { name: 'payment-thank-you', file: 'api/_lib/payment-thank-you.test.js' },
  { name: 'auth-connect', file: 'api/_lib/auth-connect.test.js' },
  { name: 'founder-usage', file: 'api/_lib/founder-usage.test.js' },
  { name: 'usage-days', file: 'api/_lib/usage-days.test.js' },
  { name: 'stats', file: 'api/stats.test.js' },

  // Node built-in test runner suites
  { name: 'onboarding', file: 'api/_lib/onboarding.test.js', args: ['--test'] },
  { name: 'password-reset', file: 'api/_lib/password-reset.test.js', args: ['--test'] },

  // Web & Analytics tests
  { name: 'analytics-data', file: 'web/assets/js/analytics-data.test.js' },

  // Repository integrity & guards
  { name: 'check-no-pii', file: 'scripts/check-no-pii.js' },
  { name: 'check-versions', file: 'scripts/check-versions.js' },
  { name: 'check-stylesheet-paths (test)', file: 'scripts/check-stylesheet-paths.test.js' },
  { name: 'check-stylesheet-paths (guard)', file: 'scripts/check-stylesheet-paths.js' },
  { name: 'check-api-host-routes (test)', file: 'scripts/check-api-host-routes.test.js' },
  { name: 'check-api-host-routes (guard)', file: 'scripts/check-api-host-routes.js' },
];

console.log('\n🧪 Running SuperCompress Unit Tests & Repository Guards...\n');

let passed = 0;
let failed = 0;
const failedSuites = [];

for (const suite of testSuites) {
  const fullPath = path.join(ROOT, suite.file);
  const args = [...(suite.args || []), fullPath];

  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  });

  if (res.status === 0) {
    passed++;
    console.log(`  ✅ PASS  ${suite.name}`);
  } else {
    failed++;
    failedSuites.push(suite.name);
    console.error(`  ❌ FAIL  ${suite.name} (exit ${res.status})`);
    if (res.stdout) console.log(res.stdout.trim());
    if (res.stderr) console.error(res.stderr.trim());
  }
}

console.log('\n' + '─'.repeat(50));
console.log(`Total: ${testSuites.length} | Passed: ${passed} | Failed: ${failed}`);
console.log('─'.repeat(50));

if (failed > 0) {
  console.error(`\n❌ Failed suites: ${failedSuites.join(', ')}`);
  process.exit(1);
} else {
  console.log('\n✨ All unit tests and guards passed!\n');
  process.exit(0);
}
