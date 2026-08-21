---
title: Oersted field Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(oersted-api-problem-statement)=
# Oersted field Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/oersted-field/index`.

(api-oersted-field-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

## Two constructors, two model families

### Analytic cylinder

| Parameter | SI unit | Required validation |
|---|---:|---|
| `current` | $\mathrm A$ | finite and signed |
| `radius` | $\mathrm m$ | finite and positive |
| `center` | $\mathrm m$ | three finite values |
| `axis` | $1$ | three finite values, non-zero, normalized once |
| `time_dependence` | $1$ multiplier | supported tagged schedule |
| `id` | $1$ | non-empty and unique |

### Solved-current binding

| Parameter | Default | Meaning |
|---|---|---|
| `source` | required | name of a compatible `CurrentTransport` |
| `model` | `"from_current_solution"` | only accepted public solved-current model |
| `id` | `oersted:<source>` | stable module identity |

## Critical documentation boundary

`OerstedField` has no `method` selector. Do not document `OE-F1` or `OE-F2` as user-selected
constructor parameters. The planner's resolved method belongs to execution provenance.

A complete solved-current example requires a conservative current view and a globally closed
circuit. Keep the large external-lead payload in a dedicated advanced fixture, not the primary API
page.

(api-oersted-field-problem-ir)=
## Lowering

```json
{"kind": "oersted_cylinder", "id": "oersted:cylinder", "current": 0.005, "radius": 5e-08, "center": [0.0, 0.0, 0.0], "axis": [0.0, 0.0, 1.0]}
```

## Capability warning

The analytic model and solved-current model have different support matrices. Front matter must be
`partial`; semantic-only FEM solved-current slices do not make all four lanes implemented.

(api-oersted-field-python-api)=
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

(api-oersted-field-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-oersted-field-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-oersted-field-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-oersted-field-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-oersted-field-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-oersted-field-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-oersted-field-validation)=
## Validation

Validation must cover units, signs, energy/field or torque consistency, discretization convergence, boundary behavior, and lane-specific CPU/GPU evidence.

(api-oersted-field-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-oersted-field-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-oersted-field-source-code-index)=
## Source-code index

The implementation owners are listed in the interaction-specific source table above.
