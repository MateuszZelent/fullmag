# LLG Conventions

- Status: release-gate convention document for native FEM CPU
- Last updated: 2026-05-18
- Implementation: `native/backends/fem/cpu/mfem/integrators/llg_rhs.hpp/.cpp`,
  `native/backends/fem/src/mfem_bridge.cpp`, and interaction modules under
  `native/backends/fem/cpu/mfem/interactions/`
- Test: `native/backends/fem/tests/llg_rhs_contract.cpp`,
  `native/backends/fem/tests/interaction_docs_contract.cpp`

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

## Validation Status

Current local contracts cover module-level sign/unit behavior for extracted
interactions and source-level ownership boundaries for the native FEM
integrator modules: adaptive timestep policy, Heun/RK tableau definitions,
explicit RK workspace allocation, stage RHS evaluation, fixed-step Heun,
complete explicit RK stepping, and LLG RHS helpers. Full active MFEM-stack numerical fixture qualification remains separate from these local ownership and docstring contracts.

Before production qualification, the LLG convention must remain covered by
macrospin, relaxation, direct-torque, and energy-monotonicity fixtures in the
validation matrix.
