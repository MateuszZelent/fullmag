---
title: Modes and Spectra
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-modes-and-spectra)=
# Modes and Spectra

(python-api-outputs-modes-and-spectra-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the eigenmode, spectrum, and eigen-diagnostics outputs attached to eigenmode
studies.

(python-api-outputs-modes-and-spectra-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Mode and spectrum mathematics belong to {doc}`../../numerical-methods/eigensolvers/index`.

(python-api-outputs-modes-and-spectra-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Spectrum entries are eigenfrequencies in hertz; mode fields and diagnostics follow the eigenmode
normalization.

(python-api-outputs-modes-and-spectra-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Mode index sets must be non-negative, unique, and non-empty (raw indices or branches).

(python-api-outputs-modes-and-spectra-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| --- | --- | --- | $1$ | --- | --- | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | --- |
| `SaveMode.field` | `str` | `"mode"` | $1$ | Non-empty | Mode field name | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `eigen_mode.field` |
| `SaveMode.indices` | `Sequence[int]` | `()` | $1$ | Non-negative unique | Raw mode indices | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `eigen_mode.indices` |
| `SaveMode.branches` | `Sequence[int]` | `()` | $1$ | Non-negative unique | Tracked branch indices | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `eigen_mode.branches` |
| `SaveMode.sample_indices` | `Sequence[int] \| None` | `None` | $1$ | Non-negative unique sample indices | Select samples by numeric index | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `eigen_mode.sample_indices` |
| `SaveMode.sample_labels` | `Sequence[str] \| None` | `None` | $1$ | Non-empty sample labels | Select samples by label | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `eigen_mode.sample_labels` |
| `SaveSpectrum.quantity` | `str` | `"eigenfrequency"` | $1$ | Non-empty | Spectrum quantity | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `eigen_spectrum.quantity` |
| `SaveSpectrum.scope` | `str` | `"per_sample"` | $1$ | `global` or `per_sample` | Spectrum scope | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `eigen_spectrum.scope` |
| `SaveEigenDiagnostics.*` | `bool` | `True` | $1$ | Boolean | Diagnostic flags | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `eigen_diagnostics` |

### Complete stage-first example

```python
# %% Eigenmodes with spectrum and mode outputs
import fullmag as fm

nm = 1.0e-9

study = fm.study("modes_spectra_api_example")
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
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
study.save("spectrum")
study.save("mode", indices=[0, 1, 2])
study.stages.add_eigenmodes(count=8, target="lowest", equilibrium_source="relax")
```

(python-api-outputs-modes-and-spectra-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`SaveMode.to_ir()`, `SaveSpectrum.to_ir()`, and `SaveEigenDiagnostics.to_ir()` emit
`eigen_mode`, `eigen_spectrum`, and `eigen_diagnostics` records inside `sampling.outputs`.

(python-api-outputs-modes-and-spectra-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in ProblemIR; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Duplicate or negative mode/branch indices, an empty selection, and invalid scopes fail
immediately.

(python-api-outputs-modes-and-spectra-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Materialization follows the eigensolver; mode tracking and diagnostics are emitted when requested.

(python-api-outputs-modes-and-spectra-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/outputs.py` (`SaveMode`, `SaveSpectrum`,
`SaveEigenDiagnostics`).

(python-api-outputs-modes-and-spectra-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-outputs-modes-and-spectra-limitations)=
<!-- (limitations)= -->
## Limitations
Output availability depends on the eigensolver realization and equilibrium source.

(python-api-outputs-modes-and-spectra-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Mode and spectrum definitions belong to the eigensolver pages.

(python-api-outputs-modes-and-spectra-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Table/field autosave and result inspection are partial; unsupported output formats remain not implemented.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Autosave` | `partial` | Submit autosave draft; output resources are revised after execution |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Autosave` | `not implemented` | Python-only until implemented |

not implemented: frontend support for output parameters not rendered by the autosave/result inspectors.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/stages/AutosaveStageInspector.tsx (AutosaveStageInspector)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Eigen outputs | `packages/fullmag-py/src/fullmag/model/outputs.py` | `SaveMode`, `SaveSpectrum`, `SaveEigenDiagnostics` | Output lowering | Ownership test |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Mode-field output selection and lowering. | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveMode` | Mode-field output selection and lowering. | Source-map validator and focused API tests |
| Spectrum output selection and lowering. | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveSpectrum` | Spectrum output selection and lowering. | Source-map validator and focused API tests |
| Eigen-solver diagnostic output selection and lowering. | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveEigenDiagnostics` | Eigen-solver diagnostic output selection and lowering. | Source-map validator and focused API tests |
