# Raport implementera — Task 10C artifacts

## Status

`DONE` dla zakresu runner/artifacts. Zmiana jest dowodem kontraktowym i unitowym;
nie stanowi kwalifikacji runtime, GPU, API, planar ani przeglądarki.

## Zakres

Zmieniono wyłącznie:

- `crates/fullmag-runner/src/artifacts.rs` — implementacja oraz testy modułowe;
- `.superpowers/sdd/task-10c-artifacts-report.md` — ten raport.

Dwa istniejące przed rozpoczęciem Task 10C wpisy fixture
`native_region_mask: None` i `native_region_legend: None` dla dwóch warstw
zostały zachowane. Są konieczne, aby fixture kompilował się z rozszerzonym
`FdmLayerPlanIR` po A2; będą jawnie objęte tym samym commitem. Nie zmieniono
API, planar samplera, dokumentacji ani cudzych dirty plików.

## Implementacja

- `field_layout` publikuje dla każdej warstwy `layer_id`, `object_id`,
  `magnet_name`, natywną siatkę, origin/cell size, fingerprint siatki,
  `value_offset`/`value_count`, membership descriptors i mapę dostępnych pól
  materiałowych.
- `native_grid_fingerprint` jest kanonicznym SHA-256 z
  `FdmGridCertificateIR::new_with_topology_tokens`, związanym z active mask i
  surową plannerową maską regionów. Nie jest fingerprintem geometry-only.
- `mat_ms`, `mat_aex` i `mat_alpha` są zapisywane wyłącznie z rzeczywistych
  `FdmLayerPlanIR.material.{ms_field,a_field,alpha_field}`. Brak tablicy
  pozostaje brakiem materializacji; nie ma rozwijania scalar fallbacku.
- Artefakty mają układ
  `material-fields/fdm-multilayer/layer-<id>/<field>.json`, a manifest
  `material-fields/fdm-multilayer/manifest.json` opisuje rozdzielne natywne
  siatki. Nie powstaje common-grid material asset.
- Membership jest zapisywany per warstwa jako maska `u32`, gdzie inactive ma
  `u32::MAX`, unassigned ma `0`, oraz jako legenda
  `(numeric_id, object_id, region_id, priority)`. Hash maski encoded i hash
  legendy są rozdzielne.
- Każdy payload/deskryptor ma niezerową rewizję `1`, generation ID i hash
  wartości w postaci `sha256:<64 lowercase hex>`.
- Walidacje fail-closed obejmują: overflow/zero native grid, długości active
  mask/region mask/material fields, finite origin/cell size, dodatnie cell
  size, finite i fizyczną dziedzinę `Ms/Aex/alpha`, kanoniczne units,
  tożsamość legendy, nieznane numeric IDs oraz przypisanie regionu do inactive
  cell. Walidacja wszystkich warstw kończy się przed pierwszym zapisem.
- Nieprawidłowy multilayer layout nie przechodzi do single-grid field writer.
- Istniejący single-grid FMRM v2 i FEM material-field metadata shape pozostają
  zachowane przez testy regresji.

## TDD — RED

1. Pierwszy RED po dodaniu testów zatrzymał kompilację na starym wyniku
   `Vec<MaterialFieldAssetIR>`: cztery błędy `E0608/E0599` dowiodły, że istniejący
   FEM-only metadata type nie potrafił przenieść layer-aware descriptors.
2. Test fingerprintu failował z różnymi hashami:
   geometry-only `sha256:d523...` zamiast topology-bound `sha256:50a4...`.
3. Test inactive membership failował, ponieważ serializer zwracał sukces dla
   raw niezerowego region ID na nieaktywnej komórce.
4. Test błędnego layoutu odtworzył możliwość pustego multilayer layoutu; writer
   został zmieniony na fail-closed zamiast powrotu do canonical single-grid.

## GREEN i weryfikacja

Użyto istniejącego targetu na zarządzanym wolumenie:
`CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/task-10b-fdm-cpu-green`
oraz `CARGO_INCREMENTAL=0`. Nie uruchamiano natywnego FEM ani dużego buildu na
root filesystemie.

- focused multilayer artifacts:
  `cargo test -p fullmag-runner --lib artifacts::tests::fdm_multilayer_ -- --nocapture`
  — `12 passed; 0 failed`;
- single-grid FMRM guard:
  `cargo test -p fullmag-runner --lib artifacts::tests::fdm_region_membership_artifact_persists_binary_mask_and_legend_identity -- --exact --nocapture`
  — `1 passed; 0 failed`;
- FEM material asset regression:
  `cargo test -p fullmag-runner --lib artifacts::tests::write_artifacts_persists_fem_material_field_asset_files -- --exact --nocapture`
  — `1 passed; 0 failed`;
- `cargo check -p fullmag-runner --lib` — exit `0`;
- `git diff --check -- crates/fullmag-runner/src/artifacts.rs` — exit `0`.

Występują wcześniejsze ostrzeżenia `unused_mut`/`dead_code` w engine/runner;
nie powstały w tym zakresie i nie były naprawiane drive-by. Próba
`cargo fmt -p fullmag-runner -- --check` wykazała wcześniejsze format drift w
cudzych aktywnie modyfikowanych plikach. Automatyczne formatowanie poza
własnymi hunkami zostało cofnięte.

## Ograniczenia i bramki

- Brak claimu runtime, managed-runtime, CUDA/GPU, API, planar i browser/WebGL.
- API/planar implementer musi czytać dokładny per-layer `artifact_path`,
  weryfikować count/unit/hash/generation/revision i normalizować encoded
  inactive `u32::MAX` do plannerowego `0` wyłącznie przy rekonstrukcji
  topology fingerprintu.
- Produkcyjne plany A2 materializują per-layer `native_region_mask` również
  bez authored regions (`Some([0...])`) oraz pustą legendę. Legacy/tampered
  `None` pozostaje jawnie `available=false`, bez syntetyzowania wspólnej maski.
