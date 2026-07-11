# FEM Spin-Transfer Torque

- Status: native FEM CPU/GPU module contract
- Last updated: 2026-07-10
- Implementation: `backends/fem/cpu/mfem/interactions/stt.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/stt_slonczewski.hpp/.cpp`,
  `backends/fem/cpu/mfem/interactions/stt_zhang_li.hpp/.cpp`
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

Plan storage ownership: `SttRuntimeState` stores executable STT family
enablement, shared current density, Zhang-Li `degree`/`beta`, Slonczewski spin
polarization, asymmetry, field-like coefficient, free-layer thickness, and
current sign. `Context` contains this owner as `ctx.stt` and does not own flat
STT plan fields directly.

## Slonczewski CPP

The Slonczewski path is local per node:

```text
tau = beta_stt * [m x (m x p) + epsilon_prime * (m x p)]
beta_stt = current_sign * |J| hbar gamma_mu0 / (2 e mu0 Ms d) * g(m.p)
g(m.p) = P Lambda^2 / [(Lambda^2 + 1) + (Lambda^2 - 1) m.p]
```

With nonzero Gilbert damping, the explicit direct-RHS form used by Fullmag is
the effective-field-equivalent form:

```text
tau =
  beta_stt / (1 + alpha^2)
    * [(1 + alpha epsilon_prime) * m x (m x p)
       + (epsilon_prime - alpha) * (m x p)]
```

For `alpha = 0`, this reduces to the simpler expression above. The
`gamma_mu0` factor converts the field-scale Slonczewski coefficient into a
`1/s` direct RHS contribution. This is equivalent to the Boris-style
implementation that inserts a Slonczewski field into `H_eff`, provided the same
angular efficiency and current-sign convention are used.

The module uses explicit `stt_free_layer_thickness` when provided. Otherwise it
derives a magnetic thickness from the mesh extent along the current-density
axis.

Source ownership: Slonczewski CPP is isolated in
`stt_slonczewski.hpp/.cpp`. It owns the CPP current-density magnitude/sign,
spin polarization axis, asymmetry factor, free-layer thickness fallback, and
local damping-like/field-like RHS update. It does not assemble Zhang-Li
gradients or add any effective-field contribution.

## Zhang-Li CIP

The Zhang-Li path computes one P1 tetrahedral gradient of `m` per magnetic
element, forms the drift vector:

```text
u = stt_degree * mu_B * J / [e Ms (1 + beta^2)]
```

and projects the element RHS back to nodes with lumped P1 weights:

```text
v = (u.grad) m
v_perp = -m x (m x v)
tau = [(1 + alpha beta) * v_perp - (beta - alpha) * (m x v)] / (1 + alpha^2)
```

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

Slonczewski CPP is local and has no FEM weak boundary term. Zhang-Li CIP uses
tetrahedral gradients over magnetic elements and has the current executable
P1-element/nodal-projection semantics; explicit source-bound current-transport
boundary coupling remains outside this module.

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

- `fem_stt_contract` checks Slonczewski damping-like and field-like terms,
  current-sign handling, nonmagnetic-node masking, Slonczewski source-module
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
  its frozen CPU/GPU comparison uses `rtol=2e-9` and `atol=1e-11`, established
  before validating that ten-step run. A separately versioned, managed
  CPU three-level Richardson study at fixed final physical time records
  observed orders `p_dt=2.0000679517167614` and
  `p_mesh=1.8064680026687565`; its conservative frozen acceptance floors are
  `p_dt >= 2.0` and `p_mesh >= 1.8`. The validator never recomputes these
  thresholds from the workload under test. See
  `docs/validation/fem-zhang-li-skew-tetra-convergence-study-v1.json` and
  `docs/validation/fem-zhang-li-skew-tetra-runtime-v1.json`.

Required before production qualification:

- public API validation for Slonczewski and Zhang-Li parameter domains;
- sign-convention regression against small reference trajectories;
- mesh-resolution check for Zhang-Li gradient projection;
- parity check before any `validated` CPU/GPU STT capability label.
