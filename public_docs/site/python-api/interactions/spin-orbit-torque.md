---
title: Spin-Orbit Torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(sot-api-problem-statement)=
# Spin-Orbit Torque Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/spin-orbit-torque/index`.

(api-spin-orbit-torque-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-spin-orbit-torque-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("prescribed_sot_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

sot = fm.PrescribedSpinOrbitTorque(
    name="hm_sot",
    target=fm.RegionRef("film"),
    drive=fm.SignedScalarDrive(current_density_Apm2=-4.0e11, sigma=(0.0, 1.0, 0.0)),
    xi_dl=0.12,
    xi_fl=-0.03,
    free_layer_thickness_m=1.5 * nm,
)
study.spin_torque(sot)
study.stages.add_run(stage_id="drive", until=1.0e-12)
```

`SpinOrbitTorque` is deprecated compatibility input and must not be the primary documented API.

## Parameters

| Parameter | Default | SI unit | Validation |
|---|---|---:|---|
| `name` | required | $1$ | non-empty, unique |
| `target` | required | $1$ | resolvable magnetic target; lane-specific granularity |
| `drive` | required | tagged | exactly one `SignedScalarDrive` or `VectorCurrentDrive` |
| `xi_dl` | required | $1$ | finite and signed |
| `xi_fl` | `0.0` | $1$ | finite and signed |
| `free_layer_thickness_m` | required | $\mathrm m$ | finite and positive |

`SignedScalarDrive` requires finite signed current density and a finite non-zero `sigma`.
`VectorCurrentDrive` requires a valid source and finite non-parallel drive/interface axes.

## Additional API details

The surrounding study must define `free_layer`, material data, solver/device, and an ordered stage.

(api-spin-orbit-torque-problem-ir)=
## Lowering and failure semantics

The tagged module is serialized under `spin_torque_modules[]`. Preserve current sign, authored
axis orientation, efficiencies, target, thickness, envelope, and formula version. Unsupported
target masks, tabulated envelopes, source bindings, or strict GPU features fail closed.

(api-spin-orbit-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-spin-orbit-torque-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-spin-orbit-torque-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-spin-orbit-torque-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-spin-orbit-torque-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-spin-orbit-torque-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-spin-orbit-torque-validation)=
## Validation

Validation must cover units, signs, energy/field or torque consistency, discretization convergence, boundary behavior, and lane-specific CPU/GPU evidence.

(api-spin-orbit-torque-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-spin-orbit-torque-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-spin-orbit-torque-source-code-index)=

## Control Room crosswalk

Status: Interaction selection is partial; only fields advertised by the current physics panel are UI-supported.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Objects -> <object> -> Physics` | `partial` | Apply physics draft; solver/stage resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Objects -> <object> -> Physics` | `TODO` | Python-only until implemented |

TODO: frontend support for interaction-specific parameters absent from PhysicsInteractionPanel.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx (PhysicsInteractionPanel)`.

## Python API

The complete runnable example is in the numbered example section below; the exact callable fields and arguments are in the numbered API section. These values are copied from the current Python contract, not inferred from the UI.

## Source-code index

The implementation owners are listed in the interaction-specific source table above.

