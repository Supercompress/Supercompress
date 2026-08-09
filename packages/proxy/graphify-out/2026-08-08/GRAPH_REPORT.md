# Graph Report - packages/proxy  (2026-08-08)

## Corpus Check
- 28 files · ~56,152 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 450 nodes · 722 edges · 23 communities
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 31 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e991d7db`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- compress-engine.js
- detector.js
- package.json
- supercompress.js
- setup.js
- launch-ready.js
- compress-deep.js
- compress-prompt-lib.js
- forwarder.js
- review.js
- mcp.js
- server.js
- Changelog
- scripts
- dual-launch.js
- SuperCompress
- bug-hunt.js
- smoke.js
- wrap.js
- post-tool-compress.js
- local-engine.js
- run-all.js

## God Nodes (most connected - your core abstractions)
1. `compressAdaptive()` - 23 edges
2. `selectCompilerLines()` - 18 edges
3. `buildInferenceRecords()` - 16 edges
4. `scripts` - 15 edges
5. `extractQuestionEntities()` - 15 edges
6. `main()` - 14 edges
7. `Changelog` - 13 edges
8. `keywords` - 12 edges
9. `normalizeQuestion()` - 12 edges
10. `SuperCompress` - 12 edges

## Surprising Connections (you probably didn't know these)
- `printLogo()` --references--> `version`  [EXTRACTED]
  packages/proxy/bin/supercompress.js → packages/proxy/package.json

## Import Cycles
- None detected.

## Communities (23 total, 0 thin omitted)

### Community 0 - "compress-engine.js"
Cohesion: 0.07
Nodes (71): addBlockWithDependencies(), answerQualityScore(), blockFingerprint(), blockToLineSet(), buildFeatureTensor(), buildInferenceRecords(), buildVerifierFeatures(), ccrStore() (+63 more)

### Community 1 - "detector.js"
Cohesion: 0.10
Nodes (39): addToShellProfile(), AGENT_CATALOG, AGENTS, appExists(), BACKUP_PATH, backupFile(), clearProxyOverrides(), commandExists() (+31 more)

### Community 2 - "package.json"
Cohesion: 0.05
Nodes (37): pkg, express, bin, supercompress, supercompress-mcp, dependencies, express, description (+29 more)

### Community 3 - "supercompress.js"
Cohesion: 0.15
Nodes (28): CONFIG_PATH, connectAccount(), crypto, fetchJson(), formatNum(), fs, http, isHealthy() (+20 more)

### Community 4 - "setup.js"
Cohesion: 0.10
Nodes (18): { execSync }, fs, HOME, launchdPlist(), os, path, registerService(), systemdUnit() (+10 more)

### Community 5 - "launch-ready.js"
Cohesion: 0.13
Nodes (21): assert, codingDump(), CONFIG_DIR, fail(), fs, HOME, http, https (+13 more)

### Community 6 - "compress-deep.js"
Cohesion: 0.14
Nodes (19): assert, CONFIG_DIR, fail(), fatLogs(), fs, HOME, https, main() (+11 more)

### Community 7 - "compress-prompt-lib.js"
Cohesion: 0.16
Nodes (15): {
  compressContext,
  writeInbox,
  splitAskAndContext,
}, fs, MIN_CONTEXT_CHARS, path, compressContext(), compressPrompt(), fs, INBOX_DIR (+7 more)

### Community 8 - "forwarder.js"
Cohesion: 0.29
Nodes (17): anthropicSSE(), extractBearer(), extractProviderKey(), fetch, forwardAnthropic(), forwardChat(), forwardResponses(), forwardResponsesViaChat() (+9 more)

### Community 9 - "review.js"
Cohesion: 0.16
Nodes (17): assert, fail(), fs, http, https, longContext(), main(), os (+9 more)

### Community 10 - "mcp.js"
Cohesion: 0.21
Nodes (16): createStdioReader(), dispatch(), { execFile }, fs, handleToolCall(), httpJson(), loadApiKey(), log() (+8 more)

### Community 11 - "server.js"
Cohesion: 0.15
Nodes (13): assembleMessages(), compress(), detectAgentName(), fs, getApiKey(), os, path, app (+5 more)

### Community 12 - "Changelog"
Cohesion: 0.13
Nodes (14): 0.5.0 — 2026-07-26, 0.5.10 — 2026-08-05, 0.5.11 — 2026-08-07, 0.5.12, 0.5.1 — 2026-07-26, 0.5.2 — 2026-07-26, 0.5.3 — 2026-07-28, 0.5.4 — 2026-07-28 (+6 more)

### Community 13 - "scripts"
Cohesion: 0.13
Nodes (15): scripts, postinstall, setup, start, status, stop, test, test:all (+7 more)

### Community 14 - "dual-launch.js"
Cohesion: 0.18
Nodes (12): assert, fs, HOME, main(), MCP_PATH, mcpRpc(), os, pass() (+4 more)

### Community 15 - "SuperCompress"
Cohesion: 0.15
Nodes (12): Account & pricing, Benchmarks, Commands, How it works, Install, License, MCP (optional), More (+4 more)

### Community 16 - "bug-hunt.js"
Cohesion: 0.20
Nodes (11): assert, fail(), fs, HOME, main(), os, pass(), path (+3 more)

### Community 17 - "smoke.js"
Cohesion: 0.23
Nodes (11): assert, detectorMatrix(), { execFileSync, spawn }, fs, http, main(), os, PACKAGE_ROOT (+3 more)

### Community 18 - "wrap.js"
Cohesion: 0.24
Nodes (9): AGENTS, ensureProxy(), fs, http, path, PORT, { spawn }, waitForHealth() (+1 more)

### Community 19 - "post-tool-compress.js"
Cohesion: 0.25
Nodes (5): fs, MAX_IN, MIN_CHARS, os, path

### Community 20 - "local-engine.js"
Cohesion: 0.40
Nodes (5): compress(), fs, getEngine(), path, vm

### Community 21 - "run-all.js"
Cohesion: 0.40
Nodes (4): path, ROOT, { spawnSync }, suites

## Knowledge Gaps
- **197 isolated node(s):** `pkg`, `path`, `fs`, `{ spawn }`, `http` (+192 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `scripts` connect `scripts` to `package.json`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Why does `version` connect `supercompress.js` to `server.js`, `package.json`, `mcp.js`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `pkg`, `path`, `fs` to the rest of the system?**
  _197 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `compress-engine.js` be split into smaller, more focused modules?**
  _Cohesion score 0.06518987341772152 - nodes in this community are weakly interconnected._
- **Should `detector.js` be split into smaller, more focused modules?**
  _Cohesion score 0.09743589743589744 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.05128205128205128 - nodes in this community are weakly interconnected._
- **Should `supercompress.js` be split into smaller, more focused modules?**
  _Cohesion score 0.1477832512315271 - nodes in this community are weakly interconnected._