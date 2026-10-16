# Smart EM demo

Front-end demo at `/demo.html`. The solver is a fast physical model (cavity + transmission line for the patch,
array factor + coupling for arrays), not full-wave.

```bash
cd frontend && npm install && npm run dev        # http://localhost:5173/demo.html
cd backend && uv run uvicorn emsolver.app:app --port 8000   # optional: AI answers in the console
```

## Studio (default)

An HFSS-style workspace (`frontend/src/demo/studio/`): Project Manager tree and property grid on the left, tabbed
3D Modeler and report windows in the middle, and a command line at the bottom.

- **Design**: Insert a patch or a 4×4 array, or draw one (B box, R rectangle, P port). Design variables live
  under Variables; editing one rebuilds the geometry.
- **Analyze** (F5) solves Setup1; every run is kept as a solution. **Optimize** runs Optimetrics toward the goal.
- **Reports** (Results ▸ Create report, or `report …`): pick solution, category, quantity, function and sweep;
  rectangular, polar or Smith; hover readout, click for markers, Axes…, Export CSV. Quantities:
  `help report`.
- **Import paper** (File, Ctrl+I, or drop a PDF): builds the design the paper describes, logs its
  inconsistencies in Messages, solves it, and recreates every results figure as an ordinary report with the
  paper's digitised curve dashed beside ours.
- **Console**: commands (`help`) or plain questions ("why is the match poor?", "where does the beam point at
  42°?", "plot the pattern"). Questions go to the backend's AI provider with the live model and solution as
  context (`backend/.env`: `GROQ_API_KEY` or `ANTHROPIC_API_KEY`); without one, built-in answers computed from
  the model. Answers can carry commands: actions you asked for run, otherwise they show as one-click suggestions.

Run sheet: `insert patch` → `solve` → `report dB(S(1,1))` → click the dip for a marker → `why is the match
poor?` → click the suggested `set inset …` → `optimize` → `report S(1,1) smith`. Then drop either paper in this
folder and open the Fig. reports under Results.

## Classic demo (`?classic`)

The original scripted pitch-video flow. `?name=Acme` in the URL changes the wordmark. "reset" in the top bar starts over.

The Lego build sound (`frontend/public/sfx/lego-build.mp3`, from `Lego building sfx.mp3`) plays while the 3D model flies together, with the minikit jingle on the moment it's built. Turn it off with "sound on" in the top bar.

There are two papers in this folder. arXiv 2211.13096 (Islam & Shikha, a 2.4 GHz inset-fed patch on FR-4) runs the
patch demo below; arXiv 2508.20905 (Saad et al., a 4×4 phased array at 2.4 GHz) runs the array demo at the end. The app
recognises the patch paper and highlights Table 1, eq. (6), Fig. 3 and Fig. 5. Page through it with the ‹ › buttons, the scroll wheel or the arrow keys. Any other PDF falls back to building from the
design equations.

## Landing page and modeler

The page opens on **Start a design**: a project tree on the left and three choices. **Upload context** (or dropping
the PDF anywhere) is the run sheet below. **Empty design** opens the modeler: draw boxes (B), cylinders (C),
rectangles (R), circles (O) and ports (P) in the XY/XZ/YZ plane (1/2/3) or on any face you hover; everything snaps to
the grid, corners, edge midpoints and face centres. Select (S) and drag the gizmo to move; it snaps flush to other
faces. Ctrl+Z / Ctrl+Y, Ctrl+D, Del, F to fit. **Insert ▸ Patch antenna** drops in an editable patch; **Solve** hands
any model that reads as an inset-fed patch to the solver (the only kind the demo's mock solver handles). Templates
are marked "coming soon". Click the Smart EM mark to get back to the landing page.

## Run sheet (~60–90 s; skip rows to fit)

In the chat box, **Tab** types the suggested message at typing speed and **Enter** sends it.

| # | You do | What shows |
|---|---|---|
| 1 | Drag the PDF from this folder onto the window | Paper opens; attachment chip in the chat |
| 2 | Tab, Enter | Reads the paper, flags 4 mistakes in it, builds the 3D model piece by piece |
| 3 | Orbit the model with the mouse, click **Solve** | The solve plan (~1:34 vs ~25:00 brute force), live S11 |
| 4 | Click **Tune it** | Runs itself: length and inset move together, curves converge, "goal met" after 5 runs |
| 5 | Click **Open Explore** | Effect map (what moves what), contour plot with the path the tuner took |
| 6 | On Explore (a workspace of windows), click metric chips in **Effects on geometry** | Every dimension on the model shows the change in that metric if only it grows 5%; ranked bars; "Where −8.6 Ω comes from" spells out before → after for the selected parameter |
| 7 | **+ parameter** → Inset ratio → Add, then **+ metric** → Goal margin → Add | New dashed dimension, new row and column in What moves what, no new runs |
| 8 | **Smith chart** window: click parameter chips, then "All, at 2.44 GHz" | Dashed loop = that parameter 5% bigger, arrows at 2.40/2.44/2.48 GHz, a sentence on what it does to the loop; readouts for Z, Γ, VSWR, return loss |
| 8b | **Charge & current** tab, drag the frequency strip | Side view of one cycle: + and − at the ends, current through the middle, energy bars trading places; says if the input looks inductive or capacitive |
| 8c | **Fields** tab: E, H, J, S, as vectors or field lines | Animated textbook fields of the patch mode; board drawn 4× thicker |
| 8d | Drag the Smith chart title onto the top-left window's tabs, then drag its tab back out; drag edges to resize; **Tile** | Windows combine into tabs, split apart, resize; Reset layout restores the default |
| 8e | Click nodes in **How it got here** | Each run and what changed; × nodes are rejected one-dimension moves; A2 is a narrower patch with the same S11 |
| 9 | Click a few matrix cells, then click inside the contour | Drill-down chart updates; design moves; Results shows "your edit" |
| 10 | Tab, Enter: "Why did it keep moving the inset…" | Plain-language answer; inset depth highlighted |
| 11 | Tab, Enter: "Can I get more bandwidth…" → **Run it** | Thicker board, re-tuned, 113 → 178 MHz |

Other things it answers: "which parts of the patch matter most at the top of the band?", "what does patch width do?", "what was wrong with the paper?", "why did you solve it
that way?", "make it smaller", "what about gain?". You can also drag any slider on the left at any time, or use
**Pause** / **Take over** while it tunes.

## Array run sheet (~60–90 s)

Uses `Saad_2025_4x4_phased_array_2.4GHz_arXiv_2508.20905.pdf`. Same chat controls: **Tab** types the suggestion,
**Enter** sends it. (`ARRAY_DEMO` in `frontend/src/demo/PaperView.tsx` hides this path when set to false.)

| # | You do | What shows |
|---|---|---|
| 1 | Drag the Saad PDF onto the window | Paper opens on Table I, Fig. 1, Fig. 2 and Fig. 5 |
| 2 | Tab, Enter | Reads the paper, builds the 4×4 in 3D (16 inset-fed patches on Rogers 6010.2LM), flags 4 things in the paper |
| 3 | Click **Solve** | Unit cell, then the full array; inset feed only matched to about −10 dB, misses the ±42° goal |
| 4 | Click **Optimise it** | Element length and inset, then spacing for coupling, then a taper for sidelobes; "Done after N runs" |
| 5 | **Summary** | Before/after for the array: active match, sidelobes and gain across the scan |
| 6 | **Paper vs ours** | All 7 results figures, our curves on the originals (or side by side); a finding under each, e.g. the paper's S11 dip is at 2.377 GHz, and one-snapshot direction finding lands within ~1° where the paper's was 50° off |
| 7 | **Explore ▸ Array designer** | Steer, taper, phase-shifter bits, true-time delay; click elements to fail them; pointing table |
| 8 | **u-v space** | Visible circle, the beam and its grating-lobe copies, the safe scan region |
| 9 | **Scan performance** | Gain and active match across the scan; beam squint over frequency |
| 10 | Tab, Enter, repeated | "Where does the beam really point at 42°?", "two elements fail?", "how many bits?", "spacing for 60°?", "beam squint?", "what was wrong with the paper?" |

The chat questions are `ARRAY_QUESTIONS` in `frontend/src/demo/Demo.tsx`. **How it was solved ▸ Why these choices**
ties each solver, mesh, sweep and optimiser choice to the geometry, for both demos.
