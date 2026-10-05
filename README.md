# Smart EM Solver: demo web app

A proof of concept of the Smart EM Solver workflow: **Model (setup) → Analyze → Solve → Verify → Results**, with a live
dashboard, a bottom chat composer, autonomy settings, and an orchestrator that runs the pipeline.

> **Every solver result is from a MOCK solver** (a single-resonator S11 model driven by the patch design equations).
> openEMS and Palace are not called. The UI, exports and reports all carry the MOCK label.

## What's real and what's mocked

| Piece | Status |
|---|---|
| 3D geometry builder (boxes, cylinders, sheets, ports, move gizmo, views, X-ray, mesh preview, air box) | Real (frontend) |
| Patch wizard (transmission-line design equations) | Real |
| Field viewer: E, H, Poynting, surface current (cut planes, vectors, phase animation, frequency slider) | **MOCK** (analytic cavity-model picture) |
| Materials library, boundary, sweep, goal, constraints, plots, autonomy, save/open project | Real |
| Geometry analyzer (electrical size, h/λd, εr, ports, band) | Real (cheap features) |
| Method selector | Rule-based v0 (README §6.4); costs are labelled estimates |
| Orchestrator | **Claude** (`claude-opus-5-5`, tool use) when `ANTHROPIC_API_KEY` is set, otherwise a scripted orchestrator with the same tools |
| Solver kernel, convergence and residual plots, mesh stats | **MOCK** |
| Verifier, numerical-fix loop, goal check, design optimizer | Real logic running on mock data |
| Exports: Touchstone `.s1p`, problem YAML, HTML report, Python reproduction script | Real (with MOCK label) |
| Far-field | Analytic cavity-model estimate |
| Trained NN / gradient-boosting selector | Out of scope; `problem.select()` is the drop-in point |

The orchestrator never produces numbers: Claude picks the next tool and writes the narration. Every number comes
from the deterministic tool layer in `backend/src/emsolver/pipeline.py`.

## Run it

**API keys:** each developer uses their own key in `backend/.env`, which is git-ignored. Never commit keys.
With no key at all, everything still works on the scripted orchestrator.

Requirements: Python 3.12 with [uv](https://docs.astral.sh/uv/), and Node 18+.

```bash
# backend (terminal 1)
cd backend
cp .env.example .env                     # optional: paste your own free Groq key (or Claude key) into .env
uv run uvicorn emsolver.app:app --port 8000

# frontend (terminal 2)
cd frontend
npm install
npm run dev                              # http://localhost:5173
```

Single-process mode: run `npm run build` in `frontend/`, then the backend serves `frontend/dist` at http://localhost:8000.

Headless mode (same pipeline, printed as log lines):

```bash
cd backend
uv run emsolver demo                     # default 2.4 GHz patch, autonomy=auto
uv run emsolver run problem.yaml --goals goals.yaml --autonomy auto
```

### Choosing the orchestrator

| Provider | How to enable | Cost |
|---|---|---|
| Claude (default when its key is set) | `ANTHROPIC_API_KEY=sk-ant-api03-...` | Pay-as-you-go API credits |
| **Groq** (free) | `GROQ_API_KEY=gsk_...` from console.groq.com (no card) | Free tier, rate-limited (about 8K tokens/min); runs pause and resume automatically when limited |
| Big Pickle (OpenCode Zen) | `OPENCODE_API_KEY=...` | Needs paid Zen credits: the free tier only works inside the OpenCode client |
| Scripted | no key, or `EMSOLVER_PROVIDER=scripted` | Free, offline |

With several keys set, the first match wins (Claude, then Groq, then Big Pickle); `EMSOLVER_PROVIDER=groq` forces one.

Other knobs: `EMSOLVER_MODEL` (Claude model, default `claude-opus-5-5`), `EMSOLVER_GROQ_MODEL` (default `openai/gpt-oss-120b`) and
`EMSOLVER_OPENCODE_MODEL` (default `big-pickle`). If an LLM call fails mid-run, the scripted orchestrator takes over from the same state.

## Demo script (happy path)

1. The **Model** tab shows the default 2.4 GHz patch on RO4003C. You can open the **Patch wizard** to regenerate it, or
   edit the geometry in the 3D view. The **Fields** buttons in the 3D toolbar show mock E/H/Poynting/current overlays.
2. Press **Run** in *Balanced* mode. **Analyze** shows features, the selector (Palace 86%, thin substrate) and the
   plan, with a 10 s countdown. Try "why FEM?" or "use openEMS" in the chat.
3. **Solve** streams progress, mesh stats, live S11 and the convergence plot. Type "cross-check" mid-run.
4. **Verify**: the cross-check against openEMS fails (2.3%), so the solver applies the padding fix λ/4 → λ/2 and the
   check passes. The goal is not met (the design equations ignore probe inductance), so the optimizer proposes a
   shorter patch. Approve it.
5. **Results** shows "Goal met and verified (MOCK)", S11 with the error band, Smith chart, impedance, VSWR,
   far-field, the run summary and the exports.

## Layout

```
backend/src/emsolver/
  physics.py       design equations, mock S11 model, analytic pattern
  problem.py       materials, geometry interpretation, features, rule-based selector, patch template
  pipeline.py      Run state, events, approvals, and the tool layer (build/analyze/select/plan/solve/verify/fix/goal/design/finish)
  orchestrator.py  Claude tool-use orchestrator + scripted fallback (same tools)
  chat.py          intent parser for commands + Claude for free-form questions
  exports.py       .s1p, YAML, HTML report, reproduction script
  app.py           FastAPI REST + Server-Sent Events
  cli.py           headless `emsolver`
frontend/src/
  setup/           3D modeler (react-three-fiber), geometry tree, properties, settings, wizard
  pages/           Analyze, Solve, Verify, Results
  components/      top bar, chat composer, event log, SVG charts (S11, Smith, polar)
```

## Swapping in the real pieces later

- **Selector model:** replace `problem.select(features, settings)` and keep the same return shape.
- **Real solvers:** replace `Run._solve()` with emharness adapter calls, keeping the emitted events
  (`subrun_started`, `progress`, `partial_result`, `convergence_point`, `subrun_finished`).
