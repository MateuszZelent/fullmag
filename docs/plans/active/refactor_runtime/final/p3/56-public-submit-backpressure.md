# P3/P5 — atomowy limit publicznego Submitu

Data checkpointu: 27.09.2026.

## Zakres

Publiczny `POST /v2/persistence/projects/{project_id}/runs` egzekwuje globalny
limit nieterminalnych accepted runów. Wartość `FULLMAG_ACCEPTED_RUN_BACKLOG_LIMIT`
jest rozstrzygana raz przy starcie API, musi być dodatnią liczbą całkowitą i
domyślnie wynosi `256`.

Admission i publikacja `run_intent.json` odbywają się pod tym samym natywnym
writer lockiem `SessionStore`. Dzięki temu dwa procesy nie mogą zaakceptować
nowych runów na podstawie tego samego wolnego miejsca. Do backlogu zalicza się:

- accepted intent bez materializowanego katalogu;
- katalog pusty albo zawierający co najmniej jeden task nieterminalny.

Run zwalnia miejsce dopiero, gdy ma niepusty katalog i wszystkie taski są w
jednym ze stanów `succeeded`, `failed`, `cancelled` lub `interrupted`.
Idempotentny replay jest rozstrzygany przed limitem, więc klient może odzyskać
wcześniejsze potwierdzenie także przy pełnym backlogu. Nowy run przy pełnym
limicie otrzymuje HTTP `429` z kodem `run_backlog_full`; odrzucona próba nie
publikuje intentu ani pustego katalogu runu.

## Dowody

Managed process E2E uruchomiło rzeczywiste binaria CLI, API, publishera,
schedulera i workera. Przy limicie `6` sześć immutable payloadów zostało
zaakceptowanych. Replay pierwszego zwrócił `200/replayed`, a siódmy payload
został odrzucony przez `429/run_backlog_full` bez `run_intent.json`. Scheduler
wykonał cztery runy; wszystkie cztery lease'y zostały zwolnione. Następnie ten
sam siódmy payload został przyjęty jako nowy run przez `201/accepted`, co
potwierdza zwolnienie pojemności przez terminalne katalogi.

| Bramka | Wynik | Dowód |
|---|---:|---|
| Atomowy limit sześciu runów | PASS | sześć accepted intentów, siódmy `429` |
| Replay przy pełnym backlogu | PASS | `200`, disposition `replayed` |
| Stabilny błąd przeciążenia | PASS | kod `run_backlog_full` w OpenAPI/API |
| Brak publikacji po odmowie | PASS | brak `run_intent.json` siódmego runu |
| Zwolnienie pojemności | PASS | po czterech terminalnych runach `201/accepted` |
| Scheduler i resource leases | PASS | cztery workery `completed`, cztery lease'y `released` |
| Tożsamość źródeł | PASS | `source_changed_during_run=false` |
| OpenAPI v2 i typy TypeScript | PASS | managed codegen, generator typów i API hygiene |

Runtime receipt:
`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-project-api-runtime\resource-discovery-runtime\407dc187d1b44d2cb8b8c04d4cd5699d\receipt.json`.

OpenAPI receipt:
`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\windows-api-source-check\api-openapi-codegen\1c4fe9ab6d34414a9e9dcd40b2ba2478\receipt.json`.

## Granica checkpointu

Limit jest globalny dla jednego store i nie stanowi rozproszonego quota
managera. Nie implementuje per-project/per-tenant limitów, aging/deadline
policy ani trwałego zasobu obserwowalności kolejki. CAS payloady zweryfikowane
przed atomowym admission mogą pozostać jako nieosiągalne obiekty po `429` i
podlegają istniejącej bezpiecznej polityce GC. Zdalny heartbeat/Stop ACK,
process E2E pozostałych lane'ów i legacy `run-json` cutover pozostają otwarte.

Po tym przyroście: **P3 90%, P5 78%, całość około 47%**.
