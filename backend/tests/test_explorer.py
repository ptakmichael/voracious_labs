import asyncio
import math

import pytest

from emsolver import expr, explorer, metrics, physics
from emsolver.cli import default_project
from emsolver.orchestrator import ScriptedOrchestrator
from emsolver.pipeline import Run


# ---------------------------------------------------------------- E1: expression language
def ev(src, **vals):
    return expr.evaluate(expr.parse(src), expr.Env(scalars=lambda n: vals[n]))


def test_evaluator_arithmetic_and_functions():
    assert ev("1 + 2 * 3") == 7
    assert ev("-2 ^ 2") == -4          # unary minus binds looser than ^
    assert ev("2 ^ 3 ^ 2") == 512      # ^ is right-associative
    assert ev("feed_x / (L_res / 2)", feed_x=6.0, L_res=31.6) == pytest.approx(0.3797, abs=1e-4)
    assert ev("sqrt(abs(-16)) + log10(100) + min(3, 1, 2) + max(1, 5) + mean(2, 4)") == 4 + 2 + 1 + 5 + 3
    assert ev("2 ** 3") == 8


@pytest.mark.parametrize("src", ["", "1 +", "(1 + 2", "foo(1)", "1 $ 2", "f_res f_res"])
def test_evaluator_rejects_bad_syntax(src):
    a = expr.analyze(src, expr.Context(scalars={"f_res": {"GHz": 1}}))
    assert a.errors


def test_never_uses_python_eval():
    # attribute access and dunder names are not part of the grammar
    for src in ["__import__('os')", "f_res.real", "[1,2]"]:
        assert expr.analyze(src, expr.Context(scalars={"f_res": {}})).errors


def test_units_and_warnings():
    ctx = expr.Context(scalars={"W": {"mm": 1}, "L_res": {"mm": 1}, "S": {"dB": 1}})
    assert expr.analyze("W / L_res", ctx).unit == {}
    assert expr.fmt_unit(expr.analyze("W * L_res", ctx).unit) == "mm^2"
    assert expr.analyze("-10 - S", ctx).unit == {"dB": 1} and not expr.analyze("-10 - S", ctx).warnings
    assert expr.analyze("W + S", ctx).warnings  # mm + dB


def test_band_functions_need_a_series():
    ctx = expr.Context(scalars={"f_res": {"GHz": 1}}, series={"S11_dB": {"dB": 1}}, band_ok=True)
    a = expr.analyze("-10 - max(S11_dB, 2.40, 2.48)", ctx)
    assert a.ok and a.unit == {"dB": 1}
    assert expr.analyze("S11_dB + 1", ctx).errors                   # series outside a band function
    assert expr.analyze("argmin(S11_dB, 2.0, 3.0)", ctx).unit == {"GHz": 1}
    no_band = expr.Context(scalars={}, series={"S11_dB": {"dB": 1}}, band_ok=False)
    assert expr.analyze("max(S11_dB, 2.4, 2.48)", no_band).errors   # not allowed in variable expressions


def test_cycle_detection():
    assert expr.find_cycle({"a": {"b"}, "b": {"a"}}) is not None
    assert expr.find_cycle({"a": {"b"}, "b": {"L_res"}}) is None


# ---------------------------------------------------------------- mock (§7)
def test_mock_input_resistance_vs_feed():
    m = physics.PatchModel(31.6, 40.0, 3.38, 1.524, feed_frac=0.38)
    assert m.r_in() == pytest.approx(55.6, abs=0.1)
    fs = [2.0 + i / 200 for i in range(201)]
    s = physics.s11_complex(m, fs)
    assert max(abs(x) for x in s) <= 1.0  # passive


# ---------------------------------------------------------------- E2: Jacobian engine
@pytest.fixture()
def ex(tmp_path, monkeypatch):
    monkeypatch.setattr(explorer, "REG_DIR", tmp_path)
    explorer.REGISTRIES.clear()
    explorer.ROW_STORE.clear()
    explorer.EXPLORERS.clear()
    run = Run(default_project(), speed=1000)
    asyncio.run(ScriptedOrchestrator(run).go())
    e = explorer.for_run(run)

    async def go():
        await e.compute_jacobian()
    asyncio.run(go())
    return e


def test_jacobian_fills_every_metric_from_two_runs_per_variable(ex):
    assert ex.coarse_runs == 2 * len(ex.base)
    m = ex.matrix()
    for v in ex.base:
        assert all(c["value"] is not None or c["na_reason"] for c in m["cells"][v].values())
    assert m["cells"]["L_res"]["axial_ratio"]["na_reason"].startswith("linear polarization")


def test_jacobian_matches_analytic_mock_derivatives(ex):
    b = ex.base
    m0 = physics.PatchModel(b["L_res"], b["W"], b["eps_r"], b["h"], 0.0027, b["feed_x"] / (b["L_res"] / 2), b["margin"])

    def f_of_L(L):
        return physics.PatchModel(L, m0.width_mm, m0.eps_r, m0.h_mm, m0.tan_d, b["feed_x"] / (L / 2),
                                  m0.margin_mm).f_true() * (1 - physics.FIDELITY_ERR[0])
    eps = 1e-5
    analytic_f = (f_of_L(b["L_res"] + eps) - f_of_L(b["L_res"] - eps)) / (2 * eps)
    assert ex.cell("L_res", "f_res")["deriv"] == pytest.approx(analytic_f, rel=0.05)

    # Re Zin = R_edge sin²(π fx / L): dR/dfx = R_edge sin(2π fx/L) π / L
    analytic_r = physics.R_EDGE * math.sin(2 * math.pi * b["feed_x"] / b["L_res"]) * math.pi / b["L_res"]
    assert ex.cell("feed_x", "Zin_re_fc")["deriv"] == pytest.approx(analytic_r, rel=0.05)


@pytest.mark.parametrize("name,expression,hold", [
    ("feed_ratio", "feed_x / (L_res / 2)", ["L_res", "W", "h", "eps_r"]),   # one free variable
    ("aspect", "W / L_res", []),                                               # min-norm over W and L_res
])
def test_chain_rule_matches_direct_fd_on_q(ex, name, expression, hold):
    explorer.add_variable(ex.name, ex.goal, name, expression, hold, ex)
    q0 = ex.var_value(name)
    dq = 0.01 * q0
    plus = explorer.simulate(ex.project, ex.point_values(name, q0 + dq), ex.solver, 0, ex.padding, ex.freqs)[0]
    minus = explorer.simulate(ex.project, ex.point_values(name, q0 - dq), ex.solver, 0, ex.padding, ex.freqs)[0]
    qp = ex.var_value(name, ex.point_values(name, q0 + dq))
    qm = ex.var_value(name, ex.point_values(name, q0 - dq))
    for metric in ("f_res", "Zin_re_fc"):
        direct = (ex.metric_value(plus, metric)[0] - ex.metric_value(minus, metric)[0]) / (qp - qm)
        chain = ex.cell(name, metric)
        if chain["noisy"]:
            continue
        assert chain["deriv"] == pytest.approx(direct, rel=0.05), metric
        assert chain["hold"]  # the hold-constant rule is always stated


def test_hold_everything_is_rejected(ex):
    with pytest.raises(explorer.ExplorerError, match="can't change"):
        explorer.add_variable(ex.name, ex.goal, "r", "feed_x / L_res", ["feed_x", "L_res"], ex)


def test_custom_metric_needs_no_new_runs_and_cycles_rejected(ex):
    n = ex.coarse_runs
    explorer.add_metric(ex.name, ex.goal, "gm", "-10 - max(S11_dB, 2.40, 2.48)", "dB", ex)
    c = ex.cell("L_res", "gm")
    assert c["value"] is not None and ex.coarse_runs == n
    assert ex.cell("L_res", "gm")["deriv"] == pytest.approx(ex.cell("L_res", "goal_margin")["deriv"])
    explorer.add_metric(ex.name, ex.goal, "m1", "gm + 1", None, ex)
    reg = explorer.load_registry(ex.name)
    reg["metrics"][-1]["expression"] = "m2 + 1"  # sneak a cycle in, then check analysis catches it
    a = explorer.analyze_metric(reg, ex.goal, "m2", "m1 * 2", None, ex)
    assert any("circular" in e["msg"] for e in a["errors"])


def test_registry_persists(ex, tmp_path):
    explorer.add_variable(ex.name, ex.goal, "aspect", "W / L_res", ["L_res"], ex)
    explorer.REGISTRIES.clear()
    assert [v["name"] for v in explorer.load_registry(ex.name)["variables"]] == ["aspect"]


def test_surface_target_and_verify(ex):
    explorer.add_variable(ex.name, ex.goal, "feed_ratio", "feed_x / (L_res / 2)", ["L_res", "W", "h", "eps_r"], ex)

    async def go():
        s = ex.start_surface("feed_ratio", "Zin_re_fc", range_pct=10, n_points=5)
        await ex.surfaces[s["id"]]["_task"]
        t = ex.target("Zin_re_fc", 50.0, "feed_ratio")
        assert t["in_range"] and t["solution"] == pytest.approx(0.358, abs=0.002)  # README demo acceptance
        rec = await ex.verify_point("feed_ratio", t["solution"], "Zin_re_fc")
        assert abs(rec["error"]) < 0.5
        view = ex.surface_view(s["id"])
        assert view["smith"]["path"] and view["tangent"]
    asyncio.run(go())


def test_band_metric_reports_active_point():
    fs = [2.0 + i / 200 for i in range(201)]
    s = physics.s11_complex(physics.PatchModel(32.0, 41.5, 3.38, 1.524), fs)
    v, f = metrics.band({"freqs": fs, "s": s}, "max", "S11_dB", 2.40, 2.48)
    assert 2.40 <= f <= 2.48 and v == max(physics.db(metrics.interp(fs, s, x)) for x in (2.40, f, 2.48))
