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

### 3. Ostre granice materiałowe w FEM wymagają decyzji meshingowej

Dla FEM są dwa przypadki:

1. **Gładki parametr**, np. `Ms(x)` - można go reprezentować jako pole węzłowe/kwadraturowe.
2. **Skokowy parametr regionu**, np. `Aex = A1` po lewej i `Aex = A2` po prawej - najlepiej wymaga konforemnej granicy materiałowej albo domain markerów.

Jeżeli skokowy region przecina tetrahedry bez granicy konforemnej, coefficient zostanie projekcyjnie rozmyty. To może być fizycznie błędne.

Dlatego plan powinien przyjąć:

- region material override z ostrym interfejsem ma domyślnie wymagać konforemnej granicy/domain markerów,
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

1. Region to semantyczny selektor, nie surowe pole Gmsh.
2. Obiekt pozostaje właścicielem `m`.
3. Domyślny układ współrzędnych regionu to local frame obiektu.
4. Mesh/material/texture/coupling to niezależne attachmenty.
5. Overlap musi być deterministyczny.
6. FDM i FEM niżej realizują ten sam intent inaczej.
7. Surowe `mesh.size_field(...)` zostaje jako advanced/debug escape hatch.
8. `fm.shapes` jest wspólnym namespace dla geometrii i regionów.
9. Rejestr regionów jest owner-scoped; study ma read-only flattened registry.
10. Smooth gradienty są polami parametrów, nie ukrytymi regionami.
11. Ostre granice materiałowe w FEM wymagają konforemnej granicy/domain markerów albo jawnej projekcji z ostrzeżeniem.
12. Interface exchange/contact/RKKY to osobne coupling semantics.

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

- `RegionHandle.region_id` jest stabilny i niejawny.
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
    Regions
      skyrmion
      edge_softening
```

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
  "region_id": "..."
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

## Decyzje, których nie wolno pominąć przed implementacją

1. Czy pierwsza wersja region material override w FEM wymaga conformal boundary, czy dopuszcza projection mode?
2. Jak wygląda publiczny API dla `fm.fields.*`?
3. Czy `interface exchange` jest własnością owner object (`waveguide.interfaces`) czy globalnym `study.couplings`?
4. Jak UI pokazuje różnicę między authored region i realized mesh field?
5. Czy region texture override ma dotyczyć tylko initial condition, czy też runtime texture authoring?
6. Jak eksportować regiony po rename, skoro runtime używa stabilnego `region_id`, a skrypt używa nazw?
7. Jak wersjonować zmianę OpenAPI, żeby stary frontend nie interpretował realized mesh regions jako authored regions?
