# S10 — certyfikaty statycznych pól Ku v2

Zakres: przyrost obsługi stałego pierwszorzędowego Ku w FEM CPU. Nie ustanawia publicznej legalności Ku ani kwalifikacji solvera. Historia i cały plan S00–S12 pozostają wymagane.

## Defekt i poprawka

Poprzedni certyfikat v1 zawierał wyłącznie H_ex, H_demag, H_ext i H_eff. Natywna anizotropia ma osobny kanał, więc prawidłowe H_eff z Ku nie spełniało starej dekompozycji. Walidator Python dodatkowo sprawdzał tylko format SHA-256, nie zgodność podpisu z bajtami pól.

V2 dodaje h_anisotropy_a_per_m, oddzielny namespace oraz kodowanie ex/demag/anisotropy/ext/eff/phi z licznikami u64 i f64 little-endian. V1 zachowuje namespace, kolejność i serializację przy braku nowego widoku. Deklarowane Ku=0 nadal wymaga v2. Pomierzone H_eff jest weryfikowane w kolejności ((H_ex+H_demag)+H_anisotropy)+H_ext; nie jest rekonstruowane w celu ukrycia różnicy.

Natywny terminalny eksport pobiera H_ani z dynamical field. Relaksacja i refresh zapisują właściwy wariant oraz pliki v1/v2; handoff i konsumenci wymagają spójności materiału, wersji i obecności pola. Observer porównuje niezależnie pole stałego Ku przy przyjętym m0, z maską magnetyczną. Publiczne guardy nadal są zachowane.

## Dowody

- RED ujawnił odrzucenie poprawnego v2, przyjmowanie nieogłoszonego pola w v1 oraz brak weryfikacji rzeczywistego podpisu.
- GREEN: 42 lekkie testy Python (18 przypadków wersji pól, digestu, błędów i kolejności sumowania oraz 24 istniejące przypadki runtime validatora).
- Stałe niezależne preimage dają sha256:534a654a6ca21daff11b59fc99026f02ab3f02f3f341bec6c8ead73df73fe730 dla fixture v1 i sha256:3b4b095aa8a9ed90102425a27ed8cceab494f88816dbd4f5101d14883d278a54 dla v2. Źródłowe regresje Rust wiążą te same wartości i zamrożony JSON v1.
- Parser rustfmt dla pięciu zmienionych plików Rust PASS, bez edycji i bez kompilacji. Regresje natywne/Rust nie zostały uruchomione, zgodnie z zakazem w AGENTS.md.
- Nota 0831, mapa równania i źródła: working-tree validator PASS. Przed commitem wymagany jest oddzielny PASS dokładnie staged wersji.
- Job #187 c52c7fd053e745d9b113ffeb0268a472 ma wcześniejszy snapshot, bez obecnego v2 i późniejszych identity/observer. Zweryfikowane żywe make/cargo/rustc; terminalny sukces i wyniki nie były jeszcze dostępne.

## Pozostałe bramki

Niezależne review przyrostu; dokładny staged diff/parser/mapa; commit i push. Następnie migracja canonical/raw material identity do equilibrium_artifact.v8 i LinearizationState.v7 z zachowaniem historycznych v7/v6, obsługa zero-h_eff z rzeczywistą krzywizną, publiczne legalności i nowy snapshot. Wymagane managed K0/+k/-k, kompletne pola/residuale, zbieżność, COMSOL A1, pozostałe interakcje, waveguide, GPU, browser i integracja. Żadna z bramek nie jest zastąpiona testem Python.

## Korekty po niezależnym review

Review wskazało hardkodowane ścieżki v1 w bias sweepie; dodatkowy odczyt potwierdził to samo w orchestratorze etapów. Wspólny selektor w CertifiedFemEquilibriumFields jest teraz używany przez oba odczyty i finalizację. Nie ma fallbacku v2→v1. Regresja source-only obejmuje jawne Ku=0.

Jawne null jest odrzucane w Rust i Python; brak widoku v1 nadal oznacza None. Wczesny guard źródła poprzedza capture/publikację i obejmuje dodatkowe pola oraz niefizyczną w tym certyfikacie dynamikę. Dla Ku wymaga jednorodnego dodatniego Ms; istniejącego v1 bez Ku nie zawężono do jednorodnego Ms.

accepted_fields_content_sha256 jest sprawdzany jako ścisły lowercase hex. To dowód zaufanego producenta; bez zaakceptowanego payloadu konsument nie deklaruje niezależnego replay. Pełny JSON i hash refresh v1 mają zamrożoną source-only regresję sha256:ed9805381c87f09d4b3f0a47b822b1ce8e0dbaa81c5511fccb205987e21fb2f9. Zapis/odczyt field JSON v1/v2 przechodzi przez rzeczywisty Python reader/walidator. Źródłowe ścieżki odczytu całego refresh v2 sprawdzono; rzeczywisty runtime nowego przyrostu nadal jest NOT VERIFIED.

Kontener #187 zakończył native-build exit0 i sam exit0. Zweryfikowano size/SHA wszystkich 14 artefaktów receipt. Koordynator nadal running podczas końcowego verify_source; nie nazywamy tego terminalnym sukcesem kolejki. Żadnych nowych częstotliwości. Dane zachowano i nie restartowano joba.

## Końcowe review i rzeczywisty runtime #187

Niezależny re-review nie wskazał nowego P1 w ograniczonym przyroście CPU. Dodano guard accepted_observables_valid do liniowego eksportu GPU zgodnie z istniejącym ogólnym eksportem; nie ustanawia to kwalifikacji GPU. Wskazany rzekomo nieużywany import serde::de::Error as DeError pozostaje: jest potrzebny do istniejących D::Error::custom w dekoderze siatki (types.rs); usunięcie mogłoby zepsuć resolution traitu. Dokumentacja doprecyzowuje, że legacy nodal A jest nadal wspierane i digest-bound.

#187 jest terminalny succeeded/exit0; 14 artefaktów receipt ma zgodne size/SHA. Kontroler 28980 zakończył się exit1 po gamma-t3. Relaksacja L2/t3 przeszła (6138 węzłów, 30012 tetraedrów, 3 kroki), ale produkcja operatora odrzuciła periodic_mesh_certificate_v6_producer_reduction_map_not_canonical przed obliczeniem modów. Brak częstotliwości; DE/BV t3/t6/t9 nie uruchomiono. Następna konkretna poprawka dotyczy zgodności kanonicznego numerowania redukcji z certyfikatem producenta. Nie wolno pominąć walidatora ani kontynuować serii po tym błędzie.

Dokładnie staged nota/mapa i 56 źródłowych plików: validator PASS. Osiem staged plików Rust: parser PASS. Native/Rust unit tests nie były kompilowane. Przyrost pozostaje niekwalifikowany runtime; proof v2 wymaga nowego snapshotu.
