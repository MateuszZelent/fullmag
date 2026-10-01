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

Guard shared-domain jest zaimplementowany; [szczegółowy audyt fizyki](2026-09-19-shared-domain-physics-audit.md) opisuje źródła, regresję i ograniczenia. Na podstawie dowodów dostępnych 2026-09-19 nie znaleziono wtedy potwierdzonego błędu znaku Floqueta/Schura; ustalenie to zostało zastąpione przez reaudyt z 2026-09-24 poniżej. Guard odrzuca nieobsługiwane ramy, nie dodaje pełnej obsługi teksturowanego m0. Zidentyfikowany koszt pięciu iloczynów CSR pozostaje hipotezą do profilowania, a nie dowiedzioną przyczyną długiego C1.

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

### Aktualizacja runtime i N1 — 2026-09-23

Managed runtime-only build `2439cca257fb49ffb42bc8adba739623` przeszedł
kompilację z `exit_code=0`, ale jego smoke `de-smoke-k2` nie wytworzył
zaakceptowanego modu. Zero-pivot LU ustąpił po zastosowaniu normowanej
stabilizacji wyłącznie w preconditionerze; pierwszy podzakres zakończył się
residual gate `floquet_original_descriptor_residual_not_met`, a drugi nie miał
dodatniego kandydata w oknie. Implementacja nie uzyskała jeszcze numerycznej
częstotliwości dla niezerowego $k$.

N1 — P1: ścieżka native Floquet nie wypełniała liczników kandydatów i
residuali, mimo że serializator już je publikował. Nieudany run pokazał 23
kandydatów, lecz zera w `residual_rejections` i metrykach residualu; tych zer
nie wolno interpretować jako wyniku. Poprawka źródłowa zbiera liczbę
kandydatów dodatnich/w oknie, liczbę pełnych ewaluacji residualu, awarie
rekonstrukcji oraz oddzielne residuale EPS, magnetyczny i potencjału.
Nieobliczone metryki są inicjalizowane jako niezmierzone i serializowane jako
`null`, więc brak próbek nie będzie wyglądał jak zerowy residual. Dodano
asercje do istniejącego testu, ale
zgodnie z polityką repo testy nie zostały skompilowane ani uruchomione.
Poprawka nie weszła jeszcze do managed builda i nie jest zweryfikowana runtime.

Runner jest zdrowy, lecz kolejkę zajmuje aktywny job innego worktree
(`b0635ee724444977bae6402221f82990`); do jego terminalnego stanu nie zmieniać
współdzielonego obrazu, profili ani procesu.

- Właściwy benchmark nadal potrzebuje poprawnego numerycznego C1 z demagiem. Zacząć od Gamma i pojedynczych BV/DE, nie od ponowienia 61 punktów bez diagnostyki.
- Globalny durable lease dla runtime benchmarku nie został dodany. Lokalny lock i exact-container cleanup nie zastępują kontraktu koordynatora. Nie uruchamiać równolegle ciężkich runów/buildów; formalna integracja wymaga osobnego rozszerzenia kolejki, bez obchodzenia `managed_heavy_lock`.
- Pełny transport `phase*(T_dst^T T_src)` dla teksturowanego m0 oraz anulowanie w środku synchronicznego GPU dense solve pozostają niezaimplementowanymi możliwościami. Aktualny zakres bezpiecznie odrzuca nieobsługiwane ramy i nie deklaruje preempcji GPU.
- Frontendowy parser CSV obsługuje obecny kontrakt numeryczny; cytowane dowolne etykiety pozostają ryzykiem wymagającym wspólnego sprawdzenia writera i parsera, nie potwierdzonym nowym błędem.
- Native assembly używa CSR. Koszt pięciu iloczynów z mapowym fill-in trzeba zmierzyć; bez profilu nie ma podstaw do przypisania im całego czasu C1 ani do zmiany operatora.
- Dwie lokalne wartości mu0=1.25663706212e-6 w `poisson_airbox_shared_domain.cpp` różnią się od kanonicznego 4*pi*1e-7 o około 5.4e-10 względnie. To dług spójności stałych, nie wyjaśnienie dużej rozbieżności dyspersji. Nie zmieniano fizyki na podstawie tej różnicy.
- Brak COMSOL nie blokuje kontroli analitycznych, ale ich przejście wymaga zgodności materiału, geometrii, równowagi, skończonego/otwartego airboxa, profilu modów i provenance. Testy walidatora sprawdzają odrzucanie złych dowodów; nie wytwarzają dowodów numerycznych.
- Browser proof, wykonanie nowych regresji Rust, pełna kampania zbieżności i kwalifikacja wydania pozostają osobnymi bramkami. Obowiązuje zakaz kompilowania testów jednostkowych.

### Doprecyzowanie walidacji szwów demagnetyzacji — 2026-09-23

Wynik `periodic_pairs.v1` potwierdza sześć grup sparowanych ścian i 3585
sparowanych węzłów przy zerowym residualu translacji. `pair_count=6` oznacza
grupy ścian, nie liczbę wszystkich par węzłów; fingerprint topologii to
`sha256:2fde44d7d0e2f8ba58de35c3055ae167866e18fbdd90a41ad5f7302110f8fa2e`.
To potwierdza wyłącznie spójność topologii okresowej.

Diagnostyka `fem_static_pbc_demag_seams.v1` nie obliczyła szwów: brakowało
snapshotów `H_demag` i `demag_phi` z końcowego kroku relaksacji. Jej status
`failed` opisuje niewykonalną kontrolę z powodu brakujących danych, a nie
negatywny wynik fizyczny. Statyczny demag seam pozostaje `NOT VERIFIED`;
należy powtórzyć kontrolny run z eksportem obu pól. Nie odblokowuje to T5:
brak zaakceptowanej częstotliwości dla niezerowego $k$ nadal blokuje wykres.

Wejście `examples/fem_de_smoke_numeric.py` żąda teraz terminalnych pól
`H_demag` i `demag_phi` z okresem wyprowadzonym z limitu relaksacji. Poprawka
ma stan `source changed, runtime NOT VERIFIED`; nowy run musi wykazać oba pola
na tym samym końcowym kroku, zanim kontrolę szwów uznamy za wykonaną.

Job runnera `b0635ee724444977bae6402221f82990` z obcego worktree zakończył się
`failed`/exit 2 po błędzie kompilacji Rust E0308 w
`eigen_equilibrium_contract.rs:345` (`&Vec<f64>` zamiast `&[bool]`). Nie jest
to wynik naszego snapshotu ani przyczyna nieudanego `k2`. Runner jest obecnie
idle, ale profil runtime-only nadal nie znajduje się na allowliście.

Runtime-only allowlistę przywrócono w koordynatorze
`sha256:eed020f1664bde606b20412968681094a885f3e7080679c6d21c90a4160253e4`,
health potwierdził `accepting_jobs=true`. Snapshot joba 109
`d4a26468c5124354b9956ac5ddb92aef` ma source digest
`054d139d6474a378c587974c5652af65eda4fad922afa241eabeba58efd2eec8` i
`source_snapshot_sha256=8467417fdf6ce3265f00c5dd61b5390b1c32352dd6475421d39b74344b89d052`;
stan `running`, więc brak jeszcze dowodu kompilacji telemetry patcha i
zmienionego wejścia DE-SMOKE.

### Aktualizacja po managed build i smoke `k2` — 2026-09-23

Powyższy status joba 109 jest historyczny. Job
`d4a26468c5124354b9956ac5ddb92aef` zakończył się `succeeded` / exit 0 na
snapshotcie `8467417fdf6ce3265f00c5dd61b5390b1c32352dd6475421d39b74344b89d052`.
Receipt ma `runtime_only=true`, profil `fem-cpu-slepc-runtime-v1`,
`unit_test_targets=[]`, a atestacja runtime przeszła dla FEM CPU/double/SLEPc.
Oznacza to działający build runtime; nie oznacza testów jednostkowych ani
kwalifikacji fizycznej.

Pilot `de-smoke-k2` (`50d824f803ef45d1a9bedb0b647ac8a5`) wystartował z tego
builda, wykonał relaksację i modalny solve dla
$\mathbf k=(0,2\times10^6,0)\,\mathrm{rad\,m^{-1}}$. SLEPc zwrócił 23
kandydatów; in-window kandydat przy 9.7233362727 GHz został odrzucony, bo
magnetyczny residual oryginalnego bloku wyniósł
`2.1678405357802513e-7`, ponad żądane `1e-8`. Residual potencjału wyniósł
`1.4175187550539143e-14`; liczba zaakceptowanych modów to zero. Nie ma
wiersza dyspersji ani poprawnego wykresu. Cleanup kontenera został
potwierdzony (`verified_absent`), a runner wrócił do stanu idle.

**N2 — P1, niespójna skala zbieżności EPS i bramki fizycznej.** Poprzedni
adapter używał `EPS_ERROR_RELATIVE` (`||r||/|lambda|`) i traktował tę wartość
jak bezwymiarowy residual. W runie wartość EPS wyniosła `5.72e-20`, choć
oryginalny residual magnetyczny wyniósł `2.17e-7`. Bramka blokowała fałszywą
akceptację, ale solver mógł zakończyć iterację za wcześnie, a diagnostyka
porównywała niezgodne miary. Źródło zmieniono na `EPS_CONV_ABS` z true
residualem wspólnego, normowanego pencil oraz wewnętrzną tolerancją
`max(100*epsilon_machine, 0.01*requested_rtol)`; próg akceptacji fizycznych
bloków pozostał równy `requested_rtol`. Wartości EPS są teraz nazywane
znormalizowanym residualem bezwzględnym i nie wchodzą do fizycznej bramki.
Wymagana następna bramka: managed runtime rebuild oraz powtórny `k2`. Status:
`source changed; managed runtime NOT VERIFIED`.

**Demag — częściowo wykonana kontrola statyczna.** Nowy run ma oba pola
`H_demag` i `demag_phi`; `fem_static_pbc_demag_seams.v1` zwrócił `status=ok`
dla sześciu grup ścian, bez mierzalnego mismatch magnetyzacji, potencjału,
pola lub strumienia normalnego. Recomputed final-state linearization ma
`status=matched`, a różnica `H_demag` wynosi około `1.67e-24 A/m`. To
potwierdza zgodność snapshotów i statyczny szew dla jednorodnej równowagi
in-plane przy $k=0$; nie testuje fazowego operatora dynamicznego przy
$k\ne0$. Artefakt LLG ma `status=not_evaluated`, więc relaksacja nie została
formalnie zakwalifikowana.

Remote `origin/master` po odświeżeniu ma SHA
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`; jest przodkiem HEAD worktree
(`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`). `git rev-list` pokazuje 209
commitów tylko po stronie brancha i zero commitów tylko po stronie mastera.
Worktree zawiera aktualny master i pozostaje dirty; nie było merge ani resetu.

Pozostałe bramki nadal otwarte: zweryfikować poprawkę N2 w runtime, uzyskać
zaakceptowaną częstotliwość dla `k2`, porównać ją z analityką i dynamicznym
demagiem, następnie wykonać kolejne punkty $k$, kontrolę zbieżności, wykres i
pełną kwalifikację C1. Testów jednostkowych nadal nie wolno kompilować.

### Checkpoint współdzielonego runnera — 2026-09-23

Job `8dead9c4716741bba741e72055a756b2` z worktree
`eigensolve-k0-finalization-db0fde795ab86411` nadal ma stan `running`.
Zweryfikowany etap `native-build` zakończył się kodem 0 po około 3107 s;
runner wykonuje teraz `pnpm install --dir apps/control-room --frozen-lockfile`.
Kontener przypisany jobowi pozostaje aktywny. Współdzielony runner jest w
graceful stop, nie przyjmuje zadań, a allowlista nie zawiera jeszcze
`fem-cpu-slepc-runtime-v1`. Nie anulować joba ani nie zmieniać/restartować
koordynatora, dopóki runner nie potwierdzi stanu terminalnego i pustej listy
aktywnych zadań.

Po zwolnieniu kolejki zachować obraz `sha256:e9f46ae4690d96dfcdfa915584265733b6d9930fdecf60b16b95f6bfb26101fc`,
włączyć profil runtime-only przez wspierany interfejs konfiguracji, wymienić
wyłącznie dokładny koordynator i potwierdzić `accepting_jobs=true`. Następnie
zbudować bieżący snapshot tego worktree, zweryfikować receipt i source identity
i powtórzyć `de-smoke-k2`. Do tego czasu N2 ma stan `source changed; runtime
NOT VERIFIED`.

### Najnowszy odczyt kolejki — 2026-09-23

Ten odczyt zastępuje wcześniejszy status joba #110. Live runner zgłasza
koordynator `26ad46a25f6aecff5534bd51ea0b7e5b8484d424363d7495ee332828f9d8efec`,
obraz `sha256:e9f46ae4690d96dfcdfa915584265733b6d9930fdecf60b16b95f6bfb26101fc`,
`worker_alive=true` i `accepting_jobs=true`. Baza kolejki pokazuje aktywny job
#111 `e087d668915e4e6099d5404d5b8ebc0c` z innego worktree, profil
`fem-cpu-slepc-modal-v1`. Live allowlista nie zawiera wymaganego przez nas
`fem-cpu-slepc-runtime-v1`. Kolejka FIFO istnieje, ale koordynator odrzuca
submit profilu spoza allowlisty przed zapisaniem joba; poprzednia próba naszego
snapshotu zwróciła HTTP 503 i nie pozostawiła wpisu w kolejce.

Ponowne odczyty w odstępie około 30 s nie zmieniły rekordu #111; `updated_at`
pozostaje przy 21:26:09 (czas lokalny). Health jednocześnie pokazuje ten job
jako `running`, lecz `coordinator.active_job_ids=[]`, `waiting_until` wskazuje
21:26:08, a worker jest żywy bez zgłoszonego błędu. To niespójność kolejki i
stanu koordynatora; nie potwierdza ani zwolnienia slotu, ani przyczyny zastoju.
Nie anulować ani nie rekoncyliować joba automatycznie.

Inspekcja dokładnie przypisanego kontenera rozstrzygnęła, że worker jest
faktycznie aktywny: kontener `337f0cae831ede0d92e46a4714ddeafd49bf45f6934669df295ce7ed1af0361f`
ma `running=true`, a `docker top` pokazał `cargo`. Po `runner-wait` 30 s job
nadal był `running`; timeout obserwatora nie kończy lease. Storage miało
`8,650,276,864` wolnych bajtów, około 60 MB ponad próg 8 GiB. API odczytu
retencji timeoutowało, więc nie ma potwierdzonego kandydata do usunięcia.
Obraz workera runtime-only jest skonfigurowany i dostępny
(`sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`,
2 CPU/8 GiB RAM), lecz aktywny koordynator nie dopuszcza profilu.

Nie przełączać obrazu/allowlisty, póki cudzy job jest aktywny. Obraz
`sha256:eed020f1664bde606b20412968681094a885f3e7080679c6d21c90a4160253e4`
wcześniej zweryfikowano jako zawierający runtime profile, ale live runner
obecnie używa obrazu `e9f46…`. Po zakończeniu #111 sprawdzić terminalny stan i
pustą listę aktywnych zadań, przywrócić zweryfikowany obraz/allowlistę przez
wspierany cykl, potwierdzić live health, a następnie przesłać snapshot N2.
Do tego czasu poprawka N2 pozostaje niezweryfikowana w runtime; nie ma
zaakceptowanego punktu `k2` ani wykresu dyspersji.

### Kontrola możliwości kolejkowania — 2026-09-23

Runner ma jedną kolejkę FIFO i nadal przyjmuje zadania. Live `/health` podaje
`worker_alive=true`, `accepting_jobs=true`, `worker_error=null` oraz aktywny
job #111 z innego worktree. Hostowa konfiguracja zawiera profil
`fem-cpu-slepc-runtime-v1`, ale allowlista działającego koordynatora go nie
zawiera. Nasz snapshot został odrzucony HTTP 400; klucza żądania nie ma w
bazie, więc nie powstał nowy job. Aktywnego joba nie zatrzymano.

Wolne miejsce spadło do `5,807,996,928` bajtów, poniżej progu 8 GiB. Po
zakończeniu #111 trzeba potwierdzić wolne miejsce, zastosować hostową
konfigurację przez wspierany cykl koordynatora i sprawdzić live allowlistę;
dopiero wtedy wysłać nowy snapshot. Kapsuły z odrzuconych prób pozostają
zachowane; retencja ani prune nie zostały uruchomione.

Nowszy odczyt o 20:24 UTC nadal pokazuje #111 jako aktywny; `runner-wait`
timeoutował na API i nie anulował joba. Wolne miejsce wynosi
`4,866,473,984` bajtów. Nie zmieniać koordynatora ani nie uruchamiać buildu
przed terminalnym jobem, live allowlistą runtime i odzyskaniem 8 GiB.

Kolejny odczyt o 20:27 UTC nadal pokazuje aktywny #111 i brak profilu runtime;
wolne miejsce wynosi `4,772,020,224` bajty.

### Re-audyt source i runnera — 2026-09-23, 21:12 UTC

1. **Poisson LU zmieniał Schur action — źródłowo poprawione, bez runtime.**
   `KSPPREONLY` aplikuje preconditioner tylko raz; `MAT_SHIFT_NONZERO` w PCLU
   nie jest tu jedynie zmianą preconditionera, lecz przybliża
   $P(\mathbf k)^{-1}$ używane wewnątrz operatora. Ustawiono `MAT_SHIFT_NONE`,
   dodano telemetrię `poisson_factorization_shift_policy`, regresję w
   `floquet_modal_solver_test.cpp` i poprawiono 0831/source-map. Test C++ i
   managed runtime pozostają `NOT VERIFIED`.

2. **Metryka masowa podprzestrzeni mogła akceptować złą liczbę składowych —
   źródłowo poprawione.** `tracking_subspace.rs` wymaga teraz dokładnie trzech
   składowych na każdy węzeł z wagą w obu kierunkach normalizacji. Dodano
   regresję, w której poprzednia heurystyka błędnie przyjmowała dwa składniki.
   Test Rust nie został uruchomiony.

3. **Niski-k cutoff pozostaje otwarty.** Warunek pure-Neumann
   `|k|L > 1e-3` jest fail-closed i ujawnia błąd próbki, ale jego związek z
   warunkowaniem/pivotami nie ma jeszcze adaptacyjnego oszacowania. Nie
   usuwano go bez dowodu, że near-Γ Poisson solve daje wiarygodny potencjał.

4. **Sparse certyfikat pozostaje celowo niepełny.** Sparse adapter mierzy
   residuale zredukowanych oryginalnych bloków, lecz nie przeprowadza osobnego
   dowodu szwów i transportu ramy na pełnym polu. Flaga
   `floquet_descriptor_certified=false` jest prawidłowa; ustawienie jej na
   `true` bez takiej kontroli byłoby fałszywym certyfikatem. Potrzebny jest
   późniejszy skalowalny certyfikat Blocha albo jawne utrzymanie bramki.

5. **Runner ma kolejkę, ale nasz job nie został przyjęty.** O 21:12 UTC job
   #111 miał terminalne `failed`/exit 2, `active_jobs=[]`, koordynator
   przyjmował zadania, a storage miało `62,508,752,896` B wolnego miejsca.
   Allowlista live nadal pomija runtime-only. `runner-container-status` zwraca
   błąd Docker Desktop; nie zmieniono obrazu ani nie wysłano joba pod profilem
   zastępczym. Należy wznowić lifecycle po przywróceniu obsługiwanej kontroli
   kontenera.

Source-map validator: pass; testy dokumentacji `32/32`; JSON i
`git diff --check`: pass. Kompilacja, testy backendu, runnerowy runtime,
kwalifikacja zbieżności, frontend/browser i wynik `f(k)` pozostają
`NOT VERIFIED`.

### Reaudyt S04/S05 — 2026-09-24

Niezależny przegląd wskazał sześć ryzyk implementacji Floquet/SLEPc. Reprodukcja
na aktualnym wywołaniu produkcyjnym potwierdziła błąd znaku, lecz nie potwierdziła
zgłoszonego błędu wymiarów:

| Finding | Stan po reaudytcie |
|---|---|
| `A_phiq` używało znaku `+S` zamiast `-S` z deskryptora `A_phiq q + P phi = 0` | Naprawione w źródle importera; dodano regresję znaku w payloadzie Floquet. Test C++ nie został zbudowany zgodnie z tymczasowym zakazem. |
| Źródło miało zredukowane kolumny q przed mnożeniem przez ograniczenie | Nie odtworzono w ścieżce produkcyjnej: `source_request` celowo nie przekazuje mapy `magnetic_reduced_node`, więc źródło ma pełne kolumny; test producenta wymaga właśnie pełnego wymiaru. Uogólnione API assemblera nadal umożliwia redukcję używaną w osobnym teście, ale ten wynik nie trafia do obecnego importera. |
| Akceptacja SLEPc bez pełnego residualu deskryptora, szwów i gauge | Otwarte; sparse solver publikuje residuale bloków zredukowanych i utrzymuje `floquet_descriptor_certified=false`. |
| Transport różnych ramek stycznych na seamach | Częściowo naprawione źródłowo w shared-domain modalnym importerze: dla czystej translacji `Q=I` ograniczenie używa `T_member^T T_rep` wraz z fazą Floqueta i nadal odrzuca inną fizyczną magnetyzację. Regresję dodano, ale nie skompilowano ani nie uruchomiono. Managed runtime jest `NOT VERIFIED`; niejednostkowe fizyczne `Q` oraz osobny driven-response validator pozostają poza tą poprawką. |
| Kompletność okna/liczby zaakceptowanych modów | Otwarte; `ok=true` nadal nie certyfikuje pokrycia żądanego widma. |
| Jawna normalizacja przyjętych modów | Źródłowo obecna: ścieżka shared-domain normalizuje `q` metryką masową i skaluje `phi` tym samym czynnikiem; odbiór runtime/artefaktu pozostaje otwarty. |
| Planner/runtime dla lokalnych interakcji | Naprawa źródłowa dodana: planner odrzuca DMI, anizotropię i niejednorodne `A`, zanim runtime zbuduje nieobsługiwany operator; regresje Rust dodano, lecz nie uruchomiono. |

`git diff --check` przechodzi. Nie uruchomiono testów C++ ani kompilacji testów.
Managed job #118 (`674dac1a46fc4cf4ba5268459f4fc845`) nadal kompiluje starszy,
zamrożony snapshot; nie obejmuje poprawki znaku. Po jego stanie terminalnym trzeba
zlecić nowy build bieżącego źródła, przed jakimkolwiek DE-SMOKE. Nadal brak
zaakceptowanej częstotliwości `k != 0`, porównania z analityką i wykresu.

Szacunek postępu pozostaje heurystyczny: **20–25% celu end-to-end**, około
**45% prac przygotowawczych/źródłowych**, **0% ukończonego wyniku naukowego dla
`k != 0`**. Źródła nie są jeszcze kwalifikowane, a część frontendu, S09–S11,
managed runtime, zbieżność, integracja i review pozostają otwarte.


### Aktualizacja po managed buildzie #119 — 2026-09-24

Job #119 3c386adf… zakończył się jako failed, exit code 2. Natywny build przeszedł, ale etap frontend-build dwukrotnie przerwał kontrolę TypeScript w frequencyDomainChartModels.ts:1885 z powodu niedozwolonego końcowego przecinka po typie wartości generyka Map. Usunięto przecinek w bieżącym worktree.

Job #120 90a40511… nadal działa na tym samym digestcie 0221cae0… i nie zawiera poprawki. Nie zatrzymano go. Aktualny kod nie ma jeszcze managed-build proof; po terminalnym #120 trzeba zgłosić świeży snapshot.

Dla korekty Rust preflight ramek stycznych i błędu TypeScript sprawdzono formatowanie Rust oraz git diff --check; testów jednostkowych nie kompilowano ani nie uruchamiano. Nadal brak zaakceptowanego punktu k != 0, porównania z analityką i wykresu dyspersji. Szacunek end-to-end pozostaje 20–25%, prace źródłowe/przygotowawcze około 45%, a zaakceptowany wynik naukowy k != 0: 0%.

### Aktualizacja statusu kolejki i postępu — 2026-09-24

Ponowny odczyt konkretnego joba #120 (`90a4051188614844bb1b64b9a5e0841c`) potwierdza `state=running`, `exit_code=null` oraz stary source digest `0221cae0…`; snapshot powstał przed poprawkami Rust preflight i TypeScript w bieżącym worktree. Jobu nie anulowano. Próba `just runner-container-status` zakończyła się błędem `Docker Desktop coordinator request failed`, dlatego bieżące zdrowie kontenera nie jest poświadczone i nie zgłoszono nowego joba.

Szacunek pozostaje heurystyczny: **20–25% celu end-to-end**, około **45% prac źródłowych/przygotowawczych** i **0% zaakceptowanego wyniku naukowego dla `k != 0`**. Nadal nie ma zaakceptowanej częstotliwości, porównania z analityką ani wykresu. Następny krok: pozostawić #120 do stanu terminalnego, potwierdzić zdrowie runnera, a następnie zbudować świeży snapshot bieżącego worktree i uruchomić DE-SMOKE z dokładnie tego runtime.

### Runner re-attestowany; świeży snapshot #122 w kolejce — 2026-09-24

Domyślny odczyt hosta nie mógł otworzyć `storage/.initialize.lock`; po przyznanym dostępie do projektu ta sama recepta `just runner-build snapshot fem-cpu-slepc-modal-v1` utworzyła job #122. To job `3f6c3486725745af9349895a0588a72b`, `state=queued`, `exit_code=null`, dla worktree `eigensolve-dispersion-plan-20260-c5dfad6d7f548079`, bazowego HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Source digest: `b4af0bd998b64b4eb68528cbe7432707419892b455df65036f6b2d05873ab8a6`; capture ID `e1733f2c90ab4c5eb3dd945b0ef92364`; `source_snapshot_sha256=2f16693d4cc14f16cbf587442b2a85ce830802825a5b4534bc9e741eb140a9d4`; dirty runtime identity `c9a9ebeb6f7c40e58a38d5404ebae7b681e85cd98f48881f66e45d8d6c25a6fe`.

Odczyt `just runner-container-status` przez dozwolony dostęp potwierdził `health.ok=true`, `worker_alive=true`, `accepting_jobs=true`, brak błędu workera, allowlistę `fem-cpu-slepc-modal-v1` oraz `34 362 441 728` B wolnego storage. Job #120 (`90a4051188614844bb1b64b9a5e0841c`) nadal ma stan `running`, lecz używa starszego digestu `0221cae0…`. W statusie koordynatora `active_job_ids=[]`, mimo że payload `active_jobs` zawiera #120; zachowuję więc #120 jako aktywny i nie próbuję odzyskiwać lease. Job #121 dotyczył innego worktree `eigensolve-k0-finalization-db0fde795ab86411` i jest terminalnie anulowany. Filtr listy kolejki pokazuje #122 jako oczekujący obok #120; runner nie prowadzi równoległego buildu.

#122 nie ma jeszcze receipt ani wyniku kompilacji/runtime. Następny krok: monitorować dokładnie #120 i #122; po terminalnym wyniku #122 zweryfikować receipt i hashe, a następnie uruchomić `DE-SMOKE` z runtime tego snapshotu. Testów jednostkowych nie kompilowano ani nie uruchamiano.

Szacunek pozostaje heurystyczny: **20–25% celu end-to-end**, około **45% prac źródłowych/przygotowawczych**, **0% zaakceptowanego wyniku naukowego dla `k != 0`**.

### Reaudyt proweniencji residuali i wykresu — 2026-09-24

W parserze natywnego wyniku Floqueta potwierdzono pomylenie norm: residual
względny był kopiowany do pól residualu bezwzględnego, L-infinity i residualu
raportowanego przez SLEPc. Źródłowo rozdzielono te wielkości. Importer czyta
każdą wyłącznie z właściwego pola, a brak pozostaje brakiem również w
manifeście, mode bundle i artefakcie ścieżki. Residuale ponownie obliczone
przez runner są oddzielone od diagnostyki producenta. Dodane regresje nie
zostały skompilowane ani uruchomione; kontrola rustfmt i `git diff --check`
przeszły. Nadal otwarty jest pełny residual oryginalnego deskryptora wraz z
gauge i certyfikacją szwów.

W Control Room potwierdzono cztery kolejne błędy źródłowe:

| Problem | Poprawka źródłowa | Pozostały dowód |
|---|---|---|
| Dwa panele dyspersji nie przekazywały klikniętego punktu do selekcji | Dodano `onSelectPoint` i kanoniczny handoff punktu w panelach Dispersion oraz k-Path | Build bieżącego snapshotu i browser/WebGL |
| Sam `mode_field_id` przedstawiał niedostępne pole jako gotowe do podglądu | Dostępność wymaga teraz jawnego klucza zasobu; ID bez klucza nie daje handoffu 3D | Testy frontendu i rzeczywisty fetch pola |
| Pojedyncze brakujące próbki były łączone linią, a nieśledzone mody tworzyły pozorne gałęzie | Dodano null sentinel przy lukach gałęzi; niezidentyfikowane mody są seriami scatter | Render w przeglądarce z rzeczywistym artefaktem dyspersji |
| Explorer pomijał wektor `k` z CSV, gdy brakowało metadata sidecar | Wektor z wiersza CSV ma pierwszeństwo przed interpolacją z sidecara | Test i round-trip UI z aktualnym artefaktem |

Regresje zostały dopisane, ale nie uruchomione ze względu na zakaz kompilacji
testów. `git diff --check` przechodzi. Próba formatowania nie mogła ruszyć,
ponieważ Prettier nie jest zainstalowany w tym worktree. Job #120 pozostaje
`running` na starym digestcie, a #122 `queued`; oba snapshoty poprzedzają te
poprawki. Potrzebny jest nowy managed build oraz późniejszy browser proof.

Szacunek nie zmienia się: **20–25% celu end-to-end**, około **45% źródeł i
przygotowania**, **0% zaakceptowanego wyniku naukowego `k != 0`**. Nie ma
częstotliwości z solvera, porównania analitycznego ani wykresu z obliczonych
danych.

### Aktualny stan wykonawcy — 2026-09-24

Po source review `just runner-container-status` zwrócił
`Docker Desktop coordinator request failed`. Nie przesądza to o zatrzymaniu
workera, lecz zdrowie runnera nie jest obecnie poświadczone. Odczyt kolejki
w tej samej sesji pokazał #120 `running` i #122 `queued`, oba na snapshotach
sprzed najnowszych poprawek S04/S05/S08. Żadnego joba nie zatrzymano ani nie
zmieniono, nie wysłano też nowego snapshotu. Następny bezpieczny krok to
przywrócić możliwość attestation przez wspieraną konfigurację runnera,
ponownie sprawdzić te same joby i dopiero potem zgłosić aktualne źródła.

### Reattestacja managed runnera i ocena postępu — 2026-09-24

Job #120 zakończył się błędem frontendowego typechecku po przejściu natywnego buildu i instalacji zależności. Przyczyną był końcowy przecinek w typie `Map` w `frequencyDomainChartModels.ts:1885`; poprawiono go w bieżącym źródle. Job #122 nadal buduje starszy snapshot sprzed ostatnich poprawek residuali i frontendowych. Zdrowie runnera potwierdzono przez wspieraną receptę: worker aktywny, akceptuje zadania, bez błędu, profil SLEPc modalny dozwolony, ok. 29 GB wolnego miejsca. `active_jobs` zawiera #122, natomiast `active_job_ids` jest puste; job pozostaje zachowany i niezmieniony.

Poziom ukończenia pozostaje **20–25% end-to-end** i około **45% źródeł/przygotowania**. **0%** wynosi akceptowana naukowo walidacja punktu `k != 0`: brak liczbowego wyniku z solvera, porównania z modelem analitycznym i wykresu z rzeczywistych danych. Dostępne są jedynie źródłowe ścieżki/komponenty wykresu. Nowe poprawki czekają na świeży managed build i dowód w przeglądarce; testów jednostkowych nie uruchamiano ze względu na obowiązującą instrukcję repozytorium.

### Aktualny job do weryfikacji snapshotu — 2026-09-24

Do wspólnego serialnego runnera dodano #123 (`c62f1d5990ec4806bba82d8fb33beda3`), profil `fem-cpu-slepc-modal-v1`, stan początkowy `queued`. Używa aktualnego snapshotu worktree: digest `c5768e4253f359e16e993af2d4a91ab1ae1a349f7713df1801c3d6d3eb5abeb0`, capture `6fcb48331d8e48028c1e42fea2da021a`, snapshot SHA `f05ba3d65e0cf3f0be98d01aabfa6a8fa1c6b0cd6d02bfeb75dbaab4304775af`, HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. W chwili zgłoszenia #122 nadal działał, więc #123 oczekuje w tej samej kolejce. Nie ma jeszcze terminalnego wyniku ani receipt dla bieżącego kodu; naukowy wynik nonzero-k nadal wynosi 0% kwalifikacji.
