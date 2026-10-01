#!/usr/bin/env node
/**
 * Validate that byCampaign[campaignId] exists and is a complete tip.
 * Usage: SUPERCOMPRESS_EMAIL_CONTENT_DIR=... node scripts/validate_weekly_tip.js [campaignId]
 * Exit 0 if valid, 1 otherwise.
 */
const fs = require("fs");
const path = require("path");
const { isoWeekCampaignId } = require("./weekly_tip_campaign_id");

const REQUIRED = [
  "id",
  "subject",
  "tipTitle",
  "tipBody",
  "proof",
  "ctaLabel",
  "ctaUrl",
];

const contentDir = (process.env.SUPERCOMPRESS_EMAIL_CONTENT_DIR || "").trim();
if (!contentDir) {
  console.error(
    "FAIL: set SUPERCOMPRESS_EMAIL_CONTENT_DIR to the directory containing weekly-tips.json"
  );
  process.exit(1);
}

const tipsPath = path.join(contentDir, "weekly-tips.json");
if (!fs.existsSync(tipsPath)) {
  console.error(`FAIL: weekly-tips.json not found under ${contentDir}`);
  process.exit(1);
}
const campaignId = (process.argv[2] || isoWeekCampaignId()).trim();

let data;
try {
  data = JSON.parse(fs.readFileSync(tipsPath, "utf8"));
} catch (e) {
  console.error("FAIL: cannot read weekly-tips.json:", e.message);
  process.exit(1);
}

const tip = data?.byCampaign?.[campaignId];
if (!tip) {
  console.error(`FAIL: no byCampaign tip for ${campaignId}`);
  process.exit(1);
}

const missing = REQUIRED.filter((k) => !String(tip[k] || "").trim());
if (missing.length) {
  console.error(`FAIL: ${campaignId} missing fields: ${missing.join(", ")}`);
  process.exit(1);
}

// Uniqueness vs seed + other campaigns
const subjects = new Set();
for (const s of data.seed || []) {
  if (s?.subject) subjects.add(String(s.subject).trim().toLowerCase());
}
for (const [cid, t] of Object.entries(data.byCampaign || {})) {
  if (cid === campaignId) continue;
  if (t?.subject) subjects.add(String(t.subject).trim().toLowerCase());
}
const subj = String(tip.subject).trim().toLowerCase();
if (subjects.has(subj)) {
  console.error(`FAIL: subject already used: ${tip.subject}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      campaign_id: campaignId,
      tip_id: tip.id,
      subject: tip.subject,
    },
    null,
    2
  )
);
