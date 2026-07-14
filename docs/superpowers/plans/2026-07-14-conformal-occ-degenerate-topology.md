# Conformal OCC Degenerate Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve conformal OCC boundary topology by retrying Gmsh whenever any generated tetrahedron is degenerate.

**Architecture:** Keep strict `MeshData` validation as the acceptance gate. Remove the partial-cleanup escape from the conformal OCC retry loop so validation failures flow into the existing HXT/Delaunay/Frontal retry policy; retain the generic cleanup helper for non-conformal filtering paths.

**Tech Stack:** Python 3.10, NumPy, Gmsh, unittest/mock-compatible tests, managed Fullmag FEM runtime.

## Global Constraints

- Do not synthesize physical boundary markers for faces created by deleting tetrahedra.
- Do not weaken `FEM_TOPOLOGY_VOLUME_EPS` or strict mesh validation.
- Preserve unrelated dirty-worktree changes.
- Use the managed `just` runtime path for final FEM proof.

---

### Task 1: Enforce topology-preserving conformal OCC retry

**Files:**
- Modify: `packages/fullmag-py/tests/test_meshing.py`
- Preserve and run: `packages/fullmag-py/tests/test_conformal_occ_degenerate_retry_regression.py`
- Modify: `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`

**Interfaces:**
- Consumes: `MeshData.validate_strict(require_positive_orientation=True)` and `_conformal_occ_degenerate_retry(options, attempted_algorithms)`.
- Produces: conformal OCC acceptance behavior in which partial degeneracy retries another Gmsh algorithm and never calls `_drop_degenerate_tetrahedra`.

- [x] **Step 1: Verify the regression is red**

Run:

```bash
PYTHONPATH=packages/fullmag-py/src:packages/fullmag-py/tests \
  .fullmag/local/python/bin/python -c \
  'import test_conformal_occ_degenerate_retry_regression as t; t.test_partial_degenerate_occ_mesh_retries_instead_of_cutting_topology()'
```

Expected: failure with `destructive cleanup must not run for conformal OCC`.

- [x] **Step 2: Align the existing partial-degeneracy test with the retry contract**

Rename `test_conformal_occ_hxt_partial_degenerate_cleans_without_delaunay_retry`
to `test_conformal_occ_hxt_partial_degenerate_retries_delaunay_without_cleanup`.
Make the fake OCC generator return the partial-degenerate mesh only on the first
call and a valid two-element mesh on the second call. Assert calls are
`[ALGO_3D_HXT, ALGO_3D_DELAUNAY]`, two elements survive, and the only fallback
is `conformal_occ_hxt_degenerate_retry_delaunay`.

- [x] **Step 3: Remove the destructive conformal cleanup branch**

In `_realize_fem_domain_mesh_asset_from_components_impl`, change the
`except ValueError as exc` branch after conformal `validate_strict` so it goes
directly to `_conformal_occ_degenerate_retry`. Do not call
`_drop_degenerate_tetrahedra` or replace `result.mesh` in this branch.

- [x] **Step 4: Verify focused tests are green**

Run the standalone regression command from Step 1. Then run the two focused
`MeshingTests` methods through the available Python test environment. Expected:
all selected tests pass, with no cleanup marker in the conformal report.

### Task 2: Prove the reported example end to end

**Files:**
- Modify: `examples/permalloy_layer_cofeb_rings_relax_300nm.py`

**Interfaces:**
- Consumes: the conformal OCC mesh asset and the existing managed runtime recipe.
- Produces: stable thin-film mesh settings and a completed FEM run whose mesh
  passes certified boundary completeness.

- [x] **Step 1: Configure the thin-film mesh and Gmsh optimizer**

Use one fixed swept-prism layer through the 1.6 nm film, retain HXT as the
first algorithm, and run the built-in `Gmsh` optimizer before strict validation.

- [x] **Step 2: Run the exact managed example**

Run:

```bash
just run-cofeb-rings-relax-headless gpu
```

The GPU probe must pass meshing and planning. If strict GPU startup is blocked
by the installed CUDA driver, run `just run-cofeb-rings-relax-headless cpu`
outside a socket-restricted sandbox. Expected: exit code 0 and no `magnetic
boundary is incomplete`, `magnetic-air interface is incomplete`, `airbox
Gamma_out is incomplete`, or `removed ... degenerate tetrahedra` output.

- [x] **Step 3: Audit the final diff and evidence**

Run `git diff -- packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py packages/fullmag-py/tests/test_meshing.py` and `git status --short`. Confirm every production/test change implements the topology-preserving retry and that unrelated changes remain untouched.
