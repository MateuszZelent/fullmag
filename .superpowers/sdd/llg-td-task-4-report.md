# Task 4: central timestep policy resolver and typed provenance

## RED

Command:

```text
cargo test -p fullmag-runner initial_timestep_tests --no-run
```

Exit 101. Tests require `resolve_timestep_policy`, requested/resolved policy
types, and `InitialTimestepReason`; all are absent. The legacy helper still treats an
explicit `dt_initial == dt_min` as a signal to inject `1e-13`, and missing
initial values also inject that sentinel.

## Required outcome

- one fail-closed exactly-one fixed/adaptive resolver;
- missing adaptive initial resolves exactly to `dt_min` with typed reason;
- explicit initial, including equality with `dt_min`, remains explicit;
- explicit `dt_max` and typed controller/provenance contract;
- no runtime `1e-13`/`1e-10` adaptive fallback;
- all time-domain execution lanes consume the resolver.

## Implemented contract

- `resolve_timestep_policy` is the only fixed/adaptive policy resolver. It
  rejects missing or simultaneous policies, requires an explicit integrator,
  requires adaptive `dt_max`, and validates bounds, tolerances, controller
  coefficients, and optional guards.
- `MaxError` requires `atol > 0` and `rtol == 0`; `Advanced` accepts finite,
  non-negative tolerances when at least one is positive.
- Provenance has separate tagged `requested` and `resolved` fixed/adaptive
  variants. Only resolved adaptive provenance contains the estimator order and
  the initial-step resolution reason.
- Every physical-time policy carries a typed `LLG-TD-POLICY-V1` execution
  identity: backend, device, precision, exact capability-matrix row,
  contract ID, and qualification state. The resolver rejects lane combinations
  absent from the executable matrix, including adaptive FDM CUDA until its ABI
  carries the complete controller contract.
- Missing adaptive initial timestep resolves exactly to `dt_min` with
  `dt_min_default`; every explicit value, including equality with `dt_min`, is
  retained with `explicit`.
- Legacy `dt_policy` accepts only `user`, `adaptive`, or `fallback` while
  deserializing and is never serialized. New artifacts emit `timestep_policy`.
- Direct minimizers do not publish physical timestep provenance. Pure-Rust
  batch and interactive paths never manufacture a timestep for them. The named
  `NON_LLG_RELAXATION_ABI_DT_PLACEHOLDER` remains only inside the native FEM ABI
  compatibility helper and its focused tests.
- Multilayer FDM requires `fixed_timestep` for every integrator.

## Surgical manifest

- Contract and provenance: `crates/fullmag-runner/src/lib.rs`,
  `crates/fullmag-runner/src/types.rs`, `crates/fullmag-runner/src/artifacts.rs`.
- FDM batch lanes: CPU reference and multilayer; CUDA single-grid,
  assisted/native-stacked multilayer, and double precision.
- FEM batch lanes: internal reference, native dispatch/execution, native FEM
  bridge configuration and tests, adaptive-integrator helper.
- Interactive lanes: monolithic compatibility runtime plus modular FDM/FEM
  CPU/GPU runtimes and their provenance builders.
- CLI diagnostics: repeated adaptive `dt_max` defaults now fail closed.

## Verification

- `cargo test -p fullmag-runner initial_timestep_tests`: 10 passed, including
  typed identity round-trip for fixed FDM CPU/CUDA and FEM CPU/GPU plus
  fail-closed adaptive FDM CUDA identity.
- `cargo test -p fullmag-runner legacy_dt_policy_is_read_only_and_bounded`: passed.
- `cargo test -p fullmag-runner interactive_cpu_direct_minimizer_has_no_physical_timestep_provenance`: passed.
- `cargo test -p fullmag-runner direct_minimizer_fem_provenance_has_no_physical_timestep_policy`: passed.
- `cargo test -p fullmag-runner direct_minimization_provenance_names_cpu_minimizer_realization`: passed.
- `cargo test -p fullmag-runner direct_cpu_multilayer_entry_requires_fixed_timestep_for_every_integrator`: passed.
- `env FULLMAG_FDM_LIB_DIR=/tmp FULLMAG_FEM_LIB_DIR=/tmp cargo check -p fullmag-runner --all-features`: passed; the temporary paths suppress native linking during type checking only.
- `cargo check -p fullmag-cli`: passed.
- `cargo test -p fullmag-runner --lib --no-fail-fast`: 558 passed, 0 failed.
- `git diff --check`: passed.
- `rg` proof found no `resolve_initial_timestep`, `DEFAULT_ADAPTIVE_DT*`,
  `unwrap_or(1e-13)`, `unwrap_or(1e-10)`, or `dt_max.unwrap_or` in runner
  execution or CLI diagnostics.

The stale `H_oe` artifact fixture now derives the certificate active-cell count
from its explicit mask. Its focused test passes and the full runner gate is
green.
