---
title: Validation
status: implemented
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
The test record must also identify whether the field is cell-centred, nodal, element-recovered,
or sampled after interpolation. Comparing fields at different locations can otherwise produce an
apparently small error for the wrong reason.

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

This stage-first FDM scenario fixes the geometry, grid, precision, boundary policy, initial state,
and output cadence needed by a demagnetization validation artifact. A refinement study should rerun
the same script with successively smaller cells while preserving every other requested setting.

```python
# %% Imports and units
import fullmag as fm

nm = 1.0e-9

# %% Study and reference execution lane
study = fm.study("demag_rectangular_prism_validation")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 4 * nm))

# %% Geometry, material, state, and isolated demagnetization term
prism = study.geometry(
    fm.Box(size=(80 * nm, 40 * nm, 4 * nm), name="prism"),
    name="prism",
)
prism.Ms = 8.0e5
prism.Aex = 1.3e-11
prism.alpha = 0.02
prism.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange(enabled=False)
study.demag()
study.solver(integrator="rk4", fix_dt=5.0e-15)

# %% Ordered measurement stage
study.stages.add_run(stage_id="measure_demag", until=1.0e-12).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            t_sampl=1.0e-13,
            quantities=[
                "t",
                "mx",
                "my",
                "mz",
                "e_demag",
                "e_total",
                "max_h_demag",
            ],
        ),
        fields=[fm.FieldAutosave("H_demag", every=2.0e-13)],
    )
)
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

The validation artifact separates requested intent from resolved execution. Requested intent
contains the chosen model, mesh/grid, output quantities, tolerance, precision, and device request.
Resolved execution contains the selected backend realization, actual mesh identity, solver policy,
iteration count, convergence flag, field recovery, energy reduction, and runtime/device identity.
An artifact that omits any of these fields is not sufficient for a CPU/GPU qualification claim.

(demag-validation-discrete-realization)=
## Discrete realization

FDM compares cell fields and volume-weighted energy. FEM compares recovered nodal/element fields,
integrated energy, and residuals. CPU/GPU parity requires the same precision and tolerance.

For FDM, the reference comparison must fix cell dimensions, padding, kernel convention, FFT
normalization, self-term, and periodic-image policy. For FEM, it must fix the magnetic/air domain,
boundary marker, Robin or Dirichlet closure, mesh order, quadrature/recovery rule, linear solver,
preconditioner, relative tolerance, absolute tolerance when present, and maximum iterations.

(demag-validation-error-metrics)=
## Error metrics and acceptance

Use more than one metric:

| Quantity | Definition | Why it is required |
|---|---|---|
| Field absolute error | $|\mathbf H-\mathbf H_{\mathrm{ref}}\|_2$ | Detects errors near zero without unstable relative division. |
| Field relative error | $|\mathbf H-\mathbf H_{\mathrm{ref}}\|_2/(\|\mathbf H_{\mathrm{ref}}\|_2+H_*)$ | Compares scale after declaring positive reference floor $H_*$. |
| Energy error | $|E-E_{\mathrm{ref}}|/(|E_{\mathrm{ref}}|+E_*)$ | Tests the global reduction independently of pointwise field error. |
| Maxwell residual | Norm of $r$ and curl residual | Detects a plausible energy with an invalid field. |
| Refinement slope | Observed error versus grid/mesh scale | Distinguishes convergence from accidental agreement. |

The report must state $H_*$ and $E_*$ whenever relative metrics are used. No universal numerical
threshold is implied by this page; the threshold belongs to the qualified test or standard problem.

(demag-validation-lane-matrix)=
## Lane-specific qualification

| Lane | Minimum evidence before status can be implemented | Typical failure that must remain visible |
|---|---|---|
| FDM CPU | independent kernel/tensor checks, analytic geometry, refinement | wrong self-term, padding, or FFT normalization |
| FDM GPU | matched CPU reference, executed CUDA device identity, precision record | skipped device test or silent CPU fallback |
| FEM CPU | weak-form residual, airbox/boundary convergence, energy derivative | residual/energy mismatch or unconverged Hypre solve |
| FEM GPU | executed device operator, matched tolerance/precision, phase telemetry | host-only assembly reported as GPU parity |

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

## Control Room crosswalk

Use `Model Explorer -> Objects -> <object> -> Physics` when `PhysicsInteractionPanel` exposes the interaction. Status: `partial`. frontend support is not implemented applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Validation target selection. |
| `backends/fem/cpu/mfem/interactions/demag.cpp` | `compute_demag_field_for_magnetization` | FEM production field path used by validation. |
