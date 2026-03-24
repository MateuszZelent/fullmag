# Szczegółowy plan wdrożenia oddziaływań dipolowych (demag) — FDM CPU/CUDA, aktywne maski i droga do geometrii zakrzywionych

- Status: **active**
- Owners: Fullmag core
- Last updated: 2026-03-24
- Scope: `FDM only`
- Główne powiązane physics notes:
  - `docs/physics/0400-fdm-exchange-demag-zeeman.md`
  - `docs/physics/0420-fdm-dipolar-demag-foundations.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md`
  - `docs/physics/0500-fdm-relaxation-algorithms.md`
- Główne powiązane specs:
  - `docs/specs/fullmag-application-architecture-v2.md`
  - `docs/specs/problem-ir-v0.md`
  - `docs/specs/capability-matrix-v0.md`
  - `docs/specs/material-assignment-and-spatial-fields-v0.md`
  - `docs/specs/output-naming-policy-v0.md`
  - `docs/specs/visualization-quantities-v1.md`
- Powiązane plany:
  - `docs/plans/active/phase-2-gpu-fdm-calibrated-rollout.md`
  - `docs/plans/active/phase-2-gpu-fdm-implementation-playbook.md`
  - `docs/plans/active/implementation-status-and-next-plans-2026-03-23.md`

---

## 1. Cel dokumentu

Ten dokument **nie** jest już planem “dodać demag od zera”.
Repo jest dalej niż wtedy, gdy powstawały pierwsze notatki:

- `Demag()` istnieje w Python API,
- `EnergyTermIR::Demag` istnieje w IR,
- CPU reference FDM liczy `Exchange + Demag + Zeeman`,
- CUDA FDM ma działający spectral demag dla obecnego wąskiego slice’u,
- quantities i artifacts zawierają już `H_demag`, `E_demag`, `H_eff`, `E_total`.

W związku z tym ten plan ma teraz inny cel:

1. uczciwie opisać **co już działa**,
2. nazwać **co nadal jest tylko bootstrapem**,
3. rozpisać drogę do **kanonicznej implementacji dipolar FDM** zgodnej z `0420`,
4. przygotować FDM pod **geometrie zakrzywione** przez voxelization + active mask,
5. uzupełnić wcześniej wdrożone oddziaływania tak, aby `Exchange`, `Demag`, `Zeeman`,
   artifacts, planner i UI mówiły tym samym językiem.

---

## 2. Wnioski z analizy physics docs

### 2.1 Najważniejsze wnioski z `0400`

`0400-fdm-exchange-demag-zeeman.md` zamraża już wspólny kontrakt dla trzech najważniejszych
wkładów do `H_eff`:

- `Exchange` jest lokalnym operatorem różnicowym,
- `Demag` jest operatorem nielokalnym wynikającym z magnetostatyki,
- `Zeeman` jest zewnętrznym polem `H_ext` w `A/m`, a obecne `B` w API jest tylko warstwą wejściową.

To oznacza, że dalszy plan dla demag **musi** jednocześnie pilnować:

- poprawności jednostek,
- poprawnego nazewnictwa outputów,
- spójności z quantity-driven UI,
- spójności z późniejszym rozszerzaniem `H_eff`.

### 2.2 Najważniejsze wnioski z `0420`

`0420-fdm-dipolar-demag-foundations.md` ustawia kanoniczny fizyczny cel FDM:

- dipolar self-interaction ma być rozumiane jako **cell-averaged tensor convolution**,
- poprawna produkcyjna ścieżka FDM to **FFT-accelerated demag operator**,
- near-field nie powinien być traktowany jak suma point dipoles,
- docelowy production-grade kernel powinien iść przez **Newell-type cell-averaged coefficients**,
- aktywna domena magnetyczna ma być jawnie modelowana przez **active mask** i później przez richer voxelization metadata.

To jest bardzo ważne: obecny kod jest już wykonawczy, ale **nie domyka jeszcze całego kanonicznego kontraktu z `0420`**.

### 2.3 Najważniejsze wnioski z `0430`

`0430-fem-dipolar-demag-mfem-gpu-foundations.md` potwierdza dwie rzeczy:

- FDM i FEM mają wspólną fizykę dipolar, ale różne realization layers,
- jeśli chcemy uczciwie obsługiwać **zakrzywione granice i skomplikowane interfejsy**, to FDM musi robić to przez voxelization + maski, a dokładna geometria długoterminowo i tak będzie domeną FEM.

Wniosek praktyczny:

- **tak**, już teraz warto projektować FDM pod zakrzywione 3D struktury,
- **nie**, nie wolno udawać, że FDM da “dokładnie gładką geometrię”,
- poprawna strategia na teraz to:
  - najpierw `Box`,
  - potem `Cylinder` przez voxelizer i `active_mask`,
  - potem imported geometry na tej samej architekturze lowering,
  - a precyzyjne curved-boundary physics pozostawić jako motywację dla FEM.

### 2.4 Najważniejsze wnioski z `0480` i `0500`

Dokumenty o integratorach i relaksacji mówią jasno:

- demag jest najdroższym wkładem do `H_eff`,
- reuse FFT plans/workspaces i reuse pól pomiędzy etapami integratora to nie optymalizacja “na potem”, tylko część architektury,
- wybór integratora i relaksacji musi uwzględniać koszt demag.

Wniosek:

- plan demag nie może kończyć się na “liczy poprawne pole”,
- musi też zawierać:
  - caching FFT,
  - reuse w Heunie,
  - później kompatybilność z RK/adaptive/relaxation paths.

---

## 3. Stan bieżący — uczciwy audyt

### 3.1 Co jest już public-executable

Na dziś repo ma rzeczywiście działający wąski FDM slice:

- Python API: `Exchange`, `Demag`, `Zeeman`
- IR/planner: plan FDM dla `Box`
- CPU reference engine: `Exchange + Demag + Zeeman + LLG(Heun)`
- CUDA backend: spectral demag + exchange + external field dla tego samego slice’u
- outputs:
  - `m`
  - `H_ex`
  - `H_demag`
  - `H_ext`
  - `H_eff`
  - `E_ex`
  - `E_demag`
  - `E_ext`
  - `E_total`

### 3.2 Co jest jeszcze bootstrapem, nie docelową architekturą

Mimo działającego execution path, kilka rzeczy nadal jest tylko bootstrapem:

1. **Demag FDM jest już wyrównane do jednego realization level**:
   - CPU reference używa kanonicznego `Newell tensor FFT`,
   - native CUDA używa tego samego operatora przez upload precomputed Newell spectra i cuFFT tensor convolution.
2. **Geometria wykonawcza nadal praktycznie kończy się na `Box`**.
3. **Aktywna maska magnetyczna nie jest jeszcze centralnym elementem planu FDM**.
4. **Krzywizny i geometrie zakrzywione nie są jeszcze uczciwie realizowane**.
5. **Walidacja demag jest nadal za cienka** względem ambicji physics-first.
6. **Exchange** nie jest jeszcze domknięty pod heterogeniczne `A_f` na ścianach między komórkami.
7. **Zeeman** ma nadal przejściowy seam `B` w API vs `H_ext` w solverze/provenance.
8. **CUDA step diagnostics są już device-side**, ale nadal brakuje kolejnych warstw optymalizacji:
   benchmarków MuMax-class i dalszych redukcji bez zbędnych synchronizacji.

### 3.3 Najważniejsze otwarte luki

#### Luka A — rozjazd “implemented” vs “canonical”

Obecna implementacja jest wystarczająca jako executable baseline, ale nie odpowiada jeszcze w pełni temu,
co physics notes zamrażają jako kontrakt produkcyjny.

#### Luka B — brak aktywnej maski i voxelized domain semantics

Bez `active_mask` nie da się uczciwie:

- uruchomić `Cylinder`,
- przejść do imported geometry,
- rozszerzyć exchange o poprawne free-surface semantics,
- pokazać w UI prawdziwej domeny magnetycznej zamiast całego prostopadłościanu.

#### Luka C — brak pełnej walidacji demag

Samo “daje niezerowe `E_demag`” jest za słabe.
Potrzebujemy:

- testów czynników demagnetyzacyjnych,
- testów energii,
- tiny-grid reference checks,
- CPU vs CUDA parity,
- regresji dla artifacts i quantities.

#### Luka D — CUDA jest działające, ale nie domknięte jako operator klasy produkcyjnej

CUDA path istnieje i ma już:

- Newell tensor FFT zgodny semantycznie z CPU reference,
- masked-domain execution,
- device-side redukcje energii i norm,
- `nz=1` thin-film fast path przez 2D FFT,

ale nadal wymaga:

- pełnej kwalifikacji,
- lepszych testów dokładności,
- uczytelnienia provenance,
- dalszego ograniczania synchronizacji i specjalizowanych fast pathów.

---

## 4. Zasady architektoniczne zamrażane przez ten plan

### 4.1 Demag to osobna klasa operatora

`Demag()` pozostaje energy termem w Python API i semantyce problemu, ale po stronie numerics
musi być traktowane jako **osobny operator nielokalny**, nie jako kolejny “lokalny wkład do `H_eff`”.

To ma konsekwencje dla:

- plannerów,
- provenance,
- artifacts,
- quantity registry,
- wyboru algorytmów relaksacji i integracji.

### 4.2 Zakrzywione geometrie w FDM tak, ale tylko przez voxelization + active mask

Nie implementujemy “gładkiego cylindra” bezpośrednio w solverze FDM.
Poprawna droga brzmi:

1. analityczna geometria (`Cylinder`, później inne prymitywy),
2. planner-owned voxelization,
3. `active_mask` + ewentualnie później `occupancy_fraction`,
4. FDM operator działa na całym padded boxie, ale fizyka materialna tylko na aktywnych komórkach.

### 4.3 FDM ma dwa poziomy demag

Ten plan rozróżnia dwa poziomy:

- **Level 1: executable spectral demag**  
  działa już dziś i jest legalnym baseline’em,
- **Level 2: canonical production demag**  
  docelowo cell-averaged/Newell + FFT acceleration.

Nie wolno mieszać tych poziomów w dokumentacji ani w claims.

### 4.4 Exchange, Demag i Zeeman muszą być domknięte razem

Dipolar plan nie może abstrahować od wcześniej wdrożonych oddziaływań:

- `Exchange` musi dostać poprawne boundary/mask semantics,
- `Zeeman` musi dostać czysty unit contract,
- `H_eff` musi mieć stabilny registry i decomposition.

---

## 5. Docelowe milestone’y

### M1 — Qualified baseline

Cel:

- zachować istniejący executable slice,
- zrobić go szybszym, lepiej zwalidowanym i lepiej opisanym.

Zakres:

- CPU spectral demag hardened,
- CUDA spectral demag hardened,
- lepsze testy,
- provenance,
- bez nowych geometrii.

### M2 — Masked FDM geometry

Cel:

- wprowadzić aktywną maskę,
- uruchomić pierwszą zakrzywioną geometrię (`Cylinder`) w FDM,
- zachować tę samą architekturę lowering dla przyszłych imported geometries.

Zakres:

- voxelizer,
- `active_mask`,
- boundary-aware exchange,
- artifacts i UI dla maski.

### M3 — Canonical dipolar operator

Cel:

- doprowadzić FDM demag do zgodności z kanonicznym kontraktem `0420`.

Zakres:

- Newell-type kernel generation,
- FFT of tensor kernel cached at init,
- porównanie z obecnym spectral path,
- decyzja o production default.

### M4 — Production-quality FDM dipolar stack

Cel:

- mieć FDM, który jest uczciwie gotowy pod większe benchmarki, comparison studies i dalsze rozszerzenia fizyki.

Zakres:

- qualified single precision,
- richer relaxation/integrators aware of demag cost,
- richer geometry support,
- stabilny comparison harness.

---

## 6. Szczegółowy plan prac

## WP0 — Alignment docs/specs/code przed dalszą numeriką

### Cel

Zanim dołożymy kolejne warstwy demag, trzeba wyczyścić semantyczny drift.

### Zadania

1. Zaktualizować ten plan tak, by odzwierciedlał realny stan repo.
2. Uzgodnić w docs trzy poziomy statusu demag:
   - executable today,
   - canonical target,
   - deferred work.
3. Dopisać do `capability-matrix-v0.md` notatkę, że obecny `Demag` executable path jest
   spectral FFT bootstrapem, a nie jeszcze kanonicznym Newell path.
4. Sprawdzić `problem-ir-v0.md`, `output-naming-policy-v0.md`, `visualization-quantities-v1.md`
   pod spójność:
   - `H_demag`
   - `E_demag`
   - `H_ext`
   - `E_ext`
   - `H_eff`
5. Uporządkować duplikaty physics docs w `docs/physics/` jeśli nadal istnieją.

### Files

- `docs/plans/active/phase-2-demag-fdm-detailed-plan.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/specs/problem-ir-v0.md`
- `docs/specs/output-naming-policy-v0.md`
- `docs/specs/visualization-quantities-v1.md`
- `docs/physics/0420-fdm-dipolar-demag-foundations.md`

### Acceptance

- brak sprzeczności między docs/specs a aktualnym kodem,
- ברור / jasne rozróżnienie: current executable vs canonical target.

---

## WP1 — Harden existing CPU spectral demag

### Cel

Domknąć obecny CPU reference path tak, żeby był porządnym baseline’em i punktem odniesienia dla CUDA oraz przyszłego Newella.

### Zadania

1. **FFT planner/workspace caching** w `fullmag-engine`.
   - dziś `fft3_in_place` nadal tworzy `FftPlanner` per call,
   - należy zbudować plan raz na grid,
   - reuse buffers i line workspaces.
2. **Demag observe reuse**.
   - ograniczyć redundantne ponowne liczenie `H_demag` w `observe()` / po kroku Heuna,
   - jeśli trzeba, rozszerzyć `StepReport` / cached observables.
3. **Jawne provenance operatora demag**.
   - `operator_kind = "spectral_fft_open_boundary"`
   - `padding = [2nx,2ny,2nz]`
   - `demag_kernel_model = "spectral_projection"`
   - `geometry_realization = "box_full_grid"` albo później `"masked_grid"`.
4. **Lepsze scalar diagnostics**:
   - `max_h_eff`
   - `max_h_demag`
   - `mean_abs_h_demag`
   - ewentualnie `demag_compute_ms`.
5. **Jawna separacja field computations**:
   - `H_demag`,
   - `H_ext`,
   - `H_eff_total`.

### Files

- `crates/fullmag-engine/src/lib.rs`
- `crates/fullmag-runner/src/cpu_reference.rs`
- `crates/fullmag-runner/src/artifacts.rs`
- `crates/fullmag-runner/src/types.rs`

### Acceptance

- ten sam wynik numeryczny jak przed refaktorem,
- wyraźnie mniejszy overhead FFT plannerów,
- artifacts i provenance mówią dokładnie jak liczone było demag.

---

## WP2 — Harden existing CUDA spectral demag

### Cel

Doprowadzić już istniejący CUDA path do poziomu “qualified backend for current slice”, nie tylko “it runs”.

### Zadania

1. Zweryfikować i utrwalić reuse:
   - `cufftHandle`
   - padded work buffers
   - demag field buffers
2. Ograniczyć koszt energy evaluation.
   - dziś demag energy w native backendzie może wymagać host copy,
   - docelowo energia powinna iść przez device reduction albo przynajmniej jawnie oznaczony temporary host path.
3. Rozszerzyć parity tests:
   - CPU double vs CUDA double,
   - różnice `H_demag`, `E_demag`, `H_eff`, `E_total`,
   - co najmniej kilka rozmiarów siatki i seedów.
4. Uzupełnić provenance:
   - `execution_backend = "cuda_fdm"`
   - `precision = "double" | "single"`
   - `fft_backend = "cuFFT"`
   - `demag_operator_kind = "spectral_fft_open_boundary"`
5. Uczciwie sklasyfikować precision tiers:
   - `double` jako qualified,
   - `single` jako engineering path dopóki nie przejdzie walidacji.

### Files

- `native/backends/fdm/src/demag_fp64.cu`
- `native/backends/fdm/src/demag_fp32.cu`
- `native/backends/fdm/src/context.cu`
- `crates/fullmag-runner/src/native_fdm.rs`
- `crates/fullmag-runner/src/dispatch.rs`
- testy CUDA w `native/backends/fdm/tests/`

### Acceptance

- CUDA double przechodzi parity vs CPU double w zdefiniowanych tolerancjach,
- provenance i artifacts są kompletne,
- `single` nie jest reklamowane jako qualified bez osobnej walidacji.

---

## WP3 — Walidacja fizyczna demag

### Cel

Podnieść demag z poziomu “działa” do poziomu “jest naukowo wiarygodne dla obecnego zakresu”.

### Zadania

1. **Thin-film tests**:
   - out-of-plane magnetization ma większą `E_demag` niż in-plane,
   - test dla `1-cell-thick` i kilku grubości.
2. **Rectangular prism demag factors**:
   - porównać z analitycznymi / semi-analitycznymi współczynnikami demagnetyzacyjnymi prostopadłościanu,
   - w praktyce użyć benchmarków typu Aharoni/Newell dla box geometries.
3. **Tiny-grid direct reference**:
   - dla bardzo małych siatek zbudować wolną referencję direct-sum / cell-average reference,
   - porównywać z FFT path.
4. **Energy positivity**:
   - `E_demag >= 0`
   - `E_total` w relaksacji nie rośnie bez powodu.
5. **CPU/CUDA parity matrix**:
   - różnice L2/Linf dla `H_demag`,
   - różnice energii.
6. **Artifact-level regression**:
   - `scalars.csv`
   - `fields/H_demag/*`
   - `metadata.json`

### Files

- `crates/fullmag-engine/src/lib.rs` tests
- `crates/fullmag-runner/src/cpu_reference.rs` tests
- `native/backends/fdm/tests/`
- ewentualny `scripts/compare_runs.py` lub podobny harness

### Acceptance

- demag ma realne testy fizyczne, nie tylko `is_finite()`,
- mamy jawny zestaw tolerancji acceptance,
- current spectral demag jest uczciwie skalibrowany.

---

## WP4 — Active mask i pierwsza zakrzywiona geometria FDM

### Cel

Umożliwić pierwsze 3D struktury zakrzywione w FDM bez łamania physics-first semantics.

### Decyzja

Pierwszy krok to **boolean active mask**, nie od razu subcell exact geometry.

### Zadania

1. Dodać do planner/plan:
   - `active_mask`
   - ewentualnie `active_cell_count`
   - `geometry_realization_metadata`
2. Dodać voxelizer dla `Cylinder`.
   - planner-owned,
   - deterministyczny,
   - jawnie zapisany w provenance.
3. Zmienić exchange w FDM tak, aby sąsiad poza aktywną domeną był traktowany zgodnie z free-surface semantics.
   - nie wolno udawać materiału poza maską,
   - boundary condition ma wynikać z geometrii aktywnej.
4. Zmienić demag packing:
   - tylko aktywne komórki mają `M != 0`,
   - padding i FFT zostają na whole padded box,
   - demag crop jest nadal do domeny gridu, ale fizyczna domena jest dana przez maskę.
5. Uzupełnić artifacts/UI:
   - zapisywać `active_mask`
   - pokazywać w 2D/3D tylko aktywne komórki
   - nie renderować “pełnego boxa” jako materii.

### Files

- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-ir/src/lib.rs`
- `crates/fullmag-engine/src/lib.rs`
- `crates/fullmag-runner/src/*`
- `apps/web/components/preview/*`

### Acceptance

- `Cylinder` jest first-class executable w FDM,
- `H_demag` i `m` są liczone tylko dla rzeczywistej domeny magnetycznej,
- UI pokazuje zakrzywioną strukturę jako voxelized magnetic body, nie jako pełny box.

---

## WP5 — Uzupełnienia do wcześniej wdrożonych oddziaływań

### 5.1 Exchange

Demag plan wymusza dopracowanie exchange.

#### Zadania

1. Przenieść exchange z modelu “jedno `A` + 6-point Laplacian” do modelu gotowego na:
   - `active_mask`,
   - future `A_f` na ścianach,
   - region/material interfaces.
2. Sprawdzić, czy `exchange_bc` z planu jest rzeczywiście konsumowane przez engine.
3. Przygotować seam pod:
   - `free surface`
   - `periodic`
   - później interface-aware exchange.

#### Cel

Nie implementować od razu pełnej heterogeniczności, ale przygotować operator tak, by nie trzeba go było przepisywać przy `MaterialAssignment` i `SpatialScalarField`.

### 5.2 Zeeman

#### Zadania

1. Domknąć semantykę:
   - surface API może dalej przyjmować `B`,
   - solver/planner pracuje na `H_ext`,
   - provenance zapisuje źródło i konwersję `B -> H_ext = B / mu0`.
2. Ujednolicić nazewnictwo wszędzie:
   - `H_ext`
   - `E_ext`
3. Zostawić seam pod:
   - pola czasowo-zależne,
   - pola przestrzennie zależne,
   - ale nie implementować ich w tym etapie.

### 5.3 LLG / integratory / relaksacja

#### Zadania

1. Upewnić się, że demag nie zmusza do powielania kodu przy kolejnych integratorach.
2. Wprowadzić operator reuse seam dla:
   - Heun,
   - później RK,
   - później relaxation algorithms.
3. Dopisać w provenance i diagnostics:
   - ile razy na krok ewaluowany był demag,
   - jakie było realne `solver_dt`,
   - jaki był koszt operatora.

---

## WP6 — Canonical dipolar upgrade: Newell path

### Cel

Dojść do zgodności z `0420` jako docelowym FDM contract.

### Ważna decyzja

Tego nie trzeba robić **przed** kwalifikacją obecnego spectral demag.
Ale trzeba zaprojektować już teraz.

### Zadania

1. Wprowadzić jawny `demag_operator_kind` w planner/runtime:
   - `spectral_projection`
   - `tensor_fft_newell`
2. Zaimplementować generator sześciu komponentów kernela Newella:
   - tylko przy init,
   - CPU builder,
   - później GPU consumption przez FFT of kernel.
3. Zbudować cache:
   - kernel coefficients,
   - FFT of kernel,
   - hash zależny od `cell_size`, `grid_shape`, aktywnej geometrii jeśli potrzebne.
4. Dodać compare harness:
   - spectral vs Newell
   - CPU vs CUDA
   - thin-film / prism benchmarks.
5. Podjąć decyzję produktową:
   - spectral zostaje jako debug/reference,
   - czy Newell staje się defaultem produkcyjnym.

### Acceptance

- repo ma klarowną drogę od obecnego bootstrapu do kanonicznego operatora,
- wybór operatora jest jawny i zapisany w provenance,
- physics docs i runtime nie kłamią, którą metodę użyto.

---

## WP7 — Planner, IR, artifacts i quantity browser

### Cel

Sprawić, żeby dipolar operator był pełnoprawnym obywatelem całej aplikacji, nie tylko jednego kernela.

### Zadania

1. Rozszerzyć `ProblemIR` / `ExecutionPlanIR` o metadata potrzebne demag:
   - `active_mask_present`
   - `geometry_realization`
   - `demag_operator_kind`
   - `external_field_input_kind = B | H_ext`
2. Uzupełnić artifacts:
   - `active_mask`
   - `geometry_realization.json`
   - jawne metadata dla `H_demag`
3. Uzupełnić quantity registry:
   - `H_demag`
   - `E_demag`
   - później `H_eff_total` jako composited quantity
4. Uzupełnić control room:
   - przełącznik quantity
   - mask-aware 2D/3D rendering
   - nie rysować nieaktywnych komórek jako materii.

### Acceptance

- planner, runner, artifacts i UI opisują tę samą fizykę,
- dipolar operator jest czytelny dla użytkownika w 2D/3D.

---

## WP8 — Jawny seam pod FEM, bez blokowania FDM

### Cel

Dopilnować, żeby obecne decyzje FDM nie zablokowały późniejszego FEM demag.

### Zadania

1. Utrzymać wspólne nazewnictwo:
   - `H_demag`
   - `E_demag`
2. Utrzymać wspólną semantykę:
   - dipolar self-interaction,
   - open-boundary intent,
   - provenance z informacją o realization method.
3. W comparison harness od początku przygotować miejsce na:
   - FDM voxelized body
   - FEM curved mesh body

### Acceptance

- FDM nie zamyka drogi do FEM,
- comparison layer jest możliwy bez późniejszego rozpruwania artifacts.

---

## 7. Priorytety implementacyjne

### Priorytet natychmiastowy

1. WP0 — alignment
2. WP1 — CPU hardening
3. WP2 — CUDA hardening
4. WP3 — walidacja

To są zadania, które mają największą wartość teraz.

### Priorytet kolejny

5. WP4 — active mask + `Cylinder`
6. WP5 — uzupełnienia exchange/Zeeman/LLG

### Priorytet strategiczny

7. WP6 — Newell path
8. WP7 — richer IR/artifacts/UI
9. WP8 — FEM seam

---

## 8. File-by-file implementation map

### Engine / numerics

- `crates/fullmag-engine/src/lib.rs`
  - CPU FFT caching
  - demag observe reuse
  - active-mask-aware exchange/demag
  - stronger tests

### Runner / artifacts

- `crates/fullmag-runner/src/cpu_reference.rs`
- `crates/fullmag-runner/src/native_fdm.rs`
- `crates/fullmag-runner/src/dispatch.rs`
- `crates/fullmag-runner/src/artifacts.rs`
- `crates/fullmag-runner/src/types.rs`

### Native CUDA

- `native/backends/fdm/src/demag_fp64.cu`
- `native/backends/fdm/src/demag_fp32.cu`
- `native/backends/fdm/src/context.cu`
- `native/backends/fdm/include/context.hpp`
- `native/backends/fdm/tests/*`

### Planner / IR

- `crates/fullmag-plan/src/lib.rs`
- `crates/fullmag-ir/src/lib.rs`

### Python surface

- `packages/fullmag-py/src/fullmag/model/energy.py`
- `packages/fullmag-py/src/fullmag/model/structure.py`
- `packages/fullmag-py/src/fullmag/model/problem.py`

### Web / quantity UI

- `apps/web/components/runs/RunControlRoom.tsx`
- `apps/web/components/preview/*`

### Docs / specs

- `docs/physics/0400-fdm-exchange-demag-zeeman.md`
- `docs/physics/0420-fdm-dipolar-demag-foundations.md`
- `docs/specs/problem-ir-v0.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/specs/output-naming-policy-v0.md`
- `docs/specs/visualization-quantities-v1.md`

---

## 9. Test matrix

### 9.1 Unit / engine tests

- `thin_film_out_of_plane_demag_energy_exceeds_in_plane_energy`
- `demag_energy_is_non_negative`
- `tiny_grid_fft_vs_direct_reference`
- `cpu_spectral_demag_reproducible_for_seeded_random_m0`

### 9.2 CPU vs CUDA parity

- `H_demag` L2 / Linf
- `E_demag`
- `E_total`
- `final m`

### 9.3 Geometry realization tests

- `Box` full mask == old behavior
- `Cylinder` active mask has expected volume fraction
- inactive cells never contribute material terms

### 9.4 End-to-end tests

- `fullmag examples/exchange_demag_zeeman.py`
- później `fullmag examples/cylinder_demag_relax.py`

### 9.5 UI / artifact tests

- quantity registry includes `H_demag`, `E_demag`
- control room renders only active domain
- artifacts contain provenance for demag operator

---

## 10. Non-goals tego etapu

W tym planie **nie** obiecujemy jeszcze:

- pełnej produkcyjnej geometrii imported CAD w FDM,
- pełnej subcell boundary correction,
- exact curved-boundary fidelity porównywalnej z FEM,
- finalnej produkcyjnej implementacji Newella,
- wdrożenia FEM demag,
- pełnej multiphysics coupling.

---

## 11. Definicja ukończenia

Etap można uznać za domknięty dopiero, gdy jednocześnie są spełnione wszystkie warunki:

- CPU demag jest hardened i lepiej zwalidowany,
- CUDA demag jest qualified dla obecnego slice’u,
- artifacts i provenance są kompletne,
- `Cylinder` działa przez voxelization + active mask,
- exchange i Zeeman są semantycznie dopięte do tej samej architektury,
- docs/physics/specs mówią dokładnie to samo co kod,
- quantity browser i control room potrafią uczciwie pokazać `H_demag` i maskowaną geometrię,
- istnieje jasna, zapisana droga z obecnego spectral baseline do kanonicznego Newell path.

---

## 12. Skrócona rekomendacja wykonawcza

Jeśli trzeba ten plan wdrażać etapami bez ryzyka rozjazdu, kolejność powinna być dokładnie taka:

1. **alignment docs/specs**
2. **CPU spectral hardening**
3. **CUDA spectral hardening**
4. **physical validation suite**
5. **active mask + Cylinder**
6. **exchange/Zeeman cleanup**
7. **Newell path as canonical upgrade**

To daje jednocześnie:

- szybkie korzyści dla obecnego solvera,
- uczciwą drogę do geometrii zakrzywionych,
- i brak długu architektonicznego przed FEM.
