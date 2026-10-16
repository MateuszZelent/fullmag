# Uwaga4207786265 — zakres poprawki mixed topology w trackingu modów

Aktualizacja 16.10.2026: źródła `152ad2e1fe7830536bd195db73c396f9f6ac5121`, branch `codex/eigensolve-dispersion-plan-20260912`. Wcześniejszy audyt zależności legacy opierał się na `ce53c62c4757879280a73216e494eeaf450ab361`. Korekta zakresu: aktualny publiczny planner **odrzuca mixed Eigen przed wykonaniem solvera**. Legacy tracking pozostaje tetraedryczny; jego rozszerzenie jest przyszłym zadaniem, a nie dowiedzioną awarią obecnie legalnej mixed modal lane. Dokument nie rozszerza wsparcia FEM.

## Aktualna bramka publicznego planowania

`plan_fem_eigen` wywołuje `reject_unsupported_mixed_topology` przed utworzeniem `FemEigenPlanIR`. `validate_mixed_p1_execution_scope` odrzuca Eigen z `fem_mixed_p1_scope_rejected` i `unsupported_study`. Nie wynika to wyłącznie z dokumentacji: sprawdzono rzeczywistą ścieżkę plannera.

Regresja `fem_eigen_public_planner_rejects_certified_mixed_mesh` z commita `152ad2e1` wywołuje publiczne `plan(&ir)` dla prawidłowego wejścia Eigen Single Γ oraz certyfikowanego zasobu Prism6/Quad4 i wymaga obu powodów odmowy. Zachowano dwa dotychczasowe testy helpera. [GitHub Actions 38894082903](https://github.com/MateuszZelent/fullmag/actions/runs/38894082903) zakończyło się **SUCCESS** dla dokładnego SHA; testy projektu wykonano wyłącznie w GHA. Test Γ nie jest dowodem uruchomienia mixed path, serial/adaptive pool ani solvera natywnego.

Źródła: [fem.rs](https://github.com/MateuszZelent/fullmag/blob/152ad2e1fe7830536bd195db73c396f9f6ac5121/crates/fullmag-plan/src/fem.rs#L5854), [mesh.rs](https://github.com/MateuszZelent/fullmag/blob/152ad2e1fe7830536bd195db73c396f9f6ac5121/crates/fullmag-plan/src/mesh.rs#L1621), [publiczny regression check](https://github.com/MateuszZelent/fullmag/blob/152ad2e1fe7830536bd195db73c396f9f6ac5121/crates/fullmag-plan/src/tests.rs).

Ręczne skonstruowanie lub przyjęcie `FemEigenPlanIR` poza publicznym plannerem nie jest dowodem legalności lane; sam native window enable nie stanowi niezależnej bramki topologii. Nie znosimy obecnych odmów ani nie zmieniamy historycznej metryki.

## Zależność legacy, która blokuje przyszłe rozszerzenie

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

## Kolejność ewentualnego przyszłego rozszerzenia mixed modal

1. Wyodrębnić minimalny widok topologii trackingu: współrzędne, uporządkowany indeks węzłów magnetycznych, jawne elementy/facety tri3/quad4 i mapy periodyczne. Użyć istniejącego MeshIR i jego fingerprintu; nie generować zastępczego mesh ani zmieniać kolejności węzłów.
2. Zachować historyczną tetra metrykę v1. Dodać jawny kontrakt dla mixed consistent mass, z rodzajem elementu, pochodzeniem wag i jednoznacznym powiązaniem z fizycznymi węzłami. Przed zmianą opracować odpowiednią notę/source-map i decyzję kontraktową. Nie zastępować consistent mass diagonalną normą ani nie udawać tetra metryki.
3. Zdefiniować natywny eksport geometrycznej consistent mass MFEM ograniczonej do domen magnetycznych, z pełną CSR oraz kanoniczną mapą węzłów fizycznych i tożsamością siatki. Z obecnego `volume_mass_form` zachowywane są tylko sumy wierszy jako masa skupiona; pełna macierz jest odrzucana. Nie utożsamiać go z `consistent_mass_matrix` ważoną Ms. Sam wybór podmacierzy węzłów fizycznych z macierzy całej domeny nie usuwa wkładu airboxu we wspólnych węzłach. Zachować kompletne cell markers; brak markerów nie jest dowodem zakresu magnetycznego. Całkowanie i operator należą do native MFEM, bez drugiego assemblera prism6 w Rust. Porównanie i testy muszą obejmować rzeczywistą mapę geometryczną dopuszczoną przez przyszłą lane.
4. Przenieść redukcję i boundary-node selection na minimalny widok, zachowując dokładne fazy Floqueta, pary graniczne, pinned DOFs i indeksowanie fizycznego envelope'u. Zaktualizować ścieżki serial, adaptive pool, bias sweep oraz replay/recovery.
5. Prześledzić pozostałe legacy topology consumers w wykonaniu pojedynczego k, w tym shared-domain mass/phase map i accepted equilibrium. Nie ogłaszać wsparcia całej lane po przejściu wyłącznie testu konstruktora trackingu.
6. Wykonać regresje źródeł w GHA: tetra v1 roundtrip bez zmiany wyników; prism6 i mieszane tet4/prism6; quad4 boundary; zgodność indeksowania i faz; niepoprawny Jacobian/fingerprint/replay; serial/pool/bias bez legacy pre-solver failure. Następnie osobna bramka managed FEM z natywną macierzą masową i kilkoma k. Kwalifikacja fizyczna wymaga zgodności i zbieżności, nie tylko braku wyjątku.

## Stan

Obecna odmowa mixed Eigen jest `source_guarded_ci_verified`; uwagi 4207786265 i 4251262086 należy rozpatrywać z tym samym zakresem legalności. Nie zastosowano splitu, diagonalnej metryki ani pominięcia trackingu. Wcześniejsze określenie „aktualna legalna mixed k-path jest zepsuta” nie było poparte publicznym plannerem i zostało skorygowane. Rozszerzenie tracking v2 i mixed modal **nie jest zaimplementowane ani zakwalifikowane**. Runtime FEM/GPU i kwalifikacja naukowa pozostają NOT VERIFIED.
