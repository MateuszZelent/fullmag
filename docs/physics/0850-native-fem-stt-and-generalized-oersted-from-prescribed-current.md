# Native FEM STT And Generalized Oersted From Prescribed Current

- Status: implemented
- Owners: Fullmag core
- Last updated: 2026-05-30
- Related ADRs: `docs/adr/0003-stno-v1-fdm-only.md`
- Related specs: `docs/specs/capability-matrix-v0.md`, `docs/specs/problem-ir-v0.md`

> **Normative reconciliation (2026-07-15).** This implemented-slice note
> documents legacy FEM realizations; it does not define canonical v1 signs or
> numerical production targets. Torque conventions are superseded by 0960 and
> current/Oersted coupling by 0980. The midpoint Biot–Savart realization is a
> bounded historical approximation, not the M1 production FEM target
> (`H(curl)` Nedelec vector potential plus `H1` gauge and airbox convergence).

## 1. Problem statement

Fullmag already has canonical public semantics for:

1. `SlonczewskiSTT` and `ZhangLiSTT`,
2. `CurrentTransport(model="prescribed_density")`,
3. `OerstedField(model="from_current_solution", source="...")`.

Before this executable slice, the gap was not in authoring. It was in the public FEM execution path:

1. native FEM does not yet consume STT plan inputs,
2. `from_current_solution` only executes through an exact cylindrical reduction,
3. FEM GPU falls back whenever any `current_modules` exist, even when the transport is already planner-resolved and backend-neutral.

This note closes the minimal honest executable slice:

- executable now on native FEM CPU and GPU:
  - `SlonczewskiSTT` with one executable module,
  - `ZhangLiSTT` with one executable module,
  - both with inline `current_density` or named `CurrentTransport(model="prescribed_density")` source binding,
- executable now on native FEM CPU and GPU:
  - `OerstedField(model="from_current_solution", source="...")` for non-cylindrical prescribed-current regions,
  - through a planner-resolved midpoint Biot-Savart realization lowered to a native per-node `H_oe(x)` field,
- still deferred:
  - `CurrentTransport(model="ohmic_poisson")`,
  - `InterfaceCppSTT`, `DriftDiffusionSpinTorque`, `SpinOrbitTorque`,
  - general FDM Biot-Savart from arbitrary or transport-solved `J(x)`,
  - Rust FEM reference-engine STT execution.

The native FEM path remains production-oriented. The trusted reference lane for STT semantics is still FDM CPU until a separate FEM-reference implementation exists.

## 2. Physical model

### 2.1 Governing equations

The solved magnetization dynamics remains the LLG equation with additive torque density
contributions:

$$
\frac{\partial \mathbf{m}}{\partial t} =
-\gamma_0\, \mathbf{m} \times \mathbf{H}_\mathrm{eff}
+ \alpha\, \mathbf{m} \times \frac{\partial \mathbf{m}}{\partial t}
+ \boldsymbol{\tau}_\mathrm{STT}.
$$

For canonical Slonczewski v1, the Gilbert-source torque is

$$
\mathbf T_{\mathrm{Slonc},G}
= \Omega_J\left[
\epsilon(\mathbf m\cdot\hat{\mathbf p})\,\mathbf m\times(\mathbf m\times\hat{\mathbf p})
+\epsilon'\,\mathbf m\times\hat{\mathbf p}
\right],
$$

with

$$
\Omega_J
= \frac{\gamma_e\hbar J_n}{2 e M_s d},
\qquad
\epsilon(c)=\frac{P \Lambda^2}{(\Lambda^2 + 1) + (\Lambda^2 - 1)c}.
$$

Here $J_n=\mathbf J_c\cdot\hat n_\mathrm{stack}$ is signed. The displayed
torque bases are interpreted as a Gilbert source and receive the single
canonical conversion from 0960; no `abs(J)` or extra `mu0` is permitted.

For canonical Zhang-Li v1, the Gilbert-source torque is

$$
\mathbf T_{\mathrm{ZL},G}
= -(\mathbf u\cdot\nabla)\mathbf m
+\beta\,\mathbf m\times[(\mathbf u\cdot\nabla)\mathbf m],
\qquad
\mathbf{u} = \frac{g\mu_B P}{2eM_s}\,\mathbf{J}_c.
$$

Both sources receive the explicit conversion
$[\mathbf T_G+\alpha\mathbf m\times\mathbf T_G]/(1+\alpha^2)$ exactly once.

The historical `1/(1+beta^2)` behavior, where encountered, is
`formula_version=zhang_li.legacy_fullmag.v0`; it must not be silently presented
as canonical v1.

For general prescribed current transport, the Oersted field is

$$
\mathbf{H}_{\mathrm{oe}}(\mathbf{x})
= \frac{1}{4\pi}
\int_{\Omega_J}
\frac{\mathbf{J}(\mathbf{x}') \times (\mathbf{x} - \mathbf{x}')}{\|\mathbf{x} - \mathbf{x}'\|^3}
\, dV'.
$$

The public executable general FEM slice uses a midpoint finite-volume approximation over source tetrahedra:

$$
\mathbf{H}_{\mathrm{oe}}(\mathbf{x}_i)
\approx \frac{1}{4\pi}
\sum_{e \in \Omega_J}
\frac{\mathbf{J}_e \times (\mathbf{x}_i - \mathbf{x}_{c,e})}{(\|\mathbf{x}_i - \mathbf{x}_{c,e}\|^2 + a_e^2)^{3/2}}
V_e,
$$

where $\mathbf{x}_{c,e}$ is the tetrahedron centroid, $V_e$ the tetrahedron volume, and
$a_e = (3V_e / 4\pi)^{1/3}$ is an equivalent-sphere regularization radius used to avoid a singular self-contribution at nodes inside the source region.

For cylindrical prescribed-current regions, the exact infinite-cylinder reduction from
`docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`
remains preferred.

### 2.2 Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf{m}$ | reduced magnetization | dimensionless |
| $\mathbf{H}_\mathrm{eff}$ | effective field | A/m |
| $\mathbf{J}$ | charge-current density | A/m^2 |
| $\hat{\mathbf{p}}$ | spin-polarization axis | dimensionless |
| $P$ | spin-polarization degree | dimensionless |
| $\Lambda$ | Slonczewski asymmetry | dimensionless |
| $\varepsilon'$ | field-like Slonczewski coefficient | dimensionless |
| $\beta$ | Zhang-Li non-adiabaticity | dimensionless |
| $M_s$ | saturation magnetization | A/m |
| $d$ | free-layer thickness used by Slonczewski prefactor | m |
| $\mu_B$ | Bohr magneton | J/T |
| $e$ | elementary charge | C |
| $\hbar$ | reduced Planck constant | J s |
| $\mu_0$ | vacuum permeability | N/A^2 |
| $\gamma_{\mu0}$ | reduced gyromagnetic ratio used by LLG | m/(A s) |
| $\mathbf{x}_{c,e}$ | source-element centroid | m |
| $V_e$ | source-element volume | m^3 |
| $a_e$ | equivalent-sphere regularization radius | m |

### 2.3 Assumptions and approximations

1. Only one executable STT module is supported at a time on the current public FEM lane.
2. Slonczewski torque uses the existing public parameterization already shared with FDM.
3. Zhang-Li uses a P1 tetrahedral element-gradient approximation for $(\mathbf{u}\cdot\nabla)\mathbf{m}$.
4. General `from_current_solution` is planner-resolved only for `CurrentTransport(model="prescribed_density")`.
5. The generalized Oersted path in this slice is authoritative on native FEM CPU/GPU; FDM later gained its own single-body midpoint path on CPU reference and native CUDA, but that remains a planner-resolved prescribed-density slice rather than a general current-solve backend.
6. The midpoint Biot-Savart realization is an approximation, not a solved current-contact problem.
7. Native FEM CPU and GPU execute the same lowered semantics; GPU is no longer blocked merely by prescribed current transport.
8. Rust FEM reference execution still rejects STT and should not be described as a public executable STT lane.

## 3. Numerical interpretation

### 3.1 FDM

- FDM semantics remain unchanged by this historical FEM slice.
- `SlonczewskiSTT` and `ZhangLiSTT` remain executable on CPU reference and GPU production lanes.
- As subsequently documented by 0860, FDM also has a bounded, single-body,
  source-count-capped midpoint Biot-Savart bootstrap for non-cylindrical
  `prescribed_density`; it is distinct from the exact-cylinder reduction.
- Neither historical FDM realization is the future M1 production
  `field.oersted.fdm_fft` solver, which requires conservative face-to-cell
  `J_charge` reconstruction and a cell-integrated open-boundary FFT kernel.

### 3.2 FEM

- Planner resolves executable STT families onto the native FEM CPU/GPU lane.
- Slonczewski torque is evaluated nodewise from the current plan inputs and added directly to the RHS after the standard LLG contribution. The stored direct term is the Gilbert-explicit equivalent of the corresponding Slonczewski effective field.
- Zhang-Li torque is evaluated from per-element P1 gradients of magnetization, quadrature-averaged and distributed to nodes with lumped weights, then added directly to the RHS with the explicit `(1 + alpha beta)/(1 + alpha^2)` and `(beta - alpha)/(1 + alpha^2)` factors.
- `OerstedField(model="from_current_solution")` lowers in two ordered branches:
  - exact infinite-cylinder reduction when the source region is cylindrical and axis-aligned,
  - otherwise midpoint Biot-Savart per-node field generation on the resolved FEM mesh.
- The native backend consumes either:
  - analytic cylinder parameters, or
  - a precomputed per-node `H_oe(x)` field.
- `current_transport/<name>.json` remains an artifact/provenance output on CPU and GPU native FEM runs.

### 3.3 Hybrid

- No hybrid current solve or cross-domain transport coupling is added here.
- Hybrid current transport remains deferred.

## 4. API, IR, and planner impact

### 4.1 Python API surface

The public Python API does not gain new user-facing classes in this slice.

Existing public authoring becomes newly executable on native FEM CPU/GPU:

```python
SlonczewskiSTT(current_source="drive", degree=0.4, spin_polarization=(0, 0, 1), lambda_asymmetry=1.0)
ZhangLiSTT(current_source="drive", degree=0.4, beta=0.02)
OerstedField(model="from_current_solution", source="drive")
CurrentTransport(name="drive", model="prescribed_density", current_density=(1e11, 0, 0), solve_region="wire")
```

No backend-specific public authoring knob is introduced.

### 4.2 ProblemIR representation

Canonical `ProblemIR` stays physics-first and unchanged in shape for this slice.

Plan-level changes are added only in `FemPlanIR`:

1. native FEM STT fields become executable rather than planner-rejected,
2. a plan-only per-node `oersted_field_xyz` buffer and `oersted_realization="biot_savart_midpoint"` become legal lowering targets.

This keeps backend-realization detail out of shared authoring semantics.

### 4.3 Planner and capability-matrix impact

Planner behavior after this change:

- FDM:
  - no new executable `from_current_solution` subset beyond the cylindrical exact path,
  - no capability regression.
- FEM CPU:
  - `SlonczewskiSTT` -> `production_executable`,
  - `ZhangLiSTT` -> `production_executable`,
  - `OerstedField(from_current_solution)` -> `production_executable` for prescribed-density sources, using exact cylinder lowering when available and midpoint Biot-Savart otherwise.
- FEM GPU:
  - prescribed current transport alone no longer forces CPU fallback,
  - the same STT and generalized Oersted subset is `production_executable`,
  - `AntennaFieldSource` still forces CPU fallback because the active RF current-module backend path remains CPU-only.

## 5. Runtime, artifacts, and provenance impact

### 5.1 Runtime / session impact

- No new public runtime family is added.
- Native FEM sessions now execute STT without an artificial runtime rejection.
- Requested vs resolved device remains explicit; prescribed current transport no longer triggers a blanket GPU fallback.

### 5.2 Artifact contract

Existing artifact contract stays:

- `current_transport/<name>.json`

No new standalone Oersted artifact is introduced in this slice; the realized Oersted mode is preserved through plan/provenance metadata.

### 5.3 Provenance impact

Provenance must preserve:

1. authored torque family and source binding,
2. authored `CurrentTransport`,
3. resolved FEM Oersted realization:
  - `infinite_cylinder`, or
  - `biot_savart_midpoint`,
4. whether native FEM resolved to CPU or GPU,
5. any CPU fallback caused specifically by `AntennaFieldSource`, not by prescribed current transport itself.

## 6. Validation strategy

### 6.1 Analytical checks

1. Slonczewski torque vanishes when $\mathbf{m} \parallel \hat{\mathbf{p}}$ and $\varepsilon' = 0$.
2. Slonczewski direct RHS matches the effective-field form after Gilbert conversion for nonzero $\alpha$.
3. Zhang-Li torque vanishes for spatially uniform magnetization.
4. Zhang-Li direct RHS includes the Boris-style explicit Gilbert $\alpha/\beta$ factors.
5. Midpoint Biot-Savart field preserves the expected circulation sign around a straight prescribed-current wire.
6. Cylindrical sources still select the exact cylinder realization instead of the midpoint fallback.

### 6.2 Cross-backend checks

1. FDM and FEM planner accept the same source-bound STT authoring for prescribed-density sources.
2. Native FEM CPU and GPU resolve the same plan semantics for prescribed transport + STT.
3. FEM GPU no longer falls back when the only current modules are prescribed transports.
4. `AntennaFieldSource` still forces explicit CPU fallback on FEM.

### 6.3 Regression tests

1. Planner tests for FEM STT legality and generalized Oersted lowering.
2. Runner/dispatch tests for GPU fallback narrowing.
3. Native FEM tests for Slonczewski torque execution and generalized Oersted field readback.
4. Capability-matrix/doc updates reflecting the new executable scope.

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

1. `CurrentTransport(model="ohmic_poisson")` remains `semantic_only`.
2. `InterfaceCppSTT`, `DriftDiffusionSpinTorque`, and `SpinOrbitTorque` remain `semantic_only`.
3. Multi-module torque superposition remains disallowed on the current public executable path.
4. The generalized Oersted path is a midpoint Biot-Savart approximation, not a contact-aware transport solve.
5. FDM has the bounded midpoint bootstrap from 0860, but still lacks the M1 production cell-integrated FFT realization for general conservative `J_charge(x,t)`.
6. Rust FEM reference execution still rejects STT and therefore is not the STT reference lane.

## 9. References

1. `docs/physics/0830-prescribed-current-transport-and-source-bound-spin-torque.md`
2. `docs/physics/0840-oersted-from-current-solution-and-fem-prescribed-current-transport.md`
3. `docs/reports/18.04.2026/06_pola_zewnetrzne_oersted_i_transport_ladunku.mdx`
