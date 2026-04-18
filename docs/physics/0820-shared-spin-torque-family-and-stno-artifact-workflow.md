# Shared Spin-Torque Family And STNO Artifact Workflow

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-04-18
- Related ADRs: `docs/adr/0003-stno-v1-fdm-only.md`
- Related specs: `docs/specs/capability-matrix-v0.md`, `docs/specs/problem-ir-v0.md`

## 1. Problem statement

Fullmag needs one physics-first contract for spin-transfer and spin-orbit drive terms that:

1. preserves backward compatibility with the existing public `SlonczewskiSTT` and `ZhangLiSTT` API,
2. makes room for multilayer / interface-local and SOT variants without inventing a second semantics layer later,
3. keeps executable status explicit per backend and per torque family,
4. defines the artifact workflow required for end-to-end STNO benchmarks.

The current executable slice remains intentionally narrow:

- executable now: single-module `SlonczewskiSTT` or `ZhangLiSTT` on the FDM public path,
- executable now: `CurrentTransport(model="prescribed_density")` as a source-bound current artifact and planner bridge on the FDM public path,
- semantic-only now: `InterfaceCppSTT`, `DriftDiffusionSpinTorque`, `SpinOrbitTorque`,
- semantic-only now on FEM: all spin-torque modules,
- executable now for Oersted on the CPU FDM reference path: constant / sinusoidal / pulse envelopes,
- rejected now on the FDM public path: `PiecewiseLinear` Oersted time dependence.

## 2. Physical model

### 2.1 Governing equations

The driven micromagnetic dynamics use the LLG equation with explicit torque-family terms:

$$
\frac{\partial \mathbf{m}}{\partial t}
= -\gamma \mu_0 \mathbf{m} \times \mathbf{H}_\mathrm{eff}
+ \alpha \mathbf{m} \times \frac{\partial \mathbf{m}}{\partial t}
+ \sum_k \boldsymbol{\tau}^{(k)}_\mathrm{spin}
+ \boldsymbol{\eta}_\mathrm{th}.
$$

For the currently executable public slice:

- Slonczewski CPP torque

$$
\boldsymbol{\tau}_\mathrm{Slonc}
= \sigma(J, P, \Lambda)\,\mathbf{m} \times (\mathbf{m} \times \hat{\mathbf{p}})
+ \sigma'(J, \varepsilon')\,\mathbf{m} \times \hat{\mathbf{p}}.
$$

- Zhang-Li CIP torque

$$
\boldsymbol{\tau}_\mathrm{ZL}
= -(\mathbf{u}\cdot\nabla)\mathbf{m}
+ \beta\,\mathbf{m}\times(\mathbf{u}\cdot\nabla)\mathbf{m}.
$$

- Oersted field from a cylindrical conductor

$$
\mathbf{H}_\mathrm{Oe}(r) =
\begin{cases}
\frac{I r}{2\pi R^2}\,\hat{\boldsymbol{\varphi}}, & r \le R, \\
\frac{I}{2\pi r}\,\hat{\boldsymbol{\varphi}}, & r > R.
\end{cases}
$$

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{m}$ | reduced magnetization | dimensionless |
| $\gamma$ | gyromagnetic ratio | m/(A s) |
| $\mu_0$ | vacuum permeability | N/A^2 |
| $\mathbf{H}_\mathrm{eff}$ | effective field | A/m |
| $J$ | current density | A/m^2 |
| $I$ | current through cylindrical conductor | A |
| $P$ | spin polarization degree | dimensionless |
| $\Lambda$ | Slonczewski asymmetry | dimensionless |
| $\varepsilon'$ | field-like CPP coefficient | dimensionless |
| $\beta$ | Zhang-Li non-adiabaticity | dimensionless |
| $\hat{\mathbf{p}}$ | fixed spin-polarization direction | dimensionless |
| $R$ | conductor radius | m |
| $T$ | temperature | K |

### 2.3 Assumptions and approximations

1. Public executable FDM assumes one torque module at a time.
2. The public Slonczewski model is a bulk / uniform CPP drive over the solved magnetic body.
3. `InterfaceCppSTT` is reserved for interface-local multilayer torque semantics and is not executable yet.
4. `DriftDiffusionSpinTorque` is reserved for self-consistent spin accumulation and diffusion and is not executable yet.
5. `SpinOrbitTorque` is reserved for damping-like / field-like SOT semantics and is not executable yet.
6. The current Oersted model assumes an analytically prescribed cylindrical conductor, not a self-consistent transport solve.
7. The current STNO artifact workflow assumes that averaged magnetization scalars and optional `m` snapshots are sufficient to measure frequency, linewidth, orbit radius, and a steady-state score.

## 3. Numerical interpretation

### 3.1 FDM

- Public executable FDM lowers one torque module to the legacy scalar/vector fields already used by the runner.
- `SlonczewskiSTT` maps to `current_density`, `stt_degree`, `stt_spin_polarization`, `stt_lambda`, `stt_epsilon_prime`.
- `ZhangLiSTT` maps to `current_density`, `stt_degree`, `stt_beta`.
- More than one module is currently legal in `ProblemIR` but rejected by the planner as not executable on the public path.
- Oersted uses the analytic cylindrical field profile and is recorded through the same time-evolution artifact path as other fields and scalars.

### 3.2 FEM

- Torque-family authoring is kept legal in `ProblemIR`, but the current public FEM planner treats all `spin_torque_modules` entries as semantic-only.
- This preserves one canonical semantics layer while keeping runtime claims honest.
- Future FEM realizations may lower:
  - uniform CPP bulk torque,
  - interface-local CPP torque,
  - self-consistent drift-diffusion or ohmic transport to torque couplings.

### 3.3 Hybrid

- Hybrid semantics remain deferred.
- No hybrid executable path is introduced by this change.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Public API after this change:

- legacy-compatible:
  - `Problem(..., spin_torque=SlonczewskiSTT(...))`
  - `Problem(..., spin_torque=ZhangLiSTT(...))`
- canonical family:
  - `Problem(..., spin_torques=[...])`
- source-bound current authoring:
  - `CurrentTransport(name="drive", model="prescribed_density", current_density=(...))`
  - `SlonczewskiSTT(..., current_source="drive")`
  - `ZhangLiSTT(..., current_source="drive")`

New semantic-only public placeholders:

- `InterfaceCppSTT`
- `DriftDiffusionSpinTorque`
- `SpinOrbitTorque`

Authoring rules:

1. `spin_torque=` and `spin_torques=` are mutually exclusive.
2. Legacy single-module authoring is normalized into the canonical `spin_torques` list.
3. Single executable legacy modules still emit the legacy flattened fields for current runner compatibility.
4. Multi-module authoring emits only `spin_torque_modules` and does not pretend to be representable by the legacy flat fields.

### 4.2 ProblemIR representation

Canonical IR now includes:

```json
{
  "spin_torque_modules": [
    { "kind": "slonczewski", "...": "..." }
  ]
}
```

Legacy flat fields remain present only as an executable bridge for the current runner:

- `current_density`
- `stt_degree`
- `stt_beta`
- `stt_spin_polarization`
- `stt_lambda`
- `stt_epsilon_prime`

Validation rules:

1. each module variant validates its own parameter domain,
2. legacy flat fields validate independently,
3. legacy flat fields cannot honestly represent more than one module,
4. planner rejects inconsistent legacy-vs-canonical payloads.

### 4.3 Planner and capability-matrix impact

Planner behavior after this change:

- FDM lane:
  - single `slonczewski` -> executable bridge,
  - single `zhang_li` -> executable bridge,
  - multiple modules -> rejected with explicit support note,
  - `interface_cpp`, `drift_diffusion`, `spin_orbit_torque` -> rejected as `semantic_only`.
- FEM lane:
  - any torque module -> rejected as `semantic_only`.

Capability status vocabulary used for this workflow:

- `semantic_only`
- `reference_executable`
- `production_executable`
- `validated`

Current truthful status:

| Feature | FDM CPU | FDM GPU | FEM CPU/GPU |
|---|---|---|---|
| `SlonczewskiSTT` | `reference_executable` | `production_executable` | `semantic_only` |
| `ZhangLiSTT` | `reference_executable` | `production_executable` | `semantic_only` |
| `InterfaceCppSTT` | `semantic_only` | `semantic_only` | `semantic_only` |
| `DriftDiffusionSpinTorque` | `semantic_only` | `semantic_only` | `semantic_only` |
| `SpinOrbitTorque` | `semantic_only` | `semantic_only` | `semantic_only` |
| `OerstedCylinder` constant/sinusoidal/pulse | `reference_executable` | `production_executable` | implementation-specific |
| `OerstedCylinder` piecewise_linear | rejected | implementation-specific | implementation-specific |

## 5. Runtime, artifacts, and provenance impact

### 5.1 Runtime / session impact

- runtime behavior is unchanged for the already executable FDM slice,
- semantic-only modules fail in planning instead of leaking to the runner,
- requested intent and resolved executable lane remain distinct.

### 5.2 Artifact contract

The canonical STNO artifact workflow uses:

1. `scalars.csv`
2. `metadata.json`
3. optional `fields/m/step_*.json`

Minimum scalar channels for the benchmark workflow:

- `time`
- `mx` as `mx_avg`
- `my` as `my_avg`
- `mz` as `mz_avg`
- `E_total`
- `max_dm_dt`

Optional field channel:

- `m` snapshots for vortex-core tracking.

Derived report metrics:

- peak frequency,
- linewidth FWHM,
- Q factor,
- mean orbit radius,
- orbit ellipticity,
- steady-state score,
- steady-state window.

### 5.3 Provenance impact

`metadata.json` and the execution plan must preserve:

1. requested backend / device / precision,
2. resolved engine,
3. torque family authoring intent in `ProblemIR`,
4. executable bridge reality in the lowered FDM plan,
5. artifact analysis parameters used for STNO summary generation.

## 6. Validation strategy

### 6.1 Analytical checks

1. Slonczewski and Zhang-Li parameter domain validation.
2. Oersted cylindrical field profile sign and scaling checks.
3. PSD peak extraction on synthetic traces with known frequency.
4. Linewidth extraction on synthetic Lorentzian PSDs.

### 6.2 Cross-backend checks

1. FDM CPU reference remains the trusted executable oracle for the current public STT slice.
2. CUDA FDM parity remains required before promoting any broader validated status.
3. FEM torque-family realizations must remain semantic-only until cross-checked and benchmarked.

### 6.3 Regression tests

Required regression coverage:

- Python round-trip for legacy and canonical torque authoring,
- planner rejection for unsupported multi-module executable requests,
- planner rejection for torque modules on FEM,
- artifact-backed STNO analysis:
  - peak frequency,
  - orbit radius,
  - steady-state detection.

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

Checklist notes:

- `Capability matrix` means the product status is now explicitly described with the four-state vocabulary and machine-readable sync artifacts.
- `Outputs / observables` means the artifact-backed STNO analysis path is defined and implemented for the current benchmark slice.
- `FEM backend` remains unchecked because torque-family execution is still semantic-only there.

## 8. Known limits and deferred work

1. Multi-module authoring is canonical but not yet executable on the public path.
2. `InterfaceCppSTT` remains semantic-only until multilayer / interface-local runtime support exists.
3. `DriftDiffusionSpinTorque` remains semantic-only until current transport and spin accumulation are modeled explicitly.
4. `SpinOrbitTorque` remains semantic-only until the public SOT executable lane exists.
5. Self-consistent `CurrentTransport` beyond `model="prescribed_density"` remains deferred; see `docs/physics/0830-prescribed-current-transport-and-source-bound-spin-torque.md`.
6. FEM periodic / eigen support must remain described by its actual current capability status and not be implied by STNO documentation.
7. Phase 5+ roadmap work such as composite free layers, NEB, and optimization are not claimed as implemented here.

## 9. References

1. J. C. Slonczewski, J. Magn. Magn. Mater. 159, L1-L7 (1996).
2. S. Zhang and Z. Li, Phys. Rev. Lett. 93, 127204 (2004).
3. A. Dussaux et al., Nat. Commun. 1, 8 (2010).
4. `docs/physics/0800-stno-vortex-mtj-physics.md`
5. `docs/physics/0810-stno-observables.md`
6. `docs/physics/stt_sign_conventions.md`
