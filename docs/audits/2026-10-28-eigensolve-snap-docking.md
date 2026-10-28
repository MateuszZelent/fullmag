# Dokowanie widoków przez przeciąganie do krawędzi

Cel: wykres i 3D można przeciągnąć do krawędzi środka workspace, zobaczyć
animowany podgląd i puścić, aby utworzyć podział 50/50. Przenoszenie nie
zmienia właściciela rendererów ani stanu solvera.

1. Kontrakt: lewo/prawo = podział obok siebie; góra/dół = podział pionowy.
   Strefa aktywacji ma do 32 px wewnątrz krawędzi i tolerancję 24 px na zewnątrz.
   Środek pozostawia okno pływające. Escape/pointercancel anuluje gest.
2. Implementacja: hit test i plan rozmieszczenia w viewportDocking; PanelFrame
   emituje fazy gestu, host atomowo wybiera kolejność, redokuje sąsiada i ustawia
   50/50. Wyparte trzecie okno pozostaje pływające. Jeden widoczny moduł bez
   sąsiada zajmuje cały obszar. Podgląd nie przechwytuje wskaźnika, szanuje
   prefers-reduced-motion; ciężkie moduły pozostają pod stałym rodzicem.
3. Weryfikacja: CI testów i typów oraz rzeczywisty mod w Chromium. Cztery
   krawędzie, podgląd, proporcje, Escape, upuszczenie w środku, oba okna
   początkowo pływające; zachowanie obu canvasów i żywego WebGL. Bez Solve.
4. Raport: screeny podglądu i zadokowanego układu, dowody i commit/push.

Stan: implementacja gotowa do weryfikacji; końcowe CI/browser w toku.
Zakres: moduły viewport-main. Istniejące dokowanie Inspectora, Explorera
oraz diagnostyki nie zmienia się w dowolne drzewo grup okien.
