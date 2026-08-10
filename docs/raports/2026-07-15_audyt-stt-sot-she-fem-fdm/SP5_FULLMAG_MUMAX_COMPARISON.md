# Standard Problem 5: reprodukcja Fullmag i porównanie z MuMax3

**Data audytu:** 2026-08-03
**Status:** reprodukcja źródła, wersjonowany operator MuMax3 Python → `ProblemIR` → FDM CPU/CUDA oraz świeży przebieg na RTX 4080 SUPER wykonane; literalny golden domyślnego MuMax3 nadal nie przechodzi, natomiast pełna trajektoria CPU/CUDA przechodzi pełnopolową bramę `1e-4` względem zbieżniejszej referencji `DemagAccuracy=24`. Jest to kwalifikowany workload o jawnej referencji, nie promocja całej rodziny STT.
**Źródło:** [`external_solvers/3/test/standardproblem5.mx3`](../../../external_solvers/3/test/standardproblem5.mx3)
**Implementacja:** [`examples/mumax_standard_problem_5_fdm.py`](../../../examples/mumax_standard_problem_5_fdm.py)
**Test kontraktu:** [`test_standard_problem_5_fdm.py`](../../../packages/fullmag-py/tests/test_standard_problem_5_fdm.py)

## 1. Kontrakt źródłowy

Plik MuMax3 definiuje:

| Parametr | Wartość źródłowa | Mapping Fullmag |
|---|---:|---|
| siatka | `32 x 32 x 4` | `study.cell(3.125, 3.125, 2.5) nm` |
| komórka | `(100/32, 100/32, 10/4) nm` | `BODY_SIZE=(100,100,10) nm`, `CELL=BODY_SIZE/GRID` |
| materiał | `Msat=800e3 A/m`, `Aex=13e-12 J/m` | `plate.Ms`, `plate.Aex` |
| tłumienie | `alpha=0.1` | `plate.alpha=0.1` w etapie fizycznym |
| stan | `vortex(1,1)` | `fm.texture.vortex(circulation=1, core_polarity=1)` |
| prąd | `J=(1e12,0,0) A/m²` | `ZhangLiSTT(current_density=(1e12,0,0))` |
| polaryzacja | `Pol=1` | `degree=1` |
| nieadiabatyczność | `xi=0.05` | `xi=0.05` → IR `beta=0.05` |
| operator | `zhangli2.cu` centralny + clamp/PBC | `formula_version=zhang_li.mumax3.v1`, `operator_version=zl_mumax3_central_v1` |
| czas | `run(1e-9)` | `add_run(1e-9, stage_id="current_run")` |
| oczekiwanie | `mx,my,mz`, tolerancja `1e-4` | ta sama norma komponentowa |

Istotna korekta fizyczna: `10e-9/4` jest rozmiarem jednej komórki w osi $z$,
więc całkowita grubość wynosi `4 * 2.5 nm = 10 nm`, a nie `40 nm`.
Źródło jest problemem CIP/Zhang–Li; nie należy mapować go na
Slonczewskiego/CPP ani na rozwiązanie SHE drift–diffusion.

## 2. Weryfikacja authoringu i IR

Test:

```text
PYTHONPATH=.:packages/fullmag-py/src TMPDIR=/tmp/fullmag-pytest \
python3 -m pytest -q packages/fullmag-py/tests/test_standard_problem_5_fdm.py
```

Wynik: test kontraktu przechodzi. Potwierdza dwa etapy (`flat_relax`, `flat_run`),
geometrię, materiał, vortex, rozdzielenie tłumienia relaksacji od tłumienia
fizycznego, brak STT podczas relaksacji, dokładny moduł Zhang–Li oraz horyzont
`1 ns`.

Run-stage lowering zawiera m.in.:

```json
{
  "discretization": {"fdm": {"cell": [3.125e-9, 3.125e-9, 2.5e-9]}},
  "energy_terms": [{"kind": "exchange"}, {"kind": "demag", "realization": "auto"}],
  "spin_torque_modules": [{
    "kind": "zhang_li",
    "schema_version": "zhang_li_torque.v1",
    "id": "sp5_zhang_li",
    "target": {"object_id": "plate"},
    "formula_version": "zhang_li.mumax3.v1",
    "operator_version": "zl_mumax3_central_v1",
    "lande_g": 2.0,
    "degree": 1.0,
    "beta": 0.05,
    "current_density": [1e12, 0.0, 0.0]
  }]
}
```

## 3. Wyniki z wykonania

### 3.1. GPU adaptive

Historyczne żądanie CUDA z domyślnym RK45 było odrzucane przez planner:

```text
adaptive_timestep on FDM CUDA has no executable timestep capability identity;
use runtime_selection.device='cpu' until the CUDA adaptive controller ABI is complete
```

Była to poprawna granica dla wcześniejszego snapshotu. W aktualnym kodzie
single-grid v2 ABI ma już jawne `explicit_adaptive_fdm_cuda_double`, ale wpis
pozostaje `unvalidated`; brak kwalifikacji nadal nie może uruchamiać cichego
CPU fallbacku.

### 3.1.1. Świeży przebieg adaptive CUDA po wprowadzeniu tożsamości

Po ponownym eksporcie zarządzanego runtime wykonano jawnie wybraną ścieżkę
`FDM/CUDA/FP64/RK45/adaptive` bez CPU fallbacku. Runtime i artefakt potwierdzają:

- `execution_engine=cuda_fdm`, `device_name=NVIDIA GeForce RTX 4080 SUPER`,
  compute capability `8.9`, cuFFT, FP64;
- `qualification_id=explicit_adaptive_fdm_cuda_double`,
  `validation_state=unvalidated`;
- `requested_integrator=resolved_integrator=rk45`, `atol=1e-5`,
  `dt_initial=dt_min=1e-15 s`, `dt_max=1e-11 s`, `rtol=0`;
- `lossy_fallback_used=false` i etap 1 ns zakończony kodem 0.

Artefakt: `/zfn2/mateuszz/git/fullmag/runs/`\
`mumax-sp5-fdm-mumax3-v1-20260802-gpu-adaptive1`.
Średnia końcowa (czas etapowy `1 ns`) wynosi
`(-0.15208459449494185, -0.033110165787384384, 0.025342838207889982)`.
Względem świeżej referencji MuMax3 różnice komponentowe to odpowiednio
`(+8.2799071544e-2, +6.1422636914e-2, +2.3808491627e-3)`, z maksimum
`8.2799e-2`. Artefakt ma `qualification.json.status=not_evaluated`;
`solver_attempts.csv` nie zawiera jeszcze accepted-step trace, więc jest to
wyłącznie dowód wykonania i tożsamości lane'u, nie kwalifikacja numeryczna.

Drugi przebieg z tym samym runtime i `FULLMAG_SP5_RELAX_MAX_STEPS=100000`
zakończył się po około 22 850 krokach relaksacji błędem CUDA:

```text
cudaMemcpyAsync(reduce_adaptive_error_policy): unspecified launch failure (719)
```

Katalog `.../gpu-adaptive2` nie zawiera finalnego artefaktu. Błąd został
zapisany jako blocker diagnostyczny; ponieważ na tej samej karcie działały
równolegle dwa niezależne przebiegi SP4, nie przypisuje się go jeszcze ani
fizyce Zhang–Li, ani konkretnemu kernelowi bez powtórzenia z
`CUDA_LAUNCH_BLOCKING=1` i izolowanym urządzeniem. Nie wolno z tego przebiegu
wyprowadzać pozytywnej ani negatywnej kwalifikacji.

### 3.2. GPU fixed-step — historyczny baseline, tylko diagnostyka

Uruchomiono CUDA double na `NVIDIA GeForce RTX 4080 SUPER`, compute capability
`8.9`, z `cuFFT`. Dla `FULLMAG_SP5_FIXED_DT=1e-13` i relaksacji do `1e-4 T`
artefakt znajduje się w:

`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-gpu-fixed-relax10k`

Średnią policzono bezpośrednio z `m_final.json` (4096 wektorów):

| komponent | MuMax3 | Fullmag | różnica |
|---|---:|---:|---:|
| $\bar m_x$ | `-0.23479773` | `-0.23433556` | `+4.62e-4` |
| $\bar m_y$ | `-0.09453578` | `-0.09937264` | `-4.84e-3` |
| $\bar m_z$ | `+0.02296375` | `+0.02290284` | `-6.09e-5` |

Maksymalny błąd komponentu wynosi `4.84e-3`, czyli przekracza tolerancję
`1e-4` około 48 razy. `qualification.json` ma `status=not_evaluated`;
przebieg nie jest dowodem produkcyjnej parzystości.

Punkt kontrolny z `dt=1e-14 s` i tym samym progiem relaksacji dał
`(-0.23433558, -0.09937265, 0.02290284)` oraz `max|Δ|=4.84e-3`. Sama zmiana
stałego kroku w tym zakresie nie zamknęła rozbieżności. Przebieg z progiem
relaksacji `1e-6 T` dał `(-0.23433558, -0.09937255, 0.02290284)` oraz
`max|Δ|=4.84e-3`.

Ten wynik jest baseline'em starego `zhang_li.legacy_fullmag.v0`; nie jest
wynikiem nowego operatora. MuMax3 `external_solvers/3/cuda/zhangli2.cu` używa
różnicy `m[i+1]-m[i-1]` podzielonej przez `cell_size`, ponieważ współczynnik
`MUB/(2*QE*GAMMA0)` zawiera już czynnik `1/2`. Legacy Fullmag używa pierwszego
rzędu upwind. Nowy operator nie zmienia starej ścieżki i musi zostać zmierzony
osobno po przebudowie runtime.

### 3.3. Wersjonowany operator i bramy implementacyjne

Dodano `zhang_li.mumax3.v1` / `zl_mumax3_central_v1`:

- Python wymaga `id`, `target`, `lande_g` i jawnej wersji operatora;
- walidacja IR nie pozwala pomylić wariantu MuMax3 z FEM `zl_central_reference_v1`;
- `FdmPlanIR` zachowuje formułę, operator, target i Landé dla provenance;
- FDM CPU używa stałych `mu_B=9.2740091523e-24`, `e=1.60217646e-19`, centralnego
  clamp/PBC stencilu z niehalowaną różnicą źródłowego kernela oraz pojedynczej
  projekcji Gilberta;
- ABI native przenosi discriminator do FP64/FP32 CUDA, a stara ścieżka v0 ma
  zachowany prefaktor i stencil;
- oracle jednego kroku oraz zgodność AoS/SoA przechodzą w `fullmag-engine`.

To jest dowód implementacji operatora, nie dowód zgodności całego SP5. Wymagane
są porównanie CPU↔CUDA na pełnej trajektorii i ponowne uruchomienie całej
trajektorii. Izolowana brama operatora jest już zamknięta: zarządzana recepta
`just verify-fdm-zhang-li-native-contract` zbudowała `fullmag_fdm` i
`stt_pbc_contract`, a aktywny test
`native_fdm_mumax3_zhang_li_matches_cpu_reference_for_one_masked_step_when_cuda_is_available`
wykonał jeden krok FP64 Heun na zamaskowanym planie $3\times3\times1$ i
zakończył się `1 passed`. Test używa
`J=(1.4e11,-2e10,3e10) A/m²`, `P=0.62`, `beta=0.07`, wersji
`zhang_li.mumax3.v1` / `zl_mumax3_central_v1`, a wymiana, demagnetyzacja i pole
zewnętrzne są wyłączone, aby nie maskować operatora innymi różnicami.

### 3.4. Naprawa publikacji skalarów

Aktywna ścieżka CUDA w `crates/fullmag-runner/src/dispatch.rs` została
poprawiona tak, aby najpierw pobrać jeden snapshot `final_magnetization`, zapisać
go do `m_final.json`, a następnie z tego samego bufora obliczyć i opublikować
`mx,my,mz` w `scalars.csv`. Focused test
`dispatch::tests::native_cuda_scalar_output_boundary_reduces_m_before_recording`
przechodzi. W świeżym przebiegu poniżej różnica scalar–mean wynosi odpowiednio
`2.8e-17`, `0.0` i `-3.5e-18`; wcześniejszy defekt zerowych skalarów nie jest
już obserwowany.

### 3.5. Świeża referencja MuMax3 i nowy operator

Referencję uruchomiono ponownie z dokładnego źródła
`external_solvers/3/test/standardproblem5.mx3` przy użyciu MuMax3 `v3.11.2`
(commit `13ac56f1`), CUDA 12.4 i NVIDIA GeForce RTX 4080 SUPER (compute
capability 8.9). Proces zakończył się kodem 0; `expect()` potwierdziły tolerancję
`1e-4`, a faktycznie zmierzona średnia to:

```text
(-0.23488366603851318, -0.09453280270099640, 0.022961989045143127)
```

Artefakt: `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-mumax3-reference-20260802-01`.
Wartość różni się od literalnego golden z pliku źródłowego
`(-0.23479773,-0.09453578,0.02296375)` o maksymalnie `8.59e-5`, czyli pozostaje
w jego tolerancji.

Świeży Fullmag FDM CUDA z `formula_version=zhang_li.mumax3.v1`,
`operator_version=zl_mumax3_central_v1`, `dt=1e-13 s`, relaksacją `tolT=1e-6 T`
i `max_steps=10000` wykonał się bez fallbacku (`execution_engine=cuda_fdm`,
`device_name=NVIDIA GeForce RTX 4080 SUPER`, FP64, cuFFT). Artefakt:
`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-20260802-gpu2`.
Średnia z `m_final.json` i końcowy scalar row są:

| komponent | MuMax3 (świeży) | Fullmag MuMax3-v1 | $\Delta$ Fullmag−MuMax3 |
|---|---:|---:|---:|
| $\bar m_x$ | `-0.2348836660385` | `-0.1168850822571` | `+1.1799858378145e-1` |
| $\bar m_y$ | `-0.0945328027010` | `-0.0482401146804` | `+4.6292688020580e-2` |
| $\bar m_z$ | `+0.0229619890451` | `+0.0257941117845` | `+2.8321227393710e-3` |

Maksymalny błąd komponentu to `1.1799858378e-1`, około 1180 razy ponad
`1e-4`. `qualification.json` pozostaje `status=not_evaluated`. Jest to
wykonany, device-resident wynik diagnostyczny; nie potwierdza on zgodności
trajektorii. Wcześniejszą próbę pełnego przebiegu CPU przerwano po kroku 550
relaksacji z powodu kosztu demagnetyzacji; CPU algebraic oracle i ścieżka
planowania pozostają zielone, ale nie zastępują pełnego CPU trajectory gate.

### 3.6. Korekta podwójnego czynnika 1/2 i świeży SP5 GPU

Kontrola źródła `external_solvers/3/cuda/zhangli2.cu` wykazała, że
`PREFACTOR=MUB/(2*QE*GAMMA0)` zawiera już czynnik `1/2`, natomiast makra
`deltax/deltay/deltaz` używają niehalowanej różnicy sąsiadów podzielonej przez
`cell_size`. Fullmag stosował wcześniej dodatkowe `0.5/cell_size` zarówno w
CPU, jak i CUDA, więc torque był dwukrotnie za mały. Poprawiono CPU oraz FP32 i
FP64 CUDA; wariant `zhang_li.legacy_fullmag.v0` pozostał niezmieniony. Zaktualizowano
równanie w nocie fizycznej i źródłowy kontrakt `stt_pbc_contract`.

Po korekcie zarządzana recepta
`just verify-fdm-zhang-li-native-contract` zakończyła się:

```text
FDM Zhang-Li periodic-stencil contract: PASS
test result: 1 passed; 0 failed; 0 ignored; 0 measured; 769 filtered out
```

Świeży zarządzany runtime i stałokrokowy SP5 GPU (`dt=1e-13 s`, `tolT=1e-6 T`,
10000 accepted steps) zapisano w:

`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed`

Artefakt potwierdza `execution_engine=cuda_fdm`, FP64/cuFFT, RTX 4080 SUPER,
compute capability 8.9 i `lossy_fallback_used=false`. Średnie końcowe są:

| komponent | MuMax3 (świeży) | Fullmag MuMax3-v1 po korekcie | Δ Fullmag−MuMax3 |
|---|---:|---:|---:|
| $\bar m_x$ | `-0.2348836660385` | `-0.2346557117921` | `+2.2795424643e-4` |
| $\bar m_y$ | `-0.0945328027010` | `-0.0945095717490` | `+2.3230951948e-5` |
| $\bar m_z$ | `+0.0229619890451` | `+0.0229429608644` | `-1.9028180738e-5` |

`max|Δ|=2.2795424643e-4`, a vector RMS of `1.3274648427e-4`. Korekta usuwa
wcześniejszy błąd skali (składowe `x/y` nie są już połową referencji), lecz
wynik nadal przekracza próg `1e-4`; `qualification.json` pozostaje
`status=not_evaluated`.

### 3.7. Pełna stałokrokowa parzystość CPU↔CUDA

Przebieg CPU został następnie doprowadzony do końca z tym samym planem,
`dt=1e-13 s` i horyzontem `1 ns` etapu `flat_run`. Artefakt znajduje się w:

`/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-mumax3-v1-factorfix-20260803-fixed-cpu`

Metadane potwierdzają `execution_engine=cpu_reference`, FP64, `rustfft`,
`tensor_fft_newell` i `lossy_fallback_used=false`. Relaksacja oraz etap dynamiczny
wykonały łącznie `12458` accepted steps; trace etapu `flat_run` zawiera `10000`
wierszy. CPU i CUDA mają identyczne identyfikatory `step`, `time` i `dt` w całym
trace. Końcowe pola (4096 wektorów) różnią się maksymalnie
`6.9389e-16`, a vector RMS wynosi `1.1431e-16`; średnie końcowe są takie same
do zaokrąglenia maszynowego. Dla fizycznych obserwabli trace maksymalna różnica
wynosi `1.2875e-3` w `max_dm_dt` przy skali około `1e10 s^-1`; energie różnią
się poniżej `1.6e-33`.

To zamyka **fixed CPU↔CUDA trajectory parity** dla tego samego operatora i
demagnetyzacji. Nie zamyka zgodności z MuMax3: CPU ma dokładnie ten sam wynik co
GPU, a błąd względem świeżej referencji pozostaje
`max|Δ|=2.2795e-4`, więc oba `qualification.json` zachowują
`status=not_evaluated`.

### 3.8. Wersjonowana brama kwalifikacji artefaktów

Ręczne porównanie zastąpiono wykonywalnym walidatorem
`scripts/validate_fdm_sp5_runtime.py` i dwiema receptami:

```text
just verify-fdm-sp5-validator
just verify-fdm-sp5-artifacts <cpu-run> <gpu-run> <output.json>
```

Walidator wymaga literalnego problemu `mumax_standard_problem_5_fdm`, siatki
`32×32×4`, komórki `(3.125, 3.125, 2.5) nm`, FP64, zakazanego fallbacku,
stałego kroku, całkowitej liczby kroków wyprowadzonej z `1 ns / dt` i czasu
końcowego `1 ns`. Wymaga również, aby runtime graph oznaczył dokładnie
`sp5_zhang_li` jako `executed` na wszystkich 4096 komórkach.
Oddzielnie kwalifikuje pełnopolowy CPU--CUDA parity oraz średnią magnetyzację
względem świeżej referencji MuMax3. Status końcowy może być `qualified` tylko
wtedy, gdy przejdą oba kryteria.

Świeże wykonanie na artefaktach z §3.6--3.7 dało:

```text
cpu_cuda_parity.status = pass
cpu_cuda_parity.max_abs_component_error = 6.938893903907228e-16
mumax3_reference.status = fail
mumax3_reference.max_abs_component_error = 2.2795424643093365e-4
qualification_status = not_qualified
```

Raport maszynowy zapisano w
`/zfn2/mateuszz/git/fullmag/runs/sp5-fdm-qualification-v1-20260809-just.json`.
Kod wyjścia recepty wynosi `1`, zgodnie z wynikiem naukowym; zielony parytet
wewnętrzny nie maskuje przekroczenia tolerancji zewnętrznej `1e-4`.

### 3.9. Świeży runtime graph i sweep kroku `dt`, `dt/2`

Po dodaniu obserwacji wykonania operatora powtórzono pełne przebiegi CPU i
CUDA z aktualnego źródła. Dla `dt=1e-13 s` oba artefakty zawierają
`executed_module_ids=["sp5_zhang_li"]`, stan `executed` i
`realized_cell_count=4096`. Mechaniczna brama potwierdziła:

```text
CPU--CUDA accepted schedule                       equal
CPU--CUDA max component field error  6.9388939039e-16
CPU--CUDA component RMS              1.1431120734e-16
MuMax3 max mean-component error       2.2795424643e-4
qualification_status                         not_qualified
```

Następnie powtórzono oba backendy dla `dt=5e-14 s`: 4914 kroków relaksacji i
20000 kroków etapu dynamicznego. CPU--CUDA ponownie ma identyczny harmonogram,
pełnopolowy błąd maksymalny `7.4940054162e-16` i RMS
`1.1983684507e-16`. Maksymalny błąd średniej względem MuMax3 zmienił się tylko
z `2.2795424643e-4` na `2.2793991698e-4`.

Zmiana pełnego pola CPU między `dt` i `dt/2` wynosi:

```text
max absolute component delta = 1.7869704683e-7
component RMS delta          = 1.7570575141e-8
```

Zmiana czasowa jest ponad trzy rzędy wielkości mniejsza od dominującego błędu
średniej względem MuMax3. Dwa poziomy kroku nie wyznaczają formalnego rzędu
zbieżności, ale wystarczają do odrzucenia hipotezy, że przekroczenie progu
`1e-4` jest powodowane przez `dt=1e-13 s`. Dalsza diagnostyka musi skupić się
na stanie po relaksacji, demagnetyzacji, warunkach brzegowych stencil Zhang--Li
i dokładnej konfiguracji referencyjnego MuMax3.

Artefakty i raporty:

- `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-cpu-executed-graph-dt1e-13-20260809-v3`;
- `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-executed-graph-dt1e-13-20260809-v1`;
- `/zfn2/mateuszz/git/fullmag/runs/sp5-fdm-executed-graph-qualification-dt1e-13-20260809-v2.json`;
- `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-cpu-executed-graph-dt5e-14-20260809-v1`;
- `/zfn2/mateuszz/git/fullmag/runs/mumax-sp5-fdm-gpu-executed-graph-dt5e-14-20260809-v1`;
- `/zfn2/mateuszz/git/fullmag/runs/sp5-fdm-executed-graph-qualification-dt5e-14-20260809-v1.json`.

### 3.10. Rozdzielenie relaksacji, pola bazowego i odpowiedzi Zhang--Li

Dodano reprodukowalny komparator pełnych pól
`scripts/compare_fdm_sp5_mumax_fields.py`. Czyta on OVF2 Binary4, wymaga
zgodnych wymiarów i liczby komórek, a następnie porównuje osobno:

1. stan po niezależnej relaksacji;
2. trajektorię bez prądu;
3. trajektorię z prądem;
4. odpowiedź prądową po odjęciu trajektorii `J=0` po obu stronach.

MuMax3 oraz Fullmag uruchomiono z tym samym polem początkowym OVF, solverem
Heuna, `dt=1e-13 s` i horyzontem `1 ns`. Zamrożony binarny build MuMax3 ma
SHA-256 `1763c7a1f9ed779abdd8ee755a6d2af771b76dc8ab2e2212efe74e0a44f5f600`.
Build nie publikuje commita, dlatego wynik pozostaje diagnostyczny; jego
końcowa średnia różni się jednak od referencji `v3.11.2@13ac56f1` tylko o
około `7.6e-7`.

Raport
`/zfn2/mateuszz/git/fullmag/runs/sp5-fdm-full-field-diagnostic-20260809-v2.json`
zawiera:

| kontrola | RMS komponentu | maksimum komponentu | główny wniosek |
|---|---:|---:|---|
| natywna relaksacja Fullmag vs MuMax3 | `4.1698e-5` | `1.8525e-4` | stany równowagi są bliskie, lecz nie identyczne |
| wspólny stan początkowy, `J=0`, 1 ns | `4.1866e-5` | `1.8544e-4` | różnica bazowego LLG nie zanika |
| wspólny stan początkowy, `J=1e12 A/m^2`, 1 ns | `2.6945e-4` | `2.6553e-3` | błąd rośnie w sprzężonej dynamice |
| `(m_J-m_0)_Fullmag-(m_J-m_0)_MuMax3` | `2.7246e-4` | `2.6507e-3` | odpowiedź prądowa jest wrażliwa na różnicę pola bazowego |

Kontrola torque-only z wyłączonym exchange i demag daje po 1 ns RMS
`3.4779e-5` przy zmianie pola RMS `6.8018e-1`, czyli względny błąd około
`5.1e-5`; maksymalny błąd średniej wynosi `8.5e-6`. Nie ma podstaw do zmiany
prefaktora ani znaku Zhang--Li. Dominującym następnym przedmiotem audytu jest
zgodność dyskretnego pola demagnetyzacji i wynikającego z niego RHS LLG.

Pierwsza próba aktualnym lokalnym binarium MuMax3
`84bd3b230aaff3f059d7ab5586f9dafe1c051acf6f1b3a4e8921b028b5869802`
utknęła przed pierwszym kernelem CUDA i została przerwana; nie jest dowodem
fizycznym ani kwalifikacyjnym.

### 3.11. Bezpośredni oracle pól i zbieżniejsza referencja demag

MuMax3 zapisuje `B_demag` i `B_exch`, natomiast Fullmag publikuje `H_demag` i
`H_ex` w `A/m`. Komparator
`scripts/compare_fdm_sp5_mumax_effective_fields.py` wykonuje jawną konwersję
$H=B/\mu_0$, wymaga dokładnie jednego snapshotu każdego pola i zgodnej siatki
`32x32x4`.

Raport
`/zfn2/mateuszz/git/fullmag/runs/sp5-fdm-effective-field-diagnostic-20260809-v2.json`
potwierdza:

| operator | RMS `A/m` | względny RMS | maksimum `A/m` |
|---|---:|---:|---:|
| exchange | `4.0756e-1` | `4.5025e-6` | `2.1649` |
| demag, `DemagAccuracy=6` | `5.6915e1` | `1.1728e-3` | `521.7590` |
| demag, `DemagAccuracy=12` | `2.3903e1` | `4.9233e-4` | `209.5525` |
| demag, `DemagAccuracy=24` | `1.1087e1` | `2.2833e-4` | `103.5996` |

Źródło MuMax3 pokazuje przyczynę: jego kernel jest numeryczną kwadraturą
powierzchnia--objętość sterowaną `DemagAccuracy`; Fullmag używa analitycznego
tensora Newella. Monotoniczne zbliżanie się MuMax3 do Fullmaga przy zwiększaniu
dokładności wyklucza naprawę przez zastąpienie dokładnego kernela Fullmaga
domyślną aproksymacją `accuracy=6`.

Pełny MuMax3 SP5 z `DemagAccuracy=24` daje średnią
`(-0.2346616633,-0.0945105377,0.0229454409)`. Względem niego Fullmag CPU dla
`dt=1e-13 s` ma:

```text
max mean-component error     = 5.9515e-6
full-field component RMS     = 9.7093e-6
full-field max component     = 4.3982e-5
CPU--CUDA max component      = 6.9389e-16
```

Dla `dt/2=5e-14 s` pełnopolowy RMS wynosi `9.7045e-6`, a maksimum
`4.3967e-5`. Oba poziomy przechodzą próg `1e-4`. Walidator zachowuje dwa
oddzielne wyniki: `mumax3_reference=fail` dla literalnego default/golden oraz
`mumax3_converged_demag_reference=pass`; kwalifikacja wymaga jawnego
`qualification_reference=converged_demag`.

Artefakty kwalifikacyjne:

- `/zfn2/mateuszz/git/fullmag/runs/sp5-fdm-converged-demag-qualification-dt1e-13-20260809-v2.json`;
- `/zfn2/mateuszz/git/fullmag/runs/sp5-fdm-converged-demag-qualification-dt5e-14-20260809-v1.json`.

## 4. Ocena fizyczna i numeryczna

Potwierdzone:

- zarządzany test jednego kroku CPU↔CUDA dla izolowanego operatora Zhang–Li
  przechodzi z tolerancją względną `5e-8` i bezwzględną `1e-10`;
- literalny rozmiar i topologia siatki są zgodne ze źródłem;
- inicjalizacja vortex i parametry materiału są zachowane w `ProblemIR`;
- `J`, `Pol`, `xi` są mapowane na signed CIP Zhang–Li (`current_density`,
  `degree`, `beta`), a nie na CPP/SHE;
- żądanie niekwalifikowanego CUDA adaptive nie wykonuje cichego fallbacku;
  aktualnie przechodzi tylko jako jawnie `unvalidated` single-grid lane;
- artefakt pola i provenance urządzenia są zapisane na szybkim dysku
  `/zfn2/mateuszz/git/fullmag`;
- jawnie wybrany workload `converged_demag` przechodzi pełnopolowo na CPU i
  CUDA dla `dt` oraz `dt/2`.

Nadal niepotwierdzone:

- zgodność z literalnym goldenem domyślnego `DemagAccuracy=6`; rozjazd jest
  wyjaśniony błędem kwadratury referencji, ale wynik pozostaje osobnym `fail`;
- pełny CPU adaptive RK45 na `1 ns`;
- CPU accepted-step scalar publication dla pełnego przebiegu;
- jakakolwiek kwalifikacja FEM/GPU cross-backend.

Nie należy wyciągać z literalnego błędu średniej wniosku, że winny jest
prefaktor lub znak. Kontrolowane testy rozdzieliły stan po relaksacji,
Zhang--Li, exchange i demag; dominującą przyczyną różnicy względem domyślnego
MuMax3 jest kwadratura kernela demag.

## 5. Kryteria zamknięcia SP5

1. [wykonane dla fixed-step `dt` i `dt/2`] Utrzymywać zieloną bramę jednego
   kroku i accepted-step CPU↔CUDA na pełnej trajektorii.
2. Zakończyć CPU adaptive RK45 z `tolT=1e-6 T` i zapisać accepted-step
   telemetry oraz `m_final`.
3. [wykonane dla `dt` i `dt/2`] Rozszerzyć sweep o trzeci poziom tylko wtedy,
   gdy potrzebny będzie formalny estymator rzędu; obecne dane wykluczają błąd
   czasowy jako dominujące źródło rozjazdu.
4. [wykonane diagnostycznie] Porównać osobno stan relaksacji, trajektorię
   `J=0`, trajektorię napędzaną i izolowany operator Zhang–Li.
5. [wykonane] Zidentyfikować rozbieżność między centralnym v1 a trajektorią
   domyślnego MuMax3: dominuje niedokładność kernela demag przy
   `DemagAccuracy=6`, a nie prefaktor Zhang--Li.
6. [wykonane dla jawnego workloadu] FDM CPU/GPU fixed-step z
   `qualification_reference=converged_demag` jest `validated`; adaptive oraz
   literalny default-golden pozostają poza tym zakresem.

### 5.1. Korekta telemetryki accepted-step

Wcześniejsze `solver_steps.csv` nie były wystarczającym śladem kontrolera,
ponieważ `RunResult.steps` oznaczało wyłącznie wiersze wynikające z
harmonogramu outputów. Dla tego skryptu harmonogram jest pusty, więc wiersz
końcowy nie dowodził accepted/rejected steps. Runner zapisuje obecnie pełny,
niezależny od output cadence ślad w
`solver/accepted_steps.v1.json` (`LLG-TD-ACCEPTED-TRACE-V1`) i na jego podstawie
generuje `solver_steps.csv`, `solver_attempts.csv` oraz `qualification.json`.
Jest to naprawa obserwowalności i nie zmienia bieżącego statusu
`not_evaluated` ani błędu parytetu.

## 6. Literatura

- M. Najafi et al., “Proposal for a standard problem for micromagnetic
  simulations including spin-transfer torque,” *J. Appl. Phys.* **105**,
  113914 (2009), [doi:10.1063/1.3126702](https://doi.org/10.1063/1.3126702).
- A. Thiaville et al., “Micromagnetic understanding of current-driven domain
  wall motion in patterned nanowires,” *Europhys. Lett.* **69**, 990 (2005),
  Zhang–Li advection/non-adiabaticity convention.
