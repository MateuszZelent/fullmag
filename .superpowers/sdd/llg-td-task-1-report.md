# LLG time-domain remediation — Task 1 report

## Scope

Freeze the canonical documentation and capability vocabulary, make the
managed native time-domain gate reach the adaptive/LLG contracts, and remove
stale source-contract blockers without changing solver algorithms.

## RED evidence

1. Baseline `just verify-fem-time-domain-native-contract` failed during CMake
   generation because CUDA targets had an empty `CUDA_ARCHITECTURES`.
2. After supplying a repo-owned non-hardcoded architecture default and adding
   the missing targets, the gate exposed a stale test dependency:
   `FAIL: unable to read /workspace/docs/reports/16.05.2026/fullmag_fem_cpu_refactor_progress_2026-05-16.md`.
3. After removing obsolete progress-ledger assertions, the gate reached the
   source facade and failed with:
   `FAIL: GPU CUDA RK external final energy reductions source must own external energy validation, launch, and scalar slot`.

These were infrastructure/source-contract failures, not adaptive-controller
algorithm failures.

## GREEN implementation

- Added explicit `docker compose run -e FULLMAG_CUDA_ARCHITECTURES=...` plus
  `-DCMAKE_CUDA_ARCHITECTURES=...` to the managed recipe, with portable host
  override and a `native` default. Native CMake now fails early on an empty
  architecture value.
- Added `fem_llg_rhs_contract` and `fem_adaptive_dt_contract` to the build and
  execution list of `verify-fem-time-domain-native-contract`.
- Made adaptive contract repository-root discovery independent of an obsolete
  path depth and removed stale refactor-progress assertions.
- Added a separate documentation gate using stable requirement identifiers
  for policy, first-step resolution, maximum-error semantics, attempted-step
  transaction, atomicity, and the stiff lane; the numerical C++ contract is
  not coupled to editorial prose.
- Removed obsolete progress-report dependencies from the newly canonical LLG
  RHS and RK explicit gates.
- Reconciled notes 0480/0490, LLG conventions, table-autosave semantics,
  backend ownership, and capability rows with note 0960.
- Reconciled the GPU final Zeeman energy source contract for both uniform
  external and regional-drive fields, including explicit device-pointer
  validation for `H_ext` and `H_drive`.

## GREEN evidence

Command:

```text
just verify-fem-time-domain-native-contract
```

Result on 2026-07-17: exit code 0. The managed CUDA/MFEM build compiled and
ran `fem_llg_rhs_contract`, `fem_adaptive_dt_contract`,
`fem_rk_explicit_contract`, and every previously listed time-domain target.

Portable override proof:

```text
FULLMAG_CUDA_ARCHITECTURES=75 just verify-fem-time-domain-native-contract
```

Result on 2026-07-17: exit code 0 after a complete rebuild for `sm_75` and
execution of the full managed contract list. This proves the host override is
passed through `docker compose run -e` into CMake rather than silently using
the container default.

## Scope boundary

Task 1 changes gate wiring, documentation, and missing pointer validation. It
does not claim that the current adaptive controller is correct; Tasks 2-12
add the public contract, controller, guards, demag failure, transaction,
telemetry, and scientific qualification.
