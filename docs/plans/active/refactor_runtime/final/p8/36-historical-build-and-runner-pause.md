# P8-36 — odbiór historycznego buildu i stan kolejki

Build 212 ma terminalny succeeded/exit 0. Odbiór 122 artefaktów o sumie
291 673 111 B potwierdził rozmiary, SHA-256, trusted documents, source identity
oraz wymagania z jego przypiętego commita. Szczegóły są w checkpointcie14.
Bieżący kontrakt produktu pozostaje niepotwierdzony: pakiet 212 nie zawiera
nowszego fullmag-runtime-service. Nie zmieniono obecnej bramki RequiredOutputs.

03.10.2026 03:10 UTC runner został wstrzymany przez Mateusza (drain).
Aktualny health potwierdził accepting_jobs=false, stop_requested=true,
worker_alive=true oraz job 213 cancel_requested. Build 214 pozostaje queued.
Nie restartowano runnera ani nie wznawiano kolejki. Zadano pytanie o jawne
wznowienie po zakończeniu drain; brak odpowiedzi nie jest zgodą.

Lista zadań zwróciła HTTP 500, lecz indywidualny status i health były dostępne.
To odrębny problem obserwacji; nie uznano go za brak procesu lub powód rerunu.
Native/backend/frontend stages buildu 212 mają exit 0, a oficjalny terminalny
receipt pojawił się po końcowej walidacji, bez potrzeby restartu.

Cel P0–P8 pozostaje aktywny. Status nowej usługi, generowany transport, UI,
natywny Windows i dowody solvera/archive nadal mają otwarte bramki.
Sesję 3104 i współdzielone cache zachowano; cudze zmiany nie są częścią odbioru.
