# Raport Task 2 — wspólny nośnik `ResolvedSpatialField`

## Wynik

Zaimplementowano backendowo neutralny, wewnętrzny kontrakt `ResolvedSpatialField` i podłączono do niego istniejące zasoby pól bez zmiany publicznych struktur JSON, nagłówków ani formatów FMVP. Kontrakt zachowuje kanoniczne metadane quantity, źródło i dostępne provenance, generację, rewizję konkretnej quantity, rewizję siatki/topologii, wartości `f64`, grid/topologię, mapowanie encji, membership FDM oraz legalny nośnik airboxa.

Commit: `9ce555065` (`feat(api): unify spatial field carrier resolution`).

Planarne route i samplery, UI, OpenAPI oraz publiczny wire nie zostały zmienione.

## Pliki

- `crates/fullmag-api/src/router_v2/handlers/data/resolved_spatial_field.rs` — nowy kontrakt, walidacja carrierów i osiem testów kontraktowych;
- `crates/fullmag-api/src/router_v2/handlers/data.rs` — rejestracja modułu;
- `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs` — delegacja compact/full FEM do jednego resolvera przy zachowaniu pełnodomenowego kontraktu obecnego planar adaptera;
- `crates/fullmag-api/src/router_v2/handlers/data/resolved_vector_field.rs` — wspólne mapowanie globalnych węzłów FEM dla analiz;
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs` — current fields, FEM scope, FDM object scope oraz airbox catalog/meta/vector przechodzą przez nowy kontrakt.

## Decyzje

- `SpatialFieldCarrier` jest enumem: `FdmCells`, `FemNodes`, `FemElements`, `ArtifactLinear`, `FdmAirboxCells`; full i compact FEM rozróżnia `EntityMapping::Identity` albo `ExplicitLocalToGlobal`, natomiast `ArtifactLinear` jest ograniczonym nośnikiem identity dla persisted/transport bez deklarowania geometrii FEM/FDM.
- Wartości pozostają `Vec<f64>`, ponieważ jest to istniejąca precyzja po stronie API; adapter nie wykonuje dodatkowej konwersji.
- FDM object scope wybiera wyłącznie komórki przypisane do żądanego obiektu. Wieloobiektowy membership oparty tylko na domyślnym ID `0` kończy się `409`, bez rozszerzenia do całej domeny.
- Airbox zachowuje quantity identity z walidowanego carrieru; inna quantity nie może użyć tego nośnika.
- Airbox catalog/meta/vector używa `field_quantity_revision`, nie globalnego `field_samples_revision`; publiczna nazwa pola/nagłówka pozostaje bez zmian.
- Istniejący priorytet źródeł topological-charge pozostaje bez zmian i nadal wyklucza preview.

## RED

Komenda:

```text
env CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/viewport2d-task2 CARGO_INCREMENTAL=0 cargo test -p fullmag-api resolved_spatial_field::tests:: --no-run
```

Wynik: exit `101`. Po poprawieniu wyłącznie błędu konstrukcji fixture (`FemFacetConnectivityIR::empty()`), kompilator zgłosił `E0432` dla brakujących symboli nowego kontraktu: `ResolvedSpatialField`, `SpatialFieldCarrier`, `SpatialFieldSourceKind`, `EntityMapping`, `FdmCellMembership`, `resolve_fem_node_mapping`, `resolve_fdm_object_indices` i `resolve_quantity_revision`.

## GREEN

Wszystkie komendy używały:

```text
CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/viewport2d-task2
CARGO_INCREMENTAL=0
```

- `cargo test -p fullmag-api resolved_spatial_field::tests:: --quiet` — aktualnie `8 passed; 0 failed`;
- `cargo test -p fullmag-api compact_magnetic_field_scope_keeps_global_nodes_and_uses_compact_offsets --quiet` — `1 passed; 0 failed`;
- `cargo test -p fullmag-api resolved_vector_field::tests:: --quiet` — `2 passed; 0 failed`;
- `cargo test -p fullmag-api fdm_field_vector_object_scope_uses_membership_cell_ordinals --quiet` — `1 passed; 0 failed`;
- `cargo test -p fullmag-api fdm_multilayer_airbox_field_catalog_meta_and_vector_use_target_carrier --quiet` — `1 passed; 0 failed`;
- `cargo test -p fullmag-api v2_field_vector_accepts_fem_live_magnetization_on_magnetic_nodes --quiet` — `1 passed; 0 failed`;
- `cargo test -p fullmag-api v2_field_vector_normalizes_unset_fem_grid_without_losing_topology_identity --quiet` — exit `0`, `1 passed; 0 failed` (końcowy ogon narzędzia został przycięty, kod wyjścia był zerowy);
- `git diff --check` — bez błędów.

Testy kompilowały się z istniejącymi ostrzeżeniami w `fullmag-engine`, `fullmag-runner` i `schemas/decimal_u64.rs`. Nowy adapter nie pozostawia własnego ostrzeżenia `dead_code` ani jego maskowania.

## Publiczny wire

Nie zmieniono schematów, OpenAPI, route paths, struktur `FieldCatalog`/`FieldMeta`, serializatorów FMVP v2/v3 ani zestawu nagłówków. Regresje obejmują publiczne ścieżki FDM object, multilayer airbox catalog/meta/vector, compact FEM i full FEM topology identity. Jedyna zamierzona zmiana wartości to poprawne użycie rewizji konkretnej quantity dla airboxa w istniejącym polu `field_revision`.

## Ograniczenia i kwalifikacja

- Planar sampling celowo nie korzysta jeszcze z `ResolvedSpatialField`; to zakres Task 3.
- Nie wykonano browser smoke ani interaktywnej weryfikacji WebGL.
- Nie wykonano managed-runtime ani fizycznej/produkcyjnej kwalifikacji solvera; Task 2 zmienia wyłącznie wewnętrzny kontrakt API i jego testy.
- Podczas pracy system plików był początkowo pełny. Niczego nie usunięto; po zewnętrznym zwolnieniu miejsca testy wykonano w dedykowanym target-dir. Końcowy zapas wynosił około 15 GiB.

## Poprawki po review

- usunięto martwy `resolve_quantity_revision`; wszystkie ścieżki używają rewizji konkretnej quantity ze źródła;
- manifest Airbox zawiera dokładne `quantity_revision` i content-addressed `field_generation`, a provenance jest odczytywane wyłącznie z walidowanego `source_runtime_identity` (`device` pozostaje `None`, gdy źródło go nie podało);
- catalog/meta/vector Airbox zachowują tę samą rewizję i generację nawet przy nowszym, niepowiązanym stanie bieżącej sesji; ETag pozostaje stabilny;
- catalog/meta/vector zachowują jedną instancję `ResolvedSpatialField` przez values, mapping, carrier, scope, revision i provenance; current, transport oraz persisted snapshot korzystają ze wspólnej factory;
- cardinality FEM zależy od `QuantityLocation`; `FemElements` jest osiągalny przez produkcyjny `resolve_current_spatial_field`;
- wieloobiektowy membership mieszający `0` z numerycznymi ID kończy się konfliktem zarówno w teście jednostkowym, jak i przez publiczną trasę;
- oba warianty structured-grid odrzucają niefinity origin oraz niefinity/niedodatni spacing;
- Airbox availability, quantity i unit pochodzą z walidowanego manifestu/carriera, bez nowej jednorazowej logiki `H_demag`; dotychczasowy publiczny błąd `H_eff` pozostaje zachowany.

Dodatkowa weryfikacja po review: carrier `8/8`, `FemElements` `1/1`, Airbox route `1/1`, FDM exact-object `1/1`, mixed-membership route `1/1`, compact FEM `1/1`, obie publiczne regresje FEM `1/1`, runner manifest emitter `1/1`, `cargo check -p fullmag-api` exit `0`, `git diff --check` bez błędów. Ostrzeżenia są wcześniejsze i nie pochodzą z Task 2.

## Poprawki po ponownym review

- publiczne `domain_generation_id` w katalogu, meta, nagłówkach FMVP oraz FMMI pochodzi wyłącznie z `domain_generation_id(snapshot)`; `field_generation` pozostaje wewnętrznym identyfikatorem walidacji źródła;
- manifest Airbox publikuje content-addressed `grid_revision` i `carrier_revision`; loader sprawdza je względem kanonicznego JSON siatki i fingerprintu SHA-256, a FMVP v3/ETag używa dokładnej rewizji carriera;
- preview carrier pobiera `quantity_revision` wyłącznie z `field_quantity_revisions[quantity]`, niezależnie od `source_revision`, globalnego `field_samples_revision` i rewizji żądania/config;
- katalog Airbox reklamuje quantity wskazaną przez zwalidowany manifest oraz jej `quantity_spec`; nie zawiera specjalnej gałęzi publikującej literalne `H_demag`, a odmowa `H_eff` nadal wynika z availability manifestu;
- catalog/meta/vector transport używają jednego `resolve_transport_spatial_field`, który zwraca kompletny `ResolvedSpatialField`; route nie składa już równoległych krotek wartości/revision/grid.

Weryfikacja po ponownym review: preview exact-revision `1/1`, Airbox catalog/meta/vector wraz z exact FMVP topology revision `1/1`, carrier contract `8/8`, runner content-revision `1/1`, runner manifest emitter `1/1`, `cargo check -p fullmag-api` exit `0`. Zmiany po review pozostają celowo niestage'owane i niecommitowane.

## Poprawki po trzecim review

- canonical transport artifacts nie są już interpretowane przez niespokrewnioną bieżącą siatkę FDM ani topologię FEM sesji; ograniczony do persisted/transport wariant `ArtifactLinear` zachowuje artifact identity, quantity domain, dokładny grid, identity point count i rewizję artefaktu, bez deklarowania geometrii FEM/FDM;
- transportowy katalog, meta i vector korzystają z tej samej instancji `ResolvedSpatialField`; regresja obejmuje scalar `V_electric`, vector `J_charge` i tensor `spin_current_tensor`, ich dokładne rewizje, wartości, ETag oraz deskryptory katalogu;
- Airbox meta/vector przekazują `Some(ResolvedSpatialField)` do scope resolution; scope, grid i topology hash są odczytywane wyłącznie z `SpatialFieldCarrier::FdmAirboxCells`. Loader pozostaje wejściem konstruktora i walidatorem availability, ale nie jest równoległym nośnikiem resource consumption.

RED: `v2_field_data_plane_reads_canonical_transport_field_artifacts` zwracał dla `V_electric` status `409` zamiast `200`.

GREEN po trzecim review: oba transportowe testy publicznego data plane `2/2`, bezpośrednia regresja Airbox scope-from-resolved-carrier `1/1`, Airbox catalog/meta/vector `1/1`, resolver contract `8/8`, preview exact-revision `1/1`. Końcowe `cargo check`, format i diff-check opisano w końcowym handoffie. Zmiany nadal pozostają niestage'owane i niecommitowane.

## Poprawka provenance po finalnym review

`ArtifactLinear` pobiera provenance wyłącznie z opcjonalnego `artifact.provenance`. Obecny format writera (`execution_engine` i `precision` jako stringi) jest akceptowany; `device` jest ustawiane tylko przy jawnym, niepustym stringu w artefakcie. Brak całego obiektu daje `backend=None`, `device=None`, `precision=None` niezależnie od wypełnionego provenance bieżącej sesji. Obecny, lecz błędnie typowany lub niekompletny obiekt provenance kończy się błędem, bez fallbacku do snapshotu.

Regresja `transport_carrier_provenance_comes_only_from_artifact` sprawdza provenance artefaktu celowo różne od sesji, brak provenance przy wypełnionej sesji oraz fail-closed dla błędnego typu. Test przeszedł `1/1`; końcowy handoff zawiera pełną ponowną weryfikację transportu, resolvera, kompilacji, diff i formatowania.
