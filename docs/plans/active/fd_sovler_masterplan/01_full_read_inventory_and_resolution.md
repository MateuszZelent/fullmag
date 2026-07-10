---
title: FEM frequency-domain inventory and document resolution
version: COMSOL-aligned v5.1 decision-complete
status: supporting
scope: documentation roles and source provenance
---

# Inventory and resolution

`documentation_manifest.json` is the machine-readable inventory of active
documents. It supplies ordering, roles, full-pack inclusion, and planned
availability. The README supplies the human read order.

## Resolution policy

The authority hierarchy in `00_README_CANONICAL_FULL_READ.md` resolves all
conflicts. Physics notes own equations and units; architecture and
specifications own public and subsystem contracts; normative masterplan
documents own implementation order; status documents own current evidence.
Historical copies have no authority outside provenance review.

The active root contains no historical document role. Superseded source bodies
are frozen under `old/` with an explicit historical header. Their names are:

- `09_validation_certification_benchmarks_legacy_2026-07-10.md`
- `10_patch_queue_current_status_legacy_2026-07-10.md`
- `11_runtime_telemetry_performance_legacy_2026-07-10.md`
- `16_implementation_plan_Kittel_D2_completed_2026-07-10.md`
- `17_eigen_k0_gpu_readiness_audit_legacy_2026-07-10.md`
- `18_poisson_airbox_eigensolve_cpu_gpu_legacy_2026-07-10.md`
- `19_physics_numerics_audit_original_2026-07-10.md`
- `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5_legacy_2026-07-10.md`

## Active-package rules

- The V5 full pack is stale and disabled: `full_pack_generated=false` and its
  active file is a non-authoritative pointer to the README and manifest.
- Task 10 may regenerate the full pack only after all manifest-declared
  canonical inputs are complete and transitional documents are promoted.
- The readiness matrix is JSON evidence and is excluded from the full pack.
- The Markdown status chapter links the readiness matrix rather than copying it.
- Documents `23`, `24`, and `25` are planned manifest entries until their
  assigned tasks create them.
- Document `20` is an active implementation-status document owned by the
  parallel remediation plan.
- Documents `08`, `16`, and `18` are transitional implementation-status
  documents. Their `target_role` is normative, but only Tasks 5, 4, and 6 may
  promote them after rewriting their dated append-only evidence.
- Numbers `21` and `22` are intentionally not assigned by this plan.

Every production claim uses the manifest-required `implementation_state`,
`validation_state`, and non-empty `validated_scope`. Production-executable
does not mean production-qualified, and narrow validation cannot promote a
broader capability.

This package concerns FEM frequency-domain work only. Runtime gates and their
artifacts, not document text, establish executable or production status.
