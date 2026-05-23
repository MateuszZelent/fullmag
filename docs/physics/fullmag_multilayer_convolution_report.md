
# Fullmag — raport wdrożeniowy dla FDM multi-layer convolution demag na CPU / CUDA

## Status dokumentu

To nie jest opis samej matematyki Borisa 1:1, tylko **rekomendacja wdrożeniowa dla Fullmaga**:
- jak to zaprojektować tak, żeby było **czytelne dla użytkownika**,
- jak to osadzić w **obecnej architekturze repo**,
- jak rozdzielić odpowiedzialności między:
  - Python API / klienta,
  - planner / `ProblemIR`,
  - mesh / voxelization / transfer,
  - CPU reference engine,
  - CUDA backend,
  - GUI / session API / artifacts.

Dokument jest pisany z perspektywy produktu i architektury. Celowo **nie kopiuje Borisa byt po bycie**. W kilku miejscach proponuję prostszy, bardziej fullmagowy wariant implementacji.

---

## 0. Najkrótsza rekomendacja

Najważniejsza rada jest taka:

> **Nie implementuj multi-layer convolution jako „ukrytej optymalizacji” wewnątrz obecnego `fm.Demag()` ani jako cienkiej kopii architektury Borisa.**
>
> Zrób z tego **jawny tryb planowania FDM demag**, z:
> - czytelnym kontraktem użytkownika,
> - wyraźnym preflightem / `explain`,
> - osobnym typem planu backendowego,
> - warstwową prezentacją w GUI,
> - i z **jednym wspólnym źródłem prawdy dla generatora kerneli** CPU + CUDA.

Drugie najważniejsze:

> **Nie buduj multi-layer convolution na obecnym operatorze demag w Fullmagu**, bo obecny FDM demag jest jeszcze prostą projekcją spektralną `H_k = -k (k·M_k)/|k|^2`, a nie dokładną splotową postacią tensora Newella.
>
> Najpierw trzeba ustabilizować **single-layer exact tensor demag**, a dopiero potem rozszerzyć go do shifted / irregular multilayer kernels.

Trzecie:

> **Nie pokazuj użytkownikowi terminów Borisa typu `n_common`, `KerType`, `inverse_shifted`, `transfer mesh` jako publicznego API.**
>
> Publicznie pokazuj:
> - `single_grid` albo `multilayer_convolution`,
> - `native layer grid`,
> - `common convolution grid`,
> - `transfer/resampling`,
> - `eligibility`,
> - `plan summary`.

To jest klucz do tego, żeby użycie było dużo prostsze niż w Borisie.

---

## 1. Diagnoza obecnego stanu Fullmaga

### 1.1. To, co w repo już jest bardzo dobre

Fullmag ma bardzo sensowny kierunek architektoniczny:

1. **Jedna powierzchnia autorska w Pythonie** opisująca problem fizyczny.
2. **IR / planner** jako jawne przejście z modelu użytkownika do planu backendowego.
3. **Control room / session API** jako osobna warstwa prezentacji.
4. **CPU reference + native backend** jako wymienne realizacje tego samego planu.

To jest idealne pod multi-layer convolution, bo ta funkcja **nie jest tylko zmianą kerneli** — to zmiana całego łańcucha:
- jak użytkownik deklaruje problem,
- jak planner rozpoznaje eligibility,
- jak budowane są siatki,
- jak backend przechowuje warstwy,
- jak GUI pokazuje pola i metadane.

### 1.2. To, co dziś blokuje czyste wdrożenie

W obecnym kodzie FDM wykonawczy path jest jeszcze znacznie węższy, niż sugeruje model publiczny.

Najważniejsze ograniczenia:

#### A. FDM executable path jest dziś w praktyce **single-grid / single-magnet**

Obecny planner i backend zakładają wąski przypadek:
- jeden geometry entry,
- jeden magnet,
- jedna siatka FDM,
- jedna instancja materiału,
- płaski plan.

To oznacza, że multi-layer convolution **nie da się dopisać jako drobnej rozbudowy** obecnych struktur.

#### B. Obecny FDM demag nie jest jeszcze exact Newell tensor convolution

To jest krytyczne architektonicznie.

Jeśli dziś wdrożysz multilayer shifted kernels obok obecnego demag operatora, dostaniesz dwa różne światy:
- single-grid mode: prosty operator spektralny,
- multilayer mode: exact/shifted/irregular tensor convolution.

To byłoby mylące:
- użytkownik miałby dwa tryby o **różnej fizyce**, nie tylko różnej wydajności,
- testowanie CPU/GPU stałoby się trudniejsze,
- dokumentacja byłaby nieczysta.

**Wniosek:** single-layer exact tensor demag powinien stać się **bazowym operatorem** dla FDM, a multilayer convolution ma być jego wielowarstwowym rozszerzeniem.

#### C. Brakuje jawnej semantyki placement / translation geometrii

W obecnym Python modelu geometrie są zasadniczo w lokalnym układzie odniesienia, a repo policy odsuwa translation/rotation.

To jest poważny problem, bo multilayer stack bez jawnego położenia warstw w `z` po prostu nie ma pełnej semantyki.

Dla SAF / spin-valve / multilayer stack potrzebujesz móc powiedzieć:
- ta warstwa jest od `z=0` do `z=t1`,
- spacer jest od `z=t1` do `z=t1+s`,
- druga warstwa jest od `z=t1+s` do `z=t1+s+t2`.

Bez tego planner nie wie:
- jaki jest `z-shift`,
- czy warstwy się stykają / nakładają,
- czy stos kwalifikuje się do `2d_stack`,
- jak policzyć bbox i common convolution grid.

#### D. GUI i session API są jeszcze mocno „single-grid minded”

Warstwa GUI jest już quantity-driven, co jest bardzo dobre, ale payloady i model live state nadal zakładają zwykle:
- jedno `grid = [nx, ny, nz]`,
- jeden zestaw pól na tym gridzie,
- ciężkie pola potrafią iść przez live stream.

Dla multilayer to się nie skaluje:
- każda warstwa ma własny native grid,
- pole `m` lub `H_demag` musi być **layer-scoped**,
- stream nie powinien pchać wszystkich warstw i pól non-stop.

### 1.3. Najważniejszy produktowy wniosek

Multi-layer convolution w Fullmagu nie jest „jednym featurem demag”.
To jest **spójny feature systemowy** obejmujący:

- publiczny kontrakt autora skryptu,
- planner i walidację,
- asset pipeline,
- runtime state model,
- artifacts,
- session API,
- control room.

To dobra wiadomość, bo właśnie dzięki tej architekturze da się zrobić to **czyściej niż w Borisie**.

---

## 2. Co w Twoim planie jest trafne, a co trzeba zmienić

## 2.1. Bardzo trafne elementy Twojego planu

Twój szkic dobrze łapie sedno Borisa:

- rozdział na **self-kernel** i **cross-layer shifted kernels**,
- osobny byt typu `DemagKernelCollection` dla kerneli per-layer,
- potrzeba **transferu** między native grid a convolution grid,
- `O(L²)` pairwise multiplications przy `L` warstwach,
- kernel reuse i `inverse_shifted`,
- osobny tryb `2D` dla thin-film stacków.

To wszystko jest dobrym fundamentem.

## 2.2. Co bym zmienił względem Twojego planu

### Zmiana 1: nie wprowadzaj `Layer` jako nowego obiektu fizycznego na starcie

W modelu użytkownika Fullmaga już istnieje `Ferromagnet`. To jest dobry publiczny byt fizyczny.

Rekomenduję:
- **nie robić od razu nowego top-level bytu `Layer`**,
- tylko traktować „layer” jako **pojęcie planistyczno-runtime'owe**:
  - warstwa = ferromagnet zakwalifikowany do multilayer demag group.

Czyli:
- użytkownik tworzy nadal `Ferromagnet`,
- planner rozpoznaje, że zestaw tych magnetów tworzy stos obsługiwalny przez `multilayer_convolution`,
- backend buduje `FdmLayerPlanIR` / `FdmLayerRuntime`.

To utrzymuje czysty publiczny model fizyki.

### Zmiana 2: nie eksponuj publicznie `n_common`

`n_common` jest dobrym pojęciem **wewnętrznym**, ale kiepskim pojęciem UX-owym.

Publicznie używaj:
- `common convolution grid`,
- `common_cells` / `common_cells_xy`,
- `mode="two_d_stack"` albo `mode="three_d"`.

To mówi użytkownikowi:
- co musi ustawić,
- kiedy planner umie dobrać to sam,
- co oznacza wynik.

`n_common` może nadal istnieć wewnętrznie jako nazwa w implementacji, ale nie jako główny byt publiczny.

### Zmiana 3: nie kopiuj 1:1 złożonych formatów przechowywania kerneli z Borisa w v1

Boris ma sporo komplikacji w storage:
- real/self,
- z-shifted,
- x-shifted,
- full complex,
- triki z symetrią i sign flips.

To ma sens wydajnościowo, ale jako **pierwsza implementacja w Fullmagu** bardzo podnosi złożoność kodu i ryzyko błędów.

Moja rekomendacja dla Fullmaga:

> **V1 internal representation powinna być prostsza niż w Borisie.**

Konkretnie:
- przechowuj kernel FFT-domain jako **jednolity kompleksowy tensor 6-składowy**
  - `xx, yy, zz, xy, xz, yz`,
- nawet dla self-kerneli pozwól, żeby imag część była po prostu zerowa,
- zrób jeden generyczny multiply path:
  - `H = K * M`,
  - dla każdego source/destination pair.

Dopiero później:
- dodaj fast path dla self real kernels,
- dodaj `inverse_shifted`,
- dodaj specjalne storage formats.

To da dużo czystszy kod i łatwiejszą weryfikację CPU/GPU.

### Zmiana 4: najpierw exact single-layer tensor demag, potem multilayer

To jest absolutnie kluczowe.

Nie rób kolejności:
1. obecny spectral projection,
2. multilayer shifted Newell.

Rób:
1. **single-layer exact tensor convolution**,
2. shared kernel builder,
3. multilayer shifted kernels,
4. irregular kernels,
5. optymalizacje.

Dzięki temu:
- 1-layer multilayer path redukuje się do tego samego operatora,
- masz spójny kontrakt fizyczny,
- CPU i CUDA testujesz wobec jednej prawdy.

### Zmiana 5: publicznie nazwij to jako **demag strategy**, nie jako „moduł warstw”

Użytkownik nie powinien musieć pytać:
- „czy mam użyć innego typu `Demag`?”
- „czy mam robić specjalne supermeshe?”
- „czy to działa tylko dla jakiegoś modułu?”

Rekomendowany publiczny model:
- `fm.Demag()` nadal oznacza fizykę,
- wybór algorytmu dzieje się w `DiscretizationHints.fdm.demag.strategy`.

Przykładowe strategie:
- `auto`
- `single_grid`
- `multilayer_convolution`

To jest czytelne i zgodne z tym, że Fullmag ma jedną warstwę opisu fizyki, a nie opis solvera w samych energy terms.

---

## 3. Zasady projektowe, których bym pilnował od początku

## 3.1. Zasada: fizyka i solver to dwie warstwy

`fm.Demag()` powinno nadal oznaczać:
- użytkownik chce dipolar/demagnetizing field.

Natomiast:
- `single_grid` vs `multilayer_convolution`
- `common convolution grid`
- transfer
- reuse
- CPU/GPU layout

to jest już warstwa solvera FDM.

To rozdzielenie utrzyma później spójność z:
- FEM,
- hybrid,
- capability matrix,
- docs/specs.

## 3.2. Zasada: explicit explainability > silent heuristics

Największy problem UX takich feature'ów to nie sama matematyka, tylko niejasność:
- kiedy to zadziała,
- dlaczego planner wybrał taki tryb,
- czemu coś nie jest eligible,
- gdzie następuje interpolacja,
- jaka siatka faktycznie jest używana.

Dlatego w Fullmagu powinny istnieć trzy poziomy jawności:

### Poziom 1 — publiczne API
Użytkownik deklaruje:
- native cells per magnet,
- demag strategy,
- opcjonalnie common convolution grid.

### Poziom 2 — plan summary
Przed uruchomieniem lub po zbudowaniu planu można łatwo zobaczyć:
- selected strategy,
- layer count,
- native grids,
- common convolution grid,
- transfer yes/no dla każdej warstwy,
- warnings / reasons.

### Poziom 3 — debug / developer views
Dla chętnych:
- pokazanie pomocniczych siatek roboczych,
- kernel reuse groups,
- estimated memory,
- pair schedule.

To jest o wiele lepsze niż „solver zrobił coś w środku i trzeba znać kod, żeby zrozumieć co”.

## 3.3. Zasada: `auto` nie może być magiczne

W szczególności:

> Jeżeli użytkownik ma wiele magnetów z różnymi cell sizes i prosi o FDM z demag, to `auto` nie powinno po cichu robić czegoś potencjalnie bardzo kosztownego lub nieoczywistego.

Moja rekomendacja:
- dla jednego magnetu: `auto` może spokojnie wybrać `single_grid`,
- dla wielu magnetów o różnych native cells:
  - jeśli multilayer jest eligible → wybierz `multilayer_convolution`,
  - jeśli nie jest eligible → **daj czytelny błąd / explain**, a nie cichy fallback do ogromnego single grid,
  - chyba że użytkownik jawnie ustawi `single_grid`.

To jest ważne, bo inaczej użytkownik nie będzie wiedział:
- czy dostał dokładny multilayer path,
- czy solver zrobił drogi supermesh,
- czy pola są liczone na wspólnej siatce,
- czy native resolution naprawdę działa.

## 3.4. Zasada: najpierw poprawność i kontrakt, potem fine-tuned optymalizacje

W takiej funkcji największe ryzyka są dwa:
1. semantyczne niejasności,
2. subtelne błędy numeryczne.

Dlatego kolejność powinna być:
1. czysty kontrakt publiczny,
2. exact single-layer demag,
3. clean multilayer plan/CPU path,
4. testy i cross-checki,
5. CUDA,
6. dopiero potem skomplikowane storage tricks.

---

## 4. Rekomendowany publiczny kontrakt użytkownika

To jest najważniejsza część z perspektywy „żeby nie było niejasności”.

## 4.1. Jak użytkownik ma o tym myśleć

Chciałbym, żeby użytkownik Fullmaga miał prosty model mentalny:

### Model 1 — `single_grid`
„Cały problem FDM jest liczony na jednej wspólnej siatce.”

Dobre gdy:
- jeden magnet,
- albo wiele magnetów i chcesz prostoty,
- albo wszystkie warstwy mają podobną skalę.

### Model 2 — `multilayer_convolution`
„Każdy magnet ma swój native FDM grid. Demag między warstwami jest liczony przez common convolution grid i transfer/resampling.”

Dobre gdy:
- masz stack warstw,
- różne warstwy potrzebują różnej rozdzielczości,
- nie chcesz marnować pamięci i FFT na supermesh.

To jest proste i wystarczająco intuicyjne.

## 4.2. Rekomendowane API w Pythonie

### 4.2.1. Zostaw `fm.Demag()` bez zmian

To jest ważne.

Nie rób:
```python
fm.MultiLayerDemag(...)
```

Rób nadal:
```python
fm.Demag()
```

a tryb wybieraj tutaj:
```python
fm.DiscretizationHints(
    fdm=fm.FDM(
        ...,
        demag=fm.FDMDemag(strategy="multilayer_convolution"),
    )
)
```

### 4.2.2. Dodaj placement geometrii

Bez tego użytkownik nie opisze wprost stosu warstw.

Rekomendowany minimalny publiczny dodatek:

```python
fm.Translate(geometry, by=(dx, dy, dz), name="...")
```

Przykład:
```python
free_geom = fm.Translate(
    fm.Box(size=(100e-9, 100e-9, 1e-9), name="free_base"),
    by=(0.0, 0.0, 0.5e-9),
    name="free_geom",
)

ref_geom = fm.Translate(
    fm.Box(size=(100e-9, 100e-9, 2e-9), name="ref_base"),
    by=(0.0, 0.0, 4.0e-9),
    name="ref_geom",
)
```

W przyszłości można rozszerzyć to do bardziej ogólnego `PlacedGeometry`, ale `Translate` wystarczy na pierwszy etap.

### 4.2.3. Dodaj per-magnet native FDM grid overrides

To jest centralny element UX.

Dzisiaj `DiscretizationHints.fdm` jest globalne. To nie wystarczy do multilayer.

Najczystszy wariant publiczny, bez mieszania solver hints bezpośrednio do `Ferromagnet`, to:

```python
fm.DiscretizationHints(
    fdm=fm.FDM(
        default_cell=(4e-9, 4e-9, 1e-9),
        per_magnet={
            "free": fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9)),
            "ref": fm.FDMGrid(cell=(4e-9, 4e-9, 1e-9)),
        },
        demag=fm.FDMDemag(
            strategy="multilayer_convolution",
            mode="two_d_stack",
            common_cells_xy=(512, 512),
        ),
    )
)
```

Dlaczego to jest lepsze niż `Ferromagnet(..., fdm_cell=...)`?

Bo:
- zachowuje `Ferromagnet` jako byt fizyczny,
- wszystkie solver hints są w jednym miejscu,
- łatwiej zrobić planner diagnostics,
- łatwiej serializować to do `ProblemIR`.

### 4.2.4. Rekomendowane nowe typy publiczne

#### `FDM`
Zamiast obecnego minimalistycznego:
```python
@dataclass(frozen=True, slots=True)
class FDM:
    cell: tuple[float, float, float]
```

proponuję ewolucję do czegoś w tym duchu:

```python
@dataclass(frozen=True, slots=True)
class FDMGrid:
    cell: tuple[float, float, float]

@dataclass(frozen=True, slots=True)
class FDMDemag:
    strategy: Literal["auto", "single_grid", "multilayer_convolution"] = "auto"
    mode: Literal["auto", "two_d_stack", "three_d"] = "auto"
    common_cells: tuple[int, int, int] | None = None
    common_cells_xy: tuple[int, int] | None = None
    allow_single_grid_fallback: bool = False
    explain: bool = True

@dataclass(frozen=True, slots=True)
class FDM:
    default_cell: tuple[float, float, float] | None = None
    per_magnet: dict[str, FDMGrid] | None = None
    demag: FDMDemag | None = None
```

Uwagi:
- `default_cell` może nadal obsłużyć stary prosty przypadek,
- `per_magnet` włącza native grids,
- `FDMDemag` zamyka całą politykę demag solvera,
- `allow_single_grid_fallback=False` domyślnie chroni przed magią.

### 4.2.5. Ergonomiczny helper opcjonalny: `LayerStack`

To nie powinien być fundament architektury, ale może być **bardzo dobrym ułatwieniem** dla użytkowników.

Przykład:

```python
stack = fm.LayerStack(
    name="saf_stack",
    size_xy=(100e-9, 100e-9),
    layers=[
        fm.StackLayer(
            name="free",
            thickness=1e-9,
            material=free_mat,
            m0=fm.uniform((1, 0, 0)),
            fdm_cell=(2e-9, 2e-9, 1e-9),
        ),
        fm.StackSpacer(name="ru", thickness=0.9e-9),
        fm.StackLayer(
            name="ref",
            thickness=2e-9,
            material=ref_mat,
            m0=fm.uniform((-1, 0, 0)),
            fdm_cell=(4e-9, 4e-9, 1e-9),
        ),
    ],
)
problem = stack.to_problem(
    energy=[fm.Exchange(), fm.Demag()],
    study=...,
)
```

Ale ważne:
- `LayerStack` powinien być tylko sugar,
- pod spodem ma generować zwykłe `Ferromagnet + Translate + DiscretizationHints`.

Wtedy podstawowa architektura pozostaje czysta.

---

## 5. Jak użytkownik ma rozumieć „kiedy można tego użyć”

To musi być super jawne. Tu właśnie Fullmag może być dużo lepszy od Borisa.

## 5.1. Publiczna macierz eligibility

W dokumentacji i w `explain()` trzeba podać wprost, że **publiczne v1** wspiera:

### Obsługiwane w v1
- backend: `fdm`,
- `fm.Demag()` obecne,
- co najmniej 2 ferromagnety lub 1 ferromagnet w trybie przyszłego rozwoju,
- geometrie axis-aligned,
- tylko translation, bez rotation,
- warstwy rozdzielone głównie w `z`,
- brak nakładania objętości warstw,
- thin-film `two_d_stack` jako pierwszy target,
- ewentualnie `three_d` jako późniejszy etap w tej samej architekturze,
- własne native FDM cell sizes per magnet.

### Nie wspierać publicznie w v1
- rotated geometries,
- ogólnych przesunięć i obrotów 3D, jeśli nie są dobrze przetestowane,
- cichych heurystyk dla niezgodnych footprintów,
- mieszania wielu niezależnych multilayer groups w jednym uruchomieniu bez jawnego wsparcia,
- ukrytej zmiany solvera z multilayer na supermesh,
- deklarowania „to działa dla dowolnych STL-i” bez sprawdzonego transfer/exchange contract.

## 5.2. `explain()` / `plan()` jako obowiązkowy UX feature

To jest moim zdaniem absolutny must-have.

Chciałbym mieć takie użycie:

```python
sim = fm.Simulation(problem, backend="fdm")
summary = sim.plan()
print(summary.render_text())
```

albo:

```python
fm.explain(problem, backend="fdm")
```

i dostać np. coś takiego:

```text
FDM demag planning summary
--------------------------
Requested demag strategy: multilayer_convolution
Selected demag strategy: multilayer_convolution
Eligibility: eligible
Mode: two_d_stack

Layers:
  - free : native grid = 512 x 512 x 1, cell = (2, 2, 1) nm
  - ref  : native grid = 256 x 256 x 1, cell = (4, 4, 1) nm

Common convolution grid:
  - cells = 512 x 512 x 1
  - transfer required:
      free: no
      ref : yes

Estimated demag kernel pairs: 4
Estimated unique kernels after reuse: 3
Estimated kernel memory (double): 144 MiB

Warnings:
  - none
```

A w przypadku błędu:

```text
FDM demag planning summary
--------------------------
Requested demag strategy: multilayer_convolution
Selected demag strategy: none
Eligibility: not eligible

Reasons:
  - layer "free" and layer "ref" have different XY extents
  - auto common convolution grid is disabled for mismatched extents

Next steps:
  - set demag.common_cells_xy=(...)
  - or switch to strategy="single_grid"
```

To rozwiązuje połowę problemu UX.

---

## 6. Konkretna rekomendacja dla Python API

Poniżej daję spójny wariant, który moim zdaniem najlepiej pasuje do Fullmaga.

## 6.1. Nowe typy / rozszerzenia

### Geometria
```python
fm.Translate(geometry, by=(dx, dy, dz), name="...")
```

### Solver hints
```python
fm.FDMGrid(cell=(...))

fm.FDMDemag(
    strategy="auto" | "single_grid" | "multilayer_convolution",
    mode="auto" | "two_d_stack" | "three_d",
    common_cells=(Nx, Ny, Nz) | None,
    common_cells_xy=(Nx, Ny) | None,
    allow_single_grid_fallback=False,
    explain=True,
)

fm.FDM(
    default_cell=(...) | None,
    per_magnet={"free": fm.FDMGrid(...), ...} | None,
    demag=fm.FDMDemag(...) | None,
)
```

## 6.2. Zachowanie `auto`

Rekomendowane reguły:

### Gdy jest 1 magnet
- `auto` → `single_grid`

### Gdy jest wiele magnetów i wszystkie mają ten sam native cell
- `auto` może wybrać `single_grid`
- ewentualnie `multilayer_convolution` też byłby poprawny, ale nie musi dawać zysku

### Gdy jest wiele magnetów i różne native cells
- jeśli problem jest eligible do multilayer → `auto` wybiera `multilayer_convolution`
- jeśli nie jest eligible:
  - gdy `allow_single_grid_fallback=False` → błąd z jasnym explain
  - gdy `allow_single_grid_fallback=True` → planner może przejść na `single_grid` i wyraźnie to raportuje

To jest bardzo czytelne.

## 6.3. Przykład rekomendowanego stylu skryptu

```python
import fullmag as fm

free_mat = fm.Material(name="free_mat", Ms=1.0e6, A=12e-12, alpha=0.02)
ref_mat  = fm.Material(name="ref_mat",  Ms=1.0e6, A=12e-12, alpha=0.02)

free_geom = fm.Translate(
    fm.Box(size=(120e-9, 120e-9, 1.0e-9), name="free_box"),
    by=(0.0, 0.0, 0.5e-9),
    name="free_geom",
)

ref_geom = fm.Translate(
    fm.Box(size=(120e-9, 120e-9, 2.0e-9), name="ref_box"),
    by=(0.0, 0.0, 4.0e-9),
    name="ref_geom",
)

free = fm.Ferromagnet(
    name="free",
    geometry=free_geom,
    material=free_mat,
    m0=fm.uniform((1, 0, 0)),
)

ref = fm.Ferromagnet(
    name="ref",
    geometry=ref_geom,
    material=ref_mat,
    m0=fm.uniform((-1, 0, 0)),
)

problem = fm.Problem(
    name="saf_relax",
    magnets=[free, ref],
    energy=[fm.Exchange(), fm.Demag()],
    study=fm.TimeEvolution(
        dynamics=fm.LLG(alpha=0.02, fixed_timestep=1e-13),
        outputs=[
            fm.SaveField("m", every_seconds=1e-12),
            fm.SaveField("H_demag", every_seconds=1e-12),
            fm.SaveScalar("E_total", every_seconds=1e-12),
        ],
    ),
    discretization=fm.DiscretizationHints(
        fdm=fm.FDM(
            default_cell=(4e-9, 4e-9, 1e-9),
            per_magnet={
                "free": fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9)),
                "ref":  fm.FDMGrid(cell=(4e-9, 4e-9, 1e-9)),
            },
            demag=fm.FDMDemag(
                strategy="multilayer_convolution",
                mode="two_d_stack",
                common_cells_xy=(512, 512),
            ),
        )
    ),
)

sim = fm.Simulation(problem, backend="fdm")
print(sim.plan().render_text())
sim.run(until=1e-9)
```

To jest dużo bardziej jednoznaczne niż „Boris-style magic”.

## 6.4. Co **nie** powinno być wymagane od użytkownika

Użytkownik nie powinien musieć:
- znać pojęcia `n_common`,
- wiedzieć, czym jest `KerType`,
- ustawiać `inverse_shifted`,
- ręcznie budować transfer mesh,
- ręcznie grupować source/destination layers,
- zgadywać, czy planner wybrał multilayer, czy single grid.

To wszystko ma być opisane przez:
- problem,
- discretization hints,
- explain summary.

---

## 7. Rekomendacja dla CLI / klienta / notebook workflow

## 7.1. Dodaj jawny tryb „plan without run”

W CLI lub Python helperach przyda się tryb:

```bash
fullmag plan script.py --backend fdm --explain
```

i wynik w stylu:
- selected backend,
- selected demag strategy,
- native grids,
- common convolution grid,
- estimated memory,
- warnings.

To jest ogromna pomoc dla usera i od razu odróżnia Fullmaga od „trzeba znać solver”.

## 7.2. Dodaj capability-oriented error messages

Błędy nie mogą brzmieć jak wewnętrzny solver panic. Powinny mówić:

### Zły styl
- `unsupported geometry kind`
- `invalid n_common`
- `kernel collection mismatch`

### Dobry styl
- `multilayer_convolution requires explicit translation/placement for each participating magnet`
- `multilayer_convolution(auto) is disabled for layers with different XY extents; set common_cells_xy explicitly`
- `layer "ref" overlaps with layer "free" in z; public v1 supports disjoint layers only`
- `native FDM cell for magnet "free" is missing; set fdm.per_magnet["free"] or default_cell`

To jest bardzo ważne dla adopcji.

---

## 8. Geometria, placement i mesh / voxelization

## 8.1. Placement to prerekwizyt, nie opcja

Bez jawnej translacji nie ma sensownej semantyki multilayer.

Rekomenduję:

### Python
```python
class Translate:
    base: Geometry
    by: tuple[float, float, float]
    name: str
```

### IR
zamiast komplikować wszystkie primitive kinds, dodaj wrapper:

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GeometryEntryIR {
    ImportedGeometry { ... },
    Box { ... },
    Cylinder { ... },
    Difference { ... },
    Translate {
        name: String,
        base: Box<GeometryEntryIR>,
        by: [f64; 3],
    },
}
```

To jest bardzo praktyczne, bo:
- działa dla każdego istniejącego kształtu,
- nie rozwala całego modelu,
- pozwala potem dodać `Rotate` bez przebudowy wszystkiego.

## 8.2. Jak liczyć bbox, origin i native grids

Dla każdej warstwy planner musi znać:
- `grid cells`,
- `cell_size`,
- `origin`,
- `bbox`,
- `active_mask`,
- oraz pozycję w globalnym układzie.

Wniosek:
- `FdmGridAssetIR` powinien nadal trzymać `origin`,
- ale `origin` musi już być rozumiane jako **global origin placed geometry**, a nie tylko lokalny start voxelizacji.

Jeżeli chcesz zachować reuse assetów:
- możesz voxelizować shape lokalnie,
- a potem doklejać translation w planie,
- ale plan wykonawczy musi finalnie znać **global origin** każdej warstwy.

## 8.3. Native grid asset vs convolution grid

To rozdzielenie trzeba wyraźnie nazwać.

Każda warstwa w multilayer mode ma dwa pojęcia siatki:

### Native layer grid
- siatka, na której żyje stan `m`,
- ta siatka jest używana do exchange,
- ta siatka jest pokazywana w GUI jako podstawowy view.

### Convolution grid
- siatka pośrednia używana tylko do demag convolution,
- wspólna liczba komórek (`common_cells`), ale per warstwa może mieć inny physical cell size przez różny bbox/extent,
- na tę siatkę przenosisz `m` i z niej wracasz z `H_demag`.

Publicznie lepiej mówić:
- `native grid`
- `common convolution grid`

niż:
- `mesh`
- `supermesh`
- `transfer mesh`

## 8.4. Transfer operator / resampler

Ja bym publicznie unikał terminu „transfer mesh”.
Lepiej:
- `transfer operator`
- `resampling`
- `native -> convolution`
- `convolution -> native`

### Rekomendowany kontrakt v1

#### `push_m`: native -> convolution
- celem jest zachowanie **średniej komórkowej / całkowitego momentu magnetycznego**,
- przy coarsening: volume-weighted average,
- przy refinement: piecewise-constant prolongation albo cell-average-preserving split.

#### `pull_h`: convolution -> native
- pole `H_demag` zwracaj na native grid,
- w v1 możesz użyć:
  - trilinear interpolation na centrach komórek,
  - albo dla `two_d_stack` bilinear w `xy` + piecewise w `z`.

To powinno być jawnie opisane w physics note.

### Ważna uwaga
Nie próbowałbym na starcie robić z transferu osobnego publicznego bytu konfiguracyjnego. To za wcześnie.
Wystarczy:
- dobrze udokumentowany domyślny transfer,
- ewentualnie debug summary: `transfer required = yes/no`.

## 8.5. Auto-selection common convolution grid

To jest miejsce, gdzie bardzo łatwo zrobić nieczytelną magię.

Moja rekomendacja:

### Dla `two_d_stack` auto działa tylko wtedy, gdy:
- wszystkie warstwy są axis-aligned,
- wszystkie mają wspólny lub jednoznacznie zgodny footprint w `xy`,
- można bez wątpliwości wyznaczyć wspólne `common_cells_xy`.

### Konserwatywna reguła auto:
- jeśli wszystkie warstwy mają ten sam `size_x` i `size_y`,
- ustaw:
  - `common_dx = min(native_dx_i)`
  - `common_dy = min(native_dy_i)`
  - `common_cells_x = round(size_x / common_dx)`
  - `common_cells_y = round(size_y / common_dy)`

Czyli convolution grid jest tak drobny jak najdrobniejsza warstwa.

### Jeżeli footprinty różnią się
- **nie zgaduj**,
- wymagaj `common_cells_xy=(...)`.

To jest dużo lepsze UX niż ukryte heurystyki.

---

## 9. ProblemIR i planner — jak to zmienić

## 9.1. Nie rozwlekaj multilayer jako kolejnej mutacji starego `FdmPlanIR`

Obecny `FdmPlanIR` jest płaski i single-grid.
Próba „dopisania kilku opcjonalnych pól” szybko zrobi z niego nieczytelny worek.

Rekomenduję:

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FdmPlanIR {
    UniformGrid(FdmUniformPlanIR),
    MultilayerConvolution(FdmMultilayerPlanIR),
}
```

To jest dużo czystsze.

## 9.2. Proponowany kształt `FdmMultilayerPlanIR`

Przykładowy szkic:

```rust
pub struct FdmMultilayerPlanIR {
    pub mode: FdmMultilayerModeIR, // two_d_stack | three_d
    pub common_cells: [u32; 3],
    pub layers: Vec<FdmLayerPlanIR>,
    pub enable_exchange: bool,
    pub enable_demag: bool,
    pub external_field: Option<[f64; 3]>,
    pub gyromagnetic_ratio: f64,
    pub precision: ExecutionPrecision,
    pub exchange_bc: ExchangeBoundaryCondition,
    pub integrator: IntegratorChoice,
    pub fixed_timestep: Option<f64>,
    pub planner_summary: FdmMultilayerSummaryIR,
}
```

### `FdmLayerPlanIR`
```rust
pub struct FdmLayerPlanIR {
    pub magnet_name: String,
    pub region_name: String,
    pub geometry_name: String,

    pub native_grid: GridDimensions,
    pub native_cell_size: [f64; 3],
    pub native_origin: [f64; 3],
    pub native_active_mask: Option<Vec<bool>>,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub material: FdmMaterialIR,

    pub convolution_grid: GridDimensions,
    pub convolution_cell_size: [f64; 3],
    pub convolution_origin: [f64; 3],

    pub transfer_kind: FdmTransferKindIR, // identity | resample
}
```

### `FdmMultilayerSummaryIR`
To nie jest konieczne do samego uruchomienia, ale bardzo pomaga w UI i explain:

```rust
pub struct FdmMultilayerSummaryIR {
    pub requested_strategy: String,
    pub selected_strategy: String,
    pub eligibility: String,
    pub estimated_pair_kernels: u32,
    pub estimated_unique_kernels: u32,
    pub estimated_kernel_bytes: u64,
    pub warnings: Vec<String>,
}
```

## 9.3. Per-magnet discretization w IR

W `ProblemIR` potrzebujesz wyrazić coś więcej niż jedno globalne `fdm.cell`.

Sugeruję ewolucję `FdmHintsIR` do czegoś w tym stylu:

```rust
pub struct FdmHintsIR {
    pub default_cell: Option<[f64; 3]>,
    pub per_magnet: BTreeMap<String, FdmGridHintsIR>,
    pub demag: Option<FdmDemagHintsIR>,
}

pub struct FdmGridHintsIR {
    pub cell: [f64; 3],
}

pub struct FdmDemagHintsIR {
    pub strategy: FdmDemagStrategyIR,   // auto | single_grid | multilayer_convolution
    pub mode: FdmMultilayerModeHintIR,  // auto | two_d_stack | three_d
    pub common_cells: Option<[u32; 3]>,
    pub common_cells_xy: Option<[u32; 2]>,
    pub allow_single_grid_fallback: bool,
}
```

To jest naturalne i czytelne.

## 9.4. Planner powinien mieć osobny etap: multilayer eligibility analysis

Planner nie powinien robić tego „przy okazji”.

Powinien istnieć jawny etap:

```text
analyze_fdm_demag_strategy(problem_ir) -> DemagPlanningDecision
```

który:
1. zbiera participating magnets,
2. sprawdza placement,
3. sprawdza native grid hints,
4. sprawdza overlap / separations,
5. ustala mode (`two_d_stack` / `three_d`),
6. dobiera albo waliduje `common_cells`,
7. szacuje koszty,
8. zwraca:
   - selected strategy,
   - summary,
   - albo czytelny error.

Dzięki temu później łatwo wystawić:
- `explain`,
- GUI plan summary,
- capability diagnostics.

## 9.5. Planner rules, które warto zapisać wprost

### Gdy `strategy="single_grid"`
- planner buduje wspólny grid dla wszystkich magnetów
- i wyraźnie raportuje, że native per-magnet cells nie są używane jako independent grids, tylko jako wskazówka lub że są niezgodne

### Gdy `strategy="multilayer_convolution"`
- planner **musi**:
  - znaleźć native grid dla każdego participating magnet,
  - wyznaczyć common convolution grid,
  - zbudować layer plan per magnet,
  - wypluć summary.

### Gdy `strategy="auto"`
- planner wybiera tylko spośród strategii, które są jawnie eligible,
- nie robi cichych degradacji bez wyraźnej zgody.

---

## 10. CPU reference engine — jak to zrefaktoryzować

## 10.1. Nie rozwijaj dalej `ExchangeLlgProblem` w obecnej postaci

Ta nazwa już dziś jest myląca, bo problem zawiera więcej niż exchange.
Przy multilayer stanie się jeszcze bardziej myląca.

Rekomendacja:
- wprowadź nowy byt, np.:
  - `FdmLlgProblem`
  - albo `FdmMicromagneticProblem`
- zostaw stary typ jako adapter lub zrób miękką migrację.

## 10.2. Proponowana struktura runtime

```rust
pub struct FdmLlgProblem {
    pub layers: Vec<FdmLayerRuntime>,
    pub demag: DemagOperatorRuntime,
    pub external_field: Option<[f64; 3]>,
    pub llg: LlgConfig,
}

pub struct FdmLayerRuntime {
    pub magnet_name: String,
    pub grid: GridShape,
    pub cell: CellSize,
    pub origin: [f64; 3],
    pub material: MaterialParameters,
    pub active_mask: Option<Vec<bool>>,
    pub m: Vec<Vector3>,
    pub h_ex: Vec<Vector3>,
    pub h_demag: Vec<Vector3>,
    pub h_eff: Vec<Vector3>,
    pub transfer: Option<TransferWorkspace>,
}
```

### `DemagOperatorRuntime`
```rust
pub enum DemagOperatorRuntime {
    None,
    UniformGrid(UniformGridDemagRuntime),
    MultilayerConvolution(MultilayerDemagRuntime),
}
```

To bardzo upraszcza logikę kroku czasowego:
1. policz exchange na native grid per layer,
2. policz demag przez operator demag,
3. dodaj field external,
4. wykonaj LLG update per layer.

## 10.3. Single-layer exact tensor demag jako pierwszy etap

Przed multilayer zrób ten byt:

```rust
pub struct TensorDemagKernel {
    pub grid: GridShape,
    pub cell: CellSize,
    pub fft_shape: FftShape,
    pub k_xx: Vec<Complex<f64>>,
    pub k_yy: Vec<Complex<f64>>,
    pub k_zz: Vec<Complex<f64>>,
    pub k_xy: Vec<Complex<f64>>,
    pub k_xz: Vec<Complex<f64>>,
    pub k_yz: Vec<Complex<f64>>,
}
```

Wtedy single-layer demag to po prostu:
- forward FFT `Mx, My, Mz`,
- tensor multiply,
- inverse FFT.

Multilayer jest tylko rozszerzeniem:
- masz wiele inputów,
- wiele kernel pairs,
- i output per destination layer.

## 10.4. Rekomendowana czysta abstrakcja multiply

Zamiast kopiować wiele wariantów typu `KernelMultiplication_3D_Self`, `..._zShifted`, `..._Complex_Full`, zacząłbym od jednej czystej operacji:

```rust
fn accumulate_tensor_convolution(
    dst_h_fft: &mut VectorFieldFft,
    src_m_fft: &VectorFieldFft,
    kernel_fft: &TensorKernelFft,
)
```

gdzie `TensorKernelFft` zawsze ma 6 complex arrays.

Dopiero później można dodać:
- fast path dla purely-real self kernel,
- special-case z symmetry.

To jest bardziej fullmagowe niż borisowe.

## 10.5. Shared kernel builder crate

To jest bardzo ważna rekomendacja.

Zamiast rozrzucać matematykę po:
- `fullmag-engine`,
- `native/backends/fdm`,
- i jeszcze może Python helpers,

zrób jeden wspólny moduł / crate, np.:

```text
crates/fullmag-demag-kernels
```

albo
```text
crates/fullmag-fdm-demag
```

Ten crate powinien mieć:
- Newell exact self kernels,
- shifted kernels,
- irregular kernels,
- transfer operator builder,
- reuse key logic,
- packing do FFT-domain,
- ewentualnie reference direct evaluation tests.

CPU reference i CUDA path powinny **korzystać z tego samego host-side generatora**.

To jest prawdopodobnie najważniejsza decyzja techniczna dla utrzymania spójności.

---

## 11. Multi-layer runtime model na CPU

## 11.1. Minimalny czysty algorytm v1

Dla `L` warstw:

### Setup
Dla każdej warstwy:
- native state `m_native[layer]`
- native exchange field `h_ex_native[layer]`
- convolution buffers `m_conv_fft[layer]`
- output conv buffer `h_conv_fft[layer]`
- transfer workspace, jeśli potrzebny

Dla całego operatora:
- `pair_kernel[layer_dst][layer_src]`
- reuse map / shared kernel bank
- wspólny FFT workspace shape (per convolution grid shape)

### Step
1. Dla każdego layer:
   - policz `H_ex` na native grid
   - `push_m` do convolution grid (albo identity)
   - forward FFT

2. Dla każdego destination layer:
   - wyzeruj output FFT
   - dla każdego source layer:
     - `H_fft_dst += K_fft(dst, src) * M_fft_src`

3. Dla każdego layer:
   - inverse FFT
   - `pull_h` z convolution grid do native grid
   - zsumuj z exchange i external
   - integrator LLG

To jest czytelne i zgodne z Twoim szkicem.

## 11.2. Single-layer powinien być specjalnym przypadkiem tego samego modelu

Dla `L=1`:
- jedna warstwa,
- jeden self-kernel,
- transfer zwykle identity.

To daje bardzo ważny test referencyjny:
- `multilayer_convolution` z jedną warstwą musi dawać ten sam wynik co exact single-layer tensor demag.

## 11.3. Transfer powinien być jawnie obecny w runtime, ale ukryty dla usera

Z punktu widzenia runtime dobrze mieć:

```rust
pub enum TransferWorkspace {
    Identity,
    Resample(ResampleWorkspace),
}
```

Ale użytkownik nie powinien tego konfigurować ręcznie.

---

## 12. CUDA backend i FFI — jak to ugryźć sensownie

## 12.1. Obecny płaski ABI jest za wąski

Obecny `fullmag_fdm_plan_desc` ma:
- jedną siatkę,
- jeden materiał,
- jedno pole startowe.

To nie wystarczy nawet koncepcyjnie.

Nie próbowałbym dopisywać tam dziesiątek opcjonalnych pól.

Rekomendacja:
- zrób **ABI v2** z rozróżnieniem:
  - `uniform_grid`
  - `multilayer_convolution`

## 12.2. Co powinno przejść przez ABI, a czego nie duplikować w CUDA

Najważniejsza decyzja:

> **Nie implementuj generatora shifted / irregular Newell kernels po stronie CUDA jako osobnej, równoległej logiki do Rust.**

Zdecydowanie lepiej:
- generować kernele host-side (Rust),
- uploadować gotowe FFT-domain kernels do native backendu,
- w CUDA wykonywać:
  - FFT,
  - multiply,
  - inverse FFT,
  - transfer,
  - integrację.

To daje:
- jedną matematykę,
- łatwiejszą walidację CPU/GPU,
- mniej powielonego kodu.

## 12.3. Proponowany model danych po stronie native backend

Po stronie CUDA potrzebujesz z grubsza:

### Per layer
- native grid desc,
- convolution grid desc,
- native `m`, `h_ex`, `h_demag`, `h_eff`,
- convolution buffers FFT,
- transfer descriptors / weights,
- active mask (jeśli wspierana w danym etapie),
- material params.

### Global
- kernel bank,
- pair map `dst,src -> kernel_index + transform flags`,
- layer scheduling,
- common stats,
- cuFFT plans.

## 12.4. Rekomendowany kształt ABI v2

Nie musi wyglądać dokładnie tak, ale kierunek powinien być taki:

```c
typedef enum {
    FULLMAG_FDM_PLAN_UNIFORM_GRID = 1,
    FULLMAG_FDM_PLAN_MULTILAYER_CONV = 2,
} fullmag_fdm_plan_kind;

typedef struct {
    uint32_t nx, ny, nz;
    double dx, dy, dz;
    double origin[3];
} fullmag_fdm_grid_desc_v2;

typedef struct {
    const char* magnet_name;
    fullmag_fdm_grid_desc_v2 native_grid;
    fullmag_fdm_grid_desc_v2 conv_grid;
    const uint8_t* active_mask;
    uint64_t active_mask_len;
    const double* m0_xyz;
    uint64_t m0_xyz_len;
    fullmag_fdm_material_desc material;
    uint32_t transfer_kind;
} fullmag_fdm_layer_desc_v2;

typedef struct {
    uint32_t layer_count;
    const fullmag_fdm_layer_desc_v2* layers;

    uint32_t kernel_count;
    const fullmag_fdm_tensor_kernel_desc_v2* kernels;

    const uint32_t* pair_kernel_index; // layer_count * layer_count
    const uint32_t* pair_flags;        // inverse/conjugate/sign transforms

    int enable_exchange;
    int enable_demag;
    int has_external_field;
    double external_field_am[3];
    ...
} fullmag_fdm_multilayer_plan_desc_v2;
```

Najważniejsza idea:
- host przygotowuje wszystko,
- native backend konsumuje gotowe, jawne deskryptory.

## 12.5. Pamięć GPU i estymacja kosztu

Tu trzeba być realistą.

Jeżeli przechowujesz pełne 6 kompleksowych składowych dla każdego kernel pair w double precision, pamięć rośnie szybko.

Przybliżenie:
- `bytes_per_kernel ≈ Nfft * 6 * sizeof(complex<double>)`
- czyli `≈ Nfft * 96 B`

Dla cienkich filmów to może być OK, ale przy większej liczbie warstw i dużych gridach trzeba:
- robić kernel reuse,
- raportować estimated memory w planner summary,
- ewentualnie strumieniować pair kernels,
- albo przejść później na bardziej skompresowane/hermitian representation.

To kolejny powód, żeby GUI i planner pokazywały **estimated kernel memory**.

## 12.6. Kolejność wdrożenia CUDA

Bardzo polecam taką kolejność:
1. host-side kernel generator,
2. CPU reference multilayer,
3. CUDA upload + generic multiply,
4. dopiero potem optymalizacje:
   - reuse z `inverse_shifted`,
   - real/self fast path,
   - R2C/Hermitian packing,
   - batched kernels / streams.

---

## 13. Kernel representation i reuse — jak uprościć Borisa po fullmagowemu

## 13.1. Nie portuj całej taksonomii storage Borisa w pierwszym kroku

To bym podkreślił bardzo mocno.

W Borisie storage jest silnie zoptymalizowane i przez to bardziej złożone niż trzeba na start Fullmaga.

### Lepszy wariant dla Fullmaga v1:
jedna spójna reprezentacja:

```rust
pub struct TensorKernelFft {
    pub shape: FftShape,
    pub xx: Vec<Complex<f64>>,
    pub yy: Vec<Complex<f64>>,
    pub zz: Vec<Complex<f64>>,
    pub xy: Vec<Complex<f64>>,
    pub xz: Vec<Complex<f64>>,
    pub yz: Vec<Complex<f64>>,
}
```

I to wystarczy dla:
- self,
- shifted,
- irregular.

Różnica jest tylko w generatorze kerneli, nie w runtime multiply API.

## 13.2. Reuse key

Dla wewnętrznego cache polecam coś w tym duchu:

```rust
struct KernelReuseKey {
    shift: [OrderedFloat<f64>; 3],
    src_cell: [OrderedFloat<f64>; 3],
    dst_cell: [OrderedFloat<f64>; 3],
    common_cells: [u32; 3],
    mode: MultilayerMode,
}
```

Uwagi:
- nie mieszaj publicznych nazw z wewnętrznym kluczem,
- `src_cell` i `dst_cell` muszą pozostać uporządkowane kierunkowo,
- znak `z-shift` może być później osobno reuse'owany jako optimization transform.

## 13.3. `inverse_shifted` jako późniejsza optymalizacja

Nie robiłbym tego w absolutnie pierwszym kroku.
Najpierw:
- exact match reuse,
- correctness.

Potem:
- sign / inverse z-shift reuse.

To ogranicza ryzyko pomyłki w sign conventions.

## 13.4. Irregular kernels

Irregular kernels (różne `dz_src`, `dz_dst`) są ważne i warto architektonicznie przewidzieć je od początku.

Ale publicznie nie robiłbym z nich osobnego trybu.
To powinien być po prostu detal:
- jeśli layer pair ma różne physical cell sizes convolution grids, planner/generator wybiera irregular kernel builder.

Użytkownik ma widzieć tylko:
- `multilayer_convolution`,
- ewentualnie w debug summary: `kernel type = shifted_irregular`.

---

## 14. Session API, artifacts i GUI

To jest miejsce, gdzie Fullmag może wygrać używalnością.

## 14.1. Najważniejsza zasada GUI

GUI nie może udawać, że wszystkie pola leżą na jednym gridzie.

W multilayer mode **pole wektorowe jest zawsze związane z konkretną warstwą**.
Czyli dla `m`, `H_ex`, `H_demag`, `H_eff` potrzebujesz:
- quantity selector,
- layer selector,
- component selector,
- 2D/3D view.

## 14.2. Zostaw quantity registry, dodaj layer registry

To jest zgodne z obecną filozofią quantity-driven UI.

### Quantity registry
dalej mówi:
- jakie pola istnieją,
- jaki mają unit,
- vector/scalar,
- cell-centered / node-centered,
- czy są available.

### Layer registry
powinien być nowym osobnym bytem:

```json
{
  "layers": [
    {
      "id": "free",
      "label": "free",
      "grid_cells": [512, 512, 1],
      "cell_size": [2e-9, 2e-9, 1e-9],
      "origin": [-60e-9, -60e-9, 0.0],
      "kind": "native_fdm_layer"
    },
    {
      "id": "ref",
      "label": "ref",
      "grid_cells": [256, 256, 2],
      "cell_size": [4e-9, 4e-9, 1e-9],
      "origin": [-60e-9, -60e-9, 3e-9],
      "kind": "native_fdm_layer"
    }
  ]
}
```

Wtedy:
- `quantity = H_demag`
- `layer = free`
- `component = magnitude`

i wszystko jest jasne.

## 14.3. Live stream nie powinien wysyłać ciężkich pól wszystkich warstw

Bardzo polecam trzymać się zasady:
- stream → tylko lifecycle, scalar stats, notices, summary, lightweight previews,
- heavy fields → fetch on demand.

W multilayer to jest wręcz konieczne.

### Co iść może w streamie
- step number,
- time,
- scalar energies,
- max fields,
- run status,
- selected strategy / summary,
- maybe low-res preview.

### Co nie powinno lecieć non-stop
- pełne `m` dla wszystkich warstw,
- pełne `H_demag` dla wszystkich warstw,
- pełne native i convolution debug fields.

## 14.4. Endpointy do pól

Przyda się coś w stylu:

```text
GET /v1/runs/{run_id}/fields/{quantity}?layer={layer_id}&step=latest
```

odpowiedź:
```json
{
  "quantity": "H_demag",
  "layer": "free",
  "layout": {
    "kind": "fdm_uniform_grid",
    "grid_cells": [512, 512, 1],
    "cell_size": [2e-9, 2e-9, 1e-9],
    "origin": [-60e-9, -60e-9, 0.0]
  },
  "values": [[...], [...], ...]
}
```

To jest dużo czytelniejsze niż jedna globalna `latest_fields.grid`.

## 14.5. Jak control room ma to pokazywać

### Górny summary panel
Powinien pokazywać:
- Backend: FDM
- Demag: multilayer convolution
- Mode: 2D stack
- Layers: 2
- Common convolution grid: 512 × 512 × 1
- Transfer: 1 / 2 layers

### Selektory
- Quantity
- Layer
- Component
- View mode (2D / 3D)

### Panel „Plan / Diagnostics”
- selected strategy,
- native grids,
- common convolution grid,
- estimated memory,
- warnings.

### Panel debug (opcjonalny)
- transfer required per layer,
- unique kernel count,
- kernel reuse,
- maybe „show convolution grid fields” dla dewelopera.

## 14.6. Jak zapisywać artifacts

Dla multilayer output `SaveField("m")` nie powinien być niejednoznaczny.

Rekomenduję manifest i osobne pliki per layer:

```text
artifacts/
  fields/
    m/
      manifest.json
      layer-free/
        step-000000123.npz
      layer-ref/
        step-000000123.npz
    H_demag/
      manifest.json
      layer-free/
        step-000000123.npz
      layer-ref/
        step-000000123.npz
```

`manifest.json` powinien opisywać:
- quantity,
- available layers,
- grid layout per layer,
- units,
- vector/scalar metadata.

To rozwiązuje problem wielowarstwowego pola bez hacków.

## 14.7. `SaveField` API

Na start można zachować prostotę:

```python
fm.SaveField("m", every_seconds=...)
```

a dla multilayer interpretować to jako:
- zapisz wszystkie layers dla tej quantity.

Później można dodać:
```python
fm.SaveField("m", every_seconds=..., layer="free")
```

ale nie robiłbym tego jako prerekwizytu dla v1.

---

## 15. Jak zakotwiczyć to w dokumentacji repo

Skoro Fullmag ma czytelną kulturę docs/specs, warto to wykorzystać.

## 15.1. Ten feature powinien skończyć się nie jednym, tylko kilkoma dokumentami

### A. Physics note
Nowy dokument w stylu:
```text
docs/physics/0530-fdm-multilayer-convolution-demag.md
```

Powinien opisywać:
- exact self demag tensor,
- shifted kernels,
- irregular kernels,
- transfer contract,
- 1-layer reduction,
- validation matrix.

### B. Specs update — Problem IR
`docs/specs/problem-ir-v0.md`
- placement / translation,
- per-magnet FDM hints,
- multilayer FDM plan kind.

### C. Specs update — capability matrix
`docs/specs/capability-matrix-v0.md`
- multilayer demag tylko dla FDM,
- v1 eligibility matrix.

### D. Specs update — visualization quantities
`docs/specs/visualization-quantities-v1.md`
- layer registry,
- field fetch per layer.

### E. Specs update — session / run API
`docs/specs/session-run-api-v1.md`
- fields on demand,
- layer-aware layouts,
- plan summary metadata.

### F. Specs update — geometry policy
`docs/specs/geometry-policy-v0.md`
- translation staje się częścią wspólnej semantyki geometrii.

### G. Plan document
Ten raport może żyć jako:
```text
docs/plans/active/fdm-multilayer-convolution-rollout.md
```

i potem rozbić się na physics/specs changes.

## 15.2. Popraw bibliografię już na etapie docs

W Twojej notce referencyjnej warto poprawić jedną rzecz:

- paper o multilayered convolution to **J. Appl. Phys. 126, 103903 (2019)**,
- natomiast paper o Borisie to **J. Appl. Phys. 128, 243902 (2020)**.

To drobiazg, ale warto od razu mieć czysto.

---

## 16. Rekomendowany zakres publicznego v1

To jest bardzo ważne, bo chroni przed „wszystko naraz”.

## 16.1. Co bym dowiózł jako v1

### Publiczny zakres v1
- translated axis-aligned box layers,
- `two_d_stack` thin-film mode,
- per-magnet native grid,
- exact self + shifted regular kernels,
- optional irregular `dz` if nie zaburza terminu,
- CPU reference path,
- explain / plan summary,
- GUI layer-aware field browsing,
- CUDA dopiero po poprawnej wersji CPU albo równolegle, ale z tym samym host-side kernel builderem.

## 16.2. Co może wejść jako v1.1 / v2

- `three_d` mode,
- cylinders / simple masked layers,
- imported voxel assets z pełnym supportem,
- irregular x/y extents z lepszym auto plannerem,
- `inverse_shifted` reuse,
- special kernel storage,
- R2C/Hermitian compression,
- multiple multilayer groups.

## 16.3. Czego nie obiecywać publicznie za wcześnie

Nie pisałbym w publicznym kontrakcie, że v1 wspiera:
- „arbitrary geometries”
- „any 3D stack”
- „all imported STL multilayers”
- „fully automatic best strategy in all cases”

Lepiej mieć węższy, bardzo czytelny kontrakt niż szeroki, ale nieprzewidywalny.

---

## 17. Proponowana ścieżka implementacji krok po kroku

Tu daję kolejność, którą naprawdę polecam.

## Faza 0 — przygotowanie kontraktu i docs
1. Ustalić publiczne nazwy:
   - `single_grid`
   - `multilayer_convolution`
   - `two_d_stack`
   - `three_d`
   - `common_cells`
   - `native grid`
   - `convolution grid`
2. Spisać physics/specs delta.
3. Dodać placement (`Translate`) do wspólnego modelu.

**Cel:** zanim powstanie solver, wiadomo już jak użytkownik ma tego używać.

## Faza 1 — planner and IR groundwork
1. Rozszerzyć Python model:
   - `Translate`
   - `FDMGrid`
   - `FDMDemag`
   - `FDM(default_cell, per_magnet, demag)`
2. Rozszerzyć `ProblemIR`.
3. Rozszerzyć planner:
   - eligibility analysis,
   - summary,
   - `FdmPlanIR::UniformGrid | MultilayerConvolution`.

**Cel:** można zbudować i obejrzeć plan, nawet zanim backend działa.

## Faza 2 — exact single-layer tensor demag on CPU
1. Wydzielić shared demag kernel crate.
2. Zaimplementować self Newell tensor FFT demag.
3. Zastąpić obecny spectral projection w CPU reference path.
4. Dodać testy zgodności i energy checks.

**Cel:** Fullmag ma już jeden spójny exact demag foundation.

## Faza 3 — multilayer CPU reference
1. Dodać transfer operator.
2. Dodać shifted kernels.
3. Dodać multilayer runtime:
   - layer runtimes,
   - pair kernel bank,
   - forward per layer,
   - pairwise multiply per dst,
   - inverse per layer.
4. Dodać explain summary z estimated memory.

**Cel:** pełna referencyjna implementacja multilayer na CPU.

## Faza 4 — CUDA ABI v2 + generic GPU path
1. Nowy ABI plan kind.
2. Upload host-generated kernels.
3. Per-layer FFT buffers.
4. Generic pairwise multiply kernel.
5. Field fetch per layer.

**Cel:** CUDA robi to samo co CPU, tylko szybciej.

## Faza 5 — session API / GUI / artifacts
1. Layer registry.
2. On-demand field fetch.
3. Plan summary panel.
4. Layer selector.
5. Artifact manifests per quantity/layer.

**Cel:** użytkownik widzi dokładnie, co solver robi.

## Faza 6 — optymalizacje
1. exact-match kernel reuse cache,
2. `inverse_shifted`,
3. self-kernel fast path,
4. Hermitian packing,
5. batched FFTs / streams,
6. advanced shapes.

---

## 18. Walidacja i testy, które naprawdę trzeba mieć

## 18.1. Testy kontraktu / planner

### Test 1
Dwa translated box magnets, różne cells, wspólny XY footprint:
- `strategy=multilayer_convolution`
- planner wybiera multilayer
- summary pokazuje correct layer/native/common grids

### Test 2
Brak placement:
- planner daje czytelny błąd

### Test 3
Różne XY extents bez `common_cells_xy`:
- planner odmawia auto
- proponuje next steps

### Test 4
`allow_single_grid_fallback=True`
- planner jawnie raportuje fallback

## 18.2. Testy numeryczne single-layer

### Test 5
1-layer multilayer == single-layer exact tensor demag

### Test 6
Self-kernel CPU vs direct-space reference dla małych gridów

### Test 7
CPU exact demag vs CUDA exact demag

## 18.3. Testy numeryczne multilayer

### Test 8
Dwie identyczne warstwy, symetryczne przesunięcie:
- `K(A<-B)` i `K(B<-A)` zgodne z oczekiwaną symetrią

### Test 9
Duży `z` gap:
- sprzężenie maleje prawidłowo

### Test 10
Różne thicknesses:
- irregular kernel daje sensowny wynik vs reference

### Test 11
Transfer identity:
- gdy native grid == convolution grid, `push/pull` nie zmienia pola poza błędem numerycznym

### Test 12
Wolniejsza dokładna referencja dla małych układów:
- bez FFT, bez reuse, bez optymalizacji
- porównanie dla 2-layer small case

## 18.4. Testy UX / artifact / GUI

### Test 13
Run manifest zawiera layer registry i plan summary

### Test 14
Field fetch dla `m`, `H_demag` z `layer=free` zwraca poprawny layout

### Test 15
Control room pokazuje layer selector tylko gdy `layers.len() > 1`

---

## 19. Szczególnie ważne ryzyka i jak ich uniknąć

## 19.1. Ryzyko: dwie różne definicje demag w zależności od trybu
**Jak uniknąć:** najpierw exact single-layer tensor demag.

## 19.2. Ryzyko: publiczne API przecieka detalami Borisa
**Jak uniknąć:** strategia i summary zamiast `n_common` / `KerType`.

## 19.3. Ryzyko: ciche fallbacki i brak wiedzy użytkownika
**Jak uniknąć:** `allow_single_grid_fallback=False` domyślnie, plus `explain`.

## 19.4. Ryzyko: GUI nadal traktuje wszystko jako jedną siatkę
**Jak uniknąć:** osobny layer registry i per-layer field fetch.

## 19.5. Ryzyko: kernel math rozjedzie się między CPU i CUDA
**Jak uniknąć:** jeden host-side kernel builder.

## 19.6. Ryzyko: za szeroki scope v1
**Jak uniknąć:** v1 = thin-film translated box stacks + clear eligibility matrix.

---

## 20. Konkretnie: czego bym **nie robił**

1. **Nie** chowałbym tego jako magicznego zachowania istniejącego `fm.Demag()` bez dodatkowych hints.
2. **Nie** wprowadzałbym `Layer` jako nowego obowiązkowego obiektu fizycznego, jeśli `Ferromagnet` już wystarcza.
3. **Nie** kopiowałbym 1:1 storage formats z Borisa w pierwszej implementacji.
4. **Nie** implementowałbym shifted/irregular kernel generatora niezależnie w Rust i CUDA.
5. **Nie** budowałbym multilayer path na obecnym spectral projection demag.
6. **Nie** puszczałbym pełnych pól wszystkich warstw przez live SSE/WS stream.
7. **Nie** pozwalałbym `auto` na cichy, niejawny supermesh fallback.
8. **Nie** obiecywałbym od razu „arbitrary imported geometry multilayers” bez silnej walidacji exchange/transfer/masks.

---

## 21. Moja rekomendacja „docelowego kształtu” feature'u

Jeśli miałbym to opisać jednym zdaniem:

> W Fullmagu multi-layer convolution powinno wyglądać dla użytkownika jak **jawny, objaśnialny tryb FDM demag dla stacków warstw**, a dla implementacji jak **osobny rodzaj FDM execution plan oparty na host-generated exact tensor kernels i per-layer runtime state**.

To jest spójne z repo, czytelne dla użytkownika i dużo prostsze w utrzymaniu niż bezpośrednie przenoszenie architektury Borisa.

---

## 22. Najbardziej konkretna propozycja wdrożenia na dziś

Gdybym miał Ci doradzić dokładnie „od czego zacząć jutro”, to zrobiłbym to tak:

### Krok 1
W Python modelu i IR dodaj:
- `Translate`
- `FDMGrid`
- `FDMDemag`
- `FDM(default_cell, per_magnet, demag)`

### Krok 2
W plannerze zaimplementuj samo:
- eligibility analysis,
- plan summary,
- `FdmPlanIR::MultilayerConvolution`

bez jeszcze działającego backendu.

### Krok 3
Wydziel crate z:
- self Newell tensor kernels,
- FFT-domain packing.

i **zamień obecny CPU demag na exact single-layer tensor demag**.

### Krok 4
Dopiero potem dodaj:
- shifted kernels,
- transfer,
- multilayer CPU runtime.

### Krok 5
Na końcu dołóż CUDA v2 jako wykonawcę tego samego planu.

To jest najbezpieczniejsza i najczystsza droga.

---

## 23. Minimalna lista plików / obszarów, które prawie na pewno trzeba ruszyć

Poniżej nie chodzi o literalną kompletną listę plików, tylko o najbardziej oczywiste miejsca.

### Python model
- `packages/fullmag-py/src/fullmag/model/geometry.py`
- `packages/fullmag-py/src/fullmag/model/discretization.py`
- `packages/fullmag-py/src/fullmag/model/problem.py`
- ewentualnie `packages/fullmag-py/src/fullmag/model/outputs.py` jeśli chcesz layer-filtered saves

### Meshing / assets
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- `packages/fullmag-py/src/fullmag/meshing/voxelization.py`

### IR
- `crates/fullmag-ir/src/lib.rs`

### Planner
- `crates/fullmag-plan/src/lib.rs`

### CPU engine
- `crates/fullmag-engine/src/lib.rs`
- plus nowy crate / moduł kernel builder

### Runner
- `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
- `crates/fullmag-runner/src/dispatch.rs`

### Native FDM ABI / CUDA
- `crates/fullmag-fdm-sys/src/lib.rs`
- `native/backends/fdm/include/...`
- `native/backends/fdm/src/...`

### GUI
- `apps/web/lib/useSessionStream.ts`
- `apps/web/components/runs/RunControlRoom.tsx`
- ewentualnie field fetch hooks / API clients

### Docs
- `docs/physics/...`
- `docs/specs/...`
- `docs/plans/...`

---

## 24. Finalna rekomendacja architektoniczna

Gdybym miał to zamknąć w jednej decyzji:

### Rekomendowany target design
- `fm.Demag()` pozostaje wspólnym termem fizycznym,
- `DiscretizationHints.fdm.demag.strategy` wybiera solver path,
- `Translate` daje jawny placement warstw,
- `per_magnet` daje native grids,
- planner ma osobny multilayer eligibility analysis i summary,
- `FdmPlanIR` rozdziela `uniform_grid` i `multilayer_convolution`,
- CPU i CUDA używają **jednego host-side generatora kerneli**,
- GUI jest layer-aware i on-demand, nie single-grid streaming.

### Najważniejsza korzyść
Użytkownik Fullmaga będzie rozumiał:
- kiedy może tego użyć,
- co musi ustawić,
- jaka strategia została wybrana,
- gdzie jest transfer,
- jakie siatki naprawdę biorą udział w obliczeniach.

I dokładnie o to Ci chodzi.

---

## 25. Dopisek bibliograficzny

Warto uporządkować odniesienia:

1. **Serban Lepadatu**,  
   *Efficient computation of demagnetizing fields for magnetic multilayers using multilayered convolution*,  
   **Journal of Applied Physics 126, 103903 (2019)**.

2. **Serban Lepadatu**,  
   *Boris computational spintronics—High performance multi-mesh magnetic and spin transport modeling software*,  
   **Journal of Applied Physics 128, 243902 (2020)**.

W praktyce:
- paper z 2019 daje Ci rdzeń algorytmu multilayered convolution,
- paper z 2020 opisuje, jak to jest użyte i osadzone w Borisie.

---

## 26. Jednozdaniowe podsumowanie dla Ciebie

**Rób to jako jawny, explainable, layer-aware tryb FDM demag z osobnym planem multilayer i wspólnym exact kernel builderem CPU/CUDA — nie jako ukrytą mutację obecnego single-grid demag.**
