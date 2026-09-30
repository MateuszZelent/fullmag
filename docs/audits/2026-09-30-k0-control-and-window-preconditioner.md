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


## Korekta po #170: biblioteka runtime nie zawiera signed guards

#170 eb7c78ea7e134ec9bcd56314f985f583 terminalnie succeeded, exit 0.
Run e048e072613e408792416acc2b381692 zakończył się failed, exit 1,
z identycznymi liczbami podokien jak #169. Jednak nie dowodzi to
nieskuteczności signed guards: w diagnostyce nie ma coverage_guard_kind
ani certified_spectral_guard_count.

Kapsuła 129880aa018a44079d5fcbd234e7b991/source/tree zawiera oba pola
w poisson_airbox_schur_matshell.cpp oraz nową regresję w pliku testowym.
Biblioteka outputs/.fullmag/local/lib/libfullmag_fem.so w #170
ma natomiast ten sam SHA-256 co #169:
1f559a6ca62d42d2765312ccb77c7bba5fdccf46451f762ac582520bc3a670d3.
Jej bytes nie zawierają original_descriptor_certified_signed_ritz.
To potwierdzona rozbieżność kapsuły i dostarczonego kodu natywnego,
mimo pozytywnego receipt i aktualnego stampu binarki Rust.

Hipoteza przyczyny: cache Cargo/CMake bazuje na czasach plików, podczas
gdy kapsuły zachowują mtimes; edycja do kolejnego snapshotu może być
starsza od zakończenia poprzedniego buildu. Build script FEM nie miał
rerun-if-env-changed dla hasha snapshotu. Szczegółowe rozdzielenie
inwalidacji Cargo, CMake i selekcji kopiowanej biblioteki pozostaje do
regresji i dowodu kolejnego buildu; nie nazywamy hipotezy wyłączną przyczyną.

Dodano w źródłach śledzenie FULLMAG_SOURCE_SNAPSHOT_SHA256 przez Cargo
oraz FULLMAG_FEM_SOURCE_SNAPSHOT_SHA256 jako definicję kompilacji
targetu CMake fullmag_fem. Zmiana hasha ma wymusić przebudowanie obiektów
bez usuwania cache. Walidowane są 64 małe cyfry hex.
Rustfmt i diff check PASS; kompilacja i test odtworzenia cache NOT VERIFIED.
Następny runtime musi wykazać nowe pola i właściwą bibliotekę,
a nie tylko nowy stamp Rust. #171 nie ma tej poprawki invalidacji w snapshotcie.
