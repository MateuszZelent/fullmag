# Obserwowalność wykonania CPU Schur/SLEPc dla modalnego FEM

- Status: FEM CPU `source_visible / unvalidated`; zmiana publikuje metryki
  wykonania, ale nie zawiera świeżego managed runtime ani kwalifikacji
  numerycznej lub fizycznej
- Owners: Fullmag FEM frequency-domain backend
- Last updated: 2026-10-01
- Related physics: `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- Related audit: `docs/audits/2026-10-01-eigensolve-window-performance.md`

Ta nota opisuje diagnostykę kosztu produkcyjnego operatora Schura dla
modalnego rozwiązania FEM. Metryki służą do rozdzielenia czasu materializacji
preconditionera, przygotowania konkretnego przesunięcia i `EPSSolve`. Nie
zmieniają macierzy, progów zbieżności, fizyki ani tożsamości wejścia.

(problem-statement)=
## 1. Zakres fizyczny i granica dowodu

Operator jest realizacją liniaryzacji FEM z dynamicznym polem
demagnetyzującym, opisanej w nocie 0831. Ta zmiana dotyczy wyłącznie
FEM CPU z PETSc/SLEPc i produkcyjnym `MatShell`. Nie jest dowodem wykonania
GPU, FDM, zgodności z COMSOL-em, zbieżności siatki ani poprawności relacji
dyspersji.

| Solver | Urządzenie | Stan | Granica dowodu |
|---|---|---|---|
| FEM | CPU | `source_visible / unvalidated` | Źródła operatora i przygotowany test natywny; brak aktualnego managed runtime w tej nocie. |
| FEM | GPU | `not-applicable` | Ta diagnostyka jest własnością CPU Schur; GPU ma odrębny kontrakt metryk. |
| FDM | CPU | `not-applicable` | Brak zmiany realizacji FDM. |
| FDM | GPU | `not-applicable` | Brak zmiany realizacji FDM. |

Diagnostyka nie jest częścią publicznego C ABI żądania ani wyniku. Dodane pola
`PoissonAirboxModalEigenResult` są wewnętrznym rekordem C++ i są serializowane
do istniejącego JSON-u operatora. `production_cpu_modal_eigen.cpp` zachowuje
przepuszczanie tego JSON-u przez pole `operator_diagnostics`.

(governing-equations)=
## 2. Równania operatora i mierzonych faz

Niech $n_q$ oznacza liczbę rzeczywistych stopni swobody części magnetycznej.
Realny split ma wymiar:

```{math}
:label: eq-schur-observability-real-split
s=2n_q,
\qquad
q_s=(q_r,q_i)\in\mathbb R^{s}.
```

Po eliminacji potencjału operator Schura tworzy część lewą rzeczywistego
zespolonego pencilu. Po normalizacji masy i skali częstotliwości, dla
bezwymiarowego przesunięcia $\tau$ SLEPc rozwiązuje problem

```{math}
:label: eq-schur-observability-eps-pencil
A_s y=\lambda M_s y,
\qquad
P_s(\tau)=A_s-\tau M_s.
```

`A_s` i `M_s` przekazywane do `EPSSetOperators` pozostają odpowiednio
`schur_shell` i `split_mass`. Macierz materializowana przez
`create_production_exact_shift_preconditioner` jest używana jako
preconditioner dla STSINVERT:

```{math}
:label: eq-schur-observability-preconditioner
\widehat P_s(\tau)=S_s(0)-\tau M_s,
\qquad
S_s(0)e_j=A_s e_j.
```

Nie jest to zamiana operatora EPS na macierz gęstą. Dla małego okna cache
$S_s(0)$ jest tworzony raz i współdzielony przez przesunięcia, jeżeli
$s\leq512$. Dla pojedynczego przesunięcia istniejący limit materializacji
wynosi $s\leq8192$. Poza tymi limitami wybierany jest istniejący magnetyczny
preconditioner iteracyjny.

Metryki są definiowane jako różnice liczników i pomiarów zegara monotonicznego:

```{math}
:label: eq-schur-observability-metrics
N_{\mathrm{PC}}=N_{\mathrm{Poisson}}^{\mathrm{after}}
-N_{\mathrm{Poisson}}^{\mathrm{before}},
\qquad
t_{\mathrm{build}}=t_1-t_0,
\qquad
t_{\mathrm{shift}}=t_2-t_0,
\qquad
t_{\mathrm{EPS}}=t_3-t_2.
```

W oknie $t_{\mathrm{build}}$ i $N_{\mathrm{PC}}$ dotyczą wspólnej budowy
cache. Dla późniejszego przesunięcia `status=cache_reused`; powtórzenie tych
wartości w śladzie nie oznacza ponownego kosztu. Czas `shifted_setup_seconds`
obejmuje wyłącznie przygotowanie konkretnej macierzy przesunięcia
(`MatDuplicate`/`MatAXPY`), więc nie nakłada się na pierwszy
`construction_seconds`. Dla pojedynczego przesunięcia exact materializacja
jest całą fazą przygotowania preconditionera i `shifted_setup_seconds` pozostaje
`null`; dla magnetycznego fallbacku mierzony jest jego własny setup.
`eps_solve_seconds` obejmuje wywołanie `EPSSolve` wraz z jego błędem lub
przerwaniem.

(symbols-and-si-units)=
## 3. Symbole, pola i jednostki SI

| Symbol/pole | Znaczenie | Jednostka lub typ |
|---|---|---|
| $n_q$ / `q_dof_count` | stopnie swobody części magnetycznej | liczba całkowita, bez jednostki |
| $s$ / `split_dof_count` | wymiar realnego splitu | liczba całkowita, bez jednostki |
| `phi_dof_count` | stopnie swobody potencjału skalarnego | liczba całkowita, bez jednostki |
| `augmented_dof_count` | pełny wymiar z ewentualnym wierszem gauge | liczba całkowita, bez jednostki |
| `dimension` | wymiar materializowanego preconditionera | liczba całkowita, bez jednostki |
| `column_count` | liczba zakończonych kolumn materializacji | liczba całkowita, bez jednostki |
| $N_{\mathrm{PC}}$ / `construction_poisson_solve_count` | przyrost natywnych solve'ów Poissona podczas budowy | liczba całkowita, bez jednostki |
| $t_{\mathrm{build}}$, $t_{\mathrm{shift}}$, $t_{\mathrm{EPS}}$ | czasy faz wykonania | s |
| $\tau$ | cel po skalowaniu pencilu | 1; fizyczny cel dzielony przez skalę częstotliwości kątowej |
| $\phi$ | współczynniki potencjału skalarnego | A |

Tabela kontraktowa używa również stabilnych, maszynowo mapowanych nazw:

| Identyfikator | Zapis | Znaczenie | Jednostka SI |
|---|---|---|---|
| n_q | n_q | magnetic DOF count | 1 |
| s | s | real-split DOF count | 1 |
| q_s | q_s | real-split magnetic vector | 1 |
| A_s | A_s | scaled real-split Schur operator | 1 |
| M_s | M_s | real-split mass operator | 1 |
| P_s | P_s | scaled shifted real-split preconditioner | 1 |
| S_s | S_s | scaled zero-shift Schur action | 1 |
| e_j | e_j | j-th canonical basis vector | 1 |
| tau | \tau | scaled spectral shift | 1 |
| N_PC | N_{\mathrm{PC}} | Poisson solves during exact preconditioner construction | 1 |
| t_build | t_{\mathrm{build}} | shared exact-cache construction time | s |
| t_shift | t_{\mathrm{shift}} | one shifted preconditioner setup time | s |
| t_EPS | t_{\mathrm{EPS}} | one EPSSolve duration | s |
| phi | \phi | scalar-potential coefficient | A |

Jednostki w wierszach $A_s$, $M_s$, $P_s$ i $S_s$ opisują bezwymiarową
reprezentację algebraiczną pencilu po skalowaniu FE. Kod używa
`mass_scale=1/descriptor_mass_norm` oraz
`operator_scale=mass_scale/angular_frequency_scale`. Dlatego $\lambda$ i
$\tau$ w powyższym problemie EPS są bezwymiarowe; fizyczna wartość własna
jest odtwarzana przez mnożenie przez `angular_frequency_scale`, w
$\mathrm{s^{-1}}$. Analogicznie `target_eigenvalue_scaled` jest ilorazem
fizycznego celu kątowego i tej skali. Surowe wpisy macierzy FE przed
normalizacją zachowują czynniki geometrii i objętości; nie mają jednostek
przypisanych w tabeli znormalizowanego problemu.

`null` oznacza, że faza nie została wykonana albo nie ma wiarygodnego pomiaru.
Dotyczy to także `exact_preconditioner.dimension`, gdy materializacja została
wyłączona, nie rozpoczęła się albo nie utworzyła używalnej macierzy. Zero jest
zachowywane tylko jako rzeczywiście zmierzona wartość. `split_dof_count` nadal
opisuje rozmiar operatora niezależnie od exact cache. Liczniki DOF pochodzą z
konfigurowanego kontekstu operatora, a nie z hardkodowanego pilota.

(assumptions-and-validity)=
## 4. Założenia i ważność

- Kontekst jest własnością produkcyjnego CPU Schur i pozostaje związany z
  `schur_shell`, `split_mass` oraz persistent Poisson setup.
- `split_dof_count=2*q_dof_count` jest publikowane dopiero po skonfigurowaniu
  kontekstu. Wartość partial `column_count` jest liczbą ukończonych kolumn;
  nie jest równoważna sukcesowi całej materializacji.
- Statusy i czasy są metrykami wykonania. Nie wchodzą do hasha operatora,
  pencilu, planu, preconditionera ani dependency digestu.
- Anulowanie i błędy zachowują już zebrane liczniki; brakujące fazy pozostają
  `null`. Nie wolno traktować kolejki, źródłowego testu ani samego JSON-u jako
  dowodu runtime.

(python-api)=
## 5. Python API

Brak zmiany publicznego `packages/fullmag-py`. Python nadal deklaruje problem,
materiał, siatkę i żądanie wykonania; nie steruje wewnętrznym pomiarem
`steady_clock` ani limitami materializacji. JSON diagnostyczny jest artefaktem
wykonania i nie staje się parametrem DSL.

Przykład inspekcji diagnostyki jest samodzielny i nie uruchamia solvera:

```python
# %%
import json

# %%
diagnostics = json.loads(
    '{"fixture": "synthetic", "q_dof_count": 128, "split_dof_count": 256, '
    '"exact_preconditioner": {"status": "cache_reused"}}'
)

# %%
assert diagnostics["split_dof_count"] == 2 * diagnostics["q_dof_count"]
assert diagnostics["exact_preconditioner"]["status"] in {
    "cache_built",
    "cache_reused",
}
```

(problem-ir)=
## 6. ProblemIR i provenance

`ProblemIR` nie otrzymuje nowych pól. `requested_execution` i
`resolved_execution` zachowują dotychczasowe znaczenie. Telemetria nie może
zmienić canonical preimage ani żadnego operator/dependency digestu; ten sam
problem musi mieć tę samą tożsamość niezależnie od czasu i liczby iteracji.

(round-trip-and-failure-semantics)=
## 7. Round-trip i błędy

`production_cpu_modal_eigen.cpp::with_operator_diagnostics` przenosi obiekt
diagnostyczny do wyniku. Wartości kontrolowane przez backend są serializowane
bez ręcznego wklejania danych użytkownika. Gdy bufor śladu okna nie mieści
całego harmonogramu, istniejący fail-closed marker
`[{"status":"diagnostics_truncated"}]` pozostaje poprawnym JSON-em i wynik
nie może być uznany za pełny certyfikat okna. Jeżeli zewnętrzny bufor
`diagnostics_json` nie mieści całego dokumentu, writer zastępuje częściowy
zapis krótkim, poprawnym JSON-em z `status=unavailable`,
`reason=diagnostics_json_truncated` i `diagnostics_json_truncated=true`.

`requested intent` opisuje żądany przez autora solver i urządzenie, a
`resolved execution` opisuje faktycznie wybraną realizację CPU Schur.
`validation errors` zatrzymują wykonanie przed przypisaniem metryk fazy, zaś
`unsupported combinations` pozostają jawnym stanem capability i nie są
zamieniane na fallback. Diagnostyka faz, która nie została osiągnięta, ma
wartość `null`.

(discrete-realization)=
## 8. Realizacja dyskretna

`ProductionCpuOperatorContext::schur.q_count` i `phi_count` opisują faktycznie
utworzony kontekst. `split_count` jest wymiarem macierzy realnego splitu.
`create_production_exact_shift_preconditioner` stosuje produkcyjny MatShell do
wektorów bazowych, rejestruje każdą zakończoną kolumnę i mierzy przyrost
licznika Poissona. `create_production_cached_window_preconditioner` odróżnia
`cache_built`, `cache_reused`, `cache_construction_failed`,
`cache_shift_matrix_failed` i `cache_reused_after_shift_failure`.
Po nieudanym `MatDuplicate`/`MatAXPY` flaga `shift_failure_observed` pozostaje
ustawiona także po późniejszym udanym reuse. Agregat okna nie zgłasza wtedy
exact preconditionera jako używalnego dla całego okna, a jego wymiar jest
`null`.

Preconditioner exact pozostaje własnością STSINVERT. `EPSSetOperators` nadal
otrzymuje `schur_shell` i `split_mass`; zmiana nie wprowadza dense route dla
operatora modalnego i nie zmienia limitu okna 512.

(implementation-mapping)=
## 9. Mapowanie na kod

- `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp::PoissonAirboxModalEigenResult` — wewnętrzne pola wymiarów, statusów, liczników i czasów.
- `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp::ProductionCpuOperatorContext` — stan cache i pomiar budowy.
- `...::create_production_exact_shift_preconditioner` — kolumny exact preconditionera i licznik Poissona.
- `...::create_production_cached_window_preconditioner` — budowa/reuse cache i statusy przesunięcia.
- `...::solve_poisson_airbox_modal_eigen_cpu_schur` — granice faz setup, fallbacku i `EPSSolve`.
- `...::write_production_schur_diagnostics` — top-level JSON z `null` dla nieuruchomionych faz.
- `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp::with_operator_diagnostics` — zachowanie warstwy adaptera.
- `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp::FrequencyWindowPublishesCompleteCertificateForSyntheticFixture` — przygotowana regresja natywna.
- `scripts/test_poisson_airbox_schur_observability_source.py::main` — interpretowany source-level wiring check.

(validation)=
## 10. Walidacja

W tym kroku wykonano wyłącznie:

```text
python scripts/test_poisson_airbox_schur_observability_source.py
PASS: CPU Schur observability source contract
git diff --check (owned files)
```

Nie kompilowano ani nie uruchamiano testu natywnego, PETSc/SLEPc, managed
runnera ani benchmarku. Natywna regresja jest przygotowana, ale status jej
wykonania pozostaje `NOT VERIFIED`. Nie ma jeszcze zmierzonego runtime dla
pilota `active_nodes=328`; zależność $N_{\mathrm{PC}}=2s$ dla rzeczywistego
przypadku pozostaje oczekiwaniem wynikającym ze źródła, dopóki receipt nie
opublikuje tych pól.

(limitations)=
## 11. Ograniczenia

- Telemetria nie rozstrzyga, czy residual modalny spełnia bramkę ani czy
  częstotliwość zgadza się z analityką lub COMSOL-em.
- `construction_seconds` jest kosztem wspólnego cache w oknie; nie wolno go
  sumować po 50 wpisach. `shifted_setup_seconds` i `eps_solve_seconds` są
  per-shift i nie zawierają pierwszej budowy wspólnego cache. Pojedyncza exact
  materializacja jest raportowana wyłącznie jako `construction_seconds`.
- Brak pola RSS, peak memory, liczby kolumn Krylov lub kwalifikacji GPU. Limit
  512 dotyczy exact cache okna; `ncv` i limit kolumn materializacji są odrębne.
- Bufor śladu ma ograniczony rozmiar i używa jawnego markera truncation.
  Zewnętrzny JSON ma osobny fail-closed fallback; żadna ścieżka nie publikuje
  cichego, uciętego dokumentu.

(scientific-bibliography)=
## 12. Bibliografia

1. V. Hernandez, J. E. Roman, V. Vidal, F. D. Campos, E. Romero i A.
   Tomas, *SLEPc: A Scalable and Flexible Toolkit for the Solution of
   Eigenvalue Problems*, ACM TOMS 31(3), 2005,
   [doi:10.1145/1089014.1089019](https://doi.org/10.1145/1089014.1089019).
2. Y. Saad, *Iterative Methods for Sparse Linear Systems*, 2nd ed., SIAM,
   2003, [doi:10.1137/1.9781611970739](https://doi.org/10.1137/1.9781611970739).

(source-code-index)=
## 13. Indeks źródeł

Źródła wskazane w tej nocie są mapowane maszynowo w
`docs/physics/poisson-airbox-schur-execution-observability.source-map.json`.
Indeks rozdziela źródło implementacji, przygotowaną regresję i interpretowany
check; żaden z nich nie zastępuje managed runtime ani dowodu fizycznego.

| Ścieżka | Symbol | Odpowiedzialność |
|---|---|---|
| backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | bool configure_production_cpu_operator_context | Stan wymiarów i exact cache. |
| backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | bool create_production_exact_shift_preconditioner | Materializacja kolumn i licznik Poissona. |
| backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | bool create_production_cached_window_preconditioner | Polityka cache okna i reuse. |
| backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | solve_poisson_airbox_modal_eigen_cpu_schur | Pomiar faz solvera. |
| backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | PetscErrorCode production_split_schur_matmult | Produkcyjna akcja MatShell Schura. |
| backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp | void write_production_schur_diagnostics | Serializacja metryk nullable. |
| backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp | with_operator_diagnostics | Przeniesienie diagnostyki adaptera. |
| backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp | void FrequencyWindowPublishesCompleteCertificateForSyntheticFixture | Przygotowana regresja natywna. |
| scripts/test_poisson_airbox_schur_observability_source.py | main | Interpretowany check źródeł. |
