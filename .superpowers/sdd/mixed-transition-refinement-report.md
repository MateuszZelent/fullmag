# Mixed transition refinement report

Status: **DONE_WITH_CONCERNS**

The mixed prism/pyramid/tetra transition implementation and every review-required item are implemented and pass their focused and full task-owned verification. The repository production meshing gate remains red for three independently diagnosed blockers: a missing production evidence manifest, a missing worktree-local managed Python runtime, and a pre-existing periodic frozen-submesh test failure reproduced on the exact baseline commit.

## Scope completed

- Replaced the former direct prism-to-tetra boundary with a deterministic 26-block transition shell around the magnetic body. The shell shares the exact six magnetic interface surfaces and realizes prism, pyramid, and tetrahedral cell families in one certified mesh.
- Applied public interface and transition controls after extrusion. `interface_thickness` and `transition_distance` now create distinct restricted Gmsh threshold fields over all transition-shell volumes and are composed with source refinement and far-air grading.
- Added deterministic, bounded pyramid-apex optimization. Candidate moves are outward-only and are accepted only when every incident prism/pyramid/tetra decomposition remains positive and does not fall below the smaller of the previous incident minimum and `0.1`.
- Strengthened the mixed topology certificate: every family must have positive minimum scaled Jacobian and p05 scaled Jacobian at least `0.1`. Optimizer identity and bounds participate in deterministic provenance.
- Kept the qualified shared-domain mixed route deliberately single-layer. Requests with `n_layers != 1` fail before Gmsh; body-only swept prism meshes retain their existing multi-layer support.
- Made layered authoring mutation atomic and non-sticky. `configure()`, `thin_film()`, and `swept()` validate complete candidate state before assignment and clear stale topology, sweep, family, transition, exactness, ratio, and symmetry fields when switching modes.
- Added public `PerObjectMeshRecipe` validation for layer counts, enums, contradictions, incomplete intent, and strict exactness. Generic swept prism plus `transition="reject"` remains legal.
- Preserved typed `.thin_film(...)` and `.swept(...)` calls during canonical script rebuilding even when generic mesh controls are also present.
- Added Rust-side validation for incomplete or contradictory layered intent and preserved the canonical `"airbox_boundary"` sentinel through scene-to-IR projection.
- Added differential, quality, determinism, axis, rejection, persistence, renderer, Python validation, and Rust validation tests.

## Review-required closure

| Required item | Result |
|---|---|
| Atomic/sticky Python mesh state | Implemented with candidate validation and explicit stale-state clearing |
| Renderer preservation of typed layered calls | Implemented and round-trip tested |
| Public `PerObjectMeshRecipe` validation | Implemented and tested, including generic swept/reject legality |
| Rust layered-intent validation | Implemented; contradictory/incomplete states fail closed |
| Rust `airbox_boundary` sentinel | Preserved for per-geometry and study-level transition fields |
| Real interface/transition ramp | Implemented post-extrusion and proven by differential fingerprints/cell counts |
| Pyramid quality p05 | Deterministic bounded optimizer plus certificate p05 floor of `0.1` |
| Multi-layer scope | Qualified shared-domain route explicitly rejects layers greater than one |

## Verification evidence

### Task-owned green gates

1. Full mixed topology and fallback suite:

   ```text
   PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
     packages/fullmag-py/tests/test_mixed_element_meshing.py \
     packages/fullmag-py/tests/test_meshing_fallbacks.py -vv
   ```

   Result: `178 passed in 395.01s`, exit `0`.

2. Canonical script round-trip and layered DSL validation:

   ```text
   PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
     packages/fullmag-py/tests/test_script_builder_roundtrip.py \
     packages/fullmag-py/tests/test_meshing.py::LayeredMeshDslValidationTests -vv
   ```

   Result: `30 passed, 47 subtests passed in 0.72s`, exit `0`.

3. Rust authoring crate:

   ```text
   CARGO_TARGET_DIR=/tmp/fem-mixed-task6-target cargo test -p fullmag-authoring
   ```

   Result: `57 passed; 0 failed`; doc-tests `0 failed`, exit `0`.

4. Python syntax and patch hygiene:

   ```text
   python3 -m py_compile <all changed Python source and test files>
   git diff --check
   rustfmt --edition 2021 --check crates/fullmag-authoring/src/adapters.rs
   rustfmt --edition 2021 --check crates/fullmag-authoring/src/validation.rs
   ```

   Result: all commands exit `0`.

5. Narrow physical differential and quality proof:

   ```text
   PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
     packages/fullmag-py/tests/test_mixed_element_meshing.py::test_public_interface_ramp_controls_change_transition_air_realization \
     packages/fullmag-py/tests/test_mixed_element_meshing.py::test_shared_domain_mixed_quality_meets_family_p05_floor -vv
   ```

   Result: `3 passed in 83.91s`, exit `0`. Both `transition_distance` and `interface_thickness` variations changed the realized fingerprint and transition-air cell population; the all-family p05 certificate passed.

6. Qualified-scope proof:

   ```text
   PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
     packages/fullmag-py/tests/test_mixed_element_meshing.py::test_shared_domain_box_prism_mesh_has_exact_requested_layer \
     packages/fullmag-py/tests/test_mixed_element_meshing.py::test_shared_domain_box_prism_rejects_unqualified_multiple_layers \
     packages/fullmag-py/tests/test_mixed_element_meshing.py::test_shared_domain_mixed_quality_meets_family_p05_floor -vv
   ```

   Result: `3 passed in 9.58s`, exit `0`.

### Repository production gate

Command:

```text
just verify-fem-meshing-production
```

Result: exit `1` after the repository-owned verifier reported:

```text
production_evidence_manifest: failed
python_meshing_tests: failed
python_api_mesh_tests: passed
python_mixed_shared_domain_meshing_tests: passed
arch_waveguide_materialization_budget: failed
```

The three failures were diagnosed separately:

1. `production_evidence_manifest`: `.fullmag/reports/fem-meshing-production/evidence.v1.json` does not exist in this worktree. No replacement or fabricated evidence was created.
2. `arch_waveguide_materialization_budget`: the verifier requires `.fullmag/local/python/bin/python`, which does not exist in this worktree. Exact verifier stderr: `missing local Python runtime: .../.fullmag/local/python/bin/python`.
3. `python_meshing_tests`: the first failure is `FieldStackAcceptanceTests::test_periodic_antidot_frozen_magnetic_submesh_stays_stable_across_airbox_z_padding`. `_gmsh_extraction._derive_facet_roles` rejects `facet 0` with same-marker adjacency `[0, 0]`.

The complete suite was also rerun without `-x`, so later failures were not hidden:

```text
PYTHONPATH=packages/fullmag-py/src python3 -m pytest \
  packages/fullmag-py/tests/test_meshing.py -q
```

Result: `1 failed, 254 passed, 1 skipped, 19 subtests passed in 154.56s`; the sole failure was the periodic frozen-submesh case above.

The third blocker is proven pre-existing, not inferred from path ownership:

```text
git rev-parse 'b8669750^{commit}'
# b8669750ce50896175cee3a00feed9ffd26a0975

git archive b8669750ce50896175cee3a00feed9ffd26a0975 | tar -x -C <validated task temp>
PYTHONPATH=<baseline>/packages/fullmag-py/src python3 -m pytest \
  <baseline>/packages/fullmag-py/tests/test_meshing.py::FieldStackAcceptanceTests::test_periodic_antidot_frozen_magnetic_submesh_stays_stable_across_airbox_z_padding -vv
```

Baseline result: the same test failed in `6.38s` with the same `ValueError: facet 0 cannot derive a canonical role from volume adjacency [0, 0]`. The task-owned temporary archive directory was explicitly validated, removed, and verified absent afterward.

## RED evidence used during development

- Python focused tests initially produced 12 failures covering stale topology, missing public recipe validation, non-atomic mutation, and renderer loss of typed calls.
- Rust focused tests initially accepted tetra topology with prism-only fields and converted `"airbox_boundary"` to null.
- Gmsh differential proof initially produced identical fingerprints for transition distances `5 nm` and `22 nm`.
- Initial mixed quality proof reported pyramid p05 `0.0970383`, below the required `0.1`.
- An intermediate full suite exposed an unsupported shared-domain two-layer path; the route now fails closed while body-only multi-layer swept meshes remain supported.

## Files changed

- `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_swept.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py`
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- `packages/fullmag-py/src/fullmag/model/discretization.py`
- `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- `packages/fullmag-py/src/fullmag/world.py`
- `packages/fullmag-py/tests/test_meshing.py`
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`
- `packages/fullmag-py/tests/test_script_builder_roundtrip.py`
- `crates/fullmag-authoring/src/adapters.rs`
- `crates/fullmag-authoring/src/builder.rs`
- `crates/fullmag-authoring/src/validation.rs`
- `crates/fullmag-ir/src/mesh_assets.rs`

## Open concerns and continuation

- Production validation is not green until authoritative managed-runtime and browser evidence populate the required manifest and the worktree has the managed Python runtime expected by the repository verifier.
- The baseline periodic frozen-submesh facet-role bug should be repaired in a separate scoped task, then the entire `just verify-fem-meshing-production` recipe should be rerun without bypasses.
- No files were staged or committed by this task.
