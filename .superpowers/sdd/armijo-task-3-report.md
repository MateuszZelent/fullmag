# Armijo Task 3 implementation report

## Outcome

`DONE_WITH_CONCERNS`: CUDA PG-BB/NCG Armijo composition is now term-complete
and the diagnosed exchange-plus-Zeeman first step executes successfully on the
managed RTX 4080 SUPER runtime. The 32-step focused case later reaches an
honest strict-Armijo stagnation on step 2 and restores the previous device
state; it is retained as non-converged diagnostic evidence, not relabelled as
a pass.

The change does not alter the Armijo coefficient or inequality, BB1/BB2,
restart behavior, fresh-zero demag policy, backtrack limit, physical stopping
tolerances, public ABI, profiler ABI, or synchronization budget.

## Implemented ownership and composition

`gpu_energy_increment_owner(Context, GpuFinalScalarSlot)` classifies every
current packed scalar from `Context` semantics. Stored scalar values never
determine enablement.

| GPU final scalar | Enabled owner | Disabled owner |
|---|---|---|
| exchange | direct polarized difference | not energy |
| demag | direct polarized difference | not energy |
| external Zeeman | direct local difference | not energy |
| regional drive | endpoint residual | not energy |
| uniaxial anisotropy | direct local difference | not energy |
| interfacial/bulk DMI | direct difference | not energy |
| cubic anisotropy | endpoint residual | not energy |
| magnetoelastic | endpoint residual | not energy |
| demag Robin boundary diagnostic | not energy | not energy |
| max/norm/moment observables | not energy | not energy |
| unknown slot | unsupported, fail closed | unsupported, fail closed |

The real CUDA local direct-difference kernel was audited before classifying
DriveEnergy. It consumes `h_ext` but not `h_drive`, so regional drive remains
an explicit endpoint residual. Drive, cubic, and magnetoelastic residuals use
`trial_q - base_q` and contribute `abs(base_q) + abs(trial_q)` to the
subtraction bound. Robin is excluded because the polarized demag identity
already includes the variational boundary form.

The production decision path now calls
`compose_term_complete_energy_difference(...)` directly. It no longer forms
`trial.total_energy_j - base.total_energy_j`, reconstructs an
`endpoint_replaced` residual, or retains the legacy
`compose_direct_energy_difference(...)` helper. Total endpoint energy remains
available only for observability and finite-state validation.

External and uniaxial enable flags were added to the existing local CUDA
kernel, and disabled exchange now skips its direct kernel. These guards keep
the direct realization identical to the ownership classifier even when packed
or device scalar storage is nonzero. No new scalar buffer, host readback, or
host synchronization was added.

If a finite-precision overlap includes a nonzero endpoint-residual operand
scale, no demag refinement is claimed for that residual. The trial backtracks
and eventually fails closed with rollback if it cannot satisfy strict Armijo.
Qualified demag-only refinement remains available to both PG-BB and NCG.

## RED evidence

The required managed command was:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-source-contract
```

The first managed RED exited 2 while compiling the new executable contract.
It failed exactly because `GpuEnergyIncrementOwner`,
`gpu_energy_increment_owner(...)`, and
`gpu_compose_term_complete_energy_difference(...)` did not exist.

After the production implementation compiled, the same gate exposed one stale
pre-Task-3 source assertion:

```text
FAIL: native FEM GPU direct Armijo evaluation must contribute zero demag energy when demag is disabled
```

That assertion still required the deliberately deleted `add_endpoint_delta`
implementation. It was repaired to pin both parts of the actual invariant:
the Context-derived DemagEnergy Direct/NotEnergy classification and the
`demag_enabled ? ... : 0.0` CUDA kernel guard. The disabled-term numerical
tests were not weakened.

## Managed GREEN evidence

The final source/derivative gate exited 0. It built and ran all four targets:

```text
fem_relaxation_source_contract
fem_relaxation_energy_derivative_contract
fem_stage_completion_contract
fem_rk_explicit_contract
PASS: FEM relaxation energy derivative matrix
```

The executable derivative contract proves:

- all current scalar slots have an explicit owner;
- all disabled energy slots are ignored even with nonzero stored scalars;
- DriveEnergy, cubic anisotropy, and magnetoelastic energy contribute endpoint
  residuals and independent operand scales exactly once;
- the Robin diagnostic contributes zero Armijo ownership regardless of value;
- an endpoint-residual ambiguity cannot be misrepresented as refinable demag
  uncertainty;
- the retained exchange increment `-2.1037518401e-39 J` plus Zeeman increment
  `+7.9035597018e-49 J` composes to
  `-2.10375183930964407e-39 J` and is accepted against the unchanged
  `-6.0314e-43 J` strict Armijo right-hand side;
- the existing resolved-uphill contract still rejects rather than introducing
  an energy window.

The managed runtime gate also exited 0:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-runtime
```

It rebuilt the managed bundle, reran the native contracts, exercised GPU and
CPU relaxation smokes including GPU PG-BB, and ended with:

```text
FEM relaxation runtime smoke completed
```

## Fresh managed runtime identity

- bundle:
  `candidate-sm89-f875db7ad96a281aa9ffb27ccb30cde7de1949abbbcd8a1ea37fb6e5554c106f`;
- bundle manifest SHA-256:
  `f875db7ad96a281aa9ffb27ccb30cde7de1949abbbcd8a1ea37fb6e5554c106f`;
- source manifest SHA-256:
  `373c203f9f10ede4d0de1c1cf558b826defadebaea50ea8578e7afa49f20975d`;
- loaded `libfullmag_fem.so.0.1.0` SHA-256:
  `3c8c062ed42d7dcd7d1897740d5cc3615583c6e78b0ed1490ec9f588bbe23839`;
- device: NVIDIA GeForce RTX 4080 SUPER, compute capability 8.9;
- CUDA toolkit/runtime: 12.4; driver reported by the bundle: 591.86;
- precision: double;
- MFEM 4.9 and HYPRE 3.1.0;
- native cubin coverage includes `sm_89`.

## Focused exchange-plus-Zeeman GPU proof

The focused one-repeat command used the fresh managed bundle in the repository
container, the coarse Box500/airbox fixture, GPU PG-BB, and the canonical
four-control-sync validator. The authoritative successful run requested one
step:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
docker compose --profile fem-gpu run --rm \
  -e PYTHONPATH=/workspace/packages/fullmag-py/src \
  -e FULLMAG_PYTHON=/usr/bin/python3 \
  -e FULLMAG_BENCH_DOMAIN_HMAX=250e-9 \
  -e FULLMAG_BENCH_AIRBOX_HMAX=500e-9 \
  -e FULLMAG_BENCH_RAW_CASE_OUTPUT=/workspace/.fullmag/reports/armijo-task-3-gpu-zeeman-step1.raw.log \
  fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/fem_gpu_benchmark.py \
    --meshes coarse --scenarios box500_airbox_exchange_zeeman \
    --integrators heun --relax-algorithms projected_gradient_bb \
    --backends gpu --thread-counts auto --steps 1 --repeat 1 \
    --case-timeout-s 600 --require-mfem-stack \
    --require-stable-solver-mesh --reuse-generated-domain-mesh \
    --require-zero-strict-gpu-global-sync --require-gpu-strict-residency \
    --require-gpu-control-readback-budget \
    --gpu-pgbb-control-readback-per-step 4 \
    --output .fullmag/reports/armijo-task-3-gpu-zeeman-step1.csv'
```

Result: process exit 0, row `status=ok`, `returncode=0`, one executed step,
and `stop_reason=max_steps`.

| Evidence | Value |
|---|---:|
| solver mesh signature | `ffe9595b4f6b6fc44fab022e733f2fbf2457ee8189929859a7f137f65dd10f11` |
| solver nodes/elements | 52 / 149 |
| total/logical RHS evaluations | 2 / 2 |
| hot-loop host synchronizations | 4 |
| control-scalar host synchronizations | 4 |
| compute host synchronizations | 0 |
| exchange host synchronizations | 0 |
| compute H2D/D2H bytes | 0 / 0 |
| exchange H2D/D2H bytes | 0 / 0 |
| final total energy | `-7.951455496239511e-19 J` |
| final exchange energy | `-2.0986047873643497e-33 J` |
| final external energy | `-7.951455496239489e-19 J` |
| final torque | `0.04996046834466434 T` |
| final data residency | `device_source_of_truth` |
| CUDA kernels | enabled |

Artifact hashes:

- step-one CSV:
  `6d611388d2f66acf4e41f899fbbec90b3d9846f54656c65862c2351e5d6f00db`;
- step-one raw log:
  `b56e62f893dc7c5972e11e96b07064c144f2de761b2a878a76d0f9bf96122efd`.

The accepted runtime log does not emit per-trial direct components. The exact
retained decrement and Armijo decision are therefore executable managed-test
evidence, while the row above proves that the repaired production GPU path
accepts and publishes the diagnosed first step within the four-sync budget.
This distinction is intentional; endpoint total energy is not used as a proxy
for the unlogged direct increment.

## Honest 32-step diagnostic

The same one-repeat command with `--steps 32` publishes step 1, then fails on
the next step after 20 backtracks. Its final trial has:

```text
direct_delta_j=-2.49964928864575686e-44
direct_exchange_component_j=-2.49964928864575686e-44
endpoint_residual_delta_j=0
endpoint_residual_operand_absolute_sum_j=0
direct_armijo_decision=Reject
previous device state restored
```

The direct decrement is negative but smaller in magnitude than the unchanged
strict sufficient-decrease demand at that final trial. This is a different
late numerical-stagnation class, not the removed positive cancellation
artifact. No resolved uphill step was accepted and rollback is explicit.

Diagnostic artifact hashes:

- 32-step-request CSV:
  `cc0f16632a764d23f4a39578f427b529dd82d8c998c645221caedb67cfb3a8c1`;
- 32-step-request raw log:
  `2345afde3ee9eb35c16ef84c9091906724d598ac260e904b7f08d40376ecc4f6`.

The runtime artifacts remain ignored under `.fullmag/reports/` and are not
staged. `.superpowers/sdd/progress.md` remains root-owned and was not edited,
staged, or reverted by Task 3.

## Remaining concern

Task 3 corrects the cancellation and proves the first diagnosed GPU decision;
it does not qualify a long-horizon exchange-plus-Zeeman trajectory. The
32-step request still ends non-converged at a later strict-Armijo stagnation.
That result must remain open for later identity-pinned production-matrix work,
without changing strict Armijo, adding a gradient floor, or treating
stagnation as convergence.
