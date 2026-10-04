# Odtworzenie bieżącego task claim z durable store

Data: 25.09.2026
Zakres: P3/P5-B — read-only reconstruction istniejącego task claim.

## Wynik

`SessionStore::read_active_resource_lease_for_task` odczytuje przypisanie
taska i jedyny aktywny lease dla wskazanego zasobu pod writer lock. Zwraca
`None`, gdy task nie ma gotowego claimu; rozbieżność między katalogiem a
aktywnym lease kończy się błędem. Lease musi zgadzać się w run, task, attempt,
ownership epoch i resource.

`fullmag-runtime-control::load_current_task_claim` mapuje zweryfikowany rekord
na application `TaskClaim` i ponownie sprawdza dokładny token oraz
heartbeat-sequence przez `require_active_resource_lease`. Funkcja niczego nie
przydziela ani nie odnawia; brak taska gotowego pod aktywnym claimem jest
odmową, a nie sygnałem do stworzenia nowego lease.

Regresja API zapisuje i odczytuje claim w fixture przyjętego taska, po czym
porównuje pełny typed claim z odtworzonym z katalogu i store.

## Weryfikacja i granice

- `rustfmt --edition 2021 --config skip_children=true --check` dla
  `fullmag-session/src/store.rs` i modułów runtime-control: **PASS**.
- `git diff --check` dla zmienionych źródeł: **PASS**; pozostały wyłącznie
  ostrzeżenia Git o normalizacji LF/CRLF.
- Test API i kompilacja: **NOT RUN / NOT VERIFIED**. Managed runner ma
  `Container profile allow-list mismatch`, a `runner-doctor` nie poświadcza
  kontekstu Docker Desktop. Nie użyto builda hostowego.

Ten odczyt nie odtwarza checkpointu koordynatora ani assessment z historii,
nie wybiera/nie claimuje taska i nie wysyła komendy. CLI nadal nie używa
`fullmag-runtime-control`. Przy istniejącym journalu consumer musi użyć
`recover_coordinator`; funkcja odmawia, gdy nie ma żadnych transitionów.
W chwili tego przyrostu kontrakt nie zapisywał osobnego durable
bootstrap/checkpointu przy claimie, więc pusty journal nie odróżniał świeżego
coordinator streamu od utraconej historii. Kolejny przyrost utrwalił początkowy
stan jako `coordinator_genesis`; szczegóły i aktualne granice opisuje
[raport watermark/genesis](11-coordinator-watermark.md). Nadal nie ma
produkcyjnego CLI/supervisora, który sam wybiera task, tworzy claim i prowadzi
transport workera.
Procenty bez zmian: **P3 49%, P4 50%, P5 0%, całość około 27%**. Wspólny,
dirty checkout `master` oraz brak uruchomionego builda opisuje
[checkpoint outboxa](09-durable-prepare-outbox.md#stan-checkoutu-i-zasobow).
