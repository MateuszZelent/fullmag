# 0571 — Higher-order uniaxial ($K_{u2}$) and cubic ($K_{c1}, K_{c2}, K_{c3}$) magnetocrystalline anisotropy contract

- Status: accepted_contract_not_production_qualified
- Owners: Fullmag physics and runtime
- Last updated: 2026-11-22
- Related ADRs: docs/adr/0086-explicit-opt-in-material-physics-activation.md
- Related specs: docs/physics/fem_anisotropy_uniaxial.md, docs/physics/fem_anisotropy_cubic.md

(problem-statement)=
## 1. Dziedzina fizyczna

Anizotropia magnetokrystaliczna wyższego rzędu opisuje zależność gęstości energii
swobodnej od orientacji zredukowanej magnetyzacji $\mathbf m(\mathbf r)$ ($|\mathbf m|=1$)
względem wyróżnionej osi jednoosiowej $\mathbf u$ (np. heksagonalny Co w fazie hcp)
lub ortonormalnej triady krystalograficznej $\{\mathbf c_1,\mathbf c_2,\mathbf c_3\}$
(np. Fe bcc, Ni fcc). Kontrakt ujednolica konwencję znaku członu czwartego rzędu
$K_{u2}$ (konwencja cosinusowa), klasyfikację reżimów kątowych w UI oraz pełny
round-trip parametrów $K_{u1}, K_{u2}$ i $K_{c1}, K_{c2}, K_{c3}$ pomiędzy
Python DSL, `SceneDocument` i `ProblemIR`.

(governing-equations)=
## 2. Model fizyczny

### 2.1 Anizotropia jednoosiowa z członem $K_{u2}$ (konwencja cosinusowa)

Dla jednostkowej osi anizotropii $\mathbf u$ ($\|\mathbf u\|=1$) oraz
$c = \mathbf m\cdot\mathbf u = \cos\theta \in [-1, 1]$ Fullmag stosuje
konwencję cosinusową zgodną z `fem_anisotropy_uniaxial.md`:

```{math}
:label: uniaxial-ku2-energy

E_{\mathrm{uni}}[\mathbf m]
= \int_{\Omega} \left[-K_{u1}(\mathbf r)\,(\mathbf m\cdot\mathbf u)^2
- K_{u2}(\mathbf r)\,(\mathbf m\cdot\mathbf u)^4\right]\,\mathrm{d}V.
```

Odpowiadające jej lokalne pole efektywne $\mathbf H_{\mathrm{uni}} = -(\mu_0 M_s)^{-1}\delta E_{\mathrm{uni}}/\delta\mathbf m$ wynosi:

```{math}
:label: uniaxial-ku2-field

\mathbf H_{\mathrm{uni}}(\mathbf r)
= \frac{2 K_{u1}(\mathbf r)\,(\mathbf m\cdot\mathbf u)
+ 4 K_{u2}(\mathbf r)\,(\mathbf m\cdot\mathbf u)^3}{\mu_0 M_s(\mathbf r)}\,\mathbf u.
```

Klasyfikacja minimum gęstości energii $e(c^2) = -K_{u1} c^2 - K_{u2} c^4$ na
przedziale $c^2 \in [0, 1]$ wynika z pochodnych $\mathrm{d}e/\mathrm{d}(c^2) = -K_{u1} - 2 K_{u2} c^2$
oraz $\mathrm{d}^2 e/\mathrm{d}(c^2)^2 = -2 K_{u2}$:

```{math}
:label: uniaxial-ku2-cone-angle

K_{u2} < 0 \;\land\; 0 < -\frac{K_{u1}}{2 K_{u2}} < 1
\implies c_{\min}^2 = -\frac{K_{u1}}{2 K_{u2}},\qquad
\theta_c = \arccos\!\left(\sqrt{-\frac{K_{u1}}{2 K_{u2}}}\right).
```

Stożek łatwego namagnesowania (easy cone) istnieje wyłącznie dla $K_{u2} < 0$ i
$0 < K_{u1} < -2 K_{u2}$ (np. dla $K_{u1}=+1.0\times 10^5\,\mathrm{J\,m^{-3}}$,
$K_{u2}=-1.5\times 10^5\,\mathrm{J\,m^{-3}}$ otrzymujemy $c_{\min}^2 = 1/3$,
$\theta_c \approx 54.74^\circ$). Poza tym obszarem minimum leży na brzegu:
porównanie $e(0)=0$ z $e(1)=-(K_{u1}+K_{u2})$ daje łatwą oś ($\theta=0^\circ$)
gdy $K_{u1}+K_{u2} > 0$, oraz łatwą płaszczyznę ($\theta=90^\circ$) gdy
$K_{u1}+K_{u2} < 0$ (w szczególności dla $K_{u1}=-2.0\times 10^5\,\mathrm{J\,m^{-3}}$,
$K_{u2}=+1.5\times 10^5\,\mathrm{J\,m^{-3}}$ zachodzi $K_{u2}>0$ i
$K_{u1}+K_{u2}=-0.5\times 10^5 < 0$, co daje łatwą płaszczyznę, a nie stożek).

### 2.2 Anizotropia kubiczna ($K_{c1}, K_{c2}, K_{c3}$)

Dla prawoskrętnej bazy ortonormalnej $\{\mathbf c_1,\mathbf c_2,\mathbf c_3\}$
z $\mathbf c_3 = \mathbf c_1 \times \mathbf c_2$ oraz składowych kierunkowych
$m_i = \mathbf m\cdot\mathbf c_i$ ($i\in\{1,2,3\}$) i niezmiennika
$\sigma = m_1^2 m_2^2 + m_2^2 m_3^2 + m_3^2 m_1^2$ energia kubiczna wynosi:

```{math}
:label: cubic-anisotropy-energy

E_{\mathrm{cub}}[\mathbf m]
= \int_{\Omega} \left[K_{c1}\,\sigma
+ K_{c2}\,m_1^2 m_2^2 m_3^2
+ K_{c3}\,\sigma^2\right]\,\mathrm{d}V.
```

Pole efektywne w bazie krystalicznej wyraża się przez gradient względem $m_i$
przekształcony z powrotem do układu świata:

```{math}
:label: cubic-anisotropy-field

\mathbf H_{\mathrm{cub}}
= -\frac{1}{\mu_0 M_s}\sum_{i=1}^{3}
\frac{\partial e_{\mathrm{cub}}}{\partial m_i}\,\mathbf c_i.
```

(symbols-and-si-units)=
## 3. Symbole i jednostki SI

| Symbol | Znaczenie | Jednostka SI |
|---|---|---|
| $\mathbf m$ | zredukowany wektor magnetyzacji | $1$ |
| $\mathbf u$ | znormalizowana oś anizotropii jednoosiowej | $1$ |
| $K_{u1}$ | stała jednoosiowa drugiego rzędu | $\mathrm{J\,m^{-3}}$ |
| $K_{u2}$ | stała jednoosiowa czwartego rzędu | $\mathrm{J\,m^{-3}}$ |
| $\theta_c$ | kąt rozwarcia stożka łatwego namagnesowania | $\mathrm{rad}$ |
| $\mathbf c_1$ | pierwsza oś krystalograficzna bazy kubicznej | $1$ |
| $\mathbf c_2$ | druga oś krystalograficzna bazy kubicznej | $1$ |
| $\mathbf c_3$ | trzecia oś kubiczna $\mathbf c_1\times\mathbf c_2$ | $1$ |
| $\sigma$ | czwartorzędowy niezmiennik kubiczny | $1$ |
| $K_{c1}$ | pierwsza stała anizotropii kubicznej | $\mathrm{J\,m^{-3}}$ |
| $K_{c2}$ | druga stała anizotropii kubicznej | $\mathrm{J\,m^{-3}}$ |
| $K_{c3}$ | trzecia stała anizotropii kubicznej | $\mathrm{J\,m^{-3}}$ |
| $M_s$ | namagnesowanie nasycenia | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | przenikalność magnetyczna próżni | $\mathrm{H\,m^{-1}}$ |
| $E_{\mathrm{uni}}$ | całkowita energia anizotropii jednoosiowej | $\mathrm{J}$ |
| $E_{\mathrm{cub}}$ | całkowita energia anizotropii kubicznej | $\mathrm{J}$ |
| $\mathbf H_{\mathrm{uni}}$ | pole efektywne anizotropii jednoosiowej | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{cub}}$ | pole efektywne anizotropii kubicznej | $\mathrm{A\,m^{-1}}$ |

(assumptions-and-validity)=
## 4. Założenia i granice ważności

Obie interakcje są czysto lokalne (algebraiczne funkcje $\mathbf m(\mathbf r)$
bez pochodnych przestrzennych) i nie nakładają dodatkowych naturalnych warunków
brzegowych. Przekształcenie ze stałej konwencji sinusowej
$\tilde K_{u1}\sin^2\theta + \tilde K_{u2}\sin^4\theta$ do kanonicznej konwencji
cosinusowej Fullmaga dane jest przez $K_{u1} = \tilde K_{u1} + 2\tilde K_{u2}$
oraz $K_{u2} = -\tilde K_{u2}$ (z dokładnością do stałej addytywnej energii).
Osie $\mathbf c_1,\mathbf c_2$ muszą być skończone, niezerowe i wzajemnie
ortogonalne ($|\hat{\mathbf c}_1\cdot\hat{\mathbf c}_2| \le 10^{-6}$ w walidacji
`SceneDocument`); nieortogonalne wejścia są odrzucane bez cichej ortogonalizacji.

(python-api)=
## 5. Python API

Parametry jednoosiowe i kubiczne przypisuje się na uchwycie obiektu w stage-first
API `fm.study(...)` lub na obiekcie `fm.Material`:

```python
# %%
import fullmag as fm

study = fm.study("hcp_co_and_cubic_fe")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(100e-9, 100e-9, 10e-9))
study.cell(5e-9, 5e-9, 5e-9)

film = study.geometry(fm.Box(size=(100e-9, 100e-9, 10e-9), name="film"), name="film")
film.Ms = 1.44e6
film.Aex = 3.0e-11
film.alpha = 0.01
film.Ku1 = 1.0e5
film.Ku2 = -1.5e5
film.anisU = (0.0, 0.0, 1.0)
film.Kc1 = 4.8e4
film.Kc2 = 5.0e3
film.Kc3 = 0.0
film.anisC1 = (1.0, 0.0, 0.0)
film.anisC2 = (0.0, 1.0, 0.0)
film.m = fm.texture.uniform(1.0, 0.0, 1.0)

study.exchange()
study.demag()
study.stages.add_relax(stage_id="relax", dt=1e-13, max_steps=200)
```

### 5.1 Tabela parametrów publicznych

| Python | Typ | Domyślna | Jednostka SI | Walidacja | Znaczenie | Obsługa backendu | ProblemIR |
|---|---|---|---|---|---|---|---|
| Material.Ku1 | float | 0.0 | $\mathrm{J\,m^{-3}}$ | finite real | stała jednoosiowa drugiego rzędu | FDM CPU/GPU, FEM CPU/GPU | magnets[].material.uniaxial_anisotropy_k1 |
| Material.Ku2 | float | 0.0 | $\mathrm{J\,m^{-3}}$ | finite real | stała jednoosiowa czwartego rzędu | FDM CPU/GPU, FEM CPU | magnets[].material.uniaxial_anisotropy_k2 |
| Material.anisU | tuple[float, float, float] | (0.0, 0.0, 1.0) | $1$ | finite, nonzero 3-vector | oś anizotropii jednoosiowej | FDM CPU/GPU, FEM CPU/GPU | magnets[].material.anisotropy_axis |
| CubicAnisotropy.kc1 | float | 0.0 | $\mathrm{J\,m^{-3}}$ | finite real | pierwsza stała anizotropii kubicznej | FDM CPU/GPU, FEM CPU | energy[kind=cubic_anisotropy].kc1 |
| CubicAnisotropy.kc2 | float | 0.0 | $\mathrm{J\,m^{-3}}$ | finite real | druga stała anizotropii kubicznej | FDM CPU/GPU, FEM CPU | energy[kind=cubic_anisotropy].kc2 |
| CubicAnisotropy.kc3 | float | 0.0 | $\mathrm{J\,m^{-3}}$ | finite real | trzecia stała anizotropii kubicznej | FEM CPU; FDM rejects nonzero kc3 if unsupported | energy[kind=cubic_anisotropy].kc3 |
| CubicAnisotropy.axis1 | tuple[float, float, float] | (1.0, 0.0, 0.0) | $1$ | finite, nonzero, orthogonal to axis2 | pierwsza oś kubiczna | FDM CPU/GPU, FEM CPU | energy[kind=cubic_anisotropy].axis1 |
| CubicAnisotropy.axis2 | tuple[float, float, float] | (0.0, 1.0, 0.0) | $1$ | finite, nonzero, orthogonal to axis1 | druga oś kubiczna | FDM CPU/GPU, FEM CPU | energy[kind=cubic_anisotropy].axis2 |

(problem-ir)=
## 6. ProblemIR i lowering

W `ProblemIR` parametry materiału i człony energetyczne są serializowane jawnie:

```json
{
  "material": {
    "saturation_magnetization": 1440000.0,
    "exchange_stiffness": 3e-11,
    "damping": 0.01,
    "uniaxial_anisotropy_k1": 100000.0,
    "uniaxial_anisotropy_k2": -150000.0,
    "anisotropy_axis": [0.0, 0.0, 1.0]
  },
  "energy_term": {
    "kind": "cubic_anisotropy",
    "kc1": 48000.0,
    "kc2": 5000.0,
    "kc3": 0.0,
    "axis1": [1.0, 0.0, 0.0],
    "axis2": [0.0, 1.0, 0.0]
  }
}
```

W `SceneDocument` wpis `physics_stack` typu `uniaxial_anisotropy` przechowuje
`ku1`, `ku2` i `axis` (aktywowany również wtedy, gdy $K_{u1}=0$ i $K_{u2}\neq 0$),
natomiast `cubic_anisotropy` przechowuje `kc1`, `kc2`, `kc3`, `axis1`, `axis2`.

(round-trip-and-failure-semantics)=
## 7. Round-trip, runtime i błędy

Requested intent (zadane `Ku1`, `Ku2`, `anisU`, `kc1`, `kc2`, `kc3`, `axis1`,
`axis2` oraz wybrany silnik/urządzenie) jest zachowywany bez strat podczas
konwersji Python $\leftrightarrow$ `SceneDocument` $\leftrightarrow$ kanoniczny
skrypt Python. Resolved execution zapisuje zrealizowany solver, urządzenie i
precyzję w planie wykonania. Validation errors (niefinityczne stałe, zerowe osie,
nieortogonalne `axis1`/`axis2`) są odrzucane przed uruchomieniem solvera, a
unsupported combinations (np. nieobsługiwany człon w wybranej realizacji GPU)
zwracają jawny błąd capability bez cichego pominięcia energii lub degradacji do CPU.

(discrete-realization)=
## 8. Realizacja dyskretna

### 8.1 FDM

FDM oblicza lokalne pole $\mathbf H_{\mathrm{uni}}$ i $\mathbf H_{\mathrm{cub}}$
w środkach aktywnych komórek siatki kartezjańskiej; komórki próżniowe ($M_s=0$)
otrzymują zerowy wkład.

### 8.2 FEM

FEM oblicza wkład węzłowy na węzłach P1 z wagami macierzy masowej skupionej
(zgodnie z `fem_anisotropy_uniaxial.md` oraz `fem_anisotropy_cubic.md`), pomijając
węzły niemagnetyczne (np. airbox).

### 8.3 Support matrix

| Solver | Device | Semantyka | Status |
|---|---|---|---|
| FDM | CPU | cell-center local field and energy | source and round-trip test evidence |
| FDM | GPU | cell-center kernel parity contract | runtime qualification separate |
| FEM | CPU | P1 nodal lumped-weight field and energy | native contract test evidence |
| FEM | GPU | P1 nodal anisotropy realization | not runtime-qualified here |

(implementation-mapping)=
## 9. Mapa implementacji

- Python material model: `packages/fullmag-py/src/fullmag/model/structure.py` (`class Material`).
- Python energy terms: `packages/fullmag-py/src/fullmag/model/energy.py` (`class UniaxialAnisotropy`, `class CubicAnisotropy`).
- SceneDocument round-trip: `packages/fullmag-py/src/fullmag/runtime/scene_document.py` (`build_builder_from_scene_document`).
- IR structures: `crates/fullmag-ir/src/model.rs` (`MaterialIR`), `crates/fullmag-ir/src/study.rs` (`EnergyTermIR`).
- UI regime classifier: `apps/control-room/src/modules/inspector/inspectors/objects/material/materialShared.ts` (`function classifyUniaxialAnisotropyRegime`).

(validation)=
## 10. Walidacja

Testy jednostkowe `test_uniaxial_ku2_and_cubic_roundtrip.py` weryfikują pełny
round-trip `Ku1`, `Ku2`, `anisU` (w tym przypadek $K_{u1}=0, K_{u2}\neq 0$) oraz
`Kc1`, `Kc2`, `Kc3`, `axis1`, `axis2`, jak również odrzucanie nieortogonalnych
osi kubicznych. Testy DOM inspektora materiału weryfikują analityczną klasyfikację
cosinusową stożka łatwego namagnesowania ($\theta_c \approx 54.7^\circ$ dla
$K_{u1}=10^5, K_{u2}=-1.5\times 10^5$) oraz łatwej płaszczyzny dla $K_{u1}=-2\times 10^5, K_{u2}=+1.5\times 10^5$.

(limitations)=
## 11. Ograniczenia i odroczone prace

Niniejsza nota definiuje kontrakt znaków, walidacji osi i round-tripu autorskiego;
kwalifikacja GPU oraz wieloregionowa zmienność przestrzenna osi kubicznych
pozostają objęte osobnymi bramkami wykonawczymi.

(scientific-bibliography)=
## 12. Bibliografia naukowa

1. A. Hubert, R. Schäfer, *Magnetic Domains*, Springer, 1998, DOI: 10.1007/978-3-540-85054-0.
2. J. M. D. Coey, *Magnetism and Magnetic Materials*, Cambridge University Press, 2010, DOI: 10.1017/CBO9780511845000.
3. A. Vansteenkiste et al., *The design and verification of MuMax3*, AIP Advances 4, 107133 (2014), DOI: 10.1063/1.4899186.

(source-code-index)=
## 13. Indeks źródeł i dowodów

| Claim/equation | Path | Symbol | Test/evidence | Lane |
|---|---|---|---|---|
| Python material Ku1/Ku2/Kc fields | packages/fullmag-py/src/fullmag/model/structure.py | class Material | test_uniaxial_ku2_and_cubic_roundtrip.py | all |
| Python uniaxial energy descriptor | packages/fullmag-py/src/fullmag/model/energy.py | class UniaxialAnisotropy | test_uniaxial_ku2_and_cubic_roundtrip.py | all |
| Python cubic energy descriptor | packages/fullmag-py/src/fullmag/model/energy.py | class CubicAnisotropy | test_uniaxial_ku2_and_cubic_roundtrip.py | all |
| SceneDocument anisotropy validation | packages/fullmag-py/src/fullmag/runtime/scene_document.py | build_builder_from_scene_document | test_cubic_anisotropy_rejects_non_orthogonal_axes_in_scene | authoring |
| Rust MaterialIR anisotropy fields | crates/fullmag-ir/src/model.rs | MaterialIR | IR serialization contract | FDM/FEM |
| Rust EnergyTermIR variants | crates/fullmag-ir/src/study.rs | EnergyTermIR | IR serialization contract | FDM/FEM |
| Control Room Ku2 cone classifier | apps/control-room/src/modules/inspector/inspectors/objects/material/materialShared.ts | function classifyUniaxialAnisotropyRegime | ObjectMaterialSpec.dom.test.tsx | browser |
