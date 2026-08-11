## Agent Bridge dashboard

Control plane MCP: `agent-bridge-dashboard` (`bridge_*` tools). Skill: `agent-bridge-dashboard`.
Use it to view/update the board, tasks, workspace, Ultron, and dashboard URL while working in this repo.
Health/list/status are free; run/chat/ultron burn tokens. Default plane: `http://127.0.0.1:8787`.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Daily shorts (`videos/sc-daily-shorts/`)

Every daily short must ship as a **finished promo**, not a text-card slideshow.

### Hard requirements (every video)

1. **Proper music (BGM)** — never silent, never a silent placeholder, never a recycled identical stub across days unless you intentionally pick that track. Resolve or generate a **real** score that fits the brief (mood + energy + length):
   - Prefer Diffusion Studio `generate.audio({ model: "elevenlabs-music", … })` on mount, **or**
   - media-use `resolve --type bgm` / curated library, **or**
   - a vetted licensed/local track frozen into `assets/score.mp3`.
   - Export/freeze the chosen bed to `assets/score.mp3` after generation so re-renders are reproducible.
   - Duck BGM under VO if VO exists; otherwise keep it present and musical (−2 to −8 dB typical).

2. **A-roll** — the primary story layer (hook / proof / CTA). Motion graphics count as A-roll when there is no talking head.

3. **B-roll** — real product footage, UI screen captures, agent/tooling clips, or generated atmospheric plates under/over the A-roll. At least **3 distinct visual sources** per short (not one flat background color).

4. **SFX** — transition whooshes, impacts, ticks, risers, UI clicks timed to cuts and counters. Use the media-use bundled SFX pack and/or `generate.audio` SFX. Bare cuts with no hit are a fail.

5. **Complexity bar** — layered timeline (B-roll sequence + overlays + captions + audio bed). If mute-watching still reads the story, good; if it looks like a Keynote export, rebuild.

### Format defaults

- Aspect **1080×1920**, ~10–15s, Diffusion Studio JSX (`main.jsx`) as source of truth.
- Captions mute-first. Coding-agent angle unless the brief says otherwise.
- Render to `renders/today.mp4` + dated filename.

### Ship checklist

```bash
cd videos/sc-daily-shorts/YYYY-MM-DD
# assets/: score.mp3 (real BGM), sfx/*, broll/*, stills/*, agents/*
dapi open .
dapi mount main.jsx   # generates AI audio/video declared in JSX
dapi context
dapi node render <scene-id> -o renders/today.mp4
```
