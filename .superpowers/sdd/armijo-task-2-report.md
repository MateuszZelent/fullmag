# Armijo Task 2 remediation report

## Outcome

Task 2's CPU/MFEM polarized exchange increment owner remains in production,
and the review findings against commit `2c086344698c729532898e75a8ae2b2acfef2ff4`
are fixed:

- CPU PG-BB now includes the regional-drive endpoint energy exactly once in
  the residual increment and in its independent operand scale;
- the source contract audits every `fullmag_fem_step_stats` energy slot used by
  PG-BB, rather than checking only the exchange slot;
- the executable derivative contract now calls the real
  `exchange_energy_difference(Context &, ...)` against an assembled MFEM P1
  diffusion form and checks AoS/DOF mapping, magnetic-attribute exclusion,
  nonmagnetic-node isolation, and static-periodic projected states;
- the exchange-plus-uniaxial benchmark authors an explicit
  `UniaxialAnisotropy` term;
- a distinct
  `box500_airbox_exchange_anis_uniaxial_tilted` identity provides a genuinely
  nonstationary anisotropy fixture without silently changing the old fixture.

No Armijo coefficient, ambiguity/refinement rule, backtrack limit, BB update,
restart behavior, stopping rule, tolerance, public ABI, or `Context` state was
changed.

## Energy ownership after remediation

| Physical contribution | PG-BB increment owner | Endpoint stats used in decision |
|---|---|---|
| exchange | assembled-MFEM polarized difference | none |
| demag | direct demag difference | none |
| external Zeeman | direct Zeeman difference | none |
| uniaxial anisotropy | direct uniaxial difference | none |
| regional drive | endpoint residual | current + trial exactly once |
| DMI | endpoint residual | current + trial exactly once |
| magnetoelastic | endpoint residual | current + trial exactly once |
| cubic anisotropy | endpoint residual | current + trial exactly once |
| total energy | diagnostics only | current twice, trial once |

The four endpoint-residual pairs use
`abs(base) + abs(trial)` and an eight-scalar reduction bound. The direct owners
retain their own roundoff bounds. Aggregate exchange, demag, external, and
anisotropy endpoint slots do not participate in the Armijo increment, so those
terms cannot be double-counted.

## RED evidence

The focused authoring test initially failed because the alleged uniaxial
fixture still authored only exchange:

```text
E assert ['exchange'] == ['exchange', 'uniaxial_anisotropy']
```

The managed native gate was run through the repository-owned container path:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-source-contract
```

The review tests produced three successive, intentional RED states:

```text
FAIL: CPU PG-BB residual drive, DMI, magnetoelastic, and cubic terms must each retain one explicit base/trial operand scale
```

After the drive omission was fixed, the queued integration requirement failed:

```text
FAIL: the relaxation derivative contract must execute the production assembled-MFEM exchange difference owner
```

The first integration implementation then failed to compile, proving that the
test target did not yet own an MFEM link/include dependency:

```text
fatal error: mfem.hpp: No such file or directory
```

The CMake target was linked to the same existing `MFEM::mfem`/`mfem` target as
the neighboring operator contract; no hand-built host dependency was added.

## GREEN evidence

The final managed source gate returned `exit 0` and built and ran the source,
derivative, stage-completion, and explicit-RK contracts. Its executable result
included:

```text
[100%] Built target fem_relaxation_source_contract
[100%] Built target fem_relaxation_energy_derivative_contract
[100%] Built target fem_stage_completion_contract
[100%] Built target fem_rk_explicit_contract
PASS: FEM relaxation energy derivative matrix
```

The new adverse-drive numerical test proves the omission is decision-relevant:
the direct decrement alone passes strict Armijo, while the positive drive
endpoint increment makes the same trial reject. The drive operand scale uses
both endpoint magnitudes.

The focused benchmark-authoring checks also pass:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_fem_benchmark_config.py::test_phase10_anisotropy_scenarios_use_expected_terms_and_materials \
  packages/fullmag-py/tests/test_fem_benchmark_config.py::test_box500_airbox_interaction_manifests_cover_deterministic_terms \
  packages/fullmag-py/tests/test_fem_benchmark_config.py::test_exchange_uniaxial_fixture_authors_term_and_distinct_tilted_identity -q
```

Result: `3 passed in 1.41s`.

## Fresh managed runtime identity

The native changes were rebuilt before runtime evidence:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just rebuild-fem-runtime
```

Result: `exit 0`; release build completed in `8m 08s`, the bundle validator
reported `bundle=valid`, and the reproduction used:

- runtime manifest SHA-256:
  `bc74b3d9c4c900369051cd7c363536a30226351f97632cb0404b4e0a6fc28cdb`;
- source manifest SHA-256:
  `70c00c306bb63da9cdaaef4131c419fd2f139af8c3cdeaecae762132b070c079`;
- loaded `libfullmag_fem.so.0.1.0` SHA-256:
  `3a12af4722293e84092a7b680ed1b8fd4ead751cd809a1dd98a4aaba547f9dcf`;
- runtime variant: `candidate-sm89`.

## Exact CPU PG-BB reproduction

The exact one-repeat, 32-step command used CPU only, Heun stage plumbing, the
coarse box500/airbox mesh, `hmax=250e-9 m`, `airbox_hmax=500e-9 m`, the original
exchange-only fixture, and the new tilted uniaxial identity:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
docker compose --profile fem-gpu run --rm \
  -e PYTHONPATH=/workspace/packages/fullmag-py/src \
  -e FULLMAG_PYTHON=/usr/bin/python3 \
  -e FULLMAG_BENCH_DOMAIN_HMAX=250e-9 \
  -e FULLMAG_BENCH_AIRBOX_HMAX=500e-9 \
  -e FULLMAG_BENCH_RAW_CASE_OUTPUT=/workspace/.fullmag/reports/armijo-task-2-fix-cpu-pgbb-cases.raw.log \
  fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/fem_gpu_benchmark.py \
    --meshes coarse \
    --scenarios exchange_only_box500_airbox1um,box500_airbox_exchange_anis_uniaxial_tilted \
    --integrators heun --relax-algorithms projected_gradient_bb \
    --backends cpu --thread-counts auto --steps 32 --repeat 1 \
    --case-timeout-s 600 --require-mfem-stack \
    --require-stable-solver-mesh --reuse-generated-domain-mesh \
    --output .fullmag/reports/armijo-task-2-fix-cpu-pgbb.csv \
    --cpu-gpu-summary-output .fullmag/reports/armijo-task-2-fix-cpu-pgbb-summary.json'
```

| Scenario | Status | Executed steps | Stop/result | Energy evidence |
|---|---:|---:|---|---:|
| `exchange_only_box500_airbox1um` | `ok` | 32 | `max_steps` | `E_total = E_ex = -5.4067953915602557e-33 J` |
| `box500_airbox_exchange_anis_uniaxial_tilted` | `failed` | not published | honest numerical stagnation after 20 backtracks | current/trial `E_total = -2.49999999999999921e-16 J` |

The exchange-only row uses solver-mesh signature
`ffe9595b4f6b6fc44fab022e733f2fbf2457ee8189929859a7f137f65dd10f11`.
The tilted case was not stationary: step 1 reported `0.37711151228842643 T`
torque. At the late failure, the direct decrement was still negative
(`-3.59398300530397322e-46 J`) but could not satisfy the unchanged strict
Armijo demand (`-3.30473834377189575e-42 J`) at the final trial step
`9.58738002183924504e-13`. The previous state was restored. No resolved-uphill
step was accepted, no false convergence was reported, and no gradient floor was
added, exactly as required by the Task 2 stagnation policy.

An auxiliary one-step run of the same tilted identity passed and captured the
term decomposition that the old stationary evidence could not provide:

| Status | Steps | `E_total` | `E_ex` | `E_ani` | Final torque |
|---:|---:|---:|---:|---:|---:|
| `ok` | 1 | `-2.246818754437406e-16 J` | `2.7916761245735524e-33 J` | `-2.246818754437406e-16 J` | `0.37711151228842643 T` |

This proves the authored anisotropy is materialized and dynamically active;
the original report's two identical exchange-only rows did not.

Artifacts remain untracked under `.fullmag/reports/`:

- `armijo-task-2-fix-cpu-pgbb.csv`;
- `armijo-task-2-fix-cpu-pgbb-summary.json`;
- `armijo-task-2-fix-cpu-pgbb-cases.raw.log`;
- `armijo-task-2-fix-tilted-step1.csv`;
- `armijo-task-2-fix-tilted-step1-summary.json`.

## Scope and remaining qualification

This remediation closes the review findings and supplies a nonstationary
anisotropy reproduction. It does not claim full CPU/GPU production
qualification: the focused command intentionally requested CPU only and one
repeat. The late tilted-row stagnation is retained as a non-converged result,
not relabeled as success. Full identity-pinned CPU/GPU pairing and five-repeat
qualification remain later plan work.

`.superpowers/sdd/progress.md` remains root-owned and was not edited, staged,
or reverted by Task 2.
