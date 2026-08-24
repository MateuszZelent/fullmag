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
