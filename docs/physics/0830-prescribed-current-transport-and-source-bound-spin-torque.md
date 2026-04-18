# Prescribed Current Transport And Source-Bound Spin Torque

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-04-18
- Related ADRs: `docs/adr/0003-stno-v1-fdm-only.md`
- Related specs: `docs/specs/capability-matrix-v0.md`, `docs/specs/problem-ir-v0.md`

## 1. Problem statement

Fullmag needs a first-class current-transport module that can:

1. represent prescribed charge-current density without pretending a transport solver already exists,
2. bind that prescribed `J(x)` to torque authoring without duplicating the same current vector across multiple terms,
3. write `J(x)` as an explicit artifact so STNO and device-level workflows preserve requested current-drive provenance,
4. leave room for future `ohmic_poisson` transport without breaking the public API again.

The executable scope of this note is intentionally narrow:

- executable now on the public FDM path: `CurrentTransport(model="prescribed_density")`,
- semantic-only now: `CurrentTransport(model="ohmic_poisson")`,
- executable now for torque coupling on the public FDM path: `SlonczewskiSTT` and `ZhangLiSTT` may consume `current_source=...`,
- semantic-only now for current-source coupling: `InterfaceCppSTT`, `DriftDiffusionSpinTorque`, `SpinOrbitTorque`,
- superseded in part by `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md` for:
  - public FEM CPU `CurrentTransport(model="prescribed_density")`,
  - `OerstedField(model="from_current_solution")` from cylindrical prescribed sources.
- superseded in part by `docs/physics/0850-native-fem-stt-and-generalized-oersted-from-prescribed-current.md` for:
  - native FEM CPU/GPU execution of source-bound `SlonczewskiSTT` and `ZhangLiSTT`,
  - native FEM CPU/GPU generalized `from_current_solution` beyond the cylindrical exact reduction.

## 2. Physical model

### 2.1 Governing equations

For the minimal executable slice, current transport is a prescribed field:

$$
\mathbf{J}(\mathbf{x}, t) = \mathbf{J}_0(\mathbf{x}) f(t),
$$

with the current public implementation restricted to a spatially uniform, time-independent density inside the solved magnetic region:

$$
\mathbf{J}(\mathbf{x}, t) = \mathbf{J}_0.
$$

Torque models may consume `J` through a named source binding instead of embedding the vector directly in the torque payload. For the executable public subset, the resulting torque laws are still the prescribed Slonczewski and Zhang-Li forms:

$$
\boldsymbol{\tau}_\mathrm{Slonc}
= \sigma(J, P, \Lambda)\,\mathbf{m} \times (\mathbf{m} \times \hat{\mathbf{p}})
+ \sigma'(J, \varepsilon')\,\mathbf{m} \times \hat{\mathbf{p}},
$$

$$
\boldsymbol{\tau}_\mathrm{ZL}
= -(\mathbf{u}\cdot\nabla)\mathbf{m}
+ \beta\,\mathbf{m}\times(\mathbf{u}\cdot\nabla)\mathbf{m}.
$$

The future semantic-only `ohmic_poisson` path would instead derive `J` from electric potential:

$$
\nabla \cdot \left( \sigma \nabla \phi \right) = 0,
\qquad
\mathbf{J} = -\sigma \nabla \phi.
$$

That solver is not implemented by this change.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{J}$ | charge-current density | A/m^2 |
| $\mathbf{J}_0$ | prescribed current density | A/m^2 |
| $f(t)$ | current envelope | dimensionless |
| $\phi$ | electric potential | V |
| $\sigma$ | electrical conductivity | S/m |
| $\mathbf{m}$ | reduced magnetization | dimensionless |
| $\hat{\mathbf{p}}$ | spin-polarization axis | dimensionless |
| $P$ | spin-polarization degree | dimensionless |
| $\Lambda$ | Slonczewski asymmetry | dimensionless |
| $\varepsilon'$ | field-like CPP coefficient | dimensionless |
| $\beta$ | Zhang-Li non-adiabaticity | dimensionless |

### 2.3 Assumptions and approximations

1. `prescribed_density` is spatially uniform over the executable magnetic solve region.
2. The current public executable path is time-independent; no waveform or contact solve is introduced here.
3. The current-density artifact is recorded on the FDM grid as provenance data, not as a live preview quantity.
4. Source-bound torque resolves to the same legacy executable fields already used by the FDM runners.
5. `ohmic_poisson` semantics are public, but contacts, conductivity tensors, and solved `J(x)` remain deferred.
6. `OerstedField(model="from_current_solution")` is specified separately in `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`; this note remains the canonical source for source-bound torque semantics.

## 3. Numerical interpretation

### 3.1 FDM

- `CurrentTransport(model="prescribed_density")` is planner-executable on the public FDM lane.
- The planner resolves the named source to a uniform `current_density` vector for the current executable STT bridge.
- The runner writes an auxiliary artifact with full-grid `values`, zeroing inactive cells where an FDM active mask exists.
- `CurrentTransport(model="ohmic_poisson")` is rejected as semantic-only.
- `AntennaFieldSource` remains non-executable on the public FDM time-domain lane and must fail explicitly rather than being silently ignored.

### 3.2 FEM

- `CurrentTransport` semantics are legal in canonical authoring and `ProblemIR`.
- The original public FEM-planner rejection described here has been partially superseded:
  - `CurrentTransport(model="prescribed_density")` is now executable on FEM CPU as an artifact-backed provenance module,
  - `CurrentTransport(model="ohmic_poisson")` remains `semantic_only`.
- `AntennaFieldSource` remains the existing executable FEM-only current module family for RF antenna workflows.

### 3.3 Hybrid

- No hybrid executable transport path is added here.
- Hybrid transport, current-to-Oersted coupling, and device-level co-simulation remain deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

New public module:

```python
CurrentTransport(
    name="drive",
    model="prescribed_density",
    current_density=(0.0, 0.0, 5e10),
)
```

Semantic-only placeholder:

```python
CurrentTransport(
    name="transport",
    model="ohmic_poisson",
    solve_region="pillar",
    conductivity_s_per_m=4e6,
)
```

Torque-family authoring may now use either:

- inline prescribed density:
  - `SlonczewskiSTT(current_density=(...), ...)`
  - `ZhangLiSTT(current_density=(...), ...)`
- named source binding:
  - `SlonczewskiSTT(current_source="drive", ...)`
  - `ZhangLiSTT(current_source="drive", ...)`

Authoring rules:

1. `current_density` and `current_source` are mutually exclusive on a single torque module.
2. A named `current_source` must reference a `CurrentTransport` module, not an antenna module.
3. `CurrentTransport.name` shares the same uniqueness scope as other `current_modules`.

### 4.2 ProblemIR representation

Canonical IR adds:

```json
{
  "current_modules": [
    {
      "kind": "current_transport",
      "name": "drive",
      "model": "prescribed_density",
      "current_density": [0.0, 0.0, 5e10]
    }
  ]
}
```

Torque-family IR variants may now carry:

- `current_density` inline, or
- `current_source` as a named reference.

Validation rules:

1. exactly one of inline current or source reference must be provided for source-bindable torque variants,
2. `current_source` must reference an existing `CurrentTransport`,
3. `excitation_analysis.source` remains antenna-only and must not point at `CurrentTransport`,
4. `ohmic_poisson` may exist semantically in IR but is planner-rejected on all current executable public lanes.

### 4.3 Planner and capability-matrix impact

Planner behavior after this change:

- FDM lane:
  - `CurrentTransport(prescribed_density)` -> executable, artifact-backed, source-bindable,
  - `CurrentTransport(ohmic_poisson)` -> rejected as `semantic_only`,
  - `SlonczewskiSTT` / `ZhangLiSTT` with `current_source` -> executable bridge if the source resolves to `prescribed_density`,
  - `AntennaFieldSource` -> explicit rejection on the public FDM time-domain lane.
- FEM lane:
  - `AntennaFieldSource` remains the executable RF/current-module family for excitation workflows,
  - `CurrentTransport(prescribed_density)` is now executable on FEM CPU as provenance-bearing current transport,
  - `CurrentTransport(ohmic_poisson)` remains rejected as `semantic_only`,
  - native FEM CPU/GPU STT execution is now covered by `0850`; the Rust FEM reference lane still rejects STT.

Status vocabulary stays:

- `semantic_only`
- `reference_executable`
- `production_executable`
- `validated`

## 5. Runtime, artifacts, and provenance impact

### 5.1 Runtime / session impact

- No new live quantity or preview channel is introduced.
- Executable FDM torque coupling still lowers to the legacy current-density fields used by the existing runners.
- Requested source-bound current intent stays visible in canonical `ProblemIR`.

### 5.2 Artifact contract

When a prescribed current transport module is present on the executable FDM path, the run writes:

- `current_transport/<name>.json`

The artifact records:

1. `kind = "current_transport"`,
2. `model`,
3. `unit = "A/m^2"`,
4. grid layout summary,
5. full-grid vector values,
6. source-bound provenance metadata.

This artifact is auxiliary provenance data, not a standard live field-store quantity.

### 5.3 Provenance impact

Provenance must preserve:

1. the authored `CurrentTransport` module,
2. any torque `current_source` binding,
3. the resolved executable bridge to legacy FDM current-density fields,
4. the written prescribed-current artifact path.

## 6. Validation strategy

### 6.1 Analytical checks

1. Parameter-domain validation for `CurrentTransport`.
2. Exactly-one-of validation for `current_density` vs `current_source`.
3. Artifact values match the prescribed current density on active FDM cells.
4. Inactive FDM cells are zeroed in the auxiliary `J(x)` artifact.

### 6.2 Cross-backend checks

1. FDM CPU and FDM GPU should both accept `prescribed_density` authoring.
2. FEM public planners should accept `CurrentTransport(model="prescribed_density")` on CPU and keep `ohmic_poisson` as explicit `semantic_only`.

### 6.3 Regression tests

1. Python serialization and round-trip for `CurrentTransport`.
2. Planner resolution from `current_source` to executable legacy STT fields.
3. Rejection of `ohmic_poisson` on the public executable path.
4. Artifact write test for `current_transport/<name>.json`.

## 7. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [x] Capability matrix
- [x] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 8. Known limits and deferred work

1. `ohmic_poisson` is semantic-only; there is no contact solve, no potential field, and no solved `J(x)` yet.
2. `SpinOrbitTorque` current-source semantics remain public-only; no executable lowering is added here.
3. `OerstedField(model="from_current_solution")` moved to `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`.
4. Current-transport artifacts are auxiliary files, not control-room preview quantities.
5. Source-bound current coupling is currently implemented only on the single-layer public FDM time-domain path.

## 9. References

1. `docs/reports/18.04.2026/06_pola_zewnetrzne_oersted_i_transport_ladunku.mdx`
2. `docs/reports/18.04.2026/07_stt_sot_i_transport_spinu.mdx`
3. `docs/physics/0820-shared-spin-torque-family-and-stno-artifact-workflow.md`
