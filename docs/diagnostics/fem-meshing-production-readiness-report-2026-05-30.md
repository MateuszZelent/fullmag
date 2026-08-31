# FEM Meshing Production Readiness Report

> **Historical / superseded.** This report records a 2026-05-30 snapshot and is
> not a current production-qualification claim. Its S1-S12 decision is
> superseded by the active [FEM meshing production closure masterplan](../superpowers/plans/2026-08-31-fem-meshing-production-closure-masterplan.md),
> which requires current source identity, FMMQ v2, managed CPU/GPU evidence,
> and browser/WebGL proof. Use this file only as historical provenance.

## Commit

- Commit: `9e19259d` plus uncommitted production-readiness worktree changes
- Date: 2026-05-30
- Author: Fullmag local verification

## Decision

Production-ready for the declared support matrix S1-S12.

The mesh-generation gate is green for the declared support matrix evidence
below, the canonical arch-waveguide example materializes within the interactive
mesh budget, and the managed runtime smoke now completes a one-step native FEM
run. The earlier managed runtime blocker was fixed by exporting the OpenMPI and
PMIx runtime components and help data into `.fullmag/runtimes/fem-gpu-host`.

## Support Matrix

| ID | Status | Evidence |
|---|---|---|
| S1 | passed | `packages/fullmag-py/tests/test_meshing.py::MeshProductionRealizationTests::test_box_air_side_edge_corner_refinement_materializes`; `MeshScaffoldTests::test_mesh_statistics_reports_per_marker_boundary_faces` |
| S2 | passed | `test_flat_arch_waveguide_occ_uses_box_not_loft`; `test_flat_arch_thin_film_materialization_records_provenance_and_partitions`; arch budget verifier |
| S3 | passed | `test_arch_waveguide_generates_fem_mesh`; `test_perimeter_refinement_uses_edge_threshold_for_non_box_geometry`; `test_perimeter_refinement_uses_explicit_corner_threshold_for_non_box_geometry` |
| S4 | passed | `test_curvature_refinement_is_finer_than_far_field_airbox`; `test_apply_mesh_options_supports_component_restricted_cylinder` |
| S5 | passed | `test_multi_object_sizing_cylinder_and_waveguide`; `test_multi_object_box_and_cylinder_preserve_object_priority_under_coarse_airbox`; `test_two_objects_different_bulk_hmax_produce_distinct_fields` |
| S6 | passed | `test_component_aware_fallback_rebuilds_bounds_fields_for_local_hmax`; `test_occ_failure_with_edge_corner_reports_degraded_fallback_not_secondary_error` |
| S7 | passed | `test_non_component_fallback_skips_edge_corner_size_fields`; `test_shared_domain_report_marks_component_fields_ignored_on_concatenated_fallback` |
| S8 | passed | `test_airbox_geometric_grading_populates_distance_bands_and_diagonal`; `test_airbox_realized_growth_bands_are_populated_and_monotone`; `test_airbox_edge_corner_plumes_refine_near_film_perimeter` |
| S9 | passed with degraded fallback policy | `test_airbox_grading_uses_radial_envelope_for_sphere`; `test_shared_domain_report_marks_sphere_airbox_degraded_on_geo_fallback` |
| S10 | passed | `test_swept_quality_does_not_label_gamma_proxy_as_sicn`; `test_shared_domain_report_marks_thin_film_tetrahedral_method` |
| S11 | passed | Rust API tests `v2_mesh_histogram_bin_elements_*`, `mesh_universe_quality_*`; frontend tests `viewport3dMeshSizeHighlight.test.ts`, `crossSectionWorkspace.test.ts`, `ribbonStructure.test.ts` |
| S12 | passed | `export-run-config`/verifier materializes within budget; managed one-step smoke reaches `fem_cpu_native`, executes one relaxation step, and completes |

## Command Evidence

### Production verifier

Command:

```bash
just verify-fem-meshing-production
```

Result: passed outside the tool sandbox.

Summary:

- `python_meshing_tests`: passed
- `python_api_mesh_tests`: passed
- `arch_waveguide_materialization_budget`: passed
- `cargo test -p fullmag-api router_v2 --no-fail-fast`: 253 passed
- `pnpm --dir apps/control-room generate:api`: passed
- `pnpm --dir apps/control-room lint`: passed
- `pnpm --dir apps/control-room typecheck`: passed
- `pnpm --dir apps/control-room test`: 174 files passed, 1009 tests passed

The same verifier failed inside the tool sandbox only because Vitest could not
spawn `process.execPath` (`EPERM`) in `computePerformanceAuditScript.test.ts`.

### Arch waveguide `export-ir`

Command:

```bash
PYTHONPATH=packages/fullmag-py/src FULLMAG_GMSH_THREADS=8 /usr/bin/time -v \
  .fullmag/local/python/bin/python -m fullmag.runtime.helper export-ir \
  --script examples/arch_waveguide_relax_50nm.py \
  --backend fem \
  >/tmp/fullmag_arch_waveguide_ir.json \
  2>/tmp/fullmag_arch_waveguide_ir.stderr
```

Result: passed.

- Wall time: 22.31 s
- Peak RSS: 392,028 KB
- `geometry_assets`: `null`
- `shared_geometry_assets`: `null`

The `export-ir` path intentionally emits the semantic IR without realized mesh
assets; the mesh budget is verified by `export-run-config` in the production
verifier.

### Arch waveguide materialization budget

Latest JSON verifier summary:

- Wall time: 32.178 s
- Total nodes: 29,515 / 75,000
- Total tetrahedra: 184,368 / 450,000
- Boundary faces: 14,186
- Airbox: 27,246 scoped nodes, 148,527 tetrahedra, SICN p5 0.281
- Magnetic domain: 9,245 scoped nodes, 35,841 tetrahedra, SICN p5 0.418
- Legacy dense FEM RAM estimate: 20.91 GB
- Dense RAM status: `not_applicable_poisson_demag`

### Managed runtime smoke

Command:

```bash
FULLMAG_ARCH_RELAX_MAX_STEPS=1 just run-arch-waveguide-managed-headless script 8
```

Result: passed after re-exporting the managed FEM runtime bundle.

- Runtime bundle validation: OpenMPI help files, OpenMPI runtime components,
  PMIx component, and PMIx help files are present in `.fullmag/runtimes/fem-gpu-host`
- Mesh materialized: 11,091 nodes, 66,355 tetrahedra, 14,180 boundary faces
- Engine reached: `fem_cpu_native`
- Solve result: completed one relaxation step with `status=completed`

### Control-room viewport smoke

Command:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace \
  CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 \
  pnpm --dir apps/control-room smoke:viewport-3d
```

Result: passed against the already-running control-room dev server on port
3100. The smoke passed camera gesture, projection round-trip, dimension frame
cage, WebGL viewport checks, and reported `Viewport 3D smoke passed`.

## Remaining Unsupported Or Blocked Cases

- S9 is supported through shape-aware radial grading plus explicit degraded
  fallback reporting where the GEO fallback cannot realize the spherical
  production contract.
- Arbitrary invalid CAD repair, non-manifold imported surfaces, and arbitrary
  anisotropic size fields remain outside the production support matrix.
