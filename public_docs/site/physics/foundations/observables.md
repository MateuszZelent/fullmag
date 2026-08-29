---
title: Observables
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0870-active-observable-and-energy-availability.md
---

(public-docs-physics-foundations-observables)=
# Observables

(observables-problem-statement)=
## Problem statement

An observable is a reproducible projection of the accepted solver state, not an arbitrary label
attached to an output file. FullMag preserves the requested quantity, spatial support, sampling
cadence, units, availability prerequisites, resolved backend, and provenance. A field observable
retains its mesh/grid support; a scalar observable is a reduction over the active magnetic domain
or an explicitly defined state metric.

(observables-governing-equations)=
## Governing equations

For an accepted state at time $t_n$, the total energy and a sampled quantity are defined by

```{math}
:label: eq-observables-total-energy
E_{\mathrm{total}}(t_n)=\sum_{k\in\mathcal K}E_k(t_n),
\qquad Q_n=Q[\mathbf m(t_n),\mathcal G,\mathcal M,\mathcal P],
```

For a volume-weighted scalar reduction,

```{math}
:label: eq-observables-volume-reduction
Q_{\mathrm{scalar}}=\sum_{i=1}^{N}w_i q_i.
```

The reduction weights are resolved by the selected discretisation. A request for a field that is
not enabled or materialisable is an error; it is never represented as a zero field.

(observables-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $Q_n$ | sampled observable at accepted state $n$ | $1$ |
| $E_{\mathrm{total}}$ | total magnetic energy | $\mathrm{J}$ |
| $E_k$ | energy contribution of interaction $k$ | $\mathrm{J}$ |
| $w_i$ | discrete integration/reduction weight | $\mathrm{m^3}$ |
| $q_i$ | local scalar density or contribution | $\mathrm{J\,m^{-3}}$ |
| $N$ | number of active discrete locations | $1$ |
| $t_n$ | accepted physical time | $\mathrm{s}$ |

An observable in FullMag is a named physical quantity that the solver can compute and
export during a simulation. Observables are either **fields** (spatially resolved,
three-component vectors or scalars at every cell/node) or **scalars** (single numbers per
time step, typically integrated quantities).

## Observable categories

### Field observables

Field observables carry spatial resolution and are exported as three-component vector arrays
or scalar arrays on the simulation grid/mesh.

| Observable | Symbol | SI unit | Requires |
|---|---|---:|---|
| `m` | $\mathbf{m}$ | $1$ | always available |
| `H_eff` | $\mathbf{H}_{\mathrm{eff}}$ | $\mathrm{A\,m^{-1}}$ | at least one energy term |
| `H_ex` | $\mathbf{H}_{\mathrm{ex}}$ | $\mathrm{A\,m^{-1}}$ | `Exchange()` |
| `H_demag` | $\mathbf{H}_{\mathrm{d}}$ | $\mathrm{A\,m^{-1}}$ | `Demag()` |
| `H_ext` | $\mathbf{H}_{\mathrm{ext}}$ | $\mathrm{A\,m^{-1}}$ | `Zeeman()` |
| `H_ani` | $\mathbf{H}_{\mathrm{ani}}$ | $\mathrm{A\,m^{-1}}$ | `UniaxialAnisotropy()` or `CubicAnisotropy()` |
| `H_dmi` | $\mathbf{H}_{\mathrm{DMI}}$ | $\mathrm{A\,m^{-1}}$ | `InterfacialDMI()` or `BulkDMI()` |
| `H_oe` | $\mathbf{H}_{\mathrm{oe}}$ | $\mathrm{A\,m^{-1}}$ | `OerstedField()` or `OerstedCylinder()` |
| `H_mel` | $\mathbf{H}_{\mathrm{mel}}$ | $\mathrm{A\,m^{-1}}$ | `Magnetoelastic()` |
| `H_th` | $\mathbf{H}_{\mathrm{th}}$ | $\mathrm{A\,m^{-1}}$ | `ThermalNoise()` |

### Scalar observables

Scalar observables are integrated (global) quantities, typically energies.

| Observable | Symbol | SI unit | Requires |
|---|---|---:|---|
| `E_ex` | $E_{\mathrm{ex}}$ | $\mathrm{J}$ | `Exchange()` |
| `E_demag` | $E_{\mathrm{d}}$ | $\mathrm{J}$ | `Demag()` |
| `E_zeeman` | $E_{\mathrm{Z}}$ | $\mathrm{J}$ | `Zeeman()` |
| `E_ani` | $E_{\mathrm{ani}}$ | $\mathrm{J}$ | anisotropy term |
| `E_dmi` | $E_{\mathrm{DMI}}$ | $\mathrm{J}$ | DMI term |
| `E_mel` | $E_{\mathrm{mel}}$ | $\mathrm{J}$ | `Magnetoelastic()` |
| `E_total` | $E_{\mathrm{tot}}$ | $\mathrm{J}$ | at least one energy term |
| `max_torque` | $\max|\mathbf{m}\times\mathbf{H}_{\mathrm{eff}}|$ | $\mathrm{A\,m^{-1}}$ | at least one field term |
| `dt` | $\Delta t$ | $\mathrm{s}$ | adaptive integrator |

## Requesting observables

Observables are requested through the `outputs` parameter of a study:

```python
# %% Observable requests in a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("observable-example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.exchange()
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 1 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.01
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=100,
    tolT=1.0e-6,
).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=1,
            quantities=["step", "e_ex", "e_total", "max_torque_T"],
        ),
        fields=[
            fm.FieldAutosave("m", every_steps=10),
            fm.FieldAutosave("H_eff", every_steps=10),
        ],
    )
)
```

The planner validates that the requested observables are compatible with the declared energy
terms. Requesting `H_ex` without `Exchange()` in the energy list is a validation error.

## Legality and materialisation

An observable is **legal** if the required interaction is declared and the selected backend
can materialise it. The legality check happens during planning:

1. **Authoring validation**: the Python DSL checks that the observable name is known.
2. **Planner validation**: the planner verifies that the energy term enabling the
   observable is declared and the concrete backend supports it.
3. **Runtime materialisation**: the solver computes the field/scalar and writes it to the
   output channel.

An observable that is declared but unmaterialisable (e.g. a GPU lane that does not implement
the energy reduction) is a planner error, not a silent zero.

## Table autosave

FullMag's table autosave captures scalar observables at every accepted step into a CSV or
structured output. This provides a continuous record of energies, maximum torque, and
timestep evolution without explicit `SaveScalar` declarations.

(observables-scientific-bibliography)=
## Scientific bibliography

1. C. Abert, "Micromagnetics and spintronics: models and numerical methods," *European
   Physical Journal B* **92**, 120 (2019).
   [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

(observables-assumptions-and-validity)=
## Assumptions and validity

- A field is interpreted on the support and ordering supplied by the resolved FDM grid or FEM
  mesh; values from different supports must not be compared without an explicit transfer.
- Scalar energies are reduced over the magnetic support only, even when a FEM airbox exists.
- A table row is emitted for an accepted state, not for a rejected adaptive trial.
- Availability is backend- and stage-dependent. Source presence or a Python constructor alone is
  not evidence of executed-device qualification.

(observables-python-api)=
## Python API

The stage-first request above is the executable public pattern. The output objects configure the
sampling policy; they do not create a second physical problem.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `TableAutosave.every_steps` | `int \| None` | `None` | $1$ | positive integer; exclusive with `t_sampl` | accepted-step cadence for scalar rows | FDM/FEM CPU/GPU where table autosave is materialised | `study.sampling.outputs[].every_steps` |
| `TableAutosave.quantities` | `Sequence[str] \| None` | default registry | $1$ | every name must be a supported scalar quantity | scalar columns to evaluate | FDM/FEM CPU/GPU subject to quantity availability | `study.sampling.outputs[].quantities` |
| `FieldAutosave.quantity` | `str` | required | $1$ | known field identifier | spatial field to write | lane-dependent; planner rejects unavailable fields | `study.sampling.outputs[].name` |
| `FieldAutosave.every_steps` | `int \| None` | `None` | $1$ | positive integer; exclusive with `every` | accepted-step field cadence | FDM/FEM CPU/GPU where the field is materialised | `study.sampling.outputs[].every_steps` |

(observables-problem-ir)=
## Canonical ProblemIR

The lowered request keeps the authored quantity and cadence explicit:

```json
{
  "kind": "table_autosave",
  "table_id": "default",
  "every_steps": 10,
  "quantities": ["step", "e_ex", "e_total", "max_torque_T"]
}
```

The planner adds stage-resolved field outputs without changing the requested names. Resolved
backend, device, precision, support, and materialisation status belong to execution provenance.

(observables-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The round trip preserves requested intent (quantity names, cadence, table identity, field target)
and records resolved execution (backend, device, precision, support, and actual availability).
Validation errors include unknown quantities, duplicate field requests, invalid cadence, and a
field whose enabling interaction is absent. Unsupported combinations are rejected by the planner;
there is no silent CPU fallback, zero substitution, or hidden unit conversion.

(observables-discrete-realization)=
## Discrete realization

### FDM CPU

The reference lane evaluates cell fields and volume-weighted reductions in deterministic host
storage.

### FDM GPU

The CUDA lane evaluates device-resident fields and reductions; a skip-success test is not evidence
of an executed device. Precision and device identity are part of the artifact.

### FEM CPU

The native FEM lane recovers nodal/vector fields and applies the selected lumped or quadrature
weights. Airbox values are not included in magnetic energy reductions.

### FEM GPU

The GPU lane may use host-assembled operators but must record device field residency, transfers,
reduction phase, precision, and executed-device identity separately from setup availability.

(observables-implementation-mapping)=
## Implementation mapping

Python declares sampling, the planner validates legality, the quantity registry evaluates named
quantities, and backend state I/O copies the resolved fields.

(observables-validation)=
## Validation

Validation must cover quantity-name normalization, enabling-interaction checks, cadence semantics,
accepted-step ordering, scalar reduction units, FDM CPU/GPU parity, FEM CPU/GPU parity, field
support/ordering, and fail-closed unavailable quantities. Qualification requires executed-device
identity for GPU claims.

(observables-limitations)=
## Limitations

Some interaction fields and mechanical quantities remain planner-gated. A quantity listed here
does not imply that every solver/device lane currently materialises it. Spatial transfer between
FDM and FEM supports is outside this observable contract.

(observables-source-code-index)=

## Control Room crosswalk

No dedicated equation editor exists. Use the applicable Geometry, Material, Physics, or Stage panel. Status: `inspection-only` for the scientific explanation. TODO: frontend support applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Stage capture | `packages/fullmag-py/src/fullmag/world.py` | `study` |
| Scalar autosave contract | `packages/fullmag-py/src/fullmag/model/study.py` | `TableAutosave` |
| Field autosave contract | `packages/fullmag-py/src/fullmag/model/study.py` | `FieldAutosave` |
| Planner output legality | `crates/fullmag-plan/src/validate.rs` | `validate_executable_outputs` |
| Quantity evaluation registry | `crates/fullmag-quantities/src/registry.rs` | `evaluate_by_name` |
| FEM field extraction | `backends/fem/cpu/mfem/runtime/state_io.cpp` | `context_copy_field_f64` |
