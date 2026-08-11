# Behawioralna specyfikacja multilayer convolution BORIS

Ta nota jest zapisem zachowania zaobserwowanego w lokalnym snapshotcie BORIS
identyfikowanym przez `boris-reference-manifest.v1.json`. Jest to materiał
traceability w trybie clean-room: nie zawiera kodu BORIS, prywatnego układu typów
ani skopiowanej implementacji. Nie jest ani oraklem numerycznym Fullmag, ani
potwierdzeniem kwalifikacji produkcyjnej.

(problem-statement)=
## Problem fizyczny

Przedmiotem noty jest organizacja konwolucji demagnetyzacyjnej dla wielu
rozłącznych siatek FDM. Dla każdej pary źródło--cel zachowujemy osobną geometrię
native, wspólną geometrię scratch oraz jawne transfery. Rectangle collection,
`n_common` i moduły FFT są stanem obliczeniowym; nie tworzą ferromagnetycznego
supermeshu ani dodatkowego materiału.

(governing-equations)=
## Równania rządzące

Wspólny kontrakt pola dla uporządkowanych par ma postać:

```{math}
:label: boris-ordered-field
\mathbf H_d=-\sum_{s=1}^{L}\mathsf N_{d\leftarrow s}\mathbf M_s .
```

Implementacja konwolucyjna rozkłada operator na transformacje źródeł, wszystkie
uporządkowane iloczyny tensorowe i odwrotne transformacje celów:

```{math}
:label: boris-fft-decomposition
\widehat{\mathbf H}_d=-\sum_{s=1}^{L}
\widehat{\mathsf N}_{d\leftarrow s}\,\widehat{\mathbf M}_s,
\qquad d=1,\ldots,L .
```

Minus pozostaje częścią iloczynu widmowego i jest stosowany dokładnie raz.
Równania opisują obserwowalny kontrakt wejść i wyjść; nie są dowodem zgodności BORIS z Fullmag.

(symbols-and-si-units)=
## Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf H_d$ | pole demagnetyzujące w siatce celu $d$ | $\mathrm{A\,m^{-1}}$ |
| $\mathsf N_{d\leftarrow s}$ | tensor demagnetyzujący pary źródło--cel | $1$ |
| $\mathbf M_s$ | magnetyzacja źródła $s$ | $\mathrm{A\,m^{-1}}$ |
| $L$ | liczba uczestniczących warstw/siatek | $1$ |
| $\widehat{\mathbf M}_s$ | widmo magnetyzacji źródła | $\mathrm{A\,m^{-1}}$ |
| $\widehat{\mathsf N}_{d\leftarrow s}$ | widmowy tensor pary | $1$ |
| $\widehat{\mathbf H}_d$ | widmowe pole celu | $\mathrm{A\,m^{-1}}$ |
| $n_{\mathrm{common}}$ | liczby komórek wspólnego scratch gridu | $1$ |
| $\mathbf h_s,\mathbf h_d$ | rozmiary komórek źródła i celu | $\mathrm m$ |

(assumptions-and-validity)=
## Założenia i granice ważności

Nota obejmuje otwarty brzeg, niepokrywające się domeny, jawne znaki przesunięć
źródło--cel oraz osobne reprezentacje 2-D i 3-D. Wymiar Z, rozmiar komórek,
kształt FFT, maska i transfer są częścią tożsamości kernela. Tryby BORIS
`force_2d_convolution=0/1/2`, PBC, supermesh, pełna macierz CUDA i wszystkie
rodziny storage pozostają odrębnymi kontraktami. Opis zachowania nie zastępuje
testu pola, energii, reciprocity, urządzenia ani przeglądarki.

(python-api)=
## Python API Fullmag

Nota BORIS nie dodaje publicznego API. Pokazuje jedynie, jak żądanie
`multilayer_convolution` jest authorowane w kanonicznym DSL Fullmag:

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDMDemag.strategy` | `Literal[str]` | `auto` | $1$ | `auto`, `single_grid`, `multilayer_convolution` | żądana realizacja demag | FDM CPU/GPU; lane gated | `backend_policy.discretization_hints.fdm.demag.strategy` |
| `FDMDemag.mode` | `Literal["auto", "two_d_stack", "three_d"]` | `auto` | $1$ | `auto`, `two_d_stack` lub `three_d`; explicite `two_d_stack` odrzuca `common_cells`, a explicite `three_d` odrzuca `common_cells_xy` | żądany model wymiaru native warstw; `auto` jest rozwiązywane przez planner | FDM CPU/GPU; z ograniczeniami | `backend_policy.discretization_hints.fdm.demag.mode` |
| `FDMDemag.common_cells_xy` | `tuple[int,int] \| None` | `None` | $1$ | dodatnie $N_x,N_y$; dozwolone z `auto` lub `two_d_stack`, wzajemnie wyłączne z `common_cells` | hint liczby komórek scratch XY; przy `auto` rozwiązuje `two_d_stack` | FDM; nie jest meshem fizycznym | `backend_policy.discretization_hints.fdm.demag.common_cells_xy` |

```python
# %% Import i study
import fullmag as fm

study = fm.study("boris_behavior_traceability")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)

# %% Żądanie multilayer convolution
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

# %% Dwie warstwy i stage-first execution
study.universe(mode="manual", size=(40e-9, 24e-9, 30e-9), center=(0.0, 0.0, 4.5e-9))
bottom = study.geometry(fm.Box(size=(32e-9, 16e-9, 3e-9)), name="layer_bottom")
top = study.geometry(
    fm.Box(size=(32e-9, 16e-9, 3e-9)).translate((0.0, 0.0, 9e-9)),
    name="layer_top",
)
for layer in (bottom, top):
    layer.Ms = 8e5
    layer.Aex = 13e-12
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange(enabled=True)
study.stages.add_run(until=1e-12, stage_id="traceability_run")
```

(problem-ir)=
## ProblemIR i provenance

Python zapisuje żądany `strategy`, `mode` i hinty common-layout. Domyślne
`mode="auto"` pozostaje w `ProblemIR` i rozwiązuje się do `two_d_stack` dla
`common_cells_xy` lub warstw o jednym Z, w przeciwnym razie do `three_d`.
Planner normalizuje wynik do `FdmLayerPlanIR` i `CommonTransformLayout`; native
cell, origin, maska, transfer, `fft_shape`, crop i provenance nie są `n_common`; round-trip zachowuje requested intent i resolved execution.

(round-trip-and-failure-semantics)=
## Round-trip i semantyka błędów

Eksporter Python odtwarza żądany DSL, nie przypadkowy układ scratch. Planner
odrzuca niezgodne wymiary, nakładające się warstwy, PBC i nieobsługiwany storage;
validation errors są jawne. Requested intent i resolved execution pozostają
rozłączne, a unsupported combinations nie przechodzą cicho do `single_grid` ani
do innej precyzji. Poniższe kotwice są traceability, nie fallbackiem runtime.

(discrete-realization)=
## Realizacja dyskretna i kotwice zachowania BORIS

(boris-rect-collection)=
### Kolekcja prostokątów

Właściciel demagnetyzacji przechowuje jeden rectangle dla każdej uczestniczącej
siatki i wyprowadza wspólną obwiednię scratch z extents oraz origins.

(boris-common-n)=
### Wspólne liczby komórek

Domyślne `n_common` wynikają z kolekcji prostokątów. W polityce 2-D wymiar Z ma
jedną komórkę; nie zmienia to native cell size żadnej warstwy.

(boris-header-force-mode)=
### Force mode

Komentarze nagłówka rozróżniają brak wymuszenia 2-D, traktowanie każdej siatki
jak 2-D oraz warstwowanie wzdłuż Z. Fullmag nie utożsamia tych wartości z
`mode="two_d_stack"`.

(boris-set-n-common)=
### Jawne `n_common`

Jawny setter zastępuje automatycznie wyznaczone counts i zmienia wyłącznie
layout transformacji.

(boris-convolution-rect)=
### Convolution rectangle

Skorygowany rectangle jest przekazywany modułom scratch do wyrównania
transformacji; nie jest wsparciem materiałowym.

(boris-mconv-init)=
### Inicjalizacja

Inicjalizacja tworzy moduł scratch/transformacji dla każdej warstwy i organizuje
pary źródło--cel.

(boris-mconv-update)=
### Aktualizacja

Aktualizacja wykonuje transformaty źródeł, akumuluje wszystkie uporządkowane
iloczyny tensorowe i wykonuje odwrotną transformatę dla każdego celu.

(boris-2d-mode)=
### Polityka 2-D

Przełącznik 2-D zmienia dopuszczalną reprezentację Z; nie redukuje po cichu
warstwy wielokomórkowej bez jawnego transferu.

(boris-multilayer-toggle)=
### Multilayer kontra supermesh

Tryb multilayer wybiera niezależne moduły warstwowe zamiast jednej konwolucji
supermeshu. Są to różne kontrakty własności siatek i transferów.

(boris-kernel-catalog)=
### Katalog kerneli

Katalog rozróżnia rodziny self, shifted i full-complex dla układów 2-D oraz 3-D.
Wpis katalogu opisuje klasę pary, a nie tylko skalarne oddalenie.

(boris-kernel-reuse)=
### Reuse

Reuse jest dozwolone tylko przy zgodności pełnej tożsamości pary: cell sizes,
shiftu, storage i transform shape.

(boris-kernel-storage)=
### Metadane storage

Real/complex representation, shift class, rozmiary komórek i transform
dimensions są częścią metadanych kernela.

(boris-kernel-multiply)=
### Mnożenie 2-D

Ścieżka 2-D konsumuje wszystkie uporządkowane źródła dla celu i rozróżnia
akumulację self oraz cross.

(boris-kernel-multiply-3d)=
### Mnożenie 3-D

Ścieżka 3-D zachowuje ten sam kontrakt par źródło--cel dla pełnego zestawu
składowych tensora.

(boris-irregular-thickness)=
### Nierówne grubości

Rodzina nieregularna zachowuje osobno grubość źródła i celu przy wspólnym XY;
średnia grubość nie jest poprawnym zamiennikiem.

(boris-weighted-transfer)=
### Transfer ważony

Transfer magnetyzacji do common gridu i pola z powrotem używa jawnych wag i
wpływa na interpretację energii.

(boris-cuda-update)=
### Aktualizacja CUDA

CUDA odwzorowuje fazy hosta: source transforms, pair accumulation, destination
inverse transforms i transfery mają osobne bufory urządzenia.

(boris-cuda-init)=
### Inicjalizacja CUDA

Inicjalizacja CUDA przygotowuje per-layer scratch, transform dimensions i device
kernel state; sama obecność tych faz nie jest dowodem parity Fullmag.

(implementation-mapping)=
## Mapowanie implementacji

Behavioral specification jest wyłącznie kotwicą porównawczą. Właścicielami
implementacji Fullmag są `FDMDemag`, `FdmLayerPlanIR`, katalog kerneli CPU oraz
oddzielna realizacja CUDA; żaden z nich nie dziedziczy nazw prywatnych BORIS.

(validation)=
## Walidacja

Walidacja noty sprawdza unikalność kotwic i zgodność source-map. Walidacja
numeryczna Fullmag musi dodatkowo wykazać pole, energię, reciprocity, transfer,
FP64/FP32, urządzenie i świeży artefakt runtime dla każdej rodziny kernela.
Status tej noty pozostaje `traceability only`; nie promuje żadnego lane do
`runtime-verified` ani `production-qualified`.

(limitations)=
## Ograniczenia

Nie zapisano kodu BORIS ani nie przypisano mu znaczenia oracle. Nie wnioskujemy
z tej noty o poprawności PBC, AFM/atomistic meshes, reduced/full storage,
dynamicznego replanu, WebGL ani o zgodności wydajnościowej. Różnica obserwowana
w snapshotcie musi zostać przełożona na niezależny kontrakt Fullmag i test.

(scientific-bibliography)=
## Bibliografia naukowa

1. S. Lepadatu, “Efficient computation of demagnetizing fields for magnetic
   multilayers using multilayered convolution,” *Journal of Applied Physics*
   **126**, 103903 (2019), [doi:10.1063/1.5116754](https://doi.org/10.1063/1.5116754).
2. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the
   demagnetizing tensor for nonuniform magnetization,” *J. Geophys. Res.*
   **98**, 9551--9555 (1993), [doi:10.1029/93JE01171](https://doi.org/10.1029/93JE01171).

(source-code-index)=
## Indeks źródeł i kotwic

| Claim | Path | Symbol | Responsibility | Lane | Evidence status |
|---|---|---|---|---|---|
| Rectangle collection | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-rect-collection` | per-layer rectangles i scratch alignment | BORIS reference | planned contract |
| Common counts | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-common-n` | default counts i wymiar Z | BORIS reference | planned contract |
| Force modes | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-header-force-mode` | rozróżnienie polityk 0/1/2 | BORIS reference | planned contract |
| Explicit counts | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-set-n-common` | jawny common layout | BORIS reference | planned contract |
| Convolution rectangle | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-convolution-rect` | alignment scratch | BORIS reference | planned contract |
| Initialization | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-mconv-init` | moduły per layer | BORIS reference | planned contract |
| Update | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-mconv-update` | forward/pair/inverse | BORIS reference | planned contract |
| 2-D mode | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-2d-mode` | polityka Z | BORIS reference | planned contract |
| Multilayer toggle | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-multilayer-toggle` | multilayer kontra supermesh | BORIS reference | planned contract |
| Kernel catalog | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-kernel-catalog` | rodziny self/shifted/full | BORIS reference | planned contract |
| Kernel reuse | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-kernel-reuse` | pełna tożsamość reuse | BORIS reference | planned contract |
| Kernel storage | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-kernel-storage` | representation and shape | BORIS reference | planned contract |
| 2-D multiply | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-kernel-multiply` | ordered pair accumulation | BORIS reference | planned contract |
| 3-D multiply | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-kernel-multiply-3d` | full tensor set | BORIS reference | planned contract |
| Irregular thickness | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-irregular-thickness` | unequal Z | BORIS reference | planned contract |
| Weighted transfer | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-weighted-transfer` | transfer weights | BORIS reference | planned contract |
| CUDA update | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-cuda-update` | device update phases | BORIS CUDA reference | planned contract |
| CUDA init | `docs/physics/multilayer_convolution/boris-behavioral-spec.v1.md` | `DOC-ANCHOR:boris-cuda-init` | device scratch state | BORIS CUDA reference | planned contract |
