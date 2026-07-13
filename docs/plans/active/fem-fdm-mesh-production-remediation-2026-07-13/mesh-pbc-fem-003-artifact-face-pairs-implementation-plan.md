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

- [ ] Dodać fixture o normalnych innych niż osiowe oraz dwie ściany o bliskich centroidach, lecz innej triangulacji.
- [ ] W `crates/fullmag-runner/src/artifacts.rs` tests oczekiwać realnego normal dot i certificate face ID; obecny writer ma FAIL.

### Task 2: serializer bez reconstruction

```rust
fn periodic_pairs_artifact(cert: &PeriodicMeshCertificateV6) -> Result<PeriodicPairsArtifactV2, ArtifactError>;
```

- [ ] Usunąć axis-derived `normal_dot=-1` i centroid matching; mapować wszystkie fields z certyfikatu.
- [ ] Fail-closed, jeśli artifact topology fingerprint różni się od mesh fingerprint.
- [ ] Uruchomić `cargo test -p fullmag-runner periodic_pairs --no-fail-fast`; PASS.

### Task 3: API consistency

- [ ] Przełączyć API handler na ten artifact/resource i uruchomić `cargo test -p fullmag-api periodic_pairs --no-fail-fast`.
- [ ] Commit: `git add crates/fullmag-runner/src/artifacts.rs crates/fullmag-api && git commit -m "fix(pbc): publish certified FEM face pairs"`.

**Exit:** artifact nie zawiera pól wyprowadzonych z samej osi/centroidu; fingerprint i wszystkie residuals odpowiadają certyfikatowi.

