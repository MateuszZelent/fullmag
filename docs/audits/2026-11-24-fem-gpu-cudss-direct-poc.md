# FEM GPU: cuDSS direct Poisson solve, proof of concept (2026-11-24)

Physics note: `docs/physics/0997-fem-gpu-poisson-direct-cudss.md`. The realization is opt-in through
`FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER=cudss`; without it every run follows the existing CG/AMG path.

## Summary

- One Heun step at 49 176 nodes takes 72 ms with the cuDSS solve instead of 909 ms with CG/AMG (12.6×).
- At 89 732 nodes, 150 ms instead of 1 758 ms (11.7×).
- `m_final` agrees with CG/AMG to 5e-10 after 20 steps, and the default path is bit-identical.
- The price is device memory: the Cholesky factor needs 2.2 GiB at 49 k nodes and 5.2 GiB at 90 k nodes. On an 8 GB
  card the realization fits up to about 90 k nodes of the measured geometry.

## Motivation: where the CG/AMG step goes

Profile with `FULLMAG_FEM_STEP_PROFILE=1`; 49 176 nodes, Heun, CG/AMG `rtol = 1e-8`; means over steps 2..N−1 of
`performance/steps.csv`.

| Mean per step | Value |
|---|---:|
| Step (`reported_solver_wall_time_ns`) | 884.7 ms |
| Inside the HYPRE solve call (`solver->Mult`, host wall clock) | 871.9 ms (98.6 %) |
| CUDA-event timeline of the same solves | 866.8 ms |
| Everything else in the step | 12.8 ms |
| PCG iterations | 185.3 (about 4.8 ms each) |

The event timeline spans the whole host call, while `nvidia-smi` shows the GPU under 1 % busy. Each PCG iteration is
paced by host-side kernel launches and the synchronizations that return the scalar products to the host. The operator
does not change during the run, which makes a factorization done once worth testing.

## Implementation

What is on the device under the override (49 176 nodes, P2 potential, 394 216 unknowns):
- the Poisson matrix $K$ as sorted lower CSR, 5.86 M stored entries (about 70 MB), copied once from the
  boundary-conditioned host operator `poisson_bc_op`;
- the Cholesky factor $L$ with $P K P^{\mathsf T} = L L^{\mathsf T}$, 237.8 M nonzeros, 2 300 MiB measured. cuDSS
  computes the ordering on the host (analysis, 5.7 s) and the factor on the device (factorization, 3.5 s), once per
  operator;
- the existing right-hand side and solution vectors (about 3 MB each).

Per evaluation, the solve phase runs two triangular substitutions over $L$ on the HYPRE stream, inside the same
fences that order the CG solve. Nothing moves between host and device except the three norms of the existing
independent residual check.

The solve time follows the size of the factor: about 4, 19 and 45 ms per solve for 46 M, 238 M and 549 M nonzeros. This
fits a solve bound by reading the factor from device memory.

The HYPRE PCG and AMG objects are not built under the override.

## Results

Case: `scripts/benchmarks/fem_memory_transfer_case.py`, a 200×200×20 nm permalloy-like box (Ms 800 kA/m, A 13 pJ/m)
with airbox, Poisson Robin, Heun, `dt = 2e-14 s`, CG/AMG `rtol = 1e-8` as the requested policy, preview off. One
build; the realization was chosen only by the environment variable, and the runs were interleaved. RTX 5050 8 GB under
WSL2, cuDSS 0.8.0.10, CUDA 12.9. Step time is the mean over steps 2..N−1 of `solver_steps.csv`. The first step includes
the cold start; the last row includes end-of-run work.

**Default path unchanged.** Without the variable, `m_final` at 49 176 nodes was bit-identical to the build without this
change.

**Step time.**

| Mesh (P2 unknowns) | CG/AMG step | cuDSS step | Speed-up | Iterations per step | Factor nonzeros | Factor device memory | Analysis + factorization |
|---|---:|---:|---:|---:|---:|---:|---:|
| 14 911 nodes (117 651) | 530.7 / 697.0 ms | 20.2 / 19.6 / 18.7 ms (last: 500 steps) | ~26–36× | 136.6 → 3 | 46.5 M | 524 MiB | 2.3–3.3 s |
| 49 176 nodes (394 216) | 905.1 / 882.9 / 940.1 ms | 72.3 / 70.4 / 74.6 ms | **12.6×** | 185.3 → 3 | 237.8 M | 2 300 MiB | 9.3 s |
| 89 732 nodes (723 473) | 1 758.4 ms | 150.0 ms | **11.7×** | 246.9 → 3 | 549.4 M | 5 310 MiB | 21.7 s |

Notes on the table:
- At 49 k nodes, `FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING=0` on the same build gave 768 ms, so cuDSS is 10.6× faster
  than the best AMG setting we found.
- The GPU is busy 6–11 % with cuDSS, against 0.2–1 % with CG/AMG.

**Whole 20-step runs, wall clock including host setup.**

| Mesh | CG/AMG | cuDSS |
|---|---:|---:|
| 14 911 nodes | 35.0 / 44.6 s | 17.7 / 17.1 s |
| 49 176 nodes | 83.0–84.9 s | 59.7–60.2 s |
| 89 732 nodes | 173.6 s | 121.3 s |

**Memory (process peaks).**

| Mesh | Device memory, CG/AMG → cuDSS | Host RAM, CG/AMG → cuDSS |
|---|---:|---:|
| 14 911 nodes | 263–269 → 771–783 MiB | 1 275–1 285 → 1 391–1 396 MiB |
| 49 176 nodes | 730–738 → 2 918–2 921 MiB | 3 145–3 147 → 3 630–3 632 MiB |
| 89 732 nodes | 1 277 → 6 095 MiB | 5 344 → 6 448 MiB |

**Physics.**

| Check | 14 911 nodes | 49 176 nodes | 89 732 nodes |
|---|---:|---:|---:|
| Max certified relative residual, cuDSS | 2.3e-15 | 2.5e-15 | 2.6e-15 |
| Same, CG/AMG | 3.0e-9 | 2.8e-9 | 5.7e-9 |
| max \|Δm\| of `m_final`, cuDSS vs CG/AMG, 20 steps | 2.8e-10 | 4.7e-10 | 4.0e-10 |
| Max relative difference of E_total over 20 steps | 1.4e-13 | 8.0e-14 | 2.1e-14 |
| Max relative difference of E_demag over 20 steps | 1.7e-11 | 8.2e-12 | 9.1e-12 |

Over 500 steps (10 ps) at 14 911 nodes the energies drift apart to 3.4e-9 (E_total) and 2.2e-8 (E_demag) relative.
That is the scale of the CG tolerance.

## Findings

1. **Silent spill beyond device memory.** At 199 457 nodes (1 620 071 unknowns) the factor has 1.66 × 10⁹ nonzeros,
   about 12 GiB of values. The run still completed:
   - cuDSS measured 4.8 GiB of dedicated memory, while `nvidia-smi` showed a 6 581 MiB peak;
   - analysis and factorization took 325 s, and a step took 3.1 s.

   We infer that the WDDM driver under WSL2 placed the rest in system memory; the spill itself was not observed. A
   production version needs a preflight from the analysis-phase memory estimate and a resolution to CG/AMG. It cannot
   rely on an out-of-memory error.
2. **Pre-existing: a longer CG/AMG run failed at the end.** A 500-step CG/AMG run at 14 911 nodes completed every step
   and wrote all scalars. It then waited about 100 s and stopped with `timed out waiting for artifact provenance update`
   (`crates/fullmag-runner/src/artifact_pipeline.rs`), without `m_final.json`.
   - The 27 s cuDSS run of the same length finished normally.
   - The end-of-run work in the last step was 14–21 s with CG/AMG and about 1 s with cuDSS at 49 k nodes.

   Hypothesis: the artifact-writer backlog grows with the wall-clock length of a run. This is independent of this
   change and needs its own issue.
3. **Next lever.** A cuDSS step at 49 k nodes is about three solves of ~19 ms plus ~15 ms of other work. Heun's third
   solve recomputes the field at the accepted state that the next step evaluates again. Under warm-started CG that
   solve was nearly free; with a direct solve it costs as much as the others. Carrying it into the next step as k0
   should save about a quarter of the step.

## Proposed next steps

1. A device-memory preflight from the analysis-phase estimate, and a resolution to CG/AMG when the factor does not fit.
2. A provenance field and an executed-operator bit for the resolved realization. The proof of concept keeps
   `DEMAG_SOLVE | PRECONDITIONER`, because the runner's required mask follows the requested CG/AMG policy. The
   realization shows only in a stderr receipt line and as one iteration per solve.
3. A public-policy decision: a `DIRECT` solver value, or an automatic resolution by size. Then the managed
   qualification.
4. The periodic reduced operator and FEM/BEM stay excluded; FEM CPU is unchanged.

## Reproduce

Inside the DEV backend container of a checkout with this change:

```bash
# CG/AMG
python3 scripts/benchmarks/run_memory_transfer_probe.py --output /build/perf-cudss --keep \
  --case-script scripts/benchmarks/fem_memory_transfer_case.py --backend fem --label amg_h2.5 \
  --env FEM_CASE_DEVICE=gpu --env FEM_CASE_HMAX=2.5e-9 --env FEM_CASE_STEPS=20 --env FEM_CASE_PRECONDITIONER=AMG
# cuDSS: same command with one more variable
python3 scripts/benchmarks/run_memory_transfer_probe.py --output /build/perf-cudss --keep \
  --case-script scripts/benchmarks/fem_memory_transfer_case.py --backend fem --label direct_h2.5 \
  --env FEM_CASE_DEVICE=gpu --env FEM_CASE_HMAX=2.5e-9 --env FEM_CASE_STEPS=20 --env FEM_CASE_PRECONDITIONER=AMG \
  --env FULLMAG_FEM_DEMAG_GPU_DIRECT_SOLVER=cudss
```

`FEM_CASE_HMAX=4e-9` and `2e-9` give the 15 k and 90 k-node meshes. The step times come from
`runs/<label>-*/out/artifacts/solver_steps.csv` (`wall_time_ns`, steps 2..N−1). The probe prints device-memory and host
RSS peaks to `results.jsonl`.
