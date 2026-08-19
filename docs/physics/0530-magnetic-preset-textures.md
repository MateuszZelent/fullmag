# 0530 — Analityczne tekstury magnetyzacji: bimeron i wspólne bazy płaszczyzn

- Status: zaakceptowany kontrakt fizyczny i referencyjny kontrakt samplingu; kwalifikacja produkcyjna backendów pozostaje osobnym etapem
- Właściciel: Fullmag core physics/runtime
- Ostatnia aktualizacja: 2026-08-19
- Zakres: presety analityczne próbkowane do punktów FEM i środków komórek FDM

(problem-statement)=
## 1. Sformułowanie problemu

Fullmag opisuje początkową magnetyzację jako analityczne pole wektorowe
przypisane do fizycznych współrzędnych punktu. Pole jest próbkowane przez
wspólny pipeline planner/runtime, dlatego ten sam preset musi mieć identyczne
nazwy parametrów, jednostki, konwencję orientacji oraz zachowanie błędów w
Rust, referencyjnym evaluatorze Python i autorstwie Control Room.

Ten dokument dodaje preset bimeronu i porządkuje orientację wszystkich
presetów korzystających z parametru plane. Nie definiuje dynamiki LLG,
energii stabilizującej ani kryterium, że tekstura pozostanie rozwiązaniem
równowagowym po relaksacji. Jest to warunek początkowy.

(governing-equations)=
## 2. Równania i konwencja orientacji

### 2.1 Wspólna prawoskrętna baza

Dla każdej płaszczyzny obowiązuje uporządkowana lokalna baza
(e_u, e_v, e_n), z e_n = e_u × e_v:

| plane | e_u | e_v | e_n |
|---|---|---|---|
| xy | +x | +y | +z |
| xz | +x | +z | −y |
| yz | +y | +z | +x |

Nazwa płaszczyzny oznacza kolejność osi, a nie nieuporządkowany zbiór osi.
Współrzędne lokalne są używane do obliczenia r i phi, a wektor lokalny jest
mapowany z powrotem do świata z tą samą bazą. Korekta xz jest wspólna dla
vortexów, skyrmionów i bimeronu.

### 2.2 Profil bimeronu

Dla u = e_u · p oraz v = e_v · p:

```text
r = sqrt(u^2 + v^2)
phi = atan2(v, u)
theta(r) =
  2 atan(exp((r - R)/Delta))
+ 2 atan(exp((r + R)/Delta))
- pi
```

Implementacja używa algebraicznie równoważnej postaci stabilnej numerycznie:

```{math}
:label: bimeron-stable-theta-profile
\theta(r) =
\arcsin\left(\tanh\left(\frac{r-R}{\Delta}\right)\right)
+
\arcsin\left(\tanh\left(\frac{r+R}{\Delta}\right)\right).
```

Dla parametrów R > 0 i Delta > 0 zachodzi theta(0) = 0 oraz
theta(r -> infinity) = pi. Faza azymutalna ma postać

```{math}
:label: bimeron-phase
\chi(r,\phi) = Q_{\mathrm v}\phi + \eta.
```

Magnetyzacja w bazie lokalnej jest definiowana jako

```{math}
:label: bimeron-magnetization
\mathbf m_{\mathrm{local}} =
s_{\mathrm{bg}}
\begin{pmatrix}
-\cos\theta \\
-\sin\theta\sin\chi \\
-\sin\theta\cos\chi
\end{pmatrix},
\qquad
s_{\mathrm{bg}}\in\{-1,+1\}.
```

Dla s_bg = +1 środek wskazuje −e_u, dalekie tło +e_u, a dwa rdzenie
meronów na osi phi = 0 i phi = pi mają przeciwne składowe normalne. Parametr
helicity eta obraca fazę, a vorticity Q_v zmienia kierunek nawinięcia.

### 2.3 Normalizacja i ładunek

Analityczny wektor spełnia:

```{math}
:label: bimeron-normalization
\lVert\mathbf m_{\mathrm{local}}\rVert^2 =
\cos^2\theta+\sin^2\theta\sin^2\chi+\sin^2\theta\cos^2\chi=1.
```

Pipeline nadal wywołuje wspólną normalize(), ponieważ wszystkie presety mają
wspólny kontrakt wyjścia.

(bimeron-topological-density)=
Dla prawoskrętnej bazy i kanonicznej orientacji
ciągły gęstościowy wkład ma postać:

```{math}
:label: bimeron-topological-density
q(u,v) =
\frac{1}{4\pi}\,
\mathbf m\cdot
\left(
\frac{\partial\mathbf m}{\partial u}
\times
\frac{\partial\mathbf m}{\partial v}
\right).
```

Dla idealnego profilu na dostatecznie dużym obszarze całka ma znak
$s_{\mathrm{bg}} Q_{\mathrm v}$. Wartość całki z dyskretnej siatki jest testem numerycznym, nie
dodatkowym runtime'em ani automatycznym twierdzeniem o kwantyzacji.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| p, u, v | punkt świata/obiektu i jego współrzędne w płaszczyźnie | m |
| r, R | promień lokalny i parametr położenia przejścia | m |
| \Delta | wall_width, szerokość profilu | m |
| \phi, \eta | azymut i helicity | rad |
| \chi | faza azymutalna | rad |
| \theta | profil polarny | rad |
| Q_{\mathrm v} | vorticity, znak nawinięcia | 1 |
| s_{\mathrm{bg}} | background_sign | 1 |
| e_u, e_v, e_n | uporządkowana baza lokalna | 1 |
| \mathbf m | znormalizowana magnetyzacja | 1 |
| mu, mv, mn | składowe m w bazie lokalnej | 1 |
| Q | całka gęstości topologicznej | 1 |

| Python | Typ | Domyślna wartość | Jednostka SI | Walidacja | Znaczenie | Backend | ProblemIR |
|---|---|---|---|---|---|---|---|
| texture.bimeron(radius=...) | float | required | m | finite and > 0 | promień przejścia profilu | FEM/FDM CPU/GPU | preset_params.radius |
| texture.bimeron(wall_width=...) | float | required | m | finite and > 0 | szerokość ściany | FEM/FDM CPU/GPU | preset_params.wall_width |
| texture.bimeron(vorticity=...) | int | +1 | 1 | -1 or +1 | znak nawinięcia | FEM/FDM CPU/GPU | preset_params.vorticity |
| texture.bimeron(helicity_rad=...) | float | 0.0 | rad | finite | przesunięcie fazy | FEM/FDM CPU/GPU | preset_params.helicity_rad |
| texture.bimeron(background_sign=...) | int | +1 | 1 | -1 or +1 | znak tła | FEM/FDM CPU/GPU | preset_params.background_sign |
| texture.bimeron(plane=...) | string | xy | 1 | xy, xz, or yz | lokalna baza płaszczyzny | FEM/FDM CPU/GPU | preset_params.plane |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

- Punkt jest interpretowany po zastosowaniu istniejącego wyboru przestrzeni,
  projekcji, odwrotnej transformacji i trybu clamp/repeat/mirror.
- radius i wall_width są długościami fizycznymi i pozostają w metrach.
- Obecny kontrakt ogranicza vorticity do ±1; profile wyższych rzędów wymagają
  osobnej funkcji regularizującej środek.
- Parametry muszą prowadzić do skończonych wartości. Stabilna postać
  tanh/asin nie oblicza exp dla dużych argumentów.
- Bimeron jest warunkiem początkowym. Stabilność po relaksacji zależy od
  wymiany, anizotropii, DMI, frustracji, pola, demagnetyzacji i geometrii.
- Dokument nie kwalifikuje dokładności ani wydajności natywnych lane'ów GPU.
- Płaszczyzna xz otrzymuje normalną −y; zmiana wpływa na znak obserwabli
  topologicznych wszystkich presetów korzystających z tej płaszczyzny.

(python-api)=
## 5. Publiczne API Python

Fabryka publiczna ma postać:

```python
texture.bimeron(
    radius,
    wall_width,
    vorticity=1,
    helicity_rad=0.0,
    background_sign=1,
    plane="xy",
)
```

Przykład:

```python
# %%
from fullmag import texture

# %%
initial = texture.bimeron(
    radius=5e-9,
    wall_width=2e-9,
    vorticity=1,
    helicity_rad=0.0,
    background_sign=1,
    plane="xy",
)
```

Fabryka zwraca istniejący PresetTexture. Nie wprowadza osobnego typu
ProblemIR. Błędy argumentów są zgłaszane przed zbudowaniem IR jako ValueError;
błędy odczytu parametrów w evaluatorze referencyjnym są również jawne.

(problem-ir)=
## 6. ProblemIR i round-trip

IR pozostaje bez zmian strukturalnych:

```json
{
  "kind": "preset_texture",
  "preset_kind": "bimeron",
  "preset_params": {
    "plane": "xy",
    "radius": 5e-9,
    "wall_width": 2e-9,
    "vorticity": 1,
    "helicity_rad": 0.0,
    "background_sign": 1
  }
}
```

Rust planner rozpoznaje preset przez tekstowy preset_kind. Python DSL,
Control Room i katalog legacy serializują te same nazwy parametrów. Nie jest
wymagany nowy enum, endpoint, wersjonowanie transportu ani capability ID.

(round-trip-and-failure-semantics)=
### 6.1 Round-trip i błędy

Round-trip przechowuje jednostki SI oraz wartości parametrów bez
przeliczania przez rozmiar obiektu. Kontrakt zachowuje requested intent, a planner ujawnia resolved execution; validation errors i unsupported combinations są zgłaszane jawnie.

Control Room przechowuje wartości robocze
w stringach draftu, a przy zapisie tworzy liczby w preset_params.

Błędy są deterministyczne:

- brak radius albo wall_width: błąd wymaganej wartości;
- radius <= 0 albo wall_width <= 0: błąd parametru;
- vorticity niebędące −1/+1: błąd parametru;
- background_sign niebędące −1/+1: błąd parametru;
- nieznana plane: błąd parametru;
- niekońcowy helicity_rad: błąd parametru.

Nie ma cichego fallbacku do skyrmionu, uniformu ani innej płaszczyzny.

(discrete-realization)=
## 7. Realizacja dyskretna

### 7.1 Wspólny planner/reference sampling

Dla każdego punktu pipeline wybiera przestrzeń, wykonuje projekcję,
odwrotną transformację, politykę clamp i funkcję presetu. Następnie wynik jest
normalizowany. Nie ma rozróżnienia wzoru dla FEM i FDM na poziomie presetu.

### 7.2 FDM CPU i FDM GPU

- FDM CPU interpretuje próbki w środkach aktywnych komórek.
- FDM GPU otrzymuje ten sam wynikowy wektor po kontrakcie runtime; ta nota
  dokumentuje wspólny sampling, nie dowód parity ani kwalifikacji GPU.
- Maska nieaktywnych komórek pozostaje nadrzędną polityką próbkowania i zwraca
  zero zgodnie z istniejącym kontraktem.

### 7.3 FEM CPU i FEM GPU

- FEM CPU interpretuje próbki w punktach/nodach przekazanych przez planner.
- FEM GPU korzysta z tego samego semantycznego initial state, jeśli dana
  ścieżka runtime jest aktywna.
- Dokumentacja nie twierdzi, że każdy natywny runtime FEM/GPU jest obecnie
  zbudowany, uruchomiony lub zakwalifikowany dla nowego presetu.

### 7.4 Jednostki i skala

Parametry długości nie są automatycznie dopasowywane do bounding boxu w
kanonicznym Python DSL ani w Control Room. Legacy metadata może zaproponować
wartości startowe do widoku, ale nie zmienia zapisanych jednostek metrycznych.

(implementation-mapping)=
## 8. Mapa implementacji

| Warstwa | Odpowiedzialność | Plik i symbol |
|---|---|---|
| Rust planner | lokalne bazy, profil, evaluator i dispatcher | crates/fullmag-plan/src/magnetization_textures.rs: plane_coords, plane_vec_to_world, bimeron_theta, eval_bimeron, eval_preset |
| Rust sampling | projekcja, transformacja, maska i normalizacja | crates/fullmag-plan/src/magnetization_textures.rs: sample_preset_texture |
| Python DSL | fabryka i serializacja | packages/fullmag-py/src/fullmag/init/textures.py: texture.bimeron |
| Python reference | niezależne próbkowanie i parity | packages/fullmag-py/src/fullmag/init/preset_eval.py: _plane_coords, _plane_vec_to_world, _bimeron, evaluate_preset_texture |
| Python runtime | metryczne parametry analityczne | packages/fullmag-py/src/fullmag/runtime/initial_state.py: _METRIC_ANALYTIC_PRESETS |
| Control Room | katalog, draft, panel i command contribution | apps/control-room/src/shared/domain/magnetization-texture/texturePresets.ts: MAGNETIZATION_TEXTURE_PRESETS; apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.ts: presetParamsFromDraft; apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx |
| Python export | kanoniczne odtwarzanie wywołania DSL | packages/fullmag-py/src/fullmag/runtime/script_builder.py: _render_texture_factory_call |
| Control Room preview | kolor podglądu presetów analitycznych | apps/control-room/src/modules/viewport-3d/viewport3dPrimitiveModel.ts: function magnetizationPreviewColor |
| Legacy metadata | referencyjny katalog i dopasowanie rozmiaru | apps/legacy_web/lib/magnetizationPresetCatalog.ts; apps/legacy_web/lib/textureTransform.ts |
| Legacy menu | akcja przypisania presetu w reference UI | apps/legacy_web/features/shell/contributions/materials.tsx: buildMaterialsGroups |
| Parity fixture | wspólne przypadki Rust/Python | crates/fullmag-plan/tests/fixtures/bimeron_parity.json; crates/fullmag-plan/tests/bimeron_textures.rs: bimeron_matches_shared_rust_python_parity_fixture |
| Dokumentacja | kontrakt fizyczny i source map | docs/physics/0530-magnetic-preset-textures.source-map.json |

(validation)=
## 9. Walidacja

Testy charakterystyczne muszą potwierdzić:

1. w środku bimeronu m_u < −0.999 dla background_sign=+1;
2. daleko od środka m_u > +0.999;
3. przy ±R na osi u składowa normalna ma przeciwne znaki;
4. norma wyjścia jest równa jeden;
5. vorticity = +1 i −1 odwracają kierunek fazy;
6. background_sign odwraca cały wektor;
7. błędne parametry są odrzucane;
8. wall_width bliskie granicy zmiennoprzecinkowej nie powoduje overflow;
9. w xz normalna wynosi −y zarówno dla bimeronu, jak i istniejących
   vortexów/skyrmionów;
10. Rust i Python produkują te same wektory dla tych samych punktów i parametrów;
11. Control Room generuje dokładnie te same klucze preset_params;
12. legacy nie skaluje tekstury bimeronu przez bezwymiarowy size multiplier.

Minimalne dowody uruchomieniowe dla tego zadania obejmują testy Rust, Python,
TypeScript oraz walidator dokumentacji. Brak toolchainu albo brak zależności
należy raportować jako ograniczenie dowodu, nie jako passing.

(limitations)=
## 10. Ograniczenia i odroczone prace

- Brak dynamicznej stabilności LLG i brak automatycznej relaksacji.
- Brak vorticity o module większym niż jeden.
- Brak analitycznego obliczania Q podczas próbkowania.
- Korekta xz zachowuje istniejące nazwy API, ale zmienia znak fizycznej
  normalnej dla wszystkich presetów plane-aware w tej płaszczyźnie.
- Kwalifikacja GPU, parity całego runtime i wizualna kwalifikacja UI wymagają
  osobnych środowiskowych gate'ów.
- Legacy web jest reference-only i nie dostaje nowej, niezależnej ścieżki
  transportu ani workflow.

(scientific-bibliography)=
## 11. Bibliografia naukowa

- [1] B. Göbel, A. Mook, J. Henk, I. Mertig, O. A. Tretiakov, “Magnetic bimerons as skyrmion analogues in in-plane magnets”, Phys. Rev. B 99, 060407 (2019), https://doi.org/10.1103/PhysRevB.99.060407.
- [2] X. Zhang, J. Xia, L. Shen, M. Ezawa, O. A. Tretiakov, G. Zhao, X. Liu, Y. Zhou, “Static and dynamic properties of bimerons in a frustrated ferromagnetic monolayer”, Phys. Rev. B 101, 144435 (2020), https://doi.org/10.1103/PhysRevB.101.144435.

(source-code-index)=
## 12. Indeks źródeł i dowodów

| Źródło | Symbol |
|---|---|
| crates/fullmag-plan/src/magnetization_textures.rs | bimeron_theta |
| crates/fullmag-plan/src/magnetization_textures.rs | eval_bimeron |
| crates/fullmag-plan/src/magnetization_textures.rs | normalize |
| crates/fullmag-plan/src/magnetization_textures.rs | plane_coords |
| crates/fullmag-plan/src/magnetization_textures.rs | plane_vec_to_world |
| packages/fullmag-py/src/fullmag/init/preset_eval.py | _bimeron |
| packages/fullmag-py/src/fullmag/init/preset_eval.py | _normalize |
| packages/fullmag-py/src/fullmag/init/preset_eval.py | _plane_coords |
| packages/fullmag-py/src/fullmag/init/preset_eval.py | _plane_vec_to_world |
| packages/fullmag-py/src/fullmag/init/textures.py | bimeron |
| packages/fullmag-py/src/fullmag/runtime/initial_state.py | prepare_initial_magnetization |
| apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.ts | buildObjectMagneticTextureAssetDraft |
| apps/legacy_web/lib/textureTransform.ts | textureScaleSemantics |
| apps/legacy_web/lib/textureTransform.ts | fitPresetParamsToBounds |
| packages/fullmag-py/src/fullmag/runtime/script_builder.py | _render_texture_factory_call |
| apps/control-room/src/modules/viewport-3d/viewport3dPrimitiveModel.ts | function magnetizationPreviewColor |
| apps/legacy_web/features/shell/contributions/materials.tsx | buildMaterialsGroups |
| crates/fullmag-plan/tests/bimeron_textures.rs | bimeron_has_in_plane_background_and_opposite_meron_cores |
| crates/fullmag-plan/tests/bimeron_textures.rs | bimeron_matches_shared_rust_python_parity_fixture |
| packages/fullmag-py/tests/test_bimeron_textures.py | test_bimeron_factory_serializes_canonical_parameters |
| apps/control-room/src/shared/domain/magnetization-texture/bimeron.test.ts | describe |
| apps/legacy_web/features/viewport-fem/model/__tests__/textureTransform.bimeron.test.ts | describe |
| docs/physics/0530-magnetic-preset-textures.md | DOC-ANCHOR:bimeron-topological-density |
| docs/physics/0530-magnetic-preset-textures.source-map.json | source map |

Ta nota dokumentuje kontrakt i ścieżki źródłowe. Nie oznacza, że wszystkie
wymienione testy lub backendy są już zakwalifikowane; status wynika wyłącznie
z uruchomionych dowodów.
