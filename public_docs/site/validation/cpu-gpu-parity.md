---
title: CPU GPU Parity
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/capability-matrix-v0.json, docs/audits/2026-08-20-relaxation-audit-v2-verification-remediation.md, docs/validation/2026-07-11-relaxation-qualification-matrix.md
---

(public-docs-validation-cpu-gpu-parity)=
# CPU/GPU parity

Parity means the CPU and GPU execution lanes of one solver produce the same physical result within
per-interaction tolerances, with the rigorous GPU path provably not falling back to host work.

## Relaxation parity

The 2026-07-11 relaxation report historically recorded:

| Coverage | Result |
|---|---|
| CPU/GPU consistency | `6/6` rows, `3/3` pairs passed |
| FEM PG-BB production benchmark | `39` comparison pairs, required coverage `21/21` |

That report is now explicitly superseded for current status. The authoritative capability matrix
lists FDM CPU as the reference-executable relaxation lane and the FDM GPU and FEM CPU/GPU lanes as
development-executable for overdamped LLG, PG-BB, and NCG. Validated workloads are empty because
fresh source-bound managed receipts are missing. The historical counts therefore remain audit
history, not a current production or parity claim.

## Rigorous GPU residency

A real GPU claim requires the strict GPU path to report the device as source of truth and zero
host hot-loop traffic:

- `hot_loop_compute_h2d_bytes = 0`,
- `hot_loop_compute_d2h_bytes = 0`,
- `hot_loop_compute_host_sync_count = 0`.

The enforcement gate is `scripts/analysis/fem_gpu_benchmark.py --require-gpu-strict-residency`, and
the interaction consistency preset is
`scripts/analysis/fem_gpu_benchmark.py --box500-airbox-interaction-consistency-preset`
(`just bench-fem-box500-consistency`).

- **Status** — scripted; the current qualification rerun in the CUDA-visible managed runtime is
  still required before strict residency and hosted CPU/GPU field parity are claimed as closed.

## What counts as evidence

Compiling CUDA code on a host, loading a CUDA library, or passing a source-only counter check is
not parity proof. Parity is claimed only when executed same-workload CPU and GPU artifacts agree
within documented tolerances and the GPU run records its device identity.
