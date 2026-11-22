# 0534 — Magnetic preset textures v2: spatial mapping, boundary clamp modes, slab confinement, and lattice/3D presets

- Status: accepted_contract_not_production_qualified
- Owners: Fullmag physics and runtime
- Last updated: 2026-11-22
- Related ADRs: docs/adr/0087-default-texture-clamp-mode-none.md
- Related specs: docs/physics/0531-versioned-magnetic-preset-textures.md

(problem-statement)=
## 1. Dziedzina fizyczna

Niniejsza nota rozszerza wersjonowany kontrakt tekstur `preset_version = 2`
(`0531-versioned-magnetic-preset-textures.md`) o:
1. rozdzielenie rotacji przestrzennej i spinowej (`rotate_vectors`),
2. przestrzeń odwzorowania `space = "region"` (lokalny układ regionu) obok `"object"` i `"world"`,
3. pięć trybów brzegowych `clamp_mode` (`"none"`, `"clamp"`, `"repeat"`, `"mirror"`, `"background"`) z ujednoliconą wartością domyślną `"none"` w Rust i Pythonie (ADR 0087),
4. ograniczenie grubości warstwy wzdłuż osi normalnej (`axis_extent_mode = "thickness"`, `axis_thickness_m`),
5. cztery presety v2 drugiej fali: `skyrmion_lattice`, `spiral`, `bloch_point` oraz `artificial_spin_ice`.

(governing-equations)=
## 2. Model fizyczny

### 2.1 Przestrzeń `region`, transformacja rigid i przełącznik `rotate_vectors`

Dla punktu próbkowania $\mathbf r$ wybierana jest współrzędna źródłowa $\mathbf r_s$
zgodnie z `mapping.space`: w układzie świata (`"world"`), względem środka obiektu
(`"object"`) lub względem środka docelowego podregionu (`"region"`). Dla obrotu
kwaternionowego $R(\mathbf q)$, skali $\mathbf s = (s_x, s_y, s_z)$, przesunięcia
$\mathbf t$ oraz punktu obrotu $\mathbf p$ współrzędna w układzie tekstury wynosi
$\mathbf r_{\mathrm{tex}} = \operatorname{diag}(\mathbf s)^{-1} R(\mathbf q)^{-1}(\mathbf r_s - \mathbf t - \mathbf p) + \mathbf p$.
Wektor wyjściowy zależy od flagi logicznej $\eta_{\mathrm{rot}} = \texttt{rotate\_vectors}$:

```{math}
:label: texture-rotate-vectors-v2

\mathbf m(\mathbf r) =
\begin{cases}
R(\mathbf q)\,\mathbf m_{\mathrm{frame}}(\mathbf r_{\mathrm{tex}}), & \eta_{\mathrm{rot}} = \mathrm{true},\\
\mathbf m_{\mathrm{frame}}(\mathbf r_{\mathrm{tex}}), & \eta_{\mathrm{rot}} = \mathrm{false}.
\end{cases}
```

Dla $\eta_{\mathrm{rot}} = \mathrm{false}$ płaszczyzna ściany domenowej lub sieć
skyrmionów obraca się w przestrzeni, lecz wektory magnetyzacji pozostają przypięte
do nieruchomych osi krystalograficznych.

### 2.2 Ograniczenie grubości (`axis_extent_mode`) i tryby `clamp_mode`

Gdy `axis_extent_mode == "thickness"` z $h_z = \texttt{axis\_thickness\_m} > 0$,
współrzędna normalna $z_n = (\mathbf r_{\mathrm{tex}} - \mathbf p)\cdot\mathbf e_n$
ogranicza nośnik tekstury do warstwy $|z_n| \le h_z/2$:

```{math}
:label: texture-axis-slab-v2

|z_n| > \frac{h_z}{2} \implies \mathbf m_{\mathrm{frame}}(\mathbf r_{\mathrm{tex}}) = \hat{\mathbf m}_{\mathrm{bg}}.
```

Dla trybów brzegowych `clamp_mode != "none"` względem okresu pudełka
$\mathbf P = (P_x, P_y, P_z)$ ($P_i > 0$) i współrzędnej względnej
$\boldsymbol\delta = \mathbf r_{\mathrm{tex}} - \mathbf p$ operator składania
$C_{\mathrm{mode}}(\delta_i, P_i)$ działa następująco:

```{math}
:label: texture-clamp-modes-v2

\begin{aligned}
\text{none}: &\quad \tilde\delta_i = \delta_i,\\
\text{clamp}: &\quad \tilde\delta_i = \min\!\left(\tfrac{P_i}{2},\,\max\!\left(-\tfrac{P_i}{2},\,\delta_i\right)\right),\\
\text{repeat}: &\quad \tilde\delta_i = \left((\delta_i + \tfrac{P_i}{2}) \bmod P_i\right) - \tfrac{P_i}{2},\\
\text{mirror}: &\quad u_i = (\delta_i + \tfrac{P_i}{2}) \bmod (2 P_i),\quad \tilde\delta_i = \min(u_i,\,2 P_i - u_i) - \tfrac{P_i}{2}.
\end{aligned}
```

W trybie `"background"` punkty spełniające $\max_i(|\delta_i| - P_i/2) > 0$
otrzymują znormalizowany wektor tła $\hat{\mathbf m}_{\mathrm{bg}} = \mathbf m_{\mathrm{bg}}/\|\mathbf m_{\mathrm{bg}}\|$.
Zgodnie z ADR 0087 domyślna wartość `clamp_mode` w Rust i Pythonie to `"none"`.

### 2.3 Cztery presety drugiej fali (`skyrmion_lattice`, `spiral`, `bloch_point`, `artificial_spin_ice`)

1. **Sieć skyrmionów (`skyrmion_lattice`):** dla stałej sieci $a_{\mathrm{lat}} > 2 R$
   punkt $(u, v)$ jest rzutowany do komórki Wignera–Seitza sieci kwadratowej
   ($\mathbf a_1 = (a_{\mathrm{lat}},0)$, $\mathbf a_2 = (0,a_{\mathrm{lat}})$)
   albo heksagonalnej ($\mathbf a_1 = (a_{\mathrm{lat}},0)$,
   $\mathbf a_2 = (\tfrac{1}{2}a_{\mathrm{lat}}, \tfrac{\sqrt{3}}{2}a_{\mathrm{lat}})$):

```{math}
:label: texture-skyrmion-lattice-v2

(u_{\mathrm{WS}}, v_{\mathrm{WS}})
= \arg\min_{(n_1,n_2)\in\mathbb Z^2}
\|(u, v) - n_1\mathbf a_1 - n_2\mathbf a_2\|,\qquad
\mathbf m(u,v) = \mathbf m_{\mathrm{skyrmion}}(u_{\mathrm{WS}}, v_{\mathrm{WS}}).
```

2. **Uogólniona spirala spinowa (`spiral`):** dla długości fali $\lambda_s > 0$,
   znormalizowanej osi propagacji $\hat{\mathbf q}$, chiralności $\chi\in\{-1,+1\}$,
   fazy $\varphi_0$ oraz ortonormalnej pary $(\mathbf e_1, \mathbf e_2)$ w płaszczyźnie
   obrotu spinów (prostopadłej do $\mathbf n_s = \hat{\mathbf q}$ dla `proper_screw`,
   zawierającej $\hat{\mathbf q}$ dla `cycloidal`, lub zadanej przez $\mathbf n_s$ dla `custom_plane`):

```{math}
:label: texture-spiral-v2

\Phi_s(\mathbf r) = \chi\,\frac{2\pi}{\lambda_s}\,(\hat{\mathbf q}\cdot\mathbf r) + \varphi_0,\qquad
\mathbf m(\mathbf r) = \mathbf e_1\cos\Phi_s(\mathbf r) + \mathbf e_2\sin\Phi_s(\mathbf r).
```

3. **Trójwymiarowy punkt Blocha (`bloch_point`):** osobliwość jeżowa 3D o polaryzacji
   $p_{\mathrm{bp}}\in\{-1,+1\}$, znaku osiowym $s_z = -1$ dla `hyperbolic`
   ($s_z = +1$ dla `radial` i `circulating`) oraz kącie skręcenia $\gamma_{\mathrm{tw}}$
   ($\gamma_{\mathrm{tw}}=\pi/2$ domyślnie dla `circulating`), z regularnym limitem
   $p_{\mathrm{bp}}\mathbf e_z$ w $r = \|\mathbf r\| \le 10^{-15}\,\mathrm{m}$:

```{math}
:label: texture-bloch-point-v2

\hat{\mathbf r} = \frac{(x, y, z)}{\|\mathbf r\|},\qquad
\mathbf m(\mathbf r) = p_{\mathrm{bp}}
\begin{pmatrix}
\hat r_x\cos\gamma_{\mathrm{tw}} - \hat r_y\sin\gamma_{\mathrm{tw}}\\
\hat r_x\sin\gamma_{\mathrm{tw}} + \hat r_y\cos\gamma_{\mathrm{tw}}\\
s_z\,\hat r_z
\end{pmatrix}.
```

4. **Sztuczny lód spinowy (`artificial_spin_ice`):** dla podziałki sieci $a_{\mathrm{asi}} > 0$
   każdy punkt przypisywany jest metodą najbliższego środka więzi $\mathbf b_{m}$
   w sieci kwadratowej lub kagome z regułą wierzchołkową `type_i_ground` (2-in/2-out
   lub 2-in/1-out), `type_ii_polarized` albo wzbudzeniem `monopole_pair`:

```{math}
:label: texture-asi-v2

m^\star(\mathbf r) = \arg\min_{m}\|(u,v) - \mathbf b_m\|,\qquad
\mathbf m(\mathbf r) = \sigma_{m^\star}\,\hat{\mathbf d}_{m^\star}.
```

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m$ | zredukowany wektor magnetyzacji | $1$ |
| $\mathbf r_{\mathrm{tex}}$ | współrzędna punktu w układzie tekstury | $\mathrm{m}$ |
| $\mathbf p$ | punkt obrotu i środek pudełka kafelkowania | $\mathrm{m}$ |
| $\eta_{\mathrm{rot}}$ | flaga obracania wektorów spinowych wraz z geometrią | $1$ |
| $h_z$ | grubość aktywnej warstwy tekstury wzdłuż normalnej | $\mathrm{m}$ |
| $z_n$ | składowa położenia wzdłuż osi normalnej płaszczyzny | $\mathrm{m}$ |
| $P_i$ | okres / rozmiar pudełka kafelkowania wzdłuż osi $i$ | $\mathrm{m}$ |
| $\delta_i$ | współrzędna względna przed złożeniem brzegowym | $\mathrm{m}$ |
| $\tilde\delta_i$ | współrzędna względna po złożeniu brzegowym | $\mathrm{m}$ |
| $\hat{\mathbf m}_{\mathrm{bg}}$ | jednostkowy wektor magnetyzacji tła | $1$ |
| $a_{\mathrm{lat}}$ | stała sieci skyrmionowej | $\mathrm{m}$ |
| $R$ | promień pojedynczego skyrmionu w komórce sieci | $\mathrm{m}$ |
| $\mathbf a_1$ | pierwszy wektor prymitywny sieci Bravais'go | $\mathrm{m}$ |
| $\mathbf a_2$ | drugi wektor prymitywny sieci Bravais'go | $\mathrm{m}$ |
| $u_{\mathrm{WS}}$ | pierwsza współrzędna w komórce Wignera–Seitza | $\mathrm{m}$ |
| $v_{\mathrm{WS}}$ | druga współrzędna w komórce Wignera–Seitza | $\mathrm{m}$ |
| $\lambda_s$ | długość fali spirali spinowej | $\mathrm{m}$ |
| $\hat{\mathbf q}$ | znormalizowana oś propagacji spirali | $1$ |
| $\chi$ | chiralność skrętu spirali ($\pm 1$) | $1$ |
| $\varphi_0$ | faza początkowa spirali | $\mathrm{rad}$ |
| $\Phi_s$ | lokalny kąt fazy spirali | $\mathrm{rad}$ |
| $\mathbf e_1$ | pierwsza oś płaszczyzny obrotu spinów | $1$ |
| $\mathbf e_2$ | druga oś płaszczyzny obrotu spinów | $1$ |
| $p_{\mathrm{bp}}$ | polaryzacja rdzenia punktu Blocha ($\pm 1$) | $1$ |
| $s_z$ | znak osiowy punktu Blocha ($+1$ lub $-1$) | $1$ |
| $\gamma_{\mathrm{tw}}$ | kąt skręcenia azymutalnego punktu Blocha | $\mathrm{rad}$ |
| $a_{\mathrm{asi}}$ | podziałka sieci sztucznego lodu spinowego | $\mathrm{m}$ |
| $\mathbf b_m$ | środek $m$-tej wyspy/więzi dipolowej | $\mathrm{m}$ |
| $\hat{\mathbf d}_{m^\star}$ | jednostkowy kierunek osi łatwej najbliższej wyspy | $1$ |
| $\sigma_{m^\star}$ | znak stanu Isingowskiego wyspy ($\pm 1$) | $1$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

Presety v2 definiują znormalizowany analityczny warunek początkowy ($|\mathbf m|=1$)
i nie stanowią same w sobie rozwiązania równowagowego LLG. `skyrmion_lattice`
wymaga $a_{\mathrm{lat}} > 2 R$, aby rdzenie sąsiednich komórek nie przekrywały się.
`bloch_point` jest pełnym polem 3D i odrzuca rzutowania płaskie (`planar_xy/xz/yz`),
wymagając `projection = "object_local"`. Dla `spiral` w trybie `cycloidal` wektor
`spin_plane_normal` nie może być równoległy do `propagation_axis`.

(python-api)=
## 5. Python API

Konstruktory fabryczne dostępne są w `fm.texture.*` wraz z metodami fluent
`.with_mapping(...)`, `.with_axis_thickness(...)` oraz `.with_rotate_vectors(...)`:

```python
# %%
import fullmag as fm

study = fm.study("skyrmion_lattice_slab_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(180e-9, 180e-9, 20e-9))
study.cell(3e-9, 3e-9, 5e-9)

film = study.geometry(fm.Box(size=(180e-9, 180e-9, 20e-9), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = (
    fm.texture.skyrmion_lattice(
        lattice_constant=60e-9,
        radius=15e-9,
        wall_width=4e-9,
        lattice="hexagonal",
        kind="bloch",
    )
    .rotate_z_deg(15.0)
    .with_rotate_vectors(True)
    .with_mapping(
        space="object",
        clamp_mode="repeat",
        tile_period=(60e-9, 60e-9, 20e-9),
        axis_extent_mode="thickness",
        axis_thickness_m=10e-9,
    )
)

study.exchange()
study.demag()
study.stages.add_save_state(artifact_name="skx-init.zarr", format="zarr", dataset="m")
```

### 5.1 Tabela parametrów publicznych

| Python | Typ | Domyślna | Jednostka SI | Walidacja | Znaczenie | Obsługa backendu | ProblemIR |
|---|---|---|---|---|---|---|---|
| TextureTransform3D.rotate_vectors | bool | True | $1$ | bool | obrót wektorów spinowych wraz z ramką przestrzenną | FDM/FEM CPU/GPU | texture_transform.rotate_vectors |
| TextureMapping.space | str | object | $1$ | object, world, or region | układ odniesienia współrzędnych próbkowania | FDM/FEM CPU/GPU | mapping.space |
| TextureMapping.clamp_mode | str | none | $1$ | none, clamp, repeat, mirror, or background | zachowanie poza pudełkiem kafelkowania | FDM/FEM CPU/GPU | mapping.clamp_mode |
| TextureMapping.tile_period | tuple[float, float, float] | None | $\mathrm{m}$ | 3 finite values > 0 | rozmiary pudełka kafelkowania $[P_x,P_y,P_z]$ | FDM/FEM CPU/GPU | mapping.tile_period |
| TextureMapping.background_vector | tuple[float, float, float] | None | $1$ | finite, nonzero 3-vector | kierunek magnetyzacji poza nośnikiem | FDM/FEM CPU/GPU | mapping.background_vector |
| TextureMapping.axis_extent_mode | str | uniform | $1$ | uniform or thickness | tryb rozciągłości wzdłuż osi normalnej | FDM/FEM CPU/GPU | mapping.axis_extent_mode |
| TextureMapping.axis_thickness_m | float | None | $\mathrm{m}$ | finite > 0 when axis_extent_mode == thickness | grubość warstwy aktywnej tekstury | FDM/FEM CPU/GPU | mapping.axis_thickness_m |
| texture.skyrmion_lattice.lattice_constant | float | required | $\mathrm{m}$ | finite and > 2 * radius | stała sieci Bravais'go skyrmionów | FDM/FEM CPU/GPU | preset_params.lattice_constant |
| texture.spiral.wavelength | float | required | $\mathrm{m}$ | finite and > 0 | długość fali spirali spinowej | FDM/FEM CPU/GPU | preset_params.wavelength |
| texture.bloch_point.bp_kind | str | circulating | $1$ | radial, circulating, or hyperbolic | typ topologiczny punktu Blocha 3D | FDM/FEM CPU/GPU | preset_params.bp_kind |
| texture.artificial_spin_ice.pitch | float | required | $\mathrm{m}$ | finite and > 0 | podziałka sieci sztucznego lodu spinowego | FDM/FEM CPU/GPU | preset_params.pitch |

(problem-ir)=
## 6. ProblemIR i lowering

Kanoniczna postać `InitialMagnetizationIR::PresetTexture` zawiera jawne pola
`mapping` i `texture_transform`:

```json
{
  "kind": "preset_texture",
  "preset_kind": "skyrmion_lattice",
  "preset_version": 2,
  "preset_params": {
    "lattice": "hexagonal",
    "lattice_constant": 6e-8,
    "radius": 1.5e-8,
    "wall_width": 4e-9,
    "kind": "bloch",
    "chirality": 1,
    "core_polarity": -1,
    "plane": "xy"
  },
  "mapping": {
    "space": "object",
    "projection": "object_local",
    "clamp_mode": "repeat",
    "tile_period": [6e-8, 6e-8, 2e-8],
    "axis_extent_mode": "thickness",
    "axis_thickness_m": 1e-8
  },
  "texture_transform": {
    "translation": [0.0, 0.0, 0.0],
    "rotation_quat": [0.0, 0.0, 0.13052619222005157, 0.9914448613738104],
    "scale": [1.0, 1.0, 1.0],
    "pivot": [0.0, 0.0, 0.0],
    "rotate_vectors": true
  }
}
```

(round-trip-and-failure-semantics)=
## 7. Round-trip, runtime i błędy

Requested intent (rodzaj presetu, wersja `2`, `clamp_mode`, `tile_period`,
`axis_extent_mode`, `axis_thickness_m`, `space` oraz `rotate_vectors`) jest
zachowywany podczas eksportu `SceneDocument` do kanonicznego skryptu Python
(`fm.texture.*` lub bezstratnego `fm.PresetTexture(...)` dla `rotate_vectors=False`).
Resolved execution rejestruje docelową dyskretyzację, urządzenie i precyzję.
Validation errors (np. $a_{\mathrm{lat}} \le 2 R$, nieznany `clamp_mode`,
brak dodatniego `axis_thickness_m` w trybie `"thickness"`) są odrzucane przed
materializacją, a unsupported combinations (np. `bloch_point` z rzutowaniem
płaskim `planar_xy`) zgłaszają jawny błąd bez cichego fallbacku.

(discrete-realization)=
## 8. Realizacja dyskretna

### 8.1 FDM

Planner FDM oblicza wartości w środkach aktywnych komórek siatki; dla
`space = "region"` współrzędne liczone są względem środka geometrycznego maski
regionu.

### 8.2 FEM

Planner FEM oblicza wartości w węzłach P1 obiektu lub regionu magnetycznego w
domenie współdzielonej.

### 8.3 Support matrix

| Solver | Device | Semantyka | Status |
|---|---|---|---|
| FDM | CPU | cell-center v2 preset and mapping evaluation | source and pytest evidence |
| FDM | GPU | consumes materialized unit-norm initial field | runtime qualification separate |
| FEM | CPU | nodal v2 preset and mapping evaluation | source and pytest evidence |
| FEM | GPU | consumes materialized unit-norm initial field | runtime qualification separate |

(implementation-mapping)=
## 9. Mapa implementacji

- Rust planner evaluator: `crates/fullmag-plan/src/magnetization_textures_v2.rs` (`apply_clamp_mode_v2`, `validate_axis_extent_v2`, `skyrmion_lattice`, `spiral`, `bloch_point`, `artificial_spin_ice`).
- Rust IR defaults: `crates/fullmag-ir/src/model.rs` (`default_texture_mapping_clamp_mode`).
- Python reference evaluator: `packages/fullmag-py/src/fullmag/init/preset_eval_v2.py` (`evaluate_preset_texture_v2`).
- Python authoring DSL: `packages/fullmag-py/src/fullmag/init/textures.py` (`class TextureMapping`, `class TextureTransform3D`, `class PresetTexture`).
- Canonical script export: `packages/fullmag-py/src/fullmag/runtime/script_builder.py` (`_render_preset_texture_expr`).

(validation)=
## 10. Walidacja

Zestaw testów `test_textures_v2_clamp_and_script_export.py` sprawdza dokładność
`repeat`, `mirror`, `clamp` i `background`, rozdzielenie `rotate_vectors=False`
od `rotate_vectors=True`, ograniczenie grubości warstwy `axis_thickness_m`,
jednostkową normę oraz okresowość wszystkich 4 nowych presetów v2, a także
pełny round-trip eksportu skryptu Python.

(limitations)=
## 11. Ograniczenia i odroczone prace

Gdy `clamp_mode != "none"` i użytkownik nie poda jawnie `tile_period`, okres
awaryjny wyznaczany z obwiedni punktów próbkowania może zależeć od dyskretyzacji;
w zastosowaniach produkcyjnych zaleca się jawne podawanie metrycznego `tile_period`.

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. N. Nagaosa, Y. Tokura, *Topological properties and dynamics of magnetic skyrmions*, Nature Nanotechnology 8, 899–911 (2013), DOI: 10.1038/nnano.2013.243.
2. A. P. Malozemoff, J. C. Slonczewski, *Magnetic Domain Walls in Bubble Materials*, Academic Press, 1979 (rozdz. o punktach Blocha).
3. C. Nisoli, R. Moessner, P. Schiffer, *Colloquium: Artificial spin ice: Designing and imaging magnetic frustration*, Rev. Mod. Phys. 85, 1473 (2013), DOI: 10.1103/RevModPhys.85.1473.

(source-code-index)=
## 13. Indeks źródeł i dowodów

| Claim/equation | Path | Symbol | Test/evidence | Lane |
|---|---|---|---|---|
| Rust clamp_mode default none | crates/fullmag-ir/src/model.rs | default_texture_mapping_clamp_mode | preset_texture_version.rs | all |
| Rust clamp/repeat/mirror/background | crates/fullmag-plan/src/magnetization_textures_v2.rs | apply_clamp_mode_v2 | test_clamp_modes_repeat_mirror_and_background_evaluate_accurately | FDM/FEM |
| Rust slab thickness confinement | crates/fullmag-plan/src/magnetization_textures_v2.rs | validate_axis_extent_v2 | test_textures_v2_clamp_and_script_export.py | FDM/FEM |
| Rust skyrmion lattice preset | crates/fullmag-plan/src/magnetization_textures_v2.rs | skyrmion_lattice | test_wave2_presets_evaluate_unit_vectors_and_validate | FDM/FEM |
| Rust spin spiral preset | crates/fullmag-plan/src/magnetization_textures_v2.rs | spiral | test_wave2_presets_evaluate_unit_vectors_and_validate | FDM/FEM |
| Rust 3D Bloch point preset | crates/fullmag-plan/src/magnetization_textures_v2.rs | bloch_point | test_wave2_presets_evaluate_unit_vectors_and_validate | FDM/FEM |
| Rust artificial spin ice preset | crates/fullmag-plan/src/magnetization_textures_v2.rs | artificial_spin_ice | test_wave2_presets_evaluate_unit_vectors_and_validate | FDM/FEM |
| Python v2 evaluator | packages/fullmag-py/src/fullmag/init/preset_eval_v2.py | evaluate_preset_texture_v2 | test_textures_v2_clamp_and_script_export.py | Python reference |
| Python TextureMapping DSL | packages/fullmag-py/src/fullmag/init/textures.py | class TextureMapping | test_textures_v2_clamp_and_script_export.py | authoring |
| Python TextureTransform3D DSL | packages/fullmag-py/src/fullmag/init/textures.py | class TextureTransform3D | test_space_only_rotation_keeps_domain_vectors_along_crystal_axis | authoring |
| Fluent script renderer | packages/fullmag-py/src/fullmag/runtime/script_builder.py | _render_preset_texture_expr | test_script_builder_renders_fluent_fm_texture_calls_for_all_v2_presets | authoring |
