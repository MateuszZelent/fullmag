---
title: Exchange Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-interactions-exchange)=
# Exchange Python API

This page owns the Python authoring, validation, and `ProblemIR` boundary. The scientific
equations and backend interpretation are owned by {doc}`../../physics/interactions/exchange/index`.

(api-exchange-problem-statement)=
## Physical problem

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

(api-exchange-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("exchange_api_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=500, tolT=1.0e-6)
```

Exchange is active by default; assigning a positive `Aex` supplies its material coefficient and
does not require `study.exchange()`. Use `study.disable_exchange()` only for an intentional
exchange-free model. The compatibility form `study.exchange(enabled=False)` remains accepted.
The exchange stiffness is material-owned (`A` in `Material`, exposed as `Aex` on a study
geometry handle).

## Parameters

| Python surface | Type | Default | SI unit | Validation owner | ProblemIR |
|---|---|---|---:|---|---|
| `Exchange()` | object | no parameters | — | authoring/IR uniqueness | `energy_terms[].kind="exchange"` |
| `Material.A` | `float` | required for active exchange | $\mathrm{J\,m^{-1}}$ | Python + IR | `materials[].exchange_stiffness` |
| geometry-handle `.Aex` | `float` | unset | $\mathrm{J\,m^{-1}}$ | facade + IR | same canonical material field |
| `Material.A_field` | sequence or artifact | unset | $\mathrm{J\,m^{-1}}$ | planner cardinality/finite checks | spatial material field |
| no exchange control call | authoring default | active | $1$ | study builder | canonical `Exchange()` term |
| `study.disable_exchange()` | method | not called | $1$ | study builder | exchange term absent |

(api-exchange-problem-ir)=
## Lowering

```json
{"kind": "exchange"}
```

The stiffness does not belong in this interaction fragment. It remains on the material so one
interaction can consume scalar or resolved spatial data without duplicating ownership.

(api-exchange-validation)=
## Failure semantics

Reject non-finite or negative stiffness, missing active material data, incompatible spatial-field
cardinality, invalid masks, and unsupported interface policy. An accepted constructor is not proof
that a specific device lane executed.

## Validation tests

Constructor/IR round trip, uniform-state zero field, spin-spiral energy, finite-difference
energy/field derivative, material-interface links, and matched CPU/GPU parity.

(api-exchange-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(api-exchange-governing-equations)=
## Governing equations

The equations and sign conventions owned by this interaction are stated in the preceding scientific description.

(api-exchange-symbols-and-si-units)=
## Symbols and SI units

All physical inputs use SI units. Dimensionless axes and reduced magnetization are normalized according to the stated contract.

(api-exchange-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(api-exchange-discrete-realization)=
## Discrete realization

FDM and FEM, and CPU and GPU, are distinct numerical realizations. Their availability and qualification are reported separately in the capability tables above.

(api-exchange-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(api-exchange-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

(api-exchange-scientific-bibliography)=
## Scientific bibliography

The principal references are listed in the interaction-specific bibliography above.

(api-exchange-source-code-index)=

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

