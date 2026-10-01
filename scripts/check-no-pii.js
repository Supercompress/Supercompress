#!/usr/bin/env node
/**
 * Fail CI if unexpected emails or private email-ops paths appear in tracked files.
 *
 * This is a *repo hygiene* gate for outreach dumps / private ops paths — not a
 * full secret scanner. Pair with gitleaks + CodeQL in CI for credentials.
 *
 * Allowed product addresses: @supercompress.dev and documented placeholders.
 */
const { execSync } = require("child_process");

const ALLOW = [
  /@[a-z0-9.-]*supercompress\.dev$/i, // product / support / security aliases
  /you@company\.com/i,
  /user@example\.com/i,
  /example\.com/i,
  /@[a-z0-9-]+\.example\./i, // RFC 2606-style test hosts
  /\b[a-z0-9._%+-]+@x\.com\b/i, // tiny unit-test placeholders
  /\b[a-z0-9._%+-]+@y\.com\b/i,
  /\ba@b\.com\b/i, // unit-test placeholder
  /noreply@/i,
  /no-reply@/i,
  /jack@greensock\.com/i, // vendored gsap license header
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const listed = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter(
    (f) =>
      !f.includes("node_modules/") &&
      !f.endsWith("package-lock.json") &&
      !f.includes("tokenizer.json") &&
      !f.startsWith("models/")
  );

const hits = [];
for (const file of listed) {
  let text;
  try {
    text = require("fs").readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const emails = text.match(EMAIL_RE) || [];
  for (const email of emails) {
    if (ALLOW.some((re) => re.test(email))) continue;
    // Skip obvious non-human / docs domains
    if (/@(supercompress\.dev|vercel\.app|github\.com|npmjs\.com|w3\.org|schema\.org|googleapis\.com|gstatic\.com|sentry\.io|stripe\.com)$/i.test(email)) {
      continue;
    }
    hits.push(`${file}: ${email}`);
  }
}

// Private ops paths must never be tracked
const bannedPaths = [
  "scripts/drain_welcome_emails.py",
  "scripts/drain_weekly_emails.py",
  "scripts/dev.supercompress.welcome-drain.plist",
  "scripts/outreach_suppression.py",
  "api/_lib/weekly-tips.json",
  "api/_lib/weekly-ship.json",
];
for (const p of bannedPaths) {
  if (listed.includes(p)) hits.push(`tracked private ops path: ${p}`);
}

if (hits.length) {
  console.error(
    "❌ Private-ops / unexpected-email check failed (not a full secret scan — see gitleaks):\n" +
      hits.slice(0, 50).join("\n")
  );
  process.exit(1);
}
console.log("✅ No unexpected emails or private email-ops paths in tracked files");
