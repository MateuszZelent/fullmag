# P0 — audyt kompletności etapu

Data: 20.09.2026. Podstawa: sześć pakietów P0 z `../03-plan-refaktoryzacji.md`, bieżące źródła na `masterze` i receipty wskazane w `05-minimal-gate.md`. Minimalna bramka przejścia do P1 jest zaliczona; poniższa tabela nie zastępuje brakujących dowodów pełnego etapu.

| Wymaganie planu | Dowód | Ocena |
|---|---|---|
| P0-A: przypięte materiały, endpoint/metoda/handler/konsument, entry points i lane’y | `inventory.json`, `01-inventory.md`, skrypt `audit_refactor_p0.py`; historyczny snapshot zakresu P0, późniejszy owner application opisany w `../p1/README.md` | Inwentarz istnieje. Nie jest dowodem zachowania API. |
| P0-B: GC preview, świeży graf pod blokadą, ochrona pinów i nieznanego/uszkodzonego stanu | `gc_preview_never_deletes_and_apply_rejects_a_stale_plan` rozpoznaje syntetyczny orphan, odrzuca stary plan, usuwa wyłącznie orphan po świeżym planie i zachowuje pin; regresje recovery oraz CAS roots | PASS w ograniczonym runie session na Windows; dane użytkownika nie były używane. |
| P0-B: materialny primary/aux capture i archive roundtrip restart payload | `p0_archive.rs`: rzeczywiste bajty pól, deskryptory/chunks, integrator/RNG/backend, zgodność common state | PASS na syntetycznych danych. Nie dowodzi fizyki ani ExactResume dowolnego runtime. |
| P0-C: staging/state przed markerem, lock i jawne gwarancje durability | Unit/integration regressions: awarie przed i po rename, poprzednie generacje CURRENT, drugi writer, obcy unlock, śmierć procesu; `04-storage-protocol.md` | PASS minimalnego kontraktu lokalnego Windows. Power loss i inne platformy nadal niekwalifikowane; plan wymaga jawnego rozróżnienia tych dowodów. |
| P0-D: FDM CPU authority, ADR-0009/0025, oddzielenie build storage i CAE Project | ADR-0032 oraz scoped zmiany ADR-0009/0025/0030, backend masterplan i API spec | Decyzje zapisane przed P1. Nie zmieniają wyboru urządzenia ani silnika. |
| P0-D: zgodność reporting capabilities FEM/FK z planner/native | W `fullmag-runner/src/capabilities.rs` profil time-domain CPU/GPU zawiera istniejącą wartość `fredkin_koehler`; profile eigen/frequency korzystają z oddzielnej bazy Poisson. `just verify-fem-mixed-p1-capability-contract` przeszedł: walidacja macierzy, 9 testów Python i 24 testy capability runnera. | Korekta źródłowa i regresja wykonane; API runtime **NOT VERIFIED**. Nie zmieniono kwalifikacji naukowej, schematu OpenAPI ani wyboru urządzenia. |
| P0-E: zachowane fixtures/receipts, tożsamość i progi przed pomiarem | `02-baseline.md` i `02-baseline-manifest.json`; brak pomiarów pozostaje NOT_RUN, brak uzgodnionego progu pozostaje THRESHOLD_NOT_SET | Materiały zachowane; nie ma bieżącego baseline’u wydajności. Historyczna polityka read-only w tych plikach opisuje moment inwentaryzacji, a nie późniejszą zgodę na P0 tests. |
| P0-F: identyfikatory z treści, ZIP paths, containment przed zapisem | manifest ID fixtures, portable names, traversal, nonempty destination, Windows junction; `repository_path.rs` używany przez writery i eksport | PASS minimalnego kontraktu zaufanego rootu. Nie deklaruje odporności na wrogi proces równocześnie zmieniający składniki ścieżki. |

## Wniosek dla aktywnego celu

Bieżący odczyt `audit_refactor_p0.py --check`: 300 operacji OpenAPI, 300 rozpoznanych handlerów, 0 nierozpoznanych handlerów, 0 nierozpoznanych konsumentów, 2 router-only i 0 OpenAPI-only. Inventory zostało zregenerowane po dodaniu endpointów projektu oraz korekcie rozpoznawania zagnieżdżonych modułów Rust; wpis `POST /v2/sessions` ma źródło `crates/fullmag-api/src/router_v2/handlers/sessions/create.rs:28`. Ponowny odczyt 18 plików wejściowych potwierdził wszystkie zadeklarowane SHA-256. Kontrola nie uruchamiała aplikacji.

Nie oznaczamy całego P0 jako zakończonego wyłącznie dlatego, że przeszło 70 testów. Wynik wystarczył do rozpoczęcia niepublikującej danych warstwy P1-A. Wymóg P0-D dotyczący reporting capabilities ma korektę źródłową i zieloną regresję; pozostaje osobna weryfikacja API runtime oraz kwalifikacja naukowa. Pełna kwalifikacja P1 jest oddzielna: application use cases i dyskowy adapter mają już lokalne testy, ale nie ma jeszcze pełnego API/UI/browser proof.

Użytkownik udzielił zgody na testy P1. Wykonano test application, kontrakt capability FEM/FK i ukierunkowany Vitest; nie uruchamiano pełnych testów solverów ani operacji GC na danych użytkownika.

Rewalidacja po korekcie P1-C obejmuje także bieżący kontrakt routera projektu: `cargo test --locked -p fullmag-api project_document_transport --offline` — **2 passed, 0 failed**. Test potwierdza create/open bez mutacji runtime oraz odmowę niepoprawnego Base64. Nie zmienia to oceny P0-C/E: power-loss i bieżące pomiary baseline pozostają `NOT VERIFIED`/`NOT_RUN`.

## Korekta raportowania FEM/FK

Źródła potwierdzone w przeglądzie: `crates/fullmag-ir/src/plan.rs`, mapowanie w `crates/fullmag-plan/src/fem.rs`, CPU `backends/fem/cpu/mfem/interactions/demag.cpp` i GPU `backends/fem/gpu/cuda/demag_fem_bem/fem_bem.cpp`. Wrapper `capabilities_for_fem_engine` dodaje istniejącą wartość realizacji; eigen/frequency używają `base_capabilities_for_fem_engine`, więc nie dziedziczą tego rozszerzenia. API zachowuje ogólne `interaction.demag`; nie dodano nowej operacji, typu ani pola.

Jest to lista dostępnych gałęzi źródłowych profilu, nie gwarancja uruchomienia na dowolnej siatce. Nadal obowiązują ograniczenia planera i dispatchu, requested/resolved provenance oraz odmowa niedostępnego wymuszonego GPU. Kwalifikacja CPU i GPU jest oddzielna. `just verify-fem-mixed-p1-capability-contract` wykonał walidację macierzy, **9 testów Python i 24 testy capability runnera**, wszystkie zakończone powodzeniem. Ten dowód nadal nie obejmuje API runtime, wykonania solvera ani kwalifikacji naukowej.
