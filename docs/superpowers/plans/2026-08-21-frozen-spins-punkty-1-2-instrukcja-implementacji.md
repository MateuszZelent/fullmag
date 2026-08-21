# Frozen spins — instrukcja implementacji punktów 1 i 2

## Cel dokumentu

Ten plik jest instrukcją wykonawczą dla modelu, który ma dokończyć dwa
pozostałe zakresy funkcji `FrozenSpins` w Fullmag:

1. **konsumenci FEM CPU i FEM GPU** — native FEM ma przyjąć i rzeczywiście
   stosować rozwiązaną maskę true-DOF oraz magnetyzację referencyjną;
2. **kwalifikacja CUDA** — FDM CUDA ma przejść od obecnego kontraktu ABI i
   kompilacji do powtarzalnego dowodu działania na zarządzanym runtime GPU.

Dokument jest planem implementacyjnym, a nie dowodem ukończenia. Nie wolno
oznaczyć funkcji jako gotowej tylko dlatego, że źródła się kompilują albo test
ABI przechodzi.

## Instrukcja nadrzędna dla modelu wykonującego pracę

Pracuj w repozytorium `/home/kkingstoun/git/fullmag/fullmag`. Zachowaj
niezwiązane zmiany w dirty worktree. Nie wykonuj `git reset --hard`, szerokiego
formatowania, commitowania ani pushowania. Wszystkie raporty, plany i komentarze
użytkowe pisz po polsku; nazwy symboli, ścieżki i komentarze w kodzie pozostają
po angielsku.

Przed edycją:

1. przeczytaj `AGENTS.md`;
2. przeczytaj, jako źródła semantyki, `docs/physics/0996-frozen-spins-constraint.md`,
   `docs/specs/frozen-spins-v1.md`,
   `docs/validation/frozen-spins-qualification-matrix.md` oraz
   `docs/physics/0900-native-fem-operator-contracts-and-validation.md`;
3. sprawdź aktualny diff przez `git status --short`,
   `git diff --stat` i `git diff --cached --stat`;
4. wyszukaj symbole wskazane w tym dokumencie przed ich modyfikacją — nie
   zakładaj, że nazwa albo layout pozostały bez zmian;
5. dla prac native FEM używaj repozytoryjnych, kontenerowych recept `just`.
   Hostowe `cargo`, `cmake` i bezpośrednie binaria są tylko diagnostyką, nie
   końcowym dowodem GPU/MFEM.

Zasada bezpieczeństwa: jeżeli dowolna warstwa nie umie zastosować maski i
referencji, ma zwrócić jednoznaczny błąd `frozen_spins_*_unqualified` przed
startem obliczeń. Nie wolno wyzerować, pominąć ani zinterpretować maski jako
zwykłego pola materiałowego.

---

## 1. Stan wyjściowy, którego nie wolno pomylić z ukończeniem

### 1.1. Warstwy już obecne

W repozytorium istnieją już elementy autorstwa i lowering:

- Python `FrozenSpins`, selektory i walidacja;
- `MagnetizationConstraintIR::FrozenSpins`;
- `ResolvedFrozenSpinsPlanIR` oraz kompilacja selekcji FDM/FEM;
- FEM plan z maską true-DOF i referencją;
- FDM CPU z projekcją RHS, aktywacją i checkpointem;
- FDM CUDA z rozszerzeniem ABI, alokacją/uploadem maski i referencji oraz
  projekcją końcowego RHS;
- kontrola możliwości native FDM CUDA;
- testy kontraktowe i dokumentacja kwalifikacyjna.

### 1.2. Aktualne blokady

FEM jest celowo fail-closed w dwóch miejscach:

- `crates/fullmag-runner/src/solver_runtime/selection.rs`:
  `reject_frozen_spins_fem_execution` i
  `reject_frozen_spins_fem_plan_execution`;
- `backends/fem/src/api.cpp`:
  `fullmag_fem_backend_create` i `fullmag_fem_backend_create_v2` odrzucają
  niepuste `frozen_mask`/`frozen_reference_xyz`.

To oznacza, że planner już wylicza dane, ale native FEM ich nie konsumuje.
Nie usuwaj tych guardów przed dodaniem konsumenta; najpierw zbuduj konsumenta i
test, potem zmień guard na przepuszczanie wyłącznie kwalifikowanego zakresu.

W FDM CUDA obecny `just verify-frozen-spins-fdm-cuda` sprawdza przede wszystkim
ABI, layout, capability gate i checkpoint FDM CPU. Jest to konieczny kontrakt,
ale nie jest jeszcze dowodem, że urządzenie CUDA utrzymuje zamrożone spiny w
rzeczywistej integracji solvera. Po ostatnich zmianach bramka zarządzanego
runtime nie ma świeżego, potwierdzonego wyniku; traktuj ją jako `BLOCKED` do
czasu uruchomienia.

---

## 2. Niepodlegająca negocjacji semantyka fizyczna

Frozen spins oznacza dla każdego aktywnego true DOF `i`:

```text
m_i(t) = m_i^★
dm_i/dt = 0
```

gdzie:

- `m_i` jest bezwymiarową magnetyzacją zredukowaną;
- `m_i^★` jest referencją przechwyconą zgodnie z
  `FrozenReferencePolicyIR` przy aktywacji;
- `F = { i | frozen_mask[i] != 0 }` jest maską wynikową po lowering;
- maska jest indeksowana **przestrzenią true DOF backendu**, a nie surowym
  indeksem elementu, indeksem UI ani indeksem komórki FDM;
- referencja ma dokładnie trzy liczby `f64` na true DOF: `[mx,my,mz]`;
- aktywne spiny muszą zachować referencję także po odrzuconej próbie, retry,
  zmianie `dt`, rollbacku i wznowieniu z checkpointu.

Dla niezamrożonych DOF solver działa normalnie. Interakcje (exchange, demag,
anisotropy, DMI, thermal, STT/SOT itd.) mogą używać pełnego pola do wyliczenia
RHS, ale finalny operator ewolucji musi wyzerować składową na `F`, a po każdej
operacji, która może zmienić stan, należy odtworzyć `m_i^★`.

Nie implementuj frozen spins przez:

- zmianę `Ms`, `alpha` albo `A_ex` na zero;
- usunięcie węzła z siatki;
- zmianę energii w sposób, który tylko „zachęca” do pozostania w miejscu;
- modyfikację jednego typu RHS bez obsługi rollbacku;
- ponowne obliczanie selektora po każdym kroku;
- cichy fallback z GPU do CPU.

---

# Punkt 1 — konsumenci FEM CPU i FEM GPU

## 3. Kontrakt wejściowy i odpowiedzialność warstw

### 3.1. Planner i runner

Źródła do sprawdzenia:

- `crates/fullmag-plan/src/fem.rs`, funkcja `resolve_fem_frozen_spins`;
- `crates/fullmag-plan/src/selection/fem.rs`;
- `crates/fullmag-plan/src/selection/certificate.rs`;
- `crates/fullmag-runner/src/native_fem.rs`, budowa
  `ffi::fullmag_fem_plan_desc`;
- `crates/fullmag-runner/src/solver_runtime/fem_selection.rs`;
- `crates/fullmag-runner/src/solver_runtime/selection.rs`.

Nie twórz drugiej selekcji w backendzie. Runner ma przekazać już rozwiązaną
maskę i referencję; backend ma zweryfikować ich kształt, związać je z
przestrzenią DOF i przechowywać snapshot aktywacji.

Przed wywołaniem C ABI runner musi sprawdzić:

```text
frozen_mask_len == n_true_dofs
frozen_reference_len == 3 * n_true_dofs
frozen_mask != null iff frozen_reference_xyz != null
```

Jeżeli maska jest pusta, oba wskaźniki i długości mają pozostać puste/zerowe.
Jeżeli jest niepusta, liczba zamrożonych DOF może wynosić od `1` do
`n_true_dofs - 1`; przypadek „wszystko zamrożone” musi mieć jawnie obsłużoną
semantykę zatrzymania i nie może prowadzić do dzielenia przez zero w redukcjach.

### 3.2. C ABI

Aktualny append-only tail już znajduje się w:

- `native/include/fullmag_fem.h`, `fullmag_fem_plan_desc`;
- `crates/fullmag-fem-sys/src/lib.rs`, `fullmag_fem_plan_desc`;
- `backends/fem/src/api.cpp`, import planu i guard tworzenia backendu.

Nie przesuwaj istniejących pól. Nie zmieniaj typów `uint8_t`, `uint64_t` ani
`double`. Zachowaj test layoutu w `crates/fullmag-fem-sys/src/lib.rs` i dodaj
assertion, że frozen tail pozostaje za dotychczasowym rozszerzeniem SOT.

Backend musi odrzucać:

- tylko jedną z dwóch tablic;
- długość maski różną od liczby true DOF;
- długość referencji różną od `3*n_true_dofs`;
- wartości niefinityczne referencji;
- maskę niezgodną z aktywną domeną magnetyczną;
- `fe_order > 1`, jeśli nie ma jawnej mapy true DOF dla tego rzędu.

Komunikat błędu musi zawierać etap (`plan`, `activation`, `step`, `checkpoint`)
i oczekiwane/rzeczywiste długości. Nie używaj ogólnego „invalid argument”.

## 4. Moduł runtime FEM — gdzie i jak go włączyć

Nie dodawaj logiki do `mfem_bridge.cpp` ani do przypadkowego pola `Context`.
Zgodnie z architekturą native FEM wydziel jeden moduł odpowiedzialny za
frozen spins, np.:

```text
backends/fem/cpu/mfem/interactions/frozen_spins.hpp
backends/fem/cpu/mfem/interactions/frozen_spins.cpp
```

Jeżeli istnieje już odpowiedni moduł interakcji/ograniczeń, użyj jego nazwy i
nie twórz duplikatu. Moduł ma mieć jedną spójną strukturę runtime, zawierającą
co najmniej:

- `enabled`;
- `true_dof_count`;
- `frozen_count`;
- hostową maskę `std::vector<uint8_t>`;
- hostową referencję `std::vector<double>` w układzie SoA albo AoS zgodnym z
  istniejącym `FemStateRuntimeState` — wybierz istniejący układ i nie mieszaj
  go lokalnie;
- fingerprint siatki/topologii i identyfikator constraintu;
- numer/epoch aktywacji;
- diagnostykę liczby projekcji i naruszenia maksymalnego.

Jeżeli GPU jest aktywne, moduł ma posiadać również jawny właściciel pamięci
device dla maski i referencji. Nie umieszczaj surowych wskaźników CUDA w C ABI
ani w runnerze.

Do `Context` dodaj tylko jeden modułowy agregat, jeżeli obecna architektura tego
wymaga; nie dodawaj osobnych pól `frozen_mask`, `frozen_reference`,
`frozen_enabled` w kilku niezależnych miejscach.

## 5. Import planu i aktywacja

### 5.1. `context_from_plan`

Właściwy punkt wejścia to `backends/fem/include/context.hpp` i implementacja
`context_from_plan` w module importu planu. Przy imporcie:

1. ustal faktyczną liczbę magnetycznych true DOF po zbudowaniu `FiniteElementSpace`;
2. dla P1 potwierdź mapowanie plannerowego indeksu na nodalny true DOF;
3. dla P2 nie zakładaj, że wszystkie DOF są węzłami siatki — albo dodaj
   kompletną mapę, albo odrzuć plan przed alokacją solvera;
4. skopiuj maskę i referencję do pamięci zarządzanej przez backend;
5. sprawdź fingerprint mesh/topology, jeśli jest dostępny w planie;
6. ustaw aktywację tylko raz dla danego snapshotu;
7. wyzeruj liczniki diagnostyczne.

Aktywacja nie może ponownie wywoływać selektora geometrycznego. W szczególności
nie wolno używać aktualnego `m` do zmiany członkostwa maski po aktywacji.

### 5.2. Wartości referencyjne

W chwili aktywacji referencja jest kopią wartości przekazanych w planie. Nie
normalizuj jej po cichu, chyba że kontrakt `0996` wyraźnie wymaga walidacji
jednostkowego modułu; w takim przypadku odrzuć referencję, której norma
przekracza ustaloną tolerancję, zamiast zmieniać dane użytkownika.

## 6. FEM CPU — wymagane punkty integracji

### 6.1. Jawna projekcja stanu i RHS

W istniejącym CPU RK pipeline znajdź:

- `backends/fem/cpu/mfem/runtime/backend_step.cpp`,
  `run_backend_step_attempt` i `run_backend_step`;
- `backends/fem/cpu/mfem/integrators/rk_explicit_step.*`;
- moduły obliczające RHS i pola efektywne.

Dodaj dwie jawne operacje modułu frozen spins:

```text
project_state_to_frozen_reference(m)
project_rhs_to_frozen_zero(rhs)
```

Ich kolejność dla każdej próby RK:

1. przed obliczeniem pierwszego stage: odtwórz zamrożone komponenty stanu;
2. po każdym stage RHS: wyzeruj `rhs[3*i + {0,1,2}]` dla `frozen_mask[i]`;
3. po złożeniu kandydata RK: odtwórz `m_i^★`;
4. przed obliczeniem energii, redukcji i kryterium stopu: ponownie odtwórz
   referencję;
5. przy `commit`: pozostaw referencję;
6. przy `rollback`: przywróć pełny snapshot transakcji i ponownie wymuś
   referencję.

Nie wystarczy projekcja tylko na końcu publicznego kroku. Adaptacyjne retry i
obliczenie następnego stage mogą odczytać stan pośredni.

### 6.2. Interakcje i redukcje

Wewnętrzne interakcje mogą liczyć pola na pełnej domenie magnetycznej, ale:

- maska nie może wyłączać zamrożonego DOF z demag/exchange, jeśli zmieniałoby to
  fizyczne pole pozostałych DOF;
- finalny RHS frozen DOF ma być zero niezależnie od tego, jakie pole zwróci
  interakcja;
- normy RHS, normy torque i kryteria relaksacji muszą mieć jasno określone,
  czy liczą wszystkie DOF czy tylko wolne. Dla kryterium zbieżności użyj
  **wolnych DOF**, a w telemetryce publikuj oba liczniki;
- średnia magnetyzacja i energia muszą nadal uwzględniać zamrożone spiny,
  ponieważ są częścią fizycznego stanu, nie usuniętymi węzłami.

Dodaj pola telemetryczne tylko przez istniejący kontrakt `fullmag_fem_step_stats`
albo istniejący JSON diagnostyczny; nie twórz nieudokumentowanego kanału.
Minimalny zestaw to `frozen_count`, `free_count`, `max_constraint_error` i
`projection_count`.

### 6.3. CPU direct minimizers

Przejrzyj:

- `backends/fem/cpu/mfem/relaxation/relaxation_step.cpp`;
- `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`;
- `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp`;
- `backends/fem/cpu/mfem/relaxation/direct_energy_increment.cpp`.

Każdy algorytm, który tworzy kierunek, krok próbny albo gradient, musi:

- wyzerować kierunek na frozen DOF;
- przywrócić referencję po trial step;
- nie uwzględniać frozen DOF w mianownikach i iloczynach używanych do wyboru
  kroku;
- wykonać projekcję także po odrzuconym kroku energetycznym.

Jeżeli nie da się tego zapewnić w jednym spójnym kontrakcie, pozostaw dany
algorytm z błędem `frozen_spins_fem_<algorithm>_unqualified` i nie przepuszczaj
go przez ogólny guard. Wtedy kwalifikuj osobno tylko algorytmy, dla których
istnieją testy. Nie oznaczaj całego FEM jako obsługującego frozen spins.

## 7. FEM GPU — wymagane punkty integracji

### 7.1. Właściciel pamięci device

Przejrzyj:

- `backends/fem/gpu/cuda/runtime/gpu_state_runtime.*`;
- `backends/fem/gpu/cuda/integrators/rk/*`;
- `backends/fem/gpu/cuda/relaxation/pgbb*`;
- `backends/fem/gpu/cuda/relaxation/nonlinear_cg*`.

Maska i referencja mają być zaalokowane raz na generację planu/topologii i
przeniesione na urządzenie przed hot loopem. W hot loopie nie może być:

- `cudaMemcpy` maski/referencji dla każdego stage;
- hostowego odczytu pojedynczych frozen DOF;
- synchronizacji host-device tylko po to, aby sprawdzić constraint;
- cichego przełączenia na CPU.

Kernels projekcji powinny pracować na tej samej przestrzeni true DOF i na tym
samym streamie co RHS/RK. Zastosuj istniejące mechanizmy eventów i
`TransferAuditScope`, nie dodawaj osobnej synchronizacji globalnej.

### 7.2. GPU explicit RK

W ścieżce wywoływanej przez `context_step_explicit_rk_mfem`:

1. przed stage 0 uruchom kernel odtwarzający referencję;
2. po każdym kernelu RHS uruchom kernel zerujący RHS frozen DOF;
3. po złożeniu kandydata uruchom projekcję stanu;
4. przy rollbacku użyj istniejącego `RkStepTransaction` i rozszerz jego
   checkpoint o stan frozen, jeżeli stan nie jest już zawarty w snapshotcie;
5. przed publikacją statystyk wykonaj projekcję i policz maksymalny błąd;
6. po `commit` zwiększ licznik zaakceptowanej projekcji, nie licz prób
   odrzuconych jako zaakceptowanych kroków.

Nie dodawaj osobnej ścieżki „frozen RK”. To ma być operator ograniczenia w
istniejącym RK pipeline, tak aby wszystkie integratory korzystały z tej samej
semantyki.

### 7.3. GPU direct minimizers

`backends/fem/cpu/mfem/runtime/backend_step.cpp` deleguje GPU PGBB/NCG do:

- `gpu_relax_projected_gradient_bb_step`;
- `gpu_relax_nonlinear_cg_step`.

Przed zdjęciem guardu musisz pokazać, że oba algorytmy stosują projekcję w:

- gradientach/kierunkach;
- trial state;
- line search i obliczeniu energii;
- rollbacku.

Jeżeli nie ma takiego dowodu, pozostaw je odrzucone z nazwanym błędem i
aktualizuj capability matrix. Zabronione jest zgłoszenie `implemented` tylko
na podstawie tego, że kernel przyjmuje wskaźnik do maski.

## 8. Guardy, capability i provenance po implementacji FEM

Po dodaniu rzeczywistych konsumentów zmień zachowanie w kolejności:

1. `backends/fem/src/api.cpp` przestaje odrzucać poprawny descriptor, ale nadal
   odrzuca malformed descriptor;
2. `crates/fullmag-runner/src/solver_runtime/selection.rs` przestaje
   odrzucać cały FEM, ale zostawia guardy dla nieobsługiwanych kombinacji
   (np. P2 albo niezaimplementowany direct minimizer);
3. `fem_selection.rs` rozróżnia `implemented`, `production_executable` i
   `validated`; nie promuj lane'u automatycznie;
4. provenance runu publikuje:

```text
frozen_spins.enabled
frozen_spins.constraint_ids
frozen_spins.true_dof_count
frozen_spins.frozen_count
frozen_spins.reference_policy
frozen_spins.activation_epoch
frozen_spins.mesh_fingerprint
frozen_spins.execution_lane
frozen_spins.projection_count
frozen_spins.max_constraint_error
```

W przypadku odrzucenia provenance ma zawierać przyczynę i capability, a nie
udawać, że constraint nie istniał.

## 9. Testy punktu 1 — kolejność TDD

Najpierw dodaj testy, które początkowo mają pokazać aktualny brak konsumenta.
Potem implementuj najmniejszą zmianę, która je przeprowadzi.

### 9.1. Testy planu i ABI

Utrzymaj lub rozszerz:

- `crates/fullmag-plan` testy FEM selection;
- `crates/fullmag-fem-sys` test append-only layout;
- test C ABI backend create dla pustej, poprawnej i malformed maski.

Wymagane przypadki:

| Przypadek | Oczekiwany wynik |
|---|---|
| brak frozen | backend działa jak przed zmianą |
| jedna zamrożona P1 true DOF | plan przyjęty, referencja zachowana |
| maska długości `n-1` | błąd przed startem solvera |
| referencja długości `3n-3` | błąd przed startem solvera |
| tylko maska albo tylko referencja | błąd przed startem solvera |
| frozen DOF w air-only node | błąd lub wynik zgodny z polityką inactive selection; nigdy ciche przyjęcie |
| `fe_order=2` bez mapy | capability rejection |
| wszystkie DOF frozen | jawny stop/degenerate policy, bez NaN |

### 9.2. CPU single-step oracle

Dodaj test natywnego FEM CPU na najmniejszej siatce P1, najlepiej dwa elementy
dzielące węzeł. Ustal:

- `m0` niejednorodne na co najmniej dwóch węzłach;
- zamrożony węzeł interfejsowy;
- niezerowe exchange i zewnętrzne pole, aby RHS nie był trywialnie zerowy;
- co najmniej jeden retry albo wymuszoną odrzuconą próbę.

Po jednym kroku sprawdź:

```text
||m_frozen - m_reference||_inf <= 1e-14   (double CPU)
max_abs(rhs_frozen) == 0                  (do tolerancji reprezentacji)
||m_free_after - m_free_before|| > 0      (test nie jest pusty)
rollback zachowuje m_reference
```

Jeżeli produkcyjny kontrakt używa innej tolerancji, odczytaj ją z istniejących
testów i zapisz w teście; nie wpisuj arbitralnej tolerancji bez uzasadnienia.

### 9.3. GPU FEM test device-resident

Na tej samej siatce uruchom FEM GPU double i sprawdź:

- aktywny backend/device jest GPU;
- zamrożony DOF pozostaje równy referencji po każdym obserwowalnym kroku;
- wolny DOF ewoluuje;
- `TransferAuditScopeKind::HotLoop` nie raportuje transferu maski/referencji;
- maska/referencja są uploadowane najwyżej raz na aktywację/topology generation;
- po rollbacku wynik jest identyczny z oczekiwanym snapshotem;
- provenance nie ma fallback trail.

Ten test musi działać w managed runtime. Sam test source-facade albo test
statycznego występowania nazwy kernela nie wystarcza.

### 9.4. Checkpoint/resume FEM

Jeżeli publiczny FEM runtime zapisuje checkpointy, rozszerz istniejący kontrakt
checkpointu o frozen state albo jawnie odrzuć resume z aktywnym frozen spins.
Wznowienie musi sprawdzić:

- schema/version;
- constraint identity;
- topology/mesh fingerprint;
- długość maski i referencji;
- zgodność aktywacji;
- integralność payloadu.

Po resume nie wolno ponownie przechwycić referencji z bieżącego `m`.

---

# Punkt 2 — kwalifikacja CUDA

## 10. Zakres kwalifikacji i kolejność lane'ów

Kwalifikuj w tej kolejności:

1. **FDM CUDA, single grid, FP64, explicit LLG/RK** — pierwszy lane
   produkcyjny;
2. **FDM CUDA, single grid, FP32** — dopiero po osobnej analizie błędu
   zaokrągleń;
3. **FDM CUDA direct minimizers (BB/NCG)** — osobny lane, obecnie jawnie
   odrzucony, dopóki trial retractions nie stosują referencji;
4. **FDM multilayer CUDA** — nie promuj bez osobnego layoutu maski i testu;
5. **FEM GPU** — kwalifikuj według sekcji punktu 1, nie zaliczaj go przez test
   FDM CUDA.

Minimalny cel punktu 2 to lane 1. Capability dla pozostałych lane'ów musi
pozostać false albo zwracać nazwany błąd.

## 11. Aktualny kod CUDA, który należy zweryfikować

Sprawdź następujące symbole przed zmianą:

- `backends/fdm/include/context.hpp` — pola maski/referencji w `Context`;
- `backends/fdm/gpu/cuda/runtime/context.cu` — alokacja, zwalnianie i upload;
- `backends/fdm/api/c_api.cpp` — capability bit i walidacja descriptoru;
- `backends/fdm/gpu/cuda/integrators/llg_fp64.cu`;
- `backends/fdm/gpu/cuda/integrators/llg_fp32.cu`;
- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` — capability gate i import
  referencji;
- `crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs` — aktywacja, checkpoint,
  stage state i finalny artefakt;
- `crates/fullmag-runner/src/solver_runtime/selection.rs` — guardy CUDA;
- `backends/fdm/tests/frozen_spins_abi_contract.cpp`;
- `crates/fullmag-fdm-sys/src/lib.rs` — layout ABI.

Założenie do sprawdzenia, nie do ślepego przyjęcia: capability może być
reklamowane dopiero wtedy, gdy natywna biblioteka potwierdzi lane single-grid i
nie ma aktywnego fallbacku. Runner nie może „dopisać” capability po stronie
Rust.

## 12. Test ABI nie jest testem runtime

Zachowaj istniejący test `frozen_spins_abi_contract`, ale dodaj osobny test
uruchamiający solver CUDA. Test runtime ma być zbudowany w `native`/CMake i
uruchomiony na realnym urządzeniu przez profil `fem-gpu`. Nie zastępuj go:

- testem, który tylko tworzy strukturę C;
- testem, który sprawdza niezerowy capability bit;
- testem CPU z flagą `--features cuda`;
- testem, który akceptuje automatyczny fallback.

## 13. Minimalny scenariusz naukowy FDM CUDA

Dodaj kontrakt, np. `backends/fdm/tests/frozen_spins_cuda_runtime.cpp`, zgodnie
ze stylem istniejących testów. Nazwę targetu dopasuj do konwencji CMake, ale
nie ukrywaj go w teście ogólnym.

### 13.1. Geometria i dane

Użyj najmniejszej nietrywialnej siatki single-grid, która ma co najmniej dwa
magnetyczne komórkowe DOF. Przygotuj:

```text
mask       = [1, 0]
reference  = [1, 0, 0,   0, 1, 0]
m_initial  = [0, 1, 0,   0, 0, 1]
```

Jeśli aktualny layout FDM wymaga innej kolejności SoA, zachowaj semantykę:
pierwszy DOF jest zamrożony, drugi wolny, a referencja pierwszego DOF różni się
od `m_initial`.

Włącz co najmniej jedną interakcję, która powoduje niezerowy RHS dla wolnego
DOF. Nie używaj wyłącznie jednorodnego stanu i zerowego pola, bo test może
przejść mimo braku konsumenta.

### 13.2. Asercje po każdym kroku

Test musi sprawdzić po każdym publicznym kroku, nie tylko po końcu:

```text
frozen_m == reference              (FP64: zgodność do kontraktu double)
frozen_rhs == 0                    (po projekcji końcowego RHS)
free_m != initial_free_m            (solver faktycznie liczył)
norm(m_frozen) == 1                 (jeśli backend normalizuje m)
no host fallback                    (provenance/device query)
```

Uruchom co najmniej dwa kroki i jeden przypadek z przerwaniem/checkpointem,
aby sprawdzić, że referencja nie jest przechwytywana ponownie.

### 13.3. Test braku cichego fallbacku

Wymuś `FULLMAG_FDM_EXECUTION=gpu` albo odpowiedni jawny runtime override.
Oczekuj:

- capability i device identity CUDA w provenance;
- błędu, jeśli CUDA nie jest dostępna;
- nigdy wyniku oznaczonego jako GPU, gdy faktycznie wykonano CPU;
- pustego fallback trail dla poprawnie uruchomionego lane'u.

Dodaj osobny test, który symuluje brak capability i potwierdza fail-closed.

## 14. CUDA integratory — obowiązkowa kontrola obu precyzji

W `llg_fp64.cu` i `llg_fp32.cu` zweryfikuj, że projekcja nie jest tylko w
jednym wariancie kernela (np. tylko final RHS, bez stage RHS). Dla każdego
integratora sprawdź:

1. wejście maski i referencji jest device-resident;
2. maska jest respektowana dla każdej składowej `x/y/z`;
3. kernel nie czyta referencji poza `3*n`;
4. nie ma branchu, który pomija frozen cells dopiero po redukcji;
5. finalny zapis do `dm` dla frozen jest zerowy;
6. po update stanu wykonywana jest projekcja do `m^★`;
7. FP32 ma osobny próg błędu i osobny raport, nie dziedziczy ślepo progu FP64.

Jeżeli tylko FP64 spełnia te warunki, capability ma reklamować wyłącznie
FP64. Nie włączaj FP32 przez wspólną flagę.

## 15. Runner CUDA i checkpoint

W `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs` oraz `execute.rs` sprawdź:

- descriptor przekazuje maskę i referencję dla tego samego grid fingerprint;
- capability gate wykonuje się przed alokacją solvera;
- aktywacja frozen ma ten sam epoch co CPU/reference lane;
- finalny checkpoint zawiera maskę, referencję, activation epoch i fingerprint;
- resume odtwarza referencję, nie recapturuje jej z aktualnego stanu;
- live `StepUpdate` i terminalny artefakt wskazują, że constraint był aktywny;
- błędy CUDA nie są opakowywane jako sukces z pustym polem.

Zachowaj obecny guard dla bezpośrednich minimizerów, jeśli ich implementacja
nie ma projekcji trial state. Jego komunikat powinien pozostać precyzyjny:
`frozen_spins_cuda_direct_minimizer_unqualified`.

## 16. Rozszerzenie zarządzanej bramki `just`

Obowiązkowa ścieżka weryfikacji native CUDA to recepta w `justfile`:

```text
just verify-frozen-spins-fdm-cuda
```

Recepta już buduje w profilu `fem-gpu` target `fullmag_fdm` i
`frozen_spins_abi_contract`, a następnie uruchamia testy Rust. Rozszerz ją tak,
aby po kontrakcie ABI uruchamiała również nowy target runtime CUDA i sprawdzała
artefakt dowodowy. Nie kopiuj ręcznie polecenia Docker do dokumentacji jako
zamiennika recepty.

Recepta powinna w kolejności:

1. użyć trwałego managed native root z `FULLMAG_MANAGED_NATIVE_ROOT`;
2. skonfigurować `FULLMAG_ENABLE_CUDA=ON` i właściwe architektury;
3. zbudować bibliotekę i oba targety (ABI + runtime);
4. uruchomić `ctest` z `--output-on-failure`;
5. wykonać test runtime na urządzeniu CUDA;
6. zapisać JSON evidence w tym samym build/report root;
7. zweryfikować JSON przez `python3 -m json.tool` i skrypt walidacyjny;
8. zakończyć kodem różnym od zera, gdy device identity, frozen invariant,
   precision lane lub fallback policy nie przejdą.

Nie zapisuj wielkich buildów w zwykłym `/tmp`. Nie używaj hostowego `cmake`
jako końcowej bramki.

## 17. Evidence JSON dla CUDA

Artefakt dowodowy runtime powinien zawierać stabilne pola:

```json
{
  "schema": "fullmag.frozen_spins.cuda.runtime.evidence.v1",
  "backend": "fdm",
  "lane": "single_grid_fp64_explicit_rk",
  "device": {
    "uuid": "...",
    "name": "...",
    "driver": "...",
    "runtime": "..."
  },
  "grid_fingerprint": "...",
  "frozen_count": 1,
  "free_count": 1,
  "activation_epoch": 1,
  "max_constraint_error": 0.0,
  "steps": 2,
  "free_state_changed": true,
  "fallback_trail": [],
  "hot_loop_mask_upload_count": 0,
  "checkpoint_round_trip": true,
  "binary_build_digest": "...",
  "pass": true
}
```

Wartości `device.uuid`, digestu i tolerancji muszą pochodzić z uruchomienia,
nie z wpisanego na stałe przykładu. Jeżeli urządzenie nie udostępnia UUID,
raportuj dokładną przyczynę i nie traktuj dowodu jako pełnego production
qualification.

## 18. Testy Rust po zmianach CUDA

Uruchom co najmniej:

```text
cargo test -p fullmag-fdm-sys frozen_spins_v1_is_an_append_only_nullable_plan_extension -- --nocapture
cargo test -p fullmag-runner --features cuda native_fdm_frozen_spins_capability_gate_accepts_advertised_single_grid_lane -- --nocapture
cargo test -p fullmag-runner constraints::checkpoint -- --nocapture
cargo test -p fullmag-runner fdm::cpu::reference::tests::frozen_spins_checkpoint_round_trip_restores_reference_without_selector_recapture -- --nocapture
```

Te testy mogą być uruchomione pomocniczo poza kontenerem, ale końcowy wynik
CUDA musi pochodzić z `just verify-frozen-spins-fdm-cuda`.

## 19. Kwalifikacja naukowa: FDM CPU jako oracle

Przed porównaniem CUDA uruchom ten sam przypadek na FDM CPU reference:

- identyczna geometria, maska, referencja, stan początkowy, `dt`, liczba
  kroków i aktywacja;
- zapisz końcowe `m`, RHS, energię i checkpoint;
- policz błąd CUDA względem CPU wyłącznie dla **wolnych** DOF;
- dla frozen DOF sprawdzaj przede wszystkim równość z referencją, a nie różnicę
  CPU/GPU.

Tolerancje muszą być rozdzielone na FP64 i FP32 i uzasadnione przez istniejący
kontrakt numeryczny. Nie akceptuj „wizualnie podobnego” pola jako dowodu.

Minimalne oracles:

1. frozen invariant przez każdy krok;
2. zmiana co najmniej jednego wolnego DOF;
3. zgodność wolnych DOF CPU/GPU w ustalonej tolerancji;
4. zgodność energii i czasu stage, jeśli są częścią istniejącego kontraktu;
5. checkpoint/resume daje ten sam wynik co przebieg ciągły;
6. odwrócenie maski zmienia wynik w przewidywalny sposób;
7. pusta maska daje wynik identyczny z baseline bez constraintu.

## 20. Macierz acceptance gates

| Gate | Dowód | Status może być `pass` tylko gdy |
|---|---|---|
| źródło/ABI | diff + layout tests | tail append-only, długości i wskaźniki są sprawdzane |
| planner | testy `fullmag-plan` | maska jest w true-DOF space i ma fingerprint |
| FEM CPU | native managed test | frozen invariant, wolny DOF, retry/rollback |
| FEM GPU | managed device test | device identity, brak hot-loop transferu, invariant |
| FDM CUDA ABI | `frozen_spins_abi_contract` | C ABI i capability są zgodne |
| FDM CUDA runtime | nowy test device | realny kernel, nie ABI-only |
| CPU/GPU parity | evidence + oracle | wolne DOF mieszczą się w tolerancji |
| checkpoint | round-trip test | referencja nie jest recaptured |
| fallback | forced GPU test | brak cichego CPU fallbacku |
| managed reproducibility | `just verify-frozen-spins-fdm-cuda` | świeży, nieprzerwany przebieg w kontenerze |
| qualification matrix | aktualizacja dokumentu | każdy lane ma osobny status i evidence path |

`source_present`, `unit_pass`, `compile_pass` i `abi_pass` nie oznaczają
`runtime_pass`. `runtime_pass` nie oznacza `production_qualified`, jeśli brak
managed evidence, provenance albo parity.

## 21. Aktualizacja capability i dokumentacji

Po przejściu testów zaktualizuj:

- `docs/validation/frozen-spins-qualification-matrix.md` — osobno FEM CPU,
  FEM GPU, FDM CUDA FP64, FDM CUDA FP32, direct minimizers i multilayer;
- `docs/physics/0996-frozen-spins-constraint.md` — tylko jeśli zmieniły się
  równania, zakres backendu albo ograniczenia;
- `docs/specs/frozen-spins-v1.md` — backend support i provenance;
- capability matrix/OpenAPI, jeżeli publiczna deklaracja możliwości się zmienia;
- test/contract source map, jeśli dodano nowe źródła publicznego kontraktu.

Nie wpisuj `validated` bez ścieżki do artefaktu, dokładnej komendy, daty,
identyfikatora urządzenia i digestu binariów.

## 22. Końcowa procedura wykonawcza

Wykonaj dokładnie w tej kolejności:

1. utwórz failing tests dla malformed FEM descriptoru i CPU true-DOF step;
2. dodaj moduł FEM frozen runtime i import descriptoru;
3. podłącz projekcję CPU explicit RK, retry i rollback;
4. podłącz GPU explicit RK z device-resident maską/referencją;
5. dopiero wtedy zdejmij ogólny FEM guard i dodaj guardy algorytmowe;
6. uruchom testy ABI/layout/planner/runner;
7. zbuduj managed FEM runtime przez właściwą receptę `just` i uruchom CPU/GPU
   testy FEM;
8. dodaj/uruchom realny FDM CUDA runtime contract;
9. rozszerz i uruchom `just verify-frozen-spins-fdm-cuda`;
10. porównaj CUDA z FDM CPU oracle;
11. wykonaj checkpoint/resume i forced-GPU no-fallback;
12. zapisz evidence JSON i dopiero wtedy aktualizuj qualification matrix.

Po każdym kroku, który nie przechodzi, napraw przyczynę. Nie maskuj błędu
warunkiem testu ani nie obniżaj tolerancji bez uzasadnienia fizycznego i
numerycznego.

## 23. Warunek zakończenia pracy

Punkt 1 jest ukończony dopiero, gdy co najmniej jeden jawnie opisany lane FEM
CPU i jeden lane FEM GPU rzeczywiście konsumują true-DOF mask/reference,
przechodzą test aktywacji, stage, retry, rollback i provenance, a nieobsługiwane
lane'y odrzucają się precyzyjnie.

Punkt 2 jest ukończony dopiero, gdy FDM CUDA single-grid FP64 przechodzi realny
managed device runtime test, CPU/GPU oracle, checkpoint round-trip i brak
fallbacku, a `just verify-frozen-spins-fdm-cuda` kończy się sukcesem na świeżym
buildzie. Sam fakt, że kod CUDA istnieje albo capability bit jest niezerowy,
nie spełnia tego warunku.

Jeżeli Docker, CUDA, MFEM albo managed runtime są niedostępne, zakończ raport
statusem `BLOCKED`, podaj dokładny błąd i listę niewykonanych gate'ów. Nie
przepisuj `BLOCKED` na `QUALIFIED` na podstawie testów hostowych.
