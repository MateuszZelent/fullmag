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

## Measured on WSL2 (2026-11-26)

RTX 5050, Windows driver 610.88 (CUDA 13.3) under WSL2, a 1.8 s kernel: every wait costs as much CPU time
as it lasts. This holds in every mode: `default`, `spin`, `yield`, `blocking` (flag 0x4 confirmed by
`cudaGetDeviceFlags`), and an event created with `cudaEventBlockingSync`. The host thread cannot sleep
while waiting for the GPU on this platform, so `blocking` cannot lower the CPU time of a job under WSL2.

The 30k-node FEM GPU case (cuDSS, one core per job) confirms it: CPU time per step equals step time
in both `default` and `blocking`. `blocking` and `yield` still help when the core is shared. With one
busy process on the same core, the median step went from 32.0 ms (`default`) to 24.8 ms (`blocking`) and
27.0 ms (`yield`), against 24.5 ms with a core of its own. Without sharing, step time is unchanged
(24.5–24.6 ms).

Native Linux drivers normally put a `blocking` waiter to sleep. The CPU-time benefit has to be measured
on a native Linux machine before any default changes.

## Policy options (open question)

`spin` reacts fastest when the job has a core to itself. `blocking` frees the core for other jobs while the
GPU works, at the cost of a wake-up delay at each synchronization point. Two ways to choose between them
are open for discussion:

1. **By load.** Use `blocking` when more GPU simulations run on the machine than there are CPU cores for
   them, and the default otherwise. A process cannot see the other jobs, so the count must come from the
   job launcher or from a host-level registry of running simulations. The number of GPUs on the machine
   is not enough: a machine may have 10 GPUs and run only one job.
2. **`blocking` by default.** Without sharing, `blocking` did not slow the step on WSL2 (24.6 vs 24.5 ms).
   If native Linux confirms that the wake-up cost stays small, one default is simpler than a load rule.

Either way, the requested and the applied mode belong in the run provenance.

The setting changes only how the host waits, not what is computed: results are expected to be identical.
In the measurements, CG/AMG results were bitwise identical across modes. cuDSS results differ at the
1e-14 level between any two runs, with or without this setting.
`blocking` adds a wake-up delay at every synchronization point (a few to tens of microseconds), so it can
lengthen steps that synchronize often. The A/B measurement must check step time, CPU time per step and the
shared-core case before any default changes.
