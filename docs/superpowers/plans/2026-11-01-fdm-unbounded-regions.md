# Plan implementacji: regiony FDM bez limitu 256 i heterogeniczne Ms/A/α na CUDA

> **Dla wykonawców:** wymagany sub-skill `superpowers:executing-plans` (wykonanie natywne
> w tej sesji). Kroki mają składnię checkboxów `- [ ]`.

**Cel:** usunąć limit 256/255 regionów w FDM CPU i CUDA, zastąpić tablicę par 256×256
współczynnikami wymiany na połączeniach komórek i pozwolić CUDA liczyć heterogeniczne
`Ms`, `Aex`, `alpha`.

**Architektura:** jeden builder w `fullmag-engine` zamienia (siatka, PBC, aktywność,
mapa regionów, właściciel regionu, A, typowane reguły par) na jawny operator wymiany
`Uniform | Faces{x_plus, y_plus, z_plus}`. CPU reference i runner CUDA konsumują ten sam
wynik. CUDA dostaje ściany przez nowe rozszerzenie `fullmag_fdm_plan_desc_v2` oraz
opcjonalne tablice `ms_field`/`alpha_field` z bazowego descriptora. LUT 256×256 znika.

**Stack:** Rust (`fullmag-ir`, `fullmag-plan`, `fullmag-engine`, `fullmag-runner`,
`fullmag-fdm-sys`), C++/CUDA (`backends/fdm`), Python (testy kontraktów), MyST (`docs/`).

**Spec:** [`docs/superpowers/specs/2026-11-01-fdm-unbounded-regions-architecture-design.md`](../specs/2026-11-01-fdm-unbounded-regions-architecture-design.md)
oraz [dowody](../specs/2026-11-01-fdm-unbounded-regions-architecture-evidence.md).

## Ograniczenia globalne

- Raporty i dokumenty po polsku; kod, identyfikatory, komentarze i commity po angielsku.
- **Zakaz lokalnej kompilacji testów jednostkowych** (`cargo test`, `just test`). Testy Rust i
  C++ piszemy dla CI (`rust-contracts`); lokalnie: build w kontenerze `backend` grupy Docker
  tego worktree, `just check-*-source`, testy Python (`pytest`), przebiegi headless.
- Build wyłącznie w grupie `fullmag-worktree-<id>` tego worktree (`just docker-dev "$PWD"`).
  Bez hostowego `cargo`/`cmake`/`nvcc`.
- Fizyka przed numeryką: nota 0104 i jej source-map aktualizowane w Task 1, przed zmianą kodu.
- Ścieżka jednorodna (`ExchangeOperator::Uniform`) nie może się zmienić: ten sam kernel
  laplasjanu co po PR #374.
- `Ms > 0` na aktywnej domenie to istniejący kontrakt (nota 0104 §2.3); A ≥ 0, α ≥ 0,
  wszystkie wartości skończone.
- Wymuszone GPU nie może po cichu przejść na CPU; każda niewspierana kombinacja daje jawny
  błąd z identyfikatorem `fdm_cuda_heterogeneous_material_unsupported:<owner>`.
- Reguła połączenia (nota 0104, spec §5):
  `A_f = 0` (brak połączenia, różni właściciele bez jawnej reguły, `Disabled`);
  `A_f = A_explicit` (`Explicit`); `A_f = s·H(A_i,A_j)` (`HarmonicScale`);
  `A_f = H(A_i,A_j)` (brak reguły); `H(a,b) = 0` gdy `a=0` lub `b=0`, `a` gdy `a=b`,
  inaczej `2ab/(a+b)`, liczone jako `2*a*(b/(a+b))`, żeby uniknąć overflow iloczynu.
- Pola i energia: `H_i = 2/(μ0 Ms_i) Σ_f A_f (m_j−m_i)/h_f²`,
  `E = V Σ_{f∈F+} A_f |m_j−m_i|²/h_f²`.

## Zakres v1 i bramki (decyzje z sekcji 10 specyfikacji, przyjęte rekomendacje)

CUDA z heterogenicznym materiałem (Ms, A lub α niejednorodne albo operator `Faces`) obsługuje:
wymianę, demag bez korekty brzegowej, Zeeman, anizotropię jedno- i trójosiową,
magnetosprężystość, interfacial/bulk DMI przy jednorodnym A, LLG wszystkimi integratorami,
fp64 i fp32.

Jawnie odrzucane w v1 (fail closed, wpis w capability matrix):

| Kombinacja z heterogenicznym materiałem | Identyfikator owner |
|---|---|
| korekta brzegowa T0/T1 (`boundary_correction != none`) | `boundary_correction` |
| szum termiczny (`temperature > 0`) | `thermal` |
| Zhang-Li, Slonczewski, SOT, transport GPU | `spin_torque` |
| DMI (interfacial/bulk/rotated) przy niejednorodnym A | `dmi_variable_exchange` |
| rotated interfacial DMI przy niejednorodnym Ms | `rotated_dmi_variable_ms` |
| `dind_field`/`dbulk_field` | bez zmian (istniejąca odmowa) |

FEM (zwarte mapowanie markerów) jest niezależnym podzadaniem bez wspólnych plików —
osobna sesja/PR (patrz Task 9).

## Review Focus

1. **Plan z > 256 regionami i bez reguł par** — oczekiwane: działa, wynik identyczny jak dla
   tych samych komórek z jedną etykietą (brak sztucznego odsprzęgania). Test: Task 3
   `uniform_material_many_regions_collapses_to_uniform`.
2. **PBC z osią długości 1 i 2** — oczekiwane: oś 1 nie wnosi wymiany; oś 2 z PBC ma dwa
   niezależne połączenia. Test: Task 3 `periodic_axis_lengths_one_and_two`.
3. **Stary zapisany plan z krotkami `(i, j, A)`** — oczekiwane: czyta się jako `Explicit(A)`.
   Test: Task 2 `legacy_tuple_pairs_deserialize_as_explicit`.
4. **Wiele ciał w adapterze multilayer (> 255 ciał)** — oczekiwane: brak wymiany między
   ciałami bez generowania O(L²) par. Test: Task 3 `distinct_owners_are_decoupled_without_rules`
   + Task 7 test adaptera.
5. **Wymuszone CUDA z heterogenicznym Ms i szumem termicznym** — oczekiwane: jawny błąd,
   bez fallbacku. Test: Task 6 `cuda_rejects_heterogeneous_material_with_thermal_noise`.

---

### Task 1: Kontrakt fizyczny i dokumentacja

**Files:**
- Modify: `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.md`
  (§2.3, §3.1, §4.2–4.5, §5, §6, §7, §9)
- Modify: `docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.source-map.json`
- Modify: `docs/specs/material-assignment-and-spatial-fields-v0.md` (status realizacji FDM)
- Modify: `docs/specs/capability-matrix-v0.md` (wiersze pól per komórka i regionów obiektu)

- [ ] **Step 1:** w §3.1 noty 0104 zastąpić „explicit exchange pair table” opisem operatora
  połączeń: reguła `A_f` z `H(a,b)` (labelled `{math}`), kontrakt indeksowania
  `x_plus/y_plus/z_plus` (ujemna ściana czytana z sąsiada, wrap PBC, oś długości 1 bez
  wymiany, oś 2 z dwoma połączeniami, nieaktywne komórki), energia po `F+`, brak limitu
  liczby regionów, odsprzęganie właścicieli bez generowania par, energia regionalna
  dzielona po połowie.
- [ ] **Step 2:** dodać sekcję realizacji FDM CPU / FDM CUDA (tryb `Uniform | Faces`,
  rozszerzenie ABI, tablice `ms_field`/`alpha_field`, bramki v1 z tabeli wyżej) i
  zaktualizować macierz wsparcia (§4.4) dla czterech realizacji.
- [ ] **Step 3:** zaktualizować source-map o nowe kotwice (`path + symbol`) dla buildera,
  kerneli i walidacji, które powstaną w Task 3–6 (symbole z bloków Interfaces niżej).
- [ ] **Step 4:** walidacja:
  `python -B .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0104-material-regions-parameter-fields-and-interface-couplings.source-map.json --repo-root .`
  Oczekiwane: exit 0. (Kotwice symboli dodanych w kolejnych taskach walidujemy ponownie po
  Task 6.)
- [ ] **Step 5:** commit `Specify unbounded FDM region exchange operator in note 0104`.

### Task 2: Typowane reguły par w IR i usunięcie bramki 255

**Files:**
- Modify: `crates/fullmag-ir/src/plan.rs` (`FdmPlanIR.inter_region_exchange`, nowe typy, testy)
- Modify: `crates/fullmag-ir/src/execution.rs` (`MAX_FDM_REGION_IDS`, `validate_fdm_region_lut_indices`)
- Modify: `crates/fullmag-ir/src/mesh_hints.rs:998` (legenda multilayer 1..=255)
- Modify: `crates/fullmag-plan/src/fdm.rs` (`materialize_object_region_mask`, `materialize_region_exchange_couplings`, testy 3770–3815)
- Modify: `crates/fullmag-runner/src/fdm/mod.rs:214`
- Modify: wszystkie literały `inter_region_exchange: vec![]` i testy krotek wymienione w
  raporcie przeglądu (runner, cli, ir tests, plan tests)

**Interfaces:**
- Produces (`fullmag_ir`):
  ```rust
  #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
  #[serde(tag = "mode", rename_all = "snake_case")]
  pub enum FdmExchangePairModeIR { HarmonicScale { scale: f64 }, Explicit { exchange_stiffness: f64 }, Disabled }
  #[derive(Debug, Clone, Copy, Serialize, PartialEq)]
  pub struct FdmExchangePairRuleIR { pub region_i: u32, pub region_j: u32, pub mode: FdmExchangePairModeIR }
  // Deserialize: struct form or legacy tuple [i, j, a] -> Explicit { exchange_stiffness: a }
  pub fn validate_fdm_exchange_pair_rules(rules: &[FdmExchangePairRuleIR], region_mask: &[u32]) -> Result<(), String>
  ```
  `FdmPlanIR.inter_region_exchange: Vec<FdmExchangePairRuleIR>` (nazwa pola bez zmian).
- Usuwa: `MAX_FDM_REGION_IDS`, `validate_fdm_region_lut_indices`.

- [ ] **Step 1: testy** w `plan.rs`:
  `legacy_tuple_pairs_deserialize_as_explicit` (`[[1,2,4e-12]]` → `Explicit{4e-12}`),
  `pair_rules_reject_self_pair_negative_and_nonfinite` (i==j, scale<0, NaN → Err),
  `pair_rules_reject_conflicting_duplicates` ((1,2) i (2,1) z różnymi trybami → Err; identyczne
  duplikaty po normalizacji → Ok), `region_mask_accepts_ids_above_255` (mask `[0, 256, 1000]`
  przechodzi `FdmGridCertificateIR::validate_against_masks` z legendą 1..=1000).
  W `fdm.rs`: zamienić `fdm_region_mask_rejects_256_active_regions_before_sampling` na
  `fdm_region_mask_accepts_1000_regions`.
- [ ] **Step 2:** implementacja typów i walidatora (normalizacja kolejności `(min,max)`,
  `region_i != region_j`, oba ≠ 0, ≠ `u32::MAX`, skończone, `scale ≥ 0`, `A ≥ 0`).
- [ ] **Step 3:** planer: usunąć bramkę 1004–1011 i `debug_assert` 1040;
  `materialize_region_exchange_couplings` zwraca `Vec<FdmExchangePairRuleIR>`:
  `HarmonicMean{scale}` → `HarmonicScale{scale}` (pomijany gdy scale == 1),
  `Explicit` → `Explicit`, `Disabled` → `Disabled`. Parametr `material_exchange` znika.
- [ ] **Step 4:** runner `fdm/mod.rs:214` → `validate_fdm_exchange_pair_rules`; mesh_hints
  bez górnego limitu 255 (tylko `numeric_id ≥ 1` i ciągłość).
- [ ] **Step 5:** `just check-api-source` i `just check-cli-source` (kompilacja źródeł bez
  testów). Oczekiwane: sukces. Commit `Type FDM exchange pair rules and drop the 255-region gate`.

### Task 3: Builder operatora wymiany w `fullmag-engine`

**Files:**
- Create: `crates/fullmag-engine/src/fdm/shared/exchange_operator.rs`
- Modify: `crates/fullmag-engine/src/fdm/shared/mod.rs` (`pub mod exchange_operator;`)

**Interfaces:**
- Produces:
  ```rust
  pub enum ExchangePairMode { HarmonicScale(f64), Explicit(f64), Disabled }
  pub struct ExchangePairRule { pub region_i: u32, pub region_j: u32, pub mode: ExchangePairMode }
  pub struct ExchangeFaces { pub x_plus: Vec<f64>, pub y_plus: Vec<f64>, pub z_plus: Vec<f64> }
  pub enum ExchangeOperator { Uniform, Faces(ExchangeFaces) }
  pub struct ExchangeOperatorInputs<'a> {
      pub grid: GridShape, pub periodic: [bool; 3], pub active: Option<&'a [bool]>,
      pub region_mask: Option<&'a [u32]>, pub region_owner: Option<&'a [u32]>,
      pub exchange_stiffness: f64, pub a_field: Option<&'a [f64]>, pub rules: &'a [ExchangePairRule],
  }
  pub fn harmonic_exchange(a: f64, b: f64) -> f64;
  pub fn build_exchange_operator(inputs: &ExchangeOperatorInputs) -> Result<ExchangeOperator, String>;
  ```
  `region_owner[r]` = indeks właściciela regionu `r` (indeks 0 = region bez nazwy);
  `None` = jeden właściciel. `Uniform` wtedy i tylko wtedy, gdy każde rzeczywiste
  połączenie dwóch aktywnych komórek ma `A_f == exchange_stiffness` (porównanie dokładne).

- [ ] **Step 1: testy** (`#[cfg(test)] mod tests`, niezależny oracle — wartości ręczne):
  `harmonic_exchange_cases` (`(0,a)=0`, `(a,a)=a` bitowo, `(1e-11,3e-11)=1.5e-11`),
  `two_cells_rules` (2×1×1, regiony 1|2, A=1e-11|3e-11: brak reguły → 1.5e-11,
  `HarmonicScale(0.5)` → 0.75e-11, `Explicit(2e-11)` → 2e-11, `Disabled` → 0),
  `uniform_material_many_regions_collapses_to_uniform` (1000 regionów, A stałe → `Uniform`),
  `distinct_owners_are_decoupled_without_rules` (owner 0|1 → ściana 0, `Faces`),
  `inactive_neighbor_has_no_connection`, `periodic_axis_lengths_one_and_two`
  (nx=1 PBC → x_plus=0; nx=2 PBC → x_plus[0] i x_plus[1] oba = H),
  `rule_without_contact_is_ignored` (reguła dla pary regionów bez wspólnej ściany nie zmienia
  wyniku; poprawność samej reguły sprawdza Task 2), `length_mismatch_is_error`.
- [ ] **Step 2:** implementacja: rozwiązanie reguł przez `HashMap<(u32,u32), ExchangePairMode>`
  (klucz `(min,max)`), jedna pętla po komórkach i trzech osiach, potem test jednorodności.
- [ ] **Step 3:** `just check-api-source` (kompiluje `fullmag-engine` bez testów). Commit
  `Add shared FDM exchange operator builder`.

### Task 4: CPU reference na operatorze ścian

**Files:**
- Modify: `crates/fullmag-engine/src/fdm/shared/problem.rs` (pole `exchange_faces: Option<Arc<ExchangeFaces>>`, `with_exchange_operator`, porównania/klonowanie ~869/892)
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields/exchange.rs` (`cell_exchange_field`)
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields/energy.rs` (`exchange_energy_from_vectors`)
- Modify: `crates/fullmag-engine/src/fdm/cpu/fields.rs` (`soa_fast_path_rejection_reason`: `"exchange_faces"`)
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs` (`materialize_reference_problem`)
- Create: `crates/fullmag-runner/src/fdm/exchange_operator.rs` — konwersja planu
- Modify: `crates/fullmag-plan/src/validate.rs` (`region_coupling_is_executable_for_backend`: CPU FDM dopuszczony)

**Interfaces:**
- Produces (`fullmag_runner::fdm::exchange_operator`):
  ```rust
  pub fn build_plan_exchange_operator(plan: &fullmag_ir::FdmPlanIR) -> Result<ExchangeOperator, RunError>;
  pub fn region_owner_from_legend(plan: &fullmag_ir::FdmPlanIR) -> Option<Vec<u32>>;
  ```
  Właściciel z `grid_certificate.region_legend[*].object_id` (kolejność pierwszego
  wystąpienia = indeks); region 0 dziedziczy właściciela pierwszego obiektu z
  `grid_certificate.object_ids`.

- [ ] **Step 1: testy:** w engine `faces_field_matches_harmonic_aos_without_rules`
  (losowe A per komórka, brak reguł: pole przez `Faces` = dotychczasowe AoS z dokładnością
  1e-15 rel), `faces_energy_is_negative_gradient` (pochodna numeryczna energii vs pole,
  rel 1e-6), `ms_jump_with_uniform_m_gives_zero_exchange`; w runnerze
  `cpu_reference_honors_disabled_pair` (dwa regiony, `Disabled` → zerowa wymiana przez
  interfejs); w planerze `fdm_region_region_explicit_exchange_executes_on_cpu_reference`
  (zastępuje test blokady).
- [ ] **Step 2:** implementacja: `cell_exchange_field` gdy `exchange_faces` jest `Some`
  używa `x_plus[i]`/`x_plus[xm]` itd. z prefaktorem `2/(μ0 Ms_i h²)`; energia po
  `x_plus/y_plus/z_plus` (także z PBC). Gdy operator `Uniform` — bez zmian.
- [ ] **Step 3:** `just check-api-source`; build w kontenerze `backend`
  (`just docker-dev "$PWD"`), przebieg headless CPU przypadku A (Task 8). Commit
  `Use the shared exchange operator in the FDM CPU reference`.

### Task 5: ABI natywne: rozszerzenie ścian i odblokowanie Ms/α

**Files:**
- Modify: `native/include/fullmag_fdm.h` (`fullmag_fdm_plan_desc_v2` tail; usunięcie `FULLMAG_FDM_MAX_EXCHANGE_REGIONS`, `FULLMAG_FDM_MAX_REGION_ID`)
- Modify: `native/include/fullmag_fdm_plan_desc_v2_layout.def` (3 pola EXTENSION)
- Modify: `backends/fdm/api/plan_ingestion_v2.cpp` (rozmiary 1384/1400/nowy)
- Modify: `backends/fdm/api/c_api.cpp` (`fullmag_fdm_backend_create_impl`: walidacja, usunięcie budowy LUT 1565–1628 i limitu 1416–1426, odblokowanie `ms_field`/`a_field`/`alpha_field` z walidacją długości i wartości; `exchange_lut`/`exchange_pairs` ≠ null → `fdm_exchange_lut_retired`)
- Modify: `crates/fullmag-fdm-sys/src/lib.rs`, `crates/fullmag-fdm-sys/build.rs` (liczba pól EXTENSION 2→5), `crates/fullmag-fdm-sys/tests/plan_desc_layout.rs`
- Modify: `backends/fdm/tests/plan_desc_sentinel_contract.cpp`, `backends/fdm/tests/region_owned_abi_contract.cpp`

**Interfaces:**
- Produces (C ABI, tail `fullmag_fdm_plan_desc_v2`, po `dmi_D_rotated_interfacial`):
  ```c
  uint32_t exchange_operator_mode;   /* FULLMAG_FDM_EXCHANGE_OPERATOR_UNIFORM=0, _FACES=1 */
  uint32_t reserved1;
  const double *exchange_face_x_plus; /* f64[cell_count] when FACES */
  const double *exchange_face_y_plus;
  const double *exchange_face_z_plus;
  uint64_t exchange_face_len;         /* == cell_count when FACES, else 0 */
  ```
  Akceptowane `struct_size`: 1384, 1400 i nowy pełny rozmiar. Brak tail = `UNIFORM`.

- [ ] **Step 1: testy kontraktowe** (C++ string/offset): offsety nowych pól w
  `plan_desc_sentinel_contract.cpp`; w `region_owned_abi_contract.cpp` zamienić
  `region_lut_capacity_is_explicit_and_fail_closed` na `region_ids_are_unbounded_and_lut_is_retired`
  oraz `native_backend_fails_fast_for_unimplemented_cellwise_material_fields` na
  `native_backend_validates_cellwise_ms_and_alpha` (odrzuca tylko dind/dbulk i złe długości).
- [ ] **Step 2:** implementacja ABI + ingestion + walidacja (`face_len == cell_count`,
  wartości skończone ≥ 0; `ms_field` > 0 na aktywnych, `alpha_field` ≥ 0).
- [ ] **Step 3:** commit razem z Task 6 (zmiana ABI bez konsumentów łamie build).

### Task 6: Kernele CUDA i runner

**Files:**
- Modify: `backends/fdm/include/context.hpp` (usunięcie `exchange_lut*`; dodanie `exchange_faces_xp/yp/zp`, `has_exchange_faces`, `ms_field`, `alpha_field`)
- Modify: `backends/fdm/gpu/cuda/runtime/context.cu` (preflight pamięci, alloc/free/upload; `context_upload_exchange_faces`, `context_upload_material_fields`)
- Modify: `backends/fdm/gpu/cuda/runtime/workspace_dependency_identity.cpp` (hash ścian i pól)
- Modify: `backends/fdm/gpu/cuda/interactions/exchange_fp64.cu`, `exchange_fp32.cu` (kernel ścian; uniform bez zmian)
- Modify: `backends/fdm/gpu/cuda/interactions/exchange_t0_fp64.cu`, `exchange_t1_fp64.cu` (usunięcie parametrów LUT; zawsze A skalarne)
- Modify: `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` (energia wymiany po ścianach; demag/external z `ms_field`)
- Modify: `backends/fdm/gpu/cuda/interactions/demag_fp64.cu`, `demag_fp32.cu` (pack, fused field/RHS, anisotropy kernels: `ms_field`, `alpha_field`)
- Modify: `backends/fdm/gpu/cuda/interactions/energy_density_fp64.cu` (`ms_field`)
- Modify: `backends/fdm/gpu/cuda/integrators/llg_{fp64,fp32,dp45_fp64,dp45_fp32,rk23_fp64,rk23_fp32,rk4_fp64,rk4_fp32,abm3_fp64,abm3_fp32}.cu` (`alpha_field` do `llg_rhs_*`)
- Modify: `backends/fdm/tests/fdm_gpu_host_transfer_callsites_v1.json` (regeneracja: `tests/generate_fdm_gpu_transfer_manifest.py`)
- Modify: `backends/fdm/tests/thermal_brown_contract.cpp` (jeżeli string się zmieni)
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` (usunięcie odmowy 1441–1448, `build_region_exchange_pairs`; budowa operatora przez `build_plan_exchange_operator`; tail v2; bramki v1)
- Modify: `crates/fullmag-runner/src/fdm/gpu/cuda/multilayer.rs` (usunięcie `disabled_inter_body_exchange_pairs`; legenda daje właścicieli)
- Modify: `scripts/benchmarks/cuda_exchange_region_bench.cu` (warianty faces/cellA/material-table)

**Interfaces:**
- Consumes: `build_plan_exchange_operator` (Task 4), ABI z Task 5.
- Produces: `fn ensure_cuda_heterogeneous_material_supported(plan: &FdmPlanIR, operator: &ExchangeOperator) -> Result<(), RunError>` w `native.rs`.
- Kernel ścian: ten sam kształt co obecna ścieżka LUT,
  `A_xp = faces_xp[idx]`, `A_xm = faces_xp[xm]` (itd.), `h = inv_mu0_ms_i * Σ A (m_n − m_c) inv_d2`,
  `inv_mu0_ms_i = ms_field ? 2/(μ0 ms_field[idx]) : inv_mu0_ms`.
- RHS: `alpha_i = alpha_field ? alpha_field[idx] : alpha`; `gamma_bar_i = alpha_field ? gamma/(1+alpha_i²) : gamma_bar`.

- [ ] **Step 1: testy:** runner `cuda_rejects_heterogeneous_material_with_thermal_noise`,
  `cuda_rejects_heterogeneous_exchange_with_dmi`, `cuda_accepts_heterogeneous_ms_alpha_core`
  (sprawdzają tylko `ensure_cuda_heterogeneous_material_supported`), `native_stacked_plan_has_no_disabled_pairs`.
- [ ] **Step 2:** implementacja kerneli i kontekstu (wzorzec `ku1_field`: wskaźnik `nullptr` = skalar,
  upload przez `upload_f64_array`, zwolnienie w `context_free_device`).
- [ ] **Step 3:** build w kontenerze `backend` grupy; oczekiwane: pakiet zbudowany i zweryfikowany.
- [ ] **Step 4:** commit Task 5+6 `Replace the CUDA exchange LUT with face coefficients and accept cellwise Ms and alpha`.

### Task 7: Benchmark wariantów reprezentacji

**Files:**
- Modify: `scripts/benchmarks/cuda_exchange_region_bench.cu`
- Create: `docs/audits/2026-11-01-fdm-unbounded-regions-benchmark.md` (po polsku)

- [ ] **Step 1:** warianty: uniform, faces (fp64/fp32), cellA (A per komórka + harmoniczna
  w kernelu), material-table (u16 material id + tablica A/Ms w pamięci globalnej);
  2D 1024², 3D 256²×64 i 128³; 1/256/1000 regionów, 2 i 8 materiałów, rozkład skupiony
  i przemieszany. CUDA events, 20 warm-up, mediana z 200.
- [ ] **Step 2:** kompilacja `nvcc` i uruchomienie w kontenerze `backend` grupy; wyniki
  w raporcie z commitem i GPU.
- [ ] **Step 3:** decyzja: faces pozostaje, jeżeli żaden wariant nie daje > 10% pełnego
  kroku lub istotnej oszczędności VRAM; inaczej zapisać follow-up. Commit raportu.

### Task 8: Przebiegi headless, parytet i narzut

**Files:**
- Create: `scripts/benchmarks/fdm_regions_parity_case.py` (scenariusze A/B/C przez `fm.study`)
- Create: `scripts/benchmarks/run_fdm_regions_parity.py` (uruchamia `fullmag-bin <script> --backend fdm --headless --json --output-dir <dir>` dla CPU, CUDA fp64, CUDA fp32; porównuje)
- Modify: `docs/audits/2026-11-01-fdm-unbounded-regions-benchmark.md`

- [ ] **Step 1:** scenariusze: (A) dwa materiały (Ms 800k/1.2M, A 13e-12/20e-12, α 0.02/0.1)
  z regułą `explicit` i wariantem `harmonic_mean scale=0.5`; (B) 1000 ziaren Voronoi z
  Ms/A/α ±10% (ostre przejście); (C) jednorodny z regionami i bez.
- [ ] **Step 2:** porównania CPU vs CUDA fp64: max|Δm|, energie składników, moment; tolerancje
  z istniejących bramek parytetu FDM; (C) hash `m_final` CUDA = master c416e1b70.
- [ ] **Step 3:** czas kroku (z wyłączonym podglądem: `FULLMAG_DISABLE_PREVIEW_3D=1`,
  `FULLMAG_DISABLE_PREVIEW_2D=1`, `FULLMAG_DISABLE_LIVE_MAGNETIZATION=1`), tabela narzutu.
- [ ] **Step 4:** aktualizacja capability matrix i noty 0104 statusami z dowodami; walidator
  dokumentacji. Commit.

### Task 9: FEM — zwarte mapowanie markerów (osobna sesja)

Niezależne od Task 1–8 (inne pliki). Zakres: kanoniczny marker `u32` → zwarty dodatni
atrybut MFEM + mapa odwrotna, osobno dla domen i granic, w `mfem_mesh_builder.cpp`,
`mesh_space_preparation.cpp::verify_marker_map`, `gpu/cuda/demag_poisson/operators.cpp`,
`demag_poisson_boundary.cpp`, `poisson_airbox_shared_domain.cpp`, `floquet_airbox_operator.cpp`,
`steady_transport_c_api.cpp` (`import_mesh`, `boundary_marker()` — alokacja do ~1e9 elementów)
i `steady_transport.cpp`; kolizja granicy 0→1; fingerprinty atrybutów. Proponowane jako
osobna sesja z własnym PR.

### Task 10: Integracja

- [ ] `superpowers:requesting-code-review` na całym branchu; poprawki.
- [ ] push, PR do `master`, CI `rust-contracts`/`python-contracts`, merge zgodnie z
  `finishing-a-development-branch` i AGENTS.md; aktualizacja rejestru.
