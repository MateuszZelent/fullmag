# Task 6 report: order-aware fail-closed FEM adaptive decision

## Scope and ownership

Implemented one pure backend-neutral scalar adaptive-decision contract in
`backends/fem/core/adaptive_step_decision.hpp`. FEM CPU/MFEM and the FEM CUDA
host-control boundary are separate adapters over that same contract. No policy
or decision logic was added to the Rust runner, `Context`, `mfem_bridge.cpp`,
or generic dispatch.

The CUDA host-scalar declaration lives in the narrow CUDA-free
`rk_adaptive_host_decision.hpp`. Tests include that owned declaration directly;
they do not redeclare its signature or pull in CUDA runtime/device APIs.

The contract freezes:

- decision kinds: `accepted`, `retry`, `failed`;
- typed reasons, including `dt_min_exhausted` and granular invalid-input reasons;
- estimator-order-aware startup and PI-history exponents;
- startup/reset/zero-error history behavior;
- accepted decisions that may propose `dt_next < dt_attempt`;
- immutable shared golden vectors and explicit FP64/FP32 scalar budgets;
- terminal failure at `dt_min`, with candidate restore and exactly one rejected-attempt count;
- no history or counter mutation for invalid scalar input.

## RED evidence

1. Named order-awareness RED:

   ```text
   just verify-fem-time-domain-native-contract
   fatal error: core/adaptive_step_decision.hpp: No such file or directory
   ```

   The failing test was
   `rk23_and_rk45_use_estimator_order_in_the_same_pi_history`, requiring the
   same scalar history to produce ratio `1.133928944905386` for RK23 `q=2` and
   `1.0338285194973316` for RK45 `q=4`.

2. GPU fail-closed restore RED after the scalar implementation:

   ```text
   FAIL: GPU terminal adaptive failure restores candidate magnetization before return
   error: recipe `verify-fem-time-domain-native-contract` failed
   ```

   This exposed that terminal `failed/dt_min_exhausted` returned after a GPU
   candidate stage without restoring magnetization. The failed branch now uses
   the same device restore owner as retry before returning the typed failure.

3. Narrow GPU-host ownership RED:

   ```text
   fatal error: gpu/cuda/integrators/rk/rk_adaptive_host_decision.hpp: No such file or directory
   ```

   The test first replaced its manual function redeclaration with the desired
   owned CUDA-free header. The implemented header contains only core scalar
   types and the adapter declaration; CUDA-only Context/device APIs remain in
   `rk_adaptive_runtime.hpp` under `FULLMAG_HAS_CUDA_RUNTIME`.

4. Canonical tolerance-lowering RED:

   ```text
   FAIL: max_err lowering with atol > 0 and rtol = 0 is legal
   ```

   Native FEM plan import previously required both tolerances to be strictly
   positive. It now accepts finite nonnegative tolerances when at least one is
   positive, so canonical `max_err -> (atol=max_err, rtol=0)` and relative-only
   advanced policies both reach the controller. Both zero, negative, and
   nonfinite values fail before runtime state mutation.

5. Public safety-bound and GPU predecision-restore RED:

   ```text
   FAIL: safety = 1 is legal
   ```

   Both native plan import and the backend-neutral scalar contract now accept
   finite `0 < safety <= 1`; values above one and nonfinite values remain
   invalid. Source-contract coverage also requires candidate magnetization
   restore after GPU adaptive error-reduction or scalar-readback failure, in
   addition to retry and terminal-decision paths. A successful restore preserves
   the original reduction/readback failure reason; a restore failure reports
   its own reason.

6. Inactive-history finite validation RED:

   ```text
   FAIL: invalid scalar decision fails closed
   ```

   A nonfinite previous-error scalar now fails with
   `invalid_previous_error` regardless of history activation and without
   mutating history or counters. Positivity is required only for active
   history; finite zero is allowed as the documented inactive placeholder.
   Tests also freeze inclusive `eta=1`, `dt_attempt=dt_min`, and
   `dt_attempt=dt_max` boundaries.

The first managed RED invocation was initially blocked before compilation by
Docker's exhausted default subnet pool. No networks were removed or pruned.
All subsequent runs safely reused the existing
`fullmag-llg-time-domain-remediation` Compose project through
`COMPOSE_PROJECT_NAME`.

## GREEN evidence

Authoritative managed command:

```text
env COMPOSE_PROJECT_NAME=fullmag-llg-time-domain-remediation \
  just verify-fem-time-domain-native-contract
```

Final result: exit `0`, wall time `216.3 s` on the final post-review run after
inactive-history validation and inclusive boundary tests rebuilt the shared
core-header dependents.
The recipe's documentation check and all named native targets built and ran,
including `fem_state_io_contract`, `fem_llg_rhs_contract`,
`fem_adaptive_dt_contract`, `fem_rk_explicit_contract`, and
`fem_source_facade_gpu_rk_contract`. The derivative matrix ended with
`PASS: FEM relaxation energy derivative matrix`.

`git diff --check` also passed with no output.

An auxiliary managed-container diagnostic built and linked
`fem_source_facade_cuda_kernels_contract`, then stopped on an unrelated Oersted
source assertion:

```text
FAIL: GPU CUDA RK Oersted field source must own time-dependent scaling and scaled field addition
```

The adaptive header/handoff assertions in that executable ran before the later
Oersted failure. The canonical Task 6 managed gate is green; this report does
not classify or repair the separate Oersted source-contract drift.

## Changed files

- `backends/fem/core/adaptive_step_decision.hpp`
- `backends/fem/cpu/mfem/integrators/adaptive_dt.cpp`
- `backends/fem/cpu/mfem/integrators/adaptive_dt.hpp`
- `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`
- `backends/fem/cpu/mfem/integrators/rk_tableau.hpp`
- `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp`
- `backends/fem/cpu/mfem/runtime/state_io.cpp`
- `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_decision_readback.cu`
- `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp`
- `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_host_decision.hpp`
- `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu`
- `backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp`
- `backends/fem/gpu/cuda/integrators/rk/rk_attempt_loop.cu`
- `backends/fem/src/api.cpp`
- `backends/fem/tests/adaptive_dt_contract.cpp`
- `backends/fem/tests/source_facade_cuda_kernels_contract.cpp`
- `backends/fem/tests/state_io_contract.cpp`
- `docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`
- `.superpowers/sdd/llg-td-task-6-report.md`

## Honest qualification limits

- CPU/GPU parity here is parity of the bounded host scalar decision over shared
  vectors. It does not qualify a device-resident GPU adaptive controller.
- The gate proves the native source/runtime contracts in the existing recipe;
  it is not full scientific trajectory qualification, energy monotonicity
  qualification, or a complete atomic attempted-step proof. Those remain later
  tasks in the remediation plan.
- FP32 coverage rounds the scalar inputs to FP32 and checks the host decision
  within `8e-6`; it does not qualify the full FEM GPU FP32 integration lane.
- The pre-existing advanced error-norm state scale is not qualified by Task 6:
  CPU currently ignores `m_old` and uses `max(||m_new||, 1)`, while the
  canonical advanced formula uses `max(||m_old||, ||m_hi||)`. This task does
  not claim that advanced-tolerance error scaling is closed; it remains a named
  follow-on numerics gap.
- General failure inside `gpu_rk_run_stage_attempt` still has pre-existing full
  attempted-step restoration debt. Task 6 owns candidate restore for adaptive
  reduction failure, readback failure, typed terminal decision, and retry only;
  the broader stage-attempt atomicity path belongs to Task 10 and is not claimed
  closed here.
