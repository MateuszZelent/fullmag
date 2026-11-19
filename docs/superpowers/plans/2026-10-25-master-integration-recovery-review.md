# Przegląd integracji mastera i dwóch blokad recovery — 25.10.2026

## Bieżąca praca: wrapper i frontend WSL — 25.10.2026

Zatwierdzona finalizacja 743a85 jest zakończona, stare wyniki zachowane.
Przy przejściu do Universe ujawniono stale failed-stop journal po późniejszym
poprawnym drain oraz Windows-only reader w frontend refresh. Backend po
managed resume działa, lecz frontend odmówił startu; publiczny port 3203
nie jest obecnie potwierdzony. Universe Solve nadal nie wykonano.
Dokładny stan, scope i kontrole:
[przegląd poprawki wrappera](2026-10-25-managed-drained-successor-wrapper-refresh.md).
Poniższe checkpointy opisują wcześniejsze zakończone operacje.



## Aktualny checkpoint: recovery wykonane, API i inspekcja przywrócone — 25.10.2026

Po konkretnej zgodzie użytkownika wykonano request
`5101ae72214536a28d15cc95ca7b2286346ea7c3b94da6d06ccd244fbca39052`.
Native finalizacja exit 0: Failed/ExplicitOperatorRequest/DoNotRetry,
release proof `40b62697f875492002b9e7f19f8871cb4d0842b244b9957829c096fbaa662f12`,
slot zarchiwizowany, aktywne rezerwacje: 0. Sprawdzono 39 plików naukowych
przed/po apply oraz osobno 70/70 plików wcześniejszego wyniku i oba archiwa
FMS: bez zmian. Nie wykonano nowego Solve.

Managed stop-failed i resume zakończyły się kodem 0. Resume attempt
`ad9fea4b382849088ce7498d1d1f0234`; ten sam backend i frontend, zachowane
cache i storage, port 3203. Make 227585 ms; źródło pakietu
`e5c0576527a95d5a8656d2f3c4eb97eb096e3f38`, snapshot
`dca90ca3acdad2e9d0b8e32c43b56430c58a429165a24eaa75d3e1a52d1e9283`,
receipt `770c58fe8fe6f52a2281385cc3bd6fc1e8a96ffd91a619e2022d035f52532ab6`,
provenance `657d21c180826455770c5ae459842727217ebba77acf0dd49bca08af3fb4b9d8`.

Po starcie API było poprawnie dostępne, ale bez aktywnego workspace.
Kanoniczne zachowane FMS przeszło preflight i import visualization_only
(HTTP 200); odtworzono projekcję accepted definition tylko do odczytu,
nie pełny dawny stan authoringu ani checkpoint solvera. Status i scena
przez publiczny origin 3203: HTTP 200, dwa obiekty, jeden port i jeden
stage anteny. Restore class config_only i ostrzeżenia archiwum zachowano.

Rzeczywisty walidator accepted HTTP: 31 kontroli PASS — V/J/H niezerowe
i skończone, właściwe jednostki i SHA, ETag/Range, odrzucenie obcych pinów,
bez zmiany sesji, sceny i komend. V: 678 wartości, J cell-local: 22404,
H: 42 wartości (14 punktów). To stary zaakceptowany wynik inspection-only.

Dla quantity catalog należy jawnie wybrać runtime stage
`script-execution-2df97d99b6b88a3c58d0b135696e390a819e720b84d6311f4f6d0a62a8969bec`.
`data/quantities?stage_id=...` zwraca V_electric/J_charge/H_ant jako
requestable, stale_complete, historical inspection. Brak dostępności
w katalogu ogólnym oraz brak native stage_execution przy autorowym
inspect_loop nie są dowodem braku danych. Wcześniejsza hipoteza o luce
facade na tej podstawie nie została potwierdzona; nie zmieniano kodu.

Nie zastosowano B. Zwykły managed start po Failed/released przeszedł bez
tej poprawki. WebGL, rzeczywista prezentacja w UI, pełne Universe,
kwalifikowana baza LLG/FFT i odtworzenie publikacji nadal nie są odebrane.
Pełny zakres E0–E12 pozostaje nieukończony. Master f08fc7755 jest pobrany,
lecz niescalony. Dowody: `verification/approved-heartbeat-A-20261025/`
w wolumenie kontrolnym, w szczególności
`recovery-and-restoration-checkpoint.json`,
`restored-accepted-http-checks.json` i `post-apply-old-results-retention.json`.


To przegląd operacyjny lokalnej grupy, nie kwalifikacja naukowa ani zgoda
na automatyczne ponowienie Solve.

## Zakończona integracja

- origin/master: 28f4fcf5bba4387025944b8fb276c94b3eef5eb5.
- Merge na gałęzi anten: 250a7728ba7c24cb96d20468ae3fa457a860d555.
- Rozwiązano 28 konfliktów commitów i 6 konfliktów odtwarzanego WIP.
- Stash 26a563993c1914aea4c81d5a41d0f7ccd1e3fbdd i kopia kontrolna pozostają.
  Wszystkie 16 pierwotnych nieśledzonych plików są zachowane bajtowo.
- Managed build: exit 0, attempt 3898ce004d0a4400b1cae74df1ec7670,
  make 1228287 ms. Snapshot:
  1f22c9a855da6660de8c56d4a4a2f36404e5f435f65dc99bd8a1a78bc05f7b75.
- Pakiet promowany bez startu runtime: receipt
  84fcc386709def983cc3f3aaf6c42665012bea991e10920ec3d5883f632eb0e8.
  Poprzedni pakiet zachowano jako rollback.
- Managed OpenAPI/TypeScript codegen exit 0, Python generator check bez driftu.
  Pomocniczy typecheck po codegenie i lint pięciu warstw viewportu exit 0.
- 84 sprawdzenia funkcji projekcji PASS. Sam merge: 1181 testów
  interpretowanych PASS, 24 pominięte. Po przywróceniu WIP domyślna recepta
  wykonała 1195 testów, ale miała 12 błędów brakującego mpmath. Osobne
  19 testów oracle z jawnym, wcześniej przypiętym wheelem PASS.
  Domyślnej recepty bez zależności po WIP nie oznaczono jako zielonej.
  Następnie wdrożono jawny argument przypiętego wheela w tej samej
  zarządzanej recepcie: 1201 testów PASS w 83,682 s, 24 pominięte,
  exit 0. 42 kontrole skoncentrowane PASS; niezależny przegląd nie
  wykazał błędów wymagających poprawki. Nie instalowano mpmath globalnie.
- 70/70 plików wyników i oba archiwa FMS zachowane bez zmian.
- API pozostaje wyłączone. Nie uruchomiono nowego Solve. WebGL i pełna mapa
  Universe pozostają niezweryfikowane. Odbiór E0–E12 nadal 1/13.

## A. Zastosowany heartbeat bez trwałego ACK

Plik: crates/fullmag-api/src/failed_worker_recovery.rs.

Dokładny przygotowany patch SHA256:
34cd8b21e9a5276cd26f7c7743d996470b87a1c739d1e29f737647b3566e5400.

Propozycja dopuszcza dodatkowy stan inbox: wszystkie komendy zastosowane,
pending=None, dokładnie jeden końcowy Heartbeat109 bez trwałego ACK, podczas
gdy lease i ostatni ACK mają sekwencję108. Nie dopisuje ACK ani nie cofa inboxu.
Zachowane muszą pozostać wszystkie piny, wcześniejsze ACK, brak ukończonego
wyniku, Failed/DoNotRetry oraz zwolnienie dopiero po trwałej finalizacji.

Ryzyko: zmiana granicy integralności recovery dopuszcza stan, którego obecna
bramka nie akceptuje. Automatyczna kontrola odrzuciła jej zapis jako brak
jednoznacznej zgody na tę konkretną zmianę. Patch pozostaje niezastosowany.

Pełny wcześniejszy przegląd:
 /home/kking/git/storage/reviews/antenna-surface-applied-heartbeat-20261024/przeglad-pl.md.

## B. Zwykły terminalny błąd a raport native failure

Plik: crates/fullmag-api/src/accepted_study_supervisor.rs,
reconcile_durable_worker_exit_before_spawn.

Dokładny przygotowany patch SHA256:
ee8fc87ec3227290e2a53a153c439497d3993be6d409880ae886da7b8a74f98c.

Po połączeniu zmian każdy Failed w gałęzi już Released lease wymaga raportu
native failure, zanim dotrze do istniejącej obsługi zwykłego błędu z mastera.
Propozycja używa Some(decision) do wejścia w wyspecjalizowany replay.
None pozwala przejść do zwykłej obsługi; Err nadal odmawia. Dla rozpoznanego
raportu zachowane są jego walidacje i dokładny trwały DoNotRetry.

Ryzyko: zmienia to warunek replayu Failed bez raportu native. Automatyczna
kontrola odrzuciła zapis jako osobną zmianę bramki recovery, której nie
obejmuje samo polecenie integracji mastera. Nie zmieniono źródła nadzorcy.
Po zatwierdzeniu nadal wymagane są regresje odróżniające zwykły błąd,
poprawny raport, brak DoNotRetry i raport niepoprawny.

Patch i przegląd w wolumenie kontrolnym:
 verification/master-integration-20261025-28f4fcf5/supervisor-replay-proposal.patch
 verification/master-integration-20261025-28f4fcf5/przeglad-replay-pl.md.

## Ściśle ograniczona operacja po zatwierdzeniu

1. Zastosować zatwierdzone poprawki, zbudować je w tej samej grupie Docker
   WSL i przypiąć świeży request do nowego pakietu.
2. Wykonać native verify-only i negatywne kontrole; odmowa zatrzymuje dalsze
   działania. Nie omijać walidacji ani nie modyfikować journala ręcznie.
3. Finalizować wyłącznie run
   run-live-743a85ce65a3a257777cb73c1bf4a1c9f7f44563e6fa6b28b10b2651e9d9e5c0,
   task task-52cd4f16fd3b44c32a02519cbc059c1d722070a366adadb153a7c2b555fe7f95,
   attempt attempt-dad534dd37644e01be20a254b8fa75f1, epoch1:
   Failed/DoNotRetry, zwolnienie tylko jego rezerwacji i archiwizacja slotu.
4. Zachować częściowe wyniki, historię, pakiety, cache i archiwa.
   Zarządzaną procedurą przywrócić API i zapisaną scenę, bez automatycznego Solve.

## Stan blokady po trzech kolejnych turach

Blokada recovery pozostaje taka sama. Zweryfikowano brak API i workera,
receipt `failed_outcome_retained` o SHA256
`c1da239cd9af4422c86a1e4b14a875b268932c31096f29229737d822b4fda015`,
niezastosowany patch A i niezmieniony warunek patcha B. Nie ma żywego
buildu ani symulacji, na które można czekać. Niezależna weryfikacja po
scaleniu i przegląd zależności są zakończone. Dalszy odbiór rzeczywistej
ścieżki anteny wymaga decyzji w sprawie opisanych A/B; nie zastępujemy go
kolejnymi fixture ani zmianą definicji ukończenia E0–E12. Cel pozostaje
nieukończony, status `blocked`; następny krok to rozstrzygnięcie A/B,
a po zgodzie regresje, managed build i native preflight przed recovery.


## Korekta po niezależnym przeglądzie — 25.10.2026

**Patch B nie jest kompletną naprawą i nie powinien zostać zastosowany jako
rozwiązanie replayu operatora.** `reported_nonretryable_failure` zwraca `None`
tylko przy braku ostatniego zdarzenia albo ostatnim zdarzeniu innym niż
`Failed { retryable: false }`. Operator recovery zapisuje właśnie takie Failed,
lecz bez Completing, którego `validate_attempt` zabrania. Helper wymaga
Completing, więc B nadal propagowałby Err. Dodatkowo operator zapisuje
`ExplicitOperatorRequest` i ID `reaped-worker-failure-*`, a helper oczekuje
`WorkerDisconnected` i ID `reported-failure-*`. Nie należy usuwać tych
walidacji ani zamieniać dowolnego Err na None. Potrzebna jest osobna,
uwierzytelniona ścieżka odczytu istniejącego dowodu finalizacji operatora.

Przegląd A nie wykazał błędu w rozszerzeniu porównania inboxa; po zastosowaniu
nadal wymagane są wykonane przypadki pozytywne i negatywne. Nowa próba
zastosowania dokładnych A/B po poleceniu użytkownika „napraw wszystkie
napotkane problemy” została odrzucona przez automatyczną kontrolę jako
niewystarczająco konkretna autoryzacja zmian bramki recovery. **Żadnego
patcha nie zastosowano.** Poprzednia propozycja wspólnego zastosowania A/B
jest zastąpiona niniejszą korektą; nie stanowi gotowej procedury startu API.

Najbliższa konkretna decyzja dotyczy wyłącznie A (SHA256
`34cd8b21e9a5276cd26f7c7743d996470b87a1c739d1e29f737647b3566e5400`).
Nie obejmuje ona samodzielnie zwolnienia rezerwacji ani uruchomienia Solve.
Niezależny reviewer zakończył analizę tylko do odczytu; testów Rust nie
kompilowano.


## Zatwierdzenie i realizacja A — 25.10.2026

Użytkownik odpowiedział „Tak” na konkretne pytanie o patch A. Zastosowano
wyłącznie patch o SHA256 `34cd8b21e9a5276cd26f7c7743d996470b87a1c739d1e29f737647b3566e5400`.
Zarządzany build kandydata pracuje w istniejącym backendzie grupy; nie
promowano pakietu, nie uruchomiono API, nie zmieniono rezerwacji ani Solve.
Wynik buildu i native preflight pozostają w toku.

## Wymagany kontrakt poprawnego następcy B

Niezależny przegląd potwierdził dodatkowo konieczność rozpoznania
uwierzytelnionego replayu operatora **przed** `SupervisorSlot::acquire`: nowy
slot zajmuje tę samą ścieżkę zasobu co sprawdzany dowód, więc active+archive
zostałoby słusznie odrzucone. Obecna procedura nie utrwala request/completion
w SessionStore; archiwum zawiera owner slotu. Nie wystarcza to do ponownego
odczytu pełnego dowodu po restarcie.

Następca B powinien utrwalić niezmienny, ograniczony request przed
terminalizacją oraz potwierdzenie po dokładnym Failed/DoNotRetry, release
i archive. Hash surowych bajtów requestu i jego kanoniczny digest muszą
pozostać oddzielne. Odczyt użyje istniejącego
`HostResourceLedger::with_terminal_run_evidence_fence`, terminalnych
walidatorów request/journal/inbox/exit oraz wyłącznie archiwalnego ownera.
Brak lub niezgodność dowodu ma odmawiać; bez catch-all Err->None, bez
ponownego release, tworzenia slotu, retry ani Solve. Dane starego recovery
wymagają osobnego, jawnie przypiętego completion; nie wolno odtwarzać
autoryzacji wyłącznie z tekstu powodu. To kontrakt propozycji, **nie
zastosowany patch ani dowód runtime**.


## Weryfikacja wywołań i zawężenie naprawy — 25.10.2026

Poprzednie założenie, że B jest konieczne do startu API po recovery operatora,
nie było potwierdzone. Niezależny przegląd wywołań ustalił, że
`accepted_scheduler_main::recover_exited_worker_tasks` obsługuje wyłącznie
Running/Stopping; `resume_next_admitted_accepted_task_with_host` wyłącznie
Preparing/Ready, a `task_outcome_settled` uznaje Failed bez aktywnego lease
za zakończone. Nie wdrażamy spekulacyjnego następcy B ani nowego certyfikatu.
Najpierw weryfikujemy A, a po osobno autoryzowanym exact recovery rzeczywisty
managed startup. Dowód źródłowy: wolumen kontrolny,
`verification/approved-heartbeat-A-20261025/operator-replay-callers-review-pl.md`,
SHA256 `ef2e0467bb20d0d0d9c51f9ba2e5d3ebab5c535c2f81cd5b1c5c2448ec66d0ce`.
To analiza wywołań, nie dowód uruchomionego API.

Build A: exit 0, attempt `dce721b26fcc4f7f90614367a0f516ac`, Make 355574 ms.
Receipt kandydata `f29fe925cf173feb1dce461a43f599b229269b0f4b712a5c18a7a298b835bd42`,
snapshot `050490344a2c6fffa6ae1e51b239f2b63bf2da8108404b34dd56c6a599e56278`.
Pierwszy verify-only bez promocji został prawidłowo odrzucony: hash
executable różni się od aktywnej provenance. Nie obchodzimy tej ochrony;
wykonujemy managed promotion bez startu runtime, a następnie świeży preflight.

Na polecenie użytkownika pobrano origin/master:
`f08fc7755acdf742c5fdcbcb6ce5bec7c40abe48`. Jest to fetch; bieżący build
i jego snapshot poprzedzają kolejną integrację.


## Aktualny checkpoint: poprawka A zweryfikowana — 25.10.2026

Zatwierdzony patch A jest zastosowany. Managed build `dce721b26fcc4f7f90614367a0f516ac`
i promocja `77d8c6371b164f16980fa9a4df47f60f` zakończyły się kodem 0.
Aktualny receipt pakietu: `f29fe925cf173feb1dce461a43f599b229269b0f4b712a5c18a7a298b835bd42`;
provenance: `d9b1fa84e1b44c74910fe09e70426d2c001c2677149b119e0f0bd3265acc112e`.
API nie wystartowało; poprzedni pakiet zachowano jako rollback.

Native verify-only na rzeczywistym runie 743a85: exit 0, request SHA256
`5101ae72214536a28d15cc95ca7b2286346ea7c3b94da6d06ccd244fbca39052`.
Dziesięć requestów z niezgodnymi pinami zostało odrzuconych, 236 chronionych
plików runu/ledgera/runtime bez zmian. Nie wykonano apply ani nowego Solve.
Dowody: `verification/approved-heartbeat-A-20261025/` w wolumenie kontrolnym.
To weryfikacja bramki recovery, nie uruchomionego API, Universe ani kwalifikacja fizyki.

Oryginalna propozycja B jest wycofana jako niepełna; analiza wywołań nie
wykazała jej konieczności do zwykłego startup po dokładnym Failed/released.
Nie wdrażamy spekulacyjnego następcy B. Rzeczywisty startup po recovery
pozostaje do sprawdzenia; samą finalizację i release należy oddzielić od
zatwierdzonego zastosowania A. Odbiór E0–E12 nadal nieukończony.

Na polecenie użytkownika pobrano `origin/master` do
`f08fc7755acdf742c5fdcbcb6ce5bec7c40abe48`; fetch nie zmienia worktree.


## Konkretna operacja finalizacji po zweryfikowaniu A — 25.10.2026

Zatwierdzenie patcha A nie obejmowało finalizacji ani zwolnienia rezerwacji.
Niniejsza operacja jest przygotowana do odrębnej decyzji.

- Request SHA256: `5101ae72214536a28d15cc95ca7b2286346ea7c3b94da6d06ccd244fbca39052`.
- Request w wolumenie kontrolnym: `verification/approved-heartbeat-A-20261025/reaped-worker-743a85-native-preflight-c849ba0f-db07-4feb-ad3b-7a74a8a66231/request.json`.
- Run: `run-live-743a85ce65a3a257777cb73c1bf4a1c9f7f44563e6fa6b28b10b2651e9d9e5c0`.
- Task: `task-52cd4f16fd3b44c32a02519cbc059c1d722070a366adadb153a7c2b555fe7f95`.
- Attempt: `attempt-dad534dd37644e01be20a254b8fa75f1`, epoch 1.
- Pakiet: receipt `f29fe925cf173feb1dce461a43f599b229269b0f4b712a5c18a7a298b835bd42`, provenance `d9b1fa84e1b44c74910fe09e70426d2c001c2677149b119e0f0bd3265acc112e`.

Ponowny native `--verify-only` na niezmienionym request: exit 0. Ledger
ma dokładnie jedną niezwolnioną rezerwację, a jej identity jest identyczne
z przypiętym requestem. Task nadal Running/Reconciling; nie istnieje
wykonywany worker. Wcześniejsze dziesięć negatywnych requestów odrzucono,
236 chronionych plików pozostało identycznych.

Po zgodzie ta sama natywna procedura `--fail-reaped-worker`, z tym samym
requestem i SHA, lecz bez `--verify-only`, zapisze dokładny Failed oraz
ExplicitOperatorRequest/DoNotRetry, zwolni wyłącznie wskazany lease
i proof-backed host reservation oraz zarchiwizuje slot. Nie dopisze ACK,
nie zmieni inboxa, nie ponowi Solve ani nie usunie częściowych Zarr,
archiwów, wyników, historii lub cache. Odmowa dowolnego pinu zatrzymuje
działanie. Po ewentualnym niejasnym wyniku nie wolno automatycznie ponawiać:
najpierw należy odczytać trwały wynik i zastosować istniejące recovery.

Ryzyko: operacja nieodwracalnie zmienia status tej próby na Failed i
wycofuje jej przydział zasobów. Nie jest uznaniem wyniku za poprawny.
Uruchomienie API wymaga następnie osobnej zarządzanej kontroli startu;
nie ma gwarancji, że nie ujawni ona kolejnego problemu. Nowy master jest
wyłącznie pobrany; nie został scalony.

## Bieżący checkpoint: grupa odtworzona, próba Universe nieudana — 25.10.2026

Zarządzane odtworzenie grupy zakończyło się sukcesem: removal
`7d6f913f9349430ab78f5d81b721af56`, development
`8ea82405252446628c12e041485547c3`, konfiguracja
`60b3af127cc966b8bbe1add9addd7066ed75d10952dbfe082bf9f3190ecebfeb`.
Obie rzeczywiste usługi używają obrazu
`sha256:4b54ecd6b33649dda5532b6a185bc6e9547d077b80ac7bd7e159cf402a946b58`;
obraz dev-wrapper `b7a46c24…` był przygotowany, lecz nie jest obrazem
uruchomionego frontendu. API przez port 3203 odpowiada HTTP 200, usługi healthy.
Pakiet pochodzi z `a71b4c628dd8e9f9fc6916caf5e834a791eb5d25`, snapshot
`7bce56b94d281910c51ae984c916721e93f76c0656d0979f7993260fbca11c79`.
Wyniki wcześniejszej próby: 70/70 plików i oba archiwa FMS bez zmian;
ponowna walidacja publicznego HTTP V/J/H: 31 kontroli PASS.
Nie jest to dowód wizualny UI/WebGL.

Aktywacja skryptu Universe `84ad00cc34f0452c8145098a0cc59df3` zakończyła
się sukcesem z `wait_for_solve(True)`. Odczyt niezmiennego katalogu CAS
`47beccc34f358c02887cc18c157793657153e3d30d73ad77fd06302092fbc9bc`
potwierdził oddzielne źródło 677 węzłów / 1862 Tet4 oraz globalną domenę
1154 węzłów / 6503 Tet4 (4777 powietrza, 1726 przewodnika).
Manifest aktualnie wybranego source mesh nie opisuje całego Universe.
Nie wykonywano dodatkowego mesh_build. Budżet wejścia: 2148748 par < 4000000.

Po ponownym sprawdzeniu ready receipt i rewizji wysłano dokładnie jeden Solve:
`fm-20b49703-375a-4cf1-8eb6-4ce2fca64a0f`, client intent
`antenna-universe-surface-20261025-solve-01`, HTTP 200 accepted.
Run `run-live-ace433241f22879d2bc6fc8c5df1b24368fb4f68ecbd973799ec8e3460ab1992`,
attempt `attempt-3519d1b2bee5418d8b17784621fd4fb0`, ownership epoch 1.
Próba zakończyła się Failed, retryable=false, bez opublikowanych artefaktów:
`surface RT0 wall-time exhausted`. Zdarzenie terminalne: sequence 340,
`5948bf8fe8e742428caf3bcde5b7fbdd`, raw SHA256
`767c07d08a4c3774d200f4d16771a0ac6575d714fdee2a04330e46b01cf4a4fd`.
Worker exit 1, timed_out=false w receipcie procesu: limit zgłosił natywny
moduł, nie zewnętrzny watchdog. Proces nie istnieje; kolejka jest pusta,
obie rezerwacje tej próby (preparation/compute) są released. Nie ponowiono Solve
ani nie zwiększono limitów. Nie ma nowej mapy H do pokazania w UI.
Kontrola przed buildem: 70/70 wcześniejszych plików i oba archiwa bez zmian,
sześć niezmiennych plików wejścia/dowodów tej próby przypięto SHA256.
Raporty: `failure-checkpoint.json` i `pre-build-retention.json` w katalogu
`verification/universe-surface-trial-20261025/`.
Dowody: `verification/universe-surface-trial-20261025/` i
`verification/wrapper-refresh-20261025/` w wolumenie kontrolnym grupy.

Ponowny fetch potwierdził `origin/master`
`f08fc7755acdf742c5fdcbcb6ce5bec7c40abe48`; nie został jeszcze scalony.
Integracja nastąpi po terminalnym rozstrzygnięciu tej próby. E0–E12 pozostaje
nieukończone: wykonanie próby nie oznacza kwalifikacji bazy, LLG/FFT ani BORIS.

Integracja źródeł mastera została następnie zapisana w merge
`3babed412bf8af3ac681f3ea3a920b535085052b`; zgodność ze współdzielonymi
typami w `db4e2da2e2b13303edb0db6f5af61af269442dc8`. Bieżący plan
realizacji rozróżnia tę integrację od oczekującego buildu i GREEN zapisu anteny.
