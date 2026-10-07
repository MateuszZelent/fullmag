# P8-53AW — awarie i anulowanie przygotowania kandydata

Data: 05.10.2026. Stan: natywne fault gates PASS, 10/10 kontroli.
Kontynuacja [P8-53AV](53av-asynchronous-candidate-preparation.md).

Pozytywny cykl AV potwierdził nieblokujący krok, lease i reuse pakietu.
Nie dowodził zachowania po przerwaniu wejścia, przekroczeniu limitu odpowiedzi,
timeout ani anulowaniu. Ten przyrost uzupełnia tę konkretną część fault gates.
Nie zastępuje zmiany scope w pełnej pompie, restartu z modelem ani UI hydration.

## Zakres

Prywatny przypadek `preparation-faults` używa produkcyjnego
`CandidateHelperProcess` w zbudowanym CLI, z podwójną bramką probe.
Każdy proces testowy ma wczesny zapis PID oraz terminalny wynik procesu
i transportów. Niepotwierdzone zakończenie pozostaje odmową bramki.
Nie uruchamiamy API i nie zatrzymujemy workspace użytkownika.

Recepta `just verify-windows-candidate-preparation` wykorzystuje resolver,
rejestr właściciela, blokadę diagnostyczną, zweryfikowany frozen package,
sprawdzoną kopię binariów i końcowy receipt. Nie kompiluje testów jednostkowych.
Native build przed próbą pozostaje zarządzaną receptą Windows.

| Przypadek | Wymagany rzeczywisty wynik |
|---|---|
| Sukces | Odebrane wejście, bounded output, exit 0 i potwierdzony terminalny proces |
| Niezerowy exit | Jawna odmowa, rzeczywisty kod procesu, potwierdzone zakończenie |
| Nadmiar output | Odmowa przekroczenia limitu, zakończony proces i transporty |
| Jawne anulowanie | Brak przyjęcia wyniku, odebrany własny proces i transporty |
| Timeout | Brak przyjęcia wyniku, odebrany własny proces i transporty |
| Niepełne stdin | Potwierdzenie niezapisania pełnego requestu i odmowa wyniku |
| Wczesny exit | Potwierdzone zakończenie własnego procesu i odmowa wyniku |

Najdłuższy rzeczywiście zmierzony krok `poll` musi trwać poniżej 1000 ms.
Deadline'y krótkich fixture jobs nie zmieniają produkcyjnych limitów 120/20 s.
Driver przy timeout zachowuje unknown outcome i log; nie uznaje braku output
za dowód zakończenia procesu oraz nie zabija niezweryfikowanych helperów.

## Dowody

Interpretowane testy walidacji receipt: **9/9 PASS**. Obejmują zachowanie
unknown custody z early PID, zgodność terminalnego PID, odmowę duplikatów,
nieodebranych/obcych procesów, nieznanego exit code, false gate i przekroczonego
limitu kroku, limit logu podczas pracy, zachowanie PID przed niepełną lub
błędną kolejną ramką oraz osobne potwierdzenie custody przy failed gate.
Python AST i rustfmt/parser PASS. Ungated helper odmówił uruchomienia
z exit 2. Nie stanowi to jeszcze dowodu lifecycle Rust.

Review wykryło i poprawiono nieograniczony zapis logu/odczyt częściowej ramki
po timeout: collector ogranicza odbiór do 128 KiB, zapisuje stabilny snapshot,
a early PID trafia do receipt przed dekodowaniem dalszych ramek. Nieodebrany
transport zachowuje unknown outcome. Recheck bez kolejnego blokera.

Pierwszy build został odmówiony przed kompilacją przez
`assert_frozen_dependencies`: zależności działającej sesji różniły się od
checkoutu. Nie obchodzono guardu. Własne testowe API
`b0407349-d370-456f-b2a5-ca43a771faeb` nadal miało `session_id=null` i epoch 0.
Po potwierdzeniu drzewa procesów zamknięto jego desktop PID 90356,
rodzic CLI 90060. Owner generacji `422ee6b89e1c418bbe758b22cf7b2cb2`
zakończył się completed, exit 0, launcher/watcher waited true; porty zamknięte.
Kolejny build oczekiwał na zwolnienie tej samej blokady, bez nowego targetu.

Pozostają: review, produkcyjny build, wykonanie siedmiu rzeczywistych przypadków,
kontrola kodów wyjścia, brak pozostałych procesów i końcowy receipt. Procenty
P0–P8 oraz publiczne `restart_available=false` nie zmieniają się na podstawie
tych testów źródłowych.

Review natywnej próby wykryło trzy niewystarczające warunki: cancel i timeout
mogły zaliczyć przypadek bez przyjęcia żądania, a niepełne stdin bez oczekiwanego
ACK. Wymagamy bounded handshake po strict validation, pełnego zapisu stdin
dla cancel/timeout oraz rzeczywistego exit 0, ACK właściwego przypadku i
niepełnego zapisu rodzica dla incomplete stdin. Failed output pozostaje
limitowany; normalna produkcyjna trasa nie używa probe readiness.

Wcześniejszy snapshot
`93572059c018ab972d32f6db983267abc6d239d34ce8610928774ca556fc2818`
zbudował się z exit 0 (`native-build-ec302e3048f3450cba134a694b8bb826.log`;
CLI/API 1 min 27 s, desktop 46,37 s). Nie kwalifikuje wzmocnionych fault gates.
Poprawka wymaga nowego snapshotu i wykonania próby po rechecku.

Recheck warunków ACK/pełnego stdin/exit code wykrył jeszcze akceptację
ACK przed sprawdzeniem cutoffu. Poprawiono kolejność i ponowny odczyt czasu
po potwierdzeniu żywotności. Dziewiąta bramka `late_ack_refused` wywołuje
tę samą funkcję dla rzeczywiście potwierdzonego, żywego helpera, z cutoffem
1 ms w przeszłości; musi otrzymać `DeadlineExpired`. Recheck bez blokera.
Kontrakt próby: siedem procesów/przypadków i dziewięć kontroli zachowania.
Po zmianie kontraktu 9/9 interpretowanych testów, Python AST i rustfmt PASS.

Próba `33a4fec93a7842deae5092c1e9f1dcbf` zakończyła się failed, exit 1;
nie zalicza bramki. Wszystkie osiem procesów ma terminalne dowody, w tym
CLI 64328 exit 1. Cancel, timeout, late ACK i pozostałe przypadki poza dwoma
miały true w wyniku natywnym. Dwie odmowy nie zostały pominięte:
overflow zakończył się kodem 1 po zatrzymaniu helpera na limicie, a request
16 KiB zmieścił się w Windows pipe i incomplete stdin niespodziewanie completed.

Overflow nadal wymaga pełnego stdin, dokładnego powodu, 65 bajtów `x` oraz
rzeczywistego odebranego exit code; nie wymaga graceful exit 0 po kill.
Wyłącznie fixture incomplete stdin zapisuje prefix, czeka na output helpera,
a potem próbuje tail. Helper po strict prefixie zamyka descriptor stdin,
emituje ACK i kończy 0. Tail trafia na rzeczywiście zamknięty pipe; żaden
bit błędu nie jest syntetyzowany. Limit requestu i produkcyjne write_all
pozostają niezmienione. Regresja rzeczywistego Windows pipe: 1 PASS (0,139 s),
ACK właściwego przypadku, actual OSError i exit 0. Recheck obu korekt bez blokera.

Nową receptę podpięto do ścisłego dispatcher'a `just_storage_shell.sh`;
wcześniejsze odmowy wrappera nie uruchomiły probe. Kolejna odmowa builda
przez active dependencies dotyczyła zmienionych `scene_document_ir.py` i
`script_builder.py` oraz plików testów pakietu Python. Nie obchodzono guardu;
własne testowe API `215a987c-fa38-4d27-84e6-bc54ac3d3f86` miało null session.

Po zamknięciu pustego workspace capture nowych źródeł przeszedł poprawnie,
ale staging frontendu zatrzymał się na ENOSPC. Nie usuwano cache ani targetów.
Po zewnętrznym zwolnieniu miejsca build `native-build-5cfab68aa960479aa0f9919071c2cfcc.log`
zakończył kompilację CLI/API w 3 min 47 s i desktopu w 1 min 51 s.
Snapshot `e11e2af74a4e0753f5047d0fb7b9dc813965d790a6d35d8de11200fad7344e58`
uruchomił pusty workspace na 3197; `/workspace` HTTP 200, ekran Welcome,
brak aktywnej sesji i przycisk Build backend potwierdzono w przeglądarce.

Próba `09edf056c9da4315abcf26656636bdd6` pozostaje failed, exit 1.
Osiem z dziewięciu natywnych kontroli przeszło; wszystkie osiem procesów
ma potwierdzony terminalny wynik. Incomplete stdin miało rzeczywisty błąd
zapisu, ale rodzic zdążył zatrzymać helpera (exit 1) po ACK przed jego exit 0.
Nie osłabiono wymaganej bramki: wyłącznie ten fixture zwalnia zapis ogona
dopiero po odczytaniu rzeczywistego `exit_status`. Produkcyjny `write_all`
pozostaje bez zmian. Niezależny przegląd, rustfmt i diff check bez blokera;
nowy build na żądanie trwa bez restartu aktywnego UI. Wynik tej korekty
w natywnym EXE pozostaje NOT VERIFIED do ponownego wykonania próby.

## Końcowa weryfikacja natywna

`just windows-backend-dev 3197` zakończył build poprawki exit 0:
CLI/API 2 min 03 s, desktop 54,19 s. Log:
`native-build-b78908d003704d3c9a8feb05f1acfd57.log`.
Capture: `44a082025595998c423f85b777fd9ed9ea3bf91321800a6870f0f75508a3a298`.
Verified build ID: `cf9de655affa94e13bb8777a907ddef5b27e507e68f3cb2ff1cf079f41f6bde8`.
Build source identity: `7919e362b8225ec95e983e05a696f4a4d840e55c69c4c70dfcdc2f24de5689ee`.

Próba `cce9f225893f4fae97c3a3d15906641e`, 17:22:36–17:23:20 CEST:
completed, exit 0, dziewięć kontroli zachowania i canonical-codegen-identity
PASS. Najdłuższy zmierzony `poll` 0 ms w rozdzielczości całych milisekund;
nie jest to twierdzenie o zerowym koszcie. Wszystkie procesy mają waited true:

| Proces | PID | Rzeczywisty exit | Wynik |
|---|---:|---:|---|
| CLI | 99984 | 0 | terminal |
| success | 101048 | 0 | completed |
| nonzero_exit | 94172 | 7 | failed |
| output_overflow | 104460 | 1 | failed |
| explicit_cancel | 79540 | 1 | failed |
| timeout | 100816 | 1 | failed |
| incomplete_stdin | 103380 | 0 | failed: rzeczywiście niepełny zapis |
| child_early_exit | 105468 | 9 | failed |

Receipt znajduje się w zarządzanym storage:
`builds/fullmag-0950f4dca4ffe38f/development-backend-api-checks/checks/cce9f225893f4fae97c3a3d15906641e/receipt.json`.
Zakres PASS obejmuje fault gates helpera. Nie kwalifikuje zmiany scope w
pełnej pompie, restartu z niepustym modelem, UI hydration ani wydania.

Kontrola regresji normalnej pompy po zmianie transportu:
`just verify-windows-development-consumer-pump 3b1de31747fb4fe7b5275b8cfdec42cd`
PASS, receipt `d0ac867fd7624f549d68cc99ead7eaa3`, completed, exit 0,
13/13 kontroli. Pierwszy krok przygotowania 21 ms, helper pozostawał aktywny.
Potwierdzono wybór kandydata, odnowienie i wygaśnięcie lease, withdrawal,
reuse jednej kopii oraz brak żądania i zastąpienia procesu. CLI 103748,
initializer 105028 i helpery 99160/101012/102004: waited true, exit 0.
Własne API diagnostyczne 105464, port 28242: waited true, rzeczywisty exit 1
po jawnym zamknięciu próby; nie jest to graceful exit 0. UI na 3197
pozostało oddzielną, działającą sesją. Stale scope i odtworzenie niepustego
workspace nadal wymagają osobnych dowodów.
