---
title: Cubic anisotropy Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-cubic-anisotropy)=
# Cubic anisotropy Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/anisotropy/index`.

(api-cubic-anisotropy-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-cubic-anisotropy-governing-equations)=
## Implemented polynomial

With $P=\alpha_1^2\alpha_2^2+\alpha_2^2\alpha_3^2+\alpha_3^2\alpha_1^2$,

$$
w=K_{c1}P+K_{c2}\alpha_1^2\alpha_2^2\alpha_3^2+K_{c3}P^2.
$$

Always publish this equation with the constants because higher-order cubic conventions vary.

(api-cubic-anisotropy-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("cubic_anisotropy_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

body.Kc1 = 4.8e4
body.Kc2 = 0.0
body.Kc3 = 0.0
body.anisC1 = (1.0, 0.0, 0.0)
body.anisC2 = (0.0, 1.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=500, tolT=1.0e-6)
```

(api-cubic-anisotropy-validation)=
## Parameters and constructor validation

| Parameter | Default | SI unit | Constructor check |
|---|---|---:|---|
| `kc1` | required | $\mathrm{J\,m^{-3}}$ | `float()` conversion |
| `kc2`, `kc3` | `0.0` | $\mathrm{J\,m^{-3}}$ | `float()` conversion |
| `axis1` | `(1,0,0)` | $1$ | exactly three float-convertible values |
| `axis2` | `(0,1,0)` | $1$ | exactly three float-convertible values |

The constructor does not currently reject non-finite constants, zero axes, or collinear axes.
Downstream semantic validation must reject those inputs before execution; constructor success is
not evidence that an anisotropy frame is executable.

(api-cubic-anisotropy-problem-ir)=
## Lowering

Canonical export stores `cubic_anisotropy_kc1/kc2/kc3` and the two authored axes on the material.
A planner may normalize the frame for execution, but requested and resolved axes must remain
distinguishable in provenance.

(api-cubic-anisotropy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-cubic-anisotropy-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-cubic-anisotropy-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-cubic-anisotropy-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-cubic-anisotropy-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-cubic-anisotropy-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-cubic-anisotropy-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-cubic-anisotropy-source-code-index)=
## Source-code index

The implementation owners are listed in the interaction-specific source table above.
