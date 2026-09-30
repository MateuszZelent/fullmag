# K0: wejście kontrolne i bramki okna, 2026-09-30

## Zakończona poprawka wejścia

Commit 5749897f71d6e0e9d9dff65951cccdeaf479c836 rozdziela pojedyncze
Gamma od Floqueta: PeriodicBC + periodic_airbox_k0 przy k0, bez zmiany
geometrii, materiału, demagu, siatki i progów. Dwie regresje Python/IR:
46 PASS. Kontrole noty/source-map PASS.

Przed poprawką run fd0a2e437ccf40009bf81eaec1578a42 na runtime #169
zatrzymał się w plannerze, przed solve. Nie wolno interpretować go jako
niezbieżnego k0.

## Dowód runtime po korekcie

Runtime #169: job da4f8f86efb94b5cb32642bdb3c0893e, succeeded, exit 0.
Wrapper przed runem zweryfikował receipt i wymagane hashe artefaktów.
Run 78721295af26413680a1b863406e4a30, failed, exit 1.
Sonda demagu passed: Nz=0.9975062344139578, Ny=-1.3513934655747887e-31.
Global_y componentwise residual=5.310767392830496e-16;
global_z=6.437539947786296e-16. Dawna norma z dzieleniem przez
niemal wyzerowane źródło global_y nadal wynosi 0.08035, lecz nie jest
bramką przyjęcia. Jej zakres diagnostyczny pozostaje jawny.

50 podokien: 25 converged, 15 coverage_deferred_to_refinement,
8 frequency_window_local_coverage_not_certified, 2 slepc_diverged.
Nie ma zaakceptowanego, opublikowanego punktu dyspersji k0.
Sonda nie dowodzi pokrycia widma ani zbieżności SLEPc.

## Wprowadzona poprawka źródłowa, jeszcze bez dowodu runtime

Małe okna k0 (real-split <=512 DOF) otrzymują cache nieprzesuniętego
preconditionera Schura z demagiem, tworzony raz na kontekst okna.
Każde podokno duplikuje cache i odejmuje własne sigma B.
MatShell i bramki pełnych równań/pokrycia pozostają niezmienione.
Nieudane tworzenie/duplikowanie cache kończy solve błędem.
Większe okna zachowują magnetic-only; limit 8192 single-shift nie zmienia się.
Cache jest niszczony z kontekstem; nie przechodzi pomiędzy oknami/problemami.

Regresja natywna zachowuje znane 9.3 GHz w sprzężonym deskryptorze,
sprawdza wiele przesunięć i dwa kolejne okna. Kompilacja/wykonanie NOT VERIFIED:
czasowy zakaz kompilowania testów pozostaje, runtime-only nieaktywny.
Kontrole matematycznej dokumentacji 10 PASS; source-map i diff check PASS.
Nie commitowano tego fragmentu jako ukończonej poprawki natywnej.

## Następna kolejność

1. Poczekać na terminalny #170 i sprawdzić jego receipt: signed guards K0.
2. Powtórzyć poprawny pojedynczy k0; rozdzielić coverage od divergences.
3. Po #171 uruchomić positive-six DE/BV: certyfikaty każdego modu,
   eksport zbiorczy, profile i tracking.
4. Zweryfikować nowy cache i diagnostykę failed-KSP w managed runtime,
   po rozstrzygnięciu już zadanego pytania o legalny profil builda.
5. Dopiero potem uzupełnić k0 na wykresie; zachować otwarte bramki
   zbieżności, A1/COMSOL i frontend.

Pełny diagnostyczny JSON i SHA-256 wejść:
C:\git\fullmag\storage\runs\eigensolve-dispersion-plan-20260-c5dfad6d7f548079\da4f8f86efb94b5cb32642bdb3c0893e\comsol-dispersion\78721295af26413680a1b863406e4a30\gamma-control-diagnostic.json
