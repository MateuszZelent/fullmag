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

## Przygotowany obraz aktualizacji

Przygotowano overlay dokładnego wdrożonego obrazu koordynatora
`sha256:9923f33b147b52b6534a9f2161bf4a00c4b138679575035676bffb52512da0db`.
Patch P8-38 zastosowano do jego rzeczywistego pliku, zamiast zastępować
rozszerzony entrypoint wersją trzech profili. Porównanie AST potwierdza
zmiany wyłącznie funkcji `preflight` i `toolchain_versions`; wszystkie
stałe modułu, w tym osiem definicji profili, pozostają identyczne.

Obraz wynikowy:
`sha256:1aa31b600114e35dac112821bfe0ee1317a00641077bf4ecee546e0747550665`.
Entry point SHA256:
`d11fe9904dda341eb4735d818de7546ed5a8978a6f7d97cf1d963fccbb329e19`.
Pakowanie wykonuje wyłącznie COPY, z `--network none --pull=false`, bez
kompilacji i instalacji. Pierwsza próba FROM z samym image ID została
odrzucona przez resolver BuildKit; osobny lokalny tag zweryfikowano względem
tego samego immutable ID przed udanym pakowaniem.

Import modułu, hash i zachowane profile sprawdzono w obrazie. Cztery
interpretowane regresje sond, uruchomione przeciw jego entrypointowi:
PASS, exit 0. Evidence:
`storage/runs/fullmag-0950f4dca4ffe38f/nightly-runner-overlay/c46eb301e1b34672b7cd7d948c89204d/verification.json`.

Obraz jest przygotowany, nie wdrożony. Po zakończeniu 215 koordynator
uruchomił cudzy build 216 `fem-cpu-slepc-runtime-v2`; health potwierdza żywe
zadanie. Nie wstrzymano go ani nie wymieniono koordynatora. Wymiana
wymaga rzeczywistego zakończenia aktywnych prac oraz paused/stopped health
z pustym `active_jobs`, zgodnie z istniejącą granicą `container-replace`.
