# I1 — review integracji rekonstrukcji modów i map periodycznych

28.10.2026. Wewnętrzna decyzja integracyjna, nie nowa nota fizyczna ani kwalifikacja solvera. Właścicielem fizyki pozostaje [nota 0600](../physics/0600-fem-eigenmodes-linearized-llg.md).

## Decyzja

Trzy krytyczne fragmenty WIP wskazane przez audyt 26.10 są już przeniesione w commicie `b152b0e63359c4f9664ff352a4556a68bca811ec`. Porównano pełne ciała funkcji z zachowaną kopią WIP ze źródła `9063e52cbdeb5d805bd23da7703ea7c582548fc8`: są identyczne po normalizacji CRLF. Przed porównaniem potwierdzono SHA-256 obu zachowanych plików względem manifestu zabezpieczenia. Nie kopiowano ponownie plików i nie modyfikowano równań solvera.

| Fragment | Sprawdzenie konsumenta i kontraktu | Decyzja |
|---|---|---|
| `eigen_projection.rs::project_complex_mode_to_tangent_basis` | Zespolono-liniowe rozszerzenie istniejącej skalarnej konwencji zachowuje obie kwadratury i globalną fazę. `eigen_execution.rs::execute_fem_eigen_inner_with_potential_publication` wybiera je wyłącznie dla skalarnego complex reference, a dla Full2x2 wybiera osobną projekcję dwuskładową. Skalarnej reprezentacji nie przypisano fizycznej eliptyczności Full2x2 | Obecny odpowiednik, ciało identyczne z WIP |
| `eigen_projection.rs::expand_reference_mode_to_periodic_nodes` | Przed zapisem reference artifacts odtwarza pełny węzłowy mod z dokładnej fazy klasy, nie nadpisuje korzenia, waliduje mapę/zakres/długości/fazę. Zachowuje węzły niemagnetyczne. Native ma wcześniejszy return i własną projekcję; nie jest rozwijany dwukrotnie | Obecny odpowiednik, ciało identyczne z WIP |
| `eigen_reduction.rs::validate_materialized_tangent_frame_transport` | `eigen_execution.rs::execute_fem_eigen_inner_with_potential_publication` uruchamia guard po materializacji rzeczywistej równowagi, przed redukcją. `eigen_equilibrium.rs::materialize_equilibrium` również stosuje guard. Full2x2 dopuszcza obrót lokalnych baz przy zgodnym fizycznym m0; scalar zachowuje ograniczenie transportu. Nie dopuszcza to dowolnego obrotowego PBC | Obecny odpowiednik, ciało identyczne z WIP |

Natywny konsument: `eigen_native_artifacts.rs::native_modal_artifacts_with_selection_binding` wywołuje `project_complex_2x2_mode_to_tangent_basis_with_periodic_map`, która transportuje dwie składowe przez lokalne bazy i fazę Blocha na pełnej siatce. Jest to inna realizacja niż skalarna projekcja reference. `eigen_native_result.rs::native_poisson_airbox_mode_from_payload` waliduje rozmiar q, przestawia układ interleaved do block-order i przy shared-domain rozwija klasy magnetyczne na aktywne węzły przed publikacją. Cicha ścieżka zerowa przy błędnym wymiarze w helperze projekcji nie jest dowodem wystąpienia błędu w runtime; w sprawdzonym producencie rozmiar jest wcześniej kontrolowany. Nie zmieniono kontraktu helpera bez wykazania niepoprawnego wejścia.

## Zakres dowodów według realizacji

| Realizacja | Zakres tego review |
|---|---|
| FDM CPU | Nie dotyczy trzech sprawdzanych fragmentów FEM |
| FDM GPU | Nie dotyczy; bez twierdzenia o równoważności backendów |
| FEM CPU | Źródłowo potwierdzona ścieżka reference i oddzielny native publisher. Rzeczywisty benchmark signed15 korzystał z native Full2x2; nie kwalifikuje sam skalarnego reference |
| FEM GPU | Wspólne fragmenty publikacji nie dowodzą wykonania GPU. Runtime i polaryzacja GPU pozostają NOT VERIFIED |

## Regresje i pozostałe bramki

Pięć testów `eigen_projection.rs::scalar_projection_tests` obejmuje zgodność real/complex, globalną fazę, signed Bloch, obrót baz i odrzucanie błędnych map. Dwa `materialized_full2x2_guard_` obejmują rotację lokalnego chartu przy zgodnym m0 oraz odrzucenie rzeczywistej nieciągłości. Dwa `reference_mode_publication_` przechodzą przez publikację, a nie tylko helper, w tym k=0 i obie strony niezerowego k.

Uruchomiono pełny default-feature runner CI [40611719529](https://github.com/MateuszZelent/fullmag/actions/runs/40611719529) dla aktualnego e805d0774. Wynik: SUCCESS, 1821 passed, 0 failed, 1 ignored. Odczytano log joba 122564583507: wszystkie dziewięć powyższych regresji zostało wykonanych i ma wynik ok. Pełne nazwy i SHA-256 logu zapisano w sąsiednim evidence JSON. Ignorowany test nie został policzony jako wykonany; gate default-feature nie kwalifikuje runtime natywnych bibliotek ani GPU. Testów Rust nie kompilowano lokalnie.

To zamyka źródłowe review trzech wskazanych WIP, nie całe I1/I6. Inwentarz nadal obejmuje 388 historycznych commitów i 40 zachowanych plików WIP. Ich pozostałych fragmentów nie oznaczono jako przejrzanych. Master/PR, kwalifikacja naukowa, aktualny runtime i końcowy strict po imporcie pozostają otwarte. Docker nadal nie odpowiada; jego restart nie był wykonywany.

## Dodatkowy odbiór zapisu checkpointu

Jedyny test ignored w domyślnym runnerze to `fem::single_k_checkpoint::tests::checkpoint_inspector_accepts_actual_persisted_manifest`; wymaga jawnego interpretera Pythona. Główny bootstrap uruchamia go już osobno. Dedykowany workflow eigensolve otrzymał tę samą operację z FULLMAG_CHECKPOINT_INSPECTOR_PYTHON=python3, selekcją exact/ignored i asercją dokładnie jednego zaliczonego testu. Nie zmieniono atrybutu ignore ani fixture'u. Test zapisuje rzeczywisty manifest, uruchamia jego inspektor i wymaga integrity=PASS przy scientific_qualification=NOT VERIFIED. Nowy krok wymaga jeszcze CI; poprzednie 1821 PASS nie zastępuje tego odbioru.
