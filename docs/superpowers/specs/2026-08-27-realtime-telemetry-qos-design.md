# Projekt optymalizacji QoS telemetryki realtime

**Data:** 2026-08-27
**Status:** wariant architektoniczny A wdrożony i zweryfikowany kontraktowo; runtime smoke `NOT VERIFIED` z powodu braku działającego serwera

## 1. Cel

Usunąć serie zaległych aktualizacji telemetryki, sprawić, aby `scalar_telemetry_publish_ms` sterowało rzeczywistą częstotliwością danych dostarczanych do UI, oraz zapewnić świeżą telemetrykę CPU/GPU bez komponentowego pollingu i bez ruchu sieciowego przy braku aktywnego konsumenta.

## 2. Niezmienne kontrakty

1. HTTP v2 pozostaje autorytatywnym źródłem zasobów.
2. WebSocket przenosi lekkie próbki skalarne oraz invalidacje; nie przenosi ciężkich zasobów CPU/GPU ani pól.
3. Po ustabilizowaniu nieaktywnego workspace'u liczba cyklicznych requestów API wynosi zero.
4. Nie wolno dodawać `setInterval` do hooków ani komponentów zasobów.
5. Wielu konsumentów jednego `resourceKey` nadal współdzieli cache i jedno żądanie in-flight.
6. Pierwsza oraz terminalna próbka skalarna każdej sekwencji muszą zostać dostarczone dokładnie raz.
7. Historia naukowa pozostaje własnością table autosave; interaktywna telemetryka nie powiela kompletnej historii kroków.

## 3. Architektura

### 3.1. Kolejka latest-only w CLI

`PendingScalarRows` zachowuje najwyżej:

- pierwszą nieopublikowaną próbkę sekwencji, jeśli jest próbką początkową;
- jedną najnowszą nieopublikowaną próbkę nieterminalną;
- jedną terminalną próbkę, która zastępuje nieterminalną próbkę tego samego kroku.

Nowa próbka pośrednia zastępuje wcześniejszą oczekującą próbkę pośrednią tej samej sekwencji zamiast dopisywać kolejny element. Reset numeru kroku w nowym etapie pozostaje rozdzielony przez istniejący `ScalarSequenceKey`. Publikacja terminalna zachowuje dotychczasową możliwość ponowienia po błędzie transportu, ale nie tworzy duplikatu po sukcesie.

CLI może nadal budzić publisher zgodnie z trybem fast/slow. Kolejka nie może jednak rosnąć proporcjonalnie do liczby kroków solvera ani opróżniać serii historycznych próbek do UI.

### 3.2. Serwerowy QoS `scalar.sample`

API otrzymuje zaakceptowaną próbkę scalar frame i przekazuje ją do jednego właściciela QoS w `AppState`.

Właściciel przechowuje:

- czas ostatniej publikacji;
- najnowszą oczekującą próbkę wraz z `session_id`, `run_id` i rewizją;
- identyfikator zaplanowanego flushu;
- tożsamość bieżącej sekwencji, aby odrzucić spóźnione zadania poprzedniej sesji lub runu.

Reguły publikacji:

1. Pierwsza próbka sekwencji jest publikowana natychmiast.
2. Próbka terminalna jest publikowana natychmiast i usuwa starszą oczekującą próbkę tej sekwencji.
3. Pozostałe próbki są publikowane nie częściej niż `scalar_telemetry_publish_ms`.
4. W oknie QoS przechowywana jest wyłącznie najnowsza próbka.
5. Zaplanowany flush ponownie odczytuje aktualną politykę; zmiana ustawienia nie wymaga restartu CLI ani połączenia WebSocket.
6. Wyłączenie `scalar_sample_enabled` usuwa oczekującą próbkę i nie publikuje jej później.
7. Zmiana sesji/runu unieważnia oczekujący flush poprzedniej tożsamości.

W ten sposób edytowalna polityka steruje rzeczywistym strumieniem docierającym do Control Roomu, niezależnie od wewnętrznej częstotliwości kroków solvera i synchronizacji CLI -> API.

### 3.3. Demand-driven telemetry CPU/GPU

Podczas aktywnego runtime API publikuje dwie lekkie zmiany zasobu:

- `/v2/sessions/current/diagnostics/cpu`;
- `/v2/sessions/current/diagnostics/gpu`.

Zmiany należą do osobnego kanału QoS `DiagnosticsSummary`, którego okno wynosi `diagnostics_summary_ms`. `solver-profile` pozostaje w dotychczasowym kanale lifecycle i nie zostaje przypadkowo spowolniony do częstotliwości telemetryki sprzętowej.

Frontend `RealtimeInvalidationBridge` unieważnia dokładne klucze zasobów. `ResourceRuntimeStore` wykonuje fetch wyłącznie wtedy, gdy dany zasób ma zamontowanego słuchacza. Zamknięty panel Diagnostics generuje zatem zdarzenie WebSocket, ale zero requestów CPU/GPU. Po zakończeniu runtime API przestaje publikować te invalidacje.

### 3.4. Nazwy w UI

Okno Communication używa nazw odpowiadających wykonaniu:

- `Scalar delivery ms` dla `scalar_telemetry_publish_ms`;
- `Diagnostics refresh ms` dla `diagnostics_summary_ms`.

Nie powstaje nowy magazyn ustawień ani druga polityka frontendowa.

## 4. Przepływ danych

```text
solver step
  -> CLI PendingScalarRows (first + latest + terminal)
  -> scalar frame HTTP
  -> API scalar QoS (effective communication policy)
  -> scalar.sample WebSocket
  -> EventBus
  -> FooterTelemetry

active runtime tick
  -> diagnostics invalidation QoS (5 s default)
  -> resource.batch_changed WebSocket
  -> exact CPU/GPU resource invalidation
  -> HTTP fetch only when Diagnostics is mounted
```

## 5. Obsługa błędów i wyścigów

- Błąd scalar frame pozostawia próbkę w kolejce CLI do istniejącego ponowienia.
- Błąd publikacji WebSocket nie tworzy osobnego nieskończonego retry; mechanizm replay/resync pozostaje właścicielem odzyskania połączenia.
- Flush QoS sprawdza tożsamość sesji/runu przed publikacją.
- Terminalna próbka wygrywa z oczekującą nieterminalną próbką tej samej sekwencji.
- HTTP 404/503 telemetryki CPU/GPU przechodzi przez istniejący ograniczony mechanizm błędu zasobu; invalidacja nie tworzy hot loopu.
- Zmiana polityki na dłuższe okno jest respektowana przez ponowną ocenę deadline'u podczas flushu.

## 6. Testy i bramki akceptacji

### 6.1. CLI

1. Wiele próbek pośrednich tej samej sekwencji pozostawia jedną najnowszą próbkę oczekującą.
2. Pierwsza próbka nie jest tracona przez późniejszą próbkę przed pierwszym flush-em.
3. Terminalna próbka zastępuje próbkę tego samego kroku i jest publikowana dokładnie raz.
4. Błąd sinka zachowuje próbkę do ponowienia.
5. Kolejka pozostaje ograniczona przy 10 000 szybkich kroków.

### 6.2. API realtime

1. Próbki w jednym oknie dają jedno `scalar.sample` z najnowszą rewizją.
2. Pierwsza i terminalna próbka omijają opóźnienie.
3. Patch `scalar_telemetry_publish_ms` zmienia deadline bez restartu.
4. Zmiana runu usuwa oczekującą próbkę poprzedniego runu.
5. CPU/GPU tworzą osobny batch `DiagnosticsSummary` z oknem `diagnostics_summary_ms`.
6. `solver-profile` zachowuje lifecycle QoS.
7. Brak aktywnego runtime nie publikuje invalidacji CPU/GPU.

### 6.3. Frontend

1. Jedna invalidacja CPU/GPU pobiera dokładnie jeden zasubskrybowany zasób.
2. Brak subskrybenta daje zero requestów.
3. Wielu konsumentów jednego zasobu nadal daje jedno żądanie in-flight.
4. Footer reaguje na opublikowaną próbkę bez dodatkowego pollingu.
5. `audit:idle-performance` przechodzi.

### 6.4. Runtime

Kontrolowany przebieg aktywnego solvera przez co najmniej 60 s musi wykazać:

- brak seryjnych paczek zaległych `scalar.sample`;
- częstotliwość zgodną z efektywnym `scalar_telemetry_publish_ms` z tolerancją jednego okna;
- brak pobrań `/data/fields` i `/data/quantities` bez zmiany katalogu;
- CPU/GPU odświeżane nie częściej niż `diagnostics_summary_ms` przy otwartym panelu;
- zero requestów CPU/GPU przy zamkniętym panelu;
- po zatrzymaniu solvera zero pollingów API i zero klatek viewportu bez dirty reason.

## 7. Zakres zmian

Planowana implementacja dotknie wyłącznie:

- kolejki telemetryki w `crates/fullmag-cli/src/live_workspace.rs`;
- właściciela realtime i QoS w `crates/fullmag-api/src/main.rs` oraz stanu API wymaganego przez ten właściciel;
- istniejącego kontraktu komunikacji w `crates/fullmag-session/src/communication_policy.rs` i schematach realtime tylko wtedy, gdy wymaga tego typowanie;
- dokładnych invalidacji i etykiet w `apps/control-room`;
- testów tych ścieżek oraz raportu audytowego.

Nie zmieniamy fizyki, częstotliwości table autosave, częstotliwości materializacji pól, renderera WebGL ani formatu danych liczbowych.

## 8. Odrzucone warianty

- Throttling wyłącznie w React: odrzucony, ponieważ pozostawia zbędny transport i pozorną kontrolę serwerową.
- Stałe 1000 ms i usunięcie konfiguracji: odrzucone, ponieważ nie zapewnia regulowanego QoS ani świeżości CPU/GPU.
- Komponentowy polling CPU/GPU: odrzucony, ponieważ narusza resource-first i budżet zerowego pollingu w idle.
