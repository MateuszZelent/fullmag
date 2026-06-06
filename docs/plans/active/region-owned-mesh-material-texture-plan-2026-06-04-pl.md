# Plan region-owned mesh/material/texture - wersja polska po audycie Mumax+ i Tetrax

Ten dokument jest polską, merytorycznie uściśloną wersją planu
`region-owned-mesh-material-texture-plan-2026-06-04.md`.

Główna korekta po audycie: **region nie może być jedynym mechanizmem zmiany parametrów**. Trzeba rozdzielić:

1. region jako nazwany selektor przestrzenny,
2. pole parametru materiałowego, np. `Ms(x)` albo `Aex(x)`,
3. sprzężenie na interfejsie region-region lub obiekt-obiekt,
4. politykę zagęszczania siatki,
5. politykę warunku początkowego/tekstury.

Jeżeli te pojęcia zostaną zmieszane, UI będzie wyglądać dobrze, ale fizyka materiałów i granic będzie niejawna.

Najważniejszy model mentalny:

- **Dwa różne materiały z ostrą granicą** powinny być dwoma obiektami
  materiałowymi albo dwoma jawnymi domenami materiałowymi. Mogą być styczne,
  rozdzielone spacerem albo sprzężone przez osobną regułę interfejsową.
- **Jeden ciągły materiał** pozostaje jednym obiektem i jednym właścicielem
  pola magnetyzacji `m`, nawet jeżeli wewnątrz ma regiony, lokalne mesh policy,
  lokalne warunki początkowe albo zmienne parametry materiałowe.
- **Gradient materiałowy**, np. `Ms(x)` albo `Aex(x)`, jest polem
  współczynnika materiałowego, nie zbiorem ukrytych mini-regionów.
- **Skok parametrów wewnątrz jednego obiektu** jest fizycznie ostrą granicą
  materiałową. W FEM wymaga konforemnej granicy/domain markerów albo jawnie
  wybranego trybu projekcji z diagnostyką.
- **RKKY/contact/interlayer exchange** jest osobną interakcją powierzchniową
  albo interfejsową, nie zwykłym nadpisaniem `Aex` po obu stronach.

---

## Audyt Mumax+

### Pliki źródłowe

- `external_solvers/plus/mumaxplus/ferromagnet.py`
  - `Ferromagnet(..., regions=None)` przyjmuje regiony jako tablicę/callable indeksującą każdą komórkę do regionu.
  - Linie 39-50 opisują, że wartości `InterParameter` skalują się z kwadratem maksymalnego indeksu regionu.
  - Linie 261-309 definiują `inter_exchange` i `scale_exchange`.
- `external_solvers/plus/mumaxplus/magnet.py`
  - `_get_mask_array(...)` zamienia `geometry` i `regions` na tablice o rozmiarze siatki.
- `external_solvers/plus/mumaxplus/parameter.py`
  - Linie 150-195: parametr może być uniform, tablicą albo funkcją przestrzenną.
  - Linie 197-240: `set_in_region(region_idx, value)` ustawia parametr tylko na masce regionu.
- `external_solvers/plus/mumaxplus/variable.py`
  - `set_in_region(...)` działa też dla zmiennych, np. magnetyzacji.
- `external_solvers/plus/mumaxplus/interparameter.py`
  - Pythonowy wrapper dla parametrów między regionami.
- `external_solvers/plus/src/core/system.cpp`
  - Linie 15-35: `regions` to `GpuBuffer<unsigned int>` o rozmiarze siatki; system buduje listę unikalnych indeksów.
- `external_solvers/plus/src/core/inter_parameter.cu`
  - Linie 15-20: liczba wartości międzyregionowych to `N * (N - 1) / 2`, gdzie `N = max(region_idx) + 1`.
  - Linie 45-63: `setBetween(i, j, value)` aktualizuje jedną parę regionów.
- `external_solvers/plus/src/physics/exchange.cu`
  - Linie 81-87: kernel sprawdza indeksy regionów sąsiednich komórek.
  - Linie 99-103: pole exchange używa współczynnika `Aex` i dzieli wynik przez lokalne `Msat`.
- `external_solvers/plus/src/physics/dmi.hpp`
  - Linie 73-75: `getExchangeStiffness(inter, scale, a, a_)` używa `inter`, jeżeli podany; w przeciwnym razie używa średniej harmonicznej `Aex` sąsiadów i mnoży przez `scale`.
- `external_solvers/plus/docs/tutorial/regions.rst`
  - Dokumentacja użytkownika pokazuje `regions`, `set_in_region`, `inter_exchange` i `scale_exchange`.

### Model Mumax+

Mumax+ ma trzy poziomy:

1. **Geometria**: maska komórek, które należą do magnetyka.
2. **Regiony**: indeks całkowity przypisany do każdej komórki.
3. **Parametry**:
   - uniform,
   - pełne pole komórkowe,
   - funkcja przestrzenna,
   - wartość w regionie.

Region w Mumax+ nie jest geometrią CAD. To szybki indeks komórkowy. Działa dobrze dla FDM, bo sąsiedztwo jest lokalne i regularne.

### Exchange między regionami

Domyślna reguła Mumax+:

- jeżeli sąsiednie komórki mają ten sam region, używa lokalnych `Aex`,
- jeżeli regiony są różne:
  - pobiera `inter_exchange(region_i, region_j)`,
  - pobiera `scale_exchange(region_i, region_j)`,
  - jeżeli `inter_exchange == 0`, używa średniej harmonicznej `Aex_i` i `Aex_j`,
  - wynik mnoży przez `scale_exchange`.

Wniosek: **brak jawnego `inter_exchange` nie oznacza braku sprzężenia**. Oznacza domyślne sprzężenie przez średnią harmoniczną. Brak exchange wymaga `scale_exchange.set_between(i, j, 0)`.

### Wnioski dla Fullmag

- Dla FDM warto przejąć semantykę domyślną:
  `A_interface = harmonic_mean(A_i, A_j) * exchange_scale(i, j)`, chyba że użytkownik poda jawny `inter_exchange`.
- Regiony o indeksach typu `1` i `500` są złe jako publiczny model, bo koszt `InterParameter` zależy od maksymalnego indeksu. Fullmag powinien używać stabilnych `region_id`, a solver powinien kompresować je do gęstych indeksów `0..N-1`.
- Smooth gradient `Ms(x)` nie powinien być modelowany tysiącem regionów. Mumax+ samo dopuszcza parametr jako funkcję/tablicę, więc region nie jest jedynym mechanizmem.
- `set_in_region` to wygodna maska, nie pełny model materiałowy.

---

## Audyt Tetrax

### Pliki źródłowe

- `external_solvers/tetrax/tetrax/sample/material/standards.py`
  - Linie 10-32: `Msat` i `Aex` są scalar material parameters, `is_global=False`, czyli mogą być przestrzennie niejednorodne.
- `external_solvers/tetrax/tetrax/sample/material/parameter.py`
  - `MaterialParameter` zarządza metadanymi, constraintami, setterami i średnią.
  - `_default_scalar_setter(...)` zamienia skalar na `MeshScalar` o długości `mesh.nx` albo przyjmuje tablicę o tej długości.
- `external_solvers/tetrax/tetrax/sample/material/material.py`
  - `SampleMaterial` jest słownikiem parametrów i wywołuje update interakcji zależnych od zmienionych parametrów.
- `external_solvers/tetrax/doc/usage/sample.rst`
  - Linie 295-378: dokumentacja pokazuje, że `Msat` i `Aex` mogą być `MeshScalar`, a gradient `Msat` może być zapisany jako `Mavrg + dMdy * sample.xyz.y`.
  - Linie 353-368 podkreślają, że `mag` pozostaje jednostkowym kierunkiem `m`, a pełna magnetyzacja to `M = Ms m`.
- `external_solvers/tetrax/tetrax/interactions/exchange.py`
  - Linie 66-68: exchange wymaga `Msat` i `Aex`.
  - Linie 94-119: operator exchange pobiera przestrzenne `Msat`, `Aex` i `Msat.average`, a potem buduje macierz.
- `external_solvers/tetrax/tetrax/sample/mesh/fem_core/cythoncore.pyx`
  - `ExchangeOperator2D` i `ExchangeOperator3D` przekazują tablicę `Aex` do kodu C.
- `external_solvers/tetrax/tetrax/sample/mesh/fem_core/fempreproc.c`
  - `ExchangeOperatorFromMesh2D/3D` używają wskaźnika do tablicy `Aex` jako parametru elementowego/węzłowego.
- `external_solvers/tetrax/tetrax/sample/mesh/fem_core/fempreproc.py`
  - `CalcGrad_rho_exc(...)` pokazuje ważony sposób użycia `Aex` w operatorze radialnym.
- `external_solvers/tetrax/tetrax/interactions/dmi_interfacial.py`
  - Linie 55-63: `open_boundary` jest jawną właściwością DMI, a zmiana wymaga rebuild macierzy.
  - Linie 124-135: gdy `open_boundary=False`, dodawana jest macierz warunku brzegowego.
- `external_solvers/tetrax/tetrax/interactions/interlayer_exchange.py`
  - Linie 26-55: RKKY/interlayer exchange to osobna interakcja powierzchniowa z parametrem `J1`, nie zwykły region materiałowy.
  - Linie 74-113: sprzężenie jest składane między parami węzłów brzegowych.

### Model Tetrax

Tetrax nie stawia regionów w centrum modelu materiałowego. Centralne są:

1. `SampleMaterial`,
2. `MaterialParameter`,
3. `MeshScalar` / `MeshVector`,
4. interakcje, które reagują na zmianę parametrów i rebuildują macierze.

To jest bliższe FEM niż model Mumax+. Parametr materiałowy może być polem na siatce.

### Gradienty materiałowe

Tetrax wprost wspiera:

```python
sample.material["Msat"] = Mavrg + dMdy * sample.xyz.y
```

Ważne: `sample.mag` pozostaje jednostkowym polem kierunku `m`; pełna magnetyzacja `M` jest wyprowadzana przez przemnożenie przez lokalne `Msat`.

### Granice i interfejsy

Tetrax pokazuje trzy oddzielne kategorie:

1. Spatial coefficient field, np. `Msat(x)` albo `Aex(x)`.
2. Boundary condition, np. jawny `open_boundary` w DMI.
3. Surface/interface interaction, np. `InterlayerExchangeInteraction` z `J1`.

Wniosek: **nie wolno modelować każdego interfejsu jako region material override**. Kontakt/RKKY/warstwa spacerowa to oddzielna interakcja, a nie zwykła wartość `Aex` po obu stronach.

---

## Główne wnioski dla Fullmag

### 0. Obiekt materiałowy, region i coupling to trzy różne pojęcia

Fullmag powinien rozróżniać trzy poziomy:

1. **Obiekt materiałowy** - reprezentuje fizyczną domenę materiału i jest
   właścicielem pola magnetyzacji `m`.
2. **Region wewnątrz obiektu** - jest selektorem części tego samego obiektu.
   Może sterować mesh policy, parametrami, teksturą początkową i diagnostyką,
   ale sam nie tworzy nowego pola `m`.
3. **Coupling/interfejs** - opisuje fizyczne sprzężenie między dwoma stronami
   granicy: ordinary exchange, scaled exchange, brak exchange, RKKY,
   interlayer exchange albo przyszłe modele kontaktowe.

Praktyczna reguła:

- dwa fizycznie różne materiały z ostrą granicą -> dwa obiekty/domeny
  materiałowe i jawny `study.couplings.*`,
- jeden materiał z płynną zmiennością -> jeden obiekt i pola
  `MaterialParameterField`,
- jeden obiekt z ostrym skokiem parametru -> dozwolone tylko z jawną polityką
  realizacji granicy: conformal/domain marker albo projection warning.

Przykład dwóch materiałów:

```python
layer_a = study.geometry(
    fm.shapes.box(size=(2.0e-6, 1.0e-6, 2.0e-9)),
    name="layer_a",
)
layer_b = study.geometry(
    fm.shapes.box(size=(2.0e-6, 1.0e-6, 2.0e-9)).translate((0.0, 0.0, 3.0e-9)),
    name="layer_b",
)

layer_a.material.Ms = 8.0e5
layer_a.material.Aex = 1.2e-11

layer_b.material.Ms = 6.0e5
layer_b.material.Aex = 8.0e-12

study.couplings.exchange(layer_a, layer_b, mode="harmonic_mean")
study.couplings.rkky(
    source=layer_a.surface("top"),
    target=layer_b.surface("bottom"),
    J1=-0.3e-3,
)
```

Przykład jednego materiału z gradientem:

```python
film = study.geometry(
    fm.shapes.box(size=(2.0e-6, 1.0e-6, 2.0e-9)),
    name="film",
)
film.material.Ms = fm.fields.linear(
    base=7.7e5,
    gradient=(0.0, 2.0e11, 0.0),
    frame="object",
)
```

### 1. Region to selektor, nie pełny materiał

Region powinien być:

- nazwanym selektorem przestrzennym,
- dzieckiem obiektu magnetycznego,
- miejscem, do którego można przypiąć polityki:
  - mesh,
  - material override,
  - parameter field,
  - initial texture,
  - coupling/interface policy.

Region nie powinien sam z siebie oznaczać nowego pola `m`.

### 2. Parametry materiałowe muszą mieć własny model

Potrzebujemy `MaterialParameterField`, np.:

```python
waveguide.material.Ms = 7.7e5
waveguide.material.Aex = 1e-11

edge.material.Ms = 6.5e5
gradient.material.Ms = fm.fields.linear(
    base=7.7e5,
    gradient=(0.0, 2.0e11, 0.0),
    frame="object",
)
```

To musi niżej zejść jako coefficient field:

- FDM: pole komórkowe/węzłowe,
- FEM: coefficient field na elementach, węzłach lub punktach kwadratury.

Nie wolno automatycznie zamieniać gładkiego gradientu na setki ukrytych regionów.

### 3. Ostre granice materiałowe w FEM mają jawny kontrakt meshingowy

Dla FEM są dwa przypadki:

1. **Gładki parametr**, np. `Ms(x)` - można go reprezentować jako pole węzłowe/kwadraturowe.
2. **Skokowy parametr regionu**, np. `Aex = A1` po lewej i `Aex = A2` po prawej - najlepiej wymaga konforemnej granicy materiałowej albo domain markerów.

Jeżeli skokowy region przecina tetrahedry bez granicy konforemnej, coefficient zostanie projekcyjnie rozmyty. To może być fizycznie błędne.

Przyjęta decyzja:

- region material override z ostrym interfejsem ma domyślnie wymagać konforemnej granicy/domain markerów,
- projection mode jest jawny i dozwolony tylko w trybie `extended`; w `strict`
  brak konforemnej granicy jest błędem,
- jeżeli użytkownik wybierze tryb projekcyjny, UI musi pokazać ostrzeżenie,
- mesh build report musi pokazywać, czy granica regionu została zrealizowana konforemnie, czy jako projekcja pola.

### 4. Exchange interface i contact exchange to oddzielny model

Domyślnie:

- FDM: `harmonic_mean(A_i, A_j)` z opcjonalnym `scale` i `inter_exchange`.
- FEM: spatial coefficient `A(x)` w słabej formie i naturalna ciągłość strumienia exchange na granicy materiałowej.

Ale:

- brak exchange,
- reduced exchange,
- RKKY/interlayer exchange,
- kontakt przez spacer,
- dwa niezależne obiekty magnetyczne,

to nie są zwykłe material overrides. To powinny być jawne `Coupling` / `InterfaceInteraction`.

Proponowana semantyka:

```python
waveguide.interfaces.exchange.between("region_a", "region_b").scale = 0.0
waveguide.interfaces.exchange.between("region_a", "region_b").A = 5e-12

study.couplings.rkky(
    source=layer1.surface("top"),
    target=layer2.surface("bottom"),
    J1=-0.3e-3,
)
```

### 5. Airbox nie jest regionem magnetycznym

Airbox może mieć:

- mesh,
- demag/external field,
- potencjał magnetostatyczny,
- wektory pól `h`, `b`.

Airbox nie może mieć:

- `m`,
- `Ms`,
- `Aex`,
- anisotropy,
- DMI material coefficients.

Jeżeli UI pokazuje `m` w airboxie, to jest bug scoping/quantity mapping, nie kwestia kolorów.

---

## Polski plan region-owned

### Cel

Named regions mają stać się kanonicznym sposobem opisu lokalnego zagęszczenia siatki, lokalnych override'ów materiałowych i lokalnych warunków początkowych wewnątrz obiektu magnetycznego.

Plan nie może jednak sprowadzać wszystkiego do regionów. Gładkie gradienty parametrów muszą być polami parametrów, a sprzężenia między regionami muszą być osobnymi regułami interface/coupling.

### Architektura

Region jest nazwanym selektorem przestrzennym należącym do jednego obiektu magnetycznego.

Region może mieć niezależne załączniki:

- `RegionMeshPolicy`,
- `RegionMaterialOverride`,
- `RegionParameterField`,
- `RegionTextureOverride`,
- `RegionInterfacePolicy`.

Obiekt pozostaje właścicielem pola magnetyzacji `m`.

### Zasady projektowe

1. Dwa różne materiały z ostrą granicą modelujemy jako dwa obiekty/domeny
   materiałowe, nie jako dwa przypadkowe regiony jednego obiektu.
2. Region to semantyczny selektor, nie surowe pole Gmsh.
3. Obiekt pozostaje właścicielem `m`.
4. Domyślny układ współrzędnych regionu to local frame obiektu.
5. Mesh/material/texture/coupling to niezależne attachmenty.
6. Overlap musi być deterministyczny.
7. FDM i FEM niżej realizują ten sam intent inaczej.
8. Surowe `mesh.size_field(...)` zostaje jako advanced/debug escape hatch.
9. `fm.shapes` jest wspólnym namespace dla geometrii i regionów.
10. Rejestr regionów jest owner-scoped; study ma read-only flattened registry.
11. Smooth gradienty są polami parametrów, nie ukrytymi regionami.
12. Ostre granice materiałowe w FEM wymagają konforemnej granicy/domain markerów albo jawnej projekcji z ostrzeżeniem.
13. Interface exchange/contact/RKKY to osobne coupling semantics.

### Docelowy Python API

```python
waveguide = study.geometry(
    fm.shapes.arch_waveguide(
        length=3000e-9,
        width=1500e-9,
        height=2e-9,
        arch_height=0.0,
        z0=0.0,
    ),
    name="arch_waveguide",
)

waveguide.mesh(
    maximum_element_size=10e-9,
    minimum_element_size=2e-9,
    transition_distance=120e-9,
    order=1,
)

skyrmion = waveguide.add_region(
    "skyrmion",
    shape=fm.shapes.cylinder(
        radius=350e-9,
        height=2e-9,
        center=(0.0, 0.0, 0.0),
    ),
)
skyrmion.mesh.remesh(
    maximum_element_size=1e-9,
    minimum_element_size=1e-9,
    transition_distance=80e-9,
)
skyrmion.m = fm.texture.neel_skyrmion(300e-9, 40e-9, -1, 1, "xy")
```

Material override:

```python
edge = waveguide.add_region(
    "edge_softening",
    shape=fm.shapes.box(
        size=(3000e-9, 120e-9, 2e-9),
        center=(0.0, 690e-9, 0.0),
    ),
)
edge.material.Ms = 6.5e5
edge.material.Aex = 8e-12
edge.material.Ku1 = 390e3
```

Gradient parametru:

```python
graded = waveguide.add_region(
    "graded_ms",
    shape=fm.shapes.box(size=(3000e-9, 1000e-9, 2e-9)),
)
graded.material.Ms = fm.fields.linear(
    base=7.7e5,
    gradient=(0.0, 2.0e11, 0.0),
    frame="object",
)
```

Interface exchange:

```python
waveguide.interfaces.exchange.between("region_a", "region_b").scale = 0.0
waveguide.interfaces.exchange.between("region_a", "region_b").A = 5e-12
```

### Rejestr regionów

```python
skyrmion = waveguide.add_region("skyrmion", shape=fm.shapes.cylinder(radius=350e-9, height=2e-9))

waveguide.regions["skyrmion"] is skyrmion
waveguide.regions[0] is skyrmion
list(waveguide.regions) == [skyrmion]

study.regions["arch_waveguide/skyrmion"] is skyrmion
study.regions[0] is skyrmion
```

Reguły:

- `RegionHandle.region_id` jest stabilnym identyfikatorem typu primary key:
  przydziela go rejestr ownera, rename go nie zmienia, a skasowane id nie jest
  ponownie używane w tej samej scenie/sesji.
- UI/backend create może pominąć `region_id`; rejestr ownera przydziela kolejny
  wolny identyfikator typu `owner:r1`, `owner:r2`, ... . Jawne `region_id`
  jest potrzebne tylko dla importu, migracji i round-trip.
- `RegionHandle.name` jest etykietą użytkownika i identyfikatorem w eksporcie skryptu.
- `waveguide.regions[...]` jest modyfikowalne tylko przez `add_region`, `remove_region`, `rename_region`, `reorder_region`.
- `study.regions[...]` jest read-only.
- `region.delete()` usuwa region i jego attachmenty.
- Rename aktualizuje referencje nazwowe, ale nie zrywa selection/runtime diagnostics, bo te używają `region_id`.

### Overlap

- Mesh: wygrywa mniejszy żądany rozmiar elementu.
- Material/texture: wygrywa wyższy priorytet per property.
- Equal-priority overlap dla tego samego parametru materiałowego lub tekstury jest błędem walidacji.
- Equal-priority overlap dla różnych parametrów jest dozwolony, ale raportowany.
- Coupling/interface overrides są pairwise i muszą wskazać obie strony.

### UI

Regiony muszą być widoczne w Explorerze jako dzieci obiektu:

```text
Objects
  arch_waveguide
    Geometry
    Magnetic Parameters
    Texture
    Mesh
    Visualization
    Regions
      skyrmion
        Geometry
        Magnetic Parameters
        Texture
        Mesh
        Visualization
        Regions
      edge_softening
        Geometry
        Magnetic Parameters
        Texture
        Mesh
        Visualization
        Regions
```

Region jest w UI sub-obiektem authoringowym: ma wyglądać prawie identycznie jak
obiekt rodzic, bo może mieć własną geometrię selektora, lokalne parametry
magnetyczne, texture override, mesh policy, visualization override i opcjonalnie
podrzędne regiony. Semantycznie nadal nie tworzy nowego pola `m`; dziedziczy
pole `m` właściciela i tylko zawęża attachmenty/override'y do swojego supportu.

Region dziedziczy domyślnie wszystkie efektywne ustawienia rodzica. Lokalny
payload regionu zapisujemy tylko wtedy, gdy użytkownik tworzy override, np.
lokalne zagęszczenie meshu, lokalny `Ms/Aex`, lokalną teksturę początkową albo
lokalną konfigurację wizualizacji. UI musi pokazywać `inherited` jako stan
domyślny, zamiast materializować kopię parametrów rodzica w regionie.

Jeżeli v1 nie obsługuje zagnieżdżonych regionów, grupa `Regions` pod regionem
pozostaje widoczna jako disabled/empty z diagnostyką capability, zamiast
znikać. Dzięki temu model UI jest stabilny i nie trzeba go przebudowywać przy
włączeniu nested regions.

Widok `Mesh -> Region fields` jest tylko raportem realizacji, nie miejscem edycji.

UI musi obsługiwać:

- Add Region z wyborem shape z katalogu `fm.shapes`,
- rename,
- duplicate,
- delete z listą zależnych attachmentów,
- priority up/down,
- show/hide overlay,
- rebuild mesh,
- inspektor regionu,
- overlay regionu w viewport,
- overlap diagnostics,
- filtr histogramu/jakości meshu per region,
- mesh rebuild progress z informacją, który region unieważnił mesh.

Inspektor regionu:

- identity: name, region_id, owner, enabled, priority, frame,
- shape: kind, dimensions, center, transform,
- mesh: hmax, hmin, transition, order, realized field,
- material: `Ms`, `Aex`, `alpha`, `Ku1`, `Dind`, anisotropy axis, parameter field summary,
- texture: preset, transform, sampling scope,
- interface/coupling: exchange default, scale, explicit inter_exchange, DMI placeholder,
- diagnostics: overlap errors, validation, mesh generation id,
- quality: nodes/tetrahedra/histogram scoped to region.

### ProblemIR

ProblemIR powinien zawierać:

- `ObjectRegionIR`,
- `RegionShapeIR`,
- `RegionMeshPolicyIR`,
- `RegionMaterialOverrideIR`,
- `RegionParameterFieldIR`,
- `RegionTextureOverrideIR`,
- `RegionInterfacePolicyIR`.

Walidacja:

- owner istnieje,
- nazwa regionu nie jest pusta,
- nazwy są unikalne w obrębie ownera,
- shape ma dodatnie rozmiary,
- frame jest obsługiwany,
- priority rozstrzyga konflikty,
- airbox nie przyjmuje parametrów magnetycznych,
- skokowe material override w FEM wymaga conformal boundary/domain marker albo explicit projection mode.

### Meshing

Region mesh policy obniża się do size fields, ale raport musi zachować semantycznego właściciela:

```json
{
  "source": "object_region",
  "owner": "arch_waveguide",
  "region": "skyrmion",
  "region_id": "reg_arch_waveguide_skyrmion_01"
}
```

Dla FEM material region:

- tryb preferowany: conformal region boundary/domain marker,
- tryb dopuszczalny: projection coefficient field z ostrzeżeniem,
- tryb błędny: ciche rozmycie ostrej granicy bez diagnostyki.

### API/OpenAPI

Region API musi być resource-first:

- `/v2/sessions/current/model/regions` pokazuje authored regions i body regions,
- create/update/delete/reorder idą przez `ControlRoomApi`,
- generated OpenAPI JSON/types/client muszą być zaktualizowane,
- React components nie mogą budować endpointów ani robić własnego `fetch()`.

Minimalne zasoby:

- `region_id`,
- `region_kind`,
- `owner_object_id`,
- `owner_path`,
- `priority`,
- `shape`,
- `mesh_policy`,
- `material_override`,
- `parameter_fields`,
- `texture_override`,
- `interface_coupling`,
- `overlap_diagnostics`,
- `realization_status`.

### Testy fizyczne

Wymagane przypadki:

1. dwa sąsiednie regiony z różnym `Ms` i `Aex` -> jeden obiekt, jedno pole `m`,
2. FDM interface `A1/A2` -> współczynnik `harmonic_mean(A1, A2)`,
3. FDM `exchange_scale=0` -> brak exchange na interfejsie,
4. FEM skokowy `Aex` z conformal boundary -> coefficient/domain marker zachowany,
5. FEM skokowy `Aex` bez conformal boundary -> ostrzeżenie albo błąd zależnie od policy,
6. gradient `Ms(x)` -> coefficient field, nie ukryte regiony,
7. overlap `Ms` z equal priority -> błąd,
8. overlap `Ms` i `Aex` z equal priority -> dozwolone z diagnostyką,
9. próba przypisania `m/Ms/Aex` do airboxa -> błąd,
10. DMI interface -> zablokowane do czasu osobnej noty fizycznej.
11. dwa obiekty bez explicit coupling -> brak exchange między nimi (free surface),
12. jeden obiekt, dwa regiony, brak jawnego `interfaces` -> default exchange = harmonic mean (weryfikacja, że intra-object default jest ciągły),
13. gradient `Ms(x)` + exchange -> `H_ex` poprawnie dzieli przez lokalne `Ms(x)` (brak division-by-zero, poprawny denominator),
14. dwa obiekty, explicit coupling `scale=0.5` -> reduced exchange (połówka harmonicznej średniej),
15. FEM conformal split + gradient `Aex` wewnątrz -> ciągłość `m` na granicy (flux continuity),
16. round-trip: Python->IR->scene->export->Python zachowuje coupling `J1`, `scale`, `mode`,
17. relaxation convergence z dwoma regionami o różnym `Aex` -> solver dochodzi do równowagi,
18. exchange field/energy consistency: `δE_ex/δm ∝ -μ₀ Ms H_ex` (Taylor test z finite difference) -> spójność `A_ij` w field i energy reduction,
19. `Ms=0` wewnątrz aktywnego obiektu magnetycznego -> błąd walidacji (nie division by zero).

Powyższe przypadki nie są opcjonalną listą regresji. Są odpowiedzią na pytania
recenzji i muszą mieć odwzorowanie w masterplanie jako test albo capability
gate. Jeżeli implementacja danej warstwy nie ma jeszcze runtime mechanizmu, ma
zablokować ścieżkę planowania zamiast zachować authored intent i uruchomić
solver z cicho zmienioną fizyką.

### Kryteria akceptacji

- Użytkownik może tworzyć regiony w Pythonie i UI.
- Regiony są widoczne pod obiektami w Explorerze.
- Regiony mają pełny CRUD i inspektor.
- Rejestr `waveguide.regions` i read-only `study.regions` działają deterministycznie.
- Mesh/material/texture/coupling są oddzielnymi attachmentami.
- Gradienty `Ms(x)`/`Aex(x)` są coefficient fields.
- FDM ma przetestowaną średnią harmoniczną i interface scale/override.
- FEM ma przetestowaną realizację coefficient field i konforemnych granic materiałowych.
- Airbox nie dostaje magnetycznych parametrów materiałowych.
- OpenAPI, generated types/client, `ControlRoomApi`, resource hooks i command registry są spójne.
- Eksport skryptu używa `waveguide.add_region(...)`, nie publicznych nazw Gmsh.

---

## Przyjęte odpowiedzi przed implementacją

1. Pierwsza wersja region material override w FEM wymaga conformal boundary dla
   ostrych skoków w trybie `strict`. Projection mode jest dozwolony tylko jako
   jawne `policy="project"` w trybie `extended`, z diagnostyką w mesh report i
   UI.
2. Publiczny API `fm.fields.*` w v1 obejmuje `constant`, `linear`, `radial`,
   `piecewise` i `sampled`. Każde pole musi mieć jawne jednostki/typ parametru,
   finite values, frame (`object` albo `world`) i docelową lokalizację
   realizacji (`cell`, `node`, `element`, `quadrature`) tam, gdzie ma to
   znaczenie.
3. Kanonicznym właścicielem interface exchange jest `study.couplings`.
   `waveguide.interfaces` może istnieć tylko jako convenience alias tworzący
   wpis w `study.couplings` z owner context.
4. UI pokazuje authored regions pod owner object w Explorerze. Realized mesh
   fields/markers są osobnym widokiem realizacji i diagnostyki, z innym badge,
   kolorem overlay i inspektorem provenance. Nie wolno mieszać authored region
   z realized mesh part.
5. Region texture override w v1 dotyczy wyłącznie initial condition `m0`.
   Runtime texture authoring jest poza zakresem i wymaga osobnego kontraktu
   stage/runtime.
6. Eksport po rename używa aktualnych nazw dla czytelności, ale zachowuje
   stabilne `region_id` w canonical Python export (`region_id=` dla regionów
   pochodzących z UI albo migracji). Ręcznie pisane skrypty mogą pominąć
   `region_id`, wtedy DSL generuje stabilny identyfikator.
7. OpenAPI musi rozdzielić resources authored i realized: nowe endpoints dla
   authored regions/material fields/couplings, osobne endpoints dla realized
   mesh/material regions. Schema dostaje jawny `kind` i revision, a generated
   frontend types/client muszą zostać odświeżone razem z `ControlRoomApi`.
8. Default exchange między regionami **wewnątrz** jednego obiektu to
   `harmonic_mean(A_i, A_j)`. To jest ciągłość jednego materiału/pola `m`, a
   nie opcjonalny coupling.
9. Default exchange między dwoma **obiektami** bez explicit coupling to
   `none` / free surface. Dwa obiekty są niezależne, dopóki użytkownik nie doda
   `study.couplings.exchange(...)`.
10. RKKY unsupported w runtime blokuje run. Planner nie może zamienić RKKY na
    warning ani na zwykły exchange.
11. `Ms=0` wewnątrz aktywnego obiektu magnetycznego jest niedozwolone.
    Niemagnetyczny void modelujemy przez geometrię/active mask, nie przez
    zerowanie `Ms`.
12. Coupling surface selector `layer_a.surface("top")` w v1 oznacza
    bounding-box face z tolerancją. FDM rozwiązuje go do exposed/contact cell
    faces i par sąsiedztwa masek; FEM rozwiązuje go do boundary face markers.
    Pełne named-face support jest v2.
13. Multilayer FDM + region-owned material/coupling jest poza zakresem v1 i
    wymaga explicit capability gate.
14. FDM ABI migruje z implicit zero cross-region default do jawnego kontraktu:
    `exchange_pairs` + `exchange_pair_default`. Stary `exchange_lut` zostaje
    low-level realized override, a legacy zero-default może działać tylko dla
    jawnie oznaczonej starej wersji planu.
15. Rejestr regionów jest owner-scoped. `object.regions` jest modyfikowalne
    tylko przez metody ownera, a `study.regions` jest read-only flattened view.
    `region.delete()` usuwa region i jego attachmenty albo wymaga jawnej
    decyzji UI, gdy istnieją zewnętrzne referencje.
16. Overlap regionów jest rozstrzygany per attachment: mesh wybiera mniejszy
    rozmiar elementu, material/texture używa priority per property, a equal
    priority dla tego samego parametru jest błędem walidacji.
17. Runtime contact discovery jest częścią realizacji couplingów. FDM używa
    sąsiedztwa masek komórek na jednej siatce; FEM wymaga boundary/domain
    markerów w shared-domain mesh. Brak realizowalnego interfejsu dla
    explicit coupling blokuje run.
18. Stare `MaterialIR.ms_field` i podobne payloady są realized/compatibility
    surface, nie authored intent. Nowe authored intent musi przechodzić przez
    `MaterialParameterFieldIR` z provenance.
19. Authored-only coupling może istnieć w modelu i UI tylko jako zachowana
    intencja. Nie wolno uruchomić solvera, jeśli coupling wymaga operatora,
    którego backend nie wspiera.
20. Projection mode nie ma w v1 ilościowej gwarancji błędu dla ostrych skoków
    `Aex/Ms`. W trybie `strict` taki przypadek wymaga conformal boundary/domain
    marker; w `extended` można go dopuścić tylko jako jawne
    `realization_policy="projected"` z diagnostyką kontrastu i provenance.
21. Projection mode nie jest dopuszczalnym domyślnym modelem dla RKKY/contact
    ani dla DMI na interfejsie. Te interakcje wymagają jawnego interfejsu
    runtime albo blokady capability.
22. Contact discovery nie jest authoringiem. FDM rozwiązuje contact przez
    sąsiedztwo masek komórek na jednej siatce; FEM przez boundary/domain
    markers w shared-domain mesh. Brak realizowalnego contactu dla explicit
    coupling blokuje run.
23. Stary `RegionIR { name, geometry }` zostaje compatibility/body-region
    surface. Nowe authored regiony nie rozszerzają tego typu, tylko używają
    `ObjectRegionIR`.
24. Exchange field i exchange energy muszą używać tej samej definicji `A_ij`.
    Kryterium produkcyjności obejmuje Taylor/directional-derivative test
    wykrywający rozjazd pola i energii.

Szczegółowy decision log z odpowiedziami na pytania recenzji znajduje się w
masterplanie wdrożeniowym, sekcja `4.4 Pytania z recenzji i wiążące
odpowiedzi`, `4.5 Doprecyzowania po drugiej recenzji` oraz `4.6 Macierz
egzekwowania decyzji`. Dodatkowe pytania operacyjne dotyczące edycji UI,
authoring transactions, delete/invalidation, airbox ownership, indeksowania
rejestru regionów i zakresu named-face selectors są zamknięte w sekcji
`4.7 Dodatkowe pytania implementacyjne i odpowiedzi`. Te sekcje są częścią
kontraktu implementacyjnego:
jeżeli kod, OpenAPI, UI albo backend nie mogą zrealizować którejś odpowiedzi,
planner musi zablokować ścieżkę capability gate zamiast cicho degradować
fizykę.
