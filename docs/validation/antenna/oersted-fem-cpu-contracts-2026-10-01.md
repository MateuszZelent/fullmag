# Antena — kontrakty pola Oersteda FEM CPU, 2026-10-01

Zakres dowodu: istniejący konserwatywny widok prądu RT0 oraz operatorzy
OE-F1 (bezpośrednia kwadratura tetraedrów) i OE-F2 (potencjał wektorowy).
Nie jest to kwalifikacja całego `AntennaFieldSolve`: T05, publikacja bazy
na amper, rzeczywisty CPW/taper i przepływ do LLG pozostają otwarte.

## Wykonanie

- Worktree: `D:\git\fullmag\worktrees\microwave-antenna-latest-20260909`;
  HEAD: `b0cb54f5fe9ab6149a7494d607e1d25102a96427`. Checkout miał
  niezwiązane z natywnymi testami, niezapisane zmiany Rust/API/ADR.
- Polecenie: `just verify-fem-oersted-oef2-cpu-contract`, z
  `FULLMAG_PROJECT_STORAGE_ROOT=D:\git\fullmag\storage` i bez odziedziczonego
  `CARGO_TARGET_DIR`. Recepta użyła `fem-cpu`, MFEM 4.7, hypre 2.32.0,
  urządzenia CPU, CUDA OFF. Build znajdował się pod podmontowanym
  `/workspace/.fullmag-build/fem-cpu-only/oersted-oef2` w magazynie D:.
- Audyt konfiguracji i linkowanych bibliotek: PASS. CTest RT0:
  `fem_conservative_current_view_contract`, `mpi_n1`, `mpi_n2` i
  `mpi_byte_identity` — 4/4 PASS.
- `fem_oersted_direct_tetra_contract`: PASS. Błędy zagęszczania siatki
  wydrukowane przez test: coarse `0.000699174`, medium `0.000337272`,
  fine `0.000145936`. Test obejmuje też znak, budżet par,
  punkty osobliwe, projekcję H1 i limit wspólny FEM/FDM.
- `fem_oersted_vector_potential_contract`: PASS. Wydrukowano
  `max boundary |p|=0` oraz `W_J=9.3886677054942546e-08`.
- Końcowy `result.json` dla scenariusza `oersted-oef2` ma
  `schema=fullmag.fem.cpu_only_contract_result.v1`,
  `scope=managed_cpu_lane_prerequisite`, `status=pass`.

Dowód trwały na hoście:
`D:\git\fullmag\storage\runtimes\microwave-antenna-latest-2026090-78aaec16ccf52671\reports\fem-cpu-only\oersted-oef2\result.json`
oraz sąsiednie `test.log`, `build.log` i audyty konfiguracji.

## Granica wniosku

Zaliczenie oznacza, że wskazane kontrakty natywnych operatorów FEM CPU
wykonały się w zarządzanym kontenerze. Nie sprawdza ono zadanych
podpisanych prądów terminalowych, podziału na asymetryczne returns,
trzech rzeczywistych siatek taperu ani poprawności przestrzennego pola
konkretnej anteny. Nie jest dowodem GPU parity ani widma fal spinowych.

Źródła testów: `backends/fem/tests/conservative_current_view_contract.cpp`
(`main`), `backends/fem/tests/oersted_direct_tetra_contract.cpp`
(`direct_tetra_h_refinement_contract`) i
`backends/fem/tests/oersted_vector_potential_contract.cpp`
(`vector_potential_exact_sequence_contract`).
