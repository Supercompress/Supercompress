"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { classifyRequest, stripHarness } = require("./request-classifier");

const HARNESS_SYSTEM = "You are an interactive CLI tool that helps users with software engineering tasks. " +
  "Use the tools to debug, refactor, review architecture and explain code. ".repeat(400);
const TOOLS = ["Read", "Edit", "Bash"].map((name) => ({ type: "function", function: { name, parameters: {} } }));

function agentRequest(...turns) {
  return { tools: TOOLS, messages: [{ role: "system", content: HARNESS_SYSTEM }, ...turns] };
}

describe("deterministic request classifier", () => {
  it("grades tasks by what they ask, with explainable reasons", () => {
    for (const [ask, tier, complexity, reason] of [
      ["Hello", 0, "simple", "greeting"],
      ["Summarize this paragraph", 1, "medium", "task_summary"],
      ["Write the commit message", 1, "medium", "task_git"],
      ["Implement the export endpoint", 2, "complex", "task_implement"],
      ["Debug this distributed system", 3, "reasoning", "task_debug"],
      ["Prove the theorem", 3, "reasoning", "task_reasoning"],
    ]) {
      const result = classifyRequest({ ask });
      assert.equal(result.tier, tier, ask);
      assert.equal(result.complexity, complexity);
      assert.ok(result.reasons.includes(reason), `${ask}: ${result.reasons}`);
      assert.deepEqual(result.required_capabilities, ["chat"]);
    }
  });

  it("puts hard work on the top tier even without classic keywords", () => {
    for (const ask of ["Plan the move to the ledger", "Find why auth only fails on CI", "Review the diff",
      "Keep edits when offline", "Cover the rounding edge cases", "Refactor the billing module across six files"]) {
      assert.equal(classifyRequest({ ask }).tier, 3, ask);
    }
  });

  it("never treats unclear asks as quick work", () => {
    for (const ask of ["Clean this up a bit", "Make these better", "fix it"]) {
      const result = classifyRequest({ ask });
      assert.equal(result.tier, 2, ask);
      assert.ok(result.reasons.includes("unclear_ask"));
    }
  });

  it("keeps quick tasks quick when they mention generic verbs", () => {
    for (const ask of ["Fix the typos in the labels", "Update the README", "Rename the old helpers",
      "Draft the pull request", "Run the suite and sum up"]) {
      assert.equal(classifyRequest({ ask }).tier, 1, ask);
    }
  });

  it("ignores the harness system prompt, tool schemas and injected blocks", () => {
    const quick = classifyRequest(agentRequest({ role: "user", content:
      "<system-reminder>Debug carefully. Review the architecture.</system-reminder>Write the commit message" }));
    assert.equal(quick.tier, 1);
    assert.equal(quick.category, "git");
    assert.equal(quick.task_source, "latest_user_turn");
    assert.deepEqual(quick.required_capabilities, ["chat", "tools"]);

    const codex = classifyRequest(agentRequest(
      { role: "user", content: "<user_instructions>Always debug root causes.</user_instructions>" },
      { role: "user", content: "<environment_context><cwd>/repo</cwd></environment_context>" },
      { role: "user", content: "Update the README" },
    ));
    assert.equal(codex.tier, 1);
    assert.ok(!stripHarness("# AGENTS.md instructions for /repo\nDebug everything"));
  });

  it("grades the latest human turn, not tool output in the agent loop", () => {
    const result = classifyRequest(agentRequest(
      { role: "user", content: "Find why auth only fails on CI" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "Bash" } }] },
      { role: "tool", tool_call_id: "1", content: "Write the commit message" },
    ));
    assert.equal(result.tier, 3);
    assert.equal(result.category, "debug");
  });

  it("continuations inherit the task they continue", () => {
    const result = classifyRequest(agentRequest(
      { role: "user", content: "Plan the move to the ledger" },
      { role: "assistant", content: "Here is a plan…" },
      { role: "user", content: "keep going" },
    ));
    assert.equal(result.tier, 3);
    assert.equal(result.task_source, "continued_user_turn");
    assert.ok(result.reasons.includes("continues_earlier_task"));
  });

  it("recognizes typo'd and extended follow-ups as the same task", () => {
    for (const followUp of ["keep gong", "Keep goimg", "keepp going keep going", "Keep working on this",
      "contiune", "finish it", "keep going, and write the commit message"]) {
      const result = classifyRequest(agentRequest(
        { role: "user", content: "Plan the move to the ledger" },
        { role: "user", content: followUp },
      ));
      assert.equal(result.tier, 3, followUp);
      assert.equal(result.task_source, "continued_user_turn", followUp);
    }
    const fresh = classifyRequest(agentRequest(
      { role: "user", content: "Plan the move to the ledger" },
      { role: "user", content: "ok now write the commit message" },
    ));
    assert.equal(fresh.tier, 1);
  });

  it("grades image asks by the ask, not by the words in the brief", () => {
    for (const ask of ["Use your image generation tool to create ONE image: an architect's plan, edge cases and all",
      "Generate a logo for the app", "make a painting of a famous debugging session"]) {
      const result = classifyRequest({ ask });
      assert.equal(result.tier, 1, ask);
      assert.equal(result.category, "media");
    }
    assert.notEqual(classifyRequest({ ask: "Make the logo component bigger on mobile" }).category, "media");
  });

  it("ignores words inside identifiers and URLs", () => {
    assert.equal(classifyRequest({ ask: "[run=imported; item=migration:v1:turn-item:a2] thanks" }).tier, 0);
    assert.equal(classifyRequest({ ask: "Read https://example.test/guides/debugging and summarize it" }).category, "summary");
    assert.equal(classifyRequest({ ask: "Debug the failing step in db/migrations/001.sql" }).tier, 3);
  });

  it("escalates when the agent loop keeps failing, and never downgrades", () => {
    const loop = [];
    for (let i = 0; i < 3; i += 1) {
      loop.push({ role: "assistant", content: null, tool_calls: [{ id: `${i}`, type: "function", function: { name: "Bash" } }] });
      loop.push({ role: "tool", tool_call_id: `${i}`, content: "FAIL src/auth.test.js\n1 failed" });
    }
    const result = classifyRequest(agentRequest({ role: "user", content: "Implement the export endpoint" }, ...loop));
    assert.equal(result.tier, 3);
    assert.ok(result.reasons.includes("repeated_tool_failures"));
  });

  it("reads explicit reasoning requests but not default efforts", () => {
    assert.equal(classifyRequest({ messages: [{ role: "user", content: "Compare the options" }] }).tier, 2);
    assert.equal(classifyRequest({ context: "```js\nconst answer = 42;\n```" }).tier, 1);
    assert.equal(classifyRequest({ reasoning_effort: "high" }).tier, 3);
    assert.equal(classifyRequest({ ask: "Update the README", reasoning: { effort: "medium" } }).tier, 1);
    assert.equal(classifyRequest({ reasoning_effort: "none" }).tier, 0);
    assert.equal(classifyRequest({ ask: "Rename it", thinking: { type: "enabled", budget_tokens: 64_000 } }).tier, 3);
  });

  it("protects declared tools, legacy functions and tool-call history", () => {
    for (const request of [
      { tools: [{ type: "function" }], tool_choice: "none" },
      { functions: [{ name: "lookup" }] },
      { tool_choice: { type: "function", function: { name: "lookup" } } },
      { messages: [{ role: "assistant", tool_calls: [{ id: "call" }] }] },
      { messages: [{ role: "assistant", function_call: { name: "lookup" } }] },
      { messages: [{ role: "tool", content: "done" }] },
      { messages: [{ role: "function", content: "done" }] },
    ]) {
      const result = classifyRequest(request);
      assert.deepEqual(result.required_capabilities, ["chat", "tools"]);
      assert.ok(result.reasons.includes("tools_present"));
      assert.ok(result.tier >= 1);
    }
  });

  it("protects images without scanning image payloads", () => {
    for (const type of ["image_url", "input_image", "image"]) {
      const result = classifyRequest({ messages: [{ role: "user", content: [
        { type: "text", text: "Hello" }, { type, image_url: "data:image/png;base64,private" },
      ] }] });
      assert.deepEqual(result.required_capabilities, ["chat", "vision"]);
      assert.equal(result.tier, 1);
      assert.ok(result.reasons.includes("images_present"));
      assert.ok(!JSON.stringify(result).includes("private"));
    }
  });

  it("treats long written asks as specs but ignores conversation length", () => {
    assert.equal(classifyRequest({ ask: "x".repeat(1499) }).tier, 0);
    assert.equal(classifyRequest({ ask: "x".repeat(1500) }).tier, 1);
    assert.equal(classifyRequest({ ask: "x".repeat(8000) }).tier, 2);
    const chatter = Array.from({ length: 40 }, () => ({ role: "user", content: "Hello" }));
    assert.equal(classifyRequest({ messages: chatter }).tier, 0);
  });

  it("scans long histories from the end and still protects capabilities", () => {
    const history = Array.from({ length: 300 }, () => ({ role: "user", content: "Hello" }));
    history[0] = { role: "user", content: [{ type: "image_url", image_url: "https://example.test/a.png" }] };
    history.push({ role: "user", content: "Write the commit message" });
    const result = classifyRequest({ messages: history });
    assert.equal(result.tier, 1);
    assert.deepEqual(result.required_capabilities, ["chat", "vision"]);

    const parts = Array.from({ length: 129 }, () => ({ type: "text", text: "Hello" }));
    const limited = classifyRequest({ messages: [{ role: "user", content: parts }] });
    assert.ok(limited.reasons.includes("input_scan_limit"));
    assert.deepEqual(limited.required_capabilities, ["chat", "tools", "vision"]);

    const huge = classifyRequest({ ask: "x".repeat(100_000) });
    assert.ok(huge.reasons.length <= 12);
  });

  it("is repeatable, does not mutate requests and tolerates missing fields", () => {
    const request = Object.freeze({ ask: "Analyze this private sentence", tools: Object.freeze([]) });
    const result = classifyRequest(request);
    assert.deepEqual(classifyRequest(request), result);
    assert.ok(!JSON.stringify(result).includes("private"));
    for (const empty of [null, undefined, {}, { messages: [null, 42, { content: null }] }]) {
      assert.equal(classifyRequest(empty).tier, 0);
    }
  });

  describe("regressions", () => {
    const toolTurn = (i, content = "ok") => [
      { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `c${i}`, content },
    ];

    it("keeps the task's tier when a long agent loop pushes it out of the scan window", () => {
      const messages = [{ role: "user", content: "Debug the race condition in the settlement worker that double charges" }];
      for (let i = 0; i < 130; i += 1) messages.push(...toolTurn(i));
      const result = classifyRequest({ messages, tools: [{ type: "function", function: { name: "bash" } }] });
      assert.equal(result.tier, 3);
      assert.equal(result.category, "debug");
      // Loop escalation still sees the task: a tier-2 task moves up after 40+ tool results.
      messages[0] = { role: "user", content: "Implement pagination for the orders endpoint" };
      const loop = classifyRequest({ messages });
      assert.equal(loop.tier, 3);
      assert.ok(loop.reasons.includes("long_agent_loop"));
    });

    it("inherits a task through many continue turns", () => {
      const messages = [{ role: "user", content: "Debug the race condition in the payment scheduler" }];
      for (let i = 0; i < 8; i += 1) {
        messages.push({ role: "assistant", content: "Working on it." }, { role: "user", content: "continue" });
      }
      assert.equal(classifyRequest({ messages }).tier, 3);
    });

    it("stays fast on long unbroken text", () => {
      for (const ask of ["a-".repeat(8000), "İ".repeat(16000), "x=".repeat(8000), "a/".repeat(8000) + ".js"]) {
        const t0 = process.hrtime.bigint();
        classifyRequest({ messages: [{ role: "user", content: ask }] });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(ms < 50, `${ask.slice(0, 6)}… took ${ms.toFixed(1)}ms`);
      }
    });

    it("ignores a reasoning_effort that is not a string", () => {
      const messages = [{ role: "user", content: "hi" }];
      assert.doesNotThrow(() => classifyRequest({ messages, reasoning_effort: { toString: null } }));
      assert.equal(classifyRequest({ messages, reasoning: { effort: "HIGH" } }).tier, 3);
    });

    it("strips harness blocks correctly after text that lengthens when lower-cased", () => {
      const content = [
        { type: "text", text: "İSTANBUL ofisi İçin: " + "İ".repeat(40) },
        { type: "text", text: "<system-reminder>context</SYSTEM-REMINDER>" },
        { type: "text", text: "debug why the deploy fails on CI" },
      ];
      const result = classifyRequest({ messages: [{ role: "user", content }] });
      assert.equal(result.tier, 3);
      assert.equal(result.category, "debug");
      assert.ok(!stripHarness(content.map((p) => p.text).join("\n")).includes("context"));
    });
  });
});
