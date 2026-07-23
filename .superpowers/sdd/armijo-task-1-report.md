# Armijo Task 1 implementation report

## Scope

Implemented Task 1 from
`docs/superpowers/plans/2026-07-24-fem-direct-armijo-energy-increments.md`:

- added `compose_term_complete_energy_difference(...)` with an explicit
  endpoint-residual operand absolute sum;
- added retained-scale numerical coverage for the `-2e-17 J` endpoint,
  `-2.1037518401e-39 J` exchange decrement, and
  `+7.9035597018e-49 J` Zeeman increment;
- added a source contract that rejects deriving the new helper's uncertainty
  from `abs(endpoint_residual_delta_joules)`;
- preserved `compose_direct_energy_difference(...)` and its production CUDA
  caller unchanged for the atomic Task 3 migration.

No Armijo tolerance, clamp, ambiguity acceptance, production caller change,
ABI change, or public-contract change was added.

## RED evidence

The first sandboxed invocation reached the managed recipe's Docker boundary
but could not access `/var/run/docker.sock`; it exited 1 before native build or
test execution. The same required managed command was then rerun with approved
Docker access:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-source-contract
```

Result: exit 2, expected RED. The managed container built
`fem_relaxation_source_contract`, then compilation of
`fem_relaxation_energy_derivative_contract` failed at the new retained-scale
test because the production interface did not yet exist:

```text
error: 'compose_term_complete_energy_difference' has not been declared in
'fullmag::fem::relaxation'
error: 'compose_term_complete_energy_difference' was not declared in this scope
```

This was the intended missing-feature failure, not a fixture, syntax, or
environment failure.

## GREEN evidence

After adding only the new helper, the same managed command was run again:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-source-contract
```

Result: exit 0. The managed container rebuilt `libfullmag_fem.so` and all four
required contract targets. Runtime output included:

```text
[100%] Built target fem_relaxation_source_contract
[100%] Built target fem_relaxation_energy_derivative_contract
[100%] Built target fem_stage_completion_contract
[100%] Built target fem_rk_explicit_contract
PASS: FEM relaxation energy derivative matrix
```

The energy-derivative executable exercised the new checks that:

- the direct exchange-plus-Zeeman sum remains below `-2.103751e-39 J` and is
  accepted against the unchanged `-6.0314e-43 J` Armijo right-hand side;
- the endpoint operand scale contributes a roundoff bound larger than both
  `1e-33 J` and one ULP of the retained `-2e-17 J` endpoint;
- the resolved `+7.9035597018e-49 J` uphill increment is rejected.

## Self-review

- The implementation matches the approved five-argument interface and uses
  `endpoint_residual_operand_absolute_sum_joules +
  direct_absolute_term_sum_joules` as its forward-error scale.
- The new helper does not use `abs(endpoint_residual_delta_joules)`.
- `strict_armijo_difference_decision(...)` is unchanged, so non-finite input
  still fails closed, resolved uphill remains rejected, and ambiguous
  intervals still request refinement.
- `compose_direct_energy_difference(...)` is unchanged.
- `backends/fem/gpu/cuda/relaxation/direct_energy_increment.cpp` is unchanged
  and still calls only `compose_direct_energy_difference(...)`.
- The source contract explicitly protects both sides of that Task 1/Task 3
  atomic-migration boundary.
- No files outside the three Task 1 code/test files and this report are owned
  by this task. `.superpowers/sdd/progress.md` remains root-owned and was not
  edited, staged, or reverted.

## Concerns

None. This is source/unit contract evidence only; production CUDA semantics are
intentionally unchanged until Task 3.
