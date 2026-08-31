---
title: Uniaxial anisotropy Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-uniaxial-anisotropy)=
# Uniaxial anisotropy Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/anisotropy/index`.

(api-uniaxial-anisotropy-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-uniaxial-anisotropy-governing-equations)=
## Implemented convention

`UniaxialAnisotropy(ku1, ku2, axis)` represents

$$
w=-K_{u1}(\mathbf m\cdot\hat{\mathbf u})^2
  -K_{u2}(\mathbf m\cdot\hat{\mathbf u})^4.
$$

The current `energy.py` docstring describing $K_{u1}\sin^2\theta+K_{u2}\sin^4\theta$ is not
parameter-identical for `ku2` and must be corrected.

## Canonical material authoring

## Parameters

| Parameter | SI unit | Meaning | Current constructor check | Required semantic check |
|---|---:|---|---|---|
| `ku1` | $\mathrm{J\,m^{-3}}$ | coefficient of $-q^2$ | `float()` | finite |
| `ku2` | $\mathrm{J\,m^{-3}}$ | coefficient of $-q^4$ | `float()` | finite |
| `axis` | $1$ | easy-axis direction | length/conversion | finite, non-zero when active, normalized once |

(api-uniaxial-anisotropy-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("anisotropy_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

body.Ku1 = 5.0e5
body.Ku2 = 5.0e4
body.anisU = (0.0, 0.0, 1.0)
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=500, tolT=1.0e-6)
```

(api-uniaxial-anisotropy-problem-ir)=
## Lowering

Canonical export stores material fields rather than retaining a compatibility energy term.
Conflicts between explicit and material-owned values must be rejected, not summed.

(api-uniaxial-anisotropy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-uniaxial-anisotropy-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-uniaxial-anisotropy-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-uniaxial-anisotropy-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-uniaxial-anisotropy-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-uniaxial-anisotropy-validation)=
## Validation

Validation must cover units, signs, energy/field or torque consistency, discretization convergence, boundary behavior, and lane-specific CPU/GPU evidence.

(api-uniaxial-anisotropy-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-uniaxial-anisotropy-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-uniaxial-anisotropy-source-code-index)=

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

