# P8-38 — wersje rzeczywistego toolchaina w receipt

Data: 03.10.2026. Status: źródła, regresje interpretowane i sondy narzędzi
PASS; wdrożenie entrypointu i odbiór nowego receipt **NOT VERIFIED**.

## Problem i zmiana

`Makefile` wykonuje managed Rust build przez `cargo +nightly`, natomiast
`scripts/local_runner/build_entrypoint.py` odczytywał wersje przez domyślne
`rustc --version` i `cargo --version`. Worker ma katalog roboczy `/workspace`,
gdzie zmaterializowany `rust-toolchain.toml` wybiera stable. Receipt mógł
więc opisywać inny kompilator niż build, a odczyt wersji mógł uruchomić
niezamierzony bootstrap domyślnego kanału. Pierwszeństwo override opisuje
[oficjalna dokumentacja rustup](https://rust-lang.github.io/rustup/overrides.html).

Preflight sprawdza teraz rzeczywiście uruchamialny nightly przez
`rustup run nightly rustc --version`, bez opcji instalacji. Sam wpis
dated nightly na liście toolchainów nie wystarcza do wykonania `+nightly`.
Odrzucane są nieudana sonda, pusty wynik i wersja bez sufiksu nightly.
Sondy receipt dla Rust i Cargo także używają jawnego `rustup run nightly`;
ich niezerowy exit lub timeout kończy etap przed Make, zamiast publikować
nieudaną obserwację jako dowód narzędzi udanego buildu. Profile i kontrole
CUDA/CMake pozostają zgodne z dotychczasowym kontraktem.

## Dowody

- 22 interpretowane regresje Python: PASS, exit 0. Nie kompilowano testów.
  Nowe przypadki obejmują dokładny kanał/no-install, receipt odporny na
  stable w źródłach oraz odmowę przy nieudanej sondzie Rust lub Cargo.
- Receipt kontroli: `storage/runs/fullmag-0950f4dca4ffe38f/nightly-receipt-check/a41f7048bd9648d79ee4b2ee3d799af6/receipt.json`;
  fixture i logi mają rozwiązaną granicę storage. Receipt przypina hashe
  dwóch zmienionych plików, nie kwalifikuje całego produktu.
- Dokładne nowe sondy w żywym workerze 215, exit 0:
  `rustc 1.101.0-nightly (0abfedbc7 2026-10-02)` oraz
  `cargo 1.101.0-nightly (f3865b2a4 2026-09-29)`.
- Niezależny scoped review: brak P0/P1; scoped diff check PASS.

Build 215 (`901bf4779f5848ebaf9900311dd4b9bd`) przeszedł przygotowanie
źródeł i rozpoczął produkcyjny etap `native-build`: żywe procesy Cargo/Rustc
oraz log kompilacji zależności. Nadal brak terminalnego wyniku; samo
rozpoczęcie nie dowodzi kompilacji zmienionych crate'ów ani kompletnego
pakietu. Build używa wcześniejszego, przypiętego trusted entrypointu — nie
modyfikowano pliku zamontowanego do aktywnego workera.

## Pozostała integracja

Po zakończeniu bieżących zadań trzeba zintegrować scoped zmianę z wdrożonym
entrypointem, zachowując rozszerzone profile obecnego runnera, i przypiąć
nowy trusted hash. Nie zastępować całego wdrożonego pliku wersją z mniejszą
allowlistą. Dopiero kolejny terminalny receipt z tym hashem dowodzi użycia
poprawionych sond w managed buildzie. Nie ponawiać aktywnego 215 z tego
powodu; jego wynik nadal może dostarczyć przypiętego API/OpenAPI.

Generacja transportu, status usługi w UI, scalar UI, browser, native Windows
i kwalifikacja lane'ów pozostają osobnymi otwartymi bramkami. Procenty
P0–P8 nie są podnoszone na podstawie tej kontroli środowiska.
