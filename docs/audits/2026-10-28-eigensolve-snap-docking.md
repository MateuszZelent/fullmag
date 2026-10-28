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

Stan: wszystkie cztery etapy wykonane. **CI i przeglądarka PASS**.
Źródła: `7fbe626bd1b7e3e2e69c09037fcb480571b0710c`, gałąź
`codex/eigensolve-integration-ui-20261026`. UI: <http://localhost:3217/workspace>.

## Dowody

[CI 40781408280](https://github.com/MateuszZelent/fullmag/actions/runs/40781408280):
1445 testów w 62 plikach, pełny typecheck i architecture hygiene PASS.
Kompilacja testów wyłącznie w GitHub Actions. React Doctor: 83/100,
12 ostrzeżeń. Nowe ostrzeżenia wydajności dotyczą krótkich list identyfikatorów
okien i krawędzi, nie tablic pól/siatki. Nie wyciszano reguł; istniejące
ostrzeżenia synchronizacji trybu ramki przez effect pozostają udokumentowane
w raporcie ruchomych okien. Nie oznaczamy całego frontendu jako wolnego od długu.

Próba `scripts/verify_eigensolve_snap_ui.mjs`: 11 checkpointów zachowało oba
canvasy oraz żywy WebGL z niezerowym drawing bufferem. Cztery kierunki mają
poprawną kolejność i proporcje 50/50 (kontrola geometrii z tolerancją 3 px).
Escape przywraca zadokowanie, upuszczenie w środku zachowuje floating, a dwa
pływające okna są dokowane razem. Brak błędów JS i prób mutacji numerycznych;
run ID nie zmienił się. Aktualny wynik to zapisany mod FEM k=+10 rad/µm;
test działał z animacją w Chromium/SwiftShader. To nie jest nowa kwalifikacja
fizyki, sprzętowego GPU ani próba podczas aktywnego Solve.

Dokładne hashe, run ID i checkpointy: [evidence JSON](2026-10-28-eigensolve-snap-docking.evidence.json).
Zachowano hashe wszystkich 14 obcych plików WIP. Frontend zaktualizował się
przez HMR w istniejącej grupie tego worktree; bez restartu innych grup.

Screeny:
- [Podgląd lewej połowy](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/snap-docking-20261028/first/preview-left.png).
- [Podgląd dolnej połowy](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/snap-docking-20261028/first/preview-bottom.png).
- [Zadokowanie jeden nad drugim](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/snap-docking-20261028/first/docked-bottom.png).
- [Końcowe zadokowanie obok siebie](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/snap-docking-20261028/first/snap-final.png).

Zakres: moduły viewport-main. Istniejące dokowanie Inspectora, Explorera
oraz diagnostyki nie zmienia się w dowolne drzewo grup okien.
