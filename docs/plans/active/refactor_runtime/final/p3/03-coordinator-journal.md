# P3-B — durable coordinator journal

`fullmag-session` przechowuje kontrolne wpisy
`coordinator_journal.v1` pod:

```text
runs/<run_id>/coordinator_journal/command/<entry_id>.json
runs/<run_id>/coordinator_journal/event/<entry_id>.json
```

Wpis zawiera `RunId`, `TaskId`, `AttemptId`, `OwnershipEpoch`, lease token,
kierunek, sekwencję, flagę terminalną oraz payload JSON z canonical SHA-256.
Session nie interpretuje payloadu worker protocol; właściwa warstwa application
dekoduje i waliduje `worker_protocol.v1`.

Admission robi trzy rzeczy przed atomową publikacją:

- sprawdza claim względem bieżącego `run_catalog.json`;
- wymaga kontynuacji sekwencji osobno dla task, attempt, ownership epoch i kierunku;
- zwraca `Replayed` dla identycznego `entry_id` i payloadu, a konflikt,
  pominiętą sekwencję, obcy claim lub wpis po terminalnym evencie odrzuca.

Wpisy przechodzą przez reachability i pack `.fms`, dzięki czemu restart lub
import nie gubi kolejności obserwacji. Dziennik jest granicą trwałego zapisu,
a `SessionStore::apply_retry_decision` łączy zapis decyzji z fenced zmianą
`run_catalog.json` po reconciliation. Nie jest jednak transportem, kolejką ani
supervisorem: nie dowodzi dostarczenia wiadomości, zatrzymania procesu,
zwolnienia VRAM ani poprawności naukowej payloadu.

### Weryfikacja — 24.09.2026

Po zgodzie użytkownika na testowanie uruchomiono regresję wielu zadań i retry.
Wykryła ona wspólne liczenie sekwencji dla całego runu: drugi task nie mógł
zapisać pierwszego zdarzenia po zakończeniu poprzedniego taska. Run przed
poprawką `08caf8b6e8aa4793b8ddb2cd2b62e631` zakończył się oczekiwanym błędem.

Sekwencja i terminal fencing dotyczą teraz jednej krotki
`(task_id, attempt_id, ownership_epoch, direction)`. Zmiana lease tokenu
w tym samym strumieniu jest odrzucana. Wszystkie istniejące wpisy nadal
przechodzą walidację formatu i tożsamości ścieżki przed filtrowaniem.
Identyfikator wpisu pozostaje unikalny w obrębie runu i kierunku; format
plików i namespace nie zostały zmienione.

`just verify-session-persistence`: **78/78 PASS** (58 biblioteki i 20
integracyjnych, 0 doctestów). Run `d2d96b31323e40e59019a61fb3f30e4c`,
exit code 0, `source_changed_during_run=false`, source SHA-256
`5abfe8f812621447f7c1859ee718e95296b364991c9b9232e68e885e3a444407`.
Receipt znajduje się w zarządzanym storage pod
`builds/fullmag-0950f4dca4ffe38f/windows-session-check/session-persistence/d2d96b31323e40e59019a61fb3f30e4c/receipt.json`.

Regresja obejmuje niezależny drugi task, nową próbę pierwszego taska,
odrzucenie starego claimu i zmienionego tokenu oraz dalszą sekwencję drugiego
taska. Nie dowodzi jeszcze odtworzenia koordynatora z dziennika, transportu
ani wykonania workera. Adapter trwałego koordynatora pozostaje do wykonania.

### Odczyt snapshotu dziennika — 24.09.2026

Dodano `SessionStore::read_coordinator_journal(run_id)`: odczytuje oba kierunki
pod blokadą pisarza, sprawdza tożsamość ścieżek i payloadów, zachowuje historyczne
próby, porządkuje wpisy według strumienia i sekwencji. Odrzuca luki, duplikaty,
zmianę tokenu oraz wpisy po zdarzeniu terminalnym. Brak katalogu runu jest błędem.
Porządek wyniku nie oznacza kolejności przyczynowej między komendami i zdarzeniami.

Regresja odczytuje pięć wpisów wielu tasków/prób po ponownym otwarciu magazynu,
odrzuca odczyt podczas aktywnej blokady pisarza i niepełny dziennik po usunięciu
początku strumienia. `just verify-session-persistence`: **78/78 PASS**, run
`122c9d944e2346a3ab31d96ccbba0bc3`, exit 0, źródła niezmienione podczas testu.
Jest to bezpieczny odczyt do przyszłego adaptera recovery, nie gotowe wznowienie
workera. Adapter nadal musi uzgodnić bieżący claim, odtworzyć stan application
i zapisywać outbox przed wysłaniem.

### Odtwarzanie rejestru protokołu — 24.09.2026

`WorkerProtocolLedger::restore` odbudowuje deduplikację i fencing dla jednego
claimu z kompletnych, uporządkowanych strumieni komend i zdarzeń. Wymaga
ciągłych sekwencji od 1; zachowuje identyfikatory i hashe payloadów, stan
terminalny i żądanie release. Release musi być ostatnią komendą i wymaga
terminalnego zdarzenia. Odtworzony aktywny strumień przyjmuje kolejne zdarzenie;
odtworzony terminalny strumień dopuszcza identyczny replay, ale odrzuca nowe
zdarzenie, konflikt payloadu i obcy claim.

`just verify-project-application`: **38/38 PASS** (19 biblioteki, 19
integracyjnych), run `a4425e3204d148af8a8bc7c84cfe18f7`, exit 0,
`source_changed_during_run=false`, source SHA-256
`14e55ba78ee7e539ee1c2abe7a9b7c114fcf28ab0bbf11c2f1c1a14e88a84b14`.
Pierwszy run `0d373208fada4b37b2bd36f637dd84d5` wykrył błąd kompilacji
fixture: token wymaga konstruktora `LeaseToken`, nie konwersji ze stringa;
fixture poprawiono przed zielonym wynikiem.

To odtworzenie rejestru protokołu, nie lifecycle zadania ani wykonania workera.
Dziennik nie ma wspólnej kolejności przyczynowej między kierunkami. Adapter
recovery wymaga jawnego checkpointu i granic zastosowanych komend/zdarzeń;
nie wolno odtwarzać tej kolejności na podstawie nazw lub czasu zapisu plików.
Żądanie release nadal nie dowodzi fizycznego zwolnienia zasobu.

### Checkpoint application — 24.09.2026

Dodano `coordinator_checkpoint.v1`: stan zadania, claim oraz dokładne granice
sekwencji komend i zdarzeń. `WorkerCoordinator::restore` wymaga kompletnych
strumieni od początku próby dokładnie do tych granic; odrzuca brakujące wpisy
i ogon poza checkpointem. Sprawdza schema, tożsamość task/claim, lifecycle,
assessment i heartbeat watermark. Odbudowuje rejestr protokołu oraz następną
sekwencję komendy, zachowuje release requested. Aktywna obserwacja przechodzi
do `Reconciling`, zamiast udawać połączenie z workerem.

Regresje obejmują serializację JSON, odtworzenie aktywnego zadania, replay,
kontynuację sekwencji, terminalny release oraz odmowę błędnej tożsamości,
lifecycle, wersji i niezgodnych granic dziennika. Bramka application:
**40/40 PASS** (21 biblioteki, 19 integracyjnych), run
`c7d51b79c07d4910993ae21eba0ca0ac`, exit 0, źródła niezmienione podczas testu.

Checkpoint jest na razie kontraktem application: nie ma jeszcze atomowej
publikacji w SessionStore ani podłączenia do transportu. Nie jest checkpointem
solvera ani dowodem ExactResume. Adapter musi zachować oryginalne koperty
komend do retransmisji i rozstrzygnąć journal tail; nie wolno pominąć go przez
obcięcie wejścia bez osobnej procedury recovery. Kontrakt nie rozszerza
lifecycle workera ani publicznego API; istniejąca granica application/runtime
pozostaje bez zmian.

### Granica publikacji przejścia — 24.09.2026

`coordinator_transition.v1` łączy dokładną kopertę komendy/zdarzenia i wynikowy
checkpoint w jeden serializowany rekord. `commit_command` i `commit_event`
przygotowują stan, wywołują publisher i dopiero po jego sukcesie zastępują
stan aktywny. Błąd publishera nie zużywa sekwencji ani nie wydaje komendy;
powtórzone zaakceptowane zdarzenie nie publikuje nowego rekordu.

Test odmowy publishera dla komendy i zdarzenia, sukcesu publikacji, replay
oraz serializacji całego przejścia: application **41/41 PASS**, run
`16701cae11d949a9a7c53b56630dbd94`, exit 0, źródła niezmienione podczas testu.
Checkpoint i transition są eksportowane przez publiczną powierzchnię crate.

Ta granica wymaga adaptera zapisującego cały rekord atomowo; test używa
publishera pamięciowego. SessionStore ma atomowy zapis pojedynczego payloadu,
ale mapowanie transition do dziennika i integracja workera pozostają otwarte.
Adapter musi odróżniać odmowę przed zapisem od `PublicationUncertain`:
niepewny wynik wymaga odczytu/reconciliation przed wygenerowaniem nowej komendy.
Nie wolno mieszać niezapisanych wywołań niskopoziomowych z durable ACK.
Staging kopiuje obecnie rejestr protokołu; koszt długiego strumienia wymaga
późniejszej optymalizacji i bramki wydajności, nie został zakwalifikowany.

### Adapter SessionStore — 24.09.2026

`fullmag-api/src/coordinator_persistence.rs` mapuje transition na jeden wpis
SessionStore: koperta i wynikowy checkpoint są wspólnym payloadem objętym
canonical SHA-256 oraz jednym atomowym zapisem. Sprawdza schema, claim,
tożsamość taska i watermark kierunku. Powtórzenie zachowuje pierwotny czas
utworzenia; store porównuje pełny rekord pod blokadą i bieżącym fencingiem.
Adapter zachowuje typowane błędy storage, w tym `PublicationUncertain`.

Test integracyjny dwóch instancji store potwierdza odmowę przy zajętym writerze,
brak zmiany application po odmowie, zapis start/started, reopen, identyczny
replay i odtworzenie koordynatora wyłącznie z checkpointu oraz kopert odczytanych
z plików. `just verify-api-project-runs`: **4/4 PASS**, run
`5b4d93b07dfb4a6aa5e2ae69b2ac7912`, exit 0, źródła niezmienione podczas testu.
Pierwsza próba wymagała poprawienia zależności fixture; druga wykazała,
że test konkurencji musi używać dwóch instancji store, ponieważ transakcja
tej samej instancji dopuszcza zagnieżdżenie. Obie poprawki dotyczyły testu.

Adapter nie jest jeszcze podłączony do pętli workera. Nie przetestowano awarii
między publikacją a ACK, power-loss ani równoległych koordynatorów tego samego
claimu. Kolejne wymagania: wybór spójnego checkpointu ze wszystkich rekordów,
rozstrzygnięcie `PublicationUncertain`, trwałe uzgodnienie katalogu tasków oraz
outbox/retransmisja. Obecny test nie zastępuje tych bramek.

### Recovery łańcucha transition — 24.09.2026

Adapter `recover_coordinator` odczytuje katalog i dziennik pod wspólną blokadą
pisarza, sprawdza bieżący attempt/epoch i wybiera rekordy wskazanego claimu.
Porównuje pełną tożsamość zewnętrznego wpisu z payloadem oraz oczekiwanym
tokenem. Kolejność wynika z sumy obu watermarks, a każdy kolejny rekord musi
zwiększać dokładnie właściwy licznik, pozostawiając drugi bez zmiany.
Luka, rozwidlenie lub obcy claim oznacza błąd, nie automatyczne wznowienie.

Odtworzenie korzysta z ostatniego checkpointu kompletnego łańcucha i zachowuje
oryginalne koperty komend do późniejszego reconciliation. Aktywne zadanie ma
obserwację `Reconciling`. Pusty claim nie jest odtwarzany jako nowa próba.
Nie ma automatycznej retransmisji ani zmiany katalogu lifecycle podczas odczytu.

Regresja obejmuje poprawny łańcuch, obcy token, starą epokę i rozwidlenie
watermarks przy poprawnym SHA-256 payloadu. `just verify-api-project-runs`:
**4/4 PASS**, run `3f7743cd35de41ee9cadf4329c0099b1`, exit 0,
źródła niezmienione podczas testu. Brak nadal fault injection dla niepewnej
publikacji, synchronizacji katalogu tasków i produkcyjnej pętli workera.

### Ponowienie niepewnej publikacji — 24.09.2026

Identyczny replay wpisu koordynatora nie kończy się już samym porównaniem
widocznego payloadu. Pod blokadą pisarza `confirm_publication` synchronizuje
istniejący plik i wykonuje dostępną na platformie barierę katalogu. Nie zmienia
rekordu ani identyfikatora wiadomości. Błąd pozostaje typowanym
`PublicationUncertain`; dopiero sukces pozwala zwrócić `Replayed`.

Fault injection potwierdza: awaria bariery po rename pozostawia widoczny
rekord, ale zwraca błąd; ponowna awaria potwierdzenia nadal zwraca błąd;
kolejne potwierdzenie tego samego wpisu kończy się replay. Session:
**78/78 PASS**, run `f6f7bf1f689c4686adb5d870bb6eb6ba`, exit 0,
źródła niezmienione podczas weryfikacji.

To kontrolowany model awarii, nie power-loss qualification. Windows nadal
raportuje brak przenośnej synchronizacji katalogu. Pętla koordynatora musi
zachować dokładną niepewną transition i zablokować nowe komendy do jej
uzgodnienia; samo ponowienie operacji generującej nowe UUID nie jest recovery.

### Zachowanie oczekującej publikacji — 24.09.2026

`DurableWorkerCoordinator` posiada aktywny stan i opcjonalną oczekującą parę
candidate/transition. Przed publikacją zachowuje dokładny rekord; każdy błąd
publishera blokuje nowe komendy i zdarzenia. `retry_publication` używa tego
samego UUID, payloadu i checkpointu. Dopiero sukces zastępuje stan aktywny
i wydaje komunikat. Kolejny błąd zachowuje rekord do następnej próby.
Osłona nie udostępnia mutowalnego koordynatora niskopoziomowego.

Application: **42/42 PASS**, run `05a23ba1069843f8aac4188f1964ca98`.
Integracja API/store: **4/4 PASS**, run `9eb78fce52c3439aa7f4096f0f1e6c8f`.
Oba runy mają exit 0 i niezmienione źródła podczas weryfikacji. Test API zapisuje
zdarzenie do pliku, symuluje utratę potwierdzenia i sprawdza, że stan pozostaje
poprzedni, a ponowienie zwraca `Replayed` dla identycznej transition. Następnie
odtwarza stan z plików. Test aplikacyjny obejmuje również dwie kolejne odmowy
i blokadę nowych operacji. Pierwszy build testu wymagał jawnego typu argumentu
closure; finalne wyniki powyżej dotyczą poprawionego fixture.

Pending jest stanem procesu: po jego utracie recovery korzysta z trwałego
łańcucha, nie z pamięci osłony. Nie ma jeszcze produkcyjnego routingu workera,
uzgadniania katalogu lifecycle ani fault injection ubicia procesu. Konstruktor
osłony wymaga koordynatora nowej próby lub zweryfikowanego recovery; nie wolno
wprowadzać do niego historii wykonanej wcześniej bez durable publication.
Koszt stagingu i wzrost rejestru nadal wymagają bramki wydajności.

### Uzgodnienie katalogu lifecycle — 24.09.2026

`commit_transition` po zapisie dziennika automatycznie uzgadnia projekcję
lifecycle/observation i watermark z pełnego trwałego łańcucha koordynatora.
Jawne `reconcile_coordinator_catalog` pozostaje idempotentną naprawą po
przerwaniu pomiędzy zapisem dziennika a projekcją. Odczyt, recovery i zapis
katalogu pozostają pod jedną blokadą pisarza. Adapter weryfikuje fingerprint
wejścia oraz zasób i nie zastępuje sprzecznego stanu terminalnego. Pozostałe
pola katalogu, w tym artefakty i readiness, pozostają zachowane. Rewizja
zwiększa się tylko przy rzeczywistej zmianie projekcji.

Opcjonalny `FmsCoordinatorWatermark` zapisuje maksymalne sequence komend i
zdarzeń bieżącego attemptu. Recovery odrzuca katalog wyprzedzający kompletny
dziennik; lagujący watermark można naprawić z dziennika. `SessionStore` blokuje
cofnięcie watermarku, jego usunięcie w tym samym ownership epoch oraz usunięcie
taska, który go posiada. W tym samym epoch wolno wyczyścić zakończony attempt,
ale rozpoczęcie nowego attemptu i reset watermarku wymagają wyższego epoch.
Pusty dziennik wolno odtworzyć z `coordinator_genesis` tylko przy watermarku
`(0,0)` i zgodnej tożsamości; brak genesis albo dodatni watermark oznacza
odmowę.

Regresja sprawdza, że zapis `Started` automatycznie publikuje `Running` /
`Reconciling` oraz watermark `(1,1)`, a ponowne uzgodnienie nie zmienia rewizji.
Test przerwania procesu zapisuje `Stop`, kończy proces i odtwarza `Stopping`
oraz watermark `(2,1)` po ponownym otwarciu magazynu. Zmiana z tego kroku nie
była jeszcze objęta wcześniejszą bramką API; wymaga ponownego uruchomienia
po przywróceniu managed build runnera.

Automatyczna projekcja następuje w adapterze publikacji transitionu, ale nie
dowodzi dostarczenia komendy do procesu workera ani wykonania skutku solvera.
Nadal potrzebne są fault injection na granicach procesu i dowody wykonania
worker/runtime.

### Przerwanie osobnego procesu — 24.09.2026

Test API uruchamia bieżący test executable w osobnym procesie z jawnym
fixture root. Proces odtwarza koordynator, zapisuje `Stop` wraz z checkpointem,
po czym wykonuje `process::exit(23)` bez destruktorów. Projekcja katalogu jest
zapisana wcześniej przez adapter transitionu.
Rodzic wymaga dokładnego kodu 23, odczytuje drugą komendę z dziennika,
odtwarza `Stopping`, potwierdza katalog `Stopping` i watermark `(2,1)`,
następnie sprawdza idempotencję powtórnego uzgodnienia.

`just verify-api-project-runs`: **4/4 PASS**, run
`cbc361752c6848c2ba38384949e59ad3`, exit 0. Ten wcześniejszy wynik nie
weryfikuje bieżącej zmiany automatycznej projekcji ani watermarku.
Jedna pomocnicza funkcja ma `ignored` w suite rodzica: jest jawnie wywołana
przez subprocess z `--exact --ignored`, a rodzic sprawdza jej kod zakończenia
i zapisane dane. Nie jest to pominięcie wymaganego testu recovery.

Dowód obejmuje kontrolowane zakończenie rzeczywistego procesu po publikacji,
nie zewnętrzne zabicie procesu w dowolnym momencie ani awarię zasilania.
Nie wykonuje solvera. Inspekcja CLI potwierdziła, że obecny
`runtime_supervisor.rs` opisuje starszy kontekst sesji; odbiornik
`worker_protocol.v1` i jego routing do wykonawcy nadal pozostają do zbudowania.

### Admission odbiornika komend — 24.09.2026

`WorkerCommandInbox` dodaje procesową granicę przed callbackiem wykonawcy:
walidację claimu/payloadu, ciągłość sekwencji, deduplikację i zachowanie
komendy o nieznanym wyniku. Identyczny replay nie wywołuje callbacku ponownie.
Po błędzie callbacku odbiornik blokuje wszystkie kolejne komendy; potwierdzenie
zastosowania wymaga dokładnie tej samej koperty i osobnego dowodu runtime.
Potwierdzenie samo nie wykonuje komendy i nie dowodzi zwolnienia zasobu.

Regresja liczy wywołania callbacku, sprawdza lukę sekwencji, obcy token,
replay, utratę ACK oraz odrzucenie uzgodnienia z inną kopertą. Application
**42/42 PASS**, run `22d03bd54ce34edeaadd78bee7450e8f`, exit 0,
źródła niezmienione podczas testu.

To komponent admission, nie gotowy worker: stan inboxu jest procesowy,
nie ma jeszcze trwałego receipt wykonawcy, odbioru transportu ani wywołań
solvera. Callback musi weryfikować właściwy lifecycle i immutable input;
nie wolno utożsamiać samego dopuszczenia koperty z wykonaniem Prepare/Start.
Inspekcja `command_bridge.rs` i `interactive_runtime_host.rs` wykazała legacy
polling związany z owner session; nowy protokół nie może delegować do mutable
current bez przypiętego kontekstu run/attempt.

### Kontrakt checkpointu odbiornika — 24.09.2026

`worker_inbox.v1` zapisuje claim, uporządkowane komendy applied i opcjonalną
pending. `receive_durable` wymaga publikacji pending przed callbackiem oraz
applied przed zwróceniem ACK. Błąd na każdej granicy zachowuje pending.
Odtworzenie waliduje claim, ciągłość i unikalność historii; pending po restarcie
blokuje automatyczne wykonanie. `confirm_pending_applied_durable` zapisuje
wynik uzgodnienia dokładnej koperty przed usunięciem blokady.

Regresje obejmują odmowę pierwszego zapisu (callback nie jest wywołany),
błąd potwierdzenia po callbacku, ponowienie uzgodnienia, JSON roundtrip,
replay po odtworzeniu oraz odrzucenie duplikatu w historii applied.
Application **42/42 PASS**, run `d2a2d0318d7549a6b5de7a430be2e266`, exit 0,
źródła niezmienione podczas weryfikacji.

Testuje to port publikacji checkpointu, nie jego zapis w SessionStore.
Do wykonania pozostaje adapter trwałego inboxu, atomowa walidacja kolejnych
stanów w magazynie, kwalifikacja kosztu rosnącej historii i routing CLI.
Procesowy helper `receive` nie daje gwarancji restartu; produkcyjny adapter
musi używać `receive_durable` i rzeczywistego atomowego publishera.

### Spójność walidacji archiwum — 24.09.2026

Przegląd przed dodaniem storage inboxu ujawnił rozbieżność: store admission
rozdzielał task/attempt, lecz reachability eksportu liczyło sekwencję dla
całego runu i kierunku. Naprawiono to wspólną walidacją strumieni według
run/task/attempt/epoch/direction, używaną przez walker magazynu i archiwum.
Archiwum sprawdza teraz również ciągłość, duplikaty, terminal fencing i
niezmienność tokenu w strumieniu, poza istniejącą walidacją pojedynczych wpisów.

Regresja magazynu zawierającego kilka tasków i retry przechodzi rzeczywisty
walker GC; dodatkowe przypadki wspólnego walidatora odrzucają duplikat i zmianę
tokenu. Session **78/78 PASS**, run `cb8ed5f95e8a4afaa55a96bed820b1bb`,
exit 0, źródła niezmienione podczas testu. Nie przeprowadzono w tym kroku
osobnego roundtrip archiwum wielu tasków; istniejące testy archiwum przeszły.
Adapter storage inboxu pozostaje kolejnym krokiem.

### Roundtrip FMS wielu tasków i retry — 24.09.2026

Dodano pełny test `archive_roundtrip_preserves_independent_coordinator_attempts`:
dwa taski, terminalny historyczny attempt pierwszego taska i nowy attempt
z wyższą epoką. Test pakuje FMS, wykonuje preflight i importuje do nowego store.
Porównuje cały katalog oraz wpisy dziennika, dopisuje sekwencję 2 drugiego
taska i potwierdza odmowę zapisu starego claimu po imporcie.

`just verify-session-persistence`: **79/79 PASS** (58 biblioteki, 8 archiwum,
13 store; 0 doctestów), run `86928c488cd64bd1afae1167255b80c2`, exit 0,
źródła niezmienione podczas testu. Tym samym zamknięto brak osobnego roundtrip
archiwum opisany wyżej. Dowód dotyczy syntetycznych rekordów sterowania,
nie stanu solvera ani kwalifikacji naukowej. Storage inboxu i routing CLI
nadal pozostają otwarte.

### Storage checkpointu inboxu — 24.09.2026

`FmsWorkerInboxRecord` i `SessionStore::commit_worker_inbox` publikują snapshot
pod `runs/<run_id>/worker_inbox/<identity-sha256>.json`. Klucz obejmuje
run/task/attempt/epoch; token nie tworzy nowej ścieżki i nie pozwala obejść
historii. Payload ma canonical SHA-256, walidację claimu, sekwencji i unikalności
message_id. Writer sprawdza bieżący katalog i dopuszcza tylko pierwszy pending,
identyczny replay, pending→applied lub applied→kolejny pending. Nie wolno
przepisać historii ani pominąć kroku. Replay ponawia bariery trwałości.

Inbox jest objęty reachability, pakowaniem, preflight i importem FMS. Regresja
sprawdza odmowę applied bez pending, replay, odmowę rollbacku i podmiany tokenu,
duplikat message_id oraz zachowanie dokładnych bajtów snapshotu po imporcie.
Session **79/79 PASS**, run `1b76cb4b24784401aba038b15cb580f4`, exit 0,
źródła niezmienione podczas testu.

Session waliduje strukturę i niezmienniki zapisu, a application nadal odpowiada
za semantykę kopert i wykonania. Do wykonania pozostaje adapter między typowanym
WorkerInboxCheckpoint a tym zapisem, test procesu odbiorcy oraz routing CLI.
Historia snapshotu rośnie; jej koszt nie jest jeszcze zakwalifikowany.

### Adapter typowanego inboxu — 24.09.2026

`commit_worker_checkpoint` waliduje WorkerInboxCheckpoint przez application
restore, a następnie publikuje FmsWorkerInboxRecord. `recover_worker_inbox`
odczytuje katalog i snapshot pod blokadą, sprawdza bieżący attempt/epoch,
tożsamość ścieżki, digest oraz typowany claim. Brak snapshotu jest błędem
wymagającym reconciliation, nie utworzeniem pustej historii wykonania.

Test API wykonuje callback raz, pozostawia pending po symulowanej utracie ACK,
otwiera magazyn ponownie i potwierdza blokadę callbacku. Po jawnym uzgodnieniu
zapisuje applied, ponownie odtwarza inbox i rozpoznaje retransmisję bez
kolejnego wykonania. API **4/4 PASS**, run
`7fa63f8d1e0145f3b4a99dcb5225edee`, exit 0,
`source_changed_during_run=false`. Pomocniczy test procesu koordynatora nadal
jest jawnie uruchamiany przez rodzica.

Wykonawca w tej regresji jest kontrolowanym callbackiem, nie solverem.
Adapter jest obecnie w warstwie kompozycji API; współdzielona trasa CLI,
trwałe dowody faktycznego wykonania i test przerwania procesu odbiorcy pozostają
do wykonania. Nie stanowi to kwalifikacji runtime ani fizycznego release.

### Proces odbiorcy przerwany po efekcie — 24.09.2026

Nowy subprocess fixture zapisuje pending przez rzeczywisty adapter, tworzy
i synchronizuje plik efektu zawierający dokładną kopertę, następnie wykonuje
`process::exit(24)` przed publikacją applied. Rodzic wymaga kodu 24 i zgodności
pliku efektu z wysłaną komendą. Recovery pending blokuje callback; po jawnym
uzgodnieniu i trwałym applied następny restore deduplikuje retransmisję.
Plik efektu pozostaje niezmieniony.

API **4/4 PASS**, run `b00c9fad310a4105bc4bcd2a0df69738`, exit 0,
źródła niezmienione podczas weryfikacji. Dwa pomocnicze testy z oznaczeniem
ignored są jawnie uruchamiane w osobnych procesach; rodzic wymaga kodów
23 (koordynator) i 24 (odbiorca) oraz ich danych na dysku.

Dowód obejmuje rzeczywisty proces i kontrolowany efekt plikowy. Nie obejmuje
solver Compute, automatycznego rozstrzygania wyniku solvera, arbitralnego kill
ani power-loss. Produkcyjne podłączenie CLI pozostaje następnym etapem.


### Wspólny adapter trwałości — 24.09.2026

Wydzielono `fullmag-runtime-control`: kompozycję kontraktów application
z SessionStore, bez zależności od solvera i HTTP. API korzysta z tej samej
implementacji przez reexport w `coordinator_persistence`. Przeniesiono zapis
i odzyskiwanie checkpointu odbiorcy, atomowe transitions koordynatora oraz
naprawę projekcji katalogu. Format danych i warunki deduplikacji pozostają
niezmienione. Manifest i źródła nowego pakietu należą do zakresu fingerprintu
zarządzanej bramki API.

Jest to realizacja istniejącego podziału warstw, bez nowego publicznego
kontraktu ani zmiany lifecycle. API jest pierwszym konsumentem. CLI nie jest
jeszcze konsumentem: potrzebuje osobnego wykonawcy przypiętego do immutable
RunSpec i danych przygotowania. Legacy InteractiveRuntimeHost śledzi bieżącą
sesję, więc nie może zastąpić izolowanego wykonawcy. Recovery pending wymaga
nadal dowodu efektu; adapter nie zezwala na automatyczne powtórzenie solvera.

Weryfikacja ekstrakcji: **4/4 PASS**, run `567ec6a73bc84714b63c4cc46fa6a710`,
exit 0, `source_changed_during_run=false`. Dwa ignored fixtures zostały
jawnie wykonane przez test rodzica w osobnych procesach. Proces bramki zakończony.
Dowody pozostają w zarządzanym storage, bez usuwania wspólnych zasobów.


### Rozwiązywanie niezmiennego snapshotu — 24.09.2026

`load_accepted_run_snapshot` we wspólnym adapterze odczytuje zaakceptowany
RunSpec oraz dokładne bajty definicji z CAS. Sprawdza run, project,
fingerprint specyfikacji i powiązanie SHA definicji; CAS sprawdza integralność
bajtów. Nie odczytuje current session i nie tworzy zastępczej definicji.
Materializacja API używa tego resolvera. Study, katalog ProblemIR i assets
nadal podlegają dalszym kontrolom istniejącej materializacji; sam snapshot
nie jest kompletnym wejściem solvera ani dowodem gotowości wykonania.

Przegląd integracji wykazał nierozwiązany kontrakt: materializacja katalogu
wylicza task input fingerprint z RunSpec, katalogu study i lowered step,
podczas gdy `TaskRecord::resolved_input` oczekuje fingerprintu samego
RunSpec. Nie należy usuwać porównania; potrzebna jest wspólna, typowana
identyfikacja kroku i oddzielenie obu odcisków wraz z regresją rzeczywiście
zmaterializowanego tasku. Blokuje to podłączenie realnego worker Start,
ale nie read-only resolver snapshotu.

Pierwsza weryfikacja (`b51606c746ee49dca89ed88eb35452c7`) wykryła brak
importu RunId w nowej regresji; poprawiono import i uruchomiono bramkę ponownie.

Weryfikacja resolvera: API **4/4 PASS**, run `4f124ea472294ed2a0e1bb0eef881c4c`, exit 0, źródła niezmienione. Dwa fixtures procesów uruchamia test rodzica. Proces zakończony; dowody zachowane w storage. Nie jest to kwalifikacja solvera; procenty planu bez zmian.


### Wspólny odcisk zadania study — 24.09.2026

Application udostępnia `study_task_input_fingerprint` dla typowanego
StudyStepExecutionPlan. Materializacja katalogu korzysta z tej funkcji;
`TaskRecord::resolved_study_input` porównuje ten sam odcisk, zamiast odcisku
całego RunSpec. W kopercie resolved input pozostaje osobny odcisk specyfikacji.
Dla zadań obejmujących cały run istniejąca metoda `resolved_input` nadal
wymaga odcisku RunSpec; nie wolno jej używać dla materializowanych study.

Regresja transportu Submit odczytuje zmaterializowany task, porównuje odcisk
z wcześniejszą serializacją task_input.v1 i tworzy resolved study input.
Podmieniony step_id, zmienione parametry RunSpec i wyłączony krok są odrzucane.
Test nie kwalifikuje preparation receipt ani solvera: binding w tym fragmencie
jest kontrolowaną daną kontraktową, a nie dowodem rzeczywistego przygotowania.
Pozostaje wpięcie tej ścieżki do produkcyjnego wykonawcy i weryfikacja planu
oraz receipt przed Start. Weryfikacja zmian jest w toku.

Pierwsza bramka tego przyrostu (`8e0019d9026a44f69712a4ce95652a94`) wykryła użycie prywatnego konstruktora bindingu w fixture. Test poprawiono na deserializację kontrolowanych danych; widoczność API pozostaje bez zmian. Powtórzenie: `a1bbf7a7734c41cab72e92c1a84c560d`.

Wynik końcowy: API **4/4 PASS** (`a1bbf7a7734c41cab72e92c1a84c560d`),
application **42/42 PASS** (`f795e78a92df4439825bad79e983bde7`). Obie bramki:
exit 0, source_changed_during_run=false; procesy zakończone, dowody zachowane
w zarządzanym storage. Niespójność obliczania odcisku jest usunięta dla nowej
ścieżki resolved_study_input i materializacji. Produkcyjne podłączenie CLI,
sprawdzenie wejść planu/preparation oraz wykonanie solvera pozostają otwarte.
Procenty całego planu bez zmian.


### Odcisk planu pochodzi z przypiętego kroku — 24.09.2026

`resolved_study_input` nie przyjmuje już dowolnego plan_fingerprint od
wywołującego. Wylicza SHA-256 kanonicznego ExecutionPlanIR zawartego w kroku,
którego pełny odcisk sprawdza względem zadania. Brak ExecutionPlanIR kończy się
błędem przed utworzeniem wejścia wykonawcy. Regresja porównuje wynik z
kanoniczną serializacją planu; osobny przypadek ma poprawny odcisk zadania,
ale nie zawiera planu, więc sprawdza właśnie tę nową granicę.

Nie zmienia to jeszcze formatu resolved_task_input.v1 ani semantyki
requested/resolved. Powiązanie receipt z dokładnym ProblemIR i produkcyjne
wykonanie CLI nadal pozostają do wdrożenia. Weryfikacja jest w toku.

API **4/4 PASS**, run `7524598f1d9b48d5ad369657e2c76627`, exit 0, source_changed_during_run=false. Proces zakończony; dowody zachowane w storage. Test potwierdza odcisk planu i odrzucenie braku planu; nie jest dowodem solvera. Procenty planu bez zmian.


### Receipt, ProblemIR i plan kroku — 24.09.2026

Ścieżka resolved_study_input przyjmuje teraz pełny PreparationReceipt oraz
ProblemIR. Binding tworzy wyłącznie z walidowanego receipt. Porównuje dokładny
odcisk ProblemIR z preparation plan, ponownie uruchamia kanoniczny planner
i wymaga zgodności ExecutionPlanIR oraz requested/resolved backend z planem
przypiętego kroku. Nie przyjmuje dowolnego bindingu dla study.

Regresja Submit używa materializacji przygotowania FDM zamiast sztucznego
bindingu. Osobny receipt ma poprawną strukturę i przeliczony odcisk planu,
ale wskazuje inny ProblemIR: powinien zostać odrzucony. Nie jest to dowód
wykonania solvera ani kwalifikacji FEM; nadal potrzebny jest produkcyjny
resolver immutable study/catalog dla CLI i transport wykonawcy.
Weryfikacja w toku.

Pierwsza regresja (`9cec85e614734a13b052d122778ee9c3`) poprawnie odmówiła przygotowania bootstrap ProblemIR bez regionu FDM. Fixture uzupełniono o object region zgodnie z istniejącą regresją materializacji; ten sam model trafia do immutable katalogu Submit i do receipt. Nie zmieniono reguł przygotowania.

Wynik: API **4/4 PASS**, run `9ace6f805dc0406a9109df947f175942`, exit 0,
source_changed_during_run=false. Proces zakończony; dowody zachowane w storage.
Regresja potwierdza przyjęcie przygotowania przypiętego modelu FDM i odrzucenie
receipt wskazującego inny ProblemIR. Pozostaje produkcyjny resolver dla CLI,
kontrola dostępności artefaktów i transport wykonawcy; solver nie był uruchamiany.
Procenty całego planu bez zmian.


### Wspólne rozwiązywanie immutable study dla API/CLI — 25.09.2026

Walidację danych study zaakceptowanych przy Submit przeniesiono do
`fullmag-runtime-control::load_accepted_study_snapshot`. Odczyt obejmuje
RunSpec i definicję, wersjonowany StudyPlan, katalog ProblemIR, powiązane
zasoby CAS, kanoniczne lowerowanie oraz kontrolę requested backend/device/
precision/mode. Wynik jest typowany i niezależny od HTTP i current session.
Materializacja katalogu API używa wspólnego resolvera; CLI może teraz korzystać
z tego samego kontraktu jako następny konsument. Skrypt fingerprintów trasy
API obejmuje nowe zależności authoring, IR i plan.

Zarządzana bramka API: **4/4 PASS**, run `f8a899e4a1184a82bb2033fb9dc4776b`,
exit 0, `source_changed_during_run=false`. Proces zakończony; pełny log i
receipt pozostają w storage. Testy obejmują immutable Submit/materializację
oraz dwie child-process regresje koordynatora/odbiorcy. Nie obejmują CLI,
rzeczywistej pętli workera ani solvera. Następna część P5-B to wybór fenced
attemptu, izolacja procesu workera i publikacja jego zdarzeń przez transport;
shared resolver sam tego nie realizuje.


### Trwały odbiornik i fencing zwolnionego lease — 25.09.2026

`fullmag-runtime-control::DurableWorkerInbox` jest właścicielem checkpointu
odbiornika: `new` obsługuje świeży claim, a `recover` wymaga istniejącego
checkpointu. Odbiornik zapisuje `pending` przed wywołaniem efektu i `applied`
przed wynikiem kwalifikującym się do ACK. Po restarcie nierozstrzygnięty
`pending` nie wywołuje efektu ponownie; adapter może potwierdzić uzgodniony
efekt przez `confirm_applied`.

Nowy zapis inboxu i nowy wpis dziennika przechodzą pod blokadą SessionStore
kontrolę przypisania zasobu, run/task/attempt/epoch, aktywnego stanu lease i
tokenu. Kontrola jest po gałęzi dokładnego replayu: wcześniej opublikowany,
identyczny wpis nadal można odtworzyć idempotentnie po zwolnieniu lease, ale
nowa komenda lub transition starego właściciela są odrzucane. Test API zwalnia
lease, następnie próbuje przyjąć Stop i zdarzenie Stopped; zapis inboxu nie
dochodzi do handlera efektu, a coordinator zachowuje fazę `Stopping`.

Rozszerzono też regresję archiwum wielu tasków i retry o przypisane aktywne
lease; pierwsza próba bramki ujawniła fixture bez wymaganego zasobu, który
został dodany do scenariusza. Końcowe bramki: API **4/4 PASS**, run
`d157917e58444ee489dfe73ca9eec16a` (dwa ignored child fixtures są jawnie
uruchamiane przez test rodzica), oraz trwałość sesji **79/79 PASS**
(58 biblioteki, 8 archiwum, 13 integracyjnych), run
`19dd731378b0440e9dd415ba399bf698`. Obie zakończyły się exit 0,
`source_changed_during_run=false`, na dirty `master@93f11dbc564c00b725d174ccb2fd0ff9a96493c9`.
Receipty i logi pozostają w zarządzanym storage projektu.

To nadal nie jest produkcyjny supervisor ani dowód wykonania solvera. Nie
zweryfikowano jeszcze fenced wyboru taska/attemptu przez runtime, transportu
CLI, anulowania i wyścigów retry, odzyskania orphanów, fencing generacji
heartbeat w wiadomościach pośrednich ani fizycznego zwolnienia CPU/RAM/VRAM.
Inventory potwierdza, że `fullmag-cli` nie używa jeszcze
`fullmag-runtime-control`; dotychczasowe `RunJson` wywołuje bezpośrednio
`fullmag_runner::run_problem` z podanego `ProblemIR`, poza accepted `RunSpec`,
coordinatorem i trwałym lease. Następny krok musi wprowadzić ścieżkę przyjętego
runu przez ten kontrakt. Procenty etapów pozostają bez zmian.


### Powiązanie receipt z zaakceptowanym RunSpec — 25.09.2026

`PreparationReceipt` ma opcjonalne `accepted_run_source` z identyfikatorem
runu, SHA-256 pełnego `RunSpecification`, `step_id` oraz odciskiem ProblemIR.
`AcceptedStudySnapshot::resolve_task_input` wybiera zaplanowany krok i ProblemIR
z zaakceptowanego katalogu, sprawdza digest, ponownie planuje model i porównuje
`ExecutionPlanIR`, wiąże receipt z RunSpec, a następnie deleguje do
`TaskRecord::resolved_study_input` z istniejącym claimem. CLI może użyć tej
jednej granicy zamiast osobno przekazywać RunSpec, krok i ProblemIR. Receipt
Live bez powiązania nie może wejść do accepted task.
Live API jawnie odrzuca receipt zawierający to pole; brak pola zachowuje
dotychczasowy kształt serializowanego receipt.

Powiązanie jest strukturalnym sprawdzeniem tożsamości, nie podpisem ani
samodzielnym dowodem pochodzenia danych. Resolver bierze RunSpec, krok i
ProblemIR z `AcceptedStudySnapshot`, ale sam nie generuje gridu/meshu ani nie
uruchamia solvera. Produkcyjny pipeline materializacji, adapter CLI, trwały
wybór taska/lease i start workera pozostają do wykonania. Regresja API sprawdza
odrzucenie receipt Live z accepted-run markerem, odrzucenie receipt z obcym
ProblemIR oraz odmowę wejścia niepowiązanego receipt do resolved task.

Weryfikacja tej zmiany jest **NOT RUN**: `just runner-container-status`
zwrócił `Container profile allow-list mismatch`, a `just runner-doctor` nie
potwierdził kontekstu Docker Desktop. Zgodnie z polityką projektu nie użyto
hostowego `cargo` ani bezpośredniej kompilacji. Test regresyjny i pełna kontrola
typów wymagają przywrócenia zatwierdzonego runnera. Procenty etapów bez zmian.


### Publikacja Prepare do durable outbox — 25.09.2026

`fullmag-runtime-control::publish_accepted_task_prepare` łączy typed task
receipt z `ResolvedTaskInput` i publikuje `WorkerCommand::Prepare` przez
`DurableWorkerCoordinator` oraz atomowy `commit_transition`. Lease jest
ponownie sprawdzany przez store przy zapisie. Błąd publikacji zachowuje
oryginalny błąd storage i pending transition do retry. Regresja API sprawdza
identyczność resolved input oraz envelope zapisanego w coordinator journal.

To adapter outboxa, nie konsument produkcyjny: `fullmag-cli` nadal nie wywołuje
tej funkcji, a transport, supervisor, wybór/claim taska i solver pozostają
otwarte. Regresja i kompilacja **NOT RUN / NOT VERIFIED** z powodu
`Container profile allow-list mismatch` i niepoświadczonego kontekstu Docker
Desktop; bez builda hostowego. Szczegóły: [09-durable-prepare-outbox.md](09-durable-prepare-outbox.md).

### Odtworzenie current task claim — 25.09.2026

`SessionStore::read_active_resource_lease_for_task` oraz
`fullmag-runtime-control::load_current_task_claim` odczytują claim tylko wtedy,
gdy run catalog i aktywny lease zgodnie wskazują bieżący task, attempt, epoch,
resource, token i heartbeat. API regresja porównuje claim odtworzony z pełnym
claimem fixture. Nie tworzy lease, nie claimuje taska i nie odtwarza coordinator
checkpointu; CLI i admission pozostają otwarte. Test/kompilacja **NOT RUN /
NOT VERIFIED** z powodu blokady managed runnera. `recover_coordinator` wymaga
co najmniej jednego transitionu, a obecny kontrakt nie zapisuje initial
coordinator marker przy claimie. Pusty journal nie odróżnia świeżego streamu
od utraconej historii, więc nowy coordinator nie może wysłać Prepare tylko na
podstawie braku wpisów. Następny krok P5-B musi zdefiniować i utrwalić
fail-closed początkowy stan admission/coordinator. Szczegóły:
[10-current-task-claim-recovery.md](10-current-task-claim-recovery.md).
