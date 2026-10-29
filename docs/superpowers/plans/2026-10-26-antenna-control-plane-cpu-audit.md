# Antena Universe: narzut control plane podczas obliczenia

Data pierwszego pomiaru: 26.10.2026. Aktualizacja: 27.10.2026.
Status: audyt i częściowa poprawka z managed buildem; pełna wydajność solvera niezaliczona.
Źródła bazowe: 67133cfb393e7bd39df235cd396bc5d43354f8a8 z lokalnym WIP;
nie przypisujemy zmian źródeł działającemu pakietowi bez manifestu buildu.

## Rzeczywisty pomiar

Dla trwającego run-live-62d110763485b10e2512922267a1aed284996710852d4fd27cb3f4ad71a1e496
zebrano dwie próbki /proc i cgroup w odstępie 5,00697 s. Obserwacja końcowa:
Unix ms 1793054796451, kontener backend 3680d47bc74a. cpu.max wynosi
400000/100000, czyli 4 CPU. Przyrost usage_usec=19963440 oznacza około
3,987 CPU wykorzystania całej grupy. Wszystkie 50 okresów były throttled;
throttled_usec wzrósł o 8355101. Ten ostatni licznik nie jest opóźnieniem
samego solvera: obejmuje grupę i nie wolno odejmować go od czasu native.

| Proces | Rola | Zużyte CPU w oknie, w jednostkach rdzenia |
|---|---|---:|
| 5124 | accepted worker obliczenia | 1,412 |
| 4054 | accepted compute scheduler | 1,230 |
| 4055 | accepted FEM preparation scheduler | 0,493 |
| 4031 | API | 0,719 |
| 4045 | runtime service | 0,088 |

Osobna próbka wykazała RSS workera około 543 MB, cgroup około 3,59 GB
przy limicie 8 GiB. memory.events nie zmieniło się w pięciosekundowym oknie;
liczniki historyczne mogą obejmować wcześniejszy build. Brak nowego OOM w tym
oknie nie dowodzi braku wszystkich wcześniejszych ograniczeń pamięci.
Nie zwiększono CPU/RAM, nie zmieniono affinity i nie zatrzymano procesów.

## Potwierdzone ścieżki kosztu w źródłach

1. `crates/fullmag-api/src/accepted_scheduler_main.rs::main`:
   pełna rekonsyliacja/discovery/kolejka/recovery poprzedza aktywny sleep 10 ms.
   Domyślny idle_poll_interval 100 ms nie ogranicza aktywnej ścieżki.
   Kolejka ma jednak prefilter Running; nie twierdzimy, że compute scheduler
   na pewno loweruje aktualne obliczenie w każdej iteracji.
2. `crates/fullmag-runtime-control/src/host_runtime.rs` — ścieżki tentative,
   released i cancellation reconciliation odczytują ledger i skanują runy.
   `crates/fullmag-session/src/host_resource_ledger.rs::read_observation_snapshot`
   waliduje cały snapshot, w tym historyczne release proofs. Nie wyłączamy
   tej walidacji ani nie zastępujemy jej niesprawdzonym cache safety.
3. `crates/fullmag-api/src/live_accepted_projection.rs::load_durable_projection`
   ma szybki powrót dla niezmienionego nieaktywnego runu. Running dochodzi do
   `crates/fullmag-runtime-control/src/study.rs::load_accepted_study_snapshot`,
   odczytów immutable CAS/assets i canonical lowering. Poll ma 500 ms.

To ścieżki kodu zgodne z pomiarem procesów, nie profil stosów ani dowód
procentowego kosztu pojedynczej funkcji. W szczególności nie uznajemy samego
narzutu control plane za pełne wyjaśnienie kosztu całkowania pola.

## Kolejność naprawy i kryteria

1. Zachować szybką obsługę Stop, timeout, heartbeat i reap. Oddzielić pełne
   discovery/admission pass zgodnie z istniejącym interwałem; przed każdą
   rzeczywistą mutacją/admisją wykonać świeże wymagane fences i rekonsyliację.
   Wymagane testy: nowy run przy zajętych slotach, zwolnienie slotu, cancellation,
   drain, recovery, konflikt writer i granice opóźnienia. Nie wystarczy zmienić sleep.
2. Zaprojektować ograniczony cache zweryfikowanego immutable snapshotu/loweringu.
   Bieżące katalogi, lifecycle, sidecary i binding sesji nadal czytać. Uzasadnić
   klucz i invalidację; nie cache'ować bieżącej polityki zasobów ani capability
   resolution jako niezmiennej. Cold-load i uszkodzone wejścia muszą pozostać
   wykrywane właściwymi bramkami.
3. W osobnym etapie porównać równe okna CPU/throttling oraz identyczne wyniki,
   source identity i protokół wykonania przed/po. Build i runtime wyłącznie
   przez managed Docker DEV tej grupy, po terminalnym stanie obecnego Solve.
   Czas pola i jego profiler nadal wymagają oddzielnej analizy.

Nie wdrożono powyższych optymalizacji. Obecna próba pozostaje aktywna i nie
została ponowiona. Oddzielny WIP timestampów etapu używa małego cache journalu
per run/task/attempt/epoch/lifecycle, aby sam heartbeat nie dodawał pełnego
odczytu journalu. Nie jest to jeszcze cache całego zaakceptowanego Study.

## Dowody i ograniczenia

Wolumen kontrolny grupy, katalog verification/antenna-solve-telemetry-20261026/:
current-worker-resources.json, current-worker-resource-delta.json,
actual-stage-journal-observation.json. Ostatni raport journalu korzystał
z istniejącego współdzielonego natywnego flock, bez zmiany ownera; katalog
był identyczny przed/po odczycie. 714 Event zajmowało około 2,52 MB;
łącznie z Commands dziennik miał około 5 MB. Odczyt pod fence trwał 0,112 s.
To obserwacja diagnostyczna, nie wykonanie przyszłego kodu Rust.
Pełne V/J/H, końcowe API, cold-load i widok H w Universe pozostają niezaliczone.

## Stan po zakończeniu próby

Powyższe pomiary opisują datowane okno aktywnego workera. Próba zakończyła się
26.10.2026 23:09:49.895 UTC jako Failed (surface RT0 wall-time exhausted,
budżet 10800 s); nie jest już aktywna. Nie uzyskano profilu faz, ponieważ
opt-in profilera nie był włączony. Nie wykonano optymalizacji schedulerów.
Managed build statusu cb64d7ff17f144739d78745a9483d16a zakończył się sukcesem;
nie stanowi benchmarku ani dowodu poprawy wydajności operatora.


## Bezczynność po buildzie i minimalny prefilter — 27.10.2026

API odpowiada 200, ale nie ma aktywnej sesji. Okno 5,00737 s zakończone
Unix ms 1793058762557 wykazało około 1,78 rdzenia całego backendu, bez nowego
throttlingu: compute scheduler 0,961, preparation scheduler 0,607, runtime 0,124,
API 0,008 rdzenia. Dowód: `verification/antenna-solve-telemetry-20261026/idle-after-build-resources-20261027.json`.
Pamięć anonimowa wynosiła około 812 MB, cache plików około 7,35 GB;
nie należy interpretować całego cgroup usage jako sterty procesu.

Audyt 38 runów znalazł 18 Succeeded, 11 Failed, 7 Cancelled, 2 Accepted/HELD
i zero Preparing. Dla każdego wolnego zasobu `scheduler.rs::resume_next_admitted_accepted_task_with_host`
ładował intent przed sprawdzeniem katalogu: z kodu wynika 76 odczytów,
54 397 026 B na ukończony przebieg. Nie jest to zmierzony licznik wywołań ani
przypisanie całego CPU do tej funkcji. SHA źródła i cienia skompilowanego buildu
były identyczne: `63ca93dbf5158d8d874594c9d549f35a48c1cde0b4923d6bacf9a6228b9b6913`.

W worktree zastosowano wyłącznie przesunięcie istniejącego filtra katalogu
przed odczyt intentu. Predykat pozostaje ten sam: Preparing, Ready, dokładny
resource, obecne attempt i epoch. Dalsze sprawdzenia manual Start, claimu,
admission, host binding, pending launch, inbox i journalu są niezmienione.
Wcześniejsze uzgadnianie tentative/released/cancellation nadal działa.
Nie zmieniono interwałów, limitów, polityki ledgera ani cache jego walidacji.

Jawna zmiana diagnostyczna: ta gałąź odkrywania nie czyta intentu poprawnie
wykluczonego katalogiem; uszkodzony katalog HELD może zgłosić błąd wcześniej.
To nie jest pominięcie walidacji zadania dopuszczanego do startu.

Dodano rzeczywisty test Rust `host_runtime::recovery_tests::accepted_recovery_filters_catalog_before_reading_immutable_intent`:
Queued z brakującym/uszkodzonym/nietypowanym intentem daje None; dokładny
Preparing musi zgłosić błąd tego wejścia, z zachowaniem katalogu i rezerwacji.
Istniejący test wymogu manual Compute release pozostaje niezmieniony.
Testów Rust nie kompilowano ani nie uruchamiano zgodnie z instrukcją projektu.
15 interpretowanych kontroli struktury/predykatu przeszło; nie zastępują testu Rust.

Dowody i patche: `verification/idle-scheduler-prefilter-20261027/` w wolumenie
kontrolnym grupy. Produkcyjny patch SHA256
`5d8dbfeeb9c93aeca6f47d225931b48a019f60768976d4446251b58e607ee46e`;
test patch SHA256 `335f589b6a8a40e4b6b7ce6b301fda5cbed06d84f9276c7239540027d87a9e5e`.
Stan bezpośrednio po edycji: WIP bez managed buildu i pomiaru po zmianie.
Poniższy checkpoint aktualizuje ten stan; nie deklarujemy przyspieszenia RT0.


## Managed build i pomiar po prefilterze — 27.10.2026

Istniejąca recepta `just docker-dev-restart-idle` z bazową próbą development
`0743c2f8394340f0811cb31f3795ce25` zakończyła się sukcesem. Nowa iteracja:
`527a61291dea4f778bf73e2133d44dcf`, Compose config
`32366b722187be889f86ead5413237ee9018217f71d7c0c3af34780039eb51a1`.
Źródło: `1151267378d39d60c316a0ac87b849bcafc1eb8c` + jawny WIP;
snapshot `11cbae6e0f91fa615dc44508ebff08124caf78b49f4643d5b4d1d14c019f9a25`.
Receipt SHA256 `db5a1542e087036593b901b2ec0cb3ea64861d0d6c9a77998bd00ff9436001e0`,
czas całej operacji 662,880 s. Make exit0 trwał 369340 ms; zbudowano pakiet
24 plików, a jego końcowa weryfikacja zakończyła się exit0. Obie usługi zachowały
te same kontenery, obraz, cache i wolumeny. Nie wykonano nowego Solve.

Jedno wcześniejsze błędne wywołanie podało iteration cb64 zamiast development
0743; odmowa Control-volume read failed nastąpiła przed zatrzymaniem usług.
Nie mylimy tego identyfikatora z błędem kompilacji. Po właściwym starcie
obserwacja runtime była przejściowo nieznana i wróciła po 9 s.

API przed i po trzech nowych oknach ma health=ok oraz active_session=false.
Limit pozostał 4 CPU i 8 GiB RAM. Każde okno miało około 5,005 s:

| Proces / cała grupa | Wcześniejsze okno | Nowe trzy okna, rdzenie CPU |
|---|---:|---|
| Compute scheduler | 0,961 | 0,679; 0,667; 0,697 |
| Preparation scheduler | 0,607 | 0,561; 0,569; 0,561 |
| Cały cgroup | 1,780 | 1,292; 1,840; 1,788 |

Obciążenie samego compute schedulera zmalało w tych oknach. Cały backend nadal
ma duży narzut; dodatkowe procesy odczytowe oraz presja hosta mogły wpływać
na pomiar grupowy. Nie wybieramy najlepszego okna jako wyniku całej aplikacji.
To nie jest statystyczna kwalifikacja ani benchmark faz RT0. Równania,
tolerancje i budżety naukowe nie zmieniły się. Pozostałe ścieżki historycznej
rekonsyliacji wymagają osobnej analizy z zachowaniem ich dowodów bezpieczeństwa.

Wszystkie 38 lifecycle pozostały: 18 Succeeded, 11 Failed, 7 Cancelled,
2 Accepted/HELD, zero Preparing. SHA run_intent/run_catalog/start_release
pełnej próby są identyczne jak przed buildem; Failed i brak artefaktów zachowano.
Pamięć anonimowa wynosiła około 702 MB, pliki cache około 6,87 GB;
nie zarejestrowano OOM. Testu Rust nadal nie kompilowano ani nie wykonywano.

Dowody w control volume, `verification/idle-scheduler-prefilter-20261027/`:
`applied-source-parse.json`, `runtime-after-prefilter.json`, `retention-after-build.json`.
Package pozostawił current + trzy backupy po około 2,82 GB, zero candidates
oraz retired. Zachowano wszystkie generacje, bez cleanup/cache deletion;
brakujący build-stage-cleanup skill i nadmiar rollbacków pozostają jawną luką
retencji, nie dowodem ograniczonego zużycia storage.
