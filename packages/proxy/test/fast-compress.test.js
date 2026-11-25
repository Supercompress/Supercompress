"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compress: compressWithFloor, unitsFor, documentFor } = require("../src/fast-compress");
// These cases test selection on small inputs; the size floor has its own tests (agent-output.test.js).
const compress = (context, query, options = {}) => compressWithFloor(context, query, { minChars: 0, ...options });

test("incidental lone words cannot justify dropping an unrecognized multiword answer", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `Routine note ${index}: ordinary background material.`);
  rows[8] = "The timeout label appears on the dashboard.";
  rows[30] = "Operations expire after 17 seconds.";
  const input = rows.join("\n");
  const output = compress(input, "What timeout governs requests?");
  assert.equal(output.compressed_text, input);
  assert.equal(output.selection_reason, "low_confidence_query_evidence");
  for (const query of ["timeout", "What governs request_17?"]) {
    const control = input.replace("timeout", "timeout request_17");
    const selected = compress(control, query);
    assert.equal(selected.selection_reason, "query_anchored_extraction");
    assert.ok(selected.compressed_text.includes("timeout request_17"));
    assert.ok(selected.compressed_text.length < control.length / 2);
  }
});

test("distant constraints are required evidence even with a tiny soft budget", () => {
  for (const constraint of [
    "Production releases require signed approval before execution.",
    "Operators must obtain signed approval before execution.",
    "Never release without signed approval.",
    "Release is prohibited without signed approval.",
    "Do not release without signed approval.",
  ]) {
    const rows = Array.from({ length: 40 }, (_, index) => `Routine note ${index}: ordinary background material.`);
    rows[8] = "To deploy cedar, run release --production.";
    rows[30] = constraint;
    const input = rows.join("\n");
    const output = compress(input, "How do I deploy cedar?", { budgetRatio: 0.01 });
    assert.equal(output.selection_reason, "query_anchored_extraction");
    assert.ok(output.compressed_text.includes(rows[8]));
    assert.ok(output.compressed_text.includes(constraint));
    assert.ok(output.compressed_text.length < input.length / 2);
    assert.ok(documentFor(input).requiredIndices.includes(30));
  }
});

test("a full budget preserves zero-score evidence and exact source formatting", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `Routine note ${index}.`);
  rows[8] = "deploy cedar";
  rows[30] = "Operations expire after 17 seconds.";
  for (const input of [rows.join("\r\n") + "\r\n", JSON.stringify(rows, null, 2)]) {
    const output = compress(input, "deploy cedar", { budgetRatio: 1 });
    assert.equal(output.compressed_text, input);
    assert.equal(output.selection_reason, "full_budget_preservation");
    assert.equal(output.tokens_saved, 0);
  }
});

test("global ranking retains the winner beyond an incidental descriptive anchor", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `region=r${index} revenue=${index + 1}`);
  rows[8] = "The highest revenue is highlighted in the dashboard.";
  rows[30] = "region=west revenue=999";
  const input = rows.join("\n");
  for (const query of ["Which region has highest revenue?", "Which region has lowest revenue?", "Rank regions by revenue", "Top 3 regions by revenue", "Which region has the largest revenue?"]) {
    const output = compress(input, query);
    assert.equal(output.compressed_text, input);
    assert.equal(output.selection_reason, "global_evidence_required");
  }
});

test("peer Markdown references preserve dependency closure before selection", () => {
  const sections = Array.from({ length: 20 }, (_, index) => `# Topic ${index}\nOrdinary background material.`);
  sections[3] = "# Prerequisites\nSigned approval is required before any release.";
  sections[12] = "# cedar\nSee section Prerequisites. Run release --production.";
  const input = sections.join("\n");
  const output = compress(input, "How do I operate cedar?");
  assert.equal(output.compressed_text, input);
  assert.equal(output.selection_reason, "cross_reference_dependency");
  assert.deepEqual(unitsFor(input), [input]);
  assert.deepEqual(documentFor(input).units, [input]);
});

test("YAML aliases cannot outlive their anchor definition", () => {
  const siblings = Array.from({ length: 20 }, (_, index) => `  service_${index}:\n    replicas: 2`);
  siblings[3] = "  defaults: &baseline\n    approval_required: true";
  siblings[12] = "  cedar:\n    <<: *baseline\n    replicas: 3";
  const input = "services:\n" + siblings.join("\n");
  const output = compress(input, "What configuration does cedar use?");
  assert.equal(output.compressed_text, input);
  assert.equal(output.selection_reason, "yaml_reference_dependency");
  assert.deepEqual(documentFor(input).units, [input]);
  assert.deepEqual(unitsFor(input), [input]);
});

test("JSON reference metadata and record references prevent positional extraction", () => {
  const records = Array.from({ length: 40 }, (_, index) => ({ id: index === 25 ? "cedar" : `other_${index}`, value: index }));
  for (const wrapper of [{ primaryIndex: 25, records }, { meta: { primary_index: 25 }, records }, { pointer: "/records/25", records }]) {
    const input = JSON.stringify(wrapper);
    const output = compress(input, "Find cedar");
    assert.equal(output.compressed_text, input);
    assert.equal(output.selection_reason, "json_reference_dependency");
    const document = documentFor(input);
    assert.deepEqual(document.units, [input]);
    assert.deepEqual(document.requiredIndices, [0]);
    assert.equal(document.render([0], document.units), input);
    if (wrapper.primaryIndex !== undefined) assert.equal(JSON.parse(output.compressed_text).records[wrapper.primaryIndex].id, "cedar");
  }
  records[25].nextIndex = 3;
  const input = JSON.stringify(records);
  assert.equal(compress(input, "cedar").compressed_text, input);
});

test("JSON constraints remain required units without disabling independent record extraction", () => {
  const records = Array.from({ length: 40 }, (_, index) => ({ id: `record_${index}`, detail: "ordinary material" }));
  records[30].detail = "Signed approval is required before execution.";
  const input = JSON.stringify({ records, total: 40 });
  const document = documentFor(input);
  assert.ok(document.requiredIndices.includes(30));
  const output = compress(input, "record_8", { budgetRatio: 0.01 });
  assert.ok(JSON.parse(output.compressed_text).records.some((record) => record.id === "record_30"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("delimited units preserve complete quoted CSV and TSV records including CRLF", () => {
  for (const delimiter of [",", "\t"]) {
    for (const newline of ["\n", "\r\n"]) {
      const rows = [
        ["case", "notes", "owner"].join(delimiter),
        ["target_zinnia", '"first line\nsecond line with ""quotes"""', "owner-12"].join(delimiter),
        ["other", "healthy", "owner-13"].join(delimiter),
      ];
      const text = rows.join(newline);
      const units = unitsFor(text);
      assert.equal(units.length, 3);
      assert.equal(units.join("\n"), text);
      assert.ok(units[1].includes('second line with ""quotes""'));
    }
  }
});

test("ambiguous delimited input is preserved rather than partially parsed", () => {
  for (const text of ['case,notes\na,"unfinished', 'case,notes\na,one,two', 'case,notes\na,"closed"trailing']) {
    assert.deepEqual(unitsFor(text), [text]);
    assert.equal(compress(text, "find case a notes").compressed_text, text);
  }
});

test("markdown keeps numbered steps and nested headings within their parent section", () => {
  const text = "preamble\n## procedure\n1. Stop\n2. Backup\n### Verify\n3. Checksum\n## reference\nother";
  assert.deepEqual(unitsFor(text), ["preamble", "## procedure\n1. Stop\n2. Backup\n### Verify\n3. Checksum", "## reference\nother"]);
});

test("a sole document title does not collapse peer sections into one unit", () => {
  const text = "# Handbook\nScope applies throughout.\n## Setup\nInitialize.\n### Validation\nCheck.\n## Recovery\nRestore.\n## Notes\nReview.";
  assert.deepEqual(unitsFor(text), [
    "# Handbook\nScope applies throughout.",
    "## Setup\nInitialize.\n### Validation\nCheck.",
    "## Recovery\nRestore.",
    "## Notes\nReview.",
  ]);
});

test("titled documents preserve query evidence across identifiers, levels and positions", () => {
  for (const titleLevel of ["#", "##"]) {
    for (let position = 0; position < 16; position += 1) {
      const identity = `record_${titleLevel.length}_${position}`;
      const answer = `evidence_${position}`;
      const sections = Array.from({ length: 16 }, (_, index) =>
        `${titleLevel}# Item ${index}\nIndependent material ${index}.\n${"Routine description. ".repeat(12)}`);
      sections[position] = `${titleLevel}# ${identity}\nDo not remove safeguards.\n${titleLevel}## Detail\n${answer}\n\`\`\`sh\n# fenced comment\nverify --safe\n\`\`\``;
      const text = `${titleLevel} Guide\nDocument scope and mandatory preconditions.\n${sections.join("\n")}`;
      const output = compress(text, `Find ${identity}`);
      assert.equal(output.selection_reason, "query_anchored_extraction");
      assert.ok(output.compressed_text.startsWith(`${titleLevel} Guide\nDocument scope and mandatory preconditions.`));
      assert.ok(output.compressed_text.includes(sections[position]));
      assert.ok(output.compressed_text.length < text.length);
      assert.equal(compress(text, "Explain the guide").compressed_text, text);
      assert.equal(compress(text, "Compare every item").compressed_text, text);
    }
  }
});

test("titled documents with explicit cross-section dependencies remain intact", () => {
  for (const dependency of ["See section Setup.", "Refer to chapter Setup.",
    "Follow [setup](#setup).", "Uses [setup][config].\n[config]: #setup",
    "Assumptions[^setup].\n[^setup]: Defined elsewhere.", "As defined above."]) {
    const text = `# Guide\nScope.\n## Setup\nRequired preconditions.\n## Noise\nOther.\n## Target\n${dependency}\n## More\nOther.\n## End\nOther.`;
    assert.deepEqual(unitsFor(text), [text]);
    assert.equal(compress(text, "Find Target").compressed_text, text);
  }
});

test("multiple top-level headings keep their nested sections together", () => {
  const text = "# First\n## Child\nBody.\n# Second\n## Other child\nOther body.";
  assert.deepEqual(unitsFor(text), ["# First\n## Child\nBody.", "# Second\n## Other child\nOther body."]);
});

test("heading-looking code inside fences never splits a fenced block", () => {
  for (const fence of ["```", "~~~"]) {
    const text = `## procedure\n${fence}sh\n# shell comment\n## not a section\nrestore --verify\n${fence}\n## reference\nother`;
    const units = unitsFor(text);
    assert.equal(units.length, 2);
    assert.ok(units[0].includes(`restore --verify\n${fence}`));
    assert.equal(units[1], "## reference\nother");
  }
});

test("query selection generalizes across seeded identifiers and positions without corpus vocabulary", () => {
  let state = 0x3c182a;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let trial = 0; trial < 100; trial += 1) {
    const identity = `ref_${random().toString(36)}`;
    const answer = `value_${random().toString(36)}`;
    const rows = Array.from({ length: 70 + random() % 200 }, (_, index) => `other_${index} routine event value=${random()}`);
    rows.splice(random() % rows.length, 0, `${identity} outcome=${answer}; do not erase history`);
    const text = rows.join("\n");
    const result = compress(text, `What is the outcome for ${identity}?`);
    assert.ok(result.compressed_text.includes(answer));
    assert.ok(result.compressed_text.includes("do not erase history"));
    assert.ok(result.compressed_text.length < text.length);
    assert.equal(compress(text, `find absent_${identity}`).compressed_text, text);
  }
});

test("transaction variants preserve commit, audit and rollback evidence", () => {
  for (const begin of ["BEGIN;", "begin transaction;", "BEGIN WORK;", "START TRANSACTION;"]) {
    const text = `${begin}\nUPDATE a SET flag=1;\nINSERT INTO audit VALUES ('keep');\nCOMMIT;`;
    assert.deepEqual(unitsFor(text), [text]);
  }
});

test("large YAML sibling scans do not exceed the function argument limit", () => {
  const text = `records:\n${Array.from({ length: 150000 }, (_, index) => `  record_${index}: healthy`).join("\n")}`;
  assert.equal(unitsFor(text).length, 150001);
});

test("finds middle answers without a head/tail cap", () => {
  const lines = Array.from({ length: 4000 }, (_, index) => `INFO event-${index} healthy`);
  lines[2017] = "INCIDENT auth-xyz root cause: expired signing key";
  const output = compress(lines.join("\n"), "What caused auth-xyz?");
  assert.match(output.compressed_text, /expired signing key/);
  assert.ok(output.tokens_saved_pct > 90);
  assert.equal(output.truncated, false);
  assert.equal(output.lines_in, 4000);
});

test("unknown or absent query preserves original byte-for-byte", () => {
  const input = "one\n\n two\nthree\r\nfour\n";
  for (const query of ["", "explain unknown-identifier"]) assert.equal(compress(input, query).compressed_text, input);
});

test("JSON numeric identifiers and special numbers never change during extraction", () => {
  for (const numeric of ["9007199254740993", "-9007199254740993", "1e400", "-0"]) {
    const context = `[{"incident":"auth-xyz","value":${numeric}},{"noise":1},{"noise":2},{"noise":3}]`;
    const output = compress(context, "What is auth-xyz?").compressed_text;
    assert.ok(output.includes(`"value":${numeric}`));
    assert.ok(output.length < context.length);
  }
});

test("aggregate and exhaustive questions never silently sample the evidence", () => {
  const context = Array.from({ length: 100 }, (_, index) => `record_${index} group=${index === 55 ? "incident_xyz" : "ordinary"} amount=${index}`).join("\n");
  for (const query of ["How many incident_xyz records?", "Compare incident_xyz against ordinary", "List all incident_xyz records", "Total amount for incident_xyz", "Find the latest incident_xyz", "Distribution of incident_xyz"]) {
    const output = compress(context, query);
    assert.equal(output.compressed_text, context);
    assert.equal(output.selection_reason, "global_evidence_required");
  }
});

test("JSON selection preserves raw escapes, duplicate keys and wrapper metadata", () => {
  const evidence = '{"id":"needle_xyz","value":9007199254740993,"value":1e400,"escaped":"\\u0061,}[]\\\"","negative":-0}';
  const context = '{"total":9007199254740995,"data":[' + Array.from({ length: 60 }, (_, index) => index === 31 ? evidence : `{"id":"noise_${index}"}`).join(",") + '],"meta":{"encoded":"\\u0062","number":1.2300e+04}}';
  const output = compress(context, "needle_xyz").compressed_text;
  assert.ok(output.includes(evidence));
  assert.ok(output.startsWith('{"total":9007199254740995,"data":['));
  assert.ok(output.endsWith('],"meta":{"encoded":"\\u0062","number":1.2300e+04}}'));
  assert.doesNotThrow(() => JSON.parse(output));
  assert.ok(output.length < context.length / 2);
});

test("generated JSON cases retain complete source entries across sizes and positions", () => {
  for (let seed = 1; seed <= 30; seed += 1) {
    const length = 20 + seed * 3;
    const target = (seed * 17) % length;
    const entries = Array.from({ length }, (_, index) => JSON.stringify({ id: index === target ? `needle_${seed}` : `noise_${index}`, nested: [{ text: `comma, quote\" slash\\ brackets[]{} ${seed}`, flag: false }], value: index }));
    const context = `[\n${entries.join(",\n")}\n]`;
    const output = compress(context, `needle_${seed}`).compressed_text;
    assert.ok(output.includes(entries[target]));
    for (const entry of JSON.parse(output)) assert.deepEqual(entry, JSON.parse(entries[entry.value]));
    assert.ok(output.length < context.length);
  }
});

test("ambiguous JSON array wrappers and malformed JSON stay byte-exact", () => {
  for (const context of ['{"data":[1,2,3,4],"other":[5,6,7,8],"id":"needle_xyz"}', '[{"id":"needle_xyz"},,1,2,3]', '{"data":["needle_xyz",1,2,3],']) {
    assert.equal(compress(context, "needle_xyz").compressed_text, context);
  }
});

test("long queries retain distant evidence without indexing unrelated vocabulary", () => {
  const lines = Array.from({ length: 4000 }, (_, index) => `entry_${index} healthy ordinary`);
  lines[713] = "first_evidence observed answer_one";
  lines[3311] = "second_evidence observed answer_two";
  const query = Array.from({ length: 2000 }, (_, index) => `unseen_${index}`).join(" ") + " first_evidence second_evidence";
  const output = compress(lines.join("\n"), query);
  assert.match(output.compressed_text, /answer_one/);
  assert.match(output.compressed_text, /answer_two/);
  assert.ok(output.lines_kept < 20);
});

test("keeps JSON and HTML whole rather than producing fragments", () => {
  for (const input of ['{\n"a": 1,\n"b": 2\n}', '<html>\n<body>\nsecret\n</body>\n</html>']) {
    assert.equal(compress(input, "secret a").compressed_text, input);
  }
});

test("preserves fences, nested YAML and full diff structures", () => {
  for (const block of ['```js\nconst auth_xyz = 1;\n```', 'auth_xyz:\n  nested:\n    value: answer', 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+auth_xyz']) {
    const input = `header\nnoise-one\nnoise-two\n${block}\nnoise-three\nnoise-four`;
    assert.ok(unitsFor(input).some((unit) => unit.includes(block)));
    assert.ok(compress(input, "auth_xyz").compressed_text.includes(block));
  }
});

test("soft budgets never truncate matching structures", () => {
  const block = `target_xyz:\n  value: ${"important ".repeat(400)}`;
  const input = `header\nnoise\n${block}\nother\nend`;
  assert.ok(compress(input, "target_xyz", { budgetRatio: 0.01 }).compressed_text.includes(block));
  assert.throws(() => compress(input, "target_xyz", { budgetRatio: NaN }), RangeError);
});

test("JSON extraction keeps complete objects, wrappers and unrelated metadata", () => {
  const entries = Array.from({ length: 50 }, (_, index) => ({ id: `account_${index}`, config: { contact: index === 27 ? "answer@example.com" : "other@example.com", enabled: false }, roles: ["reader", "writer"] }));
  const input = JSON.stringify({ data: entries, has_more: false, total: 50 }, null, 2);
  const output = JSON.parse(compress(input, "account_27").compressed_text);
  assert.deepEqual(output.data.find((entry) => entry.id === "account_27"), entries[27]);
  assert.equal(output.has_more, false);
  assert.equal(output.total, 50);
  assert.ok(output.data.length < entries.length);
  assert.deepEqual(JSON.parse(compress(JSON.stringify(entries), "account_27").compressed_text).find((entry) => entry.id === "account_27"), entries[27]);
});

test("nested YAML sibling extraction keeps the parent and whole target block", () => {
  const input = `services:\n${Array.from({ length: 50 }, (_, index) => `  service_${index}:\n    env:\n      value: secret_${index}\n    replicas: 2`).join("\n")}`;
  const output = compress(input, "service_27").compressed_text;
  assert.ok(output.startsWith("services:\n"));
  assert.ok(output.includes("  service_27:\n    env:\n      value: secret_27\n    replicas: 2"));
  assert.ok(output.length < input.length / 2);
});

test("token estimates are labeled, output ordered and tokens never expand", () => {
  const input = Array.from({ length: 100 }, (_, index) => `row ${index} value ${index === 55 ? "needle_xyz" : "ordinary"}`).join("\n");
  const output = compress(input, "needle_xyz");
  assert.equal(output.token_count_method, "legacy_lexical_estimate");
  assert.ok(output.kept_tokens <= output.original_tokens);
  assert.ok(output.compressed_text.indexOf("row 54") < output.compressed_text.indexOf("row 55"));
});

test("fast extractive path returns mode=fast with query-anchored savings", () => {
  const input = "header\nalpha\nneedle_xyz answer\nbeta\ngamma\nend";
  const output = compress(input, "needle_xyz");
  assert.equal(output.mode, "fast");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("needle_xyz answer"));
  assert.ok(output.compressed_text.length < input.length);
});

test("bracketed search-result lines are not mistaken for JSON arrays", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `[${index}] Routine listing about widget ${index}. https://example.test/r/${index}`);
  rows[17] = "[17] Hydra DB 9.1 raises max blob size to 48 MB on 2026-08-11. https://docs.example/h91";
  const input = rows.join("\n");
  assert.ok(unitsFor(input).length >= 20);
  const output = compress(input, "What max blob size did Hydra DB 9.1 introduce and when?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("48 MB"));
  assert.ok(output.compressed_text.includes("2026-08-11"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("noun-phrase count questions are extractive, not global aggregates", () => {
  const rows = Array.from({ length: 50 }, (_, index) => JSON.stringify({ id: 5000 + index, plan: "pro", seats: 1 + (index % 9) }));
  rows[22] = JSON.stringify({ id: 7721, name: "Nora Vale", plan: "enterprise", seats: 180 });
  const input = `[\n${rows.join(",\n")}\n]`;
  const output = compress(input, "Which account is on the enterprise plan? Give the user id and seat count.");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("7721"));
  assert.ok(output.compressed_text.includes("180"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("CamelCase and snake_case identifiers match query subtokens", () => {
  const rows = Array.from({ length: 60 }, (_, index) => `INFO worker=${index} heartbeat ok`);
  rows[41] = "ERROR export failed AssertionError: missing column archived_at in queries.py";
  const input = rows.join("\n");
  const output = compress(input, "What assertion failed during export?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("AssertionError"));
  assert.ok(output.compressed_text.includes("archived_at"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("JSON objects of many sibling records can drop non-matching keys", () => {
  const packages = {};
  for (let index = 0; index < 40; index += 1) {
    packages[`pkg_${index}`] = { version: `${index}.0.0`, license: "MIT" };
  }
  packages.left_padder = { version: "3.2.1", license: "Apache-2.0" };
  const input = JSON.stringify({ packages });
  const output = compress(input, "Which package uses Apache-2.0?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("left_padder"));
  assert.ok(output.compressed_text.includes("Apache-2.0"));
  assert.ok(output.compressed_text.length < input.length / 2);
  assert.doesNotThrow(() => JSON.parse(output.compressed_text));
});

test("large unfenced codebases split on peer top-level definitions", () => {
  const blocks = Array.from({ length: 12 }, (_, index) =>
    `def helper_${index}():\n    return ${index}\n`);
  blocks[7] = "def build_limiter():\n    # rate=19 burst=40 from INC-4402\n    return RateLimiter(rate=19, burst=40)\n";
  const input = "# module\nfrom limits import RateLimiter\n\n" + blocks.join("\n");
  assert.ok(unitsFor(input).length >= 8);
  const output = compress(input, "What rate and burst does build_limiter use?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("rate=19"));
  assert.ok(output.compressed_text.includes("burst=40"));
  assert.ok(output.compressed_text.includes("INC-4402"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("sparse hash comments in logs do not trigger Markdown heading collapse", () => {
  const rows = Array.from({ length: 80 }, (_, index) => `INFO event-${index} healthy`);
  rows[10] = "# operator note: ignore routine noise";
  rows[55] = "ERROR auth-xyz root cause: expired signing key";
  rows[70] = "# trailing comment";
  const input = rows.join("\n");
  assert.ok(unitsFor(input).length >= 40);
  const output = compress(input, "What caused auth-xyz?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("expired signing key"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("telemetry spike questions keep numeric outlier rows in CSV dumps", () => {
  const rows = ["timestamp,service,p99_ms,error_rate"];
  for (let index = 0; index < 80; index += 1) {
    rows.push(`2026-10-14T11:${String(index % 60).padStart(2, "0")}:00Z,feed,${40 + (index % 30)},0.00${index % 10}`);
  }
  rows[41] = "2026-10-14T11:34:20Z,checkout,9412,0.3170";
  const input = rows.join("\n");
  const output = compress(input, "Which service had the latency spike, and what was its p99?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("checkout"));
  assert.ok(output.compressed_text.includes("9412"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("stemmed fail/block verbs and compound service IDs still anchor extraction", () => {
  const rows = Array.from({ length: 60 }, (_, index) => `npm WARN deprecated pkg@${index}`);
  rows[40] = "Error: PaymentIntent pi_live_9x failed: card_declined";
  rows[41] = "    at chargeCustomer (billing/stripe.ts:214:11)";
  rows[42] = "    at processOrder (orders/checkout.ts:88:5)";
  const payment = rows.join("\n");
  const pay = compress(payment, "Why did checkout fail?");
  assert.equal(pay.selection_reason, "query_anchored_extraction");
  assert.ok(pay.compressed_text.includes("card_declined"));
  assert.ok(pay.compressed_text.length < payment.length / 2);

  const kube = Array.from({ length: 80 }, (_, index) => `I0820 Normal event noise ${index}`);
  kube[50] = "  Warning  Unhealthy  pod/payments-api-7f9c2    Liveness probe failed: HTTP 503";
  kube[51] = "Error: OOMKilled container payments-sidecar (limit 256Mi)";
  const kctx = kube.join("\n");
  const kout = compress(kctx, "Why is payments-api crash-looping?");
  assert.equal(kout.selection_reason, "query_anchored_extraction");
  assert.ok(kout.compressed_text.includes("OOMKilled") || kout.compressed_text.includes("Liveness"));
  assert.ok(kout.compressed_text.length < kctx.length / 2);
});

test("markdown category headings keep their section bodies for catalog queries", () => {
  const input = [
    "# Lumen Apparel catalog",
    "## Women's",
    "SKU-W01 | Women's Item 1 | $51",
    "SKU-W02 | Women's Item 2 | $52",
    "## Kids",
    "SKU-K01 | Kids' Item 1 | $21",
    "## Men's",
    "SKU-ALPHA | Men's Merino Crew | $89",
    "SKU-BRAVO | Men's Slim Chino | $58",
    "## FAQ",
    "Q: shipping? A: 5 days",
  ].join("\n");
  const output = compress(input, "I want stuff in men's apparel");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("SKU-ALPHA"));
  assert.ok(output.compressed_text.includes("SKU-BRAVO"));
  assert.ok(!output.compressed_text.includes("SKU-W01") || output.compressed_text.length < input.length);
  assert.ok(output.compressed_text.length < input.length);
});

test("multihop entity identifiers pull linked price and warehouse facts", () => {
  const input = [
    "noise A",
    "REF product_id=P-4412 appears on invoice INV-90.",
    "noise B",
    "P-4412 maps to SKU TrailShell-X in catalog.",
    "noise C",
    "TrailShell-X material = Gore-Tex + seam sealed (waterproof).",
    "noise D",
    "TrailShell-X list_price = $142.",
    "noise E",
    "Inventory P-4412 qty=14 warehouse=OAK.",
    "noise F",
  ].join("\n");
  const output = compress(input, "Is the product on INV-90 a waterproof shell under $150 in stock in Oakland?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("$142"));
  assert.ok(output.compressed_text.includes("OAK"));
  assert.ok(output.compressed_text.includes("TrailShell-X"));
});

test("git commit headers stay glued to their message bodies", () => {
  const commits = Array.from({ length: 12 }, (_, index) => [
    `commit ${"ab".repeat(20)}${index}`,
    `Author: dev${index} <dev${index}@corp.dev>`,
    `Date:   Tue Oct ${1 + (index % 20)} 11:00:00 2026 +0000`,
    "",
    `    chore: routine update ${index}`,
    "",
  ].join("\n"));
  commits[7] = [
    "commit 9e4c1a2b7d6f0e9a8b7c6d5e4f3a2b1c0d9e8f7a",
    "Author: priya <priya@corp.example.com>",
    "Date:   Tue Oct 7 09:14:00 2026 +0000",
    "",
    "    payments: switch default currency from USD to EUR for EU tenants",
    "",
  ].join("\n");
  const input = commits.join("\n");
  assert.ok(unitsFor(input).length >= 8);
  assert.ok(unitsFor(input).some((unit) => unit.includes("9e4c1a2") && unit.includes("currency")));
  const output = compress(input, "Which commit changed the default currency, who authored it, and what did it change to?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("9e4c1a2"));
  assert.ok(output.compressed_text.includes("priya"));
  assert.ok(output.compressed_text.includes("EUR"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("failed-login questions keep scarce 401 rows in access-log dumps", () => {
  const rows = Array.from({ length: 120 }, (_, index) => {
    const path = ["/index.html", "/api/health", "/assets/app.js", "/favicon.ico"][index % 4];
    return `198.51.100.${1 + (index % 200)} - - [14/Oct/2026:10:${String(index % 60).padStart(2, "0")}:00 +0000] "GET ${path} HTTP/1.1" 200 128`;
  });
  rows[70] = '203.0.113.44 - - [14/Oct/2026:10:41:00 +0000] "POST /admin-login HTTP/1.1" 401 240';
  rows[71] = '203.0.113.44 - - [14/Oct/2026:10:42:00 +0000] "POST /admin-login HTTP/1.1" 401 202';
  const input = rows.join("\n");
  const output = compress(input, "Which IP is making failed login attempts, and to what path?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("203.0.113.44"));
  assert.ok(output.compressed_text.includes("/admin-login"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("non-license contrast questions keep the minority sibling in package maps", () => {
  const packages = {};
  for (let index = 0; index < 36; index += 1) {
    packages[`lib_${index}`] = { version: `${index}.0.0`, license: "MIT" };
  }
  packages.odd_widget = { version: "4.5.6", license: "GPL-3.0" };
  for (const input of [JSON.stringify({ packages }), JSON.stringify({ packages }, null, 2)]) {
    const output = compress(input, "Which dependency has a non-MIT license? Name the package, version, and license.");
    assert.equal(output.selection_reason, "query_anchored_extraction");
    assert.ok(output.compressed_text.includes("odd_widget"));
    assert.ok(output.compressed_text.includes("GPL-3.0"));
    assert.ok(output.compressed_text.includes("4.5.6"));
    assert.ok(output.compressed_text.length < input.length / 2);
    assert.doesNotThrow(() => JSON.parse(output.compressed_text));
  }
});

test("explicit preservation intent bypasses extraction", () => {
  const input = "header\nalpha\nneedle_xyz answer\nbeta\ngamma\nend\nlast";
  for (const query of ["Preserve every line exactly, verbatim, including needle_xyz", "keep all rows about needle_xyz", "do not omit needle_xyz"]) {
    assert.equal(compress(input, query).compressed_text, input);
  }
});

test("uncertain unfenced code stays byte-for-byte intact", () => {
  const input = "header\nnoise\nfunction needle_xyz()\n{\n  return 42;\n}\nnoise\nend";
  assert.equal(compress(input, "needle_xyz").compressed_text, input);
});

test("accounting retains the existing lexical counter including blank lines", () => {
  const input = "abcdefghij ".repeat(1000);
  assert.equal(compress(input).original_tokens, 1000);
  assert.equal(compress("abc\n\n日本語 42").original_tokens, 7);
});

test("inline angle-bracket references do not collapse prose or Markdown sections", () => {
  for (const reference of ["<https://example.test/guide>", "<help@example.com>", "`vector<entry>`", "`left < right && right > zero`", "an inline <em>example</em>"]) {
    for (const heading of ["", "## "]) {
      const sections = Array.from({ length: 18 }, (_, index) => `${heading}Topic ${index}\n  Independent explanation for topic ${index}.\n`);
      sections[2] += `  Reference: ${reference}\n`;
      sections[11] += "  target_cedar has a unique documented behavior.\n";
      const input = sections.join("\n");
      assert.ok(unitsFor(input).length >= 18, reference);
      const output = compress(input, "Explain target_cedar");
      assert.equal(output.selection_reason, "query_anchored_extraction", reference);
      assert.ok(output.compressed_text.includes("target_cedar has a unique documented behavior."));
      assert.ok(output.compressed_text.length < input.length / 2);
    }
  }
});

test("fenced structured examples stay local and whole in mixed documents", () => {
  const examples = [
    ["json", '{\n  "target_cedar": {\n    "enabled": false\n  }\n}'],
    ["xml", '<root>\n  <target_cedar enabled="false"/>\n</root>'],
    ["js", "function target_cedar() {\n  return false;\n}"],
    ["sql", "BEGIN TRANSACTION;\nUPDATE target_cedar SET enabled=false;\nCOMMIT;"],
    ["sql", "SELECT target_cedar\nFROM settings\nWHERE enabled=false;"],
    ["cpp", "#include <example.hpp>\nconst auto target_cedar = load_settings();"],
    ["diff", "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+target_cedar"],
  ];
  for (const [language, body] of examples) {
    for (const fence of ["```", "~~~~"]) {
      for (const heading of ["", "## "]) {
        const example = `${fence}${language}\n${body}\n${fence}`;
        const sections = Array.from({ length: 18 }, (_, index) => `${heading}Topic ${index}\n  Independent descriptive material ${index}.\n`);
        sections[9] += `${example}\n`;
        const input = sections.join("\n");
        assert.ok(unitsFor(input).some((unit) => unit.includes(example)), language);
        const output = compress(input, "Explain target_cedar");
        assert.equal(output.selection_reason, "query_anchored_extraction", language);
        assert.ok(output.compressed_text.includes(example), language);
        assert.ok(output.compressed_text.length < input.length / 2);
      }
    }
  }
});

test("indented prose splits only at paragraph boundaries and retains continuation lines", () => {
  for (const indent of ["   ", "      ", "\t"]) {
    for (const newline of ["\n", "\r\n"]) {
      const paragraphs = Array.from({ length: 20 }, (_, index) =>
        `${indent}Topic ${index} describes independent behavior.${newline}${indent}Its continuation supplies necessary context.`);
      paragraphs[12] = `${indent}target_cedar requires a fresh identifier.${newline}${indent}Otherwise it must reject the operation.`;
      const input = paragraphs.join(`${newline}${newline}`);
      const units = unitsFor(input);
      assert.equal(units.length, paragraphs.length);
      assert.equal(units.join("\n"), input);
      const output = compress(input, "Explain target_cedar");
      assert.ok(output.compressed_text.includes(paragraphs[12]));
      assert.ok(output.compressed_text.length < input.length / 2);
    }
  }
});

test("only a matching bare fence closes an example, including nested fence syntax", () => {
  for (const [opening, closing] of [["````", "`````"], ["~~~~", "~~~~"]]) {
    const example = `${opening}markdown\n\`\`\`js\nfunction target_cedar() {\n  return false;\n}\n\`\`\`\n${opening}not-a-closer\n## inside the example\n${closing}`;
    const input = `## Before\nProse.\n## Example\n${example}\n## After\nMore prose.`;
    assert.equal(unitsFor(input).length, 3);
    assert.ok(unitsFor(input)[1].includes(example));
  }
});

test("unfenced structured dependencies remain intact despite blank lines and headings", () => {
  for (const input of [
    '<root>\n\n<section>target_cedar</section>\n## not a prose heading\n</root>',
    'An embedded XML block: <root>\n\ntarget_cedar\n\n</root>',
    '{\n"target_cedar": {\n\n"enabled": false\n}\n}',
    'function target_cedar() {\n\n  return false;\n}\n\ninvoke(target_cedar);',
    'BEGIN;\n\nUPDATE target_cedar SET enabled=false;\n\nCOMMIT;',
    'WITH source AS (SELECT * FROM settings)\n\nSELECT target_cedar\nFROM source\nWHERE enabled=false;',
    'SELECT target_cedar\n\nFROM settings\nWHERE enabled=false;',
    'const settings = load_settings();\n\nconst target_cedar = settings.value;',
    '#include <example.hpp>\n\n#define target_cedar VALUE\n\nuse(target_cedar);',
  ]) {
    assert.deepEqual(unitsFor(input), [input]);
    assert.equal(compress(input, "target_cedar").compressed_text, input);
  }
  const diff = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+target_cedar\n\n## still diff evidence';
  assert.ok(unitsFor(`## Preamble\nintro\n${diff}`).some((unit) => unit.includes(diff)));
  const fencedDiff = `${diff}\n\`\`\`\n## still part of the patch\n\`\`\`\n## trailing patch evidence`;
  for (const prefix of ["intro\n", "## Preamble\nintro\n"]) {
    assert.ok(unitsFor(prefix + fencedDiff).some((unit) => unit.includes(fencedDiff)));
  }
});

test("factual quantity and limit questions are not automatically global queries", () => {
  for (const [query, fact] of [
    ["What is the maximum payload for target_cedar?", "target_cedar maximum payload is determined by its transport."],
    ["How many random bits does target_cedar require?", "target_cedar requires a fresh source of random bits."],
    ["What is the minimum length for target_cedar?", "target_cedar minimum length is specified by its configuration."],
    ["How many bytes does target_cedar contain?", "target_cedar contains a fixed number of bytes."],
    ["How many characters does target_cedar support?", "target_cedar supports a configurable number of characters."],
    ["What is the maximum width for target_cedar?", "target_cedar maximum width is determined by its container."],
  ]) {
    const rows = Array.from({ length: 40 }, (_, index) => `Topic ${index} describes unrelated behavior.`);
    rows[23] = fact;
    const input = rows.join("\n");
    const output = compress(input, query);
    assert.equal(output.selection_reason, "query_anchored_extraction", query);
    assert.ok(output.compressed_text.includes(fact));
    assert.ok(output.compressed_text.length < input.length / 2);
  }
});

test("quantity, extrema and exhaustive record queries still require global evidence", () => {
  const input = Array.from({ length: 40 }, (_, index) => `record_${index} target_cedar amount=${index}`).join("\n");
  for (const query of ["How many target_cedar records exist?", "What is the maximum value for target_cedar?",
    "How many target_cedar failures happened?", "How many target_cedar widgets exist?", "Maximum amount for target_cedar",
    "Minimum target_cedar across observations", "Maximum target_cedar among candidates",
    "Maximum target_cedar in the dataset", "List all target_cedar records", "Summarize each target_cedar entry",
    "Total target_cedar amount", "Compare target_cedar records", "Average target_cedar amount"]) {
    const output = compress(input, query);
    assert.equal(output.selection_reason, "global_evidence_required", query);
    assert.equal(output.compressed_text, input);
  }
});

test("chat role labels are not mistaken for Markdown reference definitions", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `[user]: filler status update ${index}`);
  rows[8] = "[assistant]: acknowledged";
  rows[22] = "[user]: root cause is expired signing key KEY-441";
  rows[30] = "[tool]: lookup ok";
  const input = rows.join("\n");
  assert.notEqual(documentFor(input).preservationReason, "cross_reference_dependency");
  const output = compress(input, "What is the root cause key?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("KEY-441"));
  assert.ok(output.compressed_text.includes("expired signing key"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("real Markdown reference definitions still force dependency preservation", () => {
  const input = "# Doc\nSee [config][].\n\n[config]: #setup\n\n## setup\nUse KEY-441 here.\n## other\nNoise.\n";
  const output = compress(input, "Where is KEY-441?");
  assert.equal(output.selection_reason, "cross_reference_dependency");
  assert.equal(output.compressed_text, input);
});

test("transitive identifier chains keep alert location asset and action lines", () => {
  const rows = Array.from({ length: 60 }, (_, index) => `telemetry_${index} ok`);
  rows[20] = "ALERT probe TEMP_SPIKE on shelf-A";
  rows[21] = "map: shelf-A lives in bay-7";
  rows[22] = "asset PLT-77B stored at bay-7";
  rows[23] = "Action: quarantine bay-7, page on-call Lena Park";
  const input = rows.join("\n");
  const output = compress(input, "What alert fired and what should we do?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  for (const needle of ["TEMP_SPIKE", "shelf-A", "bay-7", "PLT-77B", "quarantine", "Lena Park"]) {
    assert.ok(output.compressed_text.includes(needle), needle);
  }
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("pytest failure clusters keep assertion and E-frame lines beyond one neighbor", () => {
  const rows = Array.from({ length: 80 }, (_, index) => `PASSED tests/case_${index}.py`);
  rows[40] = "FAILED tests/billing/test_fx.py::test_round";
  rows[41] = "AssertionError: expected 10.02 got 10.03";
  rows[42] = "E   assert 10.03 == 10.02";
  rows[43] = "E   at ledger/fx.py:127";
  const input = rows.join("\n");
  const output = compress(input, "Why did the billing fx test fail?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("FAILED"));
  assert.ok(output.compressed_text.includes("AssertionError"));
  assert.ok(output.compressed_text.includes("ledger/fx.py:127"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("multi-file diffs unitize per file and can drop unrelated hunks", () => {
  const files = ["alpha", "beta", "gamma", "delta"].map((name, index) => [
    `diff --git a/src/${name}.ts b/src/${name}.ts`,
    `--- a/src/${name}.ts`,
    `+++ b/src/${name}.ts`,
    "@@ -1,3 +1,3 @@",
    `-export const ${name} = ${index};`,
    `+export const ${name} = ${index + 10};`,
  ].join("\n"));
  files[2] = [
    "diff --git a/src/payments.ts b/src/payments.ts",
    "--- a/src/payments.ts",
    "+++ b/src/payments.ts",
    "@@ -1,3 +1,3 @@",
    "-export const currency = 'USD';",
    "+export const currency = 'EUR';",
  ].join("\n");
  const input = files.join("\n");
  assert.ok(unitsFor(input).length >= 4);
  const output = compress(input, "What currency change landed in payments.ts?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("EUR"));
  assert.ok(output.compressed_text.includes("payments.ts"));
  assert.ok(!output.compressed_text.includes("gamma") || output.compressed_text.length < input.length);
  assert.ok(output.compressed_text.length < input.length);
});

test("multi-array JSON objects expose records from every eligible array", () => {
  const users = Array.from({ length: 8 }, (_, index) => ({ id: `u${index}`, name: `User ${index}` }));
  const orders = Array.from({ length: 8 }, (_, index) => ({ id: `ord_${index}`, total: index * 10 }));
  orders[5] = { id: "ord_9F2A", total: 1288.4, email: "priya@example.com" };
  const input = JSON.stringify({ users, orders });
  const doc = documentFor(input);
  assert.ok(doc.units.length >= 8);
  const output = compress(input, "What email and total are on order ord_9F2A?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("ord_9F2A"));
  assert.ok(output.compressed_text.includes("priya@example.com"));
  assert.ok(output.compressed_text.includes("1288.4"));
  assert.doesNotThrow(() => JSON.parse(output.compressed_text));
  assert.ok(output.compressed_text.length < input.length);
});

test("parser units map monotonically to contiguous exact source substrings", () => {
  const inputs = [
    "same\nother\nsame\nlast",
    "\n   First paragraph.\n   Its continuation.\n\n   Second paragraph.\n\n   First paragraph.\n   Its continuation.\n",
    "# Guide\nScope.\n## Links\nSee <https://example.test> or <help@example.com>.\n## Code\n```js\nconst value = false;\n```\n## End\nDone.\n",
    'name,notes\nfirst,"multiline\nrecord"\nsecond,plain\n',
    "services:\n  first:\n    enabled: false\n\n  second:\n    enabled: true\n",
    "Intro\n\n```xml\n<root>\n<child/>\n</root>\n```\nTail\n",
    "Intro\ndiff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
    '{\n"value": false\n}',
    "",
  ];
  for (const input of inputs) {
    for (const context of [input, input.replaceAll("\n", "\r\n")]) {
      let cursor = 0;
      for (const unit of unitsFor(context)) {
        const start = context.indexOf(unit, cursor);
        assert.ok(start >= cursor, "unit must occur exactly at or after the prior source range");
        assert.match(context.slice(cursor, start), /^\n*$/, "only separator newlines may lie between units");
        cursor = start + unit.length;
        assert.equal(context.slice(start, cursor), unit);
      }
      assert.match(context.slice(cursor), /^\n*$/);
    }
  }
});

test("multi-turn proxy chat dumps extract mid-thread answers (not cross_reference atomic)", () => {
  // Organic agent/proxy transcript: bracketed roles must not be treated as Markdown link refs.
  const turns = Array.from({ length: 48 }, (_, index) =>
    index % 2 === 0
      ? `[user]: routine follow-up about batch ${index}`
      : `[assistant]: acknowledged batch ${index}; no special action`);
  turns[19] = "[assistant]: The vault passphrase for project cedar is maple-orchid-77.";
  turns[20] = "[user]: thanks — please confirm once more later";
  const input = turns.join("\n");
  assert.ok(unitsFor(input).length >= 20, "chat turns must split into many units");
  assert.notEqual(documentFor(input).preservationReason, "cross_reference_dependency");
  const output = compress(input, "What is the vault passphrase for project cedar?");
  assert.notEqual(output.selection_reason, "cross_reference_dependency");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("maple-orchid-77"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("real Markdown link-reference definitions stay atomic and preserved", () => {
  const input = [
    "# Operator handbook",
    "Scope applies to all releases.",
    "## Setup",
    "Initialize the control plane first.",
    "## Deploy cedar",
    "Follow [setup][config] before running release --production.",
    "[config]: #setup",
    "## Notes",
    "Routine background material.",
  ].join("\n");
  assert.deepEqual(unitsFor(input), [input]);
  assert.equal(documentFor(input).preservationReason, "cross_reference_dependency");
  const output = compress(input, "How do I deploy cedar?");
  assert.equal(output.compressed_text, input);
  assert.equal(output.selection_reason, "cross_reference_dependency");
});

test("transitive warehouse ID chain keeps ALERT, shelf map, PLT id, and quarantine action", () => {
  const rows = Array.from({ length: 24 }, (_, index) => `INFO warehouse telemetry tick=${index} ok`);
  rows[4] = "ALERT cold-chain breach detected on shelf-A";
  rows[9] = "shelf-A maps to pallet PLT-8841 in bay-7";
  rows[14] = "PLT-8841 current status = hold_for_inspection";
  rows[19] = "Action: quarantine PLT-8841 and notify dock-3 supervisor";
  const input = rows.join("\n");
  const output = compress(input, "What action followed the cold-chain ALERT on shelf-A?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  // Engine must_keep every hop of the identifier chain after compress.
  assert.ok(output.compressed_text.includes("ALERT"));
  assert.ok(output.compressed_text.includes("shelf-A"));
  assert.ok(output.compressed_text.includes("PLT-8841"));
  assert.ok(output.compressed_text.includes("quarantine"));
  assert.ok(output.compressed_text.length < input.length);
});

test("pytest failure blocks keep FAILED, AssertionError, and E traceback two lines below", () => {
  const rows = Array.from({ length: 60 }, (_, index) => `INFO pytest collection noise ${index}`);
  rows[33] = "FAILED tests/test_billing.py::test_refund_path - AssertionError";
  rows[34] = "AssertionError: expected status 200, got 402";
  rows[35] = "    assert response.status_code == 200";
  rows[36] = "E   at path.py:12";
  const input = rows.join("\n");
  const output = compress(input, "Why did the billing refund test fail?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("FAILED tests/test_billing.py::test_refund_path"));
  assert.ok(output.compressed_text.includes("AssertionError: expected status 200, got 402"));
  // Engine should keep the pytest `E` line two lines below AssertionError (failure block closure).
  assert.ok(output.compressed_text.includes("E   at path.py:12"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("multi-file unified diffs keep the queried file hunk and drop other file hunks", () => {
  const hunks = [
    [
      "diff --git a/src/alpha.js b/src/alpha.js",
      "--- a/src/alpha.js",
      "+++ b/src/alpha.js",
      "@@ -1,3 +1,3 @@",
      "-old alpha",
      "+new alpha",
    ].join("\n"),
    [
      "diff --git a/src/billing.js b/src/billing.js",
      "--- a/src/billing.js",
      "+++ b/src/billing.js",
      "@@ -10,3 +10,4 @@",
      " function charge() {",
      '+  applyCoupon("SAVE20");',
      "   return true;",
      " }",
    ].join("\n"),
    [
      "diff --git a/src/gamma.js b/src/gamma.js",
      "--- a/src/gamma.js",
      "+++ b/src/gamma.js",
      "@@ -1,2 +1,2 @@",
      "-old gamma",
      "+new gamma",
    ].join("\n"),
    [
      "diff --git a/src/delta.js b/src/delta.js",
      "--- a/src/delta.js",
      "+++ b/src/delta.js",
      "@@ -1,2 +1,2 @@",
      "-old delta",
      "+new delta",
    ].join("\n"),
  ];
  const input = `patch preamble\n${hunks.join("\n")}\ntrailing note\n`;
  assert.ok(unitsFor(input).length >= 4, "each file hunk should be its own unit");
  const output = compress(input, "What coupon did billing.js add?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes('applyCoupon("SAVE20")'));
  assert.ok(output.compressed_text.includes("billing.js"));
  // Engine should drop non-matching file hunks (not only far ones — adjacent too).
  assert.ok(!output.compressed_text.includes("alpha.js"));
  assert.ok(!output.compressed_text.includes("gamma.js"));
  assert.ok(!output.compressed_text.includes("delta.js"));
  assert.ok(output.compressed_text.length < input.length);
});

test("JSON objects with sibling users[] and orders[] extract the queried order record", () => {
  const users = Array.from({ length: 8 }, (_, index) => ({ id: `user_${index}`, name: `Person ${index}` }));
  const orders = Array.from({ length: 8 }, (_, index) => ({ id: `ord_${index}`, amount: index * 10, sku: `sku_${index}` }));
  orders[5] = { id: "ord_needle_91", amount: 440, sku: "SKU-QUARTZ" };
  const input = JSON.stringify({ users, orders, meta: { page: 1 } });
  const document = documentFor(input);
  assert.ok(document.units.length >= 12, "both arrays should yield extractable record units");
  const output = compress(input, "Which order is ord_needle_91?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("ord_needle_91"));
  assert.ok(output.compressed_text.includes("SKU-QUARTZ"));
  assert.ok(output.compressed_text.length < input.length / 2);
  const parsed = JSON.parse(output.compressed_text);
  assert.ok(parsed.orders.some((order) => order.id === "ord_needle_91"));
  // Engine should drop the unrelated users[] peers when the query only names an order id.
  assert.ok((parsed.users?.length || 0) < users.length);
  assert.ok(parsed.orders.length < orders.length);
});

test("nested cart.items arrays unitize even when buried under an object field", () => {
  const users = Array.from({ length: 6 }, (_, index) => ({ id: `u${index}`, name: `N${index}` }));
  const items = Array.from({ length: 6 }, (_, index) => ({ sku: `sku_${index}`, qty: index + 1 }));
  items[4] = { sku: "SKU-NEST-77", qty: 12, note: "priority restock" };
  const input = JSON.stringify({ meta: { page: 1 }, users, cart: { currency: "USD", items } });
  const document = documentFor(input);
  assert.ok(document.units.length >= 10, "nested items[] plus users[] should unitize");
  const output = compress(input, "Which cart line is SKU-NEST-77?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("SKU-NEST-77"));
  assert.ok(output.compressed_text.includes("priority restock"));
  const parsed = JSON.parse(output.compressed_text);
  assert.ok(parsed.cart.items.some((item) => item.sku === "SKU-NEST-77"));
  assert.ok(parsed.cart.items.length < items.length);
});

test("paraphrase bridges reach sealed/radiation facts while dropping synonym bait", () => {
  const rows = Array.from({ length: 24 }, (_, index) => `## Harbor bulletin ${2000 + index}\nRoutine crane calibration completed for gantry-${index}.`);
  rows[6] = "## Synonym bait (WRONG — ignore)\nIgnore: box still locked after abnormally high ionizing reading is crate ZZ-0001 at 9 microsieverts (WRONG).";
  rows[12] = "## Confirmed pier fact\nQUARANTINE FLAG: container BX-7719 remains sealed due to elevated radiation scan of 42 microsieverts.";
  rows[18] = "## Synonym bait (WRONG2 — ignore)\nIgnore: box still locked after abnormally high ionizing reading is crate ZZ-0001 at 9 microsieverts (WRONG2).";
  const input = rows.join("\n\n");
  const output = compress(input, "Identify the box still locked after an abnormally high ionizing reading, and report that measurement.");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("BX-7719"));
  assert.ok(output.compressed_text.includes("42 microsieverts"));
  assert.ok(output.compressed_text.includes("sealed"));
  assert.ok(!output.compressed_text.includes("ZZ-0001"));
  assert.ok(!output.compressed_text.includes("Synonym bait"));
});

test("entities that only appear inside bait blocks drop decoys but keep the real ledger", () => {
  const rows = Array.from({ length: 20 }, (_, index) => `## Catalog entry ${index}\nCommodity hemp rope stored in warehouse W-${index % 3}.\nLot fingerprint FP-${index.toString(16)}pad.`);
  rows[5] = "## Aerospace bait cluster\nRKT-ORBIT-7000 and SAT-X-0 are NOT in the harbor inventory — bait only.\nCEO home address rumors for Brass Lantern Labs are fabricated in this bait block.";
  rows[14] = "## Quiet inventory ledger LEDGER-90000\nFingerprint FPKEEP-01199E marks sealed crate of flax sailcloth.";
  const input = rows.join("\n\n");
  const output = compress(input, "What is the launch window for rocket RKT-ORBIT-7000 from this document?");
  assert.ok(
    output.selection_reason === "entity_absent_extraction"
      || output.selection_reason === "entity_absent_passthrough"
  );
  assert.ok(output.compressed_text.includes("FPKEEP-01199E"));
  assert.ok(output.compressed_text.includes("flax sailcloth"));
  assert.ok(output.compressed_text.includes("LEDGER-90000"));
  // Decoy aerospace block should be dropped when extraction succeeds.
  if (output.selection_reason === "entity_absent_extraction") {
    assert.ok(!output.compressed_text.includes("Aerospace bait"));
    assert.ok(output.compressed_text.length < input.length);
  }
});

test("non-MIT contrast keeps the minority license record without refilling MIT peers", () => {
  const packages = {};
  for (let index = 0; index < 20; index += 1) {
    packages[`node_modules/pkg-${index}`] = {
      version: `${index}.0.0`,
      license: "MIT",
      resolved: `https://registry.npmjs.org/pkg-${index}/-/${index}.tgz`,
    };
  }
  packages["node_modules/odd-lib"] = {
    version: "2.1.0",
    license: "GPL-3.0",
    resolved: "https://registry.npmjs.org/odd-lib/-/odd-lib-2.1.0.tgz",
  };
  for (const wrapper of [
    { packages },
    { name: "app", lockfileVersion: 3, packages },
  ]) {
    const input = JSON.stringify(wrapper, null, 2);
    assert.ok(documentFor(input).units.length >= 16, "package map should unitize per dependency");
    const output = compress(input, "Which dependency has a non-MIT license? Name the package, its version, and the license.");
    assert.equal(output.selection_reason, "query_anchored_extraction");
    assert.ok(output.compressed_text.includes("odd-lib"));
    assert.ok(output.compressed_text.includes("GPL-3.0"));
    assert.ok(output.compressed_text.includes("2.1.0"));
    // Outlier-driven fill must not keep a swarm of MIT peers.
    assert.ok((output.compressed_text.match(/"license": "MIT"/g) || []).length <= 2);
    assert.ok(output.compressed_text.length < input.length / 4);
  }
});

test("GraphQL hash comments are not treated as Markdown H1 section anchors", () => {
  const blocks = [];
  for (let index = 0; index < 24; index += 1) {
    blocks.push(`type NoiseType${index} {\n  id: ID!\n  note: String\n}\n\nextend type Query {\n  noise${index}(id: ID!): NoiseType${index}\n}`);
  }
  blocks[10] = [
    "type HadalCast0 {",
    "  id: ID!",
    "  cableId: String!",
    "}",
    "",
    "extend type Query {",
    '  """Authoritative pressure read."""',
    "  castPressure0(castId: ID!): HadalCast0",
    "}",
    "",
    "# resolver note: castPressure0 reads CBL-GQL-9400 at Canyon-Vellum",
  ].join("\n");
  blocks[18] = [
    "extend type Query {",
    "  castPressure0Fake(castId: ID!): MythCast",
    "}",
    "# resolver note: ignore CBL-GQL-FAKE-0",
  ].join("\n");
  const input = blocks.join("\n\n");
  const output = compress(
    input,
    "Which GraphQL query field returns type HadalCast0, and which cable id does the resolver note mention?"
  );
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("castPressure0"));
  assert.ok(output.compressed_text.includes("CBL-GQL-9400"));
  assert.ok(output.compressed_text.includes("HadalCast0"));
  // Hash comments must not expand into a whole-schema section keep.
  assert.ok((output.compressed_text.match(/type NoiseType/g) || []).length <= 2);
  assert.ok(output.compressed_text.length < input.length / 3);
});

test("peer-tag ID asides do not coref-expand attribute facts across every bulletin", () => {
  const rows = Array.from({ length: 18 }, (_, index) => (
    `## Mesa bulletin ${3000 + index}\nRoutine kiln calibration completed for mount-${index}; peer tag OX-5510 noted without pigment.`
  ));
  rows[9] = "## Confirmed kiln fact\nFILTER CARD: optic tube OX-5510 uses pigment cerulean with capacity 18 litres for coolant.";
  rows[3] = "## Synonym bait (WRONG — ignore)\nIgnore: hue and volume for decoy tube ZZ-9 is scarlet at 2 litres (WRONG).";
  const input = rows.join("\n\n");
  const output = compress(input, "What hue and volume figure does OX-5510 list for its coolant?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("OX-5510"));
  assert.ok(output.compressed_text.includes("cerulean"));
  assert.ok(output.compressed_text.includes("18 litres"));
  assert.ok(!output.compressed_text.includes("Synonym bait"));
  assert.ok((output.compressed_text.match(/## Mesa bulletin/g) || []).length <= 2);
  assert.ok(output.compressed_text.length < input.length / 3);
});

test("class-named queries keep the Java unit and drop same-id Python/Go peers", () => {
  const blocks = [];
  for (let index = 0; index < 8; index += 1) {
    blocks.push(`def compute_tariff_${index}(code: str) -> float:\n    if code == "TRF-MESA-4200":\n        return 0.12\n    return 0.0`);
    blocks.push(`public class ComputeTariff${index} {\n  public static double rate(String code) {\n    if ("TRF-MESA-4200".equals(code)) return 0.12;\n    return 0.0;\n  }\n}`);
    blocks.push(`func ComputeTariffGo${index}(code string) float64 {\n  if code == "TRF-MESA-4200" { return 0.12 }\n  return 0.0\n}`);
  }
  const input = blocks.join("\n\n");
  const output = compress(input, "In class ComputeTariff3, what rate is returned for code TRF-MESA-4200?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("class ComputeTariff3"));
  assert.ok(output.compressed_text.includes("0.12"));
  assert.ok(!output.compressed_text.includes("def compute_tariff_3"));
  assert.ok(!output.compressed_text.includes("ComputeTariffGo3"));
});

test("SQL dumps keep the rare event INSERT without filling every INSERT INTO stub", () => {
  const rows = [];
  for (let index = 0; index < 40; index += 1) {
    rows.push(`-- INSERT INTO noise_log_${1000 + index} VALUES (${1000 + index}, 'filler-${index}'); -- commented stub`);
    rows.push(`-- prose note ${index}: ordinary survey chatter without the target code.`);
  }
  rows[22] = "-- ### Incident narrative for EVT-GLAC-3400";
  rows[23] = "CREATE TABLE obs_events_6200 (id INTEGER PRIMARY KEY, event_code TEXT, magnitude REAL, site TEXT);";
  rows[24] = "INSERT INTO obs_events_6200 (id, event_code, magnitude, site) VALUES (8800, 'EVT-GLAC-3400', 2.40, 'Ridge-Alpha');";
  rows[25] = "INSERT INTO obs_events_6200 (id, event_code, magnitude, site) VALUES (8801, 'EVT-NOISE-0', 0.1, 'Ridge-Beta');";
  const input = rows.join("\n");
  const output = compress(input, "For event EVT-GLAC-3400, what magnitude and site appear in the INSERT into obs_events_6200?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("EVT-GLAC-3400"));
  assert.ok(output.compressed_text.includes("2.40"));
  assert.ok(output.compressed_text.includes("Ridge-Alpha"));
  assert.ok(output.compressed_text.includes("obs_events_6200"));
  // Schema glue must not pull every commented INSERT stub.
  assert.ok((output.compressed_text.match(/INSERT INTO/gi) || []).length <= 3);
  assert.ok(output.compressed_text.length < input.length / 3);
});

test("prose continuations keep hull IDs after the authoritative constant line", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `% filler paragraph ${index}: ordinary keel chatter without spring constants.`);
  rows[18] = "The authoritative docking spring constant is \\kappa_{\\mathrm{orb}}^{8} = 3.30\\,\\mathrm{kN/m}";
  rows[19] = "for hull HULL-ORB-220 in Bay-L5s.";
  rows[20] = "% Ignore: spring constant 9.99 kN/m for decoy (WRONG — ignore)";
  const input = rows.join("\n");
  const output = compress(input, "What is the authoritative docking spring constant value (kN/m) for this keel section?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("3.30"));
  assert.ok(output.compressed_text.includes("kN/m"));
  assert.ok(output.compressed_text.includes("HULL-ORB-220"));
  assert.ok(!output.compressed_text.includes("9.99"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("# Ignore bait comments are not Markdown H1 roots that keep every peer table", () => {
  const rows = Array.from({ length: 16 }, (_, index) => (
    `## Canopy log ${index}\nOrdinary glasshouse chatter near House-Dome.`
  ));
  rows[4] = "# Ignore: lot LOT-GLS-110 radiation 9.99 μSv/h (WRONG — ignore)\nFake canopy note.";
  rows[9] = "## Authoritative vault card\nLot LOT-GLS-110 reports sealed radiation 1.25 μSv/h (authoritative).";
  const input = rows.join("\n\n");
  const output = compress(input, "What sealed radiation reading does LOT-GLS-110 report?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("1.25"));
  assert.ok(output.compressed_text.includes("LOT-GLS-110"));
  assert.ok(!output.compressed_text.includes("9.99"));
  assert.ok((output.compressed_text.match(/## Canopy log/g) || []).length <= 2);
});

test("TOML tables unitize per [section] and drop decoy storage peers", () => {
  const tables = [];
  for (let index = 0; index < 20; index += 1) {
    tables.push(`[noise.table_${index}]\nlabel = "chatter-${index}"\nhumidity = ${40 + index}\n`);
  }
  tables[8] = [
    "[seed.vault_0]",
    'strain = "STR-GLS-71"',
    "storage_c = -18.0",
    'lot = "LOT-GLS-110"',
    'note = "authoritative cold-store target"',
    "",
  ].join("\n");
  tables[9] = [
    "# Ignore: seed.vault_0 storage_c = 9.9 (WRONG — ignore)",
    "[seed.vault_0_decoy]",
    'strain = "STR-FAKE-0"',
    "storage_c = 9.9",
    "",
  ].join("\n");
  const input = tables.join("\n");
  assert.ok(unitsFor(input).length >= 12);
  const output = compress(input, "What storage_c value does [seed.vault_0] list for strain STR-GLS-71?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("-18.0"));
  assert.ok(output.compressed_text.includes("LOT-GLS-110"));
  assert.ok(!output.compressed_text.includes("9.9"));
  assert.ok(output.compressed_text.length < input.length / 3);
});

test("OpenAPI path maps unitize per /path key", () => {
  const paths = ["openapi: 3.0.3", "paths:"];
  for (let index = 0; index < 16; index += 1) {
    paths.push(`  /noise/path_${index}:`, "    get:", `      operationId: noiseGet${index}`, '      responses:', '        "200":', "          description: ok", "");
  }
  paths.push(
    "  /v2/strains/str-gls-71/lots:",
    "    get:",
    "      operationId: listLotsGlass0",
    "      x-lot: LOT-GLS-110",
    "      responses:",
    '        "200":',
    "          description: success",
    "",
  );
  const input = paths.join("\n");
  assert.ok(unitsFor(input).length >= 12);
  const output = compress(input, "What operationId is defined for /v2/strains/str-gls-71/lots?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("listLotsGlass0"));
  assert.ok(output.compressed_text.includes("LOT-GLS-110"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("XML scrap peers unitize so query-anchored parts cut filler assemblies", () => {
  const scraps = [];
  for (let index = 0; index < 24; index += 1) {
    scraps.push(`<scrap id="s${index}">\n  <note>ordinary berth chatter ${index}</note>\n  <mass>1.${index}</mass>\n</scrap>`);
  }
  scraps[11] = [
    '<scrap id="s11">',
    '  <part id="PART-ORB-7300">',
    "    <mass>12.50</mass>",
    "    <hull>HULL-ORB-220</hull>",
    "  </part>",
    "</scrap>",
  ].join("\n");
  const input = `<?xml version="1.0"?>\n<shipyard>\n${scraps.join("\n")}\n</shipyard>\n`;
  assert.ok(unitsFor(input).length >= 12);
  const output = compress(input, "What mass and hull id does PART-ORB-7300 list?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("PART-ORB-7300"));
  assert.ok(output.compressed_text.includes("12.50"));
  assert.ok(output.compressed_text.includes("HULL-ORB-220"));
  assert.ok(output.compressed_text.length < input.length / 3);
});

test("identifier tokens containing DISTRACTOR are not treated as bait units", () => {
  const rows = Array.from({ length: 16 }, (_, index) => (
    `## Yard report section ${index}\nProse: inspectors walked aisle ${index}.\nshift_id,operator,berth,pallets,delay_min\nS${1000 + index},Op${index},Berth-Delta,${10 + index},${index}`
  ));
  rows[7] = [
    "## Yard report section 7",
    "### Incident narrative S-HBR-9000",
    "Prose: During S-HBR-9000, Remy Duarte reported a conveyor jam at Berth-Gamma.",
    "shift_id,operator,berth,pallets,delay_min",
    "S-HBR-9000,Remy_Duarte,Berth-Gamma,120,45",
    "S-DISTRACTOR-1,Cassian_Vale,Berth-Delta,12,3",
  ].join("\n");
  const input = rows.join("\n\n");
  assert.ok(documentFor(input).units.length >= 8);
  const output = compress(input, "For shift S-HBR-9000, what were delay_min, pallets, and which operator is named?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("S-HBR-9000"));
  assert.ok(output.compressed_text.includes("Remy_Duarte"));
  assert.ok(output.compressed_text.includes("120"));
  assert.ok(output.compressed_text.includes("45"));
  // Peer rows should be droppable once the shift id anchors.
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("fenced CSV tables inside markdown explode into row units", () => {
  const rows = Array.from({ length: 40 }, (_, index) => `SKU-${index},BIN-${index},${index}`);
  rows[22] = "SKU-NEEDLE-9,BIN-Z7,4";
  const input = [
    "# Ops notebook",
    "",
    "## Inventory extract",
    "```",
    "sku,bin,qty",
    ...rows,
    "```",
    "```js",
    "function noise() { return 1; }",
    "```",
  ].join("\n");
  const units = unitsFor(input);
  assert.ok(units.length >= 30, `expected row units, got ${units.length}`);
  assert.ok(units.some((unit) => unit.trim() === "SKU-NEEDLE-9,BIN-Z7,4"));
  const output = compress(input, "Which bin holds SKU-NEEDLE-9?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("BIN-Z7"));
  assert.ok(output.compressed_text.length < input.length / 5);
  assert.ok(!output.compressed_text.includes("function noise"));
});

test("peer single-line INSERT dumps unitize per statement", () => {
  const rows = Array.from(
    { length: 30 },
    (_, index) => `INSERT INTO orders (id, sku) VALUES (${index}, 'SKU-${index}');`
  );
  rows[17] = "INSERT INTO orders (id, sku) VALUES (99, 'SKU-NEEDLE-X');";
  const input = rows.join("\n");
  const units = unitsFor(input);
  assert.ok(units.length >= 20, `expected line units, got ${units.length}`);
  const output = compress(input, "Which sku is on order id 99?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("SKU-NEEDLE-X"));
  assert.ok((output.compressed_text.match(/INSERT INTO/gi) || []).length <= 3);
  assert.ok(output.compressed_text.length < input.length / 4);
});

test("Sentry event metadata stays with the ERROR stack cluster", () => {
  const lines = Array.from({ length: 40 }, (_, index) => `INFO req_id=r${index} GET /health 200`);
  lines.push(
    "ERROR uncaughtException request_id=req_abc",
    "TypeError: Cannot read properties of undefined (reading 'customerId')",
    "    at resolveCheckout (/app/api/billing.js:218:21)",
    "Sentry Event ID: deadbeefcafebabe0123456789abcdef",
    "Release: payments-api@1.0.0",
    "Environment: production",
  );
  const input = lines.join("\n");
  const output = compress(input, "What Sentry event id fired for req_abc?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("deadbeefcafebabe0123456789abcdef"));
  assert.ok(output.compressed_text.includes("billing.js:218"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("agent chat tool_result labels do not freeze the whole transcript", () => {
  const rounds = [];
  for (let index = 0; index < 20; index += 1) {
    rounds.push(`[user]: check file ${index}`, `[assistant]: reading`, `[tool]: read_file`, `[tool_result]: noise ${index}`);
  }
  rounds.push(
    "[user]: portal for cus_TEST?",
    "[assistant]: found it",
    "[tool_result]: portal_url https://billing.stripe.com/p/session/test_CANDID",
  );
  const input = rounds.join("\n");
  assert.ok(unitsFor(input).length >= 10);
  const output = compress(input, "What Stripe portal URL is for cus_TEST?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("https://billing.stripe.com/p/session/test_CANDID"));
  assert.ok(output.compressed_text.length < input.length / 2);
});

test("tight coref does not merge rival ALERT chains via ambient camera ids", () => {
  const lines = [];
  for (let index = 0; index < 40; index += 1) {
    lines.push(`INFO warehouse tick=${index} ok`);
  }
  lines.push(
    "ALERT ALERT-SH-41 shelf=SH-AAA0 severity=HIGH",
    "SH-AAA0 maps to asset AST-1000 in bay-3",
    "AST-1000 last_seen=camera-7 operator=nova",
    "action required: quarantine-keep-0 for AST-1000 immediately",
    "ALERT ALERT-SH-77 shelf=SH-BBB1 severity=HIGH",
    "SH-BBB1 maps to asset AST-2000 in bay-4",
    "AST-2000 last_seen=camera-7 operator=orion",
    "action required: quarantine-DROP-9 for AST-2000 immediately",
  );
  const input = lines.join("\n");
  const output = compress(input, "What action is required for ALERT-SH-41 on shelf SH-AAA0?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("quarantine-keep-0"));
  assert.ok(!output.compressed_text.includes("quarantine-DROP-9"));
  assert.ok(!output.compressed_text.includes("ALERT-SH-77"));
});

test("a lone matching ## heading keeps its numbered steps, not the rest of the log", () => {
  const rows = Array.from({ length: 120 }, (_, index) => `unrelated_${index} status=healthy value=${(index * 7919) % 104729}`);
  rows.splice(60, 0, "## recover_lantern\n\n1. Stop writes.\n2. Snapshot volume.\n3. Verify checksum.\n4. Restore manifest.");
  const output = compress(rows.join("\n"), "Describe recover_lantern procedure.");
  for (const step of ["Stop writes", "Snapshot volume", "Verify checksum", "Restore manifest"]) {
    assert.ok(output.compressed_text.includes(step), step);
  }
  assert.ok(!output.compressed_text.includes("unrelated_100"));
  assert.ok(output.compressed_text.length < rows.join("\n").length / 4);
});

test("RFC-style prose is not mistaken for YAML, TOML, SQL, footnotes or link definitions", () => {
  const filler = (index) => `   Paragraph ${index} describes ordinary background behaviour for implementers.`;
  const paragraphs = Array.from({ length: 40 }, (_, index) => filler(index));
  paragraphs[5] = "   number = [ minus ] int [ frac ] [ exp ]\n   digit1-9 = %x31-39 ; 1-9\n   int = zero / ( digit1-9 *DIGIT )";
  paragraphs[9] = "   Note: implementations see Section 4 for details.";
  paragraphs[14] = "   Select a counter bit-length that can handle the precision in use, for example from\n   the clock source described earlier.";
  paragraphs[18] = '   The regular expression ^(([^:/?#]+):)? splits a reference into its components.';
  paragraphs[22] = "   The cedar retention window is 45 days for audit records.";
  paragraphs[26] = "   The client sends the data, ending with\n   <CRLF>.<CRLF>\n   on a line by itself.";
  paragraphs[30] = "   peers select cryptographic algorithms, optionally authenticate each other,\n   and establish shared keys from the handshake.";
  const references = Array.from({ length: 8 }, (_, index) => `   [RFC${7000 + index}]\n              Author, A., "Title ${index}", RFC ${7000 + index}.`);
  references.push("   [RFC7748]: 3 curves are listed here.");
  const input = [...paragraphs, "", "References", "", ...references].join("\n\n");
  assert.equal(documentFor(input).preservationReason ?? null, null);
  const output = compress(input, "What is the cedar retention window for audit records?");
  assert.equal(output.selection_reason, "query_anchored_extraction");
  assert.ok(output.compressed_text.includes("45 days"));
  assert.ok(output.compressed_text.length < input.length);
});
