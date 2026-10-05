# ADR 0050 — kontrolowane zastosowanie backendu dev

Status: accepted jako cel i kontrakt; implementacja restartu planned, runtime NOT VERIFIED.
Cold commit, graceful exit i izolowany prelisten restore potwierdzono w
[P8-53AC](../plans/active/refactor_runtime/final/p8/53ac-lost-ack-and-candidate-restore.md).
Pełny lifecycle z UI, warm service i ponownym otwarciem admission pozostaje
NOT VERIFIED. Utrata ACK wymaga potwierdzonego exit własnego API i zgodnego
trwałego rekordu; nie upoważnia do ponowienia commit ani zwolnienia fence.
Data: 03.10.2026.

### Asynchroniczne przygotowanie kandydata — P8-53AV

Pierwsza selekcja obejmuje pełną weryfikację utrwalonych źródeł i kopiowanie
binariów. Pojedyncza kontrola snapshotu 7494 plików zajęła na tym hoście
15,254 s, więc wymagane kontrole przed i po przygotowaniu nie mieszczą się
w dotychczasowym limicie 20 s acquisition. Nie zwiększamy tego ogólnego
limitu ani nie skracamy kontroli integralności.

Pompa uruchamia osobne, odpytywane zadanie przygotowania z limitem 120 s.
Zadanie należy do właściciela procesu; jest przypięte do API, worktree,
generacji, buildu i źródła. Pending nie jest terminalnym wynikiem selekcji.
Zmiana scope lub obserwowanej gotowej wersji unieważnia wynik, anuluje
własne zadanie i wymaga potwierdzonego odebrania jego procesu i transportów.
Nierozstrzygnięty cleanup nie pozwala na nowe przejęcie lub restart.
Weryfikacja ownera zachowuje dotychczasowy limit 20 s. Odnowienie readiness
następuje dopiero po pełnym przygotowaniu i świeżej kontroli bieżącego scope.
Cache przejmuje zweryfikowany pakiet przed renewal; lost ACK nie powoduje
ponownego kopiowania. Konsumpcja restartu korzysta z tego pakietu i nie
wywołuje ponownie kosztownej selekcji w krótkim kroku handoffu.

W ramach jednego wywołania selektora można ponownie użyć zweryfikowanych
metadanych tego samego rekordu i jego dokładnych bajtów. Pełna kontrola
źródeł przed i po przygotowaniu pozostaje obowiązkowa; reuse nie przechodzi
między wywołaniami. Nie omija to sprawdzeń manifestu ani hashów binariów.
Rollback wyłącza dostępność kontrolowanego restartu, zachowując działający
workspace i dowody niepotwierdzonych procesów. Publiczna flaga nadal
pozostaje `false` do zaliczenia native/browser flow i pozostałych bramek.
Implementacja i wymagane dowody: [P8-53AV](../plans/active/refactor_runtime/final/p8/53av-asynchronous-candidate-preparation.md).

### Prywatne potwierdzenie konsumenta — P8-53AU

Gotowości konsumenta nie wyprowadzamy z konfiguracji transportu ani heartbeat
watchera. Uwierzytelniony owner odnawia pojedynczy, przypięty do API/generacji/
worktree/kandydata rekord w pamięci z ważnością 5 sekund monotonicznego czasu.
Odczyt nie odnawia; niezgodna obserwacja unieważnia dawny rekord. Potwierdzenie
nie jest idle proof ani zgodą na handoff. Selekcja dla jednej niezmienionej
tożsamości ma najwyżej jedną próbę; cache przejmuje kandydata przed renewal,
aby lost ACK nie tworzył kolejnych bundle. Publiczna flaga pozostaje `false`
do odrębnych bramek native/browser i odczytu z ETag uwzględniającym wygaśnięcie.
Stan implementacji i ograniczenia:
[P8-53AU](../plans/active/refactor_runtime/final/p8/53au-private-consumer-readiness.md).

### Jawna akcja w trwałym hoście — P8-53AT

Serwis akcji należy do `DevelopmentKernelHost`, a baner subskrybuje jego
stan. Remount banera i publikacja nowej generacji nie tworzą nowego
kontrolera dla niepotwierdzonego requestu. Start jest wyłącznie jawny;
wymaga świeżego `ready`, `restart_available=true`, pinu i zgodnej tożsamości
workspace oraz różnego od aktualnego źródła gotowego buildu. Status jest
ponownie sprawdzany przed capture i po zdobyciu guardów. Nie stosujemy
automatycznie pending forms; carry brudnego dokumentu jest jawne.
Pending/unknown pozwala tylko odczytać ten sam request z prywatnym tokenem.
Błąd hydration lub cleanup nie pozwala ponowić przejęcia ownerów.
Retry po odrzuconym capture wymaga jawnego dowodu zakończonego cleanup
od właściciela oraz braku requestu. Nietypowane odrzucenie traktujemy jako
niepotwierdzone. Wznowiony Host i tekst komunikatu nie zastępują tego dowodu;
błąd obserwatora release może wystąpić także po wznowieniu Host. Serwis
zachowuje taki kontroler i blokuje nowe przejęcie.
Pierwsze wejście to baner poza registry komend, aby sama aktywna komenda
nie blokowała zdobycia pause guard. Nie zmieniamy capability w backendzie;
pełny native/browser flow pozostaje odrębną bramką.
Zakres implementacji i dowody:
[P8-53AT](../plans/active/refactor_runtime/final/p8/53at-development-restart-action.md).

### Wynik runu jako praca właściciela dokumentu — P8-53AS

Okno oczekiwania na końcową klatkę i thumbnail również należy do pracy
właściciela dokumentu. Connector rezerwuje je synchronicznie przed
konsumowaniem obserwacji runu. Capture/guard/restore nie omijają rezerwacji,
queued outcomes ani flushu. Pauza lub guard nie konsumują obserwacji;
po zwolnieniu można ją rozpatrzyć ponownie. Ogólna operacja Save zachowuje
możliwość opróżnienia kolejki. Nie rozszerza to payloadu handoff ani nie
pozwala wyczyścić kolejki przy restore. Wykonanie i granice dowodów:
[P8-53AS](../plans/active/refactor_runtime/final/p8/53as-run-outcome-handoff.md).

### Zamontowany kernel — P8-53AR

[Dowód P8-53AR](../plans/active/refactor_runtime/final/p8/53ar-mounted-kernel-handoff.md)
obejmuje produkcyjny KernelProvider z odpowiedziami fixture. Pauza zachowuje
zamontowane dzieci; nowa generacja otrzymuje świeżych właścicieli i scoped
cache. Registry, API i zasoby nowej generacji są chronione do potwierdzenia
mount i aktualizacji pinu URL. Stary transport pozostaje retired, także po
zwolnieniu capture lease. Token-bound status może pominąć stary pin,
ale musi potwierdzić wersję kontraktu. Browser 13/13 PASS nie kwalifikuje
natywnego restartu, warm-service ani utraty zasilania. Komenda UI i pełny
restart z niepustą sceną były otwarte w checkpointcie P8-53AR; akcję banera
sprawdzono następnie w izolowanym P8-53AT. Pełny restart pozostaje NOT VERIFIED;
`restart_available=false`.

### Tożsamość i właściciele frontendu — P8-53AQ

Zasób `development-backend` w zarządzanym trybie dev zawiera cienkie
`workspace_identity`: UUID API, nullable session ID i dokładny globalny
licznik przejść `session_epoch`, również przy braku sesji. Nie wyprowadzamy
tego licznika z domenowego epoch wyniku ani nie zakładamy zera dla pustego
workspace. Odczyt sesji i licznika odbywa się pod blokadą przejść;
ETag uwzględnia tę tożsamość. Tryb wyłączony lub błędna konfiguracja nie
publikują tożsamości jako dowodu zarządzanego restartu.

Każdy klient API posiada własną przestrzeń cache zasobów. Hooki, selektory,
bezpośredni wydawcy danych i odczyt scope komend używają tej samej przestrzeni.
Kanoniczne ścieżki invalidation, transportu oraz diagnostyki pozostają
niezmienione. Spóźniony wynik starego klienta nie zasila nowego kernela.

Dokument projektu ma osobny guard handoffu: blokuje operacje i sprawdza
niezmienność metadanych do potwierdzonego zakończenia. Adapter właścicieli
łączy ten guard z PendingForms i layoutem. Wymaga jawnego carry dla dirty
dokumentu, pauzy starych connectorów oraz nowego przypiętego klienta i nowych
właścicieli przed publikacją. Obecny workspace nie ma osobnego edytora Python;
przekazuje jawny payload `state: absent`, odrębny od archiwum projektu.
Adapter nie jest jeszcze podłączony do produkcyjnej wymiany kernela;
`restart_available=false` pozostaje obowiązującą granicą.

### Zakończenie cold handoff — dziennik i admission

Zakończenie wymaga przypiętego starego commit, potwierdzonego exit starego
procesu i prywatnego przejęcia odtworzonej sceny w nowym API. Warstwa magazynu
nie wyprowadza tych dowodów z samego istnienia plików. Przyjmuje jawny rekord
autoryzacji z nowym API/session ID, epoch 1, hashem sceny, target build ID
i rzeczywistym bindingiem magazynu.

Pod WRITER najpierw publikowany i potwierdzany jest
`development/HANDOFF-COMPLETION.json`, następnie niezmienny historyczny rekord
`development/completion-authorizations/<handoff_id>.json`. Historia oznacza
autoryzację, nie dowód otwartego admission. Dopiero po readback obu rekordów
można usunąć dokładny active commit i fence. Pending journal jest usuwany
ostatni; jego usunięcie jest granicą ponownego otwarcia admission.
Prepare i finish utrzymują również kernelowe rezerwacje launch/startup
w kolejności launch → startup → WRITER, aby service nie rozpoczął startu
między sprawdzeniem admission a publikacją swojego owner record.

Compute, preparation i service startup odmawiają admission przy dowolnym
pending journal, active commit lub fence, także uszkodzonym. Zwykły abort
i nowe przejęcie fence nie mogą ominąć pending journal. Każdy etap usuwania
stosuje dostępne bariery platformy. Power-loss Windows pozostaje NOT VERIFIED.
Przerwanie wymaga jawnego finish z tym samym pełnym rekordem; nie stosuje się
timeoutu jako zgody na zdjęcie blokady. Finish odmawia zmiany obcego lub
nowszego commit/fence. Powtórzenie po zakończeniu jest tylko odczytem historii
i wymaga braku nowych active markers.
Jeżeli usunięcie pending już nastąpiło, ale końcowa bariera katalogu zawiedzie,
wynik otwarcia admission jest nieznany; nie wolno twierdzić, że pending nadal
istnieje. Jawne uzgodnienie bez active markers ponownie potwierdza historię
i dostępną barierę katalogu. Nie odtwarza automatycznie fence ani nowego commit.

Primitive magazynu oraz 13 natywnych kontroli przerwań/replay i dwóch cykli
potwierdzono w [P8-53AD](../plans/active/refactor_runtime/final/p8/53ad-completion-journal-and-repeated-store-cycle.md).
Podłączenie live owner completion pozostaje w realizacji.
Nie udostępnia to jeszcze restartu w UI ani warm-service completion.

## Kontekst

Jedno `just windows-ui dev` ma uruchamiać frontend z HMR i przyrostową
kompilację backendu. Nowy EXE nie zmienia kodu już załadowanego przez proces.
Automatyczne zamknięcie backendu mogłoby przerwać symulację lub zgubić szkice
Inspectora. Obecny zapis dokumentu projektu nie synchronizuje pełnego modelu
runtime; import FMS `resume` zwraca `checkpoint_restore_unsupported`.

## Decyzja

Kompilacja i zastosowanie wersji są odrębnymi operacjami. Odbiornik buduje
nową wersję wyłącznie na jawne żądanie z UI lub zarządzanego polecenia,
z utrwalonej kopii źródeł (P8-54). Działające procesy używają zweryfikowanej kopii EXE.
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

### Transport danych UI do właściciela procesu

Przeglądarka przekazuje wyłącznie osobne dane `editor`, `workspace` i
`project_document` oraz oczekiwaną tożsamość sesji. Kanoniczną scenę pobiera
prywatny właściciel API po zamknięciu admission. Dokument projektu nie jest
automatycznie nadpisywany sceną sesji. Żądanie nie zawiera PID-u, portu,
ścieżki EXE ani ścieżki magazynu; kandydat pochodzi z weryfikowanego pakietu.

Control plane obejmuje `POST /v2/platform/development-restart-requests` i
`GET /v2/platform/development-restart-requests/{request_id}`. POST wymaga
bieżącego pina API, dokładnego lokalnego Origin ustalonego przez launcher
oraz tokenu statusu wygenerowanego przed wysłaniem żądania. Token jest
32-znakową losową wartością hex; storage zapisuje wyłącznie SHA-256.
Przeglądarka zachowuje token także przy utracie ACK i najpierw odczytuje
stan tego samego żądania. Sekret owner RPC nie trafia do przeglądarki.

Żądanie i wynik są ograniczonymi, niezmiennymi rekordami pod kanonicznym
`runtimes/<worktree>/development-restarts/<request_id>`. Jeden slot starej
instancji API wiąże request, generację i SHA-256; inny request nie zastępuje
slotu. Zapis payloadu poprzedza publikację slotu. Uszkodzony albo częściowy
zapis pozostaje do uzgodnienia, bez automatycznego usuwania. Powtórzenie
identycznego żądania może potwierdzić istniejący zapis, ale nie ponawia
commitu ani wymiany procesu. Pierwszy przyrost nie zwalnia slotu po błędzie;
ponowne zgłoszenie do tej samej instancji wymaga osobnej jawnej procedury.

Odczyt statusu używa tokenu i nie wymaga starego pina HTTP, ponieważ wynik
musi pozostać dostępny po wymianie API. Wysłanie starego pina nadal podlega
zwykłemu `API_INSTANCE_MISMATCH`; wyjątek nie zmienia zachowania innych tras.
Wynik `ready` wymaga zakończonego prywatnego completion i nowej tożsamości.
Klient tworzy nową facade i zakres cache; nie zmienia pina starego klienta.
POST bez uruchomionego koordynatora jest niedostępny. Rejestracja tras ani
sam zapis requestu nie upoważniają do ustawienia `restart_available=true`.

Implementacja tego transportu i połączenie koordynatora są w realizacji.
Pełny przebieg UI, odtworzenie paneli i ponowne uruchomienie obserwatorów
pozostają NOT VERIFIED; obecny działający workspace nie jest restartowany
wskutek zakończenia kompilacji.

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

Zatwierdzenie handoffu ma osobny jednorazowy zapis w accepted store:
`development/HANDOFF-COMMIT.json`. Wiąże UUID starego API, nonce przejęcia,
referencję i hash kapsuły, docelowy build, binding magazynu oraz pełny fence.
Publikacja pod WRITER wymaga identycznego fence i ponownego globalnego idle.
Zastany zapis, także uszkodzony lub o niepotwierdzonej publikacji, blokuje nowe
zatwierdzenie. Po jego pojawieniu się zwykły abort nie zwalnia fence; potrzebna
jest odrębna decyzja zakończenia lifecycle z dowodem nowego ownera. Sam zapis
nie waliduje kapsuły ani nie upoważnia dowolnego klienta do shutdown API.

Prywatny konsument zimnego magazynu sprawdza nonce aktualnego przejęcia,
źródła/epokę/API, staged receipt, hash kapsuły i zgodność jej sceny z guardem,
kandydata w namespace launchera oraz skopiowane pliki. Przed publikacją
utrwala zamknięcie admission i zachowuje transition guard. Błąd publikacji
jest stanem wymagającym uzgodnienia; nie otwiera ponownie starego workspace.
Po poprawnym zatwierdzeniu graceful shutdown musi zostać zasygnalizowany
także po utracie ACK lub anulowaniu kanału. ACK nie jest dowodem exit:
launcher musi zaczekać na rzeczywisty własny proces, zachowując fence.
Ta ścieżka nie obejmuje jeszcze działającego service ani udostępnienia
komendy restartu frontendowi. Zwykły start API bez prywatnego ownera nie
może zakończyć się wskutek braku kanału shutdown.

Prywatne `complete_cold` przejmuje wyłącznie nowy API kandydata. Owner musi
wcześniej odebrać własny proces starego API; zapis commit nie dowodzi exit.
Walidacja wiąże raw commit/snapshot/manifest, aktualny sealed EXE i jego build,
rzeczywisty accepted store oraz scenę trzymaną przez guard. Scenę po restore
porównuje z kanonicznym loaderem, który rebazuje zadeklarowane assets; pierwotny
snapshot i jego źródłowe ścieżki pozostają osobno sprawdzane i niezmienione.
Prepare/finish dziennika odbywa się przy zamkniętym HTTP admission. Dopiero
potwierdzone zakończenie zwalnia freeze. Błąd po uzbrojeniu completion pozostawia
HTTP zamknięte, także przy utracie kanału. Historia przechowuje nowy session ID
i epoch 1 albo jawne `session_id=null` i epoch 0 dla pustego workspace.
Completion nie publikuje `restored` kapsuły i nie zastępuje hydration UI.
Nie dodaje publicznego endpointu ani uprawnienia restartu dla przeglądarki.

Wymagane są: zgodność generated API, regresje błędnego/starego handoffu,
odrzucenie aktywnego solve i wyścigu Start, ochrony szkiców i awarii restore,
a także rzeczywisty przebieg Windows i przeglądarki z niepustą geometrią,
regionami oraz materiałami. Nowy API UUID i hash modelu trzeba potwierdzić
po restarcie. Te bramki pozostają NOT VERIFIED do wykonania.

P8-53AO podłącza trwały transport do natywnej pętli launchera. Ready selector
wiąże status/source/raw manifest i zapieczętowany pakiet; kanoniczne położenie
jest sprawdzane w Rust, a helper otrzymuje zapis ścieżki z zatwierdzonego rootu
środowiska. Idle observers są pauzowane po zimnej rezerwacji i przed commitem.
Znany abort wznawia obserwację starego API; unknown zachowuje owner guard,
pauzę i fence. Zamknięcie okna przy unknown nie porzuca żywego launchera.
Znany exit przed commitem nie uruchamia replacement. Publikacja rezultatu
ponawia jedynie identyczny zapis, nigdy wykonanie requestu. Dowody cold native
empty/scene opisuje [raport P8-53AO](../plans/active/refactor_runtime/final/p8/53ao-native-restart-consumer.md).
Nie promuje to hydration, warm-service restart ani crash/force-kill recovery;
publiczne `restart_available` pozostaje `false`.
