---
title: Modes and Spectra
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: modes-and-spectra.source-map.json and reviewed source revision 5e99782acbb7fb3f65d0cad872e102bf67733103
---

(public-docs-python-api-outputs-modes-and-spectra)=
# Modes and Spectra

(python-api-outputs-modes-and-spectra-problem-statement)=
<!-- (problem-statement)= -->
## 1. Contract and scope

This page records the eigenmode (`SaveMode`), eigenvalue spectrum (`SaveSpectrum`), and
eigensolver diagnostic (`SaveEigenDiagnostics`) output descriptors attached to `Eigenmodes`
studies.

(python-api-outputs-modes-and-spectra-governing-equations)=
<!-- (governing-equations)= -->
## 2. Governing equations

Mode and spectrum mathematics belong to {doc}`../../numerical-methods/eigensolvers/index` and
{doc}`../../numerical-methods/eigensolvers/linearized-llg`. Each returned eigenmode $(\lambda_n, \mathbf q_n)$
is reconstructed into 3D magnetization coordinates $\delta\mathbf m_n = T\mathbf q_n$ and paired
with its complex eigenvalue $\lambda_n = \sigma_n + \mathrm i\omega_n$ ($f_n = |\omega_n|/(2\pi)$).

(python-api-outputs-modes-and-spectra-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## 3. Symbols and SI units

Spectrum entries are eigenfrequencies in hertz ($\mathrm{Hz}$) and decay rates in $\mathrm{s^{-1}}$;
spatial mode fields $\delta\mathbf m_n$ are dimensionless normalized shape functions ($1$), and
optional reconstructed magnetostatic potential fields $\delta\phi_n$ carry units of amperes
($\mathrm{A}$).

(python-api-outputs-modes-and-spectra-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and validity

Mode index sets (`indices` or `branches`) must be non-negative, unique, and non-empty when
selecting explicit subsets; sample selectors (`sample_indices` or `sample_labels`) filter which
$\mathbf k$-path or bias-field sweep samples persist 3D spatial mode arrays.

(python-api-outputs-modes-and-spectra-python-api)=
<!-- (python-api)= -->
## 5. Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
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
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(stage_id="relax", algorithm="nonlinear_cg", max_steps=1000, tolT=1e-6)
study.save("spectrum")
study.save("mode", indices=[0, 1, 2])
study.stages.add_eigenmodes(count=8, target="lowest", equilibrium_source="relax")
```

(python-api-outputs-modes-and-spectra-problem-ir)=
<!-- (problem-ir)= -->
## 6. ProblemIR

`SaveMode.to_ir()`, `SaveSpectrum.to_ir()`, and `SaveEigenDiagnostics.to_ir()` emit
`eigen_mode`, `eigen_spectrum`, and `eigen_diagnostics` records inside `sampling.outputs`.

(python-api-outputs-modes-and-spectra-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is
the planner or realization result. Validation errors identify the violated domain rule, and
unsupported combinations are rejected explicitly rather than silently substituted. Duplicate or
negative mode/branch indices, an empty selection, and invalid scopes fail immediately.

(python-api-outputs-modes-and-spectra-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization

Materialization follows the native FEM modal eigensolver (`eigen/spectrum.v2.json`,
`frequency_domain/manifest.v1.json`, and binary mode/potential payloads).

(python-api-outputs-modes-and-spectra-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Implementation mapping

| Class | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Mode output | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L252) | `class SaveMode` | Spatial eigenmode selection and IR lowering |
| Spectrum output | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L231) | `class SaveSpectrum` | Eigenfrequency spectrum selection and IR lowering |
| Diagnostics output | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L340) | `class SaveEigenDiagnostics` | Modal solver residual and KSP diagnostic flags |

(python-api-outputs-modes-and-spectra-validation)=
<!-- (validation)= -->
## 10. Validation

Ownership tests compare this inventory with live signatures and `validate_eigen_outputs` in
`crates/fullmag-plan/src/validate.rs`.

(python-api-outputs-modes-and-spectra-limitations)=
<!-- (limitations)= -->
## 11. Limitations

Output availability depends on the eigensolver realization and equilibrium source.

(python-api-outputs-modes-and-spectra-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

Mode and spectrum definitions belong to {doc}`../../numerical-methods/eigensolvers/linearized-llg`.

(python-api-outputs-modes-and-spectra-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Table/field autosave and result inspection are partial; unsupported output formats remain not implemented.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Outputs` | `partial` | Submit stage draft; output resources are revised after execution |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Outputs` | `not implemented` | Python-only until implemented |

not implemented: frontend support for output parameters not rendered by the autosave/result inspectors.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: [`apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx#L247) (`EigenmodesOutputsStageInspectorPanel`).

## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Mode-field output selection and lowering. | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L252) | `class SaveMode` | Mode-field output selection and lowering. | Source-map validator and focused API tests |
| Spectrum output selection and lowering. | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L231) | `class SaveSpectrum` | Spectrum output selection and lowering. | Source-map validator and focused API tests |
| Eigen-solver diagnostic output selection and lowering. | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L340) | `class SaveEigenDiagnostics` | Eigen-solver diagnostic output selection and lowering. | Source-map validator and focused API tests |
| Planner modal output validation. | [`crates/fullmag-plan/src/validate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/validate.rs#L950) | `validate_eigen_outputs` | Validates modal output requests against study configuration. | Rust planner source |
