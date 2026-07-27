# Native FEM Operator Contracts and Validation

- Status: canonical numerics standard
- Owners: Fullmag core
- Last updated: 2026-07-27
- Related ADRs:
  - `docs/adr/0014-native-fem-backend-modularization.md`
- Related specs:
  - `docs/specs/native-fem-backend-architecture-v1.md`
  - `docs/specs/capability-matrix-v0.md`
- Related reports:
  - `docs/reports/16.05.2026/fullmag_fem_cpu_audit.md`
  - `docs/reports/16.05.2026/fullmag_fem_cpu_implementation_instructions.md`
  - `docs/reports/16.05.2026/fullmag_fem_cpu_validation_matrix.md`

## 1. Problem Statement

The native FEM backend must stop treating the MFEM bridge as the place where
all physics, runtime, solvers, and telemetry meet. Each interaction or solver
must have a documented contract that can be validated independently before it
is treated as production-grade.

This note defines the minimum physics and numerics standard for native FEM
operator modules.

## 2. Governing Runtime Form

Fullmag uses reduced magnetization:

```text
|m(x,t)| = 1
M(x,t) = Ms(x) m(x,t)
```

The explicit LLG path uses:

```text
dm/dt = -gamma_mu0/(1 + alpha^2)
        [m x H_eff + alpha m x (m x H_eff)]
        + tau_direct
```

For `llg_overdamped` relaxation, native FEM must disable precession explicitly:

```text
dm/dt = -gamma_mu0/(1 + alpha^2)
        [alpha m x (m x H_eff)]
        + tau_direct
```

The native runtime contract field is `precession_enabled`. It must be imported
from the planner/FFI plan, stored in native FEM runtime state, consumed by both
CPU and GPU RHS implementations, and reported as `llg_mode = precessional` or
`llg_mode = pure_damping` in provenance/startup diagnostics.

where:

- `H_eff` is in `A/m`;
- `gamma_mu0` is in `m/(A s)`;
- `tau_direct` is in `1/s`.

An interaction must choose one of two paths:

1. effective field contribution added to `H_eff`;
2. direct torque contribution added to `tau_direct`.

It must not mix those paths without an explicit derivation.

## 3. Energy to Field Contract

For an energy-derived term:

```text
dE = -mu0 integral Ms H_term . delta_m dV
```

for tangent perturbations `delta_m` with `delta_m perpendicular m`.

Every energy-derived module needs at least one finite-difference directional
derivative test:

```text
E(normalize(m + eps v)) - E(normalize(m - eps v))
---------------------------------------------------  ~=  -mu0 integral Ms H . v dV
                      2 eps
```

The tolerance must be feature-specific. Local anisotropy should be stricter
than exchange, DMI, or demag because it has no FE gradient recovery error.

## 4. Symbols and SI Units

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| magnetization | `M` | `A/m` |
| saturation magnetization | `Ms` | `A/m` |
| effective field | `H` | `A/m` |
| exchange stiffness | `A_ex` | `J/m` |
| uniaxial/cubic anisotropy | `Ku`, `Kc*` | `J/m^3` |
| interfacial DMI | `D_i` | `J/m^2` |
| bulk DMI | `D_b` | `J/m^2` for the current public convention |
| scalar magnetic potential | `u` | `A` |
| current density | `J` | `A/m^2` |
| direct torque | `tau` | `1/s` |
| solver gyromagnetic factor | `gamma_mu0` | `m/(A s)` |

If a literature formula uses `gamma` in `rad/(T s)`, the implementation note
must state how it is converted to the solver's `gamma_mu0`.

## 5. FEM Discretization Contract

The current production target is low-order P1 FEM unless a feature-specific
high-order contract says otherwise.

Polynomial order and cell topology are independent capability dimensions. The
current executable P1 path is tetrahedral. The native mixed-P1 target in
`docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md` adds canonical
`prism6`, `pyramid5`, `tet4`, `tri3`, and `quad4` contracts; it is not executable
or validated merely because all cells are first order. Unsupported topology
must reject before backend startup, without connectivity truncation or hidden
prism-to-tet conversion.

For each FEM operator, document:

- FE space for input and output;
- whether data is nodal, element, quadrature-point, or global;
- mass policy: lumped, consistent, or projected;
- material averaging policy for heterogeneous `Ms`, `A_ex`, anisotropy, and
  DMI coefficients;
- magnetic/nonmagnetic/airbox handling;
- periodic-map handling if supported;
- boundary conditions and natural boundary terms;
- setup vs apply costs.

`fe_order > 1` must remain a capability rejection until those points are true
for the affected operator.

## 6. Required Interaction Records

Every native FEM interaction module must have this record in its physics note
or module header:

```text
interaction_id:
energy:
field_or_torque:
input_units:
output_units:
FEM weak form:
boundary conditions:
material coefficient policy:
capability restrictions:
observables:
telemetry:
validation tests:
known limits:
```

No new interaction should be accepted into native FEM as "just another branch"
inside a bridge or context file.

## 7. Interaction-Specific Minimum Gates

| Interaction | Minimum gates before production qualification |
|---|---|
| Exchange | sinusoidal Laplacian, exchange energy convergence, heterogeneous `A_ex`/`Ms`, periodic continuity if PBC is enabled |
| Demag | sphere `H=-M/3`, ellipsoid or rectangular prism factors, airbox convergence, energy sign, Poisson residual and iteration telemetry |
| Zeeman | energy sign, nodal/constant field copy, time envelope refresh |
| Uniaxial anisotropy | axis normalization, easy-axis/easy-plane sign, directional derivative, per-node coefficient scaling |
| Cubic anisotropy | orthonormal axis validation, known minima, directional derivative, rotation invariance |
| DMI | separate bulk/interfacial variants, unit contract, directional derivative, chirality, spiral pitch, boundary tilt |
| Thermal | seed reproducibility, variance vs `dt`, nodal volume scaling, Boltzmann macrospin test |
| Slonczewski STT | direct `1/s` torque or effective `A/m` field derivation, current sign, `1/(Ms*t)` scaling, macrospin switching |
| Zhang-Li STT | exact explicit/Gilbert form, zero gradient test, 1D domain-wall velocity, current direction |
| Oersted | analytic cylinder field inside/outside, arbitrary-axis rotation, envelope timing |
| Magnetoelastic | prescribed-vs-coupled scope, energy derivative if energy is reported, zero-strain and uniform-strain tests |

## 8. Demag Poisson Contract

The current native FEM demag realization solves for scalar potential `u`:

```text
integral_D grad(u) . grad(v) dV = integral_Omega_m M . grad(v) dV
H_demag = -grad(u)
E_demag = -0.5 mu0 integral_Omega_m M . H_demag dV + boundary_term
```

where `boundary_term` is present only for boundary models that require it.

The module boundary must separate:

```text
space setup
boundary policy
matrix/preconditioner setup
RHS assembly
linear solve
field recovery
energy
telemetry
```

FEM GPU demag has two explicit runtime modes:

| Mode | Contract |
|---|---|
| `device_hypre_poisson` | Strict GPU demag. RHS assembly, hypre PCG/GMRES+BoomerAMG, warm-start potential, recovery `H_demag`, and demag energy stay device-resident during RK stage evaluation. |
| `hybrid_cpu_poisson` | Compatibility/debug mode only. A stage performs `D->H` magnetization transfer, CPU MFEM/Hypre Poisson, then `H->D` demag-field upload. This mode must never be silently selected for strict `study.device("gpu")`. |

Strict `device_hypre_poisson` must publish provenance:

```text
fem_execution_mode = all_in_gpu_legacy_sparse
uses_gpu_poisson = true
fem_demag_operator_mode = device_hypre_poisson
hypre_execution_policy = device
demag_residency = device
hot_loop_compute_h2d_bytes = 0
hot_loop_compute_d2h_bytes = 0
hot_loop_compute_host_sync_count = 0
```

Initial strict GPU scope is tetrahedral P1, double precision, non-periodic
shared-domain airbox Poisson with Dirichlet/Robin boundary policy. Mixed-P1,
`fe_order > 1`, periodic demag, and Fredkin-Koehler GPU demag must reject with
an actionable diagnostic until their operator contracts and validation gates
are implemented and passed.

Poisson/airbox/Robin is an executable approximation to open-boundary
magnetostatics. It is not a blanket proof of full-space demag accuracy. Release
documentation must state the airbox and boundary-condition limits.

## 9. CPU/GPU Interpretation

CPU/MFEM and GPU/CUDA may differ in:

- sparse vs partial/matrix-free assembly;
- host vs device memory layout;
- preconditioner implementation;
- reduction and projection kernels;
- precision path.

They may not differ in:

- field sign;
- energy sign;
- SI units;
- direct torque vs effective field interpretation;
- capability semantics;
- observable names;
- provenance fields.

Native FEM CPU must not require GPU residency state unless the requested mode is
an explicit interop path.

## 10. Capability and Provenance Impact

Capability documentation must distinguish:

- legal semantics in Python and `ProblemIR`;
- executable implementation on a lane;
- validated workload coverage.

Artifacts and runtime metadata for native FEM operators must preserve:

- requested and resolved engine id;
- requested device and fallback reason;
- solver policy and boundary mode where relevant;
- iteration and residual telemetry for linear solves;
- operator timing for expensive phases;
- known degradation or approximation notes.

## 11. Validation Matrix

The canonical audit matrix is:

- `docs/reports/16.05.2026/fullmag_fem_cpu_validation_matrix.md`

Long-lived implementation must keep equivalent gates in tests or benchmark
artifacts. Static source tests are acceptable only for contracts that cannot run
without an MFEM host. They do not replace numerical validation for production
qualification.

## 12. Completeness Checklist

- [ ] Each native FEM interaction has a documented energy or torque contract.
- [ ] Each energy-derived field has a directional derivative test.
- [ ] Demag has analytical and airbox convergence benchmarks.
- [ ] `fe_order > 1` is rejected until high-order support is real.
- [ ] CPU and GPU lanes share physics semantics.
- [ ] Hot paths have no avoidable heap allocation.
- [ ] Capability matrix entries distinguish executable from validated.
- [ ] Mixed-P1 lanes remain gated until topology-specific basis, quadrature,
  Jacobian, masking, operator, ABI, artifact, and managed-runtime tests pass.
- [ ] Runtime artifacts preserve operator telemetry and solver provenance.

## 13. Deferred Work

- Full high-order FEM contract.
- Production FEM GPU parity.
- FEM-BEM/FMM/Fredkin-Koehler demag alternatives.
- Full STT/SOT transport-coupled validation.
- Two-way magnetoelastic coupling.
