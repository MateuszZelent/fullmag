# P6-78 — wybór obiektu po zatwierdzeniu szkicu

03.10.2026. W natywnym workspace Windows zmiana nazwy szkicu, a następnie
Apply Draft zapisywały obiekt, lecz wybór tego obiektu uruchamiał guard
niezapisanych zmian. Guard odczytywał poprzedni `dirty=true` przed kolejnym
renderem React. Apply and continue próbowało ponownie wysłać już zapisaną
transakcję, kończąc konfliktem revision. Nie powstał duplikat.

Hook rejestrujący formularz zwraca teraz lokalne potwierdzenie zapisu.
Po ACK transakcji GeometryObjectPanel czyści stan fasady formularza przed
synchronicznym wyborem obiektu. Sprawdza aktualnego właściciela formularza
oraz dotychczasową granicę sesji. Spóźniony ACK nie może wyczyścić szkicu
nowego formularza ani przejąć jego wyboru. Nie dodano ogólnego obejścia
guarda. Historia przechwytuje stan po zapisie tylko dla bieżącego formularza.

Browser: PASS. W sesji `session-18daff56b8f163e400036d24` zmieniono nazwę
walca na `Windows verified cylinder` i Translation X na `2e-7 m`.
Apply Draft zapisało obiekt `windows-verified-cylinder-musa85jv`, scene
revision 2. Explorer wybrał obiekt i Inspector pokazał committed SceneDocument;
nie wyświetlił modalu niezapisanych zmian. Poprawka dotarła przez HMR do
działającej aplikacji, bez kompilacji Rust.

Produkcja TypeScript noEmit: PASS, receipt
`8d6b8943460d4337a20668dd34ebcdcb`. Dodano regresje kolejności ACK/selection
oraz spóźnionego ACK innego właściciela. Testy DOM **NOT COMPILED / NOT RUN**
zgodnie z bieżącym zakazem kompilacji testów. Bieżący przebieg był FDM CPU;
Airbox/FEM i pełne authoring/undo/redo pozostają **NOT VERIFIED**.
