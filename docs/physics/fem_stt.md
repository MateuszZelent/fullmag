# FEM Spin-Transfer Torque

- Status: native FEM CPU module contract
- Last updated: 2026-05-18
- Implementation: `native/backends/fem/cpu/mfem/interactions/stt.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/stt_slonczewski.hpp/.cpp`,
  `native/backends/fem/cpu/mfem/interactions/stt_zhang_li.hpp/.cpp`
- Test: `native/backends/fem/tests/stt_contract.cpp`
- Shared sign reference: `docs/physics/stt_sign_conventions.md`

## Pole / torque

Spin-transfer torque is a direct `dm/dt` contribution. It is not an effective
field and must not be added to `H_eff`.

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

## Slonczewski CPP

The Slonczewski path is local per node:

```text
tau = beta_stt * [m x (m x p) + epsilon_prime * (m x p)]
beta_stt = current_sign * |J| hbar / (2 e mu0 Ms d) * g(m.p)
g(m.p) = P Lambda^2 / [(Lambda^2 + 1) + (Lambda^2 - 1) m.p]
```

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
tau = -m x [m x ((u.grad) m)] - beta * [m x ((u.grad) m)]
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

## Ograniczenia capability

- Only one executable STT family is accepted by native FEM plan validation at a
  time.
- Multi-module spin-torque authoring remains semantic-only for FEM until the
  planner/API path is expanded.
- Drift-diffusion spin accumulation and current-transport-coupled STT remain
  deferred.
- GPU parity is not claimed by this module.

## Testy

Current gate:

- `fem_stt_contract` checks Slonczewski damping-like and field-like terms,
  current-sign handling, nonmagnetic-node masking, Slonczewski source-module
  ownership, Zhang-Li source-module ownership, Zhang-Li tetrahedral
  gradient/nodal projection, additive Zhang-Li behavior for an existing RHS,
  aggregate-header non-ownership docstrings, reusable RK hot-path STT
  workspace ownership, top-level source-contract docstrings for the aggregate,
  Slonczewski and Zhang-Li sources, and combined `max_rhs` updates.

Required before production qualification:

- public API validation for Slonczewski and Zhang-Li parameter domains;
- sign-convention regression against small reference trajectories;
- mesh-resolution check for Zhang-Li gradient projection;
- parity check before any shared CPU/GPU STT capability label.
