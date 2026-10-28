# Niezależne okna wyników: plan i dowody

Worktree: eigensolve-integration-ui-20261026. Cel użytkownika: układać wykres,
3D i Inspector jako niezależnie przesuwane i skalowane okna.

1. **Kontrakt:** osobna ramka każdego modułu viewport-main; dock/float,
   przeciąganie, resize, maksymalizacja, ukrycie i przywrócenie z zakładki.
2. **Implementacja:** użyć PanelFrame oraz istniejących separatorów Resizable.
   Puste kotwice mierzą miejsca dokowania. Okna pozostają pod stałym rodzicem,
   więc zmiana pozycji nie przenosi canvasów w drzewie React. Jeden moduł ma
   najwyżej jedną instancję. Okno pływające pozostaje widoczne po zmianie
   zakładki; nieaktywne zadokowane okno jest odmontowane zgodnie z lifecycle.
   Ułożyć dwa zadokowane widoki obok/pod sobą, zamieniać kolejność. Pozycje i
   rozmiary pływających okien zapisuje istniejący PanelFrame.
3. **Weryfikacja:** regresje lifecycle w CI (bez lokalnej kompilacji testów),
   przeglądarka: rzeczywisty mod, ciągłość canvas/animacji przy dock/float/resize,
   skróty klawiaturowe, resize separatora, ukrycie/przywrócenie i WebGL.
   Żadna operacja layoutu nie może wysłać Solve/Stop/Cancel ani zmienić run ID.
4. **Raport:** screenshoty, CI, zachowanie cudzych WIP, commit i push zmian.

Stan: implementacja w toku, runtime/browser jeszcze NOT VERIFIED dla nowego
mechanizmu. Wcześniejsze R6 nie jest automatycznie dowodem dla tych zmian.
