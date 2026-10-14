# P8-53CB — zgodny compiler API i natywny CLI frontendu

Data: 14.10.2026. Baza: `059d7a2e6330233fa75da6e5d97fc9d95cd4c109`.
Status: **production source TS7 PASS; lint PASS; interpretowane regresje CLI 5/5 PASS**.

## Przyczyna i poprawka

TypeScript 7 nie udostępnia starego compiler API używanego przez parser ESLint,
Next i generatory. Samo dodanie API 6 dla testów AST nie naprawia peer resolution
parsera. Zależność `typescript` wskazuje więc oficjalny `@typescript/typescript6`
6.0.2, a osobny `typescript-native` wskazuje natywny TypeScript 7.0.2.
CLI typechecku używa wyłącznie aliasu natywnego, bez fallbacku do API 6.
Checkery `verify_control_room_sources.py`, `verify_new_problem_browser.py`
i `windows/verify_workspace_browser.py` wskazują ten sam natywny CLI.

ESLint 10.12.0 ujawnił też użycie usuniętego `context.getFilename` w pluginie
React. Oficjalny `@eslint/compat` 2.1.1 opakowuje konfiguracje Next przez
`fixupConfigRules`; nie wyłączono żadnych reguł ani nie obniżono wersji ESLint.
Lockfile aktualizuje peer bindingi i nowe jawne zależności.

## Dowody i granice

- Staging zależności `421ba0cdea3c49c7be8bd37b65b32c95`, profil
  `windows-native-fdm-cpu-dev`: frozen install bez scripts, receipt
  `7883d8c43f284e0d98b1fe1aa39a777e`, PASS.
- Pełny lint: receipt `909b25eb4c18460b8b4da0660da1ce39`, exit 0,
  bez ostrzeżeń. Production source: receipt
  `898a6f7fef734e86ae6ea7f9fc7fc408`, exit 0, natywny TS7,
  unit sources wyłączone. Obie kontrole mają stabilny digest
  `a5954c330d77ae112ec0087c69f3de47f78d489e74cac4f736d48cf64f521009`.
- Interpretowane regresje Node: receipt `3c586fb82a134a6487b04c6929ab3c1f`,
  5/5 PASS. Obejmują brak fallbacku, brak bin, zachowanie next-env i błędy CLI.
- Dwa później poprawione checkery przeglądarkowe: Python parser PASS,
  diff check PASS; rzeczywistych prób przeglądarkowych nimi nie wykonano.
- Managed native build: CLI/API PASS, cały build FAILED podczas desktopu
  przez `os error 112` (brak miejsca); log
  `native-build-f2accc4855a741e78cca19a89fb466bb.log`.

Receipts leżą w kanonicznym storage, w odpowiednich profilach source-check,
dependency-prepare i native-dev. Wyniki nie dowodzą pełnego pakietu, wykonania
symulacji, WebGL, dwóch restartów A→B→C ani kwalifikacji naukowej.
**P8 i cały plan pozostają IN PROGRESS; procentów nie podniesiono.**
