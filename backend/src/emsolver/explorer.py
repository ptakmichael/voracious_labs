"""3D explorer + effect matrix engine (EXPLORER_README §2): "any variable on any metric".

- Jacobian J[i][j] = ∂m_j/∂p_i by central finite differences at coarse fidelity, using the verified run's
  solver and settings. One ± pair per base variable fills the whole row for every metric, custom ones included.
- Custom input variables q = g(p) get their effects by the chain rule (no new runs), honouring a
  hold-constant set.
- Drill-downs fit a local quadratic response surface through verified runs, constrained by the FD gradient,
  and root-find on it for "reach this target".

All solver runs here go through the same MOCK solver as the pipeline and are labelled as such.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import time
import uuid
from pathlib import Path

from . import expr, family, metrics, physics
from .problem import interpret

STEP_PCT = 0.05            # matrix normalisation: effect of a +5% change
TRUST_PCT = 0.05           # first-order predictions are trusted within ±5%
DEFAULT_BUDGET = 20        # max coarse runs for background precompute
FD_FIDELITY = 0
REG_DIR = Path(__file__).resolve().parents[2] / "runs" / "explorer"
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,31}$")


class ExplorerError(Exception):
    pass


# ====================================================================== registries (persisted per project)
def _reg_path(project: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", project or "project")
    return REG_DIR / f"{safe}.json"


REGISTRIES: dict[str, dict] = {}


def load_registry(project: str) -> dict:
    """The project's registry (custom variables/metrics, watched variables, budget). One shared in-memory
    copy per project, loaded from disk on first use."""
    if project in REGISTRIES:
        return REGISTRIES[project]
    try:
        reg = json.loads(_reg_path(project).read_text())
    except (OSError, ValueError):
        reg = {}
    reg.setdefault("variables", [])
    reg.setdefault("metrics", [])
    reg.setdefault("watched", list(family.BASE_NAMES))
    reg.setdefault("budget", DEFAULT_BUDGET)
    REGISTRIES[project] = reg
    return reg


def save_registry(project: str, reg: dict):
    REG_DIR.mkdir(parents=True, exist_ok=True)
    keep = {k: reg[k] for k in ("variables", "metrics", "watched", "budget")}
    _reg_path(project).write_text(json.dumps(keep, indent=2))


def base_unit(name: str) -> expr.Unit:
    return expr.parse_unit(family.BASE_BY_NAME[name]["unit"])


def _reserved(goal: dict) -> set[str]:
    return (set(family.BASE_NAMES) | {m["name"] for m in metrics.scalar_catalog(goal)} | set(metrics.SERIES)
            | expr.FUNCS | set(expr.CONSTANTS))


def _var_ctx(reg: dict, exclude: str | None = None) -> expr.Context:
    sc = {n: base_unit(n) for n in family.BASE_NAMES}
    for v in reg["variables"]:
        if v["name"] != exclude:
            sc[v["name"]] = expr.parse_unit(v.get("unit"))
    return expr.Context(scalars=sc)


def _metric_ctx(reg: dict, goal: dict, exclude: str | None = None) -> expr.Context:
    sc = {m["name"]: expr.parse_unit(m["unit"]) for m in metrics.scalar_catalog(goal)}
    for m in reg["metrics"]:
        if m["name"] != exclude:
            sc[m["name"]] = expr.parse_unit(m.get("unit"))
    se = {k: expr.parse_unit(v["unit"]) for k, v in metrics.SERIES.items()}
    return expr.Context(scalars=sc, series=se, band_ok=True)


def _check_name(name: str, reg: dict, goal: dict, kind: str) -> list[str]:
    errs = []
    if not NAME_RE.match(name or ""):
        errs.append("name must start with a letter or _ and use only letters, digits and _ (max 32)")
    elif name in _reserved(goal):
        errs.append(f"'{name}' is already a built-in name")
    else:
        other = reg["metrics"] if kind == "variable" else reg["variables"]
        if any(x["name"] == name for x in other):
            errs.append(f"'{name}' is already used by a custom {'metric' if kind == 'variable' else 'variable'}")
    return errs


# ====================================================================== solver access with caching
CACHE: dict[tuple, dict] = {}


def _sim_key(model: physics.PatchModel, solver: str, fid: int, padding: float, freqs: list[float]) -> tuple:
    return (model.params(), solver, fid, round(padding, 4), len(freqs), round(freqs[0], 6), round(freqs[-1], 6))


def simulate(project: dict, values: dict[str, float], solver: str, fid: int, padding: float,
             freqs: list[float]) -> tuple[dict, bool]:
    """One MOCK solver run at the given base-variable values. Returns (result, was_cached)."""
    p = family.apply(project, values)
    model = interpret(p)["model"]
    key = _sim_key(model, solver, fid, padding, freqs)
    if key in CACHE:
        return CACHE[key], True
    s = physics.s11_complex(model, freqs, solver, fid, padding)
    res = {"freqs": freqs, "s": s, "gain_bs": physics.gain_boresight(model, model.f_true()), "fidelity": fid,
           "solver": solver, "mock": True}
    CACHE[key] = res
    return res, False


# Rows of the Jacobian survive across runs of the same project when the design has only moved inside the
# trust region and the row's own variable is unchanged (incremental recompute).
ROW_STORE: dict[str, dict[str, dict]] = {}


# ====================================================================== the explorer for one verified run
class Explorer:
    def __init__(self, run):
        if not run.primary:
            raise ExplorerError("No solver result yet. The explorer opens after a run produces results.")
        self.run = run
        self.project = run.project
        self.name = run.project.get("name", "project")
        self.goal = run.goal
        self.solver = run.primary["solver"]
        self.fid = run.primary["fidelity"]
        self.padding = run.padding
        self.freqs = run.primary["freqs"]
        try:
            self.base = family.extract(self.project)
        except family.NotAPatch as e:
            raise ExplorerError(str(e))
        model = interpret(self.project)["model"]
        self.verified = {"freqs": self.freqs, "s": run.primary["s"], "fidelity": self.fid, "solver": self.solver,
                         "gain_bs": physics.gain_boresight(model, model.f_true()), "mock": True}
        self.rows: dict[str, dict] = {}
        self.status = "idle"
        self.progress = {"done": 0, "total": 0}
        self.coarse_runs = 0
        self.verified_runs = 0
        self.task: asyncio.Task | None = None
        self.surfaces: dict[str, dict] = {}
        self.predictions: list[dict] = []
        self.proposal: dict | None = None
        self._reuse_rows()

    # ------------------------------------------------------------------ registry helpers
    @property
    def reg(self) -> dict:
        return load_registry(self.name)

    def custom_var(self, name: str) -> dict | None:
        return next((v for v in self.reg["variables"] if v["name"] == name), None)

    def custom_metric(self, name: str) -> dict | None:
        return next((m for m in self.reg["metrics"] if m["name"] == name), None)

    def metric_meta(self) -> list[dict]:
        out = []
        for m in metrics.scalar_catalog(self.goal):
            out.append({**m, "kind": "standard"})
        for m in self.reg["metrics"]:
            out.append({"name": m["name"], "label": m["name"], "long": m["expression"], "unit": m.get("unit", ""),
                        "kind": "custom", "expression": m["expression"], "floor": 0})
        for m in out:
            m["delta_unit"], m["delta_scale"] = ("MHz", 1000.0) if m["unit"] == "GHz" else (m["unit"], 1.0)
            m["impedance"] = bool(m.get("impedance"))
        return out

    def metric_names(self) -> list[str]:
        return [m["name"] for m in self.metric_meta()]

    # ------------------------------------------------------------------ evaluating variables
    def var_value(self, name: str, values: dict[str, float] | None = None, _seen: tuple = ()) -> float:
        vals = values or self.base
        if name in vals and name in family.BASE_BY_NAME:
            return vals[name]
        v = self.custom_var(name)
        if not v:
            raise ExplorerError(f"unknown variable '{name}'")
        if name in _seen:
            raise ExplorerError(f"cycle through '{name}'")
        ast = expr.parse(v["expression"])
        return expr.evaluate(ast, expr.Env(scalars=lambda n: self.var_value(n, vals, _seen + (name,))))

    def base_deps(self, name: str, _seen: tuple = ()) -> set[str]:
        if name in family.BASE_BY_NAME:
            return {name}
        v = self.custom_var(name)
        if not v or name in _seen:
            return set()
        out: set[str] = set()
        for n in expr.names(expr.parse(v["expression"])):
            out |= self.base_deps(n, _seen + (name,))
        return out

    def grad(self, name: str, values: dict[str, float] | None = None) -> dict[str, float]:
        """∂q/∂p_k for every base variable q depends on (numerical, on the expression only: no runs)."""
        vals = dict(values or self.base)
        out = {}
        for k in self.base_deps(name):
            hk = 1e-6 * max(abs(vals[k]), 1.0)
            up, dn = dict(vals), dict(vals)
            up[k] += hk
            dn[k] -= hk
            out[k] = (self.var_value(name, up) - self.var_value(name, dn)) / (2 * hk)
        return out

    def direction(self, name: str, hold: list[str] | None = None, values: dict | None = None) -> dict[str, float]:
        """dp/dq for a custom variable: which base variables move, and by how much per unit q (§2.2)."""
        if name in family.BASE_BY_NAME:
            return {name: 1.0}
        v = self.custom_var(name) or {}
        hold = set(v.get("hold_constant", []) if hold is None else hold)
        vals = values or self.base
        g = self.grad(name, vals)
        free = [k for k in g if k not in hold]
        if not free:
            deps = sorted(g)
            raise ExplorerError(f"{name} can't change if {' and '.join(deps) if len(deps) <= 2 else ', '.join(deps)} "
                                f"{'is' if len(deps) == 1 else 'are'} held constant")
        if len(free) == 1:
            k = free[0]
            if abs(g[k]) < 1e-15:
                raise ExplorerError(f"{name} doesn't depend on {k} here (∂{name}/∂{k} = 0)")
            return {k: 1.0 / g[k]}
        # minimum-norm step in normalised units u_k = p_k / s_k
        sc = {k: (abs(vals[k]) or 1.0) for k in free}
        a = {k: g[k] * sc[k] for k in free}
        n2 = sum(x * x for x in a.values())
        if n2 < 1e-30:
            raise ExplorerError(f"{name} doesn't depend on its free variables here")
        return {k: sc[k] * a[k] / n2 for k in free if abs(a[k]) > 0}

    def point_values(self, var: str, x: float) -> dict[str, float]:
        """Base-variable values that put `var` at `x` (holding the hold-constant set)."""
        if var in family.BASE_BY_NAME:
            return {**self.base, var: x}
        d = self.direction(var)
        q0 = self.var_value(var)
        vals = {**self.base, **{k: self.base[k] + dk * (x - q0) for k, dk in d.items()}}
        if len(d) == 1:  # one free variable: solve q(p) = x exactly with a few secant steps
            k = next(iter(d))
            for _ in range(8):
                err = self.var_value(var, vals) - x
                if abs(err) < 1e-10 * max(abs(x), 1):
                    break
                gk = self.grad(var, vals).get(k, 0)
                if abs(gk) < 1e-15:
                    break
                vals[k] -= err / gk
        return vals

    # ------------------------------------------------------------------ metric evaluation on a result
    def metric_value(self, res: dict, name: str, _seen: tuple = ()) -> tuple[float | None, list, str | None]:
        """(value, active points, n/a reason) for a standard or custom scalar metric on one result."""
        std = metrics.standard(res, self.goal)
        if name in std:
            v, act, na = std[name]
            return v, ([act] if act is not None else []), na
        m = self.custom_metric(name)
        if not m:
            return None, [], f"unknown metric '{name}'"
        if name in _seen:
            return None, [], "cycle in metric definitions"

        def sc(n):
            v, act, na = self.metric_value(res, n, _seen + (name,))
            if v is None:
                raise expr.ExprError(f"{n} is n/a: {na}")
            env.active.extend(act)
            return v

        env = expr.Env(scalars=sc, band=lambda fn, nm, f1, f2: metrics.band(res, fn, nm, f1, f2),
                       series=set(metrics.SERIES))
        try:
            val = expr.evaluate(expr.parse(m["expression"]), env)
        except expr.ExprError as e:
            return None, [], e.msg
        # band functions record (fn, series, active f); keep just the frequencies
        return val, [a[2] if isinstance(a, tuple) else a for a in env.active], None

    # ------------------------------------------------------------------ FD steps and cost
    def step(self, var: str) -> float:
        p = self.base[var]
        return max(0.01 * abs(p), family.BASE_BY_NAME[var]["mesh_floor"], 1e-6)

    def per(self, var: str) -> tuple[float, str]:
        """Normalisation: +5% of the current value, or an absolute step for variables near zero."""
        x = self.var_value(var)
        unit = self.var_unit(var)
        if abs(x) < 1e-6:
            return 1.0, f"+1 {unit}".strip()
        return STEP_PCT * x, "+5%"

    def var_unit(self, var: str) -> str:
        if var in family.BASE_BY_NAME:
            return family.BASE_BY_NAME[var]["unit"]
        return (self.custom_var(var) or {}).get("unit", "")

    def coarse_cost_s(self) -> float:
        return self.run.sim_cost_s(self.solver, FD_FIDELITY, "primary")

    def verified_cost_s(self) -> float:
        return self.run.sim_cost_s(self.solver, self.fid, "primary")

    async def _sim(self, values: dict[str, float], fid: int) -> dict:
        res, cached = simulate(self.project, values, self.solver, fid, self.padding, self.freqs)
        if not cached:
            # visible but short wall-clock pause; the simulated cost is what the dashboard reports
            await asyncio.sleep(0.35 / max(self.run.speed, 0.25) if fid == FD_FIDELITY else 0.8 / max(self.run.speed, 0.25))
            self.run.compute_s += self.coarse_cost_s() if fid == FD_FIDELITY else self.verified_cost_s()
            if fid == FD_FIDELITY:
                self.coarse_runs += 1
            else:
                self.verified_runs += 1
        return res

    # ------------------------------------------------------------------ Jacobian
    def _reuse_rows(self):
        store = ROW_STORE.get(self.name, {})
        for var, row in store.items():
            if row["solver"] != self.solver or row["padding"] != self.padding or len(row["freqs"]) != len(self.freqs):
                continue
            b = row["base"]
            if abs(b[var] - self.base[var]) > 1e-9 * max(abs(b[var]), 1):
                continue
            if all(abs(b[k] - self.base[k]) <= TRUST_PCT * max(abs(b[k]), 1e-9) for k in family.BASE_NAMES):
                self.rows[var] = {**row, "reused": True}

    def plan(self, variables: list[str] | None = None) -> dict:
        reg = self.reg
        vs = [v for v in (variables or reg["watched"]) if v in family.BASE_BY_NAME]
        todo = [v for v in vs if v not in self.rows]
        n = 2 * len(todo)
        return {"variables": todo, "cached": [v for v in vs if v in self.rows], "n_runs": n,
                "est_time_s": round(n * self.coarse_cost_s()), "budget": reg["budget"], "fidelity": FD_FIDELITY,
                "solver": self.solver}

    async def compute_jacobian(self, variables: list[str] | None = None):
        pl = self.plan(variables)
        todo = pl["variables"]
        self.status = "running"
        self.progress = {"done": 0, "total": pl["n_runs"]}
        self.proposal = None
        await self.run.emit("jacobian_started", {**pl, "mock": True})
        await self.run.log(f"Effect matrix: {pl['n_runs']} coarse runs (fidelity {FD_FIDELITY}, {self.solver}) "
                           f"≈ {pl['est_time_s'] / 60:.1f} min simulated" + (f"; {len(pl['cached'])} rows reused from cache"
                                                                             if pl["cached"] else ""))
        try:
            for var in todo:
                d = self.step(var)
                p = self.base[var]
                plus = await self._sim({var: p + d}, FD_FIDELITY)
                self.progress["done"] += 1
                minus = await self._sim({var: p - d}, FD_FIDELITY)
                self.progress["done"] += 1
                row = {"step": d, "plus": plus, "minus": minus, "base": dict(self.base), "solver": self.solver,
                       "padding": self.padding, "freqs": self.freqs}
                self.rows[var] = row
                ROW_STORE.setdefault(self.name, {})[var] = row
                for c in self.row_cells(var):
                    await self.run.emit("jacobian_cell", {**c, "runs_done": self.progress["done"],
                                                          "runs_total": self.progress["total"]})
        except asyncio.CancelledError:
            self.status = "idle" if not self.rows else "done"
            raise
        self.status = "done"
        await self.run.emit("jacobian_done", {"cost_basis": self.cost_basis()})
        await self.run.log("Effect matrix ready · " + self.cost_basis())

    def start_jacobian(self, variables: list[str] | None = None) -> dict:
        if self.task and not self.task.done():
            raise ExplorerError("The effect matrix is already computing.")
        pl = self.plan(variables)
        if pl["n_runs"] > pl["budget"]:
            raise ExplorerError(f"{pl['n_runs']} coarse runs exceed the compute budget ({pl['budget']}). "
                                f"Raise the budget or watch fewer variables.")
        self.task = asyncio.create_task(self.compute_jacobian(variables))
        return pl

    def cost_basis(self) -> str:
        n_rows = len(self.rows)
        reused = sum(1 for r in self.rows.values() if r.get("reused"))
        fresh = n_rows - reused
        rows = lambda k: f"{k} row{'s' if k != 1 else ''}"
        if fresh:
            s = f"From {2 * fresh} coarse runs (2 per base variable)"
            if reused:
                s += f" + {rows(reused)} reused from an earlier run (inside the trust region)"
        else:
            s = f"All {rows(reused)} reused from an earlier run of this design (inside the trust region), no new runs"
        if self.reg["variables"]:
            s += " · custom variables by chain rule, no extra runs"
        return s + " · MOCK"

    def _cell(self, var: str, metric: str) -> dict:
        """∂metric/∂var from the stored ± runs (base variables only)."""
        row = self.rows.get(var)
        if not row:
            return {"deriv": None, "na_reason": "row not computed yet"}
        mp, ap, na1 = self.metric_value(row["plus"], metric)
        mm, am, na2 = self.metric_value(row["minus"], metric)
        if mp is None or mm is None:
            return {"deriv": None, "na_reason": na1 or na2}
        deriv = (mp - mm) / (2 * row["step"])
        meta = next((m for m in self.metric_meta() if m["name"] == metric), {})
        floor = meta.get("floor", 0) or 0
        non_smooth = any(a is not None and b is not None and abs(a - b) > 1e-9 for a, b in zip(ap, am)) or len(ap) != len(am)
        noisy = floor > 0 and abs(mp - mm) < 2 * floor
        return {"deriv": deriv, "noisy": noisy, "non_smooth": non_smooth, "na_reason": None}

    def cell(self, var: str, metric: str) -> dict:
        """Signed effect of `per(var)` on `metric`, in the metric's delta units, with flags."""
        meta = next((m for m in self.metric_meta() if m["name"] == metric), None)
        if meta is None:
            return {"variable": var, "metric": metric, "value": None, "na_reason": "unknown metric"}
        if meta.get("na"):
            return {"variable": var, "metric": metric, "value": None, "na_reason": meta["na"]}
        try:
            if var in family.BASE_BY_NAME:
                c = self._cell(var, metric)
                hold_note = None
            else:
                d = self.direction(var)
                parts = [(k, self._cell(k, metric), dk) for k, dk in d.items()]
                missing = [k for k, c, _ in parts if c.get("deriv") is None]
                if missing:
                    reason = parts[[k for k, _, _ in parts].index(missing[0])][1].get("na_reason")
                    return {"variable": var, "metric": metric, "value": None,
                            "na_reason": f"needs the {', '.join(missing)} row ({reason})"}
                c = {"deriv": sum(c["deriv"] * dk for _, c, dk in parts),
                     "noisy": any(c["noisy"] for _, c, _ in parts),
                     "non_smooth": any(c["non_smooth"] for _, c, _ in parts), "na_reason": None,
                     "method": "chain rule"}
                hold_note = self.hold_note(var)
        except ExplorerError as e:
            return {"variable": var, "metric": metric, "value": None, "na_reason": str(e)}
        if c.get("deriv") is None:
            return {"variable": var, "metric": metric, "value": None, "na_reason": c.get("na_reason")}
        step, per_label = self.per(var)
        value = c["deriv"] * step * meta["delta_scale"]
        return {"variable": var, "metric": metric, "value": value, "deriv": c["deriv"], "unit": meta["delta_unit"],
                "per": per_label, "noisy": c["noisy"], "non_smooth": c["non_smooth"], "na_reason": None,
                "method": c.get("method", "central FD"), "hold": hold_note}

    def row_cells(self, var: str) -> list[dict]:
        return [self.cell(var, m) for m in self.metric_names()]

    def hold_note(self, var: str) -> str:
        v = self.custom_var(var) or {}
        h = v.get("hold_constant", [])
        return f"holding {', '.join(h)}" if h else "nothing held constant"

    # ------------------------------------------------------------------ views
    def variables_view(self) -> list[dict]:
        hs = {}
        try:
            hs = family.handles(self.project)
        except family.NotAPatch:
            pass
        out = []
        for b in family.BASE_VARS:
            out.append({"name": b["name"], "kind": "base", "label": b["label"], "unit": b["unit"],
                        "value": self.base[b["name"]], "handle": hs.get(b["name"]),
                        "watched": b["name"] in self.reg["watched"], "computed": b["name"] in self.rows})
        for v in self.reg["variables"]:
            item = {"name": v["name"], "kind": "derived", "label": v["name"], "unit": v.get("unit", ""),
                    "expression": v["expression"], "hold_constant": v.get("hold_constant", []), "value": None}
            try:
                item["value"] = self.var_value(v["name"])
                d = self.direction(v["name"])
                item["drives"] = [{"var": k, "dp_dq": dk, "unit": family.BASE_BY_NAME[k]["unit"]} for k, dk in d.items()]
                geo = [k for k in d if hs.get(k)]
                if len(d) == 1 and geo:
                    item["handle"] = {**hs[geo[0]], "via": geo[0]}
            except (ExplorerError, expr.ExprError) as e:
                item["error"] = getattr(e, "msg", str(e))
            out.append(item)
        return out

    def matrix(self) -> dict:
        mets = self.metric_meta()
        vars_ = self.variables_view()
        cells = {v["name"]: {m["name"]: self.cell(v["name"], m["name"]) for m in mets} for v in vars_}
        values = {}
        for m in mets:
            v, _, na = self.metric_value(self.verified, m["name"])
            values[m["name"]] = {"value": v, "na_reason": na or m.get("na")}
        return {"status": self.status, "progress": self.progress, "cost_basis": self.cost_basis() if self.rows else None,
                "variables": vars_, "metrics": mets, "cells": cells, "values": values,
                "solver": self.solver, "fidelity": self.fid, "fd_fidelity": FD_FIDELITY,
                "coarse_runs": self.coarse_runs, "verified_runs": self.verified_runs,
                "cost_coarse_s": round(self.coarse_cost_s()), "cost_verified_s": round(self.verified_cost_s()),
                "budget": self.reg["budget"], "watched": self.reg["watched"], "proposal": self.proposal,
                "plan": self.plan(), "predictions": self.predictions[-10:], "trust_pct": TRUST_PCT,
                "autonomy": self.run.autonomy, "mock": True}

    # ------------------------------------------------------------------ response surfaces (§2.5)
    def start_surface(self, var: str, metric: str, range_pct: float = 5.0, n_points: int = 3) -> dict:
        self._check_var(var)
        if metric not in self.metric_names():
            raise ExplorerError(f"unknown metric '{metric}'")
        n_points = 5 if n_points >= 5 else 3
        x0 = self.var_value(var)
        dx = abs(x0) * range_pct / 100 if abs(x0) > 1e-9 else range_pct / 100
        k = (n_points - 1) // 2
        offsets = [i * dx for i in range(-k, k + 1)]
        new_runs = n_points - 1
        sid = uuid.uuid4().hex[:8]
        surf = {"id": sid, "variable": var, "metric": metric, "status": "running", "x0": x0, "range_pct": range_pct,
                "n_points": n_points, "points": [], "new_runs": new_runs,
                "est_time_s": round(new_runs * self.verified_cost_s()), "fidelity": self.fid}
        self.surfaces[sid] = surf

        async def go():
            pts = []
            for off in offsets:
                vals = self.point_values(var, x0 + off)
                res = self.verified if abs(off) < 1e-15 else await self._sim(vals, self.fid)
                x = self.var_value(var, vals)
                y, _, na = self.metric_value(res, metric)
                pts.append({"x": x, "y": y, "na": na, "values": vals, "res": res})
            surf["points"] = pts
            self._fit(surf)
            surf["status"] = "ready"
            await self.run.emit("surface_ready", {"surface_id": sid, "variable": var, "metric": metric})
            await self.run.log(f"Response surface {metric} vs {var}: {new_runs} verified runs (fidelity {self.fid})")

        surf["_task"] = asyncio.create_task(go())
        return self.surface_view(sid)

    def _fit(self, surf: dict):
        pts = [p for p in surf["points"] if p["y"] is not None]
        x0 = surf["x0"]
        if len(pts) < 3:
            surf["coef"] = None
            surf["fit_note"] = "not enough valid points to fit"
            return
        c = self.cell(surf["variable"], surf["metric"])
        meta = next(m for m in self.metric_meta() if m["name"] == surf["metric"])
        slope = c.get("deriv")
        dx = max(abs(p["x"] - x0) for p in pts) or 1.0
        rows = [([1.0, p["x"] - x0, (p["x"] - x0) ** 2], p["y"]) for p in pts]
        if slope is not None:
            rows.append(([0.0, dx, 0.0], slope * dx))  # FD gradient constraint (least squares)
        surf["coef"] = _lstsq(rows)
        surf["slope"] = slope
        surf["range"] = [min(p["x"] for p in pts), max(p["x"] for p in pts)]
        surf["unit"] = meta["unit"]
        resid = [p["y"] - _poly(surf["coef"], p["x"] - x0) for p in pts]
        surf["rms_resid"] = math.sqrt(sum(r * r for r in resid) / len(resid))

    def surface_view(self, sid: str, f0: float | None = None) -> dict:
        s = self.surfaces.get(sid)
        if not s:
            raise ExplorerError("surface not found")
        out = {k: v for k, v in s.items() if not k.startswith("_") and k != "points"}
        out["points"] = [{"x": p["x"], "y": p["y"], "na": p["na"],
                          "values": {k: round(v, 6) for k, v in p["values"].items()}} for p in s["points"]]
        if s["status"] == "ready" and s.get("coef"):
            x0, (lo, hi) = s["x0"], s["range"]
            pad = 0.25 * (hi - lo)
            xs = [lo - pad + (hi - lo + 2 * pad) * i / 60 for i in range(61)]
            out["curve"] = {"x": xs, "y": [_poly(s["coef"], x - x0) for x in xs]}
            y0 = _poly(s["coef"], 0)
            if s.get("slope") is not None:
                out["tangent"] = {"x": [lo, hi], "y": [y0 + s["slope"] * (lo - x0), y0 + s["slope"] * (hi - x0)]}
            meta = next(m for m in self.metric_meta() if m["name"] == s["metric"])
            if meta.get("impedance"):
                out["smith"] = self._smith(s, f0)
        return out

    def _smith(self, s: dict, f0: float | None) -> dict:
        """Zin(f0) along the variable's range → Γ trajectory (§2.6). Default f0 = verified f_res."""
        f0 = f0 or metrics.standard(self.verified, self.goal)["f_res"][0]
        pts = [p for p in s["points"]]
        x0 = s["x0"]
        zs = [physics.zin(metrics.interp(p["res"]["freqs"], p["res"]["s"], f0)) for p in pts]
        rows_re = [([1.0, p["x"] - x0, (p["x"] - x0) ** 2], z.real) for p, z in zip(pts, zs)]
        rows_im = [([1.0, p["x"] - x0, (p["x"] - x0) ** 2], z.imag) for p, z in zip(pts, zs)]
        cr, ci = _lstsq(rows_re), _lstsq(rows_im)
        lo, hi = s["range"]
        path = []
        for i in range(41):
            x = lo + (hi - lo) * i / 40
            z = complex(_poly(cr, x - x0), _poly(ci, x - x0))
            g = (z - metrics.Z0) / (z + metrics.Z0)
            path.append({"x": x, "re": g.real, "im": g.imag, "z": [z.real, z.imag]})
        z_now = complex(_poly(cr, 0), _poly(ci, 0))
        g_now = (z_now - metrics.Z0) / (z_now + metrics.Z0)
        return {"f0": f0, "path": path, "now": {"re": g_now.real, "im": g_now.imag, "z": [z_now.real, z_now.imag]},
                "points": [{"x": p["x"], "z": [z.real, z.imag]} for p, z in zip(pts, zs)]}

    def latest_surface(self, var: str, metric: str) -> dict | None:
        ready = [s for s in self.surfaces.values() if s["variable"] == var and s["metric"] == metric
                 and s["status"] == "ready" and s.get("coef")]
        return ready[-1] if ready else None

    # ------------------------------------------------------------------ target solve
    def target(self, metric: str, value: float, var: str) -> dict:
        self._check_var(var)
        meta = next((m for m in self.metric_meta() if m["name"] == metric), None)
        if not meta:
            raise ExplorerError(f"unknown metric '{metric}'")
        x0 = self.var_value(var)
        surf = self.latest_surface(var, metric)
        c = self.cell(var, metric)
        if surf:
            a, b, cc = surf["coef"]
            roots = _quad_roots(cc, b, a - value)
            lo, hi = surf["range"]
            inside = [t for t in roots if lo - 1e-12 <= x0 + t <= hi + 1e-12]
            pick = min(inside or roots, key=abs) if (inside or roots) else None
            if pick is None:
                return {"metric": metric, "variable": var, "value": value, "solution": None, "in_range": False,
                        "method": "response surface", "message": f"The fitted surface never reaches {value:g} {meta['unit']}."}
            t = pick
            predicted = _poly(surf["coef"], t)
            in_range = bool(inside)
            method = "response surface"
        else:
            if c.get("deriv") in (None, 0):
                raise ExplorerError(c.get("na_reason") or f"{var} has no first-order effect on {metric}")
            y0, _, _ = self.metric_value(self.verified, metric)
            t = (value - y0) / c["deriv"]
            predicted = y0 + c["deriv"] * t
            in_range = abs(t) <= TRUST_PCT * max(abs(x0), 1e-9)
            method = "first-order (Jacobian)"
        x = x0 + t
        vals = self.point_values(var, x)
        drives = [{"var": k, "from": self.base[k], "to": vals[k], "unit": family.BASE_BY_NAME[k]["unit"]}
                  for k in family.BASE_NAMES if abs(vals[k] - self.base[k]) > 1e-9]
        side = []
        for m in self.metric_meta():
            if m["name"] == metric or m.get("na") or m["kind"] != "standard":
                continue
            cm = self.cell(var, m["name"])
            if cm.get("deriv") is None:
                continue
            side.append({"metric": m["name"], "label": m["label"], "delta": cm["deriv"] * t * m["delta_scale"],
                         "unit": m["delta_unit"], "noisy": cm.get("noisy")})
        res = {"metric": metric, "metric_label": meta["label"], "unit": meta["unit"], "value": value, "variable": var,
               "x0": x0, "solution": x, "predicted": predicted, "in_range": in_range, "method": method,
               "drives": drives, "side_effects": side, "hold": None if var in family.BASE_BY_NAME else self.hold_note(var)}
        res["sentence"] = self._target_sentence(res)
        return res

    def _target_sentence(self, r: dict) -> str:
        u = r["unit"]
        fmt = lambda v: _fmt(v)
        s = (f"To reach {fmt(r['value'])} {u}: {r['variable']} {fmt(r['x0'])} → {fmt(r['solution'])}")
        moves = [d for d in r["drives"] if d["var"] != r["variable"]]
        if moves:
            s += " (" + ", ".join(f"{d['var']} {fmt(d['from'])} → {fmt(d['to'])} {d['unit']}".strip() for d in moves) + ")"
        s += f". Predicted {r['metric_label']} {fmt(r['predicted'])} {u}"
        big = sorted(r["side_effects"], key=lambda e: -abs(e["delta"]))
        fres = next((e for e in big if e["metric"] == "f_res"), None)
        if fres:
            word = "unchanged" if abs(fres["delta"]) < 2 else ("up" if fres["delta"] > 0 else "down")
            s += f"; resonance {word} ({fres['delta']:+.1f} MHz)"
        s += "." if r["in_range"] else (". This is outside the fitted range; expand the range (2 more verified runs) "
                                        "before trusting it." if r["method"].startswith("response") else
                                        ". This is outside the ±5% trust region; fit a response surface first.")
        if r.get("hold"):
            s += f" ({r['variable']} {r['hold']}.)"
        return s

    # ------------------------------------------------------------------ verify / apply
    async def verify_point(self, var: str, x: float, metric: str) -> dict:
        self._check_var(var)
        vals = self.point_values(var, x)
        x0 = self.var_value(var)
        surf = self.latest_surface(var, metric)
        if surf:
            predicted, method = _poly(surf["coef"], x - x0), "response surface"
        else:
            c = self.cell(var, metric)
            y0, _, _ = self.metric_value(self.verified, metric)
            predicted = None if c.get("deriv") is None else y0 + c["deriv"] * (x - x0)
            method = "first-order"
        res = await self._sim(vals, self.fid)
        actual, _, na = self.metric_value(res, metric)
        err = None if actual is None or predicted is None else actual - predicted
        within = abs(x - x0) <= TRUST_PCT * max(abs(x0), 1e-9) or bool(surf and surf["range"][0] <= x <= surf["range"][1])
        rec = {"variable": var, "metric": metric, "x0": x0, "x": x, "predicted": predicted, "actual": actual,
               "error": err, "method": method, "within_trust": within, "na_reason": na, "t": round(time.time()),
               "solver": self.solver, "fidelity": self.fid, "mock": True}
        self.predictions.append(rec)
        await self.run.emit("prediction_verified", rec)
        await self.run.log(f"Verified {var} = {_fmt(x)}: {metric} predicted {_fmt(predicted)}, solver {_fmt(actual)}"
                           + (f" (error {_fmt(err)})" if err is not None else ""))
        return rec

    def apply(self, var: str, x: float) -> dict:
        self._check_var(var)
        vals = self.point_values(var, x)
        p = family.apply(self.project, vals)
        return {"objects": p["objects"], "materials": p.get("materials", []), "values": vals}

    def _check_var(self, var: str):
        if var not in family.BASE_BY_NAME and not self.custom_var(var):
            raise ExplorerError(f"unknown variable '{var}'")

    # ------------------------------------------------------------------ chat answers (§5.3)
    def what_does(self, var: str) -> str:
        if not self.rows:
            return self._not_ready()
        cells = [c for c in self.row_cells(var) if c.get("value") is not None]
        if not cells:
            return f"I don't have effects for {var} yet ({self.cell(var, 'f_res').get('na_reason')})."
        meta = {m["name"]: m for m in self.metric_meta()}
        # rank by size relative to each metric's spread across variables, so units don't decide
        def rel(c):
            col = [abs(self.cell(v["name"], c["metric"]).get("value") or 0) for v in self.variables_view()]
            return abs(c["value"]) / (max(col) or 1)
        top = sorted((c for c in cells if not c["noisy"]), key=rel, reverse=True)[:3]
        if not top:
            return f"Every effect of {var} is below the solver's noise floor."
        step, per = self.per(var)
        parts = [f"{meta[c['metric']]['label']} {c['value']:+.3g} {c['unit']}".strip() for c in top]
        size = f"{_fmt(step)} {self.var_unit(var)}".strip()
        s = f"Per {per} change in {var} ({size}): " + " · ".join(parts) + "."
        if var not in family.BASE_BY_NAME:
            s += f" ({var} {self.hold_note(var)}.)"
        return s + " First-order, from the effect matrix (MOCK)."

    def what_controls(self, metric: str) -> str:
        if not self.rows:
            return self._not_ready()
        meta = next((m for m in self.metric_meta() if m["name"] == metric), None)
        if meta and meta.get("na"):
            return f"{meta['label']} is n/a: {meta['na']}."
        cells = [self.cell(v["name"], metric) for v in self.variables_view()]
        cells = [c for c in cells if c.get("value") is not None and not c.get("noisy")]
        if not cells:
            return f"No variable has a measurable effect on {metric} yet."
        top = sorted(cells, key=lambda c: -abs(c["value"]))[:3]
        parts = [f"{c['variable']} {c['value']:+.3g} {c['unit']} per {c['per']}".strip() for c in top]
        return f"What controls {meta['label'] if meta else metric}: " + " · ".join(parts) + ". From the effect matrix (MOCK)."

    def target_hint(self, var: str, metric: str) -> str:
        c = self.cell(var, metric)
        if c.get("value") is None:
            return f"No first-order effect yet ({c.get('na_reason')})."
        meta = next(m for m in self.metric_meta() if m["name"] == metric)
        note = f" ({var} {c['hold']})" if c.get("hold") else ""
        return (f"First-order: {meta['label']} {c['value']:+.3g} {c['unit']} per {c['per']} of {var}{note}. "
                f"Fit a response surface for a verified curve.")

    def _not_ready(self) -> str:
        if self.status == "running":
            return f"The effect matrix is still computing ({self.progress['done']}/{self.progress['total']} coarse runs)."
        pl = self.plan()
        return (f"The effect matrix isn't computed yet. It needs {pl['n_runs']} coarse runs "
                f"(≈ {pl['est_time_s'] / 60:.1f} min simulated); press Compute on the Effect matrix tab.")


# ====================================================================== registry editing (shared by API + chat)
def analyze_variable(reg: dict, goal: dict, name: str, expression: str, hold: list[str], explorer: Explorer | None,
                     replacing: bool = False) -> dict:
    out: dict = {"errors": [], "warnings": [], "value": None, "unit": None, "drives": []}
    if not replacing:
        out["errors"] += [{"msg": m} for m in _check_name(name, reg, goal, "variable")]
        if any(v["name"] == name for v in reg["variables"]):
            out["errors"].append({"msg": f"a custom variable named '{name}' already exists"})
    a = expr.analyze(expression, _var_ctx(reg, exclude=name))
    out["errors"] += a.errors
    out["warnings"] += a.warnings
    out["unit"] = expr.fmt_unit(a.unit)
    bad_hold = [h for h in hold if h not in family.BASE_BY_NAME]
    if bad_hold:
        out["errors"].append({"msg": f"can only hold base variables ({', '.join(bad_hold)} is not one)"})
    if out["errors"]:
        return out
    graph = {v["name"]: expr.names(expr.parse(v["expression"])) for v in reg["variables"] if v["name"] != name}
    graph[name] = a.deps
    cyc = expr.find_cycle(graph)
    if cyc:
        out["errors"].append({"msg": "circular definition: " + " → ".join(cyc)})
        return out
    if explorer:
        trial = {"name": name, "expression": expression, "hold_constant": hold, "unit": out["unit"], "kind": "derived"}
        saved = list(reg["variables"])
        reg["variables"] = [v for v in saved if v["name"] != name] + [trial]  # explorer reads this shared registry
        try:
            out["value"] = explorer.var_value(name)
            d = explorer.direction(name)
            out["drives"] = [{"var": k, "dp_dq": dk, "unit": family.BASE_BY_NAME[k]["unit"]} for k, dk in d.items()]
            out["free"] = sorted(d)
        except (ExplorerError, expr.ExprError) as e:
            out["errors"].append({"msg": getattr(e, "msg", str(e))})
        finally:
            reg["variables"] = saved
    return out


def analyze_metric(reg: dict, goal: dict, name: str, expression: str, unit: str | None, explorer: Explorer | None,
                   replacing: bool = False) -> dict:
    out: dict = {"errors": [], "warnings": [], "value": None, "unit": None}
    if not replacing:
        out["errors"] += [{"msg": m} for m in _check_name(name, reg, goal, "metric")]
        if any(m["name"] == name for m in reg["metrics"]):
            out["errors"].append({"msg": f"a custom metric named '{name}' already exists"})
    a = expr.analyze(expression, _metric_ctx(reg, goal, exclude=name))
    out["errors"] += a.errors
    out["warnings"] += a.warnings
    derived = expr.fmt_unit(a.unit)
    out["unit"] = unit if unit is not None and unit != "" else derived
    if unit and a.unit is not None and expr.parse_unit(unit) != a.unit:
        out["warnings"].append(f"declared unit '{unit}' differs from the expression's unit '{derived or 'dimensionless'}'")
    if out["errors"]:
        return out
    graph = {m["name"]: expr.names(expr.parse(m["expression"])) for m in reg["metrics"] if m["name"] != name}
    graph[name] = a.deps
    cyc = expr.find_cycle(graph)
    if cyc:
        out["errors"].append({"msg": "circular definition: " + " → ".join(cyc)})
        return out
    if explorer:
        saved = list(reg["metrics"])
        reg["metrics"] = [m for m in saved if m["name"] != name] + [{"name": name, "expression": expression,
                                                                     "unit": out["unit"], "kind": "custom"}]
        try:
            v, _, na = explorer.metric_value(explorer.verified, name)
            out["value"] = v
            if v is None:
                out["errors"].append({"msg": na or "can't evaluate on the current result"})
        finally:
            reg["metrics"] = saved
    return out


def add_variable(project: str, goal: dict, name: str, expression: str, hold: list[str], explorer: Explorer | None) -> dict:
    reg = load_registry(project)
    a = analyze_variable(reg, goal, name, expression, hold, explorer)
    if a["errors"]:
        raise ExplorerError("; ".join(e["msg"] for e in a["errors"]))
    reg["variables"].append({"name": name, "expression": expression, "hold_constant": hold, "unit": a["unit"],
                             "kind": "derived"})
    save_registry(project, reg)
    return a


def add_metric(project: str, goal: dict, name: str, expression: str, unit: str | None, explorer: Explorer | None) -> dict:
    reg = load_registry(project)
    a = analyze_metric(reg, goal, name, expression, unit, explorer)
    if a["errors"]:
        raise ExplorerError("; ".join(e["msg"] for e in a["errors"]))
    reg["metrics"].append({"name": name, "expression": expression, "unit": a["unit"], "kind": "custom"})
    save_registry(project, reg)
    return a


def remove(project: str, kind: str, name: str):
    reg = load_registry(project)
    key = "variables" if kind == "variable" else "metrics"
    users = [x["name"] for x in reg[key] if x["name"] != name and name in expr.names(expr.parse(x["expression"]))]
    if users:
        raise ExplorerError(f"'{name}' is used by {', '.join(users)}; remove those first")
    reg[key] = [x for x in reg[key] if x["name"] != name]
    save_registry(project, reg)


# ====================================================================== per-run explorers + auto precompute
EXPLORERS: dict[str, Explorer] = {}


def for_run(run) -> Explorer:
    """The run's explorer. Only created once the run has finished, so its base point is the final design."""
    ex = EXPLORERS.get(run.id)
    if ex is None:
        if not run.finished:
            raise ExplorerError("The explorer opens when the run finishes.")
        ex = Explorer(run)
        EXPLORERS[run.id] = ex
    return ex


async def auto_precompute(run):
    """After a verified run: compute the Jacobian for watched variables within the budget and autonomy (§2.7)."""
    if not run.primary or not run.summary or run.summary.get("status") in ("cancelled", "failed"):
        return
    try:
        ex = for_run(run)
    except ExplorerError:
        return
    pl = ex.plan()
    if pl["n_runs"] == 0:
        ex.status = "done"
        await run.emit("jacobian_done", {"cost_basis": ex.cost_basis()})
        return
    reason = None
    if run.autonomy == "ask":
        reason = "Ask-me-first autonomy: confirm before starting background runs."
    elif not run.summary.get("verified"):
        reason = "The run isn't verified, so I'm not precomputing sensitivities automatically."
    elif pl["n_runs"] > pl["budget"]:
        reason = f"{pl['n_runs']} coarse runs exceed the compute budget ({pl['budget']})."
    if reason:
        ex.proposal = {**pl, "reason": reason}
        await run.emit("jacobian_proposed", ex.proposal)
        return
    await ex.compute_jacobian()


# ====================================================================== small numerics (no numpy dependency)
def _poly(c, t: float) -> float:
    return c[0] + c[1] * t + c[2] * t * t


def _lstsq(rows: list[tuple[list[float], float]]) -> list[float]:
    """Least squares for 3 unknowns via the normal equations + Gaussian elimination with pivoting."""
    n = 3
    A = [[sum(r[0][i] * r[0][j] for r in rows) for j in range(n)] for i in range(n)]
    b = [sum(r[0][i] * r[1] for r in rows) for i in range(n)]
    for i in range(n):  # tiny ridge keeps a degenerate fit (e.g. 2 distinct x) solvable
        A[i][i] += 1e-12 * (A[i][i] or 1)
    M = [A[i] + [b[i]] for i in range(n)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[piv] = M[piv], M[col]
        if abs(M[col][col]) < 1e-300:
            continue
        for r in range(n):
            if r != col:
                f = M[r][col] / M[col][col]
                M[r] = [M[r][k] - f * M[col][k] for k in range(n + 1)]
    return [M[i][n] / M[i][i] if abs(M[i][i]) > 1e-300 else 0.0 for i in range(n)]


def _quad_roots(a: float, b: float, c: float) -> list[float]:
    """Real roots of a t² + b t + c = 0 (falls back to linear when a ≈ 0)."""
    if abs(a) < 1e-12 * max(abs(b), 1e-30):
        return [-c / b] if abs(b) > 1e-300 else []
    d = b * b - 4 * a * c
    if d < 0:
        return []
    sq = math.sqrt(d)
    q = -0.5 * (b + math.copysign(sq, b))
    roots = [q / a] + ([c / q] if abs(q) > 1e-300 else [])
    return roots


def _fmt(v) -> str:
    if v is None:
        return "n/a"
    a = abs(v)
    if a == 0:
        return "0"
    if a >= 100:
        return f"{v:.1f}"
    if a >= 1:
        return f"{v:.3g}" if a < 10 else f"{v:.1f}"
    return f"{v:.3g}"
