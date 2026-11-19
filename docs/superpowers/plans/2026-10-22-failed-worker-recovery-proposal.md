# Finalizacja znanego błędu zakończonego workera — propozycja do review

Status aktualny 23.10.2026: zatwierdzona finalizacja zapisała Failed/DoNotRetry
i zwolniła dokładną rezerwację CPU; archiwizacja slotu nie powiodła się z EXDEV.
API pozostaje zatrzymane. Poniższy pierwotny przegląd opisuje stan przed operacją;
wynik i ograniczenia znajdują się w końcowym checkpointcie. Lokalnych unitów Rust
nie kompilowano.

## Rzeczywisty stan i sprostowanie wcześniejszej hipotezy

Run `run-live-91ade96632da3c92902cd0143337a9496518ff29ea45ab0bc22313d44421eee4`,
task `task-66fae1a7f6c10925710e8005c7e5f13fbbf33637188579e901155328d41c2904`,
attempt `attempt-0c249de9f08745c2946dcb0f6d7017bc`, epoch1.
Worker4087 rzeczywiście wystartował i został reaped po błędzie certyfikatu Pioli,
exit1. Oryginalny receipt ma stop_requested=false i heartbeat18.
Owner `9270e44f-357c-4053-a3da-7416d8fb5096` ma Failed i terminalne dzieci.
Task pozostał Running/Reconciling, lease i host reservation są aktywne.

Dokładny trwały inbox ma **pending=null**. Prepare seq1, Start seq2 oraz heartbeat1–18
(seq3–20) są już applied. Commands journal ma jeden dodatkowy command21:
heartbeat19, bez wpisu inbox i bez ACK. Historical claim w started execution receipt
ma heartbeat0; nie wolno porównywać go na równość z final lease18 ani przepisywać.
Błąd final heartbeat zakończył supervisor przed terminalizacją i host release.

Wcześniejsza hipoteza o pending Start była błędna. Nie zastosowano na jej podstawie
żadnej operacji. Tryb recovery poniżej **odrzuca pending Start**. Istniejące durable
recovery supervisora może przy tym rzeczywistym pending=null ominąć wcześniejszy
błąd i terminalizować exit. Standalone supervisor CLI nie udostępnia jednak pełnych
owner/config/package pins ani host release; nie jest używany jako obejście lifecycle.
Wąski adapter operatora zachowuje deterministic Failed/DoNotRetry i pełne pins;
nie przenosi polityki spawnu/retry z supervisora. Nie refaktoryzuje jego normalnej pętli.

## Zakres i zgodność

Nowa jawna opcja istniejącego `fullmag-runtime-service --fail-reaped-worker`
finalizuje wskazany znany błąd jako Failed(retryable=false), bez retry.
Nie tworzy API, nowego proof ani schematu SessionStore. Nie zmienia no-spawn,
orphan teardown ani zwykłego Stop. Starsza binarka odmówi nieznanej opcji.
Nie potwierdza Start ani heartbeat, nie uruchamia solvera, nie zmienia exit receiptu,
nie usuwa częściowego Zarr, katalogu attemptu, logów, CAS ani wyników.

## Warunki i kolejność

1. CLI wymaga raw SHA bajtów requestu. Request przypina config, pełny Failed owner,
   aktualny installed package receipt i binarkę, build commit/source snapshot,
   exact store/run/task/attempt/epoch/resource/token, final lease, reservation,
   task katalogu, commands/events prefix, inbox i oba receipt: reaped exit i
   historyczny started execution. Źródła starego ownera pozostają przypięte
   osobno od źródeł nowego narzędzia recovery.
2. Blokady startup, launch i OWNER są utrzymane przez operację. Wymagane są
   terminalne compute/preparation oraz API exit z zachowanego process-tree.json,
   będącego kanonicznym sąsiadem configu. Boot ID, PID namespace i hostname muszą
   odpowiadać oryginalnemu kontenerowi. Zarządzana aktywacja przypnie także container ID.
   Brak procesu sam nie stanowi dowodu zakończenia.
3. Wymagany jest jeden Start, Started, inbox.pending=null i inbox.applied równy
   dokładnie commands prefix bez ostatniego command. Wszystkie wcześniejsze
   heartbeat mają ACK; final lease odpowiada ostatniemu ACK. Jedyny tail command
   to następny heartbeat, nieobecny w inbox/events. Completing, Completed,
   Stopped, Failed, Rejected, Stop i Release w dotychczasowym prefixie blokują tryb.
4. Katalog zawiera tylko dokładnie wskazany Running/Reconciling task, bez artifact IDs.
   Canonical artifact catalog musi być pusty lub nieobecny. W exact attempt nie
   może istnieć worker_execution_completed.v1.json — nawet malformed albo symlink.
   Właściciel accepted workera zapisuje ten receipt przed study output publication,
   więc sam brak artifact catalogu nie wystarcza. Started receipt musi zgadzać się
   z historycznym Start i tym samym, ewentualnie odnowionym final claimem.
5. Pod store writer publikowany jest deterministic Failed event związany z requestem
   i exit receipt digest. Następnie istniejący immutable FmsRetryDecision zapisuje
   ExplicitOperatorRequest/DoNotRetry. Replay dopuszcza wyłącznie ten event i decyzję,
   również po crashu między nimi. CLI raw request SHA i canonical_request_sha256
   dokumentu są rozróżnione w wynikach i journal reason.
6. Dopiero po trwałym Failed i DoNotRetry następuje release dokładnego final lease.
   Store writer zostaje zwolniony przed istniejącym release_worker_after_exit:
   zachowany zostaje lock order HOST→STORE oraz rzeczywisty receipt+Released proof.
   Nie są dodawane alternatywne powody release ani wyjątki od host ledger fence.
7. Immutable slot-owner ma raw SHA, exact PID i process-start token compute schedulera.
   Kanoniczny helper supervisora używa tego samego owner codec, nazwy resource slot
   i observera process_start_token co normalne stale-slot recovery. Dopiero po
   Failed, DoNotRetry, exact receipt, lokalnym Released i host proof przenosi cały
   slot do runtime-services/reaped-worker-recovery/<request-id>/supervisor-slot.
   Linux rename bez nadpisania zachowuje wszystkie bajty; replay potwierdza oba
   directory fsync. Dwa położenia, inny owner, dodatkowe pliki lub żywy proces blokują.

Nested writes tego samego SessionStore handle/thread są jawnie wspierane przez
crates/fullmag-session/src/writer.rs (depth). Regresja używa tego samego handle;
nie utrzymuje store writera przy wejściu w host ledger.

## Konkretny dowód odczytu

Wszystkie poniższe pliki znajdują się w wolumenie kontrolnym pod
`/opt/fullmag/control/verification/public-loop-solve-fixed-binding-20261022/`.

| Plik | SHA256 / ustalenie |
|---|---|
| reaped-worker-recovery-read-only-inventory.json | d0b4ce433fb867b54d9159dc379dc8455bd6bb12a34da7ce17526dc2f0823745 |
| reaped-worker-actual-inbox.json | 1ba3d8315c9920a6354d2bd1b5660048edaf3a45fab68f2790f11cdfc6e41ff8 |
| reaped-worker-recovery-observed-fields-only.json | 9dac5b9bf1a9b9bb6d9c39b6b18928d4f10827d5f3aab288d0b5788691e1430a |
| Started execution receipt | 7b0d6c942872cc9f32f333122459e7229afde67fe218fbe6cdbfd21c13640f69 |
| Supervisor slot owner | 1556112ac3c3af1d850125e1b9f25691d59ae2f91f6c21d29c914a74c7d8f89d |

Inwentarz obejmuje 11 wpisów częściowego Zarr i jeden plik exact attemptu.
Sprawdzono kanoniczne artifact_catalog.json (brak), run_catalog artifact_ids=[]
oraz exact completed execution receipt (brak). Wszystkie istniejące pliki wyników
mają zapisane ścieżki, rozmiary i hashes. Inbox.applied==commands[:-1] sprawdzono
na rzeczywistych zapisach, bez modyfikacji store. Wrapper observed-fields-only jest
celowo niezgodny z CLI request schema i nie zawiera przyszłych promoted tool pins.
Nie jest zgodą na wykonanie.

## Regresje i aktualne ograniczenia dowodów

Przygotowano sześć testów Rust: rzeczywisty kształt applied Start i różnica
HB0/ACK1/tail2; replay po samym Failed, DoNotRetry i lokalnym release; niezmienione
inbox/receipt/partial result; odmowa completed receipt bez artifact catalogu;
zmienione inbox/journal/started pins i niezgodne exit/success/Stop/timeout/epoch/
heartbeat; dokładna progresja reservation; slot archive replay; osobna odmowa
ambiguous pending Start bez mutacji. Testy używają tego samego kodu co runtime.
W bootstrap rust-contracts dopięto filtr do istniejącego explicit --bin harness.

Wykonano parse Rust przez rustfmt --emit stdout (bez kompilacji) i git diff --check.
Testów Rust NIE SKOMPILOWANO ani NIE WYKONANO lokalnie. Pełny pozytywny CLI,
rzeczywisty host release i archiwizacja są NOT VERIFIED. Odmowy niewymienione
w powyższych testach (np. pełne owner/package/namespace CLI refusal) pozostają
bramką konkretnego requestu, nie są przedstawiane jako wykonane regresje.

## Aktywacja i zgoda

Przygotowanie patcha/review jest autoryzowane. Konkretna aktywacja zmienia politykę
operatora względem istniejących komend: trwale finalizuje rozpoczęty failed attempt
i archiwizuje jego slot. Poprzednia zgoda no-spawn nie obejmuje Started. Wymagana
jest osobna decyzja dla konkretnego requestu i raw SHA po zbudowaniu/promocji
narzędzia, review i CI. Nie przygotowano pozornej zgody z placeholderami pakietu.

## Osobny zakres: zwykły błąd naukowy

Worker powinien publikować Failed(retryable=false) tylko dla rozpoznanego błędu
naukowego przed accepted output publication. Supervisor po durable Failed i
rzeczywistym reaped receipt mógłby zwolnić exact lease bez dopisywania applied Start
ani brakującego heartbeat. Nie każdy exit1 jest takim błędem: partial publication,
nieznany CAS i crash przed terminalnym eventem pozostają fail-closed.
Osobne testy muszą rozróżniać scientific failure, publication failure, crash,
sukces i opóźniony heartbeat. Tego zakresu obecny patch operatora nie implementuje.


## Korekta przeglądu requestu i kompilacji

Oryginalny wrapper observed-fields-only nie jest requestem CLI i zawierał
błędnie wybraną zwolnioną rezerwację preparation o tym samym run/task.
Nie zastosowano go. Dokładne dopasowanie musi obejmować solver owner,
attempt/epoch, compute resource i lease token; sam run/task nie wystarcza.
Poprawione obserwacje: reaped-worker-recovery-observed-solver-fields-only.json,
SHA256 6731c6a39c9bd5b8076657a17888a0ca6558e79ddcfc88d10549b04f5e235255.
Wskazują docker-all.compute.cpu, Active lease18 i Committed reservation;
canonical reservation SHA256 bc7ace1ac7178a4c173512201add9c7a0214c3e35c745d9f6ccae53c264b520b.
Oryginał pozostaje zachowany jako dowód korekty, bez zgody aktywacji.
Guard Request::validate odmawia preparation identity; nie poluzowano go.

CI oraz zarządzany build pakietu d423ef7fe5b0fcbab7c8c45457a7462f3c6ee60f
wykryły E0599: HostRuntimeAdmission::open zwraca Result<Option<Self>>.
Poprawka wymaga Some przez istniejące anyhow::Context i odmawia przy braku
host_execution, bez panic lub zmiany wspólnego API. Parser PASS;
recovery-optional-host-admission-fix.json zawiera dowód i rozważone rozwiązania.
Wymagany jest nowy udany build i wykonanie CI; nieudany kandydat nie będzie
promowany. Pełne runtime recovery nadal NOT VERIFIED i niewykonane.


## Natywna weryfikacja requestu bez finalizacji

Opcja --verify-only wykonuje dokładnie te same walidacje configu, ownera,
pakietu, namespace, journalu/inboxu, receiptów, lease, reservation i slotu
pod tymi samymi blokadami. Kończy się przed pierwszym Failed eventem.
Nie zapisuje DoNotRetry, nie zwalnia lease/host reservation, nie archiwizuje
slotu i nie uruchamia solvera. Zwraca verified_reaped_worker_failure z raw
request SHA i mutations_applied=false. Błędne i powtórzone opcje są odrzucane.
Weryfikacja przed zgodą zostanie porównana z pełnymi hashami trwałego stanu;
aktualne źródła nie są jeszcze dowodem wykonania tej ścieżki. Po jej sukcesie
konkretna aktywacja nadal wymaga osobnej decyzji operatora dla tego samego SHA.


## Wykonanie zatwierdzonego requestu — 23.10.2026

Zarządzany build `0e30f618f98e49cc973b7dd8b545cf30` i promocja
`9f40a801672048b4b224d3db6263de39` zakończyły się exit0 w tym samym
stałym backendzie własnej grupy. Pakiet: commit
`69a7ff212193917ee7b5cec74cf741721e8a62b5`, snapshot
`a9aee69fe28d4f345632e33f49445c937d1a2fe2f027d92f3881a69c1018be95`,
receipt SHA256 `a5e6c76c01351868fe7a077e32193e331a27fe902ad7bc55b9fe28d1aebcd3c4`.
Produkcja zawiera korekcję RT0/KKT; nie oznacza to wykonania nowego solve.

Native verify-only requestu raw SHA256
`23a9ecd41c672d91c9572401e073b7f86d50ab481e1c1aed9f43ae7b0b93d0ee`
zakończył się exit0; 66 obserwowanych plików pozostało identycznych.
Po jednoznacznej zgodzie użytkownika wykonano dokładnie ten request.
Proces zakończył się exit1 dopiero na archiwizacji slotu:
`Invalid cross-device link (os error 18)`.

Potwierdzony stan po operacji:

- katalog revision47: Failed/Disconnected; istnieje DoNotRetry;
- lokalny compute lease Released, heartbeat18;
- dokładna rezerwacja Solver Released z istniejącym proof SHA256
  `62a33d02037dc04728289f5b57f4ffa95453aaa6134a9f68f3439807085e3374`;
- cały aktywny slot i owner SHA256
  `1556112ac3c3af1d850125e1b9f25691d59ae2f91f6c21d29c914a74c7d8f89d`
  pozostały zachowane; cel archiwizacji nie istnieje;
- częściowy wynik Zarr zachował wszystkie uprzednio zapisane hashe;
- API pozostaje zatrzymane; nie ponowiono Solve ani recovery.

Przyczyna: aktywny slot i store znajdują się na mount ID1298/dev2096,
a `runtime-services` jest overmountem wolumenu kontrolnego, mount ID1310/dev2112.
Atomic rename nie przenosi między mountami. Verify-only nie sprawdził tego
warunku przed trwałą finalizacją. Samo równe st_dev też nie dowodzi zgodności
mountów. Pełny wynik znajduje się w wolumenie kontrolnym pod
`verification/public-loop-solve-fixed-binding-20261022/reaped-worker-native-preflight-69a7ff212/`,
pliki `activation-result.json` i `post-activation-observed-state.json`.

Dokończenie wymaga poprawki natywnej archiwizacji oraz nowego pakietu i
preflightu. Oryginalny request pozostaje niezmieniony: jego canonical digest
jest częścią już zapisanego Failed reason. Nowe narzędzie musi być osobno
przypięte i sprawdzić stary pakiet zachowany przy promocji. Operacja domykająca
nie może ponownie terminalizować, zwalniać rezerwacji, zmieniać inboxu ani
przepisywać historii. Archiwum ma znaleźć się poza overmountem runtime-services,
na tym samym mount co slot, z zachowaniem zgodności odczytu dawnego archiwum.
To plan poprawki, nie dowód jej wykonania. Żadnego accepted V/J/H.


## Poprawka źródłowa domknięcia archiwum

Nowy jawny `--complete-reaped-worker-archive` przyjmuje niezmieniony oryginalny
request i osobny envelope `runtime_service_reaped_worker_archive_completion.v1`.
Envelope przypina raw SHA oryginału, dokładny retained backup jego pakietu,
cztery piny nowego narzędzia, canonical Failed event/DoNotRetry oraz już istniejący
release proof. Pod HOST→STORE writer potwierdza terminalną historię i oba Released;
nie terminalizuje, nie publikuje nowego release, nie ACK i nie ponawia solve.
Nowe archiwum: `store/reaped-worker-recovery/<request-id>/supervisor-slot`.
Czytnik zachowuje legacy archive i odmawia wielu lokalizacji. Mount ID/dev
rzeczywistego slotu oraz rodziców są sprawdzane przed pierwszą mutacją i przed
FD-relative renameat2 NOREPLACE. Sprawdzany jest inode oraz fsync ancestorów
przed rename i na replay. Verify-only nie tworzy katalogów archiwum.

Parser Rust i diff-check PASS; nowe focused regresje historii, envelope,
package pins, mountów, collision/inode/replay są przygotowane dla CI.
Brak lokalnej kompilacji Rust unitów. Build/promocja nowego narzędzia,
rzeczywisty preflight oraz dokończenie archiwizacji pozostają NOT VERIFIED.
Freeze i dokładny CLI/schema: wolumen kontrolny,
`verification/public-loop-solve-fixed-binding-20261022/archive-completion-source-review-20261023.json`,
SHA256 `945ac79e176374ddb11dc0e043e16b64ab6e975df04d855574213eb454534936`.

## Potwierdzone domknięcie archiwizacji — 23.10.2026

Poniższy wynik zastępuje wcześniejszy status NOT VERIFIED dotyczący wykonania
archiwizacji. Nie zmienia statusu kwalifikacji naukowej anteny.

Pakiet `b62950ee11a76f74a1f2bf1d9913de2e068c4ac2` zbudowano i promowano
w stałym backendzie własnej grupy Compose. Build
`93be046105c247a28b1b980a90287213`, promocja
`0f793cf34e4d4600846f117b0ae5f7ce`; receipt SHA256
`174702b8a526a5cad3118de162cb932791971034177c49c0c6d616e9ca79e41f`.
Obie wymagane kontrole recovery w jobie GitHub `120129279703` przeszły;
cały job miał osobne błędy późniejszych kontraktów API, więc nie jest zieloną
bramką integracji PR.

Niezmieniony oryginalny request raw SHA256
`23a9ecd41c672d91c9572401e073b7f86d50ab481e1c1aed9f43ae7b0b93d0ee`
powiązano z completion envelope raw SHA256
`e784e0884f914fef1e9e36a730e32fe007a5562d371628d48d941ec97d6906dc`.
Native verify-only zakończył się exit0 w 2,653 s; 68 obserwowanych plików
pozostało identycznych. Następnie, w granicach zgody użytkownika na archiwizację,
native completion zakończył się exit0 w 2,489 s: archive_applied=true,
leases_modified=false, terminal_state_modified=false, solve_replayed=false.

Archiwum znajduje się w
`store/reaped-worker-recovery/57f0de2b-10a5-43b7-b730-5028da02ad3c/supervisor-slot`.
Zachowano inode246076 i owner SHA256
`1556112ac3c3af1d850125e1b9f25691d59ae2f91f6c21d29c914a74c7d8f89d`.
Po uwzględnieniu wyłącznie przeniesienia ścieżki slotu wszystkie 68 obserwowanych
plików ma te same bajty. Częściowy Zarr, historia, ledger i oryginalny request
pozostały zachowane. Aktywny slot nie istnieje; Failed/DoNotRetry i Released
pozostają trwałe. Nie należy ponawiać finalizacji ani zwalniania tej próby.

Pełne dowody w wolumenie kontrolnym grupy:
`verification/public-loop-solve-fixed-binding-20261022/archive-completion-native-preflight-b62950ee1/`:
`completion.json`, `ci-proof.json`, `activation-command.json`,
`post-activation-proof.json` oraz wyniki preflightu i aktywacji.

Następnie kanoniczne odtworzenie usług usunęło tylko stare kontenery,
z zachowaniem wolumenów i danych. Receipt próby
`e71bc5ab9ccb41ba88a3856428ce8754` ma raw SHA256
`0d359fef32ac717675c08a56f4f6199e2d6ca2258dcdf3fc9d0563134309c166`.
Start usług nadal wymaga naprawy kontynuacji: walidator próbuje inspect już
usuniętego backendu zamiast użyć istniejącego przypiętego retained snapshotu.
API/UI są obecnie zatrzymane. Nowego solve ani accepted V/J/H nadal nie ma.
