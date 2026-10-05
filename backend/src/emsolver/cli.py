"""Headless mode: same pipeline, printed as log lines.

    uv run emsolver run problem.yaml --autonomy auto
    uv run emsolver demo            # default patch, no files needed
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

import yaml

from .orchestrator import run_pipeline
from .pipeline import Run
from .problem import patch_template

ORANGE, BLUE, DIM, RESET = "\033[38;5;173m", "\033[38;5;110m", "\033[2m", "\033[0m"


def default_project() -> dict:
    t = patch_template(2.44, 3.38, 1.524)
    return {"name": "patch_2g4", "objects": t["objects"], "materials": t["materials"],
            "boundary": {"type": "radiation"},
            "settings": {"f_start": 2.0, "f_stop": 3.0, "n_points": 201, "accuracy": "standard",
                         "plots": ["s11", "smith"], "autonomy": "auto"},
            "goal": {"threshold_db": -10, "f1": 2.40, "f2": 2.48},
            "constraints": {"length_pct": 10, "feed_free": True}}


def line(tag: str, text: str, color: str = ""):
    print(f"{color}[{tag:<8}] {text}{RESET if color else ''}", flush=True)


def printer(ev: dict):
    t, p = ev["type"], ev["payload"]
    if t == "features":
        line("analyze", f"electrical size {p['electrical_size']} λ0 · h/λd {p['h_over_lambda_d']}"
                        f"{' (thin)' if p['thin'] else ''} · {p['boundary'].split(',')[0].lower()}")
    elif t == "selection":
        a, b = p["options"]
        line("select", f"{a['solver']} f{a['fidelity']}  pred {a['pred_cost_s'] / 60:.1f} min  conf {a['p_fastest']:.2f}"
                       f"   >  {b['solver']} f{b['fidelity']}  pred {b['pred_cost_s'] / 60:.1f} min")
    elif t == "plan" and p.get("countdown_s") is not None or (t == "plan" and not p.get("countdown_s")):
        if t == "plan":
            line("plan", f"{p['solver']} f{p['fidelity']} · " + " · ".join(
                o["name"] for o in p["optimizations"] if o["enabled"]))
    elif t == "subrun_finished":
        line("solve", f"{p['solver']} f{p['fidelity']} ({p['purpose']}) ".ljust(36, ".") +
             f" done  {p['sim_time_s'] / 60:.1f} min  [MOCK]")
    elif t == "verification":
        txt = " · ".join(f"{c['name'].split(',')[0].lower()} {'ok' if c['passed'] else 'FAIL'}" for c in p["checks"])
        line("verify", txt + (f" · error ≤ ±{p['error_bar']}" if p["passed"] else ""), BLUE if p["passed"] else ORANGE)
    elif t == "numerical_fix":
        line("fix", f"{p['change']}, re-running", ORANGE)
    elif t == "goal_check":
        mb = p["measured_band"]
        line("goal", f"S11 < {p['threshold_db']} dB on {p['goal_band'][0]:.2f}–{p['goal_band'][1]:.2f} GHz: "
                     f"{'MET' if p['met'] else 'NOT MET'} ({f'{mb[0]:.2f}–{mb[1]:.2f}' if mb else 'none'})",
             BLUE if p["met"] else ORANGE)
    elif t == "design_proposal":
        c = p["change"]
        line("design", f"{c['label']} {c['from']} → {c['to']} {c['unit']} ({p['coarse_runs']} coarse runs), verifying")
    elif t == "message" and p["role"] == "solver":
        line("narrate", p["text"], DIM)
    elif t == "error":
        line("error", p["message"], ORANGE)
    elif t == "run_finished":
        tl = p.get("tiles", {})
        line("report", f"{p['status']} · compute {tl.get('compute_min')} min (simulated) · MOCK results", BLUE)


async def main_async(project: dict, speed: float, as_json: bool):
    run = Run(project, speed)
    q: asyncio.Queue = asyncio.Queue()
    run.subscribers.append(q)
    task = asyncio.create_task(run_pipeline(run))
    while True:
        ev = await q.get()
        if as_json:
            print(json.dumps({k: ev[k] for k in ("t", "type")} | {"payload": {k: v for k, v in ev["payload"].items()
                                                                             if not isinstance(v, list) or len(v) < 12}},
                             default=str, ensure_ascii=False), flush=True)
        else:
            printer(ev)
        if ev["type"] == "run_finished":
            break
    await task
    return run


def main():
    ap = argparse.ArgumentParser(prog="emsolver")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("problem")
    r.add_argument("--goals")
    r.add_argument("--autonomy", default="auto", choices=["ask", "balanced", "auto"])
    r.add_argument("--speed", type=float, default=4.0)
    r.add_argument("--json", action="store_true")
    d = sub.add_parser("demo")
    d.add_argument("--speed", type=float, default=4.0)
    d.add_argument("--json", action="store_true")
    a = ap.parse_args()
    if a.cmd == "demo":
        project = default_project()
        print("$ emsolver run patch_2g4.yaml --autonomy auto")
    else:
        with open(a.problem) as f:
            project = yaml.safe_load(f)
        if a.goals:
            with open(a.goals) as f:
                project["goal"] = yaml.safe_load(f)
        project.setdefault("settings", {})["autonomy"] = a.autonomy
    asyncio.run(main_async(project, a.speed, a.json))


if __name__ == "__main__":
    sys.exit(main())
