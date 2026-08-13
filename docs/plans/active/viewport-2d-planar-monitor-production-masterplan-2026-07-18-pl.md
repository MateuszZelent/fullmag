# 2D Viewport and Planar Monitor Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dostarczyć produkcyjny moduł `field-map`, prezentowany użytkownikowi jako **2D View**, który wizualizuje wszystkie opublikowane wielkości przestrzenne Fullmag na płaszczyźnie, w warstwie o skończonej grubości, w projekcji przez domenę albo na wybranej powierzchni; wprowadzić kanoniczny i reprodukowalny `PlanarMonitor`; oraz zapewnić jeden wspólny system inspektorów obsługujący konteksty 3D i 2D, w tym pola wektorowe.

**Architecture:** Python DSL, `SceneDocument` i `ProblemIR` przechowują definicję fizycznej ramki monitora oraz operator redukcji, ale nie przypisują monitora na stałe do jednej quantity ani palety. Backendowy `PlanarSamplingEngine` jest jedynym miejscem realizującym interpolację i ważenie FDM/FEM. API v2 publikuje cienkie zasoby JSON oraz ciężkie bufory binarne. Aktywny tylko jeden ciężki moduł `viewport-main`: `viewport-3d` pozostaje jedynym WebGL/R3F, a `field-map` używa renderera Canvas 2D/worker bez drugiego kontekstu WebGL. Inspektory zachowują jedną semantyczną rejestrację celu i przełączają jedynie profil prezentacji `3d | planar`.

**Tech Stack:** Python 3 dataclasses i flat `StudyBuilder` DSL; Rust/Serde/Axum/Utoipa; `fullmag-ir`, `fullmag-authoring`, `fullmag-quantities` i `fullmag-api`; OpenAPI v2 z generowanym klientem TypeScript; React 19, Next.js 16, TypeScript 5.8, Canvas 2D/OffscreenCanvas, Web Workers, shadcn/ui-style shared primitives, Catppuccin `--fm-*` tokens, Vitest, pytest, Rust tests, browser smoke przez CDP/Playwright-compatible scripts oraz zarządzany runtime FEM uruchamiany wyłącznie przez repozytoryjne receptury `just`.

## Global Constraints

- [x] Każda zmiana fizyki próbkowania lub numeryki zaczyna się od publikacyjnej noty w `docs/physics/`; kod nie wyprzedza zatwierdzonej semantyki.
- [x] `PlanarMonitor` opisuje geometrię, zakres przestrzenny, target i operator redukcji. Quantity, komponent, paleta, jednostka prezentacji i zakres koloru należą do profilu widoku, dzięki czemu jeden monitor działa dla wielu quantities.
- [x] Wynik fizyczny nigdy nie jest prostą średnią z węzłów. Liczba węzłów i elementów jest diagnostyką; wartość jest ważona miarą przecięcia: objętością, powierzchnią albo długością wzdłuż normalnej.
- [x] FDM i FEM używają wspólnych równań i wspólnego kontraktu wyniku, ale odrębnych, jawnych realizacji numerycznych.
- [x] Wszystkie wartości transportowane przez data plane są w SI. Zmiana `A/m ↔ T`, prefiksów i innych jednostek pozostaje prezentacyjna.
- [x] `viewport-3d` pozostaje jedyną powierzchnią WebGL/R3F. `field-map` nie importuje Three.js, R3F ani kodu warstw 3D.
- [x] Tylko aktywny moduł `viewport-main` jest zamontowany. Nie wolno utrzymywać ukrytego canvasa, workera, subskrypcji ciężkich zasobów ani pętli animacji dla nieaktywnego modułu.
- [x] React components nie wykonują bezpośredniego `fetch()`, nie składają ścieżek z route family `/v2/` i nie przechowują dużych typed arrays w React state.
- [x] Każda nowa ścieżka JSON jest najpierw opisana w OpenAPI; frontend używa generowanych typów, `ControlRoomApi` i resource hooks.
- [x] Wszystkie klasy CSS w `apps/control-room` mają prefiks `fm-`; komponenty konsumują `--fm-*`; `app/globals.css` pozostaje import-only.
- [x] Interaktywne prymitywy używają współdzielonej warstwy shadcn/ui-style, a nie lokalnych odpowiedników.
- [x] Pierwszy render klienta musi być zgodny z SSR; stan layoutu, store, cache i browser APIs wymaga `useSyncExternalStore` albo jawnej bramki hydracji.
- [x] Każda zmiana natywnego FEM/MFEM lub rzeczywista walidacja FEM używa najpierw dopasowanej receptury `just`; hostowe `cargo`, bezpośredni runtime i ręczny Docker są wyłącznie diagnostyką.
- [x] Współdzielony brudny worktree jest zachowywany. Przed każdym committem implementator uruchamia osobno `git diff --cached --name-only` i stage'uje wyłącznie pliki bieżącego zadania.

---

## 1. Status, zakres i źródła prawdy

### 1.1 Stan tego dokumentu

Ten plik jest planem wykonawczym i decyzją programową dla nowego przestrzennego widoku 2D. Nie oznacza, że funkcje są już zaimplementowane. Każdy etap ma osobną definicję stanu:

- **contract-complete** — dokumenty, publiczne typy i testy kontraktowe są zgodne;
- **implemented** — kod istnieje i przechodzi testy jednostkowe;
- **runtime-executable** — rzeczywisty runtime publikuje dane dla danego backendu;
- **browser-verified** — interakcja i lifecycle są sprawdzone w prawdziwej przeglądarce;
- **scientifically-validated** — wyniki przechodzą analityczne, zbieżnościowe i cross-backend gates;
- **production-ready** — wszystkie powyższe stany oraz finalne bramki jakości są zielone.

Nie wolno zastępować tych stanów jednym ogólnym określeniem „gotowe”.

### 1.2 Dokumenty nadrzędne

Implementacja musi być zgodna z:

- `AGENTS.md`;
- `docs/specs/resource-first-control-room-api-v2.md`;
- `docs/adr/0011-resource-first-api.md`;
- `docs/adr/0013-frontend-v2-module-kernel.md`;
- `docs/adr/0016-center-viewport-tabbed-surfaces.md`;
- `docs/specs/frontend-v2/01-module-kernel-architecture.md`;
- `docs/specs/frontend-v2/02-module-catalog.md`;
- `docs/specs/frontend-v2/03-api-integration-layer.md`;
- `docs/specs/frontend-v2/04-state-management.md`;
- `docs/specs/frontend-v2/05-viewport-architecture.md`;
- `docs/specs/frontend-v2/14-viewport-3d-module.md`;
- `docs/specs/frontend-v2/15-viewport-2d-module.md`;
- `docs/specs/frontend-v2/26-viewport-3d-surface-field-projection.md`;
- `docs/specs/capability-matrix-v0.md`.

### 1.3 Relacja do wcześniejszych planów

Ten masterplan zastępuje w zakresie interaktywnej przestrzennej wizualizacji 2D:

- `docs/plans/fem-2d-visualization-plan.md`;
- `docs/plans/active/comsol-style-cross-section-mesh-visualization-plan-2026-05-28.md`;
- część dotyczącą przyszłego `field-map` w `docs/plans/active/viewport-tabs-server-rendered-2d-analysis-masterplan-2026-05-30.md`.

Nie usuwa wartości istniejących formatów i zasobów:

- FMCS/FMQS nadal służą do przecięć i jakości siatki;
- server-rendered PNG pozostaje ścieżką eksportu, diagnostyki i lekkiego fallbacku;
- `analysis-plots` nadal obsługuje historie czasowe, widma i wykresy analityczne;
- `viewport-3d` nadal obsługuje jedyną interaktywną scenę WebGL.

### 1.3.1 Baseline przeglądarkowy po audycie (2026-08-12)

Historyczne raporty i screenshoty z lipca pod
`.fullmag/reports/viewport-2d-planar-monitor-smoke/` nie są dowodem aktualnego
`HEAD`. Od Task 0 browser smoke zapisuje wynik `pass: true` tylko wtedy, gdy
każdy uchwycony raster ma stan `ready` i jego telemetryka jest zgodna z
odpowiedzią `meta` zużytą przez przeglądarkę: monitor ID, operator kind,
quantity/component, `meta.etag` jako tymczasowa sample identity, field revision,
checksum/range rastra oraz liczby glyph/contour/mesh. Niepusty canvas z
poprzedniego żądania nie jest dowodem nowego żądania. Canonical sample token
pozostaje pracą Task 4; do tego czasu `meta.etag` jest wyłącznie jawnie oznaczoną
tożsamością tymczasową.

Nowe fixture baseline'u to
`examples/viewport_2d_planar_monitor_fem_compact_smoke.py` i
`examples/viewport_2d_planar_monitor_fdm_multi_object_smoke.py`. Ich obecność
nie oznacza wykonanej kwalifikacji managed runtime; receptura `just` musi zostać
osobno uruchomiona i zachować świeże artefakty.

### 1.4 Zakres produkcyjnego wydania

W zakresie są:

1. `field-map` / **2D View** jako top-level center surface;
2. dowolna opublikowana przestrzenna quantity z katalogu quantities;
3. scalar, komponent wektora, magnitude, orientacja i wektory w bazie monitora;
4. płaszczyzny `xy`, `xz`, `yz` oraz arbitralna ortonormalna ramka;
5. dokładne cięcie płaszczyzną;
6. średnia w warstwie o skończonej grubości;
7. projekcja przez pełną głębokość targetu;
8. projekcja wybranej powierzchni na ramkę;
9. heatmap, colorbar, contours, mesh overlay, vectors, probe i maska pustych próbek;
10. fizyczne targety monitora: domena, domena magnetyczna, obiekt i region; `SurfaceProjection` wybiera fizyczną granicę targetu; runtime-only view scopes: mesh part i airbox, z capability gatingiem quantity;
11. wspólne inspektory z profilami 3D/2D;
12. canonical Python round-trip, `ProblemIR`, provenance, OpenAPI i resource hooks;
13. migracja `cross-section-image` do eksportu/fallbacku bez dwóch konkurencyjnych workflow;
14. testy FDM/FEM, browser smoke, performance i memory lifecycle.

Poza pierwszym produkcyjnym wydaniem pozostają, z jawnym powodem:

- pełne, topologicznie bezstratne rozwinięcie arbitralnej zakrzywionej powierzchni do atlasu UV — wymaga osobnego kontraktu szwów, metryki i wielowartościowego odwzorowania;
- równoczesne utrzymywanie kilku aktywnych ciężkich viewportów — koliduje z regułą jednego aktywnego center surface i budżetem pamięci;
- WebGPU — nie jest potrzebne do założonych budżetów 2D i zwiększa powierzchnię kwalifikacji;
- edycja monitora przez gesty 3D w pierwszym pionowym wycinku — najpierw musi być stabilny draft/commit i numeryka; wizualny gizmo jest osobnym rozszerzeniem po P10;
- movie export i animacja po czasie — wymagają polityki próbkowania artefaktów i kodera, niezależnej od statycznego widoku 2D.

---

## 2. Audyt stanu bieżącego

| Obszar | Stan w repozytorium | Ocena |
|---|---|---|
| Center surfaces | Zarejestrowane `viewport-3d`, `cross-section-image`, `analysis-plots`; brak `field-map` | brak docelowego modułu |
| Lifecycle | `ViewportTabHost` montuje tylko aktywny moduł | właściwy fundament |
| 2D field API | Istnieją slice/projection meta, scalar, matrix JSON, PNG, arrows, mask i profile | częściowo wykonane |
| FDM slice | `crates/fullmag-api/src/field_slice.rs` ma axis-aligned slice i projection | użyteczny fundament |
| FEM exact plane | `fem_tetra_linear_slice` i lokalna topologia tetra | wykonane dla obecnego kontraktu |
| FEM projection | konserwatywna projekcja objętościowa i depth profile | wykonane dla obecnego kontraktu |
| Slab | `SliceVisualizationMode::Slab` istnieje semantycznie, backend matrix ma część ścieżki, status nadal nie jest produkcyjny | niespójne E2E |
| Arbitrary frame | Publiczny kontrakt ograniczony do `xy|xz|yz` | brak |
| Surface mapping | 3D ma `surface_projection_mode`; nie ma kanonicznej przestrzennej mapy 2D | brak |
| Static cross-section | `cross-section-image` generuje PNG jakości siatki i używa in-memory `crossSectionWorkspaceStore` | zachować jako export/fallback |
| Frontend facade | `apiPaths.ts` zna field slice/projection, lecz `ControlRoomApi` i resource hooks ich nie udostępniają | brak warstwy dostępu |
| 2D renderer | brak aktywnego renderera przestrzennego; `analysis-plots` nie jest odpowiednim właścicielem field maps | brak |
| Visualization state | istnieje rozbudowany `slice`, lecz miesza geometrię cięcia, quantity i prezentację | wymaga rozdzielenia |
| Inspector | istnieje rozbudowany panel visualization dla targetów 3D oraz osobny cross-section inspector | grozi duplikacją |
| Python/IR | brak `PlanarMonitor` w DSL, `SceneDocument` i `ProblemIR` | brak reprodukowalności |
| Quantity catalog | centralny katalog i field-store istnieją | właściwe źródło availability |
| Browser verification | istnieją smokes 3D i cross-section PNG | trzeba dodać 2D field-map |

Wniosek: nie należy pisać drugiego samplera ani drugiej aplikacji 2D. Należy wydzielić obecne algorytmy slice/projection do jednego backendowego silnika, domknąć semantykę monitora i podłączyć nowy moduł przez istniejący kernel.

---

## 3. Decyzje produktowe i rozważone warianty

### 3.1 Wybrany wariant

Wybrany jest wariant **server-authoritative sampling + client-side non-WebGL rendering**:

1. backend wybiera fizyczne próbki, interpoluje i redukuje FDM/FEM;
2. API publikuje metadane, scalar raster, vector samples, maskę i overlay;
3. frontend mapuje bufory na jeden model renderowania;
4. dedykowany Canvas 2D renderer rysuje raster i warstwy;
5. UI wykonuje pan/zoom bez ponownego samplowania, a nowy request wysyła po ustabilizowaniu draftu.

To jedyny wariant spełniający jednocześnie naukową spójność, małe payloady, brak drugiego WebGL i możliwość interakcji.

### 3.2 Warianty odrzucone

| Wariant | Zaleta | Powód odrzucenia |
|---|---|---|
| Wyłącznie server-rendered PNG | prosty frontend | brak probe, interaktywnych units/range, lokalnego pan/zoom, vectors i płynnej zmiany quantity |
| Drugi R3F/WebGL viewport | łatwe użycie istniejących warstw 3D | drugi kontekst GPU, powtórzenie lifecycle i naruszenie ADR 0016 |
| Client-only sampling z pełnej siatki | minimalny backend API | duże payloady, duplikacja numeryki FDM/FEM w TypeScript, nieuczciwe uśrednianie FEM |
| ECharts heatmap z obiektem na każdą komórkę | gotowe axes/tooltips | koszt modelu dla 262 144+ próbek i niepotrzebne przebudowy; ECharts pozostaje dla analysis plots |
| Osobny zestaw inspectorów 2D | szybki pionowy prototyp | drift semantyczny, podwójne targety i złamanie zasady jednego UI tree |

### 3.3 Nazwy i ownership

- identyfikator modułu: `field-map`;
- nazwa widoczna: `2D View`;
- kanoniczna definicja przestrzenna: `PlanarMonitor`;
- profil prezentacji: `PlanarViewProfile`;
- backendowy właściciel numeryki: `PlanarSamplingEngine`;
- statyczny eksport: `render.png`, dostępny z aktywnej konfiguracji;
- `cross-section-image` nie pozostaje docelowym osobnym top-level workflow po zakończeniu migracji.

---

## 4. Kontrakt naukowy `PlanarMonitor`

### 4.1 Układ współrzędnych

Ramka monitora jest prawoskrętną bazą:

\[
\mathcal{F} = (\mathbf{o}, \mathbf{e}_u, \mathbf{e}_v, \mathbf{n}),
\qquad
\mathbf{e}_v = \mathbf{n} \times \mathbf{e}_u,
\]

gdzie:

- \(\mathbf{o}\) — origin w metrach;
- \(\mathbf{e}_u\), \(\mathbf{e}_v\), \(\mathbf{n}\) — jednostkowe, wzajemnie ortogonalne wektory;
- \((u,v)\) — współrzędne widoku w metrach;
- \(s\) — odległość wzdłuż normalnej w metrach;
- \(\mathbf{x}(u,v,s)=\mathbf{o}+u\mathbf{e}_u+v\mathbf{e}_v+s\mathbf{n}\).

Publiczny Python przyjmuje `normal` i `u_axis`; `v_axis` jest wyprowadzany i walidowany. IR przechowuje pełną znormalizowaną bazę, intent presetu i wersję normalizacji. Presety:

- `xy`: \(\mathbf{e}_u=+\hat x\), \(\mathbf{e}_v=+\hat y\), \(\mathbf{n}=+\hat z\);
- `xz`: \(\mathbf{e}_u=+\hat x\), \(\mathbf{e}_v=+\hat z\), \(\mathbf{n}=-\hat y\), aby zachować prawoskrętność;
- `yz`: \(\mathbf{e}_u=+\hat y\), \(\mathbf{e}_v=+\hat z\), \(\mathbf{n}=+\hat x\).

Każda odpowiedź meta zwraca bazę rozwiązaną przez runtime. Frontend nie odgaduje orientacji osi.

### 4.2 Extent i target

`PlanarExtentPolicy`:

- `explicit`: jawne `u_min_m`, `u_max_m`, `v_min_m`, `v_max_m`;
- `target_bounds`: projekcja aktualnych bounds targetu z paddingiem SI;
- `magnetic_domain`: projekcja bounds wszystkich aktywnych ciał magnetycznych;
- `universe`: projekcja bounds domeny, łącznie z airboxem.

`MonitorTarget` jest oddzielnym typem od istniejącego `FieldTarget`, ponieważ target źródła pola i target obserwacji mają inne capability. Pozostaje fizyczny:

- `magnetic_domain`;
- `domain`;
- `object(object_id)`;
- `region(object_id, region_id)`.

`mesh_part` i `airbox` nie są wariantami `MonitorTargetIR`, ponieważ są realizacją dyskretyzacji/runtime, a nie definicją problemu fizycznego. Obsługują je runtime-only `PlanarViewScope`:

- `monitor_target` — bez dodatkowego filtrowania;
- `mesh_part(part_id)` — przecięcie z resolved mesh part bieżącej `mesh_revision`;
- `airbox` — przecięcie z resolved exterior domain.

`PlanarViewScope` należy do visualization state/data request i provenance, nie do Python DSL ani `ProblemIR`. Zmiana siatki może unieważnić `mesh_part(part_id)` bez mutacji kanonicznego monitora. API zwraca wtedy stabilny `stale_mesh_scope`, a UI wymaga ponownego wyboru resolved part.

Intent extentu pozostaje w `ProblemIR`; runtime zapisuje rozwiązane granice w provenance. Zmiana geometrii nie zamienia po cichu dynamicznego `target_bounds` na stare liczby.

### 4.3 Operatory

Kanoniczna unia `PlanarOperatorIR` ma cztery warianty:

1. `plane_sample`
   - próbka na \(s=0\);
   - `thickness_m` nie występuje;
   - FDM używa jawnej rekonstrukcji cell-constant, FEM używa funkcji bazowych bieżącego rzędu;
   - wynik zachowuje jednostkę quantity.

2. `slab_average`
   - skończona grubość \(t>0\);
   - obszar \(s \in [-t/2,t/2]\);
   - średnia tylko po zajętej części targetu;
   - wynik zachowuje jednostkę quantity.

3. `depth_projection`
   - integracja przez pełne przecięcie targetu wzdłuż \(\mathbf n\);
   - reduction: `mean_occupied`, `thickness_integral`, `rms`, `min`, `max`, `abs_max`;
   - `thickness_integral` ma jednostkę `quantity_unit * m`;
   - `mean_occupied` nie wstawia zera za powietrze, chyba że jawny `empty_policy=include_air_as_zero` jest dozwolony dla danej quantity.

4. `surface_projection`
   - źródłem jest jawnie wybrana granica targetu;
   - boundary faces są rzutowane do \((u,v)\);
   - `visibility_policy`: `frontmost`, `backmost`, `nearest_to_origin` albo `area_weighted_overlap`;
   - odpowiedź raportuje `overlap_count`, `fold_count` i `non_injective`;
   - planar surface bez nakładania jest ścieżką production;
   - dla zakrzywionej lub wielowartościowej powierzchni UI pokazuje diagnostykę zamiast udawać bezstratne rozwinięcie.

### 4.4 Semantyka rastra

Raster nie może mieszać próbkowania punktowego z uśrednianiem po pikselu bez informacji w meta:

- `plane_sample` używa `sample_support=point_center`: każdy wynik odpowiada \(\mathbf{x}(u_i,v_j,0)\) w środku piksela; exact FEM oznacza dokładne znalezienie przecinającego tetraedru i ewaluację P1, nie średnią z jego węzłów;
- `slab_average` i `depth_projection` używają `sample_support=pixel_prism`: wynik reprezentuje fizyczny footprint piksela \([u_i^-,u_i^+]\times[v_j^-,v_j^+]\) i dozwolony przedział \(s\);
- `surface_projection` używa `sample_support=projected_pixel_area` i raportuje, czy fizyczna powierzchnia została ważona area czy projected area;
- exact mesh intersection polygons są overlay/provenance, a nie ukrytą zmianą point sample na area average;
- zmiana resolution zmienia footprint operatorów konserwatywnych, dlatego actual resolution i physical pixel size są częścią request identity i provenance.

Jeżeli późniejszy use case wymaga `plane_pixel_average`, otrzymuje osobny wersjonowany operator; nie zmienia się znaczenia `plane_sample`.

### 4.5 Definicja średniej

Dla skalara \(q\) średnia w warstwie ma postać:

\[
\bar q(u,v) =
\frac{
\int_{\Omega_{\mathrm{target}}\cap C_{uv}} q(\mathbf x)\,d\mu
}{
\int_{\Omega_{\mathrm{target}}\cap C_{uv}} d\mu
},
\]

gdzie \(C_{uv}\) jest kolumną piksela ograniczoną operatorem, a \(d\mu\) jest właściwą miarą:

- objętością dla slab/depth volume reduction;
- powierzchnią dla surface reduction;
- długością przecięcia dla ciągłej interpretacji pojedynczej kolumny;
- dokładnym polem przekroju dla plane sampling na elementach.

Ważenie liczbą węzłów:

\[
\frac{1}{N}\sum_i q_i
\]

jest zabronione jako wynik fizyczny, ponieważ adaptacyjne zagęszczenie FEM zmienia wynik bez zmiany pola. `selected_node_count`, `selected_element_count` i `occupied_measure` pozostają diagnostyką.

### 4.6 Wektory i komponenty

Redukcja pola wektorowego odbywa się przed wyprowadzeniem komponentu:

\[
\bar{\mathbf q} =
\frac{\int \mathbf q\,d\mu}{\int d\mu}.
\]

Dopiero z \(\bar{\mathbf q}\) wylicza się:

- world: `x`, `y`, `z`;
- monitor basis: `u`, `v`, `normal`;
- `magnitude`;
- `in_plane_magnitude`;
- `orientation`;
- glyph \((q_u,q_v)\) z opcjonalnym wskaźnikiem \(q_n\).

Nie wolno uśredniać magnitude, gdy użytkownik wybrał magnitude wektora, a potem nazywać wyniku magnitude średniego wektora. API meta jawnie rozróżnia:

- `vector_then_component` — domyślne i używane przez wspólny kontrakt;
- `component_then_reduce` — dostępne tylko dla operatorów, gdzie użytkownik jawnie tego zażądał i provenance zachowuje tę decyzję.

Dla orientation wektor o normie poniżej `orientation_epsilon` otrzymuje maskę `undefined_orientation`; nie jest kolorowany przypadkowym hue.

### 4.7 FDM

- Źródłem jest opublikowane pole na regularnej siatce cell-centered.
- Domyślna rekonstrukcja to `cell_constant`; interpolacja trilinear nie jest sugerowana bez jawnej polityki.
- Plane sample bierze wartość komórki zawierającej punkt albo maskę poza domeną.
- Slab/depth używa objętości przecięcia komórki z kolumną piksela i przedziałem \(s\).
- Dla osiowego presetu można użyć szybkiego sumowania warstw, ale wynik musi być bitowo lub tolerancyjnie zgodny z ogólnym operatorem.
- GPU solver nie oznacza GPU samplera. Provenance zapisuje `source_execution_device` i osobno `sampling_execution=cpu`.

### 4.8 FEM

- P1 plane sample znajduje tetraedr przecinany przez point-center i używa barycentrycznej interpolacji; dokładne tetra-plane polygons należą do overlay i occupancy diagnostics.
- Slab/depth dla P1 używa konserwatywnej integracji po przecięciu tetraedru z kolumną/slabem; istniejący `fem_tetra_volume_projection_conservative` jest punktem startowym.
- Boundary surface używa trójkątów granicznych, ich fizycznej powierzchni i funkcji bazowych.
- Spatial index jest cache'owany po `mesh_revision` i nie jest przebudowywany na każdą zmianę quantity.
- Wyższy rząd FEM jest capability-gated, dopóki sampler nie ewaluje rzeczywistych funkcji bazowych; fallback do P1 nie może być ukryty.
- Odpowiedź raportuje `integration_order`, `basis_order`, `measure_error_estimate`, `spatial_index_revision` i `sampling_method`.

### 4.9 Puste komórki, airbox i maska

Każdy piksel ma occupancy:

- `occupied`;
- `empty`;
- `partial`;
- `undefined_orientation`;
- `overlap_ambiguous` dla niedozwolonej projekcji powierzchni.

Domyślnie pusta próbka jest maskowana i nie wpływa na min/max, histogram ani auto range. `include_air_as_zero` jest dopuszczalne wyłącznie jako jawna polityka projekcji i nie może być domyślnym sposobem „wypełnienia” brakujących danych. Quantity magnetyczne nie stają się dostępne w airboxie tylko dlatego, że airbox jest widoczny.

### 4.10 Provenance wyniku

`PlanarSampleMetaResource` zawiera co najmniej:

- `schema_version`;
- `monitor_id`, `monitor_revision`, `monitor_hash`;
- `quantity_id`, canonical SI unit, component expression;
- `field_revision`, `mesh_revision`, `generation_id`;
- resolved live/stage/snapshot field source identity;
- requested i resolved frame/extent/operator;
- requested i resolved `PlanarViewScope`, w tym resolved part identity;
- `sample_support`, actual resolution i physical pixel size;
- `source_backend`, `source_device`, `source_precision`;
- `sampling_execution`, `sampling_method`, `basis_order`, `integration_order`;
- raster shape, pixel-center coordinates i physical bounds;
- occupied/partial/empty counts i miarę;
- min/max tylko po prawidłowych wartościach;
- error estimate i diagnostyki;
- ETagi wszystkich zasobów składowych.

Eksport PNG/CSV/NPY zapisuje ten manifest obok danych albo osadza jego hash w metadanych.

---

## 5. Kanoniczny model i publiczne interfejsy

### 5.1 Python DSL

**Create:** `packages/fullmag-py/src/fullmag/model/planar_monitor.py`

Docelowy publiczny kształt:

```python
midplane = study.monitors.add_planar(
    name="midplane",
    target=fm.MonitorTarget.object("film"),
    frame=fm.PlanarFrame.xy(
        position=0.0,
        extent=fm.PlanarExtent.target_bounds(padding=2e-9),
    ),
    operator=fm.SlabAverage(thickness=5e-9),
)
```

Arbitralna orientacja:

```python
oblique = study.monitors.add_planar(
    name="oblique",
    target=fm.MonitorTarget.magnetic_domain(),
    frame=fm.PlanarFrame(
        origin=(0.0, 0.0, 0.0),
        normal=(1.0, 1.0, 1.0),
        u_axis=(1.0, -1.0, 0.0),
        extent=fm.PlanarExtent.explicit(
            u=(-80e-9, 80e-9),
            v=(-40e-9, 40e-9),
        ),
    ),
    operator=fm.PlaneSample(),
)
```

Publiczne typy:

```python
PlanarOperator = PlaneSample | SlabAverage | DepthProjection | SurfaceProjection

@dataclass(frozen=True, slots=True)
class PlanarMonitor:
    name: str
    target: MonitorTarget
    frame: PlanarFrame
    operator: PlanarOperator
```

Wymagania:

- nazwa unikalna w `Problem.monitors`;
- wszystkie liczby skończone;
- thickness dodatnie tylko dla `SlabAverage`;
- frame normal/u_axis niekolinearne i normalizowane deterministycznie;
- monitor nie ma pola `quantity`, `component`, `colormap`, `display_unit`, `resolution` ani `quality`;
- resolution, quality i vector budget należą do `PlanarViewProfile`/data request; manifest eksportu zachowuje ich rzeczywiste wartości;
- flat script rewrite generuje wywołanie `study.monitors.add_planar` ze wszystkimi argumentami kanonicznymi, nie anonimowy słownik.

**Modify:**

- `packages/fullmag-py/src/fullmag/model/__init__.py`;
- `packages/fullmag-py/src/fullmag/__init__.py`;
- `packages/fullmag-py/src/fullmag/model/problem.py`;
- `packages/fullmag-py/src/fullmag/world.py`;
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`.

`Problem` otrzymuje `monitors: Sequence[PlanarMonitor] = ()`. `StudyBuilder.__init__` otrzymuje `self.monitors = StudyMonitorRegistry()`.

### 5.2 ProblemIR

**Create:** `crates/fullmag-ir/src/planar_monitor.rs`

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanarMonitorIR {
    pub id: String,
    pub name: String,
    pub target: MonitorTargetIR,
    pub frame: PlanarFrameIR,
    pub operator: PlanarOperatorIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarOperatorIR {
    PlaneSample,
    SlabAverage { thickness_m: f64 },
    DepthProjection { reduction: PlanarReductionIR, empty_policy: EmptyPolicyIR },
    SurfaceProjection {
        boundary: SurfaceBoundarySelectorIR,
        visibility_policy: SurfaceVisibilityPolicyIR,
    },
}
```

**Modify:**

- `crates/fullmag-ir/src/lib.rs`;
- `crates/fullmag-ir/src/validation.rs`;
- `crates/fullmag-ir/tests/ir_tests.rs`.

`ProblemIR` otrzymuje:

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub planar_monitors: Vec<PlanarMonitorIR>,
```

Deserializacja poprzednich wersji daje pustą listę. Dodanie pola bez zmiany semantyki istniejących pól wymaga testu zgodności poprzedniego publicznego IR. Jeżeli polityka wersjonowania wymaga podniesienia `CURRENT_IR_VERSION`, migracja jest jawna w `migrate_problem_ir_json_value`; nie wolno zmienić wersji wyłącznie w Pythonie.

### 5.3 SceneDocument i round-trip

**Modify:**

- `crates/fullmag-authoring/src/scene.rs`;
- `crates/fullmag-authoring/src/builder.rs`;
- `crates/fullmag-authoring/src/adapters.rs`;
- `crates/fullmag-authoring/src/validation.rs`;
- `crates/fullmag-api/src/script.rs`;
- `packages/fullmag-py/tests/test_script_builder_roundtrip.py`.

Docelowe pola:

```rust
pub struct SceneDocument {
    // istniejące pola
    #[serde(default)]
    pub monitors: SceneMonitorState,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct SceneMonitorState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub planar: Vec<PlanarMonitorIR>,
}

pub struct ScriptBuilderState {
    // istniejące pola
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub planar_monitors: Vec<PlanarMonitorIR>,
}
```

Round-trip musi spełnić:

```text
Python → ProblemIR → SceneDocument → ScriptBuilderState → canonical Python
       → ProblemIR
```

z zachowaniem monitor id, intent extentu, frame, operatora i targetu. UI nie zapisuje monitors wyłącznie w `editor`, ponieważ monitor jest częścią reprodukowalnego problemu. View resolution i quality nie wracają do `SceneDocument`; trafiają do visualization state oraz manifestu eksportu.

### 5.4 ID i rename

- `id` jest stabilnym slug/UUID generowanym raz przy create;
- `name` jest edytowalną etykietą;
- referencje runtime i workspace używają `id`, nie nazwy;
- duplicate tworzy nowy `id`;
- delete jest odrzucany `409`, jeżeli przyszły saved view lub output jawnie referuje monitor; w pierwszym wydaniu brak takiej referencji oznacza bezpieczne delete;
- rename nie zmienia cache identity fizycznej definicji, ale podnosi `scene_revision`.

### 5.5 Planner i runtime

- ProblemIR validation sprawdza geometrię ramki, target references i operator.
- Validation odrzuca `mesh_part` i `airbox` w `MonitorTargetIR`; są dozwolone wyłącznie jako runtime `PlanarViewScope`.
- Planner zachowuje monitors w plan/provenance, ale sam monitor nie wybiera backendu i nie zmienia równań solvera.
- Samo zadeklarowanie monitora nie wymusza materializacji wszystkich pól i nie blokuje solve, jeżeli żaden wymagany output nie referuje konkretnej quantity.
- Żądanie danych 2D dla quantity uruchamia istniejący `compute_fields`/preview materialization contract. Brak pola zwraca jawne `quantity_not_materialized` albo `quantity_unsupported`, bez wyboru innej quantity.
- Jeżeli przyszły output stage zadeklaruje obowiązkowy zapis `quantity @ monitor`, strict planning sprawdza operator/backend przed run i failuje przed wykonaniem; nie jest to część pierwszego wydania.
- Runtime provenance zachowuje authored monitor intent oraz resolved frame, extent, mesh/field revisions i sampler implementation.
- `auto` resolution w `PlanarViewProfile` może być rozwiązane do konkretnego rasteru, ale requested `auto` i resolved dimensions pozostają w provenance artefaktu.

---

## 6. Backend `PlanarSamplingEngine`

### 6.1 Wydzielenie odpowiedzialności

**Create:** `crates/fullmag-api/src/planar_sampling/`

```text
planar_sampling/
  mod.rs
  contract.rs
  frame.rs
  fdm.rs
  fem.rs
  surface.rs
  reduction.rs
  provenance.rs
  tests.rs
```

**Refactor:**

- `crates/fullmag-api/src/field_slice.rs`;
- `crates/fullmag-api/src/field_projection.rs`;
- `crates/fullmag-api/src/fem_slice.rs`;
- `crates/fullmag-api/src/fem_slice_overlay.rs`;
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`.

`field_slice.rs` i `field_projection.rs` stają się cienkimi compatibility adapters albo są włączone do modułu. Nie mogą pozostać drugim źródłem równań.

Główny interfejs:

```rust
pub trait PlanarFieldSource {
    fn descriptor(&self) -> &QuantityDescriptor;
    fn mesh_revision(&self) -> u64;
    fn sample_planar(
        &self,
        request: &ResolvedPlanarSampleRequest,
        caches: &PlanarSamplingCaches,
    ) -> Result<PlanarSampleResult, PlanarSamplingError>;
}
```

`PlanarSampleResult` zawiera jeden wspólny layout:

```rust
pub struct PlanarSampleResult {
    pub meta: PlanarSampleMeta,
    pub scalar_values: Vec<f64>,
    pub vector_values: Option<Vec<[f64; 3]>>,
    pub occupancy: Vec<u8>,
    pub overlay: Option<FemSliceOverlay>,
}
```

Wewnętrzny `Vec` jest dopuszczalny na backendzie; frontend dostaje bounded binary resources. Cache nie kluczuje tylko po quantity, lecz po:

```text
field_revision + mesh_revision + monitor_hash + operator + resolution
+ field_source_selector + component_expression + view_scope + empty_policy
+ sampler_version
```

### 6.2 Compatibility z obecnymi endpointami

Istniejące:

- `/v2/sessions/current/data/fields/{quantity_id}/samples/slice/meta`;
- `/v2/sessions/current/data/fields/{quantity_id}/samples/slice/scalar`;
- `/v2/sessions/current/data/fields/{quantity_id}/samples/slice/matrix.json`;
- `/v2/sessions/current/data/fields/{quantity_id}/samples/slice/render.png`;
- `/v2/sessions/current/data/fields/{quantity_id}/samples/slice/arrows`;
- `/v2/sessions/current/data/fields/{quantity_id}/projection/meta`;
- `/v2/sessions/current/data/fields/{quantity_id}/projection/scalar`;
- `/v2/sessions/current/data/fields/{quantity_id}/projection/matrix.json`;
- `/v2/sessions/current/data/fields/{quantity_id}/projection/render.png`;
- `/v2/sessions/current/data/fields/{quantity_id}/projection/empty-mask`;
- `/v2/sessions/current/data/fields/{quantity_id}/projection/profile`;

pozostają w okresie migracji. Ich query jest deterministycznie mapowane do anonimowego `ResolvedPlanarMonitor`:

- `plane` → preset frame;
- `cut_world|cut_norm` → origin;
- `mode=exact` → `plane_sample`;
- `mode=slab` → `slab_average`;
- projection → `depth_projection`.

Compatibility response zachowuje dotychczasowe media types i ETag. Test parity porównuje obecny endpoint z nowym monitor endpointem na tych samych danych. Dopiero po dwóch wydaniach z telemetrycznie zerowym użyciem starego frontendu można zaplanować osobne usunięcie.

### 6.3 Quantity materialization

**Modify only if tests expose a global gap:**

- `crates/fullmag-quantities/src/catalog.rs`;
- `crates/fullmag-quantities/src/descriptor.rs`;
- `crates/fullmag-quantities/src/registry.rs`;
- `crates/fullmag-api/src/field_store.rs`;
- `crates/fullmag-api/src/quantity_data_plane.rs`;
- `crates/fullmag-api/src/router_v2/handlers/data/quantities.rs`;
- `crates/fullmag-runner/src/quantities.rs`;
- `crates/fullmag-runner/src/fdm/cpu/reference.rs`;
- `crates/fullmag-runner/src/fem/relax/preview.rs`;
- `crates/fullmag-runner/src/interactive_runtime/display_preview.rs`;
- `crates/fullmag-runner/src/interactive_runtime/fem/gpu.rs`;
- `crates/fullmag-cli/src/interactive_runtime_host.rs`;
- `crates/fullmag-cli/src/orchestrator.rs`.

Reguła: brak `H_demag` lub innej quantity w 2D naprawia się przez canonical quantity catalog, field-store/API facade i globalne materializowanie `compute_fields`, a nie przez specjalny warunek w `field-map`.

Quantity manifest otrzymuje capability:

```json
{
  "planar_sampling": {
    "spatial": true,
    "components": ["x", "y", "z", "magnitude", "u", "v", "normal"],
    "domain_scopes": ["magnetic_domain", "domain"],
    "operators": ["plane_sample", "slab_average", "depth_projection"],
    "surface_projection": true
  }
}
```

Global scalars takie jak `E_total` mają `spatial=false`; density `eden_total` może być próbkowana. UI pokazuje powód, nie pustą mapę.

---

## 7. Resource-first API v2

### 7.1 Model resources

**Create:**

- `crates/fullmag-api/src/schemas/planar_monitors.rs`;
- `crates/fullmag-api/src/router_v2/handlers/model/planar_monitors.rs`.

**Modify:**

- `crates/fullmag-api/src/schemas/mod.rs`;
- `crates/fullmag-api/src/router_v2/handlers/model.rs`;
- `crates/fullmag-api/src/router_v2/mod.rs`;
- `crates/fullmag-api/src/openapi_v2.rs`;
- `crates/fullmag-api/src/router_v2/tests.rs`.

Routes:

```text
GET    /v2/sessions/current/model/planar-monitors
POST   /v2/sessions/current/model/planar-monitors
GET    /v2/sessions/current/model/planar-monitors/{monitor_id}
PATCH  /v2/sessions/current/model/planar-monitors/{monitor_id}
DELETE /v2/sessions/current/model/planar-monitors/{monitor_id}
POST   /v2/sessions/current/model/planar-monitors/{monitor_id}/duplicate
```

Mutation rules:

- request niesie `expected_scene_revision`;
- konflikt revision zwraca `409` z bieżącą revision;
- create/patch/delete przechodzi przez istniejący SceneDocument transaction path;
- udany commit aktualizuje canonical script i emituje revision invalidation;
- walidacja używa tych samych typów co `fullmag-ir`;
- `GET list` jest cienkim JSON bez danych pola.

### 7.2 Data resources

**Create:** `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`

Routes:

```text
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/meta
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/scalar
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/vectors
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/empty-mask
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/mesh-overlay
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/probe
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/render.png
```

Query wspólne:

```text
component=x|y|z|u|v|normal|magnitude|in_plane_magnitude|orientation
scope_kind=monitor_target|mesh_part|airbox
scope_id=<required only for mesh_part>
stage_id=<optional canonical stage id>
snapshot_id=<optional field snapshot id within stage>
resolution_x=16..2048
resolution_y=16..2048
quality=interactive|export
vector_budget=0..10000
include_mesh=true|false
```

`scope_kind` zawęża resolved physical monitor target, ale go nie rozszerza. `mesh_part` i `airbox` są sprawdzane względem bieżącego target registry i `mesh_revision`. Brak `stage_id`/`snapshot_id` oznacza bieżące live field; `snapshot_id` wymaga `stage_id`, a istniejący stage/snapshot authorization path sprawdza relację. Mode/eigen/frequency fields używają opublikowanego canonical quantity id i tego samego selector, nie osobnego samplera. `meta` jest wymagane przed ciężkimi zasobami i zwraca canonical URLs/ETags. `probe` przyjmuje `u_m`, `v_m` i zwraca world coordinate, raw vector/scalar, displayed component, occupancy, element/cell id oraz sampling method.

Media types:

| Zasób | Format |
|---|---|
| meta | JSON |
| scalar | istniejący FMVP v2, shape z meta |
| vectors | istniejący FMVP v2 vector payload |
| empty-mask | bounded `u8` binary, shape z meta |
| mesh-overlay | istniejący FMCS, rozszerzony tylko wersjonowaną ramką jeśli konieczne |
| probe | JSON |
| render.png | PNG jako eksport/fallback |

Nie tworzyć nowego binary codec, jeżeli FMVP/FMCS przenoszą wymagane dane bez semantycznego oszustwa. Jeżeli frame metadata wymaga rozszerzenia FMCS, podnieść wersję formatu i utrzymać decoder poprzedniej wersji.

### 7.3 Statusy i błędy

| Status | Znaczenie |
|---|---|
| `200` | zasób dostępny |
| `204` | poprawne zapytanie, ale brak opublikowanych danych dla bieżącej revision |
| `304` | ETag zgodny |
| `400` | nieprawidłowa rama, component, resolution albo operator |
| `404` | brak monitora, quantity lub sesji |
| `409` | stale monitor/mesh/field revision albo niemożliwy spójny snapshot |
| `422` | quantity istnieje, lecz operator/target nie jest naukowo obsługiwany |
| `503` | sampler przekroczył jawny budżet i nie może bezpiecznie zdegradować |

Każdy błąd ma stabilny `code`, user-facing `message`, `capability_reason` i revision context. Frontend nie parsuje tekstu.

### 7.4 Realtime

- WebSocket przesyła wyłącznie invalidation dla monitor collection/item i planar field resources;
- zmiana monitora invaliduje wszystkie quantities dla jego `monitor_id`;
- zmiana field revision invaliduje tylko odpowiadającą quantity;
- zmiana mesh revision invaliduje monitor meta, scalar, vectors, mask i overlay;
- zmiana palety albo display unit nie invaliduje backend field resources;
- status nie zawiera rasterów ani wektorów.

### 7.5 OpenAPI i generated client

Po każdej zmianie kontraktu:

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test -- src/kernel/api/openapiV2GeneratedContract.test.ts
pnpm --dir apps/control-room run check:api-hygiene
```

Generated files:

- `apps/control-room/src/kernel/api/generated/openapi-v2.json`;
- `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`;
- `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`;
- `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`.

Manual edits generated files są zabronione.

---

## 8. Frontend API, cache i state ownership

### 8.1 Typed facade

**Modify:**

- `apps/control-room/src/kernel/api/apiPaths.ts`;
- `apps/control-room/src/kernel/api/apiTypes.ts`;
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`;
- `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`;
- `apps/control-room/src/kernel/api/fieldQueryIdentity.ts`.

Facade udostępnia dokładnie następujące operacje:

- `api.model.planarMonitors.list(options)`;
- `api.model.planarMonitors.create(request, options)`;
- `api.model.planarMonitors.get(monitorId, options)`;
- `api.model.planarMonitors.patch(monitorId, request, options)`;
- `api.model.planarMonitors.remove(monitorId, request, options)`;
- `api.model.planarMonitors.duplicate(monitorId, request, options)`;
- `api.data.fields.planar.meta(quantityId, monitorId, query, options)`;
- `api.data.fields.planar.scalar(quantityId, monitorId, query, options)`;
- `api.data.fields.planar.vectors(quantityId, monitorId, query, options)`;
- `api.data.fields.planar.emptyMask(quantityId, monitorId, query, options)`;
- `api.data.fields.planar.meshOverlay(quantityId, monitorId, query, options)`;
- `api.data.fields.planar.probe(quantityId, monitorId, query, options)`;
- `api.data.fields.planar.renderPng(quantityId, monitorId, query, options)`.

`fieldQueryIdentity.ts` normalizuje kolejność i domyślne wartości query. Float identity używa kanonicznego zapisu, nie przypadkowego `String(number)` w kilku modułach.

### 8.2 Resource hooks

**Create:**

- `apps/control-room/src/kernel/resources/planarMonitorResources.ts`;
- `apps/control-room/src/kernel/resources/planarFieldResources.ts`;
- `apps/control-room/src/kernel/resources/planarFieldResources.test.ts`.

Hooks:

```ts
usePlanarMonitorsResource()
usePlanarMonitorResource(monitorId)
usePlanarFieldMetaResource(request, options)
usePlanarScalarResource(request, options)
usePlanarVectorResource(request, options)
usePlanarMaskResource(request, options)
usePlanarMeshOverlayResource(request, options)
usePlanarProbeResource(request, options)
```

Zasady cache:

- osobny byte budget dla scalar, vectors i overlay;
- revision oraz ETag są częścią identity;
- request jest anulowany przy zmianie quantity/monitor/operator;
- stary raster może pozostać wizualnie jako `stale` wyłącznie z czytelną plakietką do czasu nowej odpowiedzi;
- `not-applicable` usuwa stary cache entry;
- cache nie przechowuje `ImageBitmap` po unmount; bitmapa należy do renderer lifecycle;
- `ResourceInvalidationController` mapuje nowe resource keys;
- inactive `field-map` nie rozpoczyna fetchy.

### 8.3 State ownership

| Stan | Właściciel | Persistence |
|---|---|---|
| committed monitor | `SceneDocument` / ProblemIR | canonical Python/project |
| monitor draft | inspector-local draft store | nie, poza czasem edycji |
| aktywny center surface | `LayoutController` | per-client UI persistence |
| aktywny monitor id | `PlanarViewportStore` | per-client UI persistence |
| live/stage/snapshot field source | workspace selection + `PlanarViewportStore` | per-client UI persistence |
| quantity/component/palette/range | `visualization/state.planar` | session visualization state |
| resolution/quality/vector budget | `visualization/state.planar` | session visualization state i export provenance |
| display unit | istniejący display-unit policy | presentation persistence |
| server field buffers | `ResourceCache` | memory only |
| renderer bitmap/paths | worker/renderer instance | memory only |
| probe hover | renderer-local external store | memory only |
| saved export artifact | artifact/session persistence | artifact provenance |

### 8.4 Visualization state

**Modify:**

- `crates/fullmag-api/src/schemas/visualization_state.rs`;
- `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`;
- generated types;
- `apps/control-room/src/kernel/visualization/useVisualizationStateResource.ts`;
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`;
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`;
- `apps/control-room/src/kernel/visualization/visualizationCommandContributions.ts`;
- `apps/control-room/src/kernel/visualization/visualizationCommandContributions.test.ts`;
- `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts`;
- `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.test.ts`;
- `apps/control-room/src/modules/viewport-3d` wyłącznie w zakresie compatibility projection.

Docelowy nowy branch:

```rust
pub struct PlanarVisualizationState {
    pub active_monitor_id: Option<String>,
    pub view_scope: PlanarViewScopeState,
    pub quantity_id: String,
    pub component: PlanarFieldComponent,
    pub colormap: String,
    pub auto_contrast: bool,
    pub contrast_min: Option<f64>,
    pub contrast_max: Option<f64>,
    pub display_unit: Option<String>,
    pub resolution: PlanarResolutionPolicy,
    pub quality: PlanarRenderQuality,
    pub layers: PlanarLayerState,
    pub vector_style: PlanarVectorStyleState,
    pub interaction: PlanarInteractionState,
}
```

Istniejący `slice` pozostaje compatibility projection podczas migracji. Nowy frontend zapisuje `planar`, a backend synchronizuje wspólne pola do compatibility tylko do czasu odcięcia starego workflow. 3D state nie jest nadpisywany przy zmianie 2D quantity, więc powrót do 3D zachowuje poprzedni profil.

### 8.5 Draft/commit

Obecny `apps/control-room/src/kernel/workspace/crossSectionWorkspace.ts` jest migrowany:

- `CrossSectionDraft` → `PlanarMonitorDraft`;
- axis plane i position percent są convenience projection na pełny frame;
- commit wywołuje model transaction;
- udany commit wybiera returned monitor id i otwiera `field-map`;
- anulowanie przywraca committed monitor bez PATCH;
- dirty draft ma Apply/Discard zgodne z ADR 0008;
- concurrent revision conflict pokazuje diff/reload, nie nadpisuje sceny.

Po migracji in-memory `CrossSectionPlot[]` nie jest źródłem prawdy.

---

## 9. Moduł `field-map`

### 9.1 Struktura

**Create:**

```text
apps/control-room/src/modules/field-map/
  manifest.ts
  manifest.test.ts
  fieldMapCommands.ts
  fieldMapCommands.test.ts
  FieldMapModule.tsx
  FieldMapModule.test.tsx
  FieldMapView.tsx
  FieldMapToolbar.tsx
  FieldMapStatusBar.tsx
  FieldMapErrorBoundary.tsx
  useFieldMapController.ts
  fieldMapStore.ts
  fieldMapStore.test.ts
  model/
    fieldMapDataPlan.ts
    fieldMapDataPlan.test.ts
    fieldMapRenderModel.ts
    fieldMapRenderModel.test.ts
    fieldMapCapabilities.ts
    fieldMapCapabilities.test.ts
    fieldMapProbe.ts
    fieldMapProbe.test.ts
  renderer/
    PlanarSurface.tsx
    PlanarSurface.test.tsx
    planarRenderer.ts
    planarRenderer.test.ts
    planarRendererWorker.ts
    planarRendererProtocol.ts
    planarFrameScheduler.ts
    planarFrameScheduler.test.ts
    colorRaster.ts
    colorRaster.test.ts
    marchingSquares.ts
    marchingSquares.test.ts
    vectorGlyphs.ts
    vectorGlyphs.test.ts
    meshOverlay.ts
    meshOverlay.test.ts
    interactionTransform.ts
    interactionTransform.test.ts
  public.ts
```

**Modify:**

- `apps/control-room/src/modules/registry.ts`;
- `apps/control-room/src/modules/index.ts`;
- `apps/control-room/src/modules/index.test.ts`;
- `apps/control-room/src/kernel/layout/layoutTypes.ts`;
- `apps/control-room/src/kernel/persistence/controlRoomUiState.ts`;
- `apps/control-room/src/kernel/resources/inactiveViewportResourcePolicy.ts`;
- `apps/control-room/app/globals.css` wyłącznie przez dodanie importu `field-map.css`;
- **Create:** `apps/control-room/src/design/styles/field-map.css`.

Manifest:

```ts
import type { ModuleManifest } from "@/kernel/types";

import { fieldMapCommands } from "./fieldMapCommands";

export const fieldMapManifest: ModuleManifest = {
  id: "field-map",
  title: "2D View",
  version: "1.0.0",
  slots: ["viewport-main"],
  component: () => import("./FieldMapModule"),
  contributes: {
    commands: fieldMapCommands,
  },
};
```

Commands:

- `field-map.open`;
- `field-map.select-monitor`;
- `field-map.fit`;
- `field-map.reset-view`;
- `field-map.export-png`;
- `field-map.export-data`;
- `field-map.toggle-vectors`;
- `field-map.toggle-contours`;
- `field-map.toggle-mesh`.

Ribbon, menu, shortcuts, context menu i command palette renderują te same command definitions.

### 9.2 Renderer

Renderer składa się z:

1. canvasa bazowego z rasterem;
2. canvasa overlay dla contours, mesh i vectors;
3. lekkiego DOM/SVG chrome dla osi, colorbar, labels, selection i accessibility;
4. workerowego przygotowania koloru/contours/glyph buffers;
5. jednego imperative renderer instance na mount.

Nie tworzy obiektu React per pixel ani per vector. Typed arrays pozostają poza React state.

Lifecycle:

- `ResizeObserver` ustawia drawing buffer z DPR cap;
- `requestAnimationFrame` jest używany tylko po invalidation;
- scheduler łączy wiele zmian w jedną klatkę;
- brak ciągłej pętli renderowania;
- unmount anuluje RAF, requesty i workera;
- `ImageBitmap.close()` jest wywołane przy zastąpieniu/unmount;
- event listeners i observer są usuwane;
- context 2D jest odnawiany po resize bez wycieku;
- reduced motion wyłącza animowane przejście skali.

### 9.3 Interakcja

- wheel/pinch zoom zakotwiczony pod kursorem;
- drag pan;
- double-click fit;
- klawiatura: strzałki pan, `+/-` zoom, `0` fit;
- hover probe jest throttled do jednej aktualizacji na frame;
- click pin probe; pinned probe ma world coordinate, \((u,v)\), SI i display value;
- podczas pan/zoom istniejący raster jest transformowany lokalnie;
- backend resampling następuje po zmianie monitora, quantity, operatora lub resolution, nie podczas samego viewport transform;
- drag thickness/position używa preview 256² i po `pointerup` żąda docelowej rozdzielczości.

### 9.4 Warstwy

`PlanarLayerState`:

- quantity raster;
- contours;
- mesh wireframe;
- object/region boundaries;
- vectors;
- out-of-plane indicator;
- primitives projection;
- airbox outline;
- probes;
- axes/grid;
- colorbar.

Warstwy niedostępne mają disabled control z reason code. Nie pokazuje się aktywnego switcha, który nic nie robi.

### 9.5 Scalar i color

- auto range ignoruje maskę i wartości niefinity;
- constant field dostaje stabilny symetryczny epsilon range;
- diverging palette może być wycentrowana na zero;
- manual range waliduje `min < max`;
- histogram i percentile range są wyliczane w workerze z bounded bins;
- colorbar pokazuje quantity symbol, component expression i display unit;
- wartości SI nie są mutowane przy zmianie display unit;
- orientation korzysta z istniejącej semantyki HSL, ale kod wspólny jest przeniesiony do neutralnej warstwy tylko wtedy, gdy nie importuje 3D lifecycle.

### 9.6 Vectors

- backend zwraca world vectors i world positions albo resolved \((u,v)\) z frame hash;
- adapter wylicza `u/v/normal`;
- glyph length ma `uniform`, `magnitude` i `clamped_magnitude`;
- color ma `orientation`, `magnitude`, `monochrome`;
- vector budget jest limitem, nie przypadkowym stride;
- sampling jest deterministyczny dla tego samego request identity;
- out-of-plane component może być pokazany markerem `⊙/⊗` lub kolorem, z legendą;
- zero vectors nie tworzą NaN geometry;
- UI pokazuje `rendered / available / budget`.

### 9.7 Contours i mesh

- contours używa testowanego marching squares na scalar raster;
- maskowane komórki przerywają linię;
- poziomy są manualne lub równomierne w display range;
- mesh overlay jest rysowany w physical monitor coordinates;
- cap segmentów jest jawny i raportowany;
- decimation zachowuje boundaries ważniejsze niż interior edges;
- surface projection pokazuje fold/overlap diagnostics.

### 9.8 Dostępność

- canvas ma accessible name opisujący quantity, monitor i operator;
- probe values są dostępne w DOM table i live region po świadomym pin;
- toolbar ma logiczny tab order i pełne labels;
- colorbar ma tekstowy min/max/unit;
- wszystkie informacje kodowane kolorem mają tekst/legendę;
- focus ring używa tokenów;
- contrast przechodzi WCAG dla chrome;
- high-contrast/reduced-motion są testowane;
- error/empty/degraded states nie istnieją tylko jako canvas pixels.

---

## 10. Jeden system inspectorów dla 3D i 2D

### 10.1 Zasada

Nie powstaje `PlanarObjectInspector`, `PlanarRegionInspector` ani drugi registry. Selekcja semantic node pozostaje identyczna. Relevant visualization panel otrzymuje:

```ts
type VisualizationViewContext = "three-d" | "planar";
```

Context jest wyprowadzany z `LayoutState.activeViewportMainModuleId`:

- `viewport-3d` → `three-d`;
- `field-map` → `planar`;
- non-spatial surface zachowuje ostatni spatial context, ale pokazuje że viewport nie jest aktywny.

Segmented control `3D | 2D` wykonuje command switch center surface. Nie jest drugim lokalnym booleanem.

### 10.2 Wspólne i kontekstowe pola

| Sekcja | Wspólna semantyka | 3D | 2D |
|---|---|---|---|
| Target | object/region/part/airbox identity | resolved 3D target | przecięcie targetu z monitorem |
| Visibility | czy target uczestniczy w profilu | surface/points/wireframe | raster/boundary/mesh |
| Quantity | ten sam katalog i availability | surface/volume field | planar sampled field |
| Component | world vector vocabulary | x/y/z/magnitude | x/y/z/u/v/normal/magnitude |
| Units | ten sam display-unit service | colorbar 3D | colorbar 2D |
| Range | auto/manual contract | 3D profile value | 2D profile value |
| Palette | shared palette catalog | surface colors | raster/contour colors |
| Vectors | shared field identity/style vocabulary | 3D glyphs | in-plane glyphs + normal marker |
| Geometry | target identity | surface, volume, points | monitor extent, boundary, mesh |
| Projection | projection semantics | surface field projection | plane/slab/depth/surface operator |
| Diagnostics | availability/provenance | 3D buffers | sampler/occupancy/error |

Wspólna semantyka nie oznacza wspólnej mutable wartości dla range/palette. Profile 3D i 2D zachowują własne ustawienia, aby przełączanie nie niszczyło przygotowanego widoku.

### 10.3 Pliki

**Modify:**

- `apps/control-room/src/modules/inspector/InspectorShell.tsx`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.tsx`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationHelpers.ts`;
- `apps/control-room/src/modules/inspector/panels/region/ObjectRegionVisualizationPanel.tsx`;
- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`;
- `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`;
- `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.tsx`;
- `apps/control-room/src/modules/inspector/panels/FrequencyDomainModeDisplayControls.tsx`;
- `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx`;
- `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.test.tsx`;
- `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`.

**Create:**

- `apps/control-room/src/modules/inspector/visualization/VisualizationViewContext.ts`;
- `apps/control-room/src/modules/inspector/visualization/VisualizationContextSwitch.tsx`;
- `apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.tsx`;
- `apps/control-room/src/modules/inspector/panels/PlanarMonitorInspectorPanel.tsx`;
- testy każdego nowego pliku.

### 10.4 Coverage relevant inspectorów

| Semantic target | Wymagany tryb 3D | Wymagany tryb 2D |
|---|---|---|
| Scene/universe | domain bounds/airbox | monitor extent i domain occupancy |
| Object | surface/mesh/field/vector | object-only slice/raster/vector |
| Object region | region overlay | region-only mask/raster/boundary |
| Mesh part | part surface/wireframe | part intersection/quality overlay |
| Airbox | full extent/wireframe/vector if available | airbox outline i full-domain field only |
| Spatial result field | 3D surface/volume projection | monitor quantity/component |
| Eigen/frequency spatial mode | 3D mode field | real/imag/amplitude/phase on monitor, jeśli resource istnieje |
| Planar monitor | 3D frame preview | frame/operator oraz view-sampling diagnostics |

General, material, physics i solver inspectors nie dostają sztucznego „trybu 2D”, ponieważ ich semantyka nie jest prezentacją przestrzenną. Wymaganie dotyczy wszystkich relevant visualization sections, nie każdego formularza aplikacji.

### 10.5 Monitor inspector

Sekcje:

1. **Identity** — name, target, committed revision;
2. **Frame** — preset/arbitrary, origin, normal, u axis, extent policy;
3. **Operator** — plane/slab/depth/surface, thickness/reduction/policy;
4. **View sampling** — resolution i quality zapisane w `PlanarViewProfile`, nie w monitorze;
5. **Layers** — quantity, contours, mesh, vectors, boundaries;
6. **Color** — component, unit, range, palette;
7. **Diagnostics** — occupied measure, nodes/elements as diagnostics, sampling method, error, revision;
8. **Actions** — Apply, Discard, Duplicate, Delete, Export.

Thickness jest edytowane w jednostce długości, nie procentach. Position percent może pozostać convenience UI dla presetów, ale committed IR przechowuje SI origin i extent policy.

---

## 11. Explorer, ribbon i workflow użytkownika

### 11.1 Explorer

**Modify:**

- `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`;
- `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`;
- `apps/control-room/src/modules/explorer/builders/crossSectionExplorerNodes.ts`;
- `apps/control-room/src/modules/explorer/explorerTypes.ts`;
- `apps/control-room/src/modules/explorer/explorerSelection.ts`.

Docelowe drzewo:

```text
Definitions
└── Monitors
    ├── Midplane
    └── Oblique slab

Results
└── Spatial fields
    └── Active 2D view
```

Monitor jest definicją authoring, więc mieszka w `Definitions`. `Results/Spatial fields` jest projekcją aktualnych danych i nie tworzy drugiej kopii monitora.

Node actions:

- Add Planar Monitor;
- Open in 2D View;
- Show Frame in 3D;
- Duplicate;
- Rename;
- Delete;
- Export current field.

Każdy monitor node ma własny `PlanarMonitorInspectorPanel`; nie używa generic inspector dla różnych child types.

### 11.2 Ribbon

**Modify:**

- `apps/control-room/src/modules/ribbon/ribbonTabViews.tsx`;
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`;
- `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`.

Zmiany:

- przycisk `2D` uruchamia `field-map.open`, nie `cross-section-image.open`;
- contextual groups w 2D: Monitor, Quantity, Layers, Range, Vectors, Export;
- aktywne command state pochodzi z registry/store;
- shortcut `2` zachowany;
- 3D controls nie są widoczne jako aktywne w 2D;
- cross-section image command staje się `Export PNG` w `field-map`, a nie top-level tab.

### 11.3 Główny workflow

1. Użytkownik wybiera `2D View`.
2. Jeżeli brak monitora, UI proponuje utworzenie `Midplane` z bounds aktywnego targetu; nic nie jest commitowane bez Apply.
3. Preview pokazuje preset plane i 256² dane, jeśli dostępne.
4. Apply zapisuje monitor przez SceneDocument transaction.
5. Użytkownik wybiera quantity z canonical catalog.
6. UI pobiera meta, potem scalar i wybrane overlays.
7. Component/unit/range/palette zmieniają prezentację bez mutacji monitora.
8. Thickness/operator zmieniają draft monitora i po Apply podnoszą scene revision.
9. Przełączenie na 3D unmountuje 2D renderer; opcja `Show Frame in 3D` pokazuje tylko lekką ramkę w istniejącym 3D viewport.
10. Powrót do 2D odtwarza view profile i pobiera zasoby zgodne z revision.

---

## 12. Capability i degraded-state matrix

### 12.1 Capability dimensions

Planner/API/UI mówią jednym słownikiem:

```text
planar_monitor_authoring
planar_plane_sample
planar_slab_average
planar_depth_projection
planar_surface_projection
planar_arbitrary_frame
planar_vector_sampling
planar_mesh_overlay
planar_airbox_sampling
planar_high_order_basis
```

`docs/specs/capability-matrix-v0.md` otrzymuje osobną tabelę postprocessingu. Nie miesza ona „solver działa na GPU” z „sampler działa na GPU”.

### 12.2 Minimalna macierz

| Ścieżka | FDM | FEM P1 | FEM high-order |
|---|---|---|---|
| axis plane | production target | production target | gated |
| arbitrary plane | production target | production target | gated |
| slab mean | volume-weighted cells | conservative tetra integration | gated |
| depth mean/integral | volume-weighted cells | conservative tetra integration | gated |
| planar boundary surface | boundary cells/faces if published | boundary triangles | gated |
| general curved surface projection | diagnostic projection | diagnostic projection | gated |
| mesh overlay | grid outline optional | exact section FMCS | gated by topology |
| vectors | published vector field | nodal vector field | gated |
| airbox | full-domain quantities only | full-domain quantities + air mesh | gated |

### 12.3 Stabilne degraded reasons

- `quantity_not_spatial`;
- `quantity_not_materialized`;
- `target_outside_monitor`;
- `fem_topology_required`;
- `fem_basis_order_unsupported`;
- `surface_projection_non_injective`;
- `airbox_quantity_scope_unsupported`;
- `vector_component_unavailable`;
- `sampling_budget_exceeded`;
- `stale_mesh_scope`;
- `stale_monitor_revision`;
- `stale_field_revision`.

UI tłumaczy codes na tekst; logi i testy używają code.

---

## 13. Performance, pamięć i lifecycle gates

### 13.1 Budżety

Budżety są mierzone na dwóch fixture:

- small: 512² raster, do 1 200 vectors, do 50 000 mesh segments;
- large: 1024² raster, do 5 000 vectors, do 100 000 mesh segments.

Acceptance:

| Metryka | Gate |
|---|---|
| idle redraw | `0` nowych frame callbacks po 1 s stabilnego widoku |
| cached pan/zoom input | p95 handler + schedule `< 8 ms` |
| worker colorization 512² | p95 `< 50 ms` na CI reference |
| overlay build small | p95 `< 75 ms` |
| main-thread commit | p95 `< 16.7 ms` po gotowym `ImageBitmap` |
| warm cached quantity switch | first painted frame `< 150 ms` |
| small backend sample | p95 `< 500 ms` na fixture analitycznym |
| large backend sample | p95 `< 2 s`, timeout nie jest fallbackiem naukowym |
| resource cap | scalar + vectors + overlay cache zgodny z zadeklarowanym byte budget |
| 100 przełączeń 3D↔2D | brak rosnącej liczby workers/listeners/canvases; heap po GC nie więcej niż 20 MiB ponad stabilny baseline |
| inactive field-map | zero planar fetchów i zero żywych renderer workers |

Przed optymalizacją zapisuje się baseline. Jeżeli środowisko CI nie pozwala stabilnie egzekwować czasu absolutnego, zachowuje się bramkę regresji `<= 10%` względem checked-in baseline i absolutne limity jako browser report gate.

### 13.2 Skrypty

**Create:**

- `apps/control-room/scripts/smoke-viewport-2d.mjs`;
- `apps/control-room/scripts/audit-viewport-2d-performance.mjs`;
- `apps/control-room/scripts/audit-viewport-surface-switch-memory.mjs`.

**Modify:** `apps/control-room/package.json`

Scripts:

```json
{
  "smoke:viewport-2d": "node scripts/smoke-viewport-2d.mjs",
  "audit:viewport-2d-performance": "node scripts/audit-viewport-2d-performance.mjs",
  "audit:viewport-surface-switch-memory": "node scripts/audit-viewport-surface-switch-memory.mjs"
}
```

### 13.3 Browser lifecycle assertions

Smoke sprawdza:

- `field-map` jest aktywny i widoczny;
- brak WebGL canvas oraz brak aktywnego R3F context w 2D;
- 2D canvas ma niezerowy drawing buffer;
- scalar raster ma co najmniej dwa kolory dla fixture z gradientem;
- colorbar ma quantity i jednostkę;
- vectors są widoczne i bounded;
- probe zwraca zgodną world coordinate i wartość;
- zmiana thickness zmienia wynik zgodnie z fixture;
- przełączenie na 3D unmountuje 2D i tworzy zdrowy WebGL context;
- `gl.isContextLost() === false`;
- drawing buffer 3D jest niezerowy;
- powrót do 2D nie zostawia starego 3D canvasa;
- console nie zawiera nieobsłużonych błędów ani `THREE.WebGLRenderer: Context Lost` podczas startup/switch;
- po teardown nie ma aktywnego worker/RAF planu 2D.

---

## 14. Migracja i cutover

### 14.1 Etapy migracji

1. **Additive contract**
   - dodać monitor, sampler i API bez zmiany aktualnego ribbon command;
   - utrzymać stare endpointy.

2. **Hidden `field-map`**
   - moduł z capability flag dostępny w testach;
   - browser smoke na FDM i FEM.

3. **Inspector parity**
   - relevant panels mają context switch;
   - `field-map` korzysta z tego samego target registry.

4. **Default cutover**
   - ribbon `2D` otwiera `field-map`;
   - istniejące cross-section drafty są konwertowane do monitor draft;
   - PNG dostępne jako Export.

5. **Top-level cleanup**
   - `cross-section-image` przestaje być rejestrowanym center surface;
   - jego renderer/resource pozostaje wywoływany przez export/fallback;
   - usunąć command/node assumptions związane z osobnym tabem.

6. **Compatibility observation**
   - stare slice/projection endpoints pozostają;
   - removal wymaga osobnej decyzji po potwierdzeniu braku klientów.

### 14.2 Rollback

Rollback nie cofa formatu `ProblemIR` i nie traci monitors. Feature flag może:

- ukryć `field-map`;
- przywrócić command `2D` do statycznego PNG;
- zachować model resources i canonical Python;
- nie usuwać monitorów z projektów.

Rollback jest dozwolony dla problemu UI/performance. Nie wolno w rollbacku zastąpić measure-weighted FEM prostą średnią węzłową.

### 14.3 Usunięcia po spełnieniu gates

Po browser/science parity:

- wyrejestrować `crossSectionImageManifest` z `apps/control-room/src/modules/registry.ts`;
- usunąć top-level command `cross-section-image.open`;
- usunąć `CrossSectionPlot[]` jako source of truth;
- zachować `CrossSectionImageModule` tylko jeśli ma udokumentowaną funkcję fallbacku; w przeciwnym razie przenieść export viewer do `field-map` i usunąć moduł;
- zaktualizować `docs/specs/frontend-v2/15-viewport-2d-module.md`;
- zaktualizować `docs/ui/2d-slice.md`;
- zaktualizować `docs/status/2d-slice-capabilities.md` na stan dowiedziony testami.

---

## 15. Plan wykonawczy task-by-task

Każdy task kończy się zielonymi testami o wąskim zakresie. Commit jest wykonywany dopiero po osobnym:

```bash
git diff --cached --name-only
```

i potwierdzeniu, że staged set zawiera wyłącznie pliki tasku.

### Task 1: Zamknąć semantykę w physics note, ADR i spec

**Create:**

- `docs/physics/0970-planar-monitor-sampling-and-projection.md`;
- `docs/adr/0020-planar-field-map-and-monitor.md`.

**Modify:**

- `docs/specs/frontend-v2/02-module-catalog.md`;
- `docs/specs/frontend-v2/05-viewport-architecture.md`;
- `docs/specs/frontend-v2/15-viewport-2d-module.md`;
- `docs/specs/resource-first-control-room-api-v2.md`;
- `docs/specs/capability-matrix-v0.md`.

- [x] Napisać physics note z problem statement, równaniami, SI, assumptions, FDM, FEM, CPU/GPU interpretation, public API, IR, planner, runtime, provenance, validation i deferred work.
- [x] Dodać manufactured examples pokazujące błąd node-count averaging.
- [x] W ADR zaakceptować non-WebGL `field-map`, canonical monitor i single sampler.
- [x] Jawnie częściowo supersede ADR 0016 tylko w zakresie przejścia od osobnego statycznego Cross-Section workflow do interaktywnego `field-map`; utrzymać zakaz drugiego WebGL.
- [x] Zaktualizować module catalog i API resource tree.
- [x] Uruchomić `rg -n "PlanarMonitor|field-map|measure-weighted|surface_projection" docs/physics/0970-planar-monitor-sampling-and-projection.md docs/adr/0020-planar-field-map-and-monitor.md docs/specs`.
- [x] Review gate: miara, units, vector order i surface ambiguity zostały sprawdzone względem równań i jawnie zapisane w physics note; zewnętrzna kwalifikacja implementacji pozostaje w R4.

**Commit:** `docs: define planar monitor sampling contract`

### Task 2: Dodać Python DSL i ProblemIR

**Create:**

- `packages/fullmag-py/src/fullmag/model/planar_monitor.py`;
- `packages/fullmag-py/tests/test_planar_monitor.py`;
- `crates/fullmag-ir/src/planar_monitor.rs`.

**Modify:**

- `packages/fullmag-py/src/fullmag/model/__init__.py`;
- `packages/fullmag-py/src/fullmag/__init__.py`;
- `packages/fullmag-py/src/fullmag/model/problem.py`;
- `packages/fullmag-py/src/fullmag/world.py`;
- `crates/fullmag-ir/src/lib.rs`;
- `crates/fullmag-ir/src/validation.rs`;
- `crates/fullmag-ir/tests/ir_tests.rs`.

- [x] Najpierw napisać failing Python tests dla presetów, arbitrary frame, thickness, invalid collinearity, duplicate names, braku pól quantity/resolution w monitorze i exact IR JSON.
- [x] Napisać failing Rust deserialize/validate tests dla wszystkich operatorów, previous IR compatibility, invalid values oraz odrzucenia `mesh_part`/`airbox` jako canonical monitor target.
- [x] Zaimplementować minimalne typy i `study.monitors.add_planar`.
- [x] Dodać `planar_monitors` do `Problem.to_ir()`.
- [x] Upewnić się, że Python i Rust używają identycznego snake_case vocabulary.
- [x] Uruchomić:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q packages/fullmag-py/tests/test_planar_monitor.py
cargo test -p fullmag-ir planar_monitor
cargo test -p fullmag-ir --test ir_tests
```

Expected: wszystkie testy zielone; invalid fixture zwracają określone errors; poprzedni IR deserializuje pustą listę monitorów.

**Commit:** `feat(dsl): add canonical planar monitors`

### Task 3: Domknąć SceneDocument i canonical Python round-trip

**Modify:**

- `crates/fullmag-authoring/src/scene.rs`;
- `crates/fullmag-authoring/src/builder.rs`;
- `crates/fullmag-authoring/src/adapters.rs`;
- `crates/fullmag-authoring/src/validation.rs`;
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`;
- `packages/fullmag-py/tests/test_script_builder_roundtrip.py`;
- `crates/fullmag-api/src/script.rs`;
- `crates/fullmag-api/src/router_v2/tests.rs`.

- [x] Najpierw dodać failing round-trip fixture z plane, slab, depth i surface monitor.
- [x] Dodać `SceneMonitorState` i `ScriptBuilderState.planar_monitors`.
- [x] Dodać adaptery builder↔scene oraz validation target references.
- [x] Dodać deterministic canonical script rendering.
- [x] Sprawdzić round-trip equality po pominięciu tylko dozwolonej runtime provenance.
- [x] Uruchomić:

```bash
PYTHONPATH=packages/fullmag-py/src pytest -q packages/fullmag-py/tests/test_script_builder_roundtrip.py -k planar_monitor
cargo test -p fullmag-authoring planar_monitor
cargo test -p fullmag-api planar_monitor_round_trip
```

Expected: canonical rewrite zawiera `study.monitors.add_planar`, drugi export daje semantycznie identyczny `ProblemIR`.

**Commit:** `feat(authoring): round-trip planar monitors`

### Task 4: Wydzielić i zwalidować `PlanarSamplingEngine`

**Create:** cały katalog `crates/fullmag-api/src/planar_sampling/`.

**Modify:**

- `crates/fullmag-api/src/main.rs`;
- `crates/fullmag-api/src/field_slice.rs`;
- `crates/fullmag-api/src/field_projection.rs`;
- `crates/fullmag-api/src/fem_slice.rs`;
- `crates/fullmag-api/src/fem_slice_overlay.rs`;
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`.

- [x] Najpierw dodać manufactured tests: constant scalar, linear scalar, vector basis, empty mask, partial occupancy.
- [x] Dodać skew-tetra fixture, dla którego node average różni się od volume-weighted analytic value.
- [x] Dodać mesh refinement invariance gate.
- [x] Zaimplementować frame resolution i common result.
- [x] Przenieść FDM plane/slab/depth do jednego implementation.
- [x] Przenieść FEM exact plane i conservative projection bez zmiany obecnych wyników.
- [x] Dodać arbitrary frame.
- [x] Dodać surface projection z overlap diagnostics.
- [x] Przepiąć stare endpoints przez compatibility adapter.
- [x] Uruchomić:

```bash
cargo test -p fullmag-api planar_sampling
cargo test -p fullmag-api field_slice
cargo test -p fullmag-api field_projection
```

Expected tolerances z physics note:

- constant field: machine precision;
- FEM P1 linear plane: near machine precision;
- slab mean/integral: tolerance wynikająca z clipping/integration order;
- refinement invariance: wynik nie zmienia się wraz z samym zagęszczeniem;
- compatibility endpoint parity: exact equality albo udokumentowana tolerancja.

**Commit:** `refactor(api): unify planar field sampling`

### Task 5: Dodać monitor model resources i data resources

**Create:**

- `crates/fullmag-api/src/schemas/planar_monitors.rs`;
- `crates/fullmag-api/src/router_v2/handlers/model/planar_monitors.rs`;
- `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`.

**Modify:**

- `crates/fullmag-api/src/schemas/mod.rs`;
- `crates/fullmag-api/src/router_v2/handlers/model.rs`;
- `crates/fullmag-api/src/router_v2/handlers/data.rs`;
- `crates/fullmag-api/src/router_v2/mod.rs`;
- `crates/fullmag-api/src/openapi_v2.rs`;
- `crates/fullmag-api/src/router_v2/tests.rs`;
- `crates/fullmag-api/src/schemas/realtime.rs`;
- `crates/fullmag-api/src/main.rs`;
- `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`;
- `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`.

- [x] Najpierw dodać failing route tests dla CRUD, revision conflict, invalid target i missing monitor.
- [x] Dodać failing data tests dla meta/scalar/vectors/mask/overlay/probe/PNG.
- [x] Dodać scope tests: mesh part i airbox zawężają target tylko dla bieżącej mesh revision; stale part zwraca `stale_mesh_scope`.
- [x] Dodać field-source tests: live default, valid stage snapshot, snapshot bez stage, snapshot spoza stage i stale snapshot revision.
- [x] Dodać ETag/304 oraz stale mesh/field conflict tests.
- [x] Zaimplementować model transactions przez SceneDocument.
- [x] Zaimplementować data routes przez `PlanarSamplingEngine`.
- [x] Dodać bounded query validation przed alokacją.
- [x] Dodać invalidation-only realtime tests.
- [x] Uruchomić:

```bash
cargo test -p fullmag-api planar_monitor
cargo test -p fullmag-api planar_field
cargo test -p fullmag-api openapi
```

Expected: wszystkie routes obecne w OpenAPI, heavy arrays nieobecne w status i WebSocket payload.

**Commit:** `feat(api): publish planar monitor resources`

### Task 6: Wygenerować frontend transport, facade i hooks

**Create:**

- `apps/control-room/src/kernel/resources/planarMonitorResources.ts`;
- `apps/control-room/src/kernel/resources/planarFieldResources.ts`;
- `apps/control-room/src/kernel/resources/planarFieldResources.test.ts`.

**Modify:**

- `apps/control-room/src/kernel/api/apiPaths.ts`;
- `apps/control-room/src/kernel/api/apiTypes.ts`;
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`;
- `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`;
- `apps/control-room/src/kernel/api/fieldQueryIdentity.ts`;
- `apps/control-room/src/kernel/resources/ResourceInvalidationController.ts`;
- generated API files przez generator.

- [x] Najpierw dodać facade tests, resource key normalization tests, 304-without-cache failure i cancellation tests.
- [x] Uruchomić `pnpm --dir apps/control-room generate:api`.
- [x] Dodać facade methods bez ręcznego response typing, jeśli generated schema wystarcza.
- [x] Dodać resource hooks z `enabled` i revision-aware caches.
- [x] Dodać tests, że inactive hook nie wysyła request.
- [x] Uruchomić:

```bash
pnpm --dir apps/control-room test -- src/kernel/api/ControlRoomApi.test.ts
pnpm --dir apps/control-room test -- src/kernel/resources/planarFieldResources.test.ts
pnpm --dir apps/control-room test -- src/kernel/api/openapiV2GeneratedContract.test.ts
pnpm --dir apps/control-room run check:api-hygiene
```

Expected: zero ręcznych endpoint strings poza API layer, generated diff zgodny z backend OpenAPI.

**Commit:** `feat(control-room): add planar field resources`

### Task 7: Zbudować module shell i renderer scalar

**Create:** pliki `apps/control-room/src/modules/field-map/` dla manifestu, store, controller, data plan, render model i scalar renderer oraz `apps/control-room/src/design/styles/field-map.css`.

**Modify:**

- `apps/control-room/src/modules/registry.ts`;
- `apps/control-room/src/modules/index.ts`;
- `apps/control-room/src/modules/index.test.ts`;
- `apps/control-room/src/kernel/resources/inactiveViewportResourcePolicy.ts`;
- `apps/control-room/app/globals.css` przez dodanie importu `../src/design/styles/field-map.css` w warstwie `fm-modules`.

- [x] Najpierw dodać manifest/module/store/data-plan tests.
- [x] Dodać hydration-safe external store.
- [x] Dodać canvas lifecycle test z mocked 2D context.
- [x] Dodać worker protocol i scalar colorization tests.
- [x] Dodać resize/RAF/dispose tests.
- [x] Zaimplementować loading/empty/error/stale/degraded surfaces.
- [x] Dodać axes, colorbar, units i auto/manual range.
- [x] Uruchomić:

```bash
pnpm --dir apps/control-room test -- src/modules/field-map
pnpm --dir apps/control-room typecheck
```

Expected: aktywny `field-map` renderuje scalar fixture; inactive moduł nie subskrybuje planar resources; unmount kończy worker i RAF.

**Commit:** `feat(control-room): add 2d field-map surface`

### Task 8: Dodać vectors, contours, mesh, surface i probe

**Create/Modify:**

- `apps/control-room/src/modules/field-map/model/fieldMapRenderModel.ts`;
- `apps/control-room/src/modules/field-map/model/fieldMapRenderModel.test.ts`;
- `apps/control-room/src/modules/field-map/model/fieldMapCapabilities.ts`;
- `apps/control-room/src/modules/field-map/model/fieldMapCapabilities.test.ts`;
- `apps/control-room/src/modules/field-map/model/fieldMapProbe.ts`;
- `apps/control-room/src/modules/field-map/model/fieldMapProbe.test.ts`;
- `apps/control-room/src/modules/field-map/renderer/planarRenderer.ts`;
- `apps/control-room/src/modules/field-map/renderer/planarRenderer.test.ts`;
- `apps/control-room/src/modules/field-map/renderer/planarRendererWorker.ts`;
- `apps/control-room/src/modules/field-map/renderer/planarRendererProtocol.ts`;
- `apps/control-room/src/modules/field-map/renderer/marchingSquares.ts`;
- `apps/control-room/src/modules/field-map/renderer/marchingSquares.test.ts`;
- `apps/control-room/src/modules/field-map/renderer/vectorGlyphs.ts`;
- `apps/control-room/src/modules/field-map/renderer/vectorGlyphs.test.ts`;
- `apps/control-room/src/modules/field-map/renderer/meshOverlay.ts`;
- `apps/control-room/src/modules/field-map/renderer/meshOverlay.test.ts`.

- [x] Najpierw dodać vector basis tests dla `xy/xz/yz` i arbitrary frame.
- [x] Dodać zero-vector i orientation epsilon tests.
- [x] Dodać deterministic budget tests.
- [x] Dodać marching squares golden tests, w tym masked holes.
- [x] Dodać FMCS frame mapping i segment cap tests.
- [x] Dodać surface overlap/fold diagnostic tests.
- [x] Dodać local hover i exact pinned probe tests.
- [x] Zaimplementować warstwy bez React object per sample.
- [x] Uruchomić:

```bash
pnpm --dir apps/control-room test -- src/modules/field-map/renderer
pnpm --dir apps/control-room test -- src/modules/field-map/model
pnpm --dir apps/control-room typecheck
```

Expected: vector count bounded, contours nie przechodzą przez maskę, mesh physical aspect zachowany, ambiguous surface ma jawny status.

**Commit:** `feat(control-room): add planar field overlays`

### Task 9: Rozdzielić profile visualization 3D i 2D

**Modify:**

- `crates/fullmag-api/src/schemas/visualization_state.rs`;
- `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`;
- generated OpenAPI;
- `apps/control-room/src/kernel/visualization/useVisualizationStateResource.ts`;
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`;
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`;
- `apps/control-room/src/kernel/visualization/visualizationCommandContributions.ts`;
- `apps/control-room/src/kernel/visualization/visualizationCommandContributions.test.ts`;
- `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts`;
- `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.test.ts`;
- `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`;
- `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`;
- `apps/control-room/src/modules/viewport-3d` tylko dla compatibility;
- `crates/fullmag-api/src/router_v2/tests.rs`.

- [x] Najpierw dodać backend schema default/migration/patch tests.
- [x] Dodać frontend tests, że planar changes nie zmieniają 3D profile.
- [x] Dodać tests, że 3D changes nie invalidują planar field buffers, jeśli monitor/field się nie zmienił.
- [x] Dodać `planar` branch i compatibility projection.
- [x] Uruchomić:

```bash
cargo test -p fullmag-api visualization_state
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room test -- src/kernel/visualization
pnpm --dir apps/control-room test -- src/modules/viewport-3d
```

Expected: oba profile round-trip niezależnie; istniejący 3D suite nie regresuje.

**Commit:** `refactor(visualization): separate 3d and planar profiles`

### Task 10: Przełączyć relevant inspectory na context-aware visualization

**Create:** `VisualizationViewContext.ts`, `VisualizationContextSwitch.tsx`, `PlanarVisualizationSection.tsx`, `PlanarMonitorInspectorPanel.tsx` i testy.

**Modify:** pliki inspectorów wymienione w sekcji 10.3.

- [x] Najpierw dodać coverage table jako parameterized test dla object, region, part, airbox, spatial result i monitor.
- [x] Dodać test, że context switch wykonuje command/layout change.
- [x] Dodać test, że general/material/physics sections nie są duplikowane.
- [x] Dodać 2D controls i capability reasons.
- [x] Mesh part i airbox inspectory ustawiają runtime `PlanarViewScope`; nie patchują `PlanarMonitorIR`.
- [x] Zachować wspólne quantity/unit/range primitives.
- [x] Dodać accessibility i SSR snapshot tests.
- [x] Uruchomić:

```bash
pnpm --dir apps/control-room test -- src/modules/inspector
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Expected: każdy relevant semantic target ma 3D i 2D visualization context; brak drugiego inspector registry.

**Commit:** `refactor(inspector): support 3d and planar contexts`

### Task 11: Zintegrować Explorer, ribbon i monitor draft/commit

**Modify:**

- explorer files z sekcji 11.1;
- ribbon files z sekcji 11.2;
- `apps/control-room/src/kernel/workspace/crossSectionWorkspace.ts`;
- `apps/control-room/src/kernel/workspace/crossSectionWorkspace.test.ts`;
- `apps/control-room/src/kernel/workspace/useCrossSectionWorkspace.ts`;
- `apps/control-room/src/modules/inspector/panels/CrossSectionDraftEditor.tsx`;
- `apps/control-room/src/modules/inspector/panels/CrossSectionDraftEditor.test.tsx`;
- `apps/control-room/src/modules/inspector/panels/CrossSectionInspectorPanel.tsx`;
- `apps/control-room/src/modules/inspector/panels/CrossSectionInspectorPanel.test.tsx`.

- [x] Najpierw dodać tree tests dla Definitions/Monitors i Results/Spatial fields.
- [x] Dodać draft/apply/discard/conflict tests.
- [x] Dodać command registry tests dla menu/ribbon/shortcut/context menu.
- [x] Przekierować `2D` do `field-map.open`.
- [x] Konwertować stare draft state do `PlanarMonitorDraft`.
- [x] Utrzymać 3D frame preview przez lekką warstwę, bez 2D WebGL.
- [x] Uruchomić:

```bash
pnpm --dir apps/control-room test -- src/modules/explorer
pnpm --dir apps/control-room test -- src/modules/ribbon
pnpm --dir apps/control-room test -- src/modules/inspector/panels/CrossSection
```

Expected: jedna command source, committed monitor pojawia się w SceneDocument i canonical script, konflikt revision nie nadpisuje danych.

**Commit:** `feat(control-room): integrate planar monitor workflow`

### Task 12: Skonsolidować PNG i odciąć osobny cross-section surface

**Modify/Delete only after parity gates:**

- `apps/control-room/src/modules/cross-section-image/manifest.ts`;
- `apps/control-room/src/modules/cross-section-image/CrossSectionImageModule.tsx`;
- `apps/control-room/src/modules/cross-section-image/CrossSectionImageModule.test.tsx`;
- `apps/control-room/src/modules/cross-section-image/crossSectionWorkflowSmokeScript.test.ts`;
- `apps/control-room/src/modules/cross-section-image/objectUrl.ts`;
- `apps/control-room/src/modules/cross-section-image/objectUrl.test.ts`;
- `apps/control-room/src/kernel/resources/crossSectionResources.ts`;
- `apps/control-room/src/kernel/workspace/crossSectionWorkspace.ts`;
- `apps/control-room/src/modules/registry.ts`;
- `apps/control-room/src/design/styles/cross-section-image.css`;
- cross-section explorer/ribbon assumptions.

- [x] Dodać `field-map.export-png` używający planar `render.png`.
- [x] Zachować mesh quality export przez istniejący cross-section image endpoint albo adapter do planar surface.
- [x] Dodać download filename z monitor, quantity, revision i unit-safe slug.
- [x] Dodać object URL revoke tests.
- [x] Wyrejestrować top-level `cross-section-image` dopiero po browser parity.
- [x] Usunąć osierocone command ids, styles i tests odnoszące się do starego top-level behavior.
- [x] Uruchomić:

```bash
pnpm --dir apps/control-room test -- src/modules/cross-section-image src/modules/field-map
pnpm --dir apps/control-room run check:architecture-hygiene
rg -n "cross-section-image\\.open" apps/control-room/src
```

Expected: ostatnie `rg` nie znajduje aktywnego command; export PNG nadal działa; brak duplicate center workflow.

**Commit:** `refactor(control-room): consolidate spatial 2d workflow`

### Task 13: Walidacja naukowa FDM/FEM i managed runtime

**Create:**

- `examples/viewport_2d_planar_monitor_fdm_smoke.py`;
- `examples/viewport_2d_planar_monitor_fem_smoke.py`;
- `scripts/analysis/validate_planar_monitor_sampling.py`;
- raport schema/fixture zgodne z istniejącymi conventions;
- receptura `run-viewport-2d-planar-monitor-smoke` w `justfile`.

**Modify:** `justfile`.

- [x] Dodać recepturę o sygnaturze:

```make
run-viewport-2d-planar-monitor-smoke backend="fdm" device="cpu" web_port="3194" api_port="8194":
```

- [x] Receptura wywołuje `just ensure-python` i `just ensure-managed-fem-runtime`, wybiera fixture na podstawie `backend`, uruchamia zarządzany runtime, czeka na API/workspace, uruchamia `pnpm --dir apps/control-room smoke:viewport-2d` i zatrzymuje wyłącznie proces, który sama utworzyła.
- [x] Raporty zapisuje pod `.fullmag/reports/viewport-2d-planar-monitor-smoke/<backend>-<device>/`, łącznie z runtime log, browser log i JSON science report.
- [x] Fixture publikuje constant, linear scalar i vector field w znanych jednostkach.
- [x] FDM sprawdza plane, slab, depth oraz axis/arbitrary parity.
- [x] FEM sprawdza P1 skew tetra, measure weighting, refinement invariance i surface boundary.
- [x] Cross-backend porównuje to samo pole ciągłe po jawnej rekonstrukcji.
- [x] Uruchomić czyste kontraktowe testy Rust.
- [x] Uruchomić `just ensure-managed-fem-runtime`.
- [x] Jeżeli source objęty manifest stale detection zmienił runtime, pozwolić recepturze wykonać container-backed rebuild; nie omijać go hostowym buildem.
- [x] Uruchomić:

```bash
just run-viewport-2d-planar-monitor-smoke fdm cpu
just run-viewport-2d-planar-monitor-smoke fem cpu
just run-viewport-2d-planar-monitor-smoke fem gpu
```

GPU case dowodzi wyłącznie, że spatial fields opublikowane przez GPU execution są poprawnie samplowane przez jawny CPU postprocessor. Nie promuje natywnego GPU sampling.

Expected: raport zawiera requested/resolved backend/device, sampling execution, error norms, occupancy, revisions i wszystkie gates `pass`.

**Commit:** `test: validate planar monitor sampling`

### Task 14: Browser, performance, accessibility i final cutover

**Create/Modify:** skrypty z sekcji 13.2, `apps/control-room/package.json`, smoke fixtures i docs status.

- [x] Zapisać screenshot baseline starego PNG workflow.
- [x] Uruchomić nowy browser smoke dla FDM i FEM.
- [x] Zapisać screenshoty: scalar plane, slab vectors, FEM mesh overlay, surface projection i 3D frame preview.
- [x] Uruchomić performance audit small/large.
- [x] Uruchomić 100-switch memory audit.
- [x] Uruchomić keyboard-only i reduced-motion smoke.
- [x] Uruchomić pełne frontend gates:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room run check:api-hygiene
pnpm --dir apps/control-room run check:architecture-hygiene
pnpm --dir apps/control-room build
```

- [x] Uruchomić backend contract suites oraz managed smoke z Task 13.
- [x] Zaktualizować:
  - `docs/ui/2d-slice.md`;
  - `docs/status/2d-slice-capabilities.md`;
  - `docs/specs/frontend-v2/15-viewport-2d-module.md`;
  - `docs/specs/capability-matrix-v0.md`.
- [x] Każdy status row musi wynikać z konkretnego artefaktu/testu; niewalidowana ścieżka pozostaje oznaczona jako taka.

Expected: zero TS errors, zero ESLint warnings, zero test failures, production build green, browser evidence istnieje, science report green.

**Commit:** `feat: complete production 2d viewport cutover`

---

## 16. Test matrix i dowody

### 16.1 Numeryka

| ID | Fixture | Operator | Oczekiwany dowód |
|---|---|---|---|
| N01 | constant scalar FDM | plane/slab/depth | dokładnie stała |
| N02 | layered cell-constant FDM | slab | volume-overlap weighted analytic |
| N03 | linear P1 skew tetra | plane | barycentric analytic |
| N04 | linear P1 skew tetra | slab | measure-weighted analytic |
| N05 | nonuniform refinement | slab | invariant względem density |
| N06 | vector \((x,y,z)\) | arbitrary frame | poprawne u/v/normal |
| N07 | empty/partial target | wszystkie | mask/occupancy poprawne |
| N08 | planar boundary | surface | area/barycentric analytic |
| N09 | folded surface | surface | `non_injective` diagnostic |
| N10 | FDM/FEM refinement | plane/slab | zbieżność do wspólnego pola |

### 16.2 API

| ID | Kontrakt |
|---|---|
| A01 | CRUD revision-safe |
| A02 | canonical script sync po mutation |
| A03 | meta przed heavy resources |
| A04 | scalar/vector/mask/overlay ETag |
| A05 | 304 działa tylko z cache |
| A06 | bounded query validation przed allocation |
| A07 | stable reason codes |
| A08 | invalidation-only WebSocket |
| A09 | no heavy data in status |
| A10 | old slice/projection parity |

### 16.3 UI

| ID | Workflow |
|---|---|
| U01 | utworzenie presetu XY i Apply |
| U02 | arbitrary frame validation |
| U03 | thickness w SI/display unit |
| U04 | quantity switch bez zmiany monitora |
| U05 | component world/monitor basis |
| U06 | vectors + normal indicator |
| U07 | contours respektują maskę |
| U08 | mesh overlay physical aspect |
| U09 | surface ambiguity |
| U10 | object/region/part/airbox inspector parity |
| U11 | 2D↔3D state preservation |
| U12 | PNG/data export z provenance |
| U13 | stale/error/degraded states |
| U14 | keyboard probe/pan/zoom |

### 16.4 Lifecycle

| ID | Gate |
|---|---|
| L01 | aktywny tylko jeden heavy center surface |
| L02 | inactive 2D zero fetch |
| L03 | no idle RAF |
| L04 | worker terminate |
| L05 | ImageBitmap/object URL cleanup |
| L06 | ResizeObserver/listener cleanup |
| L07 | 3D context zdrowy po powrocie |
| L08 | heap stabilny po 100 switches |

---

## 17. Review checkpoints

### Checkpoint R0 — po Task 1

Reviewers:

- physics/numerics;
- architecture/API;
- frontend viewport.

Blokuje kod, jeżeli nie uzgodniono measure, surface ambiguity, vector order i ownership monitora.

### Checkpoint R1 — po Task 5

Wymagane:

- Python/IR/Scene round-trip;
- sampler manufactured tests;
- OpenAPI model/data routes;
- compatibility endpoint parity.

Nie rozpoczynać pełnego UI, jeśli backend contract nadal się zmienia.

### Checkpoint R2 — po Task 8

Wymagane:

- ukryty `field-map` renderuje scalar/vector/mesh/contours;
- no-idle lifecycle tests;
- żadnego WebGL;
- resource cache bounded.

### Checkpoint R3 — po Task 11

Wymagane:

- inspector coverage matrix green;
- draft/commit/revision conflict green;
- ribbon/explorer command unification;
- 3D state preservation.

### Checkpoint R4 — po Task 14

Wymagane:

- managed FDM/FEM evidence;
- browser screenshot/smoke;
- performance/memory;
- full quality gates;
- updated docs/status.

Dopiero R4 pozwala oznaczyć program jako production-ready.

---

## 18. Ryzyka i działania zapobiegawcze

| Ryzyko | Skutek | Zapobieganie |
|---|---|---|
| node-count average w FEM | wynik zależny od mesh density | measure-weighted analytic/refinement gates |
| duplicate slice algorithms | rozjazd endpoints | jeden `PlanarSamplingEngine`, compatibility adapters |
| quantity gaps łatane lokalnie | niepełny katalog i drift | naprawa catalog/field-store/compute_fields globalnie |
| arbitrary plane kosztowna | latency/memory | spatial index cache, bounded resolution, preview quality |
| curved surface folding | mylący obraz | explicit visibility policy i non-injective diagnostics |
| 2D zmienia ustawienia 3D | utrata workflow | odrębne profile, wspólna semantyka |
| duplicate inspectors | drift UX/API | jeden registry i context-aware sections |
| drugi render loop | idle CPU/GPU | invalidation-only Canvas scheduler |
| stale data po revision | błędne porównania | ETag + monitor/mesh/field revision identity |
| GPU execution błędnie promowane | fałszywy capability claim | osobne source device i sampling execution |
| SSR hydration mismatch | warning/flicker | server snapshots/hydration gate |
| PNG workflow utracony | regresja eksportu | cutover dopiero po export parity |
| shared worktree contamination | obcy diff/commit | osobne staged inspection, scoped commits |

---

## 19. Definition of Done

Program jest zakończony wyłącznie, gdy:

- [x] physics note i ADR są zaakceptowane;
- [x] `PlanarMonitor` round-tripuje Python ↔ IR ↔ SceneDocument ↔ canonical Python;
- [x] monitor jest quantity- i raster-resolution-agnostic;
- [x] FDM i FEM używają measure-weighted samplerów;
- [x] plane, slab, depth i surface mają dowody numeryczne;
- [x] axis presets i arbitrary frame działają;
- [x] wszystkie spatial quantities są pobierane przez canonical catalog, a unsupported scalars mają jawny reason;
- [x] vectors działają w world i monitor basis;
- [x] heatmap, contours, mesh, surface diagnostics, probe i export działają;
- [x] jeden `field-map` jest aktywnym 2D center surface bez WebGL;
- [x] `viewport-3d` zachowuje zdrowy context po wielokrotnym przełączaniu;
- [x] relevant object/region/part/airbox/result/monitor inspectors obsługują 3D i 2D;
- [x] nie istnieje drugi inspector registry ani drugi source of truth targetów;
- [x] `cross-section-image` nie jest konkurencyjnym top-level workflow;
- [x] API jest resource-first, generated i revision-driven;
- [x] no direct component fetch, no heavy status/WebSocket payload;
- [x] typecheck, lint, tests, build i hygiene gates są zielone;
- [x] managed FDM/FEM runtime reports są zielone;
- [x] browser screenshots/smokes i performance/memory reports są zapisane;
- [x] status docs rozróżniają implemented, executable, browser-verified, scientifically-validated i production-ready;
- [x] każdy zmieniony plik i linia są bezpośrednio związane z tym programem.

---

## 20. Requirement traceability

| Wymaganie użytkownika | Realizacja w planie | Gate |
|---|---|---|
| Zakładka 2D viewport | `field-map` / **2D View** | U01, L01 |
| Wszystkie quantities jak MuMax3 | canonical quantity catalog + spatial capability | A07, U04 |
| Cross-section w płaszczyznach | plane sample, presets i arbitrary frame | N01, N03, U02 |
| Plotowanie na powierzchni | `surface_projection` z overlap diagnostics | N08, N09, U09 |
| Uśredniona płaszczyzna/grubość | `slab_average(thickness_m)` | N02, N04, U03 |
| Wirtualna ramka/monitor | canonical `PlanarMonitor` | Task 2–5 |
| Węzły wpadające do ramki | node/element counts jako diagnostics, miara jako wynik | N05 |
| Inspektory 3D/2D | context-aware shared inspector registry | U10, U11 |
| Wektory w 2D | u/v/normal basis i bounded glyphs | N06, U06 |
| Spójny produkcyjny projekt | docs→DSL→IR→runtime→API→UI→verification | R0–R4 |
