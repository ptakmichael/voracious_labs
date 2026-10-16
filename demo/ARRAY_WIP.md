# Notes: phased-array demo + "Paper vs ours"

Updated 2026-10-15. Committed on `main` in ~/smart-em-solver (older snapshot: branch `wip/phased-array`).
Typecheck (`cd frontend && npx tsc -b`) and lint pass. Run: `cd frontend && npm run dev` → http://localhost:5173/demo.html.
`ARRAY_DEMO = true` in `frontend/src/demo/PaperView.tsx` (set false to hide the array-paper path).

## What the user asked for (latest)
1. A second mock demo: drop a phased-array paper and it reads, builds, solves and optimises like the patch demo,
   plus array-designer tools (spacing, phase, taper, bits, failures, grating lobes, TTD…). MOSTLY DONE.
2. "Why these choices": explain the solver and optimiser choices from the geometry. DONE.
3. Replicate every plot in each paper and superimpose our results on theirs, for both papers. DONE.

## Papers (in demo/)
- Patch: Islam & Shikha, arXiv 2211.13096.
- Array: Saad et al., arXiv 2508.20905, `Saad_2025_4x4_phased_array_2.4GHz_arXiv_2508.20905.pdf`.
  This one has the arXiv non-exclusive licence: check before keeping it in the PUBLIC voracious_labs repo.

## Files (frontend/src/demo/)
- `arrayModel.ts`: array-factor model, tapers, phase-shifter bits, TTD, failures, grating lobes, active S11,
  beam(), arrayMetrics().
- `paperPlots.ts`: GENERATED. All 18 digitised figures (box on the page, data→page-point map, polar calibration).
  The generator scripts are in `demo/digitise/` (dig.py, extract.py, crop.py; they run on 200-dpi pdftoppm renders).
- `paperPhysics.ts`: patch far field, directivity, gain, efficiency, power budget; array steering cuts; MUSIC DoA.
- `Compare.tsx`: "Paper vs ours" tab. Overlays on the original PDF figure or side by side, with a finding per figure.
- `decisions.ts` + `SolveReport.tsx`: "Why these choices" tab (patch and array), and array Solver/Setup/Steps tabs.
- `ArrayScene.tsx`: 3D 4×4 build plus the 3D beam. `ArrayTools.tsx`: Array designer, u-v space, Scan performance,
  ArrayResults (Results tab), ArraySide (sidebar). `Summary.tsx`: ArraySummary. `Understand.tsx`: ARRAY_LAYOUT.
- `store.ts`: kind 'patch'|'array', arr, setArr, the array build/solve/optimise flow, and the array chat intents.

## Verified in headless Chrome
- **Patch demo:** end to end, including Paper vs ours (all 11 figures line up with the original axes).
- **Array demo:** read → build (3D) → solve → summary → Paper vs ours (7 figures) → Explore designer, u-v, and chat answers. No errors.

## Status (2026-10-15): finished and committed
- Array walkthrough re-tested in headless Chrome, dark and light: read → build → solve → optimise → Summary,
  Paper vs ours, Results, Explore (designer, u-v, scan) and all six ARRAY_QUESTIONS. No page or console errors.
- Fixed during that pass: the Results "Goal met" card showed the patch text on the array; the steering table
  overflowed its card; "-90.00" angle ticks; the array designer's narrow layout (the `.pane` container can't
  query itself, so the rule now moves `.ad-view`); right-column warning labels on the paper ran off the page;
  the step bar overlapped the status at widths under 1700 px.
- Run sheet: "Array run sheet" in demo/README.md.
- The Saad PDF (arXiv non-exclusive licence) is committed to the public repo at the user's request.
