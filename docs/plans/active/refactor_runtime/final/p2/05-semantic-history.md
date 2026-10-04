# P2-D — semanticzna historia authoringu

Data checkpointu: 24.09.2026. To jest ograniczony slice historii edycji dla
Control Room; nie zamyka całego P2-D.

## Zakres wykonany

`apps/control-room/src/kernel/authoring/AuthoringHistoryController.ts`
przechowuje przed i po pełnej scenie authoringu, a Undo/Redo wykonuje jako
revision-fenced `replace_scene` przez istniejące API transakcji. Po ACK wynik
przechodzi przez wspólny cache sceny i invalidation dependents. Jeżeli scena ma
nowszą rewizję niż wpis historii, operacja kończy się błędem i nie nadpisuje
obcej zmiany.

Komendy `workspace.undo` i `workspace.redo` są podpięte do command registry,
menu Edit, quick actions i skrótów `Ctrl+Z`/`Ctrl+Y`. Historia jest czyszczona
po zmianie sesji oraz po New/Open/Close projektu. Podstawowe mutacje geometrii
z Inspectora i komend lifecycle rejestrują jeden wpis po udanym commit; preview
draftu nie tworzy wpisu.

`apps/control-room/src/kernel/authoring/PendingFormRegistry.ts` utrzymuje
aktywny formularz Inspectora jako jeden wspólny wpis command context. Gating
Apply wymaga staged + dirty + valid i odrzuca formularz zablokowany lub już
aplikowany; Reset działa dla staged/live dirty. Komendy
`workspace.apply-inspector` i `workspace.reset-inspector` są dostępne w menu
Edit, quick actions i przez skrót Apply.

`apps/control-room/src/modules/inspector/InspectorHistoryBridge.ts` brackets
staged sesje, których callback nie jest właścicielem wpisu historii,
autorytatywnym odczytem sceny przed i po Apply. Zmiana rewizji tworzy dokładnie
jeden wpis historii, niezależnie od tego, czy Apply został wywołany z action
bara, dialogu zmiany selekcji, czy command registry. Panel, którego mutacja już
zapisuje własną historię, może jawnie wybrać tryb `mutation-owned`, aby uniknąć
duplikatu. Tryby `liveViewport` i `immediate` pozostają poza tym wrapperem, bo
nie są staged transakcją sceny.

`apps/control-room/src/kernel/authoring/authoringHistoryMutation.ts` domyka
analogiczną granicę dla immediate mutations. Helper pobiera snapshot przed
mutacją, przekazuje `baseRevision` do API, rozpoznaje `committed_scene` lub
pełny SceneResource po ACK i zapisuje pojedynczy wpis dopiero po wzroście
rewizji. Komendy region/coupling oraz panele region/coupling, texture,
absorbing boundary, antenna, material fields/parameters/assignment, spin/transport
delete, spin interface delete i monitory korzystają z tej ścieżki. Utworzenie
monitora z draftu i Apply/Commit/Delete Frozen Spins również są revision-fenced.
Physics Interaction Inspector używa tego samego wrappera dla object-interaction
resource i study-level merge patch; do API trafia rewizja uchwycona przed
mutacją, a po ACK invalidowane są zależności authoringu.
Create/Replace w panelach Spin Torque/Oersted oraz Current/Spin Transport
również przechodzą przez ten wrapper; captured `baseRevision` jest używana w
żądaniu, a nazwa operacji trafia do wpisu historii.
Create/Replace Spin Interface zapisuje historię przez właścicielski
`replaceSpinTransport`; walidacja właściciela i commit korzystają z tej samej
uchwyconej rewizji.
Dodawanie etapów Study, kontynuacja po histerezie i usuwanie zaznaczonego etapu
korzystają z helpera natychmiastowej historii oraz revision/session fence.
Usunięcie czyści wybór usuniętego etapu, więc Undo przywraca go razem ze sceną,
a Redo znów go usuwa. Testy tej ścieżki sprawdzają także ACK po zmianie sesji.
Komenda przypisywania presetu magnetyzacji wykonuje dwa zapisy w jednej
granicy: najpierw asset, potem przypisanie do obiektu/regionu. Drugi zapis
używa rewizji pierwszego ACK, a region korzysta z revision-fenced
`PATCH /model/regions/{region_id}`; przy błędzie drugiego kroku historia
zachowuje stan częściowy. Odczyt sceny, zapis assetu i przypisanie przekazują
ten sam `sessionScopeKey`; jeśli sesja zmieni się po ACK assetu, komenda kończy
się przed drugim zapisem, historią i invalidacją. Biblioteka materiałów w `MaterialLibraryDialog`
korzysta z tego samego helpera dla Save/Delete.
Wieloetapowe create→assign materiału zapisuje jeden wpis po sukcesie albo
jawny stan częściowy po utworzeniu materiału. ACK z samą rewizją uruchamia
drugi odczyt pełnej sceny; niepełny payload nie może stać się snapshotem Undo.

## Dowody

- `AuthoringHistoryController.test.ts`: **3 passed** — undo/redo przez
  `replace_scene`, revision fence dla zewnętrznej zmiany i clear po zmianie
  dokumentu.
- `PendingFormRegistry.test.ts`: **4 passed** — rejestracja i aktualizacja
  aktywnego formularza, gating Apply/Reset, lock/applying guard oraz błąd
  callbacku.
- `InspectorHistoryBridge.test.ts`: **4 passed** — snapshot przed/po staged
  Apply, no-op/live/immediate bez wpisu i odporność na niedostępny snapshot.
- `authoringHistoryMutation.test.ts`: **5 passed** — base-revision fencing,
  cache fallback, no-op, refetch pełnej sceny po ACK z samą rewizją i zapis
  częściowego ACK.
- `fieldMapCommands.test.ts`: **13 passed** — revision-fenced rename,
  duplicate/delete monitora i wpis historii po ACK.
- `PlanarMonitorDraftInspectorPanel.test.tsx`: **7 passed** — canonical create,
  collision/reload paths i wpis historii.
- `FrozenSpinsInspectorPanel.test.tsx`: **18 passed** — preview bez historii
  oraz authored Apply z pełnym snapshotem po ACK.
- `PhysicsInteractionPanel.dom.test.tsx` + `PhysicsInteractionPanelModel.test.ts`:
  **16 passed** — object/study interaction writes zachowują revision fence,
  pending/conflict recovery i wspólny history wrapper.
- `SpinAuthoringInspector.test.tsx` + `TransportAuthoringInspector.test.tsx`:
  **26 passed** — Spin Torque/Oersted oraz Current/Spin Transport renderują
  się stabilnie, a Create/Replace są objęte wspólnym wrapperem historii i
  captured `baseRevision`.
- `SpinInterfaceInspector.test.tsx`: **5 passed** — Create/Replace interfejsu
  używa historii właścicielskiego transportu i nie traci revision fence.
- `magnetization-texture/commands.test.ts`: **5 passed** — preset asset i
  przypisanie regionu/obiektu przekazują rewizję pomiędzy krokami; zasób i
  przypisanie pozostają jedną granicą historii z obsługą partial ACK.
- `regionCommandContributions.test.ts`: **5 passed** — immediate region/coupling
  commands zapisują historię po revision-fenced ACK.
- `geometryLifecycleCommandContributions.test.ts`: **40 passed** po dodaniu
  rejestracji historii do komend create/delete.
- testy komend/menu/skrótów: **35 passed**; Undo/Redo i Apply/Reset są widoczne
  i mają wspólny stan enabled/disabled.
- połączona bramka Inspectora: **28 passed**; registry, command routing, menu
  i edit-session.
- macierz paneli Inspectora i komend authoringu: **18 plików / 238 passed**;
  staged session hook, resource hydration, SSR stability, ACK i routing paneli.
- `pnpm --dir apps/control-room typecheck`: **PASS** po zmianie kontraktu
  `RegionPatchRequest` i wygenerowaniu typów OpenAPI.
- `pnpm --dir apps/control-room check:architecture-hygiene`: **PASS**.
- targeted ESLint dla komendy tekstury, dialogu materiałów i klienta API:
  **PASS** (`--max-warnings=0`).

## Granice

To nie jest jeszcze pełny odbiór P2-D. Wrapper obejmuje staged sesje, a helper
immediate pokrywa wskazane komendy i panele, w tym Physics Interaction,
Create/Replace dla Spin/Oersted/Transport, Spin Interface, tekstury
magnetyzacji i bibliotekę materiałów; pozostałe direct handlers i część
ścieżek domenowych nadal wymagają jawnego bracketingu. Podstawowa obsługa
Przywracanie zaznaczenia po Undo/Redo jest zaimplementowane dla przejść z
oboma snapshotami; poprawny nowszy wybór pozostaje własnością użytkownika.
Historia nie zapisuje focusu layoutu, bo Undo/Redo nie zmieniają panelu ani
aktywnego slotu. Nie ma jeszcze browserowego scenariusza Apply → Undo → Redo.
Historia nie cofa uruchomionego runu i nie zastępuje durable history po
stronie backendu.

`GeometryObjectPanel` został objęty wspólnym wrapperem historii dla create,
patch geometry i translation. Operacja przechwytuje session scope przed
odczytem sceny, przekazuje go do zapisu, a spóźniony ACK po zmianie sesji lub
wyczyszczeniu historii nie publikuje wpisu, invalidacji ani nowego selection.
Dodano regresje DOM dla sukcesu i zmiany sesji oraz regresję transakcji
translation. `GeometryObjectPanel.dom.test.tsx` przeszło **6/6**, a plik
`geometryLifecycleCommandContributions.test.ts` **50/50**; celowany ESLint
tych plików przeszedł bez ostrzeżeń. Typechecku nie odebrano.

## Staged Apply w GeometryObjectPanel i scope historii (24.09.2026)

`GeometryObjectPanel` rejestruje teraz edytowane drafty jako aktywną sesję
Inspectora. Globalny Apply wybiera pojedynczą zmienioną domenę: utworzenie
nowego obiektu, geometrię albo translację. Gdy jednocześnie zmieniono geometrię
i translację, Apply jest zablokowany z czytelnym powodem, a Reset pozostaje
dostępny; użytkownik może też nadal użyć osobnych lokalnych akcji. Reset
przywraca wartości bazowe, a zmiany robocze są liczone względem kanonicznego
draftu sceny.

Mutacje tego panelu są właścicielem własnego wpisu historii, dlatego rejestr
Inspectora używa trybu `mutation-owned` i nie bracketinguje zapisu drugim
snapshotem. Staged bridge dla pozostałych formularzy przekazuje
`sessionScopeKey` do obu odczytów sceny i ponownie sprawdza sesję przed Apply,
po callbacku i przed zapisaniem historii. Formularze, których callback używa
`runAuthoringMutationWithHistory`, jawnie wybierają `historyMode:
"mutation-owned"`; bridge ich nie bracketuje i nie tworzy drugiego wpisu.
Pozostałe staged formularze korzystają z bridge'a. Gdy ich callback zwróci
`false`, bridge nadal porównuje rewizje i zapisuje historię częściowego
commitu, ale zachowuje wynik `false`, aby caller nie kontynuował zmiany
selection. Pending geometrii jest przypięty do klucza draftu, sesji i
identyfikatora operacji.

Dodano regresje dla snapshotów o ustalonym scope, zmiany scope podczas odczytu
bazowego, invalidacji generacji, częściowego commitu zwróconego jako `false`,
globalnego Apply oraz zablokowania łącznego geometry/translation z zachowaniem
Resetu. `pnpm --dir apps/control-room typecheck`, API hygiene, architecture
hygiene, repository consistency i `git diff --check` **PASS**. Nowe testy
`InspectorHistoryBridge`, `InspectorEditSession.dom` i `GeometryObjectPanel.dom`
pozostają **NOT RUN**: Node nie może odczytać zainstalowanego entrypointu
Vitest (`EPERM`); browserowy Apply → Undo → Redo nadal **NOT VERIFIED**.
Procent P2 pozostaje bez zmian.

`StudyInspectorPanel` opakowuje teraz commit etapów i globalnych ustawień w
ten sam mechanizm. Historia rejestruje zatwierdzony snapshot sceny przed
replanem FDM, a zmiana scope lub generacji historii w czasie oczekiwania
blokuje późniejszą invalidację i publikację feedbacku. Testy
`StudyInspectorPanel` i jego modelu weszły do ukierunkowanego zestawu
**106/106**; celowany ESLint objął komponent oraz testy. Typecheck i browserowy
Apply → Undo → Redo pozostają `NOT VERIFIED`.

Komendy dodawania etapów, kontynuacji histerezy i usuwania zaznaczonego etapu
korzystają teraz z tego samego helpera historii i bazowej rewizji sceny.
Po usunięciu etap przestaje być zaznaczony; Undo przywraca jego wybór, a Redo
czyści go ponownie. Spóźniony ACK po zmianie sesji
nie publikuje invalidacji ani zaznaczenia, a helper pomija wtórny odczyt sceny.
Dwie ukierunkowane suite'y Vitest przeszły: **101/101**; celowany ESLint dla
komend i helpera historii oraz `check:architecture-hygiene` również **PASS**.
Typecheck i browserowy Apply → Undo → Redo nadal pozostają `NOT VERIFIED`.

`AuthoringHistoryController` przechowuje snapshot zaznaczenia po obu stronach
wpisu, a wspólne komendy Undo/Redo przekazują odtworzoną scenę do warstwy
workspace. Po cofnięciu usunięcia wraca wybór obiektu, jeśli obiekt istnieje
w odtworzonej scenie; Undo utworzenia nie pozostawia wyboru usuniętego obiektu.
Nowszy prawidłowy wybór użytkownika nie jest nadpisywany. Focus pozostaje
własnością layoutu i nie jest odtwarzany przez semantic history. `GeometryObjectPanel`,
`ObjectGeneralPanel` oraz komendy create/delete geometry zapisują snapshot po
zastosowaniu odpowiadającej zmiany selection; usunięcie przechwytuje stan po
ACK wyłącznie wtedy, gdy samo wyczyściło zaznaczony obiekt. To obejmuje
tworzenie, zmianę geometrii i transformacji, edycję nazwy/notatek oraz
usunięcie obiektu. Dodano testy kontrolera, workspace restore, helpera mutacji,
Object General i routingu Undo. Testy workspace restore i Object General
przeszły **6/6**. Suite'y helpera historii, komend Study/Run i presetowej
magnetyzacji przeszły **101/101**, a ich celowany ESLint **PASS**.
`check:architecture-hygiene`,
spójność repozytorium, celowany ESLint i `git diff --check` **PASS**; typecheck
pozostaje **NOT VERIFIED**.
Browserowy Apply → Undo → Redo na porcie 3104 nie wystartował
(`ERR_CONNECTION_REFUSED`).

### P2-D/P3a — Regional Field Drive

`RegionalFieldDrivePanel` używa teraz wspólnego mutation helpera dla create i
replace. Przed zapisem przechwytuje revision i session scope, a po ACK
sprawdza aktualność scope przed invalidacją zasobów i ustawieniem selection.
Helper tworzy historię, dlatego staged session deklaruje `mutation-owned`;
pending jest kluczowany przez sesję, draft i operację. Model testuje forwarding
`RequestOptions`, a test DOM sprawdza create i ACK po A→B. Typecheck **PASS**;
Vitest oraz React Doctor **NOT RUN** z powodu `EPERM`, a browserowy odbiór
pozostaje **NOT VERIFIED**.

## Airbox policy i budowa siatki — scope sesji (24.09.2026)

`AirboxMeshParametersPanel` przekazuje przechwycony `sessionScopeKey` do zapisu
policy. FDM używa tego samego scope do odczytu sceny i command contextu
replanowania. Lokalne Apply i Apply & Build korzystają z zarejestrowanej staged
sesji, więc oba wejścia współdzielą bridge historii z globalnym Apply. Apply
oraz Build są zablokowane bez aktywnej sesji; draft, feedback i pending są
rozdzielone między sesje, a identyfikator operacji zapobiega temu,
by późny `finally` wyczyścił stan nowszego zapisu lub budowy. Potwierdzenie
zapisane po przełączeniu A→B jest ignorowane przed invalidacją zasobów i
feedbackiem.

Dodano DOM regresje sprawdzające scoped write oraz późny ACK po zmianie sesji.
Typecheck, API hygiene, architecture hygiene i `git diff --check` **PASS**.
Vitest i lint nie wystartowały z powodu `EPERM` przy otwieraniu entrypointów w
`node_modules`; browserowy smoke pozostaje **NOT VERIFIED**, bo lokalny port 3104
odmawia połączenia.

## Object Mesh Policy — fencing zapisu i budowy (24.09.2026)

`ObjectMeshPolicyPanel` dodaje session scope do klucza draftu i przechwyconego
command contextu. Apply przekazuje ten scope do `replaceObjectPolicy` i po ACK
sprawdza, czy sesja nadal jest aktualna, zanim unieważni politykę, raport,
jakość, build state lub scenę. Build używa tego samego fence'u po Apply Policy
i po komendzie. Pending oraz `finally` są przypisane do identyfikatora operacji,
sesji i obiektu, więc zakończenie starego requestu nie czyści stanu nowego
targetu. Bez sesji Apply/Build są niedostępne.

Lokalne Apply i Apply & Build wywołują zarejestrowaną staged sesję, więc oba
wejścia przechodzą przez ten sam history bridge co globalny Apply.

DOM regresje pokrywają scoped write i zmianę A→B przed ACK. Typecheck, API
hygiene, architecture hygiene, repository consistency i `git diff --check`
**PASS**. Vitest i lint **NOT RUN** z powodu `EPERM` w `node_modules`; browser
pozostaje **NOT VERIFIED**.

## Object Regions — wspólny właściciel historii i fencing sesji (24.09.2026)

`ObjectRegionsPanel` używa `captureAuthoringMutationFence` dla Apply, duplicate,
delete i budowy siatki. Apply uruchamiany lokalnym przyciskiem i przez globalny
registry korzysta z `runAuthoringMutationWithHistory`; staged rejestracja ma
`historyMode: "mutation-owned"`, więc powstaje jeden wpis. Żądania mutacji
przekazują przechwycony `sessionScopeKey` i skończony `baseRevision`; missing
identity albo revision zatrzymuje zapis. Po ACK panel ponownie sprawdza sesję
przed publikacją sceny, zmianą selection, invalidacją, synchronizacją skryptu i
feedbackiem. Pending oraz feedback są przypięte do sesji i regionu, a stary
`finally` nie czyści nowszej operacji. Zniknął fallback `Date.now()` udający
revision.

Zaktualizowano istniejący source-contract test panelu. Control Room typecheck,
API hygiene, architecture hygiene, repo consistency i diff check **PASS**.
Vitest oraz lint **NOT RUN** z powodu `EPERM` przy otwarciu pakietów z
`node_modules`; browser **NOT VERIFIED**.
