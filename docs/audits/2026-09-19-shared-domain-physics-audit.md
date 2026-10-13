# Audyt fizyczny i numeryczny shared-domain nonzero-k — 2026-09-19

## Zakres i źródło

Audyt obejmuje ścieżkę FEM `Full2x2` z dynamicznym demagiem
`floquet_airbox`, używaną przez benchmark COMSOL nonzero-k. Sprawdzono źródła
Rust runnera, natywnego operatora MFEM/PETSc/SLEPc, kontrakt Floqueta i
istniejące testy. Nie uruchamiano ciężkiego buildu ani kompilacji testów
jednostkowych, zgodnie z bieżącą polityką repozytorium.

## Ustalenia potwierdzone

### P1 — brak transportu lokalnej bazy stycznej w shared-domain Full2x2

Dokument fizyczny wymaga na parze okresowej

`q_dst = exp(-i k·Δr) (T_dstᵀ T_src) q_src`.

Wcześniej `backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp:403-439`
budował macierz ograniczeń z samą diagonalną fazą Floqueta dla obu składowych
stycznych. `crates/fullmag-runner/src/fem/eigen_projection.rs:6-16` konstruuje
ramę przez wybór osi referencyjnej z progiem `|m_z|=0.9`; zatem zgodność
magnetyzacji na szwie do `1e-8` nie gwarantuje identyczności ram.

Przed poprawką `crates/fullmag-runner/src/fem/eigen_shared_domain.rs` omijał
istniejący `reject_nonidentity_tangent_frame_transport` dla `Full2x2` i
przygotowywał native payload. Dawało to fizycznie niepoprawny wynik dla
nieidentycznych ram.

Naprawa w źródłach:

- `crates/fullmag-runner/src/fem/eigen_reduction.rs:148-179` dodaje jawny
  guard dla shared-domain `Full2x2`, `Periodic` i `Floquet`;
- `crates/fullmag-runner/src/fem/eigen_shared_domain.rs:858-862` wywołuje go
  na zaakceptowanym `linearization_state.equilibrium_m0`, przed przygotowaniem
  pól native;
- `crates/fullmag-runner/src/fem/eigen_tests.rs:5785-5823` dodaje test, w
  którym dwa wektory różnią się o mniej niż `1e-8`, ale leżą po przeciwnych
  stronach progu konstrukcji ramy. Test wymaga odrzucenia payloadu z komunikatem
  o potrzebie `phase*(T_dst^T T_src)`.

To jest poprawka fail-closed. Pełna obsługa teksturowanego `m0` wymaga jeszcze
rozszerzenia native constraint matrix o rzeczywistą macierz `T_dstᵀ T_src`;
guard nie udaje tej funkcji.

### Brak potwierdzonego błędu znaku Floqueta ani znaku Schura

`floquet_bloch_scalar.cpp:154-167`, `floquet_airbox_operator.cpp:412-429`,
`crates/fullmag-runner/src/fem/eigen_policy.rs:141-155` i
`docs/physics/0710-periodic-and-floquet-boundary-conditions.md` są spójne z
konwencją `exp(-i k·Δr)`. Wspólny operator tworzy
`A_qq - A_qphi P⁻¹ A_phiq`, a korekta `A_qphi=-μ0 A_phiqᴴ` jest sprawdzana w
istniejących testach bloków Poissona. Nie znaleziono podstaw do zmiany tych
znaków.

### Natywna ścieżka C1 jest sparse; `finite_matrix` nie jest jej dowiedzionym
kosztem

`modal_eigen_solver.cpp:1809-1884` przekazuje do produkcji
`materialize_dense_floquet=false` i wiąże bloki CSR. Stara materializacja
dense jest osobnym mostem legacy. Produkcyjna konstrukcja w
`poisson_airbox_shared_domain.cpp:3210-3230` wykonuje pięć operacji
`complex_csr_multiply`; implementacja `:272-312` odwiedza iloczyny
niezerowych wpisów i odkłada fill-in w mapach. To jest obecnie najbardziej
wiarygodny kandydat kosztu assembly, ale bez profilera nie wolno nazywać go
udowodnioną przyczyną 20-godzinnego C1.

### Brak jawnego limitu iteracji w benchmarku

`crates/fullmag-runner/src/fem/eigen_policy.rs:21-37` zamienia pominiętą
politykę na wartość ABI `0`. Benchmark
`tests/standard_problems/mumag/comsol_nonzero_k_dispersion/problem.py:190-202`
ustawia `solver_rtol`, lecz nie ustawia `FemEigenSolverPolicy` z
`max_outer_iterations` ani `max_linear_iterations`. Native
`backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp:1059-1065`
oraz `:1150-1187` mapuje zero na `PETSC_DEFAULT`. Solver może więc pracować
bez jawnej granicy czasu/iteracji; ten kontrakt wymaga osobnej poprawki w
benchmarku lub plannerze. Nie zmieniono go w tym ograniczonym patchu.

## Walidacja

- `git diff --check` przechodzi dla zmienionych plików; Git zgłasza wyłącznie
  istniejące ostrzeżenia o konwersji LF/CRLF.
- Dodano regresję źródłową w Rust, lecz jej kompilacja i wykonanie pozostają
  `NOT VERIFIED`, bo obowiązuje zakaz kompilacji testów jednostkowych.
- Runtime managed build oraz wynik fizyczny C1/nonzero-k nadal wymagają
  osobnej bramki. Odrzucenie przypadków z nieidentycznymi ramami nie jest
  dowodem poprawnego wyniku dla przypadku teksturowanego.

## Następne kroki

1. Ustawić jawne, raportowane limity `max_outer_iterations` i
   `max_linear_iterations` w kontrolowanym benchmarku oraz zachować je w
   receipt.
2. Zbudować runtime na zamrożonym snapshotcie i wykonać krótki punkt C1, aby
   potwierdzić, że guard działa przed natywnym payloadem.
3. Dla fizyki teksturowanego `m0` zaimplementować i zweryfikować pełny
   `phase*(T_dstᵀ T_src)` w native CSR, a dopiero potem dopuścić taki zakres.
4. Zmierzyć assembly CSR i LU/EPS osobnym profilerem przed optymalizacją.
