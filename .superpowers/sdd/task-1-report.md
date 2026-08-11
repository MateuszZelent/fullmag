# Raport Task 1: zamrożona fizyka racetrack M1

## Wynik

Zamrożono kontrakt `racetrack_m1_v1` dla osi `x=track`, `y=transverse`,
`z=HM→FM`, dodatniego conventional current `+x` i normalnej HM→FM `+z`.
Fixture jest jawnie syntetyczny i nie jest przypisany jednemu rzeczywistemu
materiałowi. Nie zmieniono statusu kwalifikacji żadnej ścieżki GPU.

Commit:

```text
125c9afec02dbce994a702a2693b4de78c1e5732
docs(physics): freeze solved-current racetrack contract
```

## Zmiany

- Dodano pełne równania charge continuity, direct SHE, steady-spin reactions,
  mixing boundary, torque balance i Gilbert LLG oraz kompletną tabelę znaków.
- Dodano wersjonowany fixture z 32 dokładnymi wartościami, jednostkami,
  ograniczeniami, ścieżkami ProblemIR i motywacją literaturową lub benchmarkową.
- Dodano kontrakt `skyrmion_hall_angle_v1`: signed-density centre, dobór okna
  według stabilności prędkości, ważona regresja, covariance,
  `Theta_H=atan2(v_y,v_x)` i reason codes fail-closed.
- Dodano source map obserwabli topological charge oraz jawne
  `planned_not_implemented` symbole Tasks 2–8. Wpisy planowane nie udają
  istniejących deklaracji źródłowych.
- Rozszerzono kanoniczny test dokumentacyjny
  `scripts/test_fdm_gpu_m1_contract_docs.py` o dokładne wartości, równania,
  znaki i ownership przyszłych symboli.

## Korekta ścieżki testu z briefu

Brief wskazywał nieistniejący plik `scripts/test_validate_physics_docs.py`.
Repozytorium posiada kanoniczny, page-specific gate
`scripts/test_fdm_gpu_m1_contract_docs.py`; rozszerzono właśnie ten test.
Nie utworzono drugiego, konkurencyjnego walidatora o podobnej roli.

## TDD RED

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
12 passed, 1 failed, 70 subtests passed
```

Oczekiwany błąd RED: `FileNotFoundError` dla nieistniejącego jeszcze
`tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json`.

## GREEN i walidacja

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
13 passed, 102 subtests passed in 0.35s

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed in 0.05s

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed: public_docs/site

git diff --check
PASS

git show --check --oneline --no-renames HEAD
125c9afec docs(physics): freeze solved-current racetrack contract; PASS
```

## Self-review

- Staging sprawdzono osobnym `git diff --cached --name-only`; commit zawiera
  wyłącznie siedem plików Task 1.
- Niezależna, wcześniejsza zmiana `.superpowers/sdd/progress.md` nie została
  wystage'owana ani zmodyfikowana w ramach Task 1.
- Wszystkie mapowane bieżące źródła mają realną ścieżkę i stabilny symbol;
  przyszłe nazwy są oddzielone w `planned_symbols` z owner task i evidence gate.
- Kontrakt odróżnia implementację, wykonywalność, walidację i kwalifikację.
  Obecność dokumentu, fixture lub testu nie promuje FDM GPU.

## Ograniczenia i dalsze bramki

Task 1 zamraża kontrakt i dane wejściowe. Nie dostarcza publicznego runnera,
bindingu kontekstu, stage checkpointu, provenance, GPU trajectory ani
kwalifikacji workloadu. Te elementy pozostają jawnie przypisane Tasks 2–12 i
wymagają świeżych zarządzanych testów exact-tuple oraz rzeczywistego GPU.

## Korekty po niezależnym review

### Wynik

Zamknięto wszystkie wskazane findingi Critical i Important bez rozszerzania
Task 1 na implementację runtime. Fixture określa teraz jeden kanoniczny wariant
`ProblemIR`: dokładny requested tuple `fdm/gpu/double/strict`, siatkę
`256x64x4`, rozłączne połówotwarte placementy HM/FM, jawnie zorientowane
powierzchnie terminali i izolacji, gauge `zero_mean`, obie strony interfejsu,
trzy deterministyczne maski oraz pełny harmonogram sześciu niezależnych
przebiegów ze wspólnego checkpointu. Równe wymiary HM i FM w osiach `x,y` są
częścią normalizacji, a żadne pole BC, maski, etapu ani execution intent nie
może zostać uzupełnione backendowym defaultem.

Korekta znaku `theta_SH` rozdziela odpowiedź produkcyjnego fixture z `P=0.4`
na `T_P + T_SHE -> T_P - T_SHE`. Dokładna nieparzystość jest testowana tylko
w oracle czystego SHE z jedynym override `P=0`; dokumentacja nie przypisuje
pełnej nieliniowej prędkości dokładnego prawa parzystości.

`skyrmion_hall_angle_v1` zamraża signed-density centre, wszystkie ciągłe okna,
dokładne progi i tie-break, wspólne wagi z podłogą wariancji `1e-18 m2`,
ważoną regresję z interceptem, pełną dwuwymiarową covariance prędkości z
`N-2`, główną gałąź `atan2` i jednoznaczną kolejność reason codes. Nota 0940
ma etykiety i source-map dla wszystkich 15 kanonicznych równań, jawne źródła
path+symbol lub `DOC-ANCHOR` oraz mapę twierdzeń numerycznych. Nowe komórki
symboli i jednostek SI używają składni MyST `$...$`.

### TDD RED review-fix

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
5 failed, 13 passed, 102 subtests passed
```

Pięć nowych testów odtworzyło niezależnie: niepełny fixture/IR, błędny oracle
`theta_SH`, niedeterministyczny kontrakt Hall angle, niepełną source-map 0940
oraz surowe tokeny SI w nowych tabelach.

### GREEN i bramki po korekcie

```text
python3 -m pytest scripts/test_fdm_gpu_m1_contract_docs.py -q
18 passed, 102 subtests passed in 0.29s

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed in 0.05s

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed: public_docs/site

git diff --check
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base 125c9afec02dbce994a702a2693b4de78c1e5732 --head HEAD --repo-root .
PASS
```

### Granica kwalifikacji

Korekta pozostaje kontraktem dokumentacyjnym i fixture. Nie stanowi dowodu
wykonania FDM GPU, implementacji `SkyrmionTrajectoryV1` ani
`SkyrmionHallAngleV1`, kalibracji niepewności lub produkcyjnej kwalifikacji
racetrack. Te statusy pozostają `planned_not_implemented`/`unsupported` do
czasu przejścia własnych zarządzanych bramek runtime na dokładnym requested
tuple.

## Korekty po drugim niezależnym review

### Rozstrzygnięcie findingów

1. **Critical — niepełny `normalized_problem_ir_contract`: zamknięty.**
   `fixture.v1.json` zawiera teraz `contract_kind=typed_expected_lowering_map`
   oraz pełny `expected_lowering` dla bieżących serializowanych typów:
   `CurrentModuleIR::CurrentTransport` z modelem `ohmic_poisson`, coupling
   `one_way`, kompletną domeną, materiałami, trzema BC, gauge i solverem;
   `SpinTransportModuleIR` z `current_source_id`, mode `steady`, solverem,
   requested execution i wersją konstytutywną; oraz
   `DriftDiffusionSpinTorque` z `solve_id`, targetem i wersją formuły.
   Kontrakt obejmuje też materiał FM, energy terms `Exchange`, `Demag` i
   `InterfacialDMI` z normalną `+z`, oba `StudyIR`, integrator `rk4`,
   `BackendPolicyIR`, validation profile i runtime selection.

   Test Python buduje te rekordy bieżącymi publicznymi konstruktorami i wymaga
   dokładnej równości ich `to_ir()`. Nowy test integracyjny `fullmag-ir` parsuje
   ten sam JSON bieżącymi typami Rust i sprawdza krytyczne pola po ponownej
   serializacji. Nie utworzono fikcyjnego pola `definition`: charge definition
   pozostaje zgodnie z serde spłaszczona w `CurrentTransport`.

2. **Critical — nieistniejące cele harmonogramu: zamknięty.** Wszystkie ścieżki
   materiałów i interfejsu używają rzeczywistych indeksów tablic ProblemIR.
   Każdy drive zapisuje osobne `problem_ir_overrides` dla
   `current_modules[0].boundaries[0].outward_current_density_Apm2` oraz
   `current_modules[0].boundaries[1].outward_current_density_Apm2`. Usunięto
   `boundaries[current_sweep]`. Indeksy etapów `1..6`, `entrypoint_kind=flat_run`,
   czas, krok i sampling pozostają częścią jawnego kontraktu workflow.

   Publiczne rekordy charge/spin/torque i obiekt pomocniczy HM są dziś
   reprezentowalne, natomiast publiczny `Problem` nie potrafi jeszcze wyrazić
   mutacji BC pomiędzy etapami ani restartu każdego drive z nazwanego
   checkpointu. `public_lowering_boundary` zamraża dokładnie te dwie luki;
   sześcioprzebiegowy harmonogram nie udaje pola bieżącego ProblemIR.

3. **Important — niedostatecznie dokładne testy semantyki: zamknięty.** Testy
   wymagają teraz literalnie charge continuity i znaku `E=-grad V`, kolejności
   indeksów `epsilon_ika` direct SHE i implikacji `Q_zy>0`, wszystkich trzech
   steady reactions, orientacji `n=+e_z`, definicji skoków i znaków mixing BC,
   ujemnego prefaktora torque bez `R_sf` oraz pełnego jawnego Gilbert RHS.
   Zakres forbidden jest dokładnie zamrożony dla CPU, FP32, prescribed torque,
   prescribed current density, Oersted, iSHE, M2, M3, MTJ, PBC, thermal noise i
   multi-GPU.

4. **Important — surowe tokeny SI w nowych wierszach: zamknięty.** Nowe wiersze
   `m`, `alpha`, `B_eff`, `T_P` i `T_SHE` w 0970 używają `$...$` zarówno dla
   symbolu, jak i jednostki. Jeden test pilnuje nowych tabel maszynowych 0940 i
   0970 bez globalnego odrzucania legalnego MathJax w pozostałej, starszej
   treści.

### TDD RED drugiego review

```text
python3 -m unittest scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests
Ran 10 tests
FAILED (failures=6, errors=2)

KeyError: 'contract_kind'
KeyError: 'stage_index'
forbidden_fallbacks: brak iSHE/M2/M3/MTJ/PBC/thermal/multi-GPU
raw math cells: m, alpha, B_eff, T_P, T_SHE

cargo test -p fullmag-ir --test racetrack_m1_fixture
FAILED: contract_kind left None, right typed_expected_lowering_map
```

RED był kontrolowany: oba testy skompilowały się i zatrzymały dokładnie na
brakujących polach fixture, nie na błędzie importu, składni ani zależności.

### GREEN drugiego review

```text
python3 -m unittest scripts.test_fdm_gpu_m1_contract_docs.RacetrackM1PhysicsContractDocsTests
Ran 10 tests; OK

cargo test -p fullmag-ir --test racetrack_m1_fixture
1 passed; 0 failed

python3 scripts/test_fdm_gpu_m1_contract_docs.py
Ran 22 tests; OK

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0970-spin-hall-drift-diffusion-transport.source-map.json --repo-root .
PASS

python3 .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py \
  docs/physics/0940-topological-charge-observable.source-map.json --repo-root .
PASS

python3 -m unittest discover \
  -s .agents/skills/scientific-documentation-contract/scripts -p 'test_*.py'
Ran 22 tests; OK

python3 -m pytest scripts/test_validate_topological_charge_runtime.py -q
4 passed

python3 scripts/check_public_doc_examples.py --root public_docs/site
Public documentation Python examples passed

python3 .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py \
  --base ccd22952b8422814999d44bfca5874a2d59fabda --head HEAD --repo-root .
PASS

git show --check --oneline --no-renames HEAD
PASS
```

### Granica dowodu po korekcie

Korekta dowodzi dokładności bieżących nazw i kształtów wire przez publiczne
lowering Python oraz parser Rust. Nie dowodzi publicznej wykonywalności pełnego
workflow, materializacji masek, mutacji etapów, restartu, działania GPU ani
kwalifikacji fizycznej. Status pozostaje kontraktowy do przejścia dalszych
bramek Tasks 2--12.
