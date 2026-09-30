/**
 * Demo context presets for the impact calculator.
 */
(function (global) {
  "use strict";

  const MOCKINGBIRD = `# To Kill a Mockingbird — study context (Maycomb, AL, 1930s)

## Part One — Scout's world
Scout Finch narrates her childhood in Maycomb County. Her father Atticus Finch is a lawyer appointed to defend Tom Robinson, a Black man accused of assaulting Mayella Ewell. Scout, her brother Jem, and summer friend Dill become obsessed with Boo Radley, a reclusive neighbor they have never seen.

Atticus teaches Scout empathy: "You never really understand a person until you consider things from his point of view." The children find small gifts in a knothole of the Radley oak tree — chewing gum, soap carvings of themselves, a pocket watch — until Nathan Radley cements the hole shut.

## Themes — justice and prejudice
The trial exposes Maycomb's racial prejudice. Atticus presents evidence that Tom's left arm is useless and he could not have inflicted the injuries described. Mayella's testimony contradicts her father's. Despite clear innocence, the all-white jury convicts Tom.

Scout and Jem sit in the colored balcony with Reverend Sykes. Atticus loses but earns respect from the Black community. Mrs. Dubose, a morphine-addicted neighbor, dies free of her addiction after Jem reads to her as punishment for destroying her camellias.

## Part Two — the trial and aftermath
Bob Ewell swears revenge on Atticus. Tom is killed escaping prison. Scout performs as a ham in the school pageant; Jem escorts her home through dark woods. An attacker breaks Jem's arm. Boo Radley emerges and carries Jem home — the children realize Boo saved their lives.

Sheriff Tate decides Bob Ewell fell on his own knife to protect Boo from public attention. Scout walks Boo home and stands on his porch, seeing Maycomb as Boo would have seen it for years. She understands Atticus was right about standing in another's shoes.

## Character notes (for retrieval)
- Atticus Finch: principled lawyer, single father, shoots a rabid dog with one shot (Tim Johnson).
- Boo Radley (Arthur): recluse, leaves gifts, mends Jem's pants, saves children from Ewell.
- Tom Robinson: accused unjustly; kind to Mayella; convicted despite medical evidence.
- Calpurnia: Finch housekeeper; teaches Scout manners; takes children to her church.
- Dill Harris: summer visitor; tells tall tales; sensitive to injustice.

## Repeated context blocks (simulating a long RAG index)
`;

  function padBlock(title, body, times) {
    return Array.from({ length: times }, (_, i) => `### ${title} — chunk ${i + 1}\n${body}`).join("\n\n");
  }

  const MOCKINGBIRD_LONG =
    MOCKINGBIRD +
    padBlock(
      "Maycomb courthouse transcript excerpt",
      "Atticus: 'In our courts, all men are created equal.' The jury file out. Reverend Sykes: 'Miss Jean Louise, stand up. Your father's passin'.'",
      12
    ) +
    "\n\n" +
    padBlock(
      "Scout classroom reflections",
      "Miss Caroline forbids Scout from reading at home. Atticus negotiates a compromise. Scout learns the Cunningham family pays with hickory nuts and never takes charity.",
      10
    );

  const CODING_SESSION = (() => {
    const filler = Array.from(
      { length: 36 },
      (_, i) => `[turn ${i}] tool: grep — searched repo for fetch_user; 14 files matched`
    ).join("\n");
    const core = [
      "## Agent coding session — auth service refactor",
      "",
      "def fetch_user(row_id: str) -> User | None:",
      '    """Returns User or None when row is missing."""',
      "    row = db.query('SELECT * FROM users WHERE id = ?', row_id)",
      "    if row is None:",
      "        logger.info('fetch_user miss row_id=%s', row_id)",
      "        return None",
      "    return User(**row)",
      "",
      "class User:",
      "    email: str",
      "    name: str",
      "    role: str",
      "",
      "def list_sessions(user_id: str) -> list[Session]:",
      "    return Session.query.filter_by(user_id=user_id).order_by(Session.created_at.desc()).all()",
    ].join("\n");
    const tail = Array.from(
      { length: 18 },
      (_, i) => `[log ${i}] composio: calendar.list_events — 3 upcoming meetings`
    ).join("\n");
    return `${filler}\n${core}\n${tail}`;
  })();

  const MARKDOWN_DOC = `# Product requirements — SuperCompress integration

## Overview
Teams paste long agent context before every LLM call. SuperCompress trims tokens while preserving answer-critical lines.

## API contract
\`\`\`bash
POST /api/v1/compress
X-API-Key: sc_live_…
{"context":"…","query":"…","budget_ratio":0.35}
\`\`\`

## Rollout checklist
- [ ] Dashboard keys for staging
- [ ] Monitor tokens_saved per request
- [ ] Compare oracle recall vs truncation baseline

## Environment assumptions
| Parameter | Value |
|-----------|-------|
| GPU watts | 150 W |
| Grid CO₂ | 0.417 kg/kWh |
| Water / kWh | 1.8 L (illustrative datacenter cooling) |

`;

  const MARKDOWN_LONG =
    MARKDOWN_DOC +
    Array.from(
      { length: 24 },
      (_, i) =>
        `## Appendix ${i + 1} — deployment notes\n\n` +
        `Region ${i + 1} runs CPU eviction before GPU prefill. Budget ratio 0.35 targets 64% KV savings. ` +
        `Quality checks use oracle recall on benchmark seeds.\n`
    ).join("\n");

  const AGENT_LOG = (() => {
    const filler = Array.from(
      { length: 40 },
      (_, i) => `[turn ${i}] tool: grep — searched repo; ${8 + (i % 5)} files matched`
    ).join("\n");
    const core = [
      "## Incident report — checkout outage",
      "",
      "Root cause: Redis connection pool exhausted at 14:32 UTC.",
      "Mitigation: raised max_connections from 50 to 200 on cache-primary.",
      "Customer impact: 12 minutes elevated 503 rate on POST /api/checkout.",
      "Owner: platform-oncall · ticket INC-8842",
    ].join("\n");
    const tail = Array.from(
      { length: 20 },
      (_, i) => `[log ${i}] metrics: p99 latency 842ms (baseline 120ms)`
    ).join("\n");
    return `${filler}\n${core}\n${tail}`;
  })();

  global.ImpactPresets = {
    mockingbird: {
      label: "To Kill a Mockingbird",
      query: "What lesson does Atticus teach Scout about empathy?",
      context: MOCKINGBIRD_LONG,
    },
    coding: {
      label: "Coding session",
      query: "What does fetch_user return when the row is missing?",
      context: CODING_SESSION,
    },
    markdown: {
      label: "Sample markdown",
      query: "What is the API contract for compression?",
      context: MARKDOWN_LONG,
    },
    agent_log: {
      label: "Agent incident log",
      query: "What was the root cause of the checkout outage?",
      context: AGENT_LOG,
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
