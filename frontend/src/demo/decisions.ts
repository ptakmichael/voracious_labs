import { type ArrayDesign, F0, PAPER_ARRAY, SCAN_MAX, glFreeScan, lambda } from './arrayModel'
import { type Design, SUBSTRATE, effectMatrix, quality } from './model'

/**
 * Why each solver and optimiser choice was made, as rows of: what we saw in the geometry (with the number that
 * shows it) → what that means → what we chose, and what it ruled out. Computed from the design being solved.
 */
export interface Decision { area: 'Solver' | 'Boundaries' | 'Mesh' | 'Sweep' | 'Optimiser'; saw: string; means: string; chose: string; not?: string }

const C0 = 299.792458

export function patchDecisions(d: Design): Decision[] {
  const lam = C0 / 2.44, lamD = lam / Math.sqrt(d.er), Q = quality(d)
  const Ws = SUBSTRATE.wid * d.gs, Ls = SUBSTRATE.len * d.gs
  const m = effectMatrix(d)
  // how independent are the two tuning knobs? length row vs inset row, resonance and resistance columns
  const lf = Math.abs(m[0][0].up), lr = Math.abs(m[0][3].up), yf = Math.abs(m[2][0].up), yr = Math.abs(m[2][3].up)
  return [
    { area: 'Solver', saw: `One narrow resonance: Q ≈ ${Q.toFixed(0)}, about ${(100 / Q).toFixed(0)}% bandwidth`, means: 'Energy rings for many cycles; the answer is a sharp function of frequency', chose: 'Frequency-domain finite elements: each frequency is solved exactly, with no waiting for the ringing to die out', not: `Time domain (FDTD): ~${Math.round(Q * 2.5)} cycles of ring-down per run` },
    { area: 'Solver', saw: `Finite ground, ${Ws.toFixed(0)} × ${Ls.toFixed(0)} mm (${(Ws / lam).toFixed(2)} λ), and ground size is a design variable`, means: 'Edge diffraction sets the back lobe and ~1 dB of gain', chose: 'A volume method that models the real board edges', not: 'Planar method of moments: assumes an infinite ground and dielectric' },
    { area: 'Mesh', saw: `Thin board, h = ${d.h} mm (${(d.h / lamD).toFixed(3)} λ in the dielectric), 1.0 mm inset slots`, means: 'Fields change fast across the thickness and at the slot corners', chose: 'Second-order tetrahedra that conform to the board and slots; refined only where the error estimate says', not: 'A uniform Cartesian grid: ~0.2 mm cells everywhere to resolve the slots' },
    { area: 'Boundaries', saw: 'Geometry and feed are mirror-symmetric about x = 0', means: 'The fields are symmetric too, for the co-polarised result', chose: 'A magnetic-wall (PMC) symmetry plane: solve half, 2× faster', not: 'Using it for cross-polarisation, which it would suppress' },
    { area: 'Boundaries', saw: `Lowest frequency 2.1 GHz: λ/4 = ${(C0 / 2.1 / 4).toFixed(0)} mm`, means: 'An absorber closer than that sits in the reactive near field and detunes the patch', chose: `Six-layer PML, ${(C0 / 2.1 / 4).toFixed(0)} mm from the board on every side`, not: 'A first-order absorbing boundary: needs λ/2 of air and still reflects at grazing angles' },
    { area: 'Sweep', saw: 'One resonance in 2.1–2.8 GHz and nothing else', means: 'S11 is a smooth, low-order function of frequency', chose: 'Fast sweep: 4 full solves + a reduced-order model for 281 points, spot-checked to < 0.05 dB', not: '281 independent solves' },
    { area: 'Mesh', saw: 'The goal is a frequency band', means: 'What matters is where the resonance sits', chose: 'Stop refining when resonance moves < 0.5 MHz between passes (not a field-error tolerance)' },
    { area: 'Optimiser', saw: `Two knobs that barely interact: length moves resonance ${lf.toFixed(0)} MHz per 5% (inset: ${yf.toFixed(0)}); inset moves resistance ${yr.toFixed(1)} Ω per 5% (length: ${lr.toFixed(1)})`, means: 'The problem is nearly separable and smooth, with one basin (see the contour map)', chose: 'A damped Newton step on length and inset together, using adjoint sensitivities from each solve', not: 'Genetic / particle-swarm search: hundreds of solves for a two-variable, single-minimum problem' },
    { area: 'Optimiser', saw: 'Each step changes two dimensions by < 3%', means: 'The converged mesh from the last run is still nearly right', chose: 'Warm start: morph the mesh and do one refinement pass (94 s → 31 s a run)' },
  ]
}

export function arrayDecisions(el: Design, a: ArrayDesign = PAPER_ARRAY): Decision[] {
  const L = lambda(F0), n = a.nx * a.ny, edge = n - Math.max(0, a.nx - 2) * Math.max(0, a.ny - 2)
  const dmax = L / (1 + Math.sin((SCAN_MAX * Math.PI) / 180))
  return [
    { area: 'Solver', saw: `${n} identical elements on a regular ${a.dx.toFixed(0)} mm grid`, means: 'Every element sees the same surroundings, apart from the edges', chose: 'One unit cell with periodic (Floquet) boundaries: a single element stands in for the whole array, and scanning is a phase shift across the walls', not: `Meshing all ${n} elements for every design change` },
    { area: 'Solver', saw: `Only ${a.nx} × ${a.ny}: ${edge} of ${n} elements are on an edge`, means: 'Edge elements see fewer neighbours, so the infinite-array answer is only a start', chose: 'A finite-array check of the full 4×4 (domain decomposition, one block per element) at 0°, 22° and 42°' },
    { area: 'Sweep', saw: `Pitch ${a.dx.toFixed(0)} mm = ${(a.dx / L).toFixed(2)} λ`, means: 'Neighbours couple strongly, so the match changes as the beam steers', chose: `Active S11 swept over scan angle (0–${SCAN_MAX}°) with Floquet ports, not just the isolated element`, not: 'Judging the match from one element on its own, as the paper does' },
    { area: 'Mesh', saw: `εr = ${el.er} board, ${el.h} mm thick`, means: `Wavelength in the board is ${(L / Math.sqrt(el.er)).toFixed(0)} mm, a third of free space`, chose: 'Mesh density set by the in-board wavelength; free-space cells left coarse' },
    { area: 'Solver', saw: 'Gain, pointing and sidelobes are dominated by the array, not the element', means: 'They follow array factor × element pattern closely', chose: 'Array factor × embedded element pattern for every steering angle (milliseconds), full-wave check at three angles', not: `A full-wave solve per steering angle and per taper` },
    { area: 'Sweep', saw: '20 MHz channel, 0.8% bandwidth', means: 'Beam squint over the channel is under half a degree', chose: 'Three frequency points (edges and centre); phase shifters, not true-time delay' },
    { area: 'Optimiser', saw: 'Element match and array pattern depend on different variables', means: 'They can be optimised in stages without fighting each other', chose: 'Staged: element length and inset first (gradient), then pitch, then the amplitude taper' },
    { area: 'Optimiser', saw: `No grating lobe at ${SCAN_MAX}° needs d ≤ λ/(1 + sin ${SCAN_MAX}°) = ${dmax.toFixed(0)} mm; coupling falls as the pitch opens (grating-lobe-free to ${glFreeScan(a).toFixed(0)}° now)`, means: 'One variable, a hard ceiling and a monotonic benefit', chose: `A 1-D search on pitch, capped at ${dmax.toFixed(0)} mm, stopping when the active match clears −10 dB` },
    { area: 'Optimiser', saw: 'Sidelobes are set by the amplitude weights, not the geometry', means: 'There are closed-form weights for a target sidelobe level', chose: 'A Taylor taper for −25 dB (n̄ = 4); no numerical search over 16 weights', not: 'Optimising each element amplitude: 16 variables for a problem with a textbook answer' },
  ]
}
