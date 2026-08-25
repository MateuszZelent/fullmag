# Telemetryka transakcji kroku FDM GPU v1 — plan implementacji

> **Dla agentów wykonawczych:** WYMAGANA PODUMIEJĘTNOŚĆ: użyj `subagent-driven-development` (zalecane) albo `executing-plans`, realizując plan zadanie po zadaniu. Kroki używają składni checkbox (`- [ ]`).

**Cel:** Dodać wersjonowaną, niezależną od FSAL telemetrykę rzeczywistych transferów D2D i czasu rollbacku transakcji kroku FDM GPU oraz zachować ją bezstratnie w provenance.

**Architektura:** Natywny CUDA `Context` pozostaje jedynym właścicielem pomiarów, ponieważ tylko on zna zakończone kopie i granice synchronizacji. Getter C ABI zwraca bezalokacyjny snapshot; Rust FFI odwzorowuje layout 1:1, a runner mapuje go do osobnego obiektu provenance bez inferencji z ogólnych liczników transferów.

**Stos technologiczny:** C++17/CUDA, stabilny C ABI, Rust FFI, Serde, CTest, Cargo test.

## Ograniczenia globalne

- Nie zmieniać fizyki, algorytmów integratorów, klucza RNG ani semantyki commit/reject.
- `fullmag_fdm_step_transaction_telemetry_v1` jest osobnym ABI i nie rozszerza telemetryki FSAL.
- Getter nie może alokować, wywoływać CUDA ani synchronizować urządzenia.
- Pomiar czasu nie może dodawać żadnej synchronizacji CUDA.
- Przepełnienie lub niejednoznaczny transfer ustawia `accounting_valid = 0`.
- Buildy, cache i wygenerowane dowody trafiają wyłącznie pod `D:\fullmag-builds\audit1-fdm-gpu-trx`; nic z nich nie może zostać dodane do Git.

---

### Task 1: Zamrozić publiczny ABI C i Rust

**Pliki:**
- Modyfikuj: `native/include/fullmag_fdm.h`
- Modyfikuj: `crates/fullmag-fdm-sys/src/lib.rs`
- Modyfikuj: `backends/fdm/tests/fsal_retry_transaction_contract.cpp`

**Interfejsy:**
- Produkuje: `FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1`
- Produkuje: `fullmag_fdm_step_transaction_telemetry_v1`
- Produkuje: `fullmag_fdm_backend_get_step_transaction_telemetry_v1(fullmag_fdm_backend *, fullmag_fdm_step_transaction_telemetry_v1 *) -> int`

- [ ] **Krok 1: Dodać test RED publicznego kontraktu źródłowego**

W `fsal_retry_transaction_contract.cpp` dodać sprawdzenie, że nagłówek deklaruje osobną strukturę i getter, a struktura nie jest częścią `fullmag_fdm_fsal_telemetry_v2`:

```cpp
require(
    contains(header, "FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1") &&
    contains(header, "fullmag_fdm_step_transaction_telemetry_v1") &&
    contains(header, "fullmag_fdm_backend_get_step_transaction_telemetry_v1"),
    "step transaction telemetry must have an independent public ABI");
```

- [ ] **Krok 2: Uruchomić test i potwierdzić RED**

Uruchom:

```powershell
cmake -S backends/fdm -B D:\fullmag-builds\audit1-fdm-gpu-trx\fdm-contract -DFULLMAG_ENABLE_CUDA=OFF
cmake --build D:\fullmag-builds\audit1-fdm-gpu-trx\fdm-contract --target fdm_fsal_retry_transaction_contract
ctest --test-dir D:\fullmag-builds\audit1-fdm-gpu-trx\fdm-contract -R fdm_fsal_retry_transaction_contract --output-on-failure
```

Oczekiwane: FAIL z komunikatem `step transaction telemetry must have an independent public ABI`.

- [ ] **Krok 3: Dodać minimalny layout C**

W `native/include/fullmag_fdm.h` dodać dokładnie:

```c
#define FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1 1u
typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t accounting_valid;
    uint32_t reserved0;
    uint64_t capture_count;
    uint64_t rollback_count;
    uint64_t capture_d2d_bytes;
    uint64_t rollback_d2d_bytes;
    uint64_t rollback_latency_total_ns;
    uint64_t rollback_latency_max_ns;
    uint64_t accepted_step_index;
    uint64_t attempt_generation;
    uint64_t thermal_rng_draws;
    uint64_t stale_publication_count;
} fullmag_fdm_step_transaction_telemetry_v1;
```

Deklarację gettera umieścić obok getterów FSAL, lecz nie wewnątrz ich struktur.

- [ ] **Krok 4: Dodać test RED layoutu Rust i symbolu FFI**

W `fullmag-fdm-sys/src/lib.rs` najpierw dodać test oczekujący rozmiaru `96`, offsetu `capture_count == 16`, offsetu `stale_publication_count == 88` oraz dokładnej sygnatury funkcji.

```rust
assert_eq!(size_of::<fullmag_fdm_step_transaction_telemetry_v1>(), 96);
assert_eq!(offset_of!(fullmag_fdm_step_transaction_telemetry_v1, capture_count), 16);
assert_eq!(offset_of!(fullmag_fdm_step_transaction_telemetry_v1, stale_publication_count), 88);
let _query: unsafe extern "C" fn(
    *mut fullmag_fdm_backend,
    *mut fullmag_fdm_step_transaction_telemetry_v1,
) -> i32 = fullmag_fdm_backend_get_step_transaction_telemetry_v1;
```

- [ ] **Krok 5: Uruchomić test i potwierdzić RED**

Uruchom:

```powershell
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-fdm-sys step_transaction_telemetry_v1
```

Oczekiwane: błąd kompilacji, ponieważ typ i symbol Rust jeszcze nie istnieją.

- [ ] **Krok 6: Dodać minimalny typ i extern Rust**

Odwzorować wszystkie pola C jako `u32`/`u64` w `#[repr(C)]`, dodać stałą ABI oraz deklarację `extern "C"` bez wrappera i bez wartości domyślnych.

- [ ] **Krok 7: Potwierdzić GREEN kontraktu C i kompilacyjny GREEN layoutu Rust**

Powtórzyć CTest z kroku 2, a dla Rust uruchomić:

```powershell
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo check -p fullmag-fdm-sys --tests
```

Oczekiwane: CTest PASS i Rust check PASS. Pełny `cargo test` jest bramką Task 2 po dodaniu natywnej definicji gettera; Task 1 celowo zamraża deklarację i layout bez przesuwania implementacji runtime do warstwy ABI.

- [ ] **Krok 8: Commit**

Przed commitem uruchomić osobno `git diff --cached --name-only`. Commit:

```text
feat(fdm): define step transaction telemetry ABI
```

### Task 2: Mierzyć rzeczywiste capture i rollback w natywnym Context

**Pliki:**
- Modyfikuj: `backends/fdm/include/context.hpp`
- Modyfikuj: `backends/fdm/gpu/cuda/runtime/context.cu`
- Modyfikuj: `backends/fdm/api/c_api.cpp`
- Modyfikuj: `backends/fdm/tests/fsal_retry_transaction_contract.cpp`

**Interfejsy:**
- Konsumuje: `fullmag_fdm_step_transaction_telemetry_v1`
- Produkuje: `context_get_step_transaction_telemetry_v1(const Context &, fullmag_fdm_step_transaction_telemetry_v1 *) -> bool`
- Produkuje: monotoniczne, fail-closed liczniki w `Context`

- [ ] **Krok 1: Dodać test RED liczenia payloadu bez GPU**

Wyodrębnić czystą funkcję:

```cpp
bool context_step_transaction_payload_bytes(
    uint64_t cell_count,
    uint64_t scalar_bytes,
    bool include_abm_history,
    uint64_t &out_bytes);
```

Test ma oczekiwać `3 * cells * scalar_bytes` dla magnetyzacji, `12 * cells * scalar_bytes` dla ABM3 oraz `false` przy przepełnieniu.

- [ ] **Krok 2: Uruchomić CTest i potwierdzić RED**

Użyć komend z Task 1, kroku 2. Oczekiwane: brak funkcji lub niespełnione asercje payloadu.

- [ ] **Krok 3: Zaimplementować minimalną bezpieczną arytmetykę**

Funkcja ma używać istniejących checked helpers; `out_bytes` jest ustawiane wyłącznie przy sukcesie. Nie dodawać alokacji ani zależności CUDA.

- [ ] **Krok 4: Dodać test RED snapshotu telemetryki**

Utworzyć `Context`, ustawić liczniki na znane wartości, wywołać `context_get_step_transaction_telemetry_v1` i sprawdzić wszystkie pola, odrzucenie złego `abi_version` oraz złego `struct_size`. Test ma także dowodzić, że pola RNG/stale pochodzą z istniejących liczników `Context`.

- [ ] **Krok 5: Zaimplementować getter bez CUDA i alokacji**

Getter waliduje request, tworzy lokalny zero-initialized result, kopiuje liczniki oraz przypisuje output dopiero na końcu. Getter nie może wywołać żadnej funkcji `cuda*`.

- [ ] **Krok 6: Dodać test RED ścieżek capture/rollback**

Test kontraktu źródłowego ma wymusić:

```cpp
contains(runtime, "step_transaction_capture_d2d_bytes")
contains(runtime, "step_transaction_rollback_d2d_bytes")
contains(runtime, "steady_clock")
contains(runtime, "step_transaction_rollback_latency_total_ns")
contains(runtime, "step_transaction_rollback_latency_max_ns")
```

oraz brak nowego `cudaStreamSynchronize` poza istniejącymi granicami funkcji.

- [ ] **Krok 7: Zaimplementować accounting capture**

Po pełnym sukcesie kopii i synchronizacji obliczyć payload poprzez czystą funkcję, checked-add do `capture_d2d_bytes`, następnie checked-add do `capture_count`. Każda porażka arytmetyki ustawia `accounting_valid = false`.

- [ ] **Krok 8: Zaimplementować accounting rollback latency i bytes**

Rozpocząć `std::chrono::steady_clock` przed pierwszym istniejącym uporządkowaniem default stream. Po pełnym przywróceniu i istniejącej synchronizacji obliczyć nanosekundy, checked-add do total, zaktualizować max, bytes oraz count. Nieudany rollback ustawia `accounting_valid = false` i nie zwiększa count/bytes.

- [ ] **Krok 9: Dodać getter C ABI**

`fullmag_fdm_backend_get_step_transaction_telemetry_v1` zwraca `INVALID` dla null, `ABI` dla niezgodnego requestu i `OK` dla poprawnego snapshotu. CPU-only build ma zwracać `FULLMAG_FDM_ERR_CUDA`, zgodnie z sąsiednimi getterami natywnego Context.

- [ ] **Krok 10: Potwierdzić GREEN i brak regresji**

Uruchomić:

```powershell
ctest --test-dir D:\fullmag-builds\audit1-fdm-gpu-trx\fdm-contract -R "fdm_fsal_retry_transaction_contract|fdm_checkpoint" --output-on-failure
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-fdm-sys
```

Oczekiwane: PASS. Ten przebieg jest obowiązkowym link-time dowodem nowego gettera oraz istniejących deklaracji FFI po dodaniu natywnej definicji w Task 2.

- [ ] **Krok 11: Commit**

Commit:

```text
feat(fdm): measure GPU step transaction costs
```

### Task 3: Zachować telemetrykę bezstratnie w provenance runnera

**Pliki:**
- Modyfikuj: `crates/fullmag-runner/src/types.rs`
- Modyfikuj: `crates/fullmag-runner/src/fdm/gpu/cuda/native/residency.rs`

**Interfejsy:**
- Konsumuje: `ffi::fullmag_fdm_step_transaction_telemetry_v1`
- Produkuje: `FdmGpuStepTransactionTelemetry`
- Produkuje: `ExecutionProvenance::fdm_gpu_step_transaction_telemetry: Option<FdmGpuStepTransactionTelemetry>`

- [ ] **Krok 1: Dodać test RED serializacji provenance**

Test w `types.rs` tworzy rekord z niezerowymi wartościami i sprawdza dokładne klucze JSON:

```rust
assert_eq!(value["fdm_gpu_step_transaction_telemetry"]["capture_d2d_bytes"], 3072);
assert_eq!(value["fdm_gpu_step_transaction_telemetry"]["rollback_latency_max_ns"], 900);
assert_eq!(value["fdm_gpu_step_transaction_telemetry"]["attempt_generation"], 8);
assert_eq!(value["fdm_gpu_step_transaction_telemetry"]["accounting_valid"], true);
```

- [ ] **Krok 2: Uruchomić test i potwierdzić RED**

```powershell
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner execution_provenance_serializes_fdm_gpu_step_transaction_telemetry
```

Oczekiwane: błąd kompilacji z powodu braku typu/pola.

- [ ] **Krok 3: Dodać minimalny typ provenance**

Typ ma mieć wszystkie dziesięć pól pomiarowych ze specyfikacji, `Serialize`, `Deserialize`, `PartialEq`, `Eq`, bez pól wyliczanych i bez domyślnych zer udających dostępny receipt. Pole w `ExecutionProvenance` jest `Option` z `skip_serializing_if`.

- [ ] **Krok 4: Dodać test RED mapowania FFI**

W `residency.rs` zbudować natywną strukturę requestu, zasymulować wynik i sprawdzić mapowanie wszystkich pól. Osobny test ustawia `accounting_valid == 0` i wymusza zachowanie rekordu z `accounting_valid: false`, aby provenance jawnie dowodziło unieważnienia pomiaru zamiast publikować poprawne zera albo ukrywać rekord.

- [ ] **Krok 5: Zaimplementować zapytanie i mapowanie**

Dodać request z dokładnym ABI/size, wywołać getter po wykonaniu natywnej ścieżki i przypisać `Some(record)` po poprawnym ABI niezależnie od wartości `accounting_valid`; wartość `false` musi pozostać widoczna. Błąd samego gettera jest `RunError` z trwałym tokenem, nie parsowaniem tekstu backendu.

- [ ] **Krok 6: Potwierdzić GREEN runnera**

```powershell
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner fdm_gpu_step_transaction
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner fdm_gpu_execution_receipt
```

Oczekiwane: PASS.

- [ ] **Krok 7: Commit**

Commit:

```text
feat(runner): publish FDM GPU transaction telemetry
```

### Task 4: Weryfikacja końcowa i dowód braku artefaktów Git

**Pliki:**
- Modyfikuj tylko w razie potrzeby korekty źródłowej: pliki z Task 1–3
- Nie twórz w repozytorium żadnych wyników buildów ani raportów generowanych

**Interfejsy:**
- Konsumuje: pełny kontrakt z Task 1–3
- Produkuje: dowód spełnienia telemetrycznej części `FDM-GPU-TRX-001`

- [ ] **Krok 1: Uruchomić formatowanie i testy kontraktowe**

```powershell
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo fmt --all -- --check
ctest --test-dir D:\fullmag-builds\audit1-fdm-gpu-trx\fdm-contract --output-on-failure
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-fdm-sys
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner
```

Oczekiwane: wszystkie testy PASS. Jeśli globalny `cargo fmt` ujawni pre-existing drift poza zakresem, uruchomić `rustfmt --check` na zmienionych plikach i udokumentować oba wyniki bez modyfikowania obcych plików.

- [ ] **Krok 2: Uruchomić dostępny test CUDA**

Jeżeli host ma CUDA i istniejący target testowy jest dostępny, skonfigurować osobne drzewo `D:\fullmag-builds\audit1-fdm-gpu-trx\fdm-cuda`, uruchomić test fault-injection/retry i zapisać wynik wyłącznie poza repo. Brak urządzenia oznaczyć jako brak runtime proof, nigdy jako PASS.

- [ ] **Krok 3: Audyt indeksu i artefaktów**

Uruchomić osobno:

```powershell
git diff --cached --name-only
git status --short
git ls-files | rg "(^|/)(target|dist|build|coverage|node_modules|__pycache__)(/|$)|\.pyc$|\.pyo$"
```

Oczekiwane: indeks zawiera tylko zamierzone źródła/dokumenty; ostatnia komenda nie wykazuje nowo dodanych artefaktów.

- [ ] **Krok 4: Finalny commit korekt weryfikacyjnych, jeśli wystąpiły**

Przed commitem ponownie osobno sprawdzić `git diff --cached --name-only`. Nie commitować, jeśli nie ma korekt źródłowych.

- [ ] **Krok 5: Integracja do mastera**

Po review i zielonych bramkach zaktualizować `D:\git\fullmag` przez `git pull --ff-only`, następnie zintegrować zweryfikowane commity bez indeksowania nieśledzonych planów lub buildów. Po integracji potwierdzić, że commit implementacyjny jest przodkiem `master` i że `master == origin/master` dopiero po autoryzowanym pushu.
