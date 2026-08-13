# Raport Task 3 — target resolver, sampler i cache planarny

## Status

`DONE`

Task 3 został zaimplementowany na bazie `ResolvedSpatialField` bez zmiany publicznego wire, OpenAPI, UI, ProblemIR ani Python DSL. Route planarny nie używa już równoległych ścieżek `extract_fdm_field` / `extract_fem_field`.

## Zakres wykonany

- Dodano wewnętrzny `ResolvedSpatialTarget` i `ResolvedSpatialScope`.
- Resolver wybiera dokładne komórki FDM albo elementy FEM dla `domain`, `magnetic_domain`, `object`, `region`, `mesh_part` i legalnego `airbox`.
- FDM `object` korzysta z dokładnego membership; aktywna maska nie jest traktowana jako membership obiektu, a niejednoznaczne `0` dla wielu obiektów failuje kontrolowanie.
- FEM wymaga Tet4 i nodalnego P1. Compact carrier jest rozwijany przez jawne local-to-global node IDs; brak wymaganych wartości kończy się kontrolowanym błędem.
- Bounds `target`, `magnetic_domain` i `universe` są liczone z właściwych zbiorów encji. Pusty magnetic extent nie jest zastępowany bounds całej domeny.
- `FdmAirboxCells` jest jedynym legalnym FDM carrierem dla scope `airbox`; quantity jest sprawdzane przez istniejący kontrakt carriera, bez literalnej gałęzi `H_demag`.
- FDM surface failuje bez substytucji; FEM akceptuje tylko opublikowane `object_boundary`.
- Fingerprint targetu obejmuje rodzaj i ID targetu, carrier/mapping, wybrane encje oraz mesh/grid revision.
- Wewnętrzny `PlanarSampleIdentity` obejmuje session, monitor i scene revisions, target, quantity/component/revision/generation, carrier revision, operator, pełną ramkę i extent, resolution, quality oraz provenance źródła. Dla legacy pola bez revision/generation dodawany jest fingerprint wartości.
- Cache wykonuje lookup i insert pod mutexem, ale sampling poza mutexem; pozostawiono istniejące bounded LRU/budżety.
- Usunięto stary planarny scope/bounds resolver i osierocone pole `FdmField.active_mask`.

## RED

Pierwszy wykonany RED:

```text
cargo test -p fullmag-api planar_sampling::target_tests:: --no-run
exit 101
E0432: brak resolve_spatial_target, sample_resolved_target,
       PlanarSampleIdentity, ResolvedSpatialScope
E0599: brak QuantityDataPlaneStore::get_or_sample_planar
```

Po dodaniu kompilowalnego kontraktu pierwszy behavioural run miał wynik `8 passed; 3 failed`; ujawnił dwie pomyłki komponentu w fixture oraz zbyt ogólny tekst diagnostyczny Airbox. Po ich korekcie wymagane testy stały się zielone.

Integracja route początkowo miała wynik `3 passed; 2 failed`. Oba błędy były 409 `field 'm' has no FEM topology carrier`: stare happy-path fixtures publikowały grid-shaped values bez prawdziwego carrier identity. Nie przywrócono syntetycznego fallbacku origin/spacing; fixtures uzupełniono o jawny FDM `artifact_layout` z grid, origin i cell size, a osobny test potwierdza 409 dla danych bez wiarygodnego carriera.

## GREEN i weryfikacja

Wykonano z:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/viewport2d-task3
CARGO_INCREMENTAL=0
```

- `cargo test -p fullmag-api planar_sampling::target_tests:: -- --nocapture`
  - `11 passed; 0 failed`.
- `cargo test -p fullmag-api quantity_data_plane::tests::planar_cache_mutex_is_not_held_during_expensive_sampling -- --nocapture`
  - `1 passed; 0 failed`.
- `cargo test -p fullmag-api planar_field_ -- --nocapture`
  - `6 passed; 0 failed`.
- `cargo test -p fullmag-api planar_ -- --nocapture`
  - finalnie `41 passed; 0 failed`.
- `cargo check -p fullmag-api --bin fullmag-api`
  - exit 0; brak nowych warningów Task 3. Pozostało pięć wcześniejszych warningów w `schemas/authoring.rs` i `schemas/decimal_u64.rs` oraz warningi zależności.
- targeted `rustfmt --check`
  - exit 0.
- `git diff --check`
  - exit 0.

Testy obejmują: bounds wybranego FEM targetu, compact/full parity dla plane i slab, dokładny FDM object target, legalność Airbox, stałe pole po rotacji i zmianie resolution, refinement-invariant slab z tolerancją `1e-10`, oddzielne cache keys dla revision/quality/thickness, mutex release, empty target, ambiguous membership, unsupported FEM carrier/order, nielegalny surface oraz route fail-closed bez prawdziwego spatial carriera.

## Granice kwalifikacji

- Zmiana jest zweryfikowana testami manufactured/unit i integracją HTTP v2.
- Publiczny wire/OpenAPI nie został zmieniony; publiczny sample token pozostaje zakresem Task 4.
- HTTP v2 pozostaje źródłem prawdy dla unified viewport; nie dodano bocznego transportu ani bezpośredniej ścieżki UI.
- Nie wykonano browser smoke, interaktywnego runtime ani fizycznej/produkcyjnej kwalifikacji; Task 3 ich nie obejmuje.

## Fixup po review

Dwa review odrzuciły pierwszą wersję z czterech powodów. Fixup usuwa wszystkie wskazane luki:

- runtime scope FEM jest teraz osobną maską i ogranicza niezależnie `target`, `magnetic_domain` oraz `universe`; pokryto `mesh_part` i `airbox`, w tym pusty magnetic extent Airbox,
- brak membership FDM nie jest już interpretowany jako cała domena magnetyczna; zwykły carrier domeny i `FdmAirboxCells` failują kontrolowanie dla `MagneticDomain`,
- test slab używa niejednorodnego liniowego pola P1 na skośnym Tet4, wyłącznie `SlabAverage`, sprawdza niepuste occupancy/pary oraz coarse/refined wobec analitycznej średniej z tolerancją `1e-10`,
- wszystkie node IDs wybranych Tet4 są walidowane przed indeksowaniem bufora; błąd zawiera stabilne `invalid_fem_connectivity` zamiast paniki.

RED po dodaniu testów regresyjnych: `11 passed; 5 failed`. Failowały oba przypadki FDM, bounds `universe` dla FEM `mesh_part` i Airbox oraz out-of-range Tet4 przez panic. Skorygowany test niejednorodnego slab przeszedł już przed zmianą produkcyjną, potwierdzając istniejącą poprawność tej części przy niewakuacyjnym oracle.

Końcowa weryfikacja fixupu:

- `cargo test -p fullmag-api planar_sampling::target_tests:: -- --nocapture`: `16 passed; 0 failed`,
- `cargo test -p fullmag-api planar_ -- --nocapture`: `46 passed; 0 failed`,
- `cargo test -p fullmag-api planar_field_ -- --nocapture`: `6 passed; 0 failed`,
- `cargo check -p fullmag-api --bin fullmag-api`: exit 0; wyłącznie pięć wcześniejszych warningów schemas i warningi zależności,
- targeted `rustfmt --check` oraz `git diff --check`: exit 0.

## Drugi fixup po re-review: oracle ważenia slab

Re-review wykazało, że poprzedni test refinement opierał się na jednym Tet4. Taki fixture nie odróżnia poprawnej całki objętościowej od uśredniania po liczbie elementów lub węzłów.

RED wykonano przeciw dotychczasowemu fixture przez jawny wymóg dwóch Tet4: targeted test zakończył się exit 101 z `left: 1`, `right: 2` i komunikatem `refinement oracle requires two unequal-volume Tet4 elements`.

Fixture zastąpiono dwoma rozłącznymi Tet4 o nierównych objętościach `1/6` i `1/3`. Liniowe pole P1 ma średnie elementowe `2.5` i `4.75`, więc błędna średnia po liczbie elementów wynosi `3.625`, a niezależny oracle ważony miarą wynosi `4.0`. Analityczna całkowita zajęta miara wynosi `0.5`.

Test sprawdza wyłącznie `SlabAverage`, niepuste occupancy i parę coarse/refined oraz z tolerancją `1e-10`:

- coarse i refined równe analitycznej średniej `4.0`,
- coarse równe refined,
- `coarse.meta.occupied_measure` i `refined.meta.occupied_measure` równe sobie i analitycznej mierze `0.5`.

Wzmocniony test przeszedł na istniejącym samplerze, dlatego fixup jest test-only i nie zmienia kodu produkcyjnego. Końcowa weryfikacja: targeted `1/1`, pełne `planar_` `46/46`, routes `planar_field_` `6/6`, `cargo check -p fullmag-api --bin fullmag-api`, targeted `rustfmt --check` i `git diff --check` — wszystkie exit 0. `cargo check` nadal raportuje wyłącznie wcześniejsze warningi.
