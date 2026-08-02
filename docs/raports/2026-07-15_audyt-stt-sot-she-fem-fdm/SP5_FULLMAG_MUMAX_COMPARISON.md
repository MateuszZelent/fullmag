# Standard Problem 5: reprodukcja Fullmag i porównanie z MuMax3

**Data audytu:** 2026-08-02
**Status:** reprodukcja źródła i lowering Python → `ProblemIR` wykonane; parzystość numeryczna nie jest jeszcze kwalifikowana.
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

Wynik: `1 passed`. Test potwierdza dwa etapy (`flat_relax`, `flat_run`),
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
    "formula_version": "zhang_li.legacy_fullmag.v0",
    "degree": 1.0,
    "beta": 0.05,
    "current_density": [1e12, 0.0, 0.0]
  }]
}
```

## 3. Wyniki z wykonania

### 3.1. GPU adaptive

Żądanie CUDA z domyślnym RK45 zostało prawidłowo odrzucone przez planner:

```text
adaptive_timestep on FDM CUDA has no executable timestep capability identity;
use runtime_selection.device='cpu' until the CUDA adaptive controller ABI is complete
```

To jest poprawna granica capability, nie błąd do ukrycia przez CPU fallback.

### 3.2. GPU fixed-step — tylko diagnostyka

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

Przegląd implementacji ujawnił konkretny blocker przestrzenny: MuMax3
`external_solvers/3/cuda/zhangli2.cu` używa centralnej różnicy
`(m[i+1]-m[i-1])/(2*cell_size)`, podczas gdy bieżący legacy evaluator Fullmag
(`crates/fullmag-engine/src/fdm/cpu/fields.rs`) używa pierwszego rzędu upwind
wybranego znakiem `J`, `(m_i-m_{i-1})/cell_size`. To wyjaśnia, dlaczego sweep
`dt` nie zmienia plateau. Mapowanie `J/Pol/xi` jest semantyczne, ale operator
nie jest jeszcze MuMax3-compatible; wymagany jest osobny, wersjonowany operator
centralny z oracle jednego kroku.

### 3.3. Defekt artefaktu scalar

W trybie przykładu bez `tableautosave` pliki `scalars.csv` i
`solver_steps.csv` publikują `mx=my=mz=0`, mimo że `m_final.json` zawiera
niezerowe wektory. Dlatego w tym raporcie `m_final.json` jest źródłem średniej,
a kolumny scalar są oznaczone jako otwarty defekt kontraktu publikacji. Nie
wolno traktować zer jako wyniku fizycznego ani używać ich do „zaliczenia” SP5.

## 4. Ocena fizyczna i numeryczna

Potwierdzone:

- literalny rozmiar i topologia siatki są zgodne ze źródłem;
- inicjalizacja vortex i parametry materiału są zachowane w `ProblemIR`;
- `J`, `Pol`, `xi` są mapowane na signed CIP Zhang–Li (`current_density`,
  `degree`, `beta`), a nie na CPP/SHE;
- żądanie niekwalifikowanego CUDA adaptive nie wykonuje cichego fallbacku;
- artefakt pola i provenance urządzenia są zapisane na szybkim dysku
  `/zfn2/mateuszz/git/fullmag`.

Niepotwierdzone:

- zgodność konwencji Zhang–Li z referencyjnym buildem MuMax3 na poziomie
  trajektorii;
- wpływ dokładności i algorytmu przygotowania stanu vortex;
- zgodność demagnetyzacji i kolejności aktualizacji pól;
- pełny CPU adaptive RK45 na `1 ns`;
- zgodność accepted-step scalar publication;
- jakakolwiek kwalifikacja FEM/GPU cross-backend.

Nie należy wyciągać z jednego błędu `m_y` wniosku, że winny jest konkretny
prefaktor lub znak. Różnica dyskretyzacji jest potwierdzonym blockerem, ale
nadal trzeba rozdzielić: (1) niezależny stan po relaksacji, (2) test samego
operatora Zhang–Li z analitycznym polem, (3) zbieżność czasową i (4) zgodność
demagnetyzacji.

## 5. Kryteria zamknięcia SP5

1. Zakończyć CPU adaptive RK45 z `tolT=1e-6 T` i zapisać accepted-step
   telemetry oraz `m_final`.
2. Naprawić lub jawnie zwersjonować publikację `mx/my/mz`, aby zgadzała się z
   wolumenową średnią pola.
3. Przeprowadzić sweep kroku i sprawdzić, czy różnica jest zbieżna do stałej.
4. Porównać osobno stan relaksacji i operator Zhang–Li z niezależnym oracle.
5. Dopiero po przejściu tych punktów oznaczyć FDM CPU/GPU jako `validated`;
   obecny GPU fixed-step pozostaje `diagnostic-unqualified`.

## 6. Literatura

- M. Najafi et al., “Proposal for a standard problem for micromagnetic
  simulations including spin-transfer torque,” *J. Appl. Phys.* **105**,
  113914 (2009), [doi:10.1063/1.3126702](https://doi.org/10.1063/1.3126702).
- A. Thiaville et al., “Micromagnetic understanding of current-driven domain
  wall motion in patterned nanowires,” *Europhys. Lett.* **69**, 990 (2005),
  Zhang–Li advection/non-adiabaticity convention.
