# FEM Spin-Transfer Torque

- Status: versioned native FEM CPU/CUDA operator contract; canonical GPU smoke executable, scientific qualification pending
- Last updated: 2026-08-05
- Implementation: `backends/fem/cpu/mfem/interactions/stt.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/stt_slonczewski.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/stt_zhang_li.hpp/.cpp`,
  `backends/fem/gpu/cuda/interactions/stt/stt_kernels.cu`,
  `backends/fem/gpu/cuda/integrators/rk/rk_zhang_li_torque.cu`
- Test: `backends/fem/tests/stt_contract.cpp`
- Shared sign reference: `docs/physics/stt_sign_conventions.md`

## Pole / torque

Spin-transfer torque is a direct `dm/dt` contribution. It is not stored in
`H_eff`. For torque families that are often written as effective fields,
Fullmag stores the algebraically equivalent explicit Gilbert RHS term in
`tau_direct`.

The executable native FEM CPU module currently supports:

- Slonczewski CPP torque in `stt_slonczewski.hpp/.cpp`;
- Zhang-Li CIP torque in `stt_zhang_li.hpp/.cpp`.

`add_stt_rhs_aos(...)` is called after the ordinary LLG field RHS has been
assembled and updates `max_rhs` when a torque changed the RHS. The explicit RK
hot path passes a reusable `SttWorkspace` from `rk_stepper_workspace.hpp`, so
the aggregate does not copy the full LLG RHS or allocate a temporary Zhang-Li
RHS while evaluating one stage.

Aggregate ownership: `stt.hpp/.cpp` owns plan import, single-family validation,
family dispatch, reusable `SttWorkspace` routing, and aggregate `max_rhs`
refresh. It does not define Slonczewski CPP torque, Zhang-Li CIP torque,
CPP thickness/current physics, or CIP gradient projection; those semantics stay
in `stt_slonczewski.hpp/.cpp` and `stt_zhang_li.hpp/.cpp`.

Plan storage ownership: `SttRuntimeState` stores executable STT family and
formula/operator/realization versions, signed current density, target masks,
Zhang-Li `degree`/`beta`/Landé factor, and Slonczewski polarization,
`n_stack`, asymmetry, independent field-like coefficient, and free-layer
thickness. `Context` contains this owner as `ctx.stt` and does not own flat STT
plan fields directly.

## Slonczewski CPP

For `slonczewski.fullmag.v2` with realization
`slonczewski_thin_layer_homogenized.v1`, the local Gilbert source is

```text
J_n = J dot n_stack
epsilon(c) = P Lambda^2 / [(Lambda^2 + 1) + (Lambda^2 - 1)c]
Omega_J = gamma_e hbar J_n / (e Ms t_F)
T_G = Omega_J [epsilon(c) m x (m x p) + epsilon_prime m x p]
```

where `e=1.602176634e-19 C` exactly, `c=m dot p`, and `J_n` is signed.
Fullmag applies the Gilbert transform exactly once, giving

```text
T_explicit = Omega_J/(1+alpha^2)
  * [(epsilon + alpha epsilon_prime) m x (m x p)
     + (epsilon_prime - alpha epsilon) m x p].
```

Reversing either `J` or `n_stack` reverses the entire torque. The canonical
target node mask is applied before accumulation. The independent
`epsilon_prime` is not multiplied by `epsilon(c)`.

Canonical thin-layer execution requires explicit `t_F>0`; no mesh-extent
fallback is permitted. `slonczewski_interface_flux.v1` is not bulk-lowered:
until a separate oriented FEM surface functional exists, planner and native
import reject it before execution. The unversioned/legacy
`slonczewski.legacy_fullmag.v0` route preserves the historical current norm,
`current_sign`, elementary-charge constant, thickness fallback, and coefficient
algebra byte-for-byte in its separate branch.

Source ownership: Slonczewski CPP is isolated in
`stt_slonczewski.hpp/.cpp`. It owns the CPP current-density magnitude/sign,
spin polarization axis, asymmetry factor, free-layer thickness fallback, and
local damping-like/field-like RHS update. It does not assemble Zhang-Li
gradients or add any effective-field contribution.

The Rust reference realization shares the evaluator at
`crates/fullmag-engine/src/fdm/cpu/fields.rs::slonczewski_torque_from_config`;
`crates/fullmag-engine/src/fem.rs::FemLlgProblem::slonczewski_rhs_at` adds the
same direct `1/s` source to the FEM LLG RHS and to `max_rhs`. This reference
path is an oracle/CPU realization only and does not change the native MFEM
GPU capability label.

## Zhang-Li CIP

For `zhang_li.fullmag.v1` with `zl_central_reference_v1`, the FEM CPU path
computes one P1 tetrahedral gradient per active target element and forms

```text
u = g mu_B P J / (2 e Ms)
v = (u dot grad)m
T_G = -v + beta m x v
```

There is no extra `1/(1+beta^2)`. After tangential projection, exactly one
Gilbert conversion gives

```text
T_explicit = [-(1+alpha beta)v_perp
              +(beta-alpha)m x v_perp]/(1+alpha^2).
```

The exact elementary charge and explicit positive Landé factor are part of the
versioned plan. Reversing `J` reverses the torque. Target element masks exclude
all non-target elements before projection. The legacy
`zhang_li.legacy_fullmag.v0` branch retains its historical prefactor, sign, and
`1/(1+beta^2)` behavior.

Source ownership: Zhang-Li CIP is isolated in `stt_zhang_li.hpp/.cpp`. It owns
tetrahedral gradient reconstruction, Bohr-magneton drift scaling, nodal P1
projection, non-adiabatic beta handling, per-node Ms fallback, and the
`ZhangLiSttWorkspace` used to normalize only the projected Zhang-Li torque
before adding it to the caller's pre-existing RHS. The public aggregate
`add_stt_rhs_aos(...)` entry point remains in `stt.cpp`.

## Energia

STT is non-conservative drive. The current native FEM CPU module does not
report a standalone energy term.

## Jednostki

| Quantity | Symbol | Solver unit |
|---|---:|---:|
| reduced magnetization | `m` | `1` |
| current density | `J` | `A/m^2` |
| spin polarization | `P` | `1` |
| Slonczewski asymmetry | `Lambda` | `1` |
| field-like coefficient | `epsilon_prime` | `1` |
| Zhang-Li non-adiabaticity | `beta` | `1` |
| free-layer thickness | `d` | `m` |
| reduced gyromagnetic ratio | `gamma_mu0` | `m/(A s)` |
| RHS torque | `tau` | `1/s` |

## Warunki brzegowe

Homogenized Slonczewski CPP is local and has no FEM weak boundary term.
Canonical interface-flux Slonczewski requires an oriented surface functional
and is fail-closed rather than approximated by a volumetric `1/t_F` source.
Zhang-Li CIP uses tetrahedral gradients over active target elements and the
current P1-element/lumped-nodal-projection semantics.

## Dyskretyzacja FEM

Slonczewski CPP is evaluated per magnetic node from the local magnetization,
spin-polarization axis, current density, `Ms`, and free-layer thickness. It is
added directly to the RHS buffer in `1/s`.

Zhang-Li CIP reconstructs a P1 tetrahedral gradient of `m` on each magnetic
element, evaluates `(u.grad)m`, forms the adiabatic/non-adiabatic torque, and
projects the element contribution back to nodes with lumped P1 weights. The
hot path uses `SttWorkspace`/`ZhangLiSttWorkspace` so stage evaluation can add
the normalized Zhang-Li contribution without allocating a full temporary RHS.

For the affine tetrahedron map `x = p0 + J xi`, where the columns of `J` are
`p1-p0`, `p2-p0`, and `p3-p0`, the P1 gradients are the rows of `J^-1`:
`grad N1 = row_0(J^-1)`, `grad N2 = row_1(J^-1)`, and
`grad N3 = row_2(J^-1)`, with `grad N0 = -(grad N1 + grad N2 + grad N3)`.
This is a geometry contract, not a current-sign convention. On the skew tetra
`p0=(0,0,0)`, `p1=(2,0,0)`, `p2=(1,1,0)`, `p3=(0,0,1)`, it gives
`grad N1=(0.5,-0.5,0)`. Consequently an affine `m_z=x` and a drift along
`+x` have `(u.grad)m_z=u_x`; an affine `m_z=y` has zero directional derivative.
The CPU and CUDA implementations are distinct runtime realizations but use
this same map, SI units, and torque equation.

## Ograniczenia capability

- Only one executable STT family is accepted by native FEM plan validation at a
  time.
- Canonical v2 FEM CPU execution is implemented but remains unvalidated pending
  the named macrospin/current-scaling and domain-wall convergence gates.
- The Rust `FemLlgProblem` reference lane now applies the same local canonical
  Slonczewski v2 RHS through the shared SI evaluator used by the FDM reference
  lane. Zhang-Li remains a separate native FEM implementation and is not
  implicitly enabled by this reference-lane change.
- Canonical Slonczewski v2 FEM GPU plans still fail closed before device
  execution and before GPU provenance is created. Canonical Zhang--Li v1 now
  has an executable CUDA realization with the same target-element mask, Landé
  factor, signed-current prefactor, and Gilbert transform as the CPU contract;
  its bounded managed SP5 smoke completes on the device, but it remains
  `not_qualified` until matched CPU/GPU mesh, timestep, field, and convergence
  gates pass. Legacy GPU routes retain their historical semantics.
- `slonczewski_interface_flux.v1` is semantic-only until a distinct oriented
  surface functional is implemented; it is never bulk-lowered.
- Multi-module spin-torque authoring remains semantic-only for FEM until the
  planner/API path is expanded.
- Drift-diffusion spin accumulation and current-transport-coupled STT remain
  deferred.
- `FEM-TD-PHY-STT-001` has managed CPU/GPU parity evidence only for the named
  skew-tetra Zhang-Li workload. It does not promote any STT capability to
  `validated`, and it does not establish parity for other geometries, solvers,
  boundary conditions, or interaction combinations.

## Testy

Current gate:

- `fem_stt_contract` checks an independent canonical Slonczewski DL/FL oracle,
  exact signed `J dot n_stack`, current reversal, target-node masking,
  rejection of missing canonical thickness and interface-flux bulk lowering,
  an independent canonical Zhang-Li `g/2` oracle without a beta denominator,
  Zhang-Li current reversal and target-element masking, and canonical GPU
  device-prerequisite behavior. It also retains the legacy Slonczewski and Zhang-Li
  regression cases, nonmagnetic-node masking, Slonczewski source-module
  ownership, Zhang-Li source-module ownership, Zhang-Li tetrahedral
  gradient/nodal projection, additive Zhang-Li behavior for an existing RHS,
  aggregate-header non-ownership docstrings, `SttRuntimeState` plan-storage
  ownership outside flat `Context`, reusable RK hot-path STT workspace
  ownership, top-level source-contract docstrings for the aggregate,
  Slonczewski and Zhang-Li sources, and combined `max_rhs` updates.
- `fem_stt_contract` also evaluates the independent skew-tetra affine oracle
  above. Its `1e-12` relative bound follows from double-precision direct
  arithmetic (with `1e-24` absolute floor for zero expectations), not from a
  trajectory-fit threshold. `fem_cuda_tetra_gradient_contract` executes the
  CUDA Zhang-Li wrapper on that same tetrahedron, checks its analytic local
  RHS and current reversal, then compares a ten-step CPU/CUDA operator loop.
  That native contract uses explicit Euler followed by per-node renormalization
  on both sides; it tests the Zhang-Li operators, not the public integrator.
  The separately named managed fixture is the public fixed-step Heun workload;
  its CPU/GPU comparison uses frozen `rtol=2e-9` and `atol=1e-11`, established
  before validation. A separately versioned, managed
  CPU three-level Richardson study at fixed final physical time records
  observed orders `p_dt=2.0000679517167614` and
  `p_mesh=1.8064680026687565`; its conservative frozen acceptance floors are
  `p_dt >= 2.0` and `p_mesh >= 1.8`. The validator never recomputes these
  thresholds from the workload under test. See
  `docs/validation/fem-zhang-li-skew-tetra-convergence-study-v1.json` and
  `docs/validation/fem-zhang-li-skew-tetra-runtime-v1.json`.
- `FULLMAG_RUNTIME_PRUNE=0 just verify-fem-time-domain-native-contract` now
  also compiles and executes the CUDA canonical Zhang--Li branch after
  zero-initializing every allocated RK stage buffer. This guards the RK45
  predictor against IEEE `0 * NaN` propagation from uninitialized CUDA scratch;
  it is a numerical-safety contract, not a scientific parity claim.
- Provenance/migration: an artifact without `requested_execution` metadata is
  legacy and unverified for requested-versus-resolved execution intent; no
  backward migration is inferred, and it cannot satisfy the named
  `FEM-TD-PHY-STT-001` Zhang-Li validation gate.

Required before production qualification:

- public API validation for Slonczewski and Zhang-Li parameter domains;
- sign-convention regression against small reference trajectories;
- mesh-resolution check for Zhang-Li gradient projection;
- parity check before any `validated` CPU/GPU STT capability label.
