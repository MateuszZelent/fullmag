---
title: Oersted field
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-oersted-field-root)=
# Oersted field

Fullmag exposes two physically and numerically distinct Oersted-field families:

1. `OerstedCylinder`: an analytic infinite cylindrical conductor with prescribed current.
2. `OerstedField(source=...)`: a field derived from a named `CurrentTransport` source—either a
   prescribed current density lowered onto a conductor geometry or a solved steady/coupled charge
   transport field with an explicit circuit-closure contract.

They are distinct physical models with distinct planner resolutions and capability boundaries and
must not share one undifferentiated capability status.

(physics-oersted-field-problem-statement)=
## Physical problem

The Oersted interaction computes the magnetostatic field induced by prescribed or solved electrical
current densities and adds it to $\mathbf{H}_{\mathrm{eff}}$ without double-counting ferromagnetic
demagnetization.

```{figure} /_static/diagrams/oersted-cylinder-and-biot-savart.svg
:alt: Two-panel diagram comparing Fullmag's two Oersted-field families: Panel (a) shows OerstedCylinder right-hand-rule geometry and the exact piecewise radial profile H_oe(rho) peaking at rho = R; Panel (b) traces OerstedField(source=...) from CurrentTransport and circuit closure through Biot-Savart (OE-F1) and H(curl) vector potential (OE-F2) realizations with lane-specific capability boundaries.
:width: 100%
:name: fig-oersted-cylinder-and-biot-savart
:figclass: fm-physics-figure

Analytic cylindrical wire versus current-source Oersted field realizations in Fullmag. Panel (a)
shows the `OerstedCylinder` infinite-conductor geometry and exact piecewise radial profile
$H_{\mathrm{oe}}(\rho)$, peaking at $\rho=R$ with value $I/(2\pi R)$. Panel (b) maps the
`OerstedField(source=...)` pipeline from conservative $\nabla\cdot\mathbf J_c=0$ charge transport
and explicit circuit closure to direct Biot–Savart quadrature (`OE-F1`, compare Vansteenkiste *et al.*
2014) and compatible $H(\mathrm{curl})$ vector-potential solves (`OE-F2`, compare Hertel & Kákay
2014; Monk 2003).
```

(physics-oersted-field-governing-equations)=
## Governing equations

### Analytic cylindrical conductor

For signed current $I$ along unit axis $\hat{\mathbf a}$, let
$\boldsymbol\rho$ be the perpendicular displacement from the conductor axis,
$\rho=\lvert\boldsymbol\rho\rvert$, and
$\hat{\boldsymbol\phi}=\hat{\mathbf a}\times\boldsymbol\rho/\rho$. For a uniform
current density inside radius $R$,

```{math}
:label: eq-public-oersted-field-oersted-cylinder
\mathbf H_{\mathrm{oe}}(\rho)
=
\begin{cases}
\dfrac{I\rho}{2\pi R^2}\hat{\boldsymbol\phi}, & 0\le\rho<R,\\[6pt]
\dfrac{I}{2\pi\rho}\hat{\boldsymbol\phi}, & \rho\ge R.
\end{cases}
```

At $\rho=0$, the field is zero by continuity. The model assumes an infinitely long straight
conductor and does not include end effects or a return path.

### Current-source field

Charge transport supplies signed conventional current $\mathbf J_c$ satisfying continuity.
A direct Biot–Savart realization is

```{math}
:label: eq-public-oersted-field-oersted-biot-savart
\mathbf H_{\mathrm{oe}}(\mathbf x)
=
\frac{1}{4\pi}
\int_{\Omega_c}
\frac{
\mathbf J_c(\mathbf x')\times(\mathbf x-\mathbf x')}
{\lvert\mathbf x-\mathbf x'\rvert^3}
\,\mathrm dV'.
```

There is no $\mu_0$ in this expression for $\mathbf H$;
$\mathbf B_{\mathrm{oe}}=\mu_0\mathbf H_{\mathrm{oe}}$ in vacuum. On finite-difference grids,
discrete general-conductor Biot–Savart midpoint summation regularizes self-cell contributions using
the equivalent-sphere radius $a=(3V/(4\pi))^{1/3}$.

On finite-element meshes, Fullmag supports both direct tetrahedral Biot–Savart quadrature (`OE-F1`)
with analytical Duffy singular-pair integration and a compatible $H(\mathrm{curl})$ mixed
saddle-point vector-potential formulation (`OE-F2`):

```{math}
:label: eq-public-oersted-field-oersted-vector-potential
\nabla\times\left(\mu_0^{-1}\nabla\times\mathbf A\right) + \nabla p = \mathbf J_c,
\qquad
\nabla\cdot\mathbf A = 0,
\qquad
\mathbf H_{\mathrm{oe}} = \mu_0^{-1}\nabla\times\mathbf A .
```

Here $p\in H^1_0$ is the Coulomb-gauge Lagrange multiplier enforcing $\nabla\cdot\mathbf A=0$ in
weak form. Because a local two-electrode current bar is not automatically a globally closed source
for general Oersted evaluation, closure identity, mesh, orientation, revisions, and accepted
conservative current view (`OE-T0`, $\nabla\cdot\mathbf J_c=0$ in $H(\mathrm{div})$ RT0 space) are
part of the physical contract.

(physics-oersted-field-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $I$ | signed conductor current | $\mathrm{A}$ |
| $R$ | analytic cylinder radius | $\mathrm{m}$ |
| $\rho$ | distance from the cylinder axis | $\mathrm{m}$ |
| $\mathbf J_c$ | conventional current-density field | $\mathrm{A\,m^{-2}}$ |
| $\mathbf H_{\mathrm{oe}}$ | Oersted magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_{\mathrm{oe}}$ | Oersted flux density | $\mathrm{T}$ |
| $\mathbf A$ | magnetic vector potential | $\mathrm{T\,m}$ |
| $p$ | Coulomb-gauge saddle-point multiplier | $\mathrm{A\,m^{-1}}$ |
| $\Omega_c$ | conducting domain | $\mathrm{m^3}$ |
| $\mathrm dV'$ | source volume measure | $\mathrm{m^3}$ |

(physics-oersted-field-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability
limits stated on this page. `OerstedCylinder` neglects finite wire length and return leads.
`OerstedField(source=...)` binds to a named `CurrentTransport` source:

- **FDM prescribed-density lowering**: `resolve_fdm_oersted_term` in
  `crates/fullmag-plan/src/oersted.rs` lowers a `prescribed_density` `CurrentTransport` on a
  cylindrical `solve_region` to `ResolvedOerstedTerm::Cylinder` (`InfiniteCylinder`, axial
  $I = J_\parallel \pi R^2$) and lowers a non-cylindrical `solve_region` with a static envelope to
  `ResolvedOerstedTerm::Field` (`BiotSavartMidpoint`, capped at `4096` active source cells).
- **FDM solved-current coupling**: `resolve_solved_current_source` lowers an `OhmicPoisson`
  (`one_way`) or `MagnetoresistivePoisson` (`bidirectional`) `CurrentTransport` coupled to
  `SpinDriftDiffusion` into `ResolvedOerstedTerm::SolvedCurrent` (`BiotSavartMidpoint`), evaluated
  from the runtime-solved current density (including dynamic stages on FDM).
- **FEM solved-current contract**: `resolve_fem_oersted_term` requires a conservative
  ($\nabla\cdot\mathbf J_c=0$) RT0 current projection (`TerminalConstrainedRt0Projection`, `OE-T0`)
  and explicit circuit closure (`ConservativeCurrentView`, `StructuredCurrentClosure`, or
  `ExternalLeadCurrentSource`), restricted to steady spin-transport or charge-only FEM modes.
- **Separation from RF/FIT antennas**: Broadband or sinc-pulse spin-wave antenna excitations use
  `prescribed_zeeman_mask` / `RegionalFieldDrive` / `MaskAntenna` contracts rather than Oersted
  terms. Fullmag accepts at most one executable Oersted energy term per study.

(physics-oersted-field-discrete-realization)=
## Capability matrices and solver performance

### Analytic cylinder (`OerstedCylinder`)

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `OerstedCylinder` | implemented reference path | analytic radial-profile tests | prescribed infinite cylinder; `Constant`, `Sinusoidal`, `Pulse` envelopes |
| FDM | GPU | `OerstedCylinder` | implemented CUDA path | precision-specific device parity | precomputed $+z$ axis cylinder with `Constant` envelope only; general axes/envelopes fail closed |
| FEM | CPU | `OerstedCylinder` | implemented (`initialize_oersted_cylinder_field`) | mesh sampling and trajectory tests | analytic field sampled at FEM nodal locations with time-envelope scaling |
| FEM | GPU | `OerstedCylinder` | implemented (`fullmag_cuda_add_scaled_field_inplace`) | executed-device parity required | device-resident scaled field fused into `H_eff` on the GPU RK path |

### Named current source (`OerstedField(source=...)`)

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `OerstedField(source)` + `CurrentTransport` | implemented bounded path (`resolve_fdm_oersted_term`) | cylinder lowering, midpoint Biot–Savart, and solved-current coupling tests | cylindrical `prescribed_density` -> `InfiniteCylinder`; general `prescribed_density` -> static `BiotSavartMidpoint` ($\le 4096$ source cells); `OhmicPoisson`/`MagnetoresistivePoisson` + `SpinDriftDiffusion` -> `SolvedCurrent` `BiotSavartMidpoint` |
| FDM | GPU | same canonical IR | partial (lowered cylinder / precomputed static field) | executed-device parity required | inherits CUDA `+z`/static constraints for cylinder lowering; general dynamic solved-current CUDA Oersted remains bounded |
| FEM | CPU | `OerstedField(source)` + closure contract | implemented bounded path (`OE-T0`, `OE-F1`, `OE-F2`) | Biot–Savart quadrature, RT0 divergence, and $H(\mathrm{curl})$ saddle-point parity suites | `OE-F1` (`DirectTetraQuadrature`): deterministic `std::thread` parallel CPU (`13.53x` at 16 threads, 0-ULP); `OE-F2` (`VectorPotentialSolver`): sparse equilibrated `SparseLinearSolver` (`petsc_mumps_lu_metis` `105.5x`, `hypre_ams_boomeramg_minres` `68.3x`, IR caps `2,000,000` ND / `1,000,000` H1 DOFs); steady transport or charge-only |
| FEM | GPU | same canonical IR | partial (`OE-F1` opt-in `GpuHybridFarField` + device field scaling) | far-field 106-bit double-double accuracy (`max_rel_err = 5.59e-17`) | `OE-F1` CUDA hybrid far-field (`18.93x` with CPU Duffy singular pairs); full device-resident `OE-F2` assembly/solve is not yet a standalone strict GPU lane |

For the full benchmark methodology, sparse equilibrated saddle-point scaling (up to `68,921` DOFs
at `362–802 MiB` RSS versus ~`38 GiB` dense, residual $\le 10^{-13}$), `OE-T0` conservative RT0 KKT
residuals ($\le 1.84\times 10^{-14}$), and `OE-F1` hybrid far-field timings, see
{ref}`numerical-methods-performance-fem-spectral-multiphysics` and
{ref}`numerical-methods-performance-fem-gpu-kernels`.

(physics-oersted-field-python-api)=
## Python API and stage-first example

### Public API parameters

| Python API | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR field |
|---|---|---|---|---|---|---|---|
| `fm.OerstedCylinder.current` | `float` | required | $\mathrm{A}$ | finite float at IR/planner boundary | signed axial conductor current $I$ | FDM CPU/GPU, FEM CPU/GPU | `energy_terms[].current` |
| `fm.OerstedCylinder.radius` | `float` | required | $\mathrm{m}$ | strictly positive finite float at IR/planner boundary | conductor cylinder radius $R$ | FDM CPU/GPU, FEM CPU/GPU | `energy_terms[].radius` |
| `fm.OerstedCylinder.center` | `Sequence[float]` | `(0.0, 0.0, 0.0)` | $\mathrm{m}$ | 3-vector float conversion; finite at IR boundary | reference point on the cylinder axis | FDM CPU/GPU, FEM CPU/GPU | `energy_terms[].center` |
| `fm.OerstedCylinder.axis` | `Sequence[float]` | `(0.0, 0.0, 1.0)` | $1$ | non-zero 3-vector normalized at planner boundary | unit cylinder axis $\hat{\mathbf a}$ (`+z` required on FDM CUDA) | FDM CPU/GPU (`+z`), FEM CPU/GPU | `energy_terms[].axis` |
| `fm.OerstedCylinder.time_dependence` | `TimeDependence \| None` | `None` | — | optional `Constant`, `Sinusoidal`, or `Pulse` envelope | scalar envelope multiplying $\mathbf H_{\mathrm{oe}}$ (`Constant` only on FDM CUDA) | FDM CPU, FDM GPU (`Constant`), FEM CPU/GPU | `energy_terms[].time_dependence` |
| `fm.OerstedCylinder.id` | `str` | `"oersted:cylinder"` | — | non-empty stable identifier | stable energy-term identifier for provenance and observables | FDM CPU/GPU, FEM CPU/GPU | `energy_terms[].id` |
| `fm.OerstedField.source` | `str` | required | — | non-empty named `CurrentTransport` reference | named current-transport source driving $\mathbf H_{\mathrm{oe}}$ | FDM CPU/GPU (bounded), FEM CPU (`OE-F1`/`OE-F2`), FEM GPU (partial) | `energy_terms[].source` |
| `fm.OerstedField.model` | `str` | `"from_current_solution"` | — | canonical enum checked at IR/planner boundary | current-derived Oersted model selector | FDM CPU/GPU (bounded), FEM CPU, FEM GPU (partial) | `energy_terms[].model` |
| `fm.OerstedField.id` | `str \| None` | `None` | — | defaults to `f"oersted:{source}"` when omitted | stable energy-term identifier | FDM CPU/GPU (bounded), FEM CPU, FEM GPU (partial) | `energy_terms[].id` |

### Stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("oersted_cylinder_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Prescribed cylindrical Oersted field and time-evolution stage
study.exchange()
study.oersted(fm.OerstedCylinder(current=5.0e-3, radius=20 * nm, axis=(0.0, 0.0, 1.0)))
study.stages.add_run(stage_id="sample", until=1.0e-12)
```

For exact constructor arguments and type validation on `fm.OerstedField` and
`fm.CurrentTransport`, see {doc}`/python-api/interactions/oersted-field` and
{doc}`/python-api/current-and-excitations/current-transport`.

(physics-oersted-field-problem-ir)=
## ProblemIR

The analytic and current-source families serialize as distinct tagged records in `energy_terms`:

```json
{
  "kind": "oersted_cylinder",
  "id": "oersted:cylinder",
  "current": 0.005,
  "radius": 2e-08,
  "center": [0.0, 0.0, 0.0],
  "axis": [0.0, 0.0, 1.0]
}
```

```json
{
  "kind": "oersted_field",
  "id": "oersted:drive_current",
  "model": "from_current_solution",
  "source": "drive_current"
}
```

Resolved method (`InfiniteCylinder`, `BiotSavartMidpoint`, or `FemVectorPotential`), closure
identity, current-view revision SHA-256 digest, solver, device, precision, and mesh belong to
planner and runtime provenance.

(physics-oersted-field-validation)=
## Validation boundary

`OerstedCylinder` converts `current`, `center`, and `axis` at construction, while finite-value,
positive-radius, non-zero axis, and unit-axis normalization checks are enforced downstream at the
`ProblemIR` and planner boundary. `OerstedField` exposes no public `OE-F1`/`OE-F2` `method`
parameter; `resolve_fdm_oersted_term` and `resolve_fem_oersted_term` in
`crates/fullmag-plan/src/oersted.rs` select between `InfiniteCylinder`, `BiotSavartMidpoint`,
and `FemVectorPotential` during resolution and record the choice in execution provenance.

## Required numerical validation

- analytic radial profile inside/outside the cylinder and continuity at $R$;
- right-hand-rule sign under current and axis reversal;
- zero field on the axis;
- direct-current scaling and envelope timing;
- Biot–Savart comparison with analytic wire/loop geometries (`OE-F1` CPU and CUDA 106-bit double-double hybrid far-field parity);
- current-balance and circuit-closure residuals (`OE-T0` $\max\lvert\nabla\cdot\mathbf J_c\rvert \le 4.79\times 10^{-16}$);
- `OE-F2` sparse equilibrated saddle-point accuracy (`petsc_mumps_lu_metis` and `hypre_ams_boomeramg_minres`) and airbox/mesh convergence;
- $\nabla\cdot\mathbf B=0$ and compatible projection checks;
- strict rejection of stale current identity, cell-count overflow ($>4096$ cells on general FDM prescribed Biot–Savart), and unsupported GPU requests.

(physics-oersted-field-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored `oersted_cylinder` or `oersted_field` variant, signed
current or named transport source, geometry center/axis, time envelope, stable `id`, and execution
request. Resolved execution records the selected Oersted realization (`InfiniteCylinder`,
`BiotSavartMidpoint`, or `FemVectorPotential`), current-solution SHA-256 identity, solver, device,
precision, and capability decision. Validation errors reject multiple Oersted terms, empty or
missing transport sources, non-positive radius, zero axis vectors, and non-finite inputs before
runtime. Unsupported combinations (such as non-`+z` or time-dependent `OerstedCylinder` on FDM
CUDA, general FDM prescribed Biot–Savart exceeding `4096` source cells, non-steady FEM transport
without a bound charge-only source, standalone strict FEM GPU `OE-F2`, or stale current-view
digests) fail closed and are never silently omitted or replaced with another field source.

(physics-oersted-field-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization (`packages/fullmag-py/src/fullmag/model/energy.py`,
`packages/fullmag-py/src/fullmag/model/current_transport.py`,
`packages/fullmag-py/src/fullmag/world.py`), `ProblemIR` owns canonical intent and DOF caps
(`crates/fullmag-ir/src/antenna.rs`, `crates/fullmag-ir/src/study.rs`),
`crates/fullmag-plan/src/oersted.rs` owns FDM/FEM legality, source resolution, and midpoint or
cylinder lowering, and native FEM/FDM CPU/CUDA runners own RT0 projection (`OE-T0`), parallel and
hybrid-GPU tetrahedral Biot–Savart quadrature (`OE-F1`), sparse equilibrated $H(\mathrm{curl})$
vector-potential solves (`OE-F2`), and runtime field scaling. Control Room exposure for Oersted
interactions is tracked in {doc}`/frontend/capability-register`; parameters without a UI control
are configured in Python.

(physics-oersted-field-limitations)=
## Limitations

General FDM prescribed-density Biot–Savart evaluation is bounded to static envelopes and at most
`4096` active source cells. FEM solved-current evaluation (`OerstedField(source=...)`) requires an
explicit conservative RT0 circuit closure and steady or charge-only transport; while `OE-F1`
supports opt-in `GpuHybridFarField` CUDA acceleration and `OE-F2` scales to `2,000,000` ND /
`1,000,000` H1 DOFs via sparse MUMPS or Hypre AMS/BoomerAMG MINRES, full device-resident FEM GPU
`OE-F2` assembly/solve and unclosed external-lead extensions are not yet supported in strict
runtime.

(physics-oersted-field-scientific-bibliography)=
## Scientific bibliography

1. R. Hertel and A. Kákay, "Hybrid finite-element/boundary-element method to calculate Oersted
   fields," *Journal of Magnetism and Magnetic Materials* **369**, 189–196 (2014),
   [doi:10.1016/j.jmmm.2014.06.047](https://doi.org/10.1016/j.jmmm.2014.06.047)
   ([arXiv:0804.4010 OA](https://arxiv.org/abs/0804.4010)).
2. J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley, 1998.
3. P. Monk, *Finite Element Methods for Maxwell's Equations*, Oxford University Press, 2003.
4. A. Vansteenkiste, J. Leliaert, M. Dvornik, F. Garcia-Sanchez, and B. Van Waeyenberge, "The
   design and verification of MuMax3," *AIP Advances* **4**(10), 107133 (2014),
   [doi:10.1063/1.4899186](https://doi.org/10.1063/1.4899186)
   (CC-BY OA, [arXiv:1406.7635](https://arxiv.org/abs/1406.7635)).

(physics-oersted-field-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L384) | `class OerstedCylinder` | analytic cylindrical conductor constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L444) | `class OerstedField` | named current-source Oersted constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/current_transport.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/current_transport.py#L1467) | `class CurrentTransport` | prescribed-density and solved charge-transport source with closure contracts |
| [`crates/fullmag-ir/src/antenna.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/antenna.rs#L60) | `ANTENNA_VECTOR_POTENTIAL_MAX_ND_DOFS` | canonical ND DOF ceiling (`2,000,000`) for sparse `OE-F2` vector-potential solves |
| [`crates/fullmag-ir/src/antenna.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/antenna.rs#L61) | `ANTENNA_VECTOR_POTENTIAL_MAX_H1_DOFS` | canonical H1 gauge-multiplier DOF ceiling (`1,000,000`) for sparse `OE-F2` solves |
| [`crates/fullmag-plan/src/oersted.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/oersted.rs#L142) | `resolve_fdm_oersted_term` | FDM cylinder lowering, static midpoint Biot–Savart, and solved-current coupling resolution |
| [`crates/fullmag-plan/src/oersted.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/oersted.rs#L83) | `resolve_fem_oersted_term` | FEM Oersted capability validation and `OE-F1`/`OE-F2` realization selection |
| [`crates/fullmag-plan/src/oersted.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/oersted.rs#L233) | `resolve_solved_current_source` | `OhmicPoisson` / `MagnetoresistivePoisson` solved-current source binding |
| [`backends/fem/cpu/mfem/interactions/oersted_cylinder.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/oersted_cylinder.cpp#L45) | `initialize_oersted_cylinder_field` | FEM CPU analytic cylindrical conductor nodal evaluation |
| [`backends/fem/cpu/mfem/transport/terminal_constrained_rt0_projection.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/transport/terminal_constrained_rt0_projection.hpp#L69) | `class TerminalConstrainedRt0Projection` | `OE-T0` conservative RT0 KKT current projection ($\nabla\cdot\mathbf J_c=0$) |
| [`backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/oersted/direct_tetra_quadrature.hpp#L75) | `class DirectTetraQuadrature` | `OE-F1` multi-threaded CPU and hybrid-GPU tetrahedral Biot–Savart evaluator |
| [`backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/oersted/vector_potential.hpp#L64) | `class VectorPotentialSolver` | `OE-F2` $H(\mathrm{curl})\times H^1_0$ sparse equilibrated vector-potential solver |
| [`backends/fem/cpu/mfem/common/sparse_linear_solver.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/common/sparse_linear_solver.hpp#L59) | `class SparseLinearSolver` | shared sparse direct (MUMPS) and preconditioned iterative (Hypre AMS/BoomerAMG) solver |
| [`backends/fem/cpu/mfem/common/sparse_linear_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/common/sparse_linear_solver.cpp#L2048) | `compute_saddle_point_equilibration_beta` | saddle-point block scaling balancing $H(\mathrm{curl})$ and $H^1_0$ blocks |
| [`backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/oersted/direct_tetra_farfield_kernels.cu#L545) | `fullmag_cuda_direct_tetra_evaluate_root_farfield` | `OE-F1` CUDA 106-bit double-double (`GpuHybridFarField`) far-field Biot–Savart kernel |
| [`backends/fem/gpu/cuda/interactions/oersted/oersted_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/oersted/oersted_kernels.cu#L37) | `fullmag_cuda_add_scaled_field_inplace` | FEM GPU time-envelope scaled Oersted field accumulation kernel |
