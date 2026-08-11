# Raport GPU D-07 runtime

## Wynik

Najwyższa luka D-07 opisana w briefie jest już zaimplementowana w bieżącej
bazie kodu. Natywny hot loop CUDA dla kwalifikowalnego lane'u `identity`:

- utrzymuje osobne widma źródeł i celów na urządzeniu;
- wykonuje jedną batched XYZ forward FFT na każdą z `L` warstw źródłowych;
- zeruje widmo każdego celu przed akumulacją;
- wykonuje dokładnie `L^2` uporządkowanych akumulacji tensorowych;
- wykonuje jedną batched XYZ inverse FFT na każdą z `L` warstw docelowych;
- uruchamia push, cuFFT, akumulację, inverse i pull na jednym compute streamie
  należącym do `Context`;
- publikuje liczniki przez `fullmag_fdm_step_stats`, wrapper Rust i
  `FdmMultilayerStageTelemetry`;
- odrzuca niepełny lub zduplikowany katalog par, brak rezydentnego workspace,
  PBC i nieznany transfer przed dispatch, bez cichego przejścia do innego lane'u.

`device_resident_per_refresh` opisuje wyłącznie natywny sub-lane CUDA pomiędzy
push, FFT, pair accumulation, IFFT i pull. Nie oznacza rezydencji całego
wykonania: także dla `identity` runner `NativeMultilayerDemagOperator` przed
refresh wysyła `m` na urządzenie, a po refresh kopiuje `H_demag` na host.
Globalna proweniencja pozostaje więc `cuda_assisted_multilayer`, dopóki cały
staged RK nie utrzymuje `m` i `H` na urządzeniu. `push_pull` również pozostaje
jawnie assisted i nie może publikować telemetrii D-07. Bezpieczna zmiana kodu
produkcyjnego wymagałaby szerszej przebudowy całego staged RK, wykraczającej
poza brief. Zgodnie z instrukcją fallback dodano tylko konkretny kontrakt
regresyjny po stronie publikowanej telemetrii Rust.

## Zmienione pliki

- `crates/fullmag-runner/src/fdm/gpu/cuda/native.rs`
  - zastąpiono pojedynczy pozytywny przypadek `L=3` macierzą kwalifikacyjną
    `L=1,2,4,8`;
  - dla każdego `L` sprawdzane są dokładne wartości `1`, `L`, `L`, `L^2`;
  - dla każdego `L` osobno wymuszono fail-closed po zaniżeniu lub zawyżeniu
    refresh, forward, inverse albo pair-accumulation countera.

Commit implementacyjny:
`3fb6fac48705c6e9f9c84640a86c471233a890a0`
(`test(fdm): enforce D-07 telemetry layer matrix`).

## Weryfikacja

1. Skupione testy Rust:

   ```text
   CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/gpu-d07-runtime \
   CARGO_INCREMENTAL=0 \
   cargo test -p fullmag-runner exact_metric_contract_tests:: --lib -- --nocapture
   ```

   Wynik: PASS, 10 testów, 0 błędów. Kompilacja zgłosiła wyłącznie istniejące
   ostrzeżenia `unused_mut`/`dead_code` poza zakresem zmiany.

2. Natywny kontrakt D-07 w repozytoryjnym kontenerze CUDA, uruchomiony
   diagnostycznie po zatrzymaniu pełnego recipe przed buildem:

   ```text
   batched demag FFT contract: PASS
   ```

   Target `batched_demag_fft_contract` został skonfigurowany i zbudowany z
   CUDA 12.4.131 przez profil `fem-gpu`.

3. `git diff --check`: PASS.

4. `cargo fmt --check -p fullmag-runner`: FAIL z powodu zastanego driftu
   formatowania w plikach poza zakresem zadania, między innymi
   `fdm/cpu/native_transport.rs`, `fdm/gpu/cuda/multilayer.rs` i `types.rs`.
   Nie zmieniano tych plików.

5. `just verify-fdm-multilayer-demag-contract`: BLOCKED przed uruchomieniem
   kontenera. Lokalne `just ensure-python` nie mogło utworzyć venv, ponieważ
   interpreter nie ma `ensurepip`/pakietu `python3.10-venv`. Nie zmieniano
   środowiska ani `justfile`; dokładny natywny target został następnie
   uruchomiony w kontenerze jak opisano wyżej.

## Pozostałe bramki

- Brak świeżego managed-device artifactu dla `cuda-fp64` i `cuda-fp32`.
- Nie wykonano publicznego Python -> runner E2E na urządzeniu ani parity pola i
  energii względem CPU oracle.
- `device_resident_per_refresh` nie kwalifikuje całego runnera jako
  device-resident; bieżący `identity` nadal wykonuje H2D `m` i D2H `H_demag`
  pomiędzy host-authoritative etapami RK.
- Nie wykonano runtime matrix `L=1,2,4,8`; dodany test chroni dokładność
  publikowanej walidacji liczników, a natywny test źródłowy chroni strukturę hot
  loopu, lecz oba pozostają dowodem kontraktowym.
- Nie wolno na tej podstawie deklarować produkcyjnej kwalifikacji GPU D-07.
