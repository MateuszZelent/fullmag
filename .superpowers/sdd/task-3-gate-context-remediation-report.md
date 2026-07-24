# Task 3 gate-context closure remediation

## Scope

Follow-up to `.superpowers/sdd/task-3-ultimate-closure-review.md`. No Rust or
runtime behavior changed. This patch closes the final false negative in the
semantic FEM mesh ownership source gate.

## Fix

- Mesh-access and mesh-producer records now include the full enclosing control
  ancestry: every loop/callback kind, normalized owner header, nesting order
  and depth, plus a stable same-header sibling ordinal within the enclosing
  parent. Moving a statement from an outer stage loop to an inner step loop,
  between sibling stage loops, from an outer callback to a nested callback, or
  between sibling callbacks changes the record.
- Repository mode runs `check_text(..., validate_producers=True)` for every
  scanned Rust source instead of disabling producer-context validation.
- The allowed producer set is exact and operation-scoped per file, function,
  operation, context and normalized statement. It does not exempt a whole
  function.
- Duplicate textual producers remain guarded by the count-sensitive pinned
  inventory, while the direct mutation checker rejects unclassified duplicate
  producers.
- The self-test constructs a temporary repository, records a valid plain-stage
  producer/access inventory, then moves the identical producer and identical
  `.fem_mesh.clone()` statement into a loop and a closure. Separate probes for
  Asset, Identity and ExecutionContext producers then move the unchanged
  statement from an outer stage loop to a nested step loop and from an outer
  callback to a nested callback. Further probes move each unchanged producer
  and heavy access between same-header sibling loops and sibling callbacks.
  Repository mode must reject every mutation without relying on changed
  statement text.

## Verification

- `python3 scripts/verify_fem_mesh_hot_loop_source_contract.py --self-test --root .`: PASS.
- `bash scripts/verify_fem_mesh_hot_loop_source_contract.sh`: PASS.
- Exact semantic inventory: 191 `.fem_mesh` accesses and 64 mesh producers.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-source-contract`:
  PASS, including `fem_relaxation_source_contract`,
  `fem_stage_completion_contract` and `fem_rk_explicit_contract` in the managed
  FEM container.
- `git diff --check`: PASS.

The full managed runtime had already passed on the immediately preceding Rust
source (`0abea3aa` preparation). It was not rebuilt again because this follow-up
changes only the source-verification Python script and does not alter compiled
runtime code or benchmark behavior.
