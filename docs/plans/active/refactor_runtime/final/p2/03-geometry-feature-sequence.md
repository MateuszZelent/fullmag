# P2-B — sekwencja cech geometrii i lineage CSG

Data: 21.09.2026. Zakres: mały slice P2-B dla istniejącego
`SceneDocument`; bez uruchamiania meshera i bez zmiany realizacji FDM/FEM.

## Zmiana

`crates/fullmag-authoring/src/geometry_features.rs` dodaje jawny,
backend-neutralny widok `GeometryFeatureSequence` dla istniejących obiektów
sceny. Każdy węzeł ma stabilny identyfikator wyprowadzony z
`object_id` i ścieżki autora, zachowuje oryginalne parametry JSON oraz listę
`input_feature_ids`. Dzieci `Difference`, `Csg`, `Union`, `Intersection` i
`Translate` są rozwijane w kolejności źródłowej, więc split/merge nie tracą
lineage wejść. Transform obiektu jest końcową, osobną cechą z własną ścieżką;
rotacja, skala, przesunięcie i pivot nie są ukrywane w anonimowym meshu.

Sekwencja ma własną listę diagnostyk. Brak obiektu albo pusty typ geometrii
kończy się jawnym błędem blokującym realizację; nieobsługiwany węzeł nie jest
cicho usuwany. Funkcja jest opisowa i nie buduje siatki.

Ten sam moduł udostępnia `GeometrySelectionLineage` oraz
`classify_geometry_selection_lineage`. Pusty wynik ma status `empty`, jeden
kandydat z jednym źródłem ma status `resolved`, a split, merge lub wiele
kandydatów ma status `ambiguous` i blokującą diagnostykę do czasu jawnego
policy/repair. Zbiór ID jest sortowany i deduplikowany, więc kolejność
transportu nie wybiera przypadkowo powierzchni.

`region_revisions.rs` rozróżnia teraz zmianę geometrii/transformacji od samej
polityki mesha. Zmiana zajętej domeny podnosi osobno `topology`, `membership`,
`coefficients` i `initial_state`; sama zmiana recipe mesha podnosi tylko
`topology`. Dzięki temu precondition dla starej maski lub materiału nie może
pozostać pozornie aktualny po przesunięciu bryły.

## Kryteria i dowody

| Kryterium | Dowód | Wynik |
|---|---|---|
| Stabilne ID i ścieżki niezależne od kolejności obiektów | test `feature_ids_and_paths_are_stable_for_nested_csg` | źródło testu dodane; test Rust nie był uruchamiany zgodnie z bieżącą polityką buildów |
| Lineage wejść CSG jest jawny i uporządkowany | `input_feature_ids` dla `base`/`tool` | sprawdzone przez kontrakt typów i test źródłowy |
| Transform jest osobną cechą | test `transform_is_explicit_and_preserves_rotation_and_scale` | źródło testu dodane; test Rust nie był uruchamiany |
| Błąd braku obiektu/pustego typu blokuje dalsze użycie | diagnostyki `GEOMETRY_OBJECT_NOT_FOUND` i `GEOMETRY_FEATURE_KIND_EMPTY` | sprawdzone przez kontrakt typów i test źródłowy |
| Split/merge nie wybiera kandydata po cichu | `GeometrySelectionLineage` + `GEOMETRY_SELECTION_AMBIGUOUS` | sprawdzone przez kontrakt typów i test źródłowy |
| Geometria i transformacja nie zostawiają starych masek | `classify_region_realization_impact` + testy niezależnych rewizji | biblioteka przechodzi `cargo check`; test Rust nie był uruchamiany |
| Kod kompiluje się jako biblioteka authoringu | `cargo check --locked -p fullmag-authoring --lib` | PASS |
| Formatowanie | `rustfmt --edition 2021 --check` | PASS po formatowaniu |

## Granica odbioru

Wynik: **P2-B feature/lineage/invalidation slice IN PROGRESS**. Nie ma jeszcze
certyfikatu topologii, ewaluatora selekcji po split/merge, repair command,
ambiguous-selection resource ani integracji lineage z producerem mesha.
`GeometryFeatureSequence` nie jest jeszcze osobnym endpointem OpenAPI; obecny
przyrost przygotowuje wspólny kontrakt dla kolejnego adaptera bez udawania
kwalifikacji meshingu.
