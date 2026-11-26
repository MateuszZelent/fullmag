---
title: Modes and Spectra
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: packages/fullmag-py/src/fullmag/model/outputs.py, crates/fullmag-plan/src/validate.rs
---

(public-docs-python-api-outputs-modes-and-spectra)=
# Modes and Spectra

(python-api-outputs-modes-and-spectra-problem-statement)=
## 1. Contract and scope

This page records the eigenmode (`fm.SaveMode`), eigenvalue spectrum (`fm.SaveSpectrum`), and
eigensolver diagnostic (`fm.SaveEigenDiagnostics`) output descriptors attached to `fm.Eigenmodes`
studies.

(python-api-outputs-modes-and-spectra-governing-equations)=
## 2. Governing equations

Mode and spectrum mathematics belong to {doc}`../../numerical-methods/eigensolvers/index` and
{doc}`../../numerical-methods/eigensolvers/linearized-llg`. Each returned eigenmode $(\lambda_n, \mathbf q_n)$
is reconstructed into 3D magnetization coordinates $\delta\mathbf m_n = T\mathbf q_n$ and paired
with its complex eigenvalue $\lambda_n = \sigma_n + \mathrm i\omega_n$ ($f_n = |\omega_n|/(2\pi)$).

(python-api-outputs-modes-and-spectra-symbols-and-si-units)=
## 3. Symbols and SI units

Spectrum entries are eigenfrequencies in hertz ($\mathrm{Hz}$) and decay rates in $\mathrm{s^{-1}}$;
spatial mode fields $\delta\mathbf m_n$ are dimensionless normalized shape functions ($1$), and
optional reconstructed magnetostatic potential fields $\delta\phi_n$ carry units of amperes
($\mathrm{A}$).

(python-api-outputs-modes-and-spectra-assumptions-and-validity)=
## 4. Assumptions and validity

Mode index sets (`indices` or `branches`) must be non-negative, unique, and non-empty unless
`all_modes=True` is requested; sample selectors (`sample_indices` or `sample_labels`) filter which
$\mathbf k$-path or bias-field sweep samples persist 3D spatial mode arrays.

(python-api-outputs-modes-and-spectra-python-api)=
## 5. Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SaveMode.field` | `str` | `"mode"` | $1$ | Non-empty | Mode field name | FEM CPU/GPU; planner checks materialization | `eigen_mode.field` |
| `SaveMode.indices` | `Sequence[int]` | `()` | $1$ | Non-negative unique | Raw mode indices | FEM CPU/GPU; planner checks materialization | `eigen_mode.indices` |
| `SaveMode.branches` | `Sequence[int]` | `()` | $1$ | Non-negative unique | Tracked branch indices | FEM CPU/GPU; planner checks materialization | `eigen_mode.branches` |
| `SaveMode.sample_indices` | `Sequence[int]` | `()` | $1$ | Non-negative unique sample indices | Select samples by numeric index | FEM CPU/GPU; planner checks materialization | `eigen_mode.sample_indices` |
| `SaveMode.sample_labels` | `Sequence[str]` | `()` | $1$ | Non-empty sample labels | Select samples by label | FEM CPU/GPU; planner checks materialization | `eigen_mode.sample_labels` |
| `SaveMode.all_modes` | `bool` | `False` | $1$ | Boolean; mutually exclusive with explicit `indices`/`branches` | Persist all computed eigenmodes | FEM CPU/GPU; planner checks materialization | `eigen_mode.all_modes` |
| `SaveSpectrum.quantity` | `str` | `"eigenfrequency"` | $1$ | Non-empty | Spectrum quantity | FEM CPU/GPU; planner checks materialization | `eigen_spectrum.quantity` |
| `SaveSpectrum.scope` | `str` | `"per_sample"` | $1$ | `global` or `per_sample` | Spectrum scope | FEM CPU/GPU; planner checks materialization | `eigen_spectrum.scope` |
| `SaveEigenDiagnostics.include_tracking` | `bool` | `True` | $1$ | Boolean | Include branch-tracking diagnostics | FEM CPU/GPU | `eigen_diagnostics.include_tracking` |
| `SaveEigenDiagnostics.include_residuals` | `bool` | `True` | $1$ | Boolean | Include coupled eigenproblem residual diagnostics | FEM CPU/GPU | `eigen_diagnostics.include_residuals` |
| `SaveEigenDiagnostics.include_overlaps` | `bool` | `True` | $1$ | Boolean | Include modal overlap matrices | FEM CPU/GPU | `eigen_diagnostics.include_overlaps` |
| `SaveEigenDiagnostics.include_tangent_leakage` | `bool` | `True` | $1$ | Boolean | Include tangent-space leakage norms | FEM CPU/GPU | `eigen_diagnostics.include_tangent_leakage` |
| `SaveEigenDiagnostics.include_orthogonality` | `bool` | `True` | $1$ | Boolean | Include modal orthogonality diagnostics | FEM CPU/GPU | `eigen_diagnostics.include_orthogonality` |

### Complete stage-first example

```python
# %% Eigenmodes with spectrum, mode, and diagnostic outputs
import fullmag as fm

nm = 1.0e-9

study = fm.study("modes_spectra_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(400 * nm, 150 * nm, 100 * nm))

film = study.geometry(fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(stage_id="relax", algorithm="nonlinear_cg", max_steps=1000, tolT=1e-6)
study.save("spectrum")
study.save("mode", indices=[0, 1, 2])
study.stages.add_eigenmodes(count=8, target="lowest", equilibrium_source="relax")
```

(python-api-outputs-modes-and-spectra-problem-ir)=
## 6. ProblemIR

`SaveMode.to_ir()`, `SaveSpectrum.to_ir()`, and `SaveEigenDiagnostics.to_ir()` emit
`eigen_mode`, `eigen_spectrum`, and `eigen_diagnostics` records inside `sampling.outputs`.

(python-api-outputs-modes-and-spectra-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is
the planner or realization result. Validation errors identify the violated domain rule, and
unsupported combinations are rejected explicitly rather than silently substituted. Duplicate or
negative mode/branch indices, an empty selection (without `all_modes=True`), and invalid scopes fail
immediately.

(python-api-outputs-modes-and-spectra-discrete-realization)=
## 8. Discrete realization

Materialization follows the native FEM modal eigensolver (`eigen/spectrum.v2.json`,
`frequency_domain/manifest.v1.json`, and binary mode/potential payloads); see
{ref}`numerical-methods-performance-fem-spectral-multiphysics`.

(python-api-outputs-modes-and-spectra-implementation-mapping)=
## 9. Implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `implemented` | Full spectrum, mode-field, branch, and diagnostic serialization. |
| FEM | GPU | `partial` | Materializes outputs on qualified GPU modal lanes (`open_airbox_k0` and single-$k$ `floquet_airbox`). |
| FDM | CPU | `unsupported` | Native modal eigensolve is FEM-only. |
| FDM | GPU | `unsupported` | Native modal eigensolve is FEM-only. |

(python-api-outputs-modes-and-spectra-validation)=
## 10. Validation

Ownership tests compare this inventory with live signatures and `validate_eigen_outputs` in
`crates/fullmag-plan/src/validate.rs`.

(python-api-outputs-modes-and-spectra-limitations)=
## 11. Limitations

Output availability depends on the eigensolver realization and equilibrium source.

(python-api-outputs-modes-and-spectra-scientific-bibliography)=
## 12. Scientific bibliography

Mode and spectrum definitions belong to {doc}`../../numerical-methods/eigensolvers/linearized-llg`.

## Control Room support

Status: Mode-field and spectrum inspection are `partial`; 3D modal overlays and planar monitor frequency projections are `implemented` (`inspection-only`), while unlisted stage output toggles remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| `SaveMode`, `SaveSpectrum`, & `SaveEigenDiagnostics` selections | `Model Explorer -> Stages -> <stage> -> Outputs` (`EigenmodesStageSpec`, `StudyStagesSpec`) | `partial` | Submit stage draft; output resources are revised after execution |
| Planar monitor definitions & frequency-domain spatial cuts | `Model Explorer -> Planar Monitors` (`PlanarMonitorSpec`, `PlanarMonitorDraftSpec`) | `partial` | Commit monitor geometry; slice overlays query planar endpoints |
| 3D eigenmode / driven response phasor & spatial profile | `3D Viewport` (`ModeVisualizationInspectorPanel`) | `inspection-only` | `real`, `imag`, `magnitude`, `phase_rotated_real` and $0\text{–}2\pi$ phase slider (`analysis.eigen.set-mode-3d-phase`) |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Outputs` | `Python-only` | Authored in Python |

```{image} /_static/images/ui/inspector-planar-monitor-and-frequency.png
:alt: Control Room Planar Monitor Inspector showing View 3D/2D switcher, Monitor ID planar_mon_core, Name Mid-Plane RF Monitor, Length unit nm, and Domain target
:align: center
:width: 100%
```

```{image} /_static/images/ui/viewport-3d-eigenmode-spatial-profile.png
:alt: 3D spatial eigenmode profile rendered in Control Room Viewport with phase projection controls
:align: center
:width: 100%
```

Output parameters outside the stage and result inspectors remain Python-only.
See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/analysis-and-frequency-domain`.
Frontend source owners: `apps/control-room/src/modules/inspector/inspectors/study/StudyStagesSpec.tsx`, `apps/control-room/src/modules/inspector/inspectors/study/stages/EigenmodesStageSpec.tsx`, `apps/control-room/src/modules/inspector/inspectors/definitions/PlanarMonitorSpec.tsx`, and `ModeVisualizationInspectorPanel`.

(python-api-outputs-modes-and-spectra-source-code-index)=
## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| Mode-field output selection and lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L252) | `class SaveMode` | Mode-field output selection and lowering | Ownership and API contract tests |
| Spectrum output selection and lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L231) | `class SaveSpectrum` | Spectrum output selection and lowering | Ownership and API contract tests |
| Eigen-solver diagnostic output selection and lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L340) | `class SaveEigenDiagnostics` | Eigen-solver diagnostic output selection and lowering | Ownership and API contract tests |
| Planner modal output validation | [`crates/fullmag-plan/src/validate.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/validate.rs#L957) | `validate_eigen_outputs` | Validates modal output requests against study configuration | Rust planner source |
