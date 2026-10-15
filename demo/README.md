# Pitch-video demo

An interactive, front-end-only demo at `/demo.html`. Every number comes from a mock patch model in
`frontend/src/demo/model.ts`; no solver or backend is called.

```bash
cd frontend
npm install
npm run dev            # open http://localhost:5173/demo.html, full screen (F11), 1920×1080
```

`?name=Acme` in the URL changes the wordmark. "reset" in the top bar starts over.

The Lego build sound (`frontend/public/sfx/lego-build.mp3`, from `Lego building sfx.mp3`) plays while the 3D model flies together, with the minikit jingle on the moment it's built. Turn it off with "sound on" in the top bar.

The paper in this folder is arXiv 2211.13096 (Islam & Shikha, a 2.4 GHz inset-fed patch on FR-4). The app
recognises it and highlights Table 1, eq. (6), Fig. 3 and Fig. 5. Page through it with the ‹ › buttons, the scroll wheel or the arrow keys. Any other PDF falls back to building from the
design equations.

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
