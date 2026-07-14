# MESH-PBC-FEM-003 — Certified face-pair artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć syntetyczne normalne i nearest-centroid reconstruction z runner artifacts; publikować wyłącznie certyfikowane face pairs.

**Architecture:** `periodic_mesh_certificate.v6` jest źródłem face/node pairs. Artifact writer serializuje jego evidence i nie zgaduje topologii.

**Tech Stack:** Rust runner/artifacts/API, serde tests

## Global Constraints

- `normal_dot` jest policzone z rzeczywistych outward normals.
- Face pair zawiera vertex correspondence, area residual i translation residual.
- Brak certificate nie produkuje pozornego `valid` artifact.

---

**Finding:** MESH-PBC-FEM-003, P0.
**Dependency:** MESH-PBC-FEM-002.

### Task 1: RED artifact snapshots

- [x] Dodać fixture o normalnych innych niż osiowe oraz odrzuceniu seam o tej samej orientacji; writer przed poprawką publikował `valid`.
- [x] W `crates/fullmag-runner/src/artifacts.rs` tests oczekują realnego normal dot, certificate face ID i vertex correspondence.

Uwaga: osobny fixture z bliskimi centroidami i inną triangulacją oraz API resource wiring pozostają otwarte.

### Task 2: serializer bez reconstruction

```rust
fn periodic_pairs_artifact(cert: &PeriodicMeshCertificateV6) -> Result<PeriodicPairsArtifactV2, ArtifactError>;
```

- [x] Usunąć axis-derived `normal_dot=-1` z periodic-pairs artifactu; `normal_dot`, face IDs, vertex pairs, area residual i translation residual są mapowane z v6 certificate.
- [x] Fail-closed, jeśli artifact topology fingerprint różni się od mesh fingerprint; runner certificate identity guard i API live-mesh comparison odrzucają niezgodny artifact.
- [x] Uruchomić `cargo test -p fullmag-runner periodic_pairs_artifact --lib --no-fail-fast -- --nocapture`; 3 passed.

### Task 3: API consistency

- [x] Przełączyć API handler na persisted artifact/resource przy zgodnym topology fingerprint i uruchomić `cargo test -p fullmag-api mesh_periodic_pairs --no-fail-fast`.
- [x] Commity implementacyjne: `c7abab26` (artifact identity/API consumption) oraz `fef2f602` (material-aware v6 evidence).

**Exit:** artifact nie zawiera pól wyprowadzonych z samej osi/centroidu; fingerprint i wszystkie residuals odpowiadają certyfikatowi.

### Evidence (2026-07-14, partial)

- `cargo test -p fullmag-runner periodic_pairs_artifact --lib --no-fail-fast -- --nocapture` — 3 passed.
- `PeriodicAxisCertificateV6IR.face_pairs` publikuje globalne face IDs, explicit vertex pairs, rzeczywisty `normal_dot`, area residual, translation residual oraz seam marker/domain evidence.
- Artifact ustawia `validation_status=failed`, `certificate_status=rejected` i nie publikuje face pairs, gdy v6 certificate jest odrzucony.
- `validate_periodic_certificate_identity` ma focused stale-topology rejection test; persisted artifact zapisuje `mesh_generation_id` i `certificate_fingerprint`.
- API `mesh_periodic_pairs` suite — 7 passed; matching persisted artifact is preferred for a live mesh, mismatched artifact is never used.
- Otwarte: pełne source-scene revision w artifact manifest, binary scoped data-plane contract i managed runtime evidence.
