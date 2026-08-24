# Projekt przywrócenia pełnej bramki lintowania Control Room w PR #56

**Status:** zatwierdzony do realizacji

**Data:** 2026-08-23

## Cel

Pełne `eslint . --max-warnings=0` ujawnia osiem błędów i cztery ostrzeżenia w
pięciu plikach identycznych na gałęzi PR i aktualnym `master`. Naprawiamy je
bez osłabiania zakresu bramki i bez zmiany kontraktów API lub runtime.

## Zakres

- usunięcie nieużywanej funkcji `revisionedKey` z
  `frozenSpinsResources.ts`;
- usunięcie nieużywanego lokalnego wiązania `resourceKey` z koordynatora ACK,
  bez zmiany jego publicznego wejścia;
- zastąpienie `useEffect + setState` w polu liczbowym jednym obiektem szkicu
  `{ sourceValue, text, error }` i warunkową korektą stanu po rzeczywistej
  zmianie wartości kanonicznej;
- zastąpienie zapisu do `ref` podczas renderu panelu Frozen Spins lokalnym
  stanem ostatniego poprawnego zasobu, izolowanym przez `constraintId`;
- uzupełnienie efektu ACK viewportu o wszystkie prymitywne pola tożsamości
  bufora i usunięcie nieużywanej zależności callbacku klatki.

## Inwarianty

- Pole liczbowe zachowuje tę samą instancję DOM i fokus po zmianie wartości
  nadrzędnej; celowo nie używamy `key={value}`.
- Niepoprawny tekst pozostaje lokalnym szkicem i nie trafia do `onChange`.
- Ostatni poprawny zasób Frozen Spins może podtrzymać panel wyłącznie dla tego
  samego `constraintId`; przełączenie celu nie może ujawnić starej definicji.
- Efekt viewportu reaguje na zmianę `bufferId`, `fieldRevision`, `resourceKey`,
  `sessionEpoch` lub `sessionId`, ale nie na samą zmianę referencji obiektu.
- Nie zmieniamy OpenAPI v2, transportu, typów generowanych, resource hooks,
  topologii sceny ani własności WebGL.

## Weryfikacja

Najpierw dodajemy test DOM pola liczbowego potwierdzający zachowanie tożsamości
inputu, fokusu i przyjęcie wartości kanonicznej oraz regresję izolacji ostatniego poprawnego zasobu
Frozen Spins po zmianie celu. Następnie uruchamiamy testy modułowe ACK/viewport,
pełny lint i typecheck, bramki API/architektury, React Doctor oraz browser smoke
viewportu z widocznym canvasem, nieutraconym kontekstem i niezerowym drawing
bufferem.
