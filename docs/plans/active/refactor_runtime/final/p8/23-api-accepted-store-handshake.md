# P7-C / P8 — handshake accepted store API

Data: 03.10.2026. Kontynuacja [etapu 22](22-native-ui-service-binding.md).

HTTP /v2/platform/openapi.json zawiera runtime-only vendor extension
x-fullmag-runtime-store-binding ze schematem runtime_store_binding.v1,
kind=accepted_runs i opaque binding albo null. Wartość pochodzi z rzeczywistego
AppState.submit_store_root API. Static generator dokumentu nie ma tego runtime
state i nie deklaruje wykonanego bindingu.

Binding to domenowo wersjonowany SHA-256 kanonicznej, zwalidowanej ścieżki
hosta, zapisanej bez utraty znaków Windows/Unix. Nie ujawnia fizycznej ścieżki,
nie jest identyfikatorem przenośnego projektu ani dowodem zawartości/wykonania.
Jest stabilny przed i po inicjalizacji brakującego katalogu bez linków.
Nie służy do takeover, kwalifikacji solvera ani obejścia native lock.

Wspólny klient sprawdza kontrakt, pełny commit/snapshot oraz binding API przed
inicjalizacją store i start/attach. Niezgodny, brakujący albo null binding
odmawia podłączenia. Kontrolę powtarza się po potencjalnie długim starcie usługi.
CLI nadal wymaga własnego procesu API: binding jest obserwacją, nie lease
instancji. Reuse pozostaje zablokowany do czasu przypięcia instancji także w
kolejnych żądaniach klienta. Desktop używa tej samej bramki dla własnego sidecara.
Brak konfiguracji runtime nadal pozostawia authoring dostępny.

## Dowody

- Parser/format zmienianych źródeł oraz scoped diff check PASS.
- Regresje Rust zapisano dla bindingu AppState bez inicjalizacji, braku store,
  foreign store przy zgodnym buildzie i stabilności identyfikatora po mkdir.
- Unit tests nie kompilowano ani nie uruchomiono zgodnie z zakazem operatora.
- Typecheck, rzeczywisty HTTP/API/service i Windows: NOT VERIFIED.
- Review wykrył ryzyko zmiany procesu API po obserwacji. Zachowano fresh-process
  ownership i końcowy recheck; nie uznano bindingu za wykonany lease instancji.
- Końcowy re-review poprawionych źródeł: brak P0/P1. Persistent instance lease
  pozostaje jawnym kolejnym obowiązkiem, bez deklaracji kwalifikacji runtime.

## Stan infrastruktury buildów

Odczyt istniejącego runnera: worker_alive=true, accepting_jobs=true,
active_jobs=[], storage_free_bytes=6756581376 i waiting_for_disk. Job 212
2d488f2a1de547d4be78e105db346d33 nadal queued, exit_code=null; ma starszy SHA
75ab6fe297d116657bcf67f1f321f4fd47e66fd0. Nie jest dowodem bieżącego kodu.
Nie zlecono drugiego ciężkiego buildu ani nie kasowano współdzielonych danych.
Managed Linux build nie jest dowodem ani zależnością natywnego produktu Windows.

Do wykonania pozostają domyślne wykrycie i konfiguracja zasobów produktu,
cutover UI execution, recovery/Job Objects oraz wszystkie wymagane bramki
runtime, nauki i wydania. Cały plan pozostaje aktywny; sesję 3104 zachowano.
