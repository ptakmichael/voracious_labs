"""Problem IR helpers: materials, geometry interpretation, features, rule-based selector."""
from __future__ import annotations

import math
from typing import Any

from .physics import C0, PatchModel, patch_design

MATERIALS: dict[str, dict[str, Any]] = {
    "vacuum": {"eps_r": 1.0, "tan_d": 0.0, "kind": "dielectric"},
    "air": {"eps_r": 1.0006, "tan_d": 0.0, "kind": "dielectric"},
    "pec": {"eps_r": 1.0, "tan_d": 0.0, "kind": "pec"},
    "copper": {"eps_r": 1.0, "tan_d": 0.0, "kind": "pec", "sigma": 5.8e7},
    "fr4": {"eps_r": 4.4, "tan_d": 0.02, "kind": "dielectric"},
    "ro4003c": {"eps_r": 3.38, "tan_d": 0.0027, "kind": "dielectric"},
    "rt5880": {"eps_r": 2.2, "tan_d": 0.0009, "kind": "dielectric"},
    "ro3010": {"eps_r": 10.2, "tan_d": 0.0022, "kind": "dielectric"},
    "alumina": {"eps_r": 9.8, "tan_d": 0.0001, "kind": "dielectric"},
}

ACCURACY = {"quick": 0.1, "standard": 0.03, "tight": 0.01}

FIDELITY_TABLE = {
    "openems": {0: "mesh λmin/12 · 2 cells thru substrate · end 1e-3",
                1: "mesh λmin/20 · 4 cells thru substrate · end 1e-4",
                2: "mesh λmin/30 · 6 cells thru substrate · end 1e-5"},
    "palace": {0: "element λ/6 · order 1", 1: "element λ/10 · order 2", 2: "element λ/15 · order 3"},
}

SOLVER_LABEL = {"palace": "Palace · FEM", "openems": "openEMS · FDTD"}


def material(project: dict, name: str) -> dict:
    for m in project.get("materials", []):
        if m.get("name", "").lower() == (name or "").lower():
            return m
    return MATERIALS.get((name or "vacuum").lower(), MATERIALS["vacuum"])


def is_pec(project: dict, obj: dict) -> bool:
    return material(project, obj.get("material", "")).get("kind") == "pec"


def interpret(project: dict) -> dict:
    """Find substrate / ground / patch / port in an arbitrary object list."""
    objs = [o for o in project.get("objects", []) if o.get("visible", True) is not False]
    warnings: list[str] = []
    boxes = [o for o in objs if o["kind"] in ("box", "cylinder") and not is_pec(project, o)]
    sheets = [o for o in objs if o["kind"] == "sheet" or (o["kind"] == "box" and is_pec(project, o))]
    conductors = [o for o in sheets if is_pec(project, o)]
    ports = [o for o in objs if o["kind"] == "port"]

    def by_role(role):
        return next((o for o in objs if o.get("role") == role), None)

    vol = lambda o: o["size"][0] * o["size"][1] * max(o["size"][2], 1e-3)
    area = lambda o: o["size"][0] * o["size"][1]
    substrate = by_role("substrate") or (max(boxes, key=vol) if boxes else None)
    ground = by_role("ground") or (min(conductors, key=lambda o: o["pos"][2]) if conductors else None)
    patch_candidates = [o for o in conductors if o is not ground]
    patch = by_role("patch") or (max(patch_candidates, key=area) if patch_candidates else None)
    port = ports[0] if ports else None

    if substrate is None:
        warnings.append("No dielectric substrate found; assuming air (εr = 1).")
    if ground is None:
        warnings.append("No ground plane found.")
    if patch is None:
        warnings.append("No radiating conductor found; using the largest conductor.")
        patch = ground
    if port is None:
        warnings.append("No port defined; a 50 Ω lumped port is required to compute S11.")

    eps_r, tan_d, h = 1.0, 0.0, 1.0
    if substrate:
        m = material(project, substrate.get("material", ""))
        eps_r, tan_d, h = m["eps_r"], m.get("tan_d", 0.0), substrate["size"][2]
    if patch is None:
        model = PatchModel(30.0, 40.0, eps_r, h, tan_d)
    else:
        L, W = patch["size"][0], patch["size"][1]
        feed = 0.33
        if port:
            feed = min(abs(port["pos"][0] - patch["pos"][0]) / max(L / 2, 1e-6), 1.0)
        model = PatchModel(L, W, eps_r, max(h, 0.05), tan_d, feed)

    xs = [o["pos"][0] + s * o["size"][0] / 2 for o in objs if o["kind"] != "port" for s in (-1, 1)]
    ys = [o["pos"][1] + s * o["size"][1] / 2 for o in objs if o["kind"] != "port" for s in (-1, 1)]
    extent = max((max(xs) - min(xs)) if xs else 0, (max(ys) - min(ys)) if ys else 0)
    return {"model": model, "substrate": substrate, "ground": ground, "patch": patch, "port": port,
            "warnings": warnings, "n_objects": len(objs), "extent_mm": extent,
            "n_ports": len(ports), "n_conductors": len(conductors)}


def features(project: dict, geo: dict) -> dict:
    s = project["settings"]
    f1, f2 = s["f_start"], s["f_stop"]
    fc = (f1 + f2) / 2
    lam_c = C0 / (fc * 1e9) * 1e3
    lam_min_f = C0 / (f1 * 1e9) * 1e3
    m: PatchModel = geo["model"]
    h_ld = m.h_mm / (lam_min_f / math.sqrt(m.eps_r))
    f_est = m.f_true()
    boundary = project.get("boundary", {}).get("type", "radiation")
    return {
        "electrical_size": round(geo["extent_mm"] / lam_c, 3),
        "h_over_lambda_d": round(h_ld, 4),
        "thin": h_ld < 0.02,
        "eps_r": m.eps_r,
        "tan_d": m.tan_d,
        "boundary": "Open, radiating" if boundary in ("radiation", "pml") else "Closed (PEC)",
        "ports": geo["n_ports"],
        "port_label": f"{geo['n_ports']} lumped",
        "band": [f1, f2],
        "band_pct": round(100 * (f2 - f1) / 2 / fc),
        "f_estimate_ghz": round(f_est, 3),
        "smallest_feature_mm": round(min(m.h_mm, 1.0), 3),
        "n_objects": geo["n_objects"],
    }


def select(feat: dict, settings: dict) -> dict:
    """Rule-based selector v0. Returns ranked options plus the rule that fired."""
    tol = ACCURACY[settings["accuracy"]]
    h_ld = feat["h_over_lambda_d"]
    span = feat["band_pct"] / 100
    # cost model v0 (seconds of compute, illustrative constants)
    t_openems = 384 * (0.0187 / max(h_ld, 1e-4)) * (0.03 / tol) ** 0.35 * (1 + feat["electrical_size"])
    t_palace = 186 * (1 + 2.2 * span) * (0.03 / tol) ** 0.25 * (1 + 0.6 * feat["electrical_size"])
    t_openems /= 1.1
    t_palace /= 1.6
    reasons = []
    if h_ld < 0.02:
        winner = "palace"
        reasons.append(f"thin substrate (h ≈ {h_ld:.3f} λd) forces tiny FDTD cells and time steps")
    elif span >= 0.3 and tol >= 0.03:
        winner = "openems"
        reasons.append(f"broad band (±{feat['band_pct']}%) is covered by one FDTD run")
    elif tol <= 0.01:
        winner = "palace"
        reasons.append("tight tolerance favours high-order FEM")
    else:
        winner = "openems"
        reasons.append("no strong feature; FDTD at fidelity 1 is the default")
    if winner == "palace" and t_palace > t_openems:
        t_palace, t_openems = t_openems * 0.9, t_palace
    if winner == "openems" and t_openems > t_palace:
        t_openems, t_palace = t_palace * 0.9, t_openems
    p_pal = t_openems ** 2 / (t_openems ** 2 + t_palace ** 2)
    fid = 2 if tol <= 0.01 else 1
    opts = [
        {"solver": "palace", "label": SOLVER_LABEL["palace"], "fidelity": fid, "pred_cost_s": round(t_palace),
         "pred_error": round(tol * 0.6, 4), "p_fastest": round(p_pal, 2)},
        {"solver": "openems", "label": SOLVER_LABEL["openems"], "fidelity": fid, "pred_cost_s": round(t_openems),
         "pred_error": round(tol * 0.7, 4), "p_fastest": round(1 - p_pal, 2)},
    ]
    opts.sort(key=lambda o: -o["p_fastest"])
    conf = opts[0]["p_fastest"]
    extra = []
    if span < 0.1:
        extra.append("narrow goal band")
    extra.append(f"{settings['accuracy']} accuracy")
    why = f"{reasons[0]} (biggest factor), {', '.join(extra)}. " + (
        "Confidence is high, so no pilot runs are needed." if conf >= 0.7
        else "Confidence is moderate; a coarse pilot of both solvers would settle it.")
    return {"options": opts, "winner": winner, "reason": why, "rule": reasons[0], "confidence": conf}


def default_optimizations(solver: str, feat: dict, symmetric: bool) -> list[dict]:
    opts = []
    if solver == "palace":
        opts += [
            {"key": "symmetry", "name": "Symmetry plane y = 0 (domain ÷ 2)", "enabled": symmetric,
             "status": "applied" if symmetric else "n/a"},
            {"key": "thin_layer", "name": "Thin-layer mesh refinement", "enabled": feat["thin"], "status": "applied"},
            {"key": "adaptive_sweep", "name": "Adaptive frequency sweep", "enabled": True, "status": "applied"},
        ]
    else:
        opts += [
            {"key": "symmetry", "name": "Symmetry plane y = 0 (domain ÷ 2)", "enabled": False, "status": "planned"},
            {"key": "thin_layer", "name": "Graded mesh through thin layers", "enabled": feat["thin"], "status": "applied"},
            {"key": "excitation_bw", "name": "Gaussian excitation matched to band", "enabled": True, "status": "applied"},
        ]
    opts += [
        {"key": "padding", "name": "Air padding λ/4 (auto)", "enabled": True, "status": "applied"},
        {"key": "cores", "name": "4 CPU cores", "enabled": True, "status": "applied"},
        {"key": "warm_start", "name": "Warm start from similar past run", "enabled": False, "status": "planned"},
    ]
    return opts


def patch_template(f0: float, eps_r: float, h: float, tan_d: float = 0.0027, feed_frac: float = 0.33,
                   margin_frac: float = 0.12, material_name: str | None = None) -> dict:
    d = patch_design(f0, eps_r, h)
    L, W = d["L"], d["W"]
    lam0 = C0 / (f0 * 1e9) * 1e3
    margin = margin_frac * lam0
    gx, gy = L + 2 * margin, W + 2 * margin
    mat = material_name or "substrate_custom"
    feed_x = -feed_frac * L / 2
    r = lambda v: round(v, 3)
    objects = [
        {"id": "substrate", "name": "Substrate", "kind": "box", "role": "substrate", "material": mat,
         "pos": [0, 0, r(h / 2)], "size": [r(gx), r(gy), r(h)], "color": "#b9cdb4"},
        {"id": "ground", "name": "Ground plane", "kind": "sheet", "role": "ground", "material": "pec",
         "pos": [0, 0, 0], "size": [r(gx), r(gy), 0], "color": "#9aa6b8"},
        {"id": "patch", "name": "Patch", "kind": "sheet", "role": "patch", "material": "pec",
         "pos": [0, 0, r(h)], "size": [r(L), r(W), 0], "color": "#d9a03f"},
        {"id": "port1", "name": "Port 1", "kind": "port", "role": "port", "material": "pec",
         "pos": [r(feed_x), 0, r(h / 2)], "size": [1.0, 0, r(h)], "impedance": 50, "color": "#c2541e"},
    ]
    materials = [] if material_name else [{"name": mat, "eps_r": eps_r, "tan_d": tan_d, "kind": "dielectric"}]
    return {"objects": objects, "materials": materials,
            "design": {"f0": f0, "L": r(L), "W": r(W), "eps_eff": round(d["eps_eff"], 3), "dL": round(d["dL"], 3),
                       "feed_x": r(feed_x), "ground": [r(gx), r(gy)]}}
