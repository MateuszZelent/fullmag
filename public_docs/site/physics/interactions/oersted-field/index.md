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

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

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

## Solved-current field

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

(physics-oersted-field-discrete-realization)=
## Capability matrices

### Analytic cylinder

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `OerstedCylinder` | implemented/reference path | analytic radial-profile tests required | prescribed infinite cylinder |
| FDM | GPU | `OerstedCylinder` | implemented where planner accepts | device parity required | precomputed profile plus time envelope |
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

study.exchange()
study.oersted(fm.OerstedCylinder(current=5.0e-3, radius=20 * nm, axis=(0.0, 0.0, 1.0)))
study.stages.add_run(stage_id="sample", until=1.0e-12)
```

### Analytic object

The analytic constructor is simple and independently testable. Registration into a stage must use
the actual study interaction hook supported by the selected planner. Do not present an unregistered
local variable as active physics.

### Solved-current binding

A complete runnable solved-current example additionally needs a valid `CurrentTransport`, a
conservative accepted current view, and a closed-geometry or external-lead circuit. That advanced
closure example belongs on a dedicated child page or tested fixture, not as a 90-kilobyte primary
introduction.

(physics-oersted-field-problem-ir)=
## ProblemIR

The analytic and solved-current families use distinct tagged records. The minimal canonical
fragments are shown in the Python section above; resolved method, closure identity, current-view
revision, solver, device, precision, and mesh belong to planner/runtime provenance.

(physics-oersted-field-validation)=
## Validation boundary and required code corrections

`OerstedCylinder` currently converts `current`, `center`, and `axis` without complete finite,
non-zero, or unit-axis validation at construction. Harden the constructor: current must be finite,
radius finite and positive, center finite, and axis finite/non-zero then normalized once.

`OerstedField` has no public OE-F1/OE-F2 `method` parameter. Documentation must not imply that the
user selected a method when the planner selected it internally. Source maps referring to
worktree-uncommitted tests or an older immutable commit must be regenerated for the audited
revision.

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

(physics-oersted-field-limitations)=
## Limitations and recommended split

Create separate pages:
`analytic-cylinder.md`, `solved-current.md`, `external-lead-closure.md`, and
`vector-potential.md`. The root should compare them and expose the capability matrix. Do not mark
the family globally `implemented` while the solved-current public path is mainly semantic/bounded.

(physics-oersted-field-scientific-bibliography)=
## Scientific bibliography

1. J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley, 1998.
2. P. Monk, *Finite Element Methods for Maxwell's Equations*, Oxford University Press, 2003.

(physics-oersted-field-source-code-index)=

## Control Room crosswalk

This is a navigation page; the selected interaction or foundation is configured by its linked Python API and object/stage editor. The category itself has no standalone control. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-oersted-field-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(physics-oersted-field-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `OerstedCylinder, OerstedField` | two public model families |
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `CurrentTransport and ConservativeCurrentView` | solved-current source and closure |
| `crates/fullmag-plan/src/oersted.rs` | `Oersted planning` | source resolution and fail-closed capability |
| `crates/fullmag-runner/src/native_fem/steady_transport.rs` | `RT0 current view` | accepted conservative source |
| `backends/fem/cpu` | `OE-F1/OE-F2` | bounded FEM CPU realizations |
| `backends/fdm/gpu/cuda/interactions` | `analytic Oersted branches` | prescribed-cylinder realization |

(physics-oersted-field-round-trip-and-failure-semantics)=
