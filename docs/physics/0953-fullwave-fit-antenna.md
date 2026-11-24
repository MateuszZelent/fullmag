# Full-wave finite integration for RF antennas

- Status: reference design
- Last updated: 2026-11-23
- Related physics: [harmonic RF antenna CPW](0952-harmonic-rf-antenna-cpw.md)

(fullwave-fit-problem-statement)=
## 1. Problem statement

Compute complex electric and magnetic near fields of a driven antenna from a
finite-volume material description. The first reference problem is straight
CPW1/2 at 22.12 GHz in the geometry of Gruszecki et al. Compare FIT with the
existing tetrahedral full-wave FEM under the same materials, axial length,
enclosure, electrical circuit, physical probe coordinates and normalization.
The paper reports CST FIT. Port, termination, enclosure details, mesh,
materials omitted from its description, monitor settings and normalization
must remain explicit reconstruction uncertainties.

(fullwave-fit-governing-equations)=
## 2. Physical model and units

Use peak phasors and time convention exp(+iωt). A primal edge voltage e is a
line integral of E in V. A primal face flux b is the integral of B in Wb.
Dual-face integrals of displacement d and current j have units C and A.
Dual-edge magnetic circulations h have units A. Angular frequency ω is in
rad/s. E, H, B and J are in V/m, A/m, T and A/m², respectively.
Permittivity ε, permeability μ and conductivity σ have units F/m, H/m and S/m.
The paper benchmark uses σ(Cu) = 5.88 × 10⁷ S/m as reported. The separate
gold sensitivity case defaults to σ(Au) = 1/(2.44 × 10⁻⁸ Ω·m), a nominal
bulk specimen value at room temperature. An explicit finite positive
conductivity overrides either value. A comparison with a fabricated thin
film needs its measured or justified conductivity and actual stack. If a
continuous layer of measured thickness t has uniform sheet resistance
R□, using σ = 1/(R□ t) is an explicit material-model choice. A gold run
records independent provenance and has no claim to match the copper CST case.

With oriented primal node-edge G, edge-face C and face-cell S incidence,
```{math}
:label: eq-fit-maxwell
Ce = -i\omega b,\qquad C^\mathsf{T}h = j + i\omega d,\qquad CG = 0,\qquad SC = 0.
```

The incidence identities are independent of metric and material. The
constitutive matrices use reluctivity ν = 1/μ.

```{math}
:label: eq-fit-metrics
d=M_\varepsilon e,\qquad j=M_\sigma e,\qquad h=M_\nu b.
```

Eliminating b gives

```{math}
:label: eq-fit-wave-operator
\big(C^\mathsf{T} M_\nu C + i\omega M_\sigma - \omega^2 M_\varepsilon\big)e = 0.
```

in the field interior. An impressed dual-face current jₐ on the right-hand
side of Ampère would give −iωjₐ on the right-hand side of this second-order
system. Terminal reactions use Mσ + iωMε and current positive into the field
domain. In each conductor cell, reconstruct J from its local σ and E.
Report conduction and displacement currents separately where applicable.


(fullwave-fit-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $e$ | Primal edge voltage | $\mathrm{V}$ |
| $b$ | Primal face magnetic flux | $\mathrm{Wb}$ |
| $d$ | Dual-face electric displacement integral | $\mathrm{C}$ |
| $j$ | Dual-face electric current integral | $\mathrm{A}$ |
| $h$ | Dual-edge magnetic circulation | $\mathrm{A}$ |
| $\omega$ | Angular frequency | $\mathrm{rad\,s^{-1}}$ |
| $i$ | Imaginary unit | $1$ |
| $G$ | Node-to-edge incidence matrix | $1$ |
| $C$ | Edge-to-face incidence matrix | $1$ |
| $S$ | Face-to-cell incidence matrix | $1$ |
| $M_\varepsilon$ | Permittivity metric | $\mathrm{F}$ |
| $M_\sigma$ | Conductivity metric | $\mathrm{S}$ |
| $M_\nu$ | Reluctivity metric | $\mathrm{H^{-1}}$ |

(fullwave-fit-discrete-realization)=
## 3. Discretization and backend

The CPU double-precision reference uses orthogonal, nonuniform hexahedra.
Conductor and dielectric interfaces align with coordinate planes. For an edge,
sum the four adjacent half-cell dual areas times ε or σ and divide by the
primal edge length. Each contribution is one quarter of the transverse
cell-face area, with only in-domain contributions on the boundary. For a
face, sum adjacent half-cell dual lengths times ν and divide by the primal
face area. All coefficients are isotropic and cellwise constant. Store
incidence separately from material matrices.

Reuse the FEM reference's electric circuit element terminal partition. An
oriented rectangular boundary is triangulated only for terminal topology
validation, using virtual diagonals that do not enter any FIT field operator.
Externally tangential voltage is a discrete scalar gradient, which implies
zero normal magnetic flux. Nonterminal boundary potentials float as in the
existing FEM comparison. The tied GSG return with a passive load is the
default comparison. This enclosure is a controlled boundary condition with
its own provenance. A waveguide eigenmode port and open boundaries require
their own qualification.

(fullwave-fit-implementation-mapping)=
### Frequency-domain implementation

Use a cotree on the primal graph with all boundary nodes contracted. Write
the field as a sparse curl-carrying cotree part minus a nodal gradient that
includes the terminal and interior potentials. Form the curl operator only on
the cotree part so gradient cancellation is exact, then apply symmetric row
scaling before solving the complex sparse system. The nodal circuit stamp is
iω times its admittance matrix. This decomposition preserves inductive and
displacement terms. The frequency-domain solve avoids the explicit CFL step
that would result from nanometre copper cells.

Reconstruct each E component by the transverse bilinear interpolation of
parallel edge voltage divided by their length. Reconstruct each B component
by interpolation along its normal between its two face flux densities.
Evaluate H using the selected cell's μ. Exact coordinate ties use an explicit
positive-axis convention. Report one-sided sensitivity at interfaces and
cuts on internal grid faces. Use independent FEM sampling on the same
physical coordinates. A solver cost study is required before using sparse LU
on large grids.

Micromagnetic FDM and FEM consume the projected complex H basis; their mesh
and solver remain independent of the EM discretization. A hybrid run must
record both grids, the projection error, the reference current and both
quadratures. No GPU FIT implementation or browser execution capability is
implied by this CPU reference.

(fullwave-fit-python-api)=
## 4. API, runtime and provenance

The CPU reference has a research CLI and internal Python interface. From
the repository root, the following constructs a vacuum grid and checks its
incidence identities without solving a driven field.

```python
# %%
import sys
from pathlib import Path

sys.path.insert(0, str(Path("scripts").resolve()))
from rf_fit_reference import assemble

axes_m = ([0.0, 1e-3],) * 3
fit = assemble(axes_m, conductivity_spm=0.0, relative_permittivity=1.0, frequency_hz=1e9)

# %%
assert (fit.curl @ fit.gradient).nnz == 0
assert (fit.divergence @ fit.curl).nnz == 0
```

The reference launches from a research CLI and writes field arrays, probe
coordinates, material and circuit configuration, terminal reactions, power
and residuals. Record the solver family and backend, equation convention,
grid and input hashes, active boundary model, coordinate tie convention and
the actual complex current used for normalization.

(fullwave-fit-problem-ir)=
### Proposed native ProblemIR contract

A qualified native realization should use the single antenna field stage
described in 0952. The Python DSL should author physical geometry, materials,
port assignments, frequency, monitor and termination. ProblemIR should keep
that physical intent. A typed discretization and device selection resolves
the FIT execution path independently from micromagnetic FDM/FEM. Initially
only a qualified CPU FP64 path should be exposed. No implicit fallback.
The planner checks supported boundary models, connectivity, material domains
and positive frequency. The runtime publishes stage completion and the
accepted complex H and J with numerical provenance.

(fullwave-fit-round-trip-and-failure-semantics)=
### Round-trip and failure semantics

The reference records requested intent and resolved execution in its run
configuration. Invalid axes, material values and frequencies raise
validation errors. Unsupported combinations remain explicit in the reference limits.

Native integration will expose capabilities and measurements via the existing
resource-first v2 session artifacts, mesh and field catalogs. Heavy vectors
use binary transport. The unified workspace gains an EM mesh and result
representation through the same adapter and generated client. UI-authored
port, frequency and execution intent must round-trip to the Python DSL. The
reference phase has no public contract changes.

(fullwave-fit-validation)=
## 5. Validation

1. Verify CG and SC exactly and test geometric weights in uniform media and
   with an aligned dielectric interface.
2. Verify a discrete PEC cavity mode against the closed-form grid eigenvalue,
   then verify driven circuit closure, passive power and the actual sampled
   field with phase-preserving tolerances. Require a reduced residual below
   1e−5 and report the achieved value and terminal residual.
3. Run FIT and Maxwell FEM with fixed CPW geometry, volume copper, common
   enclosure and local GSG termination. Compare signed Hᵧ, both E and H
   quadratures, branch current, integrated gap-side return, full spatial
   spectrum and position and depth of the CPW2 minimum. Run independent
   transverse/vertical and axial refinement. To isolate the near-edge
   effect, bisect only the existing y intervals in the first 20 nm on
   either side of each gap-facing conductor edge, and the z intervals
   between −10 and +10 nm. Preserve the explicit metal, dielectric and
   port boundaries and the original x grid. Compare denser readout on the
   same solved field before attributing a profile change to the mesh.
   Publish signed field comparisons
   against the digitized final-paper CST traces on common grids. Distinguish
   native Fullmag, reference FIT, reference FEM, published CST, and any
   analytical controls. The archived paper plots are simulation references.
4. Qualify the EM monitor and terminal readback with closed current and
   energy balance. Use a common extracted mode, physical grid, current
   convention and independently known S-parameters for a modal-port case.
5. Compare CST-like waveguide ports and open/truncated enclosure variants
   one at a time. Use suitable conformal material metrics for tapered edges
   and mesh refinement before moving to Figures 4–6.

## 6. Reference and product checklist

- [ ] FIT incidence, material metric, full-wave solve and probe reconstruction
- [ ] Same-input FIT/FEM CPW benchmark on both waveguides and refinement
- [ ] Waveguide modes, open boundaries and conformal interface qualification
- [ ] Native execution, Python/ProblemIR, planner, API, UI and regression tests
- [ ] CST input provenance and independent comparison of absolute amplitudes

(fullwave-fit-assumptions-and-validity)=
(fullwave-fit-limitations)=
## 7. Limits and deferred work

Initial support is restricted to orthogonal Cartesian, aligned materials and
a single connected box. Modal ports, PML and conformal/sloped boundaries,
anisotropy, dispersion, surface-impedance approximations and two-way magnetic
coupling are separate validation stages. CST's additional algorithms and
configuration choices affect its numerical result. Using FIT removes one
methodological difference in the controlled benchmark.

(fullwave-fit-scientific-bibliography)=
## 8. References

- Clemens and Weiland, *Discrete Electromagnetism with the Finite Integration
  Technique*, 2001. [DOI](https://doi.org/10.2528/PIER00080103).
- Gruszecki et al., *Microwave excitation of spin wave beams in thin
  ferromagnetic films*, 2016. [DOI](https://doi.org/10.1038/srep22367).
- Dassault Systèmes, [CST solvers and discretizations](https://www.3ds.com/products/simulia/cst-studio-suite/electromagnetic-simulation-solvers).
- NIST, [Gold specimen data, table 64](https://srd.nist.gov/JPCRD/jpcrdS1Vol3.pdf).
- Luhmann et al., [Electrical properties of ultrathin gold films](https://doi.org/10.1038/s41467-020-15762-3).

### Independent codebases for comparison

| Project | Use in Fullmag validation |
| --- | --- |
| [Magnelio](https://github.com/brtkrtz/magnelio) | FIT-TD on a nonuniform hexahedral mesh. Study conformal material integration, modal ports, transparent termination and S-parameter tests. Its time stepping and reported surface models need separate qualification for a 10 nm conducting film. |
| [Wakis](https://github.com/ImpedanCEI/Wakis) | Second FIT-TD reference for incidence, material matrices, material losses and boundary-condition tests. Its primary application is accelerator wakefields. |
| [openEMS](https://github.com/thliebig/openEMS) | Independent EC-FDTD microwave observables and localized port controls. Useful for mesh grading and measuring reflected fields. |
| [MaxwellFDFD](https://github.com/wsshin/maxwellfdfd) and [SPINS-B](https://github.com/stanfordnqp/spins-b/blob/master/spins/fdfd_solvers/waveguide_mode.py) | Structured frequency-domain magnetic field, lossy transverse modes, modal normalization and absorbing-boundary controls. |

Use these repositories as independent method and test references, alongside
the original FIT equations and existing Palace FEM runs.

(0953-fullwave-fit-antenna-source-code-index)=
## Source-code index

| Repository path | Symbol | Role |
| --- | --- | --- |
| scripts/rf_fit_reference.py | _topology | Build the oriented primal incidences. |
| scripts/rf_fit_reference.py | _material_weights | Apply the dual-volume permittivity, conductivity and reluctivity measures. |
| scripts/rf_fit_reference.py | assemble | Validate the orthogonal grid, material values and harmonic frequency. |
| scripts/rf_fit_reference.py | solve_ece | Solve the frequency-domain cotree system with the CPW circuit boundary. |
| scripts/rf_fit_reference.py | sample | Recover electric and magnetic components from the edge and face integrals. |
| scripts/test_rf_fit_reference.py | test_driven_ece_current_balance_and_local_passive_load | Check the driven circuit, terminal currents and power balance. |
| scripts/test_rf_fit_reference.py | test_tangential_pec_cavity_discrete_eigenmode | Check the operator against a discrete cavity eigenmode. |
| scripts/run_rf_fit_cpw.py | solve | Record the solved benchmark and configuration with the field readout. |
