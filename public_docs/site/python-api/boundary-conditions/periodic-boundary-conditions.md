---
title: Periodic Boundary Conditions
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

(public-docs-python-api-boundary-conditions-periodic-boundary-conditions)=
# Periodic boundary conditions

(python-api-boundary-conditions-periodic-boundary-conditions-problem-statement)=
## 1. Physical problem and solver family

`fm.PeriodicBC` configures strict zero-phase translational periodicity across paired master/slave cell boundaries (`pair_ids`) for FEM equilibrium relaxation, time-domain LLG dynamics, spin-wave eigenmodes (`Eigenmodes` at $\Gamma$), and steady-state frequency-response (`FrequencyResponse`) stages. For study-level and structured FDM periodic wrapping (exchange stencils plus periodic demagnetization image policies), Fullmag provides `study.pbc(...)` and `fm.FdmPbc`.

Unlike `fm.FloquetBC`, `fm.PeriodicBC` enforces direct equality of boundary degrees of freedom across the lattice vector $\Delta\mathbf{r}$ without real/imaginary Bloch phase mixing (`PeriodicPhasePolicyIR::ZeroPhase`).

(python-api-boundary-conditions-periodic-boundary-conditions-governing-equations)=
## 2. Governing equations

Across each paired master/slave boundary $(\partial\Omega_-, \partial\Omega_+)$ separated by lattice translation vector $\Delta\mathbf{r} = \mathbf{r}_+ - \mathbf{r}_-$, zero-phase translational periodicity enforces:

```{math}
:label: eq-periodic-continuity

\mathbf{m}(\mathbf{r}_- + \Delta\mathbf{r}, t) = \mathbf{m}(\mathbf{r}_-, t), \qquad \phi(\mathbf{r}_- + \Delta\mathbf{r}, t) = \phi(\mathbf{r}_-, t)
```

For linearized tangent-plane perturbations $\delta\mathbf{m}(\mathbf{r})$ and dynamic magnetostatic scalar potential $\delta\phi(\mathbf{r})$, the real and imaginary parts remain uncoupled across the periodic seam:

```{math}
:label: eq-periodic-linearized

\delta\mathbf{m}(\mathbf{r}_+) = \delta\mathbf{m}(\mathbf{r}_-), \qquad \delta\phi(\mathbf{r}_+) = \delta\phi(\mathbf{r}_-)
```

(python-api-boundary-conditions-periodic-boundary-conditions-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{m}$ | unit magnetization field | $\mathrm{1}$ |
| $\phi$ | magnetostatic scalar potential | $\mathrm{A}$ |
| $\delta\mathbf{m}$ | linearized dynamic magnetization amplitude | $\mathrm{1}$ |
| $\delta\phi$ | linearized dynamic magnetostatic scalar potential amplitude | $\mathrm{A}$ |
| $\mathbf{r}_-$ | master boundary coordinate | $\mathrm{m}$ |
| $\mathbf{r}_+$ | slave boundary coordinate | $\mathrm{m}$ |
| $\Delta\mathbf{r}$ | periodic lattice translation vector $\mathbf{r}_+ - \mathbf{r}_-$ | $\mathrm{m}$ |

(python-api-boundary-conditions-periodic-boundary-conditions-assumptions-and-validity)=
## 4. Assumptions, boundary meaning, and validity limits

| Choice | Mathematical meaning | What it does not mean |
|---|---|---|
| `fm.PeriodicBC(pair_ids=("x_minus_x_plus",))` | Identifies slave boundary nodes on $\partial\Omega_+$ with master boundary nodes on $\partial\Omega_-$ with zero phase twist (`ZeroPhase`). | Does not apply a nonzero Bloch wave-vector phase $\mathrm{e}^{-\mathrm{i}\,\mathbf{k}\cdot\Delta\mathbf{r}}$ (use `fm.FloquetBC` for $\mathbf{k}\neq\mathbf{0}$). |
| `magnetostatic_bc="periodic_airbox_k0"` | Enforces periodic wrap on the lateral faces of the shared magnetostatic airbox while retaining outer truncation on non-periodic faces. | Not supported on FDM FFT demag when combined with FEM-only airbox boundary options (`test_problem_to_ir_rejects_periodic_airbox_demag_for_fdm`). |
| `magnetostatic_bc="open_airbox_k0"` | Modal-only isolated body inside a Robin magnetostatic airbox (`Eigenmodes` with `include_demag=True`, `spin_wave_bc="free"`, `k_vector=(0, 0, 0)`, `damping_policy="ignore"`). | Not periodic and rejected on `FrequencyResponse` stages. |
| `fm.FdmPbc(axes, demag="open", image_counts=None)` / `study.pbc(...)` | Configures periodic axes and demag image policy (`"open"`, `"truncated_images"`, or `"periodic_airbox_k0"` with `axes=(True, True, False)`). | `image_counts`/`images` are valid only with `demag="truncated_images"`. |

(python-api-boundary-conditions-periodic-boundary-conditions-python-api)=
## 5. Python API and complete parameter reference

### Constructor signature

```text
fm.PeriodicBC(pair_ids)
fm.FdmPbc(axes, demag="open", image_counts=None)
study.pbc(x=False, y=False, z=False, *, demag="open", images=None)
```

### Stage-first example: periodic unit-cell relaxation and $\Gamma$-point modes

```python
# %%
import fullmag as fm

study = fm.study("periodic_unit_cell_modes")
study.objects.mesh.defaults(maximum_element_size=5.0e-9)

film = study.geometry(fm.Box(size=(100.0e-9, 20.0e-9, 5.0e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")

# %%
# Configure zero-phase periodic boundary conditions along x
periodic_bc = fm.PeriodicBC(pair_ids=("x_minus_x_plus",))
fdm_pbc = fm.FdmPbc(
    axes=(True, True, False),
    demag="truncated_images",
    image_counts=(4, 4, 0),
)

study.stages.add_relax(stage_id="relax_eq", dt=5.0e-13, max_steps=100)
study.stages.add_eigenmodes(
    stage_id="gamma_modes",
    equilibrium_source="relax",
    count=4,
    operator="linearized_llg",
    damping_policy="ignore",
    k_vector=(0.0, 0.0, 0.0),
    bc=periodic_bc,
    magnetostatic_bc="periodic_airbox_k0",
)

canonical_ir = periodic_bc.to_ir()
fdm_pbc_ir = fdm_pbc.to_ir()
```

### Parameter reference

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `pair_ids` | `Sequence[str]` | `required` | $1$ | non-empty sequence; IDs non-empty | paired boundary identifiers | FEM/FDM CPU/GPU: IR; resolved support required | `pair_ids` |

### Study and FDM periodic helper (`study.pbc` and `fm.FdmPbc`)

| API surface | Parameters & defaults | Validation & ProblemIR output |
|---|---|---|
| `fm.FdmPbc` | `axes: tuple[bool, bool, bool]`, `demag: str = "open"`, `image_counts: tuple[int, int, int] \| None = None` | `len(axes) == 3`; `demag` in `{"open", "truncated_images", "periodic_airbox_k0"}`; `"periodic_airbox_k0"` requires `axes == (True, True, False)`; `image_counts` requires `demag == "truncated_images"` and 3 non-negative ints; emits `{"axes": ["periodic" \| "open", ...], "demag": ..., "image_counts": ...}` |
| `study.pbc` | `x: bool = False`, `y: bool = False`, `z: bool = False`, `*, demag: Literal["open", "truncated_images", "periodic_airbox_k0"] = "open"`, `images: tuple[int, int, int] \| None = None` | configures periodic wrapping on the study and returns `StudyBuilder` for chaining |

(python-api-boundary-conditions-periodic-boundary-conditions-problem-ir)=
## 6. ProblemIR, normalization, and provenance

`fm.PeriodicBC.to_ir()` emits the canonical `kind="periodic"` record, which the planner lowers into `PeriodicConstraintSetIR` entries with `PeriodicPhasePolicyIR::ZeroPhase`:

```json
{
  "spin_wave_bc": {
    "kind": "periodic",
    "pair_ids": ["x_minus_x_plus"]
  },
  "periodic_constraint_sets": [
    {
      "unknown_family": "magnetization_dynamic",
      "domain_scope": "magnetic_domain",
      "pair_ids": ["x_minus_x_plus"],
      "phase_policy": {
        "kind": "zero_phase"
      }
    }
  ]
}
```

(python-api-boundary-conditions-periodic-boundary-conditions-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

The requested intent is preserved in `ProblemIR` before resolved execution, while validation errors identify invalid inputs and unsupported combinations are rejected explicitly:

- Empty `pair_ids` or blank pair identifier strings raise `ValueError("PeriodicBC requires at least one pair_id")`.
- Supplying `image_counts` without `demag="truncated_images"` or choosing `demag="periodic_airbox_k0"` with `axes != (True, True, False)` raises `ValueError` in `fm.FdmPbc`.
- Combining FEM-only `periodic_airbox_k0` magnetostatic boundary conditions with an FDM solver target fails closed at the IR/planner boundary (`test_problem_to_ir_rejects_periodic_airbox_demag_for_fdm`).

(python-api-boundary-conditions-periodic-boundary-conditions-discrete-realization)=
## 8. Discrete realization and execution sequence

### 8.1 Master/slave DOF identification

In FEM, conformal periodic face pairs on `pair_ids` identify slave vertices with master vertices ($u_+ = u_-$) before or during operator assembly. In FDM, periodic axes wrap finite-difference exchange stencils and use periodic dipole-tensor / FFT image summation (`truncated_images`) along the periodic directions.

### 8.2 FEM CPU

FEM CPU enforces `ZeroPhase` master/slave elimination on both the magnetic space and (for `periodic_airbox_k0`) the shared magnetostatic airbox mesh.

### 8.3 FEM GPU

FEM GPU uses the same planner-validated periodic DOF mapping across device and host-assisted operators; see {ref}`numerical-methods-performance-fem-gpu-demag` and {ref}`numerical-methods-performance-fem-spectral-multiphysics`.

### 8.4 FDM CPU

FDM CPU wraps finite-difference exchange and DMI neighbor stencils across periodic axes authored via `study.pbc(...)` / `fm.FdmPbc` and sums truncated periodic demagnetization tensor images when `demag="truncated_images"`.

### 8.5 FDM GPU

FDM GPU executes periodic exchange stencils and periodic FFT demagnetization kernels directly on CUDA using the same `fm.FdmPbc` contract.

| Backend lane | Authoring & IR | Runtime status & discretization notes |
|---|---|---|
| FEM CPU | Supported | Implemented zero-phase master/slave constraint sets on magnetic and `periodic_airbox_k0` domains. |
| FEM GPU | Supported | Partial/qualified FEM GPU periodic constraint sets and GPU demag; see {ref}`numerical-methods-performance-fem-gpu-demag`. |
| FDM CPU | Supported | Implemented periodic exchange/DMI wrap and `open` / `truncated_images` FFT demagnetization. |
| FDM GPU | Supported | Implemented CUDA periodic exchange/DMI wrap and `open` / `truncated_images` FFT demagnetization. |

(python-api-boundary-conditions-periodic-boundary-conditions-implementation-mapping)=
## 9. Implementation mapping

- Python DSL classes: `packages/fullmag-py/src/fullmag/model/study.py` (`class PeriodicBC`), `packages/fullmag-py/src/fullmag/model/problem.py` (`class FdmPbc`), and `packages/fullmag-py/src/fullmag/world.py` (`class StudyBuilder` method `pbc`).
- IR types: `crates/fullmag-ir/src/execution.rs` (`SpinWaveBoundaryConditionIR`), `crates/fullmag-ir/src/plan.rs` (`PeriodicPhasePolicyIR`, `PeriodicConstraintSetIR`).
- Planner constraint lowering: `crates/fullmag-plan/src/fem.rs` (`frequency_response_periodic_constraint_sets`).

(python-api-boundary-conditions-periodic-boundary-conditions-validation)=
## 10. Validation and qualification

| Validation layer | Required check | Evidence required |
|---|---|---|
| Python $\to$ IR serialization | `test_study_pbc_serializes_problem_ir_and_default_fem_pairs` | Verifies `fm.PeriodicBC` and `study.pbc(...)` lower to canonical `pair_ids` and `fm.FdmPbc` IR. |
| Solver legality check | `test_problem_to_ir_rejects_periodic_airbox_demag_for_fdm` | Confirms incompatible periodic airbox + FDM combinations fail closed. |

(python-api-boundary-conditions-periodic-boundary-conditions-limitations)=
## 11. Limitations and failure modes

- Non-conformal opposite boundary meshes that lack paired vertex correspondence cannot form direct periodic master/slave constraints without conformal periodic meshing.
- Nonzero wave-vector dispersion ($\mathbf{k}\neq\mathbf{0}$) requires `fm.FloquetBC` rather than `fm.PeriodicBC`.
- `magnetostatic_bc="open_airbox_k0"` applies only to isolated-body `Eigenmodes` (`spin_wave_bc="free"`, $\mathbf{k}=\mathbf{0}$, `damping_policy="ignore"`) and is rejected on `FrequencyResponse`.

(python-api-boundary-conditions-periodic-boundary-conditions-scientific-bibliography)=
## 12. Scientific bibliography

- C. Geuzaine and J.-F. Remacle, *Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities*, Int. J. Numer. Meth. Eng. **79**, 1309–1331 (2009), DOI: [10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(python-api-boundary-conditions-periodic-boundary-conditions-source-code-index)=
## 13. Source-code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L658) | `class PeriodicBC` | public constructor and IR lowering for zero-phase periodic boundary pairs |
| [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L219) | `class FdmPbc` | structured periodic axes and demag image policy contract |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py) | `class StudyBuilder` | `study.pbc(...)` study-level periodic boundary helper |
| [`crates/fullmag-ir/src/execution.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/execution.rs#L544) | `SpinWaveBoundaryConditionIR` | canonical IR enum for spin-wave boundary conditions |
| [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/plan.rs#L2139) | `PeriodicPhasePolicyIR` | planner IR representation of zero-phase vs Bloch-phase boundary policies |
| [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-ir/src/plan.rs#L2155) | `PeriodicConstraintSetIR` | resolved periodic/Floquet constraint set for magnetic and magnetostatic domains |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L7542) | `frequency_response_periodic_constraint_sets` | lowers periodic and Floquet boundary conditions into planner constraint sets |
