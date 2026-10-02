# P7-C / P8 — powiązanie launchera i desktopu z accepted store

Data: 03.10.2026. Kontynuacja [etapu 21](21-native-runtime-launcher.md).

Resolver accepted store został przeniesiony bez zmiany reguł z API do
fullmag-runtime-control. API używa reexportu, CLI i desktop tego samego
resolvera. Klient lifecycle również ma jedną implementację w runtime-control;
CLI pozostaje adapterem poleceń. Brak kopiowania algorytmu między aplikacjami.

## Zaimplementowane źródłowo zachowanie

Przy jawnej zmiennej FULLMAG_RUNTIME_SERVICE_CONFIG launcher i desktop sidecar
po starcie API odczytują konfigurację, porównują jej store z kanonicznym
accepted store API, inicjalizują store i wykonują start/attach przed otwarciem
UI. Ta sama zwalidowana konfiguracja jest przekazywana do ensure bez ponownego
odczytu pliku operatora. Niezgodny root blokuje start przed inicjalizacją.
CLI i desktop wymagają zgodnego kontraktu OpenAPI oraz pełnego commit/snapshot
świeżo uruchomionego API przed attach. Sam healthz nie wystarcza.

W instalacji Windows root to state_root/runs/session-store; w trasie managed
FULLMAG_RUNS_ROOT/session-store. Store local-live/session-store dotyczy current
workspace i nie może być użyty przez usługę accepted runtime.

CLI tworzy guard API/frontend przed attach i przed otwarciem okna. Błąd attach
sprząta procesy launchera. Desktop robi to przez guard sidecara. Żaden z tych
guardów nie jest właścicielem native service: zamknięcie okna/API nie wysyła
drain do usługi ani nie zabija jej procesu.

CLI z jawną konfiguracją usługi odrzuca reuse istniejącego API: sam zgodny build
API nie dowodzi tożsamości jego accepted store. Współdzielony handshake store
dla reused API pozostaje do implementacji. Obcego API nie zatrzymano.
Niskopoziomowe service-ensure jest ukrytym poleceniem operatorskim dla jawnego
store; nie zastępuje powyższego powiązania aplikacji z resolverem API.

Brak konfiguracji pozostawia authoring dostępny. Automatyczne wykrywanie i
budżetowanie zasobów, domyślna konfiguracja produktu, kompletne UI accepted
execution i wycofanie current/scratch runtime pozostają otwarte. Nie uznano
opcjonalnego podłączenia za ukończony domyślny produkt Windows.

## Dowody

- Parser/format zmienianych modułów Rust i scoped diff check PASS.
- Cargo metadata offline/locked/no-deps PASS; nie jest to typecheck.
- Istniejące regresje resolvera API zachowano przez adapter wspólnego resolvera.
- Zapisano regresję odmowy local-live store bez utworzenia żadnego katalogu.
- Unit tests nie kompilowano ani nie uruchomiono zgodnie z zakazem operatora.
- Niezależny re-review po poprawie desktop handshake: brak P0/P1 w źródłach.
- Typecheck, Windows process/Job Object, browser/solver i clean-install:
  NOT VERIFIED. Źródłowe podłączenie nie dowodzi obliczeń po zamknięciu UI.

Instancja 3104, aktywne buildy i cudze zmiany pozostają zachowane; nie zmieniono
wolumenów Docker ani procentu ukończenia całego planu.
