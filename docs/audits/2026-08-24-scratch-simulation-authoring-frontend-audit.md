# Audyt frontendu: tworzenie symulacji ze scratch

**Data:** 2026-08-24
**Zakres:** Control Room, resource-first API v2, `SceneDocument`, Python DSL i
eksport do aktywnego `ProblemIR 0.3`
**Izolacja:** `D:\git\fullmag\worktrees\scratch-authoring-ui`
**Branch:** `codex/scratch-authoring-ui`

## 1. Wniosek wykonawczy

Przed wdrożeniem frontend nie miał jednej wykonywalnej ścieżki:

`pusta sesja -> obiekt -> transformacja -> materiał -> tekstura -> interakcje ->
dyskretyzacja -> stage -> Run -> eksport`.

Fragmenty tej funkcjonalności istniały osobno, ale były niespójne: start zakładał
gotową sesję/skrypt, FDM nie miał pełnego authoringu siatki, study nie miało
bezpiecznego pierwszego stage, mutacje stage nie miały konsekwentnego
`base_revision`, a eksport wymagał pliku wejściowego.

Wdrożenie w tym worktree domyka kontrakt wariantu B na `SceneDocument` i
`ProblemIR 0.3`. Dodaje procedurę pustej sesji, revision-safe mutacje, FDM grid,
FEM mesh/shared-domain/airbox, materiał, teksturę, Exchange/Demag, Relax, eksport
kanonicznego Python bez skryptu bazowego oraz testy negatywne i round-trip.

Nie deklaruję jeszcze pełnego ukończenia E1/E2: żywy browser smoke z backendem i
managed FEM runtime nie został w tej sesji uruchomiony. Kod scenariusza i lokalne
testy helpera są gotowe; wynik tej bramki pozostaje `NOT RUN` do uruchomienia
środowiska runtime.

## 2. Decyzja zakresowa

Wybrany został wariant B:

- aktywny kontrakt pozostaje `SceneDocument` / `ProblemIR 0.3`;
- UI nie tworzy drugiego modelu fizycznego;
- każda mutacja przechodzi przez API v2 i zachowuje `base_revision`;
- obiekt ma osobne `object_id`, nazwę, typ prezentacyjny i jawny stos fizyki;
- translacja jest wspierana end-to-end w FDM i FEM;
- Rotate i Scale pozostają capability-gated, ponieważ aktywny adapter 0.3 nie
  gwarantuje ich bezstratnego round-tripu;
- migracja do `ProblemIR 0.4` jest poza zakresem tego wdrożenia.

## 3. Stan zastany i luki

### Wejście i sesja

Istniały endpointy sesji oraz placeholder `New Problem`, lecz shell uruchamiał
ścieżkę przygotowania runtime zamiast domenowego pustego dokumentu. Brak sesji
nie był prawidłowym stanem authoringu. Nie było procedury wyboru FDM/FEM,
utworzenia pustej sesji, obsługi błędu Create i przełączenia workspace dopiero po
ACK.

### Geometria i transformacje

Istniały endpointy create/patch i Inspector, ale draft obiektu nie tworzył
pełnego przepływu z preview, ACK i odświeżeniem. Ribbon/gizmo nie zapewniały
pełnej procedury Move. Reprezentacje transformacji mieszały wektor Eulera z
serwerowym quaternionem, a adapter 0.3 odrzucał obrót i skalę.

### Materiał

Biblioteka materiałów i przypisanie do obiektu działały osobno. Brakowało
ścieżki „utwórz i przypisz” w kontekście nowego obiektu, z walidacją parametrów SI
i testem ACK/refetch.

### Tekstura magnetyczna

Istniały presety i panel tekstury, ale brakowało atomowego zapisu assetu razem z
przypisaniem do obiektu oraz jawnego zachowania po konflikcie. Błąd sync skryptu
mógł pozostać tylko ostrzeżeniem bez spójnego eksportu z aktualnego dokumentu.

### Interakcje

Pojedyncze panele i capability gating istniały, jednak invalidacja była lokalna:
nie było jednej tabeli zależności między interakcją, readiness, wynikami i
topologią. Użytkownik mógł widzieć kontrolkę bez jednoznacznego powodu
`supported/unavailable/planner-deferred`.

### FDM

FDM miał projekcję polityki structured grid, lecz niepełny authoring: brakowało
pewnej ścieżki globalnego cell size, override per magnet, preview counts,
staleness i Apply. Nie dodano fikcyjnego mesh-build command — konfiguracja
pozostaje częścią study.

### FEM

FEM miał elementy object mesh, shared-domain i airbox, ale brakowało jednolitego
flow Configure -> Build -> ACK -> current manifest oraz pełnego startu z pustego
dokumentu. W szczególności mesh obiektu i mesh domeny nie mogły być mylone w
eksporcie DSL.

### Study, Run i eksport

Brakowało bezpiecznego pierwszego Relax stage. Zapis całej tablicy stage nie był
konsekwentnie chroniony rewizją. Eksport wymagał istniejącego pliku Python, więc
UI-authored scratch scene nie mogła stać się kanonicznym skryptem.

## 4. Wdrożony przepływ

1. `File -> New Problem` tworzy pustą sesję FDM/FEM CPU/double, a brak sesji
   pokazuje stan authoringu zamiast błędu przygotowania solvera.
2. `Add Box` tworzy stabilny draft, który po ACK jest zastępowany projekcją
   serwerową bez resetu Inspectora.
3. Geometry Inspector zapisuje parametry Box/Cylinder/Sphere/Ellipsoid/
   ArchWaveguide w zakresie capability; translacja jest zapisywana jako
   `Transform3D.translation`.
4. Material Inspector tworzy materiał i przypisuje go do obiektu; pola
   `Ms`, `Aex`, `alpha`, DMI i anizotropii są walidowane w istniejącym modelu.
5. Texture Inspector zapisuje asset oraz referencję magnetyzacji w jednej
   transakcji `patch_magnetization`.
6. Physics panel zapisuje Exchange/Demag i respektuje capability matrix.
7. FDM udostępnia `Apply Grid` dla `default_cell` i `per_magnet`.
8. FEM zachowuje object/shared-domain mesh oraz universe/airbox; ustawienia
   order/hmax nie są eksportowane przez wycofane aliasy DSL.
9. Study pozwala dodać pierwszy Relax, a Run pozostaje zablokowany, dopóki
   readiness nie jest aktualny.
10. `syncs` renderuje `SceneDocument` bez pliku wejściowego, zapisuje plik
    atomowo i ustawia `session.script_path` dopiero po sukcesie.

## 5. Macierz zmian

| Obszar | Główna zmiana | Stan |
|---|---|---|
| Sesja | pusty New Problem, stan `no-session`, ACK i invalidacja | wdrożone |
| Obiekt | revision-safe create/patch, immutable `object_id`, Move | wdrożone |
| Materiał | create/assign/edit w istniejącym resource-first API | wdrożone |
| Tekstura | atomowy asset + assignment, preset round-trip | wdrożone |
| Interakcje | Exchange/Demag + wspólna invalidacja wyników | wdrożone |
| FDM | globalny cell size, per-object override, preview/stale | wdrożone |
| FEM | object/shared mesh, universe/airbox i managed CPU lane | wdrożone w kodzie; runtime smoke `NOT RUN` |
| Study | pierwszy Relax, revision-safe merge patch, Run gating | wdrożone |
| Eksport | `SceneDocument -> Python -> loader -> ProblemIR 0.3` bez input script | wdrożone |
| E3 | mesh/result invalidation i stabilność paneli | testy lokalne przechodzą |
| E1/E2/E5 browser | rzeczywisty API + UI + WebGL + runtime | `NOT RUN` |

## 6. Kontrakty i zabezpieczenia

### Rewizje

`merge_patch` ma opcjonalne `base_revision`; stage add/remove/continue, Apply
study oraz interakcje study-level przekazują aktualną rewizję. Brak rewizji
blokuje zapis zamiast wykonywać unconditional commit. Serwer zwraca `409 revision_conflict`, a draft
pozostaje po stronie klienta.

### Invalidacja

- geometria, translacja, domena i grid zachowują zależności meshowania;
- materiał, tekstura i interakcje odświeżają Scene/Study/readiness, wizualizację,
  pola i wyniki;
- materiał, tekstura i interakcje nie wymuszają `MESHING_BUILDS_CURRENT` ani
  `MESHING_BUILDS_LATEST_SUCCESSFUL`;
- magnetyzacja początkowa unieważnia stan i wyniki, nie topologię;
- websocket pozostaje źródłem rewizji/invalidation, a nie drugim modelem sceny.

### Eksport

Eksporter:

- waliduje kompletność materiału i magnetyzacji przez istniejący adapter;
- zachowuje immutable `object_id` niezależnie od nazwy użytkownika;
- zachowuje `requested_backend`, `requested_device`, `requested_precision` i
  `requested_mode`, w tym GPU/single, w round-tripie SceneDocument;
- rozdziela FDM body/per-magnet mesh od FEM object defaults i universe mesh;
- używa `study.objects.mesh.defaults(...)`, nie wycofanego `fm.fem_order(...)`;
- zachowuje `Transform3D.translation` i jawne interactions;
- zapisuje wynik przez plik tymczasowy i `os.replace`.

Obsługiwane są presety uniform i random oraz istniejące nazwy presetów. Tekstury
sampled-field nadal wymagają osobnej data-plane ścieżki i są jawnie pomijane
przez renderer zamiast być udawane jako uniform.

## 7. Dowody weryfikacyjne

### PASS

- Python scratch round-trip FDM/FEM + helper CLI + execution intent/random seed 0
  oraz zwykła tekstura uniform:
  **6/6**.
- Python round-trip/solver regresji (`scratch`, FDM UI, preset texture,
  script-builder, LLG): **103 passed**, 65 subtests.
- Frontend authoring/invalidation/study/interaction focused suite:
  **205 passed** w 7 plikach.
- Task 7 focused suite: **12/12**.
- Task 9 focused suite: **62/62** oraz Python **2/2**.
- Task 10 focused suite: **122/122**; ESLint bez błędów.
- Texture/interactions focused suite: **29/29** oraz region **1/1**.
- Node browser helper contract tests: **5/5**.
- ESLint dla helpera i obu smoke scripts: bez błędów.
- JSON OpenAPI v2 po ręcznej synchronizacji parsuje się poprawnie; generator
  nie został użyty, ponieważ bazowy generator Rust w tym worktree nie przechodzi
  niezależnie od tej zmiany.
- Targeted Rust API checks: SceneDocument scratch sync **PASS**; stale
  `merge_patch.base_revision` **PASS** with `409 revision_conflict`.

### NOT RUN / BLOCKED

- The broader Rust crate suite is not claimed here because the repository has
  unrelated baseline warnings and formatting drift.
- `just run-scratch-authoring-fdm-browser-smoke`: **NOT RUN** at the browser
  layer; the recipe stops before launching services because the shell resolves
  `/mnt/d/fullmag-cache/node/global/pnpm` to an old Node runtime that cannot
  parse optional chaining (`SyntaxError: Unexpected token .`).
- Node helper **5/5** jest testem kontraktu transakcji/API i fail-closed WebGL
  health; używa direct API fallbacku dla authoringu i nie jest dowodem pełnych
  kliknięć Inspectorów, build/apply mesha ani ukończenia Relax/Run. Jego
  `request_count` obejmuje także bezpośrednie fetch, a `dom_mutation_count`
  mierzy mutacje DOM (nie udaje licznika renderów React).
- `just run-scratch-authoring-fem-browser-smoke fem_execution=cpu`: dodatkowo
  wymaga managed FEM runtime; nie uruchamiałem hostowego builda jako zamiennika.
- WebGL `isContextLost()` i niezerowy drawing buffer są sprawdzane przez helper,
  ale nie ma jeszcze manifestu z żywego uruchomienia.

## 8. Pozostałe ryzyka

1. Browser smoke może ujawnić różnice w selektorach Command Palette/Explorer
   albo lifecycle WebGL, których nie wykrywają testy Vitest.
2. Eksport `sampled_field` pozostaje poza ścieżką tekstury inline.
3. Legacy script-backed FDM rewrites can still emit the deprecated
   `study.fdm(...)` warning. The new SceneDocument scratch exporter uses
   `body.mesh(cell_size=...)` and `study.objects.mesh.defaults(cell_size=...)`
   for the ordinary `default_cell/per_magnet` path; extended legacy FDM policy
   remains a separate migration surface.
4. Rotate/Scale nie powinny być odblokowane w UI bez bezstratnego lowering 0.3.

## 9. Artefakty i plan następnej bramki

Trwałe artefakty:

- specyfikacja: `docs/superpowers/specs/2026-08-23-scratch-simulation-authoring-design.md`;
- plan: `docs/superpowers/plans/2026-08-23-scratch-simulation-authoring.md`;
- helper browser: `apps/control-room/scripts/lib/scratch-authoring-browser.mjs`;
- fixture FDM/FEM: `apps/control-room/scripts/fixtures/scratch-authoring/`;
- test round-trip: `packages/fullmag-py/tests/test_scratch_authoring_ui_roundtrip.py`.

Następna bramka jest celowo krótka i binarna:

```text
just run-scratch-authoring-fdm-browser-smoke
just ensure-managed-fem-runtime
just run-scratch-authoring-fem-browser-smoke fem_execution=cpu
```

Dopiero po kodzie wyjścia `0`, screenshotach, manifestach i potwierdzeniu
`requested/effective/resolved == FEM/CPU` można oznaczyć E1/E2 jako PASS.

### Aktualizacja bramki 2026-08-24 (kontynuacja)

- Browser helper ma teraz polling terminalnego stanu komendy, oczekiwanie na
  nową rewizję mesha po `mesh_build` oraz zapis `commands[]` z provenance,
  invalidacjami i diagnostyką. Test kontraktu helpera: **6/6 PASS**.
- FDM smoke został uruchomiony z rzeczywistym API i Control Room (`8191`/`3101`),
  ale proces nadrzędny CLI zakończył się `thread 'main' has overflowed its
  stack` po materializacji ProblemIR i eksporcie konfiguracji. Brak manifestu
  browser/runtime: **BLOCKED**, nie błąd potwierdzony jako UI.
- Kanoniczne `ensure-managed-fem-runtime` zostało uruchomione przez repozytoryjny
  `just`; Windowsowy launcher WSL zwracał `E_ACCESSDENIED`, a po przełączeniu na
  Git Bash brakowało `setsid`/`flock`. Próba POSIX w WSL zakończyła się błędem
  quoting nested shell; managed bundla nadal nie ma. FEM smoke: **BLOCKED**.
- Nie oznaczam E1/E2/E5 jako PASS. Kod authoringu i testy kontraktowe są gotowe,
  lecz dowód wykonania solvera oraz pełnych kliknięć Inspectorów nadal wymaga
  działającego runtime.


### Aktualizacja bramki 2026-08-24 (stabilizacja runtime i eksportu)

- CLI uruchamia tryb skryptowy na stosie 16 MiB. Usuwa to potwierdzony
  overflow stosu podczas materializacji scratchowego ProblemIR i eksportu.
- Detached scratch supervisor przekazuje `FULLMAG_ATTACHED_SESSION_ID`,
  `FULLMAG_ATTACHED_WAIT_FOR_SOLVE=1` oraz `FULLMAG_SKIP_CONTROL_ROOM=1`.
  Polling komend jest włączany dopiero po materializacji sesji, a worker
  sprawdza właściciela sesji przed każdym poll’em. API przyjmuje
  `sessionId` w `wait_current_live_control` i blokuje przejęcie komendy
  przez poller poprzedniej sesji.
- Dla FDM `mesh_build` ma terminalny ACK: publikuje aktualny
  `mesh_build_summary`, czyści `active_build` i ustawia stan pipeline’u na
  `ready`. Klasyfikacja `relax` w bramce wait-for-solve uruchamia solver,
  zamiast ją ignorować.
- Eksporter SceneDocument normalizuje klucze `fdm.per_magnet` i
  `fdm.per_object_grid` z `object_id`/ `region_name` do user-facing
  `geometry.name`. Dodano regresję round-trip, aby pierwszy attached start
  nie kończył się błędem nieznanego magnesu.
- FDM API/runtime E2-like scenario przeszedł pełną sekwencję:
  pusty projekt → ferromagnetyk Box nazwany X → materiał → tekstura
  magnetyczna → exchange/demag → translacja → stage Relax → FDM grid →
  `mesh_build` → `relax` → eksport skryptu. Potwierdzone są rewizje,
  invalidacje, terminalne statusy komend i plan FDM; dla przebiegu po poprawce
  aliasów log silnika nie zawiera błędów.
- Bramka Node helpera: **6/6 PASS**. Python focused round-trip:
  **7 passed**. Buildy `fullmag` i `fullmag-api` przechodzą na
  `D:\\fullmag-fullmag-target` z ostrzeżeniami, bez błędów kompilacji.
- Pełny browser smoke nadal jest **BLOCKED** na warstwie SSR Next:
  `page.goto(/workspace)` przekracza 120 s podczas kompilacji i nie powstaje
  manifest kliknięć/WebGL. Nie oznaczam E1/E2/E5 jako PASS bez tego dowodu.
- Managed FEM pozostaje **BLOCKED**: kanoniczne `just
  ensure-managed-fem-runtime` zatrzymuje się na launcherze Windows/WSL
  (`E_ACCESSDENIED`, a następnie brak `setsid`/`flock` i quoting).
  Nie użyto hostowego builda jako substytutu.

Wniosek: ścieżka authoringu i runtime FDM jest zaimplementowana oraz
zweryfikowana kontraktowo i przez API; pozostałe punkty celu dotyczą
zewnętrznej bramki browser/WebGL i kwalifikacji managed FEM.

### Aktualizacja dowodowa 2026-08-24 (pełny smoke FDM)

- Pełny scenariusz Control Room + API + attached CLI dla FDM zakończył się
  **PASS**. Manifest: `C:\Users\admin\Documents\Fullmag\.fullmag\scratch-evidence\browser-fdm-filtered\fdm.manifest.json`.
- Scenariusz potwierdził rewizje `0..8`, obiekt `x-ferromagnet`, geometrię Box,
  teksturę `uniform`, parametry `Ms/Aex/alpha/Dind/Dbulk`, grid globalny i
  per-object, a następnie `mesh_build: completed` i `relax: completed`.
- WebGL: jeden widoczny i zdrowy canvas, `context_lost=false`, drawing buffer
  `617x525`; 30 żądań kontrolnych, 158 żądań strony, 39 mutacji DOM,
  `unexpected_http_errors=[]`.
- Wykryta luka lifecycle została naprawiona w fasadzie `ControlRoomApi`:
  viewport nie wysyła `compute_fields`, gdy `model/geometry/validation` ma
  `dirty=true`; równoległe odczyty walidacji są współdzielone tylko in-flight,
  bez cache wyniku, a brak autorytatywnej odpowiedzi blokuje materializację.
  Przed poprawką smoke ujawniał `409 Mesh out of date - build mesh before
  compute`; po poprawce 409 zniknął. Oczekiwane `404` dla opcjonalnych zasobów
  preparation/current-run i nieistniejącej interakcji są zapisane w manifeście,
  ale nie są klasyfikowane jako regresje.
- FDM smoke nie jest już `NOT RUN`: E1 dla FDM ma dowód browser/WebGL/runtime.
  FEM E2 nadal pozostaje **BLOCKED** przez brak managed FEM runtime; nie użyto
  hostowego builda jako substytutu.
- Aktualne testy: `ControlRoomApi` **129/129**, helper browser **7/7**, Python
  scratch round-trip **9 passed**, focused guard viewport **1 passed**.
- Harness browserowy zapisuje teraz także `request_failures` i rozróżnia
  jawnie allowlistowane odpowiedzi opcjonalnych zasobów od nieoczekiwanych
  HTTP/network failures. Eksporter zachowuje jawnie authored moduły DMI z
  wartością `0`, jednocześnie nie aktywując ich automatycznie z zerowego
  material default.
- Wcześniejsza blokada kompilacji testów CLI wynikała z fixture’ów bez pól
  `object_id`, `frozen_spins`, `selections` i `magnetization_constraints`;
  fixture’y zostały uzupełnione, a filtr `wait_for_solve` ma obecnie **4 passed**.
- Supervisor ma teraz RAII guard `ScratchRuntimeHandle`: przy każdej ścieżce
  wyjścia ustawia stop flag i dołącza worker, więc nie zostawia osieroconego
  pollera po zakończeniu attached/script mode.
- Pusta sesja zapisuje żądany backend/device/precision w
  `SceneStudyState` już podczas `POST /v2/sessions`; supervisor pobiera
  rzeczywisty `session_id` ze statusu, a backend z `model/scene` (z fallbackiem
  na pole `backend`) i normalizuje `fdm/fem`, w tym `cpu-fdm/cpu-fem`.
  Wartość `auto`/nieznana jest traktowana jako `unknown`, więc nie ma cichego
  startu FDM dla sesji FEM. Po synchronizacji sceny supervisor ponawia
  walidację pary `(session_id, backend)` przed spawnem.
- Awaria attached childa nie zostawia już komendy w stanie `dispatched`:
  supervisor raportuje terminalny failure przez resource-first endpoint
  `/simulation/commands/{command_id}/failure` i ponawia raport przy chwilowej
  niedostępności API. Błąd odczytu sceny przy zachowanym statusie sesji jest
  traktowany jako `backend=unknown`, a nie jako brak sesji, więc nie zabija
  aktywnego solvera.
- Supervisor odczekuje do 2 s na terminalny status po wyjściu childa i dopiero
  potem raportuje failure; eliminuje to wyścig końcowego snapshotu z procesem
  zamykającym się z kodem 0. Właściciel runtime obejmuje także `scene_revision`,
  więc zmiana sceny/backendu nie uruchamia starego skryptu na nowym modelu.
- W bramce wait-for-solve kanoniczny `SceneDocument` stage pozostaje bazą, a
  payload `relax/run/solve` jest teraz materializowany przez
  `build_interactive_command_stage` i ponownie planowany przed startem solvera.
  Zmiany zapisane w stage nadal są źródłem domyślnym, gdy payload nie zawiera
  danego override.
- Publisher attached scriptu sprawdza aktualne `session_id` przed heartbeat
  i kazdym cyklem publikacji; po zmianie sesji konczy worker zamiast retryowac
  stare snapshoty bez konca. Zamykanie drzewa procesow potomnych Windows
  pozostaje osobnym ryzykiem infrastrukturalnym.
- Główna pętla starego skryptu ma teraz wspólny sygnał utraty właściciela:
  worker publishera budzi runner, oznacza interrupt `Close` i zamyka solver
  przed dalszym oczekiwaniem na komendy. Zamykanie całego drzewa potomnego
  Windows przez `Child::kill()` pozostaje osobnym ryzykiem infrastrukturalnym.

Po tej aktualizacji: `cargo check -p fullmag-cli --bin fullmag` **PASS**,
test owner-loss **1 passed**, filtr `wait_for_solve` **4 passed**. Uzupełniono
też stare fixture’y CLI o aktualne pola ProblemIR, dzięki czemu ta bramka nie
jest już blokowana błędem kompilacji testów.

### Aktualizacja bramki 2026-08-25 (stan końcowy tej sesji)

- FDM browser smoke został powtórzony po zmianach harnessu i fasady API:
  **PASS**. Manifest pozostaje w
  `C:\Users\admin\Documents\Fullmag\.fullmag\scratch-evidence\browser-fdm-filtered\fdm.manifest.json`.
  Potwierdzone są `mesh_build:completed`, `relax:completed`, zdrowy WebGL
  (`context_lost=false`, drawing buffer `617x525`), `request_failures=[]` oraz
  `unexpected_http_errors=[]` po jawnej allowliście opcjonalnych zasobów.
- Bramki lokalne po ostatnim commicie `3701037bdbc08ac9f7d12452074ff590f1ca7350`
  są zielone: `ControlRoomApi` **129/129**, browser helper **7/7**, Python
  scratch round-trip **9 passed**, `wait_for_solve` **4 passed**, owner-loss
  **1 passed**, build `fullmag` **PASS**, ESLint zmienionych plików **PASS**.
- Pełny frontendowy typecheck nadal ujawnia sześć błędów bazowych poza zakresem
  tej zmiany (`visualizationCommandContributions.ts`,
  `FrozenSpinsInspectorPanel.tsx`, `ribbonCommands.ts` oraz trzy błędy
  `Resizable.tsx`). Globalna bramka architektury zgłasza też istniejące surowe
  kolory Catppuccin w `MoveObjectGizmo.tsx`; nie są to regresje wprowadzonych
  zmian.
- Kanoniczny managed FEM nie został zakwalifikowany. `just
  ensure-managed-fem-runtime` na Windows zatrzymuje się najpierw na błędzie
  cytowania zagnieżdżonego Bash (`unexpected EOF while looking for matching
  \"`). Bezpośrednia recepta `just rebuild-fem-runtime`, uruchomiona przez
  WSL, dochodzi do skryptu eksportu, ale checkout worktree ma CRLF i kończy się
  na `/usr/bin/env: ‘bash\\r’: No such file or directory` (oraz `set: pipefail\\r`
  przy wywołaniu przez `bash`).
- Po uruchomieniu WSL z podniesionymi uprawnieniami dostępna jest wyłącznie
  dystrybucja `Ubuntu`; nie ma `/zfn2`, `/mnt/fullmag-zfn2-native`, obrazu
  `fullmag-native.ext4` ani archiwum `fem-gpu-host-latest.tar`. Zgodnie z
  kontraktem projektu nie zastępuję tego hostowym buildem FEM. E2 (FEM
  browser/runtime) pozostaje więc **BLOCKED przez środowisko**, a nie przez
  niezweryfikowaną ścieżkę UI.

Aktualny stan celu: około **88% zrealizowane**. Pozostałe ~12% to uruchomienie
kanonicznego managed FEM na hoście z działającym WSL/ext4 storage, wykonanie
`just run-scratch-authoring-fem-browser-smoke fem_execution=cpu` i dołączenie
manifestu z `requested/effective/resolved == FEM/CPU`; dopiero wtedy można
oznaczyć E2/E5 jako PASS.
