# Audyt implementacji dyspersji FEM i frontendu — 2026-09-19

## Zakres i tożsamość

Worktree: `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`.
Branch: `codex/eigensolve-dispersion-plan-20260912`.
HEAD przed audytem: `a7723cf0b3dd179f32da5294dbda8dcd685b6e14` + istniejące niezacommitowane zmiany. Audyt dotyczy eigensolve nonzero-k, benchmarku C0/C1/A1, jego analityki i powiązanego UI; nie całego frontendu Fullmag. Poniższy zapis poprzedza naprawy. Ustalenia są uzupełniane po niezależnym przeglądzie kodu.

## Ustalenia potwierdzone

### R1 — P1: timeout klienta pozostawia działający kontener

Źródło: `scripts/run_comsol_dispersion_benchmark.py::_execute`, `_compose_command`.
`subprocess.run(..., timeout=...)` kończy klienta Compose, lecz nie gwarantuje zakończenia kontenera. Nie ma jawnej tożsamości kontenera ani cleanupu na timeout/przerwanie. Zwolnienie blokady klienta nie dowodzi zwolnienia zasobów Docker.

Dowód 2026-09-19: kontener `69e5f1480a2475b41b5f4de3f35e6b92dec912b0ecf527557947f6dbe1f68ac0` montował wynik `00db21eae1644871b14c71db18f23f3d`, mimo zapisanego timeoutu 3600 s. Drugi kontener `99fc8c7039843eb36ee72767c8bb5695d2d787d053159308d9fd19f94f69313e` montował `cccc724d253949a8ac409f394389b46b`, mimo limitu 21600 s i ponad 18 h heartbeatów. Oba używały runtime joba `bd32ae0aa45e437580393aebba4d20a1`. Jednorazowy pomiar Docker: odpowiednio 212,68% CPU / 3,945 GiB i 212,61% CPU / 4,043 GiB. To potwierdza równoległe obciążenie, lecz nie identyfikuje miejsca kosztownej operacji numerycznej.

Doraźnie zatrzymano dokładnie te dwa kontenery po odczycie ich pełnych ID i mountów; polecenie zakończyło się kodem 0. Logi i źródła w storage pozostają zachowane. Naprawa docelowa: tożsamość runu/kontenera, egzekwowanie limitu po stronie kontenera, ograniczony cleanup, zapis wyniku po przerwaniu i regresje.

### R2 — P1: brak dowodu postępu solvera przedstawiano jako postęp obliczeń

Heartbeat informuje o żywym wątku raportowania. Pole `idle` mierzy brak zdarzeń postępu; wzrost `idle` nie dowodzi konwergencji ani ukończonych punktów k. Dotychczasowe komentarze wątku o pewnym postępie solvera były nieuzasadnione. C0 jest kontrolą bez demagu; jego zgodność z Kittelem nie dowodzi poprawności C1 z demagiem przy Gamma ani k != 0.

Naprawa: poprawić raportowanie i aktualny checkpoint; zidentyfikować granice etapów natywnych i najkrótszą diagnostykę. Wynik C1 pozostaje NOT VERIFIED. Nie uruchamiać ponownie 61 punktów bez rozpoznania kosztu pojedynczego punktu.

## Otwarte części audytu

- Fizyka/numerics: znaki i jednostki Floqueta, projekcja styczna, demag, równowaga, residual oryginalnego problemu, selekcja wartości własnych i złożoność.
- Walidacja: niezależność analityki, tożsamość modów, liczba punktów/pasm, granice przybliżeń, zbieżność siatki/airboxa/liczby modów.
- Frontend: odczyt artefaktów, jednostki i oś k, puste dane, selekcja modów, poprawność wyświetlanych statusów; osobny raport frontend.

## Kryteria zamknięcia

Każda poprawka ma wskazane źródło, reprodukcję/regresję i wynik weryfikacji. Testy Python/TypeScript nie dowodzą wykonania FEM. Zakaz kompilacji testów jednostkowych pozostaje obowiązujący. Build runtime, wyniki fizyczne i browser proof są oddzielnymi bramkami. Brak COMSOL nie blokuje analitycznego testu kontrolnego, ale porównanie wymaga zgodnych założeń i parametrów.

### R3 — P1: ścieżka k gubi callback postępu i przerwania

Potwierdzone: `dispatch::execute_fem_eigen_with_progress` i wariant z handoffem przechodzą do `execute_fem_eigen_path`, którego sygnatura nie przyjmuje callbacku. `KSolverAdapter::solve_single_k` używa wariantów bez postępu. W konsekwencji native EPS/KSP może emitować zdarzenia, które nie docierają do klienta; sygnał Stop/Pause przez ten callback również ginie. Naprawa: przekazać opcjonalny callback przez orchestrator i wykonania każdego punktu, z zachowaniem handoffu i ograniczeń backendu. Zweryfikować propagację anulowania przed solve oraz kompilację runtime (bez kompilacji testów jednostkowych).


## Stan napraw po przeglądzie źródeł

| ID | Stan | Zmiana i dowód |
|---|---|---|
| R1 | Naprawione w źródłach; Docker runtime do weryfikacji | Tożsamość kontenera, limit czasu wewnątrz kontenera, zweryfikowany cleanup i terminalny receipt. 15 testów Python przeszło. Szczegóły: [lifecycle](2026-09-19-dispersion-lifecycle-audit.md). Dwa wcześniejsze osierocone kontenery zatrzymano po kontroli mountów. |
| R2 | Skorygowane raportowanie | Aktualny checkpoint rozdziela heartbeat, wynik solvera i kwalifikację. Nie ma potwierdzonego C1 z demagiem. |
| R3 | Naprawione w źródłach; kompilacja runtime do weryfikacji | Callback jest przekazywany przez każdy punkt ścieżki i wariant handoffu. Dodano regresję Stop przed wykonaniem punktu. Test Rust nie został skompilowany ze względu na obowiązujący zakaz. |
| F1 | Naprawione; testy zielone | Wykres sprawdza dokładny tryb obliczenia, nie tylko wspólny typ wykresu. |
| F2 | Naprawione; testy zielone | Dopuszczono wspólne serie częstotliwości numerycznej i analitycznej przy tych samych jednostkach. |

Frontend: 65 testów w pięciu plikach oraz kontrola typów przeszły; [osobny raport](2026-09-19-dispersion-frontend-audit.md). Browser proof pozostaje NOT VERIFIED. Pięć lekkich testów kontraktów SLEPc/Floquet przeszło; to kontrola źródeł, a nie wykonanie obliczeń.

Przegląd wykrył również wymagający naprawy brak weryfikacji transportu lokalnych baz stycznych w shared-domain nonzero-k: faza skalarna nie zastępuje macierzy T_dst^T T_src. Dopuszczona zgodność magnetyzacji na szwie nie gwarantuje identyczności baz przy przejściu przez próg konstrukcji bazy. Bieżący zakres realizacji wymaga odrzucenia nieobsługiwanego transportu przed zbudowaniem operatora.


### P1 — stan naprawy transportu ram

Guard shared-domain jest zaimplementowany; [szczegółowy audyt fizyki](2026-09-19-shared-domain-physics-audit.md) opisuje źródła, regresję i ograniczenia. Nie znaleziono potwierdzonego błędu znaku Floqueta/Schura. Guard odrzuca nieobsługiwane ramy, nie dodaje pełnej obsługi teksturowanego m0. Zidentyfikowany koszt pięciu iloczynów CSR pozostaje hipotezą do profilowania, a nie dowiedzioną przyczyną długiego C1.

### Checkpoint wersjonowania

Frontend zapisano jako `821395b2ef60ac183e324f951d7d7f36d8c71662` (`fix(ui): preserve dispersion overlays and exact calculation modes`). Zakres: pięć plików źródeł/testów oraz raport frontendu. Wcześniejszą pustą blokadę indeksu z 2026-09-16 zachowano jako `index.lock.audit-recovery-20260919` po dwukrotnym potwierdzeniu braku aktywnych procesów Git. Nie usunięto pracy ani wyników. Pozostałe modyfikacje zastane w worktree nie weszły do tego commita.


### Bieżąca weryfikacja (2026-09-19)

- Dodatkowy zestaw 11 plików testowych COMSOL/artefaktów: **371 passed**, 79.16 s. Obejmuje profil runtime, projekcję n=0, certyfikaty pól, tożsamość siatki, magnetic support, linearization binding, agregację bramki, stan równowagi, referencję analityczną i bundle eigen.
- Pełny `test_validate_comsol_dispersion_scientific_gate.py`: **47 passed, 54 subtests passed**, 67.33 s.
- Managed job runtime-only: `bb8e50191fe74d39b6f9c459487b04cd`; capsule `67cb6eb73411e2a04e3a46d1c3d0fbb9bea8fb25d469cacb4ab5ba88d5acd403`, capture `9153b6871d6940419ac85e51a407dba2`; HEAD `821395b2ef60ac183e324f951d7d7f36d8c71662` + dirty snapshot. Profil `fem-cpu-slepc-runtime-v1` deklaruje pustą listę `unit_test_targets`.
- Job został następnie celowo anulowany przez autora audytu po dodatkowych poprawkach review; API potwierdziło `cancelled`, exit 143. Nie zaliczył bramki builda. Nie jest to jeszcze dowód poprawnej kompilacji ani fizyki. Zmiany polityki benchmarku wykonane po capture wymagają oddzielnego rozróżnienia źródeł w następnym runie.


### R4 — P2: niespójne rozpoznawanie numerycznego Gamma

Planner, capability i przejście Floquet→Periodic używają tolerancji 1e-12 rad/m, a `is_gamma_k_sampling` oraz `k_sampling_contains_nonzero` używały dokładnego zera. Dla k=5e-13 rad/m powoduje to sprzeczną kwalifikację punktu i możliwe odrzucenie po routingu. Naprawa zachowuje istniejącą tolerancję planera, nazywa ją w runnerze i stosuje także w redukcji; nie zmienia k zapisanego w provenance. Nie jest to tolerancja residualu ani dopasowania częstotliwości. Dodajemy regresje granicy i wartości niefinitywnych.

Dodatkowe review: brak planner resolution pozostaje celowym błędem `planned_fem_eigen_resolution_missing`; nie wolno omijać tego wymagania fallbackiem legacy. Martwy fallback to dług kodu, a nie powód osłabienia kontraktu provenance.


## Zbiorcza lista ustaleń po drugim review

| ID | Priorytet | Problem | Stan poprawki |
|---|---|---|---|
| R1 | P1 | Timeout kończy klienta Compose, pozostawia obliczenie | Naprawiony lifecycle; 15 testów Python, potwierdzona normalizacja ścieżek Windows. |
| R2 | P1 | Heartbeat traktowany jako postęp numeryczny; C0 utożsamiane z C1 | Skorygowane raportowanie i checkpoint. C1 nadal bez dowodu wykonania. |
| R3 | P1 | Utrata callbacku na ścieżce k | Propagacja callbacku przez punkt i handoff; regresja Rust dodana, bez kompilacji unit. |
| R4 | P2 | Dokładne zero w redukcji, tolerancja w routingu | Wspólna nazwana tolerancja runnera 1e-12 rad/m, zgodna z plannerem; regresja granicy i NaN/Inf. |
| R5 | P2 | Pomocnicza ścieżka GPU K0 pomija callback | Callback na granicach etapów, Stop/Pause przed/po operacjach. Synchronicznego wywołania GPU nie można przerwać w środku. |
| P1 | P1 | Brak kontroli transportu lokalnych baz w shared-domain | Fail-closed przed payloadem dla nieidentycznych baz; nie jest to implementacja pełnego transportu tekstur. |
| F1 | P1 | Rodzina wykresu zastępuje dokładny tryb obliczeń | Naprawione, testy i typecheck zielone. |
| F2 | P1 | Renderer usuwa nakładkę analityczną | Naprawione przy zachowaniu zgodności jednostek. |
| V1 | P2 | Niespójne kryterium i odniesienie sweepu airboxa | Osobna kontrola sąsiednich pudełek i trendu, budżet kampanii 0.5% z wcześniej przyjętej procedury; osobna bramka KS 0.3%. |
| V2 | P1 | Kanoniczna ścieżka nie zawiera czystego DE | Jawne dodatkowe wektory BV/DE w konfiguracji i bramce. Brak ich wyników nadal blokuje kwalifikację. |
| V3 | P1 | Wybór gałęzi według identyfikatora zamiast widma | Powiązanie pierwszej gałęzi z minimum dodatniego widma w każdej próbce; to nie zastępuje certyfikatu profilu pola. |
| V4 | P2 | Niejawny budżet iteracji EPS/KSP | Jawnie 64/128, zgodnie z domyślnymi wartościami adaptera; rtol pozostaje 1e-8. Limity nie ograniczają assembly ani faktoryzacji. |

Szczegółowe dowody i ograniczenia V1–V4: [audyt walidacji](2026-09-19-dispersion-validation-audit.md). W tabeli „naprawione” oznacza zmianę źródeł, nie zakończoną walidację fizyczną. Łącznie sklasyfikowano 12 ustaleń: 11 dotyczących kodu/konfiguracji/kontraktu oraz korektę raportowania R2.

## Dług techniczny i brakujące dowody

- Właściwy benchmark nadal potrzebuje poprawnego numerycznego C1 z demagiem. Zacząć od Gamma i pojedynczych BV/DE, nie od ponowienia 61 punktów bez diagnostyki.
- Globalny durable lease dla runtime benchmarku nie został dodany. Lokalny lock i exact-container cleanup nie zastępują kontraktu koordynatora. Nie uruchamiać równolegle ciężkich runów/buildów; formalna integracja wymaga osobnego rozszerzenia kolejki, bez obchodzenia `managed_heavy_lock`.
- Pełny transport `phase*(T_dst^T T_src)` dla teksturowanego m0 oraz anulowanie w środku synchronicznego GPU dense solve pozostają niezaimplementowanymi możliwościami. Aktualny zakres bezpiecznie odrzuca nieobsługiwane ramy i nie deklaruje preempcji GPU.
- Frontendowy parser CSV obsługuje obecny kontrakt numeryczny; cytowane dowolne etykiety pozostają ryzykiem wymagającym wspólnego sprawdzenia writera i parsera, nie potwierdzonym nowym błędem.
- Native assembly używa CSR. Koszt pięciu iloczynów z mapowym fill-in trzeba zmierzyć; bez profilu nie ma podstaw do przypisania im całego czasu C1 ani do zmiany operatora.
- Dwie lokalne wartości mu0=1.25663706212e-6 w `poisson_airbox_shared_domain.cpp` różnią się od kanonicznego 4*pi*1e-7 o około 5.4e-10 względnie. To dług spójności stałych, nie wyjaśnienie dużej rozbieżności dyspersji. Nie zmieniano fizyki na podstawie tej różnicy.
- Brak COMSOL nie blokuje kontroli analitycznych, ale ich przejście wymaga zgodności materiału, geometrii, równowagi, skończonego/otwartego airboxa, profilu modów i provenance. Testy walidatora sprawdzają odrzucanie złych dowodów; nie wytwarzają dowodów numerycznych.
- Browser proof, wykonanie nowych regresji Rust, pełna kampania zbieżności i kwalifikacja wydania pozostają osobnymi bramkami. Obowiązuje zakaz kompilowania testów jednostkowych.
