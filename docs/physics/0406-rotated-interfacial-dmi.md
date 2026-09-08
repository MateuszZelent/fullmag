# Obrócone interfejsowe DMI stabilizujące bimerony

- Status: zaimplementowany kontrakt fizyczny; kwalifikacja zależna od lane'u
- Owners: Fullmag physics and backend teams
- Last updated: 2026-08-31
- Related design: `docs/superpowers/specs/2026-08-31-rotated-interfacial-dmi-bimeron-design.md`
- Primary reference: Göbel et al., *Phys. Rev. B* **99**, 060407(R) (2019), DOI `10.1103/PhysRevB.99.060407`

(problem-statement)=
## Problem fizyczny

Bimeron jest teksturą złożoną z dwóch meronów, topologicznie równoważną
skyrmionowi po globalnym obrocie przestrzeni spinowej, lecz osadzoną w
magnesie o magnetyzacji tła leżącej w płaszczyźnie. Zwykłe interfejsowe DMI
preferuje skyrmion Néela w układzie z łatwą osią prostopadłą do warstwy. Model
Göbela wymaga innego, obróconego operatora DMI, zgodnego z łatwą osią w
płaszczyźnie i stabilizującego bimeron.

Fullmag reprezentuje tę fizykę jako osobną interakcję
`RotatedInterfacialDMI`. Nie jest ona aliasem `InterfacialDMI`, `BulkDMI` ani
ogólnej macierzy DMI. Istniejący `fm.texture.bimeron` dostarcza wyłącznie stan
początkowy; o stabilizacji decydują energia, pole efektywne i dynamika.

(governing-equations)=
## Równania rządzące

Dla zredukowanej magnetyzacji
$\mathbf m=(m_x,m_y,m_z)^\mathsf T$, $|\mathbf m|=1$, stałego współczynnika
$D$ i domeny magnetycznej $\Omega_m$ energia wynosi

```{math}
:label: rdmi-energy
E_{\mathrm{rDMI}}=\int_{\Omega_m}D\left(
m_z\partial_xm_x-m_x\partial_xm_z+
m_x\partial_ym_y-m_y\partial_ym_x\right)\,\mathrm dV.
```

Jest to kombinacja niezmienników Lifshitza
$D(L_{zx}^{x}+L_{xy}^{y})$, odpowiadająca konwencji tensorowej
$D_{21}=D_{32}=D$. Znak $D$ wybiera preferowaną chiralność i nie jest
normalizowany ani zastępowany wartością bezwzględną.

Dla przestrzennie stałych $D$ i $M_s>0$, przy konwencji Fullmag
$\mathbf H_\mathrm{eff}=-(\mu_0M_s)^{-1}\delta E/\delta\mathbf m$, pole
efektywne ma postać

```{math}
:label: rdmi-field
\mathbf H_{\mathrm{rDMI}}=\frac{2D}{\mu_0M_s}
\left(\partial_xm_z-\partial_ym_y,\;\partial_ym_x,\;-\partial_xm_x\right)^\mathsf T.
```

Pierwsza wariacja używana przez FEM jest składana bez zastępowania jej
wyłącznie silną postacią pola:

```{math}
:label: rdmi-first-variation
\delta E_{\mathrm{rDMI}}[\mathbf m;\mathbf v]
=\int_{\Omega_m}D\left[
v_z\partial_xm_x+m_z\partial_xv_x-v_x\partial_xm_z-m_x\partial_xv_z
+v_x\partial_ym_y+m_x\partial_yv_y-v_y\partial_ym_x-m_y\partial_yv_x
\right],\mathrm dV.
```

Po połączeniu z energią wymiany swobodna powierzchnia magnetyka o normalnej
$\mathbf n=(n_x,n_y,n_z)^\mathsf T$ spełnia naturalny warunek

```{math}
:label: rdmi-natural-bc
2A\partial_n\mathbf m+D(n_xm_z-n_ym_y,\;n_ym_x,\;-n_xm_x)^\mathsf T=\mathbf0.
```

Wektor DMI w tym warunku jest prostopadły do $\mathbf m$. Na osi periodycznej
nie występuje korekta otwartej powierzchni. Granica maski materiałowej jest
swobodną powierzchnią magnetyka, natomiast Airbox nie wnosi pola ani energii
DMI.

(symbols-and-si-units)=
## Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $E_{\mathrm{rDMI}}$ | całkowita energia obróconego interfejsowego DMI | $\mathrm{J}$ |
| $D$ | współczynnik obróconego interfejsowego DMI; znak wybiera chiralność | $\mathrm{J\,m^{-2}}$ |
| $\Omega_m$ | domena magnetyczna | $\mathrm{m^3}$ |
| $\mathbf m$ | zredukowana magnetyzacja | $1$ |
| $m_x,m_y,m_z$ | kartezjańskie składowe $\mathbf m$ | $1$ |
| $\mathbf v$ | dopuszczalna wariacja lub funkcja testowa | $1$ |
| $\partial_i$ | pochodna względem współrzędnej $i$ | $\mathrm{m^{-1}}$ |
| $\mathbf H_{\mathrm{rDMI}}$ | pole efektywne interakcji | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | przenikalność magnetyczna próżni | $\mathrm{N\,A^{-2}}$ |
| $M_s$ | magnetyzacja nasycenia | $\mathrm{A\,m^{-1}}$ |
| $A$ | stała wymiany | $\mathrm{J\,m^{-1}}$ |
| $\mathbf n$ | zewnętrzna normalna do granicy magnetyka | $1$ |
| $\partial_n$ | pochodna w kierunku $\mathbf n$ | $\mathrm{m^{-1}}$ |
| $L_{ij}^{k}$ | niezmiennik Lifshitza $m_i\partial_km_j-m_j\partial_km_i$ | $\mathrm{m^{-1}}$ |
| $\mathbf g_a$ | złożona pochodna energii w węźle FEM a | $\mathrm{J}$ |
| $M_a^{\mathrm{lump}}$ | lumped mass węzła FEM a | $\mathrm{m^3}$ |

(assumptions-and-validity)=
## Założenia i zakres ważności

- Model jest kontinuum mikromagnetycznym z $|\mathbf m|=1$ i dodatnim $M_s$.
- Publiczna wersja v1 przyjmuje jeden przestrzennie stały skalar $D$ dla
  aktywnej domeny. Pola regionalne, skokowe i tensorowe pozostają poza zakresem.
- Operator zawiera pochodne po $x$ i $y$, ale nie po $z$; grubość warstwy nadal
  wchodzi do całki objętościowej.
- Naturalny warunek brzegowy wymaga dodatniej stałej wymiany $A$ na otwartej
  granicy. Niekompletna mapa PBC lub brak exchange kończy planowanie błędem.
- Model nie obejmuje atomistycznej sfrustrowanej wymiany, temperatury ani SOT.
  Te mechanizmy mogą być osobnymi interakcjami, lecz nie zmieniają definicji
  rDMI.
- Zerowe $D$ jest poprawną, jawnie zaautoryzowaną interakcją. Planner może
  wyłączyć jej koszt wykonawczy, zachowując requested intent w provenance.

(python-api)=
## Publiczne API Python

Jedynym parametrem publicznym jest wymagane `D`:

| Nazwa | Typ | Domyślna | Jednostka SI | Walidacja | Znaczenie | Lane’y | `ProblemIR` |
|---|---|---|---|---|---|---|---|
| `fm.RotatedInterfacialDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | wartość skończona; oba znaki i zero dozwolone | siła i chiralność rDMI | FDM/FEM CPU/GPU po przejściu capability i qualification | `energy_terms[].D` |

Wykonywalny, stage-first scenariusz publiczny ma następujący kształt:

```python
# %% import and study
import fullmag as fm

study = fm.study("goebel_2019_bimeron_fdm")
study.engine("fdm")
study.device("gpu", precision="double")
study.mode("strict")
study.cell(0.5e-9, 0.5e-9, 0.5e-9)
study.pbc(x=True, demag="truncated_images")

# %% geometry, material, and initial state
film = study.geometry(
    fm.Box(size=(500e-9, 40e-9, 0.5e-9), name="film"),
    name="film",
)
film.Ms = 0.58e6
film.Aex = 15e-12
film.alpha = 0.3
film.Ku1 = 0.8e6
film.anisU = (1.0, 0.0, 0.0)
film.m = fm.texture.bimeron(
    radius=10e-9,
    wall_width=3e-9,
    vorticity=-1,
    background_sign=1,
    plane="xy",
)

# %% interactions and stages
study.terms.add(fm.RotatedInterfacialDMI(D=3e-3))
study.demag(realization="auto")
study.solver(fix_dt=2.5e-15, integrator="rk45")
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt=2.5e-15,
    max_steps=8_000,
    max_physical_time_s=20e-12,
    tolT=1e-6,
)
study.stages.add_run(stage_id="hold", until=120e-12)
```

Konstruktor odrzuca `NaN`, `+inf` i `-inf` przez `ValueError`. Rust ponawia
walidację po deserializacji, aby ręcznie utworzony lub UI-authored `ProblemIR`
nie omijał kontraktu.

(problem-ir)=
## Kanoniczny `ProblemIR`

Docelowa serializacja obiektu `fm.RotatedInterfacialDMI(D=3e-3)` jest
następująca:

```json
{
  "kind": "rotated_interfacial_dmi",
  "D": 0.003
}
```

Rust otrzymuje osobny wariant
`EnergyTermIR::RotatedInterfacialDmi { d: f64 }`. Wartość nie jest
przekształcana do zwykłego iDMI ani bulk DMI. Drugi egzemplarz tej samej
interakcji jest błędem walidacji. Zmiana ma charakter addytywny: starsze
dokumenty bez wariantu zachowują dotychczasową semantykę i nie wymagają
migracji.

(round-trip-and-failure-semantics)=
## Round-trip, capability i semantyka błędów

Python, UI authoring, script export i ponowne wczytanie zachowują dokładnie
nazwę `RotatedInterfacialDMI` i bitową wartość `D`. Requested
discretization/device/precision/mode pozostają oddzielone od resolved oraz
executed runtime w planie, manifeście i receipt.

W słowniku kontraktu `requested intent` oznacza wybór użytkownika,
`resolved execution` oznacza decyzję plannera, `validation errors` są
typowanymi odrzuceniami danych, a `unsupported combinations` są odrzucane
przed uruchomieniem backendu.

Wariant jest legalny w `strict` dla lane’u dopiero po istnieniu właściwego
operatora. Wymuszony GPU bez kernela, nieobsługiwana topologia FEM, błędna mapa
PBC, brak dodatniego $M_s$ albo exchange na otwartej granicy kończą się
typowanym błędem przed wykonaniem. Nie istnieje zamiana na inny rodzaj DMI,
pominięcie operatora ani cichy fallback GPU do CPU.

Nowe ilości kanoniczne to `H_rotated_dmi` w $\mathrm{A\,m^{-1}}$,
`Eden_rotated_dmi` w $\mathrm{J\,m^{-3}}$ i `E_rotated_dmi` w $\mathrm{J}$.
`H_eff` oraz `E_total` zawierają składnik dokładnie raz. Żądanie ilości bez
aktywnej interakcji jest odrzucane przez planner.

(discrete-realization)=
## Realizacje dyskretne

### FDM CPU

Referencją jest Rust CPU `double`. Wnętrze jednorodnej siatki używa centralnych
różnic drugiego rzędu. Energia, pole allocating, pole in-place i wariant SoA
muszą korzystać z jednej orientacji ścian komórek. Ghost values na otwartej
granicy i granicy maski wynikają z połączonego warunku exchange+rDMI; na osi
periodycznej sąsiad jest zawijany i nie otrzymuje korekty powierzchniowej.

### FDM GPU

CUDA implementuje ten sam operator dla FP64 i FP32, single-grid i multilayer,
we wszystkich wspieranych integratorach i relaksacji. Magnetyzacja, maska,
PBC, coefficient i redukcje pozostają na urządzeniu w hot loop. Pełne
transfery pola, hostowe obliczenie operatora i CPU fallback są błędem.

### FEM CPU/MFEM

Właścicielem jest osobny moduł interakcji w `backends/fem/cpu/mfem`, a nie
`Context` ani `mfem_bridge.cpp`. MFEM składa równanie
{eq}`rdmi-first-variation` w P1 dla `tet4`, `prism6` i `pyramid5`, wykorzystując
tę samą kwadraturę do residualu i energii. Airbox jest pomijany. PBC są
redukowane w tej samej przestrzeni true DOF co exchange.

Jeśli $g_a=\partial E/\partial\mathbf m_a$ jest residualem węzłowym, pole jest
projekcją z lumped mass:

```{math}
:label: rdmi-fem-projection
\mathbf H_{\mathrm{rDMI},a}=-\frac{\mathbf g_a}
{\mu_0M_{s,a}M_a^{\mathrm{lump}}}.
```

### FEM GPU/CUDA

FEM GPU używa tego samego residualu elementowego, ale osobnego operatora CUDA
lub libCEED. Podczas setupu MFEM przygotowuje typowane tablice kwadratury,
wartości funkcji bazowych, gradienty fizyczne, jacobiany, membership i mapy
true DOF dla `tet4`, `prism6` oraz `pyramid5`. Hot loop jest device-resident;
nie spłaszcza pryzmatów ani piramid do niejawnych tetraedrów. Brak kernela lub
bufora dla aktywnej topologii kończy krok błędem bez delegacji elementów na CPU.

### Macierz wsparcia i kwalifikacji

| Solver | Device | Stan kontraktu | Stan runtime | Wymagany dowód przed promocją |
|---|---|---|---|---|
| FDM | CPU | zatwierdzony | operator i pochodna energii zweryfikowane; bimeron runtime `NOT VERIFIED` | pełna reprodukcja bimeronu CPU |
| FDM | GPU | zatwierdzony | focused boundary/operator runtime PASS; bieżący bimeron runtime `NOT VERIFIED` | świeży source-bound FP64 bimeron receipt, FP32 parity i sanitizer |
| FEM | CPU | zatwierdzony | operator MFEM, weak derivative, build i focused `H_rotated_dmi` runtime zweryfikowane; bimeron runtime `NOT VERIFIED` | reprodukcja bimeronu FEM CPU |
| FEM | GPU | zatwierdzony | operator CUDA, pochodna, managed build i focused `H_rotated_dmi` runtime zweryfikowane; bimeron runtime `NOT VERIFIED` | reprodukcja bimeronu FEM GPU |

(implementation-mapping)=
## Granice implementacji i provenance

Semantyka przepływa przez
`Python DSL -> ProblemIR -> validator -> planner -> runner/ABI -> backend -> quantities/resources`.
Wspólne są równania, znak, jednostki, identyfikatory ilości i kryteria
walidacji. FDM/FEM oraz CPU/GPU mają osobnych właścicieli realizacji.

Plan i receipt zachowują co najmniej: authored `D`, requested i resolved lane,
precision, runtime/device identity, realization ID operatora, aktywne topologie,
mesh digest, source revision, brak fallbacku i status każdego dowodu. Sama
obecność źródła lub udany build nie zmienia `NOT VERIFIED` na `validated`.

(validation)=
## Walidacja

### Walidacja operatora

1. Stała magnetyzacja z PBC daje zerowe pole i energię.
2. Liniowa manufactured solution sprawdza wszystkie trzy składowe
   {eq}`rdmi-field`, znak i skalę $2D/(\mu_0M_s)$.
3. Sinusoidalna tekstura sprawdza zbieżność siatkową.
4. Zmiana znaku $D$ odwraca pole i preferowaną chiralność.
5. Centralna różnica kierunkowa energii zgadza się z
   $-\mu_0M_s\langle\mathbf H,\mathbf v\rangle$.
6. Open boundary i maska sprawdzają {eq}`rdmi-natural-bc`; PBC nie może
   otrzymywać powierzchniowej korekty.
7. FEM sprawdza osobno `tet4`, `prism6`, `pyramid5`, mixed topology i true DOF.
8. GPU sprawdza FP64/FP32, aktualne integratory, energy reduction, sanitizer i
   brak pełnych transferów hot-loop.

### Reprodukcja Göbel 2019

Scenariusze FDM i FEM współdzielą: tor $500\times40\times0.5\,\mathrm{nm^3}$,
PBC $x$, $M_s=0.58\,\mathrm{MA\,m^{-1}}$,
$A=15\,\mathrm{pJ\,m^{-1}}$, $D=3\,\mathrm{mJ\,m^{-2}}$,
$K_x=0.8\,\mathrm{MJ\,m^{-3}}$, $\alpha=0.3$ i $T=0\,\mathrm K$.
FEM ma dokładnie jedną magnetyczną warstwę `prism6` przez grubość.
FDM używa komórek $0.5\times0.5\times0.5\,\mathrm{nm^3}$; siatka 1 nm
nie zachowuje bariery topologicznej dla relaksującego rdzenia o średnicy kilku
nanometrów i nie jest dopuszczona do tej reprodukcji. Zgodna z obróconym
Néelowskim skyrmionem chiralność presetu ma `vorticity=-1` dla $D>0$.

Akceptacja wymaga spadku energii, skończonych pól, zachowania normy, dwóch
rozdzielonych rdzeni o przeciwnych znakach $m_z$, $|Q|\ge0.8$, tła wzdłuż
$+x$ oraz braku anihilacji podczas bezprądowego etapu LLG. Parity FDM CPU/GPU
i FEM CPU/GPU jest sprawdzane wewnątrz tej samej dyskretyzacji; FDM/FEM mają
zgadzać się jakościowo, nie punktowo.

Native FEM/MFEM/CUDA/hypre/libCEED jest budowany i uruchamiany wyłącznie przez
repozytoryjne receptury kontenerowe `just`. Receipt z rzeczywistym urządzeniem
jest wymagany dla każdego twierdzenia o GPU.

### Historyczny wynik FDM GPU FP64

Wcześniej opublikowany przebieg na NVIDIA GeForce RTX 4080 SUPER, strict FP64
CUDA, bez fallbacku, przeszedł 15/15 bramek po 20 ps relaksacji i 100 ps
bezprądowego hold. Otrzymano
$Q=-0.9999894870$, $m_z^{\max}=0.9932343$,
$m_z^{\min}=-0.9935072$, separację rdzeni $5.50\,\mathrm{nm}$ oraz
$\langle m_x\rangle=0.9858318$. Energia spadła z
$-7.7736\times10^{-18}\,\mathrm J$ do
$-8.1467871427\times10^{-18}\,\mathrm J$. Receipt wykazał maskę operatorów
CUDA $159/159$, zero operatorów host/unknown i `fallback_count=0`.

Surowy receipt z tożsamością źródeł tego przebiegu nie znajduje się w bieżącym
working tree. Wynik pozostaje historycznym dowodem opublikowanego artefaktu,
ale nie kwalifikuje aktualnego źródła po integracji operatora; bieżący workload
bimeronu i parytet czterech lane'ów mają status `NOT VERIFIED`.

(limitations)=
## Ograniczenia i prace odroczone

- ogólna macierz DMI $3\times3$ i przestrzennie zmienne $D$;
- wyższe rzędy FEM niż P1;
- atomistyczne Monte Carlo i sfrustrowana wymiana dalszych sąsiadów;
- reprodukcja ruchu SOT i prędkości z Fig. 3 pracy Göbela;
- eksperymentalna identyfikacja materiału na podstawie samej symulacji.

Historyczna promocja FDM GPU dotyczyła wyłącznie powyższego przebiegu FP64 i
nie jest przenoszona na bieżący working tree. Pozostałe lane'y i ruch SOT
zachowują status wskazany w macierzy wsparcia.

(scientific-bibliography)=
## Bibliografia naukowa

1. B. Göbel, A. Mook, J. Henk, I. Mertig i O. A. Tretiakov,
   “Magnetic bimerons as skyrmion analogues in in-plane magnets,”
   *Physical Review B* **99**, 060407(R) (2019),
   [doi:10.1103/PhysRevB.99.060407](https://doi.org/10.1103/PhysRevB.99.060407).

(source-code-index)=
## Indeks kodu źródłowego

| Kontrakt | Ścieżka | Symbol | Odpowiedzialność | Lane | Stan dowodu |
|---|---|---|---|---|---|
| Python API | `packages/fullmag-py/src/fullmag/model/energy.py` | `class RotatedInterfacialDMI` | walidacja i lowering | wspólny | implemented, source test |
| `ProblemIR` | `crates/fullmag-ir/src/study.rs` | `EnergyTermIR` | wariant `RotatedInterfacialDmi` i kanoniczna serializacja | wspólny | implemented, source test |
| energia i pole FDM | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `rotated_interfacial_dmi_field` | referencyjna algebra dyskretna | FDM CPU | implemented, source test |
| pole i brzeg FDM CUDA | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | pole FP64 i korekta otwartej granicy | FDM GPU | focused boundary runtime PASS; bimeron not verified |
| residual FEM | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_rotated_interfacial_residual` | wspólna pierwsza wariacja | FEM CPU/GPU | implemented, source test |
| pole FEM CPU | `backends/fem/cpu/mfem/interactions/effective_field.cpp` | `compute_effective_fields_for_magnetization` | połączone i osobne pole rotowanego DMI | FEM CPU | focused runtime PASS; bimeron not verified |
| obserwowalne FEM | `crates/fullmag-runner/src/native_fem.rs` | `NativeFemPreviewObservable` | `H_rotated_dmi`, `eden_rotated_dmi` i brak podwójnego liczenia w `eden_total` | FEM CPU/GPU | focused runtime PASS; bimeron not verified |
| residual FEM CUDA | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `dmi_element_residual_kernel` | residual i energia na urządzeniu | FEM GPU | focused field runtime PASS; bimeron not verified |
| verifier | `tests/standard_problems/bimeron/goebel_2019/verify.py` | `verify_bundle` | bramki topologii, energii, urządzenia i braku fallbacku | FDM GPU | historical result only; current-source bimeron not verified |
