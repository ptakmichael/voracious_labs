"""Metric catalog (EXPLORER_README §4, v1) and extraction from a solver result.

A "result" here is a dict with the frequency grid `freqs` (GHz), complex `s` (S11) and, for the far-field
metric, `gain_bs` (dBi). Every metric is computed only from what a real solver would return, so the same
code works when the mock is swapped for openEMS or Palace.
"""
from __future__ import annotations

import math

from . import expr, physics

Z0 = 50.0

# Frequency-dependent metrics (usable inside band functions)
SERIES = {
    "S11_dB": {"label": "S11", "unit": "dB"},
    "S11_mag": {"label": "|S11|", "unit": ""},
    "S11_phase": {"label": "∠S11", "unit": "deg"},
    "Zin_re": {"label": "Re Zin", "unit": "Ω"},
    "Zin_im": {"label": "Im Zin", "unit": "Ω"},
    "VSWR": {"label": "VSWR", "unit": ""},
}


def scalar_catalog(goal: dict) -> list[dict]:
    """Standard scalar metrics. `fc` labels use the goal-band centre. `floor` is the solver repeatability used
    for the FD noise check; `impedance` marks metrics that get a Smith-chart trajectory."""
    fc = (goal["f1"] + goal["f2"]) / 2
    return [
        {"name": "f_res", "label": "f_res", "long": "Resonant frequency", "unit": "GHz", "floor": 3e-5},
        {"name": "bw_10db", "label": "BW −10 dB", "long": "−10 dB bandwidth", "unit": "GHz", "floor": 6e-5},
        {"name": "S11_dB_fc", "label": f"|S11| @ {fc:.2f}", "long": f"S11 at {fc:.2f} GHz", "unit": "dB",
         "floor": 0.02, "impedance": True},
        {"name": "Zin_re_fc", "label": "Re Zin", "long": f"Input resistance at {fc:.2f} GHz", "unit": "Ω",
         "floor": 0.1, "impedance": True},
        {"name": "Zin_im_fc", "label": "Im Zin", "long": f"Input reactance at {fc:.2f} GHz", "unit": "Ω",
         "floor": 0.1, "impedance": True},
        {"name": "VSWR_min", "label": "VSWR min", "long": "Minimum VSWR", "unit": "", "floor": 0.003, "impedance": True},
        {"name": "goal_margin", "label": "Goal margin", "long": f"{goal['threshold_db']} dB minus worst S11 in "
         f"{goal['f1']:.2f}–{goal['f2']:.2f} GHz (positive = goal met)", "unit": "dB", "floor": 0.02},
        {"name": "gain_bs", "label": "Gain boresight", "long": "Boresight gain (analytic cavity-model far field)",
         "unit": "dBi", "floor": 1e-6, "note": "analytic far-field estimate, not from solver fields"},
        {"name": "axial_ratio", "label": "Axial ratio", "long": "Axial ratio at boresight", "unit": "dB", "floor": 0,
         "na": "linear polarization: axial ratio is not meaningful for this antenna"},
    ]


def interp(freqs: list[float], s: list[complex], f: float) -> complex:
    if f <= freqs[0]:
        return s[0]
    if f >= freqs[-1]:
        return s[-1]
    lo, hi = 0, len(freqs) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if freqs[mid] <= f:
            lo = mid
        else:
            hi = mid
    t = (f - freqs[lo]) / (freqs[hi] - freqs[lo])
    return s[lo] + t * (s[hi] - s[lo])


def series_value(name: str, s: complex) -> float:
    if name == "S11_dB":
        return physics.db(s)
    if name == "S11_mag":
        return abs(s)
    if name == "S11_phase":
        return math.degrees(math.atan2(s.imag, s.real))
    if name in ("Zin_re", "Zin_im"):
        z = physics.zin(s, Z0)
        return z.real if name == "Zin_re" else z.imag
    if name == "VSWR":
        m = min(abs(s), 0.999999)
        return (1 + m) / (1 - m)
    raise KeyError(name)


def _min_refined(freqs: list[float], y: list[float]) -> tuple[float, float, int]:
    """Minimum of sampled y with parabolic refinement: (f, y, grid index)."""
    i = min(range(len(y)), key=lambda k: y[k])
    if 0 < i < len(y) - 1:
        y0, y1, y2 = y[i - 1], y[i], y[i + 1]
        den = y0 - 2 * y1 + y2
        if den > 0:
            d = 0.5 * (y0 - y2) / den
            df = freqs[i + 1] - freqs[i]
            return freqs[i] + d * df, y1 - 0.25 * (y0 - y2) * d, i
    return freqs[i], y[i], i


def band(res: dict, fn: str, name: str, f1: float, f2: float | None) -> tuple[float, float | None]:
    """Band function on a series: returns (value, active frequency)."""
    freqs, s = res["freqs"], res["s"]
    if fn == "at":
        return series_value(name, interp(freqs, s, f1)), f1
    lo, hi = min(f1, f2), max(f1, f2)
    if lo < freqs[0] - 1e-9 or hi > freqs[-1] + 1e-9:
        raise expr.ExprError(f"band {lo:g}–{hi:g} GHz is outside the solved band {freqs[0]:g}–{freqs[-1]:g} GHz")
    fs = [lo] + [f for f in freqs if lo < f < hi] + [hi]
    vals = [series_value(name, interp(freqs, s, f)) for f in fs]
    if fn == "mean":
        if len(fs) < 2 or hi == lo:
            return vals[0], None
        area = sum((fs[k + 1] - fs[k]) * (vals[k] + vals[k + 1]) / 2 for k in range(len(fs) - 1))
        return area / (hi - lo), None
    if fn == "max":
        k = max(range(len(vals)), key=lambda j: vals[j])
        return vals[k], fs[k]
    f, v, _ = _min_refined(fs, vals)
    return (f if fn == "argmin" else v), f


def standard(res: dict, goal: dict) -> dict[str, tuple[float | None, object, str | None]]:
    """All standard scalar metrics: name → (value, active point for non-smooth detection, n/a reason)."""
    if "_std" in res:
        return res["_std"]
    freqs, s = res["freqs"], res["s"]
    fc = (goal["f1"] + goal["f2"]) / 2
    mag2 = [abs(x) ** 2 for x in s]
    f_res, m2, _ = _min_refined(freqs, mag2)
    out: dict[str, tuple] = {"f_res": (f_res, None, None)}
    sdb = [physics.db(x) for x in s]
    b = physics.band_below(freqs, sdb, -10.0)
    out["bw_10db"] = (b[1] - b[0], None, None) if b else (None, None, "S11 never drops below −10 dB")
    sfc = interp(freqs, s, fc)
    z = physics.zin(sfc, Z0)
    out["S11_dB_fc"] = (physics.db(sfc), None, None)
    out["Zin_re_fc"] = (z.real, None, None)
    out["Zin_im_fc"] = (z.imag, None, None)
    m = math.sqrt(max(m2, 0.0))
    out["VSWR_min"] = ((1 + m) / (1 - min(m, 0.999999)), None, None)
    worst, f_act = band(res, "max", "S11_dB", goal["f1"], goal["f2"])
    out["goal_margin"] = (goal["threshold_db"] - worst, f_act, None)
    out["gain_bs"] = (res["gain_bs"], None, None) if res.get("gain_bs") is not None else (None, None, "no far-field export")
    out["axial_ratio"] = (None, None, "linear polarization: axial ratio is not meaningful for this antenna")
    res["_std"] = out
    return out
