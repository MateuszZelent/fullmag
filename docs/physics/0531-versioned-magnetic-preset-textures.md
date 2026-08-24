# 0531 — Wersjonowany kontrakt analitycznych tekstur magnetyzacji

- Status: accepted_contract_not_production_qualified
- Owners: Fullmag physics and runtime
- Last updated: 2026-08-24
- Related ADRs: docs/adr/0011-resource-first-api.md
- Related specs: docs/specs/magnetization-init-policy-v0.md

(problemmagtexture)=
## 1. Dziedzina fizyczna

(problem-statement)=
Tekstura magnetyzacji jest analitycznym warunkiem początkowym
$\mathbf m:\Omega\to\mathbb R^3$, gdzie $\mathbf m$ jest
bezwymiarowym wektorem jednostkowym, a $\Omega$ jest domeną obiektu
w metrach. Preset nie jest osobnym solverem ani energią; definiuje próbkę
stanu, którą planner materializuje na komórkach FDM albo punktach/węzłach FEM.

Audyt wykazał, że poprzedni kontrakt mieszał parametry fizyczne z kierunkiem
znormalizowanym, maskował błędy przez wybór $+\mathbf e_z$, miał niezgodne
frame płaszczyzn i nie przenosił wersji do executable IR. Ten dokument ustanawia
kontrakt migracyjny: dane historyczne są wariantem v1, a poprawione równania
i walidacja są wariantem v2.

(governing-equations)=
## 2. Model fizyczny

### 2.1 Wspólny frame

Dla lokalnej płaszczyzny wybieramy prawoskrętną bazę
$\{\mathbf e_u,\mathbf e_v,\mathbf e_n\}$, z
$\mathbf e_n=\mathbf e_u\times\mathbf e_v$. Używane orientacje to

```{math}
:label: texture-plane-frames

\begin{aligned}
xy &: (\mathbf e_u,\mathbf e_v,\mathbf e_n)=(+\mathbf e_x,+\mathbf e_y,+\mathbf e_z),\\
xz &: (\mathbf e_u,\mathbf e_v,\mathbf e_n)=(+\mathbf e_x,+\mathbf e_z,-\mathbf e_y),\\
yz &: (\mathbf e_u,\mathbf e_v,\mathbf e_n)=(+\mathbf e_y,+\mathbf e_z,+\mathbf e_x).
\end{aligned}
```

Dla punktu $\mathbf r$ lokalne współrzędne są
$u=\mathbf r\cdot\mathbf e_u$, $v=\mathbf r\cdot\mathbf e_v$,
$n=\mathbf r\cdot\mathbf e_n$. To samo źródło frame definiuje osadzenie
komponentów pola i znak obserwabli topologicznych.

### 2.2 Presety topologiczne i ściany

Dla v2 regularny vortex ma $r=\sqrt{u^2+v^2}$,
$\phi=\operatorname{atan2}(v,u)$, $q\in\{-1,+1\}$ oraz
$c,p\in\{-1,+1\}$:

```{math}
:label: texture-vortex-v2

f(r)=\exp[-(r/r_c)^2],\qquad
m_n=p f(r),\qquad
m_\perp=\sqrt{\max(0,1-f(r)^2)},
\qquad
\psi=q\phi+c\frac{\pi}{2},
m_u=m_\perp\cos\psi,\qquad
m_v=m_\perp\sin\psi.
```

Dla vortexu $q=+1$, dla antivortexu $q=-1$; circulation zmienia helicity,
a nie winding. W centrum $m_\perp=0$ i
$\mathbf m(0)=p\mathbf e_n$.

Skyrmion v2 wykorzystuje profil z dokładnym limitem w centrum:

```{math}
:label: texture-skyrmion-v2

\theta(r)=2\arctan\left(\frac{\sinh(R/\Delta)}{\sinh(r/\Delta)}\right),
\qquad
m_\perp=\sin\theta,\qquad m_n=p\cos\theta,
m_u=m_\perp\cos(q\phi+\eta),\qquad
m_v=m_\perp\sin(q\phi+\eta).
```

W implementacji dla $r=0$ używany jest analityczny limit
$\theta(0)=\pi$. Parametr v2 core_polarity oznacza znak rdzenia; zapis v1
z odwróconą konwencją nie jest reinterpretowany.

Dla ściany 180 stopni, $\mathbf a$ jest kierunkiem lewej domeny,
$\mathbf m_R=-\mathbf a$, a $\mathbf b\perp\mathbf a$ jest kierunkiem
środka ściany:

```{math}
:label: texture-domain-wall-v2

\xi=\frac{s-s_0}{\Delta},\qquad
\mathbf m(\xi)=-\tanh(\xi)\mathbf a+
\operatorname{sech}(\xi)\mathbf b.
```

Profil ma normę jeden dla każdego $\xi$, właściwe granice domen i nie redukuje
się do skoku. two_domain v2 ma jawny wall_width, chyba że użytkownik wybierze
jawny tryb ostrej granicy.

Preset `vortex_wall` łączy dokładnie jednorodne domeny z regularnym profilem
vortexu w centralnym pasie. Dla lokalnej współrzędnej $u$, połówkowej szerokości
$w>0$ i niezerowych znaków domen $s_L=\operatorname{sgn}(m_{x,L})$ oraz
$s_R=\operatorname{sgn}(m_{x,R})$:

```{math}
:label: texture-vortex-wall-v2

\mathbf m(u,v)=
\begin{cases}
s_L\mathbf e_u, & u < -w,\\
\mathbf m_{\mathrm{vortex}}(u,v), & -w\leq u\leq w,\\
s_R\mathbf e_u, & u > w.
\end{cases}
```

Centralny profil używa tego samego równania, frame, `circulation`,
`core_polarity` i `core_radius` co vortex v2. Parametr $w$ jest jawny w metrach;
nie zależy od rozmiaru siatki ani bieżących granic symulacji.

Kompaktowy hopfion używa współrzędnych toroidalnych. Dla promienia głównego
$R_H>0$, promienia przekroju $r_H>0$ i
$\psi=\operatorname{atan2}(y,x)$ definiujemy
$a=x\cos\psi+y\sin\psi-R_H$ oraz $\rho=\sqrt{z^2+a^2}$. Dla
$\rho<r_H$:

```{math}
:label: texture-hopfion-compact-support-v2

\alpha=\operatorname{atan2}(z,a),\qquad
\Phi=-\alpha+\psi,\qquad
\Theta=\pi\exp\!\left(1-\frac{1}{1-(\rho/r_H)^2}\right),
```

```{math}
:label: texture-hopfion-compact-vector-v2

\mathbf m=(\cos\Phi\sin\Theta,\;\sin\Phi\sin\Theta,\;\cos\Theta).
```

Dla $\rho\geq r_H$ kontrakt zwraca dokładnie $+\mathbf e_z$, także na granicy
nośnika. Profil jest trójwymiarowy i wymaga projekcji `object_local`.

### 2.3 Helical i conical

Dla fizycznego wektora falowego $\mathbf q$ w $\mathrm{m^{-1}}$:

```{math}
:label: texture-helical-v2

\varphi(\mathbf r)=\mathbf q\cdot\mathbf r+\varphi_0,\qquad
\mathbf m(\mathbf r)=\mathbf e_1\cos\varphi+\mathbf e_2\sin\varphi,
\qquad
\|\mathbf e_1\|=\|\mathbf e_2\|=1,\quad
\mathbf e_1\cdot\mathbf e_2=0.
```

Okres wynosi $2\pi/\|\mathbf q\|$. Wektor $\mathbf q$ nie jest
normalizowany. Conical używa jednostkowej osi $\mathbf a$, kąta
$\beta\in[0,\pi]$ i prawoskrętnej bazy poprzecznej:

```{math}
:label: texture-conical-v2

\mathbf m=\cos\beta\,\mathbf a+
\sin\beta(\mathbf e_1\cos\varphi+\mathbf e_2\sin\varphi),
\qquad
\mathbf m\cdot\mathbf a=\cos\beta,\quad\|\mathbf m\|=1.
```

### 2.4 Random i transformacja rigid

Sampler losowy używa całkowitoliczbowego, deterministycznego hasha
(seed, bit-pattern(x), bit-pattern(y), bit-pattern(z)) oraz zmiennych
$\phi\sim U[0,2\pi)$ i $z\sim U[-1,1]$. seed=0 jest prawidłowym
seedem, a nie stanem zerowym.

Dla transformacji v2 punkt jest próbkowany w lokalnym układzie przez
$R^{-1}$, ale wynikowy wektor jest następnie obracany przez $R$:
\mathbf m_{\mathrm{world}}(\mathbf r)
=R\,\mathbf m_{\mathrm{local}}(R^{-1}(\mathbf r-\mathbf t)).
Skale muszą być skończone i niezerowe.

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $r$ | lokalny promień | $\mathrm{m}$ |
| $R$ | promień presetu | $\mathrm{m}$ |
| $\Delta$ | szerokość ściany | $\mathrm{m}$ |
| $r_c$ | promień rdzenia vortexu | $\mathrm{m}$ |
| $p$ | polarity rdzenia | $1$ |
| $q$ | winding/vorticity | $1$ |
| $c$ | circulation/helicity sign | $1$ |
| $m_\perp$ | amplituda składowej in-plane | $1$ |
| $\psi$ | lokalna faza azymutalna | $\mathrm{rad}$ |
| $\theta$ | profil polarny | $\mathrm{rad}$ |
| $\xi$ | bezwymiarowa odległość od środka ściany | $1$ |
| $\mathbf a$ | kierunek domeny/osi stożka | $1$ |
| $\mathbf b$ | kierunek środka ściany | $1$ |
| $\mathbf q$ | fizyczny wektor falowy | $\mathrm{m^{-1}}$ |
| $\varphi$ | faza helisy/stożka | $\mathrm{rad}$ |
| $\beta$ | kąt stożka | $\mathrm{rad}$ |
| $\mathbf e_u$ | pierwsza oś frame | $1$ |
| $\mathbf e_v$ | druga oś frame | $1$ |
| $\mathbf e_n$ | normalna frame | $1$ |
| $\mathbf e_1$ | pierwsza oś płaszczyzny spinowej | $1$ |
| $\mathbf e_2$ | druga oś płaszczyzny spinowej | $1$ |
| $w$ | połówkowa szerokość ściany vortexowej | $\mathrm{m}$ |
| $s_L$ | znak lewej domeny | $1$ |
| $s_R$ | znak prawej domeny | $1$ |
| $R_H$ | promień główny torusa hopfionu | $\mathrm{m}$ |
| $r_H$ | promień przekroju i nośnika hopfionu | $\mathrm{m}$ |
| $\rho$ | odległość od linii centralnej torusa | $\mathrm{m}$ |
| $\alpha$ | lokalny kąt przekroju torusa | $\mathrm{rad}$ |
| $\Phi$ | azymut magnetyzacji hopfionu | $\mathrm{rad}$ |
| $\Theta$ | kąt polarny magnetyzacji hopfionu | $\mathrm{rad}$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

Presety zakładają ciągłą interpretację pola poza punktami, w których kierunek
azymutalny jest nieokreślony; v2 usuwa tę nieciągłość przez analityczne limity
rdzenia. Parametry metryczne są w SI i nie mogą być zastępowane przez
znormalizowany rozmiar tekstury. Profile są warunkami początkowymi, nie dowodem
równowagi po relaksacji ani rozwiązaniem równania LLG.

Wartości niefinitych, zerowych długości, niedozwolonych znaków, niepoprawnych
osi, nieortogonalnych baz i nieznanych wersji nie wolno naprawiać cichym
fallbackiem. Planner zwraca błąd przed materializacją.

(python-api)=
## 5. Python API

Publiczne factory methods znajdują się w
packages/fullmag-py/src/fullmag/init/textures.py. Każdy konstruktor przyjmuje
jawny preset_version; wartość 1 zachowuje kompatybilność, a 2 włącza poprawiony
kontrakt. Przykład stage-first:

```python
# %%
import fullmag as fm

study = fm.study("versioned_texture_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(200e-9, 200e-9, 20e-9))
film = study.geometry(fm.Box(size=(100e-9, 100e-9, 5e-9), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.texture.vortex(
    circulation=1,
    core_polarity=1,
    core_radius=8e-9,
    plane="xy",
    preset_version=2,
)
study.demag(realization="fdm_convolution")
study.stages.add_save_state(artifact_name="initial-m.zarr", format="zarr", dataset="m")
```

Nieznane parametry i wartości poza domeną kończą się ValueError w DSL lub
typed error w plannerze. to_ir() zapisuje wersję, parametry, mapping i
texture_transform bez zmiany nazw fizycznych.

### 5.1 Tabela parametrów publicznych

| Python | Typ | Domyślna | Jednostka SI | Walidacja | Znaczenie | Obsługa backendu | ProblemIR |
|---|---|---|---|---|---|---|---|
| texture.vortex.preset_version | int | 2 | 1 | 1 or 2 | wybór kontraktu reprodukowalności | FEM/FDM CPU/GPU semantic descriptor | magnets[].initial_magnetization.preset_version |
| texture.vortex.core_radius | float | required for v2 | $\mathrm{m}$ | finite and > 0 | promień regularizacji rdzenia | FEM/FDM CPU/GPU | preset_params.core_radius |
| texture.helical.wavevector | Sequence[float] | required | $\mathrm{m^{-1}}$ | finite and nonzero | fizyczny wektor falowy | FEM/FDM CPU/GPU | preset_params.wavevector |
| texture.domain_wall.wall_center_direction | Sequence[float] | derived when possible; explicit for degenerate geometry | 1 | finite, nonzero, orthogonal to domain direction | kierunek magnetyzacji w środku ściany | FEM/FDM CPU/GPU | preset_params.wall_center_direction |
| texture.vortex_wall.wall_half_width | float | required | $\mathrm{m}$ | finite and > 0 | połówkowa szerokość centralnego pasa vortexu | FEM/FDM CPU/GPU | preset_params.wall_half_width |
| texture.vortex_wall.left_mx | float | 1 | $1$ | finite and nonzero | znak lewej jednorodnej domeny | FEM/FDM CPU/GPU | preset_params.left_mx |
| texture.vortex_wall.right_mx | float | -1 | $1$ | finite and nonzero | znak prawej jednorodnej domeny | FEM/FDM CPU/GPU | preset_params.right_mx |
| texture.vortex_wall.circulation | int | 1 | $1$ | -1 or 1 | circulation centralnego vortexu | FEM/FDM CPU/GPU | preset_params.circulation |
| texture.vortex_wall.core_polarity | int | 1 | $1$ | -1 or 1 | polarity centralnego rdzenia | FEM/FDM CPU/GPU | preset_params.core_polarity |
| texture.vortex_wall.core_radius | float | 1e-9 | $\mathrm{m}$ | finite and > 0 | promień centralnego rdzenia | FEM/FDM CPU/GPU | preset_params.core_radius |
| texture.vortex_wall.plane | str | xy | $1$ | xy, xz or yz | prawoskrętny frame ściany | FEM/FDM CPU/GPU | preset_params.plane |
| texture.vortex_wall.preset_version | int | 2 | $1$ | exactly 2 | wybór wersji profilu vortex wall | FEM/FDM CPU/GPU | preset_version |
| texture.hopfion_compact_support.major_radius | float | required | $\mathrm{m}$ | finite and > 0 | promień główny torusa | FEM/FDM CPU/GPU | preset_params.major_radius |
| texture.hopfion_compact_support.minor_radius | float | required | $\mathrm{m}$ | finite, > 0 and <= major_radius | promień przekroju i zwartego nośnika | FEM/FDM CPU/GPU | preset_params.minor_radius |
| texture.hopfion_compact_support.preset_version | int | 2 | $1$ | exactly 2 | wybór wersji zwartego profilu hopfionu | FEM/FDM CPU/GPU | preset_version |

(problem-ir)=
## 6. ProblemIR i lowering

Canonicalny wariant to:

```json
{
  "kind": "preset_texture",
  "preset_kind": "vortex",
  "preset_version": 2,
  "preset_params": {
    "circulation": 1,
    "core_polarity": 1,
    "core_radius": 8e-9,
    "plane": "xy"
  },
  "mapping": {"space": "object", "projection": "object_local", "clamp_mode": "none"},
  "texture_transform": {
    "translation": [0.0, 0.0, 0.0],
    "rotation_quat": [0.0, 0.0, 0.0, 1.0],
    "scale": [1.0, 1.0, 1.0],
    "pivot": [0.0, 0.0, 0.0]
  }
}
```

Brak preset_version w danych historycznych normalizuje się do 1. UI i Python
muszą schodzić do tego samego wariantu. Planner zachowuje requested version,
resolved version, backend, device, precision i failure provenance.

(round-trip-and-failure-semantics)=
## 7. Round-trip, runtime i błędy

SceneDocument, API v2, Python export i executable IR muszą zachowywać wersję.
Requested intent pozostaje widoczne w preset_version i parametrach wejściowych;
resolved execution zapisuje wersję, backend, device, precision i provenance.
Validation errors są odrzucane przed samplingiem, a unsupported combinations
zwracają błąd zamiast fallbacku do +z, innej osi, seed=1 lub znormalizowanego
q. Round-trip z UI przez API v2 do ProblemIR i canonical Python zachowuje
znaczenie fizyczne; brak pola preset_version w danych historycznych oznacza
jawnie wariant v1. Zmiana tekstury korzysta z istniejącej resource-first
ścieżki i nie dodaje endpointu.

`vortex_wall` odrzuca $w\leq0$, zerowe lub niefinityczne wartości domen oraz
niepoprawny profil vortexu. `hopfion_compact_support` odrzuca nieodatnie lub
niefinityczne $R_H$ i $r_H$. Granica $\rho=r_H$ należy do dokładnie
jednorodnego zewnętrza; implementacje nie mogą oceniać tam osobliwego
mianownika profilu wewnętrznego.

(discrete-realization)=
## 8. Realizacja dyskretna

### 8.1 FDM

FDM próbuje $\mathbf m$ w środkach komórek i zachowuje wersję presetu w
planie początkowego pola. Dla presetów metrycznych skala gridu nie może
zmieniać $R,\Delta,r_c$. CPU i GPU muszą otrzymać ten sam normalizowany
descriptor; niniejsza nota nie kwalifikuje jeszcze bitowej zgodności GPU.

### 8.2 FEM

FEM próbuje ten sam descriptor w punktach/węzłach domeny współdzielonej.
Mesh geometry i sampling initial state pozostają odrębnymi kontraktami.
CPU/GPU używają tej samej semantyki fizycznej, ale wymagają osobnych dowodów
runtime; obecność kodu nie jest kwalifikacją.

### 8.3 Support matrix

| Solver | Device | Semantyka | Status |
|---|---|---|---|
| FDM | CPU | cell-center sampling | source/test evidence; runtime qualification separate |
| FDM | GPU | same descriptor and vector contract | not runtime-qualified here |
| FEM | CPU | point/node sampling | source/test evidence; runtime qualification separate |
| FEM | GPU | same semantic descriptor | not runtime-qualified here |

(implementation-mapping)=
## 9. Mapa implementacji

- Rust v2 evaluator i wspólny frame: crates/fullmag-plan/src/magnetization_textures_v2.rs
  (metric_point, metric_vector, sample_preset_texture_versioned).
- Rust v1 evaluator pozostaje w crates/fullmag-plan/src/magnetization_textures.rs
  i jest używany wyłącznie dla jawnego lub historycznie domyślnego v1.
- IR: crates/fullmag-ir/src/model.rs, InitialMagnetizationIR::PresetTexture
  oraz default_preset_version.
- Authoring/lowering: crates/fullmag-authoring/src/scene.rs,
  crates/fullmag-authoring/src/adapters.rs,
  crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs.
- Materializacja: crates/fullmag-plan/src/mesh.rs i
  crates/fullmag-plan/src/fdm.rs.
- Python: packages/fullmag-py/src/fullmag/init/textures.py,
  preset_eval.py, preset_eval_v2.py, runtime/initial_state.py,
  runtime/script_builder.py.
- UI metadata: apps/control-room/src/shared/domain/magnetization-texture/assetFactory.ts,
  apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.ts,
  katalog i komendy legacy.
- Existing bimeron contract: docs/physics/0530-magnetic-preset-textures.md.
- Mumax3-compatible v2 extensions: crates/fullmag-plan/src/magnetization_textures_v2.rs
  (`vortex_wall`, `hopfion_compact_support`) oraz odpowiadające im factory
  w packages/fullmag-py/src/fullmag/init/textures.py.

(validation)=
## 10. Walidacja

Testy analityczne sprawdzają normę, skończoność, limity centrum, winding,
okres, stożek, profile domenowe, determinant frame i rigid covariance.
Testy `vortex_wall` sprawdzają obie dokładnie jednorodne domeny i centralny
rdzeń. Testy kompaktowego hopfionu sprawdzają $-\mathbf e_z$ na linii
centralnej torusa, dokładne $+\mathbf e_z$ na granicy i poza nośnikiem oraz
normę jeden dla wszystkich próbek.
Testy migracyjne sprawdzają brak wersji jako v1 oraz pełny round-trip.
Parity Rust–Python używa wspólnego zestawu co najmniej 1000 deterministycznych
punktów na preset i porównuje komponenty oraz klasę błędu.

Źródłowe testy nie kwalifikują GPU ani stabilności dynamicznej. Do tego potrzebne
są osobne managed/container runtime recipes i niezależne artefakty.

(limitations)=
## 11. Ograniczenia i odroczone prace

Nie zmieniamy energii ani dynamiki LLG. Nie promujemy presetów jako stanów
równowagowych. Binding Rust/Python jest zaimplementowany w fullmag-py-core;
czysty evaluator Python pozostaje tylko fallbackiem dla środowisk bez modułu
native i jest objęty tym samym fixture parity.

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. A. Hubert, R. Schäfer, Magnetic Domains, Springer, 1998,
   DOI: 10.1007/978-3-540-85054-0.
2. N. Papanicolaou, T. N. Tomaras, Dynamics of magnetic vortices,
   Nuclear Physics B 360 (1991), DOI: 10.1016/0550-3213(91)90410-Y.
3. A. Thiaville et al., Three-dimensional micromagnetic simulations of
   nanostructures, J. Magn. Magn. Mater. 182 (1998), DOI:
   10.1016/S0304-8853(97)01012-2.

(source-code-index)=
## 13. Indeks źródeł i dowodów

| Claim/equation | Path | Symbol | Test/evidence | Lane |
|---|---|---|---|---|
| plane coordinates | crates/fullmag-plan/src/magnetization_textures_v2.rs | metric_point | Rust v2 contract tests | FDM/FEM CPU/GPU |
| plane vector embedding | crates/fullmag-plan/src/magnetization_textures_v2.rs | metric_vector | Rust xz handedness test | FDM/FEM CPU/GPU |
| v1/v2 dispatch | crates/fullmag-plan/src/magnetization_textures_v2.rs | sample_preset_texture_versioned | IR migration tests | FDM/FEM |
| Python evaluator fallback | packages/fullmag-py/src/fullmag/init/preset_eval_v2.py | evaluate_preset_texture_v2 | Python contract tests and shared parity fixture | fallback only |
| PyO3 canonical bridge | crates/fullmag-py-core/src/lib.rs | sample_preset_texture_v2_json | PyO3 unit test and cargo check | managed Python runtime |
| Python native adapter | packages/fullmag-py/src/fullmag/_core.py | sample_preset_texture_v2 | Python runtime integration path | managed Python runtime |
| IR version default | crates/fullmag-ir/src/model.rs | default_preset_version | IR serde tests | all |
| Python authoring | packages/fullmag-py/src/fullmag/init/textures.py | class PresetTexture | Python round-trip tests | all |
| FDM sampling | crates/fullmag-plan/src/fdm.rs | materialize_initial_magnetization | planner tests | FDM |
| FEM sampling | crates/fullmag-plan/src/mesh.rs | materialize_initial_magnetization | planner tests | FEM |
| UI serialization | apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.ts | buildObjectMagneticTextureAssetDraft | Control Room tests | browser |
| vortex-wall profile | crates/fullmag-plan/src/magnetization_textures_v2.rs | vortex_wall | mumax_vortex_wall_has_domains_and_vortex_core | FDM/FEM CPU/GPU semantic sampling |
| compact-hopfion profile | crates/fullmag-plan/src/magnetization_textures_v2.rs | hopfion_compact_support | mumax_compact_hopfion_is_exactly_uniform_outside_support | FDM/FEM CPU/GPU semantic sampling |
| python-vortex-wall | packages/fullmag-py/src/fullmag/init/preset_eval_v2.py | _vortex_wall | test_mumax_vortex_wall_factory_and_profile | Python reference |
| python-compact-hopfion | packages/fullmag-py/src/fullmag/init/preset_eval_v2.py | _hopfion_compact_support | test_mumax_compact_hopfion_factory_and_support_boundary | Python reference |
| Python factory parity | packages/fullmag-py/src/fullmag/init/textures.py | texture.vortex_wall; texture.hopfion_compact_support | test_mumax3_texture_compatibility.py | authoring |
| UI Mumax3 coverage | apps/control-room/src/shared/domain/magnetization-texture/texturePresets.ts | MAGNETIZATION_TEXTURE_PRESETS | ObjectMagneticTexturePanelModel.mumax3.test.ts | browser |
