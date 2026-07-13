# MESH-FEM-005 — Executable MeshOperation contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Każdą publiczną `MeshOperation` wykonać z raportem `actual_method` albo odrzucić jako unsupported przed buildem.

**Architecture:** Operation registry mapuje authoring kind na capability i jeden executor. Samo zapisanie operacji w eksporcie nie oznacza wsparcia runtime.

**Tech Stack:** Python DSL/meshing, Rust orchestration/capabilities, UI Inspector

## Global Constraints

- Statusy `declared`, `executable`, `validated` są rozłączne.
- Brak no-op dla `refine`, `adapt`, `swept`, `boundary_layers`, `size_field`.
- Zmiana numerics zaczyna się od `docs/physics/0100` i `0105`.

---

**Finding:** MESH-FEM-005, P1.
**Files:** `packages/fullmag-py/src/fullmag/model/discretization.py`, `packages/fullmag-py/src/fullmag/world.py`, `packages/fullmag-py/src/fullmag/meshing/_gmsh_remesh.py`, `packages/fullmag-py/src/fullmag/meshing/remesh_cli.py`, `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`, `crates/fullmag-cli/src/orchestrator.rs`, `docs/specs/capability-matrix-v0.md`, `docs/specs/capability-matrix-v0.json`, `apps/control-room/src/modules/inspector/panels/mesh-details/MeshBuildPipelineSection.tsx`.

### Task 1: contract i RED matrix

- [ ] W physics/spec docs opublikować support matrix operation kind -> executor -> validation tier.
- [ ] Dodać parametryczne testy publicznych kinds: każdy ma artifact `actual_method` albo stabilny unsupported error; obecne no-op przypadki mają FAIL.

### Task 2: minimal execution registry

```python
MESH_OPERATION_EXECUTORS: dict[str, Callable[[MeshState, MeshOperation], MeshState]]
```

- [ ] Zarejestrować tylko istniejące, mierzalne executors; dla reszty fail-closed z capability reason.
- [ ] Zapisać requested operation, resolved executor, before/after topology hash i metrics w build report.
- [ ] Uruchomić Python meshing suite oraz orchestrator tests; PASS.

### Task 3: capability/UI

- [ ] Propagować support matrix do generated UI gating i Mesh Inspector; unsupported control ma actionable reason.
- [ ] Uruchomić `./scripts/ci/contract_guard.sh --strict`, `pnpm --dir apps/control-room typecheck`, `lint`, `test`, `check:api-hygiene` i `check:architecture-hygiene`.
- [ ] Commit: `git add docs/physics docs/specs packages/fullmag-py crates/fullmag-cli apps/control-room && git commit -m "fix(mesh): make operation support executable and explicit"`.

**Exit:** nie istnieje publiczny operation kind, który kończy się sukcesem bez zmiany lub jawnego validated no-op result.
