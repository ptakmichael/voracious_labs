"""Patch-antenna family: base variables, how they map onto geometry, and dimension-handle metadata.

This lives alongside the Problem (it reads and writes the ordinary object list) rather than changing
the Problem schema. `extract` reads the base variables from a project, `apply` writes new values back
into a copy of it, and `handles` says which edges or points each geometric variable moves so the 3D
explorer can draw CAD-style dimension lines.
"""
from __future__ import annotations

import copy

from .problem import ground_margin, interpret, material

# name, label, unit, geometric?, FD mesh floor (mm, the "2 × local mesh size" in δ = max(1% p, 2 h_mesh))
BASE_VARS = [
    {"name": "L_res", "label": "Resonant length", "unit": "mm", "geometric": True, "mesh_floor": 0.2},
    {"name": "W", "label": "Patch width", "unit": "mm", "geometric": True, "mesh_floor": 0.2},
    {"name": "feed_x", "label": "Feed offset", "unit": "mm", "geometric": True, "mesh_floor": 0.2},
    {"name": "h", "label": "Substrate height", "unit": "mm", "geometric": True, "mesh_floor": 0.01},
    {"name": "eps_r", "label": "Substrate εr", "unit": "", "geometric": False, "mesh_floor": 0.0},
    {"name": "margin", "label": "Ground margin", "unit": "mm", "geometric": True, "mesh_floor": 0.2},
]
BASE_NAMES = [v["name"] for v in BASE_VARS]
BASE_BY_NAME = {v["name"]: v for v in BASE_VARS}


class NotAPatch(Exception):
    pass


def _parts(project: dict) -> dict:
    geo = interpret(project)
    if not geo["patch"] or not geo["port"] or not geo["ground"] or geo["patch"] is geo["ground"]:
        raise NotAPatch("The explorer needs a patch-type structure: a patch sheet, a ground plane and a port.")
    return geo


def extract(project: dict) -> dict[str, float]:
    g = _parts(project)
    patch, port, ground, sub = g["patch"], g["port"], g["ground"], g["substrate"]
    m = g["model"]
    return {
        "L_res": patch["size"][0],
        "W": patch["size"][1],
        "feed_x": abs(port["pos"][0] - patch["pos"][0]),
        "h": patch["pos"][2] - ground["pos"][2],
        "eps_r": m.eps_r if sub else 1.0,
        "margin": ground_margin(ground, patch),
    }


def apply(project: dict, values: dict[str, float]) -> dict:
    """Return a copy of `project` with the given base-variable values written into its geometry.
    Variables not in `values` keep their current value (base variables are independent)."""
    p = copy.deepcopy(project)
    g = _parts(p)
    cur = extract(p)
    new = {**cur, **{k: float(v) for k, v in values.items() if k in cur}}
    ids = {k: (g[k]["id"] if g[k] else None) for k in ("patch", "port", "ground", "substrate")}
    objs = {o["id"]: o for o in p["objects"]}
    patch, port, ground = objs[ids["patch"]], objs[ids["port"]], objs[ids["ground"]]
    sub = objs.get(ids["substrate"]) if ids["substrate"] else None
    r = lambda v: round(v, 4)

    # feed side is preserved (feed_x is a distance from the patch centre)
    side = -1.0 if port["pos"][0] < patch["pos"][0] else 1.0
    patch["size"][0], patch["size"][1] = r(new["L_res"]), r(new["W"])
    port["pos"][0] = r(patch["pos"][0] + side * new["feed_x"])

    # ground (and substrate) grow with the patch so each margin moves by the same amount
    dm = new["margin"] - cur["margin"]
    for o in [ground] + ([sub] if sub else []):
        o["size"][0] = r(o["size"][0] + (new["L_res"] - cur["L_res"]) + 2 * dm)
        o["size"][1] = r(o["size"][1] + (new["W"] - cur["W"]) + 2 * dm)

    if abs(new["h"] - cur["h"]) > 1e-12:
        z0 = ground["pos"][2]
        patch["pos"][2] = r(z0 + new["h"])
        port["size"][2] = r(new["h"])
        port["pos"][2] = r(z0 + new["h"] / 2)
        if sub:
            sub["size"][2] = r(new["h"])
            sub["pos"][2] = r(z0 + new["h"] / 2)

    if sub and abs(new["eps_r"] - cur["eps_r"]) > 1e-12:
        base = material(p, sub.get("material", ""))
        name = f"{sub.get('material', 'substrate')}_er{new['eps_r']:.4f}".replace(".", "p")
        mats = [m for m in p.get("materials", []) if m.get("name") != name]
        mats.append({"name": name, "eps_r": round(new["eps_r"], 6), "tan_d": base.get("tan_d", 0.0), "kind": "dielectric"})
        p["materials"] = mats
        sub["material"] = name
    return p


def handles(project: dict) -> dict[str, dict]:
    """Dimension-handle metadata per geometric base variable (world coordinates, mm).

    `a`/`b` are the dimension-line endpoints; `moves` names the edges or points the variable drives and
    `dir` is the direction they move as the variable increases."""
    g = _parts(project)
    patch, port, ground = g["patch"], g["port"], g["ground"]
    v = extract(project)
    px, py, pz = patch["pos"]
    L, W, h = v["L_res"], v["W"], v["h"]
    z0 = ground["pos"][2]
    off = max(3.0, 0.12 * max(L, W))  # dimension lines sit just outside the patch
    side = -1.0 if port["pos"][0] < px else 1.0
    gx = ground["pos"][0] + ground["size"][0] / 2
    gy0 = ground["pos"][1] - ground["size"][1] / 2
    return {
        "L_res": {"a": [px - L / 2, py - W / 2 - off, pz], "b": [px + L / 2, py - W / 2 - off, pz],
                  "ext": [[px - L / 2, py - W / 2, pz], [px + L / 2, py - W / 2, pz]],
                  "moves": "both radiating edges (x = ±L/2)", "dir": [1, 0, 0]},
        "W": {"a": [px + L / 2 + off, py - W / 2, pz], "b": [px + L / 2 + off, py + W / 2, pz],
              "ext": [[px + L / 2, py - W / 2, pz], [px + L / 2, py + W / 2, pz]],
              "moves": "both non-radiating edges (y = ±W/2)", "dir": [0, 1, 0]},
        "feed_x": {"a": [px, port["pos"][1], pz + 0.05], "b": [port["pos"][0], port["pos"][1], pz + 0.05],
                   "ext": [], "moves": "port 1 along x (away from the patch centre)", "dir": [side, 0, 0]},
        "h": {"a": [gx, gy0, z0], "b": [gx, gy0, z0 + h], "ext": [],
              "moves": "patch height, substrate thickness and probe length", "dir": [0, 0, 1]},
        "margin": {"a": [px + L / 2, gy0 + 0.6 * off, z0], "b": [gx, gy0 + 0.6 * off, z0],
                   "ext": [], "moves": "ground-plane and substrate edges", "dir": [1, 0, 0]},
    }
