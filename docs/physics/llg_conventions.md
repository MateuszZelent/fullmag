# LLG Conventions

- Status: release-gate convention document for native FEM CPU
- Last updated: 2026-05-18
- Implementation: `backends/fem/cpu/mfem/integrators/llg_rhs.hpp/.cpp` and
  interaction modules under `backends/fem/cpu/mfem/interactions/`
- Test: `backends/fem/tests/llg_rhs_contract.cpp`,
  `backends/fem/tests/interaction_docs_contract.cpp`
- Canonical time policy:
  `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`

## Equation

Native FEM evolves reduced magnetization `m = M / Ms` with the explicit LLG RHS:

```text
dm/dt =
  -gamma_mu0 / (1 + alpha^2)
    [m x H_eff + alpha m x (m x H_eff)]
  + tau_direct
```

`H_eff` is in `A/m`. Direct torques are already `dm/dt` terms in `1/s` and are
not reinterpreted as fields. The field-to-RHS conversion, AOS magnetization
normalization, and magnetic-node RHS masking live in the extracted
`cpu/mfem/integrators/llg_rhs.*` module. The `llg_rhs.cpp` source-level
contract pins that this module consumes an already composed `H_eff`: it does
not own effective-field composition, interaction field evaluation, time
advancement, or step metrics.

## Relaxation Mode

The public relaxation algorithm `llg_overdamped` disables the precessional
`m x H_eff` term and keeps only damping descent:

```text
dm/dt =
  -gamma_mu0 / (1 + alpha^2)
    [alpha m x (m x H_eff)]
  + tau_direct
```

Native FEM CPU and GPU must carry this as an explicit runtime contract named
`precession_enabled`. `precession_enabled = true` selects the full
precessional Gilbert RHS above. `precession_enabled = false` selects pure
damping relaxation. The default for ABI callers that do not specify the field
is precessional mode, preserving existing explicit LLG behavior.

Runtime provenance and startup logs must expose the resolved LLG mode as
`llg_mode = precessional` or `llg_mode = pure_damping`.

## Field Path

Interactions implemented as fields contribute additively to `H_eff`:

```text
H_eff = H_ex + H_demag + H_ext + H_ani + H_dmi + H_oe + H_me + H_th
```

The field modules must document their energy convention, field units, material
projection, boundary condition, and test coverage. The current native FEM CPU
field modules are exchange, demag Poisson, FEM/BEM demag, Zeeman, anisotropy,
DMI, Oersted, magnetoelastic, and Brown thermal field.

## Direct Torque Path

Spin-transfer torque modules write directly into the RHS:

```text
tau_direct = tau_slonczewski + tau_zhang_li + ...
```

These terms are not passed through the field-to-RHS LLG conversion. Their
module documentation must state whether the term is CPP, CIP, field-like, or
damping-like and must include sign, current-density, polarization, thickness,
and `Ms` conventions.

## Gamma Convention

The native FEM ABI field named `gyromagnetic_ratio` carries the reduced
`gamma_mu0` in `m/(A s)`, not the electron gyromagnetic ratio in `rad/(T s)`.
New internal code and documentation should use the explanatory name
`gamma_mu0` even when reading the legacy ABI field.

## Normalization

Accepted magnetization states must be normalized on magnetic nodes after every
step. Nonmagnetic FEM airbox nodes can exist for field recovery and
visualization, but they must not contribute to magnetic RHS terms unless an
interaction explicitly documents that behavior.

## Fixed, adaptive, and stiff time-domain policies

Contracts: `LLG-TD-POLICY-V1`, `LLG-TD-ATTEMPT-V1`, `LLG-TD-STIFF-V1`,
`LLG-TD-FIRST-DT-V1`, `LLG-TD-MAX-ERR-V1`, `LLG-TD-ATOMIC-V1`.

`fix_dt` selects a true fixed physical timestep. `fix_dt` cannot be combined
with `dt_initial`, `dt_min`, `dt_max`, `max_err`, or the advanced adaptive
object. Adaptive mode preserves an omitted `dt_initial` and resolves the first
attempt to exactly `dt_min`; no floating-point equality is a sentinel.

The convenience `max_err` is the absolute maximum node/cell embedded vector
error. Advanced `atol`/`rtol` is a distinct mode. A failed adaptive attempt at
the floor returns typed `dt_min_exhausted` and cannot be accepted. A stiff
time-domain lane must be selected explicitly and qualified independently; the
existing tangent-plane relaxation minimizer does not advance full LLG time.

## Validation Status

Current local contracts cover module-level sign/unit behavior for extracted
interactions and source-level ownership boundaries for the native FEM
integrator modules: adaptive timestep policy, Heun/RK tableau definitions,
explicit RK workspace allocation, stage RHS evaluation, fixed-step Heun,
complete explicit RK stepping, and LLG RHS helpers. Full active MFEM-stack numerical fixture qualification remains separate from these local ownership and docstring contracts.

Before production qualification, the LLG convention must remain covered by
macrospin, relaxation, direct-torque, and energy-monotonicity fixtures in the
validation matrix.
