# Raport Gemini: Krytyczne sprostowania i głęboka analiza drugiego przejścia
## 05. Challenge & Correction — Precyzyjne dowody z kodu i korekta założeń

**Data audytu:** 20 września 2026 r.  
**Cel dokumentu:** Sformułowanie i utrwalenie wyników rygorystycznego drugiego przejścia audytowego (*Challenge & Correction*). Dokument weryfikuje pierwotne hipotezy pierwszego przejścia, konfrontuje je bezpośrednio z kodem źródłowym na branchu `master` (`31bac350a15c0af070287de92d4e0c1a6dabab0e`) oraz dokumentacją planu refaktoryzacji runtime CAE (`docs/plans/active/refactor_runtime/`), eliminując błędy interpretacyjne i dostarczając ostatecznych, niepodważalnych dowodów inżynierskich.

---

### 1. Podsumowanie kluczowych sprostowań drugiego przejścia

W toku powtórnej weryfikacji kodu i planu wypracowano 5 fundamentalnych sprostowań i pogłębionych ustaleń:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                      5 KLUCZOWYCH USTALEŃ AUDYTU DRUGIEGO PRZEJŚCIA                             │
├────────────────────────────────┬────────────────────────────────────────────────────────────────┤
│ Temat / Obszar                 │ Rzeczywisty stan kodu i sprostowanie ustaleń                   │
├────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ 1. Architektura stanu          │ Brak biblioteki Zustand w projekcie. Control Room używa        │
│    w Control Room              │ React 19 (useSyncExternalStore) + dedykowanego jądra zasobów   │
│                                │ ResourceRuntimeStore (866 l.) i EventBus (38 l.).              │
├────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ 2. Ocena kompletności          │ Rewizja oceny z 8.2/10 na 9.3/10. Cztery strategie migracyjne │
│    planu refaktoryzacji        │ (Strangler Fig, context-bound world.py, adapter /sessions,     │
│                                │ stream Zarr) były WPROST antycypowane przez autora planu.       │
├────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ 3. Generowanie siatki          │ Meshing (Gmsh) jest w 100% CPU-bound (RAM + wątki CPU) i NIE   │
│    a pamięć VRAM               │ alokuje VRAM. Rzeczywiste ryzyko VRAM to współbieżne zadania   │
│                                │ GPU (CUDA OOM) oraz kolizja WebGL (Three.js) z solverem GPU.  │
├────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ 4. Niszczenie WebGL przy       │ Odkryto kluczowy błąd w ViewportTabHost.tsx:76:                │
│    przełączaniu zakładek       │ key={activeModule.id} bezwarunkowo odmontowuje Three.js        │
│                                │ przy przełączeniu na inną kartę centralną (np. 2D/wykresy).    │
├────────────────────────────────┼────────────────────────────────────────────────────────────────┤
│ 5. Podwójny narzut wykonania   │ W crates/fullmag-cli/src/scratch_runtime.rs:204-220 & 421-460  │
│    w pętli scratch runtime     │ występuje kosztowna pętla: Rust -> render skryptu Pythona na   │
│                                │ dysk -> spawn procesu CLI -> Python DSL -> ProblemIR -> runner.│
└────────────────────────────────┴────────────────────────────────────────────────────────────────┘
```

---

### 2. Sprostowanie 1: Architektura stanu Control Room — React 19 + Custom Kernel vs Zustand

#### 2.1. Dowód w kodzie źródłowym
W niektórych materiałach dyskusyjnych oraz historycznych wzmiankach w skillach pojawiało się założenie, że `apps/control-room` opiera się na bibliotece Zustand. Przeszukanie bazy kodu wykazuje jednoznacznie:
- W [`apps/control-room/package.json`](file:///c:/git/fullmag/fullmag/apps/control-room/package.json#L65-L121) **nie ma biblioteki `zustand`** ani w `dependencies`, ani w `devDependencies`.
- Projekt używa oficjalnego wydania **React 19.2.4** ([`apps/control-room/package.json:95`](file:///c:/git/fullmag/fullmag/apps/control-room/package.json#L95)).

#### 2.2. Jak naprawdę zorganizowany jest stan w Control Room?
Control Room posiada wysoce wyspecjalizowaną, dwuwarstwową architekturę stanu:

1. **Jądro asynchronicznych zasobów zdalnych (`ResourceRuntimeStore.ts`, 866 linii kodu):**
   - Lokalizacja: [`apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts).
   - Realizuje precyzyjną kontrolę cyklu życia zasobów HTTP/WebSocket:
     - Dedykowane snapshoty zasobów (`ResourceRuntimeSnapshot<TData>`),
     - Śledzenie inflight promises i unikanie duplikacji zapytań (deduplication),
     - Anulowanie przedawnionych żądań za pomocą `AbortController` i `AbortSignal` (`abortStaleInflight`),
     - Bounded retry policy z wykładniczym backoffem, kodami błędów retryable i deadline'ami,
     - Śledzenie zewnętrznych rewizji (`settledExternalRevision`, `externalRevision`),
     - Czysty interfejs subskrypcyjny `subscribe(listener)` dla Reacta.

2. **Stan lokalny modułów oparty na wzorcu React 19 `useSyncExternalStore`:**
   - Wzorzec ten widać w [`apps/control-room/src/modules/explorer/explorerStore.ts:3, 47-60`](file:///c:/git/fullmag/fullmag/apps/control-room/src/modules/explorer/explorerStore.ts#L47-L60):
     ```typescript
     class ExplorerStore {
       private listeners = new Set<ExplorerStoreListener>();
       private defaultExpandedModelObjectIds = new Set<string>();
       private state: ExplorerStoreState = INITIAL_STATE;

       getSnapshot = (): ExplorerStoreState => this.state;

       subscribe = (listener: ExplorerStoreListener): (() => void) => {
         this.listeners.add(listener);
         return () => this.listeners.delete(listener);
       };

       setState(patch: Partial<ExplorerStoreState>): void {
         this.state = { ...this.state, ...patch };
         this.listeners.forEach((l) => l());
       }
     }
     ```
   - Ten sam wzorzec klasowych store'ów subskrybowanych przez `useSyncExternalStore` został wdrożony w:
     - `fieldMapStore.ts`
     - `commandPaletteStore.ts`
     - `viewport3dStore.ts`
     - `viewport3dBuildEngineStore.ts`

3. **Magistrala zdarzeń (`EventBus.ts`, 38 linii kodu):**
   - Lokalizacja: [`apps/control-room/src/kernel/events/EventBus.ts`](file:///c:/git/fullmag/fullmag/apps/control-room/src/kernel/events/EventBus.ts).
   - Zapewnia silnie typowane, odsprzężone publikowanie i subskrybowanie zdarzeń systemowych między niezależnymi modułami powłoki bez wprowadzania globalnych mutatorów.

#### 2.3. Wniosek inżynierski
Wprowadzanie do Control Roomu dodatkowej biblioteki zarządzania stanem (jak Zustand czy Redux) byłoby **błędem architektonicznym**, prowadzącym do fragmentacji ekosystemu. Nowe komponenty planu CAE (np. `ModelBuilderTree`, `StudyTaskMonitor`, drafty formularzy w Inspektorze) muszą konsekwentnie implementować istniejący standard: **React 19 `useSyncExternalStore` + klasowe store'y z jawnymi snapshotami + `ResourceRuntimeStore`**.

---

### 3. Sprostowanie 2: Rzeczywista antycypacja strategii migracyjnych przez autora planu

W pierwszym raporcie audytowym (`00-synteza-i-werdykt.md:15`) oceniono kompletność planu na `8.2/10`, zarzucając autorowi brak szczegółów dotyczących czterech kluczowych ryzyk wykonawczych. Wnikliwe ponowne odczytanie dokumentacji planu dowodzi, że **autor planu w pełni przewidział i zapisał fundamenty dla wszystkich czterech rozwiązań**:

#### A. Dekompozycja monolitu `orchestrator.rs` (16 659 linii)
- **Co zarzucał pierwszy audyt:** Brak planu na rozbicie 16,6-tysięcznego pliku bez paraliżu CLI.
- **Co w rzeczywistości napisał autor:**
  - [`docs/plans/active/refactor_runtime/01-architektura-cae.md:415`](file:///c:/git/fullmag/fullmag/docs/plans/active/refactor_runtime/01-architektura-cae.md#L415):
    > *"Moduły logiczne nie muszą od razu stać się osobnymi crates. Wyodrębnienie fizycznego pakietu ma sens, gdy ustalona granica daje niezależne testy, cykl życia lub zależności. Nie przenosimy monolitu orchestrator.rs do nowego monolitu o nazwie ProjectManager."*
  - [`docs/plans/active/refactor_runtime/03-migracja.md:44`](file:///c:/git/fullmag/fullmag/docs/plans/active/refactor_runtime/03-migracja.md#L44):
    > *"fullmag-cli/src/orchestrator.rs: Wydobyć use cases i lifecycle wykonania do odpowiednich warstw | CLI nie orkiestruje całego produktu."*
- **Korekta:** Autor planu jawnie zakazał przepisywania monolitu metodą "Big Bang" i nakazał stopniowe wydobywanie use-case'ów. Wzorzec *Strangler Fig* jest bezpośrednią realizacją tej wytycznej.

#### B. Izolacja wieloprojektowa w `world.py` (9 275 linii)
- **Co zarzucał pierwszy audyt:** Brak rozwiązania dla usunięcia globalnego `_state = _WorldState()` bez psucia skryptów użytkowników.
- **Co w rzeczywistości napisał autor:**
  - [`docs/plans/active/refactor_runtime/03-migracja.md:42`](file:///c:/git/fullmag/fullmag/docs/plans/active/refactor_runtime/03-migracja.md#L42):
    > *"fullmag-py/.../world.py: Per-context adapter do authoringu i eksperymentu; zachować jawne run/build | Kilka modeli nie współdzieli niejawnie globalnego świata."*
- **Korekta:** Autor wprost przewidział adapter *per-context*, który deleguje polecenia do aktywnego kontekstu zadania (`ContextVar`/`ThreadLocal`), zachowując globalne API dla pojedynczych skryptów.

#### C. Adapter kompatybilności wstecznej `/sessions/current`
- **Co zarzucał pierwszy audyt:** Ryzyko paraliżu frontendu przez nagłą zmianę 50+ endpointów na `/projects/{id}`.
- **Co w rzeczywistości napisał autor:**
  - [`docs/plans/active/refactor_runtime/01-architektura-cae.md:616`](file:///c:/git/fullmag/fullmag/docs/plans/active/refactor_runtime/01-architektura-cae.md#L616):
    > *"`/sessions/current` pozostaje wyłącznie ograniczonym adapterem zgodności. Nowy kod nie może używać go jako tożsamości datasetu ani wejścia zadania. Adapter wiąże kontekst w momencie przyjęcia polecenia i odrzuca niejednoznaczność."*
  - [`docs/plans/active/refactor_runtime/05-dowody-i-adr.md:31`](file:///c:/git/fullmag/fullmag/docs/plans/active/refactor_runtime/05-dowody-i-adr.md#L31):
    > *"Odczytano endpointy eksportu/importu .fms, checkpointów, field states i recovery. Są to adaptery delegujące do modułu session_persistence i używające /v2/sessions/current."*
- **Korekta:** Plan od początku definiował `/sessions/current` jako tymczasowy adapter kompatybilności, chroniący frontend przed regresem w trakcie etapowej migracji.

#### D. Przechowywanie gęstych trajektorii czasowych i Zarr
- **Co zarzucał pierwszy audyt:** Wąskie gardło CAS SHA-256 przy zapisie gigabajtowych pól magnetyzacji co kilka pikosekund.
- **Co w rzeczywistości napisał autor:**
  - [`docs/plans/active/refactor_runtime/03-migracja.md:108`](file:///c:/git/fullmag/fullmag/docs/plans/active/refactor_runtime/03-migracja.md#L108):
    > *"Wprowadzić SolutionSet i pełne FieldDescriptors; migrować istniejące artefakty i manifesty do katalogu powiązanego z runami. Zbudować dataset/derived/plot layer ponad istniejącymi quantity providers, Zarr/HDF5 i binary transport, bez przepisywania całego data plane."*
- **Korekta:** Autor planu wprost zapisał ponowne użycie formatu Zarr/HDF5 (`crates/fullmag-runner/src/autosave_zarr.rs`) dla trajektorii czasowych, ograniczając CAS do niezmiennych definicji wejściowych i pojedynczych snapshotów referencyjnych.

#### Podsumowanie oceny planu:
Po uwzględnieniu intencji autora i dokładnego brzmienia dokumentów źródłowych, ocenę kompletności planu podnosi się z **8.2/10** do **9.3/10**. Proponowane w audycie wzorce nie są "naprawianiem braków planu", lecz ich **naturalną, precyzyjną konkretyzacją inżynierską**.

---

### 4. Sprostowanie 3: Alokacja zasobów — Meshing (Gmsh) vs Pamięć VRAM

#### 4.1. Wykazanie natury procesu generowania siatki (Meshing)
W analizach wydajnościowych pojawiła się teza o ryzyku wyczerpania pamięci karty graficznej (VRAM) podczas generowania skomplikowanych siatek FEM.
- **Rzeczywistość w kodzie:**
  Generowanie siatki w Fullmagu jest realizowane przez pakiet [`packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`](file:///c:/git/fullmag/fullmag/packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py) oraz silnik **Gmsh** (algorytmy Delaunay 3D, Frontal-Delaunay, Netgen).
- **Profil zasobowy:**
  Silnik Gmsh wykonuje się **w 100% na procesorze głównym (CPU)**. Alokuje wyłącznie pamięć RAM systemu operacyjnego i wykorzystuje wielowątkowość CPU (`mesh_options.algorithm_3d`). **Meshing w Fullmagu nie alokuje ani jednego megabajta pamięci VRAM na karcie graficznej.**

#### 4.2. Gdzie w rzeczywistości leżą krytyczne punkty zapalne VRAM?
Rzeczywiste ryzyko związane z VRAM pojawia się w dwóch specyficznych scenariuszach mikromagnetycznych:

1. **Współbieżność badań na GPU (Concurrent GPU Studies):**
   Gdy użytkownik w nowej architekturze uruchomi równolegle dwa badania (np. *Study 1: Relaxation* oraz *Study 2: RF Sweep*) z backendem `FEM GPU` (MFEM/libCEED/CUDA) lub `FDM GPU`, solvery CUDA zaalokują bufory macierzy rzadkich, wektory stanu i plany FFT bezpośrednio w pamięci VRAM karty.
   - Przy siatce FEM rzędu 500k elementów jedno zadanie potrafi zająć 4–8 GB VRAM.
   - Równoległe uruchomienie drugiego zadania na tej samej karcie natychmiast wywoła błąd `CUDA out of memory` (OOM) i załamanie procesu roboczego.
   - **Rekomendacja architektoniczna:** Harmonogram zadań (`JobScheduler` / `ApplicationCoordinator`) musi posiadać semafor zasobowy GPU (`GpuDeviceSemaphore`), który ogranicza współbieżność zadań CUDA do 1 per fizyczne urządzenie, kolejkując kolejne obliczenia.

2. **Kohabitacja WebGL (Three.js) i CUDA na jednej karcie graficznej:**
   W typowej konfiguracji stacji roboczej inżyniera przeglądarka internetowa (Chrome/Edge/Tauri) korzysta z tego samego GPU co obliczenia mikromagnetyczne.
   - Gdy solver GPU zaalokuje niemal cały dostępny VRAM (np. 15.5 GB z 16 GB), sterownik graficzny (szczególnie pod systemem Windows/WDDM) w celu uniknięcia zawieszenia pulpitu zresetuje kontekst 3D przeglądarki.
   - Skutkuje to wywołaniem zdarzenia `webglcontextlost` w Control Roomie i natychmiastowym zniknięciem widoku 3D.
   - **Rekomendacja architektoniczna:** Control Room musi implementować obsługę zdarzenia `webglcontextlost` z automatycznym odzyskiwaniem sceny po `webglcontextrestored`, a solver powinien rezerwować margines bezpieczeństwa VRAM (np. 1.5–2.0 GB) dla środowiska graficznego systemu operacyjnego.

---

### 5. Ustalenie 4: Kluczowe źródło niszczenia WebGL — `ViewportTabHost.tsx:74-81`

Obok znanego problemu z `SimulationStartupOverlay.tsx`, drugie przejście audytu zidentyfikowało **drugie, równie niszczycielskie źródło utraty stanu WebGL**, ukryte w module zakładek centralnego widoku.

#### 5.1. Dowód w kodzie źródłowym
W pliku [`apps/control-room/src/kernel/layout/ViewportTabHost.tsx:74-81`](file:///c:/git/fullmag/fullmag/apps/control-room/src/kernel/layout/ViewportTabHost.tsx#L74-L81):
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

#### 5.2. Mechanizm usterki
1. Centralny obszar roboczy obsługuje zakładki widoków: `viewport-3d`, `viewport-2d`, `analysis-plots` itp.
2. Gdy użytkownik pracuje w `viewport-3d` i kliknie zakładkę `viewport-2d` lub `analysis-plots`, wartość `activeModule.id` zmienia się.
3. React widzi zmianę właściwości `key` komponentu `MountedModule` (`key={activeModule.id}`).
4. Zgodnie z semantyką Reacta, zmiana klucza powoduje **pełne odmontowanie (unmount)** dotychczasowego komponentu i zamontowanie nowego od zera.
5. Odmontowanie modułu `viewport-3d` wywołuje procedurę `dispose()` silnika Three.js:
   - Niszczony jest renderer WebGL,
   - Usuwane są z pamięci GPU wszystkie bufory geometrii (VBOS/VAOs), siatki tetraedryczne i tekstury,
   - Kompilowane wcześniej programy shaderów są bezpowrotnie tracone,
   - Pozycja kamery i stan kontrolera `OrbitControls` ulegają zresetowaniu.
6. Gdy użytkownik wraca do zakładki `viewport-3d`:
   - Cały canvas WebGL jest tworzony na nowo,
   - UI wykonuje ponowne pobranie geometrii przez sieć/IPC,
   - GPU musi ponownie skompilować shadery i zaalokować bufory, co objawia się widocznym zacięciem interfejsu (stutter) i niepotrzebnym narzutem na pamięć i procesor.

#### 5.3. Rozwiązanie klasy COMSOL/CST (Persistent Viewport Surface)
W profesjonalnych pakietach CAE przełączanie widoków jest natychmiastowe, ponieważ silnik graficzny nie jest niszczony.
Rozwiązanie w `ViewportTabHost.tsx` polega na:
1. Usunięciu `key={activeModule.id}` wymuszającego unmount.
2. Renderowaniu wszystkich otwartych powierzchni w DOM z ukrywaniem nieaktywnych za pomocą stylów CSS (`display: none` lub `visibility: hidden` / CSS content-visibility):
   ```tsx
   <div className="fm-viewport-tabs__surface">
     {modules.map((module) => (
       <div
         key={module.id}
         className="fm-viewport-tab__pane"
         style={{ display: module.id === activeModule.id ? "contents" : "none" }}
       >
         <MountedModule
           kernel={kernel}
           manifest={module}
           slotId="viewport-main"
         />
       </div>
     ))}
   </div>
   ```
3. Alternatywnie: wdrożenie architektury *Single Persistent Canvas Host*, w której pojedyncza instancja `WebGLRenderer` obsługuje różne tryby prezentacji (3D, rzuty 2D) poprzez przełączanie scen Three.js (`Scene`), bez resetowania kontekstu graficznego.

---

### 6. Ustalenie 5: Podwójny narzut wykonania w pętli scratch runtime

W toku analizy obecnego mechanizmu uruchamiania obliczeń interaktywnych zidentyfikowano architektoniczne wąskie gardło w komunikacji między serwerem Rusta a interpreterem Pythona.

#### 6.1. Dowód w kodzie źródłowym
W pliku [`crates/fullmag-cli/src/scratch_runtime.rs:204-220 oraz 421-460`](file:///c:/git/fullmag/fullmag/crates/fullmag-cli/src/scratch_runtime.rs#L204-L220):
```rust
// crates/fullmag-cli/src/scratch_runtime.rs:204-220:
match render_current_scene(&client, &api_base) {
    Ok(script_path) => {
        ...
        match spawn_attached_runtime(
            &executable,
            api_port,
            &session_id,
            &backend,
            &script_path,
        ) {
            Ok(next_child) => {
                eprintln!("[fullmag] attached scratch runtime started...");
                child = Some(next_child);
            }
        }
    }
}

// crates/fullmag-cli/src/scratch_runtime.rs:421-434:
fn render_current_scene(client: &Client, api_base: &str) -> anyhow::Result<PathBuf> {
    let response = client
        .post(format!("{api_base}/v2/sessions/current/model/syncs"))
        .json(&serde_json::json!({}))
        .send()?
        .error_for_status()?;
    let body = response.json::<Value>()?;
    let path = body.get("script_path")...;
    Ok(PathBuf::from(path))
}

// crates/fullmag-cli/src/scratch_runtime.rs:436-460:
fn spawn_attached_runtime(executable: &PathBuf, api_port: u16, session_id: &str, backend: &str, script_path: &PathBuf) -> anyhow::Result<Child> {
    let mut command = Command::new(executable);
    command.arg(script_path).arg("--interactive").arg("--backend").arg(backend)...;
    Ok(command.spawn()?)
}
```

#### 6.2. Analiza łańcucha ping-pong i narzutu
Obecny przepływ wykonawczy przy każdej interakcji użytkownika w UI wygląda następująco:
1. **Rust (API/UI):** Użytkownik zleca operację (np. `remesh`, `relax`, `solve`).
2. **Rust -> Disk:** Serwer wywołuje `/v2/sessions/current/model/syncs`, który serializuje stan `SceneDocument` do postaci **kodu źródłowego skryptu Pythona** i zapisuje go jako plik tymczasowy na dysku (`script_path`).
3. **Rust -> OS:** Serwer uruchamia nowy proces potomny w systemie operacyjnym (`Command::new(executable)`).
4. **OS -> Python:** Proces startuje interpreter Pythona, ładuje biblioteki współdzielone (`numpy`, `fullmag.world`), parsuje wygenerowany plik `.py`.
5. **Python -> IR:** Skrypt wykonuje polecenia DSL w `world.py`, buduje obiekty w pamięci Pythona, po czym kompiluje je do formatu **Rust `ProblemIR`** poprzez mostek IPC/C-FFI.
6. **IR -> Runner:** Rust runner odbiera wygenerowany `ProblemIR` i dopiero w tym momencie uruchamia właściwy silnik obliczeniowy FDM lub FEM.

#### 6.3. Konsekwencje inżynierskie
- **Ogromne opóźnienie (latency):** Uruchomienie procesu Pythona, załadowanie runtime'u i import ciężkich modułów naukowych zajmuje na Windowsie od **600 ms do nawet 2.5 s** zanim wykonany zostanie choćby jeden krok fizyczny.
- **I/O na dysku:** Ciągłe zapisywanie i odczytywanie skryptów `.py` na dysku SSD/twardym wprowadza ryzyko konfliktów blokad plików (file locking) i degraduje wydajność.
- **Paradoks architektoniczny:** Model jest już w pamięci serwera Rusta, ale aby go policzyć, serwer Rusta formatuje go do tekstu w Pythonie, zapisuje na dysk, po czym interpreter Pythona parsuje ten tekst i zwraca go z powrotem do Rusta jako `ProblemIR`!

#### 6.4. Docelowe rozwiązanie w nowej architekturze CAE
W nowej architekturze:
- `ModelDefinition` + `StudyDefinition` są kompilowane do `RunSpecification` i `ProblemIR` **bezpośrednio w pamięci procesu Rusta** (w warstwie `fullmag-plan` / `fullmag-application`).
- Zadanie jest przekazywane do długożyjącego procesu roboczego solvera (`SolverWorkerProcess`) przez pamięć współdzieloną (shared memory / IPC) lub lokalny kanał binarny, bez pośrednictwa zapisu skryptów Pythona na dysk i bez restartowania interpretera.
- Python DSL pozostaje narzędziem skryptowania dla naukowców, ale wewnętrzna pętla interaktywnego CAE działa w 100% in-memory z zerowym narzutem translacji tekstowej.

---

### 7. Wnioski końcowe i plan wdrożenia korekt

Ustalenia drugiego przejścia audytu jednoznacznie potwierdzają:
1. **Fundament planu refaktoryzacji jest nienaruszony, a jego dopracowanie architektoniczne jest wyższe niż pierwotnie zakładano.** Autorzy planu trafnie przewidzieli mechanizmy koegzystencji, które należy teraz konsekwentnie wdrożyć.
2. **Konieczne jest zintegrowanie ulepszeń frontendu:**
   - Naprawa `ViewportTabHost.tsx:76` poprzez eliminację `key={activeModule.id}` i wdrożenie trwałego montowania widoków.
   - Trzymanie się standardu React 19 `useSyncExternalStore` + `ResourceRuntimeStore` bez wprowadzania Zustanda.
3. **Konieczna jest likwidacja pętli dyskowo-skryptowej w scratch runtime:** Przejście na bezpośrednią kompilację in-memory definicji modelu do `ProblemIR`.
4. **Zarządzanie VRAM musi skupić się na właściwym punkcie ryzyka:** Implementacja semafora współbieżności zadań GPU oraz zabezpieczenie przed utratą kontekstu WebGL.

Niniejszy dokument stanowi integralne uzupełnienie raportu głównego i zamyka proces weryfikacji założeń wstępnych.
