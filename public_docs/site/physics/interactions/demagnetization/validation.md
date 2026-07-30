---
title: Validation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0910-permalloy-film-fem-demag-benchmark.md
---

(public-docs-physics-interactions-demagnetization-validation)=
# Validation

Demagnetization validation must establish physical correctness, numerical convergence, and backend
qualification separately. A source-level contract test is evidence of an implementation contract,
not proof of an executed GPU result.

(demag-validation-problem-statement)=
## Physical problem

The observable pair is the demagnetizing field and self-energy. A valid test therefore checks field
direction and magnitude, energy sign and magnitude, and the relation between them.

(demag-validation-governing-equations)=
## Governing equations

```{math}
:label: eq-demag-validation-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

```{math}
:label: eq-demag-validation-residual
r=\nabla\cdot(\mathbf H_{\mathrm d}+\mathbf M),
\qquad
\nabla\times\mathbf H_{\mathrm d}=\mathbf0.
```

(demag-validation-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $r$ | magnetic divergence residual | $\mathrm{A\,m^{-2}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |

(demag-validation-assumptions-and-validity)=
## Assumptions and validity

Every comparison must state geometry, material, grid/mesh, boundary policy, precision, solver
tolerance, and whether the device actually executed the kernel. Relative errors without absolute
scales are insufficient for near-zero fields.

(demag-validation-python-api)=
## Python API

```python
# %% Request validation observables
import fullmag as fm

term = fm.Demag(model="airbox")
outputs = [fm.SaveField("H_demag", every=1), fm.SaveScalar("E_demag", every=1)]
print(term.to_ir(), outputs)
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | Canonical model validation. | Selects realization under test. | Planner-dependent. | `energy[].realization` |
| `SaveField("H_demag")` | `str` | required | $\mathrm{A\,m^{-1}}$ | Quantity must be materializable. | Requests vector field. | Executable lane-dependent. | `outputs[].quantity` |
| `SaveScalar("E_demag")` | `str` | required | $\mathrm{J}$ | Quantity must be materializable. | Requests global energy. | Executable lane-dependent. | `outputs[].quantity` |

(demag-validation-problem-ir)=
## ProblemIR

The interaction and output requests are lowered separately. Planner validation must verify that the
selected realization can materialize `H_demag` and `E_demag` before execution.

(demag-validation-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The report records requested intent, resolved execution, validation errors, and unsupported combinations.
A missing quantity is a fail-closed planner error rather than a zero-filled result.

(demag-validation-discrete-realization)=
## Discrete realization

FDM compares cell fields and volume-weighted energy. FEM compares recovered nodal/element fields,
integrated energy, and residuals. CPU/GPU parity requires the same precision and tolerance.

(demag-validation-implementation-mapping)=
## Implementation mapping

Contract tests include `batched_demag_fft_contract.cpp`, `cuda_demag_robin_energy_contract.cpp`,
and `cuda_periodic_demag_contract.cpp`; production qualification additionally needs managed runtime
and executed-device evidence.

(demag-validation-validation)=
## Validation matrix

| Test family | Required evidence |
|---|---|
| Analytical rectangle | Demag factors and energy against an independent reference. |
| FDM tensor/FFT | Kernel symmetry, self term, padding, CPU/CUDA parity. |
| FEM airbox | Mesh and airbox convergence, Robin energy accounting, residual. |
| FEM/BEM | Surface orientation, solid-angle terms, open-boundary comparison. |
| Periodic | Image-count or periodic-class convergence and zero-mode behavior. |
| Qualification | Same tolerance, same precision, runtime identity, executed device. |

(demag-validation-limitations)=
## Limitations

Historical reports and source tests may document a no-go or partial gate. They must not be rewritten
as a production qualification claim without current evidence.

(demag-validation-scientific-bibliography)=
## Scientific bibliography

- Newell, A. J., Williams, W. and Dunlop, D. J., *Geophysical Research Letters* 21, 1994.
- FullMag validation sources: `backends/fdm/tests/` and `backends/fem/tests/` demagnetization contracts.

(demag-validation-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Validation target selection. |
| `backends/fem/cpu/mfem/interactions/demag.cpp` | `compute_demag_field_for_magnetization` | FEM production field path used by validation. |
