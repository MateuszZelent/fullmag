# Raport Gemini: Analiza architektury CAE i kontraktów K01–K18
## 02. Rygorystyczna ocena specyfikacji docelowej

**Data audytu:** 20 września 2026 r.  
**Przedmiot analizy:**  
- `01-architektura-cae.md` (28 rozdziałów, ontologia encji, 4 grafy, 16 niezmienników)  
- `02-kontrakty.md` (18 formalnych kontraktów transakcyjnych i danych K01–K18)  
- Zgodność z wytycznymi architektonicznymi projektu (`docs/architecture/backend-golden-masterplan.md`, `AGENTS.md`, ADR-0008, ADR-0025)

---

### 1. Ocena kluczowych filarów architektury CAE (`01-architektura-cae.md`)

#### 1.1. Przejście: Bieżąca Sesja -> Trwały Projekt (Rozdziały 1–2)
- **Ocena:** **Wybitna i bezdyskusyjna.**
- **Analiza:**  
  W dotychczasowym modelu `SceneDocument` był efemeryczną reprezentacją „tego, co aktualnie widzi serwer”. Dokument nie mógł istnieć bez aktywnej sesji HTTP (`/v2/sessions/current`).
  Nowa zasada:
  ```text
  ProjectDefinition -> ModelDefinition -> StudyDefinition
                                  ↓ (explicit Compute)
                        immutable RunSpecification
                                  ↓
                Discretization & Execution
                                  ↓
                     SolutionSet -> Dataset -> Plot
  ```
  całkowicie rozdziela **modelowanie (authoring)** od **obliczeń (execution)** i **prezentacji wyników (results)**. Projekt można edytować, zapisać w `.fms` i otworzyć na maszynie bez GPU i bez solvera.

---

#### 1.2. Ontologia i Trzy Obszary Autorytatywne (Rozdział 5)
- **Ocena:** **Wzorcowa czystość podziału domenowego.**
- **Analiza:**  
  Wprowadzenie trzech rozłącznych obszarów zapobiega wyścigom danych i konfliktom:
  1. **Definicje (Authoring Definitions):** wersjonowane, podlegają pod transakcje UI i historię Undo/Redo. Postęp symulacji ich nie mutuje!
  2. **Wykonania (Execution Ledger):** dopisywany dziennik niemutowalnych przebiegów (`Run`), zadań (`Task`), prób (`Attempt`) oraz zdarzeń sterowania live (`SteeringEvent`).
  3. **Artefakty (Immutable Artifacts):** zrzuty binarne, siatki, macierze i pola zarządzane przez CAS (Content Addressed Storage), publikowane atomowo po sprawdzeniu sum kontrolnych.

---

#### 1.3. Rozdzielenie 4 Grafów zamiast „One Graph to Rule Them All” (Rozdział 13)
- **Ocena:** **Jedna z najważniejszych i najdojrzalszych decyzji w całej specyfikacji.**
- **Analiza:**  
  Częstym błędem w projektach CAE jest próba wepchnięcia całego systemu w jeden uniwersalny silnik grafowy (np. pojedynczy DAG w ReactFlow lub JSON-LD). Plan słusznie wyróżnia 4 odrębne struktury:
  1. **Graf zależności definicji:** ściśle acykliczny (DAG) — parametry, cechy geometrii, selekcje. Cykl w parametrach to błąd walidacji modelu.
  2. **Graf powiązań fizycznych (Physics Graph):** dopuszcza sprzężenia zwrotne i cykle (np. prąd płynie w ferromagnetyku -> wytwarza pole Oersteda -> obraca magnetyzację -> zmienia opór AMR -> zmienia rozpływ prądu). Wymaga metody relaksacyjnej lub solvera monolitycznego, a nie topologicznego sortowania zadań!
  3. **Graf planu badania (Study Plan):** acykliczny plan przepływu danych między analizami (np. Relaxation -> Linearization State -> Eigenmodes), z jawnymi operatorami pętli/kontynuacji (Hysteresis continuation, Parameter sweep).
  4. **Graf wytwarzania artefaktów (Build DAG):** deterministyczny graf oparty na fingerprintach wejść (Mesh, FunctionSpace, Linearized Operators).

---

#### 1.4. Geometria parametryczna i selekcje semantyczne (Rozdział 8)
- **Ocena:** **Bardzo dobra, z zastrzeżeniem dotyczącym jądra CAD.**
- **Mocne strony:**  
  Rozróżnienie trzech realizacji kształtu:
  - *Geometry realization:* model CAD/CSG (cechy, bryły, topologia),
  - *Display realization:* lekka triangulacja LOD dla viewportu Three.js,
  - *Simulation discretization:* właściwy grid FDM lub siatka konforemna FEM.
- **Uwaga krytyczna (Zalecenie):**  
  Plan słusznie przestrzega przed pisaniem własnego jądra CAD w pierwszym etapie. Warto jednak wyraźnie zdefiniować, że w fazie P1–P2 cechy geometryczne (`GeometryFeature`) powinny stanowić nadzbiór obecnych prymitywów z `fullmag-ir/src/model.rs` (Box, Cylinder, Waveguides, Translate, CSG Union/Difference/Intersection). Wprowadzenie zaawansowanego CAD (B-Rep, STEP, parasolid) powinno być odłożone do dedykowanego modułu zewnętrznego (np. OpenCASCADE/Truck).

---

#### 1.5. Kwalifikacja stanu równowagi a zakończenie zadania (Rozdział 11.2)
- **Ocena:** **Kluczowa dla rzetelności naukowej Fullmaga.**
- **Analiza:**  
  W wielu narzędziach badawczych stan `succeeded` oznacza jedynie, że pętla dobiła do `max_steps`. Plan wprowadza pojęcie `EquilibriumEvidence`:
  - Jeśli relaksacja osiągnie limit kroków, ale $\max |m \times H_{\mathrm{eff}}| > \tau_{\mathrm{tol}}$, zadanie ma status `succeeded` w sensie wykonawczym, lecz stan ma ocenę naukową `tolerance_not_met` / `unqualified`.
  - Kolejny krok (np. `Eigenmodes` lub `FrequencyResponse`) sprawdzający port wejściowy `LinearizationState` automatycznie zablokuje wykonanie z czytelnym komunikatem o braku kwalifikowanej równowagi!

---

#### 1.6. Eksperyment interaktywny (Live Steering) a edycja modelu (Rozdział 17)
- **Ocena:** **Prawidłowe rozwiązanie problemu `scratch_runtime.rs`.**
- **Analiza:**  
  Plan eliminuje fałszywą dychotomię: „albo modal blokujący UI, albo zabicie solvera”. Wprowadza dwa odrębne tory:
  - **Edycja definicji (Edit Model):** tworzy nową rewizję projektu (np. revision 42), która nie ma żadnego wpływu na aktualnie liczący się run bazujący na revision 41.
  - **Zdarzenie sterujące (SteeringEvent):** wysyłane do działającego solvera tylko przez jawne polecenie (np. zmiana pola zewnętrznego w locie). Solver aplikuje zmianę wyłącznie w bezpiecznym punkcie synchronizacji (`safe-point`), generując nowy segment trajektorii.

---

### 2. Szczegółowa ocena Kontraktów K01–K18 (`02-kontrakty.md`)

| Kontrakt | Zakres | Ocena | Uwagi techniczne i uściślenia |
|---|---|:---:|---|
| **K01** | Granice transakcji | 10/10 | Znakomity podział: jeden writer na projekt, atomowe zatwierdzanie komend, długie obliczenia jako asynchroniczne Runy. |
| **K02** | Minimalne tożsamości | 9.5/10 | Precyzyjne rozróżnienie `id` (byt), `revision` (wersja edycji), `fingerprint` (zależności). Wymaga dodania `project_id` do wszystkich Resource Keys w UI. |
| **K03** | Definicja projektu | 9/10 | Schemat logiczny `ProjectDefinition` i `ModelDefinition` jest kompletny. Należy zadbać, aby `sourceAssets` nie kopiowały gigabajtowych plików do JSON. |
| **K04** | Komenda edycji i Undo | 10/10 | Wykorzystuje wzorzec znany z Redux/CQRS: `client_intent_id`, `expected_revision`, transakcyjne wycofanie. Rozwiązuje problem niekontrolowanych mutacji. |
| **K05** | ParameterContext | 9.5/10 | Wartości rozstrzygane w SI z AST jednostek (np. `140[nm]`). Cykle w wyrażeniach blokują model przed Compute. |
| **K06** | Study i typowane porty | 10/10 | Zastępuje niebezpieczne `latest_state` jawnym wiązaniem: `PinnedArtifact` lub `StepOutput(step_id, output_port)`. |
| **K07** | RunSpecification | 9.5/10 | Niezmienna specyfikacja uruchomienia. Submit przypina snapshot i wejścia, uniezależniając wykonanie od przyszłych edycji projektu. |
| **K08** | Stany i przejścia | 10/10 | Usunięcie globalnego enumu `ready`. Osobne stany dla dokumentu, walidacji, artefaktu, tasku, obserwacji i oceny naukowej. |
| **K09** | Protokół workerów | 9/10 | Fencing epochs i monotonically increasing sequence numbers zabezpieczają przed publikacją z nieaktualnych workerów (np. po reconnect). |
| **K10** | Manifest i publikacja | 9.5/10 | Dwuetapowa publikacja (staging -> checksum verification -> atomic catalog commit) zapobiega odczytowi uszkodzonych fragmentów pól. |
| **K11** | Pole i FunctionSpace | 8.5/10 | **Wymaga uściślenia (patrz sekcja 3 poniżej).** Należy jednoznacznie określić reprezentację liczb zespolonych i układ stopni swobody FEM. |
| **K12** | Dataset, Derived, Plot | 10/10 | Czysty postprocessing: zmiana skali wykresu, wycięcie płaszczyzny czy rzut 2D to zapytanie do `DatasetDefinition`, a nie nowy solve. |
| **K13** | Steering i Checkpoint | 9.5/10 | Checkpoint wymaga pełnego stanu restartu (RNG, historia integratora, constraints). Zwykły zrzut `m` staje się jedynie warunkiem początkowym (`InitialConditionImport`). |
| **K14** | Format `.fms` vNext | 9.5/10 | Ewolucja istniejącego kontenera ZIP64 z manifestem projektu v2 i zachowaniem adaptera dla `manifest/session.json`. |
| **K15** | Zgodność UI/CLI/Python | 9/10 | Golden fixtures porównujące znormalizowane `ProblemIR` i provenance zamiast tekstu wygenerowanego skryptu. |
| **K16** | 4 przebiegi krytyczne | 10/10 | Dokładnie opisane scenariusze: A (Save bez solvera), B (Compute z edycją), C (Błąd siatki), D (Otwarcie wyników offline). |
| **K17** | Save i pending forms | 9/10 | Zabezpieczenie przed utratą wpisów w edytorze: Compute wymusza commit draftu lub zgłasza błąd w polu. |
| **K18** | Wyniki modalne | 9/10 | Wyjaśnienie interpretacji modów własnych (baza styczna do stanu równowagi vs gotowy wektor $m$). |

---

### 3. Zidentyfikowane luki specyfikacji i rekomendowane poprawki

W toku rygorystycznej analizy kontraktów zidentyfikowano 3 kwestie techniczne, które wymagają formalnego uściślenia w dokumentacji:

#### 1. Reprezentacja liczb zespolonych w `TensorDescriptor` (K11 i E08)
- **Problem:** Jak wykazano w audycie kodu (`fullmag-session/src/types.rs:408`), wyliczenie `TensorDtype` obsługuje wyłącznie typy rzeczywiste: `U8`, `I32`, `U32`, `F32`, `F64`. Tymczasem analizy `Eigenmodes`, `FrequencyResponse` oraz `Dispersion` produkują wielkości zespolone (amplituda i faza / część rzeczywista i urojona podatności magnetycznej $\chi(\omega)$).
- **Rekomendacja poprawki:**  
  Należy w `TensorDtype` dodać jawne warianty:
  ```rust
  pub enum TensorDtype {
      U8, I32, U32, F32, F64,
      C64,  // 2x f32 (Real, Imag)
      C128, // 2x f64 (Real, Imag)
  }
  ```
  lub sformalizować w `FieldDescriptor` regułę podziału osi logicznych (np. wymiar `component` zawiera warianty `[re, im]` lub `[mag, phase]`), z jednoznaczną konwencją czasową $e^{i\omega t}$ vs $e^{-i\omega t}$.

#### 2. Precyzja kontraktu `FunctionSpaceDescriptor` w FEM (K11)
- **Problem:** W metodzie FEM (MFEM) pole magnetyzacji może należeć do przestrzeni $L^2$ (kawałkami stałe na elementach), potencjał magnetyczny do $H^1$ (ciągły na węzłach), pole magnetyczne $B$ do $H(\mathrm{div})$, a wektorowy potencjał magnetyczny $A$ do $H(\mathrm{curl})$.
- **Rekomendacja poprawki:**  
  Kontrakt K11 powinien explicite zdefiniować strukturę `FunctionSpaceDescriptor`:
  ```rust
  pub struct FunctionSpaceDescriptor {
      pub family: String,      // "H1", "L2", "Nedelec", "Raviart-Thomas"
      pub order: u32,          // p = 1, 2, ...
      pub dof_layout: String,  // "nodal", "element_centric", "face_centric"
      pub dof_count: usize,
      pub boundary_dofs: Vec<usize>,
  }
  ```
  Zapobiegnie to próbom bezpośredniego rzutowania buforów o tej samej liczbie bajtów między różnymi przestrzeniami funkcyjnymi.

#### 3. Wąskie gardło I/O przy zapisie ciągłym do CAS (K10 i K14)
- **Problem:** CAS (Content Addressed Storage) wymaga liczenia skrótu SHA-256 dla każdego zapisanego chunka. Podczas gęstego zapisu trajektorii dynamicznej (np. 10 000 kroków czasowych dla siatki 1M komórek = 240 GB danych) hashowanie w locie i tworzenie dziesiątek tysięcy małych plików CAS w archiwum ZIP może drastycznie spowolnić solver.
- **Rekomendacja poprawki:**  
  Zaleca się architekturę hybrydową persystencji:
  - **CAS:** dla definicji modeli, konfiguracji, siatek (Mesh/Grid), operatorów i pojedynczych snapshotów (Equilibrium, Eigenmodes).
  - **Chunked Binary / Zarr Stream:** dla gęstych trajektorii czasowych i autosave (wykorzystując istniejący moduł `fullmag-runner/src/autosave_zarr.rs`), gdzie manifest runu wskazuje ciągły zbiór chunków bez konieczności hashowania każdego z osobna podczas każdego kroku solvera.

---

### 4. Podsumowanie oceny architektury

Zaproponowana architektura CAE i kontrakty K01–K18 stanowią **najwyższej klasy projekt inżynierski**. Eliminują one wszystkie patologie obecnego stanu (brak stabilnego korzenia projektu, gubienie WebGL, zabijanie solvera przy edycji, brak typowania studies). 

Po wdrożeniu powyższych 3 uściśleń technicznych, architektura ta stworzy solidny, niezawodny szkielet dla profesjonalnego środowiska modelowania i symulacji mikromagnetycznych.
