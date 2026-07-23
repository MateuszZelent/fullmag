# Armijo Task 2 implementation report

## Scope

Implemented the CPU/MFEM polarized exchange increment owner required by Task 2:

- added the focused
  `cpu/mfem/interactions/exchange_energy_difference.{hpp,cpp}` owner;
- evaluated the production exchange convention
  `E_ex(m) = m^T K_A m` as
  `(trial-base)^T K_A (trial+base)` using the already assembled symmetric
  `exchange_form`;
- integrated direct demag, Zeeman, uniaxial, and exchange increments into CPU
  PG-BB exactly once each;
- retained DMI, magnetoelastic, and cubic anisotropy as explicit endpoint
  residuals with `abs(base) + abs(trial)` uncertainty scales;
- retained independent per-owner roundoff bounds and added the residual bound;
- preserved the existing Armijo coefficient, ambiguity/refinement policy,
  backtrack limit, BB update, restart behavior, tolerances, stopping rules, and
  benchmark fixtures.

The exchange owner validates exact AoS/MFEM dimensions and finite input and
polarized vectors, uses audited MFEM host access and
`mfem::Device::IsEnabled()`, polls interruption, and owns exactly one
`ExchangeInterop` audit scope. It applies `exchange_form.Mult(sum, applied)`
directly and never mass-projects to `H_ex`. Magnetic/nonmagnetic semantics are
therefore inherited from the assembled form's magnetic attribute marker.

## RED evidence

The required managed command was run with the repository's external-network
overlay:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just verify-fem-relaxation-source-contract
```

The first sandboxed attempt reached Docker but exited 1 because the sandbox
could not access `/var/run/docker.sock`. The approved managed rerun reached the
native build and produced the intended RED (`exit 2`):

```text
fatal error: cpu/mfem/interactions/exchange_energy_difference.hpp:
No such file or directory
```

This was the expected missing-owner failure from the new production-linked
energy-derivative contract.

## GREEN evidence

After implementation, the same managed command passed twice, including a final
rerun after the last finite-vector validation change. Final result: `exit 0`.
The managed container rebuilt the new owner and linked library, then passed:

```text
[100%] Built target fem_relaxation_source_contract
[100%] Built target fem_relaxation_energy_derivative_contract
[100%] Built target fem_stage_completion_contract
[100%] Built target fem_rk_explicit_contract
PASS: FEM relaxation energy derivative matrix
```

The new production-helper tests prove separately that:

- the polarized accumulation matches a `long double` oracle;
- it matches endpoint `m^T K_A m` subtraction when that subtraction is
  resolvable;
- a near-nullspace decrement remains finite and negative when the two binary64
  endpoint energies compare equal;
- non-finite component input fails closed.

The source contract also proves that CPU PG-BB no longer reads exchange
endpoint energies, that all four direct owners occur once, and that the DMI,
magnetoelastic, and cubic residuals retain independent endpoint operand scales.
The unchanged strict Armijo decision still rejects a resolved uphill upper
bound and refines only an ambiguous interval.

## Managed CPU PG-BB reproduction

To avoid accidentally exercising the pre-change bundled library, the managed
runtime was first rebuilt:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
just rebuild-fem-runtime
```

Result: `exit 0`. Runtime identity used by the reproduction:

- runtime manifest SHA-256:
  `6013e049e3785fe9887cf9427caf1e75ea4b98df36ef43052da0829f0c49ba3d`;
- source manifest SHA-256:
  `f950725d3ca76135aa7766ff37335b2e016db669444bc5bd7d49d62fd183aa0c`;
- loaded `libfullmag_fem.so.0.1.0` SHA-256:
  `0e4fa296ea08bab08c34e8cd4b541c4dbc87c50c8ecd3ae7c5334f08f1cefad2`;
- runtime variant `candidate-sm89`, with `sm_89` in the FEM library and the
  recorded RTX 4080 SUPER / compute capability 8.9 diagnostics.

The focused managed command used the existing coarse box500/airbox fixture,
`hmax=250e-9 m`, `airbox_hmax=500e-9 m`, CPU only, Heun stage plumbing,
PG-BB, 32 requested minimizer steps, and exactly one repeat:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
docker compose --profile fem-gpu run --rm \
  -e PYTHONPATH=/workspace/packages/fullmag-py/src \
  -e FULLMAG_PYTHON=/usr/bin/python3 \
  -e FULLMAG_BENCH_DOMAIN_HMAX=250e-9 \
  -e FULLMAG_BENCH_AIRBOX_HMAX=500e-9 \
  fem-gpu bash -lc 'cd /workspace && python3 scripts/analysis/fem_gpu_benchmark.py \
    --meshes coarse \
    --scenarios exchange_only_box500_airbox1um,box500_airbox_exchange_anis_uniaxial \
    --integrators heun --relax-algorithms projected_gradient_bb \
    --backends cpu --thread-counts auto --steps 32 --repeat 1 \
    --case-timeout-s 600 --require-mfem-stack \
    --require-stable-solver-mesh --reuse-generated-domain-mesh \
    --output .fullmag/reports/armijo-task-2-cpu-pgbb.csv \
    --cpu-gpu-summary-output .fullmag/reports/armijo-task-2-cpu-pgbb-summary.json'
```

The same repeat-one command was rerun with
`FULLMAG_BENCH_RAW_CASE_OUTPUT` solely to retain otherwise temporary per-case
stdout. Both executions returned `exit 0` and the final two-row result was:

| Scenario | Status | Executed steps | Stop reason | Final total energy |
|---|---:|---:|---|---:|
| `exchange_only_box500_airbox1um` | `ok` | 32 | `max_steps` | `-5.4067953915602557e-33 J` |
| `box500_airbox_exchange_anis_uniaxial` | `ok` | 32 | `max_steps` | `-5.4067953915602557e-33 J` |

Both rows used solver-mesh signature
`ffe9595b4f6b6fc44fab022e733f2fbf2457ee8189929859a7f137f65dd10f11`.
Neither aliased fixture was classified `converged`; both honestly exhausted the
requested `max_steps`. The retained raw output reports total energy
`-3.3152e-33 J` after step 1 and `-5.4068e-33 J` after step 32, with no Armijo
error or accepted resolved-uphill diagnostic. The executable source/unit
contract, rather than sparse console cadence, supplies the per-trial proof that
resolved uphill intervals cannot be accepted.

Operational evidence was left untracked under:

- `.fullmag/reports/armijo-task-2-cpu-pgbb.csv`;
- `.fullmag/reports/armijo-task-2-cpu-pgbb-summary.json`;
- `.fullmag/reports/armijo-task-2-cpu-pgbb-cases.raw.log`.

The CPU-only benchmark rows themselves pass 2/2. The auxiliary CPU/GPU pair
section of the JSON naturally lists missing GPU partners because this focused
Task 2 reproduction intentionally requested `--backends cpu`; it is not a CPU
row failure and is not claimed as the later full CPU/GPU production matrix.

## Self-review and ownership

- No `Context` state, public ABI, exchange operator assembly, mass projection,
  Armijo/BB/restart constant, tolerance, stopping criterion, or fixture changed.
- Interrupts detected during the new direct evaluation return fail-closed
  non-finite data and the PG-BB caller restores the previous validated state.
- Cubic energy is classified explicitly rather than reconstructed by
  subtracting the direct uniaxial increment from a combined endpoint slot.
- `git diff --check` is clean.
- `.superpowers/sdd/progress.md` remains root-owned and was not edited, staged,
  or reverted by Task 2.

No remaining Task 2 implementation concern is known. Full identity-pinned
CPU/GPU pairing and five-repeat production qualification remain later plan
tasks and are not inferred from this focused two-row CPU result.
