# C3 — certyfikaty i zamrożenie ABI modalnego

Status: `DONE_WITH_CONCERNS`.

## Zakres wykonany

- Zachowano ABI v16 i rozszerzono append-only `fullmag_fem_frequency_domain_abi_layout` o manifest rozmiaru oraz offsetów modalnego requestu, payloadu shared-domain, wyniku i wszystkich pól widoku CSR.
- Rust FFI deklaruje ten sam layout i sprawdza offsety C++/Rust dla modalnego requestu, payloadu, wyniku oraz CSR.
- Granica `fullmag_fem_modal_eigen_solve` jest fail-closed dla krótkiego requestu/payloadu, nieznanych enumów, niezgodnego schema request–payload oraz nieprawidłowych identyfikatorów certificate/map-binding/equilibrium/boundary/bias.
- Sprawdzane są obowiązkowe mapy redukcji, mesh/boundary identity, pair counts i marker airbox przed wejściem do solve. Odrzucenie publikuje stabilny token i `fallback=none`.
- `FrequencyDomainContractResult` przenosi resolved provenance; C ABI publikuje engine/fallback zamiast kopiować requested fields jako pozornie resolved.
- Destroy wyniku pozostaje bezpieczny dla `nullptr`, wyniku wyzerowanego, częściowej alokacji i drugiego wywołania.
- Rustowy initializer FFI wypełnia wyłącznie nowe append-only pola payloadu; bez zmiany orkiestracji ani solvera.

## TDD

RED: dodano negatywne testy native dla request–payload schema mismatch, stale/invalid certificate digest, krótkiego payloadu, unavailable resolved provenance i partial/double destroy. Recepta native została uruchomiona przed deklarowaniem GREEN, ale nie osiągnęła kompilacji testu z powodu legalnej blokady eksportu runtime opisanej niżej.

GREEN lokalny:

```text
env CARGO_TARGET_DIR=/dev/shm/fullmag-c3-target CARGO_INCREMENTAL=0 \
  cargo check -p fullmag-fem-sys --quiet
exit 0

env CARGO_TARGET_DIR=/dev/shm/fullmag-c3-target CARGO_INCREMENTAL=0 \
  cargo check -p fullmag-runner --quiet
exit 0
```

`cargo check -p fullmag-runner` wypisał wyłącznie wcześniej istniejące ostrzeżenia o nieużywanych zmiennych/kodzie poza C3.

## Wymagane testy i blokery

```text
just verify-fem-frequency-domain-native-contract
```

Recepta weszła do `just ensure-managed-fem-runtime`, wykryła nieaktualny bundle i zatrzymała się na istniejącym eksporcie:

```text
[export_fem_gpu_runtime] waiting for existing runtime export to finish
```

Proces eksportu i jego blokada pozostały nietknięte. To blokada managed-runtime przed CMake/testem, nie wynik C3.

```text
env CARGO_TARGET_DIR=/dev/shm/fullmag-c3-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-fem-sys --quiet
```

Nie linkuje bez dostępnej biblioteki native: `fullmag_fem_get_frequency_domain_abi_layout` oraz dwa istniejące symbole native są unresolved. Hostowy test Rust nie jest zastępstwem dla recepty kontenerowej.

```text
env CARGO_TARGET_DIR=/dev/shm/fullmag-c3-target CARGO_INCREMENTAL=0 \
  cargo test -p fullmag-runner native_fem --quiet
```

Zatrzymuje się przed testami C3 na 31 niepowiązanych błędach: brakuje `bias_field_samples` w istniejących initializerach `FemEigenPlanIR` w `dispatch.rs`, `eigen/orchestrator.rs`, `fem_eigen.rs` i `tests/physics_validation.rs`. Nie zmieniano ich poza zakresem C3.

`git diff --check` dla plików C3: exit 0.

## Granica kwalifikacji

Zmiana domyka kontrakt ABI i testy negatywne w źródle, ale nie stanowi kwalifikacji CPU/GPU/MFEM/SLEPc ani produkcyjnego proof runtime. GREEN native pozostaje do ponowienia po zwolnieniu eksportu i naprawie niezwiązanych initializerów testowych.
