# CUDA wait mode (`FULLMAG_CUDA_WAIT_MODE`)

Status: experimental, added 2026-11-26. The default behavior is unchanged until an A/B measurement decides
the policy.

## Why

When the host thread waits for GPU work (a stream or device synchronization inside fullmag, cuDSS or
hypre), CUDA's default policy (`cudaDeviceScheduleAuto`) spins on the CPU as long as the process has fewer
active CUDA contexts than logical CPUs. A fullmag job therefore keeps one CPU core fully busy for the whole
run, even while the GPU does all the work.

This matters on machines where several GPU jobs share few CPU cores, for example production rigs with 5–10
GPUs and one CPU. The 2026-11-26 rig emulation found that a FEM GPU job sharing its core with one busy
process took 2× longer to set up, and its steps were 29 % (cuDSS) and 74 % (CG/AMG) slower.

## Setting

`FULLMAG_CUDA_WAIT_MODE` is read by the FEM GPU backend (after device selection in
`backends/fem/cpu/mfem/runtime/mfem_context.cpp`) and by both FDM GPU create paths
(`backends/fdm/api/c_api.cpp`):

| Value | CUDA flag | Host thread while waiting |
|---|---|---|
| unset or `default` | none set (`cudaDeviceScheduleAuto`) | spins in practice |
| `spin` | `cudaDeviceScheduleSpin` | spins |
| `yield` | `cudaDeviceScheduleYield` | spins, but yields the core to other threads |
| `blocking` | `cudaDeviceScheduleBlockingSync` | sleeps until the GPU signals completion |

Any other value, and any refusal by CUDA to apply the flag, fails backend creation; the old policy is never
kept silently. When a mode is applied, the backend logs one line, for example
`[fullmag] FEM CUDA wait mode: blocking (schedule flags 0x4)`.

The setting changes only how the host waits, not what is computed: results are expected to be identical.
`blocking` adds a wake-up delay at every synchronization point (a few to tens of microseconds), so it can
lengthen steps that synchronize often. The A/B measurement must check step time, CPU time per step and the
shared-core case before any default changes.
