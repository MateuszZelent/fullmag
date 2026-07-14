# MESH-REGION-015 — FDM membership provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FDM publikuje realized cell membership i stabilną legendę regionów możliwą do inspekcji, reprodukcji i porównania z runtime.

**Architecture:** Planner tworzy deterministic legendę z canonical region IDs, a mask artifact/resource jest związany z grid certificate i membership revision. UI viewport pobiera scoped/binary realized mask; authored overlay pozostaje osobnym preview.

**Tech Stack:** Rust IR/planner/runner/API, binary codec, Control Room viewport

## Global Constraints

- Numeric ID bez legendy nie może opuścić planera.
- Numeracja jest deterministyczna i digestowana; zmiana priority nie może być cicho reinterpretowana.
- Duża maska korzysta z binary data plane i scope/LOD, nie z thin status JSON.

---

**Finding:** MESH-REGION-015, P1.
**Dependencies:** MESH-REGION-008/010/011.

### Task 1: RED round-trip

- [ ] Dodać fixtures add/delete/reorder/priority change i sprawdzić legendę, mask checksum, grid identity oraz provenance round-trip.
- [ ] Dodać API/viewport test rozróżniający authored overlay od realized cell membership; obecnie realized FDM resource ma być brakujący.

### Task 2: plan/artifact/resource

```rust
struct FdmRegionLegendEntryIR { numeric_id: u32, object_id: String, region_id: String, priority: i32 }
```

- [x] Dodać posortowaną legendę i digest do `FdmGridCertificateIR`; planner single-grid materializuje ją deterministycznie z canonical region IDs.
- [x] Walidować każdy mask ID względem legendy; brak legendy lub nieznany numeric ID kończy się stabilnym fail-closed błędem w certyfikacie.
- [x] Opublikować legendę i digest w `mesh_runtime_metadata` jako mały, inspekcyjny kontrakt.
- [x] Zapisać mask/legend/grid-certificate identity w artefaktach `mesh/fdm_region_membership.v1.{json,bin}`; binary payload używa wersjonowanego formatu `FMRM:u32_le`.
- [x] Udostępnić v2 descriptor `data/fdm-region-memberships` oraz scoped binary endpoints `data/fdm-region-membership[/{region_id}]` z ETag, revision headers i fingerprint validation.
- [ ] Viewport i Inspector używają realized mask dla aktywnego gridu; preview jest jawnie oznaczony.

### Task 3: proof

- [x] Uruchomić focused IR/planner/runner tests: legend digest, object-region materialization oraz runtime metadata (1/1 każdy).
- [x] Runner artifact test potwierdza descriptor, legendę, `FMRM` header i mask length.
- [x] API FMRM validator test PASS; Control Room codec/API tests 74/74 PASS; generated OpenAPI v2 paths/types updated; typecheck PASS; targeted ESLint PASS.
- [ ] Uruchomić pełny planner/runner/API binary codec suite, resource/viewport tests i browser smoke dla mask switching.
- [ ] Commit: `git add crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner crates/fullmag-api apps/control-room && git commit -m "feat(fdm): publish realized region membership"`.

**Exit:** każdą wartość cell mask można jednoznacznie przypisać do canonical regionu i grid generation.
