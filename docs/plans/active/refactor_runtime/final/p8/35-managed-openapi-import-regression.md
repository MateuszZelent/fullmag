# P8-35 — pełna regresja polecenia importu kontraktu

Dodano `just verify-control-room-openapi-import` i stałą trasę źródłową
`openapi-import-check`. Node interpretuje testy bez Cargo, TypeScript bundling
ani kompilacji unit tests. Istniejąca blokada profilu, fingerprint i receipt
obejmują całą kontrolę. Receipt jawnie oznacza interpreted_node_only_no_compilation.

Fixture otrzymuje własny katalog pod managed run root w kanonicznym storage.
Kopiuje tylko dwa narzędzia generatora i tworzy osobny docelowy JSON; nie zmienia
repozytoryjnego canonical kontraktu. Child PATH nie zawiera Cargo, a timeout 10 s
ogranicza obserwację polecenia. Fixtures pozostają jako dowód, bez cleanupu cache.

## Weryfikacja

Jedenaście kontroli PASS, exit 0, źródła nie zmieniły się w trakcie:
receipt openapi-import-check/4704d70a253c411cb4e2b46bc3bacf95/receipt.json.
Obejmują wcześniejsze sześć kontroli identity i pięć pełnych scenariuszy CLI:

- poprawny eksport publikuje znormalizowany kontrakt i nie zmienia wejścia;
- niezgodny commit i uszkodzony JSON zachowują poprzedni output;
- relative input oraz katalog są odrzucane bez zmiany outputu;
- plik 64 MiB + 1 jest odrzucany przed publikacją;
- raw kontrakt bez canonical session status jest odrzucany.

Parser Node/Python, parser nowej recepty just i scoped diff check: PASS.
Zarządzany lint: PASS, exit 0, źródła bez zmian podczas kontroli;
receipt lint/f26c3046b662447dbe5fe003c62030a7/receipt.json.
Niezależny source review: PASS, brak P0/P1. Fingerprint jest kontrolą źródeł
tej trasy, nie pełną attestacją Node, dependencies, lockfile ani resolvera.
Windows reparse replacement oraz Unix FIFO/symlink runtime nie są dowiedzione
przez te scenariusze. Zaufanie do operator-owned root i przodków pozostaje jawne.
Nie nadajemy fixture statusu rzeczywistego eksportu produktu.

Managed build 214 nadal dotyczy przypiętego commita P8-33; kolejne zmiany narzędzi
nie zmieniają jego API schema. Rzeczywisty eksport, wygenerowany klient, hook,
Explorer/Inspector i autorun zachowują otwarte bramki. P0–P8 pozostaje w realizacji.
