const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const navigation = import(`data:text/javascript;base64,${fs.readFileSync(path.join(__dirname, "dashboard-navigation.js")).toString("base64")}`);

test("billing deep links survive login and onboarding", async () => {
  const { dashboardPanel, dashboardDestination } = await navigation;
  const link = new URL("https://www.supercompress.dev/dashboard#billing");
  assert.equal(dashboardPanel(link), "billing");
  const login = new URL(dashboardDestination(link, true), link);
  assert.equal(login.searchParams.get("login"), "1");
  const onboard = new URL(`/onboard?panel=${dashboardPanel(login)}`, link);
  assert.equal(dashboardDestination(onboard), "/dashboard?panel=billing");
});

test("panel names are allowlisted and query panel takes precedence", async () => {
  const { dashboardPanel, dashboardDestination } = await navigation;
  assert.equal(dashboardPanel(new URL("https://example.com/dashboard?panel=analytics#billing")), "analytics");
  assert.equal(dashboardPanel(new URL("https://example.com/dashboard?panel=invalid#billing")), "billing");
  assert.equal(dashboardDestination(new URL("https://example.com/onboard?panel=https://evil.example")), "/dashboard");
  assert.equal(dashboardPanel({ search: "?panel=%22%5D", hash: "#unknown" }), "");
});

test("switching tabs clears stale hashes, and hash changes override stale query panels", async () => {
  const { dashboardPanel, dashboardPanelUrl } = await navigation;
  const keys = dashboardPanelUrl("https://example.com/dashboard#billing", "keys");
  assert.equal(keys, "/dashboard");
  assert.equal(dashboardPanel(new URL(keys, "https://example.com")), "");
  const changed = new URL("https://example.com/dashboard?panel=analytics#billing");
  const panel = dashboardPanel({ search: "", hash: changed.hash });
  assert.equal(panel, "billing");
  assert.equal(dashboardPanelUrl(changed.href, panel), "/dashboard?panel=billing");
});
