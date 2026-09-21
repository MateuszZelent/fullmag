# Raport Gemini: Rekomendacje dla UI i workflow klasy COMSOL / CST
## 04. Projekt transformacji Control Room w profesjonalne środowisko CAE

**Data audytu:** 20 września 2026 r.  
**Cel:** Przełożenie nowej architektury CAE na najwyższej klasy doświadczenie użytkownika (UX) w `apps/control-room`, eliminując modale blokujące, migotanie i odmontowywanie widoków, oraz wdrażając sprawdzony w przemyśle workflow znany z COMSOL Multiphysics i CST Studio Suite.

---

### 1. Diagnoza obecnego UI i dlaczego COMSOL/CST działają inaczej

W komercyjnych pakietach CAE (COMSOL, CST Studio Suite, Ansys HFSS):
1. **Model jest zawsze widoczny i edytowalny:** Niezależnie od tego, czy solver liczy w tle, czy wystąpił błąd zbieżności, czy siatka nie została jeszcze wygenerowana — użytkownik ma pełny dostęp do drzewa modelu, parametrów i wyników.
2. **Brak modalnych blokad (No full-screen blocking modals):** Zadania długotrwałe (meshing, solve, sweep) działają w tle, sygnalizując postęp w pasku stanu (status tray) lub dedykowanym panelu zadań.
3. **Pojęcie badania (Study) steruje eksperymentem:** Użytkownik nie klika „uruchom symulację na tym co widać”, lecz definiuje badanie: *Study 1: Stationary -> Study 2: Frequency Domain*. Wyniki są trwale powiązane z danym badaniem.

W Fullmagu obecny komponent `SimulationStartupOverlay.tsx` oraz `WorkspaceShellClient.tsx` niszczą to doświadczenie, ponieważ przy każdym uruchomieniu przygotowania symulacji usuwają całe drzewo komponentów z DOM, powodując reset Three.js, gubienie paneli i zamykanie edytorów.

---

### 2. Architektura nowej powłoki roboczej (Workspace Shell)

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ Pasek menu: File | Edit | View | Geometry | Physics | Mesh | Study | Results | Tools | Help │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ Wstążka narzędziowa (Ribbon): Kontekstowa, zorganizowana według etapów pracy CAE           │
├──────────────────────┬───────────────────────────────────────────────┬──────────────────────┤
│ MODEL BUILDER        │ OBSZAR WIDOKU CENTRALNEGO (Central Tabs)      │ SETTINGS / INSPECTOR │
│                      │ ┌───────────────────────────────────────────┐ │                      │
│ 📁 Project: Waveguide│ │ [3D Viewport] [Convergence] [Plot: m_z]   │ │ Nazwa: Strip_1       │
│  ├─ ⚙️ Definitions   │ ├───────────────────────────────────────────┤ │ Szerokość: 120[nm]   │
│  │   ├─ Parameters   │ │                                           │ │ Długość:   2[um]     │
│  │   └─ Materials    │ │      Trwały Viewport 3D (Three.js)        │ │ Grubość:   10[nm]    │
│  ├─ 📦 Component 1   │ │     (NIGDY nie jest odmontowywany)        │ │                      │
│  │   ├─ Geometry     │ │                                           │ │ Materiał: Permalloy  │
│  │   ├─ Physics      │ │                                           │ │                      │
│  │   └─ Mesh         │ │                                           │ │ [Apply]   [Revert]   │
│  ├─ ⏱️ Studies       │ └───────────────────────────────────────────┘ │                      │
│  │   ├─ Equilibrium  ├───────────────────────────────────────────────┴──────────────────────┤
│  │   └─ Spin-Waves   │ PANELE DOLNE (Dockable Tabs)                                         │
│  └─ 📊 Results       │ [Messages / Log] [Problems (0 errors, 1 warn)] [Progress / Tasks]    │
│      ├─ Solutions    ├──────────────────────────────────────────────────────────────────────┤
│      └─ 1D/2D Plots  │ Status bar: Idle | GPU: NVIDIA RTX 4090 | Units: SI (nm) | Ready     │
└──────────────────────┴──────────────────────────────────────────────────────────────────────┘
```

#### 2.1. Likwidacja `WorkspaceStartupGateView`
- **Zmiana:** Usuwamy logikę `if (state.isVisible) return <OverlayView />`.
- **Nowe zachowanie:** Komponent `WorkspaceShellClient` zawsze renderuje `children` (pełen układ docków, ribbon i viewport).
- **Prezentacja postępu:** Stan przygotowania symulacji i obliczeń jest prezentowany w:
  1. Dolnym pasku stanu (miniaturowy pasek postępu z nazwą zadania, np. *„Meshing shared domain: 45%”* oraz przyciskiem *Cancel*).
  2. Pływającym panelu `Progress / Task Manager` (dokowalnym na dole ekranu).
  3. Węzłach drzewa Model Builder (ikona obracającego się spinnera przy aktualnie liczonym węźle Study).

#### 2.2. Architektura stanu: React 19 + `useSyncExternalStore` + `ResourceRuntimeStore` (bez Zustanda)
Wbrew obiegowym opiniom lub historycznym wzmiankom w skillach, baza kodu `apps/control-room` **nie korzysta z biblioteki Zustand** (brak w `package.json`). Projekt opiera się na **React 19.2.4** i dedykowanym, wysoce wyspecjalizowanym jądrze:
1. **Zasoby zdalne (Remote Resources):** `ResourceRuntimeStore.ts` (866 linii) odpowiada za cache, unikanie duplikacji zapytań (inflight deduplication), anulowanie starych żądań przez `AbortController`, politykę retry z deadline'ami oraz synchronizację rewizji (`externalRevision`).
2. **Stan lokalny modułów:** Klasowe store'y subskrybowane przez wzorzec React 19 `useSyncExternalStore` (jak w `ExplorerStore.ts`, `fieldMapStore.ts`, `viewport3dStore.ts`).
3. **Komunikacja między modułami:** Lekka magistrala zdarzeń `EventBus.ts` (38 linii).

Nowe moduły CAE (`ModelBuilderTree`, `StudyTaskMonitor`, drafty Inspektorów) muszą **ściśle kontynuować ten wzorzec**, unikając wprowadzania zewnętrznych bibliotek zarządzania stanem, co gwarantuje zerowy narzut i pełną zgodność z mechanizmami współbieżnymi React 19.

---

### 3. Model Builder — organizacja drzewa projektu (Wzorce COMSOL / CST)

Nowe drzewo Model Builder powinno zastąpić dotychczasowy `ExplorerModule.tsx` i odzwierciedlać naturalny przepływ inżynierski:

```text
📁 Project: MagnonicCrystal_Filter
│
├── ⚙️ Global Definitions
│   ├── 🔢 Parameters (w=120[nm], L=2[um], d=10[nm], f0=9.2[GHz], Bext=50[mT])
│   ├── 📈 Functions & Analytic Profiles (rf_pulse = sinc(2*pi*f0*t))
│   └── 📚 Materials Library (Permalloy_Py, Cobalt_Co, YIG, Copper)
│
├── 📦 Component 1 (Device Stack)
│   ├── 🌐 Definitions & Coordinate Systems
│   │   ├── 🧭 Coordinate System: Global Cartesian
│   │   └── 🎯 Explicit Selections (S1: Waveguide Core, S2: Antennas, S3: Edge Absorbers)
│   │
│   ├── 📐 Geometry Sequence
│   │   ├── ⏹️ Box 1: Waveguide Body (w, L, d)
│   │   ├── ⏹️ Box 2: Left Antenna Strip (20[nm], 500[nm], 5[nm])
│   │   ├── 🔄 Boolean Difference: Ground Notch
│   │   └── 🛠️ Build Buttons: [Build Selected] [Build to Selected] [Build All]
│   │
│   ├── 🧲 Physics: Micromagnetics
│   │   ├── 🧱 Material Assignments (Permalloy -> Selection S1)
│   │   ├── ⚡ Exchange Interaction (Aex = 13[pJ/m])
│   │   ├── 🧲 Demagnetizing Field (Method: Fast P3M / FEM-BEM)
│   │   ├── 🧭 Uniaxial Anisotropy (Ku1 = 0, Easy Axis: [1, 0, 0])
│   │   ├── 📡 RF Antenna Drive (Drive: Left Antenna, Profile: rf_pulse)
│   │   └── ❄️ Frozen Spins / Constraints (Selection: S3 Edge Absorbers)
│   │
│   └── 🕸️ Mesh / Discretization
│       ├── 🔲 FDM Recipe (Cell size: 4x4x5 [nm], Periodic: None)
│       ├── 🔺 FEM Recipe (Tetrahedral P1, Min size: 2[nm], Max size: 10[nm], Curvature adaptive)
│       └── 🛠️ Mesh Action: [Generate Mesh] [Inspect Quality]
│
├── ⏱️ Studies (Numerical Experiments)
│   ├── 🟢 Study 1: Ground State Relaxation
│   │   ├── ⚙️ Solver Configuration (Algorithm: LLG Overdamped, Max steps: 5000, Tol: 1e-5 T)
│   │   └── 🏁 Stop Condition: Torque criterion satisfied
│   │
│   ├── 🔵 Study 2: Spin-Wave Transmission (Transient)
│   │   ├── 📥 Initial Condition: Solution from Study 1 (Equilibrium State)
│   │   ├── ⏱️ Time Integration (Integrator: RK4 Dormand-Prince, dt: 50[fs], Duration: 5[ns])
│   │   └── 💾 Acquisition / Monitors (Save m every 5[ps], Planar Monitor Z=5nm)
│   │
│   └── 🟣 Study 3: Eigenmode Spectrum
│       ├── 📥 Linearization State: Solution from Study 1
│       └── 🎯 Eigensolver (Modes: 12, Shift-and-Invert target: 9[GHz], Solver: Krylov-Schur)
│
└── 📊 Results
    ├── 🗄️ Solution Sets
    │   ├── Run 1: Study 1 (Equilibrium achieved, Residual: 4.2e-6 T)
    │   ├── Run 2: Study 2 (Trajectory 5ns, 1000 frames)
    │   └── Run 3: Study 3 (12 eigenvalues identified)
    │
    ├── 📑 Datasets (Projections & Cuts)
    │   ├── D1: Full Volume Solution Run 2
    │   ├── D2: Cutplane Z = 5 nm (Cross-section)
    │   └── D3: Point Probe (Center of Waveguide)
    │
    ├── 📈 Plot Groups
    │   ├── 1D Plot: Total Energy & Torque vs Step (Study 1)
    │   ├── 1D Plot: S21 Transmission Parameter vs Frequency (FFT of Run 2)
    │   ├── 2D Surface: m_z Field at t = 2.5 ns (Dataset D2)
    │   └── 3D Vector: Spatial Mode Profile #3 at 9.15 GHz (Run 3)
    │
    └── 📋 Evaluation Tables & Reports
        ├── Table 1: Mode Frequencies & Q-factors
        └── 📄 Generate HTML/PDF Executive Report
```

---

### 4. Profesjonalny Inspektor Właściwości (CAD/CAE Inspector)

#### 4.1. Edycja wyrażeń i jednostek (Expression-Aware Inputs)
W polach liczbowych użytkownik nie powinien być zmuszany do ręcznego przeliczania wartości na metry w notacji naukowej (np. `0.00000012`).
- **Składnia wejściowa:** Użytkownik wpisuje: `120[nm]`, `2.5[um]`, `L_guide / 2`, `800[kA/m]`, `50[mT]`.
- **Interaktywna walidacja:** W trakcie pisania pod polem wyświetla się znormalizowana wartość bazowa SI w kolorze neutralnym: `≈ 1.2000e-7 m`.
- **Selektor jednostek prezentacji (Display Unit Selector):** Obok pola znajduje się rozwijany selektor jednostek (`nm`, `µm`, `mm`, `m`), który zmienia jedynie sposób prezentacji liczby na ekranie, nie zmieniając fizycznego równania.

#### 4.2. Pasek stanu edycji (Apply / Revert Bar)
Zgodnie z ADR-0008, formularz posiada lokalny stan roboczy (Draft):
- **Czysty (Clean):** Wartości w formularzu odpowiadają zatwierdzonemu modelowi. Przyciski *Apply* i *Revert* są nieaktywne.
- **Zmodyfikowany (Draft):** Po edycji któregokolwiek pola pojawia się subtelny pomarańczowy indykator draftu, a przyciski stają się aktywne.
- **Błąd walidacji (Error):** Wpisanie niepoprawnego wyrażenia (np. `120[nm` bez domknięcia nawiasu) podświetla pole na czerwono, uniemożliwia kliknięcie *Apply* i wyświetla podpowiedź o błędzie składni AST.
- **Skróty klawiszowe:** `Ctrl + Enter` zatwierdza transakcję (*Apply*), `Escape` przywraca poprzednią wartość (*Revert*).

---

### 5. Viewport 3D: Kontekstowa wizualizacja bez przeładowań

Jednym z największych problemów obecnego Control Roomu jest resetowanie lub gubienie kontekstu WebGL Three.js przy zmianach stanu. Drugie przejście audytu zidentyfikowało dwa niezależne źródła tego problemu: `SimulationStartupOverlay.tsx` oraz `ViewportTabHost.tsx`.

#### 5.1. Likwidacja usterki odmontowywania w `ViewportTabHost.tsx:74-81`
W pliku [`apps/control-room/src/kernel/layout/ViewportTabHost.tsx:74-81`](file:///c:/git/fullmag/fullmag/apps/control-room/src/kernel/layout/ViewportTabHost.tsx#L74-L81) znajduje się fragment odpowiedzialny za renderowanie aktywnej karty centralnej:
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
- **Problem:** Użycie `key={activeModule.id}` powoduje, że gdy użytkownik przełączy zakładkę z `viewport-3d` na `viewport-2d` lub `analysis-plots`, React **bezwarunkowo odmontowuje** komponent 3D. Wywołuje to `dispose()` w Three.js, niszcząc renderer WebGL, bufory GPU, shadery i stan kamery. Powrót do 3D wymaga powtórnej inicjalizacji i ponownego ładowania geometrii.
- **Rozwiązanie klasy COMSOL/CST (Persistent Viewport Surface):**
  1. Usunięcie `key={activeModule.id}` uniemożliwiające odmontowywanie modułów.
  2. Utrzymywanie instancji modułów w drzewie DOM i sterowanie ich widocznością za pomocą CSS (`display: module.id === activeModule.id ? "contents" : "none"` lub `visibility: hidden`).
  3. Wdrożenie architektury *Single Persistent Canvas Host*, w której pojedyncza instancja `WebGLRenderer` obsługuje scenę 3D oraz rzuty 2D bez rekonfiguracji kontekstu graficznego.

#### 5.2. Profilowanie zasobów: CPU Meshing vs Pamięć GPU (VRAM)
W dyskusjach architektonicznych często błędnie przypisuje się generowaniu siatki zużycie pamięci VRAM.
- **Fakty z kodu:** Meshing (Gmsh w `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`) jest procesem **w 100% CPU-bound** (RAM systemowy + wielowątkowość CPU). Gmsh nie alokuje pamięci na karcie graficznej.
- **Rzeczywiste wyzwania VRAM:**
  1. **Współbieżność badań GPU (CUDA OOM):** Uruchomienie dwóch równoległych badań `FEM GPU` (MFEM/CUDA) na siatce 500k elementów może przekroczyć 16 GB VRAM. Harmonogram zadań musi posiadać semafor `GpuDeviceSemaphore` limitujący równoległe zadania solvera do 1 per fizyczny akcelerator.
  2. **Kohabitacja WebGL i CUDA na pojedynczym GPU:** Skok alokacji solvera GPU może sprowokować sterownik graficzny (WDDM na Windows) do zrzucenia kontekstu 3D przeglądarki. Control Room musi implementować obsługę zdarzenia `webglcontextlost` i automatycznie odtwarzać scenę po `webglcontextrestored`.

#### 5.3. Likwidacja pętli dyskowo-skryptowej (`scratch_runtime.rs:204-220 & 421-460`)
W obecnym kodzie każda interakcja użytkownika wywołuje ping-pong:
`Rust API -> render skryptu Pythona na dysk -> uruchomienie procesu potomnego CLI -> interpretacja w Python DSL -> kompilacja do ProblemIR -> Rust runner`.
Narzut startu interpretera i importów naukowych wynosi 600 ms–2.5 s. W nowej architekturze:
- Serwer Rusta kompiluje `ModelDefinition` + `StudyDefinition` do `ProblemIR` **bezpośrednio w pamięci** (w ułamku milisekundy).
- Zadanie jest przekazywane do długożyjącego procesu solvera przez lokalny kanał binarny/IPC, co zapewnia błyskawiczną responsywność interfejsu godną aplikacji desktopowych.

#### 5.4. Zasady działania profesjonalnego Viewportu 3D:
1. **Pojedynczy, permanentny Canvas WebGL:** Element `<canvas>` jest montowany raz przy starcie aplikacji i **nigdy** nie jest niszczony w trakcie cyklu życia karty przeglądarki.
2. **Kontekstowe adaptery wizualizacji (Contextual Render Adapters):** Viewport reaguje na to, co jest zaznaczone w Model Builderze:
   - **Zaznaczona cecha geometrii (np. Box 1):** Viewport przechodzi w tryb modelowania CAD. Pokazuje bryły półprzezroczyste, z podświetlonymi krawędziami zaznaczonej cechy oraz gizmem translacji/skalowania.
   - **Zaznaczony węzeł Mesh:** Viewport pokazuje krawędzie siatki tetraedrycznej FEM lub linie gridu FDM, z kolorowaniem jakości elementów (Skewness, Aspect Ratio).
   - **Zaznaczony moduł fizyki (np. RF Antenna Drive):** Viewport podświetla strefę oddziaływania anteny i wektor wymuszenia pola.
   - **Zaznaczony wynik (Plot Group: m_z surface):** Viewport renderuje pole magnetyzacji, kontury barwne i wektory spinów dla wybranego snapshotu czasowego.
3. **Płynne przejścia kamerą (Smooth Camera Framing):** Podwójne kliknięcie węzła w drzewie płynnie przybliża kamerę na dany komponent (zoom to selected) z wykorzystaniem animacji sferycznej (slerp).

---

### 6. Porównanie workflow: Obecny Fullmag vs COMSOL / CST vs Docelowy Fullmag

| Cecha / Workflow | Obecny Fullmag (master) | COMSOL Multiphysics / CST Studio | Docelowy Fullmag (Nowa Architektura) |
|---|---|---|---|
| **Jednostka pracy** | Pojedyncza sesja solvera w pamięci | Trwały plik projektu (.mph / .cst) | Trwały projekt `.fms` z wersjonowanym modelem |
| **Zależność od solvera** | UI wymaga działającego solvera i GPU | Pełne modelowanie offline bez solvera | Pełne modelowanie, edycja i zapis bez solvera |
| **Zachowanie podczas solve** | Pełnoekranowy modal blokujący UI | Obliczenia w tle, UI w pełni interaktywne | Obliczenia w tle, model edytowalny, status w tray |
| **Wpływ edycji na solver** | Solver zabijany przy zmianie sceny | Zmiana draftu nie narusza aktywnego zadania | Zmiana draftu tworzy nową wersję; run nienaruszony |
| **Definicja analiz** | Płaska lista etapów z JSON payloadem | Niezależne Studies ze sprzężeniami wejść | Typowane Studies z jawnymi portami we/wy |
| **Konfiguracja metod** | Sztywne presety w `SceneStudyState` | Rozwijane drzewo algorytmów i tolerancji | Domyślny preset z jawnym drzewem parametrów solvera |
| **Przeglądanie wyników** | Nadpisywanie bufora `latest` w pamięci | Katalog Solutions, Datasets i Plot Groups | Trwałe SolutionSets, Datasets, rzuty i wykresy |
| **Stabilność WebGL** | Niszczony przez `StartupGate` i `ViewportTabHost:76` | Stabilny, jeden silnik renderujący | Permanentny canvas Three.js z trwałym montowaniem powierzchni |
| **Narzut interakcji** | 600 ms–2.5 s (pętla skryptowa w `scratch_runtime`) | Natychmiastowy (in-memory C++/FORTRAN) | Natychmiastowy (<5 ms, in-memory kompilacja Rusta) |
| **Undo / Redo** | Niestabilne, gubi stan sesji | Pełna historia edycji modelu | Transakcyjne Undo/Redo na komendach definicji |
| **Wielozadaniowość** | Jedno badanie w danym momencie | Kolejkowanie badań, porównywanie wyników | Kolejka runów z semaforem GPU, porównywanie widoków |

---

### 7. Wnioski i plan działania dla zespołu UI

Wdrożenie architektury CAE umożliwi zespołowi frontendu stworzenie narzędzia o klasie i ergonomii nieustępującej liderom rynku CAE:
1. **W Fazie P1 (Stabilizacja powłoki):**
   - Usunąć `WorkspaceStartupGateView` z `WorkspaceShellClient.tsx`, odblokowując trwały widok powłoki.
   - Zastąpić keyed mounting w `ViewportTabHost.tsx:76` trwałym montowaniem zakładek (Persistent Viewport Surface), eliminując niszczenie kontekstu Three.js przy przełączaniu kart.
2. **W Fazie P2 (Model Builder & In-Memory Loop):**
   - Zastąpić `sceneModelTreeAdapter.ts` nowym komponentem `ModelBuilderTree.tsx` (opartym na `useSyncExternalStore`), obsługującym hierarchię: *Definitions -> Component -> Geometry -> Physics -> Mesh -> Studies -> Results*.
   - Wyeliminować pętlę generowania skryptów dyskowych w `scratch_runtime.rs` na rzecz bezpośredniej kompilacji `ModelDefinition` do `ProblemIR`.
3. **W Fazie P3 (Inspektor & Drafty):**
   - Wprowadzić inspektory oparte na ewaluacji jednostek (`120[nm]`, `2.5[um]`) z lokalnymi draftami i zatwierdzaniem `Ctrl+Enter`.
4. **W Fazie P6 (Results & Postprocessing):**
   - Zbudować dedykowany panel `Results Explorer` z obsługą zbiorów danych (Datasets), przekrojów płaszczyzną i wykresów 1D/2D/3D.

Dzięki temu Fullmag przestanie być postrzegany jako „eksperymentalny skrypt z prostym interfejsem WWW”, a stanie się **pełnoprawnym, profesjonalnym środowiskiem CAE dla fizyków i inżynierów mikromagnetyzmu**.
