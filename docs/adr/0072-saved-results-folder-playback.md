# ADR 0072 — odtwarzanie pola z samodzielnego folderu wyników

Status: accepted; zrealizowano dla regularnego FDM/Zarr. [Dowody kwalifikacji YIG](../specs/saved-results-playback-verification-20261027.md).

## Kontekst

Home rejestruje foldery wyników i czyta frames.json, ale istniejący suwak nie odczytuje pola, a przycisk viewer wymaga projektu źródłowego. Zapis Zarr odzyskany po ENOSPC może być kompletny mimo nieudanej publikacji native. Użytkownik wybrał odczyt przez backend bez ponownego solvera.

## Decyzja

Rozszerzamy rodzinę workspace/items o cienki manifest playback i binarną pojedynczą klatkę, niezależne od aktywnej sesji. Używamy istniejącej granicy backend -> OpenAPI -> facade -> resource hooks -> adapter -> moduł viewport-3d/Inspector. Nie zmieniamy Python DSL, ProblemIR, fizyki, solverów ani accepted-run lifecycle.

Jawny playback.json wiąże geometrię regularnej siatki FDM w SI, oś czasu i tablice. Brak informacji nie daje prawa do ich odgadywania ani wykonania wejściowego Python. Pierwszy reader obsługuje wyłącznie Zarr v2 uncompressed f64 AoS xyz; FEM i inne formaty pozostają poza tą realizacją. source_note ujawnia kontekst odzyskania, a complete opisuje dane, nie powodzenie publikacji.

## Konsekwencje i obowiązki

Folder i bufor są przypięte przez id/revision/stage/frame. Publiczne ścieżki opisano w [kontrakcie](../specs/saved-results-playback.md). Walidacja blokuje ucieczkę ścieżki/symlinki, nadmiarowe dane, NaN, brak chunku i drift rewizji. Pola nie trafiają do JSON statusu ani WebSocket.

Kontroler UI przechowuje wyłącznie wybór, geometria i bufory mają oddzielny cykl życia, a renderer pracuje na żądanie. Zmiana czasu nie mutuje sesji ani projektu. Wspólny Inspector i istniejący Canvas pozostają jedynymi powierzchniami odtwarzania.

Obowiązkowe są wygenerowany kontrakt API, testy czytnika i klienta, typecheck/lint oraz rzeczywisty dowód zmiany zapisanej klatki i poprawnego WebGL. Zakaz kompilacji natywnych testów pozostaje jawny. Sam build nie stanowi naukowej kwalifikacji.

## Rollback i zgodność

Stare listowanie i inspekcja folderów pozostają dostępne bez deskryptora; otwarcie 3D zgłasza wtedy brak obsługi. Wyłączenie polecenia otwierania zachowuje wszystkie zapisane wyniki i receipty. Nie dodajemy GC, migracji cache ani naprawy nieudanego ownera runtime.
