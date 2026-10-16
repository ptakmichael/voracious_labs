"""FastAPI app: REST + Server-Sent Events."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import chat, explorer, exports
from .orchestrator import PROVIDER_LABEL, model_name, provider, run_pipeline
from .pipeline import Run
from .problem import MATERIALS, patch_template

app = FastAPI(title="Smart EM Solver")
RUNS: dict[str, Run] = {}
TASKS: dict[str, asyncio.Task] = {}


class PatchReq(BaseModel):
    f0: float = 2.44
    eps_r: float = 3.38
    h: float = 1.524
    tan_d: float = 0.0027
    feed_frac: float = 0.33
    margin_frac: float = 0.12
    material: str | None = None


class RunReq(BaseModel):
    project: dict
    speed: float = 1.0
    scripted: bool = False  # sample/preview runs skip the LLM


class ChatReq(BaseModel):
    text: str
    project: dict | None = None


class StudioAskReq(BaseModel):
    text: str
    state: dict = {}
    history: list[dict] = []
    commands: list[str] = []


class VariableReq(BaseModel):
    name: str
    expression: str
    hold_constant: list[str] = []
    unit: str | None = None
    run_id: str | None = None


class MetricReq(BaseModel):
    name: str
    expression: str
    unit: str | None = None
    run_id: str | None = None


class PreviewReq(BaseModel):
    kind: str  # "variable" | "metric"
    name: str = ""
    expression: str = ""
    hold_constant: list[str] = []
    unit: str | None = None
    run_id: str | None = None


class ExplorerSettingsReq(BaseModel):
    watched: list[str] | None = None
    budget: int | None = None


class JacobianReq(BaseModel):
    variables: list[str] | None = None


class SurfaceReq(BaseModel):
    variable: str
    metric: str
    n_points: int = 3
    range_pct: float = 5.0


class TargetReq(BaseModel):
    metric: str
    value: float
    variable: str


class PointReq(BaseModel):
    variable: str
    value: float
    metric: str = ""


class ApproveReq(BaseModel):
    target: str | None = None
    approved: bool = True
    value: float | None = None
    plan: dict | None = None


@app.get("/api/capabilities")
def capabilities():
    return {"solvers": {"openems": "mock", "palace": "mock", "mom": "planned", "hybrid": "planned"},
            "orchestrator": provider(), "label": PROVIDER_LABEL[provider()], "model": model_name(),
            "version": "0.1.0-demo"}


@app.get("/api/materials")
def materials():
    return [{"name": k, **v} for k, v in MATERIALS.items()]


@app.post("/api/templates/patch")
def template_patch(req: PatchReq):
    return patch_template(req.f0, req.eps_r, req.h, req.tan_d, req.feed_frac, req.margin_frac, req.material)


@app.post("/api/runs")
async def start_run(req: RunReq):
    run = Run(req.project, req.speed)
    RUNS[run.id] = run
    TASKS[run.id] = asyncio.create_task(_pipeline_then_explore(run, req.scripted))
    return {"run_id": run.id}


async def _pipeline_then_explore(run: Run, scripted: bool):
    await run_pipeline(run, scripted)
    try:  # background sensitivities after a verified run (EXPLORER_README §2.7)
        await explorer.auto_precompute(run)
    except Exception as e:  # never turn a finished run into a failure
        import traceback
        traceback.print_exc()
        await run.emit("error", {"message": f"Effect-matrix precompute failed: {e}", "where": "explorer"})


def get_run(rid: str) -> Run:
    if rid not in RUNS:
        raise HTTPException(404, "run not found")
    return RUNS[rid]


@app.get("/api/runs/{rid}")
def run_state(rid: str):
    r = get_run(rid)
    return {"id": r.id, "state": r.state, "stage": r.stage, "finished": r.finished, "summary": r.summary}


@app.get("/api/runs/{rid}/events")
async def events(rid: str):
    run = get_run(rid)
    q: asyncio.Queue = asyncio.Queue()
    history = list(run.events)
    run.subscribers.append(q)

    async def gen():
        try:
            for ev in history:
                yield f"data: {json.dumps(ev, default=str)}\n\n"
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(ev, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            if q in run.subscribers:
                run.subscribers.remove(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/chat")
async def chat_setup(req: ChatReq):
    return await chat.handle(None, req.text, req.project)


@app.post("/api/studio/ask")
async def studio_ask(req: StudioAskReq):
    return await chat.studio_ask(req.state, req.text, req.history, req.commands)


@app.post("/api/runs/{rid}/chat")
async def chat_run(rid: str, req: ChatReq):
    return await chat.handle(get_run(rid), req.text)


@app.post("/api/runs/{rid}/approve")
async def approve(rid: str, req: ApproveReq):
    run = get_run(rid)
    if req.plan and run.plan:  # edited plan toggles
        for o in run.plan["optimizations"]:
            if o["key"] in req.plan.get("enabled", {}) and o["status"] != "planned":
                o["enabled"] = bool(req.plan["enabled"][o["key"]])
        if req.plan.get("solver") in ("palace", "openems") or req.plan.get("fidelity") in (0, 1, 2):
            enabled = {o["key"]: o["enabled"] for o in run.plan["optimizations"]}
            run.plan = run._make_plan(req.plan.get("solver") or run.plan["solver"],
                                      req.plan.get("fidelity") if req.plan.get("fidelity") is not None else run.plan["fidelity"])
            for o in run.plan["optimizations"]:
                if o["key"] in enabled and o["status"] != "planned":
                    o["enabled"] = enabled[o["key"]]
        if "cross_check" in req.plan:
            run.cross_check = bool(req.plan["cross_check"])
            run.plan["cross_check"] = run.cross_check
        await run.emit_plan()
    ok = run.resolve(req.approved, by="button", value=req.value) if (req.approved or req.target) else False
    if req.approved and ok:
        await run.say({"plan": "Starting the solve.", "design": "Applying the change and re-running.",
                       "fix": "Applying the fix."}.get(req.target or "", "Approved."), "solver")
    return {"ok": ok}


@app.post("/api/runs/{rid}/hold")
async def hold(rid: str):
    run = get_run(rid)
    run.hold = True
    await run.emit("hold", {})
    return {"ok": True}


@app.post("/api/runs/{rid}/cancel")
async def cancel(rid: str):
    run = get_run(rid)
    run.cancelled = True
    run.paused.set()
    return {"ok": True}


# ---------------------------------------------------------------- 3D explorer + effect matrix
def _explorer(rid: str) -> explorer.Explorer:
    run = get_run(rid)
    try:
        return explorer.for_run(run)
    except explorer.ExplorerError as e:
        raise HTTPException(400, str(e))


def _bad(e: Exception):
    raise HTTPException(400, getattr(e, "msg", None) or str(e))


def _ctx(pid: str, run_id: str | None) -> tuple[dict, explorer.Explorer | None]:
    """Goal + explorer for registry edits: the given run, else the latest finished run of this project."""
    run = RUNS.get(run_id) if run_id else None
    if run is None:
        done = [r for r in RUNS.values() if r.project.get("name") == pid and r.primary]
        run = done[-1] if done else None
    if run is None:
        return {"threshold_db": -10, "f1": 2.4, "f2": 2.48}, None
    try:
        return run.goal, explorer.for_run(run)
    except explorer.ExplorerError:
        return run.goal, None


@app.get("/api/projects/{pid}/variables")
def list_variables(pid: str, run_id: str | None = None):
    _, ex = _ctx(pid, run_id)
    if ex:
        return ex.variables_view()
    from .family import BASE_VARS
    reg = explorer.load_registry(pid)
    return [{**b, "kind": "base"} for b in BASE_VARS] + reg["variables"]


@app.post("/api/projects/{pid}/variables")
def create_variable(pid: str, req: VariableReq):
    goal, ex = _ctx(pid, req.run_id)
    try:
        return explorer.add_variable(pid, goal, req.name.strip(), req.expression, req.hold_constant, ex)
    except explorer.ExplorerError as e:
        _bad(e)


@app.delete("/api/projects/{pid}/variables/{name}")
def delete_variable(pid: str, name: str):
    try:
        explorer.remove(pid, "variable", name)
    except explorer.ExplorerError as e:
        _bad(e)
    return {"ok": True}


@app.get("/api/projects/{pid}/metrics")
def list_metrics(pid: str, run_id: str | None = None):
    goal, ex = _ctx(pid, run_id)
    if ex:
        return ex.metric_meta()
    from .metrics import scalar_catalog
    return [{**m, "kind": "standard"} for m in scalar_catalog(goal)] + explorer.load_registry(pid)["metrics"]


@app.post("/api/projects/{pid}/metrics")
def create_metric(pid: str, req: MetricReq):
    goal, ex = _ctx(pid, req.run_id)
    try:
        return explorer.add_metric(pid, goal, req.name.strip(), req.expression, req.unit, ex)
    except explorer.ExplorerError as e:
        _bad(e)


@app.delete("/api/projects/{pid}/metrics/{name}")
def delete_metric(pid: str, name: str):
    try:
        explorer.remove(pid, "metric", name)
    except explorer.ExplorerError as e:
        _bad(e)
    return {"ok": True}


@app.post("/api/projects/{pid}/preview")
def preview(pid: str, req: PreviewReq):
    """Live validation for the builders: current value, unit, errors and (for variables) what it drives."""
    goal, ex = _ctx(pid, req.run_id)
    reg = explorer.load_registry(pid)
    if req.kind == "variable":
        return explorer.analyze_variable(reg, goal, req.name.strip(), req.expression, req.hold_constant, ex)
    return explorer.analyze_metric(reg, goal, req.name.strip(), req.expression, req.unit, ex)


@app.put("/api/projects/{pid}/explorer-settings")
def explorer_settings(pid: str, req: ExplorerSettingsReq):
    from .family import BASE_NAMES
    reg = explorer.load_registry(pid)
    if req.watched is not None:
        reg["watched"] = [v for v in BASE_NAMES if v in req.watched]
    if req.budget is not None:
        reg["budget"] = max(2, min(200, int(req.budget)))
    explorer.save_registry(pid, reg)
    return {"watched": reg["watched"], "budget": reg["budget"]}


@app.post("/api/runs/{rid}/jacobian")
async def start_jacobian(rid: str, req: JacobianReq):
    ex = _explorer(rid)
    try:
        return ex.start_jacobian(req.variables)
    except explorer.ExplorerError as e:
        _bad(e)


@app.get("/api/runs/{rid}/jacobian")
def get_jacobian(rid: str):
    return _explorer(rid).matrix()


@app.post("/api/runs/{rid}/surface")
async def start_surface(rid: str, req: SurfaceReq):
    try:
        return _explorer(rid).start_surface(req.variable, req.metric, req.range_pct, req.n_points)
    except (explorer.ExplorerError, ValueError) as e:
        _bad(e)


@app.get("/api/runs/{rid}/surface/{sid}")
def get_surface(rid: str, sid: str, f0: float | None = None):
    try:
        return _explorer(rid).surface_view(sid, f0)
    except explorer.ExplorerError as e:
        _bad(e)


@app.post("/api/runs/{rid}/target")
async def target(rid: str, req: TargetReq):
    ex = _explorer(rid)
    try:
        res = ex.target(req.metric, req.value, req.variable)
    except explorer.ExplorerError as e:
        _bad(e)
    await ex.run.emit("target_solution", {k: res[k] for k in ("metric", "value", "variable", "solution", "side_effects",
                                                               "in_range")})
    return res


@app.post("/api/runs/{rid}/verify-point")
async def verify_point(rid: str, req: PointReq):
    try:
        return await _explorer(rid).verify_point(req.variable, req.value, req.metric)
    except explorer.ExplorerError as e:
        _bad(e)


@app.post("/api/runs/{rid}/apply")
def apply_point(rid: str, req: PointReq):
    try:
        return _explorer(rid).apply(req.variable, req.value)
    except explorer.ExplorerError as e:
        _bad(e)


@app.get("/api/runs/{rid}/export/{fmt}")
def export(rid: str, fmt: str):
    run = get_run(rid)
    if not run.primary:
        raise HTTPException(400, "no results yet")
    name = run.project.get("name", "project")
    if fmt == "s1p":
        return PlainTextResponse(exports.touchstone(run), headers={"Content-Disposition": f'attachment; filename="{name}.s1p"'})
    if fmt == "yaml":
        return PlainTextResponse(exports.problem_yaml(run), headers={"Content-Disposition": f'attachment; filename="{name}.yaml"'})
    if fmt == "script":
        return PlainTextResponse(exports.script(run), headers={"Content-Disposition": f'attachment; filename="reproduce_{name}.py"'})
    if fmt == "report":
        return Response(exports.report_html(run), media_type="text/html")
    raise HTTPException(404, "unknown format")


# Serve the built frontend if present (production mode: one process, one port)
DIST = Path(__file__).resolve().parents[3] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if path and f.is_file() else DIST / "index.html")
