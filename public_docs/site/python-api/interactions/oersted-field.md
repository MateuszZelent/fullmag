---
title: Oersted field Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Oersted field

(oersted-api-problem-statement)=
## Problem statement

The source must name a current-transport solution; an unlinked Oersted field is rejected.

This page covers the Python authoring contract: construction validates the required current-transport source identifier, field reconstruction model, and optional interaction ID in Python, while `to_ir()` emits the canonical `ProblemIR` record before planner binding.

(python-api-interactions-oersted-field-governing-equations)=
## Governing equations

Solved-current Oersted magnetostatics reconstructs $\mathbf{H}_{\mathrm{oe}}(\mathbf{x})$ solving $\nabla\times\mathbf{H}_{\mathrm{oe}} = \mathbf{J}_c$ ($\nabla\cdot\mathbf{H}_{\mathrm{oe}} = 0$) via Biot–Savart integration or magnetic vector potential $\mathbf{B}_{\mathrm{oe}} = \nabla\times\mathbf{A}$ driven by a divergence-free current-transport solution `source`. Continuum equations and circuit-closure requirements are documented in {doc}`../../physics/interactions/oersted-field/index`.

(python-api-interactions-oersted-field-symbols-and-si-units)=
## Symbols and SI units

The authoring arguments (`source`, `model`, `id`) are dimensionless identifiers ($1$). The referenced charge current density $\mathbf{J}_c$ uses $\mathrm{A\,m^{-2}}$, and the reconstructed Oersted field $\mathbf{H}_{\mathrm{oe}}$ uses $\mathrm{A\,m^{-1}}$.

(python-api-interactions-oersted-field-assumptions-and-validity)=
## Assumptions and validity

`source` must be a non-empty string identifying an upstream current-transport solution (an unlinked Oersted field is rejected), `model` specifies a supported field reconstruction model (`"from_current_solution"`), and `id` must be non-empty when supplied. Unlinked or non-conservative current sources fail closed during authoring or planning.

(python-api-interactions-oersted-field-python-api)=
## Python API

### Constructor or function

`fm.OerstedField(source, model="from_current_solution", id=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `source` | `str` | `required` | $1$ | non-empty current transport source | current solution identifier | FEM/FDM CPU/GPU: IR; solved transport runtime required | `source` |
| `model` | `str` | `from_current_solution` | $1$ | current source model | field reconstruction model | FEM/FDM CPU/GPU: IR; solved transport runtime required | `model` |
| `id` | `str or None` | `None` | $1$ | non-empty when supplied; otherwise derived | stable interaction identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `id` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
# Author the documented object after the stage exists.
value = fm.OerstedField(source="ohmic")
canonical_ir = value.to_ir()
```

In a complete simulation script, link `fm.OerstedField(source=...)` to an authored current-transport module and register it on the study.

(python-api-interactions-oersted-field-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "oersted_field", "id": ..., "model": "from_current_solution", "source": ...}` referencing the current solution identifier.

(python-api-interactions-oersted-field-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves `source`, `model`, and interaction `id` in `ProblemIR` independently of `resolved execution`. `Validation errors` reject empty or missing `source` arguments, while `unsupported combinations` (such as solved-current Oersted evaluation on backends or devices lacking RT0 / $H(\mathrm{curl})$ transport coupling) fail closed at planning.

(python-api-interactions-oersted-field-discrete-realization)=
## Discrete realization

The Python contract supplies transport linkage and reconstruction mode in `ProblemIR` only; evaluating Biot–Savart quadrature or $H(\mathrm{curl})$ vector-potential solves from solved current densities is owned by the solver backends.

(python-api-interactions-oersted-field-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class OerstedField`). Constructor parameters, source-link validation, defaults, and `to_ir()` keys come directly from that module.

(python-api-interactions-oersted-field-validation)=
## Validation

Focused repository unit tests covering `OerstedField` IR lowering and source validation include `test_oersted_field_from_current_solution_serializes_to_ir` and `test_oersted_field_requires_current_transport_source`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-oersted-field-limitations)=
## Limitations and Control Room

Control Room has no dedicated form editor for `fm.OerstedField`; author solved-current Oersted links in Python scripts and verify backend support via session capability reports. See {doc}`/frontend/capability-register`.

(python-api-interactions-oersted-field-scientific-bibliography)=
## Scientific bibliography

- R. Hertel and A. Kákay, “Hybrid finite-element/boundary-element method to calculate Oersted fields,” *Journal of Magnetism and Magnetic Materials* **369**, 189–196 (2014), [doi:10.1016/j.jmmm.2014.06.047](https://doi.org/10.1016/j.jmmm.2014.06.047) | [arXiv:0804.4010](https://arxiv.org/abs/0804.4010).
- J. D. Jackson, *Classical Electrodynamics*, 3rd ed., Wiley (1998).

(python-api-interactions-oersted-field-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class OerstedField` | public constructor and IR lowering |
