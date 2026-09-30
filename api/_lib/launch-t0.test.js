const assert = require("node:assert/strict");
const test = require("node:test");
const { runLaunchT0, LAUNCH_V2_CAMPAIGN_ID } = require("./weekly");

test("runLaunchT0 skips outside the Sep 29 PT launch window", async () => {
  const result = await runLaunchT0({ force: false });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "outside_launch_window");
  assert.equal(result.campaign_id, LAUNCH_V2_CAMPAIGN_ID);
});
