# Zestawienie Plików Solvera w Domenie Częstotliwości (Frequency Domain Solver)

Dokument zawiera spis i krótką charakterystykę wszystkich istotnych plików w architekturze platformy Fullmag powiązanych z obliczeniami w domenie częstotliwości: wyznaczaniem modów własnych (*eigenmodes*) oraz wymuszoną odpowiedzią harmoniczną (*driven response*).

---

## 1. Natywny Backend C++ (`backends/fem/`)
Pliki te implementują niskopoziomowe operacje numeryczne, montaż macierzy rzadkich oraz integrację z solwerami algebraicznymi.

* **[frequency_domain_contract.cpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/src/frequency_domain/frequency_domain_contract.cpp)** / **[frequency_domain_contract.hpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/include/frequency_domain/frequency_domain_contract.hpp)**
  Definiuje FFI (Foreign Function Interface), struktury danych wejściowych/wyjściowych oraz zapewnia walidację parametrów fizycznych przesyłanych do natywnego solvera.
* **[modal_eigen_solver.cpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/src/frequency_domain/modal_eigen_solver.cpp)** / **[modal_eigen_solver.hpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/include/frequency_domain/modal_eigen_solver.hpp)**
  Główna implementacja solvera problemu własnego na poziomie C++. Koordynuje budowę operatorów i wywołanie algorytmów numerycznych.
* **[modal_eigen_request.hpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/include/frequency_domain/modal_eigen_request.hpp)**
  Struktura parametrów żądania (liczba modów, wektory falowe $k$, parametry fizyczne, typy solverów) przesyłanych z poziomu kontrolera Rust.
* **[modal_eigen_result.hpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/include/frequency_domain/modal_eigen_result.hpp)**
  Definicja struktur przechowujących zwrócone wartości własne (częstości, tłumienie) oraz wektory własne (profile modów) dla poszczególnych stanów.
* **[slepc_modal_eigen.cpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp)** / **[slepc_modal_eigen.hpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/frequency_domain/slepc_modal_eigen.hpp)**
  Integracja z biblioteką SLEPc (Scalable Library for Eigenvalue Problem Computations) na CPU do efektywnego, rzadkiego (sparse) rozwiązywania dużych problemów własnych.
* **[production_cpu_modal_eigen.cpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp)**
  Produkcyjny punkt wejścia do obliczeń modów własnych na procesorze (CPU).
* **[eigen_dense.cpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/mfem/runtime/eigen_dense.cpp)** / **[eigen_dense.hpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/cpu/mfem/runtime/eigen_dense.hpp)**
  Pomocnicze rutyny do gęstego (dense) rozwiązywania problemów własnych za pomocą standardowych bibliotek (np. LAPACK/MFEM) dla mniejszych siatek lub podproblemów.
* **[frequency_domain_contract.cpp (testy)](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/tests/frequency_domain/frequency_domain_contract.cpp)**
  Testy poprawności przesyłu struktur danych FFI dla domeny częstotliwości.
* **[modal_eigen_contract_test.cpp](file:///home/kkingstoun/git/fullmag/fullmag/backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp)**
  Niskopoziomowe testy jednostkowe weryfikujące działanie solvera modalnego.

---

## 2. Kontroler i Orkiestrator w Rust (`crates/fullmag-runner/`)
Moduł pośredniczący między warstwą planowania a natywnym kodem C++/GPU.

* **[fem_eigen.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem_eigen.rs)**
  Kluczowy, monolityczny orkiestrator modów własnych w Rust. Składa operatory masowe (Mass) i sztywności (Stiffness) na CPU/GPU oraz koordynuje cały proces obliczeniowy.
* **[frequency_response.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/frequency_response.rs)**
  Główny plik orkiestrujący solver wymuszonej odpowiedzi harmonicznej (driven response) w Rust, obsługujący pętlę przemiatania częstotliwości (frequency sweep).
* **[assembly_scalar.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/eigen/assembly_scalar.rs)**
  Uproszczona implementacja skalarna operatora z uwzględnieniem przesunięć fazowych Blocha (dla propagacji fal w sieciach periodycznych).
* **[response_block_real.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/eigen/response_block_real.rs)**
  Sprowadza zespolony układ równań $A x = b$ dla wymuszenia harmonicznego do postaci rzeczywistej typu blokowego 2x2.
* **[tracking.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/eigen/tracking.rs)**
  Implementacja śledzenia gałęzi dyspersyjnych (branch tracking) w przestrzeni $k$, pozwalająca na jednoznaczne identyfikowanie modów przy zmianie wektora falowego.
* **[eigen_solve.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem/eigen_solve.rs)**
  Zarządza uruchomieniem algorytmów numerycznych (LOBPCG, Krylov-Schur) na odpowiednim urządzeniu (CPU/GPU).
* **[eigen_operator.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem/eigen_operator.rs)**
  Montuje macierze Mass i Stiffness na poziomie Rust dla solvera modów własnych.
* **[eigen_reduction.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem/eigen_reduction.rs)**
  Implementuje redukcję stopni swobody (DOF) siatki FEM na podstawie narzuconych warunków brzegowych (np. Dirichlet, periodic).
* **[eigen_equilibrium.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem/eigen_equilibrium.rs)**
  Odpowiada za weryfikację i normalizację stanu równowagi magnetycznej (equilibrium), wokół którego przeprowadzana jest linearyzacja LLG.
* **[eigen_anisotropy.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem/eigen_anisotropy.rs)**
  Oblicza i dodaje wkład od anizotropii magnetycznej (uniaxial, cubic) do macierzy Stiffness.
* **[eigen_path.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem/eigen_path.rs)**
  Zarządza przechodzeniem po ścieżce wektorów falowych $k$ (k-path) na potrzeby wyznaczania krzywych dyspersyjnych.
* **[eigen_output.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/fem/eigen_output.rs)**
  Odpowiada za zapis i strukturyzację danych wyjściowych (np. spektrogramów i profili modów).
* **[eigen.rs (native_fem)](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/native_fem/eigen.rs)**
  Rustowy pomost FFI do wywoływania metod eigensolvera w natywnej bibliotece C++.
* **[frequency_domain.rs (native_fem)](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/src/native_fem/frequency_domain.rs)**
  Rustowy pomost FFI do wywoływania metod driven response w natywnej bibliotece C++.
* **[fem_eigen.rs (testy)](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/tests/physics_validation/fem_eigen.rs)**
  Fizyczne testy walidacyjne dla modal eigen (m.in. weryfikacja z analitycznym wzorem Kittela, testy ortogonalności modów).
* **[frequency_domain.rs (testy)](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-runner/tests/physics_validation/frequency_domain.rs)**
  Walidacja poprawności fizycznej i kontraktowej wyników dla driven response.

---

## 3. Reprezentacja Semantyczna IR i API (`crates/fullmag-ir/`, `crates/fullmag-api/`)

* **[eigen_contract.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-ir/src/eigen_contract.rs)**
  Definicja kontraktu danych (struktur JSON/Zarr) dla wyników widma własnego i profili modów.
* **[frequency_response_contract.rs](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-ir/src/frequency_response_contract.rs)**
  Definicje typów kontraktowych i formatu zapisu danych dla wymuszonej odpowiedzi harmonicznej.
* **[eigen.rs (api)](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs)**
  Handlery API v2 udostępniające dane widma własnego oraz modów do interfejsu użytkownika.
* **[frequency_domain.rs (api)](file:///home/kkingstoun/git/fullmag/fullmag/crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs)**
  Handlery API v2 do pobierania wyników wymuszonej odpowiedzi harmonicznej.

---

## 4. Python API (`packages/fullmag-py/`)

* **[eigen.py](file:///home/kkingstoun/git/fullmag/fullmag/packages/fullmag-py/src/fullmag/model/eigen.py)**
  Klasa wystawiająca interfejs Python DSL dla etapu obliczeniowego `Eigenmodes`.
* **[spectrum.py](file:///home/kkingstoun/git/fullmag/fullmag/packages/fullmag-py/src/fullmag/analysis/spectrum.py)**
  Narzędzia analityczne w Pythonie do przetwarzania, wizualizacji i wyodrębniania pików z widma częstotliwościowego.

---

## 5. Panel Kontrolny UI (`apps/control-room/`)

* **[frequencyDomainChartModels.ts](file:///home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts)**
  Modele danych definiujące serie danych na wykresach widma i krzywych dyspersyjnych.
* **[frequencyDomainInspectorModel.ts](file:///home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/inspector/panels/frequencyDomainInspectorModel.ts)**
  Model stanu panelu szczegółów (inspector) dedykowanego analizom w domenie częstotliwości.
* **[frequencyDomainNodeDetails.ts](file:///home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/inspector/panels/frequencyDomainNodeDetails.ts)**
  Komponenty UI prezentujące parametry wyjściowe danej częstotliwości lub modu.
* **[frequencyDomainSeriesAdapter.ts](file:///home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/analysis-plots/frequencyDomainSeriesAdapter.ts)**
  Adaptery mapujące surowe dane z backendu API na format akceptowany przez bibliotekę wykresów.
* **[eigenmodesStageNode.ts](file:///home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/explorer/builders/study/eigenmodesStageNode.ts)**
  Logika budowania reprezentacji wizualnej kroku "Eigenmodes" w drzewie nawigacyjnym (Explorer).
* **[frequencyResponseStageNode.ts](file:///home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/explorer/builders/study/frequencyResponseStageNode.ts)**
  Logika budowania reprezentacji kroku "FrequencyResponse" w drzewie nawigacyjnym.
* **[frequencyDomainExplorerNodes.ts](file:///home/kkingstoun/git/fullmag/fullmag/apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts)**
  Ogólny budowniczy węzłów drzewa eksploratora dla analiz w domenie częstotliwości.

---

## 6. Dokumentacja i Specyfikacje (`docs/`)

* **[frequency_domain_solver_physics.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/frequency_domain_solver_physics.md)**
  Dokumentacja matematyczno-fizyczna zlinearyzowanego równania LLG, tensorów podatności magnetycznej $\chi$ oraz mocy absorbowanej.
* **[0600-fem-eigenmodes.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/0600-fem-eigenmodes.md)**
  Opis fizyczny sformułowania problemu własnego w micromagetyzmie przy użyciu metody elementów skończonych (FEM).
* **[0700-frequency-domain-linearized-llg.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/0700-frequency-domain-linearized-llg.md)**
  Wyprowadzenie formalne i fizyczna interpretacja zlinearyzowanego LLG.
* **[0600-fem-eigenmodes-linearized-llg.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/0600-fem-eigenmodes-linearized-llg.md)**
  Przejście od równań ciągłych zlinearyzowanego LLG do postaci macierzowej rozwiązywanej przez FEM.
* **[0710-periodic-and-floquet-boundary-conditions.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/0710-periodic-and-floquet-boundary-conditions.md)**
  Teoria i sformułowanie periodycznych warunków brzegowych typu Blocha/Floqueta dla fal spinowych (magnonów).
* **[0828-fem-frequency-domain-floquet-demag.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/0828-fem-frequency-domain-floquet-demag.md)**
  Notatka fizyczna dedykowana obliczeniom pola demagnetyzacji przy periodyczności typu Floqueta.
* **[fullmag_fem_eigenproblem_plan.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/physics/fullmag_fem_eigenproblem_plan.md)**
  Historyczny plan integracji i implementacji problemu własnego w architekturze FEM.
* **[frequency-domain-artifacts-v2.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/specs/frequency-domain-artifacts-v2.md)**
  Specyfikacja formatu zapisu danych wynikowych dla driven response (v2).
* **[eigenmode-artifacts-v1.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/specs/eigenmode-artifacts-v1.md)**
  Specyfikacja zapisu danych wyjściowych dla modów własnych (widmo, wektory własne).
* **[frequency_domain_solver_engineering.md](file:///home/kkingstoun/git/fullmag/fullmag/docs/engineering/frequency_domain_solver_engineering.md)**
  Dokumentacja inżynieryjna: omówienie wyboru algorytmów (np. LOBPCG vs Krylov-Schur), rzadkich struktur danych oraz optymalizacji pamięciowej.
