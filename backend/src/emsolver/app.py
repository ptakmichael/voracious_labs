"""FastAPI app: REST + Server-Sent Events."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import chat, exports
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
    TASKS[run.id] = asyncio.create_task(run_pipeline(run, req.scripted))
    return {"run_id": run.id}


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
