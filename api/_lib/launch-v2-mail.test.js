const assert = require("node:assert/strict");
const test = require("node:test");
const { launchV2Copy, weeklyEmailCopy, campaignKind } = require("./mail");

test("v2 launch email points at the tool", () => {
  const copy = launchV2Copy({ firstName: "Ada" });
  assert.equal(copy.subject, "SuperCompress v2 is live");
  assert.match(copy.text, /64\.1%/);
  assert.match(copy.text, /24\/24/);
  assert.match(copy.text, /16,647 tokens → 5,148/);
  assert.match(copy.text, /coding-agent dumps/);
  assert.match(copy.text, /Launch promo: 5M tokens\/month free, then \$0\.10 per million/);
  assert.match(copy.html, /dashboard\?signup=1/);
  assert.match(copy.html, /coding-agents/);
  assert.match(copy.html, /\/playground/);
  assert.doesNotMatch(copy.html, /\/arena/);
  assert.doesNotMatch(copy.text, /\/arena/);
  assert.doesNotMatch(copy.text, /\$0\.30/);
});

test("weeklyEmailCopy routes launch-v2 campaign to launchV2Copy", () => {
  assert.equal(campaignKind("launch-v2-2026-09-29"), "launch");
  const copy = weeklyEmailCopy({
    firstName: "Ada",
    campaignId: "launch-v2-2026-09-29",
    unsubUrl: "https://www.supercompress.dev/unsubscribe",
  });
  assert.equal(copy.tip_id, "launch-v2-2026-09-29");
  assert.equal(copy.subject, "SuperCompress v2 is live");
  assert.match(copy.text, /\$0\.10 per million/);
});
