# P8-53CA — zależności frontendu z utrwalonego snapshotu

Data: 14.10.2026. Baza `49c0be12ffe4fc427d55cd59d0559c7c0eb994cd`.
Status: **interpreted regression PASS; production source TS7 PASS**.

## Konkretna blokada

`validate_dependency_workspace` odrzucał autentyczny staging nowego natywnego
buildu: jego `source_root` jest w `source-snapshots/<id>/source`, a walidator
wymagał bezwarunkowo ścieżki bieżącego checkoutu. Produkcyjny staging jest
niezmienionym konsumentem `stage_workspace_frontend`; nie można osłabiać
containment albo ignorować odmowy, aby korzystać z jego nowych zależności.

Nowa ścieżka frozen wymaga pełnego trzy-polowego pina, poprawnych absolutnych
ścieżek, pełnego `verify_snapshot(..., force_verify=True)`, zgodnego origin repo
i worktree ID, canonical profiled build root oraz dokładnych record/source/
inventory. Filesystem selection pozostaje odrębną ścieżką źródeł z repo-root;
nie przyjmuje pina frozen. Oba warianty dalej porównują bieżące package/lock
do stagingu bajtowo, odrzucają przekierowania i zachowują tożsamość stage.

## Granica zaufania i kwalifikacji

To weryfikator **read-only reuse zależności dla świeżych źródeł checkoutu**.
Kopiuje kod aplikacji z bieżącego repo do nowego source-check stage;
nie używa dawnego kodu aplikacji ze stagingu jako bieżącego źródła.
Deklaracja filesystem selection w lokalnym manifeście nie jest uwierzytelnionym
dowodem historii instalacji. Zmiana samego manifestu jest widoczna w jego
SHA-256; weryfikator nie zapewnia odporności na uprzywilejowanego właściciela
filesystemu zmieniającego metadane i biblioteki. Snapshot pin jest weryfikowany
wtedy, gdy workspace deklaruje frozen selection. Receipts mają
`qualification=not_assessed`; nie dowodzą źródeł natywnego runtime, nauki,
builda backendu ani gotowego pakietu. Ich dowód dotyczy świeżo kopiowanych
źródeł, zgodnych inputów zależności i stabilności wybranego stagingu.

## Weryfikacja i otwarte bramki

- Pierwszy managed suite `a686103a357447a29f3b09a5d87d23ac`: failed,
  16 błędów setUp przez odziedziczony `FULLMAG_BUILD_STORAGE_ROOT`;
  nie wykonano ciał testów. Resolvera produkcyjnego nie poluzowano.
- Po izolacji fixture env: `344508df6f9e4b30b923e59ac3f74ecc`,
  completed / exit 0, **16/16**, zero pominiętych; source before=after
  `37c0ae0471f44afe9bca66bb2080a6c89eafdc8576d599e057e90d12dd92eafc`.
  Regresje tworzą rzeczywiste snapshoty i staging, obejmują legacy, frozen,
  tamper/redirect, obcy checkout i drift package/lock.
- Review rozszerzyło izolację do wszystkich `MANAGED_VARIABLES`, aby fixture
  nie dziedziczył managed-native/EXT4 flag z hosta Linux. PATH i TMP pozostają;
  fixture leży w kontrolowanym temp. Nowy wynik tej końcowej izolacji jest wymagany.
  Końcowa seria `a435001e80c146289ce0e9eb85a15f97`: completed / exit 0,
  **16/16**, zero pominiętych; source before=after
  `3548c9f888e997d5b9a4c875829d6ee5b76c077562eb3c74266d69deedb9fc9f`.
- Autentyczny staging `bf5ab8e5bde4464c8620f3704e0199d5` ze snapshotu `6c3ce36d`
  przeszedł walidację; produkcyjny typecheck TS7 PASS `00a38ea0`.
- Stały source wrapper obsługuje również lint na weryfikowanych natywnych
  zależnościach. Nie emituje ani nie kompiluje testów. Świeży lint wykazał
  problem peer API TS7 opisany w [53BZ](53bz-typed-authoring-and-browser-buffer-contracts.md).

Nowy suite `frontend-workspace` w `verify_development_handoff.py` ma zamknięty
wzorzec testów i fingerprint walidatora, stagingu, testu, snapshotu i source
identity. Nie zastępuje kwalifikacji pełnego builda, runtime ani przeglądarki.
**P8 i cały plan pozostają IN PROGRESS; procentów nie podniesiono.**
