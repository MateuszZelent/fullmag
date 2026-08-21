---
title: Zeeman Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-zeeman)=
# Zeeman Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/zeeman/index`.

(api-zeeman-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-zeeman-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("zeeman_reference")
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
study.b_ext(0.0, 0.0, 0.1)  # tesla
study.stages.add_run(stage_id="precession", until=1.0e-12)
```

`Zeeman(B)` accepts a three-component magnetic flux density in tesla.

## Parameter reference

| Parameter | Type | Default | SI unit | Current Python check | Required semantic check |
|---|---|---|---:|---|---|
| `B` | sequence of 3 numbers | required | $\mathrm T$ | length and float conversion | all components finite |
| zero vector | legal | — | $\mathrm T$ | accepted | zero field/energy |
| spatial or time-varying source | not represented by this constructor | — | — | use typed field-source APIs | source-specific validation |

(api-zeeman-validation)=
## Validation correction

At the audited revision, `as_vector3` does not reject `NaN` or infinity. Documentation must not
claim constructor-level finite validation until the code uses a finite-vector validator. IR and
planner validation must reject such values meanwhile.

(api-zeeman-problem-ir)=
## Lowering

```json
{"kind": "zeeman", "B": [0.0, 0.0, 0.08]}
```

(api-zeeman-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-zeeman-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-zeeman-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-zeeman-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-zeeman-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-zeeman-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-zeeman-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-zeeman-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-zeeman-source-code-index)=
## Source-code index

The implementation owners are listed in the interaction-specific source table above.
