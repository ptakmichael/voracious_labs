"""Chat handling: a deterministic intent parser for commands, Claude for free-form questions."""
from __future__ import annotations

import json
import os
import re

from .orchestrator import COMPAT, MODEL, PROVIDER_LABEL, compat_client, have_api_key, provider
from .pipeline import Run
from .problem import SOLVER_LABEL

HELP = ('I can take commands like "use FEM", "use openEMS", "refine", "coarser", "cross-check", '
        '"skip cross-check", "approve", "stop", "pause", "resume", "set tolerance 0.01", or answer "why …" questions.')

CHAT_SYSTEM = """You are the voice of Smart EM Solver, an EM simulation assistant for RF engineers. Answer the \
engineer's message in 1-3 short, plain sentences, like a calm senior numerical analyst. Use only numbers present in \
the provided state JSON; if something isn't known yet, say so. The solver in this build is a MOCK, so never claim \
real simulation results. No markdown, no emojis. If they ask for an action you can't take via chat, tell them which \
command or button to use. Supported chat commands: use FEM / use openEMS, refine / coarser, cross-check / skip \
cross-check, approve, stop, pause, resume, set tolerance <0.1|0.03|0.01>."""


async def ask_claude(state: dict, text: str, history: list[dict]) -> str | None:
    """Free-form answer from the active LLM provider (name kept for the existing call sites)."""
    if not have_api_key():
        return None
    if provider() in COMPAT:
        return await ask_compat(provider(), state, text, history)
    try:
        import anthropic
        client = anthropic.AsyncAnthropic()
        convo = "\n".join(f"{m['role']}: {m['text']}" for m in history[-8:])
        resp = await client.beta.messages.create(
            model=MODEL, max_tokens=2000, system=CHAT_SYSTEM,
            output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            messages=[{"role": "user", "content": f"Current state:\n{json.dumps(state, default=str)}\n\n"
                                                  f"Recent conversation:\n{convo}\n\nEngineer: {text}"}],
        )
        if resp.stop_reason == "refusal":
            return None
        out = "".join(b.text for b in resp.content if b.type == "text").strip()
        return out or None
    except Exception as e:  # never break the chat, but say why Claude didn't answer
        import anthropic
        print("chat error:", repr(e))
        if isinstance(e, anthropic.AuthenticationError):
            return ("(Claude is unavailable: the backend's ANTHROPIC_API_KEY was rejected as invalid. Restart the "
                    "backend with a valid key. Until then I can only handle commands.)")
        if isinstance(e, anthropic.RateLimitError):
            return "(Claude is rate-limited right now; try again in a moment.)"
        if isinstance(e, anthropic.APIConnectionError):
            return "(I couldn't reach the Anthropic API from the backend; check the network.)"
        return f"(Claude call failed: {type(e).__name__}. Details are in the backend log.)"


async def ask_compat(p: str, state: dict, text: str, history: list[dict]) -> str | None:
    name = PROVIDER_LABEL[p]
    try:
        client = compat_client(p, max_retries=2)
        convo = "\n".join(f"{m['role']}: {m['text']}" for m in history[-6:])
        resp = await client.chat.completions.create(
            model=COMPAT[p]["model"], max_tokens=400,
            messages=[{"role": "system", "content": CHAT_SYSTEM},
                      {"role": "user", "content": f"Current state:\n{json.dumps(state, default=str)}\n\n"
                                                  f"Recent conversation:\n{convo}\n\nEngineer: {text}"}])
        return (resp.choices[0].message.content or "").strip() or None
    except Exception as e:
        import openai
        print("chat error:", repr(e))
        key = COMPAT[p]["key_env"]
        if isinstance(e, openai.AuthenticationError):
            return f"({name} is unavailable: {key} was rejected. Restart the backend with a valid key.)"
        if isinstance(e, openai.RateLimitError):
            return f"({name}'s free tier is rate-limited right now; try again in a minute.)"
        if isinstance(e, openai.PermissionDeniedError):
            return f"({name} refused the request: {str(e)[:160]})"
        if isinstance(e, openai.APIConnectionError):
            return f"(I couldn't reach {name} from the backend; check the network.)"
        return f"({name} call failed: {type(e).__name__}. Details are in the backend log.)"


def _why_answer(run: Run, text: str) -> str:
    t = text.lower()
    if run.selection and any(k in t for k in ("fem", "palace", "fdtd", "openems", "method", "solver", "choose", "chose")):
        return "Selector: " + run.selection["reason"]
    if "mesh" in t and run.plan:
        return f"The mesh follows the {run.plan['label']} fidelity {run.plan['fidelity']} table ({run.plan['fidelity_desc']})" + (
            ", with extra refinement through the thin substrate." if run.feat and run.feat["thin"] else ".")
    if run.decisions:
        d = run.decisions[-1]
        return f"Latest decision ({d['kind']}): {d['choice']} because {d['reason']}."
    return "I haven't made a decision yet. Press Run and I'll explain every choice."


async def handle(run: Run | None, text: str, project_state: dict | None = None) -> dict:
    """Returns {reply, action}. If run is given, also emits events."""
    t = text.strip().lower()
    action = None
    reply = None

    async def you():
        if run:
            await run.say(text, role="user")

    if run is None:
        reply = await ask_claude({"stage": "setup", "project": project_state, "mock_solver": True}, text, [])
        return {"reply": reply or ("Set up your geometry and goals, then press Run. " + HELP), "action": None}

    await you()
    pending = run.pending["target"] if run.pending else None

    def hold():
        run.hold = True

    approve_words = re.search(r"\b(approve|approved|yes|looks good|lgtm|go ahead|start|ok|okay|proceed|sounds good)\b", t)
    if approve_words and pending and len(t.split()) <= 5 and not re.search(r"\b(use|switch|feed|why|but|edit)\b", t):
        run.resolve(True, by="chat", message=text)
        action, reply = "approve", {"plan": "Starting the solve.", "design": "Applying the change and re-running.",
                                    "fix": "Applying the fix."}.get(pending, "Approved.")
    elif re.search(r"\b(stop|cancel|abort)\b", t):
        run.cancelled = True
        run.paused.set()
        action, reply = "cancel", "Stopping the run."
    elif re.search(r"\bpause\b", t):
        run.paused.clear()
        action, reply = "pause", "Paused. Say resume to continue."
    elif re.search(r"\b(resume|continue)\b", t):
        run.paused.set()
        action, reply = "resume", "Resuming."
    elif re.search(r"\b(skip|no|without)\b.*cross", t):
        run.cross_check = False
        if run.plan:
            run.plan["cross_check"] = False
            await run.emit_plan()
        action, reply = "skip_cross_check", "Cross-check skipped. The error bar will rest on convergence alone."
        if pending:
            hold()
    elif "cross" in t:
        run.cross_check = True
        if run.plan:
            run.plan["cross_check"] = True
            await run.emit_plan()
        other = "openEMS" if (run.plan and run.plan["solver"] == "palace") else "Palace"
        action = "cross_check"
        reply = f"Queued {other} (fidelity 1) right after this run. It will tighten the error bar."
        await run.log(f"You: cross-check with {other} → queued")
        if pending:
            hold()
    elif re.search(r"\b(use|switch to|try)\b.*\b(fem|palace|fdtd|openems|open ems)\b", t) and not re.search(r"\bwhy\b", t):
        solver = "palace" if re.search(r"fem|palace", t) else "openems"
        if run.plan:
            run.plan = run._make_plan(solver, run.plan["fidelity"])
            await run.emit_plan()
        run.decide("user_override", solver, f"engineer asked: {text}")
        action = "switch_solver"
        reply = f"Switched the plan to {SOLVER_LABEL[solver]}." + (" Say approve or press Start solve when ready."
                                                                   if pending == "plan" else " It applies to the next solve.")
        if pending == "plan":
            hold()
        else:
            run.inbox.append(text)
    elif re.search(r"\b(refine|higher fidelity|finer|coarser|lower fidelity)\b", t):
        up = not re.search(r"coarser|lower", t)
        if run.plan:
            fid = max(0, min(2, run.plan["fidelity"] + (1 if up else -1)))
            run.plan = run._make_plan(run.plan["solver"], fid)
            await run.emit_plan()
            reply = f"Fidelity set to {fid} ({run.plan['fidelity_desc']})."
        else:
            reply = "I'll apply that once the plan exists."
        action = "fidelity"
        run.inbox.append(text)
        if pending == "plan":
            hold()
    elif m := re.search(r"tolerance\s*(0?\.\d+)", t):
        v = float(m.group(1))
        acc = "tight" if v <= 0.015 else "standard" if v <= 0.05 else "quick"
        run.settings["accuracy"] = acc
        action, reply = "tolerance", f"Accuracy target set to {acc} (±{v})."
        run.inbox.append(text)
    elif pending == "design" and re.search(r"\bfeed\b", t):
        run.resolve(False, by="chat", message=text)
        action, reply = "decline", "Okay, exploring the feed position instead."
    elif pending == "design" and re.search(r"\bedit\b", t):
        hold()
        action, reply = "edit", "Edit the proposed value in the Design optimizer panel, then press Approve and re-run."
    elif re.search(r"\bwhy\b|\?$|^(what|how|explain)", t):
        if pending:
            hold()
        reply = await ask_claude(run.context_summary(), text, run.chat) or _why_answer(run, text)
        action = "answer"
    else:
        if pending:
            run.resolve(False, by="chat", message=text)
            action = "decline"
            reply = await ask_claude(run.context_summary(), text, run.chat) or "Got it, reconsidering."
        else:
            run.inbox.append(text)
            reply = await ask_claude(run.context_summary(), text, run.chat) or ("Noted; I'll factor that in at the next step. " + HELP)
            action = "noted"
    await run.say(reply)
    return {"reply": reply, "action": action}
