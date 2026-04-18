# Oersted From Current Solution And FEM Prescribed Current Transport

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-04-18
- Related ADRs: `docs/adr/0003-stno-v1-fdm-only.md`
- Related specs: `docs/specs/capability-matrix-v0.md`, `docs/specs/problem-ir-v0.md`

## 1. Problem statement

Fullmag already exposes:

1. analytic `OerstedCylinder(...)`,
2. `CurrentTransport(model="prescribed_density")`,
3. source-bound Slonczewski / Zhang-Li torque on the public FDM lane.

Two gaps remain:

1. there is no canonical `OerstedField(model="from_current_solution", source="...")` authoring path,
2. the public FEM planner still treats `CurrentTransport(model="prescribed_density")` as `semantic_only` even though the public FEM runtime can carry current-module provenance and already executes analytic Oersted-cylinder fields.

This note closes the minimal executable slice that is physically exact without inventing a general Biot-Savart or contact solver:

- executable now:
  - `OerstedField(model="from_current_solution", source="...")`
  - only when the referenced source is `CurrentTransport(model="prescribed_density")`
  - and that current transport declares a cylindrical `solve_region`,
- executable now:
  - `CurrentTransport(model="prescribed_density")` on the public FEM CPU lane as an artifact-backed provenance module,
- still not executable:
  - arbitrary non-cylindrical `from_current_solution`,
  - `CurrentTransport(model="ohmic_poisson")`,
  - FEM Zhang-Li / Slonczewski torque execution,
  - FEM GPU execution with active `current_modules`.

That specific non-cylindrical / FEM-STT limitation is partially superseded by
`docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md`,
which extends the public native FEM CPU/GPU path beyond this exact-cylinder slice.

## 2. Physical model

### 2.1 Governing equations

For a prescribed current density in a cylindrical region with axis unit vector $\hat{\mathbf{a}}$,
radius $R$, and uniform density $\mathbf{J}_0$, the executable slice requires

$$
\mathbf{J}(\mathbf{x}) = \mathbf{J}_0,
\qquad
\mathbf{J}_0 \parallel \hat{\mathbf{a}}.
$$

The total current is then

$$
I = (\mathbf{J}_0 \cdot \hat{\mathbf{a}})\,\pi R^2.
$$

For an infinitely long cylinder carrying that current, Ampere's law gives

$$
H_\varphi(r) =
\begin{cases}
\dfrac{I r}{2 \pi R^2}, & r < R, \\
\dfrac{I}{2 \pi r}, & r \ge R.
\end{cases}
$$

The minimal executable `from_current_solution` path is therefore not a new numerical field solve.
It is an exact reduction:

$$
\texttt{CurrentTransport(prescribed\_density, uniform cylindrical solve\_region)}
\Longrightarrow
\texttt{OerstedCylinder}(I, R, \mathbf{x}_c, \hat{\mathbf{a}}).
$$

No arbitrary-volume Biot-Savart integral is introduced here.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{J}$ | charge-current density | A/m^2 |
| $\mathbf{J}_0$ | prescribed uniform current density | A/m^2 |
| $\hat{\mathbf{a}}$ | cylinder axis unit vector | dimensionless |
| $R$ | cylinder radius | m |
| $I$ | total current through the cylinder | A |
| $r$ | distance from cylinder axis | m |
| $H_\varphi$ | azimuthal Oersted field | A/m |

### 2.3 Assumptions and approximations

1. The executable `from_current_solution` slice assumes a spatially uniform, time-independent current density.
2. The current-carrying region must be a canonical cylinder or translated cylinder in the shared geometry model.
3. The current density must be parallel or antiparallel to the cylinder axis within numerical tolerance.
4. The field realization is the existing infinite-cylinder Oersted model already used by FDM/FEM.
5. Non-cylindrical conductors, current crowding, contact solves, and finite-length corrections remain deferred.
6. FEM `CurrentTransport(prescribed_density)` is provenance-executable and Oersted-bindable, but not yet torque-executable.

## 3. Numerical interpretation

### 3.1 FDM

- `CurrentTransport(model="prescribed_density")` remains executable.
- `OerstedField(model="from_current_solution", source="...")` is executable if:
  - the source resolves to `prescribed_density`,
  - `solve_region` resolves to a cylindrical geometry,
  - the prescribed current density is axis-aligned.
- Planner lowering computes `(I, R, center, axis)` and reuses the existing Oersted-cylinder plan fields.
- The same `current_transport/<name>.json` artifact remains the provenance source for the drive.

### 3.2 FEM

- `CurrentTransport(model="prescribed_density")` becomes executable on the public FEM CPU lane as a provenance-bearing current module.
- The planner keeps the module in `FemPlanIR.current_modules`.
- `OerstedField(model="from_current_solution", source="...")` is executable on the FEM CPU/GPU lanes only through the same cylinder reduction described above.
- Requested FEM GPU with active `current_modules` still falls back explicitly to FEM CPU on the current public runtime.
- FEM Zhang-Li / Slonczewski torque remains non-executable because the native FEM backend does not yet expose STT inputs.

### 3.3 Hybrid

- No hybrid transport / Oersted execution path is added here.
- Cross-domain current solve and hybrid current-to-field coupling remain deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

New public energy term:

```python
OerstedField(
    model="from_current_solution",
    source="drive",
)
```

Authoring rule:

1. `source` must reference a `CurrentTransport`,
2. the referenced transport must define `solve_region`,
3. the executable subset requires that region to resolve to a canonical cylinder.

`OerstedCylinder(...)` stays public and unchanged as the direct analytic authoring path.

### 4.2 ProblemIR representation

Canonical IR adds:

```json
{
  "kind": "oersted_field",
  "model": "from_current_solution",
  "source": "drive"
}
```

Validation rules:

1. `source` must be non-empty,
2. `source` must reference an existing `CurrentTransport`,
3. planner lowering, not generic IR validation, decides whether the named transport is executable on a lane.

### 4.3 Planner and capability-matrix impact

Planner behavior after this change:

- FDM:
  - `CurrentTransport(prescribed_density)` -> executable,
  - `OerstedField(from_current_solution)` -> executable only for axis-aligned cylindrical prescribed sources,
  - `CurrentTransport(ohmic_poisson)` -> `semantic_only`.
- FEM CPU:
  - `CurrentTransport(prescribed_density)` -> executable as a provenance-bearing module,
  - `OerstedField(from_current_solution)` -> executable through cylinder reduction,
  - STT current-source binding may resolve semantically in the planner, but runtime execution remains unavailable.
- FEM GPU:
  - active `current_modules` still force explicit fallback to FEM CPU,
  - therefore current-transport-backed workflows are not public GPU-executable yet.

## 5. Runtime, artifacts, and provenance impact

### 5.1 Runtime / session impact

- No new live field-store quantity is introduced.
- `from_current_solution` lowers to the same runtime Oersted-cylinder fields already consumed by current FDM/FEM backends.
- The authored `CurrentTransport` and `OerstedField(source=...)` remain visible in canonical `ProblemIR`.

### 5.2 Artifact contract

When `CurrentTransport(model="prescribed_density")` is present on FDM or FEM CPU, the run writes:

- `current_transport/<name>.json`

The artifact remains the machine-readable source of the prescribed `J(x)` provenance.

No new standalone `oersted_from_current/*.json` artifact is introduced by this slice.

### 5.3 Provenance impact

Provenance must preserve:

1. the authored `CurrentTransport`,
2. the authored `OerstedField(model="from_current_solution", source=...)`,
3. the planner lowering to the infinite-cylinder Oersted realization,
4. any explicit FEM GPU -> FEM CPU fallback caused by active `current_modules`.

## 6. Validation strategy

### 6.1 Analytical checks

1. Cylinder-region reduction computes $I = J_z \pi R^2$ with the correct sign.
2. Non-cylindrical `solve_region` is rejected with an explicit diagnostic.
3. Off-axis prescribed current is rejected with an explicit diagnostic.

### 6.2 Cross-backend checks

1. FDM and FEM planners both accept the same cylindrical `CurrentTransport + OerstedField(source=...)` authoring shape.
2. FEM CPU writes the current-transport artifact.
3. FEM GPU still rejects or falls back explicitly when active `current_modules` are present.

### 6.3 Regression tests

1. Python serialization for `OerstedField(model="from_current_solution")`.
2. Planner test for exact lowering from prescribed cylindrical current transport to Oersted-cylinder plan fields.
3. Planner rejection tests for missing `solve_region`, non-cylindrical region, and off-axis current.
4. FEM artifact write test for `current_transport/<name>.json`.

## 7. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [x] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 8. Known limits and deferred work

1. `CurrentTransport(model="ohmic_poisson")` remains deferred.
2. Arbitrary Biot-Savart `H(\mathbf{x})` from general `J(\mathbf{x})` is now covered for the native FEM path by `0850`, but remains deferred on FDM.
3. FEM STT execution is now covered for the native FEM path by `0850`; the Rust FEM reference lane still does not execute STT.
4. FEM GPU fallback is now narrowed to `AntennaFieldSource`; prescribed current transport alone no longer forces CPU fallback.
5. Contact objects, voltage/current boundary conditions, and finite-length conductor corrections remain deferred.

## 9. References

1. `docs/physics/0830-prescribed-current-transport-and-source-bound-spin-torque.md`
2. `docs/reports/18.04.2026/06_pola_zewnetrzne_oersted_i_transport_ladunku.mdx`
