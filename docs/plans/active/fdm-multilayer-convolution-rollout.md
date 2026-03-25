# FDM Multi-Layer Convolution Demag: Szczegółowy Plan Architektoniczny

## Status implementacji

### Zaimplementowany pierwszy publiczny slice

Na dzień `2026-03-25` repo ma już działającą ścieżkę publiczną dla **multi-body FDM demag** w
trybie `multilayer_convolution`, ale tylko dla ograniczonego, uczciwie opisanego zakresu:

- wiele `Ferromagnet` w jednym `Problem`,
- body-local `Exchange()`,
- globalne `Demag()` pomiędzy ciałami,
- planowanie przez `BackendPlanIR::FdmMultilayer(...)`,
- wykonanie przez CPU reference runner oraz publiczny `cuda-assisted` runner,
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
- `Heun` + `double`,
- CPU reference oraz runner `cuda-assisted`, w którym local exchange per body idzie przez
  native CUDA FDM, a globalny cross-body demag pozostaje na istniejącym runtime konwolucyjnym.

Jeszcze **nie** są gotowe:

- pełny native multilayer demag path w ABI/CUDA C backendzie,
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
- Zadeklarować enum type the plan: `fullmag_fdm_plan_kind` (`FULLMAG_FDM_PLAN_UNIFORM_GRID`, `FULLMAG_FDM_PLAN_MULTILAYER_CONV`).
- Opisać `fullmag_fdm_layer_desc_v2` (posiadające i grid natywny, i wirtualny convolution_grid).
- Opisać `fullmag_fdm_multilayer_plan_desc_v2` przechowujące referencję na tablice `kernels` pre-kalkulowanych z Rust na hoscie.

#### [MODIFY] native/backends/fdm/src/... (C/CUDA)
- Przepisać deskryptory setupu pod v2 logic.
- Dodać kopiowanie z Host to Device prekompilowanych struktur tensorów multi-level `kernels`.
- Wdrożyć w CUDA generyczny kernel mnożący `multiply_demag_tensor_kernel(...)`.
- Zaimplementować fast memory `push_m` (scatter/gather z redukcjonalnymi operacjami 3D) i interpolacje sprzętową z CUDA (Texture memory l-erping dla `pull_h`).

#### [MODIFY] crates/fullmag-runner/src/native_fdm.rs
- Wypełnić wywołania API nowymi tablicami wskaźników z pamięci Rust do memory C używając structów v2.
- Pobierać tablicowe dane kroków per sub-layer zamiast pojedynczej tablicy grid.

---

### 5. GUI, Session API & Manifesty Artefaktów

#### [MODIFY] crates/fullmag-runner/src/artifacts.rs
- Skonfigurować artefakty zapisów, tak by obsługiwały podkatalogi per-layer.
- Generować `manifest.json` po utworzeniu outputu śledzący kształt wektorowy, unikalne Id warstw oraz przesunięcia oryginalne `origin`.
- Folder będzie wyglądał: `artifacts/fields/m/manifest.json` i dla każdej z warstw np. `layer-free/step-0000.npz`.

#### [MODIFY] apps/fullmag-api
- Dodać `Layer Registry` eksponowany poprzez endpoint JSON na wstępie połączenia websocket problemu.
- Stworzyć `GET /v1/runs/{run_id}/fields/{quantity}?layer={layer_id}&step=latest` dla serwowania porcjowanego, co optymalizuje proces wczytywania 3D na frontendzie.

#### [MODIFY] apps/web/lib/useSessionStream.ts & components/runs/RunControlRoom.tsx
- Zatrzymać uciążliwy nawyk pełnego śledzenia wielkich gridów wektorowych przez websocket; teraz jedynie strumieniować skalary, energie, torqui.
- Websocket odbiera ping o odświeżeniu najnowszego kroku co wyzwala asynchroniczny fetch na warstwę z REST.
- Dodać w interfejsie selekcję z Layer Dropdown.
- Dodać zakładkę **Plan / Diagnostics** na głównej stronie symulacji renderując uciążliwe metadane planowania.
