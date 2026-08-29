---
title: Qualification Status
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-qualification-status)=
# Qualification Status

Qualification is per workload, per lane, and evidence-backed. The table below is the current
production status for the **relaxation** workload; other workloads (time-domain reversal, spectral
response, GPU strict residency) have their own gates and must not inherit relaxation status.

## Relaxation algorithm and lane matrix

| Algorithm | FDM CPU | FDM CUDA | FEM CPU | FEM CUDA | Status |
|---|---|---|---|---|---|
| `llg_overdamped` | qualified | qualified | qualified | qualified | production |
| `projected_gradient_bb` | qualified | qualified for supported payloads | qualified, demag `rtol<=1e-12` | qualified, demag `rtol<=1e-12` | production |
| `nonlinear_cg` | qualified | qualified for supported payloads | qualified, demag `rtol<=1e-12` | qualified, demag `rtol<=1e-12` | production |
| `tangent_plane_implicit` | unsupported | unsupported | development-only (`extended`) | unsupported | development-only, fail-closed elsewhere |

Unsupported heterogeneous CUDA material payloads and unsupported adaptive/tableau combinations fail
capability checks; no lane silently substitutes Heun, CPU execution, another minimizer, or a looser
physical model.

## Evidence basis

The relaxation promotion is backed by the managed production benchmark (`39` comparison pairs,
`21/21` required coverage), managed native source/operator/energy-derivative contracts, and
CPU/GPU consistency `6/6` rows / `3/3` pairs. The public method pages under
{doc}`../numerical-methods/relaxation/index` document the per-algorithm contracts this matrix
summarizes.

## Frozen-spins qualification

`frozen_spins` constraints are implemented via the typed `FrozenSpins` contract in API and planner
inputs, and they are governed by `docs/validation/frozen-spins-v1-scope.yaml`
(`scope_revision: 1`, `product_version: frozen_spins.v1`).

Feature coverage is tracked in a separate lane-agnostic gate path with dedicated scopes and test sets, including:

- selector and membership behavior;
- reference mode semantics (`capture_current_at_activation`, `initial_state`, `explicit_field_asset`);
- empty/inactive selection policy;
- stage activation semantics, resume portability, and visualization support.

Operationally this is exercised through dedicated commands (for example
`just verify-frozen-spins-qualification` and scope/gate companions) rather than by inference from
the relaxation matrix.

## Frozen-spins kwalifikacja — układ jednolitego wpisu (kod + Python + bibliografia)

### 1) Wprowadzenie

`frozen_spins` is a typed stage-aware constraint contract, not a solver-side “shortcut”.
The public gate path is strict: payload-level validation happens before planning, and unsupported
combinations fail closed.

### 2) Implementacja bezpośrednio z kodu (100%)

- `FrozenSpins` is defined in `packages/fullmag-py/src/fullmag/model/constraints.py` and validates:
  `id`, `selector`, `name`, `enabled`, `reference`, `membership`, `activation`, `stage_ids`, `empty_selection`,
  `inactive_selection`.
- `ObjectRegion.freeze_spins(...)` (same file: `structure.py`) builds `FrozenSpins` via `in_region_selection(...)`.
- `Ferromagnet.freeze_spins(...)` (same file: `structure.py`) builds `FrozenSpins` via `in_object_selection(...)`.
- The stage-aware study/solver contract keeps this intent in `ProblemIR` and resolves only in planner/runtime.

### 3) Implementacja w Pythonie (bezpośredni wzorzec)

```python
from fullmag.model.constraints import FrozenSpins
from fullmag.model.selection import in_region_selection

# Direct constructor (public source class contract)
frozen = FrozenSpins(
    id="film_frozen",
    selector=in_region_selection("film", "all"),
    reference="capture_current_at_activation",
    membership=None,
    empty_selection="error",
    inactive_selection="warn_and_intersect",
)
```

```python
film_region = ...  # fullmag.model.structure.ObjectRegion instance
frozen_region = film_region.freeze_spins(
    id="film_frozen_region",
    reference="capture_current_at_activation",
    membership="dynamic",
    stage_ids=("run",),
)
```

### 4) Funkcje i argumenty (z kodu źródłowego)

| Funkcja | Argumenty i znaczenia |
|---|---|
| `FrozenSpins.__init__(*, id, selector, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | `frozen_spins` contract; selection and stage activation are normalized through `_reference_ir(...)` and `_activation_ir(...)`. |
| `ObjectRegion.freeze_spins(..., id=None, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Region-scoped freeze helper; id defaults to `<region_id>_frozen`, selector is `in_region_selection`. |
| `Ferromagnet.freeze_spins(..., id, name=None, enabled=True, reference="capture_current_at_activation", membership=None, activation=None, stage_ids=None, empty_selection="error", inactive_selection="warn_and_intersect")` | Object-scoped freeze helper; requires explicit `object_id`, selector is `in_object_selection`. |
| `TimeEvolution.constraints` | Sequence of `FrozenSpins` objects transported from study to problem contract. |

### 5) Referencje do kodu

- `packages/fullmag-py/src/fullmag/model/constraints.py:137` (`class FrozenSpins`, `__init__`)
- `packages/fullmag-py/src/fullmag/model/structure.py:516` (`ObjectRegion.freeze_spins`)
- `packages/fullmag-py/src/fullmag/model/structure.py:769` (`Ferromagnet.freeze_spins`)
- `packages/fullmag-py/src/fullmag/model/problem.py` (`Problem` aggregate and constraint lowering)
- `packages/fullmag-py/src/fullmag/model/study.py` (`TimeEvolution` transport and constraints handling)

### 6) Bibliografia

- Abert, C. “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Open Source FullMag codebase, frozen-spins constraint implementation and qualification scopes (current repository state).

## Per-interaction support matrices

Physics and numerical terminal pages own their four-lane FDM/FEM CPU/GPU support and qualification
matrices. Those are the authoritative support status for an interaction; do not use the relaxation
table above to claim an interaction is validated outside relaxation. Start from:

- {doc}`../physics/interactions/index` — canonical interaction pages;
- {doc}`../numerical-methods/index` — method and solver-lane realizations.

## Not yet qualified

- Time-domain NIST SP4 reversal (artifact `not_evaluated` / `unvalidated`).
- GPU strict-residency and hosted CPU/GPU field parity rerun in the CUDA-visible runtime.
- Full FDM↔FEM cross-backend comparison matrix.
- Frozen-spins lane-agnostic qualification and artifact promotion are tracked by their dedicated
  frozen-spins gates and are not implied by this relaxation table.

These remain open until their dedicated gates pass with recorded artifacts.
## Control Room crosswalk

Validation pages are `inspection-only` in Control Room. The UI may expose runtime metadata, fields, tables, or reports for inspection, but it does not create a qualification claim. `TODO: frontend support` applies to validation workflow authoring and report publication unless a specific control is named. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Validation is not a standalone Python constructor unless the linked case page names one. Reproduce the exact case, inputs, device, precision, and receipt described by the page; use the referenced API pages for callable signatures.

## Physics and bibliography scope

The page either states the governing benchmark model or delegates it to the linked physics/numerical-methods page. Any missing derivation is a documented boundary, not an implicit equation. Bibliography and source evidence remain the authoritative references listed by the validation case.
## Source-code index

- No standalone implementation function is introduced by this validation page. Source evidence is the exact API, managed recipe, runtime manifest, and receipt named by the validation case.

