# Obrócone interfejsowe DMI stabilizujące bimerony

- Status: zaakceptowany kontrakt fizyczny; realizacje zaimplementowane, bieżąca kwalifikacja bimeronu `NOT VERIFIED`
- Owners: Fullmag physics and backend teams
- Last updated: 2026-09-12
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
\right]\,\mathrm dV.
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
- Dla niezerowego $D$ naturalny warunek brzegowy wymaga dodatniej stałej wymiany $A$ na otwartej
  granicy, również na granicy maski. Samo włączenie `Exchange` nie wystarcza:
  planner FDM sprawdza lokalną, rozwiązaną wartość $A$, także z pola materiałowego.
  FDM i FEM traktują $D=0$ jako no-op bez tego wymagania, zachowując
  jawnie zadany term w provenance. Niekompletna mapa PBC lub
  niespełnione wymaganie exchange kończy planowanie błędem.
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
study.stages.add_run(stage_id="hold", until=100e-12)
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
`eden_rotated_dmi` w $\mathrm{J\,m^{-3}}$ i `E_rotated_dmi` w $\mathrm{J}$.
`H_eff` oraz `E_total` zawierają składnik dokładnie raz. Żądanie ilości bez
aktywnej interakcji jest odrzucane przez planner. Bieżący FEM nie materializuje
jeszcze osobnych pól `H_rotated_dmi` ani `eden_rotated_dmi`, dlatego takie
żądania również odrzuca; energia globalna pozostaje rozdzielona jako
`E_rotated_dmi`.

`E_dmi` i `eden_dmi` są agregatami DMI; osobny składnik rDMI nie jest ponownie
dodawany do `E_total` ani `eden_total`. Manifest zakończonego przebiegu zapisuje
zarówno agregat `final_e_dmi`, jak i rozdzielony składnik `final_e_rotated_dmi`.
API preferuje składnik rozdzielony; dla starych manifestów może użyć
`final_e_dmi` jako `E_rotated_dmi` tylko przy jednoznacznym planie zawierającym
wyłącznie rDMI. W FDM `eden_rotated_dmi` jest
dostępne przez materializację on-demand, lecz nie przez harmonogram snapshotów
ani field autosave; takie żądanie jest odrzucane. FEM eigenmodes i frequency
response nie obsługują rDMI i nie ogłaszają jego wielkości w capabilities.

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

Natywna ścieżka CUDA nadal odrzuca pola materiałowe per-cell. Walidacja lokalnego
$A$ w plannerze nie oznacza dodania obsługi przestrzennie zmiennego współczynnika
wymiany do tej ścieżki.

### FEM CPU/MFEM

Właścicielem jest osobny moduł interakcji w `backends/fem/cpu/mfem`, a nie
`Context` ani `mfem_bridge.cpp`. MFEM składa równanie
{eq}`rdmi-first-variation` w P1 dla `tet4`, `prism6` i `pyramid5`, wykorzystując
tę samą kwadraturę do residualu i energii. Airbox jest pomijany. Niezerowe rDMI z PBC
jest obecnie odrzucane przez planner i natywne ABI: redukcja residualu oraz
projekcji masy do periodycznych true DOF nie jest jeszcze zaimplementowana.

Jeśli $g_a=\partial E/\partial\mathbf m_a$ jest residualem węzłowym, pole jest
projekcją z lumped mass:

```{math}
:label: rdmi-fem-projection
\mathbf H_{\mathrm{rDMI},a}=-\frac{\mathbf g_a}
{\mu_0M_{s,a}M_a^{\mathrm{lump}}}.
```

### FEM GPU/CUDA

FEM GPU używa tego samego residualu elementowego, ale osobnego operatora CUDA
lub libCEED. Bieżący wykonywalny zakres rDMI na GPU jest ograniczony do P1
`tet4`. `prism6`, `pyramid5` i topologie mieszane są odrzucane przed startem,
dopóki osobne kernele i testy pochodnej energii nie zostaną zakwalifikowane.
Brak kernela lub bufora kończy krok błędem bez delegacji elementów na CPU.
FEM z periodycznymi klasami węzłów odrzuca rDMI, dopóki residual i projekcja
masy nie zostaną zredukowane po tych klasach; periodyczna kwalifikacja Göbela
pozostaje dlatego wyłącznie ścieżką FDM.

### Macierz wsparcia i kwalifikacji

| Solver | Device | Stan kontraktu | Stan runtime | Wymagany dowód przed promocją |
|---|---|---|---|---|
| FDM | CPU | zatwierdzony | operator i pochodna energii zweryfikowane; bimeron runtime `NOT VERIFIED` | pełna reprodukcja bimeronu CPU |
| FDM | GPU | zatwierdzony | historyczny FP64 CUDA bimeron 15/15; bieżący raport 19-check `NOT VERIFIED` | powtórzony raport 19-check, FP32 parity i sanitizer |
| FEM | CPU | zatwierdzony | operator MFEM, weak derivative i build zweryfikowane; bimeron runtime `NOT VERIFIED` | reprodukcja bimeronu FEM CPU |
| FEM | GPU | zatwierdzony | historyczne testy residualu CUDA; bieżąca regresja skali błędu przy kasowaniu składników i bimeron runtime `NOT VERIFIED` | managed test pochodnej energii oraz reprodukcja bimeronu FEM GPU |

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

#### Okresowy benchmark FDM

Referencyjny benchmark FDM używa toru
$500\times40\times0.5\,\mathrm{nm^3}$ z PBC w osi $x$ i demagnetyzacją
`truncated_images`. Parametry materiału i dynamiki to
$M_s=0.58\,\mathrm{MA\,m^{-1}}$, $A=15\,\mathrm{pJ\,m^{-1}}$,
$D=3\,\mathrm{mJ\,m^{-2}}$, $K_x=0.8\,\mathrm{MJ\,m^{-3}}$,
$\alpha=0.3$ i $T=0\,\mathrm K$. FDM używa komórek
$0.5\times0.5\times0.5\,\mathrm{nm^3}$; siatka 1 nm nie zachowuje bariery
topologicznej dla relaksującego rdzenia o średnicy kilku nanometrów i nie jest
dopuszczona do tego benchmarku. Zgodna z obróconym Néelowskim skyrmionem
chiralność presetu ma `vorticity=-1` dla $D>0$.

#### Otwarty wariant FEM

Wariant FEM ma te same wymiary toru, parametry materiału, teksturę początkową
i etapy LLG, ale jest osobnym wariantem **open-boundary**: nie deklaruje
`study.pbc`, używa otwartej demagnetyzacji `poisson_robin` i ma dokładnie jedną
magnetyczną warstwę `prism6` przez grubość. Nie jest to okresowa reprodukcja
benchmarku FDM ani dowód równoważności PBC. Wspólne parametry pozwalają na
porównanie jakościowe tekstury, natomiast warunki brzegowe, operator
demagnetyzacji i siatka pozostają lane-specific.

Akceptacja wymaga co najmniej 20 ps relaksacji i 100 ps bezprądowego hold,
liczonych z czasów stanów w artefaktach, oraz spadku energii, skończonych pól, zachowania normy, dwóch
rozdzielonych rdzeni o przeciwnych znakach $m_z$, $|Q|\ge0.8$, tła wzdłuż
$+x$ oraz braku anihilacji podczas bezprądowego etapu LLG. Parity FDM CPU/GPU
i FEM CPU/GPU jest sprawdzane wewnątrz tej samej dyskretyzacji; FDM/FEM mają
zgadzać się jakościowo, nie punktowo.

Native FEM/MFEM/CUDA/hypre/libCEED jest budowany i uruchamiany wyłącznie przez
repozytoryjne receptury kontenerowe `just`. Receipt z rzeczywistym urządzeniem
jest wymagany dla każdego twierdzenia o GPU.

### Historyczny wynik FDM GPU FP64 — `NOT VERIFIED`

Zapisany przebieg na NVIDIA GeForce RTX 4080 SUPER, strict FP64 CUDA, bez
fallbacku, historycznie przeszedł 15/15 bramek po 20 ps relaksacji i 100 ps
bezprądowego hold. Otrzymano
$Q=-0.9999894870$, $m_z^{\max}=0.9932343$,
$m_z^{\min}=-0.9935072$, separację rdzeni $5.50\,\mathrm{nm}$ oraz
$\langle m_x\rangle=0.9858318$. Energia spadła z
$-7.7736\times10^{-18}\,\mathrm J$ do
$-8.1467871427\times10^{-18}\,\mathrm J$. Receipt wykazał maskę operatorów
CUDA $159/159$, zero operatorów host/unknown i `fallback_count=0`.
Raport powstał przed rozszerzeniem weryfikatora do 19 bramek i dlatego pozostaje
`NOT VERIFIED` dla bieżącego kontraktu; przed promocją wymagane jest powtórzenie
tego okresowego benchmarku z aktualnym weryfikatorem. Wynik nie kwalifikuje
opisanego wyżej open-boundary wariantu FEM.

(audit-corrections-2026-09-12)=
## Audyt korekcyjny — 2026-09-12

Po przeglądzie PR #86 sprawdzono wszystkie dwanaście zgłoszonych ścieżek
regresji. Korekty są fail-closed i nie zmieniają zakresu fizycznego Göbela:

| ID | Zakres | Korekta i regresja |
|---|---|---|
| P1 | FEM reference/live | `StepStats` rozdziela agregat `E_dmi` i `E_rotated_dmi`. |
| P2 | CLI transport | scalar-row zachowuje `e_rotated_dmi`. |
| P3 | FEM equilibrium identity | źródło z dowolnym DMI jest odrzucane, zamiast pomijać fizykę. |
| P4 | CUDA workspace | częściowe alokacje rDMI są zwalniane transakcyjnie, a retry ma nową bazę księgowania. |
| P5 | FEM material A | nodal/element `A` zasila estymatę bez fałszywego wymogu dodatniego skalaru. |
| P6 | capability/API | status lane'u wyprowadza rDMI z rozwiązanego planu, nie z deklaracji stałej. |
| P7 | mixed-P1 | CPU z rDMI jest akceptowany, GPU bez kwalifikowanego kernela jest odrzucane. |
| P8 | Python rewrite | `BulkDMI` + rDMI oraz materiałowe DMI nie są gubione; pola przestrzenne kończą się błędem. |
| P9 | quantities | alias `e_rotated_dmi` zapisuje kanoniczne `E_rotated_dmi`. |
| P10 | Göbel source physics | verifier odrzuca dodatkowe kanały `Ku2` i cubic anisotropy. |
| P11 | multilayer telemetry | licznik snapshotów wynosi 6 bazowo i 7 z polem rDMI. |
| P12 | Control Room | obecny, także zerowy, study-level rDMI blokuje konflikt z object-scoped DMI. |

Dowody korekty obejmują punktowe testy Rust (`fullmag-plan`, `fullmag-runner`,
`fullmag-api`, `fullmag-cli`), testy Python API/mixed-P1/verifier, 17 testów
Vitest dla katalogu interakcji oraz walidację JSON/source-map. Nie uruchamiano
`manage-fem-qualification` zgodnie z zakresem zadania. Nie ma nowego managed
19-check receiptu ani świeżej reprodukcji 20 ps + 100 ps; kwalifikacja runtime
Göbela pozostaje `NOT VERIFIED`.

(limitations)=
## Ograniczenia i prace odroczone

- ogólna macierz DMI $3\times3$ i przestrzennie zmienne $D$;
- wyższe rzędy FEM niż P1;
- atomistyczne Monte Carlo i sfrustrowana wymiana dalszych sąsiadów;
- reprodukcja ruchu SOT i prędkości z Fig. 3 pracy Göbela;
- eksperymentalna identyfikacja materiału na podstawie samej symulacji.

Historyczny przebieg FP64 nie promuje bieżącej implementacji bez aktualnego
raportu 19-check. Pozostałe lane'y i ruch SOT zachowują status wskazany
w macierzy wsparcia.

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
| walidacja DMI | `crates/fullmag-ir/src/validation.rs` | `validate_dmi_energy_terms` | konflikt rDMI z konwencjonalnym i materiałowym DMI | wspólny | implemented, source test |
| Python canonical rewrite | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_validate_energy_terms`, `_magnet_bulk_dmi` | zachowanie materiałowego DMI i fail-closed dla pól przestrzennych/mieszania | wspólny | implemented, source test |
| energia i pole FDM | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `rotated_interfacial_dmi_field` | referencyjna algebra dyskretna | FDM CPU | implemented, source test |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `estimate_fem_exchange_stiffness` | lokalny exchange z nodal/element `A` dla warunku naturalnego | FEM CPU/GPU | implemented, source test |
| residual FEM | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_rotated_interfacial_residual` | wspólna pierwsza wariacja | FEM CPU/GPU | implemented, source test; runtime not verified |
| FEM reference telemetry | `crates/fullmag-runner/src/fem_reference.rs` | `rotated_dmi_energy_from_magnetization` | rozdzielenie energii rDMI w live/relaxation stats | FEM CPU | implemented, source test; runtime not verified |
| FEM equilibrium identity | `crates/fullmag-runner/src/fem/equilibrium_identity.rs` | `validate_supported_relax_source` | odrzucenie DMI poza zakresem tożsamości modalnej | FEM | implemented, source test |
| CUDA rDMI workspace | `backends/fdm/gpu/cuda/runtime/context.cu` | `context_ensure_rotated_dmi_workspace` | transakcyjne alokacje i retry accounting | FDM GPU | implemented, managed runtime not verified |
| multilayer snapshot telemetry | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs` | `observed_snapshot_vector_field_count` | licznik transferów D2H zgodny z obecnością pola rDMI | FDM GPU | implemented, source test |
| CLI live transport | `crates/fullmag-cli/src/live_workspace.rs` | `scalar_row_from_stats_with_active_runtime` | przeniesienie komponentu `e_rotated_dmi` | FDM/FEM | implemented, source test |
| Control Room authoring | `apps/control-room/src/shared/domain/physics/interactions.ts` | `function studyHasRotatedDmi` | konflikt obecnego, także zerowego, rDMI z object-scoped DMI | UI | implemented, Vitest |
| Göbel verifier | `tests/standard_problems/bimeron/goebel_2019/verify.py` | `_goebel_material_has_only_expected_physics` | ścisła lista fizyki źródłowej scenariusza | benchmark | implemented, source test; runtime not verified |

Publiczna source map wskazuje także rzeczywiste symbole CUDA, plannera,
quantities, runnera i walidatora scenariusza. Kwalifikacja naukowa bieżącego
bimeronu pozostaje `NOT VERIFIED`; historyczny przebieg FDM CUDA FP64 nie
promuje runtime FDM CPU ani FEM.
