# Raport Gemini: Ocena planu refaktoryzacji CAE Fullmag
## 00. Synteza i werdykt wykonawczy

**Data audytu:** 20 września 2026 r.  
**Cel audytu:** Ultra-precyzyjna analiza dokumentacji planu refaktoryzacji runtime Fullmag (`docs/plans/active/refactor_runtime/`) w powiązaniu z rzeczywistym stanem kodu na branchu `master` (commit `31bac350a15c0af070287de92d4e0c1a6dabab0e`), pod kątem poprawności, kompletności, zasadności oraz zbliżenia UX/architektury do standardów COMSOL Multiphysics i CST Studio Suite.

---

### 1. Główny werdykt

| Wymiar oceny | Ocena | Podsumowanie |
|---|:---:|---|
| **Zasadność (Justification)** | **10/10** | **Bezwzględnie konieczna.** Obecna architektura oparta na mutowalnym singletonie `SceneDocument` powiązanym z `sessions/current` oraz procesem `scratch_runtime.rs` (gdzie jakakolwiek edycja sceny w UI zabija bieżący solver) uniemożliwia profesjonalną pracę. Bez tej refaktoryzacji Fullmag nigdy nie osiągnie dojrzałości CAE. |
| **Poprawność merytoryczna (Correctness)** | **9.5/10** | **Wybitnie wysoka.** Wszystkie twierdzenia o obecnym kodzie są w 100% potwierdzone dowodami z repozytorium (od `scene.rs` przez `builder.rs`, `scratch_runtime.rs`, `SimulationStartupOverlay.tsx`, po `world.py` i `.fms`). Proponowane zasady nie łamią rygorów naukowych ani wytycznych backendu (BGM, cztery lane'y FDM/FEM CPU/GPU, brak cichych fallbacków). |
| **Kompletność (Completeness)** | **9.3/10** | **Wybitnie wysoka w warstwie domenowej i kontraktowej.** Początkowo zidentyfikowane 4 luki wykonawcze okazały się wprost antycypowane przez autora planu w `01-architektura-cae.md:415, 616` oraz `03-migracja.md:42, 44, 108`. Audyt drugiego przejścia (raport `05-krytyczne-sprostowania-i-gleboka-analiza.md`) doprecyzował je sprawdzonymi wzorcami (Strangler Fig, context-bound adapter, virtual session adapter, hybrydowy stream Zarr). |
| **Wpływ na UI i standard COMSOL/CST** | **10/10** | **Kluczowy i transformujący.** Likwiduje odmontowywanie widoków i modale blokujące, wprowadza Model Builder z prawdziwego zdarzenia, parametryzację z jednostkami, niezależne badania (Studies), osobną konfigurację solverów oraz trwałą przeglądarkę wyników (SolutionSets/Datasets). |

---

### 2. Dlaczego obecny stan blokuje rozwój Fullmaga jako CAE?

Szczegółowy audyt kodu źródłowego ujawnił fundamentalne ograniczenia architektoniczne, które nie są drobnymi usterkami kodu, lecz wynikają z wadliwego modelu własności danych i wykonania:

1. **Zabijanie procesu solvera przy dowolnej edycji w UI (`crates/fullmag-cli/src/scratch_runtime.rs:137-141`)**:
   ```rust
   let scene_changed = attached_scene_revision
       .zip(scene_revision)
       .is_some_and(|(active, current)| active != current);
   if session_changed || backend_changed || scene_changed {
       terminate_child(&mut child);
       ...
   ```
   Każde zatwierdzenie wartości w Inspektorze podbija `scene_revision`. W efekcie proces nadzorczy `scratch_runtime` natychmiast terminuje działający solver, zgłaszając błąd: *"scratch runtime ownership changed while a command was active"*. Z tego powodu system musiał blokować UI modalem podczas obliczeń.

2. **Fizyczne odmontowywanie widoku i gubienie stanu WebGL (`apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx:594-616` oraz `WorkspaceShellClient.tsx:14-31`)**:
   Gdy przygotowanie symulacji jest w toku lub nastąpi zakłócenie (`disrupted`), komponent `WorkspaceStartupGateView` dosłownie **nie renderuje swoich dzieci** (`children` zawierających cały docking layout, ribbon i viewport 3D), zastępując je pełnoekranowym widokiem modala. Powoduje to niszczenie kontekstów WebGL, utratę buforów i reset stanu paneli.

3. **Mieszanie intencji użytkownika, fizyki, konfiguracji solvera, siatki i preferencji kamery w jednym dokumencie (`crates/fullmag-authoring/src/scene.rs`)**:
   `SceneDocument` zawiera jednocześnie obiekty geometryczne (`objects`), fizykę (`materials`, `couplings`), siatkę i solver (`study: SceneStudyState`), pipeline etapów (`study_pipeline`) oraz preferencje widoku edytora (`editor: SceneEditorState`, w tym `opacity`, `clip_pos`, `arrow_mono_color`). Nie da się w takim modelu zapisać niekompletnego projektu, zmienić ustawień kamery bez podbicia rewizji modelu, ani porównać dwóch symulacji tego samego układu fizycznego.

4. **Niszczenie instancji Three.js i WebGL przy przełączaniu zakładek widoku centralnego (`apps/control-room/src/kernel/layout/ViewportTabHost.tsx:74-81`)**:
   ```tsx
   <div className="fm-viewport-tabs__surface">
     <MountedModule
       key={activeModule.id}
       kernel={kernel}
       manifest={activeModule}
       slotId="viewport-main"
     />
   </div>
   ```
   Użycie `key={activeModule.id}` powoduje, że każde przełączenie na inną kartę (np. widok 2D lub wykresy) bezwarunkowo odmontowuje Three.js, niszcząc bufory GPU, shadery, tekstury i resetując kamerę. Przy powrocie do 3D cały kontekst WebGL musi być tworzony i alokowany od zera.

5. **Podwójny narzut wykonawczy i pętla dyskowo-skryptowa w pętli interaktywnej (`crates/fullmag-cli/src/scratch_runtime.rs:204-220 & 421-460`)**:
   Przy każdej komendzie obliczeniowej serwer Rusta formatuje scenę do tekstu skryptu Pythona, zapisuje go na dysku (`/model/syncs`), uruchamia nowy proces potomny CLI (`fullmag script.py`), który startuje interpreter Pythona, importuje moduły, wykonuje DSL `world.py` i dopiero kompiluje to z powrotem do Rusta jako `ProblemIR`. Narzut rozruchu wynosi 600 ms–2.5 s na operację.

---

### 3. Odpowiedź na kluczowe pytania użytkownika

#### Pytanie 1: Czy plan jest prawidłowy, kompletny i zasadny?
- **Zasadny:** Tak, w 100%. Zaproponowana ontologia (`ProjectDefinition` -> `ModelDefinition` -> `StudyDefinition` -> `RunSpecification` -> `SolutionSet` -> `DatasetDefinition` -> `PlotDefinition`) jest zgodna z kanonem inżynierii CAE.
- **Prawidłowy:** Tak. Plan nie jest powierzchowną próbą „przepudrowania” UI, lecz sięga do przyczyn problemu: niezmienności wejścia symulacji (`RunSpecification`), dwuetapowej publikacji wyników z fencingiem prób (`attempt_id`, `ownership_epoch`), oraz uniezależnienia definicji modelu od bieżącej sesji solvera.
- **Kompletny:** W warstwie specyfikacji logicznej i ontologii — wybitnie kompletny. Analiza drugiego przejścia wykazała, że autor planu przewidział 4 kluczowe wyzwania wdrożeniowe (etapowa dekompozycja `orchestrator.rs`, per-context adapter w `world.py`, adapter kompatybilności `/sessions/current` oraz ponowne użycie Zarr dla trajektorii), co podnosi ocenę kompletności do **9.3/10**.

#### Pytanie 2: Czy pozwoli na poprawę UI prawidłowo, produkcyjnie i profesjonalnie?
**Tak.** Dopiero ta architektura pozwala na stworzenie produkcyjnego UI:
1. **Niezawodność powłoki:** Workspace nigdy nie jest odmontowywany. Brak solvera, brak GPU czy błąd siatki to stany prezentowane lokalnie w drzewie lub panelu `Problems`, a nie globalne awarie zamykające okno pracy.
2. **Praca ciągła:** Użytkownik może edytować geometrię kolejnego wariantu lub definiować nowe badanie, podczas gdy w tle trwa przeliczanie wcześniejszego uruchomienia.
3. **Drafty i Undo/Redo:** Formularze edycyjne posiadają lokalne drafty z jawną walidacją AST wyrażeń i jednostek (np. `120[nm]`). Zmiana w formularzu zatwierdzana jest atomową transakcją semantyczną z pełnym wsparciem wielopoziomowego Undo/Redo, bez wywoływania kosztownych operacji backendowych.

#### Pytanie 3: Czy zbliży Fullmaga do jakości i workflow COMSOL / CST?
**Zdecydowanie tak.** Plan wprost adaptuje sprawdzone wzorce obu pakietów:
- **COMSOL Model Builder:** Jedno hierarchiczne drzewo obejmujące: *Global Definitions* (parametry, materiały) -> *Component* (geometria parametryczna ze stosem cech, selekcje, fizyka) -> *Mesh* (receptury dyskretyzacji) -> *Studies* (kroki analizy, np. Stationary/Relaxation -> Frequency Domain / Eigenmodes) -> *Results* (katalog rozwiązań, zbiory danych, wykresy 1D/2D/3D).
- **CST Studio Suite Workflow:** Rozdzielenie modelowania parametrycznego od dyskretnego zadania symulacyjnego (*Simulation Tasks / SAM*), jawne sterowanie sprzężeniami, brak niszczenia wyników poprzednich zadań przy zmianie parametrów modelu bazowego oraz zaawansowany postprocessing ilościowy bez konieczności ponownego uruchamiania solvera.

---

### 4. Cztery kluczowe strategie wykonawcze (antycypowane w planie i skonkretyzowane w audycie)

W toku rygorystycznej analizy kodu skonkretyzowano 4 strategie wdrożeniowe, których fundamenty zostały zapisane przez autora planu w `01-architektura-cae.md:415, 616` oraz `03-migracja.md:42, 44, 108`, a które chronią migrację przed destabilizacją repozytorium:

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      4 KRYTYCZNE STRATEGIE IMPLEMENTACYJNE                       │
├─────────────────────────┬──────────────────────────┬─────────────────────────────┤
│ Obszar kodu             │ Ryzyko                   │ Skonkretyzowane rozwiązanie │
├─────────────────────────┼──────────────────────────┼─────────────────────────────┤
│ 1. orchestrator.rs      │ Naruszenie stabilności   │ Ekstrakcja fasady domenowej │
│    (16 659 linii)       │ całego CLI przy próbie   │ krok po kroku (Strangler    │
│                         │ jednorazowego rozbicia   │ Fig pattern), zachowanie    │
│                         │                          │ orchestrator.rs jako runnera│
├─────────────────────────┼──────────────────────────┼─────────────────────────────┤
│ 2. packages/fullmag-py  │ Złamanie 100+ skryptów   │ Context-bound execution z   │
│    world.py (9 275 l.)  │ naukowych przy próbie    │ ThreadLocal / ContextVar    │
│    _state singleton     │ natychmiastowego usunię- │ i backward-compatible       │
│                         │ cia globalnego API       │ delegacją do domyślnego ctx │
├─────────────────────────┼──────────────────────────┼─────────────────────────────┤
│ 3. apps/control-room    │ Paraliż frontendu przez  │ Virtual Session Adapter     │
│    /v2/sessions/current │ konieczność jednoczesnej │ w API v2, emulujący bieżącą │
│    w 50+ komponentach   │ modyfikacji dziesiątek   │ sesję nad aktywnym proj/run │
│                         │ zasobów i hooków         │ podczas migracji ekranów    │
├─────────────────────────┼──────────────────────────┼─────────────────────────────┤
│ 4. Persystencja CAS     │ Wąskie gardło I/O przy   │ Hybrydowy storage: CAS dla  │
│    wielkich pól 3D      │ ciągłym hashowaniu       │ metadanych/checkpointów,    │
│    (SHA-256 chunków)    │ gigabajtowych pól        │ zero-copy chunked raw/zarr  │
│                         │ w gęstych krokach LLG    │ dla strumieni trajektorii   │
└─────────────────────────┴──────────────────────────┴─────────────────────────────┘
```

---

### 5. Struktura szczegółowego raportu

Niniejszy raport audytowy został podzielony na 6 wyspecjalizowanych dokumentów w podfolderze `raport_gemini/`:
- `00-synteza-i-werdykt.md` *(niniejszy dokument)* — podsumowanie wykonawcze, werdykt, odpowiedzi na pytania strategiczne.
- `01-weryfikacja-kodu-i-faktow.md` — rygorystyczna, punkt po punkcie weryfikacja wszystkich twierdzeń o obecnym kodzie z cytatami i numerami linii.
- `02-analiza-architektury-i-kontraktow.md` — szczegółowa ocena 28 rozdziałów architektury CAE oraz 18 kontraktów K01–K18 z propozycjami formalnych uściśleń.
- `03-ocena-planu-migracji-i-ryzyk.md` — ocena faz P0–P8, analiza 60 scenariuszy odbioru CAE-01 do CAE-60 oraz architektura rozwiązania zidentyfikowanych ryzyk.
- `04-rekomendacje-dla-ui-comsol-cst.md` — szczegółowy projekt transformacji `apps/control-room` w profesjonalne środowisko CAE klasy COMSOL/CST (Model Builder, Inspector, Viewport, Results).
- `05-krytyczne-sprostowania-i-gleboka-analiza.md` — wyniki drugiego przejścia audytu (*Challenge & Correction*): analiza braku Zustanda, rewizja kompletności, profilowanie VRAM vs CPU meshing, usterka `ViewportTabHost.tsx:76` oraz podwójny narzut w `scratch_runtime.rs`.
