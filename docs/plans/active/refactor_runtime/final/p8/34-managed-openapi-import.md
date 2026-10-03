# P8-34 — import OpenAPI z przypiętego buildu

`generate-openapi-v2.mjs` ma jawną trasę importu raw JSON wyeksportowanego przez
produkcyjne `fullmag-api --print-openapi-v2`. Wymaga absolutnego pliku,
oczekiwanego commita 40 lowercase hex i SHA-256 snapshotu z managed receipt.
Przed normalizacją porównuje raw build identity i wymaga clean source.
Znormalizowany kontrakt, stary commit, inny snapshot, dirty lub brak identity
są odrzucane. Nie wykonuje wtedy Cargo ani zastępczej generacji.

Plik wejściowy jest ograniczony do 64 MiB i zwykłego pliku, sprawdzanego przed
open i z uchwytu. Unix open jest nonblocking/no-follow. Ścieżka i przodkowie
pozostają zaufanymi artefaktami operatora; nie deklarujemy ochrony przeciw
hostile replacement całego drzewa. Publikacja canonical JSON następuje dopiero
po walidacji i normalizacji przez istniejący atomowy rename.

## Użycie po sukcesie buildu

Najpierw potwierdź terminalny succeeded, receipt, przypięte źródła i hash binarium.
Wyeksportuj raw OpenAPI z tego binarium do katalogu runu w kanonicznym storage.
Wywołaj generator z `--input <absolute-raw-json>` oraz
`--expected-commit <receipt-full-sha> --expected-snapshot <receipt-snapshot-sha256>`.
Następnie użyj istniejącej zarządzanej trasy generate-client i kontroli źródeł.
Sam import nie weryfikuje binarium ani receipt i nie zastępuje tych kroków.
Bez parametrów zachowuje istniejący tryb Cargo codegen; na hoście enrolled nie
uruchamiaj tego ciężkiego trybu poza dopuszczoną kolejką.

## Dowody

- Sześć interpretowanych testów Node: PASS; żadnej kompilacji unit tests.
- CLI odrzuca niekompletne parametry i normalized/stale input: PASS;
  hash istniejącego canonical kontraktu pozostaje identyczny, bez Cargo fallback.
- Node parser i scoped diff check: PASS.
- Zarządzany lint po poprawce: PASS, exit 0, bez zmian źródeł w trakcie;
  receipt lint/a4213c3457b84f50a17edf5f9b016aa0/receipt.json.
- Review wykrył akceptację commitów 64-znakowych sprzeczną z obecnym
  fullmag-build-info. Regresja odtwarzała błąd; validator zawężono do 40 hex.
  Re-review: PASS, P1 zamknięty, brak otwartych P0/P1 w tym zakresie.
- Realny eksport/import buildu 214 oraz generated klient/UI: NOT VERIFIED,
  zadanie nadal czeka w kolejce. Nie opublikowano fixture jako kontraktu.

Nie zmienia to wymagania niezależnego produktu Windows ani kwalifikacji lane'ów.
Plan P0–P8 pozostaje otwarty; UI3104 i współdzielone cache zachowano.

## Następny konsument kontraktu

Po rzeczywistej generacji dodać typed path i alias komponentu w apiPaths/apiTypes,
`api.platform.runtimeService` w ControlRoomApi i platformowy resource hook obok
usePlatformHealthResource. Klucz nie może być session-scoped. W Explorerze dodać
oddzielny diagnostics.runtime-service i odpowiadający panel Inspectora; nie łączyć
go z API health. New/Open/Save/Close pozostają w istniejącej polityce project
commands, bez warunku Ready usługi. Gotowość usługi nie potwierdza solvera/GPU.
