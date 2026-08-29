---
title: CPU GPU Parity
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-validation-cpu-gpu-parity)=
# CPU/GPU parity

Parity means the CPU and GPU execution lanes of one solver produce the same physical result within
per-interaction tolerances, with the rigorous GPU path provably not falling back to host work.

## Relaxation parity

The production relaxation contract qualifies the minimizers across lanes. The 2026-07-11 relaxation
qualification matrix records:

| Coverage | Result |
|---|---|
| CPU/GPU consistency | `6/6` rows, `3/3` pairs passed |
| FEM PG-BB production benchmark | `39` comparison pairs, required coverage `21/21` |

These results apply to the qualified relaxation workloads; they do not transfer automatically to
heterogeneous CUDA material payloads, which fail capability checks instead of substituting a
looser path.

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
## Control Room crosswalk

Validation pages are `inspection-only` in Control Room. The UI may expose runtime metadata, fields, tables, or reports for inspection, but it does not create a qualification claim. `TODO: frontend support` applies to validation workflow authoring and report publication unless a specific control is named. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Validation is not a standalone Python constructor unless the linked case page names one. Reproduce the exact case, inputs, device, precision, and receipt described by the page; use the referenced API pages for callable signatures.

## Physics and bibliography scope

The page either states the governing benchmark model or delegates it to the linked physics/numerical-methods page. Any missing derivation is a documented boundary, not an implicit equation. Bibliography and source evidence remain the authoritative references listed by the validation case.
## Source-code index

- No standalone implementation function is introduced by this validation page. Source evidence is the exact API, managed recipe, runtime manifest, and receipt named by the validation case.

