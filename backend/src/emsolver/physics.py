"""Patch-antenna design equations and the MOCK solver response model.

Nothing here is a real EM simulation. The mock S11 is a single-resonator model whose
resonance comes from the transmission-line design equations, so editing the geometry
moves the curve in a believable way.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass

C0 = 299_792_458.0  # m/s


# ---------------------------------------------------------------- design equations
def eps_eff(eps_r: float, h_mm: float, w_mm: float) -> float:
    return (eps_r + 1) / 2 + (eps_r - 1) / 2 * (1 + 12 * h_mm / w_mm) ** -0.5


def delta_l(eps_r: float, h_mm: float, w_mm: float) -> float:
    ee = eps_eff(eps_r, h_mm, w_mm)
    return 0.412 * h_mm * (ee + 0.3) * (w_mm / h_mm + 0.264) / ((ee - 0.258) * (w_mm / h_mm + 0.8))


def patch_design(f0_ghz: float, eps_r: float, h_mm: float) -> dict:
    """Return (resonant length L, non-resonant width W) in mm for a target f0."""
    f0 = f0_ghz * 1e9
    w = C0 / (2 * f0) * math.sqrt(2 / (eps_r + 1)) * 1e3
    ee = eps_eff(eps_r, h_mm, w)
    dl = delta_l(eps_r, h_mm, w)
    length = C0 / (2 * f0 * math.sqrt(ee)) * 1e3 - 2 * dl
    return {"L": length, "W": w, "eps_eff": ee, "dL": dl}


def f_res_equation(length_mm: float, width_mm: float, eps_r: float, h_mm: float) -> float:
    """Resonant frequency (GHz) from the transmission-line model."""
    ee = eps_eff(eps_r, h_mm, width_mm)
    dl = delta_l(eps_r, h_mm, width_mm)
    return C0 / (2 * (length_mm + 2 * dl) * 1e-3 * math.sqrt(ee)) / 1e9


def length_for_f(f_ghz: float, width_mm: float, eps_r: float, h_mm: float) -> float:
    ee = eps_eff(eps_r, h_mm, width_mm)
    dl = delta_l(eps_r, h_mm, width_mm)
    return C0 / (2 * f_ghz * 1e9 * math.sqrt(ee)) * 1e3 - 2 * dl


# ---------------------------------------------------------------- mock S11 model
# The "true" mock resonance sits a little below the design equation (probe inductance,
# finite ground), which is what makes the first design miss the goal band.
PROBE_SHIFT = 0.9866
# Per-solver bias so FDTD and FEM disagree slightly; openEMS bias depends on padding.
SOLVER_BIAS = {"palace": 1.000, "openems": 1.000}
FIDELITY_ERR = {0: 0.012, 1: 0.003, 2: 0.0008}
R_EDGE = 176.0          # input resistance with the feed at the radiating edge (Ω)
Z0 = 50.0
# Repeatability of the mock "solver" (relative f_res, Ω, relative Q). Small enough for FD and
# response-surface fits to behave, large enough that near-zero sensitivities read as noise.
NOISE = {"fr": 1e-5, "r": 0.05, "q": 2e-4}


@dataclass
class PatchModel:
    length_mm: float      # resonant dimension (x)
    width_mm: float       # non-resonant dimension (y)
    eps_r: float
    h_mm: float
    tan_d: float = 0.0027
    feed_frac: float = 0.33   # feed offset / (L/2)
    margin_mm: float = 15.0   # ground-plane margin beyond the patch edge

    def f_true(self) -> float:
        # a small ground plane pulls the resonance down a little
        shift = PROBE_SHIFT - 0.004 * math.exp(-self.margin_mm / 8)
        return f_res_equation(self.length_mm, self.width_mm, self.eps_r, self.h_mm) * shift

    def q(self) -> float:
        lam0 = C0 / (self.f_true() * 1e9) * 1e3
        q = 0.27 * math.sqrt(self.eps_r) * lam0 / (4 * self.h_mm)
        q *= 1 / (1 + 40 * self.tan_d)  # loss lowers Q a bit
        return min(max(q, 5.0), 45.0)

    def r_in(self) -> float:
        """Input resistance at resonance vs. feed position: R_edge · sin²(π · feed_ratio / 2)."""
        r = min(max(self.feed_frac, 0.0), 1.0)
        return max(R_EDGE * math.sin(math.pi * r / 2) ** 2, 0.5)

    def x_probe(self, f_ghz: float) -> float:
        """Series reactance of the probe feed (Ω): longer probes (thicker substrates) are more inductive."""
        l_nh = 0.42 * self.h_mm * (1 + 0.5 * self.feed_frac)
        return 2 * math.pi * f_ghz * l_nh

    def params(self) -> tuple:
        return (round(self.length_mm, 6), round(self.width_mm, 6), round(self.eps_r, 6), round(self.h_mm, 6),
                round(self.tan_d, 6), round(self.feed_frac, 6), round(self.margin_mm, 6))


def _noise(key: tuple, salt: str) -> float:
    """Deterministic pseudo-noise in [-1, 1]: the same design and settings always give the same answer."""
    h = hashlib.blake2b(repr((key, salt)).encode(), digest_size=8).digest()
    return int.from_bytes(h, "big") / 2 ** 63 - 1.0


def s11_complex(model: PatchModel, freqs_ghz: list[float], solver: str = "palace",
                fidelity: int = 1, padding_ratio: float = 0.25) -> list[complex]:
    """MOCK S11 for a probe-fed patch: a resonator Zin = R(1 + jQx) + jX_probe, x = f/fr − fr/f.

    R follows the feed position (R_edge sin²(π r / 2)), so moving the feed sets the match; the
    resonance follows the design equations. Q is the unloaded Q, chosen so the loaded Q at a 50 Ω
    match equals the cavity-model estimate.
    """
    key = (model.params(), solver, fidelity, round(padding_ratio, 4))
    fr = model.f_true()
    # fidelity-dependent shift: coarse meshes resonate low
    fr *= 1 - FIDELITY_ERR.get(fidelity, 0.003)
    if solver == "openems":
        # truncated air box pulls FDTD resonance down; fixed by more padding
        fr *= 1 - (0.023 if padding_ratio < 0.5 else 0.005)
    fr *= 1 + NOISE["fr"] * _noise(key, "fr")
    q_loaded = model.q() * (1 - 0.04 * (2 - min(fidelity, 2)))
    q0 = 2 * q_loaded * (1 + NOISE["q"] * _noise(key, "q"))
    r = model.r_in() * (1.03 if solver == "openems" else 1.0) + NOISE["r"] * _noise(key, "r")
    out = []
    for f in freqs_ghz:
        x = q0 * (f / fr - fr / f)
        z = complex(r, r * x + model.x_probe(f))
        out.append((z - Z0) / (z + Z0))
    return out


def zin(s: complex, z0: float = Z0) -> complex:
    return z0 * (1 + s) / (1 - s) if abs(1 - s) > 1e-12 else complex(1e9, 0)


def gain_boresight(model: PatchModel, f_ghz: float) -> float:
    """Analytic cavity-model boresight gain (dBi): ~6–7 dBi, a little higher for wide, thick, low-εr patches."""
    lam0 = C0 / (f_ghz * 1e9) * 1e3
    g = 6.0 + 2.2 / math.sqrt(model.eps_r) - 10 * math.log10(1 + 25 * model.tan_d)
    g += 1.5 * (model.width_mm / lam0 - 0.33) + 4.0 * (model.h_mm / lam0 - 0.012)
    g -= 0.6 * math.exp(-model.margin_mm / 10)  # small grounds leak power backwards
    return g


def db(s: complex) -> float:
    return 20 * math.log10(max(abs(s), 1e-9))


def band_below(freqs: list[float], s_db: list[float], thresh: float) -> tuple[float, float] | None:
    """Contiguous band around the minimum where S11 < thresh (linear interp at edges)."""
    i_min = min(range(len(s_db)), key=lambda i: s_db[i])
    if s_db[i_min] >= thresh:
        return None
    lo = i_min
    while lo > 0 and s_db[lo - 1] < thresh:
        lo -= 1
    hi = i_min
    while hi < len(s_db) - 1 and s_db[hi + 1] < thresh:
        hi += 1

    def interp(i, j):
        if s_db[i] == s_db[j]:
            return freqs[i]
        t = (thresh - s_db[i]) / (s_db[j] - s_db[i])
        return freqs[i] + t * (freqs[j] - freqs[i])

    f1 = interp(lo - 1, lo) if lo > 0 else freqs[0]
    f2 = interp(hi, hi + 1) if hi < len(s_db) - 1 else freqs[-1]
    return (f1, f2)


def max_complex_err(a: list[complex], b: list[complex]) -> float:
    return max(abs(x - y) for x, y in zip(a, b))


def resonance(freqs: list[float], s: list[complex]) -> float:
    i = min(range(len(s)), key=lambda k: abs(s[k]))
    return freqs[i]


# ---------------------------------------------------------------- far field (analytic estimate)
def patch_pattern(model: PatchModel, f_ghz: float, n: int = 181) -> dict:
    """Cavity-model E- and H-plane patterns (dB, normalised) plus a peak-gain estimate."""
    k0 = 2 * math.pi * f_ghz * 1e9 / C0
    w = model.width_mm * 1e-3
    leff = (model.length_mm + 2 * delta_l(model.eps_r, model.h_mm, model.width_mm)) * 1e-3
    h = model.h_mm * 1e-3
    thetas = [-90 + 180 * i / (n - 1) for i in range(n)]
    e_plane, h_plane = [], []
    for t in thetas:
        th = math.radians(t)
        # E-plane (phi = 0): array factor of two slots
        ep = abs(math.cos(k0 * leff / 2 * math.sin(th)))
        x = k0 * h / 2 * math.sin(th)
        ep *= abs(math.sin(x) / x) if abs(x) > 1e-9 else 1.0
        # H-plane (phi = 90)
        y = k0 * w / 2 * math.sin(th)
        hp = abs(math.sin(y) / y if abs(y) > 1e-9 else 1.0) * abs(math.cos(th))
        e_plane.append(ep)
        h_plane.append(hp)
    norm = lambda arr: [max(20 * math.log10(max(v, 1e-6) / max(arr)), -40) for v in arr]
    # crude directivity: ~ 6.6 dBi for typical patches, rises a bit with low eps_r
    gain = gain_boresight(model, f_ghz)
    return {"theta_deg": thetas, "e_plane_db": norm(e_plane), "h_plane_db": norm(h_plane),
            "peak_gain_dbi": round(gain, 2), "f_ghz": f_ghz}
