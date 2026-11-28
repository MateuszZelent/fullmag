# FEM GPU jobs with one CPU core per job: rig emulation and CUDA wait mode (2026-11-26)

Related: [cuda-wait-mode.md](../performance/cuda-wait-mode.md) (the `FULLMAG_CUDA_WAIT_MODE` switch),
[0997](../physics/0997-fem-gpu-poisson-direct-cudss.md), [0998](../physics/0998-fem-gpu-rk-fsal-and-potential-predictor.md).

## 1. Why

Production runs are planned on mining rigs: 5–10 consumer GPUs and one CPU per machine. The CPU, its RAM and
its PCIe lanes are shared by all jobs, so the cost of a job is its CPU time, its host RAM and its host↔GPU
traffic, not how well it scales over many cores. This audit emulates "one core per job" on a workstation and
measures those costs for FEM GPU jobs. FDM GPU is not measured yet.

## 2. Summary

- **One CPU core per FEM GPU job is enough.** With one logical CPU and thread pools of 1, step time and
  setup time match the 8-CPU DEV default within 1 %.
- **But each job keeps its core 100 % busy for the whole run, including steps where only the GPU works.**
  When a core is shared, jobs slow each other down:

  | Jobs per core | cuDSS setup | cuDSS step | CG/AMG step |
  |---|---|---|---|
  | 2 | 2× longer | +29 % | +74 % |
  | 3 | 3× longer | +20–60 % | 2.9× slower |

- **`FULLMAG_CUDA_WAIT_MODE=blocking`** (added in this PR, default unchanged) removes most of the cuDSS
  step penalty when two jobs share a core: median 32.0 → 24.8 ms against 24.5 ms with a core of its own.
  Without sharing it costs nothing measurable. Under WSL2 the host thread still cannot sleep during a CUDA
  wait in any mode (section 6), so the expected CPU-time saving must be confirmed on native Linux.
- **Host RAM (not VRAM) is the likely limit on rigs.** Peak host RSS is 2.1–2.4 GB per job at 30k nodes and
  6.4 GB at 90k nodes. VRAM is separate: about 0.5–1.7 GB at 30k nodes and about 6 GB at 90k nodes.
- **Setup is single-threaded and dominates short jobs.** It takes 34 s at 30k nodes and about 120 s at 90k
  nodes. Native backend creation alone takes 23 s and 86 s.
- **PCIe x1 risers matter only for the CG/AMG path.** cuDSS moves about 0.5 MB per step; CG/AMG about 60 MB
  per step, mostly host→GPU, which already happened before #564 (72 MB per step on the #550 code).

## 3. Setup

- **Code.** Master `8ba42a726` (includes #561, #564, #565, #566). For the wait-mode runs, the same code plus
  the switch from this branch. Runs are headless `fullmag-bin` inside the DEV backend container, with the API
  detached.
- **Hardware.** RTX 5050 8 GB (PCIe 5.0 x8), Windows driver 610.88 (CUDA 13.3) under WSL2, CUDA runtime 12.9,
  cuDSS 0.8.0.10. Threadripper 7970X, 44 logical CPUs visible in WSL. About 1.5 GB of VRAM is used by other
  processes before each run (Windows desktop, other containers).
- **Case.** `scripts/benchmarks/fem_memory_transfer_case.py`: 200×200×20 nm box in an air box, random initial
  texture, Heun, fixed dt 2e-14 s, float64. A new knob `FEM_CASE_GPU_STRATEGY` selects `auto` (resolved to
  cuDSS in all runs) or `cg_amg`.
  - hmax 3 nm: 30 471–30 507 nodes (meshing is not fully deterministic between runs).
  - hmax 2 nm: 89 572 nodes.
  - hmax 2.5 nm (about 49k nodes, used on 2026-11-23) could not be measured: this master no longer builds
    that mesh (section 7).
- **Configurations.**
  - A: DEV default (cgroup quota of 8 CPUs, thread pools of 4).
  - B: one logical CPU (`taskset`) and thread pools of 1 (`FULLMAG_CPU_THREADS`, `OMP_NUM_THREADS`,
    `RAYON_NUM_THREADS`, …).
  - C: one logical CPU, thread pools left at 4.
  - D and D2: B plus one or two busy-loop processes pinned to the same CPU. Today a FEM GPU job keeps its
    core busy all the time, so a busy loop is a fair stand-in for another job.
- **Instruments** (`scripts/benchmarks/`):
  - `rig_probe.py`: CPU time, peak RSS and context switches from `getrusage`, plus a process-tree sample
    every 0.2 s;
  - `nvml_gpu_sample.c`: NVML PCIe byte counters (fields 197/198, whole GPU) and VRAM, read before and after
    each run and every 5 s. The idle GPU background (about 1.5–2 MB/s each way) is subtracted.
  - Per-step costs come from differencing the 10-step and 110-step runs. Step medians come from
    `performance/steps.csv` (steps 2..N-1).
  - CUPTI 12.9 activity tracing does not work under this WSL2 driver (`CUPTI_ERROR_INVALID_DEVICE`), so
    transfers are counted in bytes, not copies.
- **Reproduction.** `scripts/benchmarks/run_rig_fem_matrix.sh` runs the same configurations; it was
  assembled from the matrices actually run, so the labels differ from the raw data. Raw data are kept
  locally by the author and are available on request.

## 4. Results

### Step time (median over steps 2..N-1)

| Case | A | B (1 core) | C (1 core, 4 threads) | D (2 per core) | D2 (3 per core) |
|---|---:|---:|---:|---:|---:|
| 30k nodes, cuDSS | 25.0 ms | 24.8 ms | 24.9 ms | 32.0 ms | 29.9 ms (p90 40 ms) |
| 30k nodes, CG/AMG | 554 ms | 553 ms | 561 ms | 964 ms | 1591 ms |
| 90k nodes, cuDSS | 95.4 ms | 95.1 ms | – | – | – |

### Per job

| Case | Setup wall (= CPU) | Backend creation (1 / 2 / 3 jobs per core) | Peak host RAM | VRAM in use | PCIe in setup | PCIe per step |
|---|---:|---|---:|---:|---:|---:|
| 30k, cuDSS | 34 s | 23 / 46 / 66 s | 2.4 GB | ~1.7 GB | 0.72 GB | 0.5–0.6 MB |
| 30k, CG/AMG | 30–38 s | 19 / 39 / 57 s | 2.1 GB | ~0.5 GB | 0.64–0.73 GB | ~60 MB |
| 90k, cuDSS | ~121 s for 10 steps | 86 s (1 job) | 6.4 GB | ~6.0 GB | 2.3–2.5 GB | – |

- **CPU load.** CPU time equals wall time within 2 % in every A, B and C run, during the steps too.
- **Rough phase split** of the 30k cuDSS run (B), from the thread-count timeline:
  - about 9 s Python start, meshing and IR;
  - about 18 s native backend creation;
  - 0.25 s for 10 steps;
  - about 6 s end-of-run artifact writing.
- **90k nodes.** The run logs a cuDSS estimate of 5.12 GB against a budget of 5.28 GB and has 0.6 GB of
  VRAM left after setup. On 6 GB cards, `auto` will fall back to CG/AMG well below 90k nodes.

### Comparison with the #550 code (branch head `843b04a27`, same case and card, one core)

| | #550 code | master `8ba42a726` |
|---|---:|---:|
| cuDSS step, 30k nodes | 40.4 ms | 24.5 ms |
| cuDSS step, ~90k nodes | 150 ms | 95 ms |
| CG/AMG PCIe per step, 30k nodes | 72 MB | ~60 MB |
| cuDSS run-to-run difference of the final m (110 steps) | 3.7e-14 | 2.3e-14 |

The FSAL and predictor work in #564 made the cuDSS step about 40 % faster. cuDSS has never been bitwise
reproducible from run to run here; the default CG/AMG path is.

## 5. CUDA wait mode (`FULLMAG_CUDA_WAIT_MODE`, this PR)

30k nodes, cuDSS, configuration B with and without busy neighbours:

| Wait mode | Own core | 2 per core | 3 per core |
|---|---:|---:|---:|
| default | 24.5 ms | 32.0 ms (mean 32.6) | 28.0 ms (mean 31.0) |
| blocking | 24.6 ms | 24.8 ms (mean 27.1) | 28.0 ms (mean 28.8) |
| yield | 24.5 ms | 27.0 ms (mean 27.8) | – |

- CG/AMG with 2 jobs per core: 1106 ms (default) vs 1048 ms (blocking).
- CPU time per step equals step time in all modes on WSL2. Over 1000 steps: 26.2 ms (default) and 25.9 ms
  (blocking).
- A per-thread sample shows that the stepping thread (`fullmag-script-mode`) uses 100 % of the core with zero
  voluntary context switches.
- CG/AMG results are bitwise identical across modes. cuDSS results differ at the 1e-14 level between any two
  runs, independent of the mode.

## 6. WSL2 cannot sleep during a CUDA wait

`scripts/benchmarks/wait_mode_probe.cu` waits for a 1.8 s kernel. On WSL2 with driver 610.88 the wait costs
1.8 s of CPU time in every mode: `default`, `spin`, `yield`, `blocking` (flag 0x4 confirmed), and an event
created with `cudaEventBlockingSync`. So on WSL2 a FEM GPU job always occupies its core, and `blocking` can
only make the waiter give the core away more readily. Native Linux drivers normally put a `blocking` waiter
to sleep. Running the same probe and section 5 on a native Linux machine is the next step.

## 7. Problems found on the way

1. **Mesh.** The 2.5 nm mesh of `fem_memory_transfer_case.py` no longer builds on this master. All three
   Gmsh algorithms produce degenerate tetrahedra; after 35 of them are dropped, the pipeline stops with
   `MeshQualityUnavailableError: quality_unavailable_after_topology_mutation`. The same case meshed on
   2026-11-23. The 3 nm and 2 nm meshes build.
2. **Prism film case.** `relax_film_compare_case.py` with FEM fails the conformity check
   (`same_side_two_owner_face` in `transition_air`). This was already reported as a known issue.
3. **CG/AMG transfers about 60 MB host→GPU per step** (72 MB on the #550 code). The cause is not
   identified. On a PCIe 3.0 x1 riser (about 0.8 GB/s) this adds about 75 ms per step (+14 %).
4. **cuDSS is not bitwise reproducible from run to run** (1e-14 after 110 steps). From the random initial
   texture the difference grows to O(1) after 1110 steps, probably because of the chaotic early dynamics.
   If cuDSS offers a deterministic mode, it would be worth checking.
5. **CUPTI 12.9 activity tracing fails under WSL2** with this driver (`CUPTI_ERROR_INVALID_DEVICE`).

## 8. Open questions

1. **Wait-mode policy** (see cuda-wait-mode.md):
   - choose `blocking` by load, when more GPU simulations run than there are cores for them. The count of
     started simulations must come from the launcher or a host registry; one process cannot see the others.
   - or make `blocking` the default, if native Linux confirms that the wake-up cost stays small.
2. **Native Linux check** of section 5 and `wait_mode_probe.cu`, ideally on a rig.
3. **Host RAM per job** during backend creation (2.4 GB at 30k nodes, 6.4 GB at 90k nodes) and setup time:
   - a per-mesh cache of the mesh, the assembled operators and the cuDSS reordering;
   - not starting several jobs' setup on one core at the same time.

## 9. Caveats

- WSL2 uses the WDDM driver path; launch, sync and copy costs may differ on native Linux rigs.
- A Threadripper core is faster than a typical rig CPU core, so the setup times are lower bounds.
- One run per configuration. The step medians come from 100+ steps; setup varies by a few seconds between
  runs.
- The PCIe projection uses bytes only; per-copy latency is not included.

## 10. Update 2026-11-27: host RAM fixes in this PR

A heap trace (`FULLMAG_FEM_MEMORY_TRACE=1|2`, added here) showed that about half of the plateau was freed
`std::map` memory from `build_mixed_demag_operators` that glibc keeps, plus host copies that nothing reads
after the upload. Fixes in this PR:
- assemble the demag operators directly as CSR (same summation order, byte-identical arrays);
- free A0 and the host CSR copies early on the device-Hypre lane;
- run `malloc_trim(0)` after the upload and at the end of setup (`FULLMAG_FEM_MALLOC_TRIM=off` opts out).

| Case | Peak before → after | Plateau or setup-end RSS before → after | Backend creation | Step time |
|---|---|---|---|---|
| 30k nodes, cuDSS | 2.36 → 1.29 GiB | plateau 2.06 → 1.21 GiB | ~24 → ~14 s | unchanged (24.7–25.4 ms) |
| 69k nodes, cuDSS | 4.89 → 2.23 GiB | setup-end RSS 4.07 → 1.51 GiB | 63 → ~38 s | unchanged |

Verification:
- the native contract `fem-demag-poisson` passed, including a new byte-equality case for CSR vs map
  assembly (also covering periodic, nodal-Ms, −0.0 and NaN fixtures);
- CG/AMG `m_final.json` and `scalars.csv` are byte-identical before and after at 30k and 69k nodes;
- the `auto` → `hypre_krylov` VRAM fallback is bitwise equal to `cg_amg`, and forced `cudss` over budget
  still fails;
- a two-stage script is bitwise identical, and the periodic cuDSS lane agrees within cuDSS run-to-run
  noise.
