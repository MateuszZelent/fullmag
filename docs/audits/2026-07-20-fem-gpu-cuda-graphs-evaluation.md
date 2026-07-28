# FEM GPU CUDA Graphs and kernel-fusion evaluation

Date evaluated: 2026-07-27

Scope: Task 16 of `docs/superpowers/plans/2026-07-20-fem-gpu-end-to-end-performance-remediation.md`

Decision source revision: `b12a7aae3da10f27561f7e09425a4ac971cee107` plus this documentation-only Task 16 commit

Decision: **NO-GO — do not create a CUDA Graph or kernel-fusion prototype**

## Executive result

Task 16 requires positive Nsight evidence before any prototype code: at least
15% of end-to-end time in launch/idle gaps attributable to Fullmag-owned
kernels, an identical kernel sequence in at least 90% of accepted steps, and
evidence that HYPRE coarse/reduction latency does not dominate the time a
Fullmag-owned graph could affect. The current Task 13 capture establishes none
of those three facts.

The latest capability-enabled Task 13 capture is fail-closed. Nsight Systems
recorded all eight required NVTX phase IDs but exported zero CUDA kernel rows.
The bounded Nsight Compute access probe reached device 0 and returned
`ERR_NVGPUCTRPERM`, even though the capture container had effective
`SYS_ADMIN`. The resulting `summary.json` has `status="failed"`; it is not an
authoritative kernel trace and cannot support launch-bound, sequence-stability,
occupancy, register-pressure, reduction, or HYPRE coarse-level attribution.

The plan says to stop without production code when any prerequisite is not
met. Accordingly, Task 16 adds no graph cache, no graph capture, no fused
kernel, no runtime selector, and no CMake wiring. HYPRE calls and host-driven
Armijo decisions remain unchanged and outside any graph.

## Prerequisite decision

All three conditions must pass simultaneously. An unmeasurable condition is a
failed gate, not permission to infer a favorable result.

| Required condition | Current evidence | Decision |
|---|---|---|
| At least 15% of end-to-end time is launch/idle gaps in Fullmag-owned kernels | The summary contains only inter-launch CUDA API gap count and percentiles. It has no gap total, no end-to-end share, zero kernel events, and no Fullmag/HYPRE ownership correlation. | **UNVERIFIABLE; gate fails closed** |
| At least 90% of accepted steps have an identical kernel sequence | Sixty-four NCG and Armijo NVTX phase instances show phase occurrence, not the ordered kernel sequence inside each accepted step. The kernel table is empty. | **UNVERIFIABLE; gate fails closed** |
| HYPRE coarse/reduction latency does not dominate the time outside Fullmag's graph scope | The HYPRE apply NVTX aggregate is available, but there are no HYPRE kernel names, coarse-level events, reduction events, or device-counter metrics. `reduction_count=0` comes from an empty kernel table and is not evidence of zero reductions. | **UNVERIFIABLE; gate fails closed** |

Because no prerequisite passes with the required attribution, neither CUDA
Graphs nor kernel fusion has an evidence-backed optimization target.

## Authoritative Task 13 evidence

Task 13 was introduced by commit
`4fb571467f94b4bcf1b528d0fdbd0f45a6c6ae8a` and its capture-only capability
scope was closed by
`96d486f680a9d1add11b673e089734e0d6304a55`. The tracked Task 13 report has
SHA-256 `6ea96f5b05b0d29f22318fd8b5682dd180d0769d3beb1d8c3b3c99d668155400`.

The exact capture command recorded by Task 13 was:

```text
just capture-fem-gpu-nsight
```

The fresh capability-enabled capture identity was:

| Item | Exact value |
|---|---|
| run ID | `task13-box500-airbox-ncg-sm89-v1` |
| Docker image ID | `sha256:4806867d78b8e94207f6266cb2fa7bafc3778ae69f1bfae1e7659f209b099f59` |
| ON manifest SHA-256 | `9a91e68d329dc52f0efb1af453e9d358b5c69b9a0f9761b72454579f1fb5b008` |
| ON source-manifest SHA-256 | `0ab6704f416c88e90d09f6b90b64d68254ac683a8ff77189a63dc16671f992fe` |
| ON `libfullmag_fem` SHA-256 | `1573590aeed8804b498952909d5220a1bf78cc525ed3ec661410e2f9ad952422` |
| loaded HYPRE SHA-256 | `d2699a93ff310c7990583ca1b639254d5fa8bea462bef7599d8325bd1456f853` |
| MFEM SHA-256 | `16cdc246b93d436076de24d9d9024e355d25456e6d89138a995d14930b2f2898` |
| libCEED SHA-256 | `58531e367d3fe20a342a645ac754765fa95d016bd4f3ba9e1bc3b875845b41dc` |
| fixture ProblemIR SHA-256 | `403afa1214681d3317e23b14f4095dfea6141197cea813655c07d24104fbcc08` |
| solver mesh SHA-256 | `9c410c3b02cc86d3a832b923f13b5f9b0ec18c4be2babda148697c6dbc9c105a` |
| solver mesh signature | `20a1851a39da191c61cf50006e72c4b977fa31a5a4cdf2dee1e037e93640d431` |
| workload | `box500_airbox_exchange_demag`, `nonlinear_cg`, 64 requested and executed steps |
| tools | Nsight Systems `2024.1.1.0`; Nsight Compute `2024.1.1.0` build `33998838` |

The capability diagnostic recorded:

```text
ordinary CapEff 00000000a80425fb
capture  CapEff 00000000a82425fb
difference       0000000000200000  # capability 21, SYS_ADMIN
```

The capability was therefore effective inside the capture container, but it
was insufficient to expose the NVIDIA performance counters or make the
Systems kernel export usable on this host.

Persisted evidence is under
`.fullmag/reports/task-13-nsight/task13-box500-airbox-ncg-sm89-v1/`:

| Artifact | SHA-256 | Relevant result |
|---|---|---|
| `summary.json` | `078b918fe8d42a8f58b1a65f7ea9f6499278e11ef9cb9f66f569cef6364a2f8d` | `status="failed"`; zero kernels; `ERR_NVGPUCTRPERM` |
| `ncu-access-probe.log` | `2dc10ebd8d76ae91a026e4229bc19a1f76b1de19ac379a7a476a88e4dba12bc0` | device 0 reached; counter permission denied |
| `compute-stats_cuda_gpu_kern_sum.csv` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | empty file; zero exported kernel rows |
| `compute-stats_nvtx_sum.csv` | `7397d1ed17cac7e0c6cd6ddccdf9729d1587ac30888eaca87fca91c076b603ba` | five compute NVTX phase aggregates present |

The current summary records all five compute phase IDs and all three required
host phase IDs. It also records `kernels.count=0`, `top_five=[]`, and these
exact blockers:

```text
compute nsys reported only 0 unique kernels
ncu access probe failed: ERR_NVGPUCTRPERM
```

No NCU top-kernel pass ran after the unconditional access probe failed. No
occupancy, achieved bandwidth, launch-grid, warp-stall, or register-pressure
metric exists for a Task 16 decision.

## Why the aggregate counters are insufficient

The Task 13 summary's `cpu_launch_gaps_ns` is calculated per CPU thread as the
time from the end of one `cudaLaunch*`/`cuLaunch*` API call to the start of the
next. It reports `count=197099`, `p50=1448 ns`, `p95=42918 ns`, and
`max=617082047 ns`. Those values do not establish Task 16's 15% criterion:

- the summary does not record their union or sum as a fraction of the exact
  end-to-end interval;
- an inter-launch CPU interval may contain useful host work, synchronization,
  HYPRE orchestration, or GPU execution and is not automatically idle time;
- zero exported kernel events prevents correlation with GPU start/end times;
- no event ownership mapping identifies Fullmag-owned versus HYPRE-owned work;
- percentiles over gap samples cannot be converted into an end-to-end time
  share without the missing timeline attribution.

The compute NVTX export records 67 `fem.demag.hypre.apply` instances totaling
`5,031,989,790 ns`. For context, its separate aggregate records 64
`fem.relax.ncg.step` instances totaling `5,037,338,535 ns` and 64
`fem.relax.armijo` instances totaling `4,859,592,142 ns`. These ranges are
nested and have different instance counts, so dividing those totals would not
be a valid causal or end-to-end percentage. The data shows that HYPRE apply is
material enough that its exclusion cannot be ignored; it does not resolve
whether coarse or reduction latency dominates.

Likewise, `stream_waits.count=136`, `stream_waits.total_time_ns=369030`,
`reduction_count=0`, and zero preview/kernel overlap are aggregate or
missing-event results. They do not prove absence of device reductions, waits,
or overlap. Treating zero values derived from an empty kernel table as actual
zero GPU work would invert the fail-closed meaning of the capture.

## Source and production-behavior boundary

The two positive-gate-only files do not exist:

```text
backends/fem/gpu/cuda/relaxation/relaxation_graph.hpp
backends/fem/gpu/cuda/relaxation/relaxation_graph.cpp
```

A case-insensitive source search under `backends/fem` found no
`relaxation_graph`, `cudaGraph`, CUDA Graph, kernel-fusion, or relaxation-fusion
artifact. The five existing files named by the positive path are clean in the
Task 16 working tree and retain these pre-decision SHA-256 values:

| File | SHA-256 |
|---|---|
| `backends/fem/gpu/cuda/relaxation/relaxation_state.hpp` | `9d05c3e634ba76d732c4d9dde3c46cb14972a4385ffd17e17e324c774ff2cd58` |
| `backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp` | `99a6339deedbfff4799f4c586c45a212c76253d19544f4b607b28904b18e8123` |
| `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` | `9fbce5b989b1df6f0a8d411a893648f72972335949e46f935cf313c4dd945716` |
| `backends/fem/gpu/cuda/relaxation/pgbb.cpp` | `2105b003ee2145e6a7fa06a68fbc0bc05ebc6f0c0afd64bdcd736a91167af43a` |
| `backends/fem/CMakeLists.txt` | `3f68bc10f046d457a60d1bf0501f801c0b9a198e1d538d17ee715922b0981860` |

Task 16 therefore changes no native source, runtime state, cache key,
relaxation behavior, HYPRE behavior, Armijo decision, synchronization count,
artifact output, or build wiring.

## Exact reopening requirements

This decision may be reopened only after all of the following external and
measurement conditions are satisfied:

1. A host/NVIDIA administrator enables GPU performance-counter access for the
   actual managed-container user and target device 0. Success means the same
   bounded NCU `LaunchStats` access probe completes without
   `ERR_NVGPUCTRPERM` and produces numeric metrics. Adding container
   `SYS_ADMIN` alone is not a proposed remedy because it was already effective
   and insufficient. The host owner must choose and audit the driver-level
   security configuration; Task 16 does not modify host driver policy.
2. Nsight Systems CUDA kernel activity collection/export is repaired for the
   same managed image, driver, runtime bundle, and two-pass fixture. Both
   `.nsys-rep` files must export non-empty kernel timeline/table data with
   kernel names, timestamps, stream/context identity, and NVTX correlation.
3. Run a fresh identity-pinned capture with
   `COMPOSE_PROJECT_NAME=fullmag just capture-fem-gpu-nsight`. Require
   `summary.json.status="captured"`, five selected top kernels, and finite NCU
   groups for achieved occupancy, DRAM/memory bandwidth or throughput,
   launch-grid dimensions, and warp stalls. Preserve the report and raw trace
   hashes.
4. From the fresh timeline, classify every relevant event as Fullmag-owned,
   HYPRE-owned, transfer, synchronization, or host decision. Compute the union
   of attributable launch/idle gaps over the exact end-to-end interval and
   demonstrate that Fullmag-owned candidates account for at least 15%.
5. Build an ordered kernel-sequence signature per accepted step, excluding only
   explicitly documented variable host decisions, and demonstrate one stable
   sequence in at least 90% of accepted steps.
6. Attribute HYPRE apply time into fine/coarse/reduction/transfer or other
   evidenced categories and demonstrate that HYPRE latency outside the proposed
   graph does not dominate the improvable interval.
7. Only after all three Task 16 prerequisites pass may a bounded prototype be
   considered. Fusion additionally requires NCU proof that adjacent
   elementwise kernels are launch-bound and that the candidate does not regress
   occupancy or register pressure. Production promotion still requires at
   least 5% end-to-end p50 improvement, no p95 regression above 5%, zero new
   synchronization, identical outputs, and stable memory.

If any reopened criterion remains unavailable or fails, the result remains
NO-GO and no graph/fusion wiring belongs in the production tree.

## Verification performed for this report

Task 16 intentionally did not rerun the known-blocked Nsight capture, alter
host security, rebuild the native runtime, or execute the full managed runtime
matrix. A documentation-only no-go cannot make the current profiler permission
or missing-kernel condition change, and the plan's Step 1 requires stopping
before code.

Focused checks:

| Exact command/check | Result |
|---|---|
| `PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q scripts/test_capture_fem_gpu_nsight.py` | **PASS: 25 passed** |
| Parse and inspect the persisted Task 13 `summary.json` | **PASS:** valid JSON; exact failed status, identities, blockers, and zero-kernel metrics confirmed |
| Check the two positive-gate-only graph files | **PASS:** both absent |
| Search backend source for Task 16 graph/fusion artifacts | **PASS:** no matches |
| Inspect status of the five positive-path production files | **PASS:** no Task 16 working-tree changes |

The exact report/source integrity checks were:

```bash
jq -e '
  .status == "failed"
  and .metrics.kernels.count == 0
  and (.metrics.kernels.top_five | length) == 0
  and (.metrics.nvtx_ranges_missing | length) == 0
  and .ncu_access_probe.error_code == "ERR_NVGPUCTRPERM"
  and .ncu_access_probe.status == "unavailable"
  and .preflight.status == "available"
' .fullmag/reports/task-13-nsight/task13-box500-airbox-ncg-sm89-v1/summary.json

test ! -s \
  .fullmag/reports/task-13-nsight/task13-box500-airbox-ncg-sm89-v1/compute-stats_cuda_gpu_kern_sum.csv
test ! -e backends/fem/gpu/cuda/relaxation/relaxation_graph.hpp
test ! -e backends/fem/gpu/cuda/relaxation/relaxation_graph.cpp

rg -n -i \
  'relaxation_graph|cudaGraph|cuda graph|kernel fusion|fused.*(relax|armijo|pgbb|ncg)|(relax|armijo|pgbb|ncg).*fused' \
  backends/fem --glob '*.{h,hpp,c,cc,cpp,cu,cuh}'

git status --short -- \
  backends/fem/gpu/cuda/relaxation/relaxation_state.hpp \
  backends/fem/gpu/cuda/relaxation/relaxation_memory.cpp \
  backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp \
  backends/fem/gpu/cuda/relaxation/pgbb.cpp \
  backends/fem/CMakeLists.txt
```

The `rg` and scoped `git status` commands correctly produced no output. The
other checks exited `0`.

## Final decision

**NO-GO.** The current evidence cannot prove that the relaxation workload is
launch-bound in Fullmag-owned kernels, cannot prove a stable kernel sequence,
and cannot exclude HYPRE coarse/reduction dominance. CUDA Graphs and kernel
fusion would therefore be speculative. The production runtime remains
unchanged; only this audit is eligible for the Task 16 commit.
