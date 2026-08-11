# Audyt implementacji FDM multilayer convolution — 2026-08-11

## 1. Wniosek wykonawczy

Stan `master@15ab7482b0b6f5735684fb3bf7a51f155c778860` nie jest gotowy do
produkcyjnej symulacji FDM multilayer convolution na GPU. Publiczny kontrakt
Python/ProblemIR, planner CPU, resource-first API, Explorer, Inspector i model
viewportu są w dużej części wykonane. CPU FP64 ma wartościowe, lokalne dowody
zakresowe. Nie oznacza to jednak domknięcia fizyki ani architektury całego celu.

Audyt wykrył cztery blokery P0:

1. CUDA-assisted dla `two_d_stack`, nierównych grubości i `push_pull` buduje
   starszy kernel zależny tylko od przesunięcia Z i rozmiaru komórki pierwszej
   warstwy. Nie realizuje tego samego operatora co descriptorowy CPU.
2. Transfer `push_pull` ma lokalny dowód zadeklarowanego operatora dla różnych
   extentów i `V_native != V_scratch`, ale nie ma wspólnej semantyki CPU/GPU ani
   bezpośredniego continuum/native-cell oracle dla
   `h_source,z != h_destination,z`.
3. Planner budżetuje pamięć według liczby unikalnych przesunięć Z, podczas gdy
   aktywne ABI CUDA alokuje i wysyła pełne `L^2` tensorów. Plan może przejść
   preflight i zakończyć się OOM podczas tworzenia runtime.
4. Natywny hot loop D-07 realizuje `L` FFT, `L` IFFT i `L^2` akumulacji tylko
   wewnątrz odświeżenia demag. Cały krok czasowy pozostaje host-authoritative:
   przed odświeżeniem kopiuje `m` H2D, a po nim `H_demag` D2H.

Decyzja audytu: status celu pozostaje **partial / not production-qualified**.
CUDA dla niejednorodnego multilayer powinno zostać tymczasowo fail-closed, dopóki
nie używa kanonicznych deskryptorów i nie ma świeżego managed device proof.

## 2. Zakres i hierarchia dowodu

Audyt objął:

- `master` i rozbieżne worktree związane z celem;
- publikację fizyczną, plan produkcyjny, historyczny rollout i macierz
  kwalifikacji;
- Python DSL, SceneDocument, ProblemIR i planner;
- CPU reference, transfery, katalog kerneli i Airbox;
- Rust/CUDA ABI, D-06, D-07, proweniencję i managed gates;
- OpenAPI v2, API zasobowe, Explorer, Inspectory i viewport 3D;
- testy kontraktowe oraz status istniejących artefaktów.

Rozróżnienie statusów jest obowiązkowe:

| Status | Znaczenie |
|---|---|
| implemented | kod lub kontrakt istnieje |
| executable | istnieje ścieżka wywołania bez twierdzenia o poprawności fizycznej |
| runtime-verified | świeży run jest związany z pełnym SHA źródła i artefaktami |
| physically-validated | niezależny oracle potwierdza pole i energię dla danej klasy |
| production-qualified | wszystkie wymagane lane'y, urządzenia i bramki przeszły |

Lokalne JSON-y pod `.superpowers/sdd/evidence/fdm-multilayer-runtime` nie są
śledzone przez Git i nie mają kompletnego powiązania z bieżącym HEAD. Mogą być
dowodem diagnostycznym, ale nie immutable production receipt.

## 3. Stan warstw systemu

| Warstwa | Stan | Ocena audytu |
|---|---|---|
| Python DSL | `FDMGrid`, `FDMDemag`, `FDM`, `per_magnet`, `common_cells*` istnieją | wykonawcze authoring; braki walidacji typu i dokumentacji warunków |
| SceneDocument | zapisuje politykę FDM | nadal `scene.v2`; stabilne object ID nie przechodzi do runtime planu |
| ProblemIR | zachowuje requested strategy/mode | stringly typed; brak `reason_codes` i execution fragment v2 |
| Planner | buduje `FdmMultilayerPlanIR`, native/scratch grids i transfer kind | CPU użyteczny; błędny estimator D-06, cicha utrata `boundary_*` |
| CPU demag | descriptorowy pair kernel, katalog i workspace | dobry fundament; scoped `push_pull` jest lokalnie zweryfikowany, unequal native-cell thickness wymaga direct oracle |
| CUDA demag | ABI v2, pairwise i wąski batched D-07 | nieprodukcyjne; assisted operator może zmieniać fizykę |
| Runtime/provenance | rozróżnia assisted i native single-grid | brak kompletnego `fdm_multilayer_execution.v2` |
| API v2 | layout, pola, maski i Airbox jako zasoby | kontrakt działa; plan i kod różnią się dla `404` vs `200 unavailable` |
| UI authoring | wybór strategii/mode/common cells i JSON per-magnet | funkcjonalne, lecz name-keyed i podatne na rename drift |
| Explorer/Inspector | native grid, mask, transfer, provenance, Airbox | częściowe; brak osobnego scratch-grid per layer |
| Viewport 3D | oddzielne native carriers, maski i target-only Airbox | testy modelu przechodzą; brak świeżego WebGL/runtime proof |
| Managed qualification | recepty i walidatory istnieją | CUDA kończy `not_qualified`; brak FP32 i pełnej macierzy |

## 4. Findings

### P0-1 — CUDA-assisted realizuje inny operator niż CPU

Właściciele:

- `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs::build_multilayer_demag_runtime`;
- `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs::build_multilayer_demag_runtime_f32`;
- `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::build_multilayer_demag_runtime`.

Ścieżka GPU wybiera `compute_shifted_kernel(conv_grid, conv_cell_size, z_shift)`,
gdzie `conv_cell_size` pochodzi z pierwszej warstwy. Nie przekazuje rozdzielnych
`h_source`, `h_destination`, deskryptorów transferu ani pełnego przesunięcia XY.
CPU używa `compute_shifted_kernel_pair` oraz rzeczywistych native thickness.

Skutek: `validate_cuda_multilayer_execution_contract` dopuszcza `two_d_stack`,
ale jego assisted wykonanie może policzyć błędny kernel dla nierównych grubości,
XY-offset i `push_pull`.

Brama naprawcza:

1. natychmiast fail-close CUDA dla `two_d_stack`, heterogenicznego `h_z`,
   `push_pull` i XY-offset, albo przełączyć assisted demag na dokładnie ten sam
   descriptorowy operator co CPU;
2. dodać managed CPU↔CUDA FP64 parity pola i energii;
3. dopiero po FP64 osobno kwalifikować FP32.

### P0-2 — D-06: planner i runtime nie uzgadniają katalogu ani pamięci

Właściciele:

- `crates/fullmag-plan/src/fdm.rs::plan_fdm_multilayer`;
- `crates/fullmag-engine/src/multilayer.rs::build_kernel_catalog`;
- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs::create_multilayer_v2`;
- `backends/fdm/gpu/cuda/runtime/context.cu::context_upload_multilayer_plan_v2`.

Planner liczy `estimated_unique_kernels` wyłącznie z unikalnych przesunięć Z.
Kanoniczny klucz runtime obejmuje także zorientowany shift, `h_source`,
`h_destination`, thickness, layout, representation, precision i boundary.
Aktywne ABI CUDA wymaga pełnej tablicy `L^2` par i alokuje sześć widm na każdy
deskryptor. Estimator może więc wielokrotnie zaniżyć pamięć.

Brama naprawcza:

- planner ma materializować dokładnie ten sam katalog, który konsumuje runtime;
- ABI v3 ma rozdzielić unique catalog entries od direct pair bindings;
- preflight ma budżetować katalog, source spectra, destination scratch,
  transfer maps i workspace cuFFT z checked arithmetic;
- test ma wykazać fail-before-allocation zamiast runtime OOM.

### P0-3 — D-07 nie obejmuje całego kroku czasowego

Właściciele:

- `backends/fdm/gpu/cuda/demag/multilayer_convolution.cu::launch_multilayer_demag_field_fp64_batched`;
- `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs::NativeMultilayerDemagOperator::compute_demag_fields`.

Wewnętrzny refresh ma właściwy kształt `L/L/L^2`, ale runner kopiuje wszystkie
warstwy `m` H2D i wszystkie `H_demag` D2H przy każdym refreshu. Nie jest to
device-resident solver multilayer. Obecna proweniencja
`cuda_assisted_multilayer` jest uczciwa; verifier, który nadaje `qualified`
host-authoritative artefaktowi, nie jest uczciwą bramką produkcyjną.

Brama naprawcza: cały staged RK, lokalne pola, demag i aktualizacja `m` muszą
pozostać na urządzeniu. Warm apply ma raportować rzeczywiste zero wektorowych
H2D/D2H, a nie tylko wyzerowane liczniki kontraktowe.

### P0-4 — unequal native-cell thickness nie ma continuum oracle

Właściciele:

- `crates/fullmag-fdm-demag/src/transfer.rs::VolumeWeightedTransfer::push_m_into`;
- `crates/fullmag-fdm-demag/src/transfer.rs::VolumeWeightedTransfer::pull_h_adjoint_into`;
- `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs::build_multilayer_demag_runtime`.

`push_m_into` normalizuje przez `covered_volume`, a adjoint pull stosuje czynnik
`scratch_volume/native_volume`. Jednocześnie kernel 2D pair jest już
parametryzowany native `h_source/h_destination`. Lokalny artefakt
`unequal-small-fixed-fresh-v2-transfer.json` potwierdza `96/96`, pole, energię i
adjointness zadeklarowanego operatora dla różnych extentów oraz
`V_native != V_scratch`, ale używa jednakowego native `h_z=3 nm`.

Nie przesądzamy poprawki algebraicznej bez niezależnego wyprowadzenia. Istniejący
dowód zachowuje status `locally physically-validated in the stated scope`.
Nie wolno go rozszerzać na `h_source,z != h_destination,z` ani na CUDA.

Brama naprawcza: dla nierównych native cell thickness oddzielnie udowodnić
zachowanie całkowitego momentu, adjointness, pole każdej pary, energię globalną
i volume-weighted reciprocity względem direct continuum/native-cell oracle.

### P1-1 — explicit multilayer może zostać wykonany jako single-grid fast path

`build_native_stacked_cuda_plan` składa zgodne warstwy do jednego globalnego
grida z `active_mask` i kieruje je do zwykłego `NativeFdmBackend`. Fizycznie
może to być równoważne dla ograniczonego przypadku, ale jest inną realizacją niż
zamówione `multilayer_convolution` i nie przechodzi D-07.

Publiczny przełącznik silent fallback został usunięty. Dlatego plan musi:

- albo zabronić tego wyboru dla explicit `multilayer_convolution`;
- albo nazwać go jawną, osobno wybieraną strategią i zapisać requested/resolved
  realization oraz powód w provenance.

### P1-2 — cicha utrata `boundary_*`

Python obniża `boundary_correction`, `boundary_phi_floor` i
`boundary_delta_min`, lecz `FdmMultilayerPlanIR` ich nie posiada i planner ich
nie odrzuca. Jest to round-trip drift. Do czasu zdefiniowania wpływu per-layer
planner ma fail-close dla wartości innych niż neutralne.

### P1-3 — niepełny kontrakt v2 i stable object identity

Brakuje:

- typed enums dla strategy/mode;
- stabilnych `reason_codes`;
- migracji `scene.v2 -> scene.v3`;
- object ID zachowanego przez ProblemIR i planner;
- `fdm_multilayer_execution.v2` z pełnym requested/resolved execution;
- kernel/transfer hashes, runtime SHA, device UUID, cuFFT version i fallback.

Obecnie planner wyprowadza `object_id` z nazwy magnesu. UI edytuje
`per_magnet` jako surowy JSON kluczowany nazwą. Rename może osierocić siatkę.

### P1-4 — capability matrix nadmiernie agreguje single-grid i multilayer

Statusy FDM GPU i direct minimizerów są prawdziwe dla wybranych single-grid
lane'ów, ale macierz nie rozdziela ich od multilayer. Multilayer planner
dopuszcza obecnie tylko `llg_overdamped`; PG-BB i NCG są odrzucane.

Macierz ma być rozbita co najmniej po:

- `single_grid` / `multilayer_convolution`;
- CPU / CUDA-assisted / CUDA-native;
- `two_d_stack` / `three_d`;
- identity / `push_pull`;
- FP64 / FP32;
- implementacja / runtime / fizyka / produkcja.

### P1-5 — drift planu API i aktualnej semantyki resource

Plan wymaga `404 resource_not_applicable` poza multilayer. Kod i testy zwracają
`200` z `{available:false, unavailable_reason:"not_fdm_multilayer"}`. Obie
semantyki mogą być poprawne, ale jedna musi zostać wybrana i zapisana w planie,
OpenAPI oraz testach. Audyt rekomenduje zachować obecne `200 unavailable`, bo
upraszcza resource hook i nie zamienia braku zastosowania w błąd transportu.

### P2 — optymalizacje i UX

1. CUDA wyszukuje pair descriptor liniowo dla każdej pary; przy obecnym
   katalogu daje zbędny koszt host-side zbliżony do `L^4`.
2. Destination spectra są alokowane jako `3*L*Nfft`, mimo sekwencyjnego
   przetwarzania celów; po pomiarze można rozważyć jeden scratch `3*Nfft`.
3. Airbox jest eager materializowany podczas zapisu artefaktów, a nie on-demand
   przez `compute_fields`; generuje niepotrzebny koszt dla użytkownika, który
   nie żąda pola Airboxa.
4. Generic target runtime wykonuje FFT/IFFT także dla zerowych źródeł/celów;
   potrzebuje sparse/non-empty scheduling.
5. UI powinno zastąpić raw JSON `per_magnet` edytorem per-object, związanym ze
   stabilnym ID i pokazującym resolved native/scratch grid.
6. Explorer powinien dodać `Scratch Grid` per layer i dedykowane inspectory dla
   Native Grid, Active Mask, Transfer i Provenance.
7. WebGL matrix nie asertywnie mierzy demand frameloop, idle redraw, worker,
   listener i buffer lifecycle.

## 5. Worktree i strategia integracji

`codex/fdm-multilayer-production-aggregate@9e0adf382` nie jest przodkiem
`master` i nie może być scalony hurtowo. Ma `8` commitów tylko na masterze i
`15` commitów tylko na branchu. Zawiera jednocześnie:

- wartościowy hardening D-07 i validator benchmarku;
- zmiany scenariusza SP4;
- globalne migracje managed FEM storage niezwiązane bezpośrednio z operatorem;
- starszą bazę bez ostatnich poprawek scene/WebGL launchera.

Zalecenie:

| Fragment | Decyzja |
|---|---|
| fail-closed verifier z worktree D-07 | przenieść dopiero razem z runtime/provenance, które może go przejść |
| benchmark validator | selektywny re-review po ustaleniu ABI v3 i schematu receipt |
| zmiany managed FEM storage | osobny cel i osobny review; nie scalać z FDM multilayer |
| SP4 scenario loader/scene fixes | bieżący master jest nowszym właścicielem |
| cały branch aggregate | odrzucić jako jednostkę merge/cherry-pick |

## 6. Skorygowany plan wdrożenia

### Faza A — containment i kontrakt

1. Dodać testy RED dla CUDA unequal `h_z`, XY-offset, `push_pull` i
   boundary-correction drift.
2. Fail-close niekanoniczne CUDA-assisted konfiguracje.
3. Rozstrzygnąć explicit multilayer vs native single-grid fast path.
4. Zamrozić `fdm_multilayer_execution.v2` i ABI v3.

Warunek wyjścia: żaden publiczny request nie wykonuje innej fizyki niż zapisana
w ProblemIR, a każdy brak capability kończy się przed alokacją.

### Faza B — CPU oracle i D-06

1. Zachować lokalnie zweryfikowany operator dla obecnego zakresu transferu.
2. Dodać direct continuum/native-cell field/energy/reciprocity tests dla
   `h_source,z != h_destination,z`.
3. Materializować kanoniczny katalog w plannerze i przekazywać go do runtime.
4. Uzgodnić estimator pamięci z faktycznymi alokacjami.

Warunek wyjścia: CPU FP64 przechodzi L=1/2/3, +/-shift, unequal thickness,
XY-offset, identity i `push_pull`, z receipt związanym z pełnym SHA.

### Faza C — natywne CUDA

1. Zaimplementować ABI v3 unique entries + direct pair bindings.
2. Przenieść transfer maps/fingerprint na urządzenie.
3. Utrzymać `m`, local fields, `H_demag` i staged RK na GPU.
4. Instrumentować realne transfery, FFT, pair accumulation i peak memory.

Warunek wyjścia: warm FP64 apply ma `L/L/L^2`, zero vector H2D/D2H i parity z
CPU dla pełnej macierzy.

### Faza D — Python/IR/API/UI

1. Typed strategy/mode, reason codes i fail-closed `boundary_*`.
2. Scene v3 oraz stable object ID do ProblemIR/planu.
3. Per-object grid editor zamiast raw JSON.
4. Scratch Grid per layer, dedykowane Inspectory i jawny execution status.
5. Zachować target-only Airbox jako observation carrier, nigdy physical common
   mesh.

Warunek wyjścia: Python i UI round-trip zachowują ID, requested intent i
resolved execution bez rename drift.

### Faza E — kwalifikacja

1. Managed CPU FP64 source-bound receipt.
2. Managed CUDA FP64: `L=1,2,4,8`, identity, `push_pull`, +/-shift, unequal,
   XY-offset, energy i Airbox.
3. Dopiero potem osobna macierz FP32.
4. WebGL 24 native + 4 Airbox oraz lifecycle/performance assertions.
5. Benchmark `L=1,2,4,8,16`: cold setup, warm apply, FFT, pair multiply,
   transfer i peak memory.

Warunek wyjścia: dopiero komplet tej fazy pozwala ustawić
`production-qualified=yes`.

## 7. Weryfikacja wykonana podczas audytu

| Polecenie | Wynik |
|---|---|
| focused Python/runtime multilayer tests | `21 passed` |
| runtime recipe/provenance tests | `11 passed` |
| focused Control Room multilayer/Airbox tests | `101 passed` |
| Control Room typecheck | passed |
| `fullmag-plan` multilayer tests | `25 passed` |
| `fullmag-api` multilayer tests | `17 passed` |
| scientific documentation validator tests | `21 passed` |
| public documentation example checker | passed |

Pierwsze uruchomienie Vitest nie wystartowało z powodu niedostępnego
Windowsowego katalogu tymczasowego; powtórzenie z `TMPDIR=/tmp` przeszło.
Pierwsze uruchomienie Cargo nie mogło zapisać workspace `target`; powtórzenie z
dedykowanym `CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/multilayer-audit`
przeszło. Nie są to błędy implementacji multilayer.

Nie wykonano świeżego managed CUDA runu ani pełnej macierzy WebGL. Ten audyt nie
jest dowodem produkcyjnej kwalifikacji urządzenia ani wizualizacji.

## 8. Kryterium zgody na symulację

Na bieżącym masterze można używać wyłącznie jawnie ograniczonego CPU FP64 jako
lane'u badawczego i porównawczego, z zachowaniem granic macierzy kwalifikacji.
Nie należy traktować CUDA multilayer, FP32, unequal-native-cell-thickness
`push_pull` ani Airbox WebGL jako produkcyjnie zatwierdzonych. Każdy wynik z tych lane'ów musi
być oznaczony `unqualified` do przejścia faz A--E.
