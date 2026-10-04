# P8-53M — prywatna tożsamość odtworzonego workspace

Odtworzenie przed listenerem zachowuje ID modelu i nadaje nową sesję. Poprzedni
guard bezczynnego scratch wymagał równości tych ID, więc kolejne przejęcie
odtworzonego workspace odrzucało legalną scenę.

API zapisuje teraz immutable marker w `AppState` po udanym prywatnym restore.
Marker zawiera API instance, nową sesję, stabilny model i session epoch. Nie jest
częścią `SessionStateResponse`, `SceneDocument`, JSON HTTP ani OpenAPI. Powstaje
tylko po weryfikacji prywatnego wejścia i świeżego stanu API przed listenerem.

Acquisition sprawdza tę czwórkę pod transition lock i zamkniętą mutation
admission. Dopasowanie pozwala zachować rozdzielenie ID oraz oryginalne źródło
sceny. Nadal wymagane są brak run, pusty script path, brak stage/live state,
interactive authoring, awaiting_command, brak busy i możliwość przyjmowania
komend. Model, sesja, epoch lub API instance różne od markera nie dostają wyjątku.
HTTP snapshot nie może ustanowić tego powiązania.

Review źródeł nie wskazał blokera. Nowe regresje Rust sprawdzają dopasowanie
czwórki oraz zachowanie scratch guardu dla trusted/untrusted, busy i script.
Zgodnie z zakazem kompilacji unit tests pozostają NOT COMPILED / NOT RUN.
Nie dowodzą pełnego private restore → acquisition → ponownego restartu.

`just windows-workspace-build dev dev 3197 auto`: exit 0, produkcyjny profile
`backend-dev`, source identity passed. Baza buildu:
`641acac4f045ba59ef97755420e9eb853544c181`; source snapshot:
`e8f7fe164ed07e2da5276c228a88a8c1abd72554c0e1d6cafda98866bf77d810`;
backend digest: `46fffe6f3e126b5cfd437255d2570d878dbf5f986ab0f18a45ffbf8681c8736e`.

`just verify-windows-development-backend-api`: exit 0, **49 checks**.
Receipt: `storage/builds/fullmag-0950f4dca4ffe38f/development-backend-api-checks/checks/8bb55867d9f448baac581f443af7897c/receipt.json`.
Przebieg potwierdza startup restore, zachowanie kanonicznej sceny i edytowalności,
brak eksportu prywatnego markera oraz dotychczasowe negative startup i CLI pipe
gates. Digest przed i po jest identyczny; własne fixture zostały waitowane.

Scoped rustfmt, parser Python i diff check: PASS. Pełna sekwencja acquisition
oraz odrzucenia po zmianie epoch nadal NOT VERIFIED: prywatny acquisition nie
ma jeszcze produkcyjnego konsumenta komendy restartu. Nie dodano testowej
trasy HTTP do produktu. Publiczne `restart_available` pozostaje false;
globalny accepted-work fence, manager i UI hydration nadal nie są zamknięte.
