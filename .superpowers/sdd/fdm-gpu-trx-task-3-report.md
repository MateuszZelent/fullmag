# Task 3 — telemetryka transakcji FDM GPU w provenance

## Status

DONE

## Zmodyfikowane pliki

- `crates/fullmag-runner/src/types.rs`
  - dodano `FdmGpuStepTransactionTelemetry` z flagą ważności i dziesięcioma
    licznikami ABI;
  - dodano opcjonalne pole
    `ExecutionProvenance::fdm_gpu_step_transaction_telemetry`, pomijane w JSON
    wyłącznie, gdy rekordu nie ma;
  - dodano test serializacji JSON.
- `crates/fullmag-runner/src/fdm/gpu/cuda/native/residency.rs`
  - dodano request ABI v1, walidację odpowiedzi, wywołanie gettera i mapowanie
    wszystkich pól;
  - po natywnej ścieżce wykonania rekord jest przypisywany do provenance przed
    aktualizacją artefaktów;
  - błędy gettera mają stabilne tokeny
    `fdm_gpu_step_transaction_telemetry_query_failed` oraz
    `fdm_gpu_step_transaction_telemetry_abi_mismatch`;
  - dodano testy requestu, mapowania i nieważnego accounting.
- `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs`
- `crates/fullmag-runner/src/artifacts.rs`
- `crates/fullmag-runner/src/interactive_runtime.rs`
  - dodano wymagane jawne `None` do istniejących pełnych literałów
    `ExecutionProvenance`; jest to konieczne po dodaniu pola struktury i nie
    zmienia semantyki tych ścieżek.

## RED / GREEN

RED:

```powershell
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner execution_provenance_serializes_fdm_gpu_step_transaction_telemetry
```

Wynik: FAIL zgodnie z oczekiwaniem — `FdmGpuStepTransactionTelemetry` i pole
`fdm_gpu_step_transaction_telemetry` nie istniały.

RED mapowania:

```powershell
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner --features cuda fdm_gpu_step_transaction_telemetry_maps_all_fields
```

Wynik: FAIL zgodnie z oczekiwaniem — brakowało requestu i funkcji mapowania
FFI. Ten przebieg ujawnił też pięć pełnych literałów `ExecutionProvenance`,
które muszą jawnie podać nowe pole.

GREEN:

```powershell
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner execution_provenance_serializes_fdm_gpu_step_transaction_telemetry
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner --features cuda fdm_gpu_step_transaction
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner fdm_gpu_step_transaction
$env:CARGO_TARGET_DIR='D:\fullmag-builds\audit1-fdm-gpu-trx\cargo'; cargo test -p fullmag-runner fdm_gpu_execution_receipt
```

Wyniki: PASS odpowiednio 1, 3, 1 i 2 testy jednostkowe; wszystkie uruchomione
binaria integracyjne nie miały testów dopasowanych do filtra i zakończyły się
sukcesem.

## `accounting_valid=false`

Odpowiedź FFI z `accounting_valid == 0` jest zawsze mapowana do
`Some(FdmGpuStepTransactionTelemetry { accounting_valid: false, ... })`.
Rekord pozostaje w provenance i serializuje `accounting_valid: false` wraz z
wartościami liczników. Nie jest zastępowany zerami ani ukrywany. `Some(...)`
powstaje wyłącznie po poprawnym statusie gettera i poprawnej odpowiedzi ABI.

## Self-review

- Request wysyła dokładne `abi_version` i `struct_size`; odpowiedź waliduje oba
  pola przed publikacją.
- Mapowanie obejmuje flagę ważności, capture/rollback, bajty D2D, latencje,
  indeks zaakceptowanego kroku, generację próby, RNG i stale publication.
- Nie zmieniono kodu C/CUDA, fizyki, dispatchu ani liczników transferów.
- Błąd gettera nie zależy od tekstu backendu i na udanej ścieżce wykonania
  kończy run kontrolowanym `RunError` ze stabilnym tokenem. Pierwotny błąd
  solvera pozostaje priorytetem.

## Stan git i artefakty

- Cache i wyjścia Cargo: wyłącznie
  `D:\fullmag-builds\audit1-fdm-gpu-trx\cargo`.
- W worktree nie utworzono katalogu `target/`, cache ani wygenerowanych
  artefaktów do śledzenia przez Git.
- Zastany zmodyfikowany plik `.superpowers/sdd/progress.md` pozostaje nietknięty.
- `cargo fmt --all -- --check` wykazał istniejące różnice formatowania w wielu
  niepowiązanych plikach (m.in. `fullmag-api`); nie wykonano globalnego
  formatowania.

## Commit

`feat(runner): publish FDM GPU transaction telemetry`
