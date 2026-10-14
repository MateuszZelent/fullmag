# Audyt walidacji dyspersji C0/C1/A1 — 2026-09-19

## Zakres i stan dowodów

Audyt obejmuje naukową bramkę walidacyjną, referencję analityczną oraz publiczny
kontrakt benchmarku COMSOL-aligned w worktree
`C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`.
Sprawdzono `scripts/validate_comsol_dispersion_scientific_gate.py`, jego testy,
`config.py`, `problem.py`, `parameters.json`, ścieżkę `kpath.csv` i kontrakt
`Problem.to_ir()` → planner FEM.

Managed job `bb8e50191fe74d39b6f9c459487b04cd` ze snapshotu rozpoczętego przed
ostatnią poprawką policy został anulowany (`CANCELLED`, exit 143); profil
runtime-only nie uruchamiał unit/contract testów. Testy źródłowe tego audytu
uruchomiono osobno; sam job nie jest dowodem wykonania fizycznego sweepu.
W bieżących artefaktach C1 nie ma kompletnego
`run-result.json` ani niepustego widma. Log poprzedniej próby zatrzymywał się na
`flat_eigenmodes`, więc nadal nie ma potwierdzonego punktu `k != 0` ani wykresu
z danych solvera.

## Potwierdzone ustalenia i poprawki

### V-01 — airbox był oceniany względem niewłaściwego odniesienia

Wcześniejszy walidator porównywał warianty `d_air=2,4,8 µm` z primary tak,
jakby były tym samym skończonym problemem Dirichleta, i stosował próg
`2e-4`. Zmiana wysokości airboxa zmienia operator brzegowy; sweep jest
kontrolą zbieżności przybliżenia granicy otwartej, ale każdy wariant jest
osobnym zadaniem brzegowym i jego częstotliwość może się przesunąć.

Próg `0.5%` nie został wymyślony w tej poprawce. W bazowym `HEAD` przed
zmianą, w `docs/guides/comsol-nonzero-k-dispersion-benchmark.md`, oryginalna
linia 226 mówiła: „L1→L2 i d_air=2→4 µm ... każda z pierwszych 8 ... <0.5%”.
Obecna linia 233 rozdziela zbieżność siatki od sweepu airboxa i wymaga także
malejących przyrostów `2→4` oraz `4→8`.

W kodzie `AIRBOX_CONVERGENCE_RELATIVE_TOLERANCE=5e-3` jest więc wcześniej
przyjętym budżetem kampanii airboxa. Nie jest to dowód dokładności primary
widma ani przepustka dla porównania z analityką Kalinikosa–Slawina. Primary
pozostaje oceniane osobno względem otwartofilmowej referencji z
`KS_RELATIVE_TOLERANCE=3e-3`; przejście airbox sweepu nie zastępuje tej bramki.

Poprawka w validatorze:

- mesh i liczba żądanych modów nadal używają ścisłego porównania
  `primary_same_physics` i `2e-4`;
- airbox porównuje sąsiednie warianty z odniesieniem
  `adjacent_airbox_boundary_sweep` i `5e-3`;
- wymagana jest obecność wszystkich próbek kontrolnych oraz trend malejących
  przyrostów.

### V-02 — ścieżka canonical nie zawiera czystej geometrii DE

`Gamma-X-M-Gamma` ma `sin²(phi)` od `0` do `0.5`, więc sama ścieżka nie
zawiera `k=(0,k_y,0)` i nie certyfikuje czystego Damon–Eshbacha. Do kontraktu
`parameters.json` i metadanych benchmarku dodano jawne, niezależne kontrole
slabowe:

- BV: `k=(10^7,0,0) rad/m`;
- DE: `k=(0,10^7,0) rad/m`.

Walidator odrzuca brak tych wektorów, złą geometrię albo dowód z innym
wektorem. To zamyka lukę w definicji eksperymentu; nie twierdzi, że odpowiednie
artefakty runtime już istnieją. Dla C1 nadal brakuje wykonanych i
zweryfikowanych bundle’i BV/DE.

### V-03 — kompletna gałąź nie była wiązana z najniższym dodatnim modem

Wcześniej `selected[0]` wynikał z porządku identyfikatorów gałęzi. Sam
`branch_id` jest etykietą księgową i nie dowodzi fizycznej kolejności. Dodano
kontrolę, która dla każdej próbki porównuje częstotliwość pierwszej wybranej
gałęzi z minimum dodatniego raw spectrum.

Ta kontrola jest koniecznym bezpiecznikiem częstotliwościowym, ale nie jest
pełną identyfikacją rodziny `n=0`. Repozytorium ma już per-run certyfikat
profilu `n=0`: `scripts/comsol_n0_projection.py` i
`scripts/comsol_n0_field_certificate.py`, testowane przez
`scripts/test_comsol_n0_projection.py` oraz
`scripts/test_comsol_n0_field_certificate.py`; validator sprawdza tam
projection residual, longitudinal leakage, fazę i związanie hashami. Ta
kontrola dotyczy jednak certyfikowanych pól pomocniczych/wybranych eksportów,
a nie pełnego, folding-aware śledzenia wybranej gałęzi na wszystkich próbkach.
Przy foldingu pasm oraz przy przecięciach
unikniętych/hybrydyzacji dwa wektory własne mogą mieć tę samą lub bardzo bliską
częstotliwość, a najniższa gałąź adiabatyczna może zmienić charakter. Minimum
dodatniego widma może wtedy wybrać najniższy mod liczbowo, lecz nie dowodzić,
że jest to ciągły mod `n=0` z analityki slabowej.

Brakującą kontrolą do uznania identyfikacji `n=0` na pełnej ścieżce jest co
najmniej overlap z poprzednią próbką `k`, folding-aware dopasowanie względem
wektorów `k+G` oraz kontrola degeneracji/unikniętego przecięcia; istniejący
certyfikat profilu należy wykorzystać jako jeden z sygnałów, nie zastępować go.
Dla A1, gdzie antidot zmienia profil, analityka
KS służy wyłącznie jako kontrola C1; gałęzie A1 wymagają śledzenia overlapem.

### V-04 — benchmark nie miał jawnego budżetu EPS/KSP

Benchmark ustawiał `solver_rtol=1e-8`, ale nie ustawiał limitów iteracji. W
`crates/fullmag-runner/src/fem/eigen_policy.rs` brak pola jest mapowany na
ABI-sentinel `0`, a natywny adapter przekazuje `0` jako PETSc/SLEPc default.
Taki wynik zależy od ustawień biblioteki i nie ma jawnego, powtarzalnego
budżetu zatrzymania.

Ustawiono w `config.py`, `problem.py` i `parameters.json`:

- `relative_tolerance = 1e-8` — bez zmiany istniejącej tolerancji;
- `max_outer_iterations = 64` — limit zewnętrznych iteracji EPS;
- `max_linear_iterations = 128` — limit iteracji wewnętrznego KSP.

Wartości 64/128 odpowiadają jawnym wartościom domyślnym natywnego sparse
modal adaptera (`backends/fem/cpu/frequency_domain/slepc_modal_eigen.hpp`),
ale benchmark przekazuje je teraz jawnie zamiast polegać na PETSc defaults.
Istniejący most w `packages/fullmag-py/src/fullmag/model/problem.py` zapisuje
policy jako `runtime_metadata.modal_solver_policy`, skąd planner buduje
`FemEigenPlanIR`; validator sprawdza policy ponownie w
`execution_plan.backend_plan.solver_policy`, czyli w planie, który trafia do
granicy native. Nie wprowadzano dodatkowej ścieżki ABI.

Limity EPS/KSP dotyczą iteracji rozwiązania własnego i powiązanego solve’u
liniowego. Nie ograniczają czasu montażu siatki, montażu operatora, budowy
airboxa ani faktoryzacji. Osiągnięcie limitu powinno dać jawny wynik
niezakwalifikowany z diagnostyką iteracji. Podniesienie limitu wymaga później
danych z diagnostyki, a nie rozluźnienia `rtol`.

## Rzeczy sprawdzone bez znalezionego błędu

- Referencja Kalinikosa–Slawina `n=0` ma poprawne granice BV/DE i używa
  `P00(kd)` dla otwartego filmu; finite-airbox `Nz` pozostaje kontrolą Γ i nie
  jest wstrzykiwane do niezerowego `k`.
- `B_ext` jest podawane w teslach, a `H=B/mu0` jest wyprowadzane w konfiguracji;
  nie znaleziono błędu jednostek w tym przejściu.
- Wcześniejsze poprawki operatora Floqueta, znaku potencjału Poissona i
  lokalnego montażu skalarnego nie zostały ponownie zakwalifikowane jako nowe
  findings tego audytu.

## Pozostałe bramki

1. Zbudować nowy managed runtime po zmianie policy i sprawdzić w artefakcie
   `modal_solver_policy`, resolved source identity oraz wartości diagnostyczne
   EPS/KSP.
2. Wykonać C0, C1 i A1 z niepustymi artefaktami; C1 musi obejmować pełną
   ścieżkę 61 próbek, osobne BV/DE oraz kontrolę residuali i fazy Floqueta.
3. Wykonać L1→L2 przy tym samym airboxie oraz `2→4→8 µm` z malejącym trendem.
   Kampania airboxa i porównanie KS są osobnymi kryteriami.
4. Dodać overlapowe śledzenie modów przed uznaniem n=0 przy folding/hybridyzacji.
5. Zweryfikować immutable managed-run receipt/source snapshot, ponieważ same
   self-reported metadata i lokalne hash’e artefaktów nie dowodzą pochodzenia
   z konkretnego joba.

## Weryfikacja zmian źródłowych

- `python -B scripts/test_validate_comsol_dispersion_scientific_gate.py` —
  **49 testów, OK**.
- `python -B -m unittest ...` — pięć celowanych regresji, **5/5 OK**.
- `python -B -m pytest -q tests/standard_problems/mumag/comsol_nonzero_k_dispersion/test_contract.py` —
  **12 passed**; jedyne ostrzeżenie dotyczyło braku uprawnień do zapisu
  `.pytest_cache` i nie dotyczyło testu.
- Nie wykonywano native builda po zmianie policy. Job snapshotu
  `bb8e50191fe74d39b6f9c459487b04cd` został anulowany przed ukończeniem i nie
  zawiera tej ostatniej poprawki.
