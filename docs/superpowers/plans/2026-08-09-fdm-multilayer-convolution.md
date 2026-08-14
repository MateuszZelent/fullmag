# Plan produkcyjnego domknięcia FDM multilayer convolution

> Data: 2026-08-09
>
> Status: wdrożenie częściowe. Lane CPU FP64 jest wykonywalny, ale bieżący
> materiał dowodowy nie kwalifikuje go jeszcze naukowo. Kontrakt CUDA jest
> zielony wyłącznie na poziomie build/source/ABI; dedykowany managed runtime
> CUDA pozostaje zablokowany przez synchronizację source snapshotu z runtime'em
> i verifierem. Resource-first API, osobny liść Explorer/Inspector, target
> resolution i kontrakt target-only viewportu są zaimplementowane oraz
> niezależnie zreviewowane jako `contract/model verified`; świeży runtime
> `compute_fields`/WebGL, CUDA/device parity i pełna kwalifikacja pozostają
> otwarte.
>
> Właściciel semantyki naukowej: `docs/physics/0421-fdm-multilayer-convolution-demag.md`
>
> Właściciel publicznego API: `packages/fullmag-py` + `ProblemIR`
>
> Właściciel CPU oracle: `crates/fullmag-fdm-demag` + `crates/fullmag-engine`
>
> Właściciel produkcyjnego GPU: `backends/fdm`
>
> Właściciel browser contract: OpenAPI v2 + `apps/control-room`

> Audyt korygujący: [Audyt implementacji FDM multilayer convolution —
> 2026-08-11](../../audits/2026-08-11-fdm-multilayer-convolution-implementation-audit.md).
> W przypadku sprzeczności dotyczącej stanu implementacji, dowodów lub kolejności
> napraw obowiązuje nowszy audyt. W szczególności CUDA-assisted dla
> `two_d_stack`/heterogenicznego `h_z`/`push_pull`, plannerowy budżet D-06 i
> device residency D-07 są blokerami P0, a nie wyłącznie brakami finalnej
> kwalifikacji.

## Korekta bramek managed — 2026-08-14

- `just verify-fdm-multilayer-demag-runtime cpu-fp64` jest bramką CPU. Obecny
  lane jest wykonywalny, lecz nie ma jeszcze kompletnego, source-bound dowodu
  spełnienia kryteriów naukowych, więc pozostaje `not_qualified`.
- `just verify-fdm-multilayer-demag-runtime cuda-fp64` i wariant `cuda-fp32`
  nie są prawidłowymi bramkami CUDA. Receptura `demag-runtime` celowo odrzuca
  lane'y CUDA fail-closed.
- Właścicielem runtime CUDA są dokładnie
  `just verify-fdm-multilayer-cuda-runtime cuda-fp64` oraz
  `just verify-fdm-multilayer-cuda-runtime cuda-fp32`.
- Kontrakt CUDA build/source/ABI jest zielony, ale żadnego lane'u runtime CUDA
  nie promowano. Bieżącym blokerem jest spójne powiązanie source snapshotu,
  manifestu zbudowanego runtime'u i wejść verifiera w jednym niezmiennym
  przebiegu.
- Wizualna bramka Airboxa zachowuje normatywną kolejność: najpierw wireframe,
  potem osobna klatka z wyłączonym wireframe i wyłączonymi wektorami, a dopiero
  następnie włączenie wektorów.
- Machine-readable capability matrix nie promuje już
  `fdm_multilayer_fixed_explicit_rk` jako `fdm_gpu_production=production_executable`:
  status GPU pozostaje `implemented`, bez `validated_workloads`, dopóki nie
  powstanie niezmienny managed receipt z device identity, licznikami `L+L`,
  parity, residency i provenance.

## Korekta stanu — 2026-08-11

| Obszar | Stan po audycie | Decyzja |
|---|---|---|
| Python/ProblemIR/planner | częściowo wykonawcze | domknąć typed enums, reason codes, Scene v3, stable object ID i fail-closed `boundary_*` |
| CPU FP64 identity/shift | lokalnie zweryfikowane zakresowo; receptura source-bound jest zaimplementowana, świeży receipt nadal oczekuje na pełny przebieg | wykonać managed run i zarchiwizować immutable receipt |
| CPU `push_pull` | lokalnie zweryfikowane dla różnych extentów i `V_native != V_scratch`; brak direct oracle dla `h_source,z != h_destination,z` | zachować scoped validation, nie rozszerzać jej na unequal native-cell thickness |
| D-06 | Wspólny `KernelCatalogSpec` jest używany przez descriptor, planner i CPU runtime; fixed-width `src/dst/kernel_index` bindings oraz accounting CPU/CUDA ABI są identycznie wyliczane i testowane. CUDA native single-grid ma jawny model admission z zerowym payloadem katalogu. | utrzymać fail-closed rozdział CPU/catalog, CUDA ABI-v2/L² i native single-grid; nie promować CUDA bez device/runtime proof oraz immutable receipt |
| CUDA-assisted | publicznie wywoływalne, lecz niekanoniczne dla części heterogenicznego zakresu | fail-close albo użyć wspólnego descriptorowego operatora |
| D-07 | `L/L/L^2` wewnątrz refreshu | nie kwalifikuje całego solvera; wymagane zero realnych vector H2D/D2H w warm step |
| API/UI/viewport | kontrakty, target identity, Explorer/Inspector i strict frame-sequence testy istnieją | brak świeżego runtime/WebGL proof; source-bound receipt musi być zgodny z serving API |
| Airbox | target-only CPU carrier istnieje | przenieść z eager post-run do on-demand `compute_fields`, dodać maskę i FFT counters |
| Production | niekwalifikowane | fazy containment, CPU oracle, ABI v3/CUDA, round-trip i pełna kwalifikacja pozostają otwarte |

Artefakty lokalne bez śledzonego pełnego SHA są dowodem diagnostycznym, nie
immutable production receipt. Historyczne liczby suite i Chromium smoke poniżej
opisują wcześniejszy snapshot; nie są dowodem bieżącego HEAD.

## Korekta source-bound artefaktów i WebGL — 2026-08-14

- Każdy finalny artefakt pola/membership oraz plik `H_demag.samples.v1.json`
  musi przenosić tę samą `build_identity` co metadata; carrier Airboxa nadal
  dodatkowo porównuje ją z raportem runtime. Verifier egzekwuje teraz obecność
  i zgodność identity w top-level manifestu, samples oraz
  `source_runtime_identity`.
- Receptura `run-fdm-multilayer-webgl-matrix-cpu` przechwytuje snapshot źródeł
  przed buildem, wstrzykuje go do `fullmag-build-info`, wymaga porównania
  snapshotu po przebiegu i przekazuje oczekiwaną tożsamość do smoke.
- Smoke odczytuje `x-fullmag-build-identity` z serving API i fail-close, jeżeli
  commit, stan worktree lub SHA snapshotu nie są identyczne z receipt; evidence
  zapisuje `build_identity` oraz ścieżkę snapshotu.
- Receptura zapisuje stabilny `reason_code` dla błędów przed uruchomieniem,
  porównuje snapshot także po nieudanym przebiegu i po zakończeniu ustawia
  katalog receipt/evidence jako tylko do odczytu. Przed sealingiem tworzy
  `receipt-inputs-sha256.txt`, `receipt-index.v1.json` i jego plik SHA-256;
  indeks wiąże source identity, runtime binary, evidence i manifest.
- Formalny przebieg WebGL nadal musi wykonać kolejno osobne committed frames:
  `wireframe_on(true,false)`, `wireframe_off(false,false)`,
  `vectors_on(false,true)`. Self-test przechodzi, ale świeży browser/WebGL
  runtime pozostaje nieuruchomiony.

## Stan wykonania — 2026-08-10

Wykonano i zweryfikowano: publikację naukową/source-map, kontrakt Python/IR i
planner, shifted Newell/direct oracle, descriptor CPU reference, realny managed
CPU FP64 SP4-derived run, runtime-origin target-only Airbox carrier, resource-first
API, Explorer/Inspector/native-layer viewport, osobny niezależny verifier transferu
`push_pull`, niezależny verifier zbieżności Airboxa, pełny Control Room suite
`512` plików/`4913` testów oraz świeży fallback Chromium smoke po `compute_fields` (wykonany
przed późniejszą przebudową CPU 2D; pozostaje dowodem UI/data-plane, nie
post-kernelowej parity). Ostatni smoke potwierdził `H_demag` dla obu warstw (HTTP 200),
canvas `532×478`, `gl.isContextLost() == false` i osobne zaznaczalne targety.
Po przebudowie CPU wykonano także świeże pełne oracles: L=1 identity (4096/4096),
L=2 identity equal (+Z/-Z, 8192/8192) oraz osobny L=2 unequal `push_pull` w małym
3-D Appendix-A case (96/96). Dwa świeże managed runy target-only Airboxa
(`160×40×18` i `160×40×24`, ta sama siatka źródłowa `128×32`) dały pełne
`115200/115200` zgodnych centrów, maksymalny błąd `2.544311428209767e-10 A/m`
i względny L2 `7.438410419938349e-16`; verifier ma status `qualified`. Scope
`layer_id`/`object_id` ma testy canonical FMVP i fail-closed `409` dla kolizji
aliasów. Target-only Airbox ma zaakceptowany resource/API connector, centralny
request `scope_kind=airbox&scope_id=airbox` dla `H_demag`, FMVP v3 compatibility,
osobny liść `airbox.multilayer.target`, dedykowany Inspector, target-gridowy
bounds/interior hidden-edge overlay oraz rozdzielone ustawienia legacy FDM
`fdm-universe-outside-support` i targetu `airbox`. Niezależne review viewportu,
Explorer/Inspector, target resolution i legacy target separation są
`APPROVED (scope-limited)`; testy obejmują typecheck, API hygiene i diff-check.
Nie wykonano jeszcze świeżego `compute_fields` po tej integracji ani pełnej
macierzy screenshotów/WebGL.

Nie promowano jeszcze `production-qualified`: brak managed CUDA/device proof,
brak D-07 `L+L` FFT runtime/parity oraz brak pełnej macierzy wizualnej
surface/wireframe/points/hidden-listener i finalnej CPU/GPU parity. Bezpośredni
verifier ma jawny fail-closed guard dla `push_pull`, a osobny
verifier transferu ma pełne pokrycie pola, energii i test adjointu na świeżych CPU
artefaktach SP4-derived oraz małym unequal case. Pełna macierz CUDA i świeża
macierz UI nadal pozostają otwarte. CPU 2D używa dokładnej 64-narożnikowej sumy
Newella, a niezależny oracle stosuje tę samą kanonikalizację parzystości znaków
lagu. API/UI ma wyłącznie status kontraktowy; wcześniejszy fallback Chromium
smoke jest dowodem historycznego data-plane, nie post-integracyjnej kwalifikacji
viewportu. Dowody cząstkowe i dokładne bramki są utrzymywane w
`.superpowers/sdd/progress-fdm-multilayer.md`, raportach Airbox API/UI oraz
raporcie browser/WebGL.

## 1. Cel

Celem jest doprowadzenie istniejącej funkcji FDM `multilayer_convolution` do stanu, w którym:

1. publiczna intencja zapisana w Pythonie i Control Room przechodzi bez dryfu przez `ProblemIR`, planner, runner, runtime, artefakty i eksport skryptu;
2. pole demagnetyzujące wielu rozłącznych warstw jest liczone według algorytmu Lepadatu: po jednym FFT na źródło, po jednym IFFT na cel i po jednym mnożeniu widmowym na parę źródło–cel;
3. kernel wzajemny jest poprawny dla dodatnich i ujemnych przesunięć, różnych grubości warstw oraz zadeklarowanych klas 2D/3D;
4. CPU FP64 pozostaje niezależnym oraklem, a natywne CUDA FP64 i FP32 są osobno kwalifikowane;
5. reuse kerneli, budżet pamięci, cache, invalidacja i proweniencja opisują faktyczne wykonanie, nie deklarowany zamiar;
6. Control Room pokazuje wspólny layout transformaty, osobne scratch grids i natywne siatki warstw w jednym drzewie `Mesh`, z osobnymi Inspectorami;
7. viewport pobiera i renderuje natywne carriery warstw przez istniejący binarny kontrakt pól `scope_kind=layer|object`;
8. pole w przestrzeni niemagnetycznej nad i pod warstwami ma osobny, jawny carrier obserwacyjny i nie jest mylone ze wspólną siatką roboczą konwolucji;
9. pochodny układ µMAG SP4 sprawdza redukcję do jednej warstwy, sprzężenie dwóch/trzech warstw oraz pole Airboxa, bez zmieniania kanonicznego benchmarku SP4;
10. status `production-qualified` jest nadawany dopiero po przejściu świeżych bramek managed CPU/GPU, numerycznych, fizycznych, API i WebGL.

Plan jest planem clean-room. Kod i struktury BORIS są materiałem porównawczym, nie źródłem do kopiowania.

## 2. Źródła i hierarchia prawdy

### 2.1. Źródło naukowe

Serban Lepadatu, „Efficient computation of demagnetizing fields for magnetic multilayers using multilayered convolution”, *Journal of Applied Physics* **126**, 103903 (2019), DOI `10.1063/1.5116754`:

`docs/physics/multilayer_convolution/1_5116754 -- 4fb8226c2651eae7580a917b21d4fb18 -- Anna’s Archive.pdf`

Publikacja jest źródłem dla:

- równania pola wielu warstw;
- relacji źródło–cel i zależności tensora od rozmiarów obu komórek;
- schematu `L × FFT + L² × multiply + L × IFFT`;
- klas symetrii kerneli;
- nieregularnego tensora różnych grubości z dodatku A;
- kryteriów porównawczych z supermesh convolution;
- ograniczenia, że transfer między różnymi siatkami wprowadza błąd aproksymacji.

Publikacja nie definiuje wystarczająco dokładnie:

- indeksowania i orientacji bufora FFT;
- paddingu konwolucji liniowej;
- normalizacji DFT/IFFT;
- stabilnej ewaluacji wzorów w punktach osobliwych i bliskich;
- pełnej wielowymiarowej definicji transferu;
- PBC;
- tolerancji FP32/FP64;
- semantyki masek, częściowych komórek i pola w Airboxie.

Te elementy muszą zostać wyspecyfikowane i dowiedzione niezależnymi testami.

### 2.2. BORIS-spintronics

Analizowany snapshot znajduje się w `external_solvers/BORIS` i nie ma w repozytorium Fullmag śledzonej tożsamości commit SHA. README opisuje go jako pre-release, a katalog nie zawiera wykonywalnego, asercyjnego golden testu multilayer convolution. BORIS nie jest więc źródłem kwalifikacji.

Wzorce algorytmiczne warte odtworzenia clean-room:

- globalna lista warstw i jawny kierunek pary `source → destination`;
- osobne self- i cross-kernels;
- jeden forward FFT na źródło i jeden inverse FFT na cel;
- akumulacja wszystkich źródeł w widmie jednego celu;
- katalog kerneli współdzielony po `(relative_shift, h_src, h_dst)`;
- reuse dla `+Δz/-Δz` wyłącznie w legalnej klasie 2D-zShift z jawną parytetową zmianą znaków;
- odrębne reprezentacje self, z-shift i general-complex;
- jawna waga energii i kontrola `-μ0 M·H/2`;
- brak cichego fallbacku całego wykonania GPU na CPU.

Elementy, których nie wolno kopiować:

- hierarchia `SDemag`/`SDemag_Demag`, ukryte moduły i globalny stan;
- makra, kontenery, błędy i układ pamięci BORIS;
- monolityczne funkcje oraz ręcznie zduplikowane warianty CPU/GPU;
- temporalna ekstrapolacja `Hdemag` jako część podstawowego operatora;
- konkretne nazwy, struktura klas i kod objęty GPLv3;
- twierdzenia o poprawności albo wydajności bez odtworzenia dowodu.

Audyt analyst-only objął następujących właścicieli BORIS:

| Odpowiedzialność | Plik/symbol BORIS | Wniosek behawioralny |
|---|---|---|
| globalna orkiestracja | `Boris/SDemag.h::SDemag`, `Boris/SDemag_MConv.cpp::Initialize_MConv_Demag`, `UpdateField_MConv_Demag` | transfer-all, FFT-all, accumulate-per-destination, IFFT-all |
| stan jednej warstwy | `Boris/SDemag_Demag.h/.cpp::SDemag_Demag` | osobny rect/grid/transfer/energy weight per layer |
| katalog par | `Boris/DemagKernelCollection.h::DemagKernelCollection` | kernel source→current destination, self index i inverse-shift metadata |
| mnożenie CPU | `Boris/DemagKernelCollection_Mult.cpp` | self ustawia output, cross terms akumulują |
| generowanie/symetrie | `Boris/DemagKernelCollection_Calc.cpp` | klasy self, z-shift, x-shift, full-complex i in-memory reuse |
| FFT/padding | `Boris/ConvolutionData.h/.cpp` | open-boundary `N=2n`, R2C X, x-fastest, inverse normalization |
| nieregularne tensory | rodzina `Boris/DemagTFunc_Shifted*` | osobne source/destination thickness i zorientowany shift |
| CUDA orchestration | `Boris/SDemagCUDA_MConv.cpp` | ten sam kształt matematyczny, osobne execution/memory |
| CUDA kernels | `Boris/DemagKernelCollectionCUDA*`, `Boris/ConvolutionDataCUDA*` | mirrored representation, cuFFT i multi-GPU transfers |
| publiczne ustawienia | `Boris/Simulation.cpp`, `Commands.cpp`, `NetSocks.py` | multilayer/mode/common cells są osobnymi ustawieniami |

Audyt wykrył także sygnały, których nie wolno powielać: podwójne wywołanie `CalcDiagTens2D`, zagnieżdżoną podwójną pętlę transferu CUDA, zduplikowane przypisanie `non_empty_cells`, odwrócony opis `ncommonstatus` oraz niepełne launch checks. Są to wskazówki do testów regresyjnych, nie twierdzenie o zachowaniu każdej wersji BORIS.

Audytowalna granica clean-room:

1. Agent-analityk tworzy wyłącznie specyfikację zachowania i manifest `boris-reference-manifest.v1.json` z datą analizy, SHA-256 analizowanych plików, README/version hints i hash licencji.
2. Specyfikacja nie zawiera przeniesionego kodu, nazw prywatnych typów ani układu klas BORIS; zawiera równania, wejścia/wyjścia, inwarianty i wykryte pułapki.
3. Agent-implementer pracuje wyłącznie z publikacją, notą Fullmag, test vectors i behavioral specification; nie czyta plików BORIS podczas implementacji.
4. Reviewer porównuje zachowanie i artifacts, nie podobieństwo struktury kodu.
5. Brak upstream commit SHA pozostaje jawny; manifest hashy identyfikuje dokładnie lokalny snapshot.

### 2.3. Hierarchia Fullmag

Przy konflikcie obowiązuje kolejno:

1. kompletna publikacyjna nota `docs/physics/0421-fdm-multilayer-convolution-demag.md`;
2. specyfikacje i ADR-y w `docs/specs` i `docs/adr`;
3. `AGENTS.md`;
4. publiczny Python DSL;
5. `ProblemIR`, walidacja i planner;
6. runtime i backend;
7. OpenAPI i Control Room.

## 3. Stan bieżący i granica prawdziwych twierdzeń

Funkcja nie jest wdrożeniem od zera. Repozytorium zawiera już:

- `fm.FDMGrid`, `fm.FDMDemag` i `fm.FDM`;
- `strategy="multilayer_convolution"`, `mode="two_d_stack|three_d"` i `common_cells*`;
- `FdmMultilayerPlanIR`, warstwy, transfery i summary planera;
- CPU reference oparty o RustFFT;
- natywny CUDA handle v2 dla części konfiguracji;
- host-authoritative CUDA-assisted dla pozostałych konfiguracji;
- binarne pola FMVP v3 dla `scope_kind=layer|object`;
- podstawowe UI wyboru strategii.

Mapa aktywnych właścicieli Fullmag:

| Warstwa | Path/symbol |
|---|---|
| Python DSL | `packages/fullmag-py/src/fullmag/model/discretization.py::{FDMGrid,FDMDemag,FDM}` |
| ProblemIR | `crates/fullmag-ir/src/mesh_hints.rs::{FdmDemagHintsIR,FdmMultilayerPlanIR,FdmLayerPlanIR,FdmMultilayerSummaryIR}` |
| dispatch/planner | `crates/fullmag-plan/src/lib.rs::plan`, `crates/fullmag-plan/src/fdm.rs::plan_fdm_multilayer`, `crates/fullmag-plan/src/geometry.rs::extract_multilayer_geometry` |
| kernel hostowy | `crates/fullmag-fdm-demag/src/{newell,self_kernel,shifted_kernel,multiply,transfer,types}.rs` |
| CPU workspace | `crates/fullmag-engine/src/multilayer.rs::MultilayerDemagRuntime` |
| CPU public runner | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` |
| CUDA routing | `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs` |
| produkcyjny CUDA | `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu`, `backends/fdm/include/context.hpp` |
| ABI | `backends/fdm/api`, Rust FFI pod `crates/fullmag-runner/src/fdm/gpu/cuda/native` |
| v2 fields | `crates/fullmag-api/src/router_v2/handlers/data/fields.rs::resolve_multilayer_native_layer_scope` |
| frontend field type | `apps/control-room/src/kernel/api/apiTypes.ts::FdmMultilayerFieldVectorQuery` |
| Explorer | `apps/control-room/src/modules/explorer/builders/buildModelTree.ts::fdmMeshPolicyNodes` |
| viewport demand | `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts` |
| viewport renderer | `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`, `FdmCuboidLayer` |

Rozbite katalogi `fdm/cpu/reference/*`, `fdm/cpu/multilayer_reference/*`, `fdm/gpu/cuda/multilayer/*` i `fdm/gpu/cuda/native/*` trzeba najpierw potwierdzić przez deklaracje `mod`; plik niepodłączony do aktywnego modułu nie jest implementacją ani test coverage.

Poniższa tabela zachowuje baseline przed rozpoczęciem wdrożenia; aktualny
status po falach implementacyjnych jest rozliczony w sekcji Wave C/F,
macierzy kwalifikacji i końcowym audycie wymaganie → dowód.

| Właściwość | Stan przed wdrożeniem | Dowód niewystarczający do promocji |
|---|---|---|
| Publiczny wybór Python | istnieje | sam test serializacji |
| Planner multilayer | istnieje | brak zgodności wszystkich strategii i wartości enum |
| CPU reference | wykonywalny w części zakresu | brak direct oracle dla przesunięcia niezerowego |
| CUDA single-grid stack | istnieje | nie jest shifted multilayer convolution |
| CUDA native identity transfer | istnieje | brak pełnej parity i koszt FFT per layer |
| CUDA push/pull | demag może być hostowy | lokalne CUDA nie oznacza device-resident demag |
| Reuse kerneli | deklarowany w typie i estymatorze | runtime tworzy pary `L²` |
| Heterogeneous thickness | deklarowane przez plan/transfer | brak irregular source/destination kernel qualification |
| UI authoring | kontrolka istnieje | eksportuje wartość do FEM-owego `demag_realization` |
| Explorer | publikuje native layers, common scratch diagnostic i `airbox.multilayer.target` | brak świeżej sesji po `compute_fields` |
| Viewport | planuje `layer|object|airbox`, renderuje target-only grid i pełny bounds/interior wireframe przez unified canvas | brak świeżej macierzy WebGL/listener proof po integracji |
| Airbox multilayer | runtime-origin target-only carrier ma v2 layout/FMVP/API/Explorer/Inspector/viewport contract | brak świeżego browser proof i CUDA observation parity; common convolution grid nadal nie jest Airboxem |
| Produkcyjna kwalifikacja | brak | testy źródłowe i statyczne kontrakty ABI |

Najważniejsze potwierdzone luki:

1. UI zapisuje `multilayer_convolution` do FEM-owego `demag_realization`, a eksport buduje nielegalne `fm.demag(realization="multilayer_convolution")`.
2. Planner nie respektuje w pełni intencji: liczba magnesów może wymuszać albo omijać multilayer niezależnie od `strategy`.
3. Rustowe stringi strategii/trybu nie gwarantują fail-closed dla nieznanych wartości.
4. Shifted kernel nie ma orakla dla niezerowego przesunięcia i wszystkich sześciu składowych; sposób wypełniania ujemnej części Z jest podejrzany pod kątem parytetu.
5. Planner szacuje pamięć dla unikalnych kerneli, lecz runtime przechowuje pełne kernela każdej pary.
6. Natywne CUDA wykonuje obecnie pełny cykl FFT/IFFT dla każdej pary warstw, a nie raz na źródło/cel.
7. `KernelReuseKey` nie steruje rzeczywistym katalogiem kerneli.
8. `requested/resolved` dla FDM demag oraz data residency nie są pełną częścią proweniencji.
9. UI nie ma publicznego zasobu discovery dla natywnych warstw i ich carrierów.
10. Pojedynczy Airbox SP4 nie dowodzi sprzężenia cross-layer.

## 4. Decyzje architektoniczne

### D-01. Zachować istniejące publiczne klasy

Nie dodawać publicznych `Layer`, `MultilayerDemag` ani buforów runtime. Warstwą publiczną pozostaje istniejący `Ferromagnet`, a ustawieniem dyskretyzacji:

```python
study.fdm(
    default_cell=(4e-9, 4e-9, 1e-9),
    per_magnet={
        "free": fm.FDMGrid(cell=(2e-9, 2e-9, 1e-9)),
        "reference": fm.FDMGrid(cell=(4e-9, 4e-9, 2e-9)),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=(256, 128),
    ),
)
```

### D-02. Typować intencję, nie szczegóły wykonania

W `ProblemIR` wprowadzić typowane enumy o istniejących wartościach wire:

- `FdmDemagStrategyIR::{Auto, SingleGrid, MultilayerConvolution}`;
- `FdmDemagModeIR::{Auto, TwoDStack, ThreeD}`.

`native_grid`, `convolution_grid`, `transfer_plan`, kernel catalog i observation carrier pozostają w planie/runtime, nie w authoring IR.

### D-03. Jawna macierz rozstrzygania strategii

Planner musi implementować jedną tabelę:

| Liczba warstw | `auto` | `single_grid` | `multilayer_convolution` |
|---:|---|---|---|
| 1 | single-grid | single-grid | multilayer reduction, legalne do testu równoważności |
| >1 | deterministycznie multilayer | unsupported w tym planie | multilayer |

Pierwsza promocja nie implementuje nowego multi-magnet `single_grid`, ponieważ wymagałby osobnego pełnego strumienia geometry lowering, masek obiektów, artefaktów, field scopes i walidacji. Cost model pozostaje wyłączony do czasu Etapu 15. Wybór `auto` musi zostać zapisany jako requested `auto` i resolved konkretna strategia z reason code. Jawny wybór użytkownika nie może być po cichu nadpisany. `fullmag_plan::plan` w `crates/fullmag-plan/src/lib.rs` musi kierować `L=1 + strategy=multilayer_convolution` do `plan_fdm_multilayer`; liczba magnesów nie może być jedynym warunkiem dispatchu.

### D-04. `two_d_stack` ma dokładnie jedną komórkę Z na warstwę roboczą

W trybie 2D:

- `h_x` i `h_y` wspólnej siatki są wspólne;
- grubość każdej warstwy może być inna;
- każda warstwa ma jedną komórkę Z w rastrze konwolucyjnym;
- kernel używa rzeczywistych `h_src.z` i `h_dst.z`;
- magnetyzacja scratch jest moment-preserving średnią przez grubość i reprezentuje założenie jednorodności `m(z)`;
- wielokomórkowa natywna warstwa Z wymaga jawnego transferu, testu 2D-vs-3D i dowodu, że tekstura przez grubość nie jest potrzebna; w przeciwnym razie planner wybiera/żąda `three_d`;
- każda para kernela nieregularnego z dodatku A musi mieć wspólne `h_x,h_y`; różne natywne XY są legalne tylko po transferze do wspólnego scratch XY.

Jest to świadoma migracja względem bieżącego planera, który dla `common_cells_xy` zachowuje `max_native_z_cells`. Etap 2 musi zmienić lowering, `FdmLayerPlanIR`, mapy transferu i descriptor kernela tak, aby `two_d_stack` miał robocze `Nz=1` per warstwa. Reguły normalizacji są zamknięte:

- `common_cells_xy` wymusza/resolwuje `two_d_stack` i jest nielegalne z jawnym `three_d`;
- `common_cells` wymusza/resolwuje `three_d` i jest nielegalne z jawnym `two_d_stack`;
- podanie obu pól jest błędem;
- `mode=auto` bez obu pól wybiera `two_d_stack` tylko dla obsługiwanych pojedynczych slabów Z, w przeciwnym razie `three_d`;
- każda decyzja `auto` ma versioned reason code;
- legacy values przechodzą przez jawny migrator albo są odrzucane; nie są po cichu reinterpretowane.

### D-05. CPU FP64 jest oraklem; GPU nie współdzieli pętli wykonawczej

Równania, znaki, deskryptory i test vectors są backend-neutral. CPU i CUDA mają osobne realizacje pamięci oraz FFT. Produkcyjna numeryka GPU pozostaje w `backends/fdm`; runner nie przejmuje hot loop.

### D-06. Katalog kerneli jest faktyczny, deduplikowany i hashowany

Docelowy model:

```text
FdmMultilayerKernelCatalog
├── entries[unique_kernel_id]
│   ├── key
│   ├── representation
│   ├── spectrum/storage
│   └── content_hash
└── pairs[destination][source]
    ├── kernel_index
    ├── orientation
    └── parity_transform
```

Klucz obejmuje co najmniej:

- tryb 2D/3D;
- zorientowane `relative_shift`;
- `h_src` i `h_dst`;
- rozmiar i padding FFT;
- klasę reprezentacji;
- precision storage;
- wersję wzoru/kernel schema;
- boundary mode.

Planer i runtime liczą pamięć z tego samego katalogu. Nie może istnieć estymator zakładający reuse, którego runtime nie realizuje.

Parity reuse `+Δz/-Δz` jest legalne tylko, gdy jednocześnie: `mode=two_d_stack`, `N.z=1`, offset X/Y wynosi zero, para ma zgodne zorientowane `h_src/h_dst`, a odwrócenie nie zamienia nierównych source/destination thickness. Dla unequal thickness odwrotna para ma osobny key, chyba że niezależny test dowiedzie identyczności po volume-weighted transform. 3D-zShift i full-offset nie korzystają z prostego sign-only reuse.

### D-07. Produkcyjny algorytm GPU ma `L` forward i `L` inverse

Każde odświeżenie pola wykonuje:

```text
push_all_sources
→ forward_fft_each_source_once
→ zero_each_destination_spectrum
→ pairwise_tensor_accumulate
→ inverse_fft_each_destination_once
→ pull_all_destinations
→ assemble_energy_and_observables
```

Licznik etapów jest częścią testowalnej diagnostyki. Dla `L` magnetycznych warstw oczekiwane są `L` forward i `L` inverse niezależnie od `L²` par.

**Stan implementacji 2026-08-14:** w runnerze istnieje ograniczona ścieżka
`cuda_native_multilayer_convolution` dla FP64, stałego Heuna, `three_d` i
wspólnej siatki identity. Nie promuje ona jeszcze FP32, różnych `h_z` ani
`push_pull`; pozostałe przypadki zachowują jawny native-stacked/CUDA-assisted
wybór. Snapshot końcowy sprawdza kanoniczną sumę `H_eff` i raportuje wyłącznie
rzeczywiste transfery wektorowych buforów. Source-layout oraz testy jednostkowe
tej ścieżki przechodzą, a kontrakt CUDA build/source/ABI jest zielony. Nie jest
to runtime proof: dedykowane bramki `verify-fdm-multilayer-cuda-runtime`
pozostają zablokowane przez synchronizację source snapshotu z runtime'em i
verifierem.

### D-08. Airbox jest target-only observation carrier

Wielowarstwowa siatka robocza nie jest fizycznym Airboxem. Pole poza magnesem zostanie udostępnione jako osobny, opcjonalny carrier obserwacyjny:

- bounds pochodzą z istniejącego `study.universe`;
- rozdzielczość jest jawnie resolved z common transform layout i limitu pamięci;
- maska observation carrier obejmuje komórki poza sumą magnetycznych supportów;
- observation planes/grids nie są źródłami magnetyzacji;
- ich wkład nie zmienia pola ani dynamiki warstw;
- dla `compute_fields` wykonywane są tylko mnożenia źródło→observation target i IFFT targetów;
- hot loop dynamiki nie płaci za Airbox, dopóki obserwacja nie jest żądana;
- proweniencja zapisuje grid, mask hash, źródłowe warstwy i revision;
- `scope_kind=airbox` jest legalne dopiero po materializacji tego carriera.

### D-09. Jeden zasób discovery i istniejący binary field plane

Dodać lekki zasób JSON:

`GET /v2/sessions/current/data/domain/fdm-multilayer-layout`

Nie dodawać nowego endpointu pola. FMVP v3 i `scope_kind=layer|object|airbox` pozostają data plane. Status zawiera tylko revision pointer.

### D-10. Kanoniczny SP4 pozostaje bez zmian

Nie modyfikować fizycznej definicji i referencji NIST. Dodać nazwany `sp4-derived-multilayer` z jawnie opisanym odstępstwem. Wynik pochodny nie może być raportowany jako zgodność z kanonicznym SP4.

## 5. Docelowe kontrakty danych

### 5.1. Python → ProblemIR

Python zachowuje istniejące API. Wymagane testy round-trip obejmują:

- brak `default_cell` przy pełnym `per_magnet`;
- różne komórki warstw;
- `strategy`, `mode`, `common_cells` i `common_cells_xy`;
- stabilne nazwy magnesów;
- dokładny eksport z Control Room z powrotem do `study.fdm(...)`;
- odrzucenie wzajemnie sprzecznych parametrów;
- odrzucenie nieznanych wartości enum;
- zachowanie requested `auto` niezależnie od resolved planu.

### 5.2. SceneDocument authoring

`SceneStudyState.demag_realization` pozostaje tylko dla FEM. Dodać oddzielny model w `scene.v3`:

```text
SceneFdmDiscretizationState
├── default_cell
├── per_object_grid[stable_object_id]
└── demag
    ├── strategy
    ├── mode
    ├── common_cells
    └── common_cells_xy
```

W aktywnym SceneDocument siatka jest przypięta do stabilnego object ID, a eksporter mapuje ID na kanoniczną nazwę magnesu podczas generowania Python DSL. Python DSL przechowuje mapę po nazwie i nie gwarantuje zachowania tego samego SceneObject ID po ponownym imporcie tekstu; importer tworzy nowe ID i odtwarza semantykę po jednoznacznej nazwie. Test round-trip wymaga równości semantycznej, nie identyczności ID między niezależnymi importami. Rename wewnątrz jednej sceny zachowuje ID i aktualizuje eksportowaną nazwę bez osierocenia grid policy.

Migracja `scene.v2 → scene.v3`:

- dla engine FDM wartość `study.demag_realization="multilayer_convolution"` przenieść do `study.fdm.demag.strategy` i usunąć z FEM-owego pola;
- inne znane wartości FEM pozostawić jako `demag_realization`;
- niejednoznaczna lub nieznana wartość daje diagnostic/fail-closed, nie zgadywanie;
- zachować odczyt `scene.v1/v2`, zapis wykonywać jako `scene.v3`;
- objąć migrację snapshotami `SceneDocument`, adapterami i v2 authoring API.

ProblemIR nie wymaga bumpu wyłącznie z powodu Rust enum, ponieważ wire spelling pozostaje zgodny. Testy muszą jednak przejść przez `migrate_problem_ir_json_value` dla wspieranych `0.2.0/0.3.0` i dowieść, że zaostrzona walidacja nie zmienia poprawnych starszych dokumentów. Każda przyszła zmiana wire shape wymaga osobnego bumpu i migratora.

### 5.3. Plan/runtime descriptor

Rozszerzyć istniejące typy, bez tworzenia równoległego planu:

```text
FdmMultilayerPlanIR
├── planner_summary
│   ├── requested_strategy
│   ├── selected_strategy
│   ├── requested_mode
│   ├── resolved_mode
│   └── reason_codes[]
├── common_transform_layout
├── layer_scratch_grids[]
├── layers[]
├── kernel_catalog_summary
├── transfer_summary
├── observation_plan?
└── capability_decisions[]
```

`common_transform_layout` opisuje wspólne liczności XY/FFT shape, strides, padding i transform convention, lecz nie udaje jednego fizycznego grida. `layer_scratch_grids[]` mają osobne origins, położenia Z i `h_z`. `planner_summary` pozostaje jedynym właścicielem requested/resolved strategy i mode; nie dodawać zduplikowanych pól top-level. Każda warstwa ma stabilne `layer_id` i `object_id`, natywną siatkę, active mask, bounds Z, scratch grid, transfer kind oraz fingerprint. Requested device pozostaje pobierane z istniejącego `problem_meta.runtime_metadata.runtime_selection`; ten plan materializuje je do proweniencji, ale nie tworzy drugiego pola intencji w `BackendPolicyIR`.

### 5.4. Proweniencja wykonania

Artefakt runtime zapisuje co najmniej:

- `requested_demag_strategy`;
- `resolved_demag_strategy`;
- `resolved_demag_mode`;
- `resolved_execution_shape`:
  - `cpu_reference_multilayer`,
  - `cuda_native_multilayer_single_grid`,
  - `cuda_native_multilayer_convolution`,
  - `cuda_assisted_multilayer`;
- `demag_compute_residency` i transfer bytes/timing;
- precision pola i precision przechowywania kernela;
- FFT backend i library identity;
- layer count, pair count, unique kernel count;
- kernel catalog hash i schema version;
- liczba forward/inverse FFT na refresh;
- transfer kinds i ich hash;
- observation carrier hash, gdy użyty;
- requested/resolved device i jawny fallback reason;
- status kwalifikacji lane’u.

Wprowadzić wersjonowany fragment `fdm_multilayer_execution.v2` w artefakcie proweniencji. Reader starszego fragmentu v1 uzupełnia nowe pola jako `unknown/not_recorded`, nigdy jako domyślny sukces. Istniejące ogólne `requested_demag_realization/resolved_demag_realization` pozostają dla FEM; FDM używa nowych, jawnie nazwanych pól i nie wpisuje multilayer do FEM-owej realizacji.

### 5.5. Zasób `fdm-multilayer-layout`

Minimalny JSON:

```json
{
  "schema_version": "fdm_multilayer_layout.v1",
  "domain_generation_id": "...",
  "layout_revision": 17,
  "observation_revision": 3,
  "execution_revision": 9,
  "backend": "fdm",
  "requested_strategy": "multilayer_convolution",
  "resolved_strategy": "multilayer_convolution",
  "resolved_mode": "two_d_stack",
  "common_transform_layout": {},
  "layer_scratch_grids": [],
  "layers": [],
  "observation_carriers": [],
  "planned_execution_candidates": [],
  "last_run_execution": null,
  "status": "ready"
}
```

Warstwa zawiera:

- stabilne `layer_id`, `object_id` i label;
- origin, shape, spacing, bounds oraz grid fingerprint;
- active/inactive cell count;
- `active_mask_present` i binarny `mask_ref`, jeśli potrzebny;
- transfer kind i fingerprint source/target;
- field scope ID;
- state `ready|stale|degraded|unsupported` i reason.

`layout_revision` zmienia się tylko z geometrią/native/common grids, `observation_revision` tylko z materializacją observation carrier, a `execution_revision` tylko z nowym runem/proweniencją. Planowane kandydaty nie mogą być prezentowane jako wykonany lane. Maski pozostają zasobem binarnym. Nie wkładać ciężkich tablic do JSON ani `/status`.

## 6. Zakres naukowy kernela

### 6.1. Wymagane klasy

Implementacja i testy rozróżniają:

1. `2d_self`;
2. `3d_self`;
3. `2d_z_shift`;
4. `3d_z_shift`;
5. `2d_full_offset`;
6. `3d_full_offset`.

Pierwszy produkcyjny zakres może kwalifikować współosiowe stosy Z przed offsetami XY, ale planner musi odrzucać niezakwalifikowaną klasę, nie kierować jej do przypadkowej ścieżki.

Macierz docelowej reprezentacji z Tabeli I publikacji:

| Klasa | Diagonalne i `xy` | `xz`,`yz` | Zasięg storage |
|---|---|---|---|
| 2D self | real | zero | reduced |
| 3D self | real | real | reduced |
| 2D z-shift | real | imaginary | reduced |
| 3D z-shift | complex | complex | reduced |
| 2D/3D full offset | complex | complex | full |

Implementacja correctness-first może początkowo przechowywać wszystko jako full-complex, ale wtedy planner/runtime memory model używa pełnego kosztu i nie deklaruje publikacyjnej optymalizacji pamięci. Reduced storage jest osobnym etapem dopiero po przejściu pełnej reprezentacji.

### 6.2. Konwencja znaków i orientacji

Jedno źródło prawdy dokumentuje:

```text
pair[destination, source]
relative_shift = destination_origin - source_origin
H_destination = -N_destination,source * M_source
```

Testy pokrywają wszystkie sześć składowych `xx, yy, zz, xy, xz, yz`, znaki dla `±x, ±y, ±z` oraz volume-weighted reciprocity:

```text
V_destination * N_destination<-source(r)
  = V_source * transpose(N_source<-destination(-r))
```

Dla równych objętości redukuje się to do prostej równości tensorów. Nie implementować optymalizacji parytetowej, dopóki ogólna pełna reprezentacja nie przejdzie direct oracle.

Energia warstwy docelowej jest liczona wyłącznie po jej aktywnej objętości:

```text
E_destination = -(mu0/2) * sum_active(V_cell * M · H_destination)
```

Cross-energy raportuje zorientowane raw contributions obu kierunków oraz ich fizycznie symetryzowaną sumę. Test A→B/B→A używa objętościowo ważonych całek, nie surowego `M·H` bez wag.

### 6.3. Nierówne grubości

Dodać stabilną implementację wzorów A1–A4 z publikacji:

- obliczenia bazowe FP64;
- skalowanie długości przez największy wymiar komórki/pary;
- jawne limity dla zerowych współrzędnych;
- `atan2`/stabilne logarytmy tam, gdzie równoważność jest udowodniona;
- kompensowane sumowanie członów o silnej redukcji;
- testy high-precision/offline dla bliskich i dalekich par;
- permutacje osi generują pozostałe elementy, lecz mają osobne testy znaków.
- planner odrzuca bez transferu pary z `h_x,source != h_x,destination` albo `h_y,source != h_y,destination`, ponieważ dodatek A kwalifikuje różnicę tylko w Z.
- niezależny testowy oracle używa high-precision arithmetic albo bezpośredniej cubature dla wybranych par i generuje immutable fixtures poza produkcyjnym builderem A1–A4; direct sum wykorzystujący ten sam generator nie jest samodzielnym dowodem matematyki kernela.

### 6.4. Padding, layout i normalizacja

Dokumentacja i test kontraktowy ustalają:

- open boundary jako domyślny i jedyny kwalifikowany boundary mode;
- dla osi liniowej konwolucji `linear_extent = n_source + n_destination - 1`, a `fft_shape = next_supported_fft_shape(linear_extent)`; dla 2D Z pozostaje 1;
- descriptor zapisuje pozycję zerowego przesunięcia tensora, mapping dodatnich/ujemnych lagów, source insertion offset i destination crop window;
- R2C na osi X i długość `N.x/2 + 1`;
- x-fastest linear indexing;
- mapowanie ujemnych indeksów do ogona bufora;
- zachowanie Nyquista;
- miejsce znaku minus;
- dokładny czynnik normalizacji inverse;
- zerowanie destination spectra przy każdym refreshu;
- brak odczytu niezerowego paddingu z poprzedniego kroku.

Małe niesymetryczne fixtures `n_source != n_destination` porównują każdy voxel i każdą składową z direct sum. Osobno pokrywają przesunięcie o jedną komórkę, wrap-around i crop celu.

PBC pozostaje fail-closed, dopóki osobna publikacja i kwalifikacja nie rozszerzą kontraktu.

### 6.5. Transfer

W pierwszej kolejności kwalifikować `identity`. Następnie zdefiniować i zakwalifikować istniejący `push_pull`:

- `push_m` zachowuje całkowity moment objętościowy;
- `pull_h` ma jawną interpolację i politykę brzegu;
- `pull_h` jest adjointem `push_m` w objętościowo ważonym iloczynie skalarnym,
  `<P M, H_conv>_Vconv = <M, P* H_conv>_Vnative`; jeżeli istniejący transfer tego nie spełnia, należy go zastąpić albo jawnie liczyć energię na rastrze konwolucyjnym i nie promować native energy-field identity;
- transfer nie tworzy magnetyzacji poza aktywną maską;
- stałe pole i stała magnetyzacja przechodzą bez błędu poza brzegiem;
- test zbieżności pokazuje oczekiwany rząd dla gładkich danych;
- błąd transferu raportuje się oddzielnie od błędu kernela/FFT;
- różne natywne `dz` i różne grubości nie są redukowane do jednego wspólnego `dz` bez dowodu.

## 7. Plan wdrożenia krok po kroku

Każde zadanie zaczyna się od testu RED lub jawnego kontraktu dowodowego. Każdy agent edytuje wyłącznie przypisane ścieżki. Integrator nie scala dwóch agentów równocześnie w ten sam plik.

### Etap 0. Zamrożenie baseline i rejestr luk

**Pliki:**

- utworzyć `docs/physics/0421-fdm-multilayer-convolution-demag.source-map.json`;
- zmodyfikować `docs/physics/0421-fdm-multilayer-convolution-demag.md`;
- zmodyfikować `docs/physics/README.md` jako indeks kanonicznych not;
- utworzyć `docs/physics/multilayer_convolution/qualification-matrix.md`.
- utworzyć `docs/physics/multilayer_convolution/boris-reference-manifest.v1.json` i behavioral specification bez kodu BORIS.

**Kroki:**

1. Poprawić dane bibliograficzne na J. Appl. Phys. 126, 103903 (2019).
2. Przepisać notę 0421 tak, by oddzielała równania, FDM CPU oracle, CUDA production, transfer i UI.
3. Dodać pełną tabelę symboli z SI, konwencję `destination,source`, padding i normalizację.
4. Dodać mapowanie każde równanie/kontrakt → dokładny path + symbol Fullmag.
5. Oznaczyć checklistę historyczną jako dowód obecności kodu, nie poprawności runtime.
6. Zapisać snapshot BORIS jako niekwalifikowany materiał referencyjny: data analizy, lista/SHA-256 plików, README/version hints, license hash i brak upstream commit SHA; oddzielić role analyst/implementer.
7. Utworzyć macierz statusów: implemented, executable, runtime-verified, physically validated, production-qualified.
8. Uruchomić walidatory dokumentacji naukowej i naprawić każde naruszenie.

**Warunek wyjścia:** dokumentacja nie deklaruje żadnego nieudowodnionego lane’u jako production-qualified.

### Etap 1. Testy RED publicznego kontraktu i round-tripu

**Pliki:**

- `packages/fullmag-py/tests/test_api.py`;
- `crates/fullmag-authoring/src/scene.rs` i testy;
- `crates/fullmag-authoring/src/builder.rs` i testy;
- `crates/fullmag-ir/src/mesh_hints.rs` i testy;
- `crates/fullmag-plan/src/lib.rs` oraz `crates/fullmag-plan/src/fdm.rs` i testy;
- testy export/import Control Room.

**Testy RED:**

1. UI model z dwoma obiektami, różnymi `FDMGrid` i pełnym `FDMDemag` eksportuje `study.fdm(...)`.
2. Eksport nie zawiera `fm.demag(realization="multilayer_convolution")`.
3. Import → eksport → import zachowuje wszystkie wartości i stabilne object IDs.
4. `strategy=multilayer_convolution` z jedną warstwą daje legalny plan redukcyjny.
5. `strategy=single_grid` z wieloma warstwami wykonuje single-grid tylko, jeśli planner dowodzi wspólnej siatki; inaczej odrzuca.
6. Nieznane strategy/mode odrzucane są w Pythonie, serde i plannerze.
7. `common_cells` i `common_cells_xy` są wzajemnie wykluczające się i zgodne z mode.
8. Requested `auto` pozostaje w proweniencji, resolved strategy ma reason code.

**Warunek wyjścia:** testy zawodzą z aktualnego, potwierdzonego powodu, a nie przez fixture albo błąd kompilacji.

### Etap 2. Naprawa Python/SceneDocument/ProblemIR/plannera

**Implementacja:**

1. Zastąpić stringi Rust typowanymi enumami z zachowaniem wire compatibility.
2. Dodać `SceneFdmDiscretizationState` i mapowanie per stable object ID.
3. Rozdzielić FEM `demag_realization` od FDM `demag.strategy`.
4. Rozszerzyć `crates/fullmag-authoring/src/adapters.rs::{scene_document_from_script_builder,scene_document_to_script_builder,scene_problem_projection}` oraz `builder.rs` o pełne `study.fdm(...)` w obu kierunkach.
5. Zaimplementować tabelę D-03 w jednym resolverze strategii.
6. Dodać reason codes dla każdego auto-resolution i rejection.
7. Nie zmieniać istniejącego publicznego Python API poza poprawkami walidacji.
8. Dodać negatywne testy dla nielegalnych interakcji: PBC, thermal, STT, SOT, Oersted, region-owned/spatial material fields — zgodnie z faktyczną macierzą lane’u.
9. Nie rozszerzać capability tylko dlatego, że dana wartość może być sparsowana.
10. Zaimplementować i przetestować `scene.v2 → scene.v3` oraz kompatybilny odczyt ProblemIR 0.2.0/0.3.0 zgodnie z sekcją 5.2.
11. W `plan_fdm_multilayer` utworzyć `common_transform_layout` i `layer_scratch_grids[]`; usunąć semantyczne założenie jednego fizycznego common grid.

**Weryfikacja:**

- testy Python src-layout z `PYTHONPATH=packages/fullmag-py/src`;
- testy `fullmag-ir`, `fullmag-authoring`, `fullmag-plan`;
- snapshot JSON requested/resolved;
- round-trip skryptu z dwoma warstwami.

### Etap 3. Direct cell-pair oracle i stabilna matematyka

**Pliki:**

- utworzyć moduł orakla/testów w `crates/fullmag-fdm-demag/src`;
- zmodyfikować `newell.rs`, `shifted_kernel.rs`, `types.rs`;
- dodać test vectors w `crates/fullmag-fdm-demag/tests/data`.

**Kroki:**

1. Napisać wolny direct `O(N²)` oracle FP64 bez FFT dla małych siatek.
2. Zaimplementować nieregularny tensor source/destination z różnymi `h_z`.
3. Dodać jawne API `cell_pair_tensor(destination, source)` tylko wewnętrznie/testowo.
4. Pokryć sześć składowych dla `0`, `±Δx`, `±Δy`, `±Δz` i pełnego offsetu.
5. Dodać volume-weighted reciprocity i source/destination swap; prosta tensor equality tylko dla równych objętości.
6. Dodać uniform magnetization przypadki z analitycznym/dalekopolowym sanity check.
7. Dodać energy-field finite difference i objętościowo ważoną mutual-energy reciprocity A→B/B→A.
8. Dopiero po przejściu pełnej reprezentacji wprowadzić reduced/parity representations.
9. Wygenerować niezależne high-precision/cubature fixtures inną implementacją niż produkcyjny generator Newella.
10. Udokumentować tolerancje jako wynik sweepu kondycji, nie przepisać ich z publikacji.

**Warunek wyjścia:** niezerowy shifted kernel przechodzi direct oracle dla wszystkich składowych i obu orientacji.

### Etap 4. Katalog kerneli, reuse, budżet pamięci i invalidacja

**Pliki:**

- `crates/fullmag-fdm-demag/src/types.rs`;
- `crates/fullmag-engine/src/multilayer.rs`;
- `crates/fullmag-plan/src/fdm.rs`;
- `crates/fullmag-runner/src/fdm/mod.rs`;
- ABI descriptors w `backends/fdm/api` i Rust FFI.

**Kroki:**

1. Zastąpić kernel-owned-per-pair katalogiem unique entries + pair mapping.
2. Użyć rzeczywistego `KernelReuseKey` albo zastąpić go jednym kanonicznym typem.
3. Dodać orientation/parity transform bez kopiowania widma.
4. Ustalić deterministyczne sortowanie entries i content hash.
5. Współdzielić ten sam model bajtowy między plannerem i runtime.
6. W CUDA zapewnić jednoznaczną własność alokacji bez double-free współdzielonych wskaźników.
7. Cache invalidować po zmianie geometrii, gridu, maski, mode, precision, boundary schema lub wersji kernela.
8. Zmierzyć setup bytes, warm bytes i peak bytes; nie szacować tylko spectra.
9. Dodać test regularnego stosu, w którym liczba unikalnych kerneli rośnie liniowo, nie kwadratowo.
10. Dodać test nieregularnego stosu, gdzie brak reuse jest jawny i poprawnie zabudżetowany.

**Warunek wyjścia:** planner-reported bytes i runtime-allocated bytes mieszczą się w uzgodnionej tolerancji księgowej i używają tej samej liczby unique kernels.

### Etap 5. CPU FP64 reference jako oracle wykonawczy

**Pliki:**

- `crates/fullmag-engine/src/multilayer.rs`;
- `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs`;
- aktywne testy tych modułów.

**Kroki:**

1. Zachować `forward_all → accumulate_pairs → inverse_all`.
2. Przenieść bufory FFT i spectra do trwałego workspace; warm refresh ma nie alokować proporcjonalnie do gridu.
3. Podłączyć deduplikowany katalog.
4. Ujednolicić znak pola i energię z direct oracle.
5. Pokryć `L=1,2,3`, różne gaps, grubości i znaki offsetu.
6. Pokryć identity i push/pull osobno.
7. Dodać liczniki FFT, alokacji, pair multiply i cache hit.
8. Weryfikować per-layer `H_demag`, `H_eff`, `E_destination=-(μ0/2)Σ_active V M·H`, zorientowane cross contributions i globalną sumę bez podwójnego liczenia.
9. CPU publiczny pozostaje FP64; FP32 CPU może być testowym oraklem konwersji, nie reklamowanym lane’em.

**Warunek wyjścia:** CPU FFT reference zgadza się z direct oracle, a kolejne refresh nie wykonuje nieplanowanych dużych alokacji.

### Etap 6. Natywny CUDA hot loop

**Pliki:**

- `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu`;
- `backends/fdm/gpu/cuda/runtime/context.cu`;
- `backends/fdm/include/context.hpp`;
- `backends/fdm/api/*`;
- Rust FFI i wrapper w `crates/fullmag-runner/src/fdm/gpu/cuda/native`;
- aktywny `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs`.

**Kroki:**

1. Rozdzielić push, forward, multiply/accumulate, inverse i pull na jawne fazy.
2. Wykonać batched XYZ forward raz na warstwę źródłową.
3. Wyzerować spectra celu raz na refresh.
4. Akumulować wszystkie source kernels do spectra celu.
5. Wykonać batched inverse raz na warstwę docelową.
6. Cache planów cuFFT i work area według kompletnego klucza grid/precision/stream.
7. Podłączyć deduplikowany device kernel catalog.
8. Dodać jawne launch/error checks i etapowe telemetry bez globalnej synchronizacji po każdym kernelu.
9. Zaimplementować FP64 najpierw; FP32 dopiero po parity FP64.
10. Zachować rozróżnienie `cuda_native_multilayer_single_grid` i prawdziwego `cuda_native_multilayer_convolution`.
11. `push_pull` nie może używać host RustFFT, jeśli lane jest reklamowany jako device-resident; dopóki nie ma natywnego transferu, provenance pozostaje `cuda_assisted_multilayer`.
12. Wymuszone `device="gpu"` nie może cicho spaść na pełny CPU demag.

**Test kontraktowy:** dla `L=1,2,4,8` dokładnie `L` forward i `L` inverse, `L²` pair accumulations, bez dodatkowych H2D/D2H w warm device-resident refresh.

### Etap 7. Proweniencja, capability matrix i artefakty

**Pliki:**

- typ `ExecutionProvenance` w runnerze;
- artefakty FDM multilayer;
- `docs/specs/capability-matrix-v0.json` i `.md`;
- capability/status v2;
- testy serializacji i negative capability.

**Kroki:**

1. Dodać pola z sekcji 5.4 z kompatybilnym version bumpem artefaktu.
2. Dodać feature ID `interaction.demag.multilayer_convolution`.
3. Rozdzielić CPU FP64, CUDA FP64 i CUDA FP32.
4. Rozdzielić 2D identity, 2D push/pull, 3D identity i 3D push/pull.
5. Użyć bez zmian słownika `capability-matrix.v0`: `unsupported`, `semantic_only`, `reference_executable`, `production_executable`, `partial_production_executable`, `validated`. Bardziej szczegółowe `runtime_verified/physically_validated/qualified` należą do qualification artifact, nie do pola lane status macierzy.
6. Integratory są osobnym wymiarem; obecność demag nie promuje automatycznie wszystkich integratorów.
7. Feature `interaction.demag.multilayer_convolution` składać koniunkcyjnie z istniejącym `fdm_multilayer_fixed_explicit_rk`; UI może uruchomić study tylko, gdy operator, integrator, execution mode, device i precision są zgodne.
8. Pierwsza promocja obejmuje wyłącznie execution mode `strict`; `extended`, przyszłe `hybrid`, auto-device i forced-device mają osobne wpisy/reason codes, a nie dziedziczenie sukcesu.
9. Nie podnosić statusu przed świeżym managed-runtime artifactem.
10. UI pokazuje resolved lane i powód degraded/unsupported.

### Etap 8. Resource-first API dla layoutu warstw

**Pliki:**

- schematy `crates/fullmag-api/src/schemas`;
- handler/resource registry `crates/fullmag-api/src/router_v2`;
- OpenAPI source i generated artifacts;
- testy routera i OpenAPI;
- centralny frontend API client, typy i hooks.

**Kroki:**

1. Dodać `fdm-multilayer-layout` zgodnie z sekcją 5.5.
2. Dodać oddzielne ETag/revision dla layout, observation i execution oraz invalidację przez istniejący websocket.
3. Poza `BackendPlanIR::FdmMultilayer` zwracać HTTP 404 z kanonicznym v2 error code `resource_not_applicable`; nie używać alternatywnego 200/422 dla nieobecnego zasobu.
4. Nie czytać prywatnego `metadata.artifact_layout` z komponentów UI.
5. Dodać binarny mask resource tylko, gdy `active_mask_present=true`: `GET /v2/sessions/current/data/domain/fdm-multilayer-layers/{layer_id}/active-mask`, format `FMBM v1`, bit-packed w porządku z/y/x, z headerem shape, grid fingerprint, mask hash, ETag i layout revision. Observation mask używa analogicznej ścieżki pod observation carrier i wiąże się z `observation_revision`.
6. Zachować endpoint pól i FMVP v3, ale jawnie rozszerzyć multilayer query schema o `scope_kind=airbox`, OpenAPI, generated client, resource keys, realtime invalidation i cache identity. To jest zmiana kontraktu, nie zachowanie bieżącego resolvera bez zmian.
7. Zachować i regresyjnie przetestować istniejące reasoned 422 dla `region` bez pojedynczego FMRM; nie rozszerzać region scope w tym planie.
8. Status publikuje tylko revision pointer, nie kopię layers.
9. Regenerować OpenAPI i frontend transport tylko z kanonicznego źródła.
10. Rozszerzyć istniejące `GET/PUT/PATCH` authoring scene, transaction commit, `StudyRuntimeResource`, OpenAPI authoring payloady, generated types i centralny hook zapisu tak, aby `SceneFdmDiscretizationState` był resource-first; nie dodawać bezpośredniego `fetch()` w panelu.

**Resource impact summary:** jeden nowy lekki named resource, opcjonalny binarny mask resource, bez nowego command endpointu i bez ciężkich danych w statusie.

### Etap 9. Authoring UI

**Pliki:**

- `StudyGlobalAuthoringModel.ts`;
- `StudyInspectorPanel.tsx`;
- domenowy model interakcji;
- SceneDocument adapters;
- tests dla export/import i capability.

**Kroki:**

1. Zastąpić uniwersalny `demag_realization` sekcją FDM demag policy.
2. Udostępnić strategy, mode oraz advanced common cells z opisem konsekwencji.
3. Per-object grid edytować przy stabilnym object ID.
4. Wyświetlać resolved strategy/mode obok requested.
5. `auto` nie może wyglądać jak jawnie wybrany multilayer.
6. Nie dodawać „Build FDM Mesh”; siatka jest artefaktem planu.
7. Zarejestrować lokalne command IDs `mesh.inspect-native-layers`, `viewport-3d.fit-layer-stack`, `viewport-3d.toggle-scratch-grids` oraz użyć istniejącego serwerowego `study.compute-fields`. Pierwsze trzy zmieniają wyłącznie selection/camera/display state i nie tworzą endpointów mutation; `study.compute-fields` materializuje runtime fields. Wszystkie są capability-gated z reason code.
8. Dodać test UI → SceneDocument → Python → ProblemIR → UI.

### Etap 10. Explorer i dedykowane Inspectory

**Pliki:**

- `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`;
- selection model/testy Explorera;
- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`;
- nowe, małe panele Inspector;
- domain presentation adapter.

**Docelowe drzewo:**

```text
Mesh
└── Domain Mesh
    ├── Common Transform Layout
    ├── Native Layers
    │   ├── Layer <id/name>
    │   │   ├── Native Grid
    │   │   ├── Scratch Grid
    │   │   ├── Active Mask
    │   │   ├── Transfer
    │   │   └── Provenance
    │   └── ...
    └── Observation Carriers
        └── Airbox
```

**Wymagania:**

1. Nowe selection kinds są stabilne i nie kodują nazw displayowych.
2. Każdy semantyczny node ma własny Inspector model.
3. Common transform layout jest opisany jako computational layout bez jednego origin/spacing; każdy scratch grid ma własną geometrię i żaden nie jest przedstawiany jako wspólny physical mesh.
4. Layer Inspector pokazuje native vs convolution grid, bounds, mask i fingerprint.
5. Transfer Inspector pokazuje kind, source/target grid i status kwalifikacji.
6. Provenance Inspector pokazuje rzeczywisty lane, precision, residency, kernel reuse i hashes.
7. Airbox node istnieje tylko przy observation carrier; bez niego pokazuje reasoned unavailable, nie fikcyjny grid.
8. Hide/isolate/selection używa `layer_id`; rename label nie zmienia tożsamości.

### Etap 11. Viewport multilayer

**Pliki:**

- `useViewport3DSceneModel.ts`;
- domain adapter i target views;
- `viewport3DFieldDataPlan.ts`;
- `Viewport3DScene.tsx`;
- `FdmCuboidLayer` tylko, jeśli wspólny renderer wymaga rozszerzenia;
- testy lifecycle/cache/picking.

**Kroki:**

1. Zbudować osobny `FdmCuboidInstanceModel` dla każdej natywnej warstwy.
2. Zachować jeden canvas i wspólny `FdmCuboidLayer`.
3. Klucz geometrii zawiera layer ID, native grid fingerprint i layout revision.
4. Klucz pola zawiera dodatkowo quantity i field revision.
5. Demand planner używa `scope_kind=layer|object` i właściwego scope ID.
6. Zmiana `m → H_demag → H_eff` aktualizuje bufory, nie geometrię.
7. Surface, wireframe, points, vectors i field colormap kwalifikować niezależnie.
8. Ukryta warstwa nie ma aktywnego picking/canvas listenera.
9. Layer scratch grids renderować wyłącznie jako opcjonalne diagnostyczne overlays; nie renderować jednego fikcyjnego common physical grid.
10. Observation Airbox używa osobnego targetu `scope_kind=airbox`, pełnych bounds i maski.
11. Airbox wireframe zawsze pokazuje pełny extent z interior bounds/volume overlay; surface opacity nie osłabia wireframe.
12. Nie syntetyzować pola Airbox z per-layer field samples.

### Etap 12. Observation carrier i Airbox materialization

**Pliki:**

- planner/IR planu runtime dla observation target;
- CPU demag materializer;
- natywny CUDA observation apply;
- artifact store i v2 field resolver;
- FDM domain presentation i viewport tests.

**Kroki:**

1. Zdefiniować `FdmObservationCarrierPlan` jako plan resolved, nie authoring physics.
2. Wyprowadzić bounds z manual/auto universe i common XY grid.
3. Rozwiązać Z sampling z jawnego budżetu; co najmniej komórki/planes nad i pod stackiem.
4. Zbudować maskę `universe minus magnetic supports`.
5. Dodać source-layer → observation-destination kernels, bez observation → magnetic pairs.
6. Materializować na żądanie `compute_fields`, nie w każdym kroku integratora.
7. CPU i CUDA liczą ten sam carrier; GPU może być promowany dopiero bez hostowego ukrytego demag.
8. Zapisać FMVP v3 z origin/shape/spacing/mask/fingerprint i `data_origin=runtime`.
9. Dodać limity pamięci i reasoned refusal dla zbyt dużego observation grid.
10. W pierwszej promocji `H_eff` w Airboxie jest niedostępne z versioned reason code; publikować wyłącznie `H_demag`. Ewentualne przyszłe `H_eff = H_demag + H_ext` wymaga osobnej noty fizycznej i kontraktu quantity availability.

### Etap 13. Pochodny µMAG SP4

**Nie modyfikować:**

- referencji `tests/standard_problems/mumag/sp4/references`;
- canonical physical contract SP4;
- istniejących scenariuszy FEM.

**Utworzyć:**

- `tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/README.md`;
- `.../common.py` z parametrami dziedziczonymi z SP4;
- `.../single_layer_reduction.py`;
- `.../bilayer_coupling.py`;
- `.../trilayer_heterogeneous.py`;
- `.../airbox_observation.py`;
- `.../verify.py` i testy;
- raport JSON/CSV schema w `scripts` lub katalogu scenariusza.

**Scenariusz A — single-layer reduction:**

- geometria filmu SP4 `500 × 125 × 3 nm`;
- magnetyczna siatka zgodna z istniejącym FDM counterpart;
- universe rozszerzony nad i pod filmem;
- jawne `strategy=multilayer_convolution`, `L=1`;
- porównanie z single-grid Newell na identycznych komórkach;
- porównanie `H_demag`, energii, torque i relaxed state;
- Airbox nie jest tu dowodem cross-layer, tylko dowodem redukcji i obserwacji.

**Scenariusz B — bilayer coupling:**

- dwie kopie filmu SP4 o tych samych XY;
- bazowo każda warstwa ma `128 × 32 × 1` komórek, czyli około `3.90625 × 3.90625 × 3 nm`;
- bazowa odległość środków wynosi `9 nm`, a niemagnetyczny spacer `6 nm`;
- podstawowy grid-aligned vacuum gap sweep `3, 6, 12, 24 nm`, odpowiadający odległościom środków `6, 9, 15, 27 nm`;
- off-grid gap sweep jest osobną kwalifikacją push/pull i nie może być mieszany z podstawową bramką kernela;
- wariant równoległy i antyrównoległy initial M;
- inter-object exchange jest jawnie wyłączone, asertywnie sprawdzone i zapisane w proweniencji; warstwy nie są podzielonym ciągłym filmem;
- oddzielne native layer IDs i pola;
- cross-layer field nie może być zerowe;
- wykonać przebiegi źródłowe `A`, `B`, `A+B` i `A-B`, a następnie izolować
  `H_(A←B) = H_A(A+B) - H_A(A)` oraz analogicznie `H_(B←A)`;
- po odwróceniu `M_B` izolowany `H_(A←B)` musi zmienić znak;
- ujemna kontrola z wyzerowanym pair kernel musi zawieść test niezerowego sprzężenia;
- objętościowo ważona energia wzajemna A→B i B→A spełnia reciprocity;
- wynik multilayer porównać z direct oracle na małym coarse grid i z single-supergrid na rozdzielczości mieszczącej gap.

**Scenariusz C — heterogeneous trilayer:**

- C1: różne grubości przy identity transfer, aby izolować irregular source/destination kernel;
- C2: równe grubości i znany kernel przy push/pull, aby izolować transfer;
- C3: połączony heterogeneous workflow dopiero po przejściu C1 i C2;
- warianty grubości `3, 5, 2 nm` oraz publikacyjne `20, 10, 20 nm` są osobnymi przypadkami;
- dodatnie i ujemne relative Z shift są obowiązkowe;
- każdy przypadek sprawdza reuse i memory accounting niezależnie;
- CPU FP64 musi przejść przed CUDA FP64, a CUDA FP64 przed FP32.
- każdy wariant asertywnie zachowuje brak inter-object exchange.

**Scenariusz D — Airbox observation:**

- D1 `single_film_padding_invariance`: pojedynczy film, padding `3, 6, 12` komórek Z nad i pod, porównanie `H_demag` i `E_demag` wyłącznie w komórkach magnetycznych;
- D2 `multilayer_observation_carrier`: suma pól wszystkich warstw w target-only carrier, bez observation→magnet pairs i bez wpływu na dynamikę;
- baseline observation grid ma XY `128 × 32`, spacing Z `3 nm` oraz deterministyczny origin/shape wynikający z universe;
- każdy wariant zapisuje dokładne active/inactive counts i mask hash;
- test punktów symetrycznych nad/pod filmem;
- direct-oracle samples obejmują środek, długą krawędź i krótką krawędź po obu stronach, w odległościach `1, 2, 4` komórek od supportu; żaden punkt nie leży dokładnie na granicy komórki;
- porównanie z direct cell-pair field w kilku próbkach;
- `scope_kind=airbox`, nie `full` ani `layer`;
- interaktywny `compute_fields` publikuje carrier do viewportu.

D1 i D2 zapisują osobne obowiązkowe artifacts `fdm_airbox_padding_invariance.v1.json` i `fdm_multilayer_observation.v1.json`, z niezależnym statusem PASS/FAIL; jeden nie może zastąpić drugiego.

W observation Airbox `H_eff` pozostaje niedostępne z versioned reason code. Pierwsza promocja publikuje wyłącznie `H_demag`; nie definiuje efektywnego pola w niemagnetycznym carrierze przez domysł. `H_eff` pozostaje obowiązkowe na magnetycznych carrierach warstw.

**Tekstury operatorowe:**

- jednorodne `M_x`, `M_y` i `M_z`;
- znormalizowany S-state odziedziczony z przygotowania SP4;
- source-sign flip dla każdej osi;
- pokrycie wszystkich składowych `xx, yy, zz, xy, xz, yz` w obu kierunkach pary.

**Dynamika SP4-derived:**

- `Ms=8e5 A/m`, `Aex=1.3e-11 J/m`, `alpha=0.02`, `gamma_mu0=2.211e5 m/(A·s)`;
- początek dynamiczny jest stanem zrelaksowanym przy `tolT=1e-6 T`, czyli `0.7957747154594767 A/m`, oraz `accepted_state=true`;
- case A używa `B_ext=(-24.6e-3, 4.3e-3, 0) T`, case B `(-35.5e-3, -6.3e-3, 0) T`;
- fixed-step Heun, RK4 i RK23 są osobnymi lane'ami z `dt={2e-13, 1e-13, 5e-14} s`;
- sampling period `1e-12 s`, minimum duration `1e-9 s`, equilibrium window `50e-12 s`, maximum duration `5e-9 s`;
- raport zapisuje pełne `mx,my,mz(t)`, pierwszy crossing `mx=0`, mapy per layer w crossing, `E_demag`, `E_ex`, `E_total` i max torque;
- porównanie dotyczy CPU/GPU tego samego problemu pochodnego; nie stanowi PASS względem corpus NIST.

**Paper reproduction lane — traceability, nie kwalifikacja:**

- odtworzyć trilayer Ni80Fe20 `640 × 320 nm`, grubości `20/10/20 nm`, gaps `1 nm`, pole `20 kA/m` pod `5°` tylko na warstwach zewnętrznych, z siatkami i timestepami osobno zgodnymi z opisem publikacji;
- odtworzyć stos dysków Co `1 nm` ze spacerami `3 nm`, do sześciu warstw, komórką `4 × 4 × 1 nm`, `D=-1.5 mJ/m²` i metryką średnicy profilu skyrmionu;
- brakujące parametry pobrać z cytowanych przez publikację źródeł 34/40 i zapisać w source map przed uruchomieniem; brak parametru blokuje reprodukcję, nie uruchamia domyślnej wartości;
- porównać multilayer z single-supergrid w tym samym Fullmag, a wynik BORIS/mumax traktować jako historyczny punkt odniesienia;
- lane nie ustala tolerancji produkcyjnych i nie zastępuje direct oracle, SP4-derived ani managed parity.

**Metryki:**

- `L∞` i weighted `L2` dla `H_demag` w A/m;
- względny błąd z bezpiecznym floor dla pól bliskich zeru;
- bezwzględny i względny błąd energii;
- volume-weighted reciprocity residual;
- finite-difference energy-field residual;
- transfer moment residual;
- CPU/CUDA parity per layer;
- FP32/FP64 delta;
- liczba FFT, kerneli, bytes i transferów;
- dynamika/relaksacja: `mx,my,mz`, energia, max torque, kroki i accepted state.

**Macierz zbieżności:**

- XY: `64 × 16`, `128 × 32`, `256 × 64`;
- grid-aligned spacer: `3, 6, 12, 24 nm` jako obowiązkowe punkty, z off-grid sweepem push/pull i szerszym sweepem wydajności osobno;
- padding nad i pod: `3, 6, 12` komórek observation grid;
- `L=2` i `L=3`;
- oba kierunki każdej pary;
- identity i push/pull jako osobne lane'y;
- fixed-step Heun, RK4 i RK23; adaptive/RK45 nie są promowane tym planem.

Tolerancje zostaną skalibrowane na sweepie i zapisane w wersjonowanym JSON. Nie używać wizualnego podobieństwa krzywych BORIS ani `2 nm` ze skyrmionowego benchmarku jako tolerancji pola SP4.

Utworzyć przed implementacją CUDA wersjonowany `tests/standard_problems/mumag/sp4/fdm/multilayer_convolution/thresholds.v1.json`. Recipe kontraktowe ma failować, jeżeli plik nie istnieje, schema/hash nie zgadza się z raportem albo progi nie zostały zamrożone. Progi startowe do RED sweepu:

| Porównanie | Pole `H_demag` | Energia/wzajemność |
|---|---:|---:|
| CPU FP64 vs direct oracle | `rtol=1e-10`, `atol=1e-6 A/m` | `1e-10` względnie |
| CUDA FP64 vs CPU FP64 | `rtol=1e-8`, `atol=1e-4 A/m` | `1e-8` względnie |
| CUDA FP32 vs CUDA FP64 | normalized RMS `≤2e-4`, max `≤5e-4` | `≤5e-4` względnie |

Floor dla względnej normy pola wynosi `max(1 A/m, 1e-8 × H_scale)`. Startowy względny residual zachowania momentu transferu wynosi `1e-12` dla FP64 i `5e-6` dla FP32; energy-field finite-difference residual `1e-8` dla FP64 i `5e-4` dla FP32. Jeżeli sweep nie potwierdzi progu, nie wolno rozluźnić go bez diagnozy źródła błędu, przeglądu naukowego i wersjonowania pliku thresholds. Raport ma oddzielać błąd dyskretyzacji, kernela, FFT, transferu, przestrzeni, czasu i precyzji.

Zbieżność jest PASS tylko, gdy błąd maleje monotonicznie w zakresie nienasyconym albo dwie najdrobniejsze rozdzielczości osiągają plateau poniżej zamrożonego progu. Samo wykonanie sweepu nie jest dowodem zbieżności.

### Etap 14. Testy API i UI

**API:**

- schema, OpenAPI i route;
- ETag/revision;
- stale/abort/invalidation;
- absence poza multilayer;
- mask resource;
- layer/object/airbox field scope;
- carrier fingerprint mismatch fail-closed.

**Explorer/Inspector:**

- dokładna struktura drzewa;
- stabilność selection ID;
- osobny Inspector każdego node kind;
- reasoned unavailable dla observation carrier;
- hide/isolate/picking.

**Viewport:**

- layer target requests;
- oddzielne native grids;
- quantity switch bez geometry rebuild;
- cache eviction i disposal;
- bounds i masks;
- surface/wireframe/points/vectors;
- brak listenera dla hidden layer.

### Etap 15. Managed runtime, parity i benchmark

**Dodać recipes:**

- `just verify-fdm-multilayer-demag-contract`;
- `just verify-fdm-multilayer-demag-runtime cpu-fp64`;
- `just verify-fdm-multilayer-cuda-runtime cuda-fp64`;
- `just verify-fdm-multilayer-cuda-runtime cuda-fp32`;
- `just verify-fdm-multilayer-airbox-runtime cpu-fp64`;
- `just verify-fdm-multilayer-airbox-runtime cuda-fp64`;
- `just verify-fdm-multilayer-airbox-runtime cuda-fp32`;
- `just verify-fdm-multilayer-demag-production`;
- `just bench-fdm-multilayer-demag`.

Recipes są właścicielem kontenera, natywnego builda i runtime. Ręczne hostowe `cargo`, `cmake`, bezpośrednie binaria albo ręczny Docker są tylko diagnostyką i nie mogą być finalnym dowodem GPU.

**Contract recipe obejmuje:**

- direct oracle i shifted-kernel tests;
- jawne zbudowanie i wykonanie targetów `fdm_multilayer_abi_v2_contract`, `fdm_multilayer_create_v2_contract`, `fdm_batched_demag_fft_contract` oraz nowych shifted/direct tests;
- kernel catalog/reuse/memory model;
- dokładną liczbę FFT;
- OpenAPI/generated client drift;
- capability negative cases.

**CPU runtime recipe i dedykowane CUDA runtime recipes obejmują:**

- publiczny Python → runner E2E;
- dokładnie jeden requested lane na wywołanie;
- CPU reference FP64;
- CUDA native FP64 bez dopuszczonego skipu;
- CUDA FP32 osobno, dopiero po FP64;
- identity i push/pull;
- `L=1,2,4,8`;
- per-layer field/energy parity;
- actual GPU identity, CUDA/cuFFT identity i device residency;
- H2D/D2H telemetry;
- immutable summary JSON.

CUDA recipe kończy się FAIL, gdy brak urządzenia/cuFFT, runtime wybierze `cuda_assisted_multilayer`, demag nie jest device-resident albo pojawi się niejawny fallback. Production recipe agreguje wyniki, ale nie zastępuje lane-specific summaries.

**Airbox recipe obejmuje:**

- on-demand observation materialization CPU/GPU;
- runtime-origin FMVP;
- próbki direct oracle nad/pod stackiem;
- field scope i mask fingerprint;
- interaktywny Control Room smoke.

Każdy immutable summary zawiera obowiązkowo:

- source commit i dirty-state manifest;
- SHA-256 runtime binary;
- scenario schema i thresholds schema/hash;
- requested/resolved strategy, mode, device, precision i execution mode;
- device UUID/name oraz CUDA/cuFFT identity;
- demag residency i fallback reason;
- kernel catalog hash, layer/pair/unique counts;
- forward/inverse FFT counts i H2D/D2H bytes;
- wszystkie zmierzone normy, progi i decyzję `qualified|failed` per lane;
- FMVP, mask, screenshot i WebGL evidence hashes.

**Benchmark rozdziela:**

- cold kernel setup;
- cold FFT plan setup;
- warm apply;
- transfer time;
- pair multiply;
- forward/inverse FFT;
- peak/device memory;
- `L=1,2,4,8,16` i gap sweep;
- multilayer vs single-supergrid przy identycznej precision i solverze.

Multilayer nie jest automatycznie szybszy. Cost model `auto` można włączyć dopiero po stabilnym benchmarku i nie może zmienić jawnej strategii użytkownika.

### Etap 16. Świeża kwalifikacja wizualna

Dla każdego kwalifikowanego lane’u wykonać osobny interaktywny przebieg:

- CPU reference FP64;
- CUDA production FP64;
- CUDA production FP32 dopiero po przejściu numeryki.

Dla każdego lane’u utworzyć manifest obrazów enumerujący:

- każdą native layer × `surface|wireframe|points`;
- każdą native layer × `m|H_demag|H_eff` oraz vector/field mode;
- hide/isolate/picking każdej warstwy;
- layer scratch-grid diagnostic overlays;
- Airbox pełny extent × `wireframe|points|H_demag`;
- osobny screenshot hash, scope ID, carrier fingerprint i `compute_fields` command/run ID dla każdej pozycji.

`H_eff` Airbox nie należy do macierzy pierwszej promocji i zwraca versioned unavailable reason. Każdy lane CPU FP64, CUDA FP64 i CUDA FP32 ma osobny manifest; sukces jednego nie kwalifikuje pozostałych.

Automatyczny smoke musi asertywnie sprawdzić:

- canvas widoczny;
- `gl.isContextLost() === false`;
- dodatni drawing buffer;
- niepusty obraz;
- runtime-origin field po prawdziwym `compute_fields`;
- zgodność carrier fingerprint;
- brak przebudowy geometrii przy zmianie quantity;
- demand frameloop bez idle redraw;
- ograniczoną liczbę workerów/listenerów/buforów po wielokrotnych przełączeniach;
- brak canvas listenera ukrytej warstwy.

Dla Airbox wektorów kolejność jest normatywna i musi być dowiedziona osobnymi
rewizjami PATCH oraz osobnymi klatkami debug WebGL: najpierw
`wireframe=true, vectors=false`, następnie `wireframe=false, vectors=false`, a
dopiero potem `wireframe=false, vectors=true`. Snapshot klatki musi zawierać
flagi obu przełączników razem z `frameCommitId`; odpowiedź pola i adopcja
wektorów muszą pochodzić z tej samej, świeżej rewizji co trzeci etap.

Screenshot bez tych asercji nie jest dowodem kwalifikacji.

### Etap 17. Promocja dokumentacji i capability

1. Zebrać immutable artifacts z recipes.
2. Zweryfikować hashe source/kernel/catalog i GPU identity.
3. Uzupełnić qualification matrix osobno dla każdego lane/mode/transfer/precision.
4. Dopiero wtedy zmienić capability status i publiczną notę.
5. Jeśli lane nie ma świeżego dowodu, pozostawić status macierzy na ostatnim udowodnionym poziomie jej kanonicznego słownika, a szczegółowy qualification artifact oznaczyć `not_qualified`.
6. Opublikować znane ograniczenia i unsupported combinations.

### Etap 18. Macierz poleceń iteracyjnych

Poniższe komendy są focused gates. Hostowe Rust/C++ checks są diagnostyką; managed `just` pozostaje finalnym dowodem native/runtime.

| Zakres | Polecenie | Oczekiwany wynik po implementacji |
|---|---|---|
| Python DSL | `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_api.py -k 'fdm and multilayer'` | PASS round-trip/validation |
| ProblemIR | `cargo test -p fullmag-ir fdm_multilayer --lib` | PASS enum/serde/migration |
| SceneDocument | `cargo test -p fullmag-authoring fdm_multilayer --lib` | PASS scene.v3/adapters |
| planner | `cargo test -p fullmag-plan multilayer --lib` | PASS dispatch/mode/capability |
| kernel | `cargo test -p fullmag-fdm-demag` | PASS direct/high-precision/FFT/transfer |
| CPU runtime | `cargo test -p fullmag-engine multilayer --lib` | PASS workspace/oracle |
| runner | `cargo test -p fullmag-runner multilayer --lib` | PASS CPU/provenance/artifacts |
| CUDA bridge | `cargo test -p fullmag-runner --features cuda multilayer --lib` | PASS bridge contracts; nie runtime proof |
| API | `cargo test -p fullmag-api fdm_multilayer --lib` | PASS resources/scopes/revisions |
| OpenAPI | `pnpm --dir apps/control-room run generate:api` | brak generated diff poza zatwierdzonym schema |
| frontend focused | `pnpm --dir apps/control-room exec vitest run src/modules/explorer src/modules/inspector src/modules/viewport-3d src/kernel/api` | PASS tree/inspector/viewport/API |
| frontend type | `pnpm --dir apps/control-room typecheck` | PASS |
| frontend lint | `pnpm --dir apps/control-room lint` | PASS |
| managed contract | `just verify-fdm-multilayer-demag-contract` | wykonane native targets, brak skip |
| CPU runtime | `just verify-fdm-multilayer-demag-runtime cpu-fp64` | qualified albo jawny FAIL artifact |
| CUDA FP64 | `just verify-fdm-multilayer-cuda-runtime cuda-fp64` | device-resident, brak fallbacku |
| CUDA FP32 | `just verify-fdm-multilayer-cuda-runtime cuda-fp32` | osobna precision parity |
| Airbox lanes | `just verify-fdm-multilayer-airbox-runtime cpu-fp64` oraz warianty `cuda-fp64`, `cuda-fp32` | osobne D1/D2 artifacts |
| pełna promocja | `just verify-fdm-multilayer-demag-production` | agregacja wszystkich obowiązkowych PASS |

W fazie RED każda nowa focused komenda musi zawieść na oczekiwanej asercji semantycznej. Błąd kompilacji, brak fixture, skip GPU albo brak urządzenia nie jest prawidłowym RED dla fizyki.

## 8. Strategia równoległych sub-agentów

Praca ma siedem fal i dwa sekwencyjne gate commits. Agenci w tej samej fali nie mogą edytować wspólnych plików. Integrator scala po przejściu lokalnej bramki każdej gałęzi.

### Gate G0 — decyzje i schematy, sekwencyjnie

Integrator przed delegacją zamraża w jednym małym commicie/spec revision:

- source/destination orientation;
- enum wire values;
- reguły `common_cells*`;
- `scene.v3` migration;
- layout/observation/execution revisions;
- layer/object identity semantics;
- thresholds/artifact schemas;
- proponowane OpenAPI paths i error codes.

### Fala A — kontrakty RED, równolegle

| Agent | Zakres zapisu | Wynik | Zależność |
|---|---|---|---|
| A1 Physics | `docs/physics/0421-fdm-multilayer-convolution-demag.md`, sąsiedni source-map JSON, `docs/physics/multilayer_convolution/*`, `docs/physics/README.md` | kompletna nota/source map | G0 |
| A2 Python/IR | testy Python, IR i authoring | RED round-trip i validation tests | brak |
| A3 Kernel oracle | `fullmag-fdm-demag` tests/data | direct oracle i shifted RED | brak |
| A4 API contract | wyłącznie API schema/tests, bez handlera/generated | RED layout/mask resource | G0 |
| A5 UI contract | frontend model tests bez implementacji | RED Explorer/viewport/script tests | brak |
| A6 Qualification | nowy verifier/scenario tests | RED artifact schema i SP4-derived cases | brak |

### Gate G1 — centralne typy, sekwencyjnie

Jeden właściciel scala enumy i descriptor types w `fullmag-ir`, `fullmag-authoring` oraz `fullmag-fdm-demag/src/types.rs`. Dopiero ten commit rozdziela dalsze gałęzie; B1 i B2 nie edytują potem wspólnych centralnych typów.

### Fala B — semantyka i CPU, częściowo równolegle

| Agent | Zakres | Zależność |
|---|---|---|
| B1 Python/Scene adapters | Python DSL, Scene adapters/migration/script builder; bez `mesh_hints.rs` | A2 + G1 |
| B2 Planner/capability | resolver strategii i plan lowering; bez Scene adapters | A2 + G1 |
| B3 Kernel mathematics | nowy irregular/cell-pair moduł, `newell.rs`, `shifted_kernel.rs`; bez `types.rs` | A3 + G1 + nota physics |
| B4 Transfer | wyłącznie `transfer.rs` i osobne fixtures/testy transferu | A3 + G1 |

B3 i B4 współdzielą tylko readonly fixtures zatwierdzone w G1. API handler nie jest częścią tej fali, ponieważ zależy od finalnego plan descriptoru B2.

### Gate G2 — descriptor ABI, sekwencyjnie

Jeden właściciel, po B2–B4, scala katalog kerneli, C ABI source, Rust FFI declarations i fixtures ABI. Po G2 C2 nie zmienia kształtu ABI, a C3 używa zamrożonego descriptoru.

### Fala C — runtime, równolegle po zamrożeniu descriptor ABI

| Agent | Zakres | Zakazane |
|---|---|---|
| C1 CPU oracle runtime | `fullmag-engine` + CPU multilayer runner | `backends/fdm`, observation materializer |
| C2 CUDA FP64 | CUDA hot loop/context wyłącznie za ABI G2 | CPU engine, C ABI shape |
| C3 API layout resource | schemas/handlers/OpenAPI source, bez generated client | CPU/CUDA runtime |
| C4 Authoring resource | Scene resource/transaction/study-runtime API | data layout handler |

Po C1 integrator scala proweniencję CPU i runtime artifact schema; po C2 scala Rust CUDA bridge/provenance w osobnym sekwencyjnym kroku. Observation CPU nie zaczyna się równolegle z C1, ponieważ współdzieli materializer/workspace.

### Fala D — observation i frontend data plane, częściowo równolegle

| Agent | Zakres | Zależność |
|---|---|---|
| D1 Observation CPU | observation plan/materializer/artifact/field resolver | C1 |
| D2 Observation CUDA FP64 | target-only apply | C2 + D1 contract |
| D3 Generated API + hooks | generated transport, resource hooks, stale/abort | C3 + C4 |
| D4 SP4 operator/bilayer | direct/CPU scenarios bez Airbox | C1 + B3 |
| D5 SP4 C1/C2/C3 heterogeneous | podzielone scenarios | C1 + B3 + B4 |

### Gate G3 — frontend selection/target types, sekwencyjnie

Integrator scala domain presentation adapter, selection kinds, target identity i cache-key types. Dopiero potem Explorer i viewport są rozłączne plikowo.

### Fala E — UI, scenariusze Airbox i recipes FP64

| Agent | Zakres | Zależność |
|---|---|---|
| E1 Explorer/Inspector | tree i osobne panele; bez viewport | C3 + D3 + G3 |
| E2 Magnetic-layer viewport | layer carriers/lifecycle; bez Airbox target | D3 + G3 |
| E3 Airbox scenario/verifier | D1/D2 runtime artifacts | D1 + D2 + thresholds |
| E4 Managed contract/runtime recipes FP64 | just recipes + immutable summary | C1 + C2 + D1 + D2 |

E4 musi najpierw dostarczyć i uruchomić FP64 managed parity. Nie delegować FP32 w tej samej fali.

### Fala F — Airbox viewport i CUDA FP32, równolegle po FP64

| Agent | Zakres | Zależność |
|---|---|---|
| F1 Airbox viewport | observation target/demand/cache; po scaleniu E2 | E2 + E3 |
| F2 CUDA FP32 | precision lane i parity | udokumentowany PASS E4 |
| F3 Full SP4-derived dynamics | Heun/RK4/RK23 CPU/CUDA FP64 | D4 + D5 + PASS E4 |

### Fala G — integracja i promocja

Jeden integrator:

1. uruchamia wszystkie focused gates;
2. rozwiązuje konflikty w centralnych enumach i generated artifacts;
3. wykonuje managed CPU/GPU runtime;
4. wykonuje świeżą kwalifikację UI;
5. audytuje artifacts requirement-by-requirement;
6. promuje dokumentację/capabilities tylko dla udowodnionych lane’ów.

### Zasady pracy agentów

- każdy agent dostaje listę `Modify/Create/Do not touch`;
- żadnych współdzielonych edycji `AGENTS.md`, generated OpenAPI ani centralnych registry bez właściciela;
- generated files regeneruje jeden agent po scaleniu source schema;
- każda gałąź ma test RED, minimalną implementację GREEN i własny handoff;
- subagent nie commituje cudzych dirty changes;
- integrator przed każdym commitem sprawdza osobno `git diff --cached --name-only`;
- finalny build/runtime FDM przechodzi przez repozytoryjne managed `just` recipes;
- obecność kodu nie zastępuje runtime/device proof.

## 9. Macierz testów numerycznych

| Przypadek | Oracle | CPU FP64 | CUDA FP64 | CUDA FP32 | Wymagany invariant |
|---|---|---:|---:|---:|---|
| L=1 self | direct + single-grid | tak | tak | tak później | bitwise/near-roundoff FP64 |
| L=2 ±Z | direct | tak | tak | tak później | reciprocity + wszystkie składowe |
| L=2 unequal thickness | irregular direct | tak | tak | tak później | source/destination orientation |
| L=3 regular | CPU direct/coarse | tak | tak | tak później | kernel reuse + memory |
| L=3 heterogeneous | CPU direct/coarse | tak | tak | tak później | transfer error oddzielnie |
| XY offset | direct | gated | gated | gated | full-complex correctness |
| Airbox above/below | direct samples | tak | tak | tak później | target-only carrier |
| SP4-derived dynamics | CPU reference/supergrid | tak | tak | tak później | trajectories/energy/torque |

Tolerancje mają trzy warstwy:

1. tensor/kernel przeciw high-precision/direct;
2. FFT/reference przeciw direct field;
3. backend parity i pełny workflow.

Każda tolerancja podaje normę, jednostkę, floor, grid, precision, hardware relevance i uzasadnienie. Nie używać jednego globalnego `1e-5` dla wszystkich poziomów.

## 10. Kryteria akceptacji

### 10.1. Dokumentacja

- kompletna nota physics z równaniami, SI, założeniami i source map;
- poprawna bibliografia 2019/126/103903;
- clean-room/legal note dla BORIS;
- jawne braki publikacji i Fullmag;
- brak nieudowodnionych claimów.

### 10.2. Publiczny kontrakt

- UI ↔ Python ↔ ProblemIR round-trip bez dryfu;
- typowane enumy i fail-closed validation;
- jawny requested/resolved strategy/mode/device/precision;
- stabilne object/layer IDs;
- zgodna tabela strategii dla L=1 i L>1.

### 10.3. Numeryka

- direct oracle wszystkich sześciu składowych;
- reciprocity i energy-field identity;
- unequal thickness;
- identity i push/pull;
- open-boundary padding/normalization proof;
- CPU FP64, CUDA FP64, następnie FP32.

### 10.4. Wydajność i pamięć

- `L` forward + `L` inverse;
- deduplikowany katalog kerneli;
- planner/runtime memory agreement;
- allocation-free warm apply w zakresie dużych buforów;
- brak ukrytych H2D/D2H dla device-resident lane;
- benchmark cold/warm/transfer/memory.

### 10.5. API/UI

- named layout resource i revision invalidation;
- heavy arrays wyłącznie binary data plane;
- jedno drzewo Mesh i osobny Inspector na node kind;
- native layer field scopes;
- jeden canvas i wspólny renderer;
- osobny observation Airbox carrier;
- świeży WebGL proof wszystkich wymaganych trybów.

### 10.6. Walidacja SP4-derived

- kanoniczny SP4 niezmieniony;
- L=1 reduction;
- L=2/L=3 cross-layer coupling;
- Airbox nad/pod jako oddzielny target-only test;
- CPU/GPU artifact reports z provenance;
- jasny napis „SP4-derived, not canonical SP4 qualification”.

## 11. Ryzyka i działania zapobiegawcze

| Ryzyko | Skutek | Działanie |
|---|---|---|
| Błędny znak shifted off-diagonal | fizycznie błędne pole | direct oracle + reciprocity przed optymalizacją |
| Cancellation w irregular Newell | błędy blisko/daleko | scaling, compensated sum, high-precision vectors |
| Estymator pamięci rozmija się z runtime | OOM | jeden katalog i jeden model bytes |
| CUDA nadal robi L² FFT | brak zysku | liczniki etapów jako failing contract |
| Push/pull maskuje błąd kernela | fałszywa parity | osobne error lanes identity/transfer |
| UI używa private artifact metadata | dryf API | named v2 resource |
| Common grid uznany za physical mesh | błędna wizualizacja | jawna etykieta scratch + native carriers |
| Airbox włączony do hot loop | duży koszt dynamiki | on-demand target-only materialization |
| SP4-derived uznany za NIST SP4 | fałszywa kwalifikacja | osobny katalog, nazwa i raport |
| GPL contamination | ryzyko licencyjne | clean-room, brak translacji kodu/struktur |
| Dirty shared checkout | utrata cudzych zmian | izolowane worktrees i wąskie staging |
| Capability wyprzedza dowody | fałszywy claim | promocja dopiero po immutable artifacts |

## 12. Elementy poza pierwszą promocją

Poniższe elementy nie mogą być włączone przypadkiem; wymagają osobnych rozszerzeń planu i kwalifikacji:

- PBC/Ewald;
- multi-GPU;
- temporalna ekstrapolacja pola;
- atomistic/AFM;
- thermal, STT, SOT i Oersted w multilayer;
- dowolne region-owned/spatial material fields;
- adaptive integrators, jeśli nie mają pełnego staged multilayer contract;
- disk-persistent kernel cache;
- automatyczny cost model bez stabilnych benchmarków;
- general XY offset jako production lane, dopóki full-complex direct tests nie przejdą;
- publiczna ręczna konfiguracja observation kernel catalog.

## 13. Kolejność scalania

1. Dokumentacja i testy RED.
2. Typy Python/Scene/IR i resolver plannera.
3. Direct oracle i poprawna pełna reprezentacja kernela.
4. Katalog/reuse/memory model.
5. CPU FP64 reference.
6. Zamrożenie ABI descriptor.
7. CUDA FP64 hot loop i Rust bridge.
8. Proweniencja/capability/artifacts.
9. API resource i frontend data layer.
10. Explorer/Inspector i viewport layers.
11. Observation Airbox runtime/API/viewport.
12. SP4-derived scenarios.
13. Managed runtime i WebGL qualification.
14. CUDA FP32.
15. Dokumentacyjna promocja lane po audycie dowodów.

Nie scalać UI authoring jako „gotowe”, dopóki jego eksportowany skrypt nie przechodzi przez planner i publiczny runtime. Nie scalać CUDA jako „gotowe”, dopóki test nie dowodzi liczby FFT, parity i residency.

## 14. Końcowy audyt wymaganie → dowód

Przed zamknięciem wdrożenia integrator tworzy tabelę z każdym wymaganiem tego planu. Dla każdego wpisuje:

- authoritative file/symbol;
- test lub recipe;
- immutable artifact path i hash;
- lane/device/precision/mode;
- wynik `proven|contradicted|missing|insufficient`;
- blocker i następna bramka.

Status końcowy może być `complete` wyłącznie, gdy wszystkie wymagania obowiązkowe mają `proven`. Brak błędu w teście nie wystarcza, jeżeli test nie obejmuje danego wymagania.

## 15. Definition of Done

Wdrożenie jest zakończone dopiero wtedy, gdy jednocześnie:

1. dokumentacja naukowa jest kompletna i przechodzi walidatory;
2. publiczny Python i Control Room round-tripują ten sam `ProblemIR`;
3. planner respektuje jawny wybór i fail-closed capabilities;
4. shifted/irregular kernels przechodzą direct oracle;
5. CPU FP64 przechodzi pole, energię i transfer invariants;
6. CUDA FP64 wykonuje prawdziwy algorytm `L + L` FFT/IFFT i przechodzi parity;
7. CUDA FP32 ma osobną skalibrowaną kwalifikację albo pozostaje gated;
8. kernel reuse i memory accounting są faktycznie zgodne;
9. proweniencja opisuje realny lane, precision, residency i fallback;
10. API publikuje natywne layouty warstw bez ciężkich danych w statusie;
11. Explorer, Inspectory i viewport obsługują wszystkie natywne warstwy;
12. Airbox ma własny runtime-origin observation carrier;
13. SP4-derived L=1, L=2/L=3 i Airbox przechodzą wymagane porównania;
14. świeży managed CPU/GPU runtime i WebGL proof są zarchiwizowane;
15. capability matrix promuje wyłącznie udowodnione kombinacje.

Do tego momentu poprawny komunikat projektu brzmi: funkcja jest częściowo zaimplementowana i publicznie osiągalna; CPU FP64 wraz z target-only Airbox convergence ma kwalifikowane zakresy dowodowe, lecz pełna poprawność shifted/heterogeneous, produkcyjna ścieżka GPU, pełna macierz wizualna i fizyczna kwalifikacja całego algorytmu pozostają nieudowodnione.
