# Watermark koordynatora i fail-closed recovery

Data: 25.09.2026
Zakres: P3-B / P5-B — projekcja journalu do katalogu i ochrona przed utratą
końcowych transitionów.

## Decyzja

ADR [`0034-coordinator-watermark-recovery.md`](../../../../../adr/0034-coordinator-watermark-recovery.md)
utrzymuje coordinator journal jako źródło prawdy. Run catalog przechowuje
opcjonalne `FmsCoordinatorWatermark` z najwyższym sequence komend i zdarzeń
bieżącego attemptu/ownership epoch. Pole jest addytywne, więc starsze katalogi
bez watermarku nadal się deserializują.

`FmsCoordinatorGenesis` przechowuje zahashowany typed checkpoint z zerowymi
sequence i pełną tożsamością claimu. `commit_coordinator_genesis` sprawdza
aktywność taska oraz dokładny resource lease i zapisuje genesis w katalogu
przed udostępnieniem komendy. Nowy attempt dostaje własny genesis dopiero po
podniesieniu ownership epoch.

## Implementacja

- `commit_transition` publikuje wpis journalu, a następnie uzgadnia lifecycle,
  observation i watermark katalogu z pełnego, ciągłego journalu. Błąd drugiego
  zapisu wraca do `DurableWorkerCoordinator`; pending transition pozostaje do
  ponowienia z tym samym envelope.
- `recover_coordinator` odrzuca journal krótszy niż watermark, ale może odtworzyć
  catalog, który jest w tyle. Pusty journal można odtworzyć tylko z genesisem
  dopasowanym do claimu i watermarkiem `(0,0)`; brak genesis nie bootstrapuje
  nowego streamu.
- `SessionStore::commit_run_catalog` chroni watermark przed cofnięciem,
  usunięciem w tym samym epoch i usunięciem taska, który go posiada. Retry może
  wyczyścić poprzedni attempt przy zachowaniu watermarku; następny attempt oraz
  reset wymagają większego ownership epoch.
- Zwykły `commit_run_catalog` nie może wstawić genesis ani utworzyć go w nowym
  katalogu. Publikacja przechodzi wyłącznie przez `commit_coordinator_genesis`,
  które sprawdza aktualny attempt, stan admitted taska i aktywny lease z
  dokładnym tokenem, epoką oraz heartbeat sequence. Idempotentny zapis tego
  samego genesis pozostaje dozwolony.
- Publiczny read model API jawnie mapuje do DTO i nie ujawnia tego pola ani nie
  zmienia OpenAPI.

## Regresje zapisane

Rozszerzony test w
`crates/fullmag-api/src/router_v2/tests/project_documents.rs` sprawdza watermark
po komendzie Start `(1,0)` i evencie Started `(1,1)`, replay bez podwójnej
zmiany rewizji, zapis Stop `(2,1)` przed kontrolowanym zakończeniem procesu,
odmowę recovery po usunięciu końcowej komendy oraz po usunięciu całego journalu,
a także odzyskanie pustego, świeżego strumienia wyłącznie po zapisie genesis.
Sprawdza też cofnięcie watermarku, usunięcie/zmianę taska/genesisu, zmianę
attemptu bez nowego epoch, reset po podniesieniu epoch i wyczyszczenie
zakończonego attemptu.
Regresja odrzuca też próbę publikacji genesis przez ogólny zapis katalogu,
zarówno dla istniejącego katalogu, jak i pierwszego zapisu; po odmowie
sprawdza, że żaden katalog nie został zmieniony ani utworzony.

## Weryfikacja

- `rustfmt --check` dla zmienionych plików Rust: **PASS**.
- `git diff --check` dla śledzonych plików: **PASS**; osobna kontrola białych
  znaków objęła również nowe pliki i nie znalazła trailing whitespace.
- Git wypisał wyłącznie ostrzeżenia o normalizacji LF/CRLF.
- Test API i kompilacja: **NOT RUN / NOT VERIFIED**. Aktualna awaria managed
  runnera (`Container profile allow-list mismatch`; `runner-doctor` nie
  poświadcza kontekstu Docker Desktop) blokuje tę bramkę. Nie użyto builda
  hostowego.
- P3 pozostaje **49%**, P5 **0%**, całość około **27%** do czasu zaliczenia
  wymaganej bramki.

## Granice

Adapter accepted-task `Prepare` zapisuje genesis przed outboxem, ale nie istnieje
jeszcze produkcyjny caller/supervisor, który prowadziłby pełne admission,
transport, odtwarzanie efektów workera, zatrzymanie starego procesu i dowód
zwolnienia GPU. CLI nie może utworzyć `Prepare` tylko dlatego, że nie znalazł
transitionów; musi najpierw odzyskać genesis/current claim i przejść przez
runtime admission.
