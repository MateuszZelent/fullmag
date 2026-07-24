# Task 8 — direct Armijo increment qualification

Date: 2026-07-25

Status: **IMPLEMENTED_AND_EXACT_RUNTIME_QUALIFIED**. The final identity-pinned,
five-repeat PG-BB production matrix passes on the rebuilt managed FEM GPU
runtime. This status establishes numerical correctness, runtime identity and
the four-control-readback contract. It does **not** claim a GPU speedup on the
small qualification mesh.

## Numerical change

- CPU and GPU direct minimizers decide Armijo acceptance from signed discrete
  energy increments instead of subtracting nearly equal endpoint totals.
- Every enabled energy owner is composed exactly once. Exchange, Zeeman,
  uniaxial anisotropy and cubic anisotropy have direct GPU increments; demag
  and the remaining residual-owned terms retain explicit ownership.
- Exchange uncertainty is derived from the polarized edge operands actually
  used by the increment. Uniaxial uncertainty is derived from the actual
  quadratic and quartic factor products, not the full endpoint energy scale.
- Cubic anisotropy uses double-double products and accumulation in the local
  direct kernel. The tangent projection also uses double-double dot products
  and subtractions to preserve small representable chords.
- Signed increments carry independent absolute-term magnitudes and roundoff
  bounds. A trial is accepted only when the upper increment bound satisfies
  the unchanged strict Armijo inequality.
- An unrepresentable stationary chord restores the previous state and is not
  counted as an accepted step.
- GPU PG-BB retains the canonical four-control-readback-per-step contract;
  no tolerance, BB update, restart, fresh-zero demag or profiler contract was
  loosened.

## Exact managed runtime identity

The final identity was captured from the rebuilt managed bundle and then
passed back to the production benchmark as a mandatory gate:

| Property | Final value |
|---|---|
| device | NVIDIA GeForce RTX 4080 SUPER |
| compute capability | 8.9 |
| precision | double |
| OpenMP threads | CPU 1, GPU host lane 1 |
| runtime variant | `candidate-sm89` |
| runtime manifest SHA-256 | `4edbd92f41ce304ca1b3b09a6254eda436622487c1ac889fcbde6c674558f007` |
| source manifest SHA-256 | `e45689348c9f10909daca216817366b2e6d4c6fc80a5d02e3abb4cec4439a8fd` |
| `libfullmag_fem` SHA-256 | `b57830b1ee8f64f9f0fdbade28904cfe1da1992565b254a7ee0419b85b8f69b5` |
| MFEM / HYPRE binding provider | MFEM 4.9 / bundled HYPRE 3.1.0 |

The runtime validator also observes the distribution's system HYPRE 2.22.1
SONAME in the process closure. The exported Fullmag HYPRE bindings resolve to
the bundled 3.1.0 provider; eliminating the unrelated system SONAME remains a
packaging concern, not an unresolved Task 8 binding ambiguity.

## Exact five-repeat acceptance

Command:

```bash
COMPOSE_FILE=compose.yaml:.fullmag/task6-compose-external-network.yaml \
FULLMAG_BENCH_RELAX_ALGORITHMS=projected_gradient_bb \
FULLMAG_BENCH_GPU_PGBB_CONTROL_READBACK_PER_STEP=4 \
FULLMAG_BENCH_REPEAT=5 \
FULLMAG_BENCH_TASK8_QUALIFICATION_IDENTITY=.fullmag/reports/task8-qualification/final-dd-identity.json \
FULLMAG_BENCH_OUTPUT=.fullmag/reports/task8-qualification/final-dd-repeat5.csv \
FULLMAG_BENCH_SUMMARY=.fullmag/reports/task8-qualification/final-dd-repeat5-summary.json \
just verify-fem-relaxation-production-benchmark
```

Result:

- 120 rows, 120 `ok`, zero failed rows;
- 9/9 required CPU/GPU case pairs completed;
- zero consistency, qualification, group or identity failures;
- Task 8 identity gate `pass` with repeat count exactly five;
- one solver-mesh signature across the matrix;
- maximum demag residual `4.993e-13` and maximum 31 iterations;
- all GPU PG-BB rows remain within the canonical control-readback bound.

Authoritative artifacts:

| Artifact | SHA-256 |
|---|---|
| `.fullmag/reports/task8-qualification/final-dd-identity.json` | `3b2eca897f6eb76822c8f3e73e94142009f2f0364d5d103e4aca1b02af4e3f03` |
| `.fullmag/reports/task8-qualification/final-dd-repeat5.csv` | `b2f3d8afbe77ac8ecf151d28a2ad47f0e2c51daeea7ff46a59e0c3cf6d7c47da` |
| `.fullmag/reports/task8-qualification/final-dd-repeat5-summary.json` | `9900a73fda861863c2df696c9507d3a715a711267c1c10fb33244c38b63f46f8` |

Earlier 95/110, 360/360 and diagnostic `LD_PRELOAD` matrices are retained only
as development evidence. They do not supersede this final identity-pinned
managed result.

## Performance interpretation

The qualification case is deliberately small and launch/synchronization
dominated. Aggregate benchmark wall time was 73,401.4 ms on CPU and 81,013.5 ms
on GPU across 60 rows per lane, so this matrix shows about a 10.4% GPU deficit, not a
speedup. Representative non-demag medians are roughly 0.52–0.56 s on CPU and
0.58–0.65 s on GPU. For demag with JACOBI, median solver-apply time is close
between lanes (about 16–18 ms), while total GPU wall time remains higher.

This is compatible with the Task 8 objective: the work removes incorrect
endpoint cancellation and bounds host control readbacks. Demonstrating useful
GPU saturation or a crossover speedup requires the later scale sweep and
timeline/profile tasks on substantially larger meshes. The small production
fixture must not be advertised as evidence that the RTX 4080 is fully used.

## Verification

- managed source, CUDA derivative, stage-completion and explicit-RK contracts:
  pass;
- managed FEM relaxation runtime smoke, including real RTX 4080 SUPER and
  device HYPRE Poisson: pass;
- Zhang-Li skew-tetra CPU/GPU contract: pass;
- exact identity-pinned PG-BB repeat-five matrix: 120/120 pass;
- NCG is covered by the managed source and focused numerical contracts, but is
  deliberately outside this final PG-BB-only repeat-five qualification artifact;
- Python benchmark and identity validator: 252/252 pass;
- direct derivative matrix covers exchange, Zeeman, uniaxial and cubic
  anisotropy, DMI, demag and prescribed-strain magnetoelasticity: pass.

## Remaining work outside Task 8

- establish the CPU/GPU crossover with versioned larger meshes;
- profile kernel occupancy, launch gaps and HYPRE device execution with a
  timeline profiler;
- separate setup, accepted-step and visualization/API costs in production-size
  runs;
- audit and remove the unrelated system HYPRE SONAME from the runtime closure;
- qualify throughput and GPU utilization rather than inferring them from
  `nvidia-smi` sampling.
