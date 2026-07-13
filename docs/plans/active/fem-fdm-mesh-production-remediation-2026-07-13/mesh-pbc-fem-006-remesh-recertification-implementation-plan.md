# MESH-PBC-FEM-006 — PBC remesh recertification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Po każdej zmianie topologii regenerować periodic pairs i nowy v6 związany z nowym topology hash.

**Architecture:** Remesh transaction nie kopiuje starego certyfikatu. Candidate jest legalny dopiero po ponownym periodic meshing/certification i state-transfer audit.

**Tech Stack:** Python remesh, Rust CLI/planner, artifact fingerprints

## Global Constraints

- Certificate identity zawsze zawiera bieżący topology hash.
- Remesh bez możliwości zachowania mirrored topology fail-closed.
- Old certificate pozostaje historycznym artifact, nigdy current.

---

**Finding:** MESH-PBC-FEM-006, P1.
**Dependencies:** MESH-FEM-007, MESH-PBC-FEM-002 i 005.

### Task 1: RED lifecycle

- [ ] Dodać tests: successful symmetric remesh, asymmetric candidate, stale certificate copied to new mesh, failure during recertification.
- [ ] Uruchomić remesh CLI/orchestrator tests; obecne stale/copy przypadki mają FAIL.

### Task 2: recertify before commit

```rust
fn certify_remesh_candidate(candidate: &MeshIR, request: &PeriodicRequestIR) -> Result<PeriodicMeshCertificateV6, RemeshError>;
```

- [ ] Zachować authored periodic request, ponownie zastosować mesher constraints, wygenerować pairs i v6 po ekstrakcji.
- [ ] Commit remesh tylko po strict mesh validation, v6 validation i state transfer; emitować jeden new generation event.
- [ ] Uruchomić Python remesh, Rust orchestrator i managed meshing gates; PASS.

### Task 3: provenance

- [ ] Artifact ma zapisać old/new topology hash, old/new certificate ID i recertification result.
- [ ] Commit: `git add packages/fullmag-py/src/fullmag/meshing crates/fullmag-cli crates/fullmag-plan && git commit -m "fix(pbc): recertify every FEM remesh generation"`.

**Exit:** żadna nowa topologia PBC nie używa starego certificate; asymmetric remesh nie zostaje opublikowany.

