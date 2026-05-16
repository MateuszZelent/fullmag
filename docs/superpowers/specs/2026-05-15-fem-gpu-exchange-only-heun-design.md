# FEM GPU Exchange-Only Heun Design

- Status: approved for implementation
- Date: 2026-05-15
- Scope: native FEM GPU hot-loop milestone for exchange-only Heun
- Out of scope: demag, DMI, PBC, anisotropy, STT/Oersted, thermal noise,
  relaxation, consistent-mass projection, partial assembly/libCEED replacement

## Goal

Make the first measurable device-resident FEM hot loop real for the narrow
`exchange_only + Heun + lumped_mass` lane. This slice does not claim the full
production FEM solver is complete. It removes the immediate `stage H_ex is not
device-resident` blocker for the smallest physics case and keeps all broader
terms explicitly gated.

## Physical Contract

The GPU exchange lane must compute the same weak-form P1 exchange field as the
native CPU/MFEM baseline:

```text
H_ex,i = -(2 / (mu0 * Ms_i)) * (K_A m)_i / M_lumped,i
```

where:

- `K_A` is the assembled exchange stiffness matrix for the resolved magnetic
  FEM domain,
- `m_i` is unit magnetization at node `i`,
- `Ms_i` is saturation magnetization in A/m,
- `M_lumped,i` is the lumped mass/dual volume at node `i`,
- `H_ex,i` is in A/m.

Moving `K_A`, `Ms_i`, `M_lumped,i`, and `m_i` to device memory is a data
residency change only. It must not change the equation, sign, units, magnetic
masking, or Heun update.

## Runtime Contract

For this slice, the runtime may report a GPU execution lane only when all of
the following are true:

- exchange is enabled,
- demag, DMI, anisotropy, STT/Oersted, thermal, magnetoelastic, and local
  extra fields are disabled,
- integrator is Heun,
- mass projection is lumped,
- no static periodic reduction is active,
- `FemGpuState` has device buffers allocated,
- legacy sparse exchange CSR and lumped mass metadata are uploaded,
- the step uses CUDA kernels for `H_ex`, `H_eff`, LLG RHS, predictor, accept,
  and normalization.

The operator mode for this milestone is `legacy_sparse_gpu`. This is still a
bootstrap operator mode and must remain distinct from future
`partial_assembly_gpu` / `libceed_gpu` modes.

## Data Residency

After a successful GPU Heun step:

- `FemGpuState.source_of_truth = DEVICE_SOURCE_OF_TRUTH`,
- device magnetization is dirty/authoritative,
- host magnetization is stale until an explicit diagnostic/snapshot copy is
  requested outside the hot loop,
- hot-loop compute transfer counters must remain zero under
  `FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1`.

Field-copy APIs may synchronize device-to-host outside the hot-loop scope, but
that synchronization must be explicit and must not be counted as a hidden
compute-stage transfer.

## Validation

Required checks:

- RED/GREEN native smoke or unit test proving `exchange_only + Heun` cannot be
  claimed device-resident without the device CSR/mass upload and does report
  `legacy_sparse_gpu` after upload.
- CPU/GPU parity for a deterministic small exchange-only Heun case when the
  MFEM/CUDA stack is available.
- Transfer-audit gate for exchange-only Heun with
  `FULLMAG_FEM_ASSERT_NO_HOT_LOOP_COMPUTE_SYNC=1`.
- No unsupported term silently falls into the GPU lane.

Environment limitation: this local host may lack MFEM/CUDA package config. If
native CTest cannot run here, code-level gates must still compile where
possible and the final report must separate environment blockers from source
regressions.

## Completeness Checklist

- [x] Runtime plan exposes `legacy_sparse_gpu` only for the approved narrow
  lane.
- [x] GPU Heun step keeps the exchange RHS on device.
- [x] Device-source magnetization can be explicitly copied back for parity and
  snapshots without making hot-loop host sync look clean by accident.
- [x] Physics note `docs/physics/0560-all-in-gpu-fem-runtime.md` documents the
  milestone and its exclusions.
- [x] Report
  `docs/reports/15.05.2026/fem-solver-physics-performance-audit.md` reflects
  the closed and still-open parts.

Local verification note: source-level syntax checks passed on this host for
both macro configurations used by the native smoke. Full runtime CTest and
CPU/GPU parity still require a configured MFEM/CUDA build directory.
