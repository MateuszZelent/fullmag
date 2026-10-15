# P1/P8-A — workspace dostępny podczas przygotowania

Data: 15.10.2026. Baza diagnozy: `a16a34aef8367c40e350540511cb385800f489ab`;
następnie równoległy merge dokumentacji PR #172:
`8d8ec18a31ff038e3a1b0f374fe5b8977f4b20ae`. Pliki startup/layout były czyste.
To kontynuacja otwartej bramki z 07, nie nowa definicja ukończenia planu.

## Potwierdzona luka

`ActiveWorkspaceShell` używa `WorkspaceStartupGateView`, który przed pierwszym
ready nie montuje dzieci. Po ready zachowuje mount, ale przy następnym
przygotowaniu ustawia `WorkspaceStartupInteractionContext`; DockLayout nadaje
panelom `inert`. `SimulationStartupOverlayView` pozostaje fullscreen dialogiem
z `aria-modal=true`. CommandShortcutConnector dodatkowo pomija rejestrację
wszystkich skrótów, gdy startup jest widoczny. Zachowanie mountu nie zamyka
bramki swobodnego authoringu podczas meshing/initialization.

## Kontrakt poprawki

- Workspace montuje się także przy pierwszym przygotowaniu; kolejne statusy
  ready/running/stale/failed nie wymieniają jego dzieci i nie blokują paneli.
- Kompaktowy nieblokujący status pozostaje domyślnie zwinięty. Użytkownik
  może rozwinąć istniejące etapy/log/provenance i otworzyć diagnostykę.
- Błąd nie otwiera automatycznie modalu; szczegóły błędu otwierane jawnie.
- Authoring i skróty pozostają dostępne. Readiness zasobów runtime i
  `canExecute` poszczególnych komend nadal obowiązują; brak automatycznego
  Compute, retry, buildu, anulowania lub restartu.
- Zapisane szkice, focus i canvas nie są odtwarzane z nowej instancji tylko
  dlatego, że zmienił się status przygotowania.

Implementacja i odbiór: **IN PROGRESS**. Nie zaliczać P1/P8 na podstawie
tego dokumentu. Targeted testy i browser proof pozostają wymagane.

## Bramka przeglądarkowa

Nowy zamknięty scenariusz `preparation-workspace` istniejącego
`verify_pinned_dataset_browser.py`, port 3268, wykorzystuje produkcyjny
SimulationStartupOverlayView oraz istniejące komponenty fixture Inspectora
i viewportu (PrimitiveObjectLayer/renderer profile). Ma sprawdzić pierwszy
pending, retained input/value/focus i ten sam canvas przy przejściach statusu,
brak inert/automatycznego modalu, widoczny canvas, zdrowy kontekst i niezerowy
drawing buffer. Fixture jest kopiowana do isolated source view, nie rejestruje
nowej trasy produktu ani endpointu backendu.

To kontrolowany dowód zachowania komponentów, nie dowód cold startup pakietu,
Save/Open na rzeczywistym backendzie ani wykonania FEM/GPU. Te bramki pozostają.

## Granica audytu writerów

Początkowe podejrzenie, że `POST /v2/sessions/current/persistence/imports`
jest dual-truth writerem authoringu, nie potwierdziło się po prześledzeniu
konsumentów: ProjectDocumentController.open używa project namespace, a import
jest osobnym jawnym `Restore Runtime State`, zgodnie z ADR-0025 i P1 README.
Nie usunięto tej trasy ani nie nazwano jej błędem izolacji wyłącznie z powodu
braku project_id. Osobna otwarta kwestia: komenda UI domyślnie wysyła resume,
który handler odrzuca jako unsupported; wymaga własnego odbioru RestoreRuntime.

## Zasoby i retencja

Read-only CIM potwierdził CMake PID 149492 i MSBuild PID 153964 z parentem
158848: natywny FEM GPU BuildOnly z worktree `fem-script-launch-20261013`.
Nie wnioskowano o właścicielu chatu ze ścieżki i nie zatrzymywano procesów.
Nie ponawiano natywnego buildu obok aktywnego slotu. Dane solvera, cache,
receipty i frozen snapshots zachowane; brak prune/usuwania danych.

## Checkpoint wykonania — 15.10.2026

Implementacja usuwa globalną bramkę montowania oraz preparation-derived inert.
Skróty rejestrują się niezależnie od preparation, z zachowaniem per-command
canExecute i ograniczenia pobierania danych runtime. Status jest osobnym aside,
szczegóły otwierane akordeonem, błąd nie otwiera sam modalu.

Pierwszy browser receipt `4420a2093b8f4cc7bc1b5d03f501fa98` miał exit 0,
stabilny digest i zdrowy WebGL. Oględziny zrzutu ujawniły jednak widoczne treści
zwiniętego forceMount akordeonu. Dodano lokalną regułę display:none dla closed
oraz asercje widoczności, kompaktowej wysokości i expand/collapse. Nie zaliczono
pierwszego zielonego kodu wyjścia jako pełnego odbioru zachowania.

Najnowszy scenariusz komponentów `75f055e0228c481fb0cca550737d8c4f`:

- browser/preparation-workspace-report.json: **PASS**, 7 kroków; ten sam input
  i canvas, zachowany szkic/focus podczas running→ready→running→stale→failed,
  brak inert i automatycznego modalu, rozwijanie/zwijanie oraz klik viewportu;
- WebGL contextLost=false, drawing buffer 1000×620; zrzut obejrzany i potwierdza
  kompaktowy zwinięty status;
- receipt całej recepty: **FAIL**, source_changed_during_run=true. Źródła fixture
  są utrwalone w source view, ale inne równoległe edycje wspólnego frontendu
  uniemożliwiają awans tego wyniku do świeżego odbioru całego checkoutu.

Receipty i obrazy są zachowane w rozwiązywanym storage:
`builds/fullmag-0950f4dca4ffe38f/windows-control-room-browser-fixture/preparation-workspace-browser/<id>`.
Nie zmieniono warunku stabilności źródeł. Source diff check PASS. Próba kontroli
produkcyjnych typów na zależnościach checkoutu odmówiła z powodu brakującego
typescript-native; uruchomiono istniejącą zarządzaną generację
frontend-sources/5d488ca5e4b54cfbb2f14eed0541a618/workspace, bez instalacji.
Wynik typów, lint, React Doctor i regresje powłoki nadal wymagają odbioru.
Cold startup pełnego pakietu oraz Save/Open z backendem pozostają NOT VERIFIED.

Poprzednio obserwowane PID CMake/MSBuild nie istnieją już w późniejszym odczycie;
nie oznacza to sukcesu tamtego buildu. Poprzednia blokada fixture pochodziła od
żywego verify_session_persistence.py PID 175988 z potomkami Cargo/rustc.
Po ich zakończeniu recepta uruchomiła własny serwer, a receipt potwierdza
owned_server_terminal=true. Nie zatrzymano cudzych procesów ani nie usunięto danych.

Kontrola produkcyjnych typów na zwalidowanej generacji zależności zakończyła
się exit 1: receipt production-source/f87ef061a8bf4193b255ca05744de1d2.
Siedem diagnoz dotyczy compute policy API/types (5) oraz nullability
selectedRun.data w ProjectBatchesSection (2), czyli równoległych dirty zmian.
Żadna diagnoza nie wskazuje plików tej poprawki, ale nie jest to zielony
typecheck. Dodatkowo source_changed_during_run=true. Nie modyfikowano cudzych
plików w celu wyciszenia tej bramki.

React Doctor changed-scope: receipt react-doctor/2feb4d82107f4d29b5df060da9c3d638
**PASS**, exit 0 i stabilny digest. Skan 35 plików, 5 ostrzeżeń, wyłącznie
ProjectBatchesSection i ComputeNodePolicyEditor; brak uwag do tej poprawki.
Pierwszy lint odmówił z powodu brakującego @eslint/compat w zależnościach
checkoutu; uruchomiono go ponownie na tej samej zwalidowanej generacji natywnej.

Lint na kompletnych zależnościach, run a2587754ed9444928b28a22adb332598:
jedna diagnoza react-hooks/set-state-in-effect w ComputeNodePolicyEditor:50,
bez diagnoz w plikach tego przyrostu. Nie wyciszono reguły i nie poprawiano
obcego edytora. Ponowny SHA256-check siedmiu własnych plików produkcyjnych,
fixture i smoke względem source view 75f055e wykazał 0 różnic: wynik
kontrolowanej próby nadal dotyczy tych plików, mimo braku akceptacji całego
współdzielonego checkoutu.

## Świeży odbiór komponentów

Po zakończeniu kontroli źródeł ponowiono tę samą receptę. Run
`c7e641e48b16422fbcdad569c1eb05ff`: **cały receipt PASS**, exit 0,
source_changed_during_run=false, owned_server_terminal=true. Browser report:
7 kroków PASS, brak page errors, retained input/canvas/focus i WebGL 1000×620
bez utraty kontekstu. Zrzut obejrzany ponownie: compact collapsed status.
To zastępuje brak świeżości wcześniejszej próby komponentów, nie wyniki
czerwonego typecheck/lint ani bramkę pełnego pakietu.

Niezależny source review ograniczonego diffu: brak actionable P0–P2 regresji.
Dispatcher nadal sprawdza isEnabled i nie dodano automatycznego Compute.
Fixture nie dowodzi wykonania runtime canExecute ani nie asercjonuje transportu
Compute na prawdziwym API; te granice pozostają jawne. Regresje testów powłoki
przygotowane, lokalnie ich nie kompilowano; wykonanie w CI nadal wymagane.
