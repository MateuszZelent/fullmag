# FEM GPU. Rezydencja najgrubszego poziomu AMG Poissona

Status opracowania `runtime diagnostic / production unvalidated`. Baseline jest przypięty do commita `a5d8dc5d15d566ebb7156686585ceffc8e4b7c15`, biblioteki `d8703704f4b1fdc7f82333416eee03845d7950fb221b5f788f766a2be809936b` i HYPRE `9dc9e18aed6a945a95f966e57daacfb1c269f6ec`. Wariant GPU wymaga osobnej kwalifikacji czasu i fizyki.

(problem-statement)=
## Zakres

Nota opisuje numeryczną realizację preconditionera AMG w właścicielu Poissona FEM GPU `device_hypre_poisson`; pierwsza próba dotyczy dynamiki SP4. Model pola demagnetyzującego, warunki brzegowe i dyskretyzacja należą do [kanonicznego opisu Poissona](fem_demag_poisson.md). Publiczna polityka solvera należy do [noty 0532](0532-fem-demag-solver-policy-and-runtime-threading.md).

| Realizacja | Zakres tej noty | Dowód |
|---|---|---|
| FEM CPU | Dotychczasowy preconditioner HYPRE z coarse type 9 | Widoczny kod konfiguracji CPU i przypięty kod HYPRE |
| FEM GPU | Kontrolowane porównanie coarse type 9 z type 18 | Baseline i wariant type18 wykonane przy 50 fs; pełny SP4 pozostaje niezakwalifikowany |
| FDM CPU | Nie dotyczy | Ta realizacja nie używa preconditionera Poissona HYPRE |
| FDM GPU | Nie dotyczy | Ta realizacja nie używa preconditionera Poissona HYPRE |

(governing-equations)=
## Równania metody

Poisson tworzy liniowy układ dla potencjału. Preconditioner działa na residualu tego układu.

```{math}
:label: eq-gpu-amg-coarse-system
K\phi=b,\qquad r=b-K\phi,\qquad z=B r.
```

Na najgrubszym poziomie typ 9 rozwiązuje mały układ przez eliminację Gaussa. Typ 18 stosuje relaksację Jacobiego ze skalowaniem $\ell_1$ HYPRE. Ogólną postać jednej relaksacji zapisujemy jako

```{math}
:label: eq-gpu-amg-coarse-relaxation
\phi_c^{(j+1)}=\phi_c^{(j)}+\omega_c D_c^{-1}
\bigl(b_c-K_c\phi_c^{(j)}\bigr).
```

$D_c$ oznacza skalowanie faktycznie obliczane przez przypiętą realizację HYPRE dla type 18. Nie należy zastępować go dowolnie wybraną diagonalą podczas implementacji. Liczbę sweepów i wagę wyznacza istniejąca konfiguracja AMG. Wybór typu 18 odsyła do przypiętego [dispatchera i implementacji relaksacji HYPRE](https://github.com/hypre-space/hypre/blob/9dc9e18aed6a945a95f966e57daacfb1c269f6ec/src/parcsr_ls/par_relax.c). Zmiana coarse cycle może zmienić liczbę iteracji zewnętrznego CG.

(symbols-and-si-units)=
## Symbole i jednostki SI

| Token | Znaczenie | Jednostka SI |
|---|---|---|
| $K, K_c$ | Macierz sztywności Poissona oraz jej najgrubszy poziom | $\mathrm{m}$ |
| $\phi, \phi_c$ | Wektory współczynników potencjału skalarnego | $\mathrm{A}$ |
| $b, b_c$ | Wektor prawej strony i jego ograniczenie do najgrubszego poziomu | $\mathrm{A\,m}$ |
| $r$ | Residual układu Poissona | $\mathrm{A\,m}$ |
| $B$ | Operator preconditionera | $\mathrm{m^{-1}}$ |
| $z$ | Preconditionowany residual | $\mathrm{A}$ |
| $D_c$ | Diagonalne skalowanie relaksacji HYPRE | $\mathrm{m}$ |
| $\omega_c$ | Waga relaksacji | $1$ |
| $j$ | Indeks relaksacji coarse cycle | $1$ |
| $c$ | Indeks najgrubszego poziomu AMG | $1$ |
| $m$ | Jednostkowa magnetyzacja nodalna | $1$ |
| $E_1, E_2$ | Porównywane wartości tego samego składnika energii | $\mathrm{J}$ |
| $\mu_0$ | Stała przenikalności próżni użyta we wspólnej konwersji torque | $\mathrm{H/m}$ |

(assumptions-and-validity)=
## Warunki stosowania

Zakres obejmuje rzeczywistą, podwójną precyzję i aktywny preconditioner AMG w ścieżce Poissona FEM GPU. Wybór coarse type 18 podlega propagacji błędu settera i odczytowi rzeczywiście ustawionego typu. Współdzielony właściciel GPU może obsługiwać więcej niż jeden workflow. Ta próba kwalifikuje wyłącznie opisany SP4; FEM-BEM, eigensolve i pozostałe rodziny wymagają osobnego dowodu. Zbieżność każdego rozwiązania oraz końcowe pola i obserwable stanowią warunek przyjęcia wariantu.

(python-api)=
## Publiczny przykład i polityka

Wykonywalnym przykładem jest `examples/sp4_comparison_20261102/sp4_probe_fem_gpu_strict_fullzarr_50fs_20261107.py`. Zawiera `fm.study`, jawne FEM/GPU/strict/double, geometrię i materiał SP4, istniejący stan początkowy, etap dynamiki i Zarr z polami w chwilach 0 oraz 50 fs. Skrypt i jego hash należy zachować obok wyników.

Publiczne ustawienia pochodzą z `study.fem_demag_solver` i są mapowane w nocie 0532. W tej próbie używamy solvera `CG`, preconditionera `AMG`, `rtol=1e-12` i limitu 500 iteracji. Coarse cycle jest wyborem natywnej realizacji GPU, którego skuteczna wartość musi trafić do provenance.


| Python | Typ | Domyślnie | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| FemLinearSolverPolicy.solver | str | CG | 1 | CG lub GMRES | Wybór zewnętrznej metody liniowej | FEM CPU/GPU | fem.demag_solver_policy.solver |
| FemLinearSolverPolicy.preconditioner | str | AMG | 1 | AMG, JACOBI lub NONE | Wybór preconditionera | FEM CPU/GPU | fem.demag_solver_policy.preconditioner |
| FemLinearSolverPolicy.rtol | float | 1e-8 | 1 | dodatnia skończona wartość | Względna tolerancja residualu; próba używa 1e-12 | FEM CPU/GPU | fem.demag_solver_policy.rtol |
| FemLinearSolverPolicy.atol | float \| None | None | \mathrm{A\,m} | None lub dodatnia skończona wartość | Opcjonalna tolerancja bezwzględnego residualu algebraicznego | FEM CPU/GPU | fem.demag_solver_policy.atol |
| FemLinearSolverPolicy.max_iterations | int | 500 | 1 | wartość co najmniej 1 | Limit iteracji zewnętrznego solvera | FEM CPU/GPU | fem.demag_solver_policy.max_iterations |
| FemLinearSolverPolicy.print_level | int | 0 | 1 | wartość nieujemna | Poziom diagnostyki liniowej | FEM CPU/GPU | fem.demag_solver_policy.print_level |


Poniższy fragment pokazuje wyłącznie publiczny obiekt polityki. Kompletny scenariusz z etapami ma postać opisaną przez [kanoniczny scenariusz SP4](../../tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py); lokalna próba używa zachowanej fixture pełnego Zarr wskazanej powyżej.

```python
# %% Publiczna polityka numeryczna
import fullmag as fm
policy = fm.FemLinearSolverPolicy(
    solver="CG", preconditioner="AMG", rtol=1e-12,
    atol=None, max_iterations=500, print_level=0,
)
# %% Fragment kanonicznego IR tego obiektu, bez uruchamiania solvera
print(policy.to_ir())
```

Wynik `to_ir()` tej polityki:

```json
{"solver": "CG", "preconditioner": "AMG", "rtol": 1e-12, "max_iterations": 500, "print_level": 0}
```

Dla nieskalowanego układu norma euklidesowa residualu algebraicznego ma jednostkę A·m. Taki jest zamierzony bezwzględny próg niezależnej certyfikacji; zależy on od bazy i skalowania macierzy. Trzeba go odróżnić od wewnętrznego kryterium przypiętego CG: MFEM nie włącza `two_norm`, więc HYPRE używa normy preconditionowanej. CPU Fullmag oblicza niezależnie normę `Ax-b`, natomiast obecna walidacja GPU robi to warunkowo, gdy solver nie zgłosił zbieżności. Raportowanego residualu CG nie należy zatem nazywać niezależnym certyfikatem euklidesowym. Ta luka walidacji wymaga osobnej poprawki. W próbach `atol=None`; eksperyment transportu nie zmienia kryterium solvera ani tolerancji.

(problem-ir)=
## ProblemIR

Źródłem kanonicznego IR jest rzeczywisty zaakceptowany projekt tej próby oraz jego zachowane wejście. `FemHintsIR.demag_solver_policy` i rozwiązany `FemPlanIR.demag_solver_policy` niosą wybór CG/AMG, tolerancje i limit iteracji. Coarse type należy do rozwiązanego wykonania natywnego. Poniższy fragment IR pochodzi z `FemLinearSolverPolicy.to_ir()` i opisuje tylko obiekt polityki. Pełny zaakceptowany plan i wejście przechowuje samowystarczalny baseline Zarr.

(round-trip-and-failure-semantics)=
## Odtwarzanie i awarie

Requested intent zachowuje jawne FEM/GPU/strict/double i CG/AMG; resolved execution oraz skuteczny coarse type pochodzą z wykonania. Validation errors obejmują niepoprawną politykę i nieudane ustawienie lub odczyt HYPRE. Unsupported combinations kończą się istniejącym błędem planowania lub inicjalizacji. Eksport i ponowny import zachowują publiczną politykę. Skrypt publiczny, jego hash, source snapshot, hash biblioteki, resolved coarse type i komplet wyników Zarr pozwalają odtworzyć próbę. Niepoprawne ustawienie HYPRE lub niezgodny odczyt coarse type kończy inicjalizację z błędem. Brak zbieżności CG pozostaje błędem rozwiązania zgodnie z istniejącym kontraktem. Historyczne metadane bez jawnej wartości coarse type reprezentują wartość niezaobserwowaną. Nie wolno przypisywać im wyniku nowego gettera.

(discrete-realization)=
## Realizacja i rezydencja

Przypięty HYPRE `hypre_BoomerAMGSetRelaxType` ustawia cycle 0–2 na żądany typ, a cycle 3 na 9. `hypre_GaussElimSetup` dla typu 9 ustawia pamięć GE na host. `hypre_GaussElimSolve` kopiuje RHS na host do `MPI_Allgatherv`, wywołuje hostowe `hypre_gselim` i kopiuje wynik na GPU.

Wariant jawnie ustawia `HYPRE_BoomerAMGSetCycleRelaxType(..., 18, 3)`. GPU i CPU mają odrębne konfiguracje natywne, więc wybór GPU należy zastosować u właściciela GPU. Ustawienie coarse type 99 lub 199 samo w sobie zachowuje hostowy staging MPI w tej przypiętej wersji HYPRE.

(implementation-mapping)=
## Mapa implementacji

- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp::configure_demag_amg` konfiguruje preconditioner ścieżki GPU.
- `backends/fem/core/demag_solver_policy.cpp::resolve_demag_amg_policy_from_environment` jest właścicielem istniejących parametrów profilu AMG.
- `crates/fullmag-runner/src/artifacts.rs::demag_amg_profile_metadata` publikuje skuteczną politykę numeryczną.
- Addytywny getter C ABI odczytuje skuteczną wartość z HYPRE; mapowanie zapisuje ją jako opcjonalne pole metadanych. Istniejący rozmiar `fullmag_fem_step_stats` stanowi granicę zgodności.

(validation)=
## Kwalifikacja

Porównanie wymaga tej samej siatki, stanu początkowego, pola, integratora, requested i effective tolerancji oraz limitu iteracji. Dla każdego rozwiązania zachowujemy residual, liczbę iteracji i wynik sprawdzenia zbieżności. Porównujemy harmonogram zaakceptowanych kroków i odrzuceń.

Bramka pól wymaga różnicy składowych aktywnego $m$ co najwyżej $10^{-7}$. Dla wszystkich ośmiu energii stosujemy istniejący próg $10^{-29}\,\mathrm{J}+10^{-7}\max(|E_1|,|E_2|)$. Różnica torque wymaga progu bezwzględnego $10^{-8}\,\mathrm{A/m}$ plus $10^{-7}$ większej z wartości bezwzględnych obu porównywanych torque. Równoważny próg w teslach to dokładnie ten próg pomnożony przez $\mu_0=4\pi\,10^{-7}\,\mathrm{H/m}$; osobno sprawdzamy samą konwersję jednostek. Dane Zarr zawierają obie ramki pól, a końcowa ramka musi odpowiadać natywnemu stanowi zaakceptowanemu.

CUPTI musi przejść bramkę `clock_monotonic`, mieć właściwą tożsamość procesu i GPU oraz zerowe liczniki utraty, błędów i obcięć. Liczby transferów 24 B są wskazówką do weryfikacji coarse path. Brak call stacków wymaga ostrożności przy przypisywaniu wszystkich zdarzeń do konkretnego callsite. Przyspieszenie wymaga dopasowanej instrumentacji oraz oddzielnego pomiaru inicjalizacji i kroków solvera.

(limitations)=
## Ograniczenia dowodu

Baseline 50 fs obejmuje siedem kroków. Nie stanowi kwalifikacji pełnej dynamiki 1 ns, innych stanów ani siatek. Parytet CUPTI ON/OFF potwierdza wpływ instrumentacji. Zgodność FEM z MuMax3 GPU i błąd siatki są odrębnymi wymaganiami całego SP4.


### Wykonany eksperyment 50 fs

Wariant jest przypięty do snapshotu `f559662ac7601a3748a6b859937301bc87b3751cd7ac54d7fd63d9b2b135c7d9` i biblioteki `2a570d033ea478ca70bc9c80174aa723d5b93b8bd5797e3a823edf3903ccb016`. Obie próby wykonały siedem kroków do 50 fs i 43 wywołania RHS/demag w krokach 1–7, zachowując po dwie ramki tabeli i osiem klatek pól Zarr. Native build i kontrakt CUPTI przeszły; w tym pakiecie dodana regresja `fem_demag_poisson_contract` nie była wykonywana. Jej późniejsze wykonanie opisuje sekcja transportu poniżej.

| Pomiar | Coarse type 9 | Coarse type 18 |
|---|---:|---:|
| Transfery 24 B host → device w śladzie | 1712 | 0 |
| Transfery 24 B device → host w śladzie | 1712 | 0 |
| Transfery 24 B device → device w śladzie | 0 | 1711 |
| Czas solvera kroków 1–7, pierwsza próba OFF | 3,878567087 s | 4,182894412 s |

Końcowe osiem energii, aktywne $m$ i torque mieszczą się w zadeklarowanych progach. Maksymalna różnica składowych aktywnego $m$ wynosi $3{,}33\times10^{-16}$, a różnica torque wynosi około $-2{,}13\times10^{-9}\,\mathrm{A/m}$. Wewnętrzne adaptacyjne czasy i kroki różnią się od coarse9; największa różnica czasu to około $4{,}62\times10^{-19}\,\mathrm{s}$. Pierwotna bramka identyczności harmonogramu pozostała nieudana. Nie oznaczamy tego porównania jako identycznego obciążenia czasowego ani jako dowodu przyspieszenia.

Para type18 CUPTI ON/OFF ma identyczne wszystkie 15 kolumn obu ramek tabeli, wszystkie cztery pola w obu klatkach, natywną magnetyzację końcową, torque oraz harmonogram z raportowanymi residualami i iteracjami. Ślad ma 514161 rekordów i przeszedł bramkę `clock_monotonic`. Stary ślad type9 ma tabelaryczny Zarr, nowy zapisuje pełne pola; wszystkich różnic transferów wyjściowych i czasu nie wolno przypisywać wyłącznie zmianie coarse cycle.

Usunięcie małych transferów zgadza się ze zmianą źródłową i getterem. W tym śladzie nadal pozostają hostowe rekurencje PCG oraz 318 wywołań `cudaMemcpy2D`. Osobny eksperyment transportu porównuje pakowanie pól z tym samym wariantem coarse18.

Raport `coarse18-qualified-cupti-pair-b47ec3b6f81101ed.json` ma SHA-256 `b47ec3b6f81101ed5c9a3faa94dc0a174f4afc347c6784b6312c8b3408ace580`. Raport endpointu `coarse18-off-experiment-4689e091ba360525.json` ma SHA-256 `4689e091ba3605252a79df413ef66ce9e9d37b0eae322148e5fd79a0668d2f9d`. Oba zachowują pierwotne wyniki bramki harmonogramu; analiza nie powtarzała Solve.

### Osobny eksperyment pakowania pól

Kolejny wariant zmienia wyłącznie układ transportu jedenastu pól bieżącego snapshotu. Osobny bufor AoS o rozmiarze `24*N` bajtów należy do `FemGpuState`, jest alokowany przy inicjalizacji, wliczany do `device_bytes` i zwalniany przy teardown. Kernel pakuje komponenty SoA bez arytmetycznej zmiany wartości double; jeden ciągły D2H na jawnym `compute_stream` zastępuje trzy transfery 2D o szerokości 8 B. Funkcja nadal kończy się dopiero po gotowości wektora hostowego. Odmowa przy brakującym streamie, buforze albo niespójnej pojemności nie publikuje udanego transferu.

Ta ścieżka nie zmienia kadencji, zestawu obserwabli, solvera liniowego ani równań. Magnetyzacja, publiczny asynchroniczny snapshot pool i pozostali konsumenci zachowują dotychczasowe funkcje transferu. Test porządku składowych, dokładnych wartości, liczników i teardown należy do istniejącego `fem_demag_poisson_contract`, który ma zależność CUDA.

Zarządzany build snapshotu `35192e8ad570554d0ae9313b27c2e596fbea663d6f42944dda614042f6fcbadc` i biblioteki `43347eab9656762a821ad0caa616e4286586162899352c519f3a8d2e24f8b98e` przeszedł kontrakt Poissona. Test wykonał się na GPU, potwierdzając marker `packed_field_download_runtime_executed nodes=263`. Osobne próby SP4 OFF i ON przeszły wszystkie dotychczasowe bramki. Obie klatki czterech pól i 15 kolumn tabeli są dokładnie równe między OFF/ON oraz między nowym OFF i zachowanym coarse18 OFF. Natywne końcowe `m`, torque, czasy, `dt`, residuale i iteracje są identyczne OFF/ON.

| Pomiar pełnego śladu | Coarse18 | Pakowanie snapshotów |
|---|---:|---:|
| `cudaMemcpy2D` | 318 | 252 |
| Operacje D2H | 4056 | 4012 |
| Bajty D2H | 92 397 916 | 92 397 916 |
| Kernel pakowania snapshotów | 0 | 22 |
| Pierwszy czas solvera OFF | 4,182894412 s | 3,836000881 s |
| Pierwszy czas solvera ON | 4,464906253 s | 4,228889554 s |

Ślad ON ma 514199 rekordów, poprawny zegar `clock_monotonic` i zerowe liczniki błędów, utraty oraz obcięć. Dwadzieścia dwa pakowania zastąpiły 66 strided kopii przez 22 ciągłe D2H. Nie zmniejszyła się liczba przesłanych bajtów. Pozostałe 252 wywołania obejmują także uploady; nie należy dzielić tej liczby przez trzy i nazywać wyniku liczbą downloadów.

Niższe czasy w pojedynczej parze OFF i ON są obserwacją krótkiej próby, bez serii powtórzeń ani kwalifikacji przyspieszenia pełnego SP4. Pełne wywołania zarządzane obejmują dodatkowo aktywację, inicjalizację i zachowanie wyników; nie są równe czasowi solvera. Raport `packed-fields-qualified-cupti-pair-a6f7b5c5700b97e8.json` ma SHA-256 `a6f7b5c5700b97e88b64d4d8c47dd3329c3468530c3194d92b58f70eaa79e166`. Dane pozostają pełnym Zarr z sąsiednim skryptem; analiza nie powtarza Solve.

(scientific-bibliography)=
## Źródła

- [HYPRE, przypięty kod AMG i eliminacji Gaussa](https://github.com/hypre-space/hypre/tree/9dc9e18aed6a945a95f966e57daacfb1c269f6ec/src/parcsr_ls). Commit `9dc9e18aed6a945a95f966e57daacfb1c269f6ec`.
- [HYPRE BoomerAMG: relaksacja i konfiguracja coarse cycle](https://hypre.readthedocs.io/en/latest/solvers-boomeramg.html). Interpretacja wariantu odnosi się do przypiętego kodu powyżej.
- [Przypięty MFEM: domyślna konfiguracja HyprePCG](https://github.com/mfem/mfem/blob/d964264cdb9a13e94a201b6c236c7721e0c8765f/linalg/hypre.cpp#L3958) i [HYPRE: kryterium PCG](https://github.com/hypre-space/hypre/blob/9dc9e18aed6a945a95f966e57daacfb1c269f6ec/src/krylov/pcg.c#L390) określają normę wewnętrzną, odrębną od niezależnej certyfikacji residualu.
- Nota 0532 i kanoniczny opis Poissona stanowią właścicieli publicznej polityki oraz wspólnej fizyki.

(source-code-index)=
## Indeks kodu i dowodów

| Roszczenie | Właściciel | Stan dowodu |
|---|---|---|
| Domyślny coarse type 9 | Przypięty HYPRE `hypre_BoomerAMGSetRelaxType` | Potwierdzony w źródle |
| Hostowy coarse solve | Przypięty HYPRE `hypre_GaussElimSetup` i `hypre_GaussElimSolve` | Potwierdzony w źródle. Ślad transferów jest zgodny z mechanizmem |
| GPU coarse type 18 | `configure_demag_amg` | Getter potwierdził 18 w ukończonych próbach 50 fs |
| Skuteczna polityka w wynikach | `demag_amg_profile_metadata` | Zaobserwowane 18 w natywnych metadanych obu prób |
| Parytet i czas | Pełny baseline Zarr i para native/CUPTI | Endpoint energii/m/torque przeszedł; identyczność harmonogramu ze starym wariantem nie przeszła |

| Ścieżka | Symbol | Odpowiedzialność | Realizacja i dowód |
|---|---|---|---|
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `configure_demag_amg` | Ustawienie i kontrola coarse cycle18 wyłącznie w GPU AMG. | FEM; kod źródłowy, wariant GPU runtime niezweryfikowany |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `read_device_demag_amg_coarse_relax_type` | Odczyt skutecznej polityki z kontrolą lifecycle i flag HYPRE. | FEM; kod źródłowy, wariant GPU runtime niezweryfikowany |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_get_gpu_demag_amg_coarse_relax_type_v1` | Addytywny getter C ABI bez zmiany rozmiaru istniejących struktur. | FEM; kod źródłowy, wariant GPU runtime niezweryfikowany |
| `backends/fem/core/demag_solver_policy.cpp` | `resolve_demag_amg_policy_from_environment` | Dotychczasowe parametry profilu AMG. | FEM; kod źródłowy, wariant GPU runtime niezweryfikowany |
| `crates/fullmag-runner/src/artifacts.rs` | `demag_amg_profile_metadata` | Publikacja zaobserwowanego coarse type albo null dla braku obserwacji. | FEM; kod źródłowy, wariant GPU runtime niezweryfikowany |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Publiczne domyślne wartości, walidacja i serializacja polityki. | FEM; kod źródłowy, wariant GPU runtime niezweryfikowany |
| `crates/fullmag-ir/src/mesh_hints.rs` | `FemHintsIR` | Opcjonalna polityka FEM w kanonicznym ProblemIR. | FEM; kod źródłowy, wariant GPU runtime niezweryfikowany |
| `crates/fullmag-ir/src/plan.rs` | `FemPlanIR` | Rozwiązana polityka przekazana do wykonania FEM. | FEM; kod źródłowy, wariant GPU runtime niezweryfikowany |

| `backends/fem/gpu/cuda/demag_poisson/operators.cpp` | `build_p1_demag_operators` | Tworzy dyskretny operator i sprzężenia Poissona. | FEM GPU; dotychczasowa implementacja układu i residualu |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `validate_demag_poisson_hypre_device_solve` | Warunkowo liczy normę Ax-b i RHS; przy sukcesie CG może używać raportowanej normy preconditionowanej. | FEM GPU; niezależna certyfikacja euklidesowa pozostaje otwartą luką |
| `backends/fem/gpu/cuda/state/gpu_state.cpp` | `gpu_state_download_component_aos_packed` | Wymaga własnego persistent scratch i jawnego streamu; nie zmienia innych konsumentów transferu. | FEM GPU; test natywny i pełny Zarr OFF/ON przeszły przy 50 fs; pełny SP4 niezakwalifikowany |
| `backends/fem/gpu/cuda/transfer/component_transfer.cpp` | `gpu_component_download_aos_packed` | Pakuje GPU SoA do AoS, wykonuje jeden ciągły D2H i synchronizuje przed odczytem hosta. | FEM GPU; test natywny i pełny Zarr OFF/ON przeszły przy 50 fs; pełny SP4 niezakwalifikowany |
| `backends/fem/gpu/cuda/transfer/transfer_kernels.cu` | `fullmag_cuda_pack_soa_to_aos` | Uruchamia kernel kopiujący double bez zmiany wartości lub kolejności składowych. | FEM GPU; test natywny i pełny Zarr OFF/ON przeszły przy 50 fs; pełny SP4 niezakwalifikowany |
| `backends/fem/tests/demag_poisson_contract.cpp` | `packed_snapshot_field_download_is_runtime_correct_and_fails_closed` | Test GPU:263 węzły, kolejność, dokładne wartości, audit, odmowy i teardown. | FEM GPU; natywny test i para SP4 OFF/ON przeszły przy 50 fs |

Baseline pełnego Zarr ma run `run-live-57903f099c8ab012d5d2d49b6086904a8c80204059f72b12c7df354cca9c5949`, dwie próbki tabeli, osiem klatek pól i zamknięcie energii 0 J. Oryginalny wrapper zakończył się po udanym Solve błędem nazwy helpera torque; odczytowe odzyskanie postprocessingu nie powtarzało Solve. Receipt `postprocess-recovery-d6fe4d9e7c67487b.json` ma SHA-256 `d6fe4d9e7c67487b5b15609f93501c1d916f1fe0f42f0947cf4039bd6fae118c`. To dowód bazowej wersji type9, nie pomiar przyspieszenia type18.
