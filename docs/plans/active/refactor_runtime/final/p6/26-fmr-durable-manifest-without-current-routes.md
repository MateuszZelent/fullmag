# P6-A — manifest FMR bez odnośników do aktywnej sesji

Data: 30.09.2026

Status: **SOURCE PARSE PASS / MANAGED BUILD PASS / COMMIT + PUSH PASS / TESTS NOT RUN / RUNTIME NOT VERIFIED**.

## Zmiana

Nowy writer FMR z dokładną tożsamością sesji/run/stage/runtime publikuje
manifest oparty na właścicielu i ścieżkach artefaktów. Jego sekcja `resources`
nie przechowuje `/v2/sessions/current`: opcjonalne klucze są `null`, listy
transportowe są puste. Kształt manifestu v1 nie zmienia się. Stare wywołania
bez identity zachowują dotychczasowe odnośniki legacy.

Pozostają ścieżki sweepu, diagnostyki, postępu, marker przerwania i lista
zapisanych punktów. Rozszerzono przypadek regresyjny kompletnego i przerwanego
sweepu o brak mutable URL oraz zachowanie ścieżki sweepu i liczby punktów.

## Konsumenci i dowody

- Parser Rust i scoped `git diff --check`: **PASS**.
- Testy jednostkowe: **NOT RUN** zgodnie z tymczasowym zakazem w `AGENTS.md`.
- `frequencyDomainChartModels.ts` określa dostępność sweepu przez ścieżki
  `artifacts.response_sweep_v1_path`/`v2`; adapter pola przyjmuje obiekty
  `{frequency_index, field_resource_id, payload_path}`, a nie wcześniejsze
  same stringi URL writera referencyjnego.
- `frequency_domain.rs` ma jawne ścieżki odczytu pola z manifestu, sweepu
  i metadanych punktu. Sam odczyt źródeł nie zastępuje dowodu API/runtime.
- Nie zmieniono DTO ani endpointów API; nie ma zmiany kształtu wymagającej
  regeneracji OpenAPI/klienta. Nie zmieniono frontendu.
- Build snapshotu: job `9eb85e72e82048f2b7e0558b86d66014`,
  profil `fem-cpu-release`, digest
  `68964b72f39216f17e624dc674f9ab311dfddfc0cba5bfdcb80f046cd04e6286`.
  Receipt w logu odpowiada jobowi, profilowi i digestowi: state=succeeded,
  112 wpisów artefaktów; native-build, frontend-dependencies i frontend-build
  mają exit 0. Kontener wykonawcy zakończył pracę z exit 0 o 10:19:36 UTC.
  Odczyt przez zgodny klient potwierdził terminalny
  **succeeded / exit 0** z tym samym digestem. Aktywna lista kolejki nie
  zawiera tego joba. Koordynator zakończył kontrolę receipt i kapsuły źródeł.

## Integracja i dalszy zakres

Poprzedni przyrost runner context jest na `master` i `origin/master` jako
`334a42969d0e224eb5026803b838c9aa7b7b7a41`. Jego managed build ma terminalny
sukces, trzy etapy z exit 0 i receipt z 112 wpisami artefaktów.

Etapy kompilacji i finalizacja kolejki zakończyły się poprawnie.
Nie zaliczono runtime ani kwalifikacji. Zachować
dwie zastane linie `rotated_interfacial_dmi: None` i pozostałe cudze zmiany.
Nie usuwano cache, snapshotów ani wyników.

Po restarcie koordynatora stary klient zgłosił `Container profile allow-list mismatch`.
Dostęp odzyskano przez istniejącego, wersjonowanego klienta w worktree
`C:\git\fullmag\worktrees\eigensolve-dispersion-plan-20260912` (commit
`f60fc7e3f796bd434dcae90cd4cd428dd451624d`). Rozpoznaje on wdrożony profil
`fem-cpu-slepc-runtime-v2`. Użyto go z jawnym `--worktree C:\git\fullmag\fullmag`
bez zmiany konfiguracji lub profilu żądanego buildu. Health potwierdził
worker_alive=true, accepting_jobs=true, worker_error=null, stop_requested=false.
Końcowy sukces joba został potwierdzony tym odczytem.

Przyrost zapisano i wysłano na `master`/`origin/master` jako
`7189af5a98af65dbd1957411484112066be16bfa`.

Otwarte pozostają modal/native writers, API historycznych wykonań, migracja
copy-on-write i runtime. P6 pozostaje **52%**; ten przyrost nie zamyka bramki
produkcji ani testów.

## Granica następnego przyrostu natywnego

Przegląd źródeł wskazał request runnera w
`crates/fullmag-runner/src/native_fem/frequency_domain.rs`, ABI w
`crates/fullmag-fem-sys/src/lib.rs` i
`backends/fem/include/frequency_domain/driven_response_solver.hpp` oraz
kilka miejsc publikacji manifestów w
`backends/fem/src/frequency_domain/driven_response_solver.cpp`.
Obecne manifesty zawierają stałe `session_id`/`run_id` równe
`native-validation`, które nie identyfikują rzeczywistego wykonania.

Następna zmiana musi przenieść tożsamość jako osobny kontekst artefaktów,
uwzględnić wersję i rozmiar ABI oraz wszystkie miejsca publikacji pełnego
i częściowego wyniku. `operator_diagnostics_json` nie jest zastępczym polem
na ownership. Nie wystarczy poprawka manifestu po solve. To mapa zakresu
z odczytu źródeł, a nie dowód wykonanej migracji native CPU/GPU.

Odczyt granicy ABI przed przyrostem 27 potwierdził, że natywny
`DrivenFrequencyResponseSolveRequest` ma wersję 12 i jawne `struct_size`.
Walidator akceptuje obecnie wersje 0, 9 i bieżącą; niezerowy rozmiar musi
odpowiadać rozmiarowi struktury. Publiczny adapter w
`backends/fem/src/api.cpp` przekłada osobny request C z
`native/include/fullmag_fem.h`, a warstwa sys raportuje layout i offsety.
Planowany przyrost musi uwzględnić także te punkty oraz starsze wersje;
samo dodanie pola do struktury Rust nie jest zgodną migracją ABI.
