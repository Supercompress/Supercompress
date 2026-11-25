"use strict";

/**
 * Deterministic task classifier for complexity routing.
 *
 * It grades the task a person asked for, not the size of the request. Coding
 * agents (Codex, Claude Code, Cursor …) send a long harness system prompt,
 * tool definitions, injected instruction files and tool output with every
 * turn; none of that says how hard the task is. So the classifier:
 *
 *  1. finds the latest turn a person wrote, skipping system/developer
 *     messages, tool results and harness blocks (<system-reminder>,
 *     <environment_context>, <user_instructions> …);
 *  2. if that turn is a bare continuation ("keep going", "yes"), inherits the
 *     task from the earlier turn it continues, so a task keeps its tier;
 *  3. grades that text with weighted intent, scope and ambiguity signals;
 *  4. escalates when the agent loop since that turn keeps failing.
 *
 * Tiers (request tier N → models of catalog tier N under complexity routing):
 *   0 simple    trivial chat
 *   1 medium    quick, low-risk work (rename, commit message, docs, summary)
 *   2 complex   ordinary engineering (implement, wire up, write tests)
 *   3 reasoning hard work (plan, debug, review, migrations, edge cases)
 */

const MAX_MESSAGES = 256;
const MAX_PARTS = 128;
const MAX_TASK_CHARS = 16_000;
const MAX_HISTORY_CHECK = 4096;
const COMPLEXITY_NAMES = ["simple", "medium", "complex", "reasoning"];
const DIFFICULTY_NAMES = ["trivial", "easy", "medium", "hard"];
// Continuations to walk back through to reach the task ("continue" × N).
const MAX_INHERIT_STEPS = 32;
// Tokens longer than this are not words (minified code, base64, hashes); they are not
// matched against per-token patterns, which keeps grading linear in the input.
const MAX_TOKEN_CHARS = 256;

/** Harness-injected blocks that are not the person's words. */
const HARNESS_TAGS = [
  "system-reminder", "environment_context", "environment_details", "user_instructions",
  "instructions", "context", "ide_selection", "ide_opened_file", "ide_diagnostics",
  "command-name", "command-message", "command-args", "local-command-stdout",
  "local-command-stderr", "local-command-caveat", "user-prompt-submit-hook",
  "attachments", "attachment", "file_contents", "rules", "memory", "claude_background_info",
  "turn_aborted", "user_shell_command", "custom_instructions", "additional_data",
];
const HARNESS_TAG_SET = new Set(HARNESS_TAGS);
const OPEN_TAG = /<([a-z_-]+)(?:\s[^<>]{0,200})?>/gi;
const CLOSE_TAGS = new Map(HARNESS_TAGS.map((name) => [name, new RegExp(`</${name}>`, "gi")]));
const HARNESS_PREFIX = /^\s*(?:#\s*AGENTS\.md instructions for|Caveat: The messages below were generated|\[Request interrupted)/i;

/**
 * Category rules, most specific first. Each names the base difficulty tier a
 * task of that kind needs. Patterns run on lower-cased task text.
 */
const CATEGORIES = [
  // Hard (3)
  ["reasoning", 3, /\b(?:prove|proof|derive|derivation|theorem|formal(?:ly)? verif\w*|step[- ]by[- ]step|ultrathink|think (?:very )?hard(?:er)?|think deeply)\b/],
  ["security", 3, /\b(?:security (?:audit|review|holes?|issues?|bugs?|flaws?)|vulnerab\w+|exploit\w*|threat model|auth(?:entication|orization)? bypass|xss|csrf|sql injection|injection attack|privilege escalation|pentest\w*|end[- ]to[- ]end encrypt\w*|e2ee)\b/],
  ["debug", 3, /\b(?:debug\w*|root[- ]cause|investigat\w+|diagnos\w+|track (?:it |this |that |them )?down|figure out (?:why|what(?:'s| is)? (?:wrong|happen\w*|causing|going on))|find (?:out )?why|what (?:could|would|might|is) caus\w+|why (?:does|do|is|are|did|would|won'?t|can'?t|doesn'?t|isn'?t|was)\b|why\b[^.?!]{0,60}\b(?:fail\w*|break\w*|crash\w*|hang\w*|slow|wrong|error)|(?:only )?fails? (?:on|in|when|under|intermittently)|crash\w* (?:on|when|only|at)|flak(?:y|iness)|intermittent\w*|sometimes|occasionally|one (?:run )?in (?:two|three|four|five|ten|\d+)|every so often|heisenbug|race condition|deadlock\w*|memory leak|memory keeps growing|oom|segfault|regression|corrupt\w*|non[- ]?determinis\w+|under load|written twice|double[- ]charg\w*|re-?renders? \d+ times|\d{3}s from)\b/],
  ["plan", 3, /\b(?:(?:come up with |make |write )?a plan\b|plan (?:the|a|an|our|how|for|to|out)\b|planning|architect\w*|system design|design (?:the |a |an |our )?(?:[\w-]+ ){0,3}(?:system|architecture|schema|api|data model|protocol|strategy|pipeline|service|platform)s?|tech(?:nical)? spec|rfc\b|trade-?offs?|strategy (?:for|we)|roadmap|monorepo|plugin (?:system|architecture|api)|sharding|shard key|versioning strategy|split (?:the )?\w+ into (?:separate |micro)?services)\b/],
  ["migration", 3, /\b(?:migrat\w+|port (?:the|this|it|our) \w+ (?:to|from)|switch (?:the |our )?(?:whole |entire )?[\w.-]+(?: [\w.-]+)? from [\w.-]+ to|move [\w\s-]{1,30} from [\w.-]+ to|rewrite (?:the|our|this) [\w\s-]{1,30} in (?:rust|go|typescript|python|java|kotlin|swift|c\+\+)|upgrade (?:\w+ )?(?:from|to) (?:react|next(?:\.js)?|node|python|django|rails|angular|vue|spring|java)\b)/],
  ["review", 3, /\b(?:review (?:the|this|my|our|a)?\s*(?:[\d,]+[- ]line )?(?:diff|pr|pull request|change\w*|patch|code|commit\w*|branch)|code review|audit (?:the|this|our)|go through (?:the|our) [\w\s]{1,20} (?:and|for) (?:find|look|check))\b/],
  ["concurrency", 3, /\b(?:concurren\w+|distributed (?:system|lock|transaction)s?|consensus|leader election|network partition|split[- ]brain|offline (?:sync|first|mode|edits?)|works? (?:offline|without (?:a |an )?(?:connection|network))|sync\w* (?:conflict|engine|later|across)|eventual(?:ly)? consisten\w+|crdt|collaborative edit\w*|optimistic (?:update|lock)\w*|rollback|idempoten\w+|exactly[- ]once|transaction isolation|cache invalidation|invalidation|keep \w+ (?:in sync|consistent)|keep edits when offline)\b/],
  ["edge_cases", 3, /\b(?:edge[- ]cases?|corner[- ]cases?|rounding|overflow|off[- ]by[- ]one|numerical (?:stability|precision)|floating[- ]point|timezone\w*|daylight saving|dst\b|off by a cent)\b/],
  ["performance", 3, /\b(?:performance (?:issue|problem|regression|bottleneck)|bottleneck|profil(?:e|ing) (?:the|this)|too slow|n\+1|p9\d latency|latency (?:doubled|spiked|jumped)|cold start|reduce (?:our |the )?[\w\s]{1,20} (?:time|latency) from)\b/],
  ["algorithm", 3, /\b(?:algorithm\w*|time complexity|big[- ]o|dynamic programming|graph (?:search|traversal)|scheduler|solver|compiler|parser for|ranking|search relevance|typo[- ]toleran\w+|fuzzy match\w*)\b/],
  ["untangle", 3, /\b(?:untangle|circular dependenc\w+|without (?:changing behaviou?r|downtime|breaking)|no downtime|zero[- ]downtime)\b/],
  // Medium (2)
  ["refactor", 2, /\b(?:refactor\w*|restructur\w+|reorgani[sz]\w+|extract (?:the |a )?[\w\s-]{1,30} into|decouple|clean ?up the (?:architecture|module|codebase))\b/],
  ["tests", 2, /\b(?:write (?:\w+ )?tests?|add (?:\w+ )?tests?|tests? for\b|test (?:every|each|all|the)\b|unit tests?|integration tests?|e2e tests?|test coverage|cover (?:the|this|every|all)\b)/],
  ["ui", 2, /\b(?:build (?:the|a|an)? ?[\w\s-]{0,30}(?:screen|page|component|view|form|modal|layout|ui|dashboard|widget|tabs?)|figma|(?:ui|ux) work|front-?end|tailwind|responsive|animation|dark mode|toast|spinner|empty state|dialog|modal|keyboard shortcuts?|infinite scroll|drag and drop|widget)\b/],
  ["implement", 2, /\b(?:implement\w*|build\w*|create (?:a|an|the) (?:[\w-]+ )?(?:feature|endpoint|service|api|module|class|function|hook|component|cli|script|integration)|add (?:a|an|the|support for|server-side|client-side|oauth|rate limiting|retry|pagination|sorting|search|validation|input validation) ?[\w-]*|wire (?:up|the|it|them|\w+)|hook (?:up|the|into)|integrat\w+|scaffold\w*|endpoint|api route|paginat\w+|persist\w*|feature flag|oauth|webhook|rate limit\w*|retry|validation)\b/],
  ["fix", 2, /\b(?:fix\w*|bug\w*|broken|doesn'?t work|not working|exception|crash\w*|failing|fails?)\b/],
  ["config", 2, /\b(?:(?:re)?configur\w+|config (?:file|change|option|setting|flag)s?|env(?:ironment)? (?:var\w*|diff)|ci (?:pipeline|config|workflow)|github action\w*|dockerfile|docker|kubernetes|k8s|terraform|deploy\w*|infra\w*|index (?:on|to|for)|an index|compare (?:the )?(?:ci|local|prod|staging|env|config))\b/],
  ["analysis", 2, /\b(?:compare|analy[sz]\w+|evaluate|explain (?:how|why) (?:the|this|our)|walk me through|assess|pros and cons|propose|split (?:out|up|this|the))\b/],
  // Easy (1)
  ["git", 1, /\b(?:commit (?:message|msg|this|the|these|all|my|changes)|make (?:the|a) commit|write (?:a |the )?commit|git (?:add|commit|push|pull|status|log|stash|checkout|branch|tag)|push (?:the |my |this )?(?:branch|changes|commit)|(?:draft|write|open|create) (?:a |the )?(?:pr|pull request)\b|pr (?:description|summary|title)|sum up the staged|staged changes|changelog|release notes|rename the branch)\b/],
  ["docs", 1, /\b(?:readme|docstring\w*|jsdoc|comment (?:explaining|on|for|to)|add (?:a )?comments?|update (?:the )?docs?|document (?:the|this)|(?:fix|correct) (?:the |a |any |all )?typos?|typos? in|spell(?:ing)?(?:[- ]?check\w*)?|grammar|wording|copy ?edit\w*|rephrase|reword|capitali[sz]\w+|contributors(?:\.md)?|copyright)\b/],
  ["rename", 1, /\b(?:rename\w*|shorten (?:this|the)|move (?:the )?file|(?:delete|remove) (?:the )?(?:old|unused|dead|stale|legacy|console\.log|debug)\b|remove (?:the )?(?:unused|dead|console\.log|debug log|imports?)|uncomment|comment out|format\w*|lint\w*|prettier|indent\w*|newline|trailing (?:whitespace|comma)|sort (?:the )?imports?|bump\w*|update (?:the )?(?:version|dependency)|upgrade (?:the )?(?:package|dependency)|\.gitignore|\.env\.example)\b/],
  ["small_edit", 1, /^(?:please )?(?:change|update|set|replace|make) (?:the |this |our )?(?:[\w-]+ ){0,3}(?:label|text|copy|colou?r|title|heading|wording|year|value|placeholder|icon|font size|padding|margin|link)\b/],
  ["summary", 1, /\b(?:summari[sz]\w*|sum (?:it |this |that |them )?up|tl;?dr|recap|list (?:the|all)|what (?:files|changed)|run (?:the )?(?:tests?|suite|build|linter|lint)(?! and fix)|translat\w+|convert (?:this|the) (?:json|yaml|csv|text))\b/],
  ["question", 1, /^(?:what(?:'s| is| are| does| do)|whats|how do (?:i|you)|tell me (?:what|how)|explain (?:what|the difference)|what'?s the difference|is (?:it|there)|can i|should i)\b/],
];

/** Scope signals that make any task bigger. */
const SCOPE_PATTERNS = [
  ["multi_file_scope", /\b(?:across|in|over|touch\w*) (?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|several|multiple|many|all(?: the)?|every) (?:files|modules|packages|services|repos|components)\b|\b(?:\d{1,3}(?:,\d{3})+|\d{4,}|\d+k)[- ]line\b|\bacross (?:the|all|every)\b/],
  ["codebase_scope", /\b(?:entire|whole|full|all of the) (?:codebase|repo|repository|project|monorepo|app|application|system)\b|\bend[- ]to[- ]end\b|\bfrom scratch\b/],
  ["production_risk", /\b(?:in production|prod (?:data|db|database|incident)|outage|incident|data loss|live (?:data|database|traffic))\b/],
];

// Follow-ups, typo-tolerant ("keep goig", "keepp going keep going").
const KEEP_GOING = "(?:ke+p+ (?:g\\w{0,7}|o\\w{1,6}|\\w{0,2}oing|working(?: on (?:this|it|that))?|at it|it up|pushing)|cont\\w{3,8}|carry on|go on|resume|finish (?:it|this|that|up)(?: off)?)";
const FOLLOW_UP = `(?:${KEEP_GOING}|ok(?:ay)?|k|yes|yep|yeah|y|sure|go(?: ahead| for it)?|proceed|next|do it|try again|retry|again|please|thanks?(?: you)?|ty|lgtm|sounds good|perfect|great|nice|cool|done|and|then|more)`;
const CONTINUATION = new RegExp(`^\\s*${FOLLOW_UP}(?:[\\s,.!?]+${FOLLOW_UP}){0,5}[\\s.!?]*$`, "i");
// "keep going, and add the export" continues the task and adds to it.
const CONTINUATION_PREFIX = new RegExp(`^\\s*${KEEP_GOING}\\b`, "i");
// Opening asks for an image or video: the work is one tool call with a
// brief, whatever the brief describes ("an architect's watercolor").
const MEDIA_ASK = /^(?:please |can you |could you )?(?:use (?:your|the) image (?:generation|gen) tool to |use image ?gen to )?(?:create|generate|make|draw|paint|produce)(?: me)? (?:exactly |just )?(?:one|an?|the|\d{1,2}|some)? ?(?:new )?(?:\w+ ){0,2}(?:image|images|picture|photo|illustration|painting|drawing|logo|icon|wallpaper|poster|render)s?\b(?![\s\S]{0,60}\b(?:component|button|css|svg|jsx|tsx|react|page|bigger|smaller|align|center)\b)/;
// Machine identifiers and URLs carry words ("migration:v1:turn-item",
// "/guides/debugging") that are not the ask. Applied per whitespace token
// (see stripIdentifiers) so no pattern backtracks across a long run of text.
const URL_IN_TOKEN = /https?:\/\/.*/;
const IDENTIFIER_TOKEN = /=|:[^:]*:/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}\b/g;
const VAGUE_VERB = /\b(?:clean (?:this|it|that|these|them)? ?up|tidy|improve|make (?:this|it|that|these|them) (?:better|work|nicer|cleaner|faster)|make (?:these|this|it) better|polish|fix (?:this|it|that|these|them)|sort (?:this|it) out|handle (?:this|it)|deal with (?:this|it)|look (?:at|into) (?:this|it))\b/;
const GREETING = /^\s*(?:hi|hello|hey|yo|thanks?|thank you|good (?:morning|afternoon|evening)|what'?s up|how are you)\b[\s\S]{0,40}$/i;
const CODE_BLOCK = /```/;
// Matched per whitespace token (see countFiles).
const FILE_PATH = /^[`'"(]?((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,6})\b|\b([\w-]+\.(?:js|ts|tsx|jsx|py|go|rs|java|rb|php|cs|cpp|c|h|swift|kt|sql|yaml|yml|json|toml|md|css|html))\b/i;
const FAILURE = /\b(?:error|exception|traceback|failed|failing|failure|fatal|panic(?:ked)?|assertion ?error|exit (?:code|status) [1-9]\d*|segmentation fault|not ok \d+|\d+ (?:failed|failing))\b/i;

/**
 * Remove harness blocks in one forward pass: each opening tag is matched to
 * its closing tag, and an unclosed harness tag drops the rest of the text (a
 * truncated reminder is still not the ask). Linear in the input. Matching is
 * case-insensitive on the original text: offsets taken from a lower-cased
 * copy drift wherever lower-casing changes a string's length ("İ").
 */
function stripHarness(text) {
  if (typeof text !== "string") return "";
  if (HARNESS_PREFIX.test(text)) return "";
  let out = "";
  let cursor = 0;
  OPEN_TAG.lastIndex = 0;
  let match;
  while ((match = OPEN_TAG.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    if (!HARNESS_TAG_SET.has(name)) continue;
    out += text.slice(cursor, match.index) + " ";
    const closeTag = CLOSE_TAGS.get(name);
    closeTag.lastIndex = OPEN_TAG.lastIndex;
    const close = closeTag.exec(text);
    if (!close) { cursor = text.length; break; }
    cursor = closeTag.lastIndex;
    OPEN_TAG.lastIndex = cursor;
  }
  out += text.slice(cursor);
  return out.replace(/\s+/g, " ").trim();
}

/** Human-written text of one message, or "" if it carries none. */
function humanText(message, onImage, onScanLimit) {
  if (!message || typeof message !== "object") return "";
  if (message.role && message.role !== "user") return "";
  const content = message.content;
  if (typeof content === "string") return stripHarness(content);
  if (!Array.isArray(content)) return "";
  if (content.length > MAX_PARTS) onScanLimit();
  const texts = [];
  for (const part of content.slice(0, MAX_PARTS)) {
    if (!part || typeof part !== "object") continue;
    if (["image", "image_url", "input_image"].includes(part.type) || part.image_url) onImage();
    if (["text", "input_text"].includes(part.type) && typeof part.text === "string") texts.push(part.text);
  }
  return stripHarness(texts.join("\n"));
}

function isToolMessage(message) {
  return message && (message.role === "tool" || message.role === "function");
}

function messageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

function stripIdentifiers(lower) {
  return lower.replace(/\S+/g, (token) => {
    const url = URL_IN_TOKEN.exec(token);
    const word = url ? token.slice(0, url.index) : token;
    if (!word || word.length > MAX_TOKEN_CHARS) return " ";
    if (IDENTIFIER_TOKEN.test(word)) return " ";
    return word.replace(UUID, " ");
  });
}

function countFiles(text) {
  const files = new Set();
  for (const token of text.split(/\s+/)) {
    if (!token || token.length > MAX_TOKEN_CHARS) continue;
    const hit = FILE_PATH.exec(token);
    if (hit) files.add(hit[1] || hit[2]);
  }
  return files.size;
}

/** Grade one piece of task text. Returns { tier, category, reasons }. */
function gradeTask(raw) {
  const text = String(raw).slice(0, MAX_TASK_CHARS);
  // Lower-casing can lengthen text ("İ" → 2 code units): cap again after it.
  const lower = stripIdentifiers(text.toLowerCase().slice(0, MAX_TASK_CHARS));
  const reasons = [];
  if (!text.trim()) return { tier: 0, category: "empty", reasons };

  if (MEDIA_ASK.test(lower.trimStart())) {
    reasons.push("task_media");
    const tier = text.length >= 6000 ? 2 : 1;
    return { tier, category: "media", reasons };
  }

  const matched = [];
  for (const [name, base, pattern] of CATEGORIES) {
    const hit = pattern.exec(lower);
    if (hit) matched.push({ name, base, at: hit.index });
  }
  for (const { name } of matched) reasons.push(`task_${name}`);

  // Hard signals win wherever they appear. Otherwise the task's lead action
  // decides: "Rename the env var in config.yaml" is a rename, not config
  // work, and "Add tests … and fix whatever breaks" is test work. Generic
  // verbs (fix, implement) only lead when nothing more specific matched.
  let tier = 0;
  let category = "chat";
  const hard = matched.filter((m) => m.base === 3);
  if (hard.length) {
    const lead = hard.reduce((a, b) => (b.at < a.at ? b : a));
    tier = 3;
    category = lead.name;
  } else if (matched.length) {
    const generic = new Set(["fix", "implement"]);
    const specific = matched.filter((m) => !generic.has(m.name));
    const pool = specific.length ? specific : matched;
    const lead = pool.reduce((a, b) => (b.at < a.at || (b.at === a.at && b.base > a.base) ? b : a));
    tier = lead.base;
    category = lead.name;
    // Quick work joined to real work ("… and fix whatever breaks", "… with
    // tests") is real work.
    if (tier === 1 && matched.some((m) => m.base === 2 && m.at > lead.at &&
        /\b(?:and|then|with|plus)\b/.test(lower.slice(lead.at, m.at)) && !generic.has(m.name) && m.name !== "ui")) {
      tier = 2;
      reasons.push("compound_task");
    }
    if (tier === 1 && lead.name !== "question" && reasons.includes("task_fix") && !specific.length) tier = 2;
    if (tier === 1 && pool !== specific) reasons.push("generic_verb");
    else if (tier === 1 && matched.some((m) => m.base === 2)) reasons.push("quick_task_over_generic_verb");
  }

  const words = lower.split(/\s+/).filter(Boolean).length;
  const files = countFiles(text);

  let scope = 0;
  for (const [name, pattern] of SCOPE_PATTERNS) {
    if (pattern.test(lower)) { scope += 1; reasons.push(name); }
  }
  if (files >= 4) { scope += 1; reasons.push("many_files_named"); }

  // Scope raises real work one tier; quick tasks stay quick unless the scope
  // is the whole codebase.
  if (scope && tier >= 2) {
    tier = Math.min(3, tier + 1);
  } else if (scope && tier === 1 && reasons.includes("codebase_scope")) {
    tier = 2;
  } else if (scope && tier === 0) {
    tier = 2;
  }

  // Unclear work is never treated as quick work.
  if (VAGUE_VERB.test(lower) && words <= 12) {
    tier = Math.max(tier, 2);
    category = category === "chat" ? "unclear" : category;
    reasons.push("unclear_ask");
  }

  if (CODE_BLOCK.test(text) && tier < 1) { tier = 1; reasons.push("code_block_present"); }

  // A long, written-out ask is a spec, not a quick request.
  if (text.length >= 6000 && tier < 3) { tier = Math.max(tier, 2); reasons.push("long_task_spec"); }
  else if (text.length >= 1500 && tier < 2) { tier = Math.max(tier, 1); reasons.push("detailed_task"); }

  // Unknown imperative work (no category, not chat) defaults to medium, not
  // trivial: misrouting a real task to the cheapest model is the costly error.
  if (category === "chat" && tier === 0 && words >= 4 && !GREETING.test(lower) &&
      /^(?:please\s+)?(?:can you\s+|could you\s+)?[a-z]+/.test(lower) && !/\?\s*$/.test(lower)) {
    tier = 2;
    category = "unclassified_task";
    reasons.push("unclassified_task");
  }
  if (tier === 0) reasons.push(GREETING.test(lower) ? "greeting" : "simple_default");
  return { tier, category, reasons };
}

function classifyRequest(request = {}) {
  const input = request && typeof request === "object" ? request : {};
  const reasons = [];
  const capabilities = new Set(["chat"]);
  let floor = 0;
  let scanLimited = false;

  function raise(nextTier, reason) {
    floor = Math.max(floor, nextTier);
    if (!reasons.includes(reason)) reasons.push(reason);
  }
  function requireTools() {
    capabilities.add("tools");
    if (!reasons.includes("tools_present")) reasons.push("tools_present");
    floor = Math.max(floor, 1);
  }
  function requireVision() {
    capabilities.add("vision");
    if (!reasons.includes("images_present")) reasons.push("images_present");
    floor = Math.max(floor, 1);
  }
  function scanLimit() {
    scanLimited = true;
  }

  if ((Array.isArray(input.tools) && input.tools.length) ||
      (Array.isArray(input.functions) && input.functions.length) ||
      (input.tool_choice != null && input.tool_choice !== "none") ||
      (input.function_call != null && input.function_call !== "none")) {
    requireTools();
  }

  const all = Array.isArray(input.messages) ? input.messages : [];
  // The latest messages carry the task; scan from the end. Indices into `human` are
  // positions in `all`.
  const start = Math.max(0, all.length - MAX_MESSAGES);
  const human = [];
  for (let i = start; i < all.length; i += 1) {
    const message = all[i];
    if (!message || typeof message !== "object") continue;
    if (isToolMessage(message) || message.function_call ||
        (Array.isArray(message.tool_calls) && message.tool_calls.length)) {
      requireTools();
    }
    const text = humanText(message, requireVision, scanLimit);
    if (text) human.push({ index: i, text });
  }
  // A long agent loop can push the person's turn out of that window. Look further back
  // (bounded) until a turn that states a task, so the loop keeps the task's tier.
  const isContinuation = (text) => CONTINUATION.test(text) || CONTINUATION_PREFIX.test(text);
  if (typeof input.ask !== "string" && !human.some((h) => !isContinuation(h.text))) {
    for (let i = start - 1; i >= Math.max(0, start - MAX_HISTORY_CHECK); i -= 1) {
      const message = all[i];
      if (!message || typeof message !== "object" || (message.role && message.role !== "user")) continue;
      const text = humanText(message, requireVision, scanLimit);
      if (!text) continue;
      human.unshift({ index: i, text });
      if (!isContinuation(text) || human.length > MAX_INHERIT_STEPS) break;
    }
  }
  // Older messages are not graded, but still decide the capabilities a model
  // needs: a cheap type check, bounded so huge histories stay O(limit).
  const older = all.slice(0, Math.max(0, all.length - MAX_MESSAGES));
  for (const message of older.slice(-MAX_HISTORY_CHECK)) {
    if (!message || typeof message !== "object") continue;
    if (isToolMessage(message) || message.function_call ||
        (Array.isArray(message.tool_calls) && message.tool_calls.length)) requireTools();
    if (Array.isArray(message.content) && message.content.some((part) => part &&
        (["image", "image_url", "input_image"].includes(part.type) || part.image_url))) requireVision();
  }
  if (older.length > MAX_HISTORY_CHECK) scanLimit();
  if (scanLimited) {
    // Content we did not inspect may need tools or vision.
    requireTools();
    requireVision();
    reasons.push("input_scan_limit");
  }

  // The task: an explicit ask, else the latest human turn, inheriting through
  // bare continuations ("keep going") so a continuing task keeps its tier.
  let taskText = typeof input.ask === "string" ? stripHarness(input.ask) : "";
  let taskSource = taskText ? "ask" : null;
  let taskIndex = -1;
  let continuation = false;
  if (!taskText && human.length) {
    let pick = human.length - 1;
    const parts = [human[pick].text];
    taskIndex = human[pick].index;
    let steps = 0;
    while (isContinuation(human[pick].text) && pick > 0 && steps < MAX_INHERIT_STEPS) {
      pick -= 1;
      steps += 1;
      parts.unshift(human[pick].text);
      continuation = true;
    }
    taskText = parts.join("\n");
    taskSource = continuation ? "continued_user_turn" : "latest_user_turn";
  }
  if (!taskText && typeof input.context === "string" && input.context.trim()) {
    // Compress API with no ask: grade on a bounded head of the context.
    taskText = input.context.slice(0, 2000);
    taskSource = "context";
  }
  if (continuation) reasons.push("continues_earlier_task");

  const graded = gradeTask(taskText || "");
  for (const reason of graded.reasons) if (!reasons.includes(reason)) reasons.push(reason);
  let tier = Math.max(floor, graded.tier);

  // Agent loop since the task turn: repeated failing tool results mean the
  // current model is not getting there, so move up (never down).
  if (taskIndex >= 0) {
    let failures = 0;
    let toolResults = 0;
    for (const message of all.slice(taskIndex + 1)) {
      if (!isToolMessage(message)) continue;
      toolResults += 1;
      if (FAILURE.test(messageText(message).slice(0, 4000))) failures += 1;
    }
    if (failures >= 3 && tier < 3) { tier = Math.min(3, tier + 1); reasons.push("repeated_tool_failures"); }
    else if (failures >= 1 && tier < 2 && graded.tier >= 1) { tier = 2; reasons.push("tool_failure_in_task"); }
    if (toolResults >= 40 && tier < 3) { tier = Math.min(3, tier + 1); reasons.push("long_agent_loop"); }
  }

  // Explicit reasoning requests. Codex sends effort "medium" by default, so
  // only high efforts and large thinking budgets count as a signal.
  const rawEffort = input.reasoning_effort ?? input.reasoning?.effort;
  const effort = typeof rawEffort === "string" ? rawEffort.toLowerCase() : "";
  if (["high", "xhigh", "max", "maximum"].includes(effort)) {
    tier = 3;
    if (!reasons.includes("reasoning_requested")) reasons.push("reasoning_requested");
  }
  const budget = Number(input.thinking?.budget_tokens);
  if (input.thinking?.type === "enabled" && Number.isFinite(budget) && budget >= 32_000) {
    tier = 3;
    reasons.push("large_thinking_budget");
  }

  if (!reasons.length) reasons.push("simple_default");

  return {
    tier,
    complexity: COMPLEXITY_NAMES[tier],
    difficulty: DIFFICULTY_NAMES[tier],
    category: graded.category,
    task_source: taskSource,
    reasons: reasons.slice(0, 12),
    required_capabilities: [...capabilities].sort(),
  };
}

module.exports = { classifyRequest, stripHarness, gradeTask };
