# Masterplan wdrożenia region-owned mesh/material/texture/coupling

Data: 2026-06-04

Status: plan wdrożeniowy w trakcie implementacji kontraktu

Powiązane dokumenty:

- `docs/plans/active/region-owned-mesh-material-texture-plan-2026-06-04-pl.md`
- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/specs/frontend-v2/01-module-kernel-architecture.md`
- `docs/specs/frontend-v2/03-api-integration-layer.md`
- `docs/specs/frontend-v2/04-state-management.md`
- `docs/physics/TEMPLATE.md`
- `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`

Ten dokument opisuje pełną ścieżkę wdrożenia region-owned semantics od fizyki,
przez Python DSL i `ProblemIR`, po backend, OpenAPI i frontend v2.

Aktualizacja po recenzji: pytania z audytu Claude i drugiego audytu Codex są
zamknięte jako decyzje kontraktowe w sekcji 4.4. Nie są już opcjonalnymi
rekomendacjami. Jeżeli implementacja nie potrafi zrealizować którejś decyzji,
planner/runtime musi użyć capability gate albo zablokować run.

Nie jest to plan kosmetycznej zmiany UI. To zmiana publicznego modelu
authoringu. Dlatego pierwszym celem jest rozdzielenie pojęć, które obecnie są
częściowo zmieszane:

1. obiekt materiałowy,
2. region wewnątrz obiektu,
3. pole parametru materiałowego,
4. sprzężenie interfejsowe,
5. realized mesh/material region marker,
6. zakres quantity i wizualizacji.

---

## 1. Teza architektoniczna

Docelowy kontrakt Fullmag:

- **Obiekt materiałowy** jest fizyczną domeną materiału i właścicielem pola
  magnetyzacji `m`.
- **Region authored** jest nazwanym selektorem wewnątrz jednego obiektu.
  Region nie tworzy osobnego pola `m`.
- **MaterialParameterField** opisuje wartość parametru materiałowego jako
  skalar, pole analityczne, pole regionowe albo zrealizowane pole na mesh/grid.
- **Coupling** opisuje fizyczne sprzężenie między dwiema stronami granicy.
  Zwykły exchange, reduced exchange, brak exchange, RKKY i interlayer exchange
  są sprzężeniami, nie przypadkowymi override'ami materiału.
- **Realized mesh/material region** jest wynikiem materializacji. Nie jest tym
  samym co authored region.
- **Airbox** jest domeną mesh/demag/pól, ale nie jest regionem magnetycznym i
  nie może mieć `m`, `Ms`, `Aex`, anisotropy ani DMI.

Praktyczna reguła dla użytkownika:

- dwa różne materiały z ostrą granicą -> dwa obiekty albo dwie jawne domeny
  materiałowe i coupling,
- jeden ciągły materiał z lokalną zmianą parametrów -> jeden obiekt, regiony
  jako selektory i parameter fields,
- płynny gradient `Ms(x)` albo `Aex(x)` -> coefficient field,
- ostry skok parametru w FEM -> conformal boundary/domain marker albo jawny
  projection mode z diagnostyką.

---

## 2. Zakres

### 2.1 W zakresie

Masterplan obejmuje:

- nową notę fizyczną,
- zmianę publicznego Python DSL,
- zmianę `ProblemIR`,
- zmianę walidacji i normalizacji,
- zmianę `SceneDocument`,
- zmianę authoring adapters i script export,
- zmianę meshing planner i mesh build report,
- realizację pól materiałowych dla FDM i FEM,
- podstawowe coupling semantics,
- OpenAPI v2 i typy wygenerowane,
- `ControlRoomApi`, resource hooks i resource cache,
- Explorer, Inspector, ribbon/commands i viewport overlays,
- data-plane i quantity scoping,
- migrację starego `RegionIR` i `model/regions`,
- testy i rollout.

### 2.2 Poza zakresem pierwszej implementacji

Te elementy trzeba zaprojektować, ale nie muszą wejść w pierwszym wdrożeniu:

- pełny DMI interface między różnymi materiałami,
- pełny RKKY FEM operator produkcyjny,
- arbitralne pola użytkownika przez niesandboxowane wyrażenia Python w UI,
- automatyczny CSG split każdego regionu przecinającego dowolną bryłę,
- edycja regionów przez bezpośrednie rysowanie na mesh surface,
- wielofizyczne regiony mechaniczne, termiczne i spin-transportowe.

Pierwsze wdrożenie musi jednak zostawić miejsca na te semantyki bez zmiany
publicznych nazw.

---

## 3. Nazewnictwo docelowe

### 3.1 Pojęcia publiczne

| Pojęcie | Znaczenie | Właściciel |
|---|---|---|
| `MaterialObject` | fizyczna domena magnetyka | geometry object / magnet |
| `ObjectRegion` | named selector wewnątrz obiektu | owner object |
| `MaterialParameterField` | skalar lub pole parametru materiałowego | material / object / region attachment |
| `TextureOverride` | lokalny warunek początkowy `m0` | object albo region |
| `MeshPolicy` | intencja zagęszczenia meshu | universe, object, region, interface |
| `Coupling` | fizyczne sprzężenie dwóch stron | `study.couplings` |
| `RealizedRegion` | wynik materializacji w mesh/grid | runtime/meshing |
| `MeshPart` | część topologii do display/diagnostics | meshing/data-plane |

### 3.2 Pojęcia, których nie wolno mieszać

- `ObjectRegion` nie jest `RegionIR` starego typu `name + geometry`.
- `ObjectRegion` nie jest `FemDomainRegionMarkerIR`.
- `ObjectRegion` nie jest `MeshPart`.
- `material_ref` na obiekcie nie jest couplingiem.
- `Aex` po obu stronach granicy nie definiuje automatycznie RKKY.
- `m` jest polem magnetycznym tylko w magnetycznych częściach domeny.
- `airbox` może mieć `h_eff`, `h_demag`, `b`, potencjał albo mesh quality, ale
  nie może mieć `m`.

---

## 4. Warstwa fizyczna

### 4.1 Nowa nota fizyczna

Przed implementacją kodu trzeba dodać:

`docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`

Nota musi być publikacyjna i zawierać:

1. definicje `m`, `M = Ms(x)m`, `A(x)`, `Ku(x)`, `D(x)`,
2. jednostki SI dla każdego parametru,
3. rozróżnienie obiekt materiałowy / region / coupling,
4. interpretację ciągłego gradientu,
5. interpretację ostrego skoku parametru,
6. exchange dla FDM:
   `A_interface = harmonic_mean(A_i, A_j) * scale(i, j)`, chyba że podany jest
   jawny `inter_exchange`,
7. exchange dla FEM jako coefficient field w słabej formie,
8. wymóg conformal boundary/domain marker dla ostrych skoków w FEM,
9. projection mode jako świadomy kompromis z ostrzeżeniem,
10. RKKY/interlayer exchange jako oddzielną interakcję powierzchniową,
11. DMI interface jako deferred physics note,
12. airbox quantity scoping,
13. walidację i referencyjne przypadki testowe.

### 4.2 Minimalne równania w nocie

Exchange energy density:

```text
e_ex = A(x) |grad m|^2
```

Effective exchange field:

```text
H_ex = 2 / (mu0 Ms(x)) div(A(x) grad m)
```

Warunek naturalny na ostrej granicy bez dodatkowego surface coupling:

```text
A_1 partial_n m_1 = A_2 partial_n m_2
```

RKKY/interlayer exchange jako energia powierzchniowa:

```text
E_RKKY = -J1 integral_Gamma (m_1 dot m_2) dS
```

Brak exchange na granicy:

```text
scale(i, j) = 0
```

### 4.3 Przyjęte decyzje fizyczne przed kodem

PR 1 nie ma już zostawiać tych tematów jako pytań. Nota fizyczna ma utrwalić
poniższe odpowiedzi jako kontrakt implementacyjny:

1. Sharp region material override w FEM domyślnie wymaga conformal
   boundary/domain marker. Projection nie jest domyślną realizacją ostrego
   skoku.
2. Projection mode jest dozwolony tylko po jawnym `policy="project"` i tylko w
   `extended`. W `strict` brak konforemnej granicy dla ostrego skoku jest
   błędem planowania.
3. Intra-object region-region exchange musi działać od pierwszej wersji jako
   default harmonic mean, bo regiony należą do jednego pola `m`.
   `interfaces.exchange.between()` służy do nadpisania tego defaultu.
   Region bez lokalnych override'ów materiału, coefficient fieldów, texture
   override, mesh policy ani explicit exchange override jest tylko
   selektorem/sub-obiektem authoringu. Nie tworzy granicy materiałowej ani
   drugiego pola `m`; nawet jeśli runtime zmaterializuje maskę regionu,
   fizyka pozostaje ciągłym ośrodkiem z parametrami rodzica.
4. Object-object exchange jest aktywny tylko po jawnym wpisie
   `study.couplings.exchange(...)`. Bez coupling dwa obiekty mają free surface.
5. RKKY może być authored/provenance w pierwszej wersji, ale jeśli wybrany
   backend nie realizuje RKKY, planner blokuje run. Warning-only jest
   niedozwolony.
6. UI może utworzyć skokowy override `Aex` tylko razem z polityką realizacji:
   conformal/domain marker albo explicit projection. UI nie może cicho stworzyć
   projected sharp jump.
7. `Ms=0` wewnątrz aktywnego obiektu magnetycznego jest błędem walidacji.
   Void modelujemy geometrią/active mask, nie zerowaniem `Ms`.
8. Obecny FDM ABI default (`A_ij(i!=j)=0`) jest sprzeczny z docelową semantyką
   intra-object. Migracja wprowadza `exchange_pairs` i jawny
   `exchange_pair_default`; legacy zero-default może zostać tylko za flagą
   wersji starego planu.
9. Multilayer FDM + region-owned material/coupling jest poza zakresem v1 i
   wymaga capability gate. Nie wolno częściowo realizować regionów w multilayer
   path bez pełnych testów.
10. Surface selector `object.surface("top")` w v1 oznacza bounding-box face z
    tolerancją i musi zostać rozwiązany do runtime indices: w FDM do par
    sąsiadujących komórek/masek, w FEM do boundary face markers. Named-face
    support jest v2.

### 4.4 Pytania z recenzji i wiążące odpowiedzi

Ta sekcja zamyka pytania z recenzji planu. Implementacja nie może zostawić tych
odpowiedzi jako warning-only ani authored-only zachowania bez runtime
realizacji, chyba że punkt jawnie mówi o capability gate.

| Pytanie | Odpowiedź | Warstwa, która to egzekwuje |
|---|---|---|
| Czy dwa regiony wewnątrz jednego obiektu mają exchange bez jawnego coupling? | Tak. Domyślnie używają `harmonic_mean(A_i, A_j)` i należą do jednego pola `m`. | ProblemIR validation, runner materialization, FDM/FEM exchange tests |
| Czy brak explicit object-object coupling oznacza harmonic mean między obiektami? | Nie. Dwa obiekty bez `study.couplings.exchange(...)` mają free surface. | ProblemIR coupling model, planner, backend pair table |
| Czy region-region exchange może domyślnie być zerowy jak w obecnym FDM ABI? | Nie. Obecny zero-default jest legacy mismatch i musi zostać zastąpiony przez `exchange_pair_default + exchange_pairs`. | FDM ABI, runner, compatibility tests |
| Czy `interfaces.exchange.between()` tworzy domyślne sprzężenie? | Nie. To jest override istniejącego intra-object defaultu albo explicit object-object coupling. | Python DSL, ProblemIR validation |
| Czy RKKY unsupported może przejść jako warning? | Nie. Unsupported RKKY blokuje planning/solver start. Nie wolno go degradować do zwykłego exchange. | capability matrix, planner, runtime diagnostics |
| Czy `Ms=0` wewnątrz aktywnego obiektu jest dozwolone jako void? | Nie. Void modelujemy geometrią albo active mask; aktywne `Ms(x)` musi być dodatnie. | Python validation, ProblemIR validation, backend preflight |
| Jak sprawdzamy spójność exchange field i energy? | Dodajemy Taylor/directional-derivative test: `E_ex(m + eps dm)` musi zgadzać się z polem `H_ex` używającym tej samej funkcji `A_ij`. | FDM CPU oracle, FDM GPU parity, FEM reference tests |
| Co oznacza `surface("top")` w v1? | Lokalna bounding-box face z tolerancją. FDM rozwiązuje ją do exposed/contact cell faces, FEM do boundary face markers. | surface selector resolver, OpenAPI, UI inspector |
| Co z nieregularnymi/nazwanymi powierzchniami? | Są v2. W v1 używamy tylko bbox face selectors albo jawnych markerów, jeżeli istnieją po stronie realized mesh. | DSL docs, ProblemIR validation |
| Co jeśli sharp `Aex/Ms` region w FEM nie ma conformal boundary? | `strict` blokuje plan. `extended` dopuszcza tylko explicit projection z ostrzeżeniem/provenance. | FEM mesher, planner, UI diagnostics |
| Czy projection mode jest fizycznie równoważny conformal split? | Nie. Jest kompromisem do gładkich/łagodnych pól. Dla dużych kontrastów, DMI, RKKY i walidacji produkcyjnej wymaga conformal boundary albo blokady. | physics note, planner policy |
| Czy multilayer FDM + region-owned material/coupling jest w v1? | Nie. Jest out of scope v1 i musi być capability-gated. | planner capability gate, FDM runner |
| Czy dwa obiekty FDM to dwa backendi? | Nie. Dwa obiekty na jednej siatce FDM materializują się jako jeden plan z cellwise material fields, object/region masks i pair table. | runner materialization, FDM ABI |
| Czy authored region może być większy niż obiekt rodzic? | Nie. Region shape jest owner-scoped; UI clampuje draft do bounds rodzica, a API powtarza clamp przy create/patch/duplicate, żeby imported albo ręcznie wysłany payload nie mógł wyjść poza ownera. | UI inspector model, OpenAPI authoring handlers, API tests |
| Co oznacza `enabled=false` na regionie? | Region pozostaje authored draftem i musi walidować swój payload, ale jego attachmenty są runtime-inert: nie tworzą aktywnych konfliktów materiałowych, nie blokują planner capability gates i nie materializują mesh/material/texture policy. Aktywny coupling nie może wskazywać disabled regionu; disabled coupling może zachować taką referencję jako draft. | ProblemIR validation conflict filter, planner gates, UI inspector |
| Jak działa rejestr regionów? | Rejestr jest owner-scoped: `object.regions` jest modyfikowalne przez metody ownera, a `study.regions` jest read-only flattened view z kluczami `object/region`. | Python DSL, SceneDocument, OpenAPI model resources |
| Co usuwa `region.delete()`? | Usuwa region authored i wszystkie jego attachmenty: mesh policy, material overrides, texture overrides i coupling/interface references, chyba że referencja zewnętrzna wymaga explicit confirmation w UI. | Python DSL, UI commands, validation |
| Co z overlapami regionów? | Mesh overlap wybiera mniejszy rozmiar. Material/texture overlap jest rozstrzygany per property przez priority; equal priority dla tego samego parametru jest błędem. | ProblemIR validation, mesh/material report, UI diagnostics |
| Jak runtime wykrywa kontakt dwóch obiektów? | FDM używa sąsiedztwa cell masks na jednej siatce. FEM wymaga shared-domain boundary/domain markers; brak markerów dla explicit coupling blokuje run. | runner materialization, FDM/FEM backend preflight |
| Czy `MaterialIR.ms_field` jest authored intent? | Nie. Stare realized payloady zostają compatibility/runtime surface. Nowe authored intent przechodzi przez `MaterialParameterFieldIR` i provenance. | ProblemIR migration, script export, SceneDocument |

Minimalny zestaw testów wynikający bezpośrednio z tych odpowiedzi:

1. `intra_object_region_exchange_defaults_harmonic_mean`.
2. `object_object_exchange_without_coupling_defaults_none`.
3. `object_object_exchange_with_harmonic_mean_coupling_builds_pair_table`.
4. `exchange_scale_zero_disables_interface_exchange`.
5. `rkky_unsupported_blocks_runtime`.
6. `ms_zero_in_active_object_is_validation_error`.
7. `surface_top_selector_resolves_to_runtime_faces`.
8. `multilayer_fdm_regions_are_capability_gated`.
9. `exchange_field_energy_directional_derivative_consistency`.

### 4.5 Doprecyzowania po drugiej recenzji

Ta sekcja zamienia pozostałe pytania recenzji w decyzje projektowe. Jeżeli
niższa warstwa nie potrafi zrealizować decyzji, planner ma zablokować ścieżkę
albo wymagać jawnego `extended`/projection, zamiast cicho zmienić fizykę.

| Pytanie recenzji | Decyzja | Zmiana w planie implementacji |
|---|---|---|
| Czy projection mode ma znany błąd fizyczny dla skokowych `Aex/Ms`? | W v1 nie deklarujemy ilościowej gwarancji błędu dla projection sharp jump. Projection jest tylko świadomym kompromisem dla gładkich albo celowo rozmytych pól. | `strict` blokuje skokowy override bez conformal/domain marker. `extended` wymaga provenance `realization_policy=projected`, diagnostyki kontrastu i ostrzeżenia w UI. |
| Czy projection może być użyte dla DMI, RKKY albo walidacji produkcyjnej? | Nie jako domyślna realizacja. DMI/RKKY/contact wymagają jawnego interfejsu; validation-grade sharp material boundary wymaga conformal boundary. | Planner odrzuca projection dla RKKY/contact i dla DMI na interfejsie do czasu osobnej noty fizycznej. |
| Jak runtime znajduje kontakt dwóch obiektów? | Resolver kontaktu jest częścią materializacji, nie częścią authoringu. FDM używa sąsiedztwa masek na jednej siatce; FEM używa boundary/domain markers w shared-domain mesh. | Dodać `ContactInterfaceResolver` w runner/materialization i raportować `resolved_face_count`, `area`, `owner_a`, `owner_b`, `selector_a`, `selector_b`. Brak interfejsu dla explicit coupling blokuje run. |
| Czy `surface("top")` działa dla nieregularnych kształtów? | W v1 tylko jako lokalny bbox-face selector z tolerancją. Dla nieregularnych/nazwanych powierzchni v1 wymaga realized marker albo odrzuca selector. | OpenAPI/UI muszą pokazać `selector_resolution_status`; named-face support zostaje v2. |
| Czy stary `RegionIR { name, geometry }` rozszerzamy o nowe pola? | Nie. Stary `RegionIR` jest legacy/body-region compatibility. Nowy model używa `ObjectRegionIR` i `MaterialParameterFieldIR`. | Oznaczyć stary model jako deprecated/compatibility w planie migracji; adapter może z niego produkować read-only body region, ale nie authored object-owned region. |
| Czy `MaterialIR.ms_field` może zostać użyte jako authored source? | Nie. To realized/runtime payload. Authored gradient albo override przechodzi przez `MaterialParameterFieldIR`, z jednostką, frame, priority i provenance. | Script export i SceneDocument nie mogą serializować authored fields jako stare `MaterialIR.ms_field`. |
| Czy unsupported authored coupling może zostać zachowany bez wykonania? | Tak jako authored intent w modelu/UI, ale nie w uruchomionym solverze. Solver start musi być zablokowany, jeżeli coupling zmienia fizykę i backend nie ma operatora. | Capability diagnostic ma wskazać konkretny coupling i powód blokady. |
| Jak zapewniamy spójność exchange energy i field? | Jedna funkcja/kontrakt `A_ij` musi zasilać kernel pola i redukcję energii. | Dodać Taylor/directional-derivative test do FDM CPU oracle i parity dla GPU/FEM, zanim uznamy region exchange za produkcyjny. |

### 4.6 Macierz egzekwowania decyzji

Ta tabela przekłada odpowiedzi z sekcji 4.4 i 4.5 na konkretne miejsca, w
których plan ma zostać zmieniony podczas implementacji. Jeżeli dana warstwa nie
ma jeszcze potrzebnego mechanizmu, PR musi dodać capability gate zamiast
utrzymywać niejawny fallback.

| Decyzja | Wymagana zmiana | Test/gate |
|---|---|---|
| Intra-object region exchange = harmonic mean | Runner materialization buduje pair table dla regionów jednego obiektu nawet bez jawnego `CouplingIR`. FDM/FEM dostają resolved pair/coefficient contract. | `intra_object_region_exchange_defaults_harmonic_mean`; directional derivative dla pola i energii. |
| Inter-object exchange = none bez coupling | Planner nie tworzy pair table między różnymi object ids bez `CouplingIR`. | `object_object_exchange_without_coupling_defaults_none`. |
| FDM ABI nie może domyślnie zerować nowych regionów | `native/include/fullmag_fdm.h` dostaje `exchange_pair_default`, `exchange_pairs`, cellwise material fields i wersjonowaną ścieżkę legacy. | ABI contract test plus GPU/CPU parity dla harmonic/disabled/explicit pair. |
| `Ms(x) > 0` w aktywnym magnetyku | Python DSL, ProblemIR validation, runner preflight i native ABI validation odrzucają `Ms <= 0`. | `ms_zero_in_active_object_is_validation_error`; backend validation test. |
| RKKY unsupported blokuje run | Capability resolver wiąże każdy `CouplingIR` z backend support. Authored-only jest dozwolone tylko w scene/provenance, nie w runtime. | `rkky_unsupported_blocks_runtime_plan`; UI pokazuje blocker diagnostic. |
| Surface selector v1 = bbox face | Dodać selector resolver z provenance: selector, tolerance, resolved face count, area. | `surface_top_selector_resolves_to_runtime_faces`; unresolved explicit endpoint blocks run. |
| Contact discovery jest materialization step | Dodać `ContactInterfaceResolver` dla FDM mask adjacency i FEM boundary/domain markers. | Object-object coupling bez contact/marker failuje z `COUPLING_ENDPOINT_UNRESOLVED`. |
| Projection sharp jump nie jest strict | Planner wykrywa skokowy override i wymaga conformal/domain marker w `strict`; `extended` wymaga explicit `realization_policy=projected`. | `fem_sharp_aex_region_requires_conformal_in_strict`; projection warning/provenance test. |
| Projection nie obsługuje RKKY/contact/DMI jako default | Planner blokuje te kombinacje do czasu osobnych operatorów/not fizycznych. | Capability gate dla RKKY/contact/DMI projection. |
| Multilayer FDM + region-owned v1 out of scope | Multilayer plan path odrzuca object regions/material fields/couplings zanim trafi do częściowo obsłużonego native path. | `multilayer_fdm_regions_are_capability_gated`. |
| `MaterialIR.*_field` nie jest authored source | Script export, SceneDocument i UI authoring używają `MaterialParameterFieldIR`; stare pola pozostają realized/compatibility. | Round-trip nie zapisuje authored gradientu jako `MaterialIR.ms_field`. |
| Region registry owner-scoped | `object.regions` jest mutable registry; `study.regions` read-only flattened view; delete/rename obsługuje zależności i stable ids. | Python registry/delete/rename tests; UI delete confirmation for external refs. |
| Overlap per attachment | Mesh/material/texture/coupling rozstrzygają konflikty osobno; equal priority dla tego samego parametru blokuje. | Overlap validation tests i inspector diagnostics. |

### 4.7 Dodatkowe pytania implementacyjne i odpowiedzi

Poniższe pytania nie zmieniają fizyki z sekcji 4.4-4.6, ale zamykają luki
operacyjne, które mogłyby doprowadzić do dwóch różnych implementacji tego
samego modelu w Pythonie, OpenAPI i UI.

| Pytanie | Odpowiedź kontraktowa | Konsekwencja wdrożeniowa |
|---|---|---|
| Czy `study.couplings.exchange(region_a, region_b)` jest dozwolone dla dwóch regionów tego samego obiektu? | Tak, ale tylko jako override domyślnego intra-object harmonic mean. Nie tworzy drugiego pola `m` ani object-object coupling. | `CouplingIR` musi mieć `scope = intra_object_region_override | object_object | surface_surface`, a walidacja odrzuca niejednoznaczne endpointy. |
| Czy region material override automatycznie wymusza conformal split? | Nie zawsze. `realization_policy="auto"` w trybie `strict` wybiera conformal/domain marker albo blokuje plan; w `extended` może wybrać projected tylko z jawną diagnostyką. | Planner zapisuje resolved `realization_policy`, a UI pokazuje, czy region jest conformal, projected czy blocked. |
| Czy region mesh policy i material override muszą mieć ten sam shape? | Domyślnie region ma jeden shape bazowy, ale attachment może mieć własny selector tylko jeśli ma własny `attachment_id` i provenance. | Inspector pokazuje attachmenty pod regionem; script export nie miesza `region.shape` z lokalnym hotspotem mesh. |
| Czy overlapping regiony mogą niejawnie tworzyć coupling? | Nie. Overlap rozstrzyga wartości pól i mesh policy; coupling wymaga jawnego endpointu albo domyślnego intra-object exchange między sąsiednimi/materialnymi regionami. | Walidacja overlapów nie buduje `CouplingIR`; runner buduje exchange pair table dopiero z resolved material regions i coupling overrides. |
| Czy airbox może być regionem, endpointem coupling albo właścicielem `Ms/Aex/m`? | Nie. Airbox jest mesh/demag/field domain, nie magnetic material object. | Python DSL, ProblemIR i OpenAPI odrzucają airbox jako owner material parameters, texture albo exchange/RKKY endpoint. |
| Co dokładnie robi delete authored region w istniejącej sesji? | Usuwa authored region i attachmenty z modelu oraz oznacza zależne realized mesh/material/field assets jako stale. Historyczne artefakty nie są ręcznie kasowane. | API zwraca nową model revision i invalidation event; UI Explorer usuwa authored node, a realized assets pokazują stale/provenance do rebuild. |
| Czy `film.regions[0]` jest stabilnym identyfikatorem? | Nie. Indeks jest tylko kolejnością authoringu/prezentacji. Stabilnym kluczem jest `region_id`; skrypt eksportuje nazwę dla czytelności i `region_id` dla regionów UI/migracji. | Dokumentacja DSL i UI nie mogą używać indeksu jako trwałej referencji; delete/reorder nie zmienia `region_id`. |
| Gdzie trafiają edycje regionów z UI? | Przez resource-first authoring transaction z `base_revision`, nie przez lokalny store ani ręczny endpoint w komponencie. | OpenAPI dodaje typed region/coupling transaction requests; `ControlRoomApi` ma jedyne metody write; resource hooks invalidują model resources po revision. |
| Czy UI może dodać region bez shape? | Nie dla authored region. Dozwolony jest tylko realized/diagnostic mesh part bez authored region semantics. | Region create modal wymaga shape albo wyboru istniejącego realized marker jako selector source. |
| Czy material gradient może być ograniczony do regionu? | Tak. To nadal `MaterialParameterFieldIR` z `support = region_id`, nie osobny materiał ani ukryty obiekt. | Sampling fieldów musi stosować priority i support mask; overlap equal priority dla tego samego parametru blokuje. |
| Czy dwa stykające się obiekty mogą mieć zwykły exchange bez explicit coupling, jeśli mają ten sam materiał? | Nie. Granica object-object jest free surface bez `study.couplings.exchange(...)`, niezależnie od podobnych wartości `Ms/Aex`. | Planner nie zgaduje couplingów z nazw/material values; UI może sugerować dodanie coupling, ale nie robi tego automatycznie. |
| Co jeśli explicit object-object coupling nie ma resolved contact? | Solver start jest blokowany. Authored coupling zostaje w modelu jako intencja, ale runtime nie może udawać, że coupling zadziałał. | `ContactInterfaceResolver` zwraca blocker diagnostic z endpointami, tolerancją i powodem braku kontaktu/markera. |
| Czy named-face selectors są częścią v1? | Nie jako publiczny kontrakt. v1 obsługuje bbox face selectors i realized markers; named faces wymagają osobnej specyfikacji v2. | Python DSL może zachować future namespace, ale validator odrzuca unsupported selector z jasnym komunikatem. |
| Jakie pytanie blokuje PR 2, jeżeli zostanie bez odpowiedzi? | Każde pytanie, którego odpowiedź zmienia runtime physics, OpenAPI write contract albo backend capability gate. | PR 2 nie może ruszyć, jeżeli sekcje 4.4-4.7 nie mają mappingu do testu/gate albo świadomie deferred punktu. |

---

## 5. Docelowy Python DSL

### 5.1 Nowe publiczne namespace

Docelowe namespace w `packages/fullmag-py/src/fullmag/__init__.py`:

- `fm.shapes`
- `fm.fields`
- `fm.couplings`

`fm.shapes` ma być wspólne dla geometrii i regionów. Istniejące klasy z
`fullmag.model.geometry` zostają, ale publiczny styl ma preferować
`fm.shapes.box`, `fm.shapes.cylinder`, `fm.shapes.arch_waveguide`.

`fm.fields` ma opisywać pola parametrów materiałowych:

- `constant(value)`,
- `linear(base, gradient, frame)`,
- `radial(base, center, radius, inside, outside, frame)`,
- `piecewise(regions, default)`,
- `sampled(values, layout, frame, units)`.

Pierwsza wersja publicznego DSL zamyka `constant`, `linear`, `radial`,
`sampled` oraz region override. `piecewise(regions, default)` zostaje celowo
deferred do wersji po stabilizacji konfliktów overlap i script-export
canonicalizacji; nie jest wymagany do zamknięcia v1 punktów 1-6.

### 5.2 Nowe klasy Python

Pliki:

- `packages/fullmag-py/src/fullmag/model/regions.py`
- `packages/fullmag-py/src/fullmag/model/material_fields.py`
- `packages/fullmag-py/src/fullmag/model/couplings.py`
- `packages/fullmag-py/src/fullmag/model/shapes.py`

Status implementacyjny v1: publiczne namespace `fm.shapes`, `fm.fields` i
`fm.couplings` są osobnymi modułami, natomiast descriptors region/material-field
są skupione w `packages/fullmag-py/src/fullmag/model/structure.py`. Ten układ
jest akceptowany dla v1, bo nie zmienia publicznego kontraktu DSL. Ewentualne
rozbicie na `model/regions.py` i `model/material_fields.py` jest refaktorem
organizacyjnym, nie warunkiem semantycznego zamknięcia punktów 1-6.

Klasy:

- `ObjectRegion`
- `RegionHandle`
- `RegionRegistry`
- `RegionMeshPolicy`
- `RegionMaterialOverride`
- `RegionTextureOverride`
- `MaterialParameterField`
- `ConstantField`
- `LinearField`
- `RadialField`
- `SampledField`
- `ExchangeCoupling`
- `RkkyCoupling`
- `CouplingRegistry`

### 5.3 API obiektu

Docelowe użycie:

```python
film = study.geometry(
    fm.shapes.box(size=(2.0e-6, 1.0e-6, 2.0e-9)),
    name="film",
)
film.material.Ms = 7.7e5
film.material.Aex = 1.0e-11
film.material.alpha = 0.1

core = film.add_region(
    "skyrmion_core",
    shape=fm.shapes.cylinder(
        radius=80e-9,
        height=2.0e-9,
        center=(0.0, 0.0, 0.0),
    ),
)
core.mesh.maximum_element_size = 1.0e-9
core.mesh.minimum_element_size = 1.0e-9
core.mesh.transition_distance = 80e-9
core.texture = fm.texture.neel_skyrmion(300e-9, 40e-9, -1, 1, "xy")

film.material.Ms = fm.fields.linear(
    base=7.7e5,
    gradient=(0.0, 2.0e11, 0.0),
    frame="object",
)
```

### 5.4 API dwóch materiałów

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

study.couplings.exchange(
    source=layer_a,
    target=layer_b,
    mode="harmonic_mean",
    scale=1.0,
)
study.couplings.rkky(
    source=layer_a.surface("top"),
    target=layer_b.surface("bottom"),
    J1=-0.3e-3,
)
```

### 5.5 API ostrego regionowego skoku parametru

```python
film = study.geometry(
    fm.shapes.box(size=(2.0e-6, 1.0e-6, 2.0e-9)),
    name="film",
)
left = film.add_region(
    "left_half",
    shape=fm.shapes.box(
        size=(1.0e-6, 1.0e-6, 2.0e-9),
        center=(-0.5e-6, 0.0, 0.0),
    ),
)
left.material.Aex = 8.0e-12
left.material.realization = "conformal"
```

W trybie `strict` bez `realization="conformal"` planner powinien odrzucić
skokowy override w FEM, jeśli region przecina elementy i nie ma domain marker.

### 5.6 Rejestr regionów

Wymagany kontrakt:

- `film.regions["skyrmion_core"]` zwraca `RegionHandle`.
- `film.regions[0]` zwraca pierwszy region w kolejności authoringu.
- `study.regions["film/skyrmion_core"]` jest read-only flattened registry.
- `region.delete()` usuwa region i jego attachmenty.
- `film.remove_region("skyrmion_core")` usuwa region z walidacją zależności.
- `film.rename_region("old", "new")` aktualizuje referencje nazwowe.
- `region.region_id` jest stabilnym identyfikatorem typu primary key: przydziela
  go rejestr ownera, rename go nie zmienia, a skasowane id nie jest ponownie
  używane w tej samej scenie/sesji.
- UI/backend create może pominąć `region_id`; rejestr przydziela kolejny wolny
  identyfikator typu `owner:r1`, `owner:r2`, ... . Jawne `region_id` jest
  używane przy imporcie, migracji i round-trip, gdzie trzeba zachować istniejącą
  tożsamość.
- Skrypt eksportuje nazwy, runtime używa stabilnych id.

### 5.7 Zmiany w istniejących plikach Python

Pliki do zmiany:

- `packages/fullmag-py/src/fullmag/model/structure.py`
  - rozdzielić stary `Region` od nowego `ObjectRegion`,
  - dodać mutable authoring handles albo owner-side registry,
  - zostawić kompatybilność `Region(name, geometry)` jako legacy body region.
- `packages/fullmag-py/src/fullmag/model/problem.py`
  - serializować authored regions, fields i couplings,
  - walidować unikalność regionów w owner object,
  - materializować compatibility fields tylko w starym IR path.
- `packages/fullmag-py/src/fullmag/model/geometry.py`
  - przenieść publiczne primitive factory do `fm.shapes`,
  - dodać `center` do region shapes bez wymuszania translate wrapper w skrypcie.
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
  - eksportować `add_region`, `fm.fields.*` i `study.couplings.*`.
- `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
  - dodać SceneDocument region sections do builder round-trip.
- `packages/fullmag-py/src/fullmag/__init__.py`
  - eksportować publiczne namespace tylko po stabilizacji testów.

### 5.8 Testy Python

Minimalne testy:

- konstrukcja regionu z box/cylinder,
- region name empty -> błąd,
- duplicate region name w obiekcie -> błąd,
- `study.regions` read-only,
- rename zachowuje `region_id`,
- delete usuwa mesh/material/texture attachments,
- `fm.fields.linear` waliduje SI i finite values,
- gradient field serializuje się do IR descriptor,
- sampled field bez layout -> błąd,
- object-object coupling serializuje się do IR,
- airbox nie przyjmuje material/magnetization attachment.

---

## 6. ProblemIR

### 6.1 Obecny stan

`crates/fullmag-ir/src/model.rs` ma:

- `GeometryIR`,
- `GeometryEntryIR`,
- legacy `RegionIR { name, geometry }`,
- `MaterialIR`,
- `MagnetIR`.

`MaterialIR` ma już pola typu `ms_field`, `a_field`, `alpha_field`, ale są to
zrealizowane listy wartości. To nie jest wystarczające dla publicznego intentu,
bo nie opisuje źródła pola, ramki odniesienia, regionu, priorytetu ani polityki
projekcji.

Decyzja: istniejące `MaterialIR.*_field` traktujemy jako realized/runtime
payload i compatibility surface, nie jako authored model. Nowy authored intent
musi przejść przez `MaterialParameterAssignmentIR` / `MaterialParameterFieldIR`
z provenance, frame, ownerem i conflict policy. Eksport skryptu i UI nie mogą
tworzyć authored regionów przez bezpośrednie wpisywanie zrealizowanych tablic do
`MaterialIR`.

### 6.2 Nowe typy IR

Plik: `crates/fullmag-ir/src/model.rs`

Dodać:

```rust
pub struct ObjectRegionIR {
    pub region_id: String,
    pub owner_object: String,
    pub name: String,
    pub shape: RegionShapeIR,
    pub frame: RegionFrameIR,
    pub enabled: bool,
    pub priority: i32,
    pub mesh_policy: Option<RegionMeshPolicyIR>,
    pub material_overrides: Vec<RegionMaterialOverrideIR>,
    pub texture_override: Option<RegionTextureOverrideIR>,
    pub realization_policy: RegionRealizationPolicyIR,
}
```

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RegionShapeIR {
    Box {
        size: [f64; 3],
        center: [f64; 3],
    },
    Cylinder {
        radius: f64,
        height: f64,
        center: [f64; 3],
        axis: [f64; 3],
    },
    Sphere {
        radius: f64,
        center: [f64; 3],
    },
    Csg {
        expression: Box<GeometryEntryIR>,
    },
}
```

```rust
#[serde(rename_all = "snake_case")]
pub enum RegionFrameIR {
    Object,
    World,
}
```

```rust
#[serde(rename_all = "snake_case")]
pub enum RegionRealizationPolicyIR {
    Inherit,
    Conformal,
    Project,
}
```

```rust
pub struct RegionMaterialOverrideIR {
    pub parameter: MaterialParameterNameIR,
    pub value: MaterialParameterFieldIR,
    pub priority: i32,
    pub conflict_policy: RegionConflictPolicyIR,
}
```

```rust
#[serde(rename_all = "snake_case")]
pub enum MaterialParameterNameIR {
    Ms,
    Aex,
    Alpha,
    Ku1,
    Ku2,
    AnisotropyAxis,
    Kc1,
    Kc2,
    Kc3,
    Dind,
    Dbulk,
}
```

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MaterialParameterFieldIR {
    Constant {
        value: serde_json::Value,
    },
    Linear {
        base: f64,
        gradient: [f64; 3],
        frame: RegionFrameIR,
    },
    Radial {
        center: [f64; 3],
        radius: f64,
        inside: f64,
        outside: f64,
        frame: RegionFrameIR,
    },
    Sampled {
        asset_id: String,
        component_count: u32,
        location: MaterialFieldLocationIR,
        unit: String,
    },
}
```

```rust
#[serde(rename_all = "snake_case")]
pub enum MaterialFieldLocationIR {
    Cell,
    Node,
    Element,
    Quadrature,
}
```

```rust
#[serde(rename_all = "snake_case")]
pub enum RegionConflictPolicyIR {
    Error,
    HigherPriorityWins,
    MinMeshSizeWins,
}
```

```rust
pub struct CouplingIR {
    pub coupling_id: String,
    pub kind: CouplingKindIR,
    pub source: CouplingEndpointIR,
    pub target: CouplingEndpointIR,
    pub enabled: bool,
    pub parameters: CouplingParametersIR,
    pub capability_policy: CouplingCapabilityPolicyIR,
}
```

```rust
#[serde(rename_all = "snake_case")]
pub enum CouplingKindIR {
    Exchange,
    Rkky,
    InterlayerExchange,
}
```

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CouplingEndpointIR {
    Object {
        object: String,
    },
    Region {
        object: String,
        region_id: String,
    },
    Surface {
        object: String,
        selector: String,
    },
}
```

```rust
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CouplingParametersIR {
    Exchange {
        mode: ExchangeCouplingModeIR,
        scale: Option<f64>,
        inter_exchange: Option<f64>,
    },
    Rkky {
        j1: f64,
    },
    InterlayerExchange {
        j1: f64,
        j2: Option<f64>,
    },
}
```

```rust
#[serde(rename_all = "snake_case")]
pub enum ExchangeCouplingModeIR {
    HarmonicMean,
    Explicit,
    Disabled,
}
```

### 6.3 Miejsce w `ProblemIR`

Docelowo:

```rust
pub struct ProblemIR {
    pub geometry: GeometryIR,
    pub object_regions: Vec<ObjectRegionIR>,
    pub materials: Vec<MaterialIR>,
    pub material_parameter_fields: Vec<MaterialParameterAssignmentIR>,
    pub couplings: Vec<CouplingIR>,
    pub magnets: Vec<MagnetIR>,
}
```

Jeżeli obecna struktura `ProblemIR` jest w `crates/fullmag-ir/src/lib.rs`,
zmiany muszą być dodane tam, a `model.rs` powinien tylko definiować typy.

### 6.4 Legacy compatibility

Stary `RegionIR` zostaje w pierwszym etapie jako `BodyRegionIR` albo legacy
adapter i powinien zostać oznaczony jako deprecated na poziomie dokumentacji i
typów, jeśli Rust API na to pozwala. Nie wolno go rozszerzać do authored
regionów, bo jego semantyka to `name + geometry`, a nie region wewnątrz owner
object.

Plan migracji:

1. Dodać nowe `object_regions`.
2. Zostawić `regions` dla starych magnet/geometry bindings.
3. Planner normalizuje `object_regions` oddzielnie od `regions`.
4. OpenAPI pokazuje authored regions jako nowe resources.
5. Realized regions zachowują osobny resource i source/provenance.
6. Po stabilizacji usunąć publiczne użycia legacy `RegionIR`.

### 6.5 Walidacja IR

Pliki:

- `crates/fullmag-ir/src/validation.rs`
- `crates/fullmag-ir/tests/ir_tests.rs`

Reguły:

- `object_regions.owner_object` musi wskazywać istniejący object/magnet.
- `region_id` musi być stabilne i unikalne globalnie.
- `name` musi być unikalne w obrębie owner object.
- `shape` musi mieć dodatnie rozmiary.
- `frame` musi być obsługiwany.
- `priority` może być dowolnym `i32`, ale equal-priority conflicts muszą być
  wykrywane na poziomie planner/material realization.
- Material parameter name musi być zgodny z typem wartości.
- `Ms`, `Aex`, `alpha` muszą być dodatnie lub nieujemne zgodnie z fizyką.
- `Dind` i `Dbulk` mogą mieć znak.
- `anisotropy_axis` musi być niezerowym wektorem.
- Airbox nie może być endpointem material parameter override.
- Coupling endpoints muszą istnieć.
- RKKY endpoint musi być surface/object boundary endpoint, nie airbox.
- Region texture override może dotyczyć tylko initial magnetization.

### 6.6 Normalizacja IR

Normalizacja powinna:

- kompresować solver-local region indices,
- zachować publiczne `region_id`,
- rozwinąć nazwowe references do id,
- ustalić priority order,
- oznaczyć konflikty overlap,
- wyprowadzić `requires_mesh_rebuild`,
- wyprowadzić `requires_material_field_realization`,
- oznaczyć `requires_conformal_region_boundary`.

Status implementacyjny v1: `fullmag-ir` odpowiada za typowanie, walidację i
zachowanie publicznych `region_id`; nie jest właścicielem plannerowych
freshness/capability flags. Wyprowadzenie `requires_mesh_rebuild`,
`requires_material_field_realization` i `requires_conformal_region_boundary`
jest realizowane w warstwach planner/authoring/runtime diagnostics, gdzie znany
jest aktualny mesh, tryb wykonania i asset provenance. Dla punktów 1-6 wymagane
jest więc: typed IR, walidacja IR i stabilne id/reference semantics; pełne
runtime freshness/capability metadata należy audytować w sekcjach 7-19.

---

## 7. Planner i capability matrix

### 7.1 Pliki

- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-plan/src/validate.rs`
- `crates/fullmag-plan/src/mesh.rs`
- `crates/fullmag-plan/src/fdm.rs`
- `crates/fullmag-plan/src/fem.rs`
- `crates/fullmag-plan/src/geometry.rs`
- `crates/fullmag-plan/src/tests.rs`

### 7.2 Nowy etap planowania

Dodać etap:

```text
ProblemIR
  -> validate authored regions
  -> resolve material object ownership
  -> resolve region selectors
  -> resolve material parameter fields
  -> resolve couplings
  -> resolve conformal/projected realization
  -> emit mesh/material/runtime plan
```

### 7.3 Plan material field

Planner powinien wyprodukować neutralny opis:

- `MaterialFieldPlan`
  - `object_id`,
  - `parameter`,
  - `source_kind`,
  - `realization_location`,
  - `requires_sampling`,
  - `requires_mesh_revision`,
  - `warnings`.

Dla FDM:

- `location = cell`,
- sampling w cell centers,
- region masks jako boolean/cell index arrays,
- interface tables dla exchange.

Dla FEM:

- `location = node`, `element` albo `quadrature`,
- pierwsza wersja: node albo element, zależnie od operatora,
- `projection_mode = conformal | projected`,
- raport, czy ostry region boundary przecina tetrahedry.

### 7.4 Capability checks

Nowe capabilities:

- `material_fields.constant`,
- `material_fields.linear`,
- `material_fields.radial`,
- `material_fields.sampled`,
- `regions.authored_object_regions`,
- `regions.mesh_policy`,
- `regions.material_override`,
- `regions.texture_override`,
- `regions.conformal_boundary`,
- `regions.projected_boundary`,
- `couplings.exchange_object_object`,
- `couplings.exchange_region_region`,
- `couplings.rkky_surface_surface`,
- `quantity_scoping.airbox_excludes_m`.

Planner w `strict`:

- odrzuca unsupported coupling,
- odrzuca unsupported material field,
- odrzuca sharp FEM projected jump bez jawnej polityki.

Planner w `extended`:

- może dopuścić projection z warningiem,
- może zachować authored-only coupling/provenance w modelu,
- nie może wystartować runtime z unsupported couplingiem wymagającym fizycznego
  operatora; RKKY/interlayer unsupported blokuje planning/solver start,
- nie może cicho skasować intentu.

### 7.5 Testy planner

Testy w `crates/fullmag-plan/src/tests.rs`:

1. `fdm_linear_ms_field_plans_cell_sampling`.
2. `fem_linear_ms_field_plans_coefficient_sampling`.
3. `fem_sharp_aex_region_requires_conformal_in_strict`.
4. `fem_sharp_aex_region_allows_projection_in_extended_with_warning`.
5. `intra_object_region_exchange_defaults_harmonic_mean`.
6. `object_object_exchange_without_coupling_defaults_none`.
7. `object_object_exchange_with_harmonic_mean_coupling_builds_pair_table`.
8. `exchange_scale_zero_disables_interface_exchange`.
9. `rkky_unsupported_blocks_runtime_plan`.
10. `rkky_endpoint_rejects_airbox`.
11. `airbox_rejects_m_quantity_scope`.
12. `legacy_region_ir_remains_body_binding`.
13. `authored_region_ids_are_preserved_after_name_change`.

---

## 8. SceneDocument i authoring model

### 8.1 Obecny stan

`crates/fullmag-authoring/src/scene.rs` ma:

- `SceneDocument`,
- `SceneObject`,
- `SceneMaterialAsset`,
- `MagnetizationAsset`,
- `SceneRegionOverride` z samym `magnetization_ref`,
- `region_name` na obiekcie,
- `region_overrides` jako mapa.

To obecnie miesza:

- body region name,
- object-derived realized region,
- magnetization override.

### 8.2 Docelowy SceneDocument

Dodać do `SceneObject`:

```rust
pub regions: Vec<SceneObjectRegion>,
```

Nowe typy:

```rust
pub struct SceneObjectRegion {
    pub region_id: String,
    pub name: String,
    pub enabled: bool,
    pub priority: i32,
    pub shape: SceneRegionShape,
    pub frame: String,
    pub mesh_policy: Option<SceneRegionMeshPolicy>,
    pub material_overrides: Vec<SceneRegionMaterialOverride>,
    pub texture_override: Option<SceneRegionTextureOverride>,
    pub realization_policy: String,
    pub visible: bool,
    pub locked: bool,
}
```

`SceneRegionOverride` może zostać jako compatibility adapter, ale nowy UI nie
powinien go używać jako głównego modelu.

### 8.3 Scene schema version

Obecnie `version = "scene.v1"`. Region-owned authoring powinno podnieść schema
do:

```text
scene.v2
```

Migracja:

- `scene.v1` bez `objects[].regions` dostaje region domyślny tylko jako
  realized/body compatibility, nie jako authored child region.
- `objects[].region_name` zostaje mapowane na object body region label.
- `region_overrides` zostają mapowane do `SceneObjectRegion` tylko jeżeli mają
  wystarczające dane shape; w przeciwnym razie zostają legacy.

### 8.4 Authoring adapters

Pliki:

- `crates/fullmag-authoring/src/adapters.rs`
- `crates/fullmag-authoring/src/validation.rs`
- `crates/fullmag-authoring/src/geometry.rs`
- `packages/fullmag-py/src/fullmag/runtime/scene_document.py`

Zmiany:

- `scene_document_from_script_builder` musi przenieść Python-authored regions
  do `SceneObject.regions`.
- `scene_document_to_script_builder` musi zachować regiony w builder model.
- `scene_document_to_script_builder_overrides` musi serializować regions,
  fields i couplings.
- `build_scene_document_from_builder` w Python musi wypełniać `objects[].regions`.
- `build_builder_from_scene_document` musi odtwarzać regiony bez utraty id.

### 8.5 Validation diagnostics

Nowe diagnostyki:

- `REGION_NAME_DUPLICATE_IN_OBJECT`,
- `REGION_SHAPE_INVALID`,
- `REGION_OUTSIDE_OWNER_BOUNDS`,
- `REGION_OVERLAP_SAME_PARAMETER_EQUAL_PRIORITY`,
- `REGION_MATERIAL_OVERRIDE_REQUIRES_MATERIAL_OBJECT`,
- `REGION_SHARP_PARAMETER_REQUIRES_CONFORMAL_POLICY`,
- `COUPLING_ENDPOINT_NOT_FOUND`,
- `COUPLING_ENDPOINT_KIND_UNSUPPORTED`,
- `AIRBOX_MAGNETIC_PARAMETER_FORBIDDEN`.

Każda diagnostyka musi mieć:

- stable `id`,
- `code`,
- `severity`,
- `object_id`,
- optional `region_id`,
- JSON pointer path,
- `blocks` list, np. `build_mesh`, `run_solver`, `export_script`.

---

## 9. Meshing

### 9.1 Pliki Python meshing

- `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
- `packages/fullmag-py/src/fullmag/meshing/_mesh_targets.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_selectors.py`
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`

### 9.2 Region mesh policy

Region mesh policy niżej staje się size field z owner provenance:

```json
{
  "source": "object_region",
  "owner_object_id": "film",
  "region_id": "reg_skyrmion_core",
  "region_name": "skyrmion_core",
  "field_kind": "region_distance_threshold",
  "hmax": 1e-9,
  "hmin": 1e-9,
  "transition_distance": 8e-8
}
```

Reguły:

- mesh overlap wygrywa mniejszy rozmiar,
- material overlap nie może używać tej samej reguły,
- region mesh field nie może działać poza owner object, chyba że użytkownik
  jawnie wybierze interface/air padding policy,
- size field report musi pokazać authored source.

### 9.3 Conformal material region boundary

Docelowy conformal path:

1. Region shape jest przekształcany do CAD/CSG w local frame owner object.
2. Owner object jest fragmentowany region boundary.
3. Powstają sub-volumes albo domain markers.
4. Mesh zachowuje granicę.
5. `FemDomainRegionMarkerIR` dostaje material field/domain identity.
6. Mesh report pokazuje `realization = conformal`.

Minimalna pierwsza wersja:

- obsłużyć box/cylinder region inside box/flat arch waveguide,
- ograniczyć conformal split do aligned box-in-box i z-aligned cylinder-in-box,
- dla innych shape wymagać projection albo blokować w strict,
- jeśli conformal split przejdzie geometrycznie, ale mesh quality/degenerate
  tetra gate failuje, solver start jest blokowany i report sugeruje projection
  mode albo uproszczenie region shape. Nie wolno cicho fallbackować na
  projected sharp jump.

### 9.4 Projection mode

Projection mode:

- nie zmienia geometrii,
- próbuje sample'ować coefficient field na node/element centers,
- generuje warning,
- mesh report zapisuje `realization = projected`,
- strict mode blokuje, extended mode dopuszcza.

Projection jest akceptowalny dla gładkich pól. Nie powinien być domyślny dla
ostrych skoków `Aex`, `Ms`, `Dind`.

Nota fizyczna musi opisać błąd projection mode. Minimalny kontrakt v1:

- projection jest akceptowalny dla gładkich pól i łagodnych zmian parametrów,
- projection ostrego `Aex`/`Ms` jest eksperymentalny i wymaga explicit policy,
- duże kontrasty materiałowe, DMI na interfejsie, RKKY/contact exchange i
  walidacja publikacyjna wymagają conformal boundary,
- mesh report musi pokazać, które region boundaries zostały tylko
  sprojektowane na istniejące elementy.

### 9.5 Mesh build report

`mesh_build_report.py` i API report muszą dodać:

- authored region count,
- realized region count,
- per-region nodes/elements/tetrahedra,
- region realization mode,
- material field realization mode,
- conformal split status,
- projection warnings,
- overlap diagnostics,
- size field sources,
- coupling endpoints resolved,
- airbox magnetic quantity exclusions.

### 9.6 Degenerate tetrahedra gate

Ponieważ ostatnie problemy z meshem obejmowały degenerate tetrahedra, region
meshing musi mieć twarde gate:

- każda conformal fragmentation path uruchamia walidację pozytywnej objętości,
- elementy o objętości poniżej `eps_volume` blokują solver,
- mesh report podaje liczbę odrzuconych/degenerate elements,
- frontend pokazuje błąd w mesh rebuild dialog.

### 9.7 Testy meshing

Python tests:

- box object + cylindrical region mesh refinement,
- region size field nie działa w airboxie bez jawnej polityki,
- conformal split tworzy dwa domain markers,
- projection mode generuje warning,
- overlap mesh hmin wybiera mniejszy h,
- mesh report zachowuje `region_id`,
- histogram/quality może filtrować per region,
- airbox report nie przypisuje `m` ani material parameters.

Rust planner tests:

- region marker mapping zachowuje material id,
- shared interface nodes są przypisane do material boundary,
- mesh part node indices obejmują region bez airbox contamination.

---

## 10. Material parameter realization

### 10.1 Zasada główna

Publiczny intent musi przejść przez trzy poziomy:

```text
MaterialParameterFieldIR
  -> MaterialFieldPlan
  -> RealizedMaterialFieldAsset
```

Nie wolno od razu wpisywać `Vec<f64>` do `MaterialIR` na etapie authoringu,
bo tracimy:

- źródło,
- ramkę,
- priorytet,
- region owner,
- policy conformal/projection,
- provenance,
- możliwość ponownego sample po remesh.

### 10.2 Realized field assets

Dodać assety:

- `MaterialFieldAssetIR`,
- `MaterialFieldSamplingReportIR`,
- `MaterialFieldProvenanceIR`.

Pola:

- `asset_id`,
- `parameter`,
- `owner_object_id`,
- `source_region_id`,
- `mesh_id`,
- `mesh_generation_id`,
- `location`,
- `component_count`,
- `unit`,
- `values`,
- `min`,
- `max`,
- `mean`,
- `provenance`.

W JSON status nie wolno przenosić pełnych `values`. Pełne wartości idą jako
artifact albo binary data-plane resource, jeśli UI ich potrzebuje.

### 10.3 FDM realization

FDM:

- sample w cell centers,
- active mask z geometrii,
- region index per cell,
- `Ms`, `Aex`, `alpha`, `Ku` jako cell fields,
- exchange interface table dla par regionów,
- `m` tylko w active magnetic cells.

Dwa obiekty magnetyczne w jednej siatce FDM nie uruchamiają dwóch ukrytych
backendów. Plan runtime dla FDM v1 to jeden grid/plan z:

- wspólnym `active_mask`,
- per-cell `object_id`/region index,
- cellwise material fields (`Ms`, `Aex`, `alpha`, ...),
- jawnie zbudowaną tabelą `exchange_pairs`.

Brak wpisu `exchange_pairs` między dwoma różnymi obiektami oznacza free surface.
Wpis między regionami tego samego obiektu jest tworzony domyślnie jako
harmonic mean, chyba że użytkownik go nadpisze.

FDM exchange między regionami:

- same region -> local `Aex`,
- different region -> `inter_exchange` jeżeli explicit,
- otherwise harmonic mean,
- multiply by `scale`,
- `scale=0` wyłącza exchange.

### 10.4 FEM realization

FEM:

- preferowany coefficient na elementach lub quadrature,
- node field tylko gdy operator tego wymaga,
- `Ms(x)` wpływa na denominatory effective field,
- `A(x)` wchodzi w weak form exchange,
- sharp boundary wymaga domain marker,
- projection mode musi być jawnie oznaczony.

FEM runtime plan musi nieść:

- `region_marker -> material_field_asset`,
- `element_marker -> material_id`,
- `boundary_marker -> coupling_id`,
- interface normal/provenance dla przyszłych surface terms.

### 10.5 Integracja z backendami

Rust/native miejsca do audytu przed implementacją:

- `crates/fullmag-runner`,
- `crates/fullmag-engine`,
- `backends/fem`,
- native FEM material coefficient upload path,
- FDM CPU material arrays,
- FDM GPU material arrays.

Reguła build:

- FEM/MFEM/CUDA/hypre/libCEED proof przez repo `justfile`, np.
  `just ensure-managed-fem-runtime`, `just rebuild-fem-runtime`,
  `just fem-gpu-headless` albo właściwy managed recipe.
- Host-side `cargo` jest tylko smoke/diagnostic, nie final proof.

---

## 11. Couplings

### 11.1 Model docelowy

Coupling jest globalny albo owner-scoped, ale semantycznie jest oddzielny od
materiału.

Decyzja:

- publiczny model: `study.couplings`,
- convenience alias: `object.interfaces` może tworzyć wpis w
  `study.couplings` z owner context,
- IR przechowuje globalną listę `couplings`.

### 11.2 Exchange coupling

Parametry:

- `mode = harmonic_mean | explicit | disabled`,
- `scale`,
- `inter_exchange`,
- `source`,
- `target`,
- `scope = object | region | surface`.

Walidacja:

- `disabled` wymaga `scale=0` albo canonical disabled mode,
- `explicit` wymaga `inter_exchange`,
- `harmonic_mean` nie może mieć `inter_exchange`,
- endpoints muszą być magnetyczne,
- airbox endpoint jest błędem.

Default:

- region-region wewnątrz jednego obiektu: implicit harmonic mean,
- object-object: implicit none/free surface,
- object-object harmonic mean wymaga jawnego
  `study.couplings.exchange(obj_a, obj_b, mode="harmonic_mean")`.

### 11.2.1 Surface selector resolution

V1 obsługuje tylko selektory bbox-face:

- `surface("top")` -> face z maksymalnym `z` w ramce obiektu,
- `surface("bottom")` -> minimalne `z`,
- `surface("left/right/front/back")` -> odpowiednie osie bbox,
- tolerancja jest częścią realized selector provenance.

FDM realization:

- selector filtruje exposed/contact cell faces z active/object masks,
- object-object coupling rozwiązuje się do par sąsiadujących komórek po obu
  stronach interfejsu,
- jeżeli nie ma sąsiedztwa ani jawnego spacer model, planner zgłasza brak
  realizowalnego interfejsu.

FEM realization:

- selector rozwiązuje się do boundary face markers w shared-domain mesh,
- object-object contact wymaga wspólnej boundary/domain marker w conformal mesh,
- jeśli mesh nie ma markerów dla endpointów, coupling jest unsupported i run
  jest blokowany.

Named faces, selectors oparte o feature tags i nieregularne surfaces są v2, nie
scope v1.

### 11.3 RKKY/interlayer

Pierwszy publiczny model:

- `J1` w J/m^2,
- optional `J2` deferred,
- endpoints surface-surface,
- required surface selector,
- runtime capability required.

W pierwszej implementacji można:

- zapisać authored/provenance,
- pokazać w UI,
- odrzucić runtime w plannerze, jeśli backend nie wspiera,
- zablokować solver start dla unsupported RKKY,
- dodać test, że intencja nie znika i że unsupported RKKY nie przechodzi jako
  warning-only.

### 11.4 UI coupling view

UI musi pokazać coupling jako osobną gałąź:

```text
Physics
  Couplings
    layer_a ↔ layer_b exchange
    layer_a/top ↔ layer_b/bottom RKKY
```

Nie wolno ukrywać couplingów jako property w materiale.

---

## 12. OpenAPI v2 i zasoby

### 12.1 Rodziny endpointów

Wykorzystać istniejącą rodzinę `model` i `meshing`.

Nowe albo rozszerzone endpointy:

```text
GET    /v2/sessions/current/model/scene
POST   /v2/sessions/current/model/objects/{object_id}/regions
PATCH  /v2/sessions/current/model/objects/{object_id}/regions/{region_id}
DELETE /v2/sessions/current/model/objects/{object_id}/regions/{region_id}
POST   /v2/sessions/current/model/objects/{object_id}/regions/{region_id}/duplicate
POST   /v2/sessions/current/model/objects/{object_id}/regions/reorder
GET    /v2/sessions/current/model/regions
GET    /v2/sessions/current/model/couplings
POST   /v2/sessions/current/model/couplings
PATCH  /v2/sessions/current/model/couplings/{coupling_id}
DELETE /v2/sessions/current/model/couplings/{coupling_id}
GET    /v2/sessions/current/model/material-fields
GET    /v2/sessions/current/model/region-diagnostics
```

Uwaga: `GET /model/regions` obecnie czyta object-derived region resources.
Trzeba rozdzielić:

- authored regions,
- realized regions.

Decyzja:

```text
GET /v2/sessions/current/model/regions
```

zwraca authored regions.

```text
GET /v2/sessions/current/model/geometry/realizations/current
```

zwraca realized region candidates.

```text
GET /v2/sessions/current/meshing/meshes/{mesh_id}/regions
```

zwraca realized mesh/material regions.

Jeżeli zmiana obecnego endpointu byłaby zbyt ryzykowna, dodać tymczasowo:

```text
GET /v2/sessions/current/model/authored-regions
GET /v2/sessions/current/model/realized-regions
```

z jasnym removal criterion.

### 12.2 Schematy OpenAPI

Plik:

- `crates/fullmag-api/src/schemas/authoring.rs`

Nowe typy:

- `ObjectRegionResource`,
- `ObjectRegionCreateRequest`,
- `ObjectRegionPatchRequest`,
- `ObjectRegionDuplicateRequest`,
- `ObjectRegionReorderRequest`,
- `RegionShapeResource`,
- `RegionMeshPolicyResource`,
- `RegionMaterialOverrideResource`,
- `MaterialParameterFieldResource`,
- `RegionTextureOverrideResource`,
- `CouplingResource`,
- `CouplingCreateRequest`,
- `CouplingPatchRequest`,
- `RegionDiagnosticsResource`.

Każdy write request musi mieć:

- `base_revision`,
- stable id albo id generated server-side,
- validation error path.

### 12.3 Resource invalidation

Zmiana regionu invaliduje:

- `model/scene`,
- `model/regions`,
- `model/geometry/validation`,
- `model/geometry/diagnostics`,
- `model/geometry/realizations/current`,
- mesh policy resources,
- mesh build stale state,
- visualization target registry.

Zmiana material field invaliduje:

- `model/scene`,
- `model/materials` albo `model/material-fields`,
- planner capability diagnostics,
- mesh only jeśli realization wymaga conformal boundary,
- solver runtime state always stale.

Zmiana coupling invaliduje:

- `model/couplings`,
- planner diagnostics,
- solver runtime state,
- field quantities involving exchange energy/effective field.

### 12.4 Generated frontend types

Po zmianie OpenAPI:

```bash
pnpm --dir apps/control-room generate:api
```

Nie wolno ręcznie edytować:

- `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`,
- `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`,
- generated type files.

---

## 13. ControlRoomApi i resource hooks

### 13.1 Pliki

- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- `apps/control-room/src/kernel/api/apiTypes.ts`
- `apps/control-room/src/kernel/api/apiPaths.ts`
- `apps/control-room/src/kernel/resources/ResourceRuntimeStore.ts`
- `apps/control-room/src/kernel/resources/useResource.ts`
- nowe `apps/control-room/src/kernel/resources/modelRegionResources.ts`
- nowe `apps/control-room/src/kernel/resources/couplingResources.ts`

### 13.2 Handwritten facade

Dodać `ControlRoomApi.model.regions`:

- `listObjectRegions()`,
- `createObjectRegion(objectId, request)`,
- `patchObjectRegion(objectId, regionId, patch)`,
- `deleteObjectRegion(objectId, regionId, request)`,
- `duplicateObjectRegion(objectId, regionId, request)`,
- `reorderObjectRegions(objectId, request)`.

Dodać `ControlRoomApi.model.couplings`:

- `listCouplings()`,
- `createCoupling(request)`,
- `patchCoupling(couplingId, patch)`,
- `deleteCoupling(couplingId, request)`.

Nie wolno wołać generated transport bezpośrednio z modułów.

### 13.3 Resource hooks

Resource hooks:

- `useModelRegionsResource(sceneRevision)`,
- `useObjectRegionsResource(objectId, sceneRevision)`,
- `useRegionDiagnosticsResource(sceneRevision)`,
- `useCouplingsResource(sceneRevision)`,
- `useMaterialFieldsResource(sceneRevision)`,
- `useMeshRegionsResource(meshGenerationId)`.

Każdy hook musi mieć:

- key z revision,
- abort handling,
- stale state,
- degraded/error state,
- explicit reload.

### 13.4 State ownership

Server resources:

- scene,
- regions,
- couplings,
- material field descriptors,
- mesh realization,
- diagnostics.

Kernel UI state:

- selection,
- active module,
- command palette.

Module draft state:

- region inspector draft,
- material field draft,
- coupling draft.

Nie wolno trzymać pełnych scene/mesh/field payloads w module store.

---

## 14. Frontend Explorer

### 14.1 Obecny stan

`apps/control-room/src/modules/explorer/builders/buildModelTree.ts` buduje
gałąź `Regions`, ale obecnie jest to syntetyczny jeden region na object.

### 14.2 Docelowe drzewo

```text
Objects
  film
    Geometry
    Magnetic Parameters
      Material: film material
      Exchange
      Demag
      Interfacial DMI
    Texture
    Mesh
    Visualization
    Regions
      skyrmion_core
        Geometry
        Magnetic Parameters
          Material Overrides
          Exchange Overrides
          Interface Couplings
        Texture
        Mesh
        Visualization
        Regions
      edge_softening
        Geometry
        Magnetic Parameters
          Material Overrides
          Exchange Overrides
          Interface Couplings
        Texture
        Mesh
        Visualization
        Regions
Physics
  Couplings
    film ↔ reference exchange
    layer_a/top ↔ layer_b/bottom RKKY
```

Region node ma wyglądać i zachowywać się jak sub-obiekt authoringowy. Różnica
jest semantyczna, nie UI-owa: region nie tworzy drugiego pola `m` i nie jest
osobnym material object, ale może mieć własną geometrię selektora, lokalne
parametry magnetyczne, texture override, mesh policy, visualization override i
podrzędne regiony. Dlatego Explorer nie może pokazywać regionów jako płaskiej
listy pod `Regions`; musi pokazywać region jako subtree z tym samym układem
kategorii, co obiekt rodzic.

Domyślna semantyka regionu to inheritance-first: wszystkie sekcje regionu
dziedziczą efektywne wartości z rodzica, dopóki użytkownik nie doda lokalnego
override. Typowe override'y v1 to lokalne zagęszczenie meshu, lokalne parametry
materiałowe, lokalna tekstura początkowa, lokalny display overlay i lokalne
interface/coupling overrides. UI musi pokazywać stan `inherited` jako pierwszy
stan każdej sekcji, a nie kopiować wartości rodzica do regionu jako authored
payload.

`Regions` pod regionem jest dozwolone dla hierarchicznego authoringu, ale v1
może ograniczyć głębokość do jednego poziomu capability gate. Jeżeli v1 nie
obsługuje nested regions, node `Regions` pozostaje widoczny jako disabled/empty
z diagnostyką `nested_regions_unsupported`, a nie znika z modelu UI.

### 14.3 Node model

Rozszerzyć explorer types:

- `object.region.root`,
- `object.region.geometry`,
- `object.region.magnetic-parameters`,
- `object.region.mesh`,
- `object.region.texture`,
- `object.region.visualization`,
- `object.region.regions`,
- `object.region.diagnostics`,
- `physics.coupling`.

Node fields:

- `objectId`,
- `regionId`,
- `couplingId`,
- `diagnosticSeverity`,
- `meshStatus`,
- `materialOverrideCount`,
- `textureStatus`.

### 14.4 Context commands

Region node:

- Add Region,
- Rename Region,
- Duplicate Region,
- Delete Region,
- Move Priority Up,
- Move Priority Down,
- Toggle Overlay,
- Focus Region,
- Build Mesh,
- Open Diagnostics.

Coupling node:

- Edit Coupling,
- Disable Coupling,
- Delete Coupling,
- Focus Endpoints,
- Open Capability Diagnostics.

### 14.5 Tests

- explorer shows zero authored regions as empty `Regions` group,
- explorer shows multiple authored regions in owner order,
- explorer shows each region as object-like subtree with `Geometry`,
  `Magnetic Parameters`, `Texture`, `Mesh`, `Visualization` and `Regions`,
- deleting object removes child regions from tree,
- coupling appears under Physics and references endpoints,
- realized mesh regions do not masquerade as authored regions,
- airbox remains separate from object regions.

---

## 15. Frontend Inspector

### 15.1 Region inspector

Nowy inspector dla `object.region.root`:

Region inspector używa tej samej mentalnej struktury co object inspector. Każdy
panel regionu musi jasno pokazać, czy dana wartość jest:

- inherited from parent object,
- locally overridden on region,
- blocked by capability/validation,
- realized from mesh/materialization.

Region panels:

1. Geometry
   - selector shape,
   - size/radius/height,
   - center,
   - axis,
   - frame,
   - transform summary,
   - nested region support status.
2. Magnetic Parameters
   - inherited material summary,
   - local scalar overrides,
   - local parameter fields,
   - exchange override default,
   - interface/coupling endpoints.
3. Texture
   - inherited or override,
   - preset,
   - mapping,
   - transform,
   - initial-condition scope.
4. Mesh
   - enabled,
   - hmax,
   - hmin,
   - transition distance,
   - growth,
   - order,
   - realization mode.
5. Visualization
   - overlay visibility,
   - color,
   - opacity,
   - surface/wireframe/vector display,
   - inherited display defaults.
6. Regions
   - child regions if supported,
   - disabled placeholder and diagnostic if nested regions are capability-gated.
7. Diagnostics
   - validation blockers,
   - overlap,
   - mesh stale,
   - projection warnings.
8. Quality
   - nodes/elements/tetrahedra,
   - histogram scoped to region,
   - min/max element size.

Legacy flat section mapping, jeżeli jakiś panel jeszcze istnieje przejściowo:

1. Identity
   - name,
   - stable region id,
   - owner object,
   - enabled,
   - priority,
   - visibility overlay.
2. Shape
   - shape kind,
   - size/radius/height,
   - center,
   - axis,
   - frame,
   - transform summary.
3. Mesh
   - enabled,
   - hmax,
   - hmin,
   - transition distance,
   - growth,
   - order,
   - realization mode.
4. Material Overrides
   - parameter list,
   - scalar/field kind,
   - units,
   - priority,
   - conflict policy.
5. Texture
   - inherited or override,
   - preset,
   - mapping,
   - transform.
6. Couplings
   - related coupling list,
   - endpoint role.
7. Diagnostics
   - validation blockers,
   - overlap,
   - mesh stale,
   - projection warnings.
8. Quality
   - nodes/elements/tetrahedra,
   - histogram scoped to region,
   - min/max element size.

### 15.2 Draft transaction model

Inspector edits:

- edit local draft,
- validate draft locally,
- commit through command/API,
- on success refresh resource,
- on conflict show base revision mismatch,
- on validation error map path to field.

No direct mutation of server resources in component state.

### 15.3 Info modals

Each advanced field must have `(i)` help:

- Region vs material object,
- Gradient vs region subdivision,
- Conformal boundary,
- Projection mode,
- Exchange scale,
- Inter exchange,
- RKKY `J1`,
- Conflict priority,
- Airbox quantity scope.

The modal must use shared dialog/tooltip primitives, not module-local widgets.

### 15.4 Tests

- draft does not update resource before commit,
- conflict response preserves draft,
- projection warning is visible,
- equal priority overlap blocks commit,
- material field units render correctly,
- info modal content exists for each advanced field.

---

## 16. Frontend commands, ribbon i mesh rebuild progress

### 16.1 Commands

Register commands:

- `regions.add`,
- `regions.rename`,
- `regions.duplicate`,
- `regions.delete`,
- `regions.priority-up`,
- `regions.priority-down`,
- `regions.toggle-overlay`,
- `regions.focus`,
- `regions.commit-inspector-draft`,
- `couplings.add-exchange`,
- `couplings.add-rkky`,
- `couplings.delete`,
- `mesh.build-region-owner`,
- `mesh.open-region-report`.

Commands must go through kernel command registry.

### 16.2 Ribbon

Modules:

- Geometry: Add Region, Duplicate Region, Delete Region.
- Materials: Add Material Override, Add Gradient Field, Clear Override.
- Physics: Add Coupling, Disable Coupling.
- Mesh: Build Mesh, Open Mesh Report, Region Quality.

Ribbon buttons use icons from shared icon library. No bespoke SVG unless icon is
missing and exception is documented.

### 16.3 Mesh rebuild modal

Existing `apps/control-room/src/modules/overlay/MeshBuildDialog.tsx` should be
extended, not duplicated.

Progress rows:

- scene revision,
- invalidating edit,
- affected objects,
- affected regions,
- material field realization,
- conformal fragmentation,
- Gmsh phase,
- quality gates,
- degenerate tetrahedra gate,
- report links.

Failure display:

- validation blocker,
- mesher error,
- degenerate tetrahedra,
- unsupported coupling,
- projection not allowed in strict mode.

---

## 17. Viewport i visualization

### 17.1 Region overlays

Viewport layer:

- authored region shape overlay,
- realized region mesh overlay,
- material field color overlay,
- coupling endpoint highlight,
- mesh histogram bin highlight scoped to region.

Authored and realized overlays must be visually distinct.

Recommended styling:

- authored region: semi-transparent shape with outline,
- realized mesh region: mesh-part highlight,
- projection warning: amber striped overlay,
- selected region: stronger outline,
- coupling endpoint: paired colors and connector glyph.

### 17.2 Quantity scoping

Quantity registry must know allowed scopes:

- `m`: magnetic object regions only,
- `Ms`, `Aex`: magnetic material domain only,
- `h_eff`: magnetic domain,
- `h_demag`: magnetic plus airbox if solver publishes it,
- mesh quality: mesh parts including airbox,
- potential: airbox/domain where solver publishes it.

If selected scope is airbox and active quantity is `m`, UI must:

- show unavailable state,
- not render stale arrows,
- offer compatible quantities.

### 17.3 Tests

- selecting airbox with active `m` shows unavailable, no stale vectors,
- hiding object hides object `m` vectors,
- region overlay does not resize layout,
- authored/realized overlay toggle works independently,
- WebGL canvas remains nonblank after region overlay activation,
- histogram hover highlights bin tetrahedra without full rerender loop.

Viewport changes require browser smoke or Playwright check for nonblank WebGL
canvas.

---

## 18. Data-plane i diagnostics

### 18.1 Mesh region resources

New resource family:

```text
GET /v2/sessions/current/meshing/meshes/{mesh_id}/regions
GET /v2/sessions/current/meshing/meshes/{mesh_id}/regions/{region_id}/quality
GET /v2/sessions/current/meshing/meshes/{mesh_id}/regions/{region_id}/topology
```

Topology is binary if large.

### 18.2 Material field resources

For visualization/inspection:

```text
GET /v2/sessions/current/data/material-fields
GET /v2/sessions/current/data/material-fields/{field_id}
```

JSON catalog:

- ids,
- owner,
- parameter,
- unit,
- min/max/mean,
- mesh generation,
- source authored region.

Binary payload:

- values,
- location,
- component count,
- index mapping.

### 18.3 Diagnostics

Diagnostics must be linkable from:

- Explorer badge,
- Inspector section,
- mesh build modal,
- footer diagnostics.

Severity:

- `info`,
- `warning`,
- `error`,
- `blocker`.

---

## 19. Runtime i solver integration

### 19.1 Runtime plan payload

Runtime must receive:

- material objects,
- region maps,
- material field assets,
- coupling tables,
- mesh marker mapping,
- quantity scope map,
- provenance.

### 19.2 FDM CPU/GPU

Implementation sequence:

1. CPU reference accepts cellwise material fields.
2. CPU exchange validates harmonic mean/scale/inter exchange.
3. GPU gets same arrays and pair tables.
4. GPU parity tests against CPU.
5. Quantity scoping blocks airbox-like inactive cells.

### 19.3 FEM CPU/GPU

Implementation sequence:

1. FEM planner accepts coefficient field descriptors.
2. Mesh/domain marker mapping is stable.
3. Native FEM coefficient upload supports spatial `Ms`, `Aex`, `alpha`, `Ku`.
4. Exchange operator consumes `A(x)`.
5. Effective field divides by local `Ms(x)`.
6. FEM GPU path receives same coefficient memory contract.
7. Managed runtime verification uses container-backed `just` recipes.

### 19.4 Runtime provenance

Every run must record:

- requested region/coupling intent,
- resolved capabilities,
- material field realization mode,
- projection warnings,
- mesh generation id,
- material field asset ids,
- unsupported couplings rejected or degraded.

### 19.5 Konkretne zmiany w `/backends`

Ta sekcja jest obowiązkowa dla implementacji. Publiczny model regionów i pól
materiałowych nie może kończyć się na Pythonie, IR albo runnerze. Natywne
realizacje produkcyjne mieszkają w:

- `backends/fdm`,
- `backends/fem`.

Runner i sys crates mogą przekazać plan, ale nie są właścicielem hot-loopów,
weak forms, device residency ani operatorów.

#### 19.5.1 FDM native backend: aktualny punkt startowy

Istotne pliki:

- `native/include/fullmag_fdm.h`
  - definiuje ABI FDM.
  - `fullmag_fdm_plan_desc` ma już `active_mask`, `region_mask` i
    `exchange_lut`.
  - obecnie komentarz mówi, że gdy `region_mask` jest obecny bez LUT,
    cross-region exchange domyślnie jest zerowy. To jest sprzeczne z docelową
    semantyką Mumax+/Fullmag, gdzie default ma być harmonic mean, chyba że
    `scale=0`.
- `backends/fdm/include/context.hpp`
  - `Context` trzyma uniform `Ms`, `A`, `alpha`,
  - ma `region_mask`, `exchange_lut`, `ku*_field`, `kc*_field`,
  - nie ma jeszcze ogólnego cellwise `Ms_field`, `A_field`, `alpha_field`,
    `Dind_field`, `Dbulk_field`.
- `backends/fdm/api/c_api.cpp`
  - waliduje plan i tworzy backend handle,
  - obecnie validation dotyczy głównie uniform material i istniejących pól.
- `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu`
  - standardowy exchange używa `ctx.Ms` w mianowniku,
  - region path używa `exchange_lut` dla `A_ij`,
  - nie obsługuje jeszcze cellwise `Ms_i` w prefactorze ani harmonic-mean
    default budowanego z per-cell/per-region `A`.
- `backends/fdm/gpu/cuda/interactions/exchange_fp32.cu`
  - musi dostać analogiczne zmiany jak FP64.
- `backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu`
  - boundary-corrected exchange musi zachować tę samą semantykę `A_ij`.
- `backends/fdm/gpu/cuda/interactions/exchange_t1_fp64.cu`
  - analogicznie dla T1/ECB.
- `backends/fdm/gpu/cuda/interactions/multilayer_exchange.cu`
  - multilayer region-owned material/coupling jest out of scope v1; planner
    musi capability-gate tę kombinację zamiast wpuszczać ją do częściowo
    obsłużonego path.
- `backends/fdm/tests/*exchange*`
  - istnieją testy parity/contract, trzeba dodać region/cellwise material
    cases.

#### 19.5.2 FDM ABI: potrzebne rozszerzenia

W `native/include/fullmag_fdm.h` dodać do `fullmag_fdm_plan_desc`:

```c
const double *ms_field;
uint64_t ms_field_len;
const double *a_field;
uint64_t a_field_len;
const double *alpha_field;
uint64_t alpha_field_len;
const double *dind_field;
uint64_t dind_field_len;
const double *dbulk_field;
uint64_t dbulk_field_len;
```

Dodać osobny opis region/coupling intentu, zamiast przeciążać samo
`exchange_lut`:

```c
typedef enum {
    FULLMAG_FDM_EXCHANGE_PAIR_UNSPECIFIED = 0,
    FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN = 1,
    FULLMAG_FDM_EXCHANGE_PAIR_EXPLICIT = 2,
    FULLMAG_FDM_EXCHANGE_PAIR_DISABLED = 3,
} fullmag_fdm_exchange_pair_mode;

typedef struct {
    uint32_t region_i;
    uint32_t region_j;
    fullmag_fdm_exchange_pair_mode mode;
    double scale;
    double inter_exchange;
} fullmag_fdm_exchange_pair_desc;
```

Następnie `fullmag_fdm_plan_desc` powinien dostać:

```c
fullmag_fdm_exchange_pair_mode exchange_pair_default;
const fullmag_fdm_exchange_pair_desc *exchange_pairs;
uint64_t exchange_pair_count;
```

Compatibility:

- jeśli `exchange_lut` jest podane, backend może użyć go jako zrealizowanego
  low-level override,
- `FULLMAG_FDM_EXCHANGE_PAIR_UNSPECIFIED=0` jest wyłącznie ścieżką
  compatibility dla zerowanych legacy callerów i zachowuje disabled/zero
  cross-region default,
- nowy runner musi jawnie ustawiać
  `FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN`,
- jeśli `region_mask` jest podany bez `exchange_lut` i bez `exchange_pairs`,
  backend ma budować default zgodny z `exchange_pair_default`,
- free surface wymaga `mode=disabled` albo `scale=0`.

#### 19.5.3 FDM context i upload

W `backends/fdm/include/context.hpp` dodać:

```cpp
double *ms_field = nullptr;
double *a_field = nullptr;
double *alpha_field = nullptr;
double *dind_field = nullptr;
double *dbulk_field = nullptr;
bool has_ms_field = false;
bool has_a_field = false;
bool has_alpha_field = false;
bool has_dind_field = false;
bool has_dbulk_field = false;
```

Zadania w `backends/fdm/api/c_api.cpp`:

- walidować długości pól względem `cell_count`,
- walidować wartości:
  - `Ms > 0`,
  - `A >= 0`,
  - `alpha >= 0`,
  - DMI finite, znak dozwolony,
- alokować i kopiować pola na device,
- zwalniać pola w destroy path,
- budować `exchange_lut` z `exchange_pairs` i material fields.

Stan przejściowy jest dozwolony tylko jako fail-fast: ABI i runner mogą
przenieść wskaźniki `ms_field/a_field/alpha_field/dind_field/dbulk_field`, ale
native FDM backend musi odrzucić niepuste pola do czasu, gdy kernele exchange,
LLG damping i DMI faktycznie użyją tych tablic. Nie wolno uploadować tych pól i
kontynuować z uniform constants, bo byłoby to ciche usunięcie authored physics.

Nie należy dodawać całej logiki samplingowej do FDM backendu. Sampling z
`fm.fields.linear`/region shape do cell arrays należy do runner/planner
materialization. FDM backend dostaje już zrealizowane cellwise arrays i pair
tables.

#### 19.5.4 FDM exchange kernels

Zmiany w:

- `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu`,
- `backends/fdm/gpu/cuda/interactions/exchange_fp32.cu`,
- `backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu`,
- `backends/fdm/gpu/cuda/interactions/exchange_t1_fp64.cu`.

Wymagane zachowanie:

- fast path zostaje dla uniform `Ms/A` i bez region/material fields,
- field path używa lokalnego `Ms_i`:

```text
H_ex(i) = 2 / (mu0 Ms_i) * sum_j A_ij (m_j - m_i) / h_ij^2
```

- `A_ij` dla zwykłej pary bez explicit override:

```text
A_ij = harmonic_mean(A_i, A_j) * scale(region_i, region_j)
```

- `mode=explicit`:

```text
A_ij = inter_exchange * scale
```

- `mode=disabled`:

```text
A_ij = 0
```

Energy reduction musi używać tej samej parowej definicji `A_ij`, inaczej
field/energy rozjadą się w walidacji directional derivative.

#### 19.5.5 FDM tests

Dodać testy natywne:

- `backends/fdm/tests/material_field_abi_contract.cpp`
  - plan z `ms_field/a_field/alpha_field` waliduje długości i wartości.
- `backends/fdm/tests/exchange_region_harmonic_mean_contract.cu`
  - dwa regiony, brak explicit pair -> harmonic mean.
- `backends/fdm/tests/exchange_region_disabled_contract.cu`
  - `scale=0` albo `mode=disabled` -> brak cross-region exchange.
- `backends/fdm/tests/exchange_region_explicit_contract.cu`
  - explicit `inter_exchange` wygrywa nad harmonic mean.
- `backends/fdm/tests/exchange_cellwise_ms_contract.cu`
  - dwa cellwise `Ms_i` zmieniają prefactor lokalnie.
- Rozszerzyć istniejące `backends/fdm/tests/exchange_fp64_parity.cu` o
  wariant cellwise material.

#### 19.5.6 FEM native backend: aktualny punkt startowy

Istotne pliki:

- `native/include/fullmag_fem.h`
  - ABI plan FEM. Trzeba rozszerzyć go o region/material/coupling descriptors
    tylko po ustaleniu IR i runner payload.
- `backends/fem/include/context.hpp`
  - `Context` jest orchestration state. Nie dodawać tam nowej fizyki jako
    luźnych pól bez owner module.
- `backends/fem/src/context.cpp`
  - powinien pozostać orchestration/import path.
- `backends/fem/src/mfem_bridge.cpp`
  - nie jest właścicielem nowych region/coupling semantics.
  - wolno go dotknąć tylko jako narrow bridge, jeśli dedykowany moduł wymaga
    wywołania MFEM.
- `backends/fem/core/fem_material_fields.hpp`
- `backends/fem/core/fem_material_fields.cpp`
  - już importują scalar material i optional per-node fields.
  - trzeba rozszerzyć je z “per-node vectors” do jawnego
    `RealizedMaterialField` z location/provenance.
- `backends/fem/core/fem_mesh.hpp`
- `backends/fem/core/fem_mesh.cpp`
  - miejsce na realized material region/domain marker mapping po stronie CPU.
- `backends/fem/core/fem_plan_fields.hpp`
- `backends/fem/core/fem_plan_fields.cpp`
  - import bazowych pól planu; nie powinien przejmować coupling physics.
- `backends/fem/core/fem_context_builder.*`
  - powinien składać moduły, nie implementować ich fizykę.
- `backends/fem/gpu/cuda/materials/material_state.hpp`
  - device-side material coefficient fields.
- `backends/fem/gpu/cuda/state/runtime_coefficients_*`
  - upload/readiness dla material fields, mesh metrics i mesh-region maps.
- `backends/fem/gpu/cuda/mesh/mesh_regions_state.hpp`
  - obecnie magnetic mask i periodic maps; trzeba rozbudować o material region
    ids i realized region maps.
- `backends/fem/gpu/cuda/exchange/*`
  - exchange planning/upload/kernels; to właściciel GPU-side exchange coupling
    tables, nie `gpu_state.cpp`.
- `backends/fem/tests/fem_material_fields_contract.cpp`
- `backends/fem/tests/fem_plan_fields_contract.cpp`
- `backends/fem/tests/fem_mesh_contract.cpp`
- `backends/fem/tests/exchange_contract.cpp`
- `backends/fem/tests/gpu_state_runtime_contract.cpp`

#### 19.5.7 FEM ABI i core descriptors

W `native/include/fullmag_fem.h` dodać docelowo:

```c
typedef enum {
    FULLMAG_FEM_MATERIAL_FIELD_NODE = 0,
    FULLMAG_FEM_MATERIAL_FIELD_ELEMENT = 1,
    FULLMAG_FEM_MATERIAL_FIELD_QUADRATURE = 2,
} fullmag_fem_material_field_location;

typedef struct {
    const char *field_id;
    const char *owner_object_id;
    const char *source_region_id;
    uint32_t parameter;
    fullmag_fem_material_field_location location;
    const double *values;
    uint64_t values_len;
    uint32_t component_count;
} fullmag_fem_material_field_desc;
```

Dodać realized material regions:

```c
typedef struct {
    const char *region_id;
    const char *owner_object_id;
    uint32_t element_marker;
    uint32_t material_index;
    uint32_t realization_mode;
} fullmag_fem_material_region_desc;
```

Dodać coupling descriptors:

```c
typedef struct {
    const char *coupling_id;
    uint32_t kind;
    uint32_t source_marker;
    uint32_t target_marker;
    uint32_t boundary_marker;
    uint32_t mode;
    double scale;
    double inter_exchange;
    double j1;
} fullmag_fem_coupling_desc;
```

Te deskryptory powinny być backend-low-level i pochodzić z runner materialization.
Nie powinny zawierać JSON ani nazw UI-only.

#### 19.5.8 FEM CPU/MFEM material fields

Nowe albo rozszerzone moduły:

- `backends/fem/core/fem_material_regions.hpp`
- `backends/fem/core/fem_material_regions.cpp`
- `backends/fem/core/fem_couplings.hpp`
- `backends/fem/core/fem_couplings.cpp`
- `backends/fem/cpu/mfem/materials/material_coefficients.hpp`
- `backends/fem/cpu/mfem/materials/material_coefficients.cpp`

Jeśli katalog `backends/fem/cpu/mfem/materials` nie istnieje, utworzyć go jako
właściciela MFEM coefficient construction. Nie dokładać tej logiki do
`mfem_bridge.cpp`.

Odpowiedzialności:

- `fem_material_fields.*`
  - importuje i waliduje descriptor fields.
- `fem_material_regions.*`
  - mapuje `region_id`, `element_marker`, `material_index`,
  - waliduje, że sharp boundary ma conformal/domain marker.
- `fem_couplings.*`
  - importuje coupling descriptors i waliduje endpoint markers.
- `cpu/mfem/materials/material_coefficients.*`
  - tworzy MFEM `Coefficient`/`GridFunctionCoefficient`/piecewise coefficient
    z realized fields.

FEM weak exchange musi używać `A(x)` jako coefficient w operatorze. Effective
field i RHS muszą używać lokalnego `Ms(x)`. Jeśli obecny operator zakłada
uniform `A`/`Ms`, pierwsza implementacja musi jawnie capability-gate:

- uniform path supported,
- node/element material field path supported dopiero po operator update,
- unsupported field location odrzucona w planner/runtime, nie ignorowana.

#### 19.5.9 FEM GPU/CUDA material fields i region maps

Rozszerzyć:

- `backends/fem/gpu/cuda/materials/material_state.hpp`
  - dodać optional location/provenance metadata tylko jeżeli potrzebne na
    device; nie wrzucać string ids na device.
- `backends/fem/gpu/cuda/mesh/mesh_regions_state.hpp`
  - dodać:

```cpp
uint32_t *material_region_id = nullptr;
uint32_t *element_material_id = nullptr;
uint32_t *boundary_coupling_id = nullptr;
```

albo osobne arrays zależnie od node/element/boundary cardinality.

- `backends/fem/gpu/cuda/state/runtime_coefficients_memory.*`
  - alokuje nowe arrays.
- `backends/fem/gpu/cuda/state/runtime_coefficients_upload.*`
  - kopiuje material fields, material region maps i coupling ids.
- `backends/fem/gpu/cuda/state/runtime_coefficients_state.hpp`
  - readiness powinno rozróżnić:
    - material_fields_uploaded,
    - mesh_regions_uploaded,
    - couplings_uploaded,
    - all_ready.

Nie rozszerzać `gpu_state.cpp` poza orkiestrację wywołań modułów.

#### 19.5.10 FEM GPU exchange/coupling

Rozszerzyć właściciela:

- `backends/fem/gpu/cuda/exchange/exchange_plan.*`,
- `backends/fem/gpu/cuda/exchange/exchange_upload.*`,
- `backends/fem/gpu/cuda/exchange/exchange_state.hpp`,
- `backends/fem/gpu/cuda/exchange/exchange_kernels.*`.

Nowe zadania:

- exchange plan wykrywa, czy `A(x)`/region maps/couplings są device-resident,
- upload przenosi coupling table na device,
- kernels albo operator path używa local `A(x)` i coupling boundary maps,
- unsupported RKKY failuje capability jasno.

RKKY/interlayer:

- jeśli nie implementujemy operatora w pierwszym PR, `exchange_plan` albo
  runtime validation ma zwrócić unsupported z proweniencją.
- nie wolno cicho traktować RKKY jako zwykłego `Aex`.

#### 19.5.11 FEM tests w `/backends/fem/tests`

Dodać:

- `backends/fem/tests/fem_material_region_contract.cpp`
  - region descriptors, marker mapping, duplicate marker validation.
- `backends/fem/tests/fem_material_field_location_contract.cpp`
  - node/element/quadrature location validation.
- `backends/fem/tests/fem_coupling_contract.cpp`
  - endpoint marker validation i unsupported RKKY.
- `backends/fem/tests/fem_exchange_spatial_a_contract.cpp`
  - operator/plan path nie ignoruje `A_field`.
- `backends/fem/tests/fem_local_ms_contract.cpp`
  - RHS/effective field uses local `Ms`.
- `backends/fem/tests/gpu_runtime_coefficients_regions_contract.cpp`
  - GPU readiness rozróżnia material fields, mesh regions, couplings.
- Rozszerzyć:
  - `fem_material_fields_contract.cpp`,
  - `fem_plan_fields_contract.cpp`,
  - `exchange_contract.cpp`,
  - `source_facade_gpu_state_contract.cpp`.

#### 19.5.12 CMake i source-layout contracts

Zmiany w:

- `backends/fdm/CMakeLists.txt`,
- `backends/fem/CMakeLists.txt`,
- testy source-layout:
  - `backends/fdm/tests/source_layout_contract.cpp`,
  - `backends/fem/tests/source_facade_contract.cpp`,
  - `backends/fem/tests/source_facade_cuda_kernels_contract.cpp`.

Nowe kontrakty:

- material/coupling modules nie mogą być implementowane w `mfem_bridge.cpp`,
- GPU material/coupling memory ma osobne `*_memory`, `*_upload`, `*_state`,
- FDM exchange field/energy muszą używać tej samej pair coefficient function,
- `Context` może agregować stan, ale właściciel logiki jest w module.

#### 19.5.13 Weryfikacja backendów

FDM:

```bash
cargo test -p fullmag-fdm-sys
```

oraz natywne testy FDM przez istniejący CMake/CI path, po zidentyfikowaniu
repozytoryjnego recipe.

FEM:

Najpierw sprawdzić `justfile`, potem użyć managed/container path:

```bash
just ensure-managed-fem-runtime
```

Dla zmian runtime:

```bash
just rebuild-fem-runtime
```

oraz właściwy smoke, np. managed FEM headless/interactive recipe. Host-side
`cargo`, `cmake` albo bezpośredni binary mogą być tylko diagnostyką.

---

## 20. Script export

### 20.1 Export contract

Python export must prefer human-readable authoring:

- `fm.shapes.*`,
- `object.add_region`,
- `fm.fields.*`,
- `study.couplings.*`,
- no generated Gmsh field ids,
- no realized mesh markers as authored region ids.

### 20.2 Rename behavior

Runtime uses `region_id`; script uses names.

Export rule:

- if region was renamed, export new name,
- internal `region_id` is not shown unless needed for provenance comment,
- references are rewritten to names,
- duplicate names blocked before export.

### 20.3 Round-trip tests

- Python -> IR -> SceneDocument -> script export -> Python parse retains regions.
- UI create region -> export script contains `add_region`.
- UI gradient field -> export script contains `fm.fields.linear`.
- Coupling export uses `study.couplings`.
- Legacy scene without authored regions exports old object-only script.

---

## 21. Migration plan

### 21.1 Compatibility layers

Keep temporarily:

- `RegionIR { name, geometry }`,
- `SceneObject.region_name`,
- `SceneObject.region_overrides`,
- existing `/model/regions` behavior if needed for current UI.

Add:

- `SceneObject.regions`,
- `ProblemIR.object_regions`,
- `ProblemIR.couplings`,
- resource distinction authored vs realized regions.

### 21.2 Migration rules

For old scenes:

- object `region_name` becomes default body region label,
- no authored child region is created unless region override contains shape,
- `region_overrides` with only `magnetization_ref` remains compatibility
  override until user saves scene.v2,
- first save as scene.v2 writes explicit authored regions only for real region
  authoring.

### 21.3 Removal criteria

Legacy paths can be removed only when:

- all examples export `object.add_region` for authored regions,
- UI no longer uses `region_overrides`,
- planner tests distinguish legacy and authored regions,
- OpenAPI docs name authored and realized region resources separately,
- migration test suite covers scene.v1.

---

## 22. Rollout PR plan

### PR 1: Physics note and terminology

Files:

- `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`
- update plan docs if terminology shifts.

Readiness gate:

- section 4.4, 4.5 and 4.7 questions must be answered in the physics note and in
  this masterplan before PR 2 starts,
- every answer that changes runtime physics must map to either a concrete test
  or a capability gate in section 4.6,
- unresolved questions about intra-object exchange, object-object exchange,
  `Ms <= 0`, RKKY support, surface selector resolution, FEM projection,
  contact discovery, FDM ABI defaults, UI authoring transactions, region delete
  invalidation, airbox ownership, or multilayer FDM block PR 2,
- authored-only behavior is acceptable only for model/provenance storage; if a
  selected backend cannot realize the authored physics, planner/runtime must
  block the run with a diagnostic.

Verification:

- docs checklist complete,
- section 4.6 has a test/gate row for every review question that affects
  physics or runtime behavior,
- no code changes.

### PR 2: ProblemIR types and validation

Files:

- `crates/fullmag-ir/src/model.rs`
- `crates/fullmag-ir/src/validation.rs`
- `crates/fullmag-ir/tests/ir_tests.rs`

Verification:

```bash
cargo test -p fullmag-ir
```

### PR 3: Python DSL descriptors

Files:

- `packages/fullmag-py/src/fullmag/model/regions.py`
- `packages/fullmag-py/src/fullmag/model/material_fields.py`
- `packages/fullmag-py/src/fullmag/model/couplings.py`
- `packages/fullmag-py/src/fullmag/model/shapes.py`
- `packages/fullmag-py/src/fullmag/model/problem.py`
- `packages/fullmag-py/src/fullmag/__init__.py`

Verification:

```bash
python3 -m py_compile packages/fullmag-py/src/fullmag/model/regions.py
python3 -m py_compile packages/fullmag-py/src/fullmag/model/material_fields.py
python3 -m py_compile packages/fullmag-py/src/fullmag/model/couplings.py
```

Plus focused Python unit tests if test harness exists for `packages/fullmag-py`.

### PR 4: SceneDocument v2 and authoring adapters

Files:

- `crates/fullmag-authoring/src/scene.rs`
- `crates/fullmag-authoring/src/adapters.rs`
- `crates/fullmag-authoring/src/validation.rs`
- `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`

Verification:

```bash
cargo test -p fullmag-authoring
```

### PR 5: Planner material fields and coupling validation

Files:

- `crates/fullmag-plan/src/validate.rs`
- `crates/fullmag-plan/src/fdm.rs`
- `crates/fullmag-plan/src/fem.rs`
- `crates/fullmag-plan/src/mesh.rs`
- `crates/fullmag-plan/src/tests.rs`

Verification:

```bash
cargo test -p fullmag-plan
```

### PR 6: Meshing region policy and reports

Files:

- `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
- `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
- `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py`
- `packages/fullmag-py/src/fullmag/meshing/mesh_build_report.py`

Verification:

- focused meshing Python tests,
- materialize simple box + region,
- materialize arch waveguide with skyrmion region,
- verify mesh report region ownership,
- verify no degenerate tetrahedra.

### PR 7: OpenAPI v2 resources

Files:

- `crates/fullmag-api/src/schemas/authoring.rs`
- `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- `crates/fullmag-api/src/openapi_v2.rs`
- `docs/specs/resource-first-control-room-api-v2.md`

Verification:

```bash
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room generate:api
```

### PR 8: ControlRoomApi and resource hooks

Files:

- `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- `apps/control-room/src/kernel/api/apiTypes.ts`
- `apps/control-room/src/kernel/resources/modelRegionResources.ts`
- `apps/control-room/src/kernel/resources/couplingResources.ts`

Verification:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room test -- --run ControlRoomApi
```

### PR 9: Explorer and inspector UI

Files:

- `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- `apps/control-room/src/modules/explorer/explorerTypes.ts`
- new inspector module files under `apps/control-room/src/modules`
- ribbon command contributions.

Verification:

```bash
pnpm --dir apps/control-room test -- --run explorer
pnpm --dir apps/control-room typecheck
```

### PR 10: Viewport overlays and quantity scoping

Files:

- viewport 3D module,
- visualization registry,
- quantity/domain adapters,
- mesh highlight event path.

Verification:

- unit tests,
- browser smoke for nonblank WebGL canvas,
- airbox selected with `m` unavailable,
- object hidden means object `m` arrows hidden.

### PR 11: Runtime material field realization

Files:

- `native/include/fullmag_fdm.h`,
- `native/include/fullmag_fem.h`,
- `backends/fdm/include/context.hpp`,
- `backends/fdm/api/c_api.cpp`,
- `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu`,
- `backends/fdm/gpu/cuda/interactions/exchange_fp32.cu`,
- `backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu`,
- `backends/fdm/gpu/cuda/interactions/exchange_t1_fp64.cu`,
- `backends/fdm/tests/material_field_abi_contract.cpp`,
- `backends/fdm/tests/exchange_region_harmonic_mean_contract.cu`,
- `backends/fdm/tests/exchange_region_disabled_contract.cu`,
- `backends/fdm/tests/exchange_region_explicit_contract.cu`,
- `backends/fem/core/fem_material_fields.hpp`,
- `backends/fem/core/fem_material_fields.cpp`,
- `backends/fem/core/fem_material_regions.hpp`,
- `backends/fem/core/fem_material_regions.cpp`,
- `backends/fem/core/fem_couplings.hpp`,
- `backends/fem/core/fem_couplings.cpp`,
- `backends/fem/cpu/mfem/materials/material_coefficients.hpp`,
- `backends/fem/cpu/mfem/materials/material_coefficients.cpp`,
- `backends/fem/gpu/cuda/materials/material_state.hpp`,
- `backends/fem/gpu/cuda/mesh/mesh_regions_state.hpp`,
- `backends/fem/gpu/cuda/state/runtime_coefficients_state.hpp`,
- `backends/fem/gpu/cuda/state/runtime_coefficients_memory.hpp`,
- `backends/fem/gpu/cuda/state/runtime_coefficients_memory.cpp`,
- `backends/fem/gpu/cuda/state/runtime_coefficients_upload.hpp`,
- `backends/fem/gpu/cuda/state/runtime_coefficients_upload.cpp`,
- `backends/fem/gpu/cuda/exchange/exchange_plan.hpp`,
- `backends/fem/gpu/cuda/exchange/exchange_plan.cpp`,
- `backends/fem/gpu/cuda/exchange/exchange_upload.hpp`,
- `backends/fem/gpu/cuda/exchange/exchange_upload.cpp`,
- `backends/fem/gpu/cuda/exchange/exchange_state.hpp`,
- `backends/fem/gpu/cuda/exchange/exchange_kernels.hpp`,
- `backends/fem/gpu/cuda/exchange/exchange_kernels.cu`,
- `backends/fem/tests/fem_material_region_contract.cpp`,
- `backends/fem/tests/fem_material_field_location_contract.cpp`,
- `backends/fem/tests/fem_coupling_contract.cpp`,
- `backends/fem/tests/fem_exchange_spatial_a_contract.cpp`,
- `backends/fem/tests/fem_local_ms_contract.cpp`,
- `backends/fem/tests/gpu_runtime_coefficients_regions_contract.cpp`,
- runner runtime payload,
- provenance resources.

Verification:

- CPU reference tests,
- GPU parity tests,
- FEM managed runtime build through `just`,
- simple relaxation with spatial `Ms(x)`,
- exchange interface tests.

### PR 12: Examples and documentation

Files:

- `examples/arch_waveguide_relax_50nm.py`,
- `examples/region_owned_gradient_ms.py`,
- `examples/skyrmion_core_mesh_refinement.py`,
- `examples/two_object_couplings.py`,
- `docs/guides/region-owned-authoring.md`,
- `docs/guides/region-owned-migration.md`.

Verification:

- example materialization,
- script export round-trip,
- managed runtime smoke if FEM example changed.

---

## 23. Cross-layer acceptance tests

### 23.1 Python to UI round-trip

Scenario:

1. Python creates object.
2. Python adds two regions.
3. Region A has mesh refinement.
4. Region B has `Ms` override.
5. Object has `Ms(x)` gradient.
6. Python adds object-object exchange coupling.
7. Materialize scene.
8. UI Explorer shows regions and coupling.
9. Export script.
10. Exported script preserves semantics.

### 23.2 FEM sharp boundary

Scenario:

1. Box object with left/right sharp `Aex`.
2. Strict mode without conformal boundary -> planner error.
3. Strict mode with conformal boundary -> mesh has domain markers.
4. Mesh report shows conformal.
5. Solver receives coefficient/domain mapping.

### 23.3 Projection warning

Scenario:

1. Cylinder region with sharp `Ms`.
2. Projection mode explicit.
3. Mesh does not split.
4. Material field asset sampled.
5. UI shows warning.
6. Runtime provenance records projection.

### 23.4 FDM exchange interface

Scenario:

1. Two regions with `Aex = A1`, `Aex = A2`.
2. Default exchange uses harmonic mean.
3. `scale=0` disables exchange.
4. Explicit `inter_exchange` overrides harmonic mean.

### 23.5 Airbox scoping

Scenario:

1. FEM shared-domain mesh with airbox.
2. Active quantity `m`.
3. Object visible -> object vectors visible.
4. Object hidden -> object vectors hidden.
5. Airbox selected -> `m` unavailable.
6. Airbox can display allowed fields or mesh diagnostics.

### 23.6 Exchange field/energy consistency

Scenario:

1. One object, two regions with `Aex = A1`, `Aex = A2`.
2. Compute `E_ex(m)` and `H_ex(m)` for a non-trivial magnetization config.
3. Verify: `δE_ex/δm_i ≈ -μ₀ Ms_i H_ex,i` (Taylor test with finite difference).
4. Confirms `A_ij` is consistent between field kernel and energy reduction.

### 23.7 Inter-object isolation

Scenario:

1. Two objects with different `Ms`, `Aex`, no explicit coupling.
2. Run relaxation.
3. Verify: objects relax independently — no exchange torque between them.
4. Add `study.couplings.exchange(obj_a, obj_b, mode="harmonic_mean")`.
5. Re-run relaxation.
6. Verify: exchange coupling active, coupled equilibrium differs from isolated.

### 23.8 Ms=0 validation

Scenario:

1. One object, region with `Ms=0`.
2. Planner/validation must reject with clear error.
3. If `Ms` field has values close to zero but not zero, solver must not diverge.

---

## 24. Verification matrix

| Layer | Required verification |
|---|---|
| Physics docs | checklist in physics note complete |
| ProblemIR | `cargo test -p fullmag-ir` |
| Planner | `cargo test -p fullmag-plan` |
| Python DSL | py_compile and focused Python tests |
| Meshing | focused materialization examples, no degenerate tetrahedra |
| API | `cargo test -p fullmag-api router_v2 --no-fail-fast` |
| OpenAPI | `pnpm --dir apps/control-room generate:api` |
| Frontend types | `pnpm --dir apps/control-room typecheck` |
| Frontend tests | `pnpm --dir apps/control-room test` targeted then broad |
| API hygiene | no module fetch, no ad hoc `/v2` strings outside facade |
| Viewport | Playwright/browser smoke, nonblank WebGL canvas |
| FEM runtime | managed/container `just` recipe |
| Script export | Python/UI round-trip tests |

---

## 25. Risk register

### Risk 1: Region becomes hidden material

Mitigation:

- terminology in docs,
- IR separation,
- UI sections separated,
- coupling as separate resource.

### Risk 2: FEM projection silently changes physics

Mitigation:

- strict mode blocks,
- extended mode warning,
- mesh report provenance,
- tests.

### Risk 3: UI shows realized mesh regions as authored regions

Mitigation:

- resource split,
- Explorer labels,
- authored/realized overlay distinction,
- tests.

### Risk 4: Airbox displays stale `m`

Mitigation:

- quantity scope registry,
- data adapter filtering,
- viewport tests.

### Risk 5: OpenAPI and frontend drift

Mitigation:

- schema-first API changes,
- generated types,
- `ControlRoomApi` facade,
- resource hooks,
- API hygiene grep.

### Risk 6: Material fields copied into status

Mitigation:

- material field catalog in JSON,
- values via artifacts/binary data plane,
- resource-first tests.

### Risk 7: Native FEM proof done on host only

Mitigation:

- managed `just` recipe is final proof,
- host checks labelled diagnostic only.

### Risk 8: FDM ABI default mismatch breaks intra-object regions

Mitigation:

- new `exchange_pairs` descriptor in ABI overrides old behavior,
- new `exchange_pair_default` records current harmonic-mean default explicitly,
- old `exchange_lut` remains as low-level override,
- when neither `exchange_lut` nor `exchange_pairs` is present with `region_mask`,
  backend builds harmonic-mean default, not free surface,
- legacy zero-default is available only through explicit old-plan version or
  disabled pair mode,
- migration tests verify old scenarios still work with new default,
- physics note documents the change explicitly.

### Risk 9: RKKY silently dropped changes simulation physics

Mitigation:

- unsupported RKKY blocks run, not warning-only,
- capability diagnostic shows authored coupling and rejection reason,
- UI shows blocker-level diagnostic before run,
- test validates that authored RKKY that cannot be realized prevents solver start.

### Risk 10: Ms=0 causes division by zero in effective field

Mitigation:

- IR validation blocks `Ms ≤ 0` for active magnetic cells,
- planner rejects `Ms_field` values ≤ 0 within magnetic region,
- solver runtime validates before operator construction,
- test covers near-zero and zero cases.

---

## 26. Definition of done

Implementation is complete only when:

1. Physics note exists and is complete.
2. Python DSL supports regions, fields and couplings.
3. `ProblemIR` represents authored intent without backend leakage.
4. SceneDocument v2 round-trips Python and UI regions.
5. Planner validates region/material/coupling semantics.
6. Meshing report distinguishes authored and realized regions.
7. FDM supports material field sampling and exchange interface table.
8. FEM supports coefficient field realization with conformal/projection policy.
9. OpenAPI v2 exposes authored regions, realized regions, material fields and
   couplings as resource-first endpoints.
10. Generated frontend API artifacts are updated.
11. ControlRoomApi and resource hooks own transport.
12. Explorer and Inspector expose region management.
13. Mesh rebuild modal shows region/material/coupling phases.
14. Viewport overlays show authored and realized regions distinctly.
15. Airbox cannot display magnetic-only `m`.
16. Script export emits canonical Python.
17. Tests cover FDM, FEM, API, UI and round-trip.
18. FEM runtime proof uses managed/container `just` recipe.

---

## 27. Recommended immediate next step

Nota fizyczna 0104 jest już kontraktem bazowym dla implementacji. Następny
konkretny krok nie polega na ponownym otwieraniu pytań fizycznych, tylko na
domknięciu ścieżki authoring round-trip i capability gates w tej kolejności:

1. Dopiąć canonical Python script export:
   `Python DSL -> ProblemIR -> SceneDocument -> Python export -> ProblemIR`
   musi zachować `ObjectRegion`, `MaterialParameterFieldIR`, `CouplingIR`,
   `region_id`, `priority`, `mode`, `scale`, `J1` i surface selectors.
2. Utrwalić w plannerze decyzje z sekcji 4.4:
   unsupported RKKY/interlayer blokuje run, `Ms <= 0` jest błędem, multilayer
   FDM + region-owned semantics jest capability-gated, a FEM sharp jump w
   `strict` wymaga conformal/domain marker.
3. Dopiero potem materializować backend runtime:
   FDM dostaje cellwise material arrays i `exchange_pair_default +
   exchange_pairs`; FEM dostaje realized material fields, material region
   markers i coupling descriptors w dedykowanych modułach pod `backends/fem`,
   nie jako przypadkowe pola w `Context` albo `mfem_bridge.cpp`.
4. OpenAPI/UI muszą zostać zaktualizowane razem z resource-first kontraktem:
   authored regions/material fields/couplings i realized mesh/material regions
   są osobnymi zasobami, a Explorer/Inspector pokazują je jako różne byty.

Nie wolno skracać tej kolejności przez authored-only runtime behavior. Authored
intent może być zapisany i pokazany w UI, ale jeżeli wybrany backend nie ma
wymaganego operatora albo indeksów interfejsu, solver start ma zostać
zablokowany z diagnostyką capability.
