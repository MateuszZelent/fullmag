---
title: Quantities
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-quantities)=
# Quantities

(python-api-outputs-quantities-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the canonical quantity identifiers and the generic quantity-driven output used
to persist them.

(python-api-outputs-quantities-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Quantity definitions belong to the interaction and observable pages; this page owns identity and
output lowering.

(python-api-outputs-quantities-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Fields and energies carry the units defined in their owning pages; magnitude reductions preserve
those units.

(python-api-outputs-quantities-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Quantity ids and optional reductions/components are validated immediately against canonical sets.

(python-api-outputs-quantities-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `SaveQuantity.quantity_id` | `str` | `required` | Canonical id; uppercase `M` normalizes to `m` | Quantity to save | quantity id |
| `SaveQuantity.every` | `float` | `required` | Positive | Save interval | cadence |
| `SaveQuantity.reduction` | `str \| None` | `None` | `average`, `sum`, `min`, `max`, or `magnitude` | Spatial reduction | reduction |
| `SaveQuantity.component` | `str \| None` | `None` | `x`, `y`, `z`, `magnitude`, or `3D` | Component selector | component |

Canonical ids include magnetization and effective-field vectors, energy scalars, and transport
fields (`V_electric`, `J_charge`, `spin_potential`, `spin_current_tensor` among others).

### Complete stage-first example

```python
# %% Generic quantity-driven output
import fullmag as fm

nm = 1.0e-9

study = fm.study("quantities_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.save("m", every=1.0e-13)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-outputs-quantities-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`SaveQuantity.to_ir()` emits the quantity id, cadence, and optional reduction/component.

(python-api-outputs-quantities-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Unknown ids and invalid reductions/components fail immediately; legacy `M` is normalized, never
silently reinterpreted.

(python-api-outputs-quantities-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Canonical ids must match the `fullmag-quantities` Rust crate so transport and storage agree.

(python-api-outputs-quantities-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/outputs.py` (`class SaveQuantity`,
`_KNOWN_QUANTITY_IDS`).

(python-api-outputs-quantities-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live ids and reduction sets.

(python-api-outputs-quantities-limitations)=
<!-- (limitations)= -->
## Limitations
Requesting a quantity does not guarantee the configured interactions materialize it; planner
legality is authoritative.

(python-api-outputs-quantities-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-outputs-quantities-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Table/field autosave and result inspection are partial; unsupported output formats remain TODO.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Autosave` | `partial` | Submit autosave draft; output resources are revised after execution |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Autosave` | `TODO` | Python-only until implemented |

TODO: frontend support for output parameters not rendered by the autosave/result inspectors.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/stages/AutosaveStageInspector.tsx (AutosaveStageInspector)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Quantity output | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveQuantity` | Id-driven output | Ownership test |
