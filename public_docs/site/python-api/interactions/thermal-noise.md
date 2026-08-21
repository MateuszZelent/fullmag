---
title: Thermal Noise Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-thermal-noise)=
# Thermal Noise Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/thermal-noise/index`.

(api-thermal-noise-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

## Constructor

## Parameters

| Parameter | Type | Default | SI unit | Current behavior | Required behavior |
|---|---|---|---:|---|---|
| `temperature` | float | required | $\mathrm K$ | finite positive check | retain |
| `seed` | `int | None` | `None` | only positivity is checked when supplied | require an actual positive integer; reject `bool` and non-integral float |

`seed=None` requests system entropy. `seed=0` is rejected and must not be documented as an entropy
alias.

(api-thermal-noise-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("thermal_noise_reference")
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
study.thermal_noise(temperature=300.0, seed=123)
study.solver(integrator="heun", fix_dt=1.0e-15)
study.stages.add_run(stage_id="thermalize", until=1.0e-12)
```

(api-thermal-noise-problem-ir)=
## Lowering

```json
{"kind": "thermal_noise", "temperature": 300.0, "seed": 123}
```

A fixed seed defines requested replay within an explicitly declared lane; it is not a promise of
CPU/GPU bitwise trajectory identity.

(api-thermal-noise-validation)=
## Failure semantics

Reject duplicate thermal terms, conflicting top-level temperature, unsupported GPU/FEM lane,
non-positive timestep/volume/material factors, and unsupported direct `H_therm` output. Do not
silently substitute CPU execution.

(api-thermal-noise-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-thermal-noise-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-thermal-noise-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-thermal-noise-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-thermal-noise-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-thermal-noise-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-thermal-noise-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-thermal-noise-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-thermal-noise-source-code-index)=
## Source-code index

The implementation owners are listed in the interaction-specific source table above.
