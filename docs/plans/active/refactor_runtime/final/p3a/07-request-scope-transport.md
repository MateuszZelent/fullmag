# P3a — oczekiwana sesja w transporcie HTTP

Checkpoint: 22.09.2026, lokalny dirty `master`, baza
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`.

## Problem i zmiana

Klucz cache zawierający session/epoch nie zabezpieczał żądania wysłanego
po przełączeniu `current`. Fasada zachowywała `sessionScopeKey` wyłącznie
we współdzieleniu wybranych żądań. Loadery często przekazywały tylko `signal`.

`ControlRoomApi` przekazuje teraz `x-fullmag-session-scope` przez wszystkie
helpery JSON i binary. Loader otrzymuje scope z `ResourceRuntimeStore`
i przekazuje go razem z sygnałem anulowania do fasady. Scope nie trafia do URL.

Middleware API sprawdza kanoniczny format, odrzuca duplikaty nagłówka
i przechowuje oczekiwaną tożsamość w kontekście zadania obsługującego żądanie.
`capture_current_live_request_context` porównuje ją z bieżącą tożsamością
pod blokadą transition. `ensure_current_live_request_context` zachowuje
dalszą kontrolę tożsamości i wewnętrznego epoch. Nie ma blokady transition
utrzymywanej przez całe `next.run`, która kolidowałaby z blokadami handlerów.

Publiczny kontrakt jest zapisany w ADR 0011, specyfikacji resource-first
i modyfikatorze OpenAPI. Bootstrap pozostaje bezscope'owy; WS i globalne
telemetrie nie reklamują tego warunku.

## Dodatkowe poprawki

- Import assetu uzyskuje blokadę transition przed walidacją i zapisem pliku,
  zachowując ją przez aktualizację indeksu oraz publikację realtime.
- `clear()` historii unieważnia rozpoczęte Undo/Redo. Spóźniony odczyt
  nie wysyła restore, spóźniony ACK nie odtwarza stosów ani nie publikuje sceny.
- Publikacja sceny z jawnym scope aktualizuje konkretny alias zasobu.
- Callback Physics Interaction uwzględnia scope w zależnościach React.

## Granice i następne kroki

Review wykrył dodatkowo brak scope w pomocniczym odczycie świeżości meshu.
Poprawiono `meshIsStale`: współdzielony odczyt zachowuje sessionScopeKey,
ale nadal nie jest anulowany sygnałem pojedynczego konsumenta. Rozszerzono
regresję materializacji pól o kontrolę nagłówków obu sesji.

Regeneracja ujawniła blokadę działającego `fullmag-api.exe` na Windows.
Dodano osobny bin `fullmag-api-openapi`, dostępny tylko z feature
`openapi-codegen`, z wyłączonymi testami/bench. Domyślny serwer pozostaje
`fullmag-api`. Generator zapisuje kontrakt dopiero po udanym procesie,
parsowaniu JSON i sprawdzeniu wymaganej ścieżki; używa pliku tymczasowego
oraz rename. Wygenerowany kontrakt ma 300 operacji, 285 deklaracji nagłówka.
Typy i transport zregenerowano narzędziami repozytorium; generator typów
wymagał zatwierdzonego wyjścia poza sandbox z powodu EPERM w node_modules.
Hostowa generacja jest dowodem kontraktu, nie managed runtime. Zgodności
jej lokalnego katalogu Cargo target z bramką managed storage nie potwierdzono;
nie wykonywano usuwania cache ani zatrzymywania działającego API.

1. Brak nagłówka jest nadal adapterem zgodności. Wymagana jest migracja
   wszystkich komend, helperów authoringu oraz paneli; sama obecność
   nagłówka w fasadzie nie dowodzi kompletności konsumentów.
2. Tekstowy epoch statusu opiera się na session_id i timestampach. Ponowne
   otwarcie identycznej tożsamości może dać tę samą wartość. Wewnętrzny
   licznik chroni rozpoczęte żądanie, ale nie odróżni nowego żądania
   ze starym, kolidującym scope. Potrzebna jest jawna tożsamość inkarnacji.
3. Task-local nie zastępuje przekazania immutable context do osobnych zadań
   ani blokady przed skutkami ubocznymi. Trasy `OPEN` nadal wymagają review.
4. Testy źródłowe obejmują parser, zgodny/stary scope, bootstrap, brak skutku
   stale mutation, kontrakt OpenAPI, transport JSON/binary oraz wyścigi
   importu i historii. Nie zostały uruchomione w tym przyroście: aktualne
   AGENTS.md zabrania kompilacji testów jednostkowych.
5. Managed runtime, browserowe A→B podczas await/decode oraz kwalifikacja
   wydania pozostają `NOT VERIFIED`. Nie podniesiono procentów realizacji.

Aktualne wyniki kontroli integracyjnych znajdują się w
[`../06-status-realizacji.md`](../06-status-realizacji.md).

## Kolejny przyrost — polityki meshingu

PUT polityki shared-domain i interfejsu zachowują teraz request context
przez odczyt sceny, commit oraz pobranie rewizji odpowiedzi. Zapisano
regresję odrzucenia starego scope bez zmiany sceny. Oba wiersze pozostają
`OPEN`, dopóki nie zostanie zamknięta migracja klientów i wymagane dowody.

Ponowna próba kontroli API przez `fullmag_storage.py run` została odrzucona
przez preflight: host jest zarządzany przez container runner. Bezpośredni
status zatwierdzonego klienta runnera zakończył się błędem
`Container profile allow-list mismatch`. Nie wykonywano fallbacku kompilacji
tej zmiany poza kolejką, zmiany konfiguracji operatora ani restartu kontenera.
Kompilacja przyrostu meshingu i jego regresja pozostają `NOT VERIFIED`.

Diagnostyka runnera wykazała zgodne ze sobą konfiguracje publiczną i sekretną,
ale zawierające dodatkowy profil `fem-cpu-slepc-runtime-v1`. Początkowa
interpretacja, że profil jest wycofany, była błędna: pochodzi z innej linii
rozwoju i aktywny runner go używa. Bieżący master zna sześć profili.
`container-configure --enable-slepc-modal` nie rozwiązuje tego przypadku,
a usuwanie profilu naruszyłoby współdzieloną konfigurację. Znaleziono zgodny
klient, który odczytał zdrowie runnera bez zmiany polityki dopuszczenia.
Szczegóły i aktualna blokada miejsca: [08-runner-client-status.md](08-runner-client-status.md).

Audyt inkarnacji potwierdził, że `session_epoch` należy także do tożsamości
observation frames. Nie należy nadpisywać jego znaczenia UUID procesu.
Następny przyrost kontraktu dodaje osobny `request_scope_epoch`
(UUID instancji API + monotoniczny licznik transition), uwzględniony w
nagłówku HTTP, kluczach cache oraz resetach frontendowych. Wymaga wspólnej
regeneracji OpenAPI i testu ponownego otwarcia przy tym samym session_id
i timestampie. Realtime wymaga osobnej kontroli inkarnacji; sama migracja
HTTP nie zamyka tej części P3a.

## Izolacja publikacji sceny i spóźnionej historii

`publishCommittedSceneResource` nie rozsyła już payloadu bez znanego scope
do cache wszystkich sesji. Zachowuje alias zgodności i invalidację, która
zleca sesyjnym odbiorcom własny odczyt. Przy znanym scope zasila tylko cache
właściciela; `invalidate=false` nadal nie uruchamia odświeżania. Publikacja
edycji regionów przekazuje scope przechwycony przez panel. Zapisano regresję
z dwiema niezależnymi sesjami.

Helper immediate authoringu przechwytuje generację historii przed pierwszym
odczytem sceny i sprawdza ją przed zapisem wpisu oraz po odczycie po ACK.
`clear()` zmienia generację także dla pustego stosu: pierwsza, jeszcze
oczekująca edycja nie może przywrócić historii starej sesji. Zapisano regresje
dla spóźnionego ACK, zmiany generacji podczas odczytu po ACK i pustej historii.
Ta ochrona dotyczy zapisu historii; nie zastępuje backendowego request fence.

Kontrole API hygiene i repo consistency przeszły. Nowe regresje pozostają
`NOT RUN` z powodu aktualnego zakazu kompilacji testów jednostkowych.
Dowody browser/runtime i kwalifikacji wydania nadal pozostają otwarte.

Komendy mapy pola przekazują przechwycony scope do odczytów domeny,
wizualizacji, eksportów oraz operacji planar monitor (łącznie z odczytami
pomocniczymi i historią). Kolejny przyrost dodaje kontrolę lokalnych skutków
po await, opisaną poniżej. Sama migracja transportu nie zamyka komend P3a.

Panel Frozen Spins przekazuje scope do patch/createPreview/activatePreview/delete
oraz odczytów historii. Zachowany ostatni zasób i klucz edytora zależą od
scoped resource key, więc takie samo constraint_id w innej sesji nie zachowuje
starego draftu. Po demontażu edytora odpowiedzi tych operacji nie publikują
invalidacji ani nie czyszczą zaznaczenia aktualnego workspace. Dodano źródła
regresji scope i spóźnionego ACK. Końcowy frontend typecheck po tych zmianach
zakończył się exit 0; nie jest to dowód wykonania regresji ani browser smoke.

## Kontrola scope wykonywanej komendy

`CommandRegistry` korzysta z adaptera istniejącego cache `session:status`.
Nie powstaje drugi magazyn statusu: adapter wylicza scope przy odczycie.
`createCommandContext` przechwytuje scope przy utworzeniu kontekstu UI,
żeby stare wejścia komendy nie zostały przypisane automatycznie nowej sesji.
Kontekst przekazany bez scope bezpośrednio do registry otrzymuje bieżący
scope przy wykonaniu. Jawnie przekazany scope zostaje zachowany.

Na czas wykonywania komendy registry subskrybuje status i udostępnia
`isCurrentSessionScope`. Raz zaobserwowana zmiana A→B unieważnia komendę
także po powrocie do A. Subskrypcja jest zwalniana w `finally`, również
po błędzie. Nie zmienia to publicznych danych sesji ani scientific epoch.

Komendy mapy pola sprawdzają fence przed działaniem i po odczytach/ACK,
zanim utworzą draft, opublikują podgląd, zmienią widok, pobiorą PNG lub
wykonają invalidację. Helper historii sprawdza również ten fence przed
zapisem wpisu. Anulowanie lokalnego skutku po ACK nie cofa zatwierdzonego
wcześniej zapisu na serwerze.

Źródłowe regresje obejmują A→B→A, scope przechwycony przez UI, zwolnienie
subskrypcji po błędzie, stary ACK usunięcia monitora, przełączenie podczas
odczytu domeny i ochronę historii. Testy pozostają `NOT RUN`. Kontrole
architecture hygiene, API hygiene, końcowy typecheck i repo consistency
przeszły. Runtime/browser nadal wymaga
oddzielnego dowodu. Bez obserwowalnej zmiany statusu lub przy kolizji
zewnętrznego session_id+epoch fence nie wykryje nowej inkarnacji; późniejszy
przyrost poniżej dodaje `request_scope_epoch`. Pozostałe komendy wymagają migracji
lokalnych skutków do callbacku, nie tylko obecności callbacku w registry.

## Domknięcie review i migracja komend regionów

Review ochrony field-map potwierdził kolejność capture/await/publication
i cleanup obserwatora, lecz wykrył regresję pustego workspace. Naprawiono ją:
`field-map.open` jest czystą, synchroniczną nawigacją i działa bez live session;
wybór konkretnego monitora oraz operacje asynchroniczne nadal mają fence.

Wspólny helper `commandSessionScope.ts` obsługuje sprawdzenie aktualności
i typowane anulowanie. `runAuthoringMutationWithHistory` sprawdza scope
przed przygotowaniem oraz po odczycie sceny, zanim wywoła mutację. Registry
rozpoznaje `SessionCommandCancelledError` jako `cancelled`, także w zdarzeniu
ukończenia i diagnostyce. Field-map ponawia kontrolę przed zapisami
poprzedzonymi dodatkowymi odczytami kolekcji/monitora.

Duplicate/delete/reorder region oraz disable/delete coupling sprawdzają
scope na wejściu i po ACK, przed invalidacją lub czyszczeniem zaznaczenia.
Synchroniczna nawigacja focus/report pozostaje niezależna od tego mechanizmu.
Zapisano regresje pustego widoku, anulowania podczas przygotowania historii,
statusu anulowania registry oraz zachowania nowego zaznaczenia po starym ACK
usunięcia regionu/sprzężenia. Testy pozostają `NOT RUN`; bieżący typecheck,
architecture hygiene, API hygiene i diff check zakończyły się exit 0.
Nie zmieniono procentów ani statusów runtime/scientific/release.

## Komendy geometrii

Realizacja i walidacja geometrii przekazują scope do typed API i sprawdzają
aktualność po odpowiedzi przed invalidacją zasobów. Dodanie anteny sprawdza
scope po odczycie sceny przed transakcją oraz po ACK. Zapis szkicu i usunięcie
obiektu używają `prepareAuthoringMutation`, aby przechwycić również generację
historii przed odczytem, a następnie `recordAuthoringMutationHistory` z fence
po ACK. Każda z tych komend sprawdza aktualność przed lokalną publikacją,
w tym przed czyszczeniem zaznaczenia. Zapisano regresje przełączenia sesji
podczas odczytu sceny i spóźnionego ACK usunięcia.

Bieżące `typecheck`, `check:api-hygiene`, `check:architecture-hygiene` i
`git diff --check` zakończyły się exit 0. Regresje pozostają `NOT RUN`;
backend runtime i browser nie były wykonywane w tym przyroście. Pozostałe
komendy meshingu w tym samym pliku opisano w następnym przyroście.

## Komendy budowy siatki

Blokada zlecenia i zapamiętany `client_intent_id` są teraz partycjonowane
według przechwyconego scope sesji w obrębie klienta API. Operacja sesji A nie
blokuje nowego zlecenia w B, a zachowany zamiar A może być obserwowany po
powrocie do jego scope bez ponownego POST. Potwierdzenie sprawdza aktualność
sesji przed wysłaniem; odpowiedź POST, rekonsyliacja przez list/detail i
terminalne odpytywanie używają przechwyconego scope. Spóźniony wynik nie
publikuje zdarzeń ani invalidacji zasobów nowej sesji. Obejmuje to także
`fdm_grid_refresh` oraz odtworzenie obserwacji po reload. Kontekst utworzony
bezpośrednio przez UI ma domyślną kontrolę bieżącego scope; registry wzmacnia
ją monotoniczną subskrypcją na czas wykonywania komendy.

Zapisano regresje dla potwierdzenia po przełączeniu i zaakceptowanego zlecenia
A kończącego się po wykonaniu B. `typecheck`, `check:api-hygiene`,
`check:architecture-hygiene` i `git diff --check` zakończyły się exit 0.
Regresje jednostkowe pozostają `NOT RUN` przy obowiązującym zakazie ich
kompilacji. Browser/managed runtime nie były wykonywane. Tożsamość
`session_id+epoch` nie rozróżnia każdej inkarnacji po reopen; kolejny
przyrost dodaje niezależny `request_scope_epoch`.

## Inkarnacja zakresu żądania — przyrost 23.09.2026

`AppState` nadaje instancji API UUID. `current_live_session_epoch` pozostaje
licznikiem transition, a `request_scope_epoch = <UUID>:<counter>` jest
publikowany w `LiveStatus.session` i sprawdzany przez middleware razem z
`session_id` i naukowym `session_epoch`. Stary scope przy ponownym otwarciu
identycznego session ID i timestampu jest odrzucany. `session_epoch`
observation frames nie zmienia semantyki.

Frontend wymaga trzeciego pola statusu do utworzenia tożsamości zasobu. Klucze
HTTP/cache/decode i komend zawierają je; viewport resetuje cache i odrzuca
spóźnione przyjęcie renderu z poprzedniej inkarnacji. Mode composition oraz
draft materiału używają tego samego klucza. Uzupełniono ADR 0011, specyfikację
API, źródło OpenAPI oraz JSON/types/client. JSON OpenAPI zaktualizowano
bezpośrednio z kontraktu źródłowego; pełna regeneracja z działającego Rust
generatora nadal wymaga builda.

Dodano regresje parsera, backendowego 409 przy identycznym naukowym epoch,
różnych kluczy frontendowych oraz odrzucenia starego renderu. Testy pozostają
`NOT RUN` z powodu zakazu kompilacji testów jednostkowych. Kontrola typów,
API/architecture hygiene, parser Rust siedmiu plików, spójność repozytorium
i walidacja JSON przeszły. Managed build z migawki dirty `master` nie wszedł
do kolejki: API runnera zwróciło HTTP 413; profil FDM CPU nie ma
skonfigurowanego obrazu. Nie ma nowego joba ani dowodu kompilacji backendu.
Realtime, browserowe A→B→A i kwalifikacja wydania pozostają `OPEN`.
Celowany ESLint przechodzi dla pozostałych zmienionych plików; pełna
kontrola zestawu zwraca trzy istniejące błędy `react-hooks/immutability`
w `FdmCuboidLayer.tsx` przy mutacji `surfaceMaterial.needsUpdate` (linia 1207),
niezwiązanej z dodanym porównaniem tożsamości.

### WebSocket — inkarnacja połączenia

Upgrade przechwytuje `CurrentLiveRequestContext` pod blokadą przejścia sesji.
Obsługa połączenia sprawdza tę inkarnację przed `hello`, odtwarzaniem zdarzeń,
odbieraniem kolejnych wpisów i heartbeat; po zmianie zamyka strumień. Klient
Control Room wiąże cykl życia WebSocketu z pełnym `sessionRequestScopeKey`,
więc zmiana `request_scope_epoch` usuwa stare listenery i otwiera nowe
połączenie bez starego kursora. Kursor `after_seq` większy niż bieżący
licznik serwera daje `resync.required` i nie blokuje kolejnych zdarzeń.
Dodano źródłową regresję zależności połączenia od scope.

Kontrola składni Rust i `git diff --check` przeszły. Ponowny typecheck i
celowany ESLint nie dotarły do źródeł: Windows zwrócił `EPERM` podczas
odczytu binariów Next/ESLint w `node_modules`. Wcześniejsze zielone kontrole
dotyczą stanu sprzed tego małego przyrostu; brak świeżego potwierdzenia
frontendowego. Test regresyjny jest `NOT RUN`, a browserowe A→B→A,
odtworzenie kursora po transition i pełna kwalifikacja realtime pozostają
`NOT VERIFIED`. Zdarzenia nie niosą jeszcze własnego
`request_scope_epoch`, więc to nie zamyka całego kontraktu P3a.

### WebSocket — handshake zakresu

`hello.payload.request_scope_epoch` jest wymagany w schemacie Rust i AsyncAPI.
Klient ze znanym zakresem nie przetwarza żadnego zdarzenia przed zgodnym
`hello`; niezgodność zamyka socket i unieważnia status HTTP. Dzięki temu
ponowne połączenie ze starym kursorem po restarcie API nie może przyjąć
zdarzeń nowej inkarnacji pod starą tożsamością. Dodano regresje klienta dla
niezgodnego i zgodnego handshake oraz asercję wymaganego pola AsyncAPI.
Zdarzenia po `hello` dziedziczą scope połączenia; osobny epoch w każdym
rekordzie nie jest wymagany przez ten kontrakt. Typecheck, celowany ESLint,
API/architecture hygiene, kontrola składni Rust, parser AsyncAPI,
repo consistency i `git diff --check` przeszły dla tego przyrostu.
Typecheck i ESLint wymagały dostępu do plików zależności, które w zwykłym
trybie odczytu zwracały `EPERM`; nie zmieniano ACL ani zawartości
`node_modules`. Testy jednostkowe pozostają `NOT RUN` przy bieżącym
zakazie ich kompilacji. Backend build, test WebSocketu w przeglądarce,
replay po restarcie API i kwalifikacja wydania pozostają `NOT VERIFIED`.

## Eksport i import `.fms` — przyrost klienta 23.09.2026

Komendy `study.export-state` i `study.import-state` przekazują przechwycony
`sessionScopeKey` do fasady persistence. Eksport sprawdza scope przed
utworzeniem archiwum i po odpowiedzi, przed pobraniem pliku i invalidacją;
spóźniony wynik nie publikuje efektów w nowej sesji. Import ponownie sprawdza
scope po wyborze pliku i przed wysłaniem commit; backendowa walidacja nagłówka
odrzuca zmianę `current` między tymi krokami. Po udanym imporcie scope zmienia
się z definicji, dlatego odpowiedź nie jest porównywana ze starym scope.

Dialog Inspektora unieważnia wybór pliku po zmianie zakresu. Wynik odczytu
lub inspekcji starego pliku nie nadpisuje nowszego wyboru ani formularza
następnej sesji. Sama inspekcja `.fms` jest wejściowa i nie czyta aktualnego
runtime, więc nie wymaga nagłówka sesji. Dodano regresje dla nagłówków,
spóźnionego eksportu i importu anulowanego przed commit. Frontend typecheck,
celowany ESLint, API hygiene i `git diff --check` przeszły; testy jednostkowe
pozostają `NOT RUN` przy obecnym zakazie ich kompilacji. Scenariusz browserowy
A→B podczas wyboru pliku, runtime API oraz kwalifikacja wydania pozostają
`NOT VERIFIED`. Wiersze importu w inventory pozostają `OPEN` do tych dowodów.

## Checkpoint i stan pola — przyrost klienta 23.09.2026

Komendy Save/Restore Checkpoint oraz Save/Load Field State przekazują
`sessionScopeKey` do każdego żądania: create/restore, export, pobrania bajtów
artefaktu, importu assetu, inspekcji zgodności i importu stanu pola. Po
każdym `await` przed następnym żądaniem lub invalidacją sprawdzają, czy
przechwycony scope nadal jest bieżący. Wybranie pliku podczas Load Field State
jest kontrolowane przed zapisaniem assetu. Spóźniony wynik inspekcji nie może
uruchomić importu do kolejnej sesji, a spóźnione zakończenie restore/import
nie publikuje invalidacji jej pól.

Źródłowe regresje sprawdzają obecność scope w wywołaniach i anulowanie
importu po zmianie sesji w trakcie inspekcji. Backendowe handlery tych tras
przechwytują `CurrentLiveRequestContext`; frontend nie dodaje endpointów ani
drugiego klienta. Typecheck, celowany ESLint i `git diff --check` przeszły.
Testów jednostkowych nie uruchomiono przy obecnym zakazie ich kompilacji;
managed API, browserowe A→B podczas inspekcji/pobierania i trwałość
checkpointu pozostają `NOT VERIFIED`. Procenty realizacji pozostają bez zmian.

## Histereza — przyrost klienta 23.09.2026

Bookmark punktu, odczyt punktów przy eksporcie pętli CSV i zastosowanie
snapshotu jako stanu początkowego przekazują przechwycony `sessionScopeKey`
do API. Po odpowiedzi komendy sprawdzają aktualność sesji przed invalidacją
zasobów lub dalszym zapisem. Eksport CSV sprawdza ją także przed pobraniem
pliku. Dodano regresję źródłową dla spóźnionej odpowiedzi bookmarku, która
nie może opublikować revision w kolejnej sesji.

Typecheck, celowany ESLint, API hygiene i `git diff --check` przeszły.
Testy jednostkowe pozostają `NOT RUN` przy obecnym zakazie ich kompilacji.
Scenariusze browserowe A→B, managed API i kwalifikacja wydania pozostają
`NOT VERIFIED`; procenty planu pozostają bez zmian.

## Komendy runtime i profiler — przyrost klienta 23.09.2026

Wspólny helper komend Study wiąże z przechwyconym `sessionScopeKey` odczyty
statusu solvera, wykonania etapów, kolejki komend i stanu sesji używane do
odświeżenia preconditions. Po tych odczytach ponownie sprawdza scope przed
wysłaniem komendy. Submit używa tego samego zakresu, a spóźnione ACK nie
invaliduje zasobów kolejnej sesji. Tę samą osłonę ma osobna komenda profilera.
Regresje źródłowe obejmują zmianę sesji podczas odświeżenia preconditions
oraz spóźnione ACK; nagłówek scope profilera ma osobną asercję.

Typecheck, celowany ESLint, API hygiene i architecture hygiene przeszły.
Testy jednostkowe pozostają `NOT RUN` przy obecnym zakazie ich kompilacji;
browserowe A→B, managed API i kwalifikacja wydania pozostają `NOT VERIFIED`.

## Odczyt polityk meshingu — przyrost backendu 23.09.2026

GET polityki shared-domain oraz polityki interfejsu przechwytują immutable
`CurrentLiveRequestContext` razem ze snapshotem i walidują go ponownie przed
odpowiedzią. Dzięki temu odczyt nie publikuje danych po zmianie `current`
w trakcie przygotowania odpowiedzi. Odpowiednie PUT używają już context-bound
scene load/commit; ich wiersze inventory pozostają `OPEN`, ponieważ nie mają
jeszcze migrowanego klienta i dowodu runtime.

Parser `rustfmt --emit stdout` i `git diff --check` przeszły. Pełny
`rustfmt --check` zgłasza wcześniejsze, niezwiązane różnice formatowania w
tym samym pliku; nie formatowano całego współdzielonego pliku. Kompilacja
backendu i scenariusz A→B są `NOT VERIFIED`.

## Polityka komunikacji realtime — przyrost backendu 23.09.2026

PATCH polityki wcześniej zapisywał współdzielony stan przed uzyskaniem
blokady przejścia sesji. Gdy `current` zmieniał się w tym oknie, publikacja
zdarzenia była odrzucana, lecz sama zmiana polityki mogła pozostać.
Walidacja kontekstu, zapis i publikacja odbywają się teraz pod jedną blokadą.
GET uzyskuje blokady w tej samej kolejności. Regresja wymusza zmianę epoch
podczas oczekiwania PATCH i sprawdza odmowę bez zmiany revision ani polityki.

Parser Rust i diff check przeszły. Regresji nie uruchomiono przy bieżącym
zakazie kompilacji testów jednostkowych. Managed runtime, połączenie WebSocket
w przeglądarce i replay po restarcie API pozostają `NOT VERIFIED`.

## Wiadomości WebSocket — przyrost klienta 23.09.2026

Klient realtime porównuje teraz `session_id` każdej wiadomości z tożsamością
sesji, dla której otwarto socket. Wiadomość z innej sesji zamyka połączenie
przed przekazaniem do mostu invalidacji i wymusza odświeżenie statusu. Kontrola
`request_scope_epoch` w `hello` pozostaje osobną osłoną dla ponownego otwarcia
tej samej sesji. Dodano regresję dla obcego `session_id` po poprawnym `hello`.

Backend przypina kontekst przy upgrade i sprawdza go przed `hello`, replay,
każdym zdarzeniem oraz heartbeatem. Klient zamyka socket przed przekazaniem
wiadomości z obcym `session_id` albo epoch do mostu invalidacji.
`RealtimeClient.test.ts`: **8/8 PASS**. Lokalny `/workspace` nie odpowiedział
w 3-sekundowym limicie,
więc scenariusz browserowy A→B i replay pozostają `NOT VERIFIED`.

## Pełna podmiana wizualizacji — przyrost klienta 23.09.2026

Backendowe PUT display i visualization state mają już transition fence.
Control Room udostępnia teraz te operacje przez typowaną fasadę jako
`replaceDisplay` i `replaceState`, z `sessionScopeKey` przekazywanym w
nagłówku. Zapisano regresję transportową dla obu metod. Wiersze inventory
pozostają `OPEN`, ponieważ nie ma jeszcze konsumenta UI pełnej podmiany ani
dowodu runtime; zwykłe edycje nadal korzystają z istniejącego PATCH.

Typecheck, celowany ESLint bez ostrzeżeń oraz kontrole API/architektury
przeszły. Regresja transportowa pozostaje `NOT RUN` przy bieżącym zakazie
kompilacji testów jednostkowych. Browser i managed API są `NOT VERIFIED`.

## Wieloetapowe przypisanie tekstury magnetyzacji — przyrost klienta 24.09.2026

Komenda presetowego przypisania przekazuje jeden `sessionScopeKey` do odczytu
sceny, zapisu assetu i późniejszego przypisania do regionu/obiektu. Po każdym
asynchronicznym kroku sprawdza, czy sesja nadal jest aktywna. ACK assetu z
poprzedniej sesji nie uruchamia drugiego zapisu, wpisu historii ani invalidacji.
To zabezpieczenie przepływu w kliencie korzysta z istniejącej typowanej fasady;
nie dodaje endpointu ani nowego kontraktu API.

Testy źródłowe i celowany ESLint przeszły w tym przyroście. Browserowy
scenariusz zmiany sesji podczas przypisania pozostaje `NOT VERIFIED`.

## Commit importu archiwum sesji — przyrost klienta 24.09.2026

`study.import-state` przekazuje przechwycony `sessionScopeKey` do commitu
archiwum. Ponieważ poprawny import atomowo zmienia aktywną sesję, bezwarunkowe
odrzucenie ACK po zmianie scope zgubiłoby zamierzony UI state z archiwum. Po
commicie klient odczytuje globalną tożsamość sesji i stosuje stan UI oraz
invalidacje tylko wtedy, gdy aktywny `session_id` jest równy zwróconej sesji,
a epoch/scope przeszedł oczekiwaną zmianę. Gdy aktywna jest inna sesja, UI state
z odpowiedzi nie jest publikowany, a globalny status sesji jest odświeżany.

`studyRuntimeCommandContributions.test.ts`: **84/84 PASS**; celowany ESLint i
`check:api-hygiene` **PASS**. Macierz ownera klasyfikuje commit jako
`SOURCE PASS`; browser i managed import cutover pozostają `NOT VERIFIED`.
