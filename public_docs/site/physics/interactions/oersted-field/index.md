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
2. `OerstedField(source=...)`: a field derived from a named solved current transport with an
   explicit circuit-closure contract.

They must not share one undifferentiated capability status.

(physics-oersted-field-problem-statement)=
## Physical problem

The Oersted interaction computes the magnetostatic field induced by prescribed or solved steady
electrical current densities and adds it to $\mathbf{H}_{\mathrm{eff}}$ without double-counting
ferromagnetic demagnetization.

```{figure} /_static/diagrams/oersted-cylinder-and-biot-savart.svg
:alt: Two-panel diagram comparing Fullmag's two Oersted-field families: Panel (a) shows OerstedCylinder right-hand-rule geometry and the exact piecewise radial profile H_oe(rho) peaking at rho = R; Panel (b) traces OerstedField(source=...) from CurrentTransport and circuit closure through Biot-Savart (OE-F1) and H(curl) vector potential (OE-F2) realizations with lane-specific capability boundaries.
:width: 100%
:name: fig-oersted-cylinder-and-biot-savart
:figclass: fm-physics-figure

Analytic cylindrical wire versus solved-current Oersted field realizations in Fullmag. Panel (a)
shows the `OerstedCylinder` infinite-conductor geometry and exact piecewise radial profile
$H_{\mathrm{oe}}(\rho)$, peaking at $\rho=R$ with value $I/(2\pi R)$. Panel (b) maps the
`OerstedField(source=...)` pipeline from conservative $\nabla\cdot\mathbf J_c=0$ charge transport
and explicit circuit closure to direct Biot–Savart quadrature (`OE-F1`, compare Vansteenkiste *et al.*
2014) and compatible $H(\mathrm{curl})$ vector-potential solves (`OE-F2`, compare Hertel & Kákay
2014; Monk 2003), contrasting bounded FEM CPU support against unsupported FDM solved-current lanes.
```

(physics-oersted-field-governing-equations)=
## Governing equations

### Analytic cylindrical conductor

For signed current $I$ along unit axis $\hat{\mathbf a}$, let
$\boldsymbol\rho$ be the perpendicular displacement from the conductor axis,
$\rho=|\boldsymbol\rho|$, and
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

### Solved-current field

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
{|\mathbf x-\mathbf x'|^3}
\,\mathrm dV'.
```

There is no $\mu_0$ in this expression for $\mathbf H$;
$\mathbf B_{\mathrm{oe}}=\mu_0\mathbf H_{\mathrm{oe}}$ in vacuum. A vector-potential
realization solves a compatible $H(\mathrm{curl})$ problem and computes
$\mathbf B=\nabla\times\mathbf A$.

A local two-electrode current bar is not automatically a globally closed source for general
Oersted evaluation. Closure identity, mesh, orientation, revisions, and accepted current view are
part of the physical contract.

(physics-oersted-field-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $I$ | signed conductor current | $\mathrm A$ |
| $R$ | analytic cylinder radius | $\mathrm m$ |
| $\rho$ | distance from the cylinder axis | $\mathrm m$ |
| $\mathbf J_c$ | conventional current-density field | $\mathrm{A\,m^{-2}}$ |
| $\mathbf H_{\mathrm{oe}}$ | Oersted magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf B_{\mathrm{oe}}$ | Oersted flux density | $\mathrm T$ |
| $\mathbf A$ | magnetic vector potential | $\mathrm{T\,m}$ |
| $\Omega_c$ | conducting domain | not applicable |
| $\mathrm dV'$ | source volume measure | $\mathrm{m^3}$ |

(physics-oersted-field-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability
limits stated on this page. `OerstedCylinder` neglects finite wire length and return leads, while
`OerstedField(source=...)` requires a conservative ($\nabla\cdot\mathbf J_c=0$) current solution
with explicit circuit closure (`ConservativeCurrentView`, `StructuredCurrentClosure`, or
`ExternalLeadCurrentSource`). Fullmag accepts at most one Oersted energy term per problem.

(physics-oersted-field-discrete-realization)=
## Capability matrices

### Analytic cylinder

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `OerstedCylinder` | implemented/reference path | analytic radial-profile tests required | prescribed infinite cylinder |
| FDM | GPU | `OerstedCylinder` | implemented where planner accepts | device parity required | precomputed $+z$ profile; `Constant` envelope only |
| FEM | CPU | `OerstedCylinder` | implemented bounded path | mesh sampling and trajectory tests required | analytic field evaluated at FEM locations |
| FEM | GPU | `OerstedCylinder` | lane-dependent/partial | executed-device evidence required | must not infer support from source only |

### Solved current

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `OerstedField(source)` IR | unsupported for canonical OE-F1/OE-F2 | none | current canonical operator is FEM-specific |
| FDM | GPU | same IR | unsupported | none | no qualified FDM solved-current operator |
| FEM | CPU | complete current/closure authoring | semantic-only with bounded executable slices | not production qualified | OE-F1/OE-F2 selection and convergence remain constrained |
| FEM | GPU | target vocabulary | unsupported/semantic-only | none | no qualified device-resident solved-current implementation |

(physics-oersted-field-python-api)=
## Python API and stage-first example

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

For exact constructor arguments and type validation on `fm.OerstedField`, see
{doc}`/python-api/interactions/oersted-field`.

### Analytic object

The analytic constructor is simple and independently testable. Registration into a stage must use
the actual study interaction hook supported by the selected planner. Do not present an unregistered
local variable as active physics.

### Solved-current binding

A complete runnable solved-current example additionally needs a valid `CurrentTransport`, a
conservative accepted current view, and a closed-geometry or external-lead circuit; those
constructs are documented in {doc}`/python-api/current-and-excitations/current-transport` and
{doc}`/python-api/interactions/oersted-field`.

(physics-oersted-field-problem-ir)=
## ProblemIR

The analytic and solved-current families serialize as distinct tagged records in `energy_terms`:

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
`ProblemIR` and planner boundary.

`OerstedField` exposes no public `OE-F1`/`OE-F2` `method` parameter; the planner selects between
`BiotSavartMidpoint` and `FemVectorPotential` during resolution and records the choice in execution
provenance.

## Required numerical validation

- analytic radial profile inside/outside the cylinder and continuity at $R$;
- right-hand-rule sign under current and axis reversal;
- zero field on the axis;
- direct-current scaling and envelope timing;
- Biot–Savart comparison with analytic wire/loop geometries;
- current-balance and circuit-closure residuals;
- OE-F1 quadrature and OE-F2 airbox/mesh convergence;
- $\nabla\cdot\mathbf B=0$ and compatible projection checks;
- strict rejection of stale current identity and unsupported GPU requests.

(physics-oersted-field-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored `oersted_cylinder` or `oersted_field` variant, signed
current or named transport source, geometry center/axis, time envelope, and execution request.
Resolved execution records the selected Oersted realization (`InfiniteCylinder`,
`BiotSavartMidpoint`, or `FemVectorPotential`), current-solution SHA-256 identity, solver, device,
precision, and capability decision. Validation errors reject multiple Oersted terms, empty or
missing transport sources, non-positive radius, zero axis vectors, and non-finite inputs before
runtime. Unsupported combinations (such as canonical OE-F1/OE-F2 on FDM or FEM GPU, non-`+z` or
time-dependent `OerstedCylinder` on FDM CUDA, or stale current-view digests) fail closed and are
never silently omitted or replaced with another field source.

(physics-oersted-field-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization (`packages/fullmag-py/src/fullmag/model/energy.py`,
`current_transport.py`, `world.py`), `ProblemIR` owns canonical intent, `crates/fullmag-plan/src/oersted.rs`
and backend planners own legality, realization selection, and midpoint lowering, and native FEM/FDM
CPU/CUDA runners own RT0 quadrature (`OE-F1`), $H(\mathrm{curl})$ solves (`OE-F2`), and runtime
field scaling. Control Room exposure for Oersted interactions is tracked in
{doc}`/frontend/capability-register`; parameters without a UI control are configured in Python.

(physics-oersted-field-limitations)=
## Limitations

Solved-current evaluation (`OerstedField(source=...)`) remains bounded to narrow FEM CPU regimes
(`OE-F1` Biot–Savart and `OE-F2` $H(\mathrm{curl})$ vector potential) requiring an explicit
conservative circuit closure. General FDM solved-current operators, FEM GPU solved-current
execution, and unclosed external-lead extensions are not supported in strict runtime.

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
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedCylinder`, `class OerstedField` | two public model families |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `CurrentTransport and ConservativeCurrentView` | solved-current source and closure |
| `crates/fullmag-plan/src/oersted.rs` | `Oersted planning` | source resolution and fail-closed capability |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `RT0 current view` | accepted conservative source |
| `backends/fem/cpu` | `OE-F1/OE-F2` | bounded FEM CPU realizations |
| `backends/fdm/gpu/cuda/interactions` | `analytic Oersted branches` | prescribed-cylinder realization |
