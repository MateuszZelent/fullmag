# 0952 — Three-dimensional microwave antenna conductor topologies (`MeanderAntennaLayout`, `InductiveLoopLayout`, `PiecewisePath3DLayout`)

- Status: accepted_contract_not_production_qualified
- Owners: Fullmag physics and meshing
- Last updated: 2026-11-22
- Related ADRs: docs/adr/0085-one-formula-engine-for-antennas-and-absorbing-boundary.md
- Related specs: docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md

(problem-statement)=
## 1. Dziedzina fizyczna

Selektywne wzbudzanie fal spinowych o zadanym wektorze falowym $k$, lokalne
wzbudzanie modów wirowych/skyrmionowych w nanodyskach oraz trójwymiarowe
mostki powietrzne (air-bridges) nad falowodami magnonicznymi wymagają
przewodników wykraczających poza prostoliniowy mikropasek i linię CPW.
Niniejsza nota definiuje geometrię linii centralnej, transport równoległy
przekroju prostokątnego, warunki braku samoprzecięcia bryły OCC oraz selekcję
ścian terminalowych `local_u_min` / `local_u_max` dla trzech topologii 3D:
`MeanderAntennaLayout`, `InductiveLoopLayout` oraz `PiecewisePath3DLayout`.

(governing-equations)=
## 2. Model fizyczny

### 2.1 Meander (`MeanderAntennaLayout`) i selektywność $k$

Meander o liczbie palców $N_f \in [2, 64]$, podziałce $p > w_s$, szerokości
paska $w_s > 0$, grubości $t_c > 0$ i długości palca $L_f > 0$ jest wycentrowany
w lokalnym układzie $(u,v,w)$ na przedziale $u\in[-L_f/2, +L_f/2]$, z $k$-tym
palcem na $v_k = k p - \tfrac{1}{2}(N_f - 1)p$. Przeciwbieżny kierunek prądu w
kolejnych palcach wybiera dominującą składową Fouriera pola Oersteda przy:

```{math}
:label: meander-dominant-wavenumber

k_0 = \frac{\pi}{p},\qquad
2 r_b + w_s \le p,
```

gdzie $r_b \ge 0$ jest promieniem zewnętrznego wygięcia łuku U-kształtnego.
Warunek $2 r_b + w_s \le p$ zapobiega samoprzecięciu sąsiednich łuków w CAD/OCC.

### 2.2 Pętla indukcyjna (`InductiveLoopLayout`)

Mikrocewka o promieniu wewnętrznym $R_{\mathrm{in}} > 0$, szerokości $w_s > 0$,
szczelinie zasilającej $g_f \in (0, 2 R_{\mathrm{in}})$, liczbie zwojów
$N_t \in [1, 16]$ i skoku zwojowym $p_{\mathrm{loop}}$ ma promień linii
środkowej pierwszego zwoju $R_0 = R_{\mathrm{in}} + \tfrac{1}{2}w_s$ oraz
nominalny obwód referencyjny:

```{math}
:label: inductive-loop-circumference

R_0 = R_{\mathrm{in}} + \frac{w_s}{2},\qquad
L_{\mathrm{loop}} = 2\pi R_0 N_t,\qquad
\theta_{\mathrm{gap}} = \arcsin\!\left(\min\!\left(0.45,\;\frac{g_f + w_s}{2 R_0}\right)\right).
```

W wariancie `circular` i `omega` kąt przebiega od $\pi - \theta_{\mathrm{gap}}$
przez pełny kąt $2\pi N_t - 2\theta_{\mathrm{gap}}$ (z promieniem
$R(s) = R_0 + (N_t - 1) p_{\mathrm{loop}} s$ dla $s\in[0,1]$), a w wariancie
`rectangular` tworzy zaokrąglony kwadrat otwarty po stronie $-u$.

### 2.3 Ścieżka 3D (`PiecewisePath3DLayout`), ramka Bishopa i terminale OCC

Dla ciągu węzłów 3D $\{\mathbf P_m\}_{m=0}^{M-1}$ ($M\ge 2$, $\|\mathbf P_m - \mathbf P_{m-1}\| > 10^{-12}\,\mathrm{m}$)
wewnętrzny narożnik o promieniu $r_{b,m} > 0$ jest wygładzany kwadratową krzywą
Béziera przyciętą o $\ell_m = \min(r_{b,m}, 0.4\|\mathbf P_m - \mathbf P_{m-1}\|, 0.4\|\mathbf P_{m+1} - \mathbf P_m\|)$:

```{math}
:label: path3d-bezier-fillet

\mathbf B_m(\tau)
= (1-\tau)^2\mathbf P_m^{-}
+ 2(1-\tau)\tau\,\mathbf P_m
+ \tau^2\mathbf P_m^{+},\qquad
\tau \in [0, 1].
```

Wzdłuż zdyskretyzowanej linii centralnej $\{\mathbf c_i\}$ ortonormalna ramka
przekroju $(\hat{\mathbf t}_i, \hat{\mathbf n}_i, \hat{\mathbf b}_i)$ jest
transportowana równolegle bez skręcenia Freneta:

```{math}
:label: bishop-parallel-transport

\mathbf n_i^{\perp} = \hat{\mathbf n}_{i-1} - (\hat{\mathbf n}_{i-1}\cdot\hat{\mathbf t}_i)\hat{\mathbf t}_i,\qquad
\hat{\mathbf n}_i = \frac{\mathbf n_i^{\perp}}{\|\mathbf n_i^{\perp}\|},\qquad
\hat{\mathbf b}_i = \hat{\mathbf t}_i \times \hat{\mathbf n}_i.
```

Ponieważ dla parzystego $N_f$ w meandrze oba końce leżą na $u = -L_f/2$, a w
pętli i ścieżce 3D ściany czołowe mają dowolną orientację 3D, selekcja grup
fizycznych OCC (`local_u_min`, `local_u_max`) dopasowuje powierzchnię brzegową
$S$ bezpośrednio do czworokąta przekroju początkowego $Q_0$ i końcowego $Q_{\mathrm{end}}$
w bazie $(\hat{\mathbf u}_Q, \hat{\mathbf v}_Q, \hat{\mathbf n}_Q)$ ze środkiem $\mathbf c_Q$:

```{math}
:label: occ-terminal-cap-predicate

|\hat{\mathbf n}_Q\cdot(\mathbf x - \mathbf c_Q)| \le \tau_Q
\;\land\;
|\hat{\mathbf u}_Q\cdot(\mathbf x - \mathbf c_Q)| \le u_{\max} + \tau_Q
\;\land\;
|\hat{\mathbf v}_Q\cdot(\mathbf x - \mathbf c_Q)| \le v_{\max} + \tau_Q.
```

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $L_f$ | długość pojedynczego palca meandra | $\mathrm{m}$ |
| $w_s$ | szerokość paska sygnałowego przewodnika | $\mathrm{m}$ |
| $t_c$ | grubość warstwy metalizacji przewodnika | $\mathrm{m}$ |
| $N_f$ | liczba palców grzebienia meandra | $1$ |
| $p$ | podziałka (pitch) między środkami sąsiednich palców | $\mathrm{m}$ |
| $r_b$ | promień gięcia łuku meandra | $\mathrm{m}$ |
| $k_0$ | dominująca liczba falowa wzbudzenia meandra | $\mathrm{rad\,m^{-1}}$ |
| $R_{\mathrm{in}}$ | promień wewnętrzny pętli indukcyjnej | $\mathrm{m}$ |
| $R_0$ | promień linii centralnej pierwszego zwoju pętli | $\mathrm{m}$ |
| $N_t$ | liczba zwojów pętli indukcyjnej | $1$ |
| $g_f$ | szerokość szczeliny zasilającej pętli | $\mathrm{m}$ |
| $L_{\mathrm{loop}}$ | obwód referencyjny pętli indukcyjnej | $\mathrm{m}$ |
| $\theta_{\mathrm{gap}}$ | kąt połówkowy rozwarcia szczeliny pętli | $\mathrm{rad}$ |
| $\mathbf P_m$ | $m$-ty węzeł kontrolny ścieżki 3D | $\mathrm{m}$ |
| $\mathbf P_m^{-}$ | punkt wejścia zaokrąglenia narożnika Béziera | $\mathrm{m}$ |
| $\mathbf P_m^{+}$ | punkt wyjścia zaokrąglenia narożnika Béziera | $\mathrm{m}$ |
| $\mathbf B_m$ | punkt na kwadratowym łuku narożnika Béziera | $\mathrm{m}$ |
| $\tau$ | bezwymiarowy parametr krzywej Béziera | $1$ |
| $\hat{\mathbf t}_i$ | jednostkowy wektor styczny linii centralnej | $1$ |
| $\hat{\mathbf n}_i$ | transportowany wektor szerokości przekroju | $1$ |
| $\mathbf n_i^{\perp}$ | rzut poprzedniej normalnej na płaszczyznę przekroju | $1$ |
| $\hat{\mathbf b}_i$ | binormalny wektor grubości przekroju | $1$ |
| $\mathbf c_Q$ | środek geometryczny czworokąta ściany terminalowej | $\mathrm{m}$ |
| $\hat{\mathbf u}_Q$ | pierwsza oś styczna czworokąta terminalu | $1$ |
| $\hat{\mathbf v}_Q$ | druga oś styczna czworokąta terminalu | $1$ |
| $\hat{\mathbf n}_Q$ | jednostkowa normalna płaszczyzny terminalu | $1$ |
| $u_{\max}$ | połówkowy wymiar terminalu wzdłuż $\hat{\mathbf u}_Q$ | $\mathrm{m}$ |
| $v_{\max}$ | połówkowy wymiar terminalu wzdłuż $\hat{\mathbf v}_Q$ | $\mathrm{m}$ |
| $\tau_Q$ | skalowalna tolerancja geometryczna dopasowania ściany OCC | $\mathrm{m}$ |
| $\mathbf x$ | punkt kontrolny / wierzchołek ściany OCC | $\mathrm{m}$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

Trzy nowe topologie są jednożyłowymi przewodnikami sygnałowymi (`conductors = [signal]`)
przeznaczonymi do quasistatycznego wyznaczania rozpływu prądu omowego ($\nabla\cdot(\sigma\nabla V)=0$)
oraz pola Biota–Savarta / Oersteda w potoku FEM/OCC. Promień gięcia w `PiecewisePath3DLayout`
powinien przekraczać połowę wymiaru przekroju leżącego w płaszczyźnie zgięcia,
aby uniknąć lokalnego samoprzecięcia sąsiednich ścian bocznych w siatkowaniu 3D Gmsh.

(python-api)=
## 5. Python API

Wszystkie trzy klasy geometrii są eksportowane na najwyższym poziomie `fullmag`
i współpracują z potokiem FEM `study.antenna_object(...)`:

```python
# %%
import fullmag as fm

study = fm.study("meander_spin_wave_antenna")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

film = study.geometry(fm.Box(size=(2.0e-6, 1.6e-6, 40e-9), name="yig"), name="yig")
film.Ms = 1.4e5
film.Aex = 3.5e-12
film.alpha = 2.0e-4
film.m = fm.texture.uniform(0.0, 1.0, 0.0)

meander = fm.MeanderAntennaLayout(
    name="grating",
    length_m=1.2e-6,
    signal_width_m=100e-9,
    thickness_m=50e-9,
    conductivity_s_per_m=5.96e7,
    finger_count=4,
    pitch_m=300e-9,
    bend_radius_m=60e-9,
    transform=fm.RigidTransform(translation=(0.0, 0.0, 80e-9)),
)
study.antenna_object(meander, name="grating", object_id="grating")
study.exchange()
study.demag()
study.stages.add_relax(stage_id="relax", dt=1e-13, max_steps=100)
```

### 5.1 Tabela parametrów publicznych

| Python | Typ | Domyślna | Jednostka SI | Walidacja | Znaczenie | Obsługa backendu | ProblemIR |
|---|---|---|---|---|---|---|---|
| MeanderAntennaLayout.length_m | float | required | $\mathrm{m}$ | finite and > 0 | długość pojedynczego palca meandra | FEM OCC geometry pipeline | geometry.entries[kind=meander].length_m |
| MeanderAntennaLayout.finger_count | int | 4 | $1$ | integer in [2, 64] | liczba palców meandra | FEM OCC geometry pipeline | geometry.entries[kind=meander].finger_count |
| MeanderAntennaLayout.pitch_m | float | required | $\mathrm{m}$ | finite and > signal_width_m | podziałka między palcami meandra | FEM OCC geometry pipeline | geometry.entries[kind=meander].pitch_m |
| MeanderAntennaLayout.bend_radius_m | float | 0.0 | $\mathrm{m}$ | >= 0 and 2*bend_radius_m + signal_width_m <= pitch_m | promień zewnętrzny łuku U-turn | FEM OCC geometry pipeline | geometry.entries[kind=meander].bend_radius_m |
| InductiveLoopLayout.loop_shape | str | circular | $1$ | circular, rectangular, or omega | kształt geometryczny pętli indukcyjnej | FEM OCC geometry pipeline | geometry.entries[kind=inductive_loop].loop_shape |
| InductiveLoopLayout.inner_radius_m | float | required | $\mathrm{m}$ | finite and > 0 | promień wewnętrzny cewki | FEM OCC geometry pipeline | geometry.entries[kind=inductive_loop].inner_radius_m |
| InductiveLoopLayout.turns | int | 1 | $1$ | integer in [1, 16] | liczba zwojów cewki | FEM OCC geometry pipeline | geometry.entries[kind=inductive_loop].turns |
| InductiveLoopLayout.feed_gap_m | float | min(0.5*R_in, width) | $\mathrm{m}$ | > 0 and < 2 * inner_radius_m | szerokość szczeliny zasilającej | FEM OCC geometry pipeline | geometry.entries[kind=inductive_loop].feed_gap_m |
| PiecewisePath3DLayout.waypoints | Sequence[Path3DWaypoint] | required | $\mathrm{m}$ | >= 2 consecutive distinct 3D points | węzły linii centralnej przewodnika 3D | FEM OCC geometry pipeline | geometry.entries[kind=piecewise_3d_path].waypoints |
| PiecewisePath3DLayout.signal_width_m | float | required | $\mathrm{m}$ | finite and > 0 | domyślna szerokość przekroju ścieżki | FEM OCC geometry pipeline | geometry.entries[kind=piecewise_3d_path].signal_width_m |

(problem-ir)=
## 6. ProblemIR i lowering

Każda z trzech topologii serializuje pojedynczą żyłę `signal` oraz kanoniczne
selektory ścian terminalowych `local_u_min` (wlot `sections[0]`) i `local_u_max`
(wylot `sections[-1]`):

```json
{
  "name": "grating",
  "kind": "meander",
  "length_m": 1.2e-6,
  "signal_width_m": 1e-7,
  "thickness_m": 5e-8,
  "conductivity_s_per_m": 59600000.0,
  "finger_count": 4,
  "pitch_m": 3e-7,
  "bend_radius_m": 6e-8,
  "conductors": [{"id": "signal", "kind": "signal"}],
  "terminal_faces": {
    "signal": {"inlet": "local_u_min", "outlet": "local_u_max"}
  }
}
```

(round-trip-and-failure-semantics)=
## 7. Round-trip, runtime i błędy

Requested intent (parametry geometryczne, `transform` oraz przypisania portów)
jest zachowywany bez strat w konwersji `SceneDocument` $\leftrightarrow$ skrypt
Python (`fm.MeanderAntennaLayout`, `fm.InductiveLoopLayout`, `fm.PiecewisePath3DLayout`).
Resolved execution rejestruje wygenerowane znaczniki powierzchni terminalowych
`antenna_terminal_marker(owner_id, part_id, selector)` i siatkę czworościenną.
Validation errors (samoprzecięcie łuku meandra $2 r_b + w_s > p$, zduplikowane
sąsiednie punkty 3D, `feed_gap_m >= 2 * inner_radius_m`, brak lub nałożenie ścian
terminalowych OCC) są odrzucane przed rozwiązaniem pola, a unsupported combinations
(próba użycia `MeanderAntennaLayout`, `InductiveLoopLayout` lub `PiecewisePath3DLayout`
w czystym potoku wokselowym bez siatki FEM) zwracają jawny błąd walidacji.

(discrete-realization)=
## 8. Realizacja dyskretna

### 8.1 FEM

Bryły przewodników budowane są w OpenCASCADE przez `gmsh.model.occ.addThruSections(..., makeSolid=True, makeRuled=True)`.
Ściany terminalowe `local_u_min` i `local_u_max` są identyfikowane z pełnej
geometrii czworokątów końcowych `sections[0]` i `sections[-1]` (środek oraz
wszystkie wierzchołki narożne 0D muszą leżeć w płaszczyźnie i obrysie czworokąta
czołowego), co działa poprawnie dla parzystego $N_f$ w meandrze, szczelin pętli
oraz pionowych odejść mostków 3D.

### 8.2 FDM

Bryły OCC anten służą do wyznaczenia przestrzennego profilu pola wzbudzającego,
które może zasilać siatkę FDM przez rzutowanie maski Zeemana, lecz samo
rozwiązanie geometrii przewodnika wymaga potoku FEM/OCC.

### 8.3 Support matrix

| Solver | Device | Semantyka | Status |
|---|---|---|---|
| FEM | CPU | OCC loft meshing, terminal markers, ohmic/Biot-Savart basis | source and Gmsh meshing test evidence |
| FEM | GPU | consumes solved spatial antenna field basis | runtime qualification separate |
| FDM | CPU | unsupported as native voxel conductor; requires FEM antenna solve / mask | unsupported (reason: curved 3D OCC antenna layouts require FEM geometry pipeline) |
| FDM | GPU | unsupported as native voxel conductor; requires FEM antenna solve / mask | unsupported (reason: curved 3D OCC antenna layouts require FEM geometry pipeline) |

(implementation-mapping)=
## 9. Mapa implementacji

- Python geometry classes: `packages/fullmag-py/src/fullmag/model/geometry.py` (`_path_strip_sections`, `class MeanderAntennaLayout`, `class InductiveLoopLayout`, `class PiecewisePath3DLayout`).
- OCC solid lofting & terminal face tagging: `packages/fullmag-py/src/fullmag/meshing/_gmsh_waveguides.py` (`add_antenna_layout_parts_to_occ`, `_cap_frame_from_quad`, `add_antenna_layout_terminal_physical_groups`).
- Rust authoring validation & bounds: `crates/fullmag-authoring/src/geometry.rs` (`parse_meander_layout`, `parse_inductive_loop_layout`, `parse_piecewise_path_3d_layout`).
- Canonical script builder: `packages/fullmag-py/src/fullmag/runtime/script_builder.py` (`_render_geometry_expr`).

(validation)=
## 10. Walidacja

Plik `test_antenna_layouts_occ.py` weryfikuje warunki walidacji, serializację
IR/Python oraz pełne siatkowanie 3D Gmsh (`generate_mesh`) dla parzystego i
nieparzystego meandra, trzech kształtów pętli (`circular`, `rectangular`, `omega`)
oraz pionowych i ukośnych mostków `PiecewisePath3DLayout` z obrotem `RigidTransform`,
potwierdzając zgodność środków ciężkości trójkątów terminalowych z analitycznymi
przekrojami końcowymi z dokładnością $< 10^{-12}\,\mathrm{m}$.

(limitations)=
## 11. Ograniczenia i odroczone prace

Łuk U-turn meandra parametryzowany jest półelipsą o półosiach $(r_b, p/2)$, a
w UI Control Room jednorodna zmiana `signal_width_m` nadpisuje indywidualne
szerokości węzłów `width_m` (tapering pozostaje w pełni obsługiwany w Python DSL).

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. V. Vlaminck, M. Bailleul, *Current-Induced Spin-Wave Doppler Shift*, Science 322, 410–413 (2008), DOI: 10.1126/science.1162843 (anteny meandrowe fal spinowych).
2. R. L. Bishop, *There is more than one way to frame a curve*, Amer. Math. Monthly 82, 246–251 (1975), DOI: 10.2307/2319846 (ramka transportu równoległego).
3. C. Geuzaine, J.-F. Remacle, *Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities*, Int. J. Numer. Meth. Engng 79, 1309–1331 (2009), DOI: 10.1002/nme.2579.

(source-code-index)=
## 13. Indeks źródeł i dowodów

| Claim/equation | Path | Symbol | Test/evidence | Lane |
|---|---|---|---|---|
| Parallel-transported strip sections | packages/fullmag-py/src/fullmag/model/geometry.py | _path_strip_sections | test_antenna_layouts_occ.py | FEM |
| Meander geometry and wavenumber | packages/fullmag-py/src/fullmag/model/geometry.py | class MeanderAntennaLayout | test_meander_inductive_loop_and_piecewise_path_layouts_validate_and_serialize | FEM |
| Inductive loop geometry | packages/fullmag-py/src/fullmag/model/geometry.py | class InductiveLoopLayout | test_meander_inductive_loop_and_piecewise_path_layouts_validate_and_serialize | FEM |
| Piecewise 3D path geometry | packages/fullmag-py/src/fullmag/model/geometry.py | class PiecewisePath3DLayout | test_meander_inductive_loop_and_piecewise_path_layouts_validate_and_serialize | FEM |
| OCC terminal cap quad frame | packages/fullmag-py/src/fullmag/meshing/_gmsh_waveguides.py | _cap_frame_from_quad | test_occ_meshing_publishes_accurate_terminals_for_meander_loop_and_path3d | FEM |
| OCC terminal physical group tagging | packages/fullmag-py/src/fullmag/meshing/_gmsh_waveguides.py | add_antenna_layout_terminal_physical_groups | test_occ_meshing_publishes_accurate_terminals_for_meander_loop_and_path3d | FEM |
| Rust meander validator | crates/fullmag-authoring/src/geometry.rs | parse_meander_layout | authoring geometry validation | authoring |
| Rust inductive loop validator | crates/fullmag-authoring/src/geometry.rs | parse_inductive_loop_layout | authoring geometry validation | authoring |
| Rust 3D path validator | crates/fullmag-authoring/src/geometry.rs | parse_piecewise_path_3d_layout | authoring geometry validation | authoring |
