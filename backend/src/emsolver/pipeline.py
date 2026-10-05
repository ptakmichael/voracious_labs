"""Run state + the tool layer the orchestrator calls.

Every tool here is deterministic code. The orchestrator (Claude or the scripted fallback)
only decides *which* tool to call next and narrates; it never produces the numbers.
All solver results are produced by the MOCK solver and are labelled as such.
"""
from __future__ import annotations

import asyncio
import copy
import datetime as dt
import math
import random
import time
import uuid
from typing import Any

from . import physics
from .physics import PatchModel
from .problem import (ACCURACY, FIDELITY_TABLE, SOLVER_LABEL, default_optimizations, features,
                      interpret, select)

MAX_FIXES = 4
MAX_DESIGN_ITERS = 5
STAGES = ["setup", "analyze", "solve", "verify", "results"]


class RunCancelled(Exception):
    pass


class Run:
    def __init__(self, project: dict, speed: float = 1.0):
        self.id = uuid.uuid4().hex[:10]
        self.project = copy.deepcopy(project)
        self.settings = self.project["settings"]
        self.goal = self.project["goal"]
        self.autonomy = self.settings.get("autonomy", "balanced")
        self.speed = max(0.25, float(speed))
        self.t0 = time.time()
        self.events: list[dict] = []
        self.subscribers: list[asyncio.Queue] = []
        self.state = "building"
        self.stage = "analyze"
        self.cancelled = False
        self.paused = asyncio.Event()
        self.paused.set()
        self.orchestrator_name = "scripted"

        # pipeline state
        self.geo: dict | None = None
        self.feat: dict | None = None
        self.selection: dict | None = None
        self.plan: dict | None = None
        self.plan_approved = False
        self.padding = 0.25          # air padding in wavelengths
        self.cross_check = self.settings["accuracy"] in ("standard", "tight")
        self.subruns: list[dict] = []
        self.primary: dict | None = None     # latest primary result
        self.xcheck: dict | None = None      # latest cross-check result
        self.last_verify: dict | None = None
        self.last_goal: dict | None = None
        self.verify_iter = 0
        self.fixes: list[dict] = []
        self.design_history: list[dict] = []
        self.history: list[dict] = []        # iteration history for Verify page
        self.iter_label = "Initial plan"
        self.decisions: list[dict] = []
        self.compute_s = 0.0
        self.finished = False
        self.summary: dict | None = None

        # human-in-the-loop
        self.pending: dict | None = None     # {target, future, ...}
        self.hold = False
        self.inbox: list[str] = []
        self.chat: list[dict] = []

    # ------------------------------------------------------------------ events
    def elapsed(self) -> float:
        return time.time() - self.t0

    async def emit(self, type_: str, payload: dict | None = None) -> dict:
        ev = {"ts": dt.datetime.now(dt.timezone.utc).isoformat(), "t": round(self.elapsed(), 2),
              "run_id": self.id, "type": type_, "payload": payload or {}}
        self.events.append(ev)
        for q in list(self.subscribers):
            q.put_nowait(ev)
        return ev

    async def say(self, text: str, role: str = "solver"):
        if not text:
            return
        self.chat.append({"role": role, "text": text, "t": round(self.elapsed(), 2)})
        await self.emit("message", {"role": role, "text": text})

    async def log(self, text: str, level: str = "info"):
        await self.emit("log", {"text": text, "level": level})

    async def set_stage(self, stage: str, state: str):
        self.stage, self.state = stage, state
        await self.emit("stage_changed", {"stage": stage, "state": state})

    def decide(self, kind: str, choice: Any, reason: str, inputs: dict | None = None):
        self.decisions.append({"t": round(self.elapsed(), 2), "kind": kind, "choice": choice,
                               "reason": reason, "inputs": inputs or {}})

    async def sleep(self, s: float):
        """Scaled sleep that honours cancel/pause."""
        end = time.time() + s / self.speed
        while time.time() < end:
            if self.cancelled:
                raise RunCancelled()
            await self.paused.wait()
            await asyncio.sleep(min(0.1, max(0.0, end - time.time())))
        if self.cancelled:
            raise RunCancelled()

    def take_inbox(self) -> list[str]:
        msgs, self.inbox = self.inbox, []
        return msgs

    # ------------------------------------------------------------------ approvals
    async def wait_approval(self, target: str, summary: str, quick: list[str], countdown: float | None = None,
                            extra: dict | None = None) -> dict:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self.hold = False
        self.pending = {"target": target, "future": fut}
        self.state = f"awaiting_{target}_approval"
        await self.emit("awaiting_approval", {"target": target, "summary": summary, "quick_replies": quick,
                                              "countdown_s": countdown, **(extra or {})})
        try:
            if countdown:
                deadline = time.time() + countdown
                while not fut.done() and not self.hold and time.time() < deadline:
                    if self.cancelled:
                        raise RunCancelled()
                    await asyncio.sleep(0.1)
                if not fut.done() and not self.hold:
                    fut.set_result({"approved": True, "by": "countdown"})
            while not fut.done():
                if self.cancelled:
                    raise RunCancelled()
                await asyncio.sleep(0.1)
            res = fut.result()
        finally:
            self.pending = None
        await self.emit("approval_resolved", {"target": target, **{k: v for k, v in res.items() if k != "future"}})
        return res

    def resolve(self, approved: bool, **kw) -> bool:
        if self.pending and not self.pending["future"].done():
            self.pending["future"].set_result({"approved": approved, **kw})
            return True
        return False

    # ------------------------------------------------------------------ helpers
    def freqs(self) -> list[float]:
        s = self.settings
        n = int(max(21, min(1001, s["n_points"])))
        return [s["f_start"] + (s["f_stop"] - s["f_start"]) * i / (n - 1) for i in range(n)]

    def model(self) -> PatchModel:
        return self.geo["model"]

    def symmetric(self) -> bool:
        port = self.geo.get("port")
        patch = self.geo.get("patch")
        return bool(port and patch and abs(port["pos"][1] - patch["pos"][1]) < 1e-6)

    def mesh_stats(self, solver: str, fid: int) -> dict:
        """Illustrative mesh sizes, calibrated so the default patch looks like the mockups."""
        f_max = self.settings["f_stop"]
        lam = physics.C0 / (f_max * 1e9) * 1e3
        ext = max(self.geo["extent_mm"], 10) + 2 * self.padding * lam
        size = ((ext / lam) / 1.21) ** 3
        thin = 0.0187 / max(self.feat["h_over_lambda_d"], 1e-4)
        if solver == "openems":
            cells = int(1.9e6 * size * {0: 0.3, 1: 1.0, 2: 3.2}[fid] * thin ** 0.3)
            steps = int(9000 * thin * (1 + fid * 0.5))
            return {"cells": cells, "timesteps": steps, "mem_mb": round(cells * 230 / 1e6), "label": "Cells"}
        tets = int(428e3 * size * {0: 0.22, 1: 1.0, 2: 3.4}[fid] * thin ** 0.5)
        if self.plan and any(o["key"] == "symmetry" and o["enabled"] for o in self.plan["optimizations"]):
            tets //= 2
        order = {0: 1, 1: 2, 2: 3}[fid]
        unknowns = int(tets * {1: 1.3, 2: 7.5, 3: 24}[order])
        return {"tets": tets, "unknowns": unknowns, "order": order, "mem_mb": round(unknowns * 1.9e-3),
                "label": "Tetrahedra"}

    def sim_cost_s(self, solver: str, fid: int, purpose: str) -> float:
        """Simulated compute seconds (what the report shows), from the cost model."""
        base = next((o["pred_cost_s"] for o in self.selection["options"] if o["solver"] == solver), 240)
        scale = {0: 0.25, 1: 1.0, 2: 1.9}[fid]
        if purpose == "convergence":
            scale *= 0.35  # warm-started from the primary mesh; only the band edges + resonance are re-solved
        elif purpose == "cross_check":
            scale *= 0.7
        return base * scale * (1.08 if self.padding >= 0.5 else 1.0)

    def summarize_result(self, r: dict) -> dict:
        return {k: r[k] for k in ("solver", "fidelity", "purpose", "sim_time_s", "resonance_ghz",
                                  "min_s11_db", "band_below_goal") if k in r}

    # ------------------------------------------------------------------ tools
    async def tool_build_problem(self) -> dict:
        await self.set_stage("analyze", "building")
        self.geo = interpret(self.project)
        n = self.geo["n_objects"]
        await self.log(f"Built problem {self.project.get('name', 'project')} and validated units, materials, ports"
                       f" ({n} objects)")
        for w in self.geo["warnings"]:
            await self.log(f"Warning: {w}", "warn")
        return {"problem_id": self.project.get("name", "project"), "n_objects": n, "warnings": self.geo["warnings"],
                "units": "mm", "ports": self.geo["n_ports"]}

    async def tool_analyze_geometry(self) -> dict:
        self.state = "analyzing"
        self.feat = features(self.project, self.geo)
        await self.sleep(0.6)
        await self.emit("features", self.feat)
        f = self.feat
        await self.log(f"Features computed: {f['electrical_size']} λ₀, h/λd {f['h_over_lambda_d']}"
                       f"{' (thin)' if f['thin'] else ''}, {f['boundary'].lower()} boundary")
        return {k: f[k] for k in ("electrical_size", "h_over_lambda_d", "thin", "eps_r", "boundary", "ports",
                                  "band", "band_pct", "f_estimate_ghz")}

    async def tool_select_method(self) -> dict:
        self.state = "selecting"
        self.selection = select(self.feat, self.settings)
        await self.sleep(0.5)
        await self.emit("selection", self.selection)
        o = self.selection["options"]
        await self.log("Selector: " + " · ".join(f"{SOLVER_LABEL[x['solver']].split(' ·')[0]} {round(100 * x['p_fastest'])}%"
                                                  for x in o) + " (rule-based estimate)")
        self.decide("select", self.selection["winner"], self.selection["reason"], {"features": self.feat})
        return {"options": [{k: x[k] for k in ("solver", "fidelity", "pred_cost_s", "p_fastest")} for x in o],
                "rule_fired": self.selection["rule"], "confidence": self.selection["confidence"]}

    def _make_plan(self, solver: str, fidelity: int) -> dict:
        opts = default_optimizations(solver, self.feat, self.symmetric())
        if self.plan:  # keep user toggles where keys match
            prev = {o["key"]: o["enabled"] for o in self.plan["optimizations"]}
            for o in opts:
                if o["key"] in prev and o["status"] != "planned":
                    o["enabled"] = prev[o["key"]]
        for o in opts:
            if o["key"] == "padding":
                o["name"] = f"Air padding λ/{int(round(1 / self.padding))} (auto)"
        return {"solver": solver, "label": SOLVER_LABEL[solver], "fidelity": fidelity,
                "order": {0: 1, 1: 2, 2: 3}[fidelity] if solver == "palace" else None,
                "fidelity_desc": FIDELITY_TABLE[solver][fidelity], "optimizations": opts,
                "cross_check": self.cross_check, "padding": self.padding}

    async def emit_plan(self, countdown: float | None = None):
        await self.emit("plan", {**self.plan, "countdown_s": countdown})

    async def tool_propose_plan(self, solver: str | None = None, fidelity: int | None = None) -> dict:
        self.state = "planning"
        solver = solver if solver in ("palace", "openems") else self.selection["winner"]
        if fidelity not in (0, 1, 2):
            fidelity = self.selection["options"][0]["fidelity"]
        self.plan = self._make_plan(solver, fidelity)
        countdown = 10.0 if self.autonomy == "balanced" else None
        await self.emit_plan(countdown)
        self.decide("plan", {"solver": solver, "fidelity": fidelity}, "selector winner" if solver ==
                    self.selection["winner"] else "orchestrator override")
        if self.autonomy == "auto":
            await self.log("Plan proposed; starting immediately (Fully autonomous)")
            res = {"approved": True, "by": "autonomy"}
        else:
            what = "waiting 10 s for objections (Balanced autonomy)" if countdown else "waiting for your approval"
            await self.log(f"Plan proposed; {what}")
            other = "openems" if self.plan["solver"] == "palace" else "palace"
            quick = ["Looks good", f"Use {SOLVER_LABEL[other].split(' ·')[0]} instead",
                     f"Why {'FEM' if self.plan['solver'] == 'palace' else 'FDTD'}?"]
            res = await self.wait_approval("plan", f"{self.plan['label']} · fidelity {self.plan['fidelity']}", quick,
                                           countdown)
        self.plan_approved = bool(res["approved"])
        await self.log("Plan accepted" if res["approved"] else "Plan not accepted")
        return {"approved": res["approved"], "plan": self.plan_summary(), "user_message": res.get("message"),
                "user_messages": self.take_inbox()}

    def plan_summary(self) -> dict:
        p = self.plan
        return {"solver": p["solver"], "fidelity": p["fidelity"], "cross_check": self.cross_check,
                "padding": f"λ/{int(round(1 / self.padding))}",
                "optimizations": [o["key"] for o in p["optimizations"] if o["enabled"]]}

    async def _solve(self, solver: str, fid: int, purpose: str, duration: float, stream: bool) -> dict:
        """Run the MOCK solver: stream progress, convergence and partial S11."""
        stats = self.mesh_stats(solver, fid)
        sim_total = self.sim_cost_s(solver, fid, purpose)
        sub = {"solver": solver, "fidelity": fid, "purpose": purpose, "mock": True, "stats": stats,
               "label": SOLVER_LABEL[solver], "sim_total_s": round(sim_total)}
        await self.emit("subrun_started", sub)
        freqs = self.freqs()
        s = physics.s11_complex(self.model(), freqs, solver, fid, self.padding)
        sdb = [physics.db(x) for x in s]
        steps = max(6, int(duration * 5))
        rng = random.Random(hash((solver, fid, purpose, round(self.model().length_mm, 3))) & 0xFFFF)
        resid = 1.0
        # adaptive-sweep sampling order for FEM; time stepping for FDTD
        for i in range(1, steps + 1):
            await self.sleep(duration / steps)
            frac = i / steps
            pct = round(100 * frac)
            await self.emit("progress", {"purpose": purpose, "solver": solver, "percent": pct,
                                         "eta_s": round(sim_total * (1 - frac)), "elapsed_sim_s": round(sim_total * frac),
                                         "stats": stats})
            if stream:
                if solver == "palace":
                    for _ in range(3):
                        resid *= 10 ** -(0.25 + 0.25 * rng.random())
                        if resid < 1e-9:
                            resid = 10 ** (-0.2 * rng.random())  # next frequency sample
                        await self.emit("convergence_point", {"kind": "residual", "value": resid})
                else:
                    e = -80 * frac ** 0.8 - 6 * rng.random() * frac
                    await self.emit("convergence_point", {"kind": "energy_db", "value": e})
                k = max(2, int(len(freqs) * frac))
                await self.emit("partial_result", {"freqs_ghz": freqs[:k:2] + [freqs[k - 1]],
                                                   "s11_db": sdb[:k:2] + [sdb[k - 1]]})
        self.compute_s += sim_total
        thr = self.goal["threshold_db"]
        band = physics.band_below(freqs, sdb, thr)
        res = {**sub, "sim_time_s": round(sim_total), "freqs": freqs, "s": s, "s_db": sdb,
               "resonance_ghz": round(physics.resonance(freqs, s), 4), "min_s11_db": round(min(sdb), 2),
               "band_below_goal": [round(band[0], 4), round(band[1], 4)] if band else None,
               "padding": self.padding, "length_mm": round(self.model().length_mm, 3)}
        self.subruns.append(res)
        await self.emit("subrun_finished", {**self.summarize_result(res), "status": "ok", "mock": True})
        return res

    async def tool_run_solver(self, solver: str | None = None, fidelity: int | None = None) -> dict:
        await self.set_stage("solve", "solving")
        solver = solver or self.plan["solver"]
        fid = self.plan["fidelity"] if fidelity is None else int(fidelity)
        if solver != self.plan["solver"] or fid != self.plan["fidelity"]:
            self.plan = self._make_plan(solver, fid)
            await self.emit_plan()
        stats = self.mesh_stats(solver, fid)
        if solver == "palace":
            await self.log(f"Meshing with {'thin-layer refinement' if self.feat['thin'] else 'default sizing'}")
            await self.sleep(1.0)
            await self.log(f"Mesh ready: {stats['tets'] / 1000:.0f}k tetrahedra, order {stats['order']}")
            await self.log("Solving · adaptive sweep sampling frequencies")
        else:
            await self.sleep(0.6)
            await self.log(f"FDTD grid ready: {stats['cells'] / 1e6:.2f} M cells, {stats['timesteps']} time steps")
        res = await self._solve(solver, fid, "primary", 9.0, True)
        self.primary = res
        await self.log(f"{SOLVER_LABEL[solver]} f{fid} done · {res['sim_time_s'] / 60:.1f} min (simulated) · "
                       f"resonance {res['resonance_ghz']:.3f} GHz")
        return {**self.summarize_result(res), "mock": True, "user_messages": self.take_inbox()}

    async def tool_run_cross_check(self) -> dict:
        await self.set_stage("solve", "solving")
        other = "openems" if self.primary["solver"] == "palace" else "palace"
        await self.log(f"Cross-check: {SOLVER_LABEL[other]} f1")
        res = await self._solve(other, 1, "cross_check", 6.0, True)
        self.xcheck = res
        await self.log(f"Cross-check done · {res['sim_time_s'] / 60:.1f} min (simulated)")
        return {**self.summarize_result(res), "mock": True, "user_messages": self.take_inbox()}

    async def tool_verify(self) -> dict:
        await self.set_stage("verify", "verifying")
        self.verify_iter += 1
        p = self.primary
        tol = ACCURACY[self.settings["accuracy"]]
        checks = []
        max_mag = max(abs(x) for x in p["s"])
        checks.append({"name": "Passivity", "result": f"max |S11| = {max_mag:.2f} (must be ≤ 1)",
                       "value": max_mag, "limit": 1.001, "passed": max_mag <= 1.001})
        # convergence: next fidelity up (or down if top)
        fid2 = p["fidelity"] + 1 if p["fidelity"] < 2 else p["fidelity"] - 1
        await self.log(f"Convergence check: {p['solver']} f{p['fidelity']} → f{fid2}")
        conv = await self._solve(p["solver"], fid2, "convergence", 3.5, False)
        conv_err = physics.max_complex_err(p["s"], conv["s"]) * 0.12
        checks.append({"name": f"Convergence, fidelity {p['fidelity']} → {fid2}",
                       "result": f"max change {conv_err:.3f} (limit {tol})", "value": conv_err, "limit": tol,
                       "passed": conv_err < tol})
        err_bar = conv_err
        if self.cross_check and self.xcheck:
            x = self.xcheck
            shift = abs(x["resonance_ghz"] - p["resonance_ghz"]) / p["resonance_ghz"]
            cerr = physics.max_complex_err(p["s"], x["s"]) * 0.22
            ok = shift < 0.02 and cerr < 0.05
            note = "" if self.padding < 0.5 else " after padding λ/4 → λ/2"
            checks.append({"name": f"Cross-check vs. {SOLVER_LABEL[x['solver']].split(' ·')[0]}, iteration {self.verify_iter}",
                           "result": f"resonance shift {100 * shift:.1f}% (limit 2%){note}", "value": shift,
                           "limit": 0.02, "passed": ok})
            if ok:
                err_bar = max(err_bar, cerr)
        passed = all(c["passed"] for c in checks)
        err_bar = round(max(err_bar, 0.004), 3)
        v = {"iteration": self.verify_iter, "checks": checks, "passed": passed, "error_bar": err_bar,
             "solver": p["solver"], "fidelity": p["fidelity"]}
        self.last_verify = v
        await self.emit("verification", v)
        failed = [c["name"] for c in checks if not c["passed"]]
        if not passed:
            bad = next(c for c in checks if not c["passed"])
            short = bad["name"].split(",")[0].lower()
            val = f" ({100 * bad['value']:.1f}%)" if "Cross" in bad["name"] else ""
            self.history.append({"label": f"{self.iter_label} · {short} failed{val}", "status": "done"})
            await self.emit("history", {"items": self.history})
        await self.log("Verification " + ("passed" if passed else "FAILED: " + ", ".join(failed)) +
                       (f" · error ≤ ±{err_bar}" if passed else ""), "info" if passed else "warn")
        return {"passed": passed, "error_bar": err_bar if passed else None,
                "checks": [{"name": c["name"], "result": c["result"], "passed": c["passed"]} for c in checks],
                "fixes_used": len(self.fixes), "max_fixes": MAX_FIXES, "user_messages": self.take_inbox()}

    async def tool_apply_numerical_fix(self, fix: str, reason: str = "") -> dict:
        if len(self.fixes) >= MAX_FIXES:
            return {"error": f"numerical fix limit ({MAX_FIXES}) reached; finish as not verified"}
        self.state = "numerical_fix"
        if fix == "padding" and self.padding >= 0.5:
            fix = "raise_fidelity"
        if fix == "raise_fidelity" and self.plan["fidelity"] >= 2:
            fix = "switch_method"
        if fix == "padding":
            change = f"air padding λ/{int(round(1 / self.padding))} → λ/2"
        elif fix == "raise_fidelity":
            change = f"fidelity {self.plan['fidelity']} → {self.plan['fidelity'] + 1}"
        else:
            other = "openems" if self.plan["solver"] == "palace" else "palace"
            change = f"method {self.plan['solver']} → {other}"
        if self.autonomy == "ask":
            r = await self.wait_approval("fix", f"Numerical fix: {change}", ["Approve", "Skip"])
            if not r["approved"]:
                return {"applied": False, "user_message": r.get("message")}
        if fix == "padding":
            self.padding = 0.5
        elif fix == "raise_fidelity":
            self.plan = self._make_plan(self.plan["solver"], self.plan["fidelity"] + 1)
        else:
            self.plan = self._make_plan("openems" if self.plan["solver"] == "palace" else "palace", self.plan["fidelity"])
        for o in self.plan["optimizations"]:
            if o["key"] == "padding":
                o["name"] = f"Air padding λ/{int(round(1 / self.padding))} (auto)"
        self.fixes.append({"attempt": len(self.fixes) + 1, "change": change, "reason": reason})
        self.iter_label = change[0].upper() + change[1:]
        await self.emit("numerical_fix", {"attempt": len(self.fixes), "change": change, "reason": reason})
        await self.emit_plan()
        self.decide("fix", change, reason)
        await self.log(f"Numerical fix: {change}, re-running", "warn")
        return {"applied": True, "change": change, "next": "re-run the primary solve (and cross-check), then verify"}

    async def tool_check_goal(self) -> dict:
        self.state = "goal_check"
        p = self.primary
        g = self.goal
        band = p["band_below_goal"]
        met = bool(band and band[0] <= g["f1"] and band[1] >= g["f2"])
        res = {"met": met, "measured_band": band, "goal_band": [g["f1"], g["f2"]], "threshold_db": g["threshold_db"],
               "resonance_ghz": p["resonance_ghz"], "freqs": p["freqs"], "s11_db": p["s_db"],
               "iteration": len(self.design_history) + 1}
        self.last_goal = res
        await self.emit("goal_check", res)
        bt = f"{band[0]:.2f}–{band[1]:.2f} GHz" if band else "nowhere in the band"
        await self.log(f"Goal S11 < {g['threshold_db']} dB on {g['f1']:.2f}–{g['f2']:.2f} GHz: "
                       f"{'MET' if met else 'NOT MET'} (measured {bt})", "info" if met else "warn")
        verified = bool(self.last_verify and self.last_verify["passed"])
        self.history.append({"label": f"{self.iter_label} · {'verified' if verified else 'not verified'} · "
                                      f"goal {'met' if met else 'not met'}", "status": "done"})
        await self.emit("history", {"items": self.history})
        return {"met": met, "measured_band_ghz": band, "goal_band_ghz": [g["f1"], g["f2"]],
                "resonance_ghz": p["resonance_ghz"], "design_iterations_used": len(self.design_history),
                "max_design_iterations": MAX_DESIGN_ITERS, "user_messages": self.take_inbox()}

    async def tool_propose_design_change(self, variable: str = "patch_length", rationale: str = "") -> dict:
        if len(self.design_history) >= MAX_DESIGN_ITERS:
            return {"error": f"design iteration limit ({MAX_DESIGN_ITERS}) reached; finish as goal not met"}
        self.state = "design_proposal"
        g = self.goal
        m = self.model()
        p = self.primary
        fc_goal = (g["f1"] + g["f2"]) / 2
        constraint = self.project.get("constraints", {}).get("length_pct", 10) / 100
        await self.log(f"Design optimizer: exploring {variable.replace('_', ' ')} with coarse runs (fidelity 0)")
        coarse = 4
        for i in range(coarse):
            await self.sleep(0.7)
            await self.emit("progress", {"purpose": "explore", "solver": p["solver"], "percent": round(100 * (i + 1) / coarse),
                                         "eta_s": 0, "stats": {}})
        if variable == "feed_offset":
            frm = m.feed_frac
            to = 0.33 if abs(frm - 0.33) > 0.02 else min(frm + 0.04, 0.45)
            port = self.geo["port"]
            frm_mm = port["pos"][0]
            to_mm = round(-to * m.length_mm / 2, 2)
            change = {"var": "feed_offset", "label": "feed offset", "from": round(frm_mm, 2), "to": to_mm, "unit": "mm"}
            why = rationale or "Moves the feed toward the 50 Ω point to deepen the match; resonance unchanged."
        else:
            # shift resonance to goal centre; f ∝ 1/(L + 2ΔL), secant-corrected by the measured offset
            ratio = fc_goal / p["resonance_ghz"]
            target_f_eq = physics.f_res_equation(m.length_mm, m.width_mm, m.eps_r, m.h_mm) * ratio
            new_l = physics.length_for_f(target_f_eq, m.width_mm, m.eps_r, m.h_mm)
            orig = self.project.get("_orig_length") or m.length_mm
            self.project["_orig_length"] = orig
            new_l = min(max(new_l, orig * (1 - constraint)), orig * (1 + constraint))
            df = (fc_goal - p["resonance_ghz"]) * 1000
            change = {"var": "patch_length", "label": "resonant length", "from": round(m.length_mm, 2),
                      "to": round(new_l, 2), "unit": "mm"}
            why = rationale or (f"{'Shorten' if new_l < m.length_mm else 'Lengthen'} the resonant length to move the "
                                f"resonance {'up' if df > 0 else 'down'} by about {abs(df):.0f} MHz. Feed position unchanged.")
        prop = {"change": change, "rationale": why, "coarse_runs": coarse,
                "constraint": f"within your ±{round(constraint * 100)}% length constraint",
                "iteration": len(self.design_history) + 1}
        self.history.append({"label": f"{change['label'].capitalize()} {change['from']} → {change['to']} {change['unit']}",
                             "status": "awaiting approval"})
        await self.emit("design_proposal", prop)
        await self.emit("history", {"items": self.history})
        if self.autonomy == "auto":
            res = {"approved": True, "by": "autonomy"}
        else:
            res = await self.wait_approval("design", f"{change['label']} {change['from']} → {change['to']} mm",
                                           ["Approve", "Try feed position instead", "Let me edit"])
        if res.get("value") is not None:
            change["to"] = float(res["value"])
        if not res["approved"]:
            self.history[-1]["status"] = "declined"
            await self.emit("history", {"items": self.history})
            return {"approved": False, "user_message": res.get("message"), "user_messages": self.take_inbox()}
        self._apply_change(change)
        self.history.pop()
        self.iter_label = f"{change['label'].capitalize()} {change['from']} → {change['to']} {change['unit']}"
        self.design_history.append({**change, "rationale": why})
        self.decide("design", change, why)
        await self.emit("history", {"items": self.history})
        await self.emit("geometry_updated", {"objects": self.project["objects"], "change": change})
        await self.log(f"Design change applied: {change['label']} {change['from']} → {change['to']} mm; re-running pipeline")
        self.geo = interpret(self.project)
        return {"approved": True, "applied": change, "next": "re-run the primary solve, cross-check and verify",
                "user_messages": self.take_inbox()}

    def _apply_change(self, change: dict):
        objs = self.project["objects"]
        patch = self.geo["patch"]
        port = self.geo["port"]
        for o in objs:
            if patch and o["id"] == patch["id"] and change["var"] == "patch_length":
                o["size"][0] = change["to"]
            if port and o["id"] == port["id"] and change["var"] == "feed_offset":
                o["pos"][0] = change["to"]
        # keep port inside a shortened patch at the same fractional offset
        if change["var"] == "patch_length" and port and patch:
            for o in objs:
                if o["id"] == port["id"]:
                    o["pos"][0] = round(o["pos"][0] * change["to"] / change["from"], 3)

    async def tool_finish(self, status: str, headline: str = "") -> dict:
        await self.set_stage("results", "done")
        self.finished = True
        self.summary = self.build_results(status, headline)
        await self.emit("run_finished", self.summary)
        return {"ok": True}

    # ------------------------------------------------------------------ results
    def build_results(self, status: str = "", headline: str = "") -> dict:
        p = self.primary
        v = self.last_verify or {}
        g = self.last_goal or {}
        verified = bool(v.get("passed"))
        met = bool(g.get("met"))
        if not status:
            status = "met_verified" if (verified and met) else "verified_not_met" if verified else "not_verified"
        res = {"status": status, "headline": headline, "verified": verified, "goal_met": met, "mock": True,
               "orchestrator": self.orchestrator_name}
        if not p:
            return res
        eb = v.get("error_bar") or 0.02
        s = p["s"]
        freqs = p["freqs"]
        up = [physics.db(min(abs(x) + eb, 1.0)) for x in s]
        lo = [physics.db(max(abs(x) - eb, 1e-4)) for x in s]
        fr = p["resonance_ghz"]
        i_r = freqs.index(min(freqs, key=lambda f: abs(f - fr)))
        z = 50 * (1 + s[i_r]) / (1 - s[i_r])
        zs = [50 * (1 + x) / (1 - x) for x in s]
        vswr = [(1 + abs(x)) / (1 - min(abs(x), 0.999)) for x in s]
        methods = SOLVER_LABEL[p["solver"]].replace(" · ", " ")
        res.update({
            "freqs": freqs, "s_re": [x.real for x in s], "s_im": [x.imag for x in s], "s_db": p["s_db"],
            "err_hi_db": up, "err_lo_db": lo, "error_bar": eb, "goal": self.goal,
            "measured_band": g.get("measured_band"), "resonance_ghz": fr, "min_s11_db": p["min_s11_db"],
            "z_res": [round(z.real, 1), round(z.imag, 1)], "z_re": [x.real for x in zs], "z_im": [x.imag for x in zs],
            "vswr": vswr,
            "pattern": physics.patch_pattern(self.model(), fr),
            "tiles": {
                "method": methods, "method_sub": (f"+ {SOLVER_LABEL[self.xcheck['solver']].split(' ·')[0]} cross-check"
                                                  if self.xcheck else "no cross-check"),
                "design_iterations": len(self.design_history) + 1,
                "numerical_fixes": len(self.fixes),
                "fix_sub": ", ".join(f["change"].split(" ")[0] + " " + f["change"].split(" ")[1] for f in self.fixes) or "none",
                "compute_min": round(self.compute_s / 60, 1), "cores": 4, "saving": "[X%]", "manual_steps": 0,
                "subruns": len(self.subruns),
            },
            "fixes": self.fixes, "design_history": self.design_history, "history": self.history,
            "verification": v, "solver": p["solver"], "fidelity": p["fidelity"], "objects": self.project["objects"],
        })
        return res

    def context_summary(self) -> dict:
        """Compact state for the chat responder (never raw arrays)."""
        return {
            "state": self.state, "stage": self.stage, "autonomy": self.autonomy,
            "awaiting": self.pending["target"] if self.pending else None,
            "settings": {k: self.settings[k] for k in ("f_start", "f_stop", "n_points", "accuracy")},
            "goal": self.goal, "features": self.feat,
            "selection": {"winner": self.selection["winner"], "reason": self.selection["reason"],
                          "options": [{k: o[k] for k in ("solver", "pred_cost_s", "p_fastest")} for o in self.selection["options"]]}
            if self.selection else None,
            "plan": self.plan_summary() if self.plan else None,
            "primary": self.summarize_result(self.primary) if self.primary else None,
            "cross_check": self.summarize_result(self.xcheck) if self.xcheck else None,
            "verification": {"passed": self.last_verify["passed"], "error_bar": self.last_verify["error_bar"],
                             "checks": [{"name": c["name"], "result": c["result"], "passed": c["passed"]}
                                        for c in self.last_verify["checks"]]} if self.last_verify else None,
            "goal_check": {"met": self.last_goal["met"], "measured_band": self.last_goal["measured_band"]}
            if self.last_goal else None,
            "fixes": self.fixes, "design_changes": self.design_history,
            "recent_decisions": self.decisions[-5:], "mock_solver": True,
        }
