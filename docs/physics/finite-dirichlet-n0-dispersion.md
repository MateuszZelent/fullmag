# Referencja n=0 dla skończonego airboxu Dirichleta

- Status: diagnostyczna referencja analityczna; `source-visible / unvalidated`
- Właściciel: FEM frequency-domain DE/BV dispersion
- Aktualizacja: 2026-10-02
- Powiązany model: `examples/fem_de_smoke_numeric.py`
- Powiązany audyt: `docs/audits/2026-09-15-eigensolve-dispersion-correctness-audit.md`, finding M15

Ta nota rozdziela dwie referencje używane przy analizie relacji dyspersji:
otwarty film oraz jednorodny moduł grubościowy $n=0$ w skończonej domenie
powietrza z warunkiem Dirichleta dla potencjału skalarnego. Druga referencja
odtwarza resolved `air_padding_each_side_m`; nie jest wynikiem dyskretnego
FEM, zbieżności siatki ani porównania z COMSOL-em.

(problem-statement)=
## 1. Domena fizyczna

Rozważamy jednorodny film magnetyczny o grubości $t$, rozciągnięty
periodycznie w płaszczyźnie $xy$. Film zajmuje
$z\in[-t/2,t/2]$. Po każdej stronie filmu znajduje się warstwa powietrza o
resolved grubości $d$; płaszczyzny Dirichleta potencjału są zatem w
$z=\pm L$, gdzie $L=d+t/2$. W płaszczyźnie filmu stosujemy pojedynczy
wektor falowy o wartości $q=|\mathbf{k}|$.

Wzorzec odpowiada jednorodnemu przypadkowi `fem_de_smoke_numeric.py`, w
którym `study.demag(model="airbox", variant="dirichlet")` definiuje finite
airbox. Nie opisuje antydotu, niejednorodnej komórki, wyższych modów przez
grubość ani asymetrycznych warunków brzegowych.

| Solver | Urządzenie | Stan | Granica dowodu |
|---|---|---|---|
| FEM | CPU | `source-visible / unvalidated` | Referencja może służyć do diagnostycznego porównania z FEM CPU. |
| FEM | GPU | `not-applicable` | Nie dodano implementacji ani dowodu GPU. |
| FDM | CPU | `not-applicable` | Nota nie zmienia realizacji FDM. |
| FDM | GPU | `not-applicable` | Nota nie zmienia realizacji FDM. |

(governing-equations)=
## 2. Równania modelu

### 2.1. Funkcja Greena dla skończonego airboxu

Dla $q>0$ rozwiązujemy jednowymiarowy problem potencjału z warunkami
$\phi(-L)=\phi(L)=0$. Własna funkcja Greena dla operatora
$\partial_z^2-q^2$ ma postać:

```{math}
:label: eq-finite-airbox-green
G_D(z,z';q) = -\frac{\sinh\!\left(q(z_<+L)\right)\sinh\!\left(q(L-z_>)\right)}{q\sinh(2qL)},
\qquad z_< = \min(z,z'),\quad z_> = \max(z,z').
```

Znak i normalizacja odpowiadają równaniu
$\left(\partial_z^2-q^2\right)G_D=\delta(z-z')$. Jest to własne
wyprowadzenie dla symetrycznych płaszczyzn Dirichleta; nie jest kopiowane z
implementacji zewnętrznego solvera.

### 2.2. Czynniki demagnetyzacji modu n=0

Dla DE składowa dynamiczna równoległa do $\mathbf{k}$ otrzymuje czynnik:

```{math}
:label: eq-finite-airbox-demag-parallel
N_\parallel^D(q) = 1 - \frac{\cosh(qd)\sinh(qt/2)}{(qt/2)\cosh(q(d+t/2))}.
```

Dla składowej normalnej do filmu otrzymujemy:

```{math}
:label: eq-finite-airbox-demag-normal
N_z^D(q) = \frac{2\sinh(qd)\sinh(qt/2)}{qt\sinh(q(d+t/2))}.
```

W przypadku DE macierz modu n=0 jest więc diagonalna:

```{math}
:label: eq-finite-airbox-demag-de
\mathbf{N}_{\mathrm{DE}}^D(q)=\operatorname{diag}\!\left(N_\parallel^D(q),N_z^D(q)\right).
```

Dla BV dynamiczna składowa poprzeczna do $\mathbf{k}$ nie generuje ładunku
objętościowego. W modelu n=0 pozostaje:

```{math}
:label: eq-finite-airbox-demag-bv
\mathbf{N}_{\mathrm{BV}}^D(q)=\operatorname{diag}\!\left(0,N_z^D(q)\right).
```

### 2.3. Częstotliwość dipole-exchange

Niech $H_0$ będzie polem biasu w jednostkach A m$^{-1}$, a
$X(q)=H_0+2A_{\mathrm{ex}}q^2/(\mu_0M_s)$. Wtedy:

```{math}
:label: eq-finite-airbox-frequency
f_{\mathrm{DE}}^D(q)=\frac{\gamma_0}{2\pi}\sqrt{\left[X(q)+M_sN_\parallel^D(q)\right]\left[X(q)+M_sN_z^D(q)\right]},
```

```{math}
:label: eq-finite-airbox-frequency-bv
f_{\mathrm{BV}}^D(q)=\frac{\gamma_0}{2\pi}\sqrt{X(q)\left[X(q)+M_sN_z^D(q)\right]}.
```

W implementacji `mu0_t_m_a` jest używane jawnie w członie wymiany oraz w
przeliczeniu `external_induction_t` na $H_0$.

### 2.4. Granice kontrolne

W granicy $q\to0$:

```{math}
:label: eq-finite-airbox-gamma-limit
N_\parallel^D(0)=0,
\qquad N_z^D(0)=\frac{2d}{t+2d}.
```

W granicy $d\to\infty$:

```{math}
:label: eq-finite-airbox-open-limit
N_z^D(q)\longrightarrow\frac{1-e^{-qt}}{qt},
\qquad N_\parallel^D(q)\longrightarrow1-\frac{1-e^{-qt}}{qt}.
```

Model jest parzysty względem signed $k$, ponieważ zależy od $q=|k|$. Dla
symetrycznego airboxu i braku DMI lub innej asymetrii
$f(+k)=f(-k)$. Ta referencja nie może wyjaśniać nieodwracalności
częstotliwościowej.

### 2.5. Stabilizacja dla małego $q$

Bezpośrednie obliczenie $1-N_\parallel^D$ przez logarytm iloczynu dwóch
czynników bliskich jedności traci cyfry dla bardzo małego $q$. Implementacja
stosuje równoważną postać algebraiczną. Dla $u=qt$, $E=\exp(-2qd)$,
$F=(1-\exp(-u))/u$, $P=1-F$ oraz $Q=2P-uF$ oblicza
$N_\parallel^D=[P(1-E)+EQ]/[1+E\exp(-u)]$. Dla małego $u$ wartości $P$ i
$Q$ są rozwijane w szeregi Taylora, a czynniki $1-\exp(-x)$ korzystają z
`expm1`; nie jest to zastępowane bezwarunkowym clampem. Niezależna regresja
Decimal o precyzji 70 cyfr sprawdza $q=0.01$, $1$, $100$ i $10^4\,\mathrm{m^{-1}}$.
Granica $q=0$ jest liczona przez iloraz skalowany, który nie tworzy
$2d$ przed dzieleniem; dzięki temu także padding bliski maksymalnej skończonej
wartości zmiennoprzecinkowej daje skończony czynnik w przedziale $[0,1]$.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $q$ | wartość bezwzględna wektora falowego | $\mathrm{m^{-1}}$ |
| $k$ | signed składowa ścieżki DE/BV | $\mathrm{m^{-1}}$ |
| $t$ | grubość filmu | $\mathrm{m}$ |
| $d$ | odległość od powierzchni filmu do płaszczyzny Dirichleta | $\mathrm{m}$ |
| $L$ | położenie płaszczyzny Dirichleta, $d+t/2$ | $\mathrm{m}$ |
| $z,z'$ | współrzędne normalne funkcji Greena | $\mathrm{m}$ |
| $z_<$ | minimum z i z-prime | $\mathrm{m}$ |
| $z_>$ | maksimum z i z-prime | $\mathrm{m}$ |
| $G_D$ | funkcja Greena potencjału skalarnego | $\mathrm{m}$ |
| $N_\parallel^D$ | finite-airbox czynnik dla składowej równoległej do $\mathbf{k}$ | $1$ |
| $N_z^D$ | finite-airbox czynnik dla składowej normalnej | $1$ |
| $X(q)$ | pole biasu powiększone o pole wymiany | $\mathrm{A\,m^{-1}}$ |
| $f_{\mathrm{DE}}^D$ | częstotliwość DE modu n=0 w finite airbox | $\mathrm{Hz}$ |
| $f_{\mathrm{BV}}^D$ | częstotliwość BV modu n=0 w finite airbox | $\mathrm{Hz}$ |
| $M_s$ | nasycenie magnetyzacji | $\mathrm{A\,m^{-1}}$ |
| $H_0$ | pole biasu | $\mathrm{A\,m^{-1}}$ |
| $B_0$ | resolved indukcja zewnętrzna | $\mathrm{T}$ |
| $A_{\mathrm{ex}}$ | stała wymiany | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | przenikalność próżni w konwencji modelu | $\mathrm{T\,m\,A^{-1}}$ |
| $\gamma_0$ | współczynnik gyromagnetyczny | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $f$ | częstotliwość | $\mathrm{Hz}$ |
| $\phi$ | potencjał magnetostatyczny | $\mathrm{A}$ |

W rekordach artefaktów `air_padding_each_side_m` oznacza $d$, a nie pełną
wysokość domeny. `external_induction_t` oznacza $B_0$; referencja przelicza
je na $H_0=B_0/\mu_0$. Wszystkie wartości są pobierane z resolved metadata.

(assumptions-and-validity)=
## 4. Założenia i ważność

- Film jest jednorodny w płaszczyźnie i przez grubość; rozważany jest tylko
  modu grubościowy $n=0$.
- Airbox ma symetryczne, skalarnopotencjałowe warunki Dirichleta w odległości
  $d$ od każdej powierzchni filmu.
- W płaszczyźnie $xy$ zakładamy periodyczność i pojedynczy Fourierowski
  wektor falowy.
- Nie uwzględniamy DMI, anizotropii, tłumienia, niejednorodnego $M_s$,
  niejednorodnego $A_{\mathrm{ex}}$, antydotu, wyższych modów grubości ani
  asymetrii powierzchni.
- Wartość referencji nie jest częstotliwością z solvera i nie dowodzi
  zbieżności FEM, airboxu, siatki, liczby modów ani residualu.
- Przy bardzo dużym $|k|d$ implementacja używa skalowanych postaci
  wykładniczych zamiast bezpośrednich `sinh`/`cosh`, aby nie przepełnić
  arytmetyki.
- Przy małym $qt$ implementacja używa stabilnej postaci algebraicznej
  $P,Q$ opisanej w sekcji 2.5; clamp pozostaje wyłącznie ochroną granic
  przed zaokrągleniem, a nie metodą poprawy dokładności.
- Przy braku resolved `air_padding_each_side_m` kolektor i ploter raportują
  `finite_dirichlet_n0=NOT_AVAILABLE`; nie podstawiają wartości `d` z przykładu.

(python-api)=
## 5. Python API i przykład

Nie zmieniono publicznego Python DSL ani ProblemIR. Rzeczywisty model FEM
pozostaje w scenariuszu `examples/fem_de_smoke_numeric.py`; helper jest
wewnętrzną referencją postsolve.

Poniższy przykład jest wykonywalnym fragmentem diagnostycznym, który korzysta
z parametrów resolved modelu i nie uruchamia solvera:

```python
# %%
from scripts.finite_dirichlet_thin_film_oracle import (
    finite_dirichlet_n0_demag_factors,
    finite_dirichlet_n0_frequency_hz,
)

# %%
parameters = {
    "k_rad_m": 2.0e6,
    "geometry": "damon_eshbach",
    "bias_field_a_per_m": 0.1 / (4.0 * 3.141592653589793e-7),
    "film_thickness_m": 10.0e-9,
    "air_padding_each_side_m": 2.0e-6,
    "exchange_stiffness_j_per_m": 13.0e-12,
    "saturation_magnetisation_a_per_m": 8.0e5,
    "gamma0_rad_s_per_a_m": 2.211e5,
    "mu0_t_m_a": 4.0 * 3.141592653589793e-7,
}

# %%
n_parallel, n_z = finite_dirichlet_n0_demag_factors(
    k_rad_m=parameters["k_rad_m"],
    thickness_m=parameters["film_thickness_m"],
    air_padding_each_side_m=parameters["air_padding_each_side_m"],
)
frequency_hz = finite_dirichlet_n0_frequency_hz(**parameters)
assert 0.0 <= n_parallel <= 1.0
assert 0.0 <= n_z <= 1.0
assert frequency_hz > 0.0
```

Parametry są nazwami artefaktu, a nie nowymi argumentami `fm.study`. Ich
walidacja odrzuca wartości niefinitywne, niedodatnie oraz nieidentyfikowany
padding. CPU FEM jest jedyną ścieżką, z którą obecny artefakt jest wiązany.

(problem-ir)=
## 6. ProblemIR i provenance

Brak nowych pól ProblemIR. `requested intent` i `resolved execution` nadal
pochodzą z istniejącego scenariusza oraz native receipts. Kolektor zapisuje
referencję dopiero po odczycie resolved `t`, `d`, $M_s$, $A_{\mathrm{ex}}$,
$B_0$, $\mu_0$ i $\gamma_0$. Nazwa modelu analitycznego nie zastępuje
tożsamości joba, źródła, siatki ani native frequency.

(round-trip-and-failure-semantics)=
## 7. Round-trip i failure semantics

Kolektor zachowuje historyczne `analytic_frequency_hz` oraz open-film dane.
Nowe pola `analytic_open_film_n0_frequency_hz` i
`analytic_finite_dirichlet_n0_frequency_hz` są addytywne. Ploter rysuje
finite-airbox n=0 tylko wtedy, gdy wszystkie punkty mają zgodne resolved
metadata airboxu i materiału. W przeciwnym razie receipt zawiera:
`finite_dirichlet_n0.status = NOT_AVAILABLE` oraz przyczynę.

Selected-only ploter porównuje z metadata tego samego pilota cały zestaw pól
modelu: geometrię i pojedynczy wektor falowy, `bias_field_a_per_m`,
`film_thickness_m`, `exchange_stiffness_j_per_m`,
`saturation_magnetisation_a_per_m`, `gamma0_rad_s_per_a_m`,
`mu0_t_m_a`, `external_induction_t` oraz `air_padding_each_side_m`.
Mutacja któregokolwiek z tych pól kończy walidację błędem. Brakujące pole nie
jest zastępowane stałą z przykładu.

`validation errors` kończą odczyt rekordu przed narysowaniem referencji, a
`unsupported combinations` pozostają jawnie nieobsługiwane; nie ma cichego
fallbacku do modelu open-film dla brakującego finite airboxu.

(discrete-realization)=
## 8. Realizacja dyskretna

`finite_dirichlet_thin_film_oracle.py` oblicza referencję w arytmetyce
skalowanych wykładników. Kolektor `signed-13` i `nearest-single-k` odczytują
resolved metadata z `metadata.json`, a ploter ponownie wylicza obie referencje
z rekordów przed rysowaniem. Dla signed $k$ używana jest wartość $|k|$; ploter
nie tworzy sztucznego punktu po drugiej stronie osi.

Open-film profil grubościowy $N=32$ pozostaje osobną kontrolą. Finite-airbox
dotyczy wyłącznie zamkniętego modu n=0 i nie jest przedstawiany jako pełna
referencja dla geometrii z antydotem lub niejednorodną komórką.

(implementation-mapping)=
## 9. Mapowanie implementacji

- `examples/fem_de_smoke_numeric.py::AIR_PADDING_EACH_SIDE_M` — authoring
  odległości airboxu używanej przez pilot.
- `scripts/finite_dirichlet_thin_film_oracle.py::finite_dirichlet_n0_demag_factors`
  — stabilne czynniki Green’a.
- `scripts/finite_dirichlet_thin_film_oracle.py::n0_reference_frequencies` —
  oba modele częstotliwości z resolved SI parameters.
- `scripts/collect_signed_de_bv_dispersion.py::_attach_n0_references` —
  wiązanie metadata z rekordem signed/nearest.
- `scripts/plot_de_bv_dispersion_comparison.py::_record_n0_reference` —
  ponowne obliczenie referencji przed plotem.
- `scripts/plot_de_bv_dispersion_comparison.py::_shared_finite_reference_context`
  — zgodność paddingu i jawny stan braku referencji.

(validation)=
## 10. Walidacja

Wykonane bramki interpretowane:

- `python -m pytest scripts/test_finite_dirichlet_thin_film_oracle.py -q` —
  11 testów PASS; obejmuje niezależną kwadraturę objętościową i powierzchniową,
  granice $q\to0$ i $d\to\infty$, signed $k$, duże $|k|d$, kontrolowany
  błąd nieobsługiwanej geometrii i niezależne porównanie Decimal dla małego
  $q$, a także ochronę przed przepełnieniem ilorazu dla $q=0$ i bardzo dużego
  paddingu.
- `python -m pytest scripts/test_plot_de_bv_dispersion_comparison.py -q` —
  14 testów PASS; obejmuje pełne bindingi geometrii, wektora falowego,
  materiału, biasu, paddingu i mutacje metadata.
- `python -m pytest scripts/test_signed_de_bv_dispersion.py -q` — 53 testy
  PASS; historyczny signed/nearest contract nadal działa.

Nie kompilowano testów natywnych, nie uruchamiano managed runnera i nie
wykonywano nowego pilota. Status runtime, zbieżności i kwalifikacji fizycznej
pozostaje `NOT VERIFIED`.

(limitations)=
## 11. Ograniczenia i prace odroczone

- Nie ma jeszcze świeżego artefaktu #195 porównanego z obiema referencjami.
- Zgodność w punkcie Γ nie dowodzi zgodności dla niezerowego $k$.
- Dla antydotu, finite lateral cell z niejednorodnym stanem lub wyższych
  modów grubości należy przygotować inną referencję albo traktować tę jako
  kontrolę ograniczoną.
- Wymagane są osobne sweepy siatki, airboxu, liczby modów i residuali.
- Tolerancje naukowe nie zostały zmienione; różnica open-film–finite-airbox
  nie jest automatycznie błędem numerycznym.

(ui-selected-only-diagnostic)=
## 11.1. Mała demonstracja UI: siedem wybranych modów DE

Pilot `de-smoke-ui-seven` demonstruje odczyt wyników i analizę pola,
bez certyfikacji pełnego widma. Zachowuje film 40×40×10 nm, PBC xy,
Bx=0.1 T, Ms=800 kA/m, A=13 pJ/m i finite airbox Dirichleta ±2 µm.
Wybiera po jednym modzie `target="nearest"` względem tej samej dodatniej
częstotliwości dla $k_y=(-25,-15,-5,0,5,15,25)\,\mathrm{rad/\mu m}$,
$k_x=k_z=0$. Python/IR, CSV i pola zachowują rad/m. Jawny identyfikator
stage `modes` wiąże widmo i pola z etapem autora; nie zmienia operatora.

Referencja n=0 jest porównaniem po obliczeniu. Mod nearest nie dowodzi
n=0 ani ciągłości tej samej gałęzi; połączenie punktów w UI służy
orientacji, a ciągłość wymaga osobnej oceny pól/overlapów.
Provenance zachowuje `selection_scope="selected_only"`,
`window_complete=false`, `qualification="NOT VERIFIED"`.

Siatka L0 z trzema warstwami filmu służy szybkiej demonstracji.
Fizyczny residual pozostaje 1e-8, wraz z bramkami magnetycznymi
oraz magnetostatycznymi. Brak próbki, niespójny wektor, target lub
odrzucony mod przerywa odbiór. Nie odbijamy punktów symetrycznie.
Pełna kwalifikacja wymaga zbieżności siatki/airboxu, kompletności
okna oraz porównania niezależnego.

Mapa realizacji: `examples/fem_de_smoke_numeric.py` → publiczny
Eigenmodes/KPath → ProblemIR eigensolve → FEM CPU Floquet i demag.
FEM CPU: planowane wykonanie/NOT VERIFIED; FEM GPU i FDM CPU/GPU:
poza zakresem pilota. Animacja UI używa istniejącej fazy prezentacji;
jej szybkość nie jest częstotliwością fizyczną modu w GHz.

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. Y. Kalinikos i A. Slavin, *Theory of dipole-exchange spin wave spectrum
   for ferromagnetic films with arbitrary surface pinning*, J. Phys. C 19,
   7013 (1986), DOI: [10.1088/0022-3719/19/35/7013](https://doi.org/10.1088/0022-3719/19/35/7013).
2. Wyprowadzenie funkcji Greena i czynników finite-airbox w tej nocie jest
   własnym wyprowadzeniem z jednowymiarowego operatora
   $\partial_z^2-q^2$ z dwoma warunkami Dirichleta; implementacja i test
   niezależnej kwadratury są wskazane w mapie źródeł.

(source-code-index)=
## 13. Indeks źródeł

| Odpowiedzialność | Ścieżka i symbol | Lane | Dowód |
|---|---|---|---|
| Resolved padding modelu | `examples/fem_de_smoke_numeric.py::AIR_PADDING_EACH_SIDE_M` | FEM CPU | source-visible; runtime osobny |
| Green function finite n=0 | `scripts/finite_dirichlet_thin_film_oracle.py::finite_dirichlet_n0_demag_factors` | referencja analityczna | 11 testów interpretowanych |
| Open-film limit | `scripts/finite_dirichlet_thin_film_oracle.py::open_film_n0_demag_factors` | referencja analityczna | granica d→∞ |
| Częstotliwości DE/BV | `scripts/finite_dirichlet_thin_film_oracle.py::n0_reference_frequencies` | referencja analityczna | granice i signed-k |
| Rekord kolektora | `scripts/collect_signed_de_bv_dispersion.py::_attach_n0_references` | collector CPU artifacts | signed contract |
| Kontekst finite curve | `scripts/plot_de_bv_dispersion_comparison.py::_shared_finite_reference_context` | plot diagnostic | plot contract |
| Recompute przed plotem | `scripts/plot_de_bv_dispersion_comparison.py::_record_n0_reference` | plot diagnostic | metadata binding |
| Niezależna kwadratura | `scripts/test_finite_dirichlet_thin_film_oracle.py::test_surface_and_volume_green_quadrature_reproduce_both_factors` | source-level math | PASS; bez native build |
| Binding plotera | `scripts/test_plot_de_bv_dispersion_comparison.py::test_plot_selected_only_rejects_unqualified_record` | artifact diagnostic | PASS |
| Binding kolektora | `scripts/test_signed_de_bv_dispersion.py::test_nearest_record_binds_native_target_and_full_residual` | artifact diagnostic | PASS |
| UI seven authoring | `examples/fem_de_smoke_numeric.py::SAMPLING` | FEM CPU selected-only | NOT VERIFIED runtime |
| UI seven metadata binding | `scripts/run_de_100nm_pilot.py::validate_selected_only_metadata` | managed diagnostic | NOT VERIFIED runtime |
| Per-sample nearest diagnostics | `scripts/validate_de_smoke_rows.py::validate_selected_only_diagnostics` | artifact guard | testy CI wymagane |

Źródła i testy pokazują implementację referencji; żaden z nich nie zastępuje
managed runtime, dowodu GPU, zbieżności FEM ani porównania COMSOL.
