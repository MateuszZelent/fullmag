# Plan naprawczy wydajności FEM GPU

- **Status:** skorygowany po audycie źródłowym `HEAD`; plan implementacyjny, nie
  dowód wydajności ani kwalifikacja produkcyjna.
- **Repozytorium:** `MateuszZelent/fullmag`
- **Gałąź dokumentacyjna pochodzenia:** `docs/fem-gpu-performance-remediation-2026-09-01`
- **Rewizja bazowa planu:** `4c7897f218eb0c32612db1f43a844502a316b4f6`
- **Rewizja pierwotnego audytu:** `7faa259c5597ba447c413f2aea0ff66d6110b297`
- **Rewizja weryfikacji kodu:** `c3f49db708868f3649a3e894416d230269718920`
- **Data:** 2026-09-01
- **Lane:** natywny FEM GPU, MFEM 4.9, HYPRE 3.1.0, CUDA.
- **Przypadek referencyjny:** µMAG SP4 FEM, `mixed_p1`, `layers=1`, `mesh=medium`,
  `airbox=baseline`, `device=gpu`, double precision.

## 0. Zakres i status dowodów

Pakiet został ponownie sprawdzony względem kodu, testów kontraktowych i
`justfile`. Nie uruchomiono aktualnego managed runtime na GPU, dlatego wyniki
wydajności, parytet urządzenia i kwalifikacja naukowa pozostają `NOT VERIFIED`.
Szczegółowy werdykt dla każdego ID znajduje się w
[10-finding-coverage-matrix.md](10-finding-coverage-matrix.md).

Stosowane statusy:

- `POTWIERDZONE` — diagnoza wynika bezpośrednio z aktualnego kodu;
- `CZĘŚCIOWO` — część mechanizmu już istnieje albo teza wymaga zawężenia;
- `NIEPRAWDA` — opis stanu obecnego jest sprzeczny z kodem;
- `NOT VERIFIED` — oczekiwany wpływ wydajnościowy lub zachowanie runtime nie
  ma aktualnego, immutable receipt z managed GPU.

Pseudokod, nowe pliki, typy i testy w dokumentach 01–09 są celami
implementacyjnymi, o ile nie oznaczono ich jako istniejące. Ścieżki zaczynające
się od `gpu/` lub `cpu/` są względne wobec `backends/fem/`.

## 1. Cel

Celem jest skrócenie czasu rozwiązania FEM GPU bez zmiany równań,
warunków brzegowych, definicji energii, kryteriów zbieżności ani jakości siatki.
Plan zamienia ustalenia audytu na zadania implementacyjne na poziomie:

- właścicieli stanu,
- konkretnych plików i symboli,
- nowych interfejsów wewnętrznych i wersjonowanego C ABI,
- kolejności RED–GREEN–REFACTOR,
- testów poprawności fizycznej i numerycznej,
- benchmarków na rzeczywistym GPU,
- jednoznacznych kryteriów zakończenia.

Nie jest celem sztuczne podniesienie wskaźnika `nvidia-smi`. Metryką główną jest
**wall time do tego samego wyniku**, np. czas zaakceptowanego kroku RK,
czas do `tolA` w relaksacji albo czas symulacji 1 ns przy tej samej dokładności.

## 2. Reguły nienegocjowalne

1. Produkcyjny kod pozostaje w `backends/fem`; Rust runner jedynie orkiestruje.
2. Nie dodawać kolejnych przypadkowych pól do centralnego `Context`. Stan należy
   do modułu: exchange, RK, demag, reductions, relaxation albo runtime diagnostics.
3. Jawne `device=gpu` w trybie strict nie może przechodzić do
   `hybrid_cpu_poisson`, consistent-mass CPU ani innego hostowego operatora.
4. P0 nie luzuje `rtol`, `max_err`, `tolA`, jakości meshu ani fizyki.
5. Każda zmiana wydajności musi mieć:
   - baseline,
   - licznik wykonanej pracy,
   - test parytetu,
   - managed GPU runtime proof.
6. Autorytatywne buildy i testy FEM używają kontenerowych receptur `justfile`.
   Hostowe `cargo`, `cmake` i bezpośrednie binaria są wyłącznie diagnostyką.
7. Nie łączyć wszystkich operatorów w jeden monolityczny kernel bez profilu
   rejestrów i occupancy.
8. Nie włączać globalnego `--use_fast_math`.
9. Nie zmieniać istniejącego ABI przez dopisywanie pól do niewersjonowanych
   struktur. Nowa telemetria i sterowanie muszą mieć wersjonowane struktury.
10. Nie usuwać ścieżki referencyjnej przed kwalifikacją następcy.

## 3. Dokumenty wykonawcze

| Dokument | Zakres |
|---|---|
| [01-runtime-truth-build-and-instrumentation.md](01-runtime-truth-build-and-instrumentation.md) | RT-01, BL-01, baseline, wykonane operatory, wersjonowana telemetria |
| [02-exchange-operator-remediation.md](02-exchange-operator-remediation.md) | EX-01…EX-08, fused xyz CSR, PBC reduction, row mapping, prekomputacja |
| [03-rk-pipeline-and-synchronization-remediation.md](03-rk-pipeline-and-synchronization-remediation.md) | RK-01…RK-06, deferred validation, FSAL, kopie D2D, output mask |
| [04-adaptive-error-controller-remediation.md](04-adaptive-error-controller-remediation.md) | AD-01…AD-03, brak `acos` per node, specjalizacje BS23/DP54 |
| [05-demag-hypre-remediation.md](05-demag-hypre-remediation.md) | DM-01…DM-05, FieldOnly, residual validation, HYPRE, recovery |
| [06-effective-field-reductions-and-memory-remediation.md](06-effective-field-reductions-and-memory-remediation.md) | HF-01, HF-02, RD-01, MEM-01, LLG metric, fuzja redukcji |
| [07-relaxation-preconditioning-remediation.md](07-relaxation-preconditioning-remediation.md) | RL-01, GPU NCG preconditioner, PG-BB/Armijo control |
| [08-operator-planner-partial-assembly-and-autotuning.md](08-operator-planner-partial-assembly-and-autotuning.md) | PA-01, CSR/SpMM/PA, histogram wierszy, kwalifikowany planner |
| [09-pr-sequence-tests-and-definition-of-done.md](09-pr-sequence-tests-and-definition-of-done.md) | kolejność PR, managed gates, rollout, rollback i finalne DoD |
| [10-finding-coverage-matrix.md](10-finding-coverage-matrix.md) | pełne mapowanie ustalenie → kod → test → telemetria → PR |

## 4. Źródłowy i docelowy graf wykonania RK23

Baseline przed remediacją dla zaakceptowanej, adaptacyjnej próby BS23 po
rozgrzaniu FSAL, wyprowadzony z grafu wywołań w `rk_stage_schedule.cu` i
`rk_final_refresh.cu`, wyglądał następująco:

```text
backup D2D
  -> predictor + normalize + host fence
  -> RHS k1 [exchange x3 + demag solve + stage demag energy + H_eff + LLG/max]
  -> predictor + normalize + host fence
  -> RHS k2 [jak wyżej]
  -> accept + normalize + host fence
  -> RHS k3 endpoint [jak wyżej]
  -> adaptive reductions x3 + host fence
  -> ponowny final RHS [jak wyżej]
  -> final energies/observables + host fence
```

W bieżącym worktree ścieżka endpoint/FSAL i FieldOnly jest już zaimplementowana
źródłowo, więc wariant bez odrzuceń może dojść do budżetu P0 poniżej. Dopóki
nie ma managed receipt, tabelę należy czytać jako cel/hipotezę, nie wynik.

Cel P0:

```text
attempt transaction
  -> fused predictor/normalize, deferred finite flag
  -> RHS k1 [exchange xyz + demag FieldOnly + H_eff + LLG bez max]
  -> fused predictor/normalize
  -> RHS k2
  -> exact endpoint candidate + normalize
  -> RHS k3 endpoint
  -> specjalizowana redukcja błędu + jeden control packet readback
  -> accept:
       reuse k3 i endpoint fields
       policz wyłącznie wymagane final metrics
  -> reject:
       restore transaction i powtórz próbę
```

Docelowy budżet no-reject dla adaptacyjnego RK23. Liczby są bramką
implementacyjną, a nie zmierzonym baseline SP4:

| Licznik | Przed | P0 |
|---|---:|---:|
| pełne RHS | 4 | 3 |
| Poisson demag solve | 4 przy aktywnym demag | 3 przy aktywnym demag |
| exchange sparse launches | 12 | 3 |
| stage demag energy kernel + reduce | zależne od aktywnego demag | 0 |
| normalizer host fences | 3 | 0 |
| adaptive host fences | 1 | 1 |
| final-stat host fences | 1 | 0 lub 1 zależnie od output/control mask |

### Orientacyjny wpływ na wall time — hipoteza, nie wynik

Na podstawie samego grafu pracy nie można uczciwie obiecać jednej wartości
procentowej. Dla zwykłego, nieperiodycznego SP4, bez odrzuceń prób i przy
kwalifikacji wszystkich ścieżek P0, mój roboczy szacunek całego kroku to około
**15–30% krótszy wall time** (punkt środkowy około 20–25%). Wynika on głównie z
4 → 3 pełnych RHS/demag solve, usunięcia stage demag energy oraz ograniczenia
launchy exchange; nie jest to pomiar.

W przypadku, w którym Poisson demag dominuje koszt, górna granica może dojść do
około **30–40%**, natomiast przy dominacji innych operatorów, częstych
odrzuceniach lub pozostawieniu ścieżki zgodności zysk może spaść do kilku–
kilkunastu procent. Periodyczny reduced CSR może dać wielokrotny zysk w samym
komponencie exchange względem skanu O(N²), ale zysk całego kroku pozostaje
`NOT VERIFIED` i może być ograniczony przez Poisson, projekcję oraz koszt
liftu.

Powyższe widełki są jedynie hipotezą planistyczną. Do dokumentu kwalifikacyjnego
wolno wpisać wyłącznie medianę/p95 z aktualnego managed GPU receipt dla tego
samego ProblemIR, meshu, tolerancji, runtime bundle i źródła.

Priorytet poniżej jest klasyfikacją inżynierską wynikającą ze struktury kodu,
nie rankingiem udziału w wall time:

| Klasa | Ustalenia | Podstawa |
|---|---|---|
| Błąd skalowania | EX-01 | pełny skan `source_row=0..N` dla każdego wiersza |
| Gwarantowane usunięcie pracy | RK-03, DM-01, DM-02, RK-01, EX-02 | graf wywołań i liczniki pracy |
| Kandydat sprzętowy | EX-03, EX-04, DM-04, DM-05, RL-01, PA-01 | wymaga A/B na rzeczywistym GPU |
| Refaktor architektoniczny | RK-05, HF-02, RD-01 | samodzielnie nie gwarantuje skrócenia czasu |

## 5. Fale realizacji

### Fala A — prawda i baseline

- scalenie istniejących statystyk kroku, endpoint cache, transfer audit,
  execution receipt i fazowych timerów w wersjonowany snapshot pracy,
- zachowanie i rozszerzenie istniejącego fail-closed strict-device receipt,
- zachowanie istniejącego gate'u exportera dla Ada
  (`FULLMAG_FEM_EXPECTED_COMPUTE_CAPABILITY=8.9`, `fullmag_fem=sm_89`,
  `hypre=sm_89`) oraz zastąpienie stałego `sm_89` mapowaniem z wykrytego
  compute capability, związanym z digestem finalnego bundle i benchmark receipt,
- stabilny benchmark SP4 i mikrobenchmark operatorów.

Nie optymalizować przed zapisaniem baseline.

### Fala B — usunięcie pracy zbędnej

- jeden właściciel polityki HYPRE,
- warunkowe `Norml2(rhs)`,
- demag `FieldOnly` w etapach,
- LLG bez redukcji maksimum w etapach,
- statystyki liczone zgodnie z maską zapisu/kontroli.

### Fala C — usunięcie barier i duplikatu endpointu

- deferred normalization status,
- jeden control packet na próbę,
- specjalizowany adaptive error,
- endpoint FSAL reuse dla BS23, następnie DP54.

### Fala D — przebudowa wymiany

- precomputed row scale,
- off-diagonal CSR,
- jeden fused xyz kernel,
- wariant strict/accurate,
- zredukowany operator PBC.

### Fala E — fuzja element-wise i redukcji

- fused xyz `H_eff`,
- lazy materialization,
- wielokanałowe redukcje adaptive/Armijo,
- ograniczenie kopii D2D przez role buforów.

### Fala F — algorytmy

- GPU NCG preconditioner,
- inexact stage Poisson po kwalifikacji,
- planner CSR/SpMM/partial assembly,
- ewentualny CUDA Graph po usunięciu hostowych zależności.

## 6. Kanoniczny przypadek benchmarkowy

Dla `mixed_p1` należy użyć `FULLMAG_SP4_COMPATIBILITY=native`, ponieważ profil
`mumax3` wymaga `all_tet`.

Przykładowa konfiguracja środowiska:

```bash
export FULLMAG_SP4_PHASE=relax
export FULLMAG_SP4_DEVICE=gpu
export FULLMAG_SP4_TOPOLOGY_VARIANT=mixed_p1
export FULLMAG_SP4_LAYERS=1
export FULLMAG_SP4_MESH=medium
export FULLMAG_SP4_AIRBOX=baseline
export FULLMAG_SP4_COMPATIBILITY=native
export FULLMAG_SP4_RELAX_ALGORITHM=llg_overdamped
export FULLMAG_SP4_RELAX_MAX_STEPS=64
export FULLMAG_FEM_STEP_PROFILE=1
```

Autorytatywna ścieżka managed runtime:

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just fem-sp4-run gpu <output_dir>
```

Alternatywnie skrypt może zostać uruchomiony przez aktualny cel
`fem-managed-headless`. `fem-gpu-headless` buduje i uruchamia binarium ad hoc;
jest przydatne diagnostycznie, ale nie stanowi managed-runtime proof.

Istniejące cele `verify-fem-gpu-performance-regression` i
`capture-fem-gpu-pre-remediation-performance-baseline` dotyczą przypadku
`box500`, a nie tej dokładnej konfiguracji SP4. Należy dodać osobny cel SP4,
który utrwali source/runtime identity, ProblemIR i mesh digest, liczniki
rzeczywistej pracy oraz medianę/p95. Przykładowe liczby siatki i zerowe czasy
nie są baseline i nie mogą trafić do zaakceptowanego artefaktu.

## 7. Warunki zakończenia całego programu

Program optymalizacji jest zamknięty dopiero, gdy:

- strict receipt potwierdza wszystkie wymagane operatory na GPU;
- nie ma pełnego H2D/D2H w accepted-step hot loop;
- wszystkie host fences są policzone i mają jawnego właściciela;
- liczba RHS i demag solve odpowiada metodzie;
- periodyczna wymiana nie skanuje `N` węzłów dla każdego wiersza;
- CPU/GPU operator, energia, krok i trajektoria przechodzą parytet;
- SP4 przechodzi bramki przestrzenne, czasowe i energii;
- relaksacja zachowuje dowód Armijo i skraca time-to-`tolA`;
- benchmark raportuje medianę i p95 z rozgrzanych powtórzeń;
- finalny runtime zawiera właściwy cubin/PTX dla testowanego GPU;
- dokumenty architektury, fizyki, capability i provenance są zaktualizowane.
