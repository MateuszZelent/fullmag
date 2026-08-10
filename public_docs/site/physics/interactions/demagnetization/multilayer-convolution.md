---
title: FDM multilayer convolution
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0421-fdm-multilayer-convolution-demag.md
---

(public-docs-physics-interactions-demagnetization-multilayer-convolution)=
# FDM multilayer demagnetizing-field convolution

This page describes the physics, discretization, and public configuration contract for
`multilayer_convolution`. The method computes the demagnetizing field of disconnected
magnetic layers or objects on separate FDM grids. It is not a FEM Poisson or BEM model;
choosing this strategy changes the numerical realization but does not change the physical
definition of the demagnetizing field.

Each magnetic object owns a native FDM grid. The common convolution grid is an FFT supercell used
for pair kernels and transfers; it is neither a material mesh nor a FEM universe mesh. Geometry
translations determine layer offsets, including the signed $z$ offsets used by the kernels. A
public FDM multilayer script therefore needs `study.fdm(..., per_magnet=..., demag=FDMDemag(...))`
and named geometry, but no `study.universe.mesh(...)` dependency.

The `partial` status is intentional. FDM CPU FP64 has local field, energy, reciprocity,
and transfer evidence for the stated case classes. CUDA sources and the ABI contract are
implemented, but without a fresh, complete device comparison the GPU lane must not be
called production-qualified.

(multilayer-convolution-problem-statement)=
## 1. Problem fizyczny

Consider $L$ disconnected ferromagnetic objects. Index $s$ denotes a source layer and
$d$ a destination layer. Each layer has its own regular `native_grid`, cell size
$\mathbf h_s$, origin $\mathbf o_s$, active mask, and magnetization field $\mathbf M_s$.
The only permitted pair-offset convention is
$\boldsymbol\delta_{d,s}=\mathbf o_d-\mathbf o_s$.

The field in a destination layer is the sum of its self contribution and all inter-layer
contributions. FFT convolution accelerates this sum; it does not replace the magnetostatic
tensor with a local approximation. The `scratch_grid` is a computational tool. Physical
position, source-cell size, and destination-cell size remain part of the kernel.

(multilayer-convolution-governing-equations)=
## 2. Governing equations

### 2.1. Continuous model and discrete pair sum

Pole magnetostatyczne jest zdefiniowane przez

```{math}
:label: eq-multilayer-public-continuous-field
\mathbf H(\mathbf r)
=-\int_{\Omega_m}\mathcal N(\mathbf r-\mathbf r')
\mathbf M(\mathbf r')\,\mathrm dV'.
```

The implemented FDM contract is a directed source-to-destination pair sum corresponding
to equation (3) of Lepadatu (2019):

```{math}
:label: eq-multilayer-public-discrete-field
\mathbf H_{d,l}
=-\sum_{s=1}^{L}\sum_{\mathbf r_{s,j}\in V_s}
\mathsf N\!\left(
\mathbf r_{d,l}-\mathbf r_{s,j},\mathbf h_d,\mathbf h_s
\right)\mathbf M(\mathbf r_{s,j}).
```

The tensor $\mathsf N$ has six independent components:
$N_{xx}$, $N_{yy}$, $N_{zz}$, $N_{xy}$, $N_{xz}$ i $N_{yz}$. Znak minus
The minus sign belongs to the field definition. Tensor-vector multiplication in the FFT
domain accumulates the product without that sign, and the field stage applies the negation
exactly once.

### 2.2. Reciprocity i energia

For different cell volumes, reciprocity is volume-weighted:

```{math}
:label: eq-multilayer-public-reciprocity
V_d\,\mathsf N_{d\leftarrow s}(\mathbf q)
=V_s\,\mathsf N_{s\leftarrow d}^{\mathsf T}(-\mathbf q).
```

Simple equality of the two directions is valid only when $V_d=V_s$. The demagnetization
energy over active cells in all layers is

```{math}
:label: eq-multilayer-public-energy
E_{\mathrm d}
=-\frac{\mu_0}{2}\sum_{d=1}^{L}
\sum_{c\in\mathcal A_d}V_{d,c}\,
\mathbf M_{d,c}\mathbin\cdot\mathbf H_{d,c}.
```

The factor $1/2$ removes double counting of pair energy. The field, active mask, volumes,
and precision used by the energy reduction must match the field path.

### 2.3. Konwolucja FFT

Each source layer is transformed once, each ordered pair accumulates a six-component
tensor product, and each destination receives one inverse transform:

```{math}
:label: eq-multilayer-public-fft
\widehat{\mathbf H}_d(\mathbf k)
=-\sum_{s=1}^{L}
\widehat{\mathsf N}_{d\leftarrow s}(\mathbf k)
\widehat{\mathbf M}_s(\mathbf k),
\qquad
\mathbf H_d=\mathcal F^{-1}\!\left[\widehat{\mathbf H}_d\right].
```

One complete operator refresh for $L$ layers therefore has $L$ forward transforms, $L$
inverse transforms, and $L^2$ pair accumulations. These counters describe the demagnetization
operator, not automatically the residency of the complete time integrator.

### 2.4. Transfer between `native_grid` and `scratch_grid`

When native and scratch grids differ, magnetization is transferred by operator $P$:

```{math}
:label: eq-multilayer-public-transfer
\mathbf M(\mathbf r')=\sum_{i\in\mathcal P}w_i\mathbf M(\mathbf r_i).
```

The weights from equations (4)-(5) of Lepadatu are

```{math}
:label: eq-multilayer-public-transfer-weights
w_i=\frac{\widetilde d_i\delta_i}{\widetilde d_T},
\qquad
\widetilde d_T=\sum_{i\in\mathcal P}\widetilde d_i\delta_i,
\qquad
\widetilde d_i=
\frac{\lvert\mathbf h'+\mathbf h\rvert}{2}
-\lvert\mathbf r'-\mathbf r_i\rvert.
```

Returning the field to a native grid must use the volume-adjoint $P^*$:

```{math}
:label: eq-multilayer-public-transfer-adjoint
\left\langle P\mathbf M,\mathbf H_c\right\rangle_{V_c}
=\left\langle\mathbf M,P^*\mathbf H_c\right\rangle_{V_n}.
```

This identity is the work and energy conservation condition. Pointwise field interpolation
alone is not sufficient evidence of a correct transfer.

### 2.5. Irregular Newell tensor for unequal Z thickness

For common $h_x,h_y$ and different $h_{s,z},h_{d,z}$, Appendix A of the publication
defines

```{math}
:label: eq-multilayer-public-newell-a1
N_{xx}(\mathbf s)=
\mathcal L[f;\mathbf h_s,\mathbf h_d](\mathbf s),
\qquad
N_{xy}(\mathbf s)=
\mathcal L[g;\mathbf h_s,\mathbf h_d](\mathbf s).
```

```{math}
:label: eq-multilayer-public-newell-a2
\begin{aligned}
\mathcal L[w;\mathbf h_s,\mathbf h_d](\mathbf s)
=\frac{1}{\tau}
\sum_{\epsilon_1,\epsilon_2=-1}^{1}
(-1)^{|\epsilon_1|+|\epsilon_2|}
\bigl[&-w(x+\epsilon_1h_x,y+\epsilon_2h_y,z-h_{s,z})\\
&-w(x+\epsilon_1h_x,y+\epsilon_2h_y,z+h_{d,z})\\
&+w(x+\epsilon_1h_x,y+\epsilon_2h_y,z)\\
&+w(x+\epsilon_1h_x,y+\epsilon_2h_y,z-\Delta)\bigr].
\end{aligned}
```

```{math}
:label: eq-multilayer-public-newell-a3
\begin{aligned}
R^2&=x^2+y^2+z^2,
&\tau&=\pi h_xh_yh_{d,z},
&\Delta&=h_{s,z}-h_{d,z},\\
f(x,y,z)&=\frac{(2x^2-y^2-z^2)R}{6}
+\frac{y(z^2-x^2)}{4}
\ln\!\left(1+\frac{2y(y+R)}{x^2+z^2}\right)\\
&\quad+\frac{z(y^2-x^2)}{4}
\ln\!\left(1+\frac{2z(z+R)}{x^2+y^2}\right)
-xyz\arctan\!\frac{yz}{xR}.
\end{aligned}
```

```{math}
:label: eq-multilayer-public-newell-a4
\begin{aligned}
g(x,y,z)&=-\frac{xyR}{3}
-\frac{z^3}{6}\arctan\!\frac{xy}{zR}
-\frac{zy^2}{2}\arctan\!\frac{xz}{yR}
-\frac{zx^2}{2}\arctan\!\frac{yz}{xR}\\
&\quad+\frac{y(3z^2-y^2)}{12}
\ln\!\left(1+\frac{2x(x+R)}{y^2+z^2}\right)
+\frac{x(3z^2-x^2)}{12}
\ln\!\left(1+\frac{2y(y+R)}{x^2+z^2}\right)\\
&\quad+\frac{xyz}{2}
\ln\!\left(1+\frac{2z(z+R)}{x^2+y^2}\right).
\end{aligned}
```

The remaining components follow by axis permutations consistent with Newell-tensor
symmetry. Appendix A covers unequal Z thickness with a common XY cell size; it does not
justify arbitrary XY offsets or arbitrary, different XY grids.

(multilayer-convolution-symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---:|
| $L$ | liczba warstw magnetycznych | $1$ |
| $d,s$ | indeksy warstwy docelowej i źródłowej | $1$ |
| $l,j,c,i$ | indeksy komórek, składników lub punktów transferu | $1$ |
| $\Omega_m$ | magnetyczna część domeny | $\mathrm{m^3}$ |
| $V_s$ | domena albo objętość komórki źródłowej, zgodnie z kontekstem sumy | $\mathrm{m^3}$ |
| $V_d$ | objętość komórki docelowej | $\mathrm{m^3}$ |
| $V_{d,c}$ | objętość aktywnej komórki $c$ warstwy $d$ | $\mathrm{m^3}$ |
| $V_c$ | objętość komórki siatki konwolucyjnej | $\mathrm{m^3}$ |
| $V_n$ | objętość komórki siatki natywnej | $\mathrm{m^3}$ |
| $\mathbf r,\mathbf r'$ | pozycja obserwacji i pozycja źródła w modelu ciągłym | $\mathrm m$ |
| $\mathbf r_{d,l}$ | środek komórki docelowej | $\mathrm m$ |
| $\mathbf r_{s,j}$ | środek komórki źródłowej | $\mathrm m$ |
| $\mathbf r_i$ | środek komórki wejściowej transferu | $\mathrm m$ |
| $\mathbf o_d,\mathbf o_s$ | początki siatek docelowej i źródłowej | $\mathrm m$ |
| $\boldsymbol\delta_{d,s}$ | przesunięcie $\mathbf o_d-\mathbf o_s$ | $\mathrm m$ |
| $\mathbf q$ | lag przestrzenny kernela | $\mathrm m$ |
| $\mathbf s=(x,y,z)$ | argument przestrzenny operatora Appendix A | $\mathrm m$ |
| $x,y,z$ | współrzędne argumentu kernela | $\mathrm m$ |
| $R$ | odległość $\sqrt{x^2+y^2+z^2}$ | $\mathrm m$ |
| $\mathbf h_s,\mathbf h_d$ | rozmiary komórek źródła i celu | $\mathrm m$ |
| $\mathbf h,\mathbf h'$ | rozmiary komórek wejściowej i roboczej siatki transferu | $\mathrm m$ |
| $h_x,h_y$ | wspólne rozmiary komórki w osiach X i Y | $\mathrm m$ |
| $h_{s,z},h_{d,z}$ | grubości komórek źródła i celu | $\mathrm m$ |
| $\Delta$ | różnica $h_{s,z}-h_{d,z}$ | $\mathrm m$ |
| $\tau$ | normalizacja $\pi h_xh_yh_{d,z}$ | $\mathrm{m^3}$ |
| $\mathbf M,\mathbf M_s,\mathbf M_{d,c}$ | magnetyzacja | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H,\mathbf H_d,\mathbf H_{d,c},\mathbf H_c$ | pole magnetostatyczne lub demagnetyzujące | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf M}_s$ | transformata dyskretna magnetyzacji źródła | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathbf H}_d$ | transformata dyskretna pola celu | $\mathrm{A\,m^{-1}}$ |
| $\mathcal N$ | ciągłe jądro magnetostatyczne | $\mathrm{m^{-3}}$ |
| $\mathsf N,\mathsf N_{d\leftarrow s}$ | dyskretny tensor demagnetyzujący pary komórek | $1$ |
| $\widehat{\mathsf N}_{d\leftarrow s}$ | transformata dyskretna tensora pary | $1$ |
| $N_{xx},N_{yy},N_{zz},N_{xy},N_{xz},N_{yz}$ | sześć niezależnych składowych tensora | $1$ |
| $\mathcal F,\mathcal F^{-1}$ | dyskretna transformata Fouriera i jej odwrotność | $1$ |
| $\mathbf k$ | indeks lub wektor falowy dyskretnej transformaty | $\mathrm{m^{-1}}$ |
| $P,P^*$ | transfer native→scratch i jego sprzężenie objętościowe | $1$ |
| $\mathcal P$ | zbiór komórek uczestniczących w transferze | $1$ |
| $w_i$ | znormalizowana waga transferu | $1$ |
| $\delta_i$ | wskaźnik nakładania komórki | $1$ |
| $\widetilde d_i,\widetilde d_T$ | odległość ważona i jej suma | $\mathrm m$ |
| $\mathcal A_d$ | zbiór aktywnych komórek warstwy $d$ | $1$ |
| $E_{\mathrm d}$ | energia demagnetyzacyjna | $\mathrm J$ |
| $\mu_0$ | przenikalność magnetyczna próżni | $\mathrm{N\,A^{-2}}$ |
| $\mathcal L$ | nieregularny operator narożnikowy Newella | $1$ |
| $f,g,w$ | funkcje bazowe Appendix A | $\mathrm{m^3}$ |
| $\epsilon_1,\epsilon_2$ | indeksy sumy narożnikowej | $1$ |

(multilayer-convolution-assumptions-and-validity)=
## 4. Założenia, klasy kerneli i granice ważności

Obecny publiczny planner wymaga rozłącznych obiektów, tych samych rozmiarów XY
i tego samego środka XY. Przesunięcie w Z jest dozwolone; ogólny offset XY
jest odrzucany. Periodyczne osie są fail-closed, dopóki nie istnieje
kwalifikacja kerneli self/shifted i szwów exchange dla każdej warstwy.

`two_d_stack` jest przeznaczony dla cienkich warstw z jedną komórką natywną w
Z. Warstwa o wielu komórkach Z wymaga jawnego uśrednienia zachowującego moment
albo wyboru `three_d`; planner nie kopiuje arbitralnie jednej płaszczyzny.
`common_cells_xy=(N_x,N_y)` rozwiązuje roboczą siatkę
$(N_x,N_y,1)$. `common_cells=(N_x,N_y,N_z)` wybiera pełną siatkę 3D.

Klasy symetrii z Table I Lepadatu wyznaczają legalną reprezentację widma:

| Klasa | Geometria | Charakter widma i storage | Stan Fullmag |
|---|---|---|---|
| 2D-self | jedna komórka Z, brak shiftu | składowe diagonalne i XY rzeczywiste, reduced | CPU FP64 lokalnie zweryfikowane; brak production qualification |
| 3D-self | wspólny rozmiar komórki | rzeczywiste, reduced | mały lokalny oracle L=3; brak niezależnego managed receipt |
| 2D-zShift | wspólne XY, czysty shift Z | diagonalne/XY real, XZ/YZ imaginary, reduced | CPU FP64 lokalnie zweryfikowane dla obu znaków Z |
| 3D-zShift | wspólna komórka, czysty shift Z | complex, reduced | mały lokalny oracle; brak pełnej macierzy produkcyjnej |
| 2D-full | geometria bez parzystości shift-only | complex, full | niewykonywalne jako kwalifikowany lane |
| 3D-full | ogólna geometria 3D | complex, full | niewykonywalne jako kwalifikowany lane |

Zerowe dopełnienie musi mieć na każdej osi co najmniej
$n_{\mathrm{src}}+n_{\mathrm{dst}}-1$ próbek liniowej konwolucji. Descriptor
transformacji rozdziela fizyczne siatki od `fft_shape`, insertion offset,
położenia zera laga i cropu celu. Transformata inverse stosuje normalizację
$1/(F_xF_yF_z)$ dokładnie raz.

(multilayer-convolution-python-api)=
## 5. Python API

### 5.1. Pełna tabela parametrów

`FDMDemag` wybiera realizację numeryczną. `FDMGrid` i `FDM` definiują natywne
siatki. Fizyczne obiekty nadal powstają przez `study.geometry(...)`; nazwy w
`per_magnet` muszą odpowiadać kanonicznym nazwom tych obiektów.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDMGrid.cell` | `Sequence[float]` | `required` | $\mathrm m$ | Dokładnie trzy skończone wartości większe od zera. | Natywny rozmiar komórki jednego magnesu. | FDM CPU/GPU authoring; wykonanie zależy od lane'u. | `backend_policy.discretization_hints.fdm.per_magnet.<name>.cell` |
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm m$ | Dokładnie trzy dodatnie wartości; nie może wystąpić razem z `default_cell`. | Zgodny wstecznie alias domyślnego rozmiaru komórki. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.cell` i znormalizowane `default_cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm m$ | Dokładnie trzy dodatnie wartości; wymagane, jeżeli mapa per-magnet jest niepełna. | Domyślny natywny rozmiar komórki. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.default_cell` |
| `FDM.per_magnet` | `dict[str,FDMGrid] \| None` | `None` | $1$ | Klucze są niepustymi nazwami; wartości muszą być `FDMGrid`. | Nadpisania siatki dla nazwanych magnesów. | FDM multilayer CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | $1$ | Wartość jest instancją `FDMDemag`. | Polityka realizacji pola demagnetyzującego. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.demag` |
| `FDMDemag.strategy` | `Literal[str]` | `auto` | $1$ | `auto`, `single_grid` albo `multilayer_convolution`. | Requested strategy; jawny wybór multilayer nie może spaść po cichu do single grid. | FDM CPU/GPU authoring; runtime kwalifikowany per lane. | `backend_policy.discretization_hints.fdm.demag.strategy` |
| `FDMDemag.mode` | `Literal[str]` | `auto` | $1$ | `auto`, `two_d_stack` albo `three_d`. | Requested mode; `auto` rozwiązuje planner po poznaniu geometrii warstw. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.demag.mode` |
| `FDMDemag.common_cells` | `tuple[int,int,int] \| None` | `None` | $1$ | Trzy dodatnie liczby całkowite; wyklucza `common_cells_xy` i `two_d_stack`. | Jawny rozmiar wspólnej roboczej siatki 3D. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.demag.common_cells` |
| `FDMDemag.common_cells_xy` | `tuple[int,int] \| None` | `None` | $1$ | Dwie dodatnie liczby całkowite; wyklucza `common_cells` i `three_d`. | Jawny rozmiar wspólnej siatki XY dla stosu 2D. | FDM CPU/GPU authoring. | `backend_policy.discretization_hints.fdm.demag.common_cells_xy` |
| `FDMDemag.explain` | `bool` | `True` | $1$ | Wartość logiczna. | Żąda czytelnego wyjaśnienia planu; nie jest polem fizycznym i nie jest serializowana przez `to_ir()`. | FDM authoring helper. | `not serialized` |
| `FDMDemag.allow_single_grid_fallback` | `bool \| None` | `None` | $1$ | Każda wartość różna od `None` zgłasza `ValueError`. | Usunięty przełącznik zgodności; zabrania cichego fallbacku. | Unsupported combinations są odrzucane. | `not serialized` |

`boundary_correction`, `boundary_phi_floor` i `boundary_delta_min` należą do
ogólnej polityki częściowych komórek FDM. Nie są parametrami algorytmu
multilayer convolution i dlatego nie są przedstawiane jako regulatory FFT,
paddingu albo dokładności transferu.

### 5.2. Kompletny przykład `two_d_stack`

Przykład jest stage-first, używa SI i zachowuje nazwy obiektów między
`per_magnet` i `study.geometry`. Jego wykonanie przez loader weryfikuje
authoring i lowering; samo umieszczenie etapu nie stanowi dowodu uruchomienia
native solvera.

```python
# %% Import i study
import fullmag as fm

study = fm.study("fdm_multilayer_two_d_stack_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)

# %% FDM i polityka demag
cell = (4e-9, 4e-9, 3e-9)
study.fdm(
    default_cell=cell,
    per_magnet={
        "layer_bottom": fm.FDMGrid(cell=cell),
        "layer_top": fm.FDMGrid(cell=cell),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=(8, 4),
        explain=True,
    ),
)

# %% Domena, geometria i materiał
study.universe(
    mode="manual",
    size=(40e-9, 24e-9, 30e-9),
    center=(0.0, 0.0, 4.5e-9),
    padding=(0.0, 0.0, 0.0),
)
study.universe.mesh(minimum_element_size=3e-9, maximum_element_size=3e-9)

bottom = study.geometry(
    fm.Box(size=(32e-9, 16e-9, 3e-9), name="layer_bottom_geom"),
    name="layer_bottom",
)
top = study.geometry(
    fm.Box(size=(32e-9, 16e-9, 3e-9), name="layer_top_geom").translate(
        (0.0, 0.0, 9e-9)
    ),
    name="layer_top",
)
for layer in (bottom, top):
    layer.Ms = 8e5
    layer.Aex = 13e-12
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))

# %% Interakcje, obserwable i etap
study.exchange(enabled=True)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)
study.save("H_demag", every=1e-12)
study.solver(fix_dt=1e-14, gamma=2.211e5)
study.tableautosave(
    1e-13,
    quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total"],
)
study.stages.add_run(until=1e-12, stage_id="multilayer_run")
```

### 5.3. Kiedy użyć `three_d`

Ustaw `mode="three_d"` i `common_cells=(N_x,N_y,N_z)`, gdy co najmniej jedna
warstwa ma wiele natywnych komórek Z albo gdy tekstura w grubości ma znaczenie.
Nie ustawiaj równocześnie `common_cells_xy`. Dla najprostszego identity transfer
wybierz wspólną siatkę równą siatce natywnej każdej warstwy. Różne siatki
uruchamiają `push_pull` i wymagają oddzielnej oceny błędu transferu.

(multilayer-convolution-problem-ir)=
## 6. ProblemIR, planner i provenance

`FDMGrid.to_ir()` normalizuje tuple komórki do listy SI. `FDMDemag.to_ir()`
zapisuje wyłącznie requested strategy, requested mode i opcjonalny wspólny
layout. `explain` nie zmienia fizyki i nie trafia do `ProblemIR`.

Poniższy fragment jest rzeczywistym kształtem serializacji dla scenariusza
L=3 z `mode="three_d"`:

```json
{
  "backend_policy": {
    "discretization_hints": {
      "fdm": {
        "cell": [3.90625e-09, 3.90625e-09, 3e-09],
        "default_cell": [3.90625e-09, 3.90625e-09, 3e-09],
        "per_magnet": {
          "layer_bottom": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]},
          "layer_middle": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]},
          "layer_top": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]}
        },
        "demag": {
          "strategy": "multilayer_convolution",
          "mode": "three_d",
          "common_cells": [16, 8, 2]
        }
      }
    }
  }
}
```

Planner tworzy osobny `FdmLayerPlanIR` dla każdego obiektu i
`FdmMultilayerPlanIR` dla całej realizacji. Warstwa zawiera stabilne
`layer_id`, `object_id`, natywną siatkę, początek, maskę, roboczą siatkę i
`transfer_kind`. `planner_summary` zachowuje jednocześnie
`requested_strategy`, `selected_strategy`, `requested_mode`, `resolved_mode`,
eligibility oraz oszacowanie liczby i pamięci kerneli.

(multilayer-convolution-round-trip-and-failure-semantics)=
## 7. Round-trip i semantyka błędów

**requested intent** jest authored kontraktem: strategią, trybem, per-magnet
cells, wspólnym layoutem, urządzeniem i precyzją. **resolved execution** jest
decyzją planera i runtime: rzeczywistym trybem, siatkami, transferami,
paddingiem, backendem FFT, urządzeniem i licznikami operatora. Eksport z UI do
Pythona zachowuje requested intent jako `study.fdm(...,
demag=fm.FDMDemag(...))`; nie eksportuje multilayer jako realizacji FEM.

**validation errors** są zwracane dla niepoprawnych enumów, niepozytywnych
rozmiarów, równoczesnego `common_cells` i `common_cells_xy`, niezgodności trybu
z layoutem, brakujących per-magnet cells, nakładających się warstw, różnych
extent/center XY, offsetu XY i periodyczności. **unsupported combinations**
muszą zostać odrzucone; planner nie może po cichu zmienić strategii, urządzenia,
precyzji, warunków brzegowych ani usunąć interakcji.

Artefakt runtime powinien rozdzielać requested/resolved demag realization,
transfer telemetry i stage telemetry CUDA. Liczniki CUDA `L/L/L²` dowodzą
kształtu jednego device demag refresh, ale nie dowodzą, że cały integrator był
device-resident.

(multilayer-convolution-discrete-realization)=
## 8. Realizacje backendowe

| Solver | Device | Status | Co jest zaimplementowane | Czego status nie dowodzi |
|---|---|---|---|---|
| FDM | CPU | `reference-executable`, nie production-qualified | FP64, FFT, sześcioskładnikowe pary, identity i push/pull, pole i energia; lokalne oracles 2D/3D i Airbox convergence w wyszczególnionym zakresie. | Nie kwalifikuje automatycznie ogólnego full-complex, PBC ani wszystkich rozmiarów i przesunięć. |
| FDM | GPU | `implemented`, runtime-unqualified | ABI v2, plan D-07, workspace cuFFT i liczniki stage telemetry są obecne w źródłach. | Build i kontrakt ABI nie zastępują świeżego executed-device field/energy parity; FP32 ma osobne progi. |
| FEM | CPU | `not-applicable` | Brak: ta metoda jest kartezjańską konwolucją Newella/FFT na siatkach FDM. | Nie opisuje Poissona na airboxie ani FEM-BEM. |
| FEM | GPU | `not-applicable` | Brak z tego samego powodu fizyczno-numerycznego; FEM GPU ma własne realizacje magnetostatyki. | Nie można wybrać `multilayer_convolution` jako realizacji FEM. |

### 8.1. FDM CPU

CPU FP64 jest referencyjnym lane'em wykonawczym. `MultilayerDemagRuntime`
zeruje widmo każdego celu, sumuje wszystkie źródła, wykonuje inverse FFT i
przenosi pole na native grid. Dla lane'u 2D produkcyjny builder Newella używa
dokładnej sumy narożników. Ogólny 3D ma jawnie ograniczoną gałąź asymptotyczną
dla dalekich par; dlatego zakres orakla musi być raportowany razem z wynikiem.

### 8.2. FDM CUDA

Native plan v2 przechowuje deskryptory warstw i par, tworzy compute stream oraz
workspace cuFFT. Identity common-grid może używać urządzeniowego D-07; ścieżka
heterogeniczna może zachować host-authoritative orchestration. Provenance ma
raportować tę różnicę zamiast nazywać cały run device-resident.

(multilayer-convolution-implementation-mapping)=
## 9. Włączenie i kontrola w UI

1. Otwórz moduł **Study** w jednolitym workspace i wybierz globalny węzeł
   study w Explorerze, aby otworzyć jego Inspector.
2. Ustaw **Engine** na `FDM`, **Requested device** na `CPU`, `CUDA` albo
   `Auto`, **Requested precision** na `Double` lub `Single` i pozostaw
   **Mode**=`Strict`, jeżeli brak fallbacku jest wymagany.
3. Włącz **Demag enabled**. W polu **FDM demag** wybierz
   **FDM multilayer convolution**.
4. W **FDM default cell** podaj `dx, dy, dz` w metrach. W **FDM per-magnet
   grids** podaj obiekt JSON, którego klucze są dokładnymi nazwami magnesów,
   na przykład `{"layer_bottom":{"cell":[4e-9,4e-9,3e-9]}}`.
5. Dla cienkich, jednokomórkowych warstw wybierz **FDM demag mode** =
   **2-D stack** i wpisz `Nx, Ny` w **Common convolution cells XY**. Pole
   **Common convolution cells** pozostaw puste.
6. Dla pełnego 3D wybierz **3-D** i wpisz `Nx, Ny, Nz` w **Common convolution
   cells**. Pole XY pozostaw puste. Dodatnie liczby całkowite są obowiązkowe.
7. Włącz **Explain FDM demag plan**, aby zachować wyjaśnienie decyzji planera.
   Następnie zastosuj draft; walidator UI odrzuci sprzeczne pary parametrów.

Po materializacji runtime Explorer pokazuje natywne cele warstw jako osobne
węzły `fdm-native-layer:<layer-id>`. Jeżeli opublikowano target-only Airbox,
pojawia się osobny cel Airbox. Wybierz warstwę lub Airbox, następnie quantity
`H_demag`, aby skierować żądanie pola do tego celu. Dla Airbox `H_eff` jest
jawnie niedostępne i UI nie powinno syntetyzować tego pola.

Viewport obsługuje bryły warstw, bounds, wireframe, points i wektory pola.
Pełny Airbox wireframe obejmuje również wewnętrzny bounds/volume overlay.
Widoczny obraz nie jest sam w sobie dowodem poprawności: kwalifikacja wymaga
świeżego `compute_fields`, danych pochodzących z runtime, działającego WebGL i
niezerowego drawing buffer.

### 9.1. Stabilne mapowanie implementacji

| Odpowiedzialność | Path | Symbol | Lane |
|---|---|---|---|
| Python grid | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | Public authoring |
| Python demag policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | Public authoring |
| Python FDM wrapper | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | Public authoring |
| ProblemIR validation | `crates/fullmag-ir/src/mesh_hints.rs` | `FdmDemagHintsIR::validate` | FDM authored and resolved IR |
| Planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | FDM planner |
| CPU runtime | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `execute_reference_fdm_multilayer` | FDM CPU FP64 |
| CPU observation and energy | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `observe_multilayer` | FDM CPU FP64 |
| Push transfer | `crates/fullmag-fdm-demag/src/transfer.rs` | `push_m_with_boundary_policy` | FDM CPU transfer |
| Pull transfer | `crates/fullmag-fdm-demag/src/transfer.rs` | `pull_h_with_boundary_policy` | FDM CPU transfer |
| Newell diagonal primitive | `crates/fullmag-fdm-demag/src/newell.rs` | `newell_f` | Kernel preparation |
| Newell cross primitive | `crates/fullmag-fdm-demag/src/newell.rs` | `newell_g` | Kernel preparation |
| Shifted Newell builder | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels_shifted` | Shifted pair kernel |
| CUDA v2 plan creation | `backends/fdm/api/c_api.cpp` | `fullmag_fdm_backend_create_v2` | FDM CUDA |
| CUDA FFT workspace | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_prepare_multilayer_fft_workspace_v2` | FDM CUDA |
| UI round-trip model | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `createStudyGlobalDraft` | Control Room authoring |
| UI native-layer adapter | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainMeta` | Explorer/viewport |
| UI Airbox adapter | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainPresentation` | Explorer/viewport |

(multilayer-convolution-validation)=
## 10. Walidacja i rzeczywisty stan dowodów

Statusy są rozłączne: `implemented` oznacza obecność kodu, `executable`
uruchamialny kontrakt, `runtime-verified` świeże wykonanie,
`physically-validated` niezależny oracle, a `production-qualified` kompletną
macierz dowodów. Niższy status nie dziedziczy wyższego.

| Zakres | Dowód | Stan |
|---|---|---|
| CPU 2D-self FP64 | pełne pole L=1, energia, reciprocity, cubature i self-trace | lokalnie physically-validated; nie production-qualified |
| CPU 2D-zShift FP64 | pełne pole L=2 dla obu znaków Z, energia i ważone reciprocity | lokalnie physically-validated; nie production-qualified |
| CPU 3D identity FP64 | mały L=3, pełne pole, energia, reciprocity, self-trace i cubature | lokalnie physically-validated; brak niezależnego managed receipt |
| CPU push/pull FP64 | przypadek equal oraz mały unequal, pole, energia i adjointness | lokalnie physically-validated w opisanym zakresie |
| CPU target-only Airbox | zbieżność `160×40×18` względem `160×40×24` na wspólnych centrach | locally runtime-verified i physically-validated w tej parze meshów |
| CUDA FP64 | kontrakt ABI v2, utworzenie planu i testy statyczne | implemented/executable contract; brak świeżego device parity |
| CUDA FP32 | źródła i ścieżka runtime | nie runtime-verified i nie physically-validated |
| UI/viewport | testy round-trip, adapterów, Explorer/Inspector i render modelu | contract-verified; brak świeżego post-integration browser/WebGL proof |

Niezależny oracle powinien sprawdzać sześć składowych, znaki lagów, pełne
pokrycie pola, energię, weighted reciprocity, moment transferu i adjointness.
Porównanie dwóch ścieżek korzystających z tego samego buildera kernela nie jest
niezależnym dowodem fizycznym.

(multilayer-convolution-limitations)=
## 11. Ograniczenia

- PBC, ogólny offset XY i pełne klasy 2D/3D full-complex nie są obecnie
  production-qualified.
- `two_d_stack` nie reprezentuje tekstury w grubości bez jawnego,
  moment-zachowującego transferu.
- Różne komórki XY wymagają wspólnej siatki transferowej albo odrzucenia;
  Appendix A nie legalizuje dowolnej różnicy XY.
- CPU FP64 jest referencją wykonawczą, ale nie zastępuje niezależnej analityki
  lub cubature.
- Build CUDA, obecność cuFFT i poprawny ABI nie są dowodem parity pola i
  energii na konkretnym GPU.
- Target-only Airbox publikuje `H_demag`. `H_eff` poza domeną magnetyczną ma
  versioned unavailable reason i nie jest syntetyzowane.
- Scenariusze SP4-derived służą traceability. Nie zmieniają kanonicznej
  definicji µMAG Standard Problem 4.

(multilayer-convolution-scientific-bibliography)=
## 12. Bibliografia naukowa

1. S. Lepadatu, “Efficient computation of demagnetizing fields for magnetic
   multilayers using multilayered convolution,” *Journal of Applied Physics*
   **126**, 103903 (2019),
   [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
2. A. J. Newell, W. Williams i D. J. Dunlop, “A generalization of the
   demagnetizing tensor for nonuniform magnetization,” *Journal of
   Geophysical Research: Solid Earth* **98**, 9551–9555 (1993),
   [doi:10.1029/93JE01171](https://doi.org/10.1029/93JE01171).
3. A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,”
   *Journal of Applied Physics* **83**, 3432–3434 (1998),
   [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).

### Granica clean-room BORIS

BORIS był użyty wyłącznie jako zewnętrzny materiał traceability dla
architektury kategorii kerneli i organizacji konwolucji. Kanonicznym zapisem
tej granicy jest `docs/physics/multilayer_convolution/boris-reference-manifest.v1.json`.
Kod BORIS nie jest kopiowany do Fullmag, nie jest oraklem numerycznym i nie
stanowi dowodu kwalifikacji. Równania na tej stronie pochodzą z publikacji
Lepadatu i Newella oraz są mapowane do niezależnie utrzymywanego kodu Fullmag.

(multilayer-convolution-source-code-index)=
## 13. Indeks kodu źródłowego

| Claim | Path | Symbol | Responsibility | Lane | Tests/evidence | Evidence status | Immutable link |
|---|---|---|---|---|---|---|---|
| Python grid | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | Waliduje i obniża komórkę per magnet. | Public API | `packages/fullmag-py/tests/test_fdm_multilayer_contract.py` | executable authoring | Niedostępny przed committem |
| Python demag policy | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | Waliduje requested strategy/mode/common layout. | Public API | `packages/fullmag-py/tests/test_fdm_multilayer_contract.py` | executable authoring | Niedostępny przed committem |
| Python FDM wrapper | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | Obniża pełne hints FDM. | Public API | `packages/fullmag-py/tests/test_fdm_ui_roundtrip.py` | round-trip contract | Niedostępny przed committem |
| ProblemIR topology identity | `crates/fullmag-ir/src/mesh_hints.rs` | `fdm_multilayer_topology_tokens` | Wiąże resolved mode i geometrię warstw z certyfikatem topologii. | IR | `crates/fullmag-ir/src/mesh_hints.rs` tests | executable contract | Niedostępny przed committem |
| ProblemIR validation | `crates/fullmag-ir/src/mesh_hints.rs` | `FdmDemagHintsIR::validate` | Odrzuca nielegalną authored konfigurację. | IR | `crates/fullmag-ir/src/mesh_hints.rs` tests | executable contract | Niedostępny przed committem |
| Planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | Rozwiązuje tryb, warstwy, grid certificate i transfer. | Planner | `crates/fullmag-plan/src/tests.rs` multilayer tests | executable contract | Niedostępny przed committem |
| CPU runtime | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `execute_reference_fdm_multilayer` | Uruchamia CPU reference; runtime wykonuje FFT, pary i pull pola. | FDM CPU FP64 | engine multilayer tests i niezależne oracles | runtime-verified, zakresowy | Niedostępny przed committem |
| CPU observation and energy | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `observe_multilayer` | Publikuje pole, energię i provenance CPU. | FDM CPU FP64 | SP4-derived runtime artifacts | runtime-verified, zakresowy | Niedostępny przed committem |
| Push transfer | `crates/fullmag-fdm-demag/src/transfer.rs` | `push_m_with_boundary_policy` | Przenosi magnetyzację na scratch grid. | FDM CPU transfer | transfer parity oracle | physically-validated, zakresowy | Niedostępny przed committem |
| Pull transfer | `crates/fullmag-fdm-demag/src/transfer.rs` | `pull_h_with_boundary_policy` | Stosuje powrót pola do native grid. | FDM CPU transfer | adjointness oracle | physically-validated, zakresowy | Niedostępny przed committem |
| Newell diagonal primitive | `crates/fullmag-fdm-demag/src/newell.rs` | `newell_f` | Funkcja $f$ tensora Newella. | Kernel preparation | Newell reference tests | code/test evidence | Niedostępny przed committem |
| Newell cross primitive | `crates/fullmag-fdm-demag/src/newell.rs` | `newell_g` | Funkcja $g$ tensora Newella. | Kernel preparation | Newell reference tests | code/test evidence | Niedostępny przed committem |
| Shifted Newell builder | `crates/fullmag-fdm-demag/src/newell.rs` | `compute_newell_kernels_shifted` | Buduje tensor dla zorientowanego shiftu. | FDM CPU kernel | shifted/cubature tests | locally physically-validated | Niedostępny przed committem |
| CUDA v2 plan creation | `backends/fdm/api/c_api.cpp` | `fullmag_fdm_backend_create_v2` | Waliduje, uploaduje i przygotowuje plan D-07. | FDM CUDA | managed ABI/contract tests | executable contract, no device parity | Niedostępny przed committem |
| CUDA FFT workspace | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_prepare_multilayer_fft_workspace_v2` | Przygotowuje batched workspace cuFFT. | FDM CUDA | managed contract tests | executable contract, no device parity | Niedostępny przed committem |
| UI round-trip model | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `createStudyGlobalDraft` | Czyta scene FDM do draftu Inspectora. | Control Room | `StudyGlobalAuthoringModel.test.ts` | contract-verified | Niedostępny przed committem |
| UI native-layer adapter | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainMeta` | Stanowi bazę dla osobnych celów warstw. | Explorer/viewport | viewport adapter tests | contract-verified | Niedostępny przed committem |
| UI Airbox adapter | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainPresentation` | Stanowi bazę dla target-only Airbox. | Explorer/viewport | viewport adapter tests | contract-verified, no fresh browser proof | Niedostępny przed committem |
