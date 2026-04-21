# Runtime engine naming v0

## Purpose

This note defines the canonical naming for resolved execution engines shown in:

- `resolve_runtime_engine()`,
- `resolve_session_runtime()`,
- `resolve_runtime_capabilities()`,
- session/runtime metadata,
- artifact provenance,
- diagnostic logs.

The goal is simple: a CPU/GPU choice must never be confused with a
reference-vs-production solver identity.

## Canonical ids

### FDM time-domain

| Engine id | Meaning | Status |
|---|---|---|
| `fdm_cpu_reference` | Rust CPU reference FDM runner | public-executable |
| `fdm_cuda` | native CUDA FDM runner | public-executable |

### FEM time-domain

| Engine id | Meaning | Status |
|---|---|---|
| `fem_cpu_native` | sole maintained MFEM/libCEED/hypre CPU runner | public-executable |
| `fem_native_gpu` | native MFEM/libCEED/CUDA GPU runner | public-executable |
| `fem_cpu_baseline_internal` | Rust FEM baseline helper | internal-reference only |

### FEM eigen

| Engine id | Meaning | Status |
|---|---|---|
| `fem_eigen_cpu_baseline` | current CPU FEM eigen baseline solver | public-executable / transitional |
| `fem_eigen_native_gpu` | current GPU FEM eigen solver | public-executable / transitional |

## Dispatch vocabulary

Inside the runner, FEM dispatch first resolves a **runtime lane**:

- `CpuNative`
- `NativeGpu`

For time-domain FEM, the CPU lane resolves to `fem_cpu_native`.
No alternate public CPU-native FEM engine is maintained alongside it.
For FEM eigen, the CPU lane resolves to `fem_eigen_cpu_baseline`.

That split is intentional:

- lane selection answers "CPU or GPU?",
- engine id answers "which concrete solver implementation actually ran?".

## Fallback policy

- `FULLMAG_FEM_EXECUTION=cpu` selects the CPU lane.
- `FULLMAG_FEM_EXECUTION=gpu` selects the GPU lane and fails or falls back according to runtime policy.
- A fallback from GPU to CPU must preserve:
  - requested device intent,
  - resolved engine id,
  - fallback reason.

## Non-negotiable rule

`resolved_engine_id` and `execution_provenance.execution_engine` must describe the
concrete executed solver, not an internal enum name or lane alias.
