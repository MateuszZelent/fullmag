# FDM Generalized Oersted From Prescribed Current

- Status: implemented (CPU reference FDM + native CUDA FDM)
- Owners: Fullmag core
- Last updated: 2026-04-18
- Related ADRs: `docs/adr/0003-stno-v1-fdm-only.md`
- Related specs: `docs/specs/capability-matrix-v0.md`, `docs/specs/problem-ir-v0.md`

## 1. Problem statement

After `0850`, native FEM can execute general
`OerstedField(model="from_current_solution", source="...")` for non-cylindrical
`CurrentTransport(model="prescribed_density")` sources. FDM still only executes the exact
cylindrical reduction.

This note closes the corresponding public FDM slice for the current single-body FDM planner:

- executable now on CPU FDM reference and native CUDA FDM:
  - `OerstedField(model="from_current_solution", source="...")`
  - for `CurrentTransport(model="prescribed_density")`
  - even when the source region is non-cylindrical,
  - via midpoint Biot-Savart evaluation on FDM cell centers,
- still deferred:
  - `CurrentTransport(model="ohmic_poisson")`,
  - multi-body or hybrid current transport,
  - a contact-aware current solve,
  - waveform-rich non-analytic transport sources.

The exact cylinder lowering from `0840` remains preferred whenever the source region is cylindrical
and axis-aligned.

## 2. Physical model

### 2.1 Governing equations

For prescribed transport, the Oersted field remains

$$
\mathbf{H}_{\mathrm{oe}}(\mathbf{x})
= \frac{1}{4\pi}
\int_{\Omega_J}
\frac{\mathbf{J}(\mathbf{x}') \times (\mathbf{x} - \mathbf{x}')}{\|\mathbf{x} - \mathbf{x}'\|^3}
\, dV'.
$$

For non-cylindrical FDM sources, Fullmag now uses a midpoint Riemann-sum realization over active
source cells:

$$
\mathbf{H}_{\mathrm{oe}}(\mathbf{x}_i)
\approx \frac{1}{4\pi}
\sum_{c \in \Omega_J}
\frac{\mathbf{J}_c \times (\mathbf{x}_i - \mathbf{x}_c)}{(\|\mathbf{x}_i - \mathbf{x}_c\|^2 + a_c^2)^{3/2}}
V_c,
$$

where $\mathbf{x}_c$ is the source-cell center, $V_c = \Delta x\Delta y\Delta z$, and
$a_c = (3V_c/4\pi)^{1/3}$ is an equivalent-sphere regularization radius that removes the singular
self-contribution.

For cylindrical source regions with axis-aligned current density, the planner still uses the exact
infinite-cylinder reduction instead of this midpoint fallback.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{J}$ | charge-current density | A/m^2 |
| $\mathbf{H}_{\mathrm{oe}}$ | Oersted field | A/m |
| $\mathbf{x}_i$ | destination cell-center position | m |
| $\mathbf{x}_c$ | source cell-center position | m |
| $V_c$ | source cell volume | m^3 |
| $a_c$ | equivalent-sphere regularization radius | m |
| $\Delta x,\Delta y,\Delta z$ | FDM cell sizes | m |

### 2.3 Assumptions and approximations

1. The current public FDM path still assumes a single realized body / grid plan.
2. General `from_current_solution` remains limited to `CurrentTransport(model="prescribed_density")`.
3. The source region is represented by the active FDM cells of the current single-body solve region.
4. The midpoint Biot-Savart realization is approximate and not a solved current-contact model.
5. Cylindrical exact lowering still wins whenever applicable.
6. The added Oersted field enters FDM execution as a planner-resolved per-cell field, not as a new public authoring construct.
7. The current public FDM planner rejects this generalized midpoint path above a finite active-source-cell threshold, because the bootstrap realization is explicitly `O(N^2)` in planner cost.

## 3. Numerical interpretation

### 3.1 FDM

- Exact cylindrical source path:
  - unchanged,
  - still lowered to analytic `OerstedCylinder` plan fields.
- General prescribed-density source path on FDM:
  - planner computes per-cell `H_oe(x)` on the realized FDM grid,
  - CPU reference and native CUDA runners inject that field as an additive per-cell effective-field contribution,
  - `H_OE` becomes available through the FDM observables and field selection contract.

For CPU FDM step reports, both `EvaluationRequest::Minimal` and `EvaluationRequest::Full` include
the Oersted contribution in `H_eff`, RHS, and torque metrics. The current FDM scalar energy
decomposition does not publish a separate Oersted energy term.

### 3.2 FEM

- No change; `0850` remains the authoritative note for general prescribed-current Oersted on native FEM.

### 3.3 Hybrid

- No hybrid current solve or hybrid Oersted realization is added here.

## 4. API, IR, and planner impact

### 4.1 Python API surface

No public Python API shape changes are required. Existing authoring becomes newly executable on FDM:

```python
CurrentTransport(name="drive", model="prescribed_density", current_density=(1e11, 0, 0), solve_region="wire")
OerstedField(model="from_current_solution", source="drive")
```

### 4.2 ProblemIR representation

Canonical `ProblemIR` remains unchanged.

Plan-level impact:

- `FdmPlanIR` gains a plan-only optional `oersted_field_xyz` per-cell field for generalized FDM lowering.

### 4.3 Planner and capability-matrix impact

- FDM CPU reference and native CUDA production now advertise general prescribed-density `from_current_solution` as executable.
- The exact cylinder path remains the preferred realization and should be visible in provenance.
- `ohmic_poisson` remains `semantic_only`.

## 5. Runtime, artifacts, and provenance impact

### 5.1 Runtime / session impact

- No new runtime family is introduced.
- FDM runners now carry a distinct `oersted_field` / `H_OE` observable when generalized lowering is active.

### 5.2 Artifact contract

- Existing `current_transport/<name>.json` artifacts remain the provenance source for the drive.
- No new standalone Oersted artifact is added by this slice.

### 5.3 Provenance impact

Provenance should preserve whether FDM used:

1. `infinite_cylinder`, or
2. `biot_savart_midpoint`.

## 6. Validation strategy

### 6.1 Analytical checks

1. Cylindrical exact lowering still wins for cylindrical source regions.
2. A non-cylindrical source generates a non-zero circulatory field with the correct handedness around current flow.
3. Self-contribution regularization keeps the field finite on source cells.

### 6.2 Cross-backend checks

1. The same non-cylindrical prescribed-density authoring is now legal on CPU-reference FDM and native FEM.
2. FDM and FEM both report the realization as midpoint Biot-Savart for non-cylindrical sources when they execute.

### 6.3 Regression tests

1. Planner test for non-cylindrical FDM `from_current_solution` lowering.
2. CPU FDM runner test proving the generalized Oersted field reaches observables / effective field.
3. Engine test proving Oersted-only full step observables preserve the same field/RHS/torque
   metrics as minimal evaluation.
4. Capability-matrix updates.

## 7. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend (CPU reference + native CUDA)
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 8. Known limits and deferred work

1. `CurrentTransport(model="ohmic_poisson")` remains deferred.
2. Multi-body FDM current transport remains outside the current public executable slice.
3. Midpoint Biot-Savart does not include finite-contact or finite-conductor-end corrections.
4. The current bootstrap midpoint realization is intentionally capped by active source-cell count to keep planner cost honest.
5. Time-dependent generalized `from_current_solution` is still not modeled; only the exact cylindrical path carries an explicit envelope today.

## 9. References

1. `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`
2. `docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md`
