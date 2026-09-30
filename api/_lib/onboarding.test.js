/**
 * Onboarding + power celebrate unit tests.
 * Run: node --test api/_lib/onboarding.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ONBOARD_ACTION_TOKENS,
  onboardBonusTokens,
  needsOnboarding,
  needsPowerCelebrate,
  statusPayload,
  powerShareIntentUrl,
} = require("./onboarding");

describe("onboarding bonuses", () => {
  it("caps bonus at 30,000", () => {
    assert.equal(onboardBonusTokens({ sc_onboard_bonus: 50_000 }), 30_000);
    assert.equal(onboardBonusTokens({ sc_onboard_bonus: 10_000 }), 10_000);
    assert.equal(onboardBonusTokens({}), 0);
  });

  it("action token grant is 10,000", () => {
    assert.equal(ONBOARD_ACTION_TOKENS, 10_000);
  });
});

describe("needsOnboarding", () => {
  it("skips when done or skipped", () => {
    const young = { metadata: { creationTime: new Date().toISOString() } };
    assert.equal(needsOnboarding({ sc_onboard_done: true }, young), false);
    assert.equal(needsOnboarding({ sc_onboard_skipped: true }, young), false);
  });

  it("only for young accounts (14d); unfinished without owner still needs it", () => {
    const young = { metadata: { creationTime: new Date().toISOString() } };
    const old = {
      metadata: { creationTime: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() },
    };
    assert.equal(needsOnboarding({}, young), true);
    assert.equal(needsOnboarding({}, old), false);
    assert.equal(needsOnboarding({}, null), true);
    assert.equal(needsOnboarding({}, { metadata: {} }), true);
  });
});

describe("power celebrate", () => {
  it("pending flag triggers celebrate", () => {
    assert.equal(needsPowerCelebrate({ sc_power_celebrate: "pending" }), true);
    assert.equal(needsPowerCelebrate({ sc_power_celebrate: "shown" }), false);
    assert.equal(needsPowerCelebrate({}), false);
  });

  it("share intent includes site link", () => {
    const url = powerShareIntentUrl({ tokensIn: 1_200_000, tokensSaved: 600_000, cutPct: 50 });
    assert.ok(url.startsWith("https://twitter.com/intent/tweet?text="));
    const text = decodeURIComponent(url.split("text=")[1]);
    assert.match(text, /supercompress\.dev/i);
    assert.match(text, /power user/i);
  });
});

describe("statusPayload", () => {
  it("exposes quest links and plugin commands", () => {
    const young = { metadata: { creationTime: new Date().toISOString() } };
    const p = statusPayload({}, young);
    assert.equal(p.needs_onboarding, true);
    assert.equal(p.action_tokens, 10_000);
    assert.ok(p.links.star.includes("github.com"));
    assert.ok(p.links.x_follow.includes("x.com"));
    assert.ok(Array.isArray(p.plugin_commands) && p.plugin_commands.length >= 1);
  });

  it("parseActions only keeps known keys", () => {
    const p = statusPayload({
      sc_onboard_actions: { star: true, junk: true },
      sc_onboard_bonus: 10_000,
    });
    assert.deepEqual(p.actions, { star: true });
    assert.equal(p.bonus_tokens, 10_000);
    assert.deepEqual(p.completed_actions, ["star"]);
  });
});

describe("heard sources", () => {
  const { normalizeHeard, HEARD_SOURCES } = require("./onboarding");
  it("normalizes aliases", () => {
    assert.equal(normalizeHeard("twitter"), "x");
    assert.equal(normalizeHeard("friend"), "word_of_mouth");
    assert.equal(normalizeHeard("linkedin"), "linkedin");
    assert.equal(normalizeHeard("spam"), null);
  });
  it("has the onboarding choices", () => {
    for (const id of ["x", "reddit", "linkedin", "instagram", "word_of_mouth"]) {
      assert.ok(HEARD_SOURCES.includes(id));
    }
  });
});
