# ADR 0075: Popyt na wielkości live z Control Room do accepted workera

Status: wdrożone na branchu `codex/live-quantity-refresh-20261029` (29.10.2026) na zlecenie
użytkownika po audycie `docs/audits/2026-10-29-live-quantity-refresh-audit.md`.
Kompilacja w grupie Docker DEV: tak. Weryfikacja runtime na czterech torach: NOT VERIFIED.

## Kontekst

W trakcie aktywnego solve accepted worker publikował cały aktywny katalog pól przestrzennych
(`H_*`, `torque`, `eden_*`, `mat_*`) na każdym kroku, gdy mieścił się w budżecie 128 MiB.
Użytkownik ogląda zwykle jedną albo kilka wielkości. API już wyliczało listę oglądanych
wielkości (`CurrentDisplaySelection::observation_quantities`, z PATCH stanu wizualizacji),
ale korzystała z niej tylko stara ścieżka interaktywna; oba accepted workery podawały
runnerowi `DisplaySelectionState::default`.

## Decyzja

1. **Źródło popytu (API).** Popyt to suma:
   - `observation_quantities` stanu wizualizacji: aktywna wielkość, widoczne cele z kolorem
     powierzchni lub strzałkami, wielkość mapy planarnej;
   - wielkości przestrzennych odczytanych przez `GET …/fields/{q}/samples/vector` lub
     `…/meta` w ostatnich 15 s (Inspector, klient Pythona).

   Pusty popyt wyświetlania oznacza brak deklaracji klienta. Wtedy nic nie jest publikowane
   i obowiązuje pełny katalog. Kod: `crates/fullmag-api/src/live_field_demand.rs`.
2. **Kanał (API → worker).** Projektor accepted zapisuje popyt atomowo do
   `runs/<run>/live_demand.v1.json` (`schema_version = fullmag.accepted_live_demand.v1`,
   `run_id`, `quantities`, najwyżej 64 pozycje i 64 KiB), tylko gdy się zmienił.
   Plik leży obok runu, nie w prywatnym katalogu próby workera.
   Kod: `crates/fullmag-api/src/accepted_live_demand.rs`.
3. **Worker.** `AcceptedLiveObservationWriter` czyta plik najwyżej co 250 ms i instaluje
   popyt w runnerze (`fullmag_runner::set_live_quantity_demand`). Brakujący, zbyt duży albo
   obcy plik przywraca pełny katalog. Koniec zadania czyści popyt.
4. **Runner.** Ścieżki przechwytywania live zachowują `m` i wielkości z popytu
   (`live_demand::retain_demanded_live_quantities`):
   - FDM CPU: `capture_full_active_cpu_fields`;
   - FDM GPU: `capture_full_active_cuda_fields`;
   - FEM CPU/GPU: `capture_native_fem_observables`;
   - FDM multilayer CPU i GPU: generacje nieterminalne.

   Pakiety terminalne, artefakty i jawna materializacja zawsze używają pełnego katalogu.

## Konsekwencje

- Koszt kroku z publikacją pól (kopie D2H, ewaluacja pól, SHA-256, zapis) skaluje się
  z liczbą oglądanych wielkości, nie z rozmiarem katalogu.
- Po zmianie wielkości w UI pierwsza klatka przychodzi po ≤ 0,5 s (tick projektora)
  + ≤ 0,25 s (odczyt popytu) + kadencja pól. Do tego czasu endpoint zwraca brak ładunku
  live, a frontend pobiera dane po inwalidacji tej wielkości.
- Wielkość, która wypadła z popytu, zostaje w `latest_fields` z własną ramką
  i krokiem źródłowym (scalanie per wielkość). Nie jest przypisywana do nowszego kroku.
- Fizyka i punkty ewaluacji pól się nie zmieniają; zmienia się tylko zbiór kopiowanych pól.

## Poza zakresem

- Budżet per wielkość dla domen, których pełna generacja nie mieści się w 128 MiB. Worker
  nadal wybiera wtedy tryb „samo `m` co 100 kroków”. Po wejściu kadencji czasowej
  (PR #270) należy przełączyć te domeny na kadencję 1 + popyt.
- Wiadomość WebSocket klient → serwer. Popyt idzie istniejącym `PATCH /visualization/state`.
