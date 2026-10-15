# P1/P8 — dalszy odbiór nieblokującego przygotowania

Data: 15.10.2026. Baza: `1c70c027775ee1cdb1a05a66402ae3d72b8e8ea5`.
Kontynuacja [53CY](53cy-nonblocking-preparation-workspace.md), nie zamknięcie
całego P1/P8 ani kwalifikacja solvera.

## Bieżące dowody i porażki

Browser receipt c7e641e48b16422fbcdad569c1eb05ff pozostaje zielonym dowodem
komponentów dla niezmienionych plików produkcyjnych: 7 kroków, preserved draft/
focus/canvas, zdrowy WebGL i compact accordion. Nie zastępuje testów powłoki.

CI bootstrap 38708719103, Control Room job 116334496254, wykryło błędny props
state w MountedWorkspace: wrapper SimulationStartupOverlay nie przyjmuje
propsów i sam wywołuje hook, a View przyjmuje state. Naprawa
`9d83d9517448127b0fcac209e9adb469245350b9` używa wrappera bez propsów i usuwa
nieużywany import hooka. Opublikowana na origin/master; produkcja bez zmian.

Kolejne CI 38709138658, job 116335882219, przeszło typecheck i doszło do
wykonania testów, gdzie wystąpiło 7 porażek. Własnych regresji testów nie
przypisano obcemu dirty WIP:

- testy omitted predicates/clipboard wymagają jawnego otwarcia dialogu błędu;
- fixture konsumenta diagnostyki musi montować jego SlotHost po usunięciu gate;
- dwie asercje braku aria-hidden były zbyt szerokie i łapały dekoracyjne SVG;
- fixture rzeczywistej powłoki wymaga kompletnego kontraktu kernel.realtime;
- audyt wydajności wciąż wymagał startupVisible w dependency list listenera.

Zmiana audytu zachowuje ref do najnowszych danych i stabilny listener
[kernel, sessionScopeKey], wymaga dispatchShortcutCommand oraz
enabled: !startupVisible dla danych runtime i zabrania globalnego
if (startupVisible). Interpretowany audit-compute-performance.mjs: exit 0,
"Compute performance audit passed.". Przygotowano naprawy sześciu testów
powłoki w czterech plikach: jawne akcje diagnostyki, realny SlotHost,
asercje root/panel tags i prawdziwy RealtimeConnectionController. Diff i
kontrakty fixture przejrzane; wykonanie wymaga nowego CI. Lokalnie nie
kompilowano testów jednostkowych.

Python job 116334496343 potwierdził Gmsh 45/45, sceny 127/127 oraz kolejny
zestaw 107/107. Następna porażka dotyczy dwóch ordered-stage roundtrip
asercji w test_script_builder_roundtrip.py:659/839. Trwa diagnoza temporalnego
scope save/clear_outputs; nie osłabiono asercji na podstawie samego wyjścia.

## Pełny pakiet Windows i zasoby

`just windows-workspace-build dev dev 3197 auto` zakończyło się exit 2 po
limicie 120 s wspólnego slotu, przed kompilacją. Brak nowego pakietu.
Obserwowany żywy PID 160168: powershell run_fullmag.ps1 BuildOnly release
FEM GPU z worktree fem-script-launch-20261013. Nie wywodzono właściciela
chatu ze ścieżki i nie zatrzymano procesu. Brak listenera 3197 przy preflight.

Resolver: profil windows-native-fdm-cpu-dev, worktree fullmag-0950f4dca4ffe38f,
storage C:/git/fullmag/storage. Wolne C: 33570582528 B, R: 75062390784 B;
to odczyt dostępności, nie odzysku miejsca. Zachować cache Cargo, poprzedni
zweryfikowany pakiet, źródła snapshotów, logi i receipty. Brak prune/usuwania.
Ponowna ocena slotu po zakończeniu obserwowanego procesu, retencja po
zweryfikowaniu następcy i referencji. Pełny startup/Save/Open nadal NOT VERIFIED.

Istniejący smoke-project-lifecycle-runtime.mjs zakłada aktywną sesję przed
New Project; nie dowodzi sam projektu bez RuntimeSession. Ścieżka project-only
powłoki i jej konsumenci są badani oddzielnie. Nie uznano samego API authoring
ani nazwy ProjectWorkspaceShell za dowód pełnego authoringu bez runtime.

## Diagnostyka pełnego lifecycle

smoke-project-lifecycle-runtime.mjs zapisuje teraz raport również przy błędzie
inicjalizacji/nawigacji/asercji lub zamykania przeglądarki: state, phase,
failed_phase, stack, wszystkie requests, HTTP/page/console errors. Nie wycisza
pageerror przez filtr tekstowych console errors. Zachowano istniejące asercje
New/Save/Open/Close, byte-roundtrip, nazwy plików, zakaz mutacji runtime i limity
spodziewanych idle 404. Nie przedstawiono tej zmiany jako wykonania lifecycle.

node --check i diff check PASS. Interpretowana próba invalid URL, bez launchu
przeglądarki i bez API: receipt
windows-control-room-source-check/lifecycle-harness-invalid-url/7e317e359f764341b0cf2ee17ff0c33f
PASS. Node exit 1 zgodnie z oczekiwaniem, report state failed,
failed_phase=playwright_setup, stack obecny i puste requests/page_errors;
hash źródła niezmieniony. Jest to dowód obsługi błędu harnessu, nie odbiór M1.

## Mapa otwartego P2 — authoring bez RuntimeSession

Ograniczony audyt potwierdził rozdział istniejącego ADR-0039: New Project
tworzy dokument bez sesji, ProjectWorkspaceShell montuje zapisane wyniki
i readonly Inspector. Nie jest to dowód geometrii/materialów bez sesji.

InspectorModule ogranicza project selection do materialized-dataset;
geometryLifecycleResources useSceneResource/useMaterialResource wymagają
sessionIdentity, a mutacje geometrii używają session model API. New simulation
tworzy sesję i ProjectAuthoringSessionBinding; to inna ścieżka niż New Project.

ProjectDocumentController.synchronizeAuthoring już wysyła kanoniczny dokument
do projects.authoringUpdate z project ID/revision fence. ProjectDocumentResource
zawiera archiwum i metadane, bez typowanej projekcji scene_document do edytorów.
Save bez authoringSessionBinding zapisuje bieżące archiwum, nie odczytuje sceny
z sesji. Pełny slice P2 wymaga więc kanonicznego odczytu sceny nowego/otwartego
projektu i podłączenia istniejących edytorów do tego właściciela oraz mutacji.
Nie tworzyć sztucznej RuntimeSession ani drugiego store dokumentu. Zmiana
kontraktu/projekcji i odpowiedni ADR muszą poprzedzić zależną implementację.
Ta mapa jest dowodem źródłowego ograniczenia i następnym krokiem, nie odbiorem P2.

## Kolejny wynik CI

Opublikowano poprawki fixture/audytu jako
`77e14c3481798da0b42ed71d2989ee5ae947535b` i raportowanie lifecycle jako
`8dd76eb9b39bdd5b9b97ac67b00877400820fe82`. Bootstrap 38710742438,
Control Room job 116341194142: typecheck/lint przeszły do Vitest, wynik
827 plików PASS / 1 FAIL / 1 skip; 8535 testów PASS / 1 FAIL / 13 skip.
Sześć wcześniejszych porażek zniknęło. Pozostał first-preparation test
WorkspaceShellClient: testowy window nie udostępnia localStorage, wymagany
przez restoreFromStorage dockingu. Naprawa fixture oraz dodatkowa próba
retencji realnej powłoki przy refresh failure są w przygotowaniu; runtime
produktu nie jest zmieniany dla sztucznego DOM. Cała bramka pozostaje FAIL.

Fixture uzupełniono o map-backed localStorage; dodatkowa regresja montuje
rzeczywisty WorkspaceShellClient i po błędach refresh obu canonical resources
sprawdza ten sam input/body, szkic/focus, lokalny stale/Reconnecting i brak
launchera/inert/modalu. Source diff check PASS, wykonanie w nowym CI wymagane.

Ordered-stage Python roundtrip: oba globalne tekstowe zakazy save zastąpiono
niezależnymi literalnymi snapshotami wyjść stage i końcowego modelu dla loaded
oraz rewritten. Pełne study IR porównania i kolejność stage/action zachowane;
renderer produkcyjny bez zmian. Interpretowany pytest: **56 PASS + 35 subtestów**,
JUnit 91, failures/errors/skips=0, exit 0. Receipt:
`runs/fullmag-0950f4dca4ffe38f/python-script-builder-roundtrip/20261015T091135Z-0ef89e06b34d457e8b241f40a25b2f63/receipt.json`.
HEAD przed/po 8dd76eb9b39bdd5b9b97ac67b00877400820fe82. Hash testu
2e31a757425535f20abf4ded8dd877792e0ec34d573d65a21974ebb86b198473,
script_builder.py 36a4233cb7c39dd012262b8ba6a5d728092cf8102c932ce57d05d91762313323;
pary przed/po zgodne i ponownie odczytane przez roota. Bez bytecode,
pytest cache/plugin autoload, z resolverowym worktree lock i managed tmp/log/JUnit.
To zamyka lokalne dwie porażki roundtrip, pełny Python CI nadal wymagany.

Bootstrap 38712104335 / Control Room 116345739547: 8535 PASS / 2 FAIL /
13 skip. Oba nowe testy realnej powłoki doszły do browser-only hit regions
react-resizable-panels; custom DOM nie implementuje browser layout API.
Po powtarzających się brakach fixture root zmienił granicę testu zamiast
dopisywać kolejną emulację geometrii: prawdziwe WorkspaceShellClient,
WorkspaceDockLayout, SlotHost i zasoby pozostają; jedynie Resizable/Sortable
gesture primitives są kontenerami w tej fixture. Atrybuty inert kontenerów
są przekazywane, testy mount/identity/focus i stanu transportu zachowane.
Próba wykrywałaby starą bramkę odmontowującą workspace, lecz nie kwalifikuje
drag/resize ani geometrii przeglądarki. Te wymagają oddzielnego browser proof.
Diff check PASS; nowy CI wymagany, produkcja bez zmian.
