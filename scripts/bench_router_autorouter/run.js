#!/usr/bin/env node
"use strict";
// Offline routing benchmark for `model: "auto"`: the SuperCompress classifier + router vs
// AutoRouter's published example turns (autorouter.com, captured 2026-10-22), plus a
// held-out set of prompts labelled with AutoRouter's rubric before the classifier saw them.
//
// What this measures: routing DECISIONS (which capability tier each task lands on) and
// list-price cost of those decisions. What it does not measure: answer quality, latency,
// or compression. No model calls are made.
//
//   node scripts/bench_router_autorouter/run.js [--json]

const path = require("path");
const fs = require("fs");
const root = path.join(__dirname, "..", "..");
const { classifyRequest } = require(path.join(root, "packages/control-plane/request-classifier"));
const { selectRoute } = require(path.join(root, "packages/control-plane/router"));
const { DEFAULT_CATALOG, PROVIDER_CATALOG } = require(path.join(root, "packages/control-plane/catalog"));
const heldout = require("./heldout");

// [prompt, AutoRouter pick, AutoRouter label, total tokens]. "rule" / "override" turns were
// not routed by AutoRouter's classifier, so they are excluded from scoring.
const TURNS = [
  ["Plan the move to the ledger", "Claude Opus 5.5", "Hard", 38200],
  ["Clean this up a bit", "Claude Sonnet 5.5", "Medium", 61500],
  ["Rename the old helpers", "MiniMax M3.1 Flash", "Easy", 2100],
  ["Review the diff", "GPT-6 Astra", "Hard", 24700],
  ["Build it from the Figma frame", "Claude Opus 5.5", "rule", 58400],
  ["Wire the toggles to the API", "Claude Sonnet 5.5", "Medium", 21700],
  ["Fix the typos in the labels", "MiniMax M3.1 Flash", "Easy", 1800],
  ["Keep edits when offline", "GPT-6 Astra", "Hard", 33900],
  ["Find why auth only fails on CI", "GPT-6 Astra", "Hard", 44300],
  ["Compare the CI and local env", "Claude Sonnet 5.5", "Medium", 14900],
  ["Fix the clock in the test", "GPT-6.1 Sol", "override", 27600],
  ["Run the suite and sum up", "MiniMax M3.1 Flash", "Easy", 2900],
  ["Test every ledger endpoint", "Claude Sonnet 5.5", "Medium", 26300],
  ["Make these better", "Claude Sonnet 5.5", "Medium", 19400],
  ["Cover the rounding edge cases", "Claude Opus 5.5", "Hard", 16100],
  ["Update the README", "MiniMax M3.1 Flash", "Easy", 2400],
  ["Sum up the staged changes", "MiniMax M3.1 Flash", "Easy", 4600],
  ["Write the commit message", "MiniMax M3.1 Flash", "Easy", 2100],
  ["Split out the config change", "Claude Sonnet 5.5", "Medium", 8900],
  ["Draft the pull request", "MiniMax M3.1 Flash", "Easy", 2300],
];
const LABEL_TIER = { Easy: 1, Medium: 2, Hard: 3 };
const NAME_TO_ID = {
  "Claude Opus 5.5": "claude-opus-5-5",
  "Claude Sonnet 5.5": "claude-sonnet-5-5",
  "GPT-6 Astra": "gpt-6-astra",
  "GPT-6.1 Sol": "gpt-6.1-sol",
  "MiniMax M3.1 Flash": null, // not in our catalog: priced at $0 (best case for AutoRouter)
};
const INPUT_SHARE = 0.9; // same input/output split for every router; only the model differs
const TOP = "claude-fable-5-1";

// A coding agent's real request: long harness system prompt full of task words, tool
// definitions and an injected reminder. None of that says how hard the task is.
const SYSTEM = ("You are an interactive CLI tool that helps users with software engineering tasks: " +
  "debug failures, refactor code, review architecture, explain algorithms and write tests. ").repeat(160);
const REMINDER = "<system-reminder>Contents of CLAUDE.md: always debug root causes and review diffs.</system-reminder>";
const TOOLS = ["Read", "Edit", "Bash", "Grep"].map((name) => ({
  type: "function", function: { name, parameters: { type: "object", properties: {} } },
}));

const CATALOGS = {
  openai_anthropic: DEFAULT_CATALOG,
  all_providers: [...DEFAULT_CATALOG, ...PROVIDER_CATALOG],
};

function usd(catalog, id, tokens) {
  if (!id) return 0;
  const m = catalog.find((x) => x.id === id) || DEFAULT_CATALOG.find((x) => x.id === id);
  return (tokens * INPUT_SHARE * m.input_usd_per_mtok + tokens * (1 - INPUT_SHARE) * m.output_usd_per_mtok) / 1e6;
}

function route(catalog, prompt, tokens, agentShaped) {
  const req = agentShaped
    ? { messages: [{ role: "system", content: SYSTEM }, { role: "user", content: REMINDER + prompt }], tools: TOOLS }
    : { messages: [{ role: "user", content: prompt }] };
  const cls = classifyRequest(req);
  const decision = selectRoute({
    request_tier: cls.tier,
    routing: { strategy: "cheapest_fit", complexity_routing: true },
    retained_tokens: Math.round(tokens * INPUT_SHARE),
    output_tokens_est: Math.round(tokens * (1 - INPUT_SHARE)),
    catalog,
    require_capabilities: cls.required_capabilities,
    max_usd_per_request: 50,
  });
  const model = decision.model;
  return { cls, model, tier: model ? catalog.find((m) => m.id === model).tier : null };
}

function scoreTurns(catalogName, agentShaped) {
  const catalog = CATALOGS[catalogName];
  const rows = TURNS.map(([prompt, arPick, label, tokens]) => {
    const ours = route(catalog, prompt, tokens, agentShaped);
    const scored = label in LABEL_TIER;
    return {
      prompt, label, tokens, autorouter: arPick, ours: ours.model, our_tier: ours.tier,
      reasons: ours.cls.reasons.join(","),
      ar_usd: usd(catalog, NAME_TO_ID[arPick], tokens),
      our_usd: usd(catalog, ours.model, tokens),
      top_usd: usd(catalog, TOP, tokens),
      scored,
      verdict: !scored ? "n/a" : ours.tier === LABEL_TIER[label] ? "match" : ours.tier < LABEL_TIER[label] ? "UNDER" : "over",
    };
  });
  const scored = rows.filter((r) => r.scored);
  const sum = (k) => +scored.reduce((a, r) => a + r[k], 0).toFixed(4);
  return {
    match: `${scored.filter((r) => r.verdict === "match").length}/${scored.length}`,
    under_routed: scored.filter((r) => r.verdict === "UNDER").length,
    over_routed: scored.filter((r) => r.verdict === "over").length,
    usd: { autorouter: sum("ar_usd"), supercompress: sum("our_usd"), always_top_model: sum("top_usd") },
    rows,
  };
}

function scoreHeldout() {
  const out = {};
  for (const [name, filter] of [["dev_split", (i) => i % 2 === 0], ["test_split", (i) => i % 2 === 1]]) {
    const split = heldout.filter((_, i) => filter(i));
    let exact = 0, under = 0, over = 0;
    const misses = [];
    for (const [ask, label] of split) {
      const tier = Math.max(1, classifyRequest({ ask }).tier);
      if (tier === LABEL_TIER[label]) exact += 1;
      else {
        if (tier < LABEL_TIER[label]) under += 1; else over += 1;
        misses.push({ ask, label, tier });
      }
    }
    out[name] = { exact: `${exact}/${split.length}`, under_routed: under, over_routed: over, misses };
  }
  return out;
}

const results = { generated_at: new Date().toISOString(), turns: {}, heldout: scoreHeldout() };
for (const catalogName of Object.keys(CATALOGS)) {
  for (const [shape, agentShaped] of [["bare_prompt", false], ["agent_request", true]]) {
    results.turns[`${catalogName}/${shape}`] = scoreTurns(catalogName, agentShaped);
  }
}

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(results, null, 1) + "\n");
} else {
  for (const [name, r] of Object.entries(results.turns)) {
    console.log(`\n== ${name} ==`);
    console.table(r.rows.map((x) => ({ prompt: x.prompt, label: x.label, autorouter: x.autorouter, ours: x.ours, verdict: x.verdict })));
    console.log(JSON.stringify({ match: r.match, under_routed: r.under_routed, over_routed: r.over_routed, usd: r.usd }));
  }
  console.log("\n== held-out prompts (classifier tier vs AutoRouter rubric label) ==");
  for (const [name, r] of Object.entries(results.heldout)) {
    console.log(name, JSON.stringify({ exact: r.exact, under_routed: r.under_routed, over_routed: r.over_routed }));
  }
}
fs.writeFileSync(path.join(__dirname, "results.json"), JSON.stringify(results, null, 1) + "\n");
