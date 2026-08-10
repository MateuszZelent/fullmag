# Fullmag Control Room: audyt Explorer / Inspector / 3D / API dla FEM i FDM

**Data:** 2026-08-05  
**Zakres:** bieżący, współdzielony i zmodyfikowany working tree; frontend `apps/control-room`, API v2, publikacja danych runtime, Explorer, Inspectors, viewport FEM/FDM, Airbox, wiele obiektów i regionów.  
**Werdykt bazowy (przed wdrożeniem poprawek):** **stan nie był poprawny i nie wszystkie zgłoszone problemy były rozwiązane.** Najważniejszy zgłoszony objaw — brak reakcji `Visible`, `Shaded`, `Wireframe` dla obiektu FDM — był potwierdzonym błędem architektury renderowania (P0), a nie błędem obsługi użytkownika. Aktualny status po implementacji znajduje się w sekcji 10.

## 1. Kryterium zgodności

Fullmag powinien pokazywać jeden spójny model fizyczny niezależnie od dyskretyzacji:

```text
Session Model
├── Mesh                              globalne podsumowanie domeny
├── Universe
│   └── Airbox
│       ├── Mesh                      dyskretyzacja przestrzeni poza magnetykiem
│       └── Visualization             ramka/extent oraz pola wektorowe; bez shadera materiału
└── Objects
    └── Object
        ├── Mesh                      dyskretyzacja obiektu
        ├── Visualization             niezależne ustawienia obiektu
        └── Regions
            └── Region
                ├── Mesh              dyskretyzacja/realizacja regionu
                └── Visualization     niezależne ustawienia regionu
```

Nomenklatura techniczna może się różnić (`structured grid` w FDM, elementy/topologia w FEM), ale nie może tworzyć drugiego produktu „FDM Grid”. Każdy widoczny węzeł semantyczny powinien mieć prawdziwy, odrębny Inspector oraz odpowiadający mu render target.

## 2. Najważniejsze ustalenia

### P0-A — ustawienia obiektu/regionu FDM nie sterują rzeczywistym renderem FDM

To jest bezpośrednia przyczyna zgłoszonego zachowania.

1. Inspector poprawnie zapisuje wybór obiektu jako `object:film`.
2. `useViewport3DSceneModel.ts:3040-3052` ignoruje ten target przy budowie zrealizowanej siatki i rozwiązuje jeden globalny `targetForFdmDomain(...)`.
3. `useViewport3DSceneModel.ts:3976-3991` buduje jeden model wszystkich aktywnych komórek z `cellSelection: "active"`, `scopeKind: "full"`, `scopeId: "full"`.
4. `Viewport3DScene.tsx:1023-1046` przekazuje do jedynego magnetycznego `FdmCuboidLayer` jedne globalne `fdmSettings`.
5. `FdmCuboidLayer.tsx:1160-1177` ma również na stałe carrier wektorów `fdm-domain`.
6. `ObjectVisualizationPanelModel.ts:377-387` ujawnia, że ustawienia obiektu FDM dotyczą w praktyce jedynie authored `PrimitiveObjectLayer`, nie zrealizowanych komórek.

Skutek: `Visible`, `Shaded`, `Wireframe`, `Points`, wektory, opacity, quantity i colorbar dla `object:*` lub `region:*` nie mogą niezależnie zmienić właściwego renderu FDM. Dla wielu ferromagnetyków i regionów jest to luka kontraktowa, nie pojedynczy błąd przycisku.

**Wymagana naprawa:** FMRM `region_legend` i per-cell `regionIds` muszą zostać przekształcone w target-aware render carriers. Jeden wspólny bufor próbek powinien być partycjonowany na lekkie widoki per obiekt/region, z dziedziczeniem ustawień region → obiekt. Nie należy budować całej siatki osobno dla każdego targetu.

### P0-B — bieżąca sesja nie publikuje maski FDM

Live probe bieżącej sesji:

| Resource | HTTP | Wynik |
|---|---:|---|
| `/v2/sessions/current/status` | 200 | FDM, 122 880 komórek, wykonane 123 kroki |
| `/v2/sessions/current/model/scene` | 200 | obiekt `film`, Universe `800 × 325 × 90 nm` |
| `/v2/sessions/current/data/domain/meta` | 200 | grid `128 × 32 × 30`, 122 880 komórek |
| `/v2/sessions/current/data/fdm-region-memberships` | **204** | brak zmaterializowanej maski |
| `/v2/sessions/current/data/fields/m/meta` | 200 | `m`, revision 4, state `complete` |
| `/v2/sessions/current/visualization/state` | 200 | `airbox` + `object:film` |

Frontend słusznie nie może uznać wszystkich komórek Universe za magnetyczne. Bez FMRM nie zna granicy magnetyk/powietrze ani przynależności do wielu obiektów/regionów. Obecny fail-closed usuwa shader/wektory z komórek, pozostawiając authored primitive/ramę, co odpowiada widocznemu symptomowi.

**Wymagana naprawa:** backend/runtime musi opublikować FMRM dla aktualnego planu przed uznaniem zrealizowanego meshu za gotowy. API powinno walidować fingerprint, kształt, origin, spacing, generation i legendę względem bieżącej domeny.

### P0-C — rzeczywiste FDM multilayer nie pasuje do kontraktu pól API

Runner zapisuje multilayer jako natywne pola per warstwa i waliduje sumę `value_count`. API prezentuje jedną wspólną siatkę i dopuszcza pole tylko wtedy, gdy `point_count == common_cells`. Syntetyczny test wspólnej siatki nie reprezentuje realnego payloadu runnera. Rezultatem może być odrzucenie pola, 204/404 albo błędna lokalizacja próbek.

Ponadto runner nie publikuje FMRM dla `BackendPlanIR::FdmMultilayer`, a fallback API obsługuje wyłącznie zwykły `Fdm`. Wielowarstwowy FDM nie ma więc obecnie pełnego kontraktu Explorer/object/region/field.

### P0-D — FEM może przejść w globalny fallback ignorujący target obiektu

W poprawnej ścieżce `TopologyMeshLayer`/`MeshPartLayer` respektuje ustawienia per part. Gdy zdekodowana topologia istnieje, ale `magneticParts.length === 0`, `TopologyMeshLayer.tsx:67-123` renderuje całą topologię przez `FallbackTopologyMeshLayer` z jednym `fallbackSettings`. Wtedy `Visible`, `Shaded` i `Wireframe` obiektu również nie mogą sterować geometrią. Brak lub niezgodność carrier manifestu jest zatem krytyczna także dla FEM.

### P1 — dodatkowe błędy targetowania i provenance FEM

- `useViewport3DSceneModel.ts:1274-1294` dla manifest regionu z wieloma `sourceObjectIds` wybiera pierwszy obiekt i przypisuje wszystkie `mesh_part_id` do jego targetu. Region obejmujący wiele obiektów może sterować niewłaściwą geometrią.
- `viewport3dTopologyStaleness.ts:20-23` promuje `unknown` do `current` tylko dlatego, że bufor FEM ma węzły. Nie dowodzi to zgodności scene/manifest/generation i może dopuścić stary mesh po edycji sceny.
- Walidacja explicit/sample indexing wykrywa duplikaty w gałęzi FDM, lecz nie dla FEM. Późniejszy `Map<globalNode, localIndex>` zachowuje ostatni duplikat, co może bez komunikatu błędnie przypisać kolor lub wektor.

## 3. Airbox

Docelowa semantyka jest jednoznaczna:

- Airbox może istnieć w FEM i FDM, gdy Universe wykracza poza wsparcie ferromagnetyczne.
- Airbox nie ma shadera materiału ani magnetyzacji.
- Airbox pokazuje extent/bounds oraz pola zdefiniowane w powietrzu (np. `H_demag`) jako wektory.
- Magnetyczny obiekt i Airbox nie mogą używać jednego globalnego render targetu.

Bieżący frontend rozdzielił bounds overlay od komórek, ale nadal buduje drugi `FdmCuboidLayer` ze wszystkich nieaktywnych komórek dla Airboxa. Przy dużym pustym Universe dziesiątki tysięcy krawędzi nakładają się i tworzą „biały blok”. Dla vector-only Airboxa nie należy budować pełnej geometrii nieaktywnych voxeli tylko po to, aby uzyskać anchory wektorów. Extent powinien pochodzić z bounds/envelope, a anchory z osobnego, ograniczonego próbkowania pola.

Live visualization state ma dla Airboxa `render_mode=off`, `surface_visible=false`, `vectors_visible=false`, więc widoczna na zrzucie ramka jest extentem, a nie shaderem. Brak reakcji ustawień obiektu pozostaje oddzielnym P0-A.

Scenariusz ma nadal `fields=[]`; `H_demag` nie jest przez to gwarantowanie materializowane. Airbox nie może pokazać pola, którego backend nie opublikował ani nie wyliczył na żądanie.

## 4. Explorer i Inspectors

### P1 — FEM Airbox jest fabrykowany jako gotowy

`buildModelTree.ts:1547-1638` tworzy kompletny FEM Airbox i oznacza dzieci jako `ready` na podstawie samego `domainDiscretization: "fem"`. Nie sprawdza authored policy, demag, capability ani zasobu zrealizowanego meshu. UI może więc twierdzić, że Airbox jest gotowy mimo braku danych.

### P1 — kolizja identyfikatorów regionów FEM między obiektami

`sceneModelTreeAdapter.ts:482-551` indeksuje membership tylko po `region_id`. API membership nie przenosi `owner_object_id`. Dwa ferromagnetyki z regionem o tej samej nazwie mogą otrzymać status/mesh ostatniego wpisu. FDM ma owner-qualified identity, FEM nie.

### P2 — pozorne dzieci Mesh Airboxa FDM

Explorer pokazuje `Parameters`, `Quality Gates`, `Statistics`, `Topology`, `Build & Provenance`, ale cztery z pięciu ścieżek kończą się w tym samym `FdmUniverseExtentPanel`. To nie są realnie odrębne Inspectors. Należy albo pokazać prawdziwe fakty i jawne N/A, albo usunąć nieobsługiwane dzieci.

### P2 — semantyczne rooty bez Inspectorów

`session.root`, `universe.root`, `objects.root`, `definitions.root` i `model.planar.monitors` są wybieralne, ale nie mają `SelectionRef`/dedykowanego panelu i trafiają do placeholdera. Narusza to zasadę „każdy semantyczny węzeł ma własny Inspector”.

### P2 — pozostałości produktu „FDM Grid”

Explorer przeszedł na wspólny Mesh, lecz `inspectorRegistry.tsx:741` nadal nazywa panel `FDM Grid`, a ribbon używa `Grid` / `Grid overview`. Techniczne określenia `grid shape/spacing` są poprawne, ale produktowa gałąź ma pozostać Mesh.

## 5. Kontrakt API i provenance

### P0 — FEM generation identity jest niespójne

Runner publikuje SHA-256-like `FemMeshPayload.generation_id` jako string. API `domain_generation_id` próbuje parsować je jako `u64`; po niepowodzeniu przechodzi do identyfikacji FDM/live-grid. Topology ETag korzysta natomiast z prawdziwego stringa. Status, domain meta, katalog pól i FMVP mogą więc mówić o innej generacji niż topologia.

### P1 — scope pól jest praktycznie FEM-only

OpenAPI reklamuje `full/object/part/airbox/selection`, lecz non-full vector field wymaga `snapshot.fem_mesh`. FDM nie może pobrać pola dla obiektu/regionu ani warstwy multilayer, mimo że FMRM ma informację o przynależności.

### P1 — membership FDM może być błędnie oznaczony jako current

Endpoint wyszukuje artifact w bieżącym katalogu, ale nie wymaga aktywnej lane FDM ani zgodności fingerprint/counts/origin/spacing/generation z bieżącą domeną. `freshness: current` jest emitowane bez tej walidacji. Reużyty katalog może ujawnić stary lub cross-backend artifact jako aktualny.

### P1 — mieszana topologia FEM jest opisywana jako tetrahedron

API zawsze zwraca pojedyncze `element_type: tetrahedron`, chociaż FMMT/runner wspiera mixed topology. Binary topology może być poprawna, a meta kierować UI w złą ścieżkę.

### P2 — revision membership nie śledzi publikacji artifactu

Publiczny revision pochodzi z licznika zmian sceny, podczas gdy payload/fingerprint zmienia się po wykonaniu. Nowy artifact może pojawić się bez zmiany wskaźnika invalidacji statusu; ETag nie naprawia braku sygnału do refetch.

## 6. Ocena zaktualizowanego planu Opusa (v2)

Plan został przeczytany ponownie w wersji zmodyfikowanej 2026-08-05 17:10. Trafnie identyfikuje zewnętrzną i wewnętrzną bramkę membership, ale jego centralna naprawa jest niepoprawna naukowo.

| WP | Ocena | Uzasadnienie |
|---|---|---|
| WP1 synthesize all-active | **odrzucić** | Maluje cały Universe jako ferromagnetyk i niszczy Airbox oraz ownership wielu obiektów. Bez maski dopuszczalny jest authored primitive/extent, nie fałszywa realizacja. |
| WP2 Airbox decoupling | częściowo trafny | Niezależny bounds overlay jest już obecny. Zwiększenie epsilon nie ma wykazanego uzasadnienia; proponowana wartość nadal nie rozwiązuje kontraktu membership. |
| WP3 tolerant indexing | **odrzucić** | Częściowe mapowanie pola o złej liczbie punktów daje naukowo fałszywe kolory. Należy naprawić backend/payload i zachować fail-closed z jawnym powodem. |
| WP4 fallback layer | częściowo zbędny | `DomainBoxLayer` i authored primitive już zapewniają bezpieczny fallback. Potrzebny jest jawny degraded state, nie druga konkurencyjna ramka. |
| WP5 diagnostics | wymagany, ale niepełny | Potrzebne są strukturalne statusy domain/membership/field/target, nie `console` jako główne UX. |
| WP6 memo count/log | brak dowodu błędu | Kolory zależą od identity `cellIndices`; samo dodanie `count` i loga nie naprawia wskazanego P0. |
| WP7 bounds | w dużej części wykonany | Renderer już preferuje magnetic support bounds. Brakuje osobnej komendy fit-to-support. |
| WP8 console warning | niewystarczający | Powód incompatibility powinien być typowanym stanem zasobu i widocznym degraded UI, nie tylko logiem konsoli. |

Plan Opusa nie obejmuje kluczowych, obecnie dowiedzionych problemów: target-aware FDM carriers per obiekt/region, owner-qualified membership FEM, FEM generation identity, rzeczywistego multilayer, publikacji FMRM oraz scoping pól FDM.

## 7. Testy i granica dowodu

W bieżącym drzewie wykonano:

- pełny Control Room: **489 plików passed, 1 skipped; 4667 testów passed, 1 skipped** (niezależny audyt Explorer);
- drugi pełny przebieg: **490 plików / 4668 testów passed** (niezależny audyt renderera FDM);
- focused viewport/Explorer/Inspector/codecs: **17 plików / 248 testów passed**;
- focused Opus reconciliation: **6 plików / 100 testów passed**;
- `pnpm --dir apps/control-room check:architecture-hygiene`: passed;
- `pnpm --dir apps/control-room check:api-hygiene`: passed;
- `git diff --check`: passed.

Pierwsze uruchomienia Vitest bez `TMPDIR=/tmp` w części agentów kończyły się przed kolekcją przez brak Windows temp path; po ustawieniu `/tmp` testy przeszły. Nie jest to błąd produktu.

Zielone testy nie kwalifikują UI. Wiele „smoke testów” jest testowanych przez wyszukanie tekstu skryptu, a nie przez wykonanie WebGL. Brakuje testu mounted/browser:

- click Explorer object/region/Airbox → właściwy Inspector → ten sam render target;
- dwa obiekty i dwa regiony z niezależnym `Visible/Shaded/Wireframe/Vectors/Colorbar`;
- realny FMRM/FMVP/FMMT z backendu → codec → hook → adapter → piksele;
- fail-closed 204/stale/mismatch z jawnym komunikatem i recovery po nowej revision;
- `canvas` widoczny, WebGL context żywy, drawing buffer > 0 po zmianach targetów.

### Wykonane browser/WebGL QA

Na izolowanym Next dev `:3104` wykonano repozytoryjny fixture FDM. Przeszedł: selekcję regionu, healthy WebGL, FMVPv2 `12×8×2×3`, colorbar, shader pixel delta `2398/7416`, vectors delta `1526/7416`, trzy projekcje bez refetch topologii, dimension cage i zmianę profilu. Dowodzi to, że bazowy materiał/renderer potrafi działać na kontrolowanym kompletnym payloadzie. Nie dowodzi poprawności live API ani targetów obiektowych.

Audyt FEM na tym samym serwerze wykazał draw calls/uploads dla surface/wireframe/points, ale zakończył się błędem semantycznego wyboru Airboxa. Diagnostyka zgłosiła również niepoprawny/niekompletny `Content-Range` topologii. Test live FDM Inspector nie znalazł wymaganego węzła Visualization. Tym samym ścieżka produkcyjna Explorer → Inspector → resource → carrier nadal nie jest zakwalifikowana.

Sterowanie wbudowaną przeglądarką było niedostępne przez błąd bridge `sandboxCwd is not a local file URI`; jest to ograniczenie środowiska testowego, nie dowód zachowania aplikacji. Zrzuty użytkownika pozostają bezpośrednim dowodem widocznego objawu.

## 8. Architektura frontendowa

Automatyczne hygiene gates przechodzą, lecz nie pokrywają wszystkich reguł specyfikacji:

- Inspector importuje sibling module stores/hooks przez ścieżki `public`; gate je bezwarunkowo zwalnia, mimo zakazu bezpośrednich zależności modułowych.
- `Viewport3DModule.tsx` ma około 2834 linii i łączy resource orchestration, lifecycle, debug, controls, canvas, overlays i capture. Przekracza progi review z dokumentu modułowego wielokrotnie.
- `ModuleManifest.capabilityGate` jest zadeklarowane, ale registry/slot/tab host go nie wykonują.

Pozytywnie: w badanych ścieżkach nie znaleziono bezpośrednich `fetch()` z komponentów, ręcznych URL-i v2 poza warstwą API, powrotu do `/v1/live/current`, bootstrap/poll/preview ani ciężkich payloadów przez WebSocket. HTTP v2 pozostaje źródłem ciężkich danych, a WS służy invalidacji/zdarzeniom.

## 9. Plan naprawczy i bramki zamknięcia

1. **Backend FMRM i identity:** publikować maskę dla single-grid i multilayer; owner-qualified legend; walidacja generation/fingerprint/grid; bump revision po publikacji.
2. **Target-aware FDM render model:** utworzyć carriers per object/region na jednym wspólnym sampled buffer; niezależne ustawienia, picking, wektory i colorbar.
3. **Field contract:** wspierać FDM object/region/layer scopes i natywne per-layer payloady; żadnego częściowego indeksowania przy mismatch.
4. **FEM provenance/carriers:** zachować string generation identity; nie renderować globalnego fallbacku jako substytutu obiektu; naprawić owner identity regionu.
5. **Airbox:** bounds/envelope + wektorowe pola; bez surface shader; bez domyślnego gęstego inactive-cell wireframe.
6. **Explorer/Inspector parity:** prawdziwe panele Mesh w trzech poziomach i regionach; usunąć martwe/duplikowane dzieci oraz produktowe `FDM Grid`.
7. **Browser qualification:** wykonać realne FEM i FDM sesje, dwa obiekty z kolidującymi nazwami regionów, Airbox, shader, wireframe, vectors, colorbar, visibility; zapisać screenshoty i payload hashes.

Zamknięcie jest możliwe dopiero, gdy kliknięcie każdego targetu zmienia jego rzeczywisty carrier w 3D, payloady mają zgodną provenance, a test browser/WebGL potwierdza pikselową zmianę bez utraty kontekstu. Obecny stan nie spełnia tej bramki.

## 10. Addendum po implementacji (2026-08-05)

Ta sekcja rozdziela poprawki w kodzie od dowodów, których nie można zamknąć bez pełnej sesji browserowej i kwalifikacji solvera.

### Rozwiązane i zweryfikowane

- FDM ma wspólny model target-aware dla obiektu i regionu. Jeden model komórek jest współdzielony, a indeksy są partycjonowane po owner-qualified `region_legend`/masce. Obiekt ma również aggregate carrier, więc działa także wtedy, gdy każda komórka należy do regionu.
- `Visible`, `Shaded`, `Wireframe`, `Points`, wektory, quantity i colorbar są rozwiązywane per target. Zmiana Inspectora nie jest już ignorowana przez viewport przy braku registry backendowego; pending override jest stosowany do renderera.
- FDM Airbox jest osobnym targetem extent/vector-only. Nie dostaje shadera materiałowego ani gęstego wireframe’u nieaktywnych voxeli. Dla `204` bez payloadu pole dostaje jawny stan „not materialized” i działający Retry.
- FEM zachowuje carriers per mesh-part, fail-closed topology/provenance oraz owner-qualified region identity. Membership, vector budget, FieldMeta i cache nie kolidują dla dwóch obiektów z tym samym `region_id`.
- Explorer/Inspector zachowują wspólną nomenklaturę `Mesh`, węzeł `Visualization` istnieje także dla obiektów `primitive-only`, a smoke helper poprawnie odsłania wirtualizowane dzieci.
- API/FMRM/FMMI/FMVP zachowują scope i provenance. Scoped FDM obsługuje owner-qualified object/region, `max_samples` przez FMVP v3 z explicit cell ordinals oraz `geometry_scope=surface` dla granicy Airboxa. Multilayer pozostaje celowo fail-closed.
- CLI zachowuje bezpieczny `PreparationFailure.detail`, a bieżąca materializacja `relax_projected_gradient_bb_fdm.py` kończy się `preparation=ready`: Universe `800×325×90 nm`, grid `128×32×30`, `960/122880` aktywnych komórek. Błąd z przytoczonego logu nie został odtworzony na bieżącym helperze; jego źródło pozostaje nieustalone bez pełnego `PreparationFailure.detail` i najpewniej dotyczy starszego/rozjechanego procesu. Bieżący helper nie emituje ostrzeżeń FEM dla czystego FDM.

### Reprodukcja wskazanego uruchomienia CLI

Uruchomienie bieżącego binarium bez warstwy sieciowej (ta sama ścieżka materializacji i planowania) zostało wykonane poleceniem:

```text
FULLMAG_API_PORT=0 FULLMAG_FDM_EXECUTION=cpu fullmag relax_projected_gradient_bb_fdm.py --backend fdm --headless --json
```

Wynik: `script materialized`, plan `fdm`, Universe `800×325×90 nm`, grid `128×32×30`, `960/122880` aktywnych komórek, etap relaksacji zakończony po 123 krokach. Nie wystąpiło `Simulation materialization failed`. Przy `FULLMAG_API_PORT=0` pojawiły się wyłącznie oczekiwane ostrzeżenia o niedostępnym live sync, ponieważ API jest celowo wyłączone.

Wcześniejszy log z czterokrotnymi ostrzeżeniami o „generated shared-domain FEM mesh” nie odpowiada bieżącemu czystemu FDM (`fem` w aktualnym ProblemIR ma wartość `null`); należy go traktować jako log starszego binarium/procesu lub innego środowiska. Interaktywny rerun na osobnych portach nie został ponowiony, ponieważ środowisko wykonawcze odrzuciło eskalację localhost z powodu globalnego limitu uruchomień. Nie należy na tej podstawie deklarować finalnej kwalifikacji browserowej.

### Dowód testowy

- Control Room: `494` pliki passed, `1` skipped; `4767` testów passed, `1` skipped — PASS przy uruchomieniu serialnym `vitest run --no-file-parallelism`. Pierwszy przebieg równoległy miał znany, niestabilny `ChartLegend.rowsBinary.integration.test.tsx` (izolowane uruchomienie PASS).
- Focused target/API/viewport/Inspector: `380` testów plus focused owner-qualified suite `301` testów — PASS.
- API Rust: scoped FDM `3/3`, FMRM/membership `13/13` — PASS.
- Python materialization regression: `2 passed, 52 deselected`.
- Typecheck, architecture hygiene, API hygiene, ESLint, webpack production build oraz `git diff --check` — PASS.
- Izolowany FDM target smoke na bieżącym HEAD przeszedł canvas/WebGL, niezależne targety obiektów/regionów, cykl render modes oraz Airbox vectors. Kontrolowany FEM smoke przeszedł canvas, mesh-backed target i cykl `Wireframe/Points/Off/Shaded`; QA harness zakończył się `12/12`.

### Nadal otwarte bramki i ograniczenia

- Ostatni pełny browser rerun po zmianie fixture fallbacku został zablokowany globalnym limitem uruchomień Chromium. Nie ma więc aktualnego, jednego artefaktu obejmującego wszystkie nowe poprawki; wcześniejsze metryki należy traktować jako dowód częściowy, nie jako finalną kwalifikację.
- FMRM validator nadal nie sprawdza formalnie `legend_count`, `region_legend_fingerprint` ani zakresu numeric IDs względem maski. To osobny P2 kontraktu binary-data, wymagający najpierw uzgodnienia kompatybilności v1/v2.
- Multilayer FDM nie ma jeszcze jednego kompletnego carrier/FMRM/FMVP kontraktu; frontend pozostaje fail-closed zamiast udawać wspólną siatkę.
- Nie wykonano produkcyjnej kwalifikacji naukowej FEM/FDM, parytetu solverów ani dowodu na rzeczywistym GPU/device. Testy UI i fixture nie zastępują walidacji numerycznej.
- `react-doctor` nie został uruchomiony, ponieważ środowisko nie rozwiązuje `registry.npmjs.org` (`EAI_AGAIN`); nie jest to dowód błędu aplikacji.

**Ocena postępu:** procent bez uzgodnionych wag jest pozorny. Uczciwa ocena to około `85%` problemów implementacyjnych zamkniętych i około `15%` pozostających jako luki kontraktu, ograniczenia browsera albo kwalifikacji naukowej. Nie jest to `100%` gotowości produkcyjnej.
