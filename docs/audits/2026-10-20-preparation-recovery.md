# Recovery przygotowania symulacji — master, 20.10.2026

## Bieżący checkpoint po integracji

Aktualizacja 21.10.2026: bezpośredni odczyt potwierdził HEAD
`8a290d6e5e425f0bd42a38db6734148a0b66bfdb` oraz działający kontener backendu
`c007e2f1e113`. Docker HostConfig: Memory=137438953472 (128 GiB),
NanoCpus=16000000000 (16 CPU), MemorySwap=146028888064 (136 GiB łącznie,
czyli 8 GiB swap ponad RAM). Właściciel lifecycle przekazał receipt
`174138824a3d4777a9834b165f500b53` ze stanem succeeded i potwierdzenie cgroup;
tego receiptu nie odczytywano niezależnie w tym kroku. Według jego checkpointu
ten sam PID 7 nadal sprawdzał stare kopie przed API (6/14), bez replay/retry/Solve
runu 04. Zwiększenie limitów nie jest dowodem READY ani wdrożenia nowego helpera
do już uruchomionego procesu. Odbiór runtime i okna nadal pozostaje otwarty.

Zmiany zostały zachowane w checkpointcie `5c072bd16628354060ff5b1c2345e24013e1039c`
i merge `b724373654c95ea73ea058738a09bd90cc5e7441`. Porównanie objętych tym
zadaniem plików pomiędzy checkpointem i merge nie wykazało różnic.
Następny managed build używa HEAD `d2a4bdfb7a685da587954f1dbb57ea828f8a4e6b`.
Backend `c007e2f1e113b82deaf205cc9cf1e2a97d45ed63d5a454e57d911ceb16935d26`:
dwa odczyty 9143 plików zakończone poprawnie, capture 256106 ms,
sync 8607 ms. Bezpośredni odczyt logu potwierdził `make` exit 0
po 217249 ms oraz pakiet 24 plików po 2289 ms. Gotowość API tej próby
pozostaje niepotwierdzona; poniższe starsze próby zachowano jako historię.

Limity nowej generacji frontendu ponownie potwierdzone odczytowo:
`31f1035340db9d12ec8252f424ed7521c1d463c6e8bdb02bd0e933f71cbc0e12`,
image `sha256:fec961feca1292383edf6fb4104b36c4eb55ca1c0458b6746b57b140822fb978`.
Docker i cgroup: 17179869184 bajtów RAM, 4 CPU (`cpu.max=400000 100000`).
Rzeczywiste procesy Next PID 28/44 mają old space 6144 MiB.
Ten odczyt nie dowodzi dostępności API ani wykonania symulacji.

Kolejny ustalony bloker startu: po publikacji poprawnego pakietu proces
`backend_dev` synchronicznie waliduje 14 kopii rollbacku w
`_retain_package_backups`, zanim wejdzie do `_serve`. Odczyty FD/IO
potwierdzają postęp po kolejnych plikach i kopiach; API nie zostało jeszcze
uruchomione. Statyczny trace nie wykazał rekurencyjnie zagnieżdżonych kopii:
to oddzielne katalogi, każdy ponownie hashowany. Próba zwolnienia cache RAM
przez właściciela lifecycle nie wykazała istotnej poprawy i nie potwierdza
cache jako głównej przyczyny opóźnienia.

Właściciel launchera zapisał minimalną poprawkę w
`01cb8ed197e066fd25d2d9db26c52d6bf9d3d154`: opcjonalna retencja nie blokuje
startu; wszystkie kopie pozostają, a obowiązkowa walidacja aktualnego
pakietu w `_serve` jest zachowana. Kontrola składni i review przeszły.
Bieżący proces wykonuje jednak wcześniej załadowany helper, więc ten
commit nie jest dowodem wdrożenia zmiany do tej operacji. Nadal otwarte:
READY API, widoczny odtworzony failed preparation resource w przeglądarce,
checkpoint braku nowego launch/exit/start_release przed jawnym retry oraz
runtime scenariusza odroczonej finalizacji. Nie deklarujemy ukończenia
całego zadania na podstawie samego poprawnego buildu.

## Cel i stan

Cel użytkownika: aplikacja pozostaje dostępna po błędzie przygotowania, finalizacja
wraca do działania automatycznie po chwilowej blokadzie, a recovery nie uruchamia
drugi raz preparera ani Solve.

Checkout: `C:\git\fullmag\fullmag`, branch `master`, bazowy HEAD
`42d92610312871d591db16a5b60a8f7a6d6339b5`. Współdzielony dirty checkout:
zmiany innych zadań pozostają zachowane. Ten dokument opisuje stan roboczy;
nie jest potwierdzeniem wdrożenia ani kwalifikacji runtime.

## Ustalony incydent

- Request `master-permalloy-rings-20261020-c1fd-04`, run
  `run-live-9c179751e74f74e1dfadd5c244c7e956d7b406945753262e25c8cc169a300dd2`.
- Preparer zakończył się kodem 1. Scheduler następnie zakończył pracę na
  `reading preparation resource lease: No such file`.
- Lease żądania istnieje i ma stan Released, sequence 41. Dokładnego wiersza,
  którego dotyczył odczyt ENOENT, nie ustalono. Nie jest to dowód trwałego braku
  lease; błąd mógł wystąpić między sprawdzeniem metadanych a otwarciem pliku.
- stdout/stderr procesu były przetrzymywane do zbiorczego podsumowania
  schedulera. Po błędzie podsumowanie nie powstało. Utraconego stderr starej
  próby nie odzyskano; pierwotna przyczyna exit 1 pozostaje nieustalona.
- Przyjętego żądania nie wolno automatycznie wysłać ponownie.

## Zmiany źródeł

1. `crates/fullmag-session/src/store.rs`,
   `read_preparation_resource_lease`: wyłącznie typowany błąd IO NotFound
   z wieloetapowego odczytu uruchamia jeden ponowny, pełny bounded read pod
   istniejącym reentrant STORE writer. Walidacja ścieżki, symlinków, rozmiaru
   i tożsamości pozostaje obowiązkowa. Rzeczywisty brak nadal zwraca None;
   uszkodzenie dokumentu nadal jest błędem.
2. `crates/fullmag-api/src/accepted_fem_preparation_supervisor.rs`:
   po zaobserwowanym i potwierdzonym zakończeniu procesu chwilowy, typowany
   StoreWriterBusy może zwrócić `TerminalPreparationFinalizationPending`.
   Jego metoda `resume` ponawia zapis dokładnie tego samego exit receipt,
   jeśli nie jest jeszcze trwały, a następnie jego finalizację. Istniejący
   receipt musi być identyczny. Nie ma ścieżki spawn.
   Nieznany wynik uruchomienia, brak proof i błędy walidacji nie kwalifikują
   się do tej ścieżki. Utrata procesu schedulera przed trwałym zapisem exit
   nadal pozostawia wynik niepotwierdzony; recovery nie zgaduje zakończenia.
3. `crates/fullmag-api/src/accepted_fem_preparation_scheduler_main.rs`:
   podczas takiej odroczonej finalizacji scheduler zachowuje zajęty slot zasobu,
   tożsamość lease i dane checkpointu. Nie przekazuje zasobu nowej pracy.
4. Supervisor zapisuje `preparation_process_observed.v1` do stderr przed
   fallible persistence/finalization. Runtime kieruje stderr do pliku logu;
   stdout zachowuje pojedynczą odpowiedź JSON także dla one-shot CLI.
   flush ogranicza utratę diagnostyki przy zwykłym zakończeniu procesu.
   Nie stanowi to gwarancji fsync przy utracie zasilania.
   Nowy event zawiera najwyżej po 64 KiB tekstu stdout/stderr, wraz z
   `total_bytes` i `truncated`. Istniejące czytniki procesu nadal zbierają pełne
   wyjście w RAM; ograniczono dodatkową alokację i rozmiar nowego eventu.
5. Nieudany exit receipt zachowuje końcówkę stderr wraz z krótkim opisem;
   całość ma najwyżej 4096 bajtów, z zachowaniem granic UTF-8 i redakcją
   dokładnego lease token.

Pozostaje istniejąca autoryzacja kolejnej próby:
`SessionStore::preparation_attempt_authorization_sequence` i
`preparation_candidates`. Finalizacja nie jest ponownym wysłaniem polecenia.

## Koordynacja i zakres dodatkowy

Drugi czat posiada operacje lifecycle grupy `fullmag-master`, naprawę technicznej
reconciliation starej próby oraz plik `development_accepted_restore.rs`.
Oba zadania uzgodniły jedną wspólną przebudowę i odtworzenie usług.

W trace wykryto osobny problem: Held run po błędzie przygotowania może przy
restore utracić `accepted_preparation.status=failed` i pokazać
`waiting_for_compute`. Start gate nadal chroni przed automatycznym Solve,
ale read-model gubi przyczynę. W uzgodnionym zakresie dodano wariant
`load_held_preparation_failure` w `development_accepted_restore.rs`.
Kosztowne dekodowanie Study i obliczenie fingerprintów odbywa się bez STORE
writer. Następnie pod guardem ponownie porównywany jest pełny RunIntent
z walidowanym snapshotem. W tej sekcji sprawdzane są planned/enabled step,
task input fingerprint, brak claimu, nierozstrzygnięty failure bez autoryzacji
retry, dokładny failed exit, matching launch oraz Released lease o zgodnej
sekwencji heartbeat. Aktywne lease i istniejący sukces przygotowania blokują
ten wariant. Nie wyprowadza błędu z ogólnego failed runtime owner.

Tylko tak potwierdzona porażka pomija wymaganie success anchor i projekcję
gotowej siatki. Read-model sesji/runu ma stan failed i
`accepted_preparation.preparation_status=failed`. Oryginalny RunIntent, katalog
zadań i zamknięta bramka startu nie są zmieniane. Zwykłe udane przygotowanie
nadal przechodzi dotychczasową walidację anchor/task/stage.

## Weryfikacja i brakujące dowody

- PASS: `git diff --check` plików recovery i odtwarzania sesji.
- PASS: parser rustfmt, `--emit stdout --config skip_children=true`;
  brak zapisu plików i brak kompilacji.
- Dodano źródłowe regression checks dla klasyfikacji typowanego writer busy,
  tożsamości receipt, limitu UTF-8 i zachowania/redakcji stderr.
  Testów jednostkowych nie uruchomiono zgodnie z obowiązującym zakazem.
- PASS: build aplikacji w stałym backendzie `fullmag-master`, target
  `install-cli-dev`; pakiet przeszedł verify-complete (24 pliki), bramki
  `windows-folder-v1` i `worker-cgroup` zakończyły się poprawnie.
  Runtime: `0.1.0-dev.20261020.g42d926103128.dirty.sf1da3fe0b3b3+9789`,
  source snapshot
  `f1da3fe0b3b3c42dbe0c64048c7e718703cacd3ee057b537142736e34435df2e`,
  build `2026-10-20T18:41:31Z`.
- NOT VERIFIED: gotowość API — pierwsza próba po buildzie nie osiągnęła
  READY. `make` zakończył się exit 0 po 173149 ms, ale API PID 3467
  pozostawało bez portu przez 60 s i supervisor zakończył je SIGTERM
  (exit -15). Nie stwierdzono paniki ani błędu Rust w stderr.
  Native runtime service jeszcze nie wystartował.
  Sam poprawny build nie zamyka zadania.
- NOT VERIFIED: zachowanie API/schedulera po nowym kontrolowanym błędzie,
  contention ponad 5 sekund i brak drugiego procesu.
- NOT VERIFIED: zachowanie błędu Held przy restore.

Checkpoint źródeł przekazany do wspólnego review/buildu (SHA-256):

| Plik Rust | SHA-256 |
| --- | --- |
| `accepted_fem_preparation_supervisor.rs` | `f183f98d434d273bbaab4ed4b6c6b162c26354bb75fda3ba2c84ab2356d7c834` |
| `accepted_fem_preparation_scheduler_main.rs` | `e05f0a6c36f8b5b93a54bf7d0afb23a277b40d1010a2cb80aec9d990a968225a` |
| `development_accepted_restore.rs` (wspólne zmiany) | `99b6d11bb5463380eb979060ce7bb1109bca7d476d6f98fd23cbf0b003ad3b79` |
| `fullmag-session/src/store.rs` | `dcbfa1dd05b15805899443f84512354f27a1965cc20a231ffaf4c662bc5aead6` |

Po tej próbie dodano wyłącznie diagnostykę etapów pre-listen w restore:
statyczna nazwa etapu, start/complete/incomplete i elapsed_ms na stderr.
Obejmuje odczyt wejścia/proof, walidację buildu, immutable Study, STORE
snapshot, projekcję i ack. Nie zapisuje payloadów ani sekretów, nie zmienia
walidacji. Nowy SHA-256 `development_accepted_restore.rs`:
`21c2a92c9271050ae006af8a2dfefe86024271c841a667dc526b2da85bc9f98d`.
Parser i diff check PASS; ta wersja diagnostyki oczekuje na kolejny managed build.

Kolejna próba: backend `3faec05b8835`, source capture pass 1/2
191178/166966 ms, capture-complete 358357 ms, sync-complete 9123 plików
w 3804 ms; rozpoczęto `install-cli-dev`. Osobny właściciel launchera dodał
ograniczony budżet pre-listen 300 s tylko dla zwalidowanego accepted reattach
i komunikat postępu co 10 s. Zwykły start zachowuje dotychczasowe maks. 60 s.
Źródło opóźnienia samego API nadal wymaga dowodu z nowych checkpointów.

Ta kolejna kompilacja i weryfikacja pakietu również przeszły, lecz
`entrypoint.py -> accepted_reattach_preflight` odmówił jeszcze przed spawn API:
`accepted-run current terminal record differs from immutable backing evidence`.
Dotyczy porównania bieżącego rekordu zakończenia z historycznym dowodem
przypiętym do recovery. Nie uruchomiono nowych checkpointów Rust.
Właściciel launchera analizuje powiązanie kolejnych zakończeń; walidacji
nie pominięto. Weryfikacja gotowości aplikacji nadal pozostaje otwarta.

Kryteria odbioru runtime: API pozostaje dostępne po błędzie preparera;
diagnostyka jest zapisana; dokładna lease kończy się Released po ustąpieniu
blokady; liczba launch/process dla tej próby nie rośnie podczas finalizacji;
ponowne Solve wymaga osobnego polecenia. Stare request 04 nie jest fixture
do powtórnego uruchomienia.

### Projekcja błędu do okna przygotowania

Trace konsumenta wykazał dodatkową lukę: sam marker
`metadata.accepted_preparation` nie jest częścią cienkiego `LiveStatus`.
Przy `simulation_preparation: None` i revision 0 okno nie pokazywało
konkretnej awarii. `build_snapshot` publikuje teraz istniejący
`SimulationPreparationSnapshot` z revision 1; dotychczasowy endpoint
preparation i hook odczytują go bez nowego schematu lub endpointu.

To projekcja zwalidowanego failed exit: ID próby, czas z durable launch
i exit, status failed, requested execution ze snapshotu sesji, resolved
pozostaje nieustalone. `domain_preparation` jest wyłącznie etapem zbiorczym
z etykietą „Preparation process” i jawną informacją, że wewnętrzny etap
awarii jest nieznany. Nie dopisano potwierdzeń ukończenia ani czasów
poszczególnych etapów. ID exit receipt jest w opisie/logu;
`diagnostics_correlation_id` pozostaje null, ponieważ nie utworzono
odpowiadającego zasobu diagnostyki. Projekcja nie zmienia katalogu,
Start gate ani autoryzacji retry.
Jeżeli zwalidowanych awarii jest więcej, komunikat podaje ich liczbę,
a bounded log (maks. 200 wpisów) zachowuje własne task/attempt/receipt ID
i czas zakończenia każdej przedstawionej próby. Główny snapshot pozostaje
przypięty do pierwszej obserwacji; nie tworzy zbiorczej fikcyjnej próby.

Parser Rust i diff check: PASS. Dodano źródłowy regression check
tożsamości, historycznych czasów, braku fikcyjnych completed stages
i odrzucania brakującej obserwacji. Test nie został uruchomiony ani
skompilowany zgodnie z obowiązującym zakazem. Build/runtime/browser
tej projekcji oczekują na wspólną próbę.

## Limity frontendu — osobne wdrożenie

Źródła ustawiają frontend na 16 GiB RAM, 4 CPU i Node old space 6144 MiB.
Przygotowanie obrazów ukończone w grupie `fullmag-master`, exit 0:

- dev attempt `2efd804ce1e94e2bb23c8c31f8e33e71`,
  image `sha256:9fa50dedd0143248670625671205979eb4913818192afbb1365e85960fad50fb`;
- backend attempt `fe61b296088a43ec8c916eaa7d2e7f3e`,
  image `sha256:dffb31c9ea100873e08271843cc5ecc00cb101feb59a0fcb7a01483f2e7ac495`.

Odbiór limitów po zarządzanym odtworzeniu: **PASS**. Nowy running frontend
`a977d68e3b74c60df5dcc5cadd0f4e7791a6bb1eed65bf1672d7c6ab07abc69e`
używa obrazu backend `dffb31c9…` zawierającego nowy helper frontendu.
Docker inspect zwrócił `Memory=17179869184`, `NanoCpus=4000000000`.
Cgroup ma `memory.max=17179869184`, `cpu.max=400000 100000`.
Rzeczywisty Next PID 27 ma `NODE_OPTIONS=--max-old-space-size=6144`,
a next-server PID 43 ma
`--max-old-space-size=6144 --enable-source-maps --inspect=127.0.0.1:0`.
Old space nie jest całkowitym RSS procesu. Pierwszy HTTP check miał timeout
podczas niegotowego backendu; ten odczyt nie potwierdza gotowości aplikacji.
Wolumeny/cache zachowano; nie wykonywano usuwania danych.

Powtórzenie odbioru limitów po kolejnej, powyższej rekreacji: **PASS**.
Frontend `e1a04f452f84c610135ea6b43c1bf641af118eaa48dfcd2fd902c4ad588d2fff`,
obraz `sha256:e30f3cf928e9b970f4963b41b51faad1a6fe2776832c5bebc102f6fd18dd08f3`.
Inspect/cgroup i NODE_OPTIONS PID 27/43 zwróciły te same wartości
16 GiB / 4 CPU / 6144 MiB old space. Dowód dotyczy nowej generacji kontenera.
