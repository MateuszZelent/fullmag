# P6-52 — binarny odczyt fragmentów trwałego datasetu

Data: 01.10.2026. Status: zaimplementowany przyrost transportu, sprawdzone
źródła i wygenerowany kontrakt; runtime i renderer **NOT VERIFIED**.
Baza: `d118a8bf991e5c9819d546081bf1e0af4469edd8`.
Commit kodu: `c84deae95ab70398455185c1223a79207b6209bf`.
P6 pozostaje **IN PROGRESS, około 52%**, cały plan około **49%**.

## Zachowanie

Nowa project-owned trasa `GET .../materialized-dataset/slice` korzysta z
istniejącego storage-neutralnego DatasetFieldSlice i adaptera CAS. Weryfikuje
projekt/RunSpec, dokładny SolutionSet, containing revision, manifest hash,
historycznego ownera oraz dataset/sample/item/field przed wydaniem bytes.
Requested offset/count/budget są kanonicznymi stringami u64; identyfikatory
nie przechodzą przez Number ani alias `current`.

Odpowiedź FMDS v1 wiąże pełny descriptor pola i pinned source z surowymi
little-endian F32/F64 part bytes. Payload jest ograniczony do 64 MiB, metadata
do 1 MiB, header ma 12 B. JSON nie przenosi tablic wartości. Wygenerowany
OpenAPI opisuje body jako `string/binary`. Centralna fasada klienta używa
istniejącego transportu binarnego i kontroluje ilość odebranych bytes przed
alokacją końcowego ArrayBuffer. Nowy codec sprawdza dokładny scope, descriptor,
zakres, coverage i SHA-256 każdej zwróconej części, a następnie udostępnia
wartości w oryginalnej precyzji. Abort nie publikuje późnego wyniku.

Manifest v1 zachowuje wcześniejszy kontrakt rzeczywistego `Values`; nie ma
fallbacku do realnej części pola zespolonego. Reader nie uruchamia solvera,
materializacji, mutacji projektu ani odczytów bieżącej topologii. Istniejący
metadata endpoint nadal sprawdza cały payload. Bounded slice weryfikuje
metadane i dotknięte chunky; `verified_returned_ranges` nie certyfikuje
nieodczytanego pola ani fizyki. Kontrola hasha może odczytać cały dotknięty
chunk, więc limit odpowiedzi nie jest równoważnym limitem I/O.

Decyzję zapisuje [ADR 0040](../../../../../adr/0040-bounded-materialized-dataset-binary-slices.md),
a publiczny kontrakt rozwija [specyfikacja API](../../../../../specs/resource-first-control-room-api-v2.md).

## Review i korekty

Niezależny review wskazał dwa P1, poprawione przed commitem:

- Backend skanuje zwrócone scalar bytes bez dodatkowej kopii numerycznej,
  a frontend sprawdza Number.isFinite. NaN/Infinity są odrzucane również przy
  poprawnym checksum, zgodnie z istniejącym dekoderem domenowym.
- Legalne 4096 części storage nie gwarantuje zmieszczenia ich metadata w HTTP.
  Przekroczenie budżetu daje jawne HTTP 422 DATASET_SLICE_METADATA_BYTE_LIMIT;
  nie jest oznaczane jako uszkodzony zapis ani ukrywane truncation.

Ponowny review źródeł nie znalazł pozostałych P0/P1. Uwagę P2 dotyczącą typu
body poprawiono do string/binary i potwierdzono w rzeczywiście wygenerowanym
JSON. Review nie uruchamiał testów ani backendu HTTP.

## Dowody

Receipt paths poniżej są względne wobec rozwiązanego
`storage/builds/fullmag-0950f4dca4ffe38f`. Zarządzane trasy rejestrowały
preflight i terminalny wynik; finalne przebiegi miały exit 0 i niezmienione
wejścia w trakcie pracy. Źródła pochodziły z dirty checkoutu na masterze;
nie jest to kwalifikacja artefaktu release z czystego commita.

| Bramka | Receipt / kontrola | Wynik |
|---|---|---|
| Produkcyjna kompilacja API i generacja OpenAPI po review | `windows-api-source-check/api-openapi-codegen/12896ebd0b2749d6b24be25859d7df3a/receipt.json` | PASS; bez kompilacji testów jednostkowych |
| Generacja typów, paths i transportu klienta | `windows-control-room-source-check/generate-client/5252106e3c7944a2929208f1ff2bbcce/receipt.json` | PASS; generowanych plików nie edytowano ręcznie |
| Produkcyjny TypeScript | `windows-control-room-source-check/production-source/5635560f3c494475bf6247ed740aa17a/receipt.json` | PASS; testy wykluczone |
| API hygiene | `windows-control-room-source-check/api-hygiene/1d4584ee518942439a2d3478e9d2e1ef/receipt.json` | PASS |
| Schema binarnego body i limit metadata | parser wygenerowanego JSON: type=string, format=binary, response 422 | PASS |
| Architecture hygiene i repository consistency | istniejące checkery repozytorium | PASS |
| Staged diff | lista 19 plików, diff/check, tylko własne insertions w routerze i OpenAPI | PASS; zachowano 107 obcych dirty paths |
| Rootowy hook React Doctor | 9 staged plików, score 79/100, framework-neutral | commit zakończony; dwa await-in-loop w wcześniejszym odczycie topologii, identyczne względem bazy P6-51 |

Wcześniejszy source check API `58a50032be2647d5b5c26be155ea8238` przeszedł
przed poprawkami review; finalnym dowodem kompilacji nowych poprawek jest
codegen powyżej. Przebiegi odrzucone jako source_changed, początkowy błąd
widoczności validatora CAS i błąd BigInt literal/target pozostają zachowane
w storage; nie są liczone jako PASS. Równoległa próba drugiego source checku
została zatrzymana przez wspólną blokadę worktree i powtórzona sekwencyjnie.

## Regresje i granice

Dodano źródła regresji exact/historical owner, forged manifest/field,
range/budget, corrupt touched chunk przy niecertyfikowanych unread chunks,
liczników powyżej 2^53, strict query, 4096-part metadata budget,
F32/F64 decode, checksum, trailing bytes, abort, nonfinite values oraz limitu
streamu i skompresowanego Content-Length. Backendowy przypadek nonfinite
używa F64, frontendowy obejmuje F32 i F64.

**Testów jednostkowych nie kompilowano ani nie uruchamiano** zgodnie z
bieżącym zakazem AGENTS.md. Te źródła nie są dowodem PASS zachowania.
Nie wykonywano nowego browser fixture, prawdziwego backend HTTP, testu RAM,
scientific/runtime/GPU ani release qualification. Poprzedni browser proof
P6-51 pozostaje dowodem wcześniejszego widoku, nie nowego binarnego odczytu.

Nowa fasada i codec nie są jeszcze montowane przez resource hook/renderer.
Readonly Inspector pozostaje metadata-only. Zapisana geometria i mapowanie
indeksów nie powstają z samego topology_id/support_fingerprint. Kolejny
przyrost musi dodać bounded resource lifecycle i dowód pobrania, potem exact
topology/support artifact oraz renderer w istniejącym viewport. Pola
zespolone wymagają nowego manifestu z jawnymi plane sources i wspólną
walidacją; derived/plot axes, pełny P6 oraz P0–P8 pozostają otwarte.

Wszystkie uruchomione procesy kontroli zakończyły się. Checkout pozostaje
na masterze zgodnie z autoryzacją użytkownika; rejestr pracy ma stan wip.
Storage, poprzednie dowody i obce zmiany pozostają zachowane.
