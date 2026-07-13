# MESH-REGION-006 — Region marker generation provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mapa region-marker jest jednoznacznie związana z ownerem, mesh generation i topology hash we wszystkich raportach, planach i artefaktach.

**Architecture:** Jeden typ `ObjectRegionMarkerCertificateIR` zastępuje luźną mapę na granicach warstw. Asset, build report, planner i runtime zachowują tę samą identity; mismatch jest fail-closed.

**Tech Stack:** Rust IR/planner/runner, Python build report, API schemas

## Global Constraints

- Marker number bez owner/region/generation identity nie jest wystarczającym kluczem.
- Hash jest deterministyczny dla posortowanych wpisów i topology hash.
- OpenAPI publikuje certificate summary, ciężka mapa może pozostać resource-scoped.

---

**Finding:** MESH-REGION-006, P1.

### Task 1: RED — stale i collision

- [ ] Dodać IR/planner tests dla mapy z obcej generation, błędnego ownera, braku coverage i ponownego użycia numeru markera; wszystkie muszą być odrzucone.
- [ ] Dodać round-trip Python report -> Rust IR -> artifact i potwierdzić, że obecny report traci identity.

### Task 2: canonical certificate

```rust
struct ObjectRegionMarkerCertificateIR {
    mesh_generation_id: String,
    topology_hash: String,
    entries: Vec<ObjectRegionMarkerEntryIR>,
    digest: String,
}
```

- [ ] Wprowadzić wpis zawierający `object_id`, `region_id`, marker, element count i volume; walidować uniqueness, enabled conformal coverage i digest.
- [ ] Przenieść certificate przez Python response, `FemSharedDomainBuildReportIR`, mesh asset, planner, runtime provenance, artifacts i API resource.
- [ ] Usunąć lookup po samym numerze markera na ścieżce material realization.

### Task 3: gates

- [ ] Uruchomić IR/planner/runner/API tests, OpenAPI generation/hygiene i managed FEM contract; sprawdzić ten sam digest w report, plan i artifact.
- [ ] Commit: `git add packages/fullmag-py crates/fullmag-ir crates/fullmag-plan crates/fullmag-runner crates/fullmag-api && git commit -m "fix(fem): bind region markers to mesh generation"`.

**Exit:** marker z innej topologii lub ownera nie może przejść validation ani material assignment.
