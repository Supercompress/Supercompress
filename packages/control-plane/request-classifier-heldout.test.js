"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyRequest } = require("./request-classifier");
const heldout = require("../../scripts/bench_router_autorouter/heldout");

const TIER = { Easy: 1, Medium: 2, Hard: 3 };

// Odd indexes were never used to tune the classifier. Under-routing (hard work
// on a weaker tier) is the costly error, so it must stay at zero.
test("held-out coding prompts route to their labelled tier", () => {
  let exact = 0;
  let under = 0;
  const split = heldout.filter((_, index) => index % 2 === 1);
  for (const [ask, label] of split) {
    const tier = Math.max(1, classifyRequest({ ask }).tier);
    if (tier === TIER[label]) exact += 1;
    else if (tier < TIER[label]) under += 1;
  }
  assert.equal(under, 0);
  assert.ok(exact / split.length >= 0.9, `${exact}/${split.length}`);
});
