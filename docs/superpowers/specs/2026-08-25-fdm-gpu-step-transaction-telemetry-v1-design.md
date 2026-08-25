# Telemetryka transakcji kroku FDM GPU v1

## Cel

Projekt zamyka brak telemetryczny z `FDM-GPU-TRX-001`: produkcyjna ścieżka CUDA ma raportować rzeczywisty koszt snapshotu i rollbacku transakcji kroku, bez wiązania kontraktu z opcjonalną optymalizacją FSAL.

## Zakres

Zmiana obejmuje wersjonowany ABI C/C++, odpowiadający mu layout Rust FFI, liczniki w `Context`, pomiar w granicach capture/rollback oraz bezstratne przeniesienie danych do execution provenance. Nie zmienia fizyki, algorytmów integratorów, klucza RNG ani semantyki commit/reject.

## Kontrakt ABI

Powstaje append-only struktura `fullmag_fdm_step_transaction_telemetry_v1` i funkcja zapytania `fullmag_fdm_backend_get_step_transaction_telemetry_v1`.

Struktura zawiera:

- `abi_version` i `struct_size`;
- `accounting_valid`;
- `capture_count` i `rollback_count`;
- `capture_d2d_bytes` i `rollback_d2d_bytes`;
- `rollback_latency_total_ns` i `rollback_latency_max_ns`;
- `accepted_step_index` i `attempt_generation`;
- `thermal_rng_draws` i `stale_publication_count`.

ABI odrzuca niezgodną wersję lub rozmiar. Wszystkie liczniki są monotoniczne. Przepełnienie ustawia `accounting_valid = 0`; nie wolno raportować wartości nasyconej jako poprawnego pomiaru.

## Granice pomiaru

Capture nalicza wyłącznie kopie D2D zakończone powodzeniem. Dla magnetyzacji jest to `3 * cell_count * scalar_bytes`; ABM3 dodaje trzy trójskładnikowe pola historii. Nieudany częściowy capture nie zwiększa `capture_count`, ale unieważnia accounting, jeśli nie można jednoznacznie ustalić zakończonego payloadu.

Rollback latency obejmuje pełną granicę przywracania stanu urządzenia: uporządkowanie default stream, kopie magnetyzacji, opcjonalne kopie historii ABM i końcową synchronizację compute stream. Pomiar używa monotonicznego zegara hosta wokół synchronicznie zakończonej operacji; nie wymaga dodatkowej synchronizacji CUDA poza istniejącą granicą rollbacku.

`rollback_count` i `rollback_d2d_bytes` rosną tylko po pełnym, udanym przywróceniu authoritative state. Nieudany rollback unieważnia accounting i pozostaje błędem wykonania.

## Własność i przepływ danych

Liczniki należą do natywnego `Context`, ponieważ tylko ta warstwa zna wykonane kopie i granice synchronizacji. Getter ABI zwraca snapshot bez alokacji i bez wywołań CUDA. Rust FFI mapuje strukturę jeden do jednego. Runner zapisuje osobny obiekt `fdm_gpu_step_transaction_telemetry` w provenance; nie wylicza wartości z ogólnych liczników transferów i nie parsuje tekstu diagnostyki.

Telemetryka transakcji pozostaje niezależna od `fullmag_fdm_fsal_telemetry_v2`. Integrator bez FSAL publikuje ten sam kontrakt transakcyjny.

## Obsługa błędów

- Niezgodność ABI kończy zapytanie kodem `FULLMAG_FDM_ERR_ABI`.
- Null handle lub null output kończy się `FULLMAG_FDM_ERR_INVALID`.
- Przepełnienie lub niejednoznaczny częściowy transfer ustawia `accounting_valid = 0`.
- Brak telemetryki nie może zostać zamieniony na zerowe, rzekomo poprawne wartości w provenance.
- Błąd pomiaru czasu nie może zmienić wyniku rollbacku; unieważnia jedynie accounting telemetryki.

## Testy

Implementacja przebiega test-first:

1. test layoutu C/Rust i symbolu ABI;
2. test niezależności od FSAL;
3. test liczby bajtów magnetyzacji dla single/double;
4. test dodatkowego payloadu ABM3;
5. fault-injection: udany rollback zwiększa liczniki, nieudany unieważnia accounting;
6. test monotoniczności total/max latency;
7. test serializacji provenance bez utraty pól;
8. istniejące testy retry/RNG/checkpoint muszą pozostać zielone.

Testy kontraktowe bez GPU dowodzą layoutu i przepływu danych. Twierdzenie o rzeczywistym wykonaniu CUDA wymaga testu zarządzanego na urządzeniu; test hostowy nie jest takim dowodem.

## Ograniczenia wydajnościowe

Getter nie alokuje, nie synchronizuje urządzenia i nie wykonuje transferów. Hot loop dodaje jedynie bezpieczne operacje licznikowe przy już istniejących granicach capture/rollback. Pomiar czasu nie dodaje nowej synchronizacji. Telemetryka nie może zmienić liczby kopii D2D ani payloadu transakcji.

## Poza zakresem

- zmniejszenie obecnego snapshotu transakcji;
- zmiana polityki checkpointów;
- zmiana algorytmu RNG lub retry;
- telemetryka FEM GPU;
- migracja starszych struktur FSAL.

## Kryteria akceptacji

- ABI C i Rust ma zgodny, testowany layout;
- rzeczywiste udane kopie D2D są raportowane osobno dla capture i rollbacku;
- rollback publikuje count oraz total/max latency bez dodatkowej synchronizacji;
- accounting fail-closed wykrywa przepełnienie i częściową porażkę;
- runner zachowuje wszystkie pola w provenance;
- kontrakt działa niezależnie od FSAL;
- testy retry, RNG, checkpoint i fault-injection przechodzą;
- żaden build, cache ani artefakt generowany nie trafia do indeksu Git.
