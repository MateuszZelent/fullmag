# API trwałych rewizji SolutionSet v1

Status: implementacja źródłowa; bramki runtime i wydania pozostają otwarte.
Data: 2026-09-30. Właściciel: `fullmag-session::SolutionSetCatalog`, adapter
`router_v2/handlers/persistence/solutions.rs`; jeden klient Control Room.

## Cel i tożsamość

Przegląd wyników historycznych nie zależy od aktywnego runtime ani od
mutable draftu. API odczytuje istniejący store przyjętych runów oraz dokładną
niezmienną rewizję `SolutionSet`. Nie kopiuje artefaktów, nie otwiera runtime,
nie zleca solvera, nie nabywa writer lease i nie wykonuje reconciliation.

Wspólny prefiks tras:

```text
/v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets/{solution_set_id}/revisions/{revision}
```

| Sufiks | Metoda | Zasób |
|---|---|---|
| pusty | GET | `SolutionSetResource`: nagłówek, provenance, status i liczby rekordów |
| `/members` | GET | `SolutionSetMemberPageResource`: member/task/attempt/stage, execution i assessment |
| `/members/{member_id}/artifacts` | GET | `SolutionSetArtifactPageResource`: immutable referencje CAS i coverage summary |

`revision` jest dodatnim kanonicznym ciągiem cyfr reprezentującym pełny `u64`.
Wartości `01`, `+1`, `0`, whitespace i overflow są odrzucane (400). Transport
nie używa liczby JavaScript dla revision, ownership epoch, byte length,
accepted step ani liczników próbek. Nie ma aliasu `current` lub `latest`.

Każde żądanie weryfikuje projekt oraz tożsamość/fingerprint trwałego RunSpec.
Odczytany wynik musi należeć do tego runu i zawierać ten sam
`provenance.run_spec_digest`. Nie wolno podstawić wyniku z innego projektu,
runu lub bieżącej sesji. Brak store, intentu, rewizji lub membera daje 404;
niezgodność właściciela lub provenance daje 409. Błąd storage, manifestu lub
spójności RunSpec daje 500. Brak store nie tworzy katalogu.

`manifest_digest` to SHA-256 kanonicznego JSON całego typowanego manifestu
wskazanej rewizji. Jest semantycznym fencing tokenem zasobu, a nie hashem
surowego pliku na dysku ani dowodem integralności payloadów CAS. Wszystkie
strony tej samej rewizji zwracają tę samą tożsamość i digest.

## Stronicowanie i budżety

### Discovery wyników runu

`GET /v2/persistence/projects/{project_id}/runs/{run_id}/solution-sets`
udostępnia stronicowane referencje do rzeczywiście opublikowanych wyników.
Nie jest aliasem odczytu `latest`: każda referencja zawiera exact revision
i `manifest_digest`, z których UI tworzy dalsze przypięte żądania.
Odpowiedź zawiera schema `fullmag.analysis.solution_set_discovery.v1`,
project/run, items (solution_set_id, revision, manifest_digest) i next_cursor.
Rewizja pozostaje stringiem u64. Każdy zwrócony wynik przechodzi fence
RunSpec/projekt/run. CAS, runtime i solver nie są otwierane.

Discovery przegląda istniejącą przestrzeń nazw magazynu przy stałej pamięci
na wpisy katalogowe. W jednym żądaniu sprawdza najwyżej `limit` bieżących
manifestów (domyślnie 25, zakres 1–50), również jeżeli część należy do innych
runów. Zwracana referencja musi zgadzać się z odpowiadającą jej dokładną
immutable rewizją; brak lub rozbieżność daje błąd. Odczyty tych dwóch
manifestów są sekwencyjne i ograniczone, bez pełnego skanu historii.
Sortowanie używa niezmiennego skrótu katalogu SolutionSet; cursor jest
wersjonowany, przypięty do projektu/runu i walidowany przez serwer.
Strona może być pusta i mieć next_cursor — oznacza to dalsze wpisy do
sprawdzenia, nie brak wyników runu. UI musi zachować możliwość następnej strony.
Nie wolno zbierać wszystkich stron automatycznie ani pokazywać zer jako
zamiennika błędu. Directory traversal pozostaje O(N); jego koszt i peak RAM
wymagają osobnych pomiarów, a paginacja nie dowodzi stałego czasu odpowiedzi.

Nie jest to atomowy snapshot mutable katalogu. Publikacja nowego katalogu
przed granicą cursora jest widoczna po odświeżeniu od początku; aktualizacja
manifestu nie zmienia już przypiętej referencji. Uszkodzony manifest lub
niezgodny digest ownera daje jawny błąd. Nie ma reconciliation ani pomijania
korupcji jako pustego sukcesu. Nieznana lub obca granica cursora daje 400.
Obowiązuje istniejący limit 16 MiB na jeden manifest i 1 MiB na odpowiedź.
Nie tworzy się drugiego indeksu, nowego writera ani wyprowadzonych przez UI IDs.

Strony są sortowane rosnąco po immutable `member_id` lub `artifact_id`.
`limit` domyślnie wynosi 50; zakres wynosi 1–100. `after_member_id` oraz
`after_artifact_id` są jawnymi granicami pozycji w wskazanej rewizji i memberze.
Nieznana granica daje 400. Odpowiedź publikuje odpowiednio
`next_after_member_id` albo `next_after_artifact_id`; null oznacza koniec.
Nie jest to cursor mutable katalogu; pełna identity rewizji należy do ścieżki.

Manifest sterujący ma limit 16 MiB surowych bajtów, wymuszony przy odczycie
(limit + jeden bajt) oraz przed publikacją nowej rewizji. Starszy przekraczający
limit manifest jest błędem, nie obciętym wynikiem i nie podstawą GC. W takiej
sytuacji wymagany jest osobny plan migracji/shardingu, bez usunięcia źródła.
Każda odpowiedź metadanych ma limit 1 MiB; przekroczenie daje 500
`SOLUTION_RESPONSE_BYTE_LIMIT`. Te limity nie dowodzą peak RAM po parsowaniu,
walidacji, sortowaniu i budowaniu odpowiedzi. Kwalifikacja pamięci pozostaje
odrębną bramką P6-C.

Nagłówek nie inline'uje memberów, artefaktów, segmentów ani numerical payloads.
Artefakt publikuje `object_ref`, schema, rodzaj, exact length i opcjonalną
identity accepted state. Coverage zawiera stan, expected/committed samples
oraz liczbę segmentów, bez payloadów segmentów. Brak coverage to null, nie
wymyślone zero ani stan complete. `scientific_evidence` wskazuje przynależność
artefaktu do zadeklarowanych dowodów assessmentu, nie zaliczenie dowodu.

## Jakość i granice claimu

Execution, scientific assessment oraz coverage pozostają oddzielnymi facetami.
Sukces wykonania nie oznacza convergence ani kwalifikacji naukowej/wydania.
Stan assessmentu i jego powód pochodzą z trwałego manifestu; API ich nie
podwyższa. Powód i liczba referencji dowodów nie zastępują samych dowodów.

Odczyt metadanych nie otwiera CAS. Każda referencja artefaktu ma
`integrity=not_verified`; dostępność i zgodność payloadu wymagają osobnego
bounded binary data-plane resource i weryfikacji hash/length przed użyciem.
API nie tworzy jeszcze DatasetDefinition, materializowanego datasetu,
DerivedValue, PlotDefinition ani porównania pól. Jest rzeczywistym trwałym
właścicielem źródła, który ma być wykorzystany przez te kolejne etapy.

## Frontend i invalidation

Generated OpenAPI types/transport są źródłem typów JSON. Handwritten facade
oraz project-scoped hooki zawierają pełne project/run/solution/revision,
member i pagination w kluczu cache. `manifest_digest` jest revision tokenem.
Zmiana źródła anuluje stare in-flight requesty; wynik poprzedniego targetu nie
może stać się wynikiem nowego. Hook nie zależy od aktywnej sesji, nie łapie
404 jako pustego sukcesu i nie przechowuje payloadów CAS w stanie UI.

HTTP pozostaje właścicielem zasobów; WebSocket nie przenosi manifestu ani
ciężkich danych. Immutable rewizja nie wymaga pollingu ani osobnego realtime
kanału. Discovery kolejnych rewizji i wpięcie w Explorer pozostają odrębnymi
krokami; brak consumer UI nie jest przedstawiany jako wykonany browser proof.

## Odbiór i rollback

Wymagane: route/schema i generated type zgodność, właściciel RunSpec/run,
odczyt bez aktywnej sesji, pinned history po publikacji kolejnej rewizji,
member/artifact pagination, odrzucenie obcej granicy, zachowanie całego u64,
corrupt/missing manifest, limity wejścia/odpowiedzi, anulowanie zmiany source.
Aktualny zakaz kompilacji testów jednostkowych nie pozwala zaliczyć nowych
regresji samym source checkiem. Runtime, browser, RAM i release są osobnymi
bramkami. Rollback może wyłączyć consumer/transport bez usuwania katalogu,
zmiany immutable revisions ani przywrócenia zależności od aktywnego runtime.
