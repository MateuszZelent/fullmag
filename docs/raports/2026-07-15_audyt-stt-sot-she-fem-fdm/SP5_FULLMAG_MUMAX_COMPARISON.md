# Standard Problem 5: reprodukcja Fullmag i porównanie z MuMax3

**Data audytu:** 2026-08-03
**Status:** reprodukcja źródła, wersjonowany operator MuMax3 Python → `ProblemIR` → FDM CPU/CUDA oraz świeży przebieg na RTX 4080 SUPER wykonane; izolowana brama jednego kroku CPU↔CUDA przechodzi, ale pełna trajektoria nie spełnia tolerancji MuMax3, więc kwalifikacja produkcyjna pozostaje otwarta.
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
centralnej różnicy `(m[i+1]-m[i-1])/(2*cell_size)`, podczas gdy legacy Fullmag
używa pierwszego rzędu upwind. Nowy operator nie zmienia starej ścieżki i musi
zostać zmierzony osobno po przebudowie runtime.

### 3.3. Wersjonowany operator i bramy implementacyjne

Dodano `zhang_li.mumax3.v1` / `zl_mumax3_central_v1`:

- Python wymaga `id`, `target`, `lande_g` i jawnej wersji operatora;
- walidacja IR nie pozwala pomylić wariantu MuMax3 z FEM `zl_central_reference_v1`;
- `FdmPlanIR` zachowuje formułę, operator, target i Landé dla provenance;
- FDM CPU używa stałych `mu_B=9.2740091523e-24`, `e=1.60217646e-19`, centralnego
  clamp/PBC stencilu i pojedynczej projekcji Gilberta;
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
trajektorii. CPU pełnego przebiegu przerwano po kroku 550 relaksacji z powodu
kosztu demagnetyzacji; CPU algebraic oracle i ścieżka planowania pozostają
zielone, ale nie zastępują pełnego CPU trajectory gate.

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
  `/zfn2/mateuszz/git/fullmag`.

Niepotwierdzone:

- zgodność konwencji Zhang–Li, stanu po relaksacji i demagnetyzacji z
  referencyjnym buildem MuMax3 na poziomie trajektorii (nowy operator jest
  wykonywalny, lecz wynik nie mieści się w tolerancji);
- wpływ dokładności i algorytmu przygotowania stanu vortex;
- zgodność demagnetyzacji i kolejności aktualizacji pól;
- pełny CPU adaptive RK45 na `1 ns`;
- CPU accepted-step scalar publication dla pełnego przebiegu;
- jakakolwiek kwalifikacja FEM/GPU cross-backend.

Nie należy wyciągać z jednego błędu `m_y` wniosku, że winny jest konkretny
prefaktor lub znak. Różnica dyskretyzacji jest potwierdzonym blockerem, ale
nadal trzeba rozdzielić: (1) niezależny stan po relaksacji, (2) test samego
operatora Zhang–Li z analitycznym polem, (3) zbieżność czasową i (4) zgodność
demagnetyzacji.

## 5. Kryteria zamknięcia SP5

1. Utrzymywać zieloną bramę jednego kroku CPU↔CUDA i rozszerzyć ją do accepted-step
   parity na pełnej trajektorii.
2. Zakończyć CPU adaptive RK45 z `tolT=1e-6 T` i zapisać accepted-step
   telemetry oraz `m_final`.
3. Przeprowadzić sweep kroku i sprawdzić, czy różnica jest zbieżna do stałej.
4. Porównać osobno stan relaksacji i operator Zhang–Li z niezależnym oracle.
5. Zidentyfikować rozbieżność między centralnym v1 a trajektorią MuMax3
   (demag, relaksacja, kolejność aktualizacji lub prefaktor) na kontrolowanych
   testach, zanim zmieni się wzór produkcyjny.
6. Dopiero po przejściu tych punktów oznaczyć FDM CPU/GPU jako `validated`;
   obecny GPU fixed-step pozostaje `diagnostic-unqualified`.

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
