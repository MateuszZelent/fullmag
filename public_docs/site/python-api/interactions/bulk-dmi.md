---
title: Bulk DMI Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-bulk-dmi)=
# Bulk DMI Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/dmi/index`.

(api-bulk-dmi-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-bulk-dmi-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("bulk_dmi_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

body.Dbulk = 1.5e-3  # J/m^2
study.pbc(x=True, y=True, z=True)
study.demag(enabled=False)
study.stages.add_run(stage_id="sample", until=1.0e-12)
```

`D` is a signed coefficient in $\mathrm{J\,m^{-2}}$.

## Canonical material route

The canonical material field and geometry-facade spelling is `Dbulk`. The compatibility
`BulkDMI(D)` constructor lowers the same signed coefficient as an explicit energy term.

## Parameter reference

| Parameter | Type | SI unit | Required checks |
|---|---|---:|---|
| `D` | float | $\mathrm{J\,m^{-2}}$ | finite; either sign |
| material bulk coefficient | float or spatial field | $\mathrm{J\,m^{-2}}$ | finite; mesh cardinality for fields |
| periodicity/topology | planner policy | — | compatible with selected FDM bulk stencil |

`Material.Dbulk` uses the same $\mathrm{J\,m^{-2}}$ coefficient contract as
$w=D\,\mathbf m\cdot\nabla\times\mathbf m$.

(api-bulk-dmi-validation)=
## Failure semantics

Reject duplicate explicit/material ownership, non-finite coefficients, unsupported non-periodic
or multilayer FDM plans, missing FEM fields/buffers, and unavailable observables. Never rotate or
change the sign of `D` silently.

(api-bulk-dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-bulk-dmi-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-bulk-dmi-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-bulk-dmi-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-bulk-dmi-problem-ir)=
## ProblemIR

`BulkDMI(D).to_ir()` emits `{"kind": "bulk_dmi", "D": D}`. Stage-first material authoring
stores the coefficient on the material and creates the corresponding interaction during lowering;
resolved stencil and device information remain execution provenance.

(api-bulk-dmi-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-bulk-dmi-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-bulk-dmi-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-bulk-dmi-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-bulk-dmi-source-code-index)=
## Source-code index

The implementation owners are listed in the interaction-specific source table above.
