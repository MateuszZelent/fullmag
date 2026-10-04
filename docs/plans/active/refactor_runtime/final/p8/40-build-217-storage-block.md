# P8-40 — blokada pojemności przed kompilacją 217

Data: 03.10.2026. Build 217 `50298982d80f48d8a688af01a7c19304`
przeszedł z QUEUED przez RUNNING do terminalnego BLOCKED; `exit_code=null`.
To błąd infrastruktury przed utworzeniem katalogu wykonania i kontenera
workera, nie wynik kompilacji poprawki P8-39.

Koordynator: `Build needs at least 8 GiB free; no automatic cleanup`.
Health nadal `ok=true`, `worker_alive=true`, brak aktywnych jobs,
`last_result.state=waiting_for_disk`. Build 218 pozostaje queued.

## Ustalona lokalizacja braku miejsca

| Pomiar | Wynik |
|---|---|
| Windows C: | 8 084 226 048 B wolnego, około 7,53 GiB. |
| `/storage` koordynatora | 8 084 221 952 B; odpowiada dyskowi hosta C:. |
| Wewnętrzny filesystem Dockera `/` | 798 776 872 960 B wolnego, około 744 GiB. |
| Próg admission | 8 589 934 592 B, czyli 8 GiB; sam próg nie gwarantuje pojemności całego buildu. |

Nie należy traktować cache BuildKit jako rozwiązania tej blokady: znajduje
się na innym filesystemie, a jego usunięcie nie dowodzi odzyskania miejsca
na C:. Odczyt `docker system df` i inwentaryzacja dwóch starych rekordów
BuildKit były wyłącznie diagnostyką; niczego nie usunięto.

Historyczne 44 cache frontendowe z P6-67 już usunięto po ówczesnej zgodzie.
Aktualny odczyt tego samego katalogu fixture nie znalazł kolejnych
`frontend/next/dev-3250` z receiptami. Nie ponawiamy starego cleanupu ani
nie rozszerzamy jego autoryzacji na inne katalogi.

## Następny krok

Potrzebne jest zwolnienie miejsca na C: z zapasem do buildu albo jawna decyzja
operatora o nowej fizycznej lokalizacji storage. Nie zmieniono `.env`,
nie usunięto Cargo target, wyników, kontenerów ani worktree.
Polityka [storage](../../../../../guides/fullmag-build-storage-governance.md)
wymaga osobnej autoryzacji dla dokładnych celów usuwania.

Po odzyskaniu pojemności najpierw odczytać 218 i health; jeśli kolejka już
wykonuje ten build, obserwować go bez restartu ani duplikatu. 218 zawiera
również P8-39 oraz backendowy scalar API, więc terminalny poprawny wynik
może posłużyć do odbioru pakietu i eksportu OpenAPI; nie ma potrzeby
automatycznego ponawiania 217. Przypięty commit/snapshot 218 pozostają
normatywną tożsamością tego odbioru. Cały plan pozostaje otwarty.
