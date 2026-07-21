# Task 3 interactive closure remediation

## Scope

Follow-up to `.superpowers/sdd/task-3-final-closure-review.md`. This change
closes the remaining duplicate FEM mesh identity construction in the
production CLI interactive route and removes the last broad exclusions from
the semantic mesh ownership gate. FEM physics, solver selection and benchmark
configuration are unchanged.

## Finding disposition

1. **Production interactive runtime reuses the authoritative stage asset.**
   The existing `StageFemMeshAsset` is threaded through the CLI orchestrator,
   `InteractiveRuntimeHost`, the runner runtime factory and the FEM interactive
   constructor. The compatibility factory still exists for callers without a
   stage owner, while the production route uses the asset-aware entrypoint.
   A counter test proves one payload build and one fingerprint evaluation, and
   the CLI structural test pins the complete production call chain.
2. **All identity/context producer forms are classified.** The producer
   inventory recognizes every `FemStageExecutionContext::from_*`,
   `StageFemMeshIdentity::from_*`, asset builder and direct generation helper,
   including expression and callback forms. The exact producer inventory is
   pinned at 64 occurrences.
3. **No broad error filtering or whole-function allowlists remain.** The gate
   no longer discards unclassified `.fem_mesh` errors and no longer exempts
   `run_script_mode` or adaptive functions as wholes. Exact mesh-operation and
   producer inventories are pinned independently. Mutation fixtures cover
   context, eigen and frequency-response producers in callback and duplicate
   forms, in addition to the earlier payload, hash, generation-`None` and
   arbitrary-access mutations.

## Verification

- Source checker self-test and repository scan: PASS; 191 mesh accesses and
  64 mesh producers classified.
- `production_interactive_route_threads_authoritative_fem_mesh_asset`: PASS.
- `production_interactive_asset_reuse_does_not_rebuild_or_refingerprint_mesh`:
  PASS; payload builds = 1, fingerprint evaluations = 1.
- Full CLI suite with `--test-threads=1`: 219/219 PASS.
- Managed FEM source contract: PASS, including all three native targets.
- `COMPOSE_PROJECT_NAME=fullmag just verify-fem-relaxation-runtime`: PASS on a
  freshly rebuilt and promoted release bundle; GPU/CPU smoke matrix and log
  validators completed with final message `FEM relaxation runtime smoke
  completed`.
- `git diff --check`: PASS.

The managed build emitted four pre-existing runner warnings in
`artifact_pipeline.rs`, `native_fem.rs` and `native_fem/availability.rs`; this
change introduced no new warning. Performance was not rerun because the final
delta is confined to interactive runtime construction and the source gate, not
the relaxation step path. The preceding frozen-source forward/reverse A/B
already established no Task 3 solver regression.
