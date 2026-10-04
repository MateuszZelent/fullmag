# P6-62 — aktualność źródeł natywnego buildu

Data: 01.10.2026. Baza: `ff23b7ef7b6ca6bd308c5023f05dd11dbe21ca0d`.
Status: przyczyna wykazana, poprawka źródłowa; managed build po poprawce **NOT VERIFIED**.
P6 około **52%**, cały P0–P8 około **49%**.

## Przyczyna i dowody

Build 189 (`529ac93e81744c5faf50494306d50a11`) zakończył się sukcesem
dla P6-55; 113 artefaktów przeszło kontrolę długości i SHA256. Build 191
(`78d0c52ecb0245aa85f9411d76f8b914`, commit
`e56041781b439b23f47bbcceed43aaf54f39c708`) zakończył się exit 2.
Drugie wywołanie Cargo zgłosiło brak modułów i pól P6-57–59, mimo ich
obecności w zweryfikowanej kopii źródeł.

Oba joby korzystały kolejno z tego samego targetu lane'u FEM CPU.
Materializacja kapsuły przez `copy2` zachowała czasy źródeł sprzed
zbudowania wcześniejszych zależności. Fingerprinty stosowały `mtime`.
Stare metadata `fullmag-quantities` (`4b0f9af0ffd71518`) i `fullmag-ir`
(`4593a1d21fa1f189`) pochodziły z 12:21/12:22 UTC; ich dep-info nie
zawierało nowych modułów. Nowe warianty (`cb8932aced44b171`,
`346c2be8c56086d5`) z 13:11/13:12 UTC zawierały je. Drugie wywołanie
Cargo wybrało stare warianty. Nie była to jednoczesna kolizja buildów.

Decydujące pliki pod resolved storage:
`builds/fullmag-0950f4dca4ffe38f/runner-fem-cpu-release-e9b8ec88b9a9/cargo-targets/fem-cpu/release/build/`.
Każdy wariant ma `<crate>/<fingerprint>/fingerprint/lib-<crate>.json`
i `<crate>/<fingerprint>/out/<crate>-<fingerprint>.d`. Dla tej wersji
Cargo nie należy zakładać dawnego układu `release/.fingerprint`/`deps`.

Ten mechanizm odpowiada opisanej przez Cargo kontroli aktualności
[path dependencies przez mtime](https://doc.rust-lang.org/stable/nightly-rustc/cargo/core/compiler/fingerprint/index.html).

## Poprawka

- Trusted entrypoint kopiuje pliki przez `shutil.copy`: zachowuje treść
  i uprawnienia, ale prywatna kopia otrzymuje aktualny czas modyfikacji.
  Niezmienna kapsuła pozostaje nietknięta.
- `install-cli*` przed Cargo uruchamia helper zgodności dla obecnego
  wdrożonego koordynatora. Działa wyłącznie przy zgodnym fizycznym
  `FULLMAG_RUNNER_WORKSPACE`, bez `.git`, z wymaganymi mountpointami.
  Waliduje całe `crates/` przed zmianą; odrzuca linki, junctions i pliki
  specjalne. Odświeża tylko mtime regularnych plików prywatnych źródeł.
- Bez zmiennej managed workspace helper niczego nie zmienia. Nie usuwa
  cache, nie tworzy targetu per SHA, nie zmienia profili ani koordynatora.
  JSON z zakresem i liczbą plików trafia do logu etapu native-build.

Commit entrypointu nie oznacza automatycznego wdrożenia trusted workera.
Most w wersjonowanym Makefile pozwala użyć poprawki przez zwykłą kapsułę
źródłową, bez restartu koordynatora lub zmiany konfiguracji operatora.

## Weryfikacja i pozostałe kroki

7 testów helpera i 16 testów entrypointu PASS, bez kompilacji Rust/C++.
Kontrole obejmują zachowanie treści/uprawnień, aktualny mtime kopii,
niezmienność kapsuły/cache, brak zmian checkoutu oraz odmowę niezgodnego
workspace, brakujących mountpointów i linków. Repo consistency PASS.
Independent review bez P0/P1. Uwagi P2 usunięte: opis helpera oraz
wykrywanie Windows reparse points również na Pythonie sprzed 3.12.

Build 192 (`5d750ed66e584869ab6e88e48c457c86`) pozostaje queued, nie
został ponowiony ani anulowany. Health koordynatora z 13:45 UTC:
`worker_alive=false`, `worker_state=paused`, `accepting_jobs=false`;
graceful stop został zamówiony przez operatora Mateusz o 13:09 UTC.
Brak aktywnych jobów. Wznowienie wymaga rozstrzygnięcia tego jawnego stopu.

Po wznowieniu: clean commit build obejmujący P6-60–62, kontrola terminalnego
receiptu i artefaktów, następnie rzeczywisty accepted FEM snapshot oraz
trasa archive roundtrip P6-61. Te bramki, renderer, nauka, GPU i release
pozostają otwarte. Poprawka infrastruktury nie podnosi procentu planu.
