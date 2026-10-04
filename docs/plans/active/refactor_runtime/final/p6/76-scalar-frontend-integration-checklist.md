# P6-76 — odbiór skalarów w Saved Results

Data: 03.10.2026. Status: audyt źródeł zakończony; integracja i browser
**NOT VERIFIED**. Ten dokument nie zalicza implementacji P6.
Baza backendu: `7a209139f13156bbf89fa2a162c281b5ba620e09`.
Kontrakt odczytu: [P6-75](75-durable-scalar-api.md). Build 215 zakończył się
błędem kompilacji launchera; poprawka P8-39 jest w źródle buildu 218
`9f7eadb06b7f4e9be3b0fed7b1c9006a4666ea04`. Build 218 jest terminalny `succeeded`/exit `0`; pełny receipt, 120 artefaktów,
15 wymaganych wyjść oraz 6829 plików kapsuły zweryfikowano. Rzeczywisty eksport
OpenAPI i jego import z expected commit/snapshot przeszły; typy i paths
zregenerowano. Dowody: [P8-49](../p8/49-managed-package-openapi-export.md).

## Istniejący przepływ i zakres

`apps/control-room/src/modules/results-navigator/SavedResultsBrowser.tsx`
prowadzi przez projekt → run → SolutionSet revision → member → artifact.
Wybrany manifest jest sprawdzany przed prezentacją members i artifacts.
`SavedMemberArtifacts` obsługuje obecnie wyłącznie `materialized_dataset.v1`;
brakuje odczytu i prezentacji skalarów. Wygenerowany kontrakt zawiera
już endpoint scalar; facade/resource hook i panel wymagają implementacji. Zachowujemy istniejący panel i centralną warstwę
resource hooks; nie tworzymy kolejnego drzewa wyników.

## Kolejność implementacji

| Krok | Miejsce | Dowód odbioru |
|---|---|---|
| 1 | Managed build 218 | Terminalny receipt, zgodna tożsamość źródeł i hash binarium API; samo `queued`/`running` ani sukces pojedynczego etapu nie wystarcza. |
| 2 | `scripts/generate-openapi-v2.mjs` w Control Room | Raw eksport przez `--print-openapi-v2`, import z expected commit/snapshot, regeneracja typów i paths. Bez ręcznej edycji generated JSON/TS. |
| 3 | `kernel/api/apiPaths.ts`, `apiTypes.ts`, `ControlRoomApi.ts` | Typowany path, alias `SolutionScalarResource`, metoda `persistence.projects.solutionScalar` z walidacją pełnej tożsamości. |
| 4 | `kernel/resources/solutionSetResources.ts` | Hook oparty na facade, klucz projektu/run/revision/member/artifact, `abortStaleInflight: true`, brak zależności od bieżącej sesji. |
| 5 | `SavedResultsBrowser.tsx` | Lista scalar artifacts i lokalny wybór, wartość SI oraz oddzielne stany integralności, wykonania i oceny naukowej. |
| 6 | Regresje oraz przeglądarka | Scenariusze poniżej, jawny zakres wykonanych kontroli i pozostałych bramek. |

Ścieżka backendu:

```text
GET /v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}/members/{member_id}/artifacts/{artifact_id}/scalar
```

## Wiązanie danych

Filtr artefaktów wymaga jednocześnie `kind=table` oraz
`schema_id=fullmag.study.scalar_json@v1`. Odpowiedź ma osobny
`schema_version=fullmag.analysis.solution_scalar.v1`. Nie mylić codec tuple
artefaktu ze schematem payloadu ani zasobu API.

Hook sprawdza project/run/SolutionSet/revision/member/artifact i canonical
decimal u64. `revision`, `step`, `byte_length` i `ownership_epoch` pozostają
stringami; konwersja do JavaScript `number` traci duże liczniki. Wartości
`value_si` i `time_s` muszą być skończone. Przed renderem wiążemy
`manifest_digest`, `object_ref` i `byte_length` odpowiedzi z wybraną stroną
artefaktów. Niezgodność blokuje prezentację i ma jawny błąd integralności.

Klucz cache zawiera wszystkie identyfikatory, kodowane zgodnie z istniejącym
`solutionSetResourceKey`, i sufiks `:scalar`. Nie stosujemy
`useSessionScopedResourceKey`. Wybór skalara jest lokalny w Saved Results;
nie zmienia sesyjnej selekcji kernela ani Inspectora. Zmiana strony artifacts
czyści ten wybór tak jak obecny wybór pola.

Panel prezentuje dowolny `quantity_id`, `value_si`/`unit`, dokładny `step`,
`time_s`, manifest state, stany wykonania solution i member, obie oceny
naukowe oraz opcjonalny `accepted_state`. `integrity=verified` oznacza
sprawdzenie CAS. Nie wyprowadza zbieżności ani accepted state z kroku/czasu.

## Scenariusze odbioru

| Przypadek | Oczekiwane zachowanie | Wymagany dowód |
|---|---|---|
| Zapisany skalar poprawnej rewizji | Wartość i jednostka zgodne z API oraz wybranym artefaktem. | Realny API odczyt i browser. |
| Licznik większy niż `Number.MAX_SAFE_INTEGER` | Dokładny tekst kroku i rewizji, bez zaokrąglenia. | Regresja walidatora/renderu. |
| Zmiana project/run/revision/member/strony w trakcie fetch | Poprzednia odpowiedź nie pojawia się w nowym wyborze. | Regresja zasobu i browser. |
| Zmiana aktywnej sesji | Przypięty wynik historyczny i jego cache pozostają przy tej samej tożsamości. | Browser z dwoma kontekstami. |
| Niezgodny manifest/object/length lub payload | Jawny błąd; brak prezentacji jako poprawnego wyniku. | Regresja oraz kontrolowany fixture. |
| 404/409/500 | Lokalny stan niedostępności; brak fallbacku do `sessions/current`. | Regresja błędu i browser. |
| Projekt nie jest `ready` | Odczyt scalar nie jest uruchamiany. | Regresja warunku uruchomienia. |
| Naukowo `unassessed`, CAS poprawny | Integralność i ocena naukowa mają osobne komunikaty. | Browser. |

Regresje wymagające kompilacji testów pozostają **NOT RUN** do odwołania
aktualnego zakazu AGENTS.md. Kontrole źródeł, production build i browser
mają własne bramki; żaden z tych wyników nie zastępuje kwalifikacji fizyki
ani niezależnego pakietu Windows.

## Checkpoint kontraktu — 03.10.2026

Kroki 1 i 2 mają rzeczywiste dowody PASS. Regeneracja klienta, produkcyjny
source check baseline i 11 interpretowanych regresji importu przeszły.
Implementacja facade, hooka i panelu z kroków 3–6 znajduje się w
[P6-77](77-scalar-frontend-integration.md). Produkcyjny source check i API
hygiene przeszły po poprawce `refreshError`. Odbiór runtime/browser i regresje
wymagające kompilacji pozostają otwarte; nie zaliczamy tych kroków jako
ukończonych wyłącznie na podstawie kontroli źródeł.
