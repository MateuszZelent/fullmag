# FEM GPU — równoległe normy niezależnego certyfikatu Poissona

Status: implementacja źródłowa według kontraktu utworzonego przed kodem;
wykonanie natywne i przyspieszenie
**NOT VERIFIED**. Model fizyczny pozostaje opisany w
[Poisson FEM](fem_demag_poisson.md), a kryterium akceptacji w
[polityce solvera](0532-fem-demag-solver-policy-and-runtime-threading.md).

(problem-statement)=
## Problem i zakres

Każde rozwiązanie Poissona musi mieć niezależnie obliczone normy RHS i
prawdziwego residuum. Dotychczasowa redukcja pary norm używa jednego bloku
CUDA. Dla dużego wektora wątki tego bloku wykonują wiele kolejnych odczytów,
chociaż pozostałe bloki urządzenia mogłyby przetwarzać inne fragmenty.
Zmiana dotyczy wyłącznie organizacji tej redukcji; nie usuwa certyfikatu,
rozwiązania pola, żadnej składowej energii ani próbki Zarr.

| Realizacja | Interpretacja |
|---|---|
| FEM GPU | Dwuetapowa redukcja dużych wektorów w niezależnym certyfikacie Poissona |
| FEM CPU | Dotychczasowa realizacja CPU; bez zmiany kryterium lub sterowania |
| FDM CPU | Nie dotyczy: ta realizacja nie używa właściciela Poissona HYPRE |
| FDM GPU | Nie dotyczy: ta realizacja nie używa właściciela Poissona HYPRE |

(governing-equations)=
## Równania

```{math}
:label: eq-parallel-certificate-system
K\phi=b,\qquad r=K\phi-b,\qquad
\eta=\begin{cases}\|r\|_2/\|b\|_2,&\|b\|_2>0,\\\|r\|_2,&\|b\|_2=0.\end{cases}
```

Certyfikat nadal otrzymuje residuum z osobnego działania aktualnego $K$ na
kandydata $\phi$. Norma rekurencyjna PCG nie zastępuje tej operacji.

Każdy częściowy akumulator przechowuje skalę $s$ i sumę $q$:

```{math}
:label: eq-parallel-certificate-scaled
\|v\|_2=s\sqrt{q},\qquad
q=\sum_i(|v_i|/s)^2.
```

Puste akumulatory mają $s=q=0$. Przy scalaniu dwóch niepustych akumulatorów
zamieniamy je w razie potrzeby, aby $s_a\ge s_b$, po czym obliczamy

```{math}
:label: eq-parallel-certificate-merge
s=s_a,\qquad q=q_a+q_b(s_b/s_a)^2.
```

Nie podnosimy bezpośrednio do kwadratu wartości wejściowych. NaN lub
nieskończoność dowolnego wejścia daje niefinitywną normę odpowiadającego
wektora i dotychczasową odmowę certyfikacji.

(symbols-and-si-units)=
## Symbole i SI

| Token | Znaczenie | SI |
|---|---|---|
| $K$ | Macierz Poissona | $\mathrm{m}$ |
| $\phi$ | Potencjał skalarny | $\mathrm{A}$ |
| $b,r,v$ | RHS, residuum lub wektor redukcji | $\mathrm{A\,m}$ |
| $s,s_a,s_b$ | Skala akumulatora | $\mathrm{A\,m}$ |
| $q,q_a,q_b$ | Skalowana suma kwadratów | $1$ |
| $\eta$ | Raportowana względna norma dla niezerowego RHS | $1$ |
| $n$ | Liczba lokalnych stopni swobody potencjału | $1$ |

Dla zerowego RHS istniejąca polityka interpretuje raportowaną normę
bezwzględnie, w $\mathrm{A\,m}$; zmiana nie wprowadza nowego ilorazu przez zero.

(assumptions-and-validity)=
## Warunki i granice

Wektory mają precyzję double, ten sam rozmiar i istnieją w pamięci GPU.
Oba etapy redukcji, obliczenie residuum i dotychczasowy odczyt norm są
uporządkowane na pożyczonym streamie HYPRE. Zmienia się kolejność dodawania,
więc norma może różnić się o błąd zaokrąglenia; nie deklarujemy bitowej
tożsamości norm ani trajektorii bez wykonania porównania.

Małe wektory zachowują dotychczasową redukcję jednego bloku. Dla $n\ge4096$
siatka ma $\min(256,\lceil n/2048\rceil)$ bloków po 256 wątków. Jest to
wewnętrzny wybór organizacji pracy, bez nowej polityki fizycznej. Próg i
rozmiar siatki podlegają pomiarowi; duży wektor sam nie dowodzi zysku.

(python-api)=
## Python

Nie powstaje nowy przełącznik. Istniejąca polityka zachowuje parametry i
walidację. Poniższe komórki sprawdzają sam obiekt publicznej polityki; nie
uruchamiają symulacji ani nie kwalifikują redukcji GPU. Pełny wzorzec Study,
etapów, materiału i autosave to
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`.
Para pomiarowa używa identycznego skryptu dynamiki i pełnego sąsiedniego Zarr.

```python
# %% Existing public policy; no new numerical-control parameter.
import fullmag as fm
policy = fm.FemLinearSolverPolicy(
    solver="CG", preconditioner="AMG", rtol=1e-12,
    atol=None, max_iterations=500, print_level=0,
)
# %% Inspect the unchanged Python-to-IR representation.
assert policy.to_ir()["rtol"] == 1e-12
assert "atol" not in policy.to_ir()
```

| Parametr | Typ | Domyślnie | SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| FemLinearSolverPolicy.solver | str | CG | $1$ | CG lub GMRES | Solver liniowy | FEM CPU/GPU | backend_policy.discretization_hints.fem.demag_solver_policy.solver |
| FemLinearSolverPolicy.preconditioner | str | AMG | $1$ | AMG, JACOBI lub NONE | Preconditioner | FEM CPU/GPU | backend_policy.discretization_hints.fem.demag_solver_policy.preconditioner |
| FemLinearSolverPolicy.rtol | float | 1e-8 | $1$ | Dodatnia skończona wartość | Względna tolerancja | FEM CPU/GPU | backend_policy.discretization_hints.fem.demag_solver_policy.rtol |
| FemLinearSolverPolicy.atol | float lub None | None | $\mathrm{A\,m}$ | None lub dodatnia skończona wartość | Tolerancja bezwzględna | FEM CPU/GPU | backend_policy.discretization_hints.fem.demag_solver_policy.atol |
| FemLinearSolverPolicy.max_iterations | int | 500 | $1$ | Co najmniej 1 | Limit iteracji | FEM CPU/GPU | backend_policy.discretization_hints.fem.demag_solver_policy.max_iterations |
| FemLinearSolverPolicy.print_level | int | 0 | $1$ | Wartość nieujemna | Poziom logowania | FEM CPU/GPU | backend_policy.discretization_hints.fem.demag_solver_policy.print_level |

(problem-ir)=
## ProblemIR, planner i capability

Nie zmieniamy ProblemIR, planu, requested intent ani wyboru backendu.
Resolved execution pozostaje rzeczywistą realizacją GPU. Zmiana nie dodaje
obsługi FEM-BEM, eigensolve ani nowej kombinacji solvera; wykonuje redukcję
tam, gdzie istniejący właściciel Poissona już wymaga pary norm.

(round-trip-and-failure-semantics)=
## Round-trip, sesja i awarie

Eksport skryptu i import IR zachowują istniejące parametry; validation errors
i unsupported combinations mają dotychczasową semantykę. Brak scratch,
zbyt mała pojemność albo błąd CUDA kończą próbę błędem. Nie uruchamiamy CPU
w zastępstwie. Scratch należy do workspace, powstaje poza hot loop i jest
zwalniany przez jego istniejący lifecycle. Zapis sesji lub Zarr nie wymaga
zachowania odtwarzalnego scratch urządzenia.

(discrete-realization)=
## Realizacja dyskretna i rezydencja

Pierwszy kernel wylicza dla każdego bloku dwie pary $(s,q)$, obejmując całe
oba wejścia przez grid-stride. Drugi scala części i dopiero wtedy zapisuje
dwa wyniki. Granica kerneli na tym samym streamie gwarantuje zakończenie
wszystkich odczytów wejścia, zanim wynik nadpisze jego pierwsze dwa elementy.

Bufor części wymaga czterech double na blok, najwyżej 8192 bajtów. Nie może
aliasować wektorów wejściowych ani dwóch wyników. Oba wyniki mogą nadal
aliasować początek jednego z wejść. Dotychczasowy wrapper ma tę samą
sygnaturę i małe wektory zachowują swoją ścieżkę. Pojedynczy wektor o jednym
elemencie nadal używa osobnego bezpiecznego wrappera.

Końcowy transfer pozostaje jedną parą double: 16 bajtów D2H i jednym
istniejącym fence. Nie dodajemy synchronizacji pomiędzy kernelami, pełnego
wektora D2H, alokacji ani drugiego odczytu norm w hot loop.

(implementation-mapping)=
## Mapa implementacji

Walidacja pozostaje w `validate_demag_poisson_hypre_device_solve`. Właściciel
operatorów przygotowuje scratch przy uploadzie i zwalnia go przy destroy.
Wrapper wieloblokowy korzysta z tego samego skalowanego prawa scalania.
Profil źródeł/biblioteki odróżnia implementacje; dotychczasowe liczniki
certyfikatu, control D2H/fence i wyniki fizyczne pozostają w provenance.
Nie dodajemy prywatnych nowych wyników pomiaru do tej noty.

(validation)=
## Bramy walidacji i kompletność

- [x] Model, SI, skalowanie, aliasing i cztery realizacje opisane przed kodem.
- [x] Publiczny Python, IR, planner i kryterium akceptacji bez zmiany.
- [x] Napisano natywne regresje: małe wektory, wiele bloków, limit siatki i niepełny blok;
  oba legalne aliasy, zera, znaki, NaN/Inf osobno w obu wektorach, wartości
  bardzo małe i duże, odmowa błędnych wskaźników i pojemności. Wykonanie pending.
- [ ] Porównanie norm z niezależną referencją o większej precyzji oraz
  pierwotnym wrapperem; brak dodatkowego transferu/fence i alokacji hot loop.
- [ ] Ten sam SP4 i harmonogram zapisu: energie, pola, torque, unit norm,
  końcowy prawdziwy certyfikat i pełny Zarr; pomiar czasu norm i całego kroku.
- [x] Review źródeł i aktualizacja source-map; brak blokujących usterek w
  ograniczonym przeglądzie integracji. Nie zastępuje to kompilacji ani runtime.
- [ ] Zarządzany build CPU/stub/CUDA i wykonanie testów.

Testy źródeł nie zastępują wykonania kerneli. Wyniki runtime i przyspieszenie
pozostają NOT VERIFIED do uzyskania tych dowodów.

(limitations)=
## Ograniczenia i prace odłożone

Nie zmieniamy rekurencji PCG, tolerancji, preconditionera, początkowego
potencjału ani liczby rozwiązań Poissona na krok. Predyktor zaakceptowanego
potencjału i CUDA Graph dla AMG pozostają oddzielnymi eksperymentami.
Redukcja norm to część kosztu certyfikacji, więc jej przyspieszenie nie
przekłada się wprost na taki sam zysk całego kroku.

(scientific-bibliography)=
## Źródła

- [Model Poissona FEM](fem_demag_poisson.md).
- [Polityka solvera i niezależna certyfikacja](0532-fem-demag-solver-policy-and-runtime-threading.md).
- [Netlib, referencyjne DNRM2, LAPACK 3.1.1](https://www.netlib.org/lapack/lapack-3.1.1/html/dnrm2.f.html):
  skalowane akumulowanie norm. Nota wyprowadza własne prawo scalania;
  implementacja rozszerza istniejący kod Fullmaga.

(parallel-certificate-planned)=
## Stan realizacji

Redukcja dwustopniowa, jej stały scratch i testy istnieją w źródłach.
Mapa wskazuje rzeczywiste symbole. Status native pozostaje NOT VERIFIED;
kontrakt ani source-map nie dowodzą wykonania GPU.

(source-code-index)=
## Indeks źródeł

| Ścieżka | Symbol | Odpowiedzialność i status |
|---|---|---|
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `fullmag_cuda_demag_validation_norm_pair` | Dotychczasowa skalowana para norm i pojedynczy readback |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `fullmag_cuda_demag_validation_norm_pair_parallel` | Dwuetapowa redukcja, aliasing, jedna para D2H i fence; native pending |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_validation_norm_pair_partials_kernel` | Skalowane akumulatory bloków; native pending |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_validation_norm_pair_finish_kernel` | Scalenie części po odczycie obu wektorów; native pending |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.hpp` | `demag_validation_norm_pair_blocks` | Ograniczony wybór siatki bez overflow |
| `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` | `validate_demag_poisson_hypre_device_solve` | Niezależny aktualny residuum i odmowa wadliwego kandydata |
| `backends/fem/gpu/cuda/demag_poisson/operators.cpp` | `upload_demag_poisson_operators` | Właściciel persistent scratch; wykonanie rozszerzenia pending |
| `backends/fem/gpu/cuda/demag_poisson/operators.hpp` | `destroy_demag_poisson_operators` | Właściciel zwalniania scratch; wykonanie rozszerzenia pending |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FemLinearSolverPolicy` | Niezmieniona publiczna polityka |
| `backends/fem/tests/cuda_demag_residual_fixture.hpp` | `check_gpu_hypre_demag_residual` | Fixture wywołuje testy dużej pary norm z niezależną referencją long double/hypot; native pending |
