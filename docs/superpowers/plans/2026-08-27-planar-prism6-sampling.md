# Planarne próbkowanie FEM Prism6 — plan implementacji

> **Dla agentów wykonawczych:** wymagane umiejętności: `physics-publication`, `scientific-documentation-contract`, `fem-native-backend-architecture`, `resource-first-api-check`, `test-driven-development` i `verification-before-completion`.

**Cel:** zapewnić poprawne numerycznie zasoby planarnego `m` i innych pól na domenach FEM Prism6 bez ukrytej tetraedryzacji, bez próbkowania powietrza dla compact magnetic carrier i bez zmiany publicznego kształtu API.

**Architektura:** sampler otrzyma topology-aware element carrier z osobną realizacją liniowej bazy Prism6 (triangle-P1 × interval-P1). Lokalizacja, interpolacja, clipping/slab integration, occupancy i overlay będą rozróżniać Tet4 i Prism6. Default source dla quantity `magnetic_only` ograniczy target do magnetycznych elementów, zachowując powietrze jako maskę.

**Technologie:** Rust, FEM P1 geometry/postprocessing, Axum v2 resources, managed/container `just`, Playwright.

## Ograniczenia globalne

- Nie używać pierwszych czterech węzłów Prism6 ani niejawnej konwersji do Tet4.
- Nie zmieniać równań solvera, Python DSL ani ProblemIR; jest to numeryczny postprocessing zasobów.
- Pyramid5 i Hex8 pozostają jawnie unsupported, dopóki nie dostaną własnych realizacji.
- OpenAPI i wygenerowany transport pozostają bez zmian, jeżeli endpointy i metadane nie zmienią kształtu.
- Autorytatywne buildy/runtime FEM prowadzić wyłącznie przez kontenerowe recepty `just`.

---

### Zadanie 1: publikacyjny kontrakt Prism6

**Pliki:**
- modyfikacja: `docs/physics/0970-planar-monitor-sampling-and-projection.md`
- modyfikacja: sąsiedni `docs/physics/0970-planar-monitor-sampling-and-projection.source-map.json`
- modyfikacja: `docs/specs/capability-matrix-v0.md`
- modyfikacja: `docs/specs/resource-first-control-room-api-v2.md`

- [ ] Udokumentować bazę Prism6, mapowanie referencyjne, Jacobian, interpolację, clipping/integrację, occupancy, surface overlay, validity limits i zachowanie compact magnetic carrier.
- [ ] Uzupełnić macierz FDM CPU/GPU oraz FEM CPU/GPU i status kwalifikacji.
- [ ] Zmapować każde twierdzenie do stabilnego `path + symbol` i zaktualizować source map.
- [ ] Uruchomić walidator dokumentacji oraz jego testy; bez przejścia tej bramki nie zaczynać kodu.

```bash
python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0970-planar-monitor-sampling-and-projection.source-map.json --repo-root .
python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
```

### Zadanie 2: topology-aware kontrakt elementu i baza Prism6

**Pliki:**
- modyfikacja: `crates/fullmag-api/src/planar_sampling/contract.rs`
- modyfikacja: `crates/fullmag-api/src/planar_sampling/geometry.rs`
- test: `crates/fullmag-api/src/planar_sampling/tests.rs`
- test: `crates/fullmag-api/src/planar_sampling/target_tests.rs`

- [ ] Dodać testy RED dla funkcji kształtu Prism6: partition of unity, Kronecker nodes, stałe i afiniczne pole oraz nanometrowa skala.
- [ ] Zastąpić `Vec<[u32; 4]>` topology-aware reprezentacją obsługującą `Tet4` i `Prism6`.
- [ ] Dodać mapowanie referencyjne i stabilną lokalizację punktu/Jacobian dla Prism6.
- [ ] Zachować istniejącą ścieżkę Tet4 bez zmiany wyników.

### Zadanie 3: plane, slab/depth, occupancy i overlay Prism6

**Pliki:**
- modyfikacja: `crates/fullmag-api/src/planar_sampling/fem.rs`
- modyfikacja: `crates/fullmag-api/src/planar_sampling/target.rs`
- test: `crates/fullmag-api/src/planar_sampling/target_tests.rs`

- [ ] Dodać testy RED plane sample dla stałego i afinicznego pola Prism6.
- [ ] Dodać testy RED slab/depth dla zachowania stałej, miary i refinement invariance.
- [ ] Dodać test overlay: dwa końce `tri3`, trzy boki `quad4`, poprawne boundary/interior.
- [ ] Dodać mixed-mesh target/scope dla Prism6 + Tet4 oraz jawne odrzucenie Pyramid5/Hex8.
- [ ] Zaimplementować interpolation, integration, occupancy i overlay bez tetraedryzacji.

### Zadanie 4: quantity-domain-aware default target

**Pliki:**
- modyfikacja: `crates/fullmag-api/src/planar_sampling/source.rs`
- modyfikacja: `crates/fullmag-api/src/planar_sampling/target.rs`
- test: `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs` lub istniejące router tests

- [ ] Dodać test RED: default planar `m` na domenie prism + airbox wybiera compact magnetic carrier, a powietrze pozostaje masked.
- [ ] Dodać testy endpointów `meta`, scalar/vector, mask, overlay i probe z oczekiwanym `200`.
- [ ] Rozwiązać default target na podstawie quantity domain i canonical carrier descriptors.
- [ ] Zachować typowane `422` dla faktycznie nieobsługiwanych topologii.

### Zadanie 5: zarządzana kwalifikacja FEM i browser

- [ ] Dodać kontenerową receptę `verify-planar-sampling-prism6-contract`, która uruchamia pełne testy `planar_sampling` na zarządzanym runtime.
- [ ] Uruchomić autorytatywny rebuild i kontrakty mixed-P1.
- [ ] Uruchomić CPU i GPU smoke default slice oraz authored planar monitor na rzeczywistym fixture Prism6.
- [ ] Potwierdzić brak powtarzalnych `404/422`, stabilny raster, poprawną maskę i zachowany WebGL.

```bash
just rebuild-fem-runtime
just verify-fem-mixed-p1-native-contract
just verify-fem-mixed-prism-airbox-runtime
just run-viewport-2d-default-slice-smoke-fem-cpu
just run-viewport-2d-default-slice-smoke-fem-gpu
just run-viewport-2d-planar-monitor-smoke fem cpu
just run-viewport-2d-planar-monitor-smoke fem gpu
```
