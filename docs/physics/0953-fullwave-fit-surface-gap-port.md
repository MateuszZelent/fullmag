# Resistive gap excitation for the full-wave FIT reference

- Status — Draft reference extension
- Baseline — `7d36c49e2`
- Related notes — [Full-wave FIT antenna reference](0953-fullwave-fit-antenna.md) and [harmonic RF antenna](0952-harmonic-rf-antenna-cpw.md)

(fit-gap-problem-statement)=
## 1. Physical problem

A finite copper GSG waveguide is excited at its end face. The full-wave research FIT solver currently imposes scalar terminal voltages and circuit loads with a constrained boundary trace. In the independent Palace control, two gap rectangles carry a prescribed tangential surface drive and a passive sheet admittance. The uncovered inlet retains the natural magnetic boundary. Comparing these two source models requires preserving the geometry, material stack, outlet and monitor while changing only the inlet boundary. The input-port dimensions, placement and calibration of the published CST project are unavailable.

(fit-gap-governing-equations)=
## 2. Governing equations and SI units

Use peak phasors with physical time convention $e^{i\omega t}$. The volume has conductivity $\sigma$ in S/m, permittivity $\varepsilon$ in F/m and permeability $\mu$ in H/m.

```{math}
:label: eq-fit-gap-maxwell

\nabla\times E=-i\omega\mu H,\qquad \nabla\times H=(\sigma+i\omega\varepsilon)E.
```

At a port patch with outward normal $n$, tangential projection $E_t$, tangential driving direction $d$ and uniform positive real sheet admittance $Y_s$ in S,

```{math}
:label: eq-fit-gap-boundary

n\times H=-Y_s E_t+2Y_s E_{\rm inc}d.
```

The first term absorbs outward power on both tangential components. The second launches the uniform incident field along $d$. The boundary is magnetic on uncovered surfaces, except where a separate PEC or termination is specified. A conductance on the total field is not a voltage constraint.

For $N$ rectangular patches forming one real port with resistance $R$ in Ω, assign branch resistance $NR$ to each patch of length $\ell$ along $d$ and perpendicular width $w$ in m. The sheet and incident phasor follow from the total incident power and phase.

```{math}
:label: eq-fit-gap-normalization

R_s=\frac{NRw}{\ell},\quad Y_s=R_s^{-1},\quad E_{\rm inc}=\frac{\sqrt{2RP_{\rm inc}}}{\ell}e^{i\phi},\quad \tfrac12Y_s\lvert E_{\rm inc}\rvert^2w\ell=\frac{P_{\rm inc}}{N}.
```

The incident magnetic amplitude is $Y_s E_{\rm inc}$ in A/m. A matched 50 Ω pair with $\ell=95$ nm, $w=10$ nm, $P_{\rm inc}=1$ W and opposite transverse directions has $R_s=10.52631579\,\Omega$, $|E_{\rm inc}|=1.05263158\times10^8$ V/m and $|Y_s E_{\rm inc}|=10^7$ A/m per patch. Unit incident power is a solver calibration. The absolute current and field in the CST article cannot be inferred from it.

With test field $v$, let $L_\Gamma$ and $F_\Gamma$ be the surface additions to the left and right of the curl–curl equation. The absorbed time-average power is $P_\Gamma$.

```{math}
:label: eq-fit-gap-weak

L_\Gamma=i\omega\int_\Gamma v_t^*\cdot Y_s E_t\,dS,\qquad F_\Gamma=2i\omega\int_\Gamma v_t^*\cdot Y_s E_{\rm inc}d\,dS,\qquad P_\Gamma=\tfrac12\int_\Gamma Y_s\lVert E_t\rVert^2\,dS.
```

The incident and reflected waves must be separated before comparing S-parameters.

(fit-gap-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $E$ | Electric field phasor | $\mathrm{V\,m^{-1}}$ |
| $H$ | Magnetic field phasor | $\mathrm{A\,m^{-1}}$ |
| $i$ | Imaginary unit | $1$ |
| $\omega$ | Angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $\sigma$ | Conductivity | $\mathrm{S\,m^{-1}}$ |
| $\varepsilon$ | Permittivity | $\mathrm{F\,m^{-1}}$ |
| $\mu$ | Permeability | $\mathrm{H\,m^{-1}}$ |
| $\nabla\times$ | Spatial curl operator | $\mathrm{m^{-1}}$ |
| $n$ | Outward unit normal | $1$ |
| $E_t$ | Tangential electric trace | $\mathrm{V\,m^{-1}}$ |
| $E_{\rm inc}$ | Incident electric field amplitude on a patch | $\mathrm{V\,m^{-1}}$ |
| $d$ | Unit drive direction | $1$ |
| $d_y$ | Signed component of the drive along the y axis | $1$ |
| $N$ | Number of equal-resistance branches in one port | $1$ |
| $R$ | Total port resistance | $\Omega$ |
| $R_s$ | Sheet resistance | $\Omega$ |
| $Y_s$ | Sheet admittance | $\mathrm{S}$ |
| $\ell$ | Whole-patch length along the drive | $\mathrm{m}$ |
| $w$ | Whole-patch width transverse to the drive | $\mathrm{m}$ |
| $P_{\rm inc}$ | Total incident time-average power | $\mathrm{W}$ |
| $\phi$ | Incident phase | $\mathrm{rad}$ |
| $\Gamma$ | Boundary patch | $\mathrm{m^2}$ |
| $dS$ | Differential surface area | $\mathrm{m^2}$ |
| $v_t^*$ | Conjugated tangential trace of the electric test field | $\mathrm{V\,m^{-1}}$ |
| $L_\Gamma$ | Surface contribution on the left of the weak equation | $\mathrm{W\,s^{-1}}$ |
| $F_\Gamma$ | Surface contribution on the right of the weak equation | $\mathrm{W\,s^{-1}}$ |
| $P_\Gamma$ | Absorbed time-average power on a patch | $\mathrm{W}$ |
| $\Delta y$ | Face cell length along y | $\mathrm{m}$ |
| $\Delta z$ | Face cell length along z | $\mathrm{m}$ |
| $M_{y}$ | Conductance block for two y-parallel edge integrals | $\mathrm{S}$ |
| $b_y$ | Incident vector entry before multiplication by angular frequency | $\mathrm{A}$ |

(fit-gap-discrete-realization)=
## 3. Discretization

(fit-gap-assumptions-and-validity)=
### Grid and material assumptions

The first CPU double reference uses the existing orthogonal FIT volume operator. On a rectangular x-normal grid face with dimensions $\Delta y$, $\Delta z$, let the two parallel y-edges carry voltage-integral degrees of freedom. Exact integration of the piecewise linear trace gives the surface matrix block and drive entry.

```{math}
:label: eq-fit-gap-discrete

M_{y}=\frac{Y_s\Delta z}{6\Delta y}\begin{pmatrix}2&1\\1&2\end{pmatrix},\qquad b_y=Y_s E_{\rm inc}d_y\Delta z.
```

Interchanging y and z gives the block for the other tangential pair. There are no cross terms because these direction vectors are orthogonal. A uniform y-directed surface drive places $Y_s E_{\rm inc}d_y\Delta z$ in each y-edge entry of the right-hand vector before multiplication by $i\omega$. Opposite gap orientations reverse only the drive sign. PEC edge values are removed from both matrix and source. The sheet is integrated on material-aligned end faces. No interpolation across an element is needed to place a gap edge.

An H(curl) FEM reference uses the same weak form and the tangential traces of edge basis functions; Palace is the independent implementation. Micromagnetic FDM receives a sampled complex H field only after validation of the electromagnetic stage. It does not apply RF surface conditions itself. FEM micromagnetics would consume that same physical quantity through its target projection. No GPU or single precision qualification is implied. A hybrid run keeps electromagnetic and micromagnetic provenance separate and records the source and target grids and phase.

| Solver | Device | Status | Reason |
| --- | --- | --- | --- |
| FDM | CPU | Research-only EM boundary | Consumes sampled H in a separate micromagnetic step. |
| FDM | GPU | Research-only EM boundary | No GPU FIT sheet-port operator is qualified. |
| FEM | CPU | Research-only EM boundary | The independent H(curl) comparison uses Palace. |
| FEM | GPU | Research-only EM boundary | No GPU FEM sheet-port operator is qualified. |

(fit-gap-python-api)=
## 4. API, runtime and output

This executable example uses the repository research scripts.

```python
# %% Imports. Run from the repository root.
import sys

import numpy as np
from scipy.constants import epsilon_0, mu_0

sys.path.insert(0, "scripts")
from rf_fit_reference import assemble
from rf_fit_surface_gap_port import GapPatch, GapPort, solve_gap_ports

# %% Matched TEM reference at 1 GHz in vacuum
length, height, width = 0.15, 0.02, 0.03
resistance = np.sqrt(mu_0 / epsilon_0) * height / width
axes = (np.linspace(0, length, 81), np.linspace(0, height, 4), np.linspace(0, width, 4))
fit = assemble(axes, 0.0, 1.0, 1e9)
patch = GapPatch((0, height), (0, width), +1)
ports = (GapPort(0, resistance, (patch,), incident_power_w=1.0),
         GapPort(length, resistance, (patch,)))
y = fit.points_m[fit.edges, 1]
pec = np.flatnonzero(np.all(y == 0, axis=1) | np.all(y == height, axis=1))
solution = solve_gap_ports(fit, ports, pec_edges=pec)

# %% Check energy balance and the algebraic solve
assert solution.relative_residual < 1e-11
np.testing.assert_allclose(solution.power_source_w, solution.power_surface_w, rtol=1e-11)
```

(fit-gap-problem-ir)=
### ProblemIR and native runtime

The boundary is initially an explicit research input with quantities expressed in SI. The canonical Python, ProblemIR, planner, capability matrix, runner, OpenAPI and browser surfaces have no new admitted configuration at this stage. Native admission would put positive frequency, resistance, phase, incident power, direction and named disjoint gap surfaces on the existing antenna field solve stage. Planner validation must reject unresolvable surfaces, overlapping PEC, inconsistent terms and unsupported wave-mode terminations. A qualified native runtime would expose electric and magnetic phasors, copper current, outlet condition, physical power balance, mesh revision, original inputs and resolved port model using the existing field and artifact resources. Browser authoring would export the same port declaration to canonical Python and inspect H and J through the accepted artifact carrier.

(fit-gap-round-trip-and-failure-semantics)=
### Round-trip and failure semantics

The research script records requested intent through its grid, material and port configuration. Resolved execution uses the CPU double FIT operator. Validation errors cover invalid power or resistance, non-finite phase, misaligned or overlapping patches, and invalid PEC indices. The public Python and browser round trip has no sheet-port construct. Native or GPU runs with this research-only port are unsupported combinations.

(fit-gap-validation)=
## 5. Validation gates

1. Check the analytic surface matrix with constant tangential fields, both tangential directions, multiple nonuniform faces, and limits of the uniform two-gap power identity. The block must be symmetric positive semidefinite. A zero incident drive has no source and retains damping. Opposite patch directions preserve the matrix. Test on the small reference grid before a volume solve.
2. Solve a simple matched and a mismatched guide with known incident phase and check energy. Compare through the same PEC mask, exact boundary patches, admittances and phasor convention. Report real power supplied by the drive, passive port dissipation, copper heat and any other exit flux. For the insulating uniform fixture this balance is limited by algebraic residual and arithmetic. For the physical guide also check mesh convergence and direct probes in both tools.
3. Run the 65 nm and 260 nm signal CPWs at 22.12 GHz with 95 nm gaps and 10 nm copper, 21 identical longitudinal sections and a common 20 nm transverse line 7.5 nm below copper. Validate complex H_y with the same inlet-current orientation and compare own-peak spectra. Record current closure, power and independent readback residual before interpreting a match with the published CST curves. A fair Palace A/B comparison requires the same outlet as FIT. Use a separately matched pair with resistive output first if the FIT wave outlet is unavailable. Identify the original CST outlet and monitor as unresolved inputs.

(fit-gap-limitations)=
## 6. Completeness and deferred work

- [x] Governing boundary, assumptions and reproducible uniform-patch normalizations
- [x] Discrete surface operator and analytic fixture
- [x] Full-volume FIT solver and matched/mismatched analytical TEM fixtures
- [ ] Independent full-wave CPW1/CPW2 comparisons and mesh refinement
- [ ] Native stage, compiler, planner and artifact integration after qualification
- [ ] OpenAPI resource coverage, browser controls and Python round trip after qualification

An exact modal outlet, open boundary treatment, curved sheet ports and material-conformal edge integration remain separate work. A different outlet or monitor precludes attributing the entire residual to the inlet. The independent comparison to CST and the downstream spin dynamics have separate acceptance evidence.

(fit-gap-scientific-bibliography)=
## 7. References

- [Gruszecki et al., Scientific Reports 6, 22367](https://doi.org/10.1038/srep22367)
- [Palace boundary documentation at the pinned revision](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/docs/src/guide/boundaries.md)
- [Palace port normalization and source model at the pinned revision](https://github.com/awslabs/palace/blob/be4b5d36ffe77933d4dbf86209d2bf21a2059fe3/palace/models/lumpedportoperator.cpp)

(fit-gap-implementation-mapping)=
(fit-gap-source-code-index)=
## Source-code index

| Path | Symbol | Responsibility |
| --- | --- | --- |
| `scripts/rf_fit_surface_gap_port.py` | `assemble_gap_ports` | Stamp the analytic conductance and signed incident surface vector. |
| `scripts/rf_fit_surface_gap_port.py` | `solve_gap_ports` | Solve the volume and boundary system and report power terms. |
| `scripts/rf_fit_reference.py` | `assemble` | Build the orthogonal volume topology and material weights. |
| `scripts/test_rf_fit_surface_gap_port.py` | `test_nonuniform_rectangles_conserve_resistance_power_and_polarity` | Check admittance, direction, and the resistance and power normalizations. |
| `scripts/test_rf_fit_surface_gap_port.py` | `test_tem_guide_recovers_known_voltage_phase_and_load_power` | Check phase, distribution and absorbed power for matched and mismatched loads. |
