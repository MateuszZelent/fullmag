# ADR 0050 — kontrolowane zastosowanie backendu dev

Status: accepted jako cel i kontrakt; implementacja restartu planned, runtime NOT VERIFIED.
Data: 03.10.2026.

## Kontekst

Jedno `just windows-ui dev` ma uruchamiać frontend z HMR i przyrostową
kompilację backendu. Nowy EXE nie zmienia kodu już załadowanego przez proces.
Automatyczne zamknięcie backendu mogłoby przerwać symulację lub zgubić szkice
Inspectora. Obecny zapis dokumentu projektu nie synchronizuje pełnego modelu
runtime; import FMS `resume` zwraca `checkpoint_restore_unsupported`.

## Decyzja

Kompilacja i zastosowanie wersji są odrębnymi operacjami. Watcher buduje
nową wersję, a działające procesy używają zweryfikowanej kopii EXE.
UI pokazuje stan kompilacji i komendę „Uruchom nową wersję”. Sam zakończony
build nie wywołuje restartu.

Status jest cienkim zasobem platformowym v2, dostępnym wyłącznie dla
zarządzanego launchera dev. Zawiera tożsamość bieżącej i gotowej wersji,
rewizję, stan i powód blokady. Nie zawiera ścieżek hosta, sekretów ani
modelu projektu. Generated transport, centralna facade i resource hook
obsługują jeden workspace; React nie czyta lokalnych plików.

Komenda restartu musi:

1. Zablokować albo rozwiązać wszystkie znane lokalne szkice. Nie stosuje
   cichego Discard. Dirty dokument i szkice geometrii są odrębnymi właścicielami.
2. Atomowo zamknąć admission mutacji na czas handoffu, zaczekać na zakończenie
   już przyjętych mutacji i ponownie sprawdzić autorytatywny stan obliczeń.
   Running, paused, przyjęte/oczekujące zadania, aktywne preparation/mesh oraz
   nierozstrzygnięty stan blokują restart. Sam warunek disabled w UI nie wystarcza.
3. Zapisać zweryfikowany handoff w kanonicznym storage: pełny `SceneDocument`,
   dane edytora, stan UI i tożsamość dokumentu projektu, z hashami oraz
   powiązaniem API/session/build. `ScriptBuilderState` nie zastępuje sceny.
   Referencje assetów muszą pozostać rozwiązywalne; brak assetu blokuje sukces.
4. Potwierdzić zapis przed kontrolowanym zamknięciem własnych procesów.
   Właściciel zaakceptowanych zadań z ADR 0049 pozostaje odrębną granicą.
5. Uruchomić zweryfikowaną nową kopię, odtworzyć edytowalny model i workspace,
   a dopiero potem potwierdzić zakończenie handoffu. Nieudane odtworzenie
   zachowuje kopię danych i jawny błąd; puste UI nie oznacza sukcesu.

Nowe API otrzymuje nowy UUID. Wyłącznie jawny handoff może ustanowić świeży
pin klienta. Zwykły reconnect nadal odrzuca obcą instancję. Wyniki i artefakty
zachowują pierwotną provenance; odtworzenie modelu authoring nie jest
wznowieniem checkpointu ani kontynuacją kroku solvera. Requested intent
backend/device/precision/mode pozostaje w kanonicznej scenie; nowy proces
nie może przypisać starym wynikom swojej wersji lub rozstrzygnięcia urządzenia.

## Obowiązki implementacji i migracja

P8-52 obejmuje profil kompilacji, watcher, integralność kopii EXE i lease
procesów. P8-53 obejmuje nowy zasób/komendę v2, generację OpenAPI, facade/hook,
guardy szkiców i admission, trwały handoff, odtworzenie i kontrolę nowego pina.
Szczegóły źródeł i bramek są w
[planie P8-53](../plans/active/refactor_runtime/final/p8/53-development-restart-workspace.md).

Prywatny kanał supervisor–launcher pozostaje wewnętrznym protokołem dev,
związanym z jednym worktree, lease i losowym identyfikatorem generacji.
Nie jest publicznym endpointem kill/restart dowolnego procesu. Właścicielem
jego usunięcia przy wspólnym lifecycle produktu jest P7-C. Release i brak
zarządzanego launchera nie udostępniają tej komendy.

Rollback wyłącza komendę zastosowania wersji, pozostawiając kompilację w tle
i ręczne zamknięcie/uruchomienie. Nie usuwa handoffów, wyników ani cache.

### Podział właścicieli w natywnym Windows

Docelowo Pythonowy manager zachowuje workspace lease i watcher; żywy supervisor CLI
zachowuje frontend oraz okno desktopowe i wymienia wyłącznie własne dziecko API.
Ponowne uruchomienie całego launchera nie realizuje tego restartu, ponieważ
`ControlRoomGuard` zamyka również frontend. Ta integracja pozostaje planned.

Prywatny kanał manager–CLI–API musi wiązać polecenie z ownerem, generacją,
nonce, starą instancją API i zweryfikowanym kandydatem. Trwały ACK kapsuły
i globalny idle/drain proof poprzedzają utrwalenie zamkniętego admission oraz
kontrolowane zamknięcie starego API. Timeout oznacza nieznany wynik, nie zgodę
na retry albo przejęcie. Release markera wymaga zgodności pełnego rekordu.

API potrzebuje kontrolowanego shutdown wraz z zakończeniem długich obserwacji;
samo zakończenie listenera nie dowodzi exit procesu. Supervisor musi odczekać
własny stary proces, sprawdzić brak listenera, przekazać replacementowi zamknięty
stdin restore i potwierdzić nowe PID/UUID/build oraz model po odtworzeniu.
Dotychczasowy attach observer i scratch supervisor nie mogą adoptować nowego API
przez zwykły reconnect; wymagają jawnego zakończenia i nowego przypięcia.

Frontend zachowuje szkice przez kontrolowany handoff. Obecne czyszczenie
`pendingForms` przy disconnect oraz jednorazowy `apiInstancePin` nie dowodzą
takiego zachowania. Wyjątek admission dla restartowej komendy nie może uzyskać
własnego permitu przed `begin_freeze`, ponieważ blokowałby się na samym sobie.
Publiczna komenda pozostaje wyłączona do wykonania całego tego kontraktu.

Prywatny zapis semantycznego handoffu używa schematu
`fullmag.development-authoring-handoff.v2`: assety mają ścieżki adresowane
SHA256 z zachowanym rozszerzeniem źródła. Jest to wymagane przez obecne
importery siatki/geometrii wybierające format po rozszerzeniu. Czytnik
prymitywu nadal obsługuje v1 (`.blob`); starszy writer nie zapisuje v2.
Inwentaryzacja odwołań wynika z typów sceny, a nie wyszukiwania dowolnych
kluczy `path`. Kolejny restart może kopiować dane poprzedniego handoffu
dopiero po zweryfikowaniu całej jego kapsuły i konkretnego assetu.
Ta warstwa przygotowuje dane; nie zastępuje admission/drain, instalacji
sceny przed listenerem ani potwierdzenia nowej instancji API.

## Weryfikacja

Natywny API używa jednego procesowego UUID dla nagłówka
`x-fullmag-api-instance`, prefiksu `request_scope_epoch`, prywatnego discovery
ownera i acquisition. Licznik epoki sesji pozostaje osobny. Nie przenosimy
tożsamości ze starego procesu ani nie zmieniamy historycznych receiptów.
Manager nie może utożsamiać listenera i modelu na podstawie dwóch niezależnie
generowanych UUID. Odrzucenie mutacji podczas freeze odczytuje i odrzuca body
strumieniowo, z ograniczeniem czasu/rozmiaru, przed dostarczeniem 409;
niedokończone żądanie zamyka połączenie HTTP/1, bez dopuszczenia mutacji.

Świeży natywny start publikuje sprawdzone kopie EXE pod stałą ścieżką
`runtime_root/native-launch/<dev|release>/bin`, zachowując immutable bundle
UUID. Publikacja wymaga istniejącego runtime lease i statusu `starting`
z pasującym profilem, nonce, checkoutem oraz właścicielem procesu. Manifest
i `ready.v2` potwierdzają kompletny zestaw przed zwolnieniem build lease;
awaria częściowej publikacji nie jest gotowością. Zmiana ogranicza mnożenie
reguł zapory związanych z pełną ścieżką EXE, bez zmiany ustawień systemu.
Nie jest to mechanizm podmiany plików działającego workspace ani hot restartu.

Natywny CLI generuje token początkowego ownera tylko dla własnego managed dev
API bez skryptu; frontend nie dostaje tych credentials. Discovery musi zgadzać
się z własnym PID, przypiętym HTTP UUID i skompilowanym bundle CLI/API.
Acquire/abort mają ograniczenia czasu i rozmiaru oraz weryfikację canonical
sceny. Ten klient nie daje jeszcze commit/shutdown. Replacement wymaga osobnego
bindingu do zweryfikowanego kandydata, gdy persistent CLI zachowuje stary build.

Prywatny `drain_confirmed` rozszerza istniejący kanał service bez zmiany
kontraktu `drain`: wymaga tokenu ownera i świeżego nonce, a odpowiedź
`runtime_service_drain.v1` wysyła dopiero po terminalnych receiptach obu
schedulerów i publikacji descriptoru. Klient sprawdza pełną konfigurację,
tożsamość ownera/source/pul oraz terminalne PID-y. Ta odpowiedź nie zastępuje
kontroli accepted work, zapisu authoring ani obserwacji zwolnienia owner locka.
Publiczna komenda pozostaje wyłączona do podłączenia wszystkich tych granic.

Owner może potwierdzić bieżące przejęcie przez `confirm` na tym samym prywatnym
połączeniu. ACK wymaga tokenu, UUID API oraz nonce bieżącego przejęcia i nie
zwalnia guardu ani nie przedłuża bezwzględnego limitu 30 sekund. Błąd klienta
unieważnia kanał. Potwierdzenie jest obserwacją: przyszły commit musi atomowo
sprawdzić nadal aktualny guard, trwały ACK kapsuły i globalny idle/drain.

Puste przejęcie ma osobny schema kapsuły
`fullmag.development-empty-workspace-handoff.v1`, z `session_id=null`,
`scene=null` i bez assetów. Zachowuje osobne dane edytora, projektu i workspace.
Nie tworzy fikcyjnej sesji. Historyczne kapsuły v1/v2 zachowują wymaganie sceny
i niepustego session_id. Przygotowanie nowego API dla pustej kapsuły nie wysyła
envelope sceny; owner musi potwierdzić brak sesji, nowy pin i hydration UI.

Staging łączy zaufane source identity ownera i manifest kandydata z payloadem
UI przypiętym do tej samej instancji API, sesji i epoki. Trwały ACK wymaga
odczytu zwrotnego hashów, stanu `staged`, oryginalnej sceny i danych UI.
Nie zastępuje aktualnego potwierdzenia przejęcia ani atomowego commit/shutdown.

Przed commit launcher ponownie sprawdza kapsułę i sealed candidate, używając
prywatnie zachowanych danych przejęcia i UI. Mały ACK pozostaje `staged`;
odczyt nie publikuje `restored` i nie upoważnia do shutdown. Niezgodny nonce,
źródła, scene/UI, snapshot lub receipt unieważniają kanał przejęcia.

Zimny istniejący accepted store wymaga braku metadanych ownera/config oraz
rezerwacji launchera i przejmowania ownera. Osobny `STARTUP-GATE.lock`
obejmuje również bezpośredni start service przed publikacją ownera.
Trwały admission fence pozostaje po Drop rezerwacji i blokuje nowych ownerów;
zwolnienie wymaga jawnej decyzji lifecycle, nie automatycznego cleanup po błędzie.
Brak magazynu nie jest dowodem pustego workspace ani zgodą na inicjalizację.

Izolacja danych drugiego workspace nie zmienia namespace źródeł ani pakietu.
Jawny opcjonalny `FULLMAG_ACCEPTED_STORE_SCOPE` jest kanonicznym niezerowym UUID:
z bazowego `runs/<worktree>/session-store` wybiera
`runs/<worktree>/workspaces/<UUID>/session-store`. Analogiczny podkatalog należy
do user-data root w instalacji. Bez scope pozostaje dotychczasowa ścieżka;
niepoprawny scope powoduje odmowę, nigdy fallback. Resolver nadal sprawdza
kanoniczny root, rzeczywiste worktree i marker storage. Scope nie jest ścieżką
z UI, identyfikatorem fizyki ani zmianą uprawnień solvera. Zarządzana inicjalizacja
może utworzyć wyłącznie nowy scoped store; zastanych danych nie nadpisuje.
Własna sonda zapisuje UUID i binding w receipt oraz zachowuje swój magazyn.

Wymagane są: zgodność generated API, regresje błędnego/starego handoffu,
odrzucenie aktywnego solve i wyścigu Start, ochrony szkiców i awarii restore,
a także rzeczywisty przebieg Windows i przeglądarki z niepustą geometrią,
regionami oraz materiałami. Nowy API UUID i hash modelu trzeba potwierdzić
po restarcie. Te bramki pozostają NOT VERIFIED do wykonania.
