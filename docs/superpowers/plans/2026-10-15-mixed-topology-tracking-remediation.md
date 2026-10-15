# Uwaga4207786265 — zakres poprawki mixed topology w trackingu modów

Stan odczytany z GitHub: `ce53c62c4757879280a73216e494eeaf450ab361`, branch `codex/eigensolve-dispersion-plan-20260912`. Audyt źródłowy, bez testów i bez wykonania FEM. Uwaga nadal zasadna i niezaimplementowana. Dokument jest wewnętrznym planem korekty, nie nową notą fizyczną ani deklaracją wsparcia.

## Co dokładnie jest nieprawidłowe

[Komentarz](https://github.com/MateuszZelent/fullmag/pull/97#discussion_r4207786265) wskazuje `crates/fullmag-runner/src/fem/eigen_path.rs`, oryginalną linię3447. Bieżąca ścieżka pojedynczej próbki nadal wykonuje:

```rust
let tracking_topology =
    MeshTopology::from_ir(&point_plan.mesh).map_err(|error| RunError {
        message: format!("eigen path tracking mesh topology: {error}"),
    })?;
```

Ta sama zależność występuje w `publish_bias_field_tracking` i przygotowaniu/odtwarzaniu próbki. To nie tylko problem jednej instrukcji: dalsi konsumenci również zakładają tetraedryczną topologię.

## Potwierdzone zależności uniemożliwiające prostą podmianę adaptera

| Właściciel / symbol | Bieżące założenie i konsekwencja |
|---|---|
| `fem/eigen_path.rs::eigen_path_consistent_tracking_metric`, linie554–594 | Iteruje `topology.elements`, tworzy `[0;4]`, mapuje tylko cztery węzły oraz bierze `element_volumes`. Samo dopuszczenie prism6 w konstruktorze nie tworzy poprawnej metryki. |
| `eigen/tracking_mass.rs::ConsistentP1TrackingMetric` | Przechowuje `tetra: Vec<[usize;4]>`, `sqrt_factors`, `volumes_m3`. `new`, `embed`, `recover` są obliczeniami dla tetra P1. |
| `eigen/tracking_mass.rs::artifact_json` i `from_artifact_json` | Persistowany kontrakt to `fullmag.tracking_consistent_p1_metric.v1`, definition `consistent_p1_tet4_cartesian_nodal_envelope.v1`, z kluczami `tetra` i `volumes_m3`. Nie wolno interpretować tego v1 jako prism/mixed. |
| `fem/eigen_reduction.rs::build_reduction_map` | Przyjmuje cały legacy MeshTopology; potrzebuje aktywnych węzłów magnetycznych, węzłów granicznych i par periodycznych. Dotyczy to free/pinned/periodic/Floquet, nie wyłącznie współrzędnych. |
| `fem/eigen_mass_metric.rs::SharedDomainSparseMass::from_topology` | Modalna metryka i jej phase-map również przyjmują legacy MeshTopology. Naprawa samego trackingu nie dowodzi obsługi całego runu mixed mesh. |
| `eigen/types.rs` | Wyniki i obserwable nazywają metodę `consistent_mass_p1_tet4`, a jeden z jawnych wariantów reprezentacji to `ConsistentP1Tet4CartesianNodalEnvelope`. Nie można pozostawić tych nazw dla innej metryki. |

Referencje kodu: [eigen_path.rs](https://github.com/MateuszZelent/fullmag/blob/ce53c62c4757879280a73216e494eeaf450ab361/crates/fullmag-runner/src/fem/eigen_path.rs), [tracking_mass.rs](https://github.com/MateuszZelent/fullmag/blob/ce53c62c4757879280a73216e494eeaf450ab361/crates/fullmag-runner/src/eigen/tracking_mass.rs), [eigen_reduction.rs](https://github.com/MateuszZelent/fullmag/blob/ce53c62c4757879280a73216e494eeaf450ab361/crates/fullmag-runner/src/fem/eigen_reduction.rs), [eigen_mass_metric.rs](https://github.com/MateuszZelent/fullmag/blob/ce53c62c4757879280a73216e494eeaf450ab361/crates/fullmag-runner/src/fem/eigen_mass_metric.rs).

## Obowiązująca granica architektury

`docs/architecture/backend-golden-masterplan.md` zachowuje natywne FEM/MFEM jako właściciela operatorów i zabrania cichego prism-to-tet split w strict mixed P1. `tracking_mass.rs` jawnie określa metrykę jako postprocessing, a nie nowy solver ani certyfikat widma. Te granice trzeba zachować.

Ogólna nota `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md` zawiera ograniczenia frequency-domain/eigen w opisach zakresów poszczególnych mixed lanes. Nie wolno wywnioskować, że każdy wariant mixed obsługiwany przez relaksację jest legalny w każdym wariancie eigensolve. Przy wdrożeniu potrzebne jest dokładne powiązanie konkretnej legalnej lane z aktualną notą modalną/capability matrix; samo usunięcie błędu trackingu nie rozszerza możliwości solvera.

## Kolejność wdrożenia

1. Wyodrębnić minimalny widok topologii trackingu: współrzędne, uporządkowany indeks węzłów magnetycznych, jawne elementy/facety tri3/quad4 i mapy periodyczne. Użyć istniejącego MeshIR i jego fingerprintu; nie generować zastępczego mesh ani zmieniać kolejności węzłów.
2. Zachować historyczną tetra metrykę v1. Dodać jawny kontrakt dla mixed consistent mass, z rodzajem elementu, pochodzeniem wag i jednoznacznym powiązaniem z fizycznymi węzłami. Przed zmianą opracować odpowiednią notę/source-map i decyzję kontraktową. Nie zastępować consistent mass diagonalną normą ani nie udawać tetra metryki.
3. Zdefiniować i sprawdzić poprawne całkowanie kształtów prism6 dla rzeczywistej mapy geometrycznej dopuszczonej przez lane. Porównać z natywną macierzą masową MFEM. Nie stosować wzoru dla afinicznego graniastosłupa do ogólnego zdeformowanego elementu bez dowodu jego zakresu.
4. Przenieść redukcję i boundary-node selection na minimalny widok, zachowując dokładne fazy Floqueta, pary graniczne, pinned DOFs i indeksowanie fizycznego envelope'u. Zaktualizować ścieżki serial, adaptive pool, bias sweep oraz replay/recovery.
5. Prześledzić pozostałe legacy topology consumers w wykonaniu pojedynczego k, w tym shared-domain mass/phase map i accepted equilibrium. Nie ogłaszać wsparcia całej lane po przejściu wyłącznie testu konstruktora trackingu.
6. Wykonać regresje źródeł w GHA: tetra v1 roundtrip bez zmiany wyników; prism6 i mieszane tet4/prism6; quad4 boundary; zgodność indeksowania i faz; niepoprawny Jacobian/fingerprint/replay; serial/pool/bias bez legacy pre-solver failure. Następnie osobna bramka managed FEM z natywną macierzą masową i kilkoma k. Kwalifikacja fizyczna wymaga zgodności i zbieżności, nie tylko braku wyjątku.

## Stan

Nie zastosowano obejścia przez split, diagonalną metrykę, pominięcie trackingu ani ukrycie błędu. Uwaga pozostaje `valid/unfixed`; powyższy zakres ma zapobiec pozornej poprawce jednej linii, która dopuściłaby błędne całkowanie modów. Runtime mixed eigen i naukowa kwalifikacja pozostają NOT VERIFIED.
