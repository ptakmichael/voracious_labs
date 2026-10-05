"""Orchestrators. Both call the same tool layer on `Run`.

- LLMOrchestrator: Claude (via the Anthropic API) decides the next tool and narrates.
- ScriptedOrchestrator: deterministic fallback with template narration (no API key needed).
"""
from __future__ import annotations

import json
import os
import traceback

from .pipeline import MAX_DESIGN_ITERS, MAX_FIXES, Run, RunCancelled
from .problem import ACCURACY, SOLVER_LABEL

MODEL = os.environ.get("EMSOLVER_MODEL", "claude-opus-5-5")
# OpenAI-compatible providers. Groq has a permanent free tier (no card; ~8K tokens/min, rate-limited per day).
# OpenCode Zen's free models only work inside the OpenCode client, so "bigpickle" needs paid Zen credits.
COMPAT = {
    "groq": {"label": "Groq", "base_url": "https://api.groq.com/openai/v1", "key_env": "GROQ_API_KEY",
             "model": os.environ.get("EMSOLVER_GROQ_MODEL", "openai/gpt-oss-120b")},
    "bigpickle": {"label": "Big Pickle", "base_url": os.environ.get("OPENCODE_BASE_URL", "https://opencode.ai/zen/v1"),
                  "key_env": "OPENCODE_API_KEY", "model": os.environ.get("EMSOLVER_OPENCODE_MODEL", "big-pickle")},
}
PROVIDER_LABEL = {"claude": "Claude", "scripted": "Scripted", **{k: v["label"] for k, v in COMPAT.items()}}


def provider() -> str:
    """claude | groq | bigpickle | scripted. EMSOLVER_PROVIDER wins; otherwise the first key found."""
    want = os.environ.get("EMSOLVER_PROVIDER", "").lower().replace("opencode", "bigpickle")
    has = {"claude": bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")),
           **{k: bool(os.environ.get(v["key_env"])) for k, v in COMPAT.items()}}
    if os.environ.get("EMSOLVER_ORCHESTRATOR") == "scripted" or want == "scripted":
        return "scripted"
    if has.get(want):
        return want
    return next((k for k in ("claude", "groq", "bigpickle") if has[k]), "scripted")


def model_name() -> str | None:
    p = provider()
    return MODEL if p == "claude" else COMPAT[p]["model"] if p in COMPAT else None


def compat_client(p: str, max_retries: int = 0):
    from openai import AsyncOpenAI
    c = COMPAT[p]
    return AsyncOpenAI(base_url=c["base_url"], api_key=os.environ[c["key_env"]], max_retries=max_retries)


SYSTEM = f"""You are the orchestrator of Smart EM Solver, an electromagnetic simulation tool that behaves like an \
expert numerical analyst. An RF engineer has set up a problem (geometry, band, accuracy target, design goal, autonomy \
level). You run the pipeline by calling tools, one at a time, and you narrate each step to the engineer.

Rules:
- Verified code does the physics. You never invent, estimate or alter numbers; quote only numbers that tools returned.
- Every tool takes a `narration`: one or two plain sentences (max ~35 words) shown to the engineer in the chat line. \
Explain what you are doing and why, like a calm senior engineer. No emojis, no hype, no markdown.
- Never skip verification. A result is trustworthy only after `verify` passes.
- Typical order: build_problem → analyze_geometry → select_method → propose_plan → run_solver → run_cross_check \
(if the plan says cross_check is true) → verify → (if verify fails: apply_numerical_fix, then re-run solver, \
cross-check and verify) → check_goal → (if goal not met: propose_design_change, then re-run solver, cross-check, \
verify, check_goal) → finish.
- Numerical-fix policy, in order: padding (λ/4 → λ/2) when the cross-check disagrees, then raise_fidelity when \
convergence fails, then switch_method. Max {MAX_FIXES} fixes and {MAX_DESIGN_ITERS} design iterations; on a limit, finish.
- Approvals and autonomy are enforced inside the tools. If a tool returns approved=false with a user_message, adapt \
to what the engineer asked (e.g. propose a feed-offset change instead, or switch solver) rather than repeating yourself.
- Tool results may include `user_messages` the engineer typed mid-run. Honour them.
- The solver is a MOCK in this build; do not claim results are from a real solver.
- When done, call `finish` with status met_verified, verified_not_met, or not_verified, and a one-sentence headline."""

_N = {"narration": {"type": "string", "description": "1-2 sentences for the engineer about this step"}}


def _tool(name, desc, props=None, required=None):
    props = {**_N, **(props or {})}
    return {"name": name, "description": desc,
            "input_schema": {"type": "object", "properties": props, "required": ["narration", *(required or [])]}}


TOOLS = [
    _tool("build_problem", "Convert the setup geometry and settings into the canonical, validated problem description."),
    _tool("analyze_geometry", "Compute cheap geometry features (electrical size, h/λd, εr, boundary, ports, band)."),
    _tool("select_method", "Rule-based method selector: predicted cost and p(fastest) per solver, plus the rule that fired."),
    _tool("propose_plan", "Propose the run plan (solver, fidelity, auto-optimizations). Blocks for approval per autonomy. "
          "Omit solver/fidelity to take the selector's top option.",
          {"solver": {"type": "string", "enum": ["palace", "openems"]}, "fidelity": {"type": "integer", "enum": [0, 1, 2]}}),
    _tool("run_solver", "Run the planned primary solve and stream progress. Returns a short summary (resonance, min S11, band).",
          {"solver": {"type": "string", "enum": ["palace", "openems"]}, "fidelity": {"type": "integer", "enum": [0, 1, 2]}}),
    _tool("run_cross_check", "Run the other solver at fidelity 1 to cross-check the primary result."),
    _tool("verify", "Verify the latest primary result: passivity, convergence to next fidelity, cross-check. Returns error bar."),
    _tool("apply_numerical_fix", "Apply a numerical fix after failed verification.",
          {"fix": {"type": "string", "enum": ["padding", "raise_fidelity", "switch_method"]},
           "reason": {"type": "string"}}, ["fix"]),
    _tool("check_goal", "Compare the verified result against the design goal (S11 below threshold across the goal band)."),
    _tool("propose_design_change", "Design optimizer: explore with coarse runs and propose a geometry change toward the goal. "
          "Blocks for approval per autonomy.",
          {"variable": {"type": "string", "enum": ["patch_length", "feed_offset"]}, "rationale": {"type": "string"}}),
    _tool("finish", "Finish the run and publish results.",
          {"status": {"type": "string", "enum": ["met_verified", "verified_not_met", "not_verified"]},
           "headline": {"type": "string"}}, ["status", "headline"]),
]


async def dispatch(run: Run, name: str, args: dict) -> dict:
    if name == "build_problem":
        return await run.tool_build_problem()
    if name == "analyze_geometry":
        return await run.tool_analyze_geometry()
    if name == "select_method":
        return await run.tool_select_method()
    if name == "propose_plan":
        return await run.tool_propose_plan(args.get("solver"), args.get("fidelity"))
    if name == "run_solver":
        return await run.tool_run_solver(args.get("solver"), args.get("fidelity"))
    if name == "run_cross_check":
        return await run.tool_run_cross_check()
    if name == "verify":
        return await run.tool_verify()
    if name == "apply_numerical_fix":
        return await run.tool_apply_numerical_fix(args.get("fix", "padding"), args.get("reason", ""))
    if name == "check_goal":
        return await run.tool_check_goal()
    if name == "propose_design_change":
        return await run.tool_propose_design_change(args.get("variable", "patch_length"), args.get("rationale", ""))
    if name == "finish":
        return await run.tool_finish(args.get("status", ""), args.get("headline", ""))
    return {"error": f"unknown tool {name}"}


def _prereq_error(run: Run, name: str) -> str | None:
    need = {"analyze_geometry": run.geo, "select_method": run.feat, "propose_plan": run.selection,
            "run_solver": run.plan, "run_cross_check": run.primary, "verify": run.primary,
            "check_goal": run.last_verify, "propose_design_change": run.last_goal}
    if name in need and not need[name]:
        return f"{name} called too early; follow the pipeline order"
    return None


def request_text(run: Run) -> str:
    s, g = run.settings, run.goal
    c = run.project.get("constraints", {})
    objs = [f"{o['name']} ({o['kind']}, {o.get('material')}, {o['size'][0]}×{o['size'][1]}×{o['size'][2]} mm)"
            for o in run.project["objects"]]
    return (f"Project {run.project.get('name')}. Geometry objects: {'; '.join(objs)}.\n"
            f"Band {s['f_start']}–{s['f_stop']} GHz, {s['n_points']} points, accuracy {s['accuracy']} "
            f"(±{ACCURACY[s['accuracy']]}). Goal: S11 below {g['threshold_db']} dB from {g['f1']} to {g['f2']} GHz. "
            f"Constraints: patch length ±{c.get('length_pct', 10)}%, feed position "
            f"{'free' if c.get('feed_free', True) else 'fixed'}. Plots: {', '.join(s.get('plots', []))}. "
            f"Autonomy: {run.autonomy}. Please run the pipeline.")


class LLMOrchestrator:
    name = "claude"

    def __init__(self, run: Run):
        import anthropic
        self.run = run
        self.client = anthropic.AsyncAnthropic()

    async def call(self, messages):
        return await self.client.beta.messages.create(
            model=MODEL, max_tokens=8000, system=SYSTEM, tools=TOOLS, messages=messages,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )

    async def go(self):
        run = self.run
        run.orchestrator_name = "claude"
        messages = [{"role": "user", "content": request_text(run)}]
        nudges = 0
        for _ in range(80):
            resp = await self.call(messages)
            if resp.stop_reason == "refusal":
                raise RuntimeError("model declined the request")
            messages.append({"role": "assistant", "content": resp.content})
            uses = [b for b in resp.content if b.type == "tool_use"]
            if not uses:
                if run.finished:
                    return
                nudges += 1
                if nudges > 2:
                    raise RuntimeError("orchestrator stopped without finishing")
                messages.append({"role": "user", "content": "Continue the pipeline by calling the next tool."})
                continue
            results = []
            for b in uses:
                out, is_err = await exec_tool(run, b.name, b.input if isinstance(b.input, dict) else {})
                results.append({"type": "tool_result", "tool_use_id": b.id, "content": json.dumps(out, default=str),
                                **({"is_error": True} if is_err else {})})
            messages.append({"role": "user", "content": results})
            if run.finished:
                return
        raise RuntimeError("orchestrator exceeded step limit")


async def exec_tool(run: Run, name: str, args: dict) -> tuple[dict, bool]:
    await run.say(args.get("narration", ""))
    err = _prereq_error(run, name)
    if err:
        return {"error": err}, True
    out = await dispatch(run, name, args)
    return out, "error" in out


OPENAI_TOOLS = [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                                  "parameters": t["input_schema"]}} for t in TOOLS]


class OpenAICompatOrchestrator:
    """Same tools over an OpenAI-compatible chat-completions API (Groq, OpenCode Zen, ...).

    Free tiers meter tokens per minute, so each request carries only: the system prompt, the engineer's request plus a
    one-line-per-step progress log, and the last few tool exchanges, not the whole growing transcript.
    """
    KEEP_TURNS = 2

    def __init__(self, run: Run, p: str):
        self.run = run
        self.p = p
        self.model = COMPAT[p]["model"]
        self.client = compat_client(p)

    async def complete(self, messages):
        import openai
        for attempt in range(8):
            try:
                return await self.client.chat.completions.create(
                    model=self.model, messages=messages, tools=OPENAI_TOOLS, tool_choice="auto", max_tokens=900)
            except openai.RateLimitError as e:
                wait = 8.0
                try:
                    wait = float(e.response.headers.get("retry-after", wait))
                except (TypeError, ValueError):
                    pass
                wait = min(max(wait, 1.0), 60.0)
                await self.run.log(f"{PROVIDER_LABEL[self.p]} free-tier rate limit; waiting {wait:.0f} s", "warn")
                await self.run.sleep(wait * self.run.speed)  # real seconds, still cancellable
            except openai.BadRequestError as e:
                # open models occasionally emit malformed tool-call JSON; Groq rejects it as tool_use_failed
                if "tool_use_failed" not in str(e) or attempt >= 3:
                    raise
                await self.run.log(f"{PROVIDER_LABEL[self.p]} produced a malformed tool call; retrying", "warn")
            except openai.APIConnectionError:
                if attempt >= 2:
                    raise
                await self.run.sleep(2 * self.run.speed)
        raise RuntimeError("rate limit did not clear")

    async def go(self):
        run = self.run
        run.orchestrator_name = self.p
        progress: list[str] = []
        turns: list[list[dict]] = []
        nudges = 0
        for _ in range(80):
            head = request_text(run) + ("\n\nSteps completed so far (oldest first):\n" + "\n".join(progress[-30:])
                                        if progress else "")
            window = [m for t in turns[-self.KEEP_TURNS:] for m in t]
            resp = await self.complete([{"role": "system", "content": SYSTEM}, {"role": "user", "content": head}, *window])
            msg = resp.choices[0].message
            calls = msg.tool_calls or []
            turn: list[dict] = [{"role": "assistant", "content": msg.content or "",
                                 **({"tool_calls": [{"id": c.id, "type": "function",
                                                     "function": {"name": c.function.name,
                                                                  "arguments": c.function.arguments or "{}"}}
                                                    for c in calls]} if calls else {})}]
            turns.append(turn)
            if not calls:
                if run.finished:
                    return
                nudges += 1
                if nudges > 2:
                    raise RuntimeError("orchestrator stopped without finishing")
                turn.append({"role": "user", "content": "Continue the pipeline by calling the next tool."})
                continue
            for c in calls:
                try:
                    args = json.loads(c.function.arguments or "{}")
                    if not isinstance(args, dict):
                        raise ValueError("arguments must be an object")
                except (json.JSONDecodeError, ValueError) as e:
                    out = {"error": f"invalid JSON arguments: {e}"}
                else:
                    out, _ = await exec_tool(run, c.function.name, args)
                res = json.dumps(out, default=str)
                turn.append({"role": "tool", "tool_call_id": c.id, "content": res})
                progress.append(f"- {c.function.name}: {res[:110]}")
            if run.finished:
                return
        raise RuntimeError("orchestrator exceeded step limit")


class ScriptedOrchestrator:
    """Same tools, fixed policy, template narration."""
    name = "scripted"

    def __init__(self, run: Run):
        self.run = run

    async def step(self, name, narration="", **args):
        await self.run.say(narration)
        return await dispatch(self.run, name, args)

    async def continue_from_state(self):
        await self.go(resume=True)

    async def go(self, resume=False):
        r = self.run
        if not resume:
            r.orchestrator_name = "scripted"
        if not r.geo:
            await self.step("build_problem", "Building the problem description from your geometry and checking units, "
                                             "materials and ports.")
        if not r.feat:
            await self.step("analyze_geometry")
        if not r.selection:
            await self.step("select_method")
        if not r.plan_approved:
            await self.plan_loop()
        if not r.last_verify:
            await self.solve_cycle(first=r.primary is None)
        await self.iterate()

    async def plan_loop(self):
        r = self.run
        win = SOLVER_LABEL[r.selection["winner"]].replace(" · ", " (") + ")"
        why = r.selection["rule"]
        msg = f"The {why}, so I'm choosing {win}."
        if r.symmetric() and r.selection["winner"] == "palace":
            msg = msg[:-1] + " with the y = 0 symmetry plane."
        if r.autonomy == "balanced":
            msg += " Starting in 10 s unless you change something."
        elif r.autonomy == "ask":
            msg += " Approve the plan when you're ready."
        while True:
            res = await self.step("propose_plan", msg, solver=r.plan["solver"] if r.plan else None,
                                  fidelity=r.plan["fidelity"] if r.plan else None)
            if res["approved"]:
                break
            msg = "Understood. Here's the revised plan."

    async def iterate(self):
        r = self.run
        while True:
            # numerical loop
            while not r.last_verify["passed"]:
                if len(r.fixes) >= MAX_FIXES:
                    return await self.step("finish", "I hit the numerical-fix limit; reporting the result as not verified.",
                                           status="not_verified", headline="Not verified after the maximum number of fixes")
                failed = [c for c in r.last_verify["checks"] if not c["passed"]]
                if any("Cross" in c["name"] for c in failed) and r.padding < 0.5:
                    fix, why = "padding", "the cross-check disagrees on resonance; a tight air box detunes FDTD"
                elif any("Convergence" in c["name"] for c in failed):
                    fix, why = "raise_fidelity", "the result is still changing with mesh density"
                else:
                    fix, why = "switch_method", "the other method is more robust here"
                await self.step("apply_numerical_fix", f"Verification failed: {why}. Trying {fix.replace('_', ' ')} "
                                                       "and re-running.", fix=fix, reason=why)
                await self.solve_cycle()
            g = await self.step("check_goal", f"Verified to ±{r.last_verify['error_bar']}. Checking the design goal.")
            if g["met"]:
                return await self.step("finish", "", status="met_verified",
                                       headline=f"Goal met and verified to ±{r.last_verify['error_bar']}")
            if len(r.design_history) >= MAX_DESIGN_ITERS:
                return await self.step("finish", "", status="verified_not_met", headline="Verified, goal not met")
            band = g["measured_band_ghz"]
            bt = f"{band[0]:.2f}–{band[1]:.2f} GHz" if band else "nowhere in the band"
            var = "patch_length"
            narration = (f"Verified, but S11 is below {r.goal['threshold_db']} dB only from {bt}. "
                         "Exploring a geometry change with coarse runs.")
            while True:
                d = await self.step("propose_design_change", narration, variable=var)
                if d.get("approved"):
                    break
                um = (d.get("user_message") or "").lower()
                var = "feed_offset" if "feed" in um else "patch_length"
                narration = "Okay, trying a different change."
                if "error" in d:
                    return await self.step("finish", "", status="verified_not_met", headline="Verified, goal not met")
            await self.solve_cycle()

    async def solve_cycle(self, first=False):
        r = self.run
        p = r.plan
        await self.step("run_solver", f"Solving with {SOLVER_LABEL[p['solver']]} at fidelity {p['fidelity']}." if first
                        else "Re-solving with the updated setup.")
        if r.cross_check:
            other = "openEMS" if p["solver"] == "palace" else "Palace"
            await self.step("run_cross_check", f"Cross-checking with {other} at fidelity 1 to tighten the error bar.")
        await self.step("verify", "Verifying: passivity, convergence to the next fidelity, and the cross-check.")


def have_api_key() -> bool:
    return provider() != "scripted"


async def run_pipeline(run: Run, scripted: bool = False):
    try:
        p = "scripted" if scripted else provider()
        if p != "scripted":
            try:
                await (LLMOrchestrator(run) if p == "claude" else OpenAICompatOrchestrator(run, p)).go()
            except RunCancelled:
                raise
            except Exception as e:  # fall back so the demo never dead-ends
                traceback.print_exc()
                await run.emit("error", {"message": f"{PROVIDER_LABEL[p]} orchestrator error: {e}. Continuing with scripted orchestrator.",
                                         "where": "orchestrator"})
                if not run.finished:
                    await ScriptedOrchestrator(run).continue_from_state()
        else:
            await ScriptedOrchestrator(run).go()
    except RunCancelled:
        run.state = "cancelled"
        await run.emit("run_finished", {"status": "cancelled", "mock": True})
    except Exception as e:
        traceback.print_exc()
        await run.emit("error", {"message": str(e), "where": "pipeline"})
        await run.emit("run_finished", {"status": "failed", "mock": True})
