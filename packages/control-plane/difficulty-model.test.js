"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { difficultyScore, modelVersion } = require("./difficulty-model");
const { classifyRequest } = require("./request-classifier");

const ask = (content) => classifyRequest({ messages: [{ role: "user", content }] });

describe("learned difficulty model", () => {
  it("ships trained weights and scores in [0, 1], deterministically", () => {
    assert.match(modelVersion(), /^rb-dev-/);
    const text = "Which of the following best describes the role of the Federal Reserve? A. ... B. ...";
    const a = difficultyScore(text);
    assert.ok(a > 0 && a < 1);
    assert.equal(difficultyScore(text), a);
  });

  it("returns 0.5 for empty or non-string input", () => {
    assert.equal(difficultyScore(""), 0.5);
    assert.equal(difficultyScore(null), 0.5);
  });

  it("stays fast on a 120k-character prompt", () => {
    const started = Date.now();
    difficultyScore("lorem ipsum dolor sit amet ".repeat(5000));
    difficultyScore("a.".repeat(60000));
    assert.ok(Date.now() - started < 1000);
  });
});

describe("classifier with learned difficulty", () => {
  it("grades unrecognised asks with the learned model and reports its score", () => {
    const result = ask("Who won the world cup in 2018 and how many goals were scored in the final?");
    assert.equal(typeof result.difficulty_score, "number");
    assert.ok(result.reasons.some((r) => r.startsWith("learned_difficulty_")));
  });

  it("never sends a short ask to the reasoning tier", () => {
    for (const text of ["Tell me about the weather today", "Write a haiku about cats", "Solve for x: 3x + 7 = 22"]) {
      assert.ok(ask(text).tier <= 2, text);
    }
  });

  it("leaves greetings, recognised coding tasks and context-only requests to the rules", () => {
    assert.equal(ask("hi").tier, 0);
    assert.equal(ask("hi").difficulty_score, null);
    assert.equal(ask("Rename the old helpers").difficulty_score, null);
    assert.equal(ask("Find why auth only fails on CI").tier, 3);
    assert.equal(classifyRequest({ context: "```js\nconst answer = 42;\n```" }).difficulty_score, null);
  });
});
