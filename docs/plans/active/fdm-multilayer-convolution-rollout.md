# FDM Multi-Layer Convolution Demag: Szczegółowy Plan Architektoniczny

## Status implementacji

### Zaimplementowany pierwszy publiczny slice

Na dzień `2026-03-25` repo ma już działającą ścieżkę publiczną dla **multi-body FDM demag** w
trybie `multilayer_convolution`, ale tylko dla ograniczonego, uczciwie opisanego zakresu:

- wiele `Ferromagnet` w jednym `Problem`,
- body-local `Exchange()`,
- globalne `Demag()` pomiędzy ciałami,
- globalne `InterfacialDMI()` / `BulkDMI()` constants w publicznym multilayer planie,
- planowanie przez `BackendPlanIR::FdmMultilayer(...)`,
- wykonanie przez CPU reference runner, publiczny `cuda-assisted` runner oraz
  native CUDA single-grid fast path dla kompatybilnych z-stacków,
- translacje geometrii przez `Translate`,
- przykład end-to-end:
  [examples/fdm_multibody_two_layer_stack.py](/home/kkingstoun/git/fullmag/fullmag/examples/fdm_multibody_two_layer_stack.py)

Potwierdzony smoke publiczny:

```bash
fullmag examples/fdm_multibody_two_layer_stack.py --headless --json
```

### Aktualne granice tego slice'u

Obecna implementacja nie jest jeszcze pełnym końcem planu z tego dokumentu. Publicznie
obsługiwane są tylko:

- stosy rozdzielone w `z`,
- identyczny środek i extenty `xy` wszystkich warstw,
- brak nakładania warstw w `z`,
- `Box`, `Cylinder`, `Difference` oraz opcjonalne `Translate`,
- `ImportedGeometry` tylko przez precomputed FDM grid asset,
- fixed-step `Heun`/`RK4`/`RK23` + `double`/`single` at the native v2 staged layer boundary,
- CPU reference oraz dwa tory CUDA:
  - `cuda_native_multilayer_single_grid` dla kompatybilnych z-stacków dających się złożyć do
    jednego globalnego grida z `active_mask + region_mask`,
  - `cuda-assisted_multilayer` jako fallback, gdzie local exchange per body idzie przez
    native CUDA FDM, lokalne DMI/anizotropia są składane z warstwowych obserwowalnych, a globalny
    cross-body demag pozostaje na istniejącym runtime konwolucyjnym.

Jeszcze **nie** są gotowe:

- pełny natywny ABI/CUDA path dla heterogenicznych multilayer cases, które nie mieszczą się w
  single-grid fast path,
- warstwy z przesunięciem w `x/y`,
- `Union` / `Intersection` w publicznym plannerze multilayer,
- inter-body exchange / explicit couplings,
- layer-aware live preview w web UI,
- pełny artifact split per layer z osobnymi REST fetchami.

## Cel
Zastąpienie obecnego jedno-magnesowego spektralnego FDM demag przez jawny, objaśnialny, wielowarstwowy demag konwolucyjny oparty na dokładnym tensorze Newella. Pozwala to na symulację stosów warstw (np. SAF, spin-valves) z ewaluacją pól demagnetyzujących warstwa-po-warstwie na wspólnej siatce konwolucyjnej.

---

## Szczegółowe zmiany per plik

### 1. Python API & Definicje IR

#### [MODIFY] packages/fullmag-py/src/fullmag/model/geometry.py
- Dodać klasę `Translate`, dziedziczącą po `Geometry`: `Translate(base: Geometry, by: tuple[float, float, float], name: str = "")`.
- Zaimplementować metody `_bounding_box` oraz `_contains` tak, aby przesuwały współrzędne w locie.
- Dodać `Translate` do `__all__` oraz mixinów operatorskich (`.translate()`).

#### [MODIFY] packages/fullmag-py/src/fullmag/model/discretization.py
- Przebudować `FDM` aby obsługiwał osobne parametry siatki per magnes oraz opcje demagu:
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
- Zaktualizować `to_ir()`, by poprawnie eksportowało te obiekty.

#### [MODIFY] crates/fullmag-ir/src/lib.rs
- W `GeometryEntryIR` dodać wariant: `Translate { name: String, base: Box<GeometryEntryIR>, by: [f64; 3] }`.
- Wprowadzić `FdmHintsIR` ze strukturą dopasowaną do Pythona (zamiast dotychczasowego płaskiego `cell`).
- Dodać pomocnicze `FdmDemagHintsIR` i `FdmGridHintsIR`.
- Przebudować gruntownie `FdmPlanIR`:
  ```rust
  #[serde(tag = "kind", rename_all = "snake_case")]
  pub enum FdmPlanIR {
      UniformGrid(FdmUniformPlanIR),
      MultilayerConvolution(FdmMultilayerPlanIR),
  }
  ```
- W `FdmMultilayerPlanIR` dodać: `mode`, `common_cells`, `layers: Vec<FdmLayerPlanIR>`, `planner_summary: FdmMultilayerSummaryIR`.
- Zdefiniować `FdmLayerPlanIR`, przechowujące `native_grid`, `native_origin`, `convolution_grid` oraz `transfer_kind`.

---

### 2. Planner & Walidacja Wykonawcza

#### [MODIFY] crates/fullmag-plan/src/lib.rs
- Utworzyć nową fazę planowania implementując funkcję `analyze_fdm_demag_strategy(problem_ir) -> DemagPlanningDecision`.
- **Reguły decyzyjne**:
  - Auto-select wybiera `single_grid` dla jednego magnesu lub gdy wszystkie mają precyzyjnie ten sam rozmiar komórki.
  - Generuje błąd (Brak cichego fallbacku), jeśli nałożenie `multilayer_convolution` z opcją auto failuje przez niezgodne wymiary `xy` (zgłasza konieczność zdefiniowania `common_cells_xy`).
  - Zgłasza jasne błędy przy pokrywających się warstwach w `z`, lub gdy użyta jest rotacja, co w V1 nie jest wspierane.
- Zaktualizować główną funkcję `plan()`, kierującą wykonanie na budowanie odpowiedniego wariantu `FdmPlanIR` (UniformGrid lub MultilayerConvolution).

#### [MODIFY] crates/fullmag-cli/src/main.rs
- Dodać flagę `--explain` argumentach CLI.
- Jeśli `--explain` jest użyte, aplikacja wypisze czytelny diagnostyczny `FdmMultilayerSummaryIR` na stdout i zakończy bez wywoływania runnera.

---

### 3. Matematyka Single-Layer & Multi-layer na CPU

#### [NEW] crates/fullmag-fdm-demag (Nowy Crate)
- Cała implementacja kalkulacji tensora Newella, obecnie robi to engine dla pojedynczego box-a, zostaje wydzielona by CPU/GPU miało spójne source of truth.
- `TensorKernelFft`: Struct przechowujący w pamięci 6 wymiarów w dziedzinie sprzężonej (xx, yy, zz, xy, xz, yz).
- Utworzyć funkcje generujące: `compute_exact_self_kernel`, `compute_shifted_regular_kernel`.
- Zaimplementować generyczne $O(1)$ mnożenie tensor-wektor: `accumulate_tensor_convolution(dst_fft, src_fft, pair_kernel)`.
- Dodać transfer operators: `push_m` (native -> convolution przez uśrednianie w celach) oraz `pull_h` (convolution -> native via interpolacja trójliniowa).
- Dodać logikę użycia mapowania (np. hash key) po `KernelReuseKey` w celu oszczędzenia powtórnych wyliczeń tych samych dystansów międzywarstwowych.

#### [MODIFY] crates/fullmag-engine/src/lib.rs
- [x] Przenieść współdzielone `VectorFieldSoA`, `ExchangeLlgProblem`, `StepReport`/observables, `EffectiveFieldTerms`/term configs i typy FDM do `src/fdm/shared/` oraz CPU execution files (`fft`, `fft_backend`, `fields`, `integrators`, `state`) do `src/fdm/cpu/`, z publicznymi re-eksportami zachowanymi przez `fdm/mod.rs`.
- Zmienić nazwę i logikę `ExchangeLlgProblem` by odzwierciedlały nową semantykę. Nowa architektura:
  ```rust
  pub struct FdmLlgProblem {
      pub layers: Vec<FdmLayerRuntime>,
      pub demag: DemagOperatorRuntime,
      pub external_field: Option<[f64; 3]>,
      pub llg: LlgConfig,
  }
  pub enum DemagOperatorRuntime {
      None,
      UniformGrid(UniformGridDemagRuntime),
      MultilayerConvolution(MultilayerDemagRuntime),
  }
  ```
- **Krok Stepper'a**: Ewaluuje najpierw wymianę (exchange) na siatkach natywnych, potem wywołuje demag w oparciu o tablicę `MultilayerDemagRuntime`, co sprowadza się do złożoności $O(L^2)$ transferów i mnożeń w pętli. Na koniec dodaje pole zewnętrzne i przeprowadza krok LLG per warstwa.

---

### 4. GPU Path: Wykonanie natywne w CUDA

#### [MODIFY] crates/fullmag-fdm-sys/src/lib.rs
- Zmodyfikować bindingi C, tworząc wersję 2 API.
- [x] Zadeklarować enum typu planu: `fullmag_fdm_plan_kind` (`FULLMAG_FDM_PLAN_UNIFORM_GRID`, `FULLMAG_FDM_PLAN_MULTILAYER_CONV`).
- [x] Opisać `fullmag_fdm_layer_desc_v2` (posiadające i grid natywny, i wirtualny convolution_grid).
- [x] Opisać `fullmag_fdm_tensor_kernel_desc_v2` oraz `fullmag_fdm_multilayer_plan_desc_v2` przechowujące referencję na tablice `kernels` pre-kalkulowanych z Rust na hoscie.
- [x] Dodać wykonawczy entrypoint `fullmag_fdm_backend_create_v2` oraz walidację planu po stronie native CUDA z jawnym staged execution scope dla poprawnych planów multilayer.
- [x] Dodać upload/staging warstw i tensor-kerneli do urządzenia w `Context`.
- [x] Dodać pierwszego właściciela CUDA dla identity-grid `push_m`, `multiply_demag_tensor_kernel(...)` i `pull_h` w fp64/fp32.
- [x] Przygotować cached cuFFT workspaces dla v2 multilayer, keyowane per tensor-kernel `fft_grid`, i bindować aktywny workspace przed launchem tensor-kernela.
- [x] Użyć istniejącego `cufftMakePlanMany(..., batch=3)` workspace także w staged v2 multilayer demag launchu: każdy tensor-kernel wykonuje jedno batched x/y/z forward i jedno batched x/y/z inverse zamiast trzech osobnych wywołań na składową.
- [x] Wpiąć staged v2 handle w `step()` do natywnych fixed-step timestep slices: Heun, RK4 i RK23 w fp64/fp32 dla staged multilayer layers z opcjonalnym demag, uniform external field, per-layer uniform uniaxial/cubic anisotropy, global interfacial/bulk DMI i layer-local exchange; local/exchange-only plany utrzymują zerowe `H_DEMAG` zamiast wymagać tensor kernels, a adaptacyjne i wielokrokowe integratory są nadal jawnie odrzucane.
- [x] Zdjąć nieaktualną publiczną bramkę `heun`-only: planner multilayer FDM oraz CUDA-assisted multilayer runner przepuszczają fixed-step RK4 do staged native v2 path, bez otwierania adaptacyjnych ani wielokrokowych integratorów v2.
- [x] Rozdzielić publiczną bramkę integratorów według wykonania: CPU reference multilayer dopuszcza fixed-step Heun/RK4/RK23/RK45/ABM3, kompatybilne `cuda_native_multilayer_single_grid` stacki mogą użyć istniejących single-grid CUDA integratorów RK23/RK45/ABM3, a staged native v2 multilayer dopuszcza fixed-step Heun/RK4/RK23 i jawnie odrzuca adaptacyjne RK23/RK45 oraz ABM3.
- [x] Dodać fixed-step Bogacki-Shampine RK23 dla staged native v2 multilayer przez wspólnego właściciela explicit RK dla RK4/RK23; nie otwierać w tym kroku adaptive accept/reject/retry, RK45 ani ABM3.
- [x] Wystawić jawny `fullmag_fdm_backend_refresh_multilayer_demag`, żeby CUDA-assisted path odświeżał staged v2 demag bez używania `step(0)` jako operatora demag.
- [x] Wystawić per-layer copy ABI dla `M`, `H_EX` i `H_DEMAG`, żeby odświeżone native multilayer fields były widoczne poza prywatnym `Context`; kopia `H_EX` odświeża staged layer-local exchange przed transferem hosta.
- [x] Wystawić per-layer copy ABI dla staged `H_DMI`: native `Context` ma warstwowy bufor `h_dmi`, a `gpu/cuda/interactions/multilayer_dmi.cu` odświeża globalny interfacial/bulk DMI field na żądanie kopii.
- [x] Wystawić per-layer copy ABI dla staged `H_ANI`: native `Context` ma warstwowy bufor `h_ani`, a `gpu/cuda/interactions/multilayer_anisotropy.cu` odświeża uniaxial/cubic anisotropy field na żądanie kopii.
- [x] Wystawić per-layer copy ABI dla staged `H_EFF`: `gpu/cuda/interactions/multilayer_effective_field.cu` składa `H_EX + H_DEMAG + H_DMI + H_ANI + H_EXT` do istniejącego warstwowego `tmp` scratch po odświeżeniu staged `H_EX`, `H_DMI` i `H_ANI`; `H_DEMAG` pozostaje jawnie odświeżanym staged demag buforem.
- [x] Wystawić per-layer upload ABI dla aktualnej magnetyzacji i użyć staged native v2 handle jako demag operatora w identity-grid CUDA-assisted multilayer path.
- [x] Przenieść `transfer_kind` z `FdmLayerPlanIR` przez Rust wrapper, C ABI i native `Context`, żeby `identity` oraz `push_pull` były jawnym kontraktem wykonania zamiast inferencją z rozmiarów siatek.
- [x] Dodać fp64/fp32 CUDA `push_pull` transfer kernels dla staged v2 demag refresh: volume-weighted `push_m` native->convolution oraz trilinear `pull_h` convolution->native.
- [x] Zbudować i wgrać staged precomputed transfer maps dla heterogenicznych siatek w native `Context`: push offsets/indices/weights oraz padded-FFT pull indices/weights.
- [x] Dodać per-grid cuFFT workspace cache: tensor kernels mogą mieć różne `fft_grid`, a runtime przełącza aktywny `DeviceMultilayerFftWorkspace` bez niszczenia i ponownego tworzenia planu/buforów.
- [x] Przenieść `pull_h` mapy `push_pull` na tensor-kernel `fft_grid`: `push_map` pozostaje per-layer, a destination `pull_map` jest staged jako `kernel.dst_pull_map`.
- [ ] Dodać pełny native CUDA execution path dla `multilayer_convolution`: zoptymalizowane interpolation backends, pozostałe local-field RHS coverage poza uniform external field, per-layer uniform uniaxial/cubic anisotropy, global DMI i layer-local exchange oraz staged v2 integratory poza fixed-step Heun/RK4/RK23.

#### [MODIFY] native/backends/fdm/api, native/backends/fdm/core, native/backends/fdm/gpu/cuda/... (C/CUDA)
- Przepisać deskryptory setupu pod v2 logic.
- Dodać kopiowanie z Host to Device prekompilowanych struktur tensorów multi-level `kernels`.
- [x] Wdrożyć w CUDA pierwszy kernel mnożący `multiply_demag_tensor_kernel(...)` dla identity-grid slice.
- [x] Wdrożyć identity-grid `push_m` / `pull_h` boundary w `gpu/cuda/demag/multilayer_convolution.cu`.
- [x] Wykonać forward i inverse cuFFT dla wszystkich składowych `M_x/M_y/M_z` w natywnym identity-grid multilayer demag, zamiast transformować tylko komponent `x`.
- [x] Poprawić walidację identity transfer: `native_grid == convolution_grid`, a tensor-kernel `fft_grid` może być padded i musi tylko obejmować convolution grid.
- [x] Dodać routing `fullmag_fdm_backend_copy_layer_field_f64/f32(...)` przez native `Context` dla warstwowego `M`, `H_EX` i `H_DEMAG`, z odświeżeniem layer-local exchange przed kopią `H_EX`.
- [x] Dodać routing `FULLMAG_FDM_OBSERVABLE_H_DMI` przez `fullmag_fdm_backend_copy_layer_field_f64/f32(...)` oraz osobnego właściciela `gpu/cuda/interactions/multilayer_dmi.cu` dla staged global DMI field.
- [x] Dodać routing `FULLMAG_FDM_OBSERVABLE_H_ANI` przez `fullmag_fdm_backend_copy_layer_field_f64/f32(...)` oraz osobnego właściciela `gpu/cuda/interactions/multilayer_anisotropy.cu` dla staged uniaxial/cubic anisotropy field.
- [x] Dodać routing `FULLMAG_FDM_OBSERVABLE_H_EFF` przez `fullmag_fdm_backend_copy_layer_field_f64/f32(...)` oraz osobnego właściciela `gpu/cuda/interactions/multilayer_effective_field.cu` dla scratch-backed staged effective field z on-demand refresh `H_EX`/`H_DMI`/`H_ANI`.
- [x] Dodać routing `fullmag_fdm_backend_upload_layer_magnetization_f64/f32(...)` przez native `Context` oraz Rust wrapper `create_multilayer_v2`.
- [x] Dodać routing `fullmag_fdm_backend_refresh_multilayer_demag(...)` przez native `Context` i Rust FFI, bez przeciążania semantyki timestepu.
- [x] Dodać jawny `transfer_kind` do v2 layer descriptor i zachować go w staged native layer state, z routingiem `identity` oraz `push_pull`.
- [x] Zaimplementować pierwsze native CUDA `push_m` dla niezgodnych siatek przez volume-weighted overlap oraz `pull_h` przez trilinear interpolation na urządzeniu.
- [x] Zaimplementować staged memory transfer maps dla niezgodnych siatek, żeby CUDA refresh konsumował gotowe mapy zamiast liczyć overlap/trilinear neighborhood w kernelu.
- [x] Dodać osobnego właściciela `gpu/cuda/integrators/multilayer_heun.cu` dla v2 Heun timestepu z demag, uniform external field, per-layer uniform uniaxial/cubic anisotropy, global interfacial/bulk DMI i layer-local exchange, z per-layer `tmp`/`k1`/`k2` w `Context`.
- [x] Dodać wspólnego właściciela `gpu/cuda/integrators/multilayer_explicit_rk.cu` dla v2 fixed-step RK4/RK23 z demag, uniform external field, per-layer uniform uniaxial/cubic anisotropy, global interfacial/bulk DMI i layer-local exchange, z per-layer `k1`/`k2`/`k3`/`k4` w `Context`.
- [x] Dodać osobnego właściciela `gpu/cuda/interactions/multilayer_exchange.cu` dla uniform-A layer-local exchange na staged v2 layer native grids.
- [x] Dodać osobnego właściciela `gpu/cuda/interactions/multilayer_dmi.cu` dla obserwowalnego `H_DMI` na staged v2 layer native grids.
- [x] Dodać osobnego właściciela `gpu/cuda/interactions/multilayer_anisotropy.cu` dla obserwowalnego `H_ANI` na staged v2 layer native grids.
- [x] Dodać osobnego właściciela `gpu/cuda/interactions/multilayer_effective_field.cu` dla obserwowalnego `H_EFF` na staged v2 layer native grids.
- [ ] Zaimplementować zoptymalizowane sprzętowe/interpolacyjne `pull_h` ponad obecnym staged-map fallbackiem.

#### [MODIFY] crates/fullmag-runner/src/fdm/gpu/cuda/native.rs
- [x] Wypełnić wywołania API nowymi tablicami wskaźników z pamięci Rust do memory C używając structów v2 dla identity-grid native demag boundary.
- [x] Pobierać `H_DEMAG` per sub-layer z native v2 handle w CUDA-assisted path, gdy transfer_kind jest `identity`.
- [x] Pobierać tablicowe dane kroków per sub-layer zamiast pojedynczej tablicy grid dla pełnego native timestep path: `cuda_native_multilayer_single_grid` zachowuje natywne metadata kroku, ale scalar/live/relaxation `StepStats` buduje z warstwowych `StateObservables`.
- [x] Zachować layer-local DMI reporting w `cuda_native_multilayer_single_grid`: warstwowe konteksty są częścią native stacked planu, a `H_dmi` / per-object `e_dmi` są składane z tych kontekstów zamiast zerować się na globalnej granicy obserwowalnych.

#### [MODIFY] crates/fullmag-runner/src/fdm
- [x] Przenieść FDM CPU reference i multilayer reference pod `src/fdm/cpu/`, a CUDA-assisted multilayer i native CUDA wrapper pod `src/fdm/gpu/cuda/`, bez root-level shimów kompatybilności w runnerze.
- [x] Przenieść współdzieloną selekcję artifact field snapshots z lokalnych runnerów do `src/fdm/artifacts.rs`, żeby CPU, multilayer reference i CUDA-assisted multilayer nie duplikowały semantyki nazw pól.
- [x] Przenieść wspólne zapisywanie due field snapshots dla ścieżek multilayer do `src/fdm/schedules.rs`, żeby reference i CUDA-assisted multilayer używały jednego helpera schedule/artifact.
- [x] Przenieść wspólny builder `StepStats` dla ścieżek multilayer do `src/fdm/multilayer.rs`, żeby reference i CUDA-assisted multilayer nie duplikowały scalar trace semantics.

---

### 5. GUI, Session API & Manifesty Artefaktów

#### [MODIFY] crates/fullmag-runner/src/artifacts.rs
- [x] Skonfigurować artefakty zapisów, tak by obsługiwały podkatalogi per-layer.
- [x] Generować `manifest.json` po utworzeniu outputu śledzący kształt wektorowy, unikalne Id warstw oraz przesunięcia oryginalne `origin`.
- [x] Folder runnera wygląda teraz: `artifacts/fields/m/manifest.json` i dla każdej z warstw np. `layer-free/step_000000.json`. Pakowany format binarny pozostaje przyszłym krokiem, jeśli REST/data-plane będzie wymagał formatu innego niż JSON.

#### [MODIFY] apps/fullmag-api
- Dodać `Layer Registry` eksponowany poprzez endpoint JSON na wstępie połączenia websocket problemu.
- Stworzyć `GET /v1/runs/{run_id}/fields/{quantity}?layer={layer_id}&step=latest` dla serwowania porcjowanego, co optymalizuje proces wczytywania 3D na frontendzie.

#### [MODIFY] apps/web/lib/useSessionStream.ts & components/runs/RunControlRoom.tsx
- Zatrzymać uciążliwy nawyk pełnego śledzenia wielkich gridów wektorowych przez websocket; teraz jedynie strumieniować skalary, energie, torqui.
- Websocket odbiera ping o odświeżeniu najnowszego kroku co wyzwala asynchroniczny fetch na warstwę z REST.
- Dodać w interfejsie selekcję z Layer Dropdown.
- Dodać zakładkę **Plan / Diagnostics** na głównej stronie symulacji renderując uciążliwe metadane planowania.
