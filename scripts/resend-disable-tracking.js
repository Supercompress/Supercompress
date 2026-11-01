#!/usr/bin/env node
/**
 * Turn OFF open + click tracking on the Resend sending domain.
 * Tracking pixels and rewritten (redirect) links are strong Gmail Promotions
 * signals; Resend controls them per domain, not per email.
 *
 *   RESEND_API_KEY=... node scripts/resend-disable-tracking.js [domain]
 *   (default domain: supercompress.dev; add --dry-run to only print status)
 */
const domainName = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) || "supercompress.dev";
const dry = process.argv.includes("--dry-run");
const key = (process.env.RESEND_API_KEY || "").trim();
if (!key) {
  console.error("RESEND_API_KEY not set");
  process.exit(1);
}
const api = (p, init = {}) =>
  fetch(`https://api.resend.com${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) }));

(async () => {
  const list = await api("/domains");
  if (!list.ok) throw new Error(`list domains: HTTP ${list.status}`);
  const d = (list.body.data || []).find((x) => x.name === domainName);
  if (!d) throw new Error(`domain ${domainName} not found in Resend`);
  const cur = await api(`/domains/${d.id}`);
  console.log(`${domainName}: open_tracking=${cur.body.open_tracking} click_tracking=${cur.body.click_tracking}`);
  if (dry) return;
  const upd = await api(`/domains/${d.id}`, {
    method: "PATCH",
    body: JSON.stringify({ open_tracking: false, click_tracking: false }),
  });
  if (!upd.ok) throw new Error(`update: HTTP ${upd.status} ${JSON.stringify(upd.body)}`);
  console.log("open_tracking=false click_tracking=false set");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
