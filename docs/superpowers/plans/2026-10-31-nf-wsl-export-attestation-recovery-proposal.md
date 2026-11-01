# Propozycja: attestacja eksportu N/F w WSL i zamknięcie nieuruchomionej próby

Stan: przygotowane, niezastosowane; 31.10.2026.

## Problem i dowody

Build BORIS `b83ab46ac347452d96d86b27cbfaf990` zakończył się poprawnie wraz z ABI binary64. Próba porównania `81d5af6c2e1542288bbe544253deca1a` odmówiła przed uruchomieniem pierwszego solvera, ponieważ Docker Desktop zamienił ścieżkę klienta na alias `/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Ubuntu/...`. Kontroler porównuje te ścieżki tekstowo. Istniejący `docker_dev_codegen._source_mount_matches_selected` potwierdził zgodność katalogu przez `samefile` (to samo urządzenie i inode). Sam prefiks aliasu nie jest dowodem.

Kontener `bc862d9e8ceae7ba3c625c304d00285862a0566eacbd08f4186038fb1d012f6f` ma stan Created, PID 0, zerowe StartedAt/FinishedAt. Nie był uruchomiony. Helper `ad33d704f4f22c9c0354c6a34121713b2f7af022d969bed01fd7bc1d5871f12b` pozostaje oryginalnym właścicielem blokady i czeka na terminal operacji. Wszystkie dane pozostają zachowane.

## Dokładny zakres poprawki

Jeden warunek w `scripts/docker_nf_common_volume.py` ma używać istniejącej funkcji sprawdzającej dokładną ścieżkę albo alias WSL z dowodem tożsamości inode. Nie dodajemy ogólnej listy dozwolonych prefiksów ani alternatywnego storage. Pozostałe sprawdzenia obrazu, etykiet, komendy, dostępu, liczby mountów i zasobów pozostają wykonywane.

Patch SHA256: `2f1966e50607a9ffaea6900a92fb69b481f0d1aead1808a26e3db889b76c85a4`. SHA256 źródła przed zmianą: `fe4d90418f0ba766afbf0195e155a8eb8937b59cd4cabc5ce27d2d82da56ad2a`. Kandydat i patch są w wolumenie kontrolnym: `verification/nf-wsl-export-attestation-20261031/`.

Sprawdzono rzeczywisty kontener i 12 odmów: obcy katalog, brak/niepoprawny token aliasu, traversal, nieobsługiwany prefiks, zmieniony dostęp/typ eksportu, dodatkowy mount, obca grupa/obraz, zmieniony limit RAM i komenda. Wszystkie 13 kontroli przeszło. Nie kompilowano testów Rust i nie uruchomiono solvera N/F.

## Proponowane kontrolowane zamknięcie starej próby

Request SHA256: `d27d5fbc78314c3d36d5d4c5c240de23fc39693ef1b51e84b8ed1ef9238ef36e`. Pierwotny receipt SHA256: `84b27e293825232dee051d50d3b1dbe0a733840a6408d94ae96d375d31d66fc1`. Dokładny proponowany terminal SHA256: `8b396eb573a783b3799ee1e2c68c76e9c7964d1c3e85f896c61881fdf74f6809`. Pliki `request.json` i `proposed-terminal.json` są przygotowane w tym samym katalogu kontrolnym.

Przed zapisem ponownie sprawdzimy dokładne bajty receiptu, helpera i jego oryginalną komendę/mounty, token active, brak terminala, nieobecność procesu kontrolera oraz stan Created jedynego kontenera naukowego. Pełna attestacja proponowanego kontrolera musi przejść. Następnie przez istniejący atomowy writer BuildControl opublikujemy przypięty failed-confirmed receipt i terminal. Tylko oryginalny helper może zwolnić active; nie usuwamy blokady ręcznie. Oryginalny receipt pozostaje zachowany w przeglądzie. Kontener naukowy, jego warstwa zapisu, obrazy, wolumeny i dane pozostają.

Po potwierdzeniu zamknięcia zastosujemy dokładny patch i wykonamy jedną nową próbę porównania przez `just docker-dev-nf-common-qualify`, z istniejącym producentem i tym samym pakietem Fullmaga. Zmiana kontrolera hostowego nie zmienia pięciu przypiętych helperów producenta BORIS. Nadal obowiązuje pełna weryfikacja pochodzenia podczas nowej próby; żadnej bramki nie pomijamy.

## Odrzucone alternatywy i granice

Nie przyjmujemy aliasu na podstawie tekstowego prefiksu, nie zmieniamy storage wyników na wolumen, nie przenosimy demona Docker i nie restartujemy WSL. Nie uruchamiamy starego kontenera ani nie ponawiamy nieznanego wykonania. Odmowa przy jakiejkolwiek zmianie pinów pozostaje obowiązkowa.

To naprawa bramki attestacji i jawna rekoncyliacja jednej nieuruchomionej próby, nie kwalifikacja fizyczna. Zakres obejmuje ochronę współdzielonego runtime, dlatego wymaga decyzji według AGENTS.md §8.

Dokumentacja Docker o translacji bind mountów: https://docs.docker.com/engine/storage/bind-mounts/ . Dowód konkretnego mapowania pochodzi z lokalnej kontroli inode, nie z tej dokumentacji.


## Wykonanie zatwierdzonej operacji — 01.11.2026

Użytkownik zatwierdził dokładny patch, kontrolowane zakończenie starej próby i jedno nowe porównanie. Po integracji mastera ponownie sprawdzono wszystkie piny. Oryginalny helper `ad33d704…` potwierdził zakończenie kodem 0 przez obserwację Docker wait i sam zwolnił active; nie kasowano blokady ręcznie. Receipt i terminal mają dokładny zatwierdzony SHA256 `8b396eb573a783b3799ee1e2c68c76e9c7964d1c3e85f896c61881fdf74f6809`. Kontener naukowy `bc862d9e…` pozostaje Created, PID 0, bez wykonania solvera.

Zastosowano wyłącznie zatwierdzony warunek attestacji, SHA256 kontrolera po zmianie `36ae65cb11bf39b6b527395c9bb777f2f9c37102603d9d58c8cba17dbfef8559`. Przeszła rzeczywista attestacja i 12 odmów. Trwała regresja odtwarza błąd starego warunku; po poprawce cały zestaw 20 testów interpretowanych przeszedł. W istniejącym mocku operacji uzupełniono wymagane przez aktualny BuildControl przypięcie helpera i stan aktywnej operacji. Pierwszy wynik z nieaktualnym mockiem pozostaje zachowany, końcowy raport to `regression-red-green-20261101-v2.json`. Nie kompilowano testów Rust.

Dowody: `verification/nf-wsl-export-attestation-20261031/{fresh-preflight-20261101.json,applied-20261101.json,post-master-pins-20261101.json,regression-red-green-20261101-v2.json}` w wolumenie kontrolnym grupy. Działający pakiet nadal jest przypięty do `27ed093e182435a1ba6ed84b8df6d422ba692436`; po aktualizacji probe wskazuje `151c1346c21f0ec965c151c3f48ae9d353f83ca9` i niezgodny snapshot. Producent BORIS jest zgodny ze starym pakietem. Nowe porównanie nie zostało jeszcze uruchomione: potrzebny jest build spójnego pakietu i ponowne przygotowanie referencji dla niego; nie zdejmujemy bramki zgodności źródeł.
