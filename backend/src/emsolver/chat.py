"""Chat handling: a deterministic intent parser for commands, Claude for free-form questions."""
from __future__ import annotations

import json
import os
import re

from . import explorer as ex_mod
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


# ---------------------------------------------------------------- explorer intents (EXPLORER_README §5.3)
VAR_ALIASES = {
    "feed": "feed_x", "feed position": "feed_x", "feed offset": "feed_x", "feed x": "feed_x", "probe": "feed_x",
    "length": "L_res", "resonant length": "L_res", "patch length": "L_res", "l": "L_res",
    "width": "W", "patch width": "W", "height": "h", "substrate height": "h", "thickness": "h",
    "substrate thickness": "h", "permittivity": "eps_r", "epsilon": "eps_r", "er": "eps_r", "εr": "eps_r",
    "substrate εr": "eps_r", "ground margin": "margin", "ground": "margin",
}
METRIC_ALIASES = {
    "resonance": "f_res", "resonant frequency": "f_res", "frequency": "f_res", "fres": "f_res",
    "bandwidth": "bw_10db", "bw": "bw_10db", "-10 db bandwidth": "bw_10db",
    "re zin": "Zin_re_fc", "rezin": "Zin_re_fc", "zin": "Zin_re_fc", "input resistance": "Zin_re_fc",
    "resistance": "Zin_re_fc", "real zin": "Zin_re_fc", "re z": "Zin_re_fc",
    "im zin": "Zin_im_fc", "reactance": "Zin_im_fc", "input reactance": "Zin_im_fc", "im z": "Zin_im_fc",
    "s11": "S11_dB_fc", "|s11|": "S11_dB_fc", "match": "S11_dB_fc", "matching": "S11_dB_fc",
    "vswr": "VSWR_min", "gain": "gain_bs", "boresight gain": "gain_bs", "gain boresight": "gain_bs",
    "axial ratio": "axial_ratio", "ar": "axial_ratio", "goal margin": "goal_margin", "margin to goal": "goal_margin",
}
OVERLAYS = {"|e|": "E", "e": "E", "e field": "E", "|e| field": "E", "field": "E", "e-field": "E",
            "current": "J", "surface current": "J", "j": "J", "currents": "J",
            "sensitivity": "sens", "sensitivity paint": "sens", "none": "none", "off": "none", "nothing": "none"}


def _clean(phrase: str) -> str:
    p = phrase.strip().strip("?.!\"'").strip()
    p = re.sub(r"^(the|a|an)\s+", "", p, flags=re.I)
    return re.sub(r"\s+(here|now|actually|exactly)$", "", p, flags=re.I).strip()


def _resolve(phrase: str, names: list[str], aliases: dict[str, str]) -> str | None:
    p = _clean(phrase)
    for n in names:
        if n.lower() == p.lower():
            return n
    hit = aliases.get(p.lower())
    return hit if hit in names else None


async def explorer_intent(run: Run, text: str) -> dict | None:
    """Deterministic answers from the Jacobian and response surfaces. None if the text isn't an explorer intent."""
    t = text.strip()
    pats = {
        "what_does": r"^what\s+does\s+(.+?)\s+(?:actually\s+)?do\b",
        "what_controls": r"^what\s+controls\s+(.+?)\??$",
        "define": r"^define\s+([A-Za-z_]\w*)\s*=\s*(.+?)(?:\s+holding\s+(.+?))?\s*$",
        "add_metric": r"^add\s+metric\s+([A-Za-z_]\w*)\s*=\s*(.+?)(?:\s+unit\s+(\S+))?\s*$",
        "color": r"^colou?r\s+handles\s+by\s+(.+?)\s*$",
        "overlay": r"^(?:show\s+)?overlay\s+(.+?)\s*$",
        "matrix": r"^(?:show|open)\s+(?:the\s+)?(?:effect\s+)?matrix\s*$",
        "show_vs": r"^show\s+(.+?)\s+vs\.?\s+(.+?)\s*$",
        "reach": r"^reach\s+(.+?)\s*=\s*(-?[\d.]+)\s*([^\s\d]*)\s+using\s+(.+?)\s*$",
    }
    kind, m = None, None
    for k, pat in pats.items():
        m = re.match(pat, t, flags=re.I)
        if m:
            kind = k
            break
    if not kind:
        return None
    if not run.finished or not run.primary:
        return {"reply": "The 3D explorer and effect matrix open once the run has results. I'll pick this up then.",
                "ui": None}
    try:
        ex = ex_mod.for_run(run)
    except ex_mod.ExplorerError as e:
        return {"reply": str(e), "ui": None}
    var_names = [v["name"] for v in ex.variables_view()]
    met_names = ex.metric_names()
    var = lambda s: _resolve(s, var_names, VAR_ALIASES)
    met = lambda s: _resolve(s, met_names, METRIC_ALIASES)
    label = {mm["name"]: mm["label"] for mm in ex.metric_meta()}

    if kind == "what_does":
        v = var(m.group(1))
        if not v:
            return None  # not a variable: let the general answerer take it
        return {"reply": ex.what_does(v), "ui": {"tab": "explorer", "select": v}}
    if kind == "what_controls":
        mt = met(m.group(1))
        if not mt:
            return None
        return {"reply": ex.what_controls(mt), "ui": {"tab": "matrix", "sort": mt}}
    if kind == "define":
        name, expression, holding = m.group(1), m.group(2), m.group(3)
        hold = [h for h in re.split(r"[,\s]+|\band\b", holding or "") if h.strip()]
        hold = [var(h) or h for h in hold]
        try:
            a = ex_mod.add_variable(ex.name, ex.goal, name, expression, hold, ex)
        except ex_mod.ExplorerError as e:
            return {"reply": f"I couldn't define {name}: {e}", "ui": None}
        drives = ", ".join(f"{d['var']} (∂{d['var']}/∂{name} = {d['dp_dq']:.3g} {d['unit']})".replace(" )", ")")
                           for d in a["drives"])
        held = f"holding {', '.join(hold)}" if hold else "nothing held constant (minimum-norm move)"
        return {"reply": f"Defined {name} = {expression} ({held}); it is {a['value']:.4g} now and drives {drives}. "
                         f"Its effects come from the chain rule, with no new simulations.",
                "ui": {"tab": "matrix", "refresh": True, "select": name}}
    if kind == "add_metric":
        name, expression, unit = m.group(1), m.group(2), m.group(3)
        try:
            a = ex_mod.add_metric(ex.name, ex.goal, name, expression, unit, ex)
        except ex_mod.ExplorerError as e:
            return {"reply": f"I couldn't add {name}: {e}", "ui": None}
        return {"reply": f"Added metric {name} = {expression}; it is {a['value']:.4g} {a['unit']} on the verified result. "
                         f"Its column fills from the existing runs.".replace(" .", "."),
                "ui": {"tab": "matrix", "refresh": True}}
    if kind == "color":
        mt = met(m.group(1))
        if not mt:
            return {"reply": f"I don't know a metric called '{_clean(m.group(1))}'. Try one of: {', '.join(met_names)}.",
                    "ui": None}
        return {"reply": f"Handles are now coloured by their effect on {label[mt]}.", "ui": {"tab": "explorer", "colorBy": mt}}
    if kind == "overlay":
        o = OVERLAYS.get(_clean(m.group(1)).lower())
        if not o:
            return {"reply": "Overlays: |E| field, surface current, sensitivity paint, or none.", "ui": None}
        if o == "sens":
            return {"reply": "Sensitivity paint isn't available yet: the sensitivity map hasn't been computed.",
                    "ui": {"tab": "explorer"}}
        label = {"E": "|E| field", "J": "surface current", "none": "no overlay"}[o]
        return {"reply": f"Showing {label} (analytic cavity-model picture, MOCK).", "ui": {"tab": "explorer", "overlay": o}}
    if kind == "matrix":
        return {"reply": "Here's the effect matrix." if ex.rows else ex._not_ready(), "ui": {"tab": "matrix"}}
    if kind == "show_vs":
        v, mt = var(m.group(1)), met(m.group(2))
        if not v or not mt:
            return None
        return {"reply": f"Opened {label[mt]} vs {v}. " + (ex.target_hint(v, mt)), "ui": {"tab": "matrix", "cell": [v, mt]}}
    if kind == "reach":
        mt, val, v = met(m.group(1)), float(m.group(2)), var(m.group(4))
        if not mt or not v:
            return {"reply": "Try e.g. \"reach Re Zin = 50 Ω using feed_ratio\".", "ui": None}
        try:
            r = ex.target(mt, val, v)
        except ex_mod.ExplorerError as e:
            return {"reply": f"I can't solve that: {e}", "ui": {"tab": "matrix", "cell": [v, mt]}}
        await run.emit("target_solution", {k: r[k] for k in ("metric", "value", "variable", "solution", "side_effects",
                                                             "in_range")})
        tail = " Press Verify with solver to confirm with one verified run." if r["in_range"] else ""
        return {"reply": r["sentence"] + tail, "ui": {"tab": "matrix", "cell": [v, mt], "target": val}}
    return None


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
    ex_answer = await explorer_intent(run, text)
    if ex_answer:
        await run.say(ex_answer["reply"])
        return {"reply": ex_answer["reply"], "action": "explorer", "ui": ex_answer.get("ui")}
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
