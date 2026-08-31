---
title: Interfacial DMI Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-interfacial-dmi)=
# Interfacial DMI Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/dmi/index`.

(api-interfacial-dmi-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

## Constructor

`D` is in $\mathrm{J\,m^{-2}}$. The sign is physical and must be preserved.

## Parameters

| Parameter | Default | SI unit | Current check | Required check |
|---|---|---:|---|---|
| `D` | required | $\mathrm{J\,m^{-2}}$ | float conversion | finite |
| `interface_normal` | `None` | $1$ | length/conversion | finite, non-zero; FDM requires canonical +z |

Material-owned `dind` and an explicit interaction are alternative sources. Reject duplicates.

(api-interfacial-dmi-problem-ir)=
## Lowering

```json
{"kind": "interfacial_dmi", "D": 0.003, "interface_normal": [0.0, 0.0, 1.0]}
```

(api-interfacial-dmi-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("interfacial_dmi_reference")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

body.Ku1 = 4.7e5
body.anisU = (0.0, 0.0, 1.0)
body.dind = 3.0e-3  # J/m^2
study.demag(realization="poisson_robin")
study.stages.add_relax(stage_id="relax", algorithm="llg_overdamped", max_steps=500, tolT=1.0e-6)
```

(api-interfacial-dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-interfacial-dmi-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-interfacial-dmi-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-interfacial-dmi-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-interfacial-dmi-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-interfacial-dmi-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-interfacial-dmi-validation)=
## Validation

Validation must cover units, signs, energy/field or torque consistency, discretization convergence, boundary behavior, and lane-specific CPU/GPU evidence.

(api-interfacial-dmi-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-interfacial-dmi-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-interfacial-dmi-source-code-index)=

## Control Room crosswalk

Status: Interaction selection is partial; only fields advertised by the current physics panel are UI-supported.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Physics` | `partial` | Apply physics draft; solver/stage resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Physics` | `not implemented` | Python-only until implemented |

Frontend support is not implemented for interaction-specific parameters absent from `PhysicsInteractionPanel`.
See [Control Room capability register](/frontend/capability-register) for the support matrix and explicit not-implemented status.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx (PhysicsInteractionPanel)`.

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

## Source-code index

The implementation owners are listed in the interaction-specific source table above.

