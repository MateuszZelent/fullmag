# 0535 — OVF 1.0/2.0 and NPZ field-state import, domain-overlap validation, and masked trilinear resampling with antipodal fallback

- Status: accepted_contract_not_production_qualified
- Owners: Fullmag physics and runtime
- Last updated: 2026-11-22
- Related ADRs: docs/adr/0011-resource-first-api.md
- Related specs: docs/physics/0532-fem-fdm-magnetization-state-transfer.md, docs/specs/magnetization-init-policy-v0.md

(problem-statement)=
## 1. Dziedzina fizyczna

Import zewnętrznych stanów pola magnetyzacji z plików OOMMF/MuMax3 OVF (1.0 i 2.0:
`Text`, `Binary 4`, `Binary 8`) oraz archiwów NumPy `.npz` / `.npy` na docelową
siatkę kartezjańską FDM lub niestrukturalną siatkę czworościenną FEM wymaga
zachowania więzu jednostkowej długości $|\mathbf m(\mathbf r)| = 1$ we wszystkich
aktywnych komórkach i węzłach magnetycznych. Zwykła interpolacja trójliniowa
załamuje się w dwóch sytuacjach fizycznych: (a) na brzegu geometrii otoczonym
komórkami próżniowymi ($\mathbf m = \mathbf 0$) oraz (b) w dokładnym środku
symetrycznej ściany domenowej $180^\circ$ ($\mathbf m_L = -\mathbf m_R$), gdzie
suma liniowa zeruje się antypodalnie ($\tilde{\mathbf m} = \mathbf 0$). Niniejsza
nota definiuje format wejściowy, walidację nakładania obwiedni (bounding box) i
osi tablic 4D oraz algorytm maskowanego resamplingu trójliniowego z
deterministycznym fallbackiem antypodalnym.

(governing-equations)=
## 2. Model fizyczny

### 2.1 Odwzorowanie siatki źródłowej i kontrola nakładania obwiedni

Siatka prostokątna o wymiarach $(n_x, n_y, n_z)$, początku
$\mathbf o = (x_0, y_0, z_0)$ oraz krokach $\mathbf h = (h_x, h_y, h_z)$ ($h_a > 0$)
przechowuje próbki w porządku x-fastest ($k = i_x + n_x(i_y + n_y i_z)$, co w
pamięci C odpowiada tablicy 4D o kształcie $[n_z, n_y, n_x, C]$) w środkach
komórek $\mathbf c_{i_x,i_y,i_z} = \mathbf o + (i_x + \tfrac{1}{2}, i_y + \tfrac{1}{2}, i_z + \tfrac{1}{2})\odot\mathbf h$.
Obwiednia źródłowa wynosi $B_{\mathrm{src}} = \prod_{a\in\{x,y,z\}}[o_a, o_a + n_a h_a]$.
Dla zbioru aktywnych punktów docelowych $\{\mathbf p_j\}_{j=1}^{M}$ warunek
niepustego przekrycia ma postać:

```{math}
:label: ovf-bbox-overlap-gate

N_{\mathrm{in}} = \sum_{j=1}^{M} \mathbb I\!\left(\forall a:\; o_a - \varepsilon_a \le p_{j,a} \le o_a + n_a h_a + \varepsilon_a\right) > 0,
\qquad \varepsilon_a = 10^{-9} h_a.
```

Gdy $N_{\mathrm{in}} = 0$ (rozłączne domeny, np. przesunięty układ współrzędnych),
import kończy się natychmiastowym błędem walidacji zamiast cichego rzutowania
całej domeny na ścianę brzegową. Częściowe wystawanie ($0 < N_{\mathrm{in}} < M$,
np. siatka MuMax3 $[0, L]$ załadowana na wycentrowaną domenę $[-L/2, +L/2]$ bez
jawnego `source_origin`) generuje jawne ostrzeżenie diagnostyczne.

### 2.2 Maskowana interpolacja trójliniowa z wykluczeniem próżni

Dla punktu docelowego $\mathbf p$ znormalizowane współrzędne indeksowe we wnętrzu
siatki źródłowej wynoszą:

```{math}
:label: trilinear-cell-coords

u_a = \min\!\left(n_a - 1,\;\max\!\left(0,\;\frac{p_a - (o_a + \tfrac{1}{2}h_a)}{h_a}\right)\right),\qquad
i_{a,0} = \lfloor u_a \rfloor,\quad
i_{a,1} = \min(i_{a,0} + 1, n_a - 1),\quad
t_a = u_a - i_{a,0}.
```

Narożniki próżniowe o normie $\|\mathbf m_{i_x,i_y,i_z}\| \le \varepsilon_0$
($\varepsilon_0 = 10^{-12}$) są wyłączone z sumy ważonej wagami trójliniowymi
$w_{\alpha\beta\gamma}$:

```{math}
:label: masked-trilinear-sum

\tilde{\mathbf m}(\mathbf p)
= \sum_{(\alpha,\beta,\gamma)\in\{0,1\}^3}
\mathbb I\!\left(\|\mathbf m_{i_{x,\alpha}, i_{y,\beta}, i_{z,\gamma}}\| > \varepsilon_0\right)\,
w_{\alpha\beta\gamma}\,\mathbf m_{i_{x,\alpha}, i_{y,\beta}, i_{z,\gamma}},
\qquad
W(\mathbf p)
= \sum_{(\alpha,\beta,\gamma)\in\{0,1\}^3}
\mathbb I\!\left(\|\mathbf m_{i_{x,\alpha}, i_{y,\beta}, i_{z,\gamma}}\| > \varepsilon_0\right)\,
w_{\alpha\beta\gamma}.
```

### 2.3 Renormalizacja i deterministyczny fallback antypodalny

Gdy $\|\tilde{\mathbf m}(\mathbf p)\| > \varepsilon_0$, wynik w trybie
`normalize = True` jest renormalizowany do sfery jednostkowej $S^2$, a w trybie
`normalize = False` dzielony przez sumę aktywnych wag $W(\mathbf p)$. Gdy
$\|\tilde{\mathbf m}(\mathbf p)\| \le \varepsilon_0$ (dokładna kancelacja
antypodalna na środku ściany domenowej lub punkt otoczony komórkami zerowymi),
algorytm przechodzi deterministycznie do euklidesowo najbliższej niezerowej
komórki $\mathbf m_{\mathrm{NN}}(\mathbf p)$ przeszukiwanej warstwami
Czebyszewa $r = 1, 2, \dots, \max(n_x,n_y,n_z)-1$ z uściśleniem anizotropowym
(oraz jednostkowym fallbackiem $+\mathbf e_z$ dla patologicznej siatki całkowicie zerowej):

```{math}
:label: trilinear-antipodal-fallback

\mathbf m_{\mathrm{out}}(\mathbf p) =
\begin{cases}
\dfrac{\tilde{\mathbf m}(\mathbf p)}{\|\tilde{\mathbf m}(\mathbf p)\|}, & \|\tilde{\mathbf m}(\mathbf p)\| > \varepsilon_0 \;\land\; \text{normalize},\\[8pt]
\dfrac{\tilde{\mathbf m}(\mathbf p)}{W(\mathbf p)}, & \|\tilde{\mathbf m}(\mathbf p)\| > \varepsilon_0 \;\land\; \neg\text{normalize},\\[8pt]
\dfrac{\mathbf m_{\mathrm{NN}}(\mathbf p)}{\|\mathbf m_{\mathrm{NN}}(\mathbf p)\|}, & \|\tilde{\mathbf m}(\mathbf p)\| \le \varepsilon_0 \;\land\; \text{normalize}.
\end{cases}
```

Dzięki temu każda aktywna komórka FDM i każdy magnetyczny węzeł FEM otrzymuje
skończony wektor o normie dokładnie równej $1$.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m$ | źródłowy wektor pola (magnetyzacji) | $1$ |
| $\tilde{\mathbf m}$ | nieznormalizowany akumulator maskowanej sumy trójliniowej | $1$ |
| $\mathbf m_{\mathrm{NN}}$ | wektor najbliższej euklidesowo niezerowej komórki źródłowej | $1$ |
| $\mathbf m_{\mathrm{out}}$ | wynikowy wektor zresamplowanego pola | $1$ |
| $n_a$ | liczba komórek siatki źródłowej wzdłuż osi $a$ | $1$ |
| $o_a$ | współrzędna początku siatki źródłowej wzdłuż osi $a$ | $\mathrm{m}$ |
| $h_a$ | rozmiar komórki siatki źródłowej wzdłuż osi $a$ | $\mathrm{m}$ |
| $\varepsilon_a$ | tolerancja numeryczna obwiedni brzegowej ($10^{-9} h_a$) | $\mathrm{m}$ |
| $p_a$ | współrzędna punktu docelowego wzdłuż osi $a$ | $\mathrm{m}$ |
| $p_{j,a}$ | składowa $a$ $j$-tego punktu docelowego | $\mathrm{m}$ |
| $M$ | liczba aktywnych punktów docelowych | $1$ |
| $N_{\mathrm{in}}$ | liczba aktywnych punktów docelowych wewnątrz obwiedni źródła | $1$ |
| $u_a$ | ciągły indeks komórkowy wzdłuż osi $a$ | $1$ |
| $i_{a,0}$ | dolny indeks narożnika komórki interpolacji | $1$ |
| $i_{a,1}$ | górny indeks narożnika komórki interpolacji | $1$ |
| $t_a$ | ułamkowa waga interpolacji liniowej wzdłuż osi $a$ | $1$ |
| $w_{\alpha\beta\gamma}$ | trójliniowa waga narożnika $(\alpha,\beta,\gamma)$ | $1$ |
| $W$ | suma wag niezerowych narożników komórki | $1$ |
| $\varepsilon_0$ | próg odcięcia komórek zerowych i kancelacji antypodalnej ($10^{-12}$) | $1$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

Parser OVF obsługuje wyłącznie siatki `meshtype: rectangular` w standardzie
OVF 1.0 (big-endian float32/float64 z magic `1234567.0` / `123456789012345.0`
oraz mnożnikiem `valuemultiplier`) i OVF 2.0 (little-endian, `valuedim` 1 lub 3).
Pola skalarne (`valuedim = 1`) mogą być ładowane i inspekcjonowane przez
`load_field_state`, lecz zastosowanie jako stan magnetyzacji $\mathbf m$ wymaga
ściśle `valuedim = 3`. Archiwa NPZ z tablicami 4D bez klucza `axis_order` muszą
mieć kanoniczny układ `[Nz, Ny, Nx, C]`; tablica `[Nx, Ny, Nz, C]` z `grid_shape = [Nx, Ny, Nz]`
($N_x \neq N_z$) bez jawnego `axis_order = "xyz"` jest odrzucana zamiast cichej transpozycji.

(python-api)=
## 5. Python API

Funkcje `load_field_state`, `save_ovf` oraz `resample_imported_field` w
`fullmag.init.state_io` pozwalają wczytać stan OVF/NPZ, jawnie ustawić
`source_origin` i zresamplować go na punkty docelowe:

```python
# %%
import tempfile
from pathlib import Path
import fullmag as fm
from fullmag.init.magnetization import SampledMagnetization
from fullmag.init.state_io import load_field_state, resample_imported_field, save_ovf

with tempfile.TemporaryDirectory() as tmp:
    ovf_file = Path(tmp) / "domain_wall.ovf"
    save_ovf(
        ovf_file,
        [(0.0, 0.0, 1.0), (0.0, 0.0, -1.0)],
        grid_shape=(2, 1, 1),
        grid_spacing=(10e-9, 10e-9, 10e-9),
        grid_origin=(-10e-9, -5e-9, -5e-9),
        encoding="binary4",
    )
    imported = load_field_state(ovf_file)
    sampled = resample_imported_field(
        imported,
        [(-5e-9, 0.0, 0.0), (0.0, 0.0, 0.0), (5e-9, 0.0, 0.0)],
        interpolation="trilinear",
        normalize=True,
    )

study = fm.study("ovf_resampled_continuation")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(30e-9, 10e-9, 10e-9))
study.cell(10e-9, 10e-9, 10e-9)
bar = study.geometry(fm.Box(size=(30e-9, 10e-9, 10e-9), name="bar"), name="bar")
bar.Ms = 8.0e5
bar.Aex = 1.3e-11
bar.alpha = 0.02
bar.m = SampledMagnetization(sampled.tolist())
study.exchange()
study.stages.add_relax(stage_id="relax", dt=1e-13, max_steps=50)
```

### 5.1 Tabela parametrów publicznych

| Python | Typ | Domyślna | Jednostka SI | Walidacja | Znaczenie | Obsługa backendu | ProblemIR |
|---|---|---|---|---|---|---|---|
| load_field_state.format | str | auto | $1$ | auto, ovf, npz, npy, zarr, h5, or json | format pliku wejściowego stanu pola | FDM/FEM CPU/GPU | magnets[].initial_magnetization[kind=sampled_field] |
| load_field_state.source_origin | Sequence[float] | None | $\mathrm{m}$ | finite 3-vector or None | jawne nadpisanie początku siatki źródłowej | FDM/FEM CPU/GPU | runtime resampling coordinate transform |
| save_ovf.encoding | str | binary4 | $1$ | binary4, binary8, or text | kodowanie bloku danych OVF 2.0 | export utility | artifact file encoding |
| resample_imported_field.interpolation | str | trilinear | $1$ | exact, nearest, or trilinear | metoda interpolacji przestrzennej | FDM/FEM CPU/GPU | session field-state import / sampled_field |
| resample_imported_field.normalize | bool | True | $1$ | bool | renormalizacja wektorów wyjściowych do normy 1 | FDM/FEM CPU/GPU | magnets[].initial_magnetization.values |
| resample_imported_field.zero_threshold | float | 1e-12 | $1$ | finite and > 0 | próg normy wykluczający komórki próżniowe | FDM/FEM CPU/GPU | resampling numerical threshold |

(problem-ir)=
## 6. ProblemIR i lowering

Po zresamplowaniu stan początkowy obniżany jest do kanonicznego wariantu
`InitialMagnetizationIR::SampledField` (lub aplikowany bezpośrednio do aktywnego
stanu sesji przez `POST /v2/sessions/current/persistence/field-states/imports`):

```json
{
  "kind": "sampled_field",
  "values": [
    [0.0, 0.0, 1.0],
    [0.0, 0.0, 1.0],
    [0.0, 0.0, -1.0]
  ]
}
```

(round-trip-and-failure-semantics)=
## 7. Round-trip, runtime i błędy

Requested intent (wybrany artefakt, tryb `interpolation` w `{"exact", "nearest", "trilinear"}`
oraz `normalize`) jest walidowany zarówno w Pythonie, jak i w usłudze sesji API v2.
Resolved execution zapisuje liczbę zaaplikowanych punktów, nową rewizję pola oraz
tablicę ostrzeżeń diagnostycznych (`warnings`) dla domyślnego `origin` lub
częściowego przycięcia brzegowego. Validation errors (uszkodzony magic OVF,
niezgodność kształtu 3D w trybie `exact`, rozłączne obwiednie źródła i celu,
`valuedim != 3` dla magnetyzacji, niejednoznaczna kolejność osi 4D NPZ) są
odrzucane jawnie przed modyfikacją stanu sesji, a unsupported combinations
(np. `exact` pomiędzy siatką strukturalną a niestrukturalną siatką FEM) wymagają
jawnego wyboru `nearest` lub `trilinear`.

(discrete-realization)=
## 8. Realizacja dyskretna

### 8.1 FDM

W sesji FDM resampling oblicza próbki w środkach aktywnych komórek docelowych
(w tym wielowarstwowych `fdm_multilayer`), ustawiając dokładnie $[0,0,0]$ w
komórkach nieaktywnych poza maską geometrii.

### 8.2 FEM

W sesji FEM resampling oblicza próbki wyłącznie w magnetycznych węzłach P1
siatki `fem_mesh`, pozostawiając $[0,0,0]$ na węzłach domeny powietrznej (airbox).

### 8.3 Support matrix

| Solver | Device | Semantyka | Status |
|---|---|---|---|
| FDM | CPU | exact, nearest, and masked trilinear cell-center import | source and pytest evidence |
| FDM | GPU | receives unit-normalized host-resampled state buffer | runtime qualification separate |
| FEM | CPU | nearest and masked trilinear P1 magnetic-node import | source and unit test evidence |
| FEM | GPU | receives unit-normalized host-resampled nodal buffer | runtime qualification separate |

(implementation-mapping)=
## 9. Mapa implementacji

- Python OVF/NPZ I/O & resampler: `packages/fullmag-py/src/fullmag/init/state_io.py` (`parse_ovf_bytes`, `save_ovf`, `_load_numpy_field_values`, `_nearest_nonzero_cell`, `resample_imported_field`).
- Python CLI bridge: `packages/fullmag-py/src/fullmag/init/field_state_cli.py` (`_read`).
- Rust API v2 OVF parser & session resampler: `crates/fullmag-api/src/session_persistence.rs` (`parse_ovf_bytes`, `check_source_target_bbox_overlap`, `nearest_nonzero_grid_vector`, `sample_field_state_at_point`, `resample_field_state_to_snapshot_domain`).

(validation)=
## 10. Walidacja

Zestaw `test_field_state_import_formats.py` weryfikuje round-trip OVF 2.0 (`binary4`,
`binary8`, `text`), OVF 1.0 big-endian z `valuemultiplier`, archiwa NPZ 4D
(`[Nz, Ny, Nx, 3]` oraz walidację `axis_order='xyz'`), deterministyczny fallback
antypodalny w środku ściany domenowej $[0,0,1]/[0,0,-1]$, ekspansję powłokową
`_nearest_nonzero_cell` poza otoczenie $3\times 3\times 3$, odrzucanie rozłącznych
obwiedni oraz zachowanie `valuedim` i `normalize`.

(limitations)=
## 11. Ograniczenia i odroczone prace

Interpolacja trójliniowa działa punktowo w środkach komórek / węzłach P1 i nie
wykonuje całkowania objętościowego po przecięciu komórek o silnie różnej skali;
próg kancelacji antypodalnej $\varepsilon_0 = 10^{-12}$ jest stałą bezwzględną
dla znormalizowanych pól kierunkowych.

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. M. J. Donahue, D. G. Porter, *OOMMF User's Guide, Version 1.0*, NISTIR 6376, National Institute of Standards and Technology, Gaithersburg, MD (1999) — specyfikacja formatów OVF 1.0 i OVF 2.0.
2. A. Vansteenkiste et al., *The design and verification of MuMax3*, AIP Advances 4, 107133 (2014), DOI: 10.1063/1.4899186.

(source-code-index)=
## 13. Indeks źródeł i dowodów

| Claim/equation | Path | Symbol | Test/evidence | Lane |
|---|---|---|---|---|
| Python OVF 1.0/2.0 parser | packages/fullmag-py/src/fullmag/init/state_io.py | parse_ovf_bytes | test_ovf2_binary4_and_npz_roundtrip | all |
| Python OVF 2.0 writer | packages/fullmag-py/src/fullmag/init/state_io.py | save_ovf | test_ovf2_binary4_and_npz_roundtrip | all |
| Python NPZ 4D axis-order loader | packages/fullmag-py/src/fullmag/init/state_io.py | _load_numpy_field_values | test_valuedim_normalize_and_npz_4d_axis_order_validation | all |
| Python shell-expanding nearest cell | packages/fullmag-py/src/fullmag/init/state_io.py | _nearest_nonzero_cell | test_nearest_nonzero_cell_expands_beyond_3x3x3_and_never_returns_zero | all |
| Python masked trilinear resampler | packages/fullmag-py/src/fullmag/init/state_io.py | resample_imported_field | test_trilinear_antipodal_wall_midpoint_falls_back_to_unit_nearest | all |
| Rust OVF 1.0/2.0 parser | crates/fullmag-api/src/session_persistence.rs | parse_ovf_bytes | session field-state import contract | FDM/FEM |
| Rust source/target bbox overlap check | crates/fullmag-api/src/session_persistence.rs | check_source_target_bbox_overlap | session field-state import contract | FDM/FEM |
| Rust shell-expanding nearest vector | crates/fullmag-api/src/session_persistence.rs | nearest_nonzero_grid_vector | session field-state import contract | FDM/FEM |
| Rust masked trilinear point sampler | crates/fullmag-api/src/session_persistence.rs | sample_field_state_at_point | session field-state import contract | FDM/FEM |
