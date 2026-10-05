import asyncio

from emsolver.cli import default_project
from emsolver.orchestrator import ScriptedOrchestrator
from emsolver.physics import f_res_equation, patch_design
from emsolver.pipeline import Run
from emsolver.problem import features, interpret, select


def test_design_equations_roundtrip():
    d = patch_design(2.44, 3.38, 1.524)
    assert abs(f_res_equation(d["L"], d["W"], 3.38, 1.524) - 2.44) < 1e-6


def test_selector_prefers_fem_for_thin_substrate():
    p = default_project()
    feat = features(p, interpret(p))
    assert feat["thin"]
    assert select(feat, p["settings"])["winner"] == "palace"


def test_scripted_happy_path():
    run = Run(default_project(), speed=200)
    asyncio.run(ScriptedOrchestrator(run).go())
    s = run.summary
    assert s["status"] == "met_verified"
    assert len(run.fixes) == 1 and len(run.design_history) == 1
    assert s["mock"] is True
