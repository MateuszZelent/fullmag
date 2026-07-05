# Audyt Fizyczny i Numeryczny Solvera Częstotliwościowego (Frequency Domain Solver)

> **Data audytu**: 2026-07-04  
> **Status**: Kompletny audyt poprawności fizycznej i numerycznej metod solvera w domenie częstotliwości (modalnych *eigenmodes* oraz *driven response*) dla wszystkich plików w zestawieniu.

---

## 1. Natywny Backend C++ (`backends/fem/`)

### 1.1 `frequency_domain_contract.cpp` / `frequency_domain_contract.hpp`
* **Audyt Fizyczny**: Plik definiuje i waliduje parametry przesyłane przez granicę FFI. Poprawnie weryfikuje kombinacje fizyczne (np. odrzucenie dynamicznego pola demagnetyzacji w ujęciu Floqueta/Blocha, co zapobiega powstawaniu błędów fizycznych przy braku implementacji tego członu na GPU).
* **Audyt Numeryczny**: Stabilny, oparty o diagnostyczne stałe JSON reprezentujące możliwości (capabilities) backendu. Bezpieczne parsowanie stringów i walidacja wektorów falowych Floqueta ($k \approx 0$ jako próg tolerancji $10^{-12}$).

### 1.2 `modal_eigen_solver.cpp` / `modal_eigen_solver.hpp`
* **Audyt Fizyczny**: W trybie *tiny validation* implementuje analityczne rozwiązanie uogólnionego problemu własnego dla dwóch tangent DOFs:
  $$\det(K - \lambda G) = 0 \implies \det(G) \lambda^2 + c_{\text{linear}} \lambda + \det(K) = 0$$
  Wyznaczenie wartości własnych $\lambda$ (gdzie $\omega = \text{Im}(\lambda)$) oraz ich konwersja na Hz: $f_n = \omega / 2\pi$ jest w 100% poprawne fizycznie.
* **Audyt Numeryczny**: Wyznaczenie wektora własnego przy użyciu dopełnień algebraicznych (algebraic cofactors) dla układu $2 \times 2$ jest stabilne, pod warunkiem, że norma wektora własnego jest niezerowa (co jest poprawnie sprawdzane progiem $10^{-15}$). W przypadku braku SLEPc wywołuje `production_cpu_modal_eigen_unavailable`, co zapobiega cichemu uruchomieniu niekompletnego solvera.

### 1.3 `modal_eigen_request.hpp` / `modal_eigen_result.hpp`
* **Audyt Fizyczny i Numeryczny**: Bezpieczne struktury danych FFI (POD - Plain Old Data), zapobiegające problemom z layoutem pamięci na granicy Rust/C++. Posiadają wbudowane mechanizmy śledzenia wersji ABI (`kFrequencyDomainAbiVersion`), co eliminuje błędy niezgodności wersji bibliotek.

### 1.4 `slepc_modal_eigen.cpp` / `slepc_modal_eigen.hpp`
* **Audyt Fizyczny**: Rozwiązuje uogólniony problem własny w bazie stycznej o strukturze żyrotropowej:
  $$K \mathbf{u} = \lambda G \mathbf{u}$$
  Częstość kołowa precesji $\omega = \text{Im}(\lambda)$ jest poprawnie konwertowana na Hz ($f = \omega/2\pi$). Filtrowanie ujemnych częstości ($\text{Im}(\lambda) \le 0$) jest zgodne z fizyczną konwencją precesji w prawą stronę (right-handed precession).
* **Audyt Numeryczny**:
  - Użycie solvera Krylova-Schura (`EPSKRYLOVSCHUR`) gwarantuje optymalną zbieżność dla rzadkich uogólnionych problemów niesymetrycznych (GNHEP).
  - Wykorzystanie transformacji widmowej Shift-and-Invert (`STSINVERT`) z faktoryzacją bezpośrednią LU (`PCLU` i solver `KSPPREONLY`) zapewnia doskonałą stabilność numeryczną wokół zadanego przesunięcia (shift frequency). Zapobiega to "gubieniu" modów wewnętrznych.
  - Zastosowanie precyzyjnych kryteriów zbieżności i kontroli błędów za pomocą `EPSComputeError` chroni przed fałszywymi modami numerycznymi.

### 1.5 `production_cpu_modal_eigen.cpp`
* **Audyt Fizyczny i Numeryczny**: Punkt wejścia dla solvera produkcyjnego. Zapewnia delegację do SLEPc lub zwraca błąd o braku konfiguracji.

### 1.6 `eigen_dense.cpp` / `eigen_dense.hpp`
* **Audyt Fizyczny i Numeryczny**: Zapewnia lokalne gęste rozwiązywanie mniejszych problemów własnych (np. dla makrospinów). Poprawne wykorzystanie interfejsów numerycznych LAPACK.

---

## 2. Kontroler i Orkiestrator w Rust (`crates/fullmag-runner/`)

### 2.1 `fem_eigen.rs`
* **Audyt Fizyczny**: 
  - Przeliczenie operatora sztywności ze skali pola ($A/m$) na skalę częstości kołowej ($rad/s$):
    `stiffness_omega = stiffness_field * gyromagnetic_ratio`
    jest poprawne, ponieważ $\gamma_0 = \mu_0 \gamma$ ma wymiar $m/(A \cdot s)$, co w iloczynie z $H$ w $A/m$ daje wymiar częstości $1/s$.
  - Transformacje modów z bazy stycznej do bazy kartezjańskiej (funkcje `project_mode_to_tangent_basis`) poprawnie uwzględniają ortonormalną strukturę bazy lokalnej.
* **Audyt Numeryczny**: 
  - Zabezpieczenie przed ujemnymi wartościami własnymi przy mapowaniu częstotliwości (`eigenvalue.max(0.0)`) zapobiega powstawaniu zespolonych częstości Hz (wartości typu NaN) w trybie bez tłumienia.
  - Plik jest jednak bardzo duży (6837 linii), co utrudnia weryfikację i stwarza ryzyko ukrytych błędów przy modyfikacjach.

### 2.2 `frequency_response.rs`
* **Audyt Fizyczny i Numeryczny**: 
  - W trybie produkcyjnym poprawnie buduje payload i przekazuje dane do natywnego backendu.
  - **Krytyczne Ograniczenie (Placeholder)**: W trybie fallbacku walidacyjnego (`execute_fem_frequency_response_validation`) plik generuje trywialny układ diagonalny:
    `stiffness = DMatrix::identity(dim, dim) * stiffness_scale`
    `mass = DMatrix::identity(dim, dim)`
    Oznacza to całkowity brak fizycznych sprzężeń (wymiany, demag) i reprezentuje jedynie zbiór niezależnych oscylatorów. Działa to poprawnie jako test integracyjny przepływu danych (smoke test), ale **nie generuje fizycznych wyników** i musi być jawnie raportowane jako fallback.

### 2.3 `assembly_scalar.rs`
* **Audyt Fizyczny**: 
  - Implementacja periodyczności Blocha z wektorem falowym $k$:
    `diag_shift = k^2 * shift_scale`
    Poprawnie przybliża przesunięcie Laplacianu wymiany ($-\nabla^2 \to -\nabla^2 + k^2$) na poziomie dyskretnym przez dodanie wyrazu diagonalnego do stiffness.
* **Audyt Numeryczny**:
  - Funkcja `solve_dense_reference_modes` wyznacza wartości własne dla $M^{-1} K$ za pomocą `nalgebra::SymmetricEigen::new(effective)`.
  - **Uwaga numeryczna**: `SymmetricEigen` zakłada, że macierz wejściowa jest symetryczna. Iloczyn $M^{-1} K$ na ogół *nie jest* symetryczny, mimo że ma rzeczywiste wartości własne. Zastosowanie solvera dla macierzy symetrycznych na niesymetrycznej macierzy $M^{-1} K$ może prowadzić do niedokładności numerycznych lub błędów dla bardziej złożonych układów. Bezpieczniejszym podejściem byłoby sprowadzenie uogólnionego problemu własnego do symetrycznego standardowego przy użyciu rozkładu Cholesky'ego macierzy $M$.

### 2.4 `response_block_real.rs`
* **Audyt Fizyczny**: 
  - Przeliczenie zespolonego układu harmonicznego $(K - \omega^2 M + i\omega C) \mathbf{u} = \mathbf{f}$ na blokowy rzeczywisty układ $2N \times 2N$:
    $$
    \begin{pmatrix}
    K - \omega^2 M & -\omega C \\
    \omega C & K - \omega^2 M
    \end{pmatrix}
    \begin{pmatrix}
    \mathbf{u}_{\text{re}} \\
    \mathbf{u}_{\text{im}}
    \end{pmatrix}
    =
    \begin{pmatrix}
    \mathbf{f}_{\text{re}} \\
    \mathbf{f}_{\text{im}}
    \end{pmatrix}
    $$
    jest matematycznie i fizycznie ścisłe.
  - Wyliczenie absorpcji mocy: $P = -\frac{1}{2} \omega \text{Im}(\mathbf{f}^\dagger \mathbf{u})$ (w kodzie: `-0.5 * omega * field_work.im`) oraz zespolonej podatności magnetycznej $\chi$ jest w pełni zgodne z teorią magnetyczną.
* **Audyt Numeryczny**: Wykorzystanie faktoryzacji LU (`block.lu().solve()`) zapewnia wysoką dokładność i stabilność numeryczną dla układów gęstych (dense fallback).

### 2.5 `tracking.rs`
* **Audyt Fizyczny**: Śledzenie gałęzi (branch tracking) bazuje na nakładaniu się zespolonych modów (complex overlap) oraz ich częstotliwościach. Zapobiega to fizycznie błędnemu przypisaniu modów na krzywych dyspersyjnych przy przejściu między kolejnymi punktami wektora wavevector $k$.
* **Audyt Numeryczny**: Stabilny algorytm zachłannego dopasowania (greedy matching) z progiem odcięcia tolerancji.

### 2.6 `eigen_solve.rs` / `eigen_operator.rs` / `eigen_reduction.rs`
* **Audyt Fizyczny**:
  - `eigen_operator.rs` (funkcja `assemble_projected_scalar_operator_real`): Montaż macierzy masowej $M_{ij}$ oparty na spójnej macierzy masowej (consistent mass matrix) dla tetraedrów P1:
    $$M_{\text{local}} = \frac{V}{20} \begin{pmatrix} 2 & 1 & 1 & 1 \\ 1 & 2 & 1 & 1 \\ 1 & 1 & 2 & 1 \\ 1 & 1 & 1 & 2 \end{pmatrix}$$
    jest w 100% poprawny fizycznie.
  - Montaż wkładów od Zeeman/demag jako lokalne przesunięcie potencjału: `local_mass * shift` jest poprawny.
  - **Uproszczenie numeryczno-fizyczne w `Full2x2`**: Krzyżowe sprzężenie (cross-coupling) tangent-plane w `assemble_full_2x2_operator_real` jest przybliżane za pomocą:
    `h_e1 * h_e2 / h_parallel`
    Jest to uproszczony Hessian pola efektywnego. Dla silnie niejednorodnych stanów (wirów magnetycznych) pomija to dokładny wkład sprzężeń pochodzących bezpośrednio z rzutowania pełnego tensora demagnetyzacji na płaszczyznę styczną, co stanowi świadome uproszczenie numeryczne wersji MVP.
  - Montaż DMI brzegowego i objętościowego (`add_dmi_real`) oraz anizotropii powierzchniowej (`add_surface_anisotropy_real`) poprawnie rzutuje formy słabe na elementy brzegowe siatki magnetycznej.
  - Zespolony montaż Blocha/Floqueta poprawnie uwzględnia sprzężenie fazowe $e^{-i \mathbf{k} \cdot \mathbf{r}_i} e^{i \mathbf{k} \cdot \mathbf{r}_j}$ na poziomie montażu macierzy zespolonych.
* **Audyt Numeryczny**: Redukcja stopni swobody w `eigen_reduction.rs` poprawnie usuwa nieaktywne węzły (np. niemagnetyczny airbox) oraz węzły brzegowe o narzuconych sztywnych warunkach brzegowych, co zmniejsza wymiar układu algebraicznego i zapobiega powstawaniu zerowych wartości własnych (singularities).

### 2.7 `eigen_equilibrium.rs` / `eigen_anisotropy.rs` / `eigen_path.rs` / `eigen_output.rs`
* **Audyt Fizyczny**: 
  - `eigen_equilibrium.rs` sprawdza warunek stacjonarności $\mathbf{m}_0 \times \mathbf{H}_{\text{eff}} \approx 0$ oraz czy namagnesowanie jest znormalizowane ($|\mathbf{m}_0| = 1$), co chroni przed wykonywaniem nieliniowych analiz na niestabilnych konfiguracjach początkowych.
  - `eigen_anisotropy.rs` poprawnie wyznacza wkład od anizotropii jednoosiowej (uniaxial) i sześciennej (cubic).
* **Audyt Numeryczny**: Poprawna interpolacja wektorów $k$ wzdłuż zadanej ścieżki i stabilny eksport wyników do formatów JSON/Zarr.

---

## 3. Reprezentacja Semantyczna IR i API (`crates/fullmag-ir/`, `crates/fullmag-api/`)

### 3.1 `eigen_contract.rs` / `frequency_response_contract.rs`
* **Audyt Fizyczny i Numeryczny**: Poprawne definicje typów i jednostek w metadanych wyjściowych (Hz, rad/s, W/m³ dla absorpcji). Zapewniają spójną reprezentację fizyczną wyników przesyłanych do kontrolera API oraz interfejsu graficznego.

### 3.2 `router_v2/handlers/analysis/eigen.rs` / `frequency_domain.rs`
* **Audyt Fizyczny i Numeryczny**: Warstwa transportowa API. Bezpieczna konwersja danych binarnych z formatów Zarr na JSON oraz obsługa zapytań o widma i mody. Brak bezpośrednich operacji fizycznych (separacja warstw).

---

## 4. Python API (`packages/fullmag-py/`)

### 4.1 `eigen.py` / `study.py` / `outputs.py` / `problem.py`
* **Audyt Fizyczny**: Udostępnia klasy `Eigenmodes` oraz `FrequencyResponse` w Python DSL. Zapewnia spójność jednostek SI na wejściu (użytkownik podaje parametry w Hz, $A/m$, $J/m^3$, rad).
* **Audyt Numeryczny**: Poprawne lowering (obniżenie) obiektów Pythona do struktur `ProblemIR` w Rust. Walidacja typów i wymiarów wejściowych zapobiega uruchomieniu solvera z niepoprawnymi fizycznie parametrami.

### 4.2 `spectrum.py`
* **Audyt Fizyczny**: Algorytmy wyszukiwania pików (peak finding) w widmach absorpcyjnych bazują na analizie pochodnych i dopasowaniu profili Lorentza (Lorentzian line shapes), co odpowiada rzeczywistej fizyce poszerzenia linii rezonansowych wywołanego tłumieniem Gilberta.

---

## 5. Panel Kontrolny UI (`apps/control-room/`)

### 5.1 Pliki analiz i adaptacji serii wykresów (`frequencyDomainChartModels.ts`, `frequencyDomainSeriesAdapter.ts`, `frequencyUnits.ts`)
* **Audyt Fizyczny**: Zapewniają poprawne etykietowanie i konwersję jednostek na osiach wykresów (częstotliwość w Hz/GHz, absorbed power density w $W/m^3$, podatność magnetyczna $\chi$ jako bezwymiarowa wielkość zespolona). Zapobiega to błędom interpretacyjnym użytkownika.
* **Audyt Numeryczny**: Wydajna wizualizacja dużych serii danych (spektrogramy, dyspersje) z zabezpieczeniem przed wartościami typu NaN/Inf na wykresach.

### 5.2 Panele inspekcji (`frequencyDomainInspectorModel.ts`, `frequencyDomainNodeDetails.ts`, `eigenmodesStageNode.ts`, `frequencyResponseStageNode.ts`)
* **Audyt Fizyczny i Numeryczny**: Prezentacja metadanych takich jak wektory wavevector $k$, wartości własne $\lambda$ (część rzeczywista i urojona) oraz residua. Zapewnia spójność prezentacji bez cichej modyfikacji danych fizycznych.

---

## 6. Dokumentacja i Specyfikacje (`docs/`)

* **[frequency_domain_solver_physics.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/frequency_domain_solver_physics.md)**
  Teoria fizyczna (linearne LLG, Block-Real, Power Absorption) jest w pełni zgodna z implementacją w `response_block_real.rs`. Dokładnie opisuje uproszczenia (rejection Floquet + demag).
* **[0600-fem-eigenmodes.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/0600-fem-eigenmodes.md)** / **[0600-fem-eigenmodes-linearized-llg.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/0600-fem-eigenmodes-linearized-llg.md)**
  Opisują sformułowanie słabe FEM dla problemu własnego. Zgodne z implementacją montażu macierzy w `eigen_operator.rs`.
* **[0710-periodic-and-floquet-boundary-conditions.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/0710-periodic-and-floquet-boundary-conditions.md)**
  Wyjaśnia matematycznie periodyczność Blocha, co jest podstawą dla implementacji shiftów DMI i anizotropii brzegowej z czynnikami fazowymi.
* **[frequency_domain_solver_engineering.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/engineering/frequency_domain_solver_engineering.md)**
  Zgodne z implementacją SLEPc i orkiestracją k-path w Rust.

---

## Podsumowanie i Wnioski Krytyczne Audytu

1. **Spójność fizyczna**: Parametr $\gamma_0 = \mu_0 \gamma$ jest poprawnie stosowany we wszystkich warstwach kodu C++ i Rust. Wszystkie wielkości fizyczne ( absorbed power, susceptibility, eigenfrequencies) używają czystych jednostek układu SI.
2. **Uproszczenia numeryczne (do monitorowania)**:
   - *Diagonalny solver reference w Rust (`assembly_scalar.rs`)*: Zastosowanie standardowego solvera symetrycznego `SymmetricEigen` na niesymetrycznej macierzy $M^{-1} K$ jest uproszczeniem, które przy silnie niesymetrycznych układach może prowadzić do niestabilności.
   - *Cross-coupling w `Full2x2`*: Zastosowanie przybliżenia geometrycznego `h_e1 * h_e2 / h_parallel` zamiast pełnego rzutu tensora demagnetyzacji ogranicza dokładność dla niejednorodnych stanów namagnesowania.
   - *Driven response validation fallback*: Macierze $K, M, C$ w fallbacku walidacyjnym są tożsamościowe (diagonalne), przez co fallback ten służy jedynie jako smoke test przepływu danych i nie ma wartości fizycznej.
