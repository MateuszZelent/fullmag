# P8-41 — wdrożenie poprawki sond nightly

Data: 03.10.2026. Wdrożono przygotowany i wcześniej sprawdzony overlay
[P8-38](38-nightly-build-evidence.md). Zmienia wyłącznie `preflight` i
`toolchain_versions` względem dotychczasowego obrazu koordynatora.

## Przebieg i dowody

Przed wymianą koordynator był zdrowy, z pustą listą aktywnych jobs i
`waiting_for_disk`. Własna kontrolowana pauza zakończyła worker:
`worker_alive=false`, `accepting_jobs=false`, `stop_requested=true`,
`coordinator.state=stopped`, obecny `finished_at`, bez worker error.
Nie przerywano aktywnego buildu.

| Tożsamość / bramka | Wynik |
|---|---|
| Poprzedni kontener | `488eb93b7aea`; własny koordynator, wymieniony przez managed `container-replace`. |
| Poprzedni obraz | `sha256:9923f33b147b52b6534a9f2161bf4a00c4b138679575035676bffb52512da0db` |
| Nowy obraz | `sha256:1aa31b600114e35dac112821bfe0ee1317a00641077bf4ecee546e0747550665` |
| Nowy kontener | `7f20873de2b1e21335b7399afa8436ce6ed0e0503dcd69d2fa366917fa3bdef2` |
| Wdrożony entrypoint | `/opt/runner/scripts/local_runner/build_entrypoint.py` |
| SHA-256 wdrożonego pliku | `d11fe9904dda341eb4735d818de7546ed5a8978a6f7d97cf1d963fccbb329e19`, zgodny ze sprawdzonym overlay. |
| Rejestr profili w obrazie | Zachowane wszystkie osiem dotychczasowych profili, w tym historyczny `fem-cpu-slepc-runtime-v1`. |
| Operatorowy allow-list | Zachowane siedem profili; historyczny v1 nie został dopuszczony do kolejki. |
| Wznowienie własnej pauzy | `resumed=true`, `worker_started=true`; końcowy `ok=true`, `worker_alive=true`, `worker_error=null`, `accepting_jobs=true`, `stop_requested=false`. |
| Build 218 | Ten sam job `5a2659ca616448fdacd75e16f004e2af`, QUEUED; brak duplikatu i zmiany kolejności. |
| Storage | Ten sam bind `C:\git\fullmag\storage` → `/storage`; brak usunięcia danych lub wolumenów. |

Overlay zachowuje bazowy obraz jako możliwość rollbacku. Wcześniejsze cztery
interpretowane regresje wykonały się na dokładnie tym obrazie; po wdrożeniu
sprawdzono tożsamość rzeczywistego pliku i profili. Nie kompilowano testów.

## Granice i następny krok

P8-38 jest teraz wdrożony, lecz nowy produkcyjny receipt pozostaje
NOT VERIFIED. Kolejka nadal czeka na miejsce na Windows C:, około 7,53 GiB.
Wymiana koordynatora nie odblokowuje pojemności i nie dowodzi kompilacji
P8-39/B-02/B-03 ani działania API/UI.

Overlay nie wdraża pełnego kontraktu 14 wymaganych outputów z P6-68–70:
przed zaakceptowaniem pakietu należy nadal użyć aktualnego walidatora
źródłowego i sprawdzić dokładne artefakty. Nie obniżamy bramki do starego
zestawu pięciu plików. Po odzyskaniu pojemności obserwować istniejący 218,
odebrać receipt/hashe/źródła i przejść do realnego eksportu OpenAPI.
Nie zmieniono pakowania ani niezależności natywnego produktu Windows od
Linuxa/Dockera. Cały plan i procenty pozostają bez awansu.
