---
title: Quantities
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-quantities)=
# Quantities

(python-api-outputs-quantities-problem-statement)=
## Contract
This page records the canonical quantity identifiers, the generic quantity-driven output (`fm.SaveQuantity`), and live quantity inspection handles (`QuantityHandle` via `study.m`, `.get()`, `.average()`, `.region(...)`, `.comp(...)`).

(python-api-outputs-quantities-governing-equations)=
## Governing equations
Quantity definitions belong to the interaction and observable pages; this page owns identity and output lowering.

(python-api-outputs-quantities-symbols-and-si-units)=
## Symbols and SI units
Fields and energies carry the units defined in their owning pages; magnitude reductions preserve those units.

(python-api-outputs-quantities-assumptions-and-validity)=
## Assumptions and validity
Quantity ids and optional reductions/components are validated immediately against canonical sets (`_KNOWN_QUANTITY_IDS`, 39 registered identifiers).

(python-api-outputs-quantities-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SaveQuantity.quantity_id` | `str` | `required` | $1$ | Canonical id; uppercase `M` normalizes to `m` | Quantity to save | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `save_quantity.quantity_id` |
| `SaveQuantity.every` | `float` | `required` | $\mathrm{s}$ | Positive finite | Save interval | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `save_quantity.every_seconds` |
| `SaveQuantity.reduction` | `str \| None` | `None` | $1$ | `average`, `sum`, `min`, `max`, or `magnitude` | Spatial reduction | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `save_quantity.reduction` |
| `SaveQuantity.component` | `str \| None` | `None` | $1$ | `x`, `y`, `z`, `magnitude`, or `3D` | Component selector | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `save_quantity.component` |

### Canonical quantity families and `QuantityHandle`

Canonical IDs include magnetization and effective-field vectors (`m`, `H_eff`, `H_ex`, `H_demag`, `H_ext`, `H_ani`, `H_ani_cubic`, `H_dmi`, `H_dmi_bulk`, `H_rotated_dmi`, `H_mel`, `H_oe`, `H_ant`, `H_drive`, `B_drive`, `H_therm`, `dm_dt`, `demag_phi`), energy densities (`eden_ex`, `eden_demag`, `eden_ext`, `eden_ani`, `eden_dmi`, `eden_drive`), energy and diagnostic scalars (`E_total`, `E_ex`, `E_demag`, `E_ext`, `E_ani`, `E_dmi`, `E_rotated_dmi`, `E_drive`, `mx`, `my`, `mz`, `max_dm_dt`, `max_h_eff`, `max_h_demag`, `solver_dt`, `step`, `time`), and transport fields (`V_electric`, `J_charge`, `spin_potential`, `spin_current_tensor`).

In interactive/live workflows, `QuantityHandle` exposes `.get()`, `.average()`, `.region(name_or_index)`, and `.comp(component)` (plus MuMax3-compatible capitalized aliases `.Get()`, `.Average()`, `.Region()`, `.Comp()`), and feeds tabular columns into `study.tableadd(...)`.

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
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.save("m", every=1.0e-13)
study.stages.add_run(stage_id="run", until=1.0e-12)

req = fm.SaveQuantity("m", every=1.0e-13, reduction="average", component="x")
assert req.to_ir()["kind"] == "save_quantity"
assert req.to_ir()["every_seconds"] == 1.0e-13
```

(python-api-outputs-quantities-problem-ir)=
## ProblemIR
`SaveQuantity.to_ir()` emits `{"kind": "save_quantity", "quantity_id": ..., "every_seconds": ...}` plus optional `reduction` and `component`.

(python-api-outputs-quantities-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Unknown ids and invalid reductions/components fail immediately; legacy `M` is normalized to `m`, never silently reinterpreted.

(python-api-outputs-quantities-discrete-realization)=
## Discrete realization
Canonical ids match the `fullmag-quantities` Rust crate so transport, storage, and Control Room inspection agree.

(python-api-outputs-quantities-implementation-mapping)=
## Implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Evaluates requested canonical field, scalar, and reduction quantities. |
| FEM | GPU | `documented` | Evaluates GPU reductions and field extracts for enabled interactions. |
| FDM | CPU | `documented` | Evaluates Cartesian quantities and spatial reductions. |
| FDM | GPU | `documented` | Evaluates CUDA reductions and accepted-endpoint observations. |

(python-api-outputs-quantities-validation)=
## Validation
Ownership tests compare this inventory with live ids and reduction sets.

(python-api-outputs-quantities-limitations)=
## Limitations
Requesting a quantity does not guarantee the configured interactions materialize it; planner legality is authoritative.

(python-api-outputs-quantities-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Table/field autosave and result inspection are `partial`; unlisted output formats and advanced options remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Autosave` (`FieldAutosaveStageSpec`) | `partial` | Submit autosave draft; output resources are revised after execution |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Autosave` | `Python-only` | Authored in Python |

Output parameters outside `FieldAutosaveStageSpec` remain Python-only.
See {doc}`/frontend/capability-register` for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/inspectors/study/stages/FieldAutosaveStageSpec.tsx`.

(python-api-outputs-quantities-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| Generic quantity output validation and lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L389) | [`class SaveQuantity`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L389) | Id-driven quantity output validation and lowering | Ownership and API contract tests |
