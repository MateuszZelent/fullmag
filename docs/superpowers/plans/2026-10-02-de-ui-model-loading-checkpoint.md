# Naprawa ładowania modelu DE w UI

## Potwierdzona przyczyna i korekta

Puste UI uruchamiało sesję bez modelu. Następnie próba połączenia API z buildu #195 i frontendu #197 ujawniła niezgodność identyfikatora `request_scope_epoch`: frontend pozostawał przy wykrywaniu sesji. Dodatkowo zapis checkpointów na Docker Desktop 9p był odrzucany przez kontrakt trwałości.

Działający podgląd korzysta z API i frontendu tej samej zweryfikowanej wersji #197, a workspace oraz stan sesji znajdują się w prywatnym tmpfs. Kapsuła źródeł i pakiet buildu pozostają tylko do odczytu. Jest to sesja tymczasowa; restart usuwa jej stan. Model wejściowy i dowody pozostają w kanonicznym storage.

## Model i dowody

- UI: http://localhost:3105/workspace/
- Model wejściowy: `71ec3f159b47ee7a56e471020923248c2cac283f`, `examples/fem_de_smoke_numeric.py`.
- FEM CPU, double; film 40×40×10 nm, pole 0.1 T w x, demag airbox Dirichlet.
- Trzy etapy: relaksacja, eigensolve `k_y=+10^7 rad/m`, eigensolve `k_y=-10^7 rad/m`; full_2x2, demag i Floquet.
- Prawdziwa przeglądarka: widoczny film i drzewo trzech etapów, canvas 617×556, contextLost=false, niezerowy drawing buffer.
- Eksport/import sceny po korekcie Python zachowuje także politykę solvera; GET sceny porównany z wejściem.
- Kontrole Python renderer/API: 38 passed. Kontrole launchera modelu: 7 passed.

## Naprawy źródeł i pozostałe bramki

Renderer SceneDocument poprzednio pomijał eigenmodes. Obecnie odtwarza etapy, tożsamości, k, Floquet, demag i politykę solvera. Błędne jawne count/k nie przechodzą po cichu do wartości domyślnych. Publiczny add_eigenmodes przyjmuje stage_id, zgodnie z istniejącą semantyką identyfikatorów etapów.

Hook preparation rozróżnia oczekiwany brak zasobu (404 przed Prepare) od błędu wykonania. Regresje React są zapisane, ale NIE wykonane: obowiązuje zakaz kompilacji testów jednostkowych. Ta poprawka frontendu oraz renderer Python nie są jeszcze wdrożone w immutable UI #197. W podglądzie pozostaje toast dotyczący nieistniejącego jeszcze preparation, mimo poprawnie załadowanego modelu.

Build #202 `0f941ef9a26840ab9ff190eb1c58e3f8` jest niezależnym ponowieniem #201 po korekcie guardu koordynatora. Obserwator uruchomi signed pilots po terminalnym sukcesie buildu. UI preview nie jest sesją wykonania tego obserwatora. Brak nowych częstotliwości, brak kwalifikacji fizyki; żadnego sukcesu solvera nie wnioskujemy z UI.

Status integracji: review i bramki runtime/frontendu pozostają otwarte; worktree zachowane. Pełne scalenie do master nie zostało wykonane.
