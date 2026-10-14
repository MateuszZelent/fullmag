---
title: Floquet Boundary Conditions
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-10-14
reviewed_revision: 5e99782acbb7fb3f65d0cad872e102bf67733103
---

# Floquet boundary conditions

(public-docs-python-api-boundary-conditions-floquet-boundary-conditions)=
(python-api-boundary-conditions-floquet-boundary-conditions-problem-statement)=
## 1. Physical problem and solver family

`fm.FloquetBC` configures Bloch/Floquet phase-twisted periodic boundary constraints across paired opposite cell boundaries for wave-vector-resolved spin-wave eigenmode (`Eigenmodes`) and steady-state frequency-response (`FrequencyResponse`) stages.

Unlike strict zero-phase periodic boundaries (`fm.PeriodicBC`), `fm.FloquetBC` couples the real and imaginary parts of the dynamic magnetization $\delta\mathbf{m}(\mathbf{r})$ and dynamic magnetostatic scalar potential $\delta\phi(\mathbf{r})$ across the unit-cell translation vector $\Delta\mathbf{r}$ via a wave-vector-dependent complex phase factor $\exp(-\mathrm{i}\,\mathbf{k}\cdot\Delta\mathbf{r})$.

(python-api-boundary-conditions-floquet-boundary-conditions-governing-equations)=
## 2. Governing equations

Across any master/slave boundary pair $(\partial\Omega_-, \partial\Omega_+)$ separated by lattice translation vector $\Delta\mathbf{r} = \mathbf{r}_+ - \mathbf{r}_-$, the Bloch-periodic boundary condition under the canonical `exp_minus_i_k_dot_delta_r` convention enforces:

```{math}
:label: eq-floquet-bloch

\delta\mathbf{m}(\mathbf{r}_- + \Delta\mathbf{r}) = \mathrm{e}^{-\mathrm{i}\,\mathbf{k}\cdot\Delta\mathbf{r}}\,\delta\mathbf{m}(\mathbf{r}_-), \qquad \delta\phi(\mathbf{r}_- + \Delta\mathbf{r}) = \mathrm{e}^{-\mathrm{i}\,\mathbf{k}\cdot\Delta\mathbf{r}}\,\delta\phi(\mathbf{r}_-)
```

In the real-split two-component tangent-plane and Poisson-airbox representation $(\Re,\Im)$, the complex phase factor $\mathrm{e}^{-\mathrm{i}\theta}$ with $\theta = \mathbf{k}\cdot\Delta\mathbf{r}$ acts as an orthogonal $2\times 2$ rotation matrix mixing the real and imaginary sub-blocks (`real_imag_mixing = true`):

```{math}
:label: eq-floquet-real-split

\begin{bmatrix} \Re\,\delta u(\mathbf{r}_+) \\ \Im\,\delta u(\mathbf{r}_+) \end{bmatrix} = \begin{bmatrix} \cos(\mathbf{k}\cdot\Delta\mathbf{r}) & \sin(\mathbf{k}\cdot\Delta\mathbf{r}) \\ -\sin(\mathbf{k}\cdot\Delta\mathbf{r}) & \cos(\mathbf{k}\cdot\Delta\mathbf{r}) \end{bmatrix} \begin{bmatrix} \Re\,\delta u(\mathbf{r}_-) \\ \Im\,\delta u(\mathbf{r}_-) \end{bmatrix}
```

When the wave-vector norm satisfies the planner $\Gamma$-point threshold $\|\mathbf{k}\|_2 \le \varepsilon_\Gamma = 10^{-12}\,\mathrm{rad\,m^{-1}}$, the off-diagonal $\sin(\mathbf{k}\cdot\Delta\mathbf{r})$ terms vanish and the constraint reduces to zero-phase periodicity.

(python-api-boundary-conditions-floquet-boundary-conditions-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\delta\mathbf{m}$ | complex dynamic magnetization amplitude | $\mathrm{1}$ |
| $\delta\phi$ | complex dynamic magnetostatic scalar potential amplitude | $\mathrm{A}$ |
| $\delta u$ | generic complex dynamic field component ($\delta\mathbf{m}$ or $\delta\phi$) | $\mathrm{1}$ |
| $\mathbf{r}_-, \mathbf{r}_+$ | paired master and slave boundary coordinates | $\mathrm{m}$ |
| $\Delta\mathbf{r}$ | periodic lattice translation vector $\mathbf{r}_+ - \mathbf{r}_-$ | $\mathrm{m}$ |
| $\mathbf{k}$ | Bloch wave vector | $\mathrm{rad\,m^{-1}}$ |
| $\theta$ | Bloch phase angle $\mathbf{k}\cdot\Delta\mathbf{r}$ across the boundary pair | $\mathrm{rad}$ |
| $\varepsilon_\Gamma$ | planner $\Gamma$-point classification threshold ($10^{-12}$) | $\mathrm{rad\,m^{-1}}$ |

(python-api-boundary-conditions-floquet-boundary-conditions-assumptions-and-validity)=
## 4. Assumptions, boundary meaning, and validity limits

| Choice | Mathematical meaning | What it does not mean |
|---|---|---|
| `fm.FloquetBC(pair_ids=("x_minus_x_plus",))` | Enforces Bloch phase twist $\mathrm{e}^{-\mathrm{i}\,\mathbf{k}\cdot\Delta\mathbf{r}}$ on paired boundaries in the 3D unit-cell formulation (`PeriodicPhasePolicyIR::BlochPhase`). | Does not eliminate the propagation axis into a 2D cross-section mesh (use `waveguide_2p5d` for 2.5D translationally invariant waveguides). |
| `phase_convention="exp_minus_i_k_dot_delta_r"` | Uses $\psi(\mathbf{r}+\Delta\mathbf{r}) = \mathrm{e}^{-\mathrm{i}\,\mathbf{k}\cdot\Delta\mathbf{r}}\psi(\mathbf{r})$ consistent with $\mathrm{e}^{\mathrm{i}(\omega t - \mathbf{k}\cdot\mathbf{r})}$. | Does not flip the sign of $\omega$ without corresponding adjustment in the real-split operator. |
| `magnetostatic_bc="floquet_airbox"` | Applies the same Bloch phase constraint (`MagnetostaticPotentialDynamic`) on the shared magnetostatic airbox lateral faces. | Does not apply open Dirichlet truncation on the periodic lateral faces. |

(python-api-boundary-conditions-floquet-boundary-conditions-python-api)=
## 5. Python API and complete parameter reference

### Constructor signature

```text
fm.FloquetBC(
    pair_ids,
    phase_convention="exp_minus_i_k_dot_delta_r",
)
```

### Stage-first example: 3D unit-cell Floquet dispersion

```python
# %%
import fullmag as fm

study = fm.study("unit_cell_floquet_dispersion")
study.objects.mesh.defaults(maximum_element_size=5.0e-9)

cell = study.geometry(fm.Box(size=(50.0e-9, 50.0e-9, 10.0e-9)), name="magnonic_cell")
cell.Ms = 800.0e3
cell.Aex = 13.0e-12
cell.alpha = 0.01
cell.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")

# %%
# Configure 3D unit-cell Floquet boundary conditions along x
floquet_bc = fm.FloquetBC(
    pair_ids=("x_minus_x_plus",),
    phase_convention="exp_minus_i_k_dot_delta_r",
)

study.stages.add_relax(stage_id="relax_eq", dt=5.0e-13, max_steps=100)
study.stages.add_eigenmodes(
    stage_id="floquet_bands",
    equilibrium_source="relax",
    count=6,
    operator="linearized_llg",
    damping_policy="include",
    k_sampling=fm.KPath(
        points=[
            fm.KPoint("Gamma", (0.0, 0.0, 0.0)),
            fm.KPoint("X", (6.283185307e7, 0.0, 0.0)),
        ],
        samples_per_segment=[8],
    ),
    bc=floquet_bc,
    magnetostatic_bc="floquet_airbox",
)

canonical_ir = floquet_bc.to_ir()
```

### Parameter reference

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `pair_ids` | `Sequence[str]` | `required` | `1` | non-empty sequence; IDs non-empty | boundary pairs carrying the Bloch phase | FEM/FDM CPU/GPU: IR; resolved support required | `pair_ids` |
| `phase_convention` | `str` | `exp_minus_i_k_dot_delta_r` | `1` | non-empty string | phase sign convention | FEM/FDM CPU/GPU: IR; resolved support required | `phase_convention` |

(python-api-boundary-conditions-floquet-boundary-conditions-problem-ir)=
## 6. ProblemIR, normalization, and provenance

`FloquetBC.to_ir()` emits the canonical `SpinWaveBoundaryConditionIR::Config` record, which the FEM planner lowers into `PeriodicConstraintSetIR` entries for both dynamic magnetization and dynamic magnetostatic scalar potential:

```json
{
  "spin_wave_bc": {
    "kind": "floquet",
    "pair_ids": ["x_minus_x_plus"],
    "phase_convention": "exp_minus_i_k_dot_delta_r"
  },
  "periodic_constraint_sets": [
    {
      "unknown_family": "magnetization_dynamic",
      "domain_scope": "magnetic_domain",
      "pair_ids": ["x_minus_x_plus"],
      "phase_policy": {
        "kind": "bloch_phase",
        "phase_convention": "exp_minus_i_k_dot_delta_r",
        "k_vector_rad_per_m": [62831853.07, 0.0, 0.0],
        "real_imag_mixing": true
      }
    }
  ]
}
```

(python-api-boundary-conditions-floquet-boundary-conditions-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

The requested intent is preserved in `ProblemIR` before resolved execution, while validation errors identify invalid inputs and unsupported combinations are rejected explicitly:

- Empty `pair_ids` or blank pair identifier strings raise `ValueError("FloquetBC requires at least one pair_id")`.
- Blank `phase_convention` strings fail closed in `FloquetBC.__post_init__`.
- Closed phase loops around intersecting periodic pairs are checked by planner phase-loop diagnostics (`frequency_response_phase_loop_diagnostics`).

(python-api-boundary-conditions-floquet-boundary-conditions-discrete-realization)=
## 8. Discrete realization and execution sequence

### 8.1 Constraint assembly

For each paired master/slave node set on `pair_ids`, the backend constructs the complex Bloch phase constraint $\mathrm{e}^{-\mathrm{i}\,\mathbf{k}\cdot\Delta\mathbf{r}}$ and eliminates slave degrees of freedom into master degrees of freedom via the $2\times 2$ real-split orthogonal rotation block.

### 8.2 FEM CPU

FEM CPU applies the real-split Bloch constraint to both the tangent-plane magnetic subspace and (when `magnetostatic_bc="floquet_airbox"`) the $H^1(\Omega_{\mathrm{ms}})$ scalar potential space.

### 8.3 FEM GPU

FEM GPU uses the same planner-validated `PeriodicConstraintSetIR` contract when assembling device or host-transferred Floquet operators.

(python-api-boundary-conditions-floquet-boundary-conditions-implementation-mapping)=
## 9. Implementation mapping

- Python DSL class: `packages/fullmag-py/src/fullmag/model/study.py` (`class FloquetBC`).
- IR types: `crates/fullmag-ir/src/execution.rs` (`SpinWaveBoundaryConditionIR`), `crates/fullmag-ir/src/plan.rs` (`PeriodicPhasePolicyIR`, `PeriodicConstraintSetIR`).
- Planner constraint lowering: `crates/fullmag-plan/src/fem.rs` (`frequency_response_periodic_constraint_sets`).

(python-api-boundary-conditions-floquet-boundary-conditions-validation)=
## 10. Validation and qualification

| Validation layer | Required check | Evidence required |
|---|---|---|
| Python $\to$ IR serialization | `test_eigenmodes_serializes_floquet_pair_ids` | Verifies `FloquetBC` lowers to `kind="floquet"` with `pair_ids` and `phase_convention`. |
| Planner constraint lowering | `PeriodicConstraintSetIR` verification | Confirms `BlochPhase` with `real_imag_mixing = true` is emitted for both magnetic and magnetostatic domains. |

(python-api-boundary-conditions-floquet-boundary-conditions-limitations)=
## 11. Limitations and failure modes

- Requiring `FloquetBC` without paired periodic mesh faces on the specified `pair_ids` fails during mesh/planner constraint validation.
- Using `FloquetBC` without a wave-vector specification (`k_sampling`) leaves the Bloch phase vector unresolved in frequency-response or modal stages.

(python-api-boundary-conditions-floquet-boundary-conditions-scientific-bibliography)=
## 12. Scientific bibliography

- F. Bloch, *Über die Quantenmechanik der Elektronen in Kristallgittern*, Z. Physik **52**, 555–600 (1929), DOI: [10.1007/BF01339455](https://doi.org/10.1007/BF01339455).
- M. Krawczyk and D. Grundler, *Review and prospects of magnonic crystals and devices with reprogrammable band structure*, J. Phys.: Condens. Matter **26**, 123202 (2014), DOI: [10.1088/0953-8984/26/12/123202](https://doi.org/10.1088/0953-8984/26/12/123202).

(python-api-boundary-conditions-floquet-boundary-conditions-source-code-index)=
## 13. Source-code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L629) | `class FloquetBC` | public constructor and IR lowering for Bloch/Floquet boundary pairs |
| [`crates/fullmag-ir/src/execution.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/execution.rs#L476) | `SpinWaveBoundaryConditionIR` | canonical IR enum for spin-wave boundary conditions |
| [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/plan.rs#L1964) | `PeriodicPhasePolicyIR` | planner IR representation of zero-phase vs Bloch-phase boundary policies |
| [`crates/fullmag-ir/src/plan.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-ir/src/plan.rs#L1980) | `PeriodicConstraintSetIR` | resolved periodic/Floquet constraint set for magnetic and magnetostatic domains |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L6504) | `frequency_response_periodic_constraint_sets` | lowers Floquet and periodic boundary conditions into planner constraint sets |
