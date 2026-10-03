# P6-77 — odbiór skalarów w Saved Results

## Zakres

Dodano frontendowy odczyt historycznego artefaktu skalarnego przez v2 API,
bez aktywnej sesji i bez zmiany selekcji kernela. Przepływ pozostaje w jednym
drzewie Saved Results:

```text
projekt (ready) → run → SolutionSet revision → member → artifact page
  → table/fullmag.study.scalar_json@v1 → scalar resource → lokalny panel wartości
```

Zmiana obejmuje `apiPaths.ts`, `apiTypes.ts`, `ControlRoomApi.ts`,
`kernel/resources/solutionSetResources.ts`, regresje resource/facade oraz
`SavedResultsBrowser.tsx`. Wygenerowane pliki OpenAPI nie były ręcznie
edytowane; użyto istniejącego wygenerowanego endpointu z bieżącego kontraktu.

## Kontrakt transportu i resource hook

Facade udostępnia `persistence.projects.solutionScalar(...)` dla trasy:

```text
GET /v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/scalar
```

Hook `useSolutionScalarResource` ma klucz zawierający projekt, run,
SolutionSet, revision, member i artifact oraz końcówkę `:scalar`. Dodatkowo
wiąże wersję cache z digestem manifestu, object reference i długością artefaktu,
żeby zmiana strony nie mogła pokazać starej odpowiedzi. Używa
`abortStaleInflight: true` i nie odwołuje się do `sessions/current`.

Odpowiedź przechodzi fail-closed przez `validateSolutionScalarEnvelope`:

- wszystkie identyfikatory muszą zgadzać się z żądaniem;
- `manifest_digest`, `object_ref` i `byte_length` muszą zgadzać się z wybranym
  wpisem strony artefaktów;
- `revision`, `step`, `byte_length` i `ownership_epoch` pozostają canonical
  decimal u64 stringami; długość odpowiedzi jest ograniczona do 64 KiB;
- `value_si` i `time_s` muszą być skończone;
- wymagane są schema version, `integrity=verified`, poprawne stany wykonania,
  osobne oceny naukowe i niepuste provenance; jeśli payload zawiera
  `accepted_state`, jego run, liczniki i digesty są również walidowane.

Filtr listy artefaktów wymaga równocześnie `kind=table` oraz
`schema_id=fullmag.study.scalar_json@v1`. Błąd 404/409/500 albo naruszenie
wiązania jest pokazany lokalnie jako niedostępność skalara; nie ma fallbacku do
aktywnej sesji ani do podglądu/preview.

Panel uwzględnia także `refreshError`. Resource hook może zatrzymać poprzednie
dane podczas odświeżania; UI pokazuje wartości wyłącznie dla stanu `ready`
bez błędu odczytu ani odświeżenia. Nie przedstawia zatrzymanego wyniku jako
aktualnie zweryfikowanego po nieudanym ponownym odczycie.

## UI

`SavedMemberArtifacts` zachowuje dotychczasowy panel materialized dataset i
dostaje osobną lokalną listę `Scalar values`. Wybranie pozycji nie wywołuje
`kernel.selection.set`; wpływa wyłącznie na lokalny panel. Panel pokazuje:

- `quantity_id`, `value_si` i jednostkę SI;
- dokładny tekstowy `step` oraz `time_s`;
- osobno integralność/CAS i stan manifestu;
- osobno stan wykonania SolutionSet i membera;
- osobno ocenę naukową SolutionSet i membera wraz z powodem;
- zachowany `accepted_state` (krok i stage), jeżeli artefakt go posiada;
  panel nie wyprowadza go z kroku ani czasu skalara.

Zmiana strony artefaktów czyści wybór skalara. Projekt inny niż `ready` nadal
blokuje cały Saved Results na istniejącej bramce `useProjectDocumentSnapshot`.

## Dowody i ograniczenia

Dodano regresje dla:

- pełnego wiązania historycznej tożsamości i cache key;
- dużych canonical u64 bez konwersji do `number`;
- niezgodnego projektu/run/revision/member/artifact, manifestu, object ref,
  długości, schema, finite value/time i niekanonicznych liczników;
- facade GET na dokładnej trasie scalar, niezależnej od current session;
- odrzucenie pustego/malformed payloadu oraz obcego lub niekanonicznego
  `accepted_state`.

`pnpm --dir apps/control-room typecheck` uruchomiono jako kontrolę noEmit.
Nie zgłosił błędów w zmienionych plikach, lecz pozostaje czerwony przez
wcześniejsze, niezwiązane błędy w testach i innych modułach (m.in. stare typy
quantity, `ResourceRevision=null`, brak globalnych typów testowych i zgodność
viewport). Kompilacji testów jednostkowych ani testów runtime nie uruchamiano
zgodnie z bieżącym zakazem `AGENTS.md`.

Managed build 218 zakończył się sukcesem. Rzeczywisty OpenAPI wyeksportowano
z jego zweryfikowanego pakietu i zaimportowano generatorami; opis i receipt
znajdują się w [P8-49](../p8/49-managed-package-openapi-export.md).
`just check-control-room-production-source` przeszedł dla produkcyjnych
źródeł po integracji skalarów (receipt `a619cba169be4682887a80f543d6e1ce`).
Po poprawce obsługi `refreshError` kontrola produkcyjnych źródeł przeszła
ponownie (receipt `3b9f25fc649b499d8c68a4a105f2fb86`).
Kontrola API hygiene również przeszła
(receipt `91c54f88bcdd4d7091d9f544825f4b89`).
React Doctor 0.9.12, `--scope changed --base
2d1ccb7165878fbfba731c06fa5451b92e0bbd82 --no-score --no-supply-chain`,
sprawdził 10 zmienionych plików i nie znalazł problemów. Trzy ostrzeżenia
hooka commita dotyczą wcześniejszych pętli pobierania topology i klonowania
fixture; potwierdzono ich pochodzenie przez Git blame. Sekwencyjne pobieranie
ogranicza pamięć i nie zostało zmienione dla samego wyniku skanera.
Odczyt przez browser/API pozostaje **NOT VERIFIED**.
Build Linux CPU nie zastępuje dowodu natywnego pakietu Windows ani walidacji
naukowej skalara.
