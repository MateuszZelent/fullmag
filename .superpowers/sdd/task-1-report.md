# Task 1 report: canonical mixed-P1 contract and Gmsh feasibility fixture

## Result

- Status: `DONE_WITH_CONCERNS`
- Commit: `0b12322bfd732b6a7117571ec419eb587f10d74d`
- Commit subject: `Define native mixed-P1 topology contract`
- Scope: documentation and a frozen Gmsh feasibility fixture/test only; no
  production meshing, native operator, runtime, SP4 scenario, or lockfile change.

## Changed files

Committed:

- `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`
- `docs/adr/0021-native-mixed-p1-fem-topology.md`
- `docs/architecture/backend-golden-masterplan.md`
- `docs/physics/0101-swept-mesh-through-thickness.md`
- `docs/physics/0104-thin-film-shared-domain-meshing.md`
- `docs/physics/0105-fem-meshing-production-acceptance.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- `docs/physics/fem_demag_poisson.md`
- `docs/specs/capability-matrix-v0.md`
- `packages/fullmag-py/tests/fixtures/gmsh/mixed_prism_pyramid_airbox.geo`
- `packages/fullmag-py/tests/test_mixed_element_meshing.py`

Report only, written after the commit and not staged:

- `.superpowers/sdd/task-1-report.md`

Pre-existing user/controller state preserved and never staged:

- `.superpowers/sdd/progress.md`

## Contract delivered

- Defines the canonical target as `prism6` magnetic cells, `pyramid5` air
  transition cells, `tet4` far-air cells, and `tri3 | quad4` facets.
- Preserves the existing exchange, Zeeman, scalar-Poisson, and demag-energy
  signs and SI units; the mesh change introduces no new physics.
- Specifies topology-aware P1 basis/trace semantics, one-layer full-3D meaning,
  shared-node conformity, magnetic region ownership, and CPU/GPU parity.
- Defines a fail-closed exact-layer/shared-domain certificate, requested versus
  resolved provenance, canonical capability vocabulary, FMMT v2 implications,
  the narrow first workload, and explicit unsupported lanes.
- Keeps all new capabilities `semantic_only` or `unsupported`; the feasibility
  fixture does not claim `production_executable` or `validated` status.
- Rejects silent prism-to-tet conversion, nonconforming coupling, 2.5D
  reinterpretation, and a second Rust FEM implementation.

## TDD evidence

### RED

Command:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_mixed_element_meshing.py -k gmsh_feasibility -vv
```

Expected failure before the fixture was added:

```text
AssertionError: missing frozen Gmsh feasibility fixture: .../mixed_prism_pyramid_airbox.geo
1 failed
exit 1
```

This was the intended missing-fixture failure from the new test, not a command
or dependency failure.

### GREEN

The same exact command was rerun after the frozen Box-in-Box fixture was added
and again after commit:

```text
packages/fullmag-py/tests/test_mixed_element_meshing.py::test_gmsh_feasibility_freezes_mixed_p1_topology PASSED [100%]
1 passed in 0.15s
exit 0
```

The test pins Gmsh `4.15.2` and proves:

- film cells are exactly `Prism 6`;
- air cells contain exactly `Pyramid 5` and `Tetrahedron 4` topologies;
- the film has exactly two normal-coordinate node planes;
- film top/bottom facets are `Triangle 3` and laterals are `Quadrilateral 4`;
- pyramid bases remain on the quadrilateral film transition;
- tetrahedra exist in far air;
- all film boundary faces have one film and one air owner with shared node IDs;
- volume-face ownership is manifold, and explicit faces are neither duplicated
  nor orphaned;
- the production splitter module is not imported.

The fixture is a closed Box-in-Box volume: an explicit outer Box surface loop
contains the structured prism film boundary as the air volume's inner loop.

## Repeated-error research and correction

An initial attempt to force all-prism air failed twice. Per `AGENTS.md`, the
Gmsh 4.15.2 reference manual was checked for structured extrusion and QuadTri
transition behavior. The considered fixes were explicit `QuadTriAddVerts`, a
dedicated transition volume, unstructured air bounded by the film's shared
quadrilateral faces, and `TransfQuadTri`. The selected minimal fixture uses the
last geometry contract with unstructured closed air: Gmsh inserts pyramids at
the quadrilateral interface and tetrahedra farther away. A one-sided air block
was rejected and replaced by the final closed Box-in-Box fixture.

## Repository consistency

Required command:

```bash
python3 scripts/check_repo_consistency.py
```

Post-commit output and status:

```text
FAIL: .github is missing skill mirrors for: backend-golden-masterplan, brainstorming, dispatching-parallel-agents, executing-plans, fem-native-backend-architecture, finishing-a-development-branch, frontend-apple-style, frontend-v2-api-hygiene, frontend-v2-cutover-governance, frontend-v2-module-architecture, frontend-v2-performance-gates, frontend-v2-state-hygiene, frontend-v2-viewport-lifecycle, full-output-enforcement, google-eng-review-practices, gpt-taste, high-end-visual-design, react-doctor, receiving-code-review, requesting-code-review, subagent-driven-development, systematic-debugging, test-driven-development, using-git-worktrees, using-superpowers, verification-before-completion, writing-plans, writing-skills
exit 1
```

Baseline attribution command:

```bash
git diff --exit-code HEAD^ -- .agents .github scripts/check_repo_consistency.py
```

Result:

```text
no output
exit 0
```

The commit changes neither skill mirror tree nor the consistency script, so the
reported mirror inventory gap is pre-existing and outside this slice.

## Additional verification

```bash
python3 -m py_compile packages/fullmag-py/tests/test_mixed_element_meshing.py
git diff --check
git diff --cached --check
git show --check --stat --oneline HEAD
git diff-tree --no-commit-id --name-only -r HEAD
```

All commands above exited `0`. The final commit contains exactly the 11 paths
listed under Changed files. `packages/fullmag-py/uv.lock`, SP4 scenarios,
production meshing code, and `.superpowers/sdd/progress.md` are absent from the
commit.

## Self-review

- Read the complete staged diff and traced every change to the Slice 1 brief.
- Confirmed the physics note precedes implementation and covers equations,
  units, assumptions, backend interpretations, public/API/IR/planner/runtime/UI
  impact, validation, completion state, and deferred work.
- Confirmed the ADR states the decision, rejected alternatives, ownership,
  versioned transport migration, rollback, and validation consequences.
- Confirmed capability vocabulary is target-only and does not overclaim runtime
  support.
- Confirmed the fixture uses shared topology in one closed domain and freezes
  invariants rather than incidental element counts.
- Confirmed the test makes no production Fullmag meshing call and cannot pass by
  exercising the legacy prism-to-tet splitter.
- Confirmed no unrelated dirty file was staged or committed.

## Concerns

The required repository-consistency command is not green because the baseline
`.github` skill mirror inventory is incomplete. This slice neither caused nor
repairs that repository-wide governance issue. There are no known concerns with
the committed mixed-P1 contract or focused Gmsh feasibility gate. Production
mixed-P1 execution remains intentionally unimplemented and unvalidated.

## Review-fix follow-up

- Status: `DONE_WITH_CONCERNS`
- Fix commit: `cf2d0b3c806885aadf17b9906a802020dfb3b568`
- Commit subject: `Harden mixed-P1 feasibility guards`
- Committed paths:
  - `packages/fullmag-py/tests/fixtures/gmsh/mixed_prism_pyramid_airbox.geo`
  - `packages/fullmag-py/tests/test_mixed_element_meshing.py`

### Finding 1 RED: collection-order dependence

Command on the pre-fix test:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_meshing.py packages/fullmag-py/tests/test_mixed_element_meshing.py -k gmsh_feasibility -vv
```

Output and status:

```text
collecting ... collected 252 items / 251 deselected / 1 selected
packages/fullmag-py/tests/test_mixed_element_meshing.py::test_gmsh_feasibility_freezes_mixed_p1_topology FAILED [100%]
>       assert splitter_module not in sys.modules
E       AssertionError: assert 'fullmag.meshing._gmsh_swept' not in {...}
====================== 1 failed, 251 deselected in 0.63s =======================
exit 1
```

Root cause: `test_meshing.py` imports functions from `_gmsh_swept` during
collection, so module presence measured test ordering rather than splitter use.
The replacement imports the owner module deterministically, monkeypatches
`_split_prism_to_tets` with a call-failing mock, and asserts that the mock was
not called. This guard is independent of whether another test collected the
module first and fails immediately if the feasibility path invokes the
production splitter.

First GREEN after only the order-independent guard change used the same command:

```text
collecting ... collected 252 items / 251 deselected / 1 selected
packages/fullmag-py/tests/test_mixed_element_meshing.py::test_gmsh_feasibility_freezes_mixed_p1_topology PASSED [100%]
====================== 1 passed, 251 deselected in 0.62s =======================
exit 0
```

### Finding 2 RED: unnamed one-owner boundaries

After adding the exact outer-boundary assertion but before changing the GEO,
the focused command was:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_mixed_element_meshing.py -k gmsh_feasibility -vv
```

Output and status:

```text
packages/fullmag-py/tests/test_mixed_element_meshing.py::test_gmsh_feasibility_freezes_mixed_p1_topology FAILED [100%]
E       AssertionError: missing physical group 'airbox_outer'
FAILED packages/fullmag-py/tests/test_mixed_element_meshing.py::test_gmsh_feasibility_freezes_mixed_p1_topology - AssertionError: missing physical group 'airbox_outer'
============================== 1 failed in 0.34s ===============================
exit 1
```

Root cause: the old test accepted every one-owner volume face if Gmsh exposed
it as any explicit surface, so a named internal cavity or crack could pass. The
GEO now names surfaces `211` through `216` as `airbox_outer`, and the test
requires exact set equality between that physical surface mesh and all
one-owner volume faces. The film-interface assertion remains exactly two
owners with one `film` and one `air` owner.

### Final GREEN

Focused command:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_mixed_element_meshing.py -k gmsh_feasibility -vv
```

Output and status:

```text
packages/fullmag-py/tests/test_mixed_element_meshing.py::test_gmsh_feasibility_freezes_mixed_p1_topology PASSED [100%]
============================== 1 passed in 0.39s ===============================
exit 0
```

Co-collection command:

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_meshing.py packages/fullmag-py/tests/test_mixed_element_meshing.py -k gmsh_feasibility -vv
```

Output and status:

```text
collecting ... collected 252 items / 251 deselected / 1 selected
packages/fullmag-py/tests/test_mixed_element_meshing.py::test_gmsh_feasibility_freezes_mixed_p1_topology PASSED [100%]
====================== 1 passed, 251 deselected in 0.83s =======================
exit 0
```

Additional commands:

```bash
python3 -m py_compile packages/fullmag-py/tests/test_mixed_element_meshing.py
git diff --check
```

Both exited `0` with no output. The separately inspected staged path list
contained exactly the two committed fixture/test paths above. The report and
the pre-existing `.superpowers/sdd/progress.md` change were not staged.

Post-commit repetition of the two required pytest commands also exited `0`:

```text
focused: 1 passed in 0.41s
co-collection: 1 passed, 251 deselected in 0.80s
```
