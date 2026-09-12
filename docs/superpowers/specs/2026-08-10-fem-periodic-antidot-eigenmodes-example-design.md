# Projekt osobnego przykładu FEM periodic-antidot eigensolve K0

## Cel

Dodać osobny, kanoniczny przykład Python DSL, który buduje periodyczną warstwę
Permalloy z centralnym otworem, relaksuje ją, a następnie oblicza widmo własne
K0 z dynamicznym demagnetyzowaniem Poisson-airbox oraz zapisuje widmo i
zespolone pola modów. Istniejący przykład wymuszonej odpowiedzi
częstotliwościowej pozostaje bez zmian i zachowuje własny cel walidacyjny.

## Plik i granica odpowiedzialności

Nowy plik:

`examples/fem_periodic_antidot_relax_eigenmodes.py`

Przykład jest pełnym, samodzielnym dokumentem authoringowym. Nie importuje
drugiego przykładu i nie ukrywa fizyki w pomocniczym builderze. Wspólne wartości
fizyczne mają być jawnie takie same jak w
`examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py`, a
test kontraktowy chroni je przed rozjazdem.

## Model fizyczny

- film Permalloy: 200 nm x 200 nm x 10 nm;
- centralny cylindryczny otwór: promień 25 nm;
- ręczny shared domain: 200 nm x 200 nm x 400 nm;
- periodyczność dokładnie x/y, otwarta oś z;
- `Ms = 800e3 A/m`, `Aex = 13e-12 J/m`, jawne tłumienie relaksacji;
- zewnętrzne pole bias: 10 mT w osi x;
- exchange oraz demag `poisson_robin`;
- magnetostatyka periodyczna `periodic_airbox_k0`;
- conformal region `hole_transition_refinement` pozostaje częścią modelu i
  tworzy drugi magnetyczny segment tego samego obiektu.

Nie wolno upraszczać geometrii do pełnego prostokąta, usuwać refinementu,
airboxu, narożnych klas periodycznych ani dynamicznego demag po to, aby
uruchomić solver.

## Przebieg obliczeń

1. Skrypt wybiera urządzenie modalne z
   `FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE=cpu|gpu`; domyślnie `cpu`.
2. Buduje jeden mesh shared-domain z magnetic parts i airboxem.
3. Wykonuje relaksację na CPU przez produkcyjnie obsługiwaną metodę
   minimalizacji, z jawną tolerancją momentu w A/m.
4. Po relaksacji przełącza urządzenie tylko wtedy, gdy modalne urządzenie jest
   GPU.
5. Dodaje jeden etap `add_eigenmodes`:
   - `operator="full_2x2"`,
   - `include_demag=True`,
   - `equilibrium_source="relax"`,
   - `normalization="unit_l2"`,
   - `damping_policy="ignore"`,
   - `k_vector=(0.0, 0.0, 0.0)`,
   - `bc=fm.PeriodicBC(["x_faces", "y_faces"])`,
   - `magnetostatic_bc="periodic_airbox_k0"`.
6. Target jest jawnym, ograniczonym oknem częstotliwości, nie nieograniczonym
   wyszukiwaniem. Dolna i górna granica oraz liczba modów są konfigurowalne.

## Parametry uruchomieniowe

Skrypt waliduje zmienne środowiskowe przed zbudowaniem study:

- `FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE`, domyślnie `cpu`;
- `FULLMAG_PERIODIC_ANTIDOT_EIGEN_MODE_COUNT`, domyślnie `8`, liczba dodatnia;
- `FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMIN_GHZ`, domyślnie `0.5`;
- `FULLMAG_PERIODIC_ANTIDOT_EIGEN_FMAX_GHZ`, domyślnie `30.0`, większe od
  minimum;
- `FULLMAG_PERIODIC_ANTIDOT_EIGEN_SAVE_MODE_COUNT`, domyślnie `4`, zakres
  `1..MODE_COUNT`.

Wartości są przeliczane na Hz przed wywołaniem DSL. Nie wprowadzamy drugiego
systemu jednostek ani nie zapisujemy GHz do ProblemIR.

## Wyniki i provenance

Skrypt deklaruje:

- `study.save("spectrum")`;
- `study.save("dispersion")`;
- `study.save("mode", indices=tuple(range(save_mode_count)))`.

Runtime metadata zapisuje nazwę scenariusza, rozmiary filmu i airboxu, promień
otworu, PBC x/y, open-z, pole bias, urządzenie żądane, okno częstotliwości i
liczbę modów. Resolved device, solver, assembly kind, certyfikaty i source of
truth pochodzą z runtime/artifact contract, a nie z deklaracji skryptu.

## Błędy i zachowanie fail-closed

Skrypt odrzuca nieznane urządzenie, niepoprawne liczby, puste okno oraz żądanie
większej liczby zapisywanych modów niż obliczanych. Planner/runtime musi
odrzucić brak PBC x/y, niezerowe k, brak periodic-airbox demag, stale
certificate, niepełny magnetic/airbox part registry oraz niedostępny strict GPU.
Nie ma cichego fallbacku GPU -> CPU dla jawnego `device="gpu"`.

## Testy

### Python DSL / ProblemIR

- import i wykonanie przykładu z podstawionym runtime bez uruchamiania native;
- dokładna geometria, materiał, airbox i mesh policy;
- kolejność `relax -> eigenmodes`;
- modalny `full_2x2`, K0, PBC x/y i `periodic_airbox_k0`;
- save requests dla spectrum/dispersion/mode;
- walidacja zmiennych środowiskowych;
- canonical Python/ProblemIR round-trip bez utraty pól.

### Planner / runner source contract

- CPU plan wybiera produkcyjną ścieżkę K0 shared-domain bez fallbacku;
- GPU plan pozostaje strict i wymaga natywnej capability;
- realny multi-part registry obejmuje bazę oraz
  `hole_transition_refinement` jako jeden physical object;
- certyfikat zawiera x/y faces, edge/corner closure i open-z.

### Managed native qualification

Po odblokowaniu export lock:

1. container-backed `just verify-fem-frequency-domain-native-contract`;
2. dense Poisson-airbox oracle;
3. rzeczywiste uruchomienie nowego przykładu na CPU;
4. walidacja niepustego widma, pełnych reszt i zespolonych pól modów;
5. dopiero po CPU oracle: GPU, CPU/GPU parity i performance.

Test IR ani fixture C++ nie zastępuje rzeczywistego managed MFEM solve.

## Kryteria akceptacji

Zakres skryptu jest source-complete, gdy testy DSL/IR/planner są zielone i
niezależny review nie ma Critical/Important findings. Nie jest
production-qualified, dopóki świeży managed runtime dokładnego source snapshotu
nie wykona relaksacji i modalnego solve CPU, nie zapisze widma i zespolonych
modów oraz nie przejdzie wymaganych residuów.
