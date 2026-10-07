<!-- current-eigensolve-status-begin -->
## Bieżący stan — 2026-10-07

**Cały cel S00–S12 pozostaje aktywny.** Poniższa tabela opisuje aktualny
stan; dalsze checkpointy zachowują historię i nie zastępują bieżących dowodów.
Zweryfikowany source checkpoint: f8b616509077e84d91ce8c49ad2d8aa715e85628.
Bootstrap CI37424976665 zakończone8/8jobs PASS, obejmuje cały pakiet IR oraz
retention engine/service/API/CLI/Hub. Naprawiono strict compute resources,
cooperative preview cancel i niezależny od uptime fixture harmonogramu.
Nowa analogiczna luka przy bezpośrednim odczycie SpatialRepresentationIR Full3d
jest poprawiona źródłowo: prywatny empty-struct decoder nie zgubi dodatkowego
intentu. Review/parser PASS; nowa regresja trzech granic odczytu wymaga świeżego CI.

| Zakres | Potwierdzone | Pozostaje |
|---|---|---|
| Źródła/CI | Python, Control Room, browser fixture, generated API, Windows, FDM i API hygiene PASS;31 V04 tests PASS | Świeże CI po poprawce bezpośredniego parsera SpatialRepresentationIR oraz managed runtime dla NCV4; source CI nie jest walidacją eigensolve |
| Γ/signed15 | Zachowane pełne diagnostics nieudanego runtime234; kontrolowana recepta okna8.5–16GHz i jawny proof actual EPS dimensions | Nowy attested build, pełny window certificate Γ, potem15 punktów i sprawdzony wykres |
| Adaptive k pool | Poprawka exit telemetry, deterministyczny plan digest i kontrakty CI | Rzeczywisty świeży przebieg, pomiary CPU/RAM i serial/adaptive parity |
| Regionalne meshing | Zachowane regional fields; poprawiona jawna konfiguracja minimum, actual density fixture PASS bez zmiany threshold5nm | Pełna scoped kompozycja lower bounds i runtime consumer regionalnych minima pozostają oddzielnymi lukami |
| S09/2.5D | Frame, UV/world geometry, contours, registry i jawne Dirichlet bindings mają CI evidence | Geometry identity ma source review i waveguide CI PASS. Typed StudyIRV04/model bindings zaimplementowane i reviewed,31 nowych regresji CI PASS; world equivalence, pełne physics/invariance/equilibrium bindings, typed routing i owner MFEM |
| Nauka | Wstępne benchmarki i analityczne oracles nie domykają kwalifikacji | DE/BV, zbieżności siatki/airboxu/liczby modów, identyczny COMSOL A1 i GPU |
| GUI/integracja | Frontend/browser fixture CI PASS; PR97 otwarty | Rzeczywisty workspace z modelem/wynikami, pełne review/science gates, merge i bezpieczne cleanup worktree |

Build235 d6482966a2404d6d933a6708cdf3466d anulowano przed wykonaniem: exact070d277a8
nie zawiera NCV4. Dane i kapsuła zachowane; obserwator zakończył się terminalnie.
Następny runtime wymaga jawnego przypięcia do najnowszego zweryfikowanego SHA; recepta przygotowana, nowy job
niezgłoszony podczas wcześniejszej blokady storage. Po odciążeniu dysku zapisano
trzy commity i wykonano CI. Na2026-10-07 runner zdrowy, worker alive,
accepting_jobs=true, brak aktywnych jobów; storage ponownie spadł do około4.7GB
poniżej8GiB. Nie uruchomiono nowej kapsuły/builda. Wąski read-only preview
plan-9eb148b0b26c4b27944ee4eba61b0f58 obejmuje wyłącznie execution jobów233/234,
ostatni odczyt1/2, applied=false. Nie usuwamy danych ani nie uruchamiamy
równoległego globalnego inventory. Poprzedni pełny build zużył około27GB;
sam próg8GiB nie gwarantuje pojemności całego buildu.
Upload dwóch synthetic failure artifacts nadal nieaktywny po odmowie auto-review;
aktualny density test już przechodzi, więc jest to opcjonalna diagnostyka przyszłych
błędów. Zwolnienie miejsca potwierdzono, ale sam próg8GiB nie gwarantuje miejsca
na pełny build. Potrzebny ponowny health/storage preflight. Upload pozostaje
nieaktywny. Przygotowany cooperative cancel execution preview ma źródłowe
review i kompletne regresje obu race boundaries; AST11files/YAML PASS,
wykonanie w CI potwierdzone; aktualizacja koordynatora do tego przyrostu
nadal NOT VERIFIED.
<!-- current-eigensolve-status-end -->

<!-- master1bdb-integration-20261006 -->
## Checkpoint — najnowszy master, trzy konflikty rozwiązane

Integracja origin/master1bdb48274050e66aabcb490b52873c5b9cc02f98 do dedykowanego
brancha. Zachowano18 zmian mastera i naszą implementację. Konflikty:
.env.example zachowuje pełny Windows-only komentarz mastera;
fixture volatile zachowuje dodatkowy RepoRoot inicjalizujący kontekst testu;
launcher zachowuje identyczny rollback z multiline else. Automerge tworzył
podwójny klucz volatile_build_storage i dwa wywołania prepare adaptera:
pozostawiono pojedynczą, pełniej walidowaną wersję mastera i manifest
faktycznych compiler inputs (C przy wyłączonym mirrorze R), zamiast surowych
planowanych ścieżek helpera. Autoports/frozen inputs/TEMP rollback zachowane.
BOM zachowany, Python AST i PowerShell parser PASS, review bez blockerów.
Lokalnych testów ani builda natywnego Windows nie wykonano.

PR97 wcześniej CONFLICTING, co blokowało nowe workflow pull_request.
Push merge ma przywrócić testy nowego digestu/fixture API. To nie jest merge
PR do mastera ani zakończenie naukowej kwalifikacji. Build234 nadal przypięty
do immutable888, watcher i model niezależne od merge; źródłowe drivery pilota,
benchmarku i klienta runnera nie zmieniły się po stronie mastera. Resolver
storage otrzymał jedynie zarządzany klucz Windows-only, bez mapowania R do FEM.
Pełny S00–S12 i shared runtime/science/GUI/integracja nadal OPEN.

<!-- runtime234-canonical-worker-build-20261006 -->
## Checkpoint — build234 przyjęty, watcher przygotowuje ponowienie adaptive15

Job234 4ea6f05931f045a3a644a3c424cc1da2 potwierdzony API state running,
commit888be1c223d851aa4af1f1365f1e7cf3fc3106b9, source digest
a8aa1b32c194a44fe54b26008d2c04a4a9d0584341f164c161a1862a71e68370.
Coordinator healthy/accepting, brak aktywnych jobów przed submit,17.7GB free.
Profil fem-cpu-slepc-runtime-v2 bez kompilacji testów jednostkowych.
Submission exit0; nie duplikowano requestu mimo początkowej ciszy klienta.
Osobny list endpoint zwrócił500; status dokładnego joba i submit działały.

Watcher runtime234-canonical-signed15-adaptive obserwuje ten sam build;
po terminal succeeded/exit0 uruchomi świeży managed OpenAPI export,
dry-run i ten sam signed15 adaptive z wersjonowanym modelem ba0045fef.
Timeout obserwacji nie anuluje ani nie ponawia builda. Nowe częstotliwości
poza ukończoną parą ±10 pozostają NOT VERIFIED do postsolve.

CI merge491b1fc8578ad09814cc3e5ad3ced0f1567d2d52 ma dokładnie drzewo
cc32e3ec075c4cfc0b849aeba713dc123cf1ec62 jak branch3878; brak source drift
w ostatnim błędzie coupled M3. Fixture wzmacnia no-mutation dla checkpoint
oraz pokaże response body przy niespodziewanym500, bez zmiany fizycznego
sum guardu Oersted. Root pobrał remote master1bdb48274050e66aabcb490b52873c5b9cc02f98;
nie wykonano merge w dirty worktree. Integracja po odrębnym checkpointcie.
Pełny plan S00–S12 nadal aktywny, source/build/science/GUI rozdzielone.

<!-- canonical-worker-plan-digest-20261006 -->
## Checkpoint — przyczyna digest mismatch potwierdzona w zachowanych taskach

Request worker000000 dla sample1/k=-20rad/um zachował exact raw plan hash
f993eb61560493de2d102a500cbb1b26e3eb7647f3e991d00dda78961c29eebd,
zgodny z expected_plan_sha256; bajty równowagi także zgodne ze stored SHA.
Transport nie zmienił wejściowego JSON. FemEigenPlanIR zawiera MeshIR
per_domain_quality HashMap z kluczami0,1. Ponowna deserializacja tworzy
HashMap z niezależną kolejnością iteracji. plan_sha256 hashuje bezpośrednie
serde_json::to_vec(plan), więc nieistotna kolejność map zmienia digest.
Zamiana wyłącznie tych dwóch wpisów oryginalnego JSON daje inny SHA,
bez zmiany parametrów ani liczb. Child nie raportował actual hash;
nie przypisujemy konkretnej permutacji po fakcie. Float roundtrip włączone
w obu wersjach; worker/pool/IR/Cargo identyczne z runtime1f0e.

Naprawa właściciela eigen_k_worker::plan_sha256: deterministyczny JSON
z rekurencyjnie uporządkowanymi kluczami obiektów. Kolejność tablic,
wartości f64, SI, równania, material state i residual thresholds bez zmian.
Guard rodzic/dziecko i hash bajtów równowagi pozostają wymagane. Prywatny
format tasków bez zmiany; identyczność wykonawcy/build identity w handshake
wymusza ten sam algorytm po obu stronach. Historyczne taski i wyniki nie są
przepisywane; ich źródłowa wersja algorytmu pozostaje przypięta do runtime.
Nowa diagnostyka zapisuje actual/expected hashe, bez danych wejściowych.
Implementacja, dwie regresje i source review PASS; parser Rust/YAML PASS.
Regresje wykonania i świeży runtime pozostają OPEN. CI3878: frontend, browser
fixture, Python, generated API, API hygiene, FDM i Windows volatile PASS.
API976 PASS /1 FAIL w coupled M3 capture Oersted: oddzielna diagnoza trwa.
Regresje roundtrip/map-order i zmiany fizyki wykonywane wyłącznie w GitHub.
Do kwalifikacji potrzeba nowego managed runtime i ponowienia adaptive15.
Pełny zakres celu pozostaje zachowany.

<!-- adaptive-signed15-worker-integrity-20261005 -->
## Checkpoint — podpisany sweep15 uruchomiony, błąd integralności workera

Wszystkie zmiany źródeł wypchnięto do3878f33431ad298bd8a90a5f4c7b2de4b83e8d25;
worktree czysty przy push. CI #37379147889 in_progress przy odczycie.
Uruchomiono istniejącą kampanię de-smoke-signed-fifteen (-25..25 rad/um,
15 punktów), wersjonowany model ba0045fef, #233, L2/trzy warstwy,
FGMRES, EPS/KSP1e-9, restart8, physical rtol1e-8, adaptive CPU90% RAM80%.
Redundantny single-k-only diagnostic growth override usunięto po odmowie dry-run;
niezmienny model ustawia i publikuje ten sam growth1.3.
Kolejny managed dry-run PASS i kontener rzeczywiście wykonał relaksację
oraz bazowy solve, lecz pool przerwał z RunError:
eigen k worker input digest mismatch. Runtime/driver exit1, brak pełnego
sweepa, kontener verified_absent; run633992f212a8408abea195784abc1076 zachowany.

Diagnostyka producenta/odbiorcy task digest w eigen_k_pool.rs i
eigen_k_worker.rs trwa. Nie wyłączamy integralności, nie zastępujemy adaptive
trybem serial i nie wykorzystujemy niepełnego runa jako zweryfikowanej krzywej.
Para ±10 pozostaje udanym, odrębnym wynikiem; pełny cel nadal OPEN.

<!-- stage-status-bootstrap-guard-20261005 -->
## Checkpoint — consumer stages blokuje status do potwierdzenia sesji

Źródło pozostałych 2 FAIL i9 unhandled TypeError w CI: StartScreen ->
HomeSection -> useContinueLive -> useStageExecutionResource. Selector statusu
był włączony przed scoped session identity, mimo późniejszego guardu stages.
Przeniesiono pozyskanie scoped key przed selector; jego enabled wymaga
resourceSessionIdentity !== null. Downstream session/epoch guards i fixtures
not.toHaveBeenCalled pozostają bez zmian. Bootstrap identity niezależny.
React Doctor --scope changed: exit0,80 plików, no issues found (score88/100).
Review i parser tylko produkcyjnego TypeScript PASS; wykonanie regresji,
cały typecheck i browser proof pozostają bramkami CI/runtime.

Osobny commit ecf21cbc77f5e2325211493ecae935b51b535642 koryguje4 fixtures API:
jedna revision mutacji plus kanoniczny demand, typed snapshot bez ostrzeżenia
untyped. Nie zmienia produkcji ani guardów; oczekuje wykonania GitHub CI.
Handoff commit7ab2a4f297c24b4c6dd007aa92746f668c121285 potwierdzony parą ±10.
Pełny plan, podpisany sweep15, convergence, GUI/A1, S09 i GPU nadal OPEN.

<!-- managed-session-artifact-handoff-20261005 -->
## Checkpoint — właściwy katalog artefaktów i zakres certyfikatu

Naprawa handoff obejmuje oba managed wrappery: DE pilot i benchmark COMSOL
C0/C1/A1. Resolver czyta końcowy natywny report workspace_dir/artifact_dir,
mapuje wyłącznie mount benchmark-output i sprawdza regularne komponenty
ścieżek, manifest runu, SHA modelu, run_id oraz output-storage receipt.
Wszystkie walidatory success używają tego samego przypiętego artifact root;
nie ma newest-glob, kopiowania metadata ani nadpisywania historycznych wyników.
Błędy walidacji po solver exit0 także uruchamiają reconciliation cleanup
konkretnego kontenera. Prywatny temp cleanup pozostaje odrębnym dowodem.
Regresje resolvera kierowane są wyłącznie do GitHub Actions.
Review wykryło potrzebę obowiązkowych ID run/session oraz namespace case;
uzupełniono zgodnie z producentem case-run_id-attempt (0..99). Oba rzeczywiste
wyniki ±10 przeszły wzmocniony guard; dowód przypina hash dokładnego helpera.
Opcjonalna diagnostyka Schur korzysta z resolved root w sukcesie i log root
w błędzie; jej brak nie zmienia wyniku solvera ani nie przerywa zapisu receipt.
Wygenerowano i wizualnie sprawdzono de-signed10-runtime233-comparison.png:
2 punkty FEM na tle otwartego filmu N32 w zakresie -25..25 rad/um.

CI #37375306477 job111982360215 potwierdziło nowy output-storage lowering
contract PASS oraz eigensolve scene/profile merge contracts PASS.
Rust i frontend nadal wymagają wyniku bieżącej bramki.

floquet_geometric_bc_certified=false jest wymagane przez kontrakt
frequency-domain-artifacts-v2.md (sekcja certyfikatu fizycznego), a nie
wynikiem nieudanej propagacji flagi. C++ publikuje false, Rust odrzuca true.
Certyfikacja descriptor/seam/gauge nie obejmuje outer-boundary flux ani
mesh/airbox convergence. Flagi nie zmieniamy; odrębna kwalifikacja V9 OPEN.
Próba #233 ma rzeczywisty phi_full na 6138 węzłach oraz H_demag=-grad(phi_full)
na 30012 elementach, z manifestem physical_potential.v1.json.

AST 4 plików i YAML PASS. Resolver + required-artifact contract odczytano
na rzeczywistym poprzednim wyniku #233: 7 plików, 1 mod i pełny phi payload.
Świeża para FGMRES +10/-10 na tym samym modelu i runtime: oba wrappery exit0,
completed_unqualified. Przeszły row, KSP, physical potential, mesh L2,
growth1.3, thickness3 i selected-only preflight. f(+10)=11.205285324453774GHz,
f(-10)=11.205285254423218GHz, różnica70.0306Hz. Magnetic residualy
1.82093e-13 i7.71593e-14; potential3.77517e-14 i3.94861e-14.
Wyniki w runach0efe99d166a54c1185ce58577a677c93 i d7d3e55c869f4adeb7d3060c09f3572d;
postsolve z hashami nearest233-bound-roots-signed10-postsolve.json w evidence.
Sukces tej pary nie zamyka signed15/window/mesh/airbox/COMSOL/GUI/GPU.

CI potwierdziło oba nowe Rust default autosave testy PASS. Późniejszy target
API ma4 FAIL: trzy stare oczekiwania podwójnego revision bump i ostrzeżenie
untyped dla obecnie typed current_live_snapshot. Frontend2 FAIL +9 unhandled;
diagnoza/poprzedniego scope guard trwa. Pełne S00–S12 nadal OPEN.

<!-- runtime233-fgmres-selected-mode-20261005 -->
## Checkpoint — FGMRES wyliczył mod DE +10 rad/um

Runtime #233, model ba0045fef5978e67063047c5896384923d30960a:
FGMRES native exit0, eigensolve completed, 1 mod. Częstotliwość
11.205285324453773 GHz; magnetic full residual 1.8215819390878056e-13,
potential full residual 3.7781853230175506e-14, threshold 1e-8.
KSP true residual zmierzono dla 32/32 solve, 0 violations, max ratio
0.9806801026128354 przy rtol1e-9; EPS reason1, KSP reason2.
Geometric BC certification false pozostaje do oceny; nie promujemy samej
certyfikacji descriptor/seam do pełnej kwalifikacji geometry/physics.

Porównanie z istniejącym thin_film_thickness_oracle.py (otwarty film DE,
Ms800kA/m, A13pJ/m, B0.1T, thickness10nm, gamma0=2.211e5):
N=1 11.235414179GHz, różnica -0.26816%; N=32 11.228265979GHz,
różnica -0.20467%. Jest to pojedynczy selected mode, nie pełny spectrum,
signed sweep ani dowód zbieżności siatki/airboxu.

Wrapper exit1 pomimo native exit0: szuka metadata.json w output/pilot,
lecz publiczna polityka output storage kieruje wynik do jawnego katalogu
sesji. Runtime summary wskazuje workspace_dir i artifact_dir; fullmag-run.json
potwierdza completed/exit0 i SHA modelu, output-storage.json state succeeded.
Naprawa musi używać jawnego reportu/provenance, bez newest-glob lub przenoszenia
artefaktów. Stan wrappera pozostaje failed; historycznych receiptów nie zmieniono.
Dowody z hashami: nearest233-fgmres-numeric-observation.json oraz
nearest233-fgmres-analytic-comparison.json w preview-state-checkpoint.

Commit 774f3e89bc488af0c4425c6936b17e8dbc641ad7 wypchnięty na remote;
bootstrap #37375306477 queued przy odczycie. Default autosave runtime,
artifact handoff, GUI/A1, signed sweep, parity/zbieżność, S09 i GPU nadal OPEN.

<!-- canonical-autosave-producers-20261005 -->
## Checkpoint — trwała poprawka autosave i rzeczywista próba eigensolve

Oba domyślne producenci emitują teraz m: Python output_storage_lowering.py
(relaxation i time fallback), Rust project_output_policy.rs. Jawne polityki
oraz autorskie nazwy pól pozostają zachowane. Regresje obejmują m, format,
cadence i preservation; Rust ma oddzielne przypadki relax/time. Podłączono
je do bootstrap GitHub Actions; lokalnych testów ani ich kompilacji nie wykonano.
AST Python, parser Rust, YAML i source review PASS. Wykonanie regresji CI OPEN.

Model ba0045fef5978e67063047c5896384923d30960a z jawnym m uruchomiono
na gotowym runtime #233. Relaksacja native FEM zakończyła się po 3 krokach:
max_torque_apm=4.7383e-11, próg 1 A/m. Eigensolve rzeczywiście wystartował.
GMRES zgłosił residual recursion 5.9689e-16 wobec residual recomputed
4.6044e-11 przy restart; stop floquet_slepc_solve_failed, wrapper exit1.
Dynamic demag operator probe PASS: hermitian relative defect 5.8770e-16,
potential residual y 1.6592e-13 i z 1.3599e-14. To dowód tego probe,
nie kompletny dowód poprawności częstotliwości ani rekonstrukcji pola.
Kontener GMRES verified_absent; logi i wszystkie artefakty zachowane.

Uruchomiono pozostałą zaplanowaną próbę FGMRES: identyczny model k=+10 rad/um,
L2, 3 warstwy, growth1.3, target11.2GHz, EPS/KSP1e-9, restart8,
physical rtol1e-8. Zmieniony wyłącznie KSP type; bramki bez poluzowania.
Stan solver rows/residual/frequency pozostaje NOT VERIFIED do zakończenia.
Implicit default wymaga przyszłego runtime z poprawionymi producentami.
Pełne S00–S12, signed sweep/parity/zbieżność, GUI/A1, S09/provider i GPU OPEN.

<!-- canonical-autosave-model-retry-20261005 -->
## Checkpoint — jawny zapis kanonicznego pola przed ponowieniem k10

Próba #233 zatrzymała się przy początkowym autosave relaksacji, przed
uruchomieniem eigensolve: unsupported quantity 'magnetization'. Trace prowadzi
do domyślnych producentów w output_storage_lowering.py i project_output_policy.rs.
Kanoniczne pole m jest zredukowaną magnetyzacją (wektor, jednostka 1);
nie zastępujemy go fizycznym M = Ms m w A/m. Źródła kontraktu:
crates/fullmag-quantities/src/catalog.rs oraz docs/specs/visualization-quantities-v1.md.

Benchmark examples/fem_de_smoke_numeric.py jawnie deklaruje FieldAutosave('m',
every_steps=100), target results, layout separate, format zarr. Zachowuje
wcześniejszy format, cadence i docelową lokalizację; geometria, materiał,
demag, warunki brzegowe, relaksacja i ustawienia eigenmodes są niezmienione.
Publiczny DSL StageAutosave trafia do field_autosave.quantity w ProblemIR.
Zmiana pozwala ponowić identyczny fizyczny przypadek na gotowym runtime #233.
Nie kwalifikuje jeszcze naprawy implicit default: oba domyślne producenci
wymagają osobnej regresji CI i późniejszego managed runtime z poprawką.

Kontrola składni benchmarku AST i review diff: PASS. Nowe solver rows,
residuale i wynik częstotliwości pozostają NOT VERIFIED do zakończenia próby.
Zakres S00–S12 oraz signed sweep, parity, zbieżność, GUI/A1, S09 i GPU OPEN.

<!-- runtime233-first-real-attempt-20261005 -->
## Bieżący checkpoint — #233 PASS, pierwsza próba zatrzymana przed eigensolve

#233 (`9f2a5fa62a0541059447c88165156887`) jest terminal succeeded/exit0;
29 artefaktów i atestacja runtime-v2 zweryfikowane przez koordynatora.
Native-build trwał około 37,5 minuty. Pierwszy eksport OpenAPI blokował
justfile: master i branch zawierały 242 końcowe NUL. Zachowano oryginalne
bajty w dowodach; usunięto tylko ten ogon, prefix identyczny, parser just PASS.
Po naprawie managed OpenAPI PASS z input hashes i cleanup potwierdzonymi.

Obie próby nearest GMRES/FGMRES k=+10 rad/um przeszły dry-run. Usunięto
redundantny --solver-rtol, niedozwolony przez k2-only diagnostic gate;
niezmienny model ma default1e-8. EPS/KSP1e-9, restart8, L2/trzy warstwy,
growth1.3 i target11.2GHz zachowane; jedyna różnica to typ KSP.
GMRES wrapper exit1: powstała siatka 6138 węzłów /30012 tetrahedrów i
rozpoczęła się relaksacja FEM CPU native. Następnie runtime zgłosił
unsupported quantity 'magnetization'. Eigensolve nie ruszył; nie ma
częstotliwości. Kontener potwierdzono verified_absent, wyniki i log zachowane.
FGMRES nie uruchomiono automatycznie. Trwa trace kontraktu pola, bez
pomijania zapisu magnetyzacji ani zastępowania modelu prostszym przypadkiem.

CI a86664b30: Python-contracts PASS, generated-api PASS, API hygiene i FDM
relaxation PASS. Frontend:754 pliki PASS,4 przypadki FAIL oraz9 unhandled
errors. Zlokalizowano drugi nieosłonięty consumer statusu w AppMenu runtime
bundle; dodano ten sam guard identity. Dwa prep fixtures czekają teraz na
potwierdzony scoped revision przed włączeniem loadera, zachowując SSR,
stale refresh i abort. rDMI test wzmacnia baseline i obecny tekst odmowy.
Parser/review PASS; wykonanie korekt oczekuje CI. Fizyczny guard bez zmian.
Pełne S00–S12, shared signed sweep/parity/zbieżność, GUI/A1, S09 i GPU OPEN.

<!-- api-json-fixture-recursion-remediation-20261005 -->
## Bieżący checkpoint — materializacja aplikacji PASS, fixture API podzielony

CI #37369463128 potwierdziło kompletny krok fullmag-application, obejmujący
59 unit tests, testy integracyjne i selektor eigensolve. Kolejna bramka Rust
quantity/API/CLI zatrzymała się przy kompilacji types.rs: duży json! fixture
preview z zagnieżdżonym fem_mesh przekroczył limit rekursji makra.

Wyodrębniono fem_mesh do osobnego lokalnego Value i wstawiono do obiektu
preview. Statyczny parser JSON potwierdził identyczne dane przed/po zmianie;
parser Rust PASS. Zachowano numeric domain-quality keys i pełne asercje
round-trip. Brak zmiany typów produkcyjnych i globalnego recursion_limit.
Wykonanie poprawki oczekuje CI; lokalnych unit tests nie uruchamiano.

#233 nadal native-build, nie ma nowych solver rows. Runtime/science/GUI,
signed sweep/parity/zbieżność, COMSOL A1, S09/provider i GPU pozostają OPEN.
Pełny zakres S00–S12 jest zachowany, nie oznaczamy celu ukończonym.

<!-- scene-name-fixture-correction-20261005 -->
## Bieżący checkpoint — 102/103 regresje sceny/profilu PASS

CI #37369463128 potwierdziło wcześniejszą korektę dwóch asercji GPU/auto;
102 przypadki PASS. Ostatni FAIL to KeyError w nowo dodanej asercji nazwy:
study_name jest kluczem buildera, a dokument SceneDocument używa scene.name.
Sprawdzono producenta dokumentu i inverse scene_to_builder; asercja teraz
porównuje nazwę IR, scene.name oraz literalną nazwę autorskiego fixture'u.
Brak technicznego stem i pozostałe asercje pozostają zachowane. Parser
Python PASS; wykonanie tej korekty oczekuje CI. Produkcyjny kod bez zmian.

#233 nadal native-build. Pozostałe bramki fullmag-application, frontend,
managed FEM i nauka pozostają niezamknięte. Pełny cel S00–S12 trwa.

<!-- python-ci-assertion-remediation-20261005 -->
## Bieżący checkpoint — CI potwierdza RAM-dysk, trzy korekty asercji Python

Bootstrap #37367782823: windows-volatile-storage-contracts PASS, wraz z
przywróceniem TEMP/TMP/TMPDIR po błędzie kompilatora. FDM relaxation i API
hygiene PASS. W nowej suite sceny/profilu Python: 100 PASS, 3 FAIL.
Dwa testy GPU/auto zostały prawidłowo odrzucone przez produkcyjny guard,
lecz regex oczekiwał tekstu FEM CPU zamiast rzeczywistego kontraktu żądanej
ścieżki. Trzeci fixture oczekiwał technicznego stem scene_document, sprzecznie
z naprawionym i pokrytym innymi testami kontraktem nazwy modelu.

Poprawiono wyłącznie asercje: dokładny wymagany backend/device w komunikacie,
brak syntetycznego stem oraz zachowanie autorskiej study_name w ProblemIR.
Pozostałe asercje niezmienione. Parser Python 2/2 PASS; wykonanie poprawki
wymaga CI. Lokalnych unit tests nie wykonano. Produkcyjna fizyka i #233
bez zmian. #233 nadal kompiluje/linkuje; resume1 jest aktywny. Nowych
solver rows brak; pełny cel S00–S12 i bramki naukowe pozostają OPEN.

<!-- application-ci-compile-remediation-20261005 -->
## Bieżący checkpoint — wykryte dwa błędy kompilacji testów materializacji

CI #37367782823 dla `756c58e1cbbffbb9f7a9eb88005038961defb31a`
ujawniło E0596 w declared_execution_tests i study_execution_materialization_tests:
BTreeMap nie implementuje IndexMut. Poprawka używa get_mut z asercją obecności
materializacji, zachowując modyfikację requested.device i oczekiwanie odrzucenia
sfałszowanego żądania. Produkcyjny binder, solver, progi i dane #233 bez zmian.
Parser Rust 2/2 i YAML PASS; kompilacja/wykonanie poprawki NOT VERIFIED.

GitHub będzie wykonywał pełne testy fullmag-application, obejmujące selektory
eigensolve i przeniesione kontrakty wykonania. Lokalnego zakazu testów nie
zmieniono. Pozostałe joby CI pozostają pending; nie są wynikiem PASS.
#233 nadal native-build. Obserwator resume1 działa na tej samej niezmiennej
kapsule; brak nowych solver rows. Cel S00–S12 pozostaje aktywny i nieukończony.

<!-- ci-source-remediation-complete-checkpoint-20261005 -->
## Bieżący checkpoint — poprawki wszystkich 15 przypadków CI przygotowane

Przyrosty `ac7c23500c05537d9e3776e2e0cacf912391b7a3` i
`80de0218aadd656eb031ae471eb50e9363cc7d40` obejmują guard statusu AppMenu,
fixture'y Next/kolorów oraz kanoniczną dostępność pól modalnych. Pozostałe
cztery testy zasobów mają poprawione warunki faktycznego wykonania żądań,
pełne session/epoch/request_scope_epoch i odrębne asercje optional/required/
session 404. Test źródłowego tekstu timeoutu zastąpiono wykonaniem hooka
w fixture: timeout pozostaje błędem bez globalnego powiadomienia, zwykły
błąd emituje powiadomienie. Produkcyjnych hooków nie zmieniono.

Kontrole składni wszystkich 11 plików TS/TSX PASS; review obu przyrostów
bez otwartych uwag. To źródłowa naprawa reproducerów, nie potwierdzone
przejście suite. Lokalnych unit tests/typecheck nie wykonywano; wymagane
ponowne GitHub Actions. Poprzednie anulowanie rust-contracts wyjaśnia
annotation: hosted runner nie uzyskał przydziału. Nie jest to błąd
kompilatora ani wynik PASS. Generated API i public docs dla merge PASS.

#233 rzeczywiście rozpoczął native-build (install-cli-dev); procesy rustc,
CMake i cc1plus potwierdzono w jego kontenerze. Obserwator zakończył się
na limicie obserwacji z build_state=running, bez prób. Uruchomiono nową
obserwację tego samego joba, zachowując poprzedni zapis i logi. Nie ponowiono
buildu ani nie zmieniono jego kapsuły. Próby GMRES/FGMRES jeszcze nie ruszyły.
Pełny zakres S00–S12 pozostaje aktywny; kwalifikacja FEM/science/GUI/COMSOL,
signed sweep/parity/zbieżność, S09/provider i GPU nadal OPEN.

<!-- ci-runtime233-checkpoint-20261005 -->
## Bieżący checkpoint — runtime #233 i naprawa bramki frontendu

Merge `1f0e239a532954351250dce66c6a0d88da3d29b0` jest na remote;
PR97 potwierdzono MERGEABLE. Build #233 (`9f2a5fa62a0541059447c88165156887`)
w profilu `fem-cpu-slepc-runtime-v2` został przyjęty i ma stan running.
Koordynator zweryfikował kapsułę 7870 plików i uruchomił kontener
workera. Worker przygotowuje źródła; start kompilatora jeszcze niepotwierdzony.
Capsule digest:
`60f0093bb7d6eaebc86f3193b80617bc80b6f255b40445abfcfd98f5d6cad207`.
Wolne miejsce przekroczyło 23 GiB. R: nadal nie jest używany przez Docker.

Obserwator przygotowano i uruchomiono dla jednej pary nearest przy
k=+10 rad/um: GMRES/FGMRES, L2, trzy warstwy, growth=1.3, target=11.2 GHz,
EPS/KSP=1e-9, fizyczny próg=1e-8 i restart=8. Jedyna różnica żądanych
parametrów to typ KSP. Przed próbami wymaga sukcesu buildu, walidacji receipt,
eksportu OpenAPI i dry-run; po błędzie zatrzymuje wykonanie do diagnozy.
Nie ma jeszcze nowych wyników solvera ani dowodu kwalifikacji.

GitHub bootstrap #37363400830: generated-api-determinism, API hygiene,
FDM relaxation i browser-fixture-smoke PASS. Control Room: 745 plików testowych
PASS, 11 FAIL (15 przypadków). Rust, Python i Windows volatile zostały
anulowane przed wykonaniem — NOT VERIFIED. Log zachowano w dowodach wątku.
Analiza wykazała nieosłonięte pobranie statusu sesji przez AppMenu oraz stare
oczekiwania fixture'ów: ścieżki typów Next, podwójna konwersja sRGB, zakres
zasobów i aktualne pola/tabele częstotliwości. Guard statusu AppMenu i trzy korekty testów Next/kolorów mają parser
4/4 PASS i review bez uwag. Pozostałe poprawki zasobów/wykresów są w toku;
całość wymaga ponownego CI. Lokalnych unit tests nie wykonujemy.

Pięć map naukowych związanych z przeniesionym step_utils i eksportem sceny
przeszło validator. To dowód spójności dokumentacji, nie wykonania FEM.
Pełne S00–S12, signed sweep/parity/zbieżność, GUI/A1, S09 i GPU pozostają OPEN.

<!-- merge-resolution-checkpoint-20261005 -->
## Bieżący checkpoint — konflikty rozwiązane, regresje skierowane do CI

Scalenie mastera `3a3368cf2b8ef9909c9ca9ed6aa90bdd3e00bf72`
zostało rozpoczęte; rozwiązano wszystkie 10 konfliktów. Zachowano profile
wykonania i równoległość, kanoniczną materializację etapów oraz ustawienia
non-k0: wektor k, Floquet, tolerancje solvera i selektory modów/pasm.
Poprawiono walidację adaptacyjnej równoległości przy zadeklarowanym profilu:
korzysta z żądanej ścieżki CPU/FEM, nie z nieaktywnych pól legacy. GPU i jawne
auto nie są po cichu zmieniane na CPU. Pełna materializacja pozostaje po
stronie wspólnego bindera Rust.

Review rozwiązań nie wykazało otwartych uwag. Kontrole składni Python,
Rust, TypeScript i PowerShell oraz staged whitespace przeszły; nie są
dowodem poprawnego typowania ani wykonania. Dodano jawne bramki GitHub
Actions dla regresji sceny/profilu, selektorów eigensolve i Windows RAM-dysku.
Testy jednostkowe lokalnie nie były wykonywane; wyniki CI pozostają
NOT VERIFIED. Commit fixture’ów: `d2902fd6f62962ef32906ae7bbc4a2d5a2a6c2e2`.

Użytkownik zatwierdził koordynację z wątkiem „Scal audyty i plan
refaktoryzacji”. Wysłano wspólny kontrakt: jeden klucz
`FULLMAG_WINDOWS_VOLATILE_ROOT`, helper Windows i R: wyłącznie dla natywnych
buildów. Nie zmieniono storage ani mountów Dockera.

Ostatni odczyt runnera wykazał około 1 GB wolnego durable storage przy progu
8 GiB; nowy build FEM wymaga ponownego sprawdzenia miejsca. Nie usunięto
danych. Nowych punktów dyspersji w tym etapie nie obliczono. GMRES/FGMRES
runtime, wspólny signed sweep/parity, zbieżność, GUI, COMSOL A1, S09/provider,
GPU i pełna integracja pozostają OPEN; pełny cel S00–S12 trwa.

<!-- frontend-fixture-source-remediation-20261005 -->
## Bieżący checkpoint — fixture’y źródłowo naprawione, integracja i FEM otwarte

Poprzednia tura: postęp — jedna wspólna konfiguracja RAM-dysku Windows,
managed build exit0 i trzy hashe EXE sprawdzone. R: jest wyłącznie dla
natywnych buildów Windows; runner FEM/Docker nie używa R:.

Naprawiono osiem frontendowych plików testowych z logu CI master816:
pełny fixture LiveStatus, nullable wynik rzeczywistego hooka, obserwację
asynchroniczną bez never, zawężenie JSON study oraz kompletne identyfikatory
session/epoch/run w stage execution. Asercje zakresu sesji i odświeżenia
zachowane. Parser składni 8/8 PASS, niezależne review bez otwartych uwag.
Nie kompilowano i nie wykonywano unit tests lokalnie. Typowanie i wykonanie
pozostają NOT VERIFIED do GitHub Actions (wyjątek zaakceptowany przez operatora).

PR97 aktualnie CONFLICTING. Pobrano remote master; read-only merge-tree
wskazuje 10 konfliktów (Inspector, Python scene/IR/script, step_utils,
launcher oraz source-check wrapper). Właściwe scalenie nie jest jeszcze
rozpoczęte. Potrzebne zachowanie obu kontraktów parallel_execution i
execution_profile oraz autorytatywnego Windows P8-57, bez generowanych
artefaktów edytowanych ręcznie.

Runner ma worker_alive=true, brak aktywnych jobów i worker_error=null,
ale odczyt 05.10.2026 18:25 UTC wykazuje 1 070 415 872 B wolnych (<8 GiB).
Nowy build FEM jest zablokowany zasobem; nie zlecono duplikatu ani nie
usunięto danych. To nie blokuje poprawy źródeł i integracji.
GMRES/FGMRES runtime, shared signed sweep/parity, zbieżność, GUI, COMSOL A1,
S09/provider i GPU pozostają OPEN. Pełny cel S00–S12 nie jest zakończony.

<!-- native-source-check-reuse-checkpoint-20261005 -->
## Aktualny checkpoint — native build PASS i kontrola frontendu PASS

Merge master816 oraz poprawka ścieżek Cargo są na remote38cad3c51.
Ponowiony windows-workspace-build zakończył się completed/exit0:
backend39,47s, desktop1min02s. Source identity passed, local changes enforced,
3 hashe binariów zgodne z manifestem. Dowód dotyczy zbudowanego source digest,
nie późniejszych fixture’ów ani runtime FEM/GPU/GUI. Receipt tego wrappera
nie wiąże hashem manifestu; niezależny verifier zachował jego hash.

Lokalny commit `957e73680ae94a08492b9dbe9e46eda820d1893d` naprawia pięć
błędów cfg(test) ujawnionych przez CI. Parser4 plików i review PASS;
kompilacja/wykonanie testów NOT VERIFIED. Zachowany test manifestu używa
syntetycznej częstotliwości analytic*1,01 — nie jest FEM solve.
Użytkownik dopuścił unit tests wyłącznie w GitHub Actions; lokalny zakaz trwa.

Naprawiono reuse zależności native workspace w lekkiej trasie source-check:
tylko ten sam worktree, sprawdzony manifest i identyczne dependency inputs,
własne kopie bieżących źródeł, bez install/rebindingu istniejących katalogów.
11 regresji helpera +4 shella +4 publikacji PASS, review bez otwartych uwag.
Ochrona edycji plików generated jest optymistyczna; współpracujących writerów
serializuje lock worktree. Real generate-client (także po poprawce publikacji),
production TypeScript i API hygiene: terminalne PASS, source unchanged.
Generated artifacts semantycznie zgodne z indeksem Git; brak ręcznych zmian.

CI ujawniło również fixture types w8 frontend tests, browser boundary timeout
i kontrakt noty0832. Te bramki oraz całość S00–S12 pozostają OPEN.
Szczegóły: [bramki integracji](2026-10-05-eigensolve-master816-integration-gates.md).
Operator zadeklarował samodzielny restart Docker Desktop. Bez nowych punktów
solvera; po odzyskaniu runnera wymagane health/reconciliation i exact FEM gates.

<!-- master816-native-link-checkpoint-20261005 -->
## Aktualny checkpoint — merge mastera i diagnoza linkowania Windows

Scalono mastera `81600790c3aad6d3b8f50cdbd33c9155ee7a0a43` do brancha
zadania (HEAD przed merge `f50525638bc00dae17b605a031934eac4bcf0f5d`).
Trzy konflikty rozwiązane; nie ma unmerged paths. Zachowano oba moduły IR,
typed live snapshot i konserwatywną ochronę GC. 96 testów Python oraz
24 podtesty PASS; parser Rust PASS. Merge commit: `a54ed087a9fa941477e8c7a15f700e3ace032df0`.
Hook React Doctor 72/100, 38 ostrzeżeń w zmianach mastera; kontrola
produkcyjnego frontendu i eksportu API nadal NOT VERIFIED.

Zarządzany native Windows build zakończył się exit 1 przy linkowaniu
backendu, LNK1104. Wskazany plik rlib istnieje, ścieżka ma 262 znaki.
Resolver skraca katalog pośredni Cargo do `build_root/b` dla natywnych
profili Windows, pozostawiając finalny target i istniejący cache.
Override jest walidowany względem profilu, bez wyjścia poza storage.
36 interpretowanych kontroli resolvera: OK, 2 pominięte. Review PASS;
domyślne b i recheck initialize odrzucają junction poza profilem. Potwierdzenie
poprawki: ponowiony zarządzany build zakończył kompilację i linkowanie
fullmag-cli/fullmag-api sukcesem po 6 min 14 s. LNK1104 nie powrócił.
Desktop również skompilował się w 3 min 16 s. Recepta zakończyła się
exit 1: poprawka walidacji storage podczas próby zmieniła identity.
Wymagane ponowienie na stabilnym źródle. Nie jest to dowód FEM.
Zależności frontendu istnieją w native workspace, lecz source-check
wskazuje dawny frontend root; nie rebindowano ani nie kopiowano ich.

Live health API runnera: worker failed, OSError Errno 5 Input/output error,
accepting_jobs=false, active_jobs=[]; ponad 50 GB wolnego. Dwie wcześniejsze
sesje diagnostyczne Docker nadal oczekują bez wyniku.
Nie uruchomiono ich duplikatów ani nowych punktów dyspersji. Export API,
frontend, exact-runtime GMRES/FGMRES, signed sweep, zbieżność, GUI i COMSOL A1
pozostają otwarte. Poniższe checkpointy opisują wcześniejsze stany.

<!-- storage-production-and-master-d429-checkpoint-20261005 -->
## Aktualny checkpoint — cleanup PASS, kompakcja częściowa, nowy master

Execution #187/#188: terminalne succeeded, 879 901 764 bajtów logicznych
usuniętych. Po operacji 28 artefaktów, manifesty/receipty i oba pełne logi
przeszły kontrolę integralności; live UI potwierdza reload i disabled reapply.
To postęp storage, bez nowych wyników solvera ani zamknięcia S00–S12.

Kompakcja dwóch historycznych kapsuł zakończyła się partial po 545 konwersjach
pierwszej kapsuły i timeoutcie Docker dla drugiej. Verify_source 14 991 plików
oraz oba manifesty/digesty PASS. Przyczyna I/O pozostaje do diagnozy;
SourceStore zachowuje teraz errno w komunikacie (10/10 regresji PASS).
Wdrożono validating i czytnik metadanych; legacy runtime inventory NOT VERIFIED.

Pobrano master d4292406e7ae3f8f3e8a82b0ece88df8e13dcd6c. PR97 jest
OPEN/CONFLICTING. Preview merge-tree wskazał OpenAPI JSON, fullmag-ir/lib.rs
oraz fullmag-session/reachability.rs; właściwego merge nie rozpoczęto.
Następna integracja ma zachować parallel_execution i execution_profile,
typed live snapshot i konserwatywną klasyfikację GC; generated API wymaga
późniejszego managed eksportu. Diagnostyka storage, nauka, GUI/A1 i pozostałe
bramki pozostają otwarte. Starsze checkpointy poniżej są historyczne.

<!-- storage-retention-runtime232-checkpoint-20261005 -->
## Aktualny checkpoint — runtime #232 i naprawa retencji storage

Build #232 `2486b24dc7924dadaff342d4603ed197` jest terminalny `succeeded`,
exit 0; receipt wiąże pakiet z HEAD `3da4b53d16bf3bbf57c6dde3c0f7541e17e9442c`.
To dowód buildu, nie wykonania nowych bramek GMRES/FGMRES, GUI ani nauki.

Retencja nie jest już wyłącznie preview. Executor execution, CAS nowych
kapsuł, historyczna kompakcja i planer/wykonawca runtime są zaimplementowane;
koordynator obsługuje trwałe plany oraz osobne zakresy. Aktualne dowody i
pozostałe bramki zawiera [plan storage](2026-10-05-runner-storage-retention.md).
Nie oznacza to zamknięcia R1–R5 ani S00–S12.

Dwie próby produkcyjne #187/#188 zakończyły się `partial`, retained oba
execution, 0 bajtów usuniętych. Manifesty i receipty zachowane z identycznymi
SHA256. Pierwszą blokadę (historyczny CMake a bieżący profil) naprawia osobna
kontrola integralności archiwalnej; ścisłe dopuszczanie runtime pozostaje.
Drugą blokadą były krotki mountów porównywane z listami zapisanymi w JSON
oraz Windowsowa interpretacja absolutnych ścieżek demona Docker.
Poprawka zachowuje pełne image/mount/isolation checks: 26/19/10 kontroli
Python PASS i rzeczywista odczytowa atestacja obu zakończonych workerów PASS.
Wdrożenie tej drugiej korekty i świeży apply są następnym krokiem.

Historyczna kompletność odwołań runtime pozostaje NOT VERIFIED: brak
runtime-reference-roots.json oraz niestandardowe JSON kontrolerów scientific-batches.
Nie można zaznaczyć legacy_inventory_complete bez jawnych kontraktów i audytu.
Po storage wracamy do exact-runtime bramek solvera, shared signed15/parity,
zbieżności, GUI/A1 oraz pozostałych wymagań S00–S12 i integracji PR97.

<!-- master-eae-scene-pbc-checkpoint-20261005 -->
## Aktualny checkpoint — scalony master i zachowanie modelu w eksporcie

Scalono master `eae25cc2b393f78e7ff0e9da727344f08c62ee41` przez commit
`79a9dcb8b9d70651f8ae81442d1bc2ad0095e96f`; merge jest na branchu remote.
Rozwiązano cztery konflikty, zachowując równoległość i nowy output storage.
PR #97 jest OPEN/MERGEABLE; wymagane kontrole i kwalifikacja nie są zamknięte.

Regresja integracyjna wykryła utratę jawnego PBC w dokumencie sceny.
Naprawiono Python builder/scene/script/direct IR oraz typed Rust authoring
przez istniejący FdmPeriodicityIR, bez zgadywania osi z k/FloquetBC.
Null usuwa politykę i pozostaje jawny po Rust serde; brak override zachowuje
źródłowe ustawienie. Osie, demag i images przechodzą walidację.
Pusty authoring zachowuje PBC, lecz pusty ProblemIR nadal jest odrzucany.

Druga regresja ujawniła techniczne `scene_document.py` jako źródło nazwy
wyników. Direct Scene→IR usuwa ten basename; istniejący Python-core używa
bezpiecznej nazwy modelu. Jawne katalogi i pozostała polityka output storage
pozostają zachowane. Różnice nazw rzeczywistych plików referencyjnych są
sprawdzane osobno przed porównaniem fizycznego IR.

Dowody źródłowe: Scene→IR 59/59, PBC 6/6, parallel/storage export 6/6 PASS;
łącznie 71 interpretowanych testów. Walidator noty i mapy źródeł PASS.
Parser Rust: 31 plików PASS, bez kompilacji testów i bez dowodu typecheck.
Produkcyjny TypeScript: 1002 wejścia, 0 jednostkowych, 0 błędów; API hygiene PASS.
Hook merge React Doctor: 79/100, dwa ostrzeżenia await-in-loop w niezmienionym
sekwencyjnym czytaniu fragmentów topologii; nie są nowymi zmianami tego merge.
Native serde/regresje, pełny eksport OpenAPI i GUI wymagają nowego managed runtime.

Następny krok: jeden build exact-commit w profilu fem-cpu-slepc-runtime-v2,
bez targetów jednostkowych; następnie twardy błąd GMRES i kontrola FGMRES,
PBC/API replay oraz kolejne bramki Γ/signed15/parity/zasobów/zbieżności/GUI/A1.
S00–S12 nadal OPEN, w tym S09/provider, interakcje/GPU i pełna integracja PR.
Analiza runs nie wdrożyła retencji: działająca usługa nadal ma tylko preview.

<!-- air231-six-results-ksp-checkpoint-20261004 -->
## Aktualny checkpoint — sześć prób siatki powietrza i diagnostyka KSP

Na pakiecie #231, source `4b34ec7b91dadb18ac87d7f8b98b3a2cf5c8f574`,
zakończono sześć rzeczywistych prób +10/+25 rad/µm × growth 1,3/1,15/1,075.
Wszystkie wiersze przechodzą kontrolę artefaktów i residualu modu;
zakres pełnego residualu wynosi 1,54264e-11–2,47329e-11 przy progu 1e-8.
Okna pozostają `not_certified`, z jednym zwróconym modem i możliwością
istnienia dalszych modów. Nie jest to pełne widmo ani geometria COMSOL A1.

Rzeczywista siatka filmu jest zachowana; zmienia się harmonogram powietrza.
Porównanie stanu spełnia istniejącą bezwzględną rozdzielczość replay pól
1e-8 A/m. Pierwotny nieudany audyt używał innego ad hoc progu; zachowano
zarówno jego dowód, jak nowy raport, bez zmiany tolerancji solvera.
Odchylenie względem świeżej referencji open-air 1D/basis32 spada przy +10
z -0,204668% do -0,074200%, a przy +25 z -0,616906% do -0,371054%.
To trend zbieżności powietrza, bez domknięcia filmu, paddingu i liczby modów.

Opublikowano CSV, dwa wykresy PNG/PDF, receptę renderu oraz manifest i oba
pliki dowodowe w `docs/raports/2026-10-04-de-air-matrix-runtime231.md`
i `docs/raports/assets/de-air-matrix-20261004/`. Historyczne signed15
#227/#228 pozostaje osobno oznaczone; nie dopisano ujemnych refinementów.

Commit `4451860087a7fdd27e087b27cae0f6cadc47bc44` zachowuje postęp monitora
KSP przed unwindem twardego błędu. Rekurencyjny residual i obserwowany reason
nie zastępują true residualu ani końcowych query. Consumer: 9/9 PASS,
kontrakty noty: 10/10 PASS, mapa źródeł PASS. Natywne regresje przygotowano,
bez kompilacji; wykonanie nowego monitora wymaga kolejnego managed pakietu.
Commit `0e5b7755bb665d120502511911c845aabd2ae817` naprawia rozpoznawanie
Rust async w walidatorze dokumentacji: 20+15 interpretowanych kontroli PASS.

Po odświeżeniu origin/master pozostaje na
`eae25cc2b393f78e7ff0e9da727344f08c62ee41`. Cztery rozwiązania konfliktów
przygotowano i sprawdzono w preview; właściwy merge i nowy build są następne.
S00–S12 nadal OPEN: aktualny Γ/full window, shared signed15 i serial/adaptive
parity/zasoby, zbieżność, GUI/browser, A1, S09/provider, interakcje/GPU oraz
wymagane review/CI/integracja/main FF/cleanup. Starsze checkpointy poniżej
opisują wcześniejsze obserwacje, a nie stan bieżący.

<!-- runner231-nearest-runtime-checkpoint-20261004 -->
## Aktualny checkpoint — pakiet #231, eksport OpenAPI i rzeczywisty punkt +10

Stan z 2026-10-04 po zakończeniu dwóch prób nearest: build #231
(`3e3b5a6123934d8b8f63cfbf02ccad55`) zakończył się `succeeded`, exit 0.
Receipt, CMake/runtime/dependency attestations potwierdzają FEM CPU/double,
SLEPc, MFEM 4.10 i źródło `4b34ec7b91dadb18ac87d7f8b98b3a2cf5c8f574`.
Nie kompilowano testów jednostkowych; sukces buildu nie zamyka kwalifikacji naukowej.
Pakiet i ta sama kapsuła są używane ponownie, bez nowego przechwycenia źródeł.

Merge mastera `6c0c76551b6095b064e996cbb4c80a4ba7952aa9` zapisano jako
`f01644bd6cc16d99101deee52b7a951ed5292278`. Produkcyjny TypeScript:
1000 wejść, 0 wejść jednostkowych, 0 błędów. Parser 14 scalonych plików,
API hygiene i interpretowane kontrole handoff przeszły; nie jest to browser proof.
Hook React Doctor: 73/100, 6 ostrzeżeń; ograniczone review nie potwierdziło
błędu zachowania w tych ostrzeżeniach. Pełny audyt UI pozostaje osobną bramką.

Dwie poprawki eksportera (`fb5f9510efcc3352e06387c8a981e12669a05676`,
`a5dbff4b6930bf6dcdded5dfa4828430c114a342`) usuwają arbitralny wymóg
15 artefaktów przy zachowaniu walidacji kompletnego receipt właściwego profilu
oraz zachowują zadeklarowany CPU MFEM `LD_LIBRARY_PATH`. 30 interpretowanych
regresji PASS. Rzeczywisty eksport z #231 zakończył się `succeeded`/0,
zweryfikował hashe wejść, stamp oraz cleanup. To dowód eksportu, nie GUI.

DE: k=(0,+10^7,0) rad/m, L2, 3 warstwy, air growth 1,3, nearest 11,2 GHz,
EPS/KSP 1e-9, restart 8, fizyczna tolerancja 1e-8. GMRES zakończył się błędem
różnicy między residualem rekurencyjnym i obliczonym wprost. Po review
uruchomiony FGMRES zwrócił **11,205285324453773 GHz**. Certyfikat wybranego
modu w `spectrum.v2.json` daje residual pełnej postaci słabej i szwów
**1,8215819390878056e-13**, poniżej 1e-8. True KSP: 32/32 pomiary,
0 naruszeń, 0 brakujących; maksymalny stosunek do tolerancji 0,9806801026.

Obie próby mają identyczne bajty modelu, źródło, runtime i żądane sterowania
poza typem KSP. Native shared operator digest jest identyczny. Failed GMRES
nie publikuje oddzielnych hashy mesh/equilibrium/phase; nie raportujemy ich
zgodności jako sprawdzonej. `solver.v1` nie agreguje certyfikatu bloków modu:
jego summary ma null/false, podczas gdy zaakceptowany mod ma certyfikat true.
Nie należy używać summary do zastąpienia certyfikatu konkretnego modu.

Wynik jest `completed_unqualified`, `selected_only`, `window_complete=false`.
Nie potwierdza pełnego okna, identyfikacji n0, zbieżności ani przypadku COMSOL A1.
Sześć przygotowanych prób air growth 1,3/1,15/1,075 dla +10/+25 będzie używać
tego samego pakietu. Stan wykonania zapisuje `air-matrix231-controller-state.json`;
prepared lub dry-run nie jest wynikiem numerycznym.

Review S05: PC jest stałym LU, actual FGMRES użył magnetic-only dla 656 DOF;
brak podstaw do uznania PC za zmienny lub zmiany defaultu po jednej parze.
Null/false w solver-level summary jest zamierzonym brakiem metryk, a UI czyta
certyfikat konkretnego modu — ten punkt review zamknięto bez poprawki kodu.
Do naprawy/diagnozy pozostają snapshot telemetry przed unwindem hard-error,
głębsza przyczyna luki residualu i `floquet_geometric_bc_certified=false`.
Nie obniżono tolerancji ani nie zastosowano cichego fallbacku.

Audyt storage: około 87% datowanego rozmiaru logicznego to execution/source.
Policy ma tylko preview; wykonawca GC i deduplikacja CAS nie są wdrożone.
Planer dodatkowo odrzuca całe drzewo zawierające link. Potrzebny jest bezpieczny
kontrakt linków/mountów, a nie wyłączenie ochrony. Analiza nie usuwała danych.

S00–S12 nadal OPEN: Γ full window, aktualny shared signed15 i serial/adaptive
parity/zasoby, convergence, GUI/browser, COMSOL A1, S09/provider, interakcje/GPU
oraz wymagane review/CI/integracja. PR97 OPEN; remote master ponownie przesunął
się do `eae25cc2b393f78e7ff0e9da727344f08c62ee41`; odczyt PR zgłosił konflikty.
Ten nowy master nie jest jeszcze scalony. Szczegóły i dowody:
`docs/raports/2026-10-04-dispersion-master-merge-checkpoint.md`.
Poniższe checkpointy opisują wcześniejsze obserwacje i nie zastępują tego stanu.

<!-- runner231-storage-audit-checkpoint-20261004 -->
## Aktualny checkpoint — koordynator wdrożony, build #231 i audyt storage

Stan z 2026-10-04: parser startup stamp jest wdrożony w trusted koordynatorze
`sha256:69760bc41867c5f0c55b107c077a9ac762f29a16706cda2ff2c151da44706851`.
Odczyt hashy potwierdził zgodność helpera z worktree i zachowanie profili,
sekretu oraz konfiguracji buildów. Jest to dowód wdrożenia koordynatora;
nowa attestacja pakietu i solve nie otrzymują przez to PASS.

#230 (`37cb64f57d94459ba82de02f187ef5be`) został zablokowany przed utworzeniem
job root/kontenera po spadku wolnego miejsca poniżej admission 8 GiB.
Po zewnętrznym zwolnieniu miejsca zwykłe API kolejki przyjęło #231
(`3e3b5a6123934d8b8f63cfbf02ccad55`) dla źródła
`4b34ec7b91dadb18ac87d7f8b98b3a2cf5c8f574`, digestu
`860b3872cce76d190bd18076edf039d66299933a8aa4cdf31e2d44aa1e3153c7`
i profilu `fem-cpu-slepc-runtime-v2`. Ponownie użyto kapsuły
`9756cdb852ce42ff9d2dc6d7ee7f8f21`; nie utworzono nowej kopii źródeł.
Failed #229 i blocked #230 zachowują historyczne stany i dowody.

#231 jest running, exit code null. Docker potwierdził żywy kontener
`1044d9bc59a9543e16abfd459f047dbbd8096f02ac3981324df6201238f13ca7`
i rozpoczęty native-build. Obserwator PID270544 oczekuje na sukces,
eksport/weryfikację OpenAPI i dry-run; potem wykona przygotowaną parę nearest
GMRES/FGMRES dla k=+10 rad/µm. Po porażce próby wstrzyma kolejną do kontroli
artefaktów i cleanup kontenera. Obserwacja dotyczy tego samego joba;
timeout nie oznacza anulowania ani zgody na ponowne zgłoszenie.

Przygotowano osobną macierz sześciu prób zbieżności: k=+10/+25 rad/µm
oraz air growth 1,3/1,15/1,075, wszystkie na pakiecie #231. Baseline 1,3/1,15
trzeba policzyć ponownie, aby nie przypisać zmian nowego runtime wyłącznie
siatce powietrza. Model hash i dziewięć pinów drivera sprawdzono; wewnątrz
każdej grupy k zmienia się tylko żądany air growth i katalog wyniku.
Managed dry-run, actual mesh/equilibrium isolation i wykonanie są NOT VERIFIED.
Nie uruchomiono tych prób równolegle z buildem ani obserwatorem nearest.

Audyt konieczności danych potwierdza brak wykonawcy retencji: policy ma tylko
preview, apply zwraca cleanup_executor_not_enabled i reclaimed_bytes=0.
Skan rzeczywistych korzeni 19:17–19:18 UTC obserwował około 154,13 GB logicznie:
87,29 GB execution, 46,36 GB source, 10,83 GB artifacts, 7,53 GB benchmarków
i 1,88 GB results. Zmiany zewnętrzne i 32 błędy brakujących podkatalogów starego
execution wykluczają traktowanie skanu jako jednoczesnego pomiaru fizycznego.
154 manifesty źródeł deklarują 45,62 GB danych; unikalne hashe treści 0,86 GB.
To potencjał deduplikacji, nie dowód fizycznego odzysku ani zgoda na usuwanie.
Raport i JSON-y: audyt-koniecznosci-danych-i-lista-sprzatania.md w katalogu
preview-state-checkpoint/storage-cleanup-list-20261004 artefaktów tego wątku.
W tym audycie nie usunięto danych i nie wdrożono automatycznego GC/CAS.

S00–S12 pozostają OPEN. Piętnaście historycznych punktów DE i dwa refinements
zachowują swoje tożsamości; nowych częstotliwości w tym checkpointcie brak.
Najbliższy krok: terminalny #231 i kontrola nearest, następnie aktualny Γ full
window, wspólny signed15/parytet/zasoby i zbieżność. GUI, A1-COMSOL,
S09/provider, interakcje/GPU, wymagane kontrole PR97 i integracja pozostają otwarte.
PR97 jest OPEN; bieżący odczyt mergeable/mergeStateStatus był UNKNOWN.
Poniższe checkpointy opisują odczyty historyczne.

<!-- master125-integration-checkpoint-20261004 -->
## Kolejny merge aktualnego mastera — 2026-10-04

Po poprzednich 40 rozwiązanych konfliktach remote master przesunął się
do `01e1b113f5a1f17aef0e506e3c9dbf965401e300` (PR125/126).
Rozwiązano i przejrzano pięć kolejnych konfliktów frontendu i dokumentacji API.
Produkcyjny TypeScript 997 plików/0 unit inputs/0 błędów, API hygiene,
porównanie generowanych typów oraz mapa dokumentacji i 35 kontroli
jej narzędzi przeszły. Szczegóły i końcowy wynik merge w raporcie
`docs/raports/2026-10-04-dispersion-master-merge-checkpoint.md`.

Parser startup stamp zapisano i wysłano jako
`569947856713b622d52aacd0044556d68a82e28b`. Nie zaktualizowano jeszcze
zaufanego koordynatora ani nie wykonano nowej attestacji. #229 pozostaje
failed; nowych solve'ów w tym przyroście nie wykonano. Konflikty integracji
nie zastępują bramek S00–S12, runtime, nauki ani GUI.

<!-- integration-checkpoint-20261004 -->
## Integracja zmian do mastera — checkpoint 2026-10-04

Użytkownik zlecił zapis i push zmian worktree, pobranie origin/master,
rozwiązanie konfliktów i integrację PR97. Wszystkie 40 konfliktów rozwiązano
i zreviewowano. Merge `9085b6a0242b3cde9737bfd87c854e278c537616`
oraz `cfc3fc3d28f461543048b4bfac8c6a5e36b03878` obejmują master do
`1010f5d94cb13a9aae2e5644992c0fc26c93f33e`. Commit
`bdb927fd2400cb2372d1fbeeff57e8c62f99016a` poprawia wyłącznie dwa dokładne
wyjątki design-token CSS w capture źródeł. Wszystkie trzy commity wypchnięto.
PR97 był MERGEABLE/CLEAN/OPEN przy sprawdzeniu tego checkpointu; brak konfliktów
nie zastępuje kwalifikacji. Pominięte CI nie jest PASS.

Source-only kontrole merge: 503 interpretowane testy i 42 podprzypadki PASS;
production TypeScript 985 plików, bez wejść jednostkowych i bez błędów; scoped
Rust/TS parser, API hygiene i source-map PASS. Capture CSS: 15 testów PASS.
Testów kompilowanych nie uruchomiono. Pełne szczegóły decyzji, warningów hooka
i ograniczeń: `docs/raports/2026-10-04-dispersion-master-merge-checkpoint.md`.

Managed build #229 (`b0fbe5759e5940ceb41c0bc283cef8ff`) zakończył się
terminalnym failed/exit2. Native-build przeszedł exit0 w 2503003,827 ms
(około41m43s); availability probe przeszedł exit0 i FEM CPU=true.
Attestacja zatrzymała pakiet: consumer rozpoznawał wyłącznie `[fullmag] build:`,
natomiast nowy producent wypisuje `[fullmag] version:`. Rzeczywisty stamp zawiera
dokładny oczekiwany hash snapshotu; nie jest to błąd solvera ani brakujący hash.
Kontroler nearest zatrzymał się przed eksportem/solve; nowych częstotliwości zero.
Poprawka parsera jest zaimplementowana i zreviewowana: 60 interpretowanych
testów PASS oraz odczyt rzeczywistych stampów #228/#229 przez nowy helper PASS.
Pozostają aktualizacja trusted koordynatora przy pustej kolejce i nowy managed
job; sam parser nie jest ponowną attestacją runtime. Failed receipt #229,
logi, kapsuła i skompilowane dane pozostają zachowane. Profil
`fem-cpu-slepc-runtime-v2`, źródło
`bdb927fd2400cb2372d1fbeeff57e8c62f99016a`, digest
`c3fc343bbd56bac5555ad1f7c52c8235ea3efb404600002926f5dabfe2fc0156`.
Aktualny klient pochodzi z worktree; stary klient głównego checkoutu ma inną
listę profili. Nie zmieniano allowlisty w celu obejścia tej różnicy.
Receipt, export OpenAPI z nowego binarium i runtime pozostają NOT VERIFIED.

Guardy pustych/duplikowanych nazw materiałów i globalnych region_id oraz
nieprawidłowych owner_object są teraz zaimplementowane w źródłach V04.
Referencje materiałów pozostają dokładnymi MaterialIR.name; brak normalizacji
i nowych pól wire. Pięć funkcji regresji Rust przygotowano, bez kompilacji
i wykonania. Review poprawiło trzy tabulatorowe dane testowe. Parser i kontrola
tekstu nie dowodzą działania walidatora. #229 nie zawiera tego nowego przyrostu;
wymaga on osobnego typechecku. Providera waveguide nie aktywowano.

Aktualny dowód naukowy: 15 rzeczywistych punktów DE (14 nonzero z #228,
Gamma selected-only z #227) i dwa refinements air1,15. Wszystkie raw wyniki
i receipt-y zachowano. Zbieżność, Gamma full window, wspólny signed15,
serial/adaptive parity, GUI, A1-COMSOL, GPU i S09 nadal wymagają osobnych dowodów.
Dokładną parę nearest k=10 GMRES/FGMRES przygotowano dla #229: identyczny model,
siatka, target 11,2 GHz i tolerancje; różni się tylko KSP kind. Nie wykonano jej.
Dry-run air1,075 na historycznym #228 został odrzucony przez aktualną bramkę
receipt przed solve: dawny runtime-v2 deklaruje FEM_GPU=ON, a bieżący CPU-only
kontrakt wymaga OFF. Nie obchodzono sprawdzenia i nie zmieniono historycznych
receiptów. Dalsze triale wymagają nowego zgodnego pakietu. S00–S12 nadal OPEN.

Integracja remote PR97 pozostaje niezakończona. Główny checkout master miał
24 dirty ścieżki i dwa unikalne lokalne commity (688f1f23… oraz ddfd6bc1…);
zachowano je, bez resetu ani lokalnego merge. Cleanup blokują kwalifikacja,
integracja i aktywne zasoby. Nie usunięto cache/storage. Ostatni pomiar runnera
przed tym przyrostem wynosił około 40 GB wolnego; to pomiar chwilowy.
Historyczne checkpointy poniżej pozostają zapisem dawnych odczytów.

<!-- nearest-floquet-consumer-source-checkpoint-20261004 -->
## S05 — konsument nearest i jawny trial GMRES/FGMRES

Zaimplementowano osobną walidację pojedynczego niezerowego DE/BV nearest oraz dopuszczenie jawnego typu KSP w driverze. Wspólny helper nearest/window wymaga istniejącego kryterium rzeczywistego residualu względem RHS, konfiguracji queried, dodatnich kodów zakończenia i pełnych liczników bez violation/unavailable. Nearest wiąże konkretny indexed sample, znak/oś k, targetHz, actual restart i wymiary EPS; odrzuca global fallback, subwindows, window_exhausted, K0 i grupowe próby. Nie zmienia tolerancji, fizyki ani domyślnego solvera. Pozostałe bramki physical/seam/potential/mesh/equilibrium nadal obowiązują; accepted trial pozostaje selected_only/window_complete=false i NOT VERIFIED naukowo.

Kontrole interpretowane: **29 consumer +58 driver PASS**, **32 scientific-documentation +3 skill-contract PASS**. Review czterech Python plików nie ma otwartych P1/P2 po poprawce sprzecznego stop_reason; regresja mutuje wyłącznie to pole. Na rzeczywistych niezmienionych raw window artefaktach air1,15 dla +10/+25 wykonano rewalidację wspólnego helpera, oba PASS z zachowaniem hashy. Nie jest to nowe wykonanie ani dowód nearest. Dokładnie staged własną notę/mapę i fragment planu waliduje źródłowa bramka przed commitem; cudze WIP pozostają poza przyrostem.

Native producent pochodzi z wcześniejszego commita f0eb4a6446cd5f5d9ee744c36492105e6b73325a. Obecny runtime228/source57182911c6e8e721b8ee9705aa7f70491c70fe94 go nie zawiera, więc **managed nearest GMRES/FGMRES A/B NOT VERIFIED** i wymaga nowego buildu runtime-v2. Nie wolno dopisywać brakującej telemetry do starych wyników. Kompilowane unit testy NOT RUN zgodnie z zakazem użytkownika.

Zmiana drivera unieważnia hashe niewysłanych przygotowań air1,075. Zachować dotychczasowy controller/owner/history, oznaczyć niewysłany plan superseded i przygotować v2 z nowymi pinami oraz ponownymi dry-run. Model3aac3ddfdeb795476db04b5487f96ac1d41a5963 i runtime228 dla air trialu pozostają oddzielnie przypięte; wejścia/case outputs v2 muszą być nowe. Dispatch dopiero po bieżącym admission storage8GiB. Ostatni odczyt przy audycie storage wskazywał2,70GiB na C:, pusta kolejka; nie obniżamy progu i nie kasujemy cache bez zgody/koordynacji.

Całe **S00–S12 OPEN**: dalsza convergence airbox/body/thickness/modów, Γ full window, native shared signed15 i serial/adaptive parity/zasoby, GUI, A1/COMSOL, pozostałe S09/S10/GPU i PR97/integracja. Zachowano 15 rzeczywistych punktów DE i dwa air1,15 refinements oraz ich wykres; niniejsza zmiana nie tworzy nowych częstotliwości.

Nota: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` — `nearest-floquet-telemetry-consumer`. Dowody: nearest-consumer-review.md oraz nearest-consumer-real-window-revalidation.json w preview-state-checkpoint wątku. Historyczne checkpointy zachowano.


<!-- nearest-floquet-producer-source-checkpoint-20261004 -->
## S05 — wspólna publikacja telemetry Floquet nearest/window

Uzupełniamy pierwszy wymagany podpunkt `Nearest + FGMRES`: producent istniejących pomiarów true KSP residual, konfiguracji queried przed EPSSolve, kodów zakończenia i wymiarów EPS. Prywatny formatter w natywnym FEM CPU jest współdzielony z oknem częstotliwości; samodzielny nearest publikuje dane także przy porażce, wyłącznie dla actual Floquet adapter. Nie ma nowych zapytań PETSc, zmiany progów, selection, ABI ani domyślnego solvera. `selected_only/window_complete=false` zachowane. Generic/K0 pozostaje poza Floquet telemetry.

Stan: **producent zaimplementowany źródłowo; kontrola zachowania wyrażeń window i mapa naukowa PASS; kompilacja i native runtime NOT VERIFIED**. Przygotowana regresja production nearest oraz generic/K0 wymaga wykonania po odwołaniu zakazu kompilowania testów; interpretowane kontrole dokumentacji35 PASS. Source review CPP bezP1/P2; exact staged review całego przyrostu stanowi bramkę przed commitem. Nie przygotowano deterministycznej regresji EPSSolve failure; wykonanie failure/null pozostaje odrębną otwartą bramką. Osobny consumer nearest, dopuszczenie FGMRES, izolowane GMRES/FGMRES A/B i managed wykonanie pozostają OPEN. Guard nearest FGMRES w Pythonie nie został usunięty.

Przygotowane wejścia air growth1,075 +10/+25 pozostają przypięte do modelu3aac3ddfdeb795476db04b5487f96ac1d41a5963; pliki drivera nie zostały zmienione. Runtime228 nie zawiera nowego producenta. Obliczenia pozostają niewysłane: odczyt runnera/Windows wskazał około6,9GiB na C: przy admission8GiB. Nie obniżamy progu i nie usuwamy katalogów bez odrębnej zgody.

Całe S00–S12 pozostają **OPEN**: convergence mesh/airbox/modów, Γ full window, native shared signed15 i serial/adaptive parity/zasoby, GUI, A1/COMSOL, reszta S09/S10/GPU oraz PR97/integracja. Piętnaście zakończonych punktów DE i dwa refinements air1,15 zachowują swoje wcześniejsze tożsamości i wyniki. Ta zmiana nie tworzy nowych częstotliwości.

Nota: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md` — `nearest-floquet-telemetry-producer`. Poprzednie checkpointy zachowano.


<!-- de-air-refinement-levels-source-20261004 -->
## Aktualny checkpoint — dalsze poziomy air mesh i kontrola wersji wejścia

Dodano jawne diagnostyczne wartości growth1,075 i1,0375, zachowując baseline1,3/1,15 i domyślny brak override CLI. Niezmienione single-k standalone DE, model fizyczny, body L2/3 i wszystkie tolerancje. Kontrola AST przed dispatch wymaga, aby wersjonowany input obsługiwał dokładny requested string z prawidłową wartością; stare wejście38fc nie może użyć nowych poziomów. Źródłowe interpreted pilot tests: 53PASS; scientific-documentation35PASS oraz focused staged source-map PASS. Testy kompilowane NOT RUN.

Nowe poziomy **runtime/actual isolation NOT VERIFIED**; nie wykonano nowego ciężkiego buildu ani solve. Runner przy odczycie miał7765102592B wolnego, poniżej8GiB; nie obniżano admission ani nie usuwano danych. Następne obliczenia: +10/+25 przygrowth1,075 po spełnieniu admission, potem1,0375 gdy wcześniejszy wynik/zasoby to uzasadnią. Kolejne różnice częstotliwości i actual film/equilibrium/profile isolation muszą być odczytane z raw artefaktów. Nie ogłaszać zbieżności na podstawie samego zbliżenia do1D. Γ full window, padding/body/thickness/mode-count, native signed15/serial-adaptive parity/zasoby, GUI, A1/COMSOL, S09/provider/typecheck/GPU oraz PR97 pozostają **OPEN**.

Nota: docs/physics/0830-fem-poisson-airbox-modal-eigen.md — de-air-refinement-levels. Poprzednie checkpointy i15baseline/dwa refinementy zachowano.

<!-- de-air-two-points-isolation-20261004 -->
## Aktualny checkpoint — izolacja siatki powietrza potwierdzona przy +10 i +25

Odczyt 2026-10-04T12:26:25.407609+00:00. Obie próby L2/3, air growth1,15 na attested228 niezależnie zaakceptowane; rzeczywisty film/stan izolowany w jawnych tolerancjach. +25 **13,581679730GHz**, pełny residual2,473e−11,97,907s; częstotliwość wzrosła24,090184MHz. Różnica wobec open-air1D basis16 **0,616906%→0,440315%**. +10:11,216153905GHz, różnica **0,204668%→0,107871%**. Nowy wykres zachowuje15baseline growth1,3 i osobno oznacza tylko dwa refinements.

[Raport i wykres obu prób](../../raports/2026-10-04-de-air-grading-two-points.md). Air mesh wnosi część rozbieżności; dalsza zbieżność i pozostałe przyczyny pozostają otwarte. Progi solvera zachowano. Γ full window, wspólny native signed15/serial-adaptive parity/zasoby, GUI, A1/COMSOL, S09/provider/typecheck/GPU i integracjaPR97 **OPEN**. Kolejny ciężki krok wymaga spełnienia bieżącego admission storage; runner przy ostatnim odczycie widział7,24GiB, poniżej8GiB. To nie blokuje publikacji zakończonych wyników.

Historyczne checkpointy zachowano.

<!-- de-air-grading-isolated-terminal-20261004 -->
## Aktualny checkpoint — potwierdzony wkład siatki powietrza do rozbieżności DE

Odczyt 2026-10-04T12:10:50.063820+00:00. Kontrolka source38fc4420bbc02454c4b74896ce8bd014b70643f5 jest na remote/PR97, review bezP1/P2,52interpreted pilot i35scientific-doc tests PASS. Testy kompilowane nadal NOT RUN.

- Nowy +10 L2/3/growth1,15 na gotowym managed228: **11,216153905GHz**, full relative residual2,312e−11, exit0,81,399s. Postsolve bind/demag/seams/true KSP/potential PASS; model i runtime mają odrębne tożsamości. Nie wykonano nowego buildu ani zmiany progów.
- Actual izolacja PASS: film396węzłów/1476tet i4płaszczyzny z, te same kanoniczne coordinates/connectivity przytol1e−20m; raw coordinate maxdiff3,309e−24m, m₀maxdiff4,784e−20. Air plane count62→76, total nodes6138→7524; squared consistent-mass profile overlap0,999999942484. To nie deklaracja body identity na podstawie nazwy L2.
- Częstotliwość wzrosła o10,868580MHz; różnica wobec open-air1D basis16 spadła **0,204668%→0,107871%**. Dyskretyzacja powietrza wnosi część rozbieżności. Pełna mesh/airbox/mode-count convergence, Γ full window, shared signed15/serial-adaptive parity, GUI, A1/COMSOL, S09/provider i integracjaPR97 pozostają **OPEN**.
- Następny eksperyment: dalszy kontrolowany air refinement, potem sekwencja body/thickness i padding; nie uznawać growth1,15 za zbieżny tylko dlatego, że przybliżył wynik do oracle. Baseline15punktów pozostaje jednorodny growth1,3; nowy punkt ma oddzielne oznaczenie/raport.

[Raport izolacji air mesh](../../raports/2026-10-04-de-air-grading-isolation.md). Historyczne checkpointy poniżej zachowano.

<!-- signed15-scatter-verified-checkpoint-20261004 -->
## Aktualny checkpoint — policzone 15 pozycji DE od −25 do +25 rad/µm

Odczyt 2026-10-04T11:09:28.814828+00:00. **Cel wykresu kilku/kilkunastu rzeczywistych punktów osiągnięto: 14 zaakceptowanych nonzero-k oraz wcześniejszy Γ227.** Cały zakres S00–S12 pozostaje otwarty; to nie kwalifikacja naukowa ani jedno wspólne zadanie signed15.

- Zakres k_y: −25,−20,−15,−10,−7,−5,−2,0,2,5,7,10,15,20,25 rad/µm. Jednolity film DE 10 nm, M₀=x/k=y, B₀=0,1 T, PBC x/y, finite Dirichlet padding2µm, L2/trzy warstwy i demag. Wszystkie 14 nonzero z managed #228/source57182911c6e8e721b8ee9705aa7f70491c70fe94; Γ227 selected_only z osobną tożsamością. Nie użyto archiwalnych ±25, mirroringu ani interpolacji FEM.
- Artefakty i pełne physical/periodic-seam residuale PASS; max nonzero full relative residual1,956e−11 przy niezmienionym progu1e−8. Actual complex profiles: identyczna uporządkowana topologia, minimum adjacent consistent-mass overlap²0,999030114. Różnica niezależnych par ±k do około958,5Hz przy25. Te dane nie zamykają completeness/parity/convergence.
- Pierwszy +15 restart8 odrzucono przez FGMRES DIVERGED_ITS i true-residual violation. Fresh retry zmienił tylko restart8→30; +15=12,035727543GHz/fullres4,717e−12, queried restart30. Zachowano wcześniejszą nieudaną próbę. Pozostałe punkty restart8; automatyczny recovery i domyślne ustawienia produktu nadal wymagają odrębnej poprawki/kwalifikacji.
- Wykres PNG/PDF sprawdzono wizualnie i przez hashe/receipt. Ciągłe krzywe są referencjami n=0, scatter jest FEM; osobne punkty open-air 1D basis16 są referencją diagnostyczną. Różnica FEM wobec1D wynosi około0,205% przy10 i0,617% przy25; przyΓ różnica open-air wynika z innych BC. Nie uznano solvera za zweryfikowany na podstawie wyglądu wykresu.
- Oba refinementy +10 zaakceptowano: L2/6 = 11,207794879GHz/fullres1,974e−11; L3/3 = 11,208735289GHz/fullres3,103e−11. Actual mesh ma odpowiednio 6435/10496 węzłów, 2952/2538 tet filmu oraz 7/4 płaszczyzny z; objętość 1,6e−23m³ zachowana. Baseline L2/3 = 11,205285324GHz. To zależność od siatki, nie pełna zbieżność. L2→L3 zmienia także air seed/lateral; nie jest air-only. Następna izolacja air growth1,3→1,15 wymaga versioned input i actual body identity check. Siatka/airbox/mode-count convergence pozostają OPEN.
- Γ pełnego okna #228 nadal failed43/50, siedem własnych EPS reason−1/2000iter; selected-only Γ227 tego nie zastępuje. Wspólny signed15 manifest i serial/adaptive resource/parity/GUI, A1/COMSOL, reszta S09/S10/GPU oraz PR97/integracja pozostają OPEN.

Raport z tabelą/CSV i obrazami: [DE signed15 runtime](../../raports/2026-10-04-de-signed15-runtime.md). [Scan dyskretyzacji i actual mesh](../../raports/2026-10-04-de-nonzero-discrepancy-source-scan.md). Historyczne checkpointy poniżej zachowano wraz z ich momentem odczytu.

<!-- waveguide-contours-and-signed10-terminal-checkpoint-20261004 -->
## Aktualny checkpoint — dwa zaakceptowane punkty ±10 oraz diagnostyka Γ

Odczyt 2026-10-04T10:26:07.948740+00:00. Całe S00–S12 pozostają OPEN. Nowa inspekcja zaakceptowała dwa rzeczywiste punkty nonzero-k z demagiem i pełnym residualem. Nie jest to jeszcze pełny signed15 ani kwalifikacja naukowa.

- Commit źródeł `842d7da7a25fcae7704d01a2f6fc8dda1f96ffad` dodaje validate_waveguide_mesh_contours: typed prerequisite embedding, dokładny znak signed area, half-open odd-even point location i nesting parity wyłącznie w tym samym region_id. Per-region point/AABB sweep używa dotychczasowego indeksu przedziałów, bez unconditional all-pairs/limitu głębokości. Same-region disjoint outer i wyspa depth 2 pozostają legalne. Raport ma prywatne Serialize-only pola, bez certificate/admission; ciała helperów embeddingu są identyczne po usunięciu pub(crate) i normalizacji rustfmt.
- Source review zakończono bez otwartych P1/P2. Poprawiono concave fixture: punkt wcześniej leżący na krawędzi stał się rzeczywiście interior; nie była to awaria wykonana w Rust. Exact staged parser/format, source-map/notę i whitespace sprawdzono, PASS. 35 interpreted Python scientific-documentation contract tests PASS. Przygotowano 10 regresji Rust, bez kompilacji/uruchomienia; typecheck/public validator/runtime/provider NOT VERIFIED. Fraction input oracle: 88 przypadków na czterech skalach oraz wspólny i nested fixture; dodatkowo cztery rational input checks korekty concave, bez wykonania kodu Rust.
- Build #228 zakończony succeeded/exit 0, kapsuła 57182911c6e8e721b8ee9705aa7f70491c70fe94 / digest 1635883ea717cc5892970fabb872c70e6d94648da2b57234d6d3c857bbc9d326; nie zawiera nowego embeddingu/contours. Γ pełnego okna 8,5–16 GHz zakończyło się failed/exit 1 po 4671,96 s: 43/50 podokien ukończone, siedem nieudanych (base1,2 oraz refinement12,13,14,15,24). Każde nieudane podokno ma własny EPS reason code -1 i outer_iterations 2000. Faktyczne NEV/NCV/MPD to 4/8/8 dla base i 8/16/16 dla refinement; q656, real split1312, exact PC disabled_dimension_cap. Globalny ostatni eps_converged nie dowodzi sukcesu wszystkich podokien. Brak per-window KSP termination i liczbowej wartości cap w artefakcie; nie uzupełniano ich domysłem. Nowa telemetria wyjaśnia rodzaj niepowodzenia, ale nie naprawia jeszcze zbieżności Γ.
- Próby nearest 11,2 GHz/GMRES dla ±10 zakończyły się exit 1 przez rozbieżność residualu rekurencyjnego i ponownie obliczonego przy restarcie; bez częstotliwości do przyjęcia. Ponowiono oba punkty istniejącą, dozwoloną trasą frequency_window 8,5–16 GHz z FGMRES. Zmieniono jednocześnie KSP type i spectral selection: to nie jest izolowany eksperyment jednego parametru ani dowód, że sama zmiana KSP usuwa wszystkie przyczyny.
- FGMRES: +10 rad/µm = 11,205285324366156 GHz, full relative residual 1,568186666958425e-11, 69,128 s; −10 rad/µm = 11,205285254416574 GHz, residual 9,017075039220922e-12, 75,219 s. Obie próby exit 0/completed_unqualified. Inspektor PASS dla receipt/source/model, dynamic demag, pełnego projected weak form i periodic seams, L2/trzech warstw, physical potentials oraz każdego świadectwa prawdziwego residualu FGMRES. Zachowano EPS/KSP 1e-9, restart8 i próg pełnego residualu 1e-8. Użyto modelu 71ba0d18225ffcc83f7f18e676de8dc051e87fd1 / SHA 083f8f97b705b819cee2c4a03349e06f7b0b39715ddfec0d9898aa5e8ab23038; żadnego punktu nie odbito przez symetrię.
- Różnica względem finite Dirichlet uniform n=0 wynosi około -0,268160%; rzeczywisty profil ma uniform projection squared około 0,999971156. Niezależny open-air 1D thickness oracle (basis8/16, quadrature256) daje dla ±10 około 11,228265980 GHz i różnicę FEM około -0,204668%; basis8→16 zmienia wynik tylko o około 27,2 Hz. Założenia brzegowe tej referencji są inne niż finite-box FEM; jest to diagnostyka, nie dowód zbieżności airboxu/siatki ani pełne porównanie finite-box multimode. Mały residual algebraiczny nie usuwa pozostałej różnicy dyskretyzacji/modelu.

| Następny podpunkt naprawy/weryfikacji | Stan i konkretne kryterium |
| --- | --- |
| Γ: kontrolowana korekta NCV/MPD i preconditionera | OPEN; wykorzystać własne reasons/iterations/dimensions nieudanych podokien, udokumentować zmianę i uzyskać pełne 50/50; bez fałszywego uznania aggregate eps_converged za sukces. |
| Nearest + FGMRES | OPEN; najpierw addytywna publikacja native queried PC/norm i true-residual telemetry oraz odrębny consumer nearest z tymi samymi kryteriami. Nie wystarczy usunąć guard częstotliwościowego okna. |
| Zbieżność FEM przy ±10 | OPEN; zmieniać osobno siatkę, warstwy grubości i airbox, zachowując materiał/k/demag oraz identyfikację gałęzi; ocenić pozostałe około 0,2% względem 1D. |
| Signed15 i wykres | OPEN; obliczyć wszystkie rzeczywiste k=-25,-20,-15,-10,-7,-5,-2,0,2,5,7,10,15,20,25. Dwa nowe punkty ±10 są gotowe; Γ227 jest selected_only, stare ±25 mają odrębne provenance i wymagają jawnego oznaczenia archiwalnego. Brak pełnego wspólnego manifestu i parytetu serial/adaptive. |
| Pozostały zakres | OPEN; serial/adaptive resource measurements i GUI, A1 61 próbek/8 pasm, DE/BV/COMSOL, S09 registry/frame/fingerprint/fields/interactions/BC/invariance/equilibrium/atomic IR/planner/ABI/native MFEM2.5D/3D-TetraX, S10/GPU i PR97/integracja. |

Dowody w preview-state-checkpoint wizualizacji wątku: waveguide-contours-review.md, waveguide-contours-staged-validation.json, waveguide-contours-scientific-contract-tests.json, waveguide-contour-input-oracles.json, concave-correction-input-oracle.json, gamma228-terminal-diagnostics-inspection.json, signed10-job228-postsolve-inspection.json, signed10-fgmres-window-postsolve-inspection.json i signed10-thickness-reference-inspection.json. Aktualizacja wykresu i dodatkowe punkty są osobnymi krokami; nowego GUI nie potwierdzono.

<!-- waveguide-embedding-and-gamma228-checkpoint-20261004 -->
## Aktualny checkpoint — globalna geometria S09 i uruchomione okno Γ

Odczyt 2026-10-04T08:47:24.527785+00:00. Całe S00–S12 pozostają OPEN; nie uzyskano jeszcze terminalnych wyników testu #228 ani nowych zaakceptowanych nonzero-k.

- Źródłowy commit `d86ed7671951248ba6c74dbcabc083201eab3f42` (wysłany na branch i PR97) dodaje `validate_waveguide_mesh_embedding`: po typed prerequisites elements/incidence sprawdza cały scalar mesh, proper crossings, collinear overlap, T-junction/contact bez wspólnej tożsamości oraz strict triangle containment. Dokładne predykaty używają BigInt kodowania zapisanych binary64, bez tolerancji odległości. Broadphase sortuje min-u i utrzymuje aktywne przedziały v; inclusive AABB, checked counters, bez unconditional all-pairs/cap. Raport jest telemetryczny, nie certificate/admission.
- Niezależne source review: brak otwartych P1/P2. Korekta z review dopina usize literal przesunięcia w przygotowanej regresji; nie była to wykonana awaria buildu. Dokładnie staged parser/format, nota/source-map i whitespace PASS; dependency-only cargo metadata offline/locked bez kompilacji i zmian wersji PASS. Num-bigint pozostaje istniejącą wersją 0.4.6. Przygotowano 10 testów Rust bez kompilacji/uruchomienia. Fraction input oracle: 1031 binary64 wejść, cztery skale segmentów i fixture 156/89 kandydatów; nie wykonuje Rust. Typecheck/walidator runtime/provider NOT VERIFIED.
- Build #228 (`8df582e52a54410bae0387d2eaecd6a9`) uzyskał terminalny `succeeded`, exit 0. Kontener workera zakończył się 2026-10-04T08:33:33Z bez OOM. Managed preflight/dry-run przeszedł z modelem hash 083f8f97b705b819cee2c4a03349e06f7b0b39715ddfec0d9898aa5e8ab23038. Kapsuła commit 57182911c6e8e721b8ee9705aa7f70491c70fe94 / digest 1635883ea717cc5892970fabb872c70e6d94648da2b57234d6d3c857bbc9d326 obejmuje EPS termination/iterations/dimensions oraz wcześniejsze lokalne moduły S09, bez nowego embeddingu i bez buildu UI/unit tests.
- Kontroler 90880 rzeczywiście uruchomił `gamma-fgmres-window-eps-diagnostics-job228-v1`; faza window_pilot_running. Odczyt kontenera `fullmag-dispersion-2bfe8ca7d39f6bba50b6a9ef0f158c0d` potwierdził działający fullmag-bin/PID65172. Zakres Γ: okno 8,5–16 GHz, ten sam model 10 nm, L2/trzy warstwy, EPS/KSP 1e-9, FGMRES/restart 8. Nie zmieniono bramek residualu, kompletności ani cap preconditionera. Start procesu nie jest kwalifikacją widma.
- Nowy zaakceptowany punkt #227 pozostaje selected-only Γ 9,299249697 GHz; cztery dawne ±10/±25 zachowano. #228 nie ma jeszcze terminalnych artefaktów lub zaakceptowanych nowych punktów. Nie dodano wykresu/GUI/COMSOL i nie wygenerowano punktów przez symetrię.
- Następnie: końcowe raw artefakty #228 i rzeczywiste powody/iteracje/dimensions podokien → uzasadniona korekta zbieżności → pełny signed15 i wykres/analityka → serial/adaptive parity/pomiary i GUI. S09 nadal wymaga contour orientation/nesting, registry/frame/fingerprint, structural fields/interactions/BC, equilibrium/invariance, atomicznego IR/planner/ABI i native MFEM 2.5D oraz walidacji. A1 61 próbek/8 pasm, DE/BV/COMSOL/zbieżności, S10/GPU oraz PR97/integracja pozostają OPEN.

Dowody w preview-state-checkpoint wizualizacji wątku: waveguide-embedding-review.md, waveguide-embedding-staged-validation.json, waveguide-embedding-input-oracles.json, waveguide-embedding-cargo-metadata.json, gamma228-window-build-terminal.json, gamma228-window-dry-run.stdout.json i gamma228-window-controller-state.json.

<!-- gamma227-accepted-selected-checkpoint-20261004 -->
## Aktualny checkpoint — nowy punkt Γ po naprawie μ₀

Odczyt 2026-10-04T07:41:36.154074+00:00. Cel S00–S12 nadal aktywny; ten przyrost potwierdza jeden wybrany mod Γ, bez kwalifikacji kompletnego widma lub solvera dyspersji.

- Po zwolnieniu miejsca build #227 (`d2a6c2dd0c3c4a66a1e05fce10bb32c7`) zakończył się terminalnym `succeeded`, exit 0. Pakiet runtime-v2 przeszedł managed preflight źródeł, receipt i artefaktów. Źródło a8d67ac92002b884799119578a054b518cf40cbf / digest e848950d7d555f4d70d27a71421803fd2566d7e2f57d7e05b22f05da8123e8e6; brak kompilacji unit tests i brak buildu UI.
- Nowa próba `gamma-nearest-canonical-mu0-job227-v1` zakończyła solver i driver kodem 0, `completed_unqualified`, w około 43.00 s. Rzeczywista częstotliwość wynosi 9.299249697067491 GHz; pełny względny residual 3.28252982656441e-11, certyfikowany przy niezmienionym progu 1e-8. μ₀ operatora i modelu są identyczne: 1.2566370614359173e-06. Demag, zgodność CSV/spectrum, potential-field reconstruction, źródłowa siatka, stan równowagi, linearization i authoring L2/trzy warstwy przeszły istniejące kontrole.
- Analityka Γ dla tej samej płytki 10 nm, paddingu po 2 µm i zewnętrznego Dirichleta daje 9,299249697068401 GHz. Różnica wynosi około -0,000909 Hz (względnie -9,77e-14). Dodatkowy odczyt rzeczywistego pola zespolonego przez istniejący `compare_de_bv_mode_profiles.load_record` wiąże hash payloadu i cache z końcowym fingerprintem siatki. Projekcja na stały mod w consistent P1 tet mass wynosi 0,9999999999999998, względna niejednorodność 6,0243e-12; |mean(m_z)/mean(m_y)| = 0,3011279731324544 wobec referencji tego airboxu 0,3011279731307674 (różnica względna 5,60e-12). Składowa wzdłużna średniego modu względem jego normy wynosi 3,77e-22. To dowód jednorodnego profilu i zgodności amplitud Γ, bez nowego progu acceptance; nie certyfikuje znaku konwencji czasowej, kompletności widma, nonzero-k ani zbieżności. Dowód: `preview-state-checkpoint/gamma227-profile-inspection.json` w wizualizacjach wątku. Nie porównujemy tego punktu z granicą nieskończonego airboxu jako identycznym problemem.
- Istniejący driver i niezależny odczyt końcowych artefaktów przeszły. W pomocniczym inspektorze v1 błędnie przekazano integer 3 zamiast istniejącej string choice '3' do walidatora grubości; raport v2 poprawia wyłącznie wywołanie inspektora, zachowuje v1 oraz nie modyfikuje wyniku, drivera ani progów. Dowód właściwy: `preview-state-checkpoint/gamma227-selected-result-inspection-v2.json` w wizualizacjach wątku.
- Zakres tego wyniku: `selected_only`, `window_complete=false`, jeden punkt k=0. Nowych zaakceptowanych nonzero-k jest nadal zero; cztery dawne ±10/±25 zachowano. Nie wygenerowano nowego wykresu ani nie potwierdzono GUI/COMSOL.
- Kolejny build #228 (`8df582e52a54410bae0387d2eaecd6a9`) ma odczytany stan `running`, profil runtime-v2, commit 57182911c6e8e721b8ee9705aa7f70491c70fe94, digest 1635883ea717cc5892970fabb872c70e6d94648da2b57234d6d3c857bbc9d326. Obejmuje zapisaną diagnostykę EPS termination/iterations i rzeczywistych dimensions oraz lokalne źródła S09. Zgłoszenie/stan running nie kwalifikuje tych źródeł. Kontroler `watch-gamma228-window.py`, sesja 90880, przygotowuje jedną nową próbę Γ full-window 8,5–16 GHz z tym samym modelem i ustawieniami FGMRES/restart 8/EPS 1e-9/KSP 1e-9 po terminalnym sukcesie i preflight. Nie zmieniono limitu preconditionera ani bramek residualu/kompletności.
- Następny krok: odczytać rzeczywiste powody/iteracje/dimensions każdego nieudanego podokna, wykonać kontrolowaną korektę zbieżności i pełny sweep signed15; potem analityka, serial/adaptive parity i pomiary CPU/RAM oraz GUI. A1 61 próbek/8 pasm, DE/BV/COMSOL i zbieżności, całe S09/S10/GPU oraz PR97/integracja pozostają OPEN.

<!-- waveguide-local-validation-checkpoint-20261004 -->
## Aktualny checkpoint — lokalna geometria i incydencja mesha S09

Odczyt 2026-10-04T07:09:24.307812+00:00. Całe S00–S12 pozostają OPEN; nie dodano nowego punktu dyspersji, wykresu ani kwalifikacji GUI.

- Commit źródeł `f683b804b066ba919e52e3b955efcf565e19ef55` dodaje dwie podłączone kontrole raw mesha: CCW/finite/index/duplicate coordinates oraz reprezentowalność geometrycznych P1 area/mass/gradients/stiffness; pełne pokrycie incydencji krawędzi, referencje regionów, zamknięte proste kontury i połączone vertex fans. Raporty mają prywatne pola, Serialize-only/accessors; nie są validated mesh ani admission certificate.
- Kontrola geometrii używa bezwymiarowego q > 64*f64::EPSILON, area (s*a)*s bez samodzielnego s² i stiffness ze scaled gradients. Guard gradual underflow przeniesiono do jednego prywatnego modułu; arytmetyka i publiczny błąd frame są zachowane. Kontrola topologii liczy składowe całego scalar mesha oraz zewnętrzne air edges: fixture 1/12, closed air island 1/0. Rodzaj regionu nie tworzy BC/anchoring; point-contact jest odrzucany.
- Niezależny pełny source review ośmiu plików: brak nowych P1/P2. Dokładne staged źródła i nota/source-map, rustfmt/parser oraz whitespace PASS; osobny changed-scientific-docs dla commita exit0. Dokładny Fraction/Decimal oracle ośmiu wejść i graph oracle są kontrolą danych, nie wykonaniem Rust. Zapisano 13 funkcji regresji Rust (4 geometria z wieloma przypadkami, 9 topologia), bez uruchomienia/kompilacji zgodnie z zakazem. Typecheck, managed wykonanie nowych modułów i pełna kwalifikacja pozostają NOT VERIFIED.
- S09 nadal wymaga globalnego embeddingu: intersections/overlap/T-junction, geometric outer/hole orientation/nesting, world/frame mapping, immutable object/material bindings, invariance/equilibrium i boundary certificate. Następnie potrzebne są atomiczne Python/ProblemIRV04/StudyIR/planner/ABI routing, production MFEM owner, exchange k², field reconstruction, k→0/boundary i TetraX/extruded3D. Nie aktywowano nowego publicznego payloadu ani providera.
- Po zwolnieniu miejsca #227 przeszedł do `running`; runner running=True, worker_alive=True, accepting_jobs=True, worker_error=None. Wolne 21949722624 B (20.44 GiB). Rzeczywisty worker 4316903e118dead3ab7e1786ce17275f672bbcd6d952e4d4c29d742d20446f1f i żywy obserwator 81829 zostały potwierdzone. Nie uruchamiano duplikatu ani nie usuwano danych. Ostatni odczyt procesów wskazywał przygotowanie źródeł, bez kompilatora/niepustego logu; samo running nie jest sukcesem buildu.
- #227 zachowuje źródło a8d67ac92002b884799119578a054b518cf40cbf i digest e848950d7d555f4d70d27a71421803fd2566d7e2f57d7e05b22f05da8123e8e6. Obejmuje μ₀, bez późniejszej diagnostyki EPS i tego S09. Priorytet: terminalny sukces/receipt → managed preflight → Γ nearest → rzeczywiste artefakty i demag/residual/bindings → świeży pakiet diagnostyki/controlled full window → signed15 i analityka → serial/adaptive parity/pomiary i GUI. Pierwotne A1 61 próbek/8 pasm, DE/BV/COMSOL/zbieżności, S10/GPU oraz PR97/integracja nadal OPEN.

Dowody: waveguide-local-validation-review.md w wizualizacjach wątku; preview-state-checkpoint/waveguide-local-final-staged-validation.json, waveguide-shared-guard-source-proof.json, waveguide-element-rational-oracles.json, waveguide-incidence-graph-oracles.json oraz raporty elements/incidence-source.md. [Kontrakt lokalnych kontroli](../../specs/fem-waveguide-spatial-representation-v1.md#lokalna-walidacja-raw-mesha--przyrost-źródłowy-2026-10-04).

# Eigensolve dyspersji — checkpoint implementacji

<!-- raw-waveguide-mesh-checkpoint-20261004 -->
## Aktualny checkpoint — surowy typed mesh 2D na remote

Odczyt 2026-10-04T06:03:21.897124+00:00. Po zapisaniu diagnostyki EPS i porównania analitycznego Γ dodano kolejny wymagany składnik S09: surowy typ siatki przekroju. Cały cel S00–S12 pozostaje aktywny, bez nowych zaakceptowanych punktów solvera.

- Źródłowy commit `940626c21dc4f48063d25da2c3f1642c90544d66`: osobny WaveguideCrossSectionMeshIR, schema v1, local nodes [m], P1 triangles, edges i skierowane half-edge incidence, region/object/material references oraz ordered contours. Obiekty i tagged region enum mają required fields i deny_unknown_fields. Local edge index przyjmuje wyłącznie integer 0,1,2. String-only schema/loop_kind odrzucają alternatywne mapy unit wariantu; tę nieścisłość poprawiono przed commitem. Nie reinterpretujemy siatki 3D.
- Bounded source review sześciu plików bez P1/P2, parser/format nowego Rust i parser lib PASS, fixture JSON PASS, dokładnie staged nota/mapa naukowa i whitespace PASS. Przygotowano sześć regresji rzeczywistej serde; nie kompilowano ani nie uruchamiano ich zgodnie z zakazem. To nie jest dowód działania deserializera w nowym runtime.
- Niezależny exact Fraction audit przykładu: 16 węzłów, 18 dodatnio zorientowanych trójkątów, 33 krawędzie, 2 regiony, 3 domknięte kontury i jedna składowa scalar mesh. Incidencje, mapping konturów, exact area closure, vertex fans i brak przecięć/T-junction w tym przykładzie sprawdzone; cztery uszkodzone mutacje odrzucone. Jest to audit pojedynczego fixture, nie ogólny production geometry validator, invariance certificate lub kwalifikacja FEM.
- S09 nadal OPEN: scaled geometry/representability, pełna kontrola topology/non-overlap i registry mapping; wersjonowany fingerprint z frame; kompletne structural_2d fields/interactions/BC; atomiczny StudyIRV04/Wire.study i migracja/admission z missing/null BC; planner unavailable guards, owner MFEM 2.5D, exchange k², rekonstruowane pola/normy/residual oraz zbieżność/k→0/TetraX/extruded3D. Publiczny writer/reader 0.3 i jego guard przestrzennego intent pozostają bez zmian. Surowy typed wire nie jest certyfikowanym meshem i nie otwiera providera.
- Kolejka: worker_alive=True, accepting_jobs=True, worker_error=None; aktywne joby [], ostatni stan waiting_for_disk. Wolne 1990201344 B (~1.85 GiB), próg 8 GiB. Ten sam #227 d2a6c2dd0c3c4a66a1e05fce10bb32c7 ma stan `queued`; kontroler 81829/PID243032 potwierdzony live. Jego źródła a8d67ac92002b884799119578a054b518cf40cbf nie zawierają nowych typów ani diagnostyki EPS.
- Lokalny read-only planer retencji: 2121606033 B (~1.98 GiB) kandydatów execution naszego worktree. Nawet cały ten odzysk nie osiągnąłby progu startu przy ostatnim pomiarze; nie kasowano danych ani cache. API retencji miało timeout; odczyt SQLite był read-only, nie restartowano koordynatora/jobów ani nie zwiększano timeoutu.
- Następna ścieżka CPU3D nadal ma pierwszeństwo: terminalny sukces #227 i managed preflight → nowy nearest Γ i pełna walidacja μ₀/demag/residual/bindings → świeży pakiet diagnostyki i controlled frequency_window → rzeczywiste signed15 → wykres i analityka → serial/adaptive parity/pomiary puli i GUI. Oryginalny benchmark A1 Γ-X-M-Γ (61 próbek/8 pasm), COMSOL/DE/BV i zbieżności, S10/GPU oraz PR97/integracja pozostają wymagane i OPEN. Cztery dawne ±10/±25 pozostają dotychczasowymi zaakceptowanymi punktami; nie utworzono punktów przez symetrię.

Dowody: preview-state-checkpoint/waveguide-mesh-wire-final-staged-validation.json, waveguide-mesh-wire-review.md, waveguide-mesh-wire-source.md, waveguide-mesh-fixture-rational-audit.json i owned-retention-inventory-20261004.json w wizualizacjach wątku. [Kontrakt surowego mesha](../../specs/fem-waveguide-spatial-representation-v1.md#typowany-surowy-descriptor-przekroju--wire-v1).


<!-- eps-dimensions-analytic-checkpoint-20261004 -->
## Aktualny checkpoint — wymiary EPS i analityka Γ

Odczyt 2026-10-04T05:29:59.287034+00:00. Całe S00–S12 pozostają OPEN; ten etap nie dodaje zaakceptowanych punktów ani nowego wykresu.

- Commit źródeł `d95053982f3b0447d81df240663d1c9bec721b79` zapisuje rzeczywisty EPSGetDimensions (NEV/NCV/MPD) w istniejących fazach diagnostyki. Signed zera i sentinele są zachowane, nieudany odczyt daje false/null. Odbiornik zachowuje opcjonalne dane osobno w raporcie globalnym, próbce i każdym podoknie; brak historycznego pola nie tworzy pomiaru. Wymiary mogą różnić się między oknami. Operator, konfiguracja EPS/KSP, residual i kryteria akceptacji nie zostały zmienione.
- Natywne oraz Python source review: brak nowych P1/P2. Dokładnie staged nota/mapa naukowa, Python AST i whitespace PASS. 19 interpretowanych testów Pythona PASS; nowe przypadki wykrywają brak zachowania danych w starym odbiorniku (oczekiwany RED). Test C++ actual formattera przygotowano bez kompilacji zgodnie z zakazem. Native getter, świeży pakiet i managed runtime tego przyrostu NOT VERIFIED.
- Niezależna kontrola wcześniejszego Γ #226: raw 9,299249697068216 GHz wobec analityki jednorodnej warstwy 9,299249697068401 GHz, różnica około −0,000185 Hz. Referencja używa tego samego t=10 nm, p=2 µm po każdej stronie, B=0,1 T, Ms=800 kA/m i demag Nz=2p/(2p+t). Model otwartej nieskończonej warstwy daje 9,309813711433354 GHz i nie jest tym samym warunkiem brzegowym. Zgodność częstotliwości nie dowodzi tożsamości modu, nonzero-k ani zbieżności. Kandydat pozostaje odrzucony przez pierwotną bramkę μ₀; artefaktów ani tolerancji nie zmieniono.
- Runner po zgłoszonym restarcie: running=True, worker_alive=True, accepting_jobs=True, worker_error=None. Wolne 2110935040 B (~1.97 GiB) wobec progu 8 GiB; aktywne joby [], ostatni stan koordynatora waiting_for_disk. Ten sam #227 ma stan obserwatora `queued` / `waiting_for_build`. Żywy uchwyt 81829/PID 243032 potwierdzono; nie zgłoszono duplikatu i nie usuwano danych.
- #227 pozostaje przypięty do a8d67ac92002b884799119578a054b518cf40cbf, digest e848950d7d555f4d70d27a71421803fd2566d7e2f57d7e05b22f05da8123e8e6: zawiera poprawkę μ₀, bez późniejszych EPS termination/dimensions ani S09. Po terminalnym sukcesie publiczny managed dry-run ma poprzedzić pojedynczy Γ nearest; przyjęcie wymaga rzeczywistych artefaktów. Pełne frequency_window wymaga później świeżego pakietu z diagnostyką i kontrolowanego strojenia.
- S09 pozostaje OPEN: atomiczny typed cutover musi objąć ProblemIRV04/Wire.study, StudyIR wraz z pozostałymi payloadami, migrację i round-trip, obecność BC, planner, geometryczne certyfikaty siatki/regionów/ramy oraz MFEM 2.5D. Dotychczasowe guardy i propozycje kontraktu nie są produkcyjnym providerem. API/UI/FMS/WebGL, serial/adaptive parity i pomiar puli, signed15, DE/BV/COMSOL A1, zbieżność, S10/GPU oraz PR97/integracja nadal OPEN.

Dowody w katalogu preview-state-checkpoint wizualizacji wątku: eps-dimensions-final-staged-validation.json, eps-dimensions-native-review.md, eps-dimensions-consumer-review.md, eps-dimensions-consumer-source.md, eps-dimensions-regression-baseline.json, gamma226-finite-air-analytic-comparison.json i gamma226-finite-air-analytic-audit.md. To osobne dowody źródeł i kontroli wcześniejszego raw wyniku, bez nowej kwalifikacji solvera.


<!-- eps-termination-spatial-checkpoint-20261004 -->
## Aktualny checkpoint — diagnostyka podokien i S09 na remote

Odczyt 2026-10-04T04:47:21.413299+00:00. S00–S12 pozostają OPEN; nowych zaakceptowanych punktów jest zero.

- Poprawka EPS `091a046970b2256c85813c5ea4761377496c5e57` zachowuje rzeczywisty signed kod zakończenia i liczbę iteracji osobno dla każdego podokna; dostępny kod błędu 0 nie usuwa zmierzonych danych. Brak odczytu, hard error oraz nieważny kontekst pozostają false/null. Review: jeden P2 zamknięty źródłowo, bez nowych P1/P2; dokładnie staged dokumentacja naukowa i whitespace PASS. Regresja rzeczywistego formattera przygotowana, niekompilowana zgodnie z zakazem. Native/runtime NOT VERIFIED. Nie zmieniono operatora, tolerancji, budżetów ani kryteriów akceptacji.
- S09 `c667a41779a6cba20d917983b674563b1e3f929f`: historyczne readery/migratory odrzucają obecność spatial_representation, także null, zamiast tracić intent. Nowa nota 0833 i specyfikacja 2.5D są propozycją kontraktu; typed ProblemIRV04 i produkcyjny provider MFEM 2.5D nadal OPEN. Kontrole naukowe, parser Rust bez kompilacji i review źródeł PASS; siedem wcześniejszych niezmienionych kontroli algebraicznych pozostaje aktualne. Nie uznano tego za kwalifikację solvera 2.5D.
- Korekta diagnozy Γ #226: układ split ma 1312 stopni swobody, magnetyczne q ma 656; limit dokładnego preconditionera 512 sprawdza split_count. Nearest i frequency_window różniły się również KSP/preconditionerem oraz NEV/NCV, więc nie stanowią kontrolowanego A/B. Z brakujących kodów podokien nie można wywieść rzeczywistej przyczyny siedmiu slepc_diverged. Pełne okno nadal OPEN; kandydat nearest 9,299249697068216 GHz został odrzucony przez bramkę μ₀ i nie jest nowym zaakceptowanym punktem.
- Runner po restarcie: worker_alive=True, accepting_jobs=True, worker_error=None; wolne 2184069120 B (~2.03 GiB), próg admission 8 GiB. Job #227 `d2a6c2dd0c3c4a66a1e05fce10bb32c7` ma stan `queued`. Nie zgłoszono duplikatu, nie usuwano danych ani cache.
- Jeden żywy kontroler sesji 81829 (PID 243032) obserwuje job #227; faza `waiting_for_build`. Po succeeded/exit0 i publicznym managed dry-run uruchomi tylko nową próbę nearest Γ 9,3 GHz na modelu 71ba0d18225ffcc83f7f18e676de8dc051e87fd1, L2/t3. Wynik wymaga walidacji artefaktów, μ₀, demaga, residualu i binding. Kontroler nie kwalifikuje pełnego okna ani 15-punktowego sweepu.
- Ważna tożsamość źródeł: #227 kompiluje commit a8d67ac92002b884799119578a054b518cf40cbf z poprawką μ₀; nie zawiera S09 ani nowej diagnostyki EPS. Następny eksperyment całego okna wymaga świeżego pakietu tej diagnostyki po zakończeniu bieżącej bramki; queued nie oznacza wykonania. API+UI/FMS/WebGL, serial/adaptive parity i pomiary CPU/RAM, DE/BV/COMSOL A1, zbieżność, S10/GPU oraz PR #97/integracja pozostają OPEN. Wykres nie otrzymał nowych punktów.

Dowody w katalogu evidence wątku: `preview-state-checkpoint/eps-termination-staged-validation.json`, `eps-subwindow-termination-review.md`, `spatial-contract-staged-validation.json`, `spatial-presence-guard-review.md`, `gamma226-window-convergence-audit.md`, `eps-plan-live-checkpoint.json`, `gamma227-nearest-controller-state.json`.

<!-- canonical-mu0-source-checkpoint -->
## Poprzedni checkpoint — poprawka μ₀ na remote; nowy build w kolejce

Odczyt 2026-10-04T04:01:49.824275+00:00. S00–S12 pozostają OPEN; brak nowych zaakceptowanych punktów.

- Docker po restarcie: health OK, worker_alive=true, worker_error=null, przyjmowanie zadań włączone. Ostatni pomiar przed zgłoszeniem: 3 385 720 832 B (~3,15 GiB), poniżej progu admission 8 GiB. Nie usuwano cache, wyników ani kontenerów i nie uruchomiono ciężkiego buildu poza kolejką.
- Γ #226: frequency_window zakończone błędem, 43/50 podokien OK; kompletność niezatwierdzona. Osobny selected-only nearest zakończył solver kodem 0 w 40,75 s: 9,299249697068216 GHz, full relative residual 6,396428791585744e-11. Driver prawidłowo odrzucił niespójną μ₀. Stary punkt pozostaje niezatwierdzony; nie poprawiano jego artefaktów.
- Przyczyna potwierdzona: dwie własne stałe μ₀ w shared-domain C++ składały rzeczywisty operator i probe. Commit `a8d67ac92002b884799119578a054b518cf40cbf` zastępuje oba przypisania istniejącym `fullmag::fem::kMu0`. Model, metadata oraz próg spójności 1e-12 i residualu 1e-8 pozostają bez zmian. Source review bez nowych P1/P2, kontrola dokładnie staged dokumentacji naukowej PASS. Regresja importera/Floqueta przygotowana, testy C++ niekompilowane zgodnie z zakazem. Poprawiony runtime NOT VERIFIED.
- Jeden managed build: job `d2a6c2dd0c3c4a66a1e05fce10bb32c7` (sekwencja 227), profil `fem-cpu-slepc-runtime-v2`, źródło commit `a8d67ac92002b884799119578a054b518cf40cbf`. Profil nie kompiluje unit tests ani frontendu. Zgłoszenie do kolejki nie dowodzi startu ani sukcesu. Admission jest blokowane dostępnym storage; po uzyskaniu terminalnego sukcesu i receipt należy wykonać nowy nearest Γ na niezmienionym modelu oraz zweryfikować stałą, residual, demag i binding siatki/równowagi. Nie używać pakietu #226 do kwalifikacji poprawki.
- PreviewState strict raw JSON jest na remote w `17d614412672cf22e6dbb6c01a7375bdcaae5076`. Ochrona centralnego postępu etapów przed obcymi session_id/epoch/run_id jest na remote w `c9f8e78b098545f59603e73c329d855f895902c1`; produkcyjne TypeScript (896 wejść, 0 testów) i lint (7 plików, 0 błędów/ostrzeżeń) PASS. Nowy import FMS, lifecycle/session-switch i browser/WebGL pozostają NOT VERIFIED. Potrzebny osobny zgodny build API+UI po bramce runtime.
- Nadal otwarte: 15 zaakceptowanych punktów signed DE, pełne okno Γ, serial/adaptive parity i pomiary CPU/RAM, API/GUI/FMS/Inspector, DE/BV/COMSOL A1 i zbieżność, S09/S10/GPU, PR #97 i integracja. Cztery wcześniejsze zaakceptowane punkty ±10/±25 nie kwalifikują nowego kodu.

Dowody: `preview-state-checkpoint/mu0-fix-review.md`, `mu0-staged-scientific-validation.json`, `mu0-runtime-build-submit.json`, `gamma226-selected-result-inspection.json`; `adaptive-ui-checkpoint/stage-identity-production-types.json` i `stage-identity-production-eslint-evidence.json` w katalogu evidence tego wątku.

<!-- gamma226-window-terminal-selected-mode -->
## Poprzedni checkpoint — Γ window failed; osobna próba pojedynczego modu

Odczyt 2026-10-04T03:28:58.637030+00:00. Źródła, runtime, GUI i kwalifikacja naukowa pozostają oddzielnymi bramkami.

- Docker i koordynator działają. Pilot Γ #226 zakończył się błędem (exit 1) o 2026-10-04T03:21:39 UTC; kontroler 75208 zakończył pracę. Zachowano receipt i dane. Poprawnie zakończyły się 43 z 50 podokien. Siedem ma `stop_reason=slepc_diverged`: base 1, 2 oraz refinement 12, 13, 14, 15, 24. Certyfikat ma stan `failed/pass_incomplete`. Kandydat 9,299249697096525 GHz wymaga nadal zatwierdzenia; nowych zaakceptowanych punktów jest zero. Nie wykazano niezerowego PetscErrorCode ani związku awarii z Dockerem.
- Odczyt ustawień po EPS potwierdza tolerancje EPS/KSP 1e-9/1e-9 i FGMRES z restartem 8. Dokładny preconditioner okna był wyłączony (`disabled_dimension_cap`): układ split ma 1312 stopni swobody (magnetyczne q: 656), a limit wynosi 512. Wpływ tego ograniczenia na zbieżność jest hipotezą do sprawdzenia. Limit i próg fizycznego residualu 1e-8 pozostają bez zmian.
- Próba pojedynczego modu Γ `gamma-nearest-current-job226-v1` zakończyła solver kodem 0 w około 40,75 s. CSV i spectrum.v3 zawierają częstotliwość 9,299249697068216 GHz, a względny pełny residual wynosi 6,3964287916e-11 przy progu 1e-8. Natywny residual ma certyfikację, lecz driver odrzucił wynik z powodu niespójnej stałej μ₀: diagnostyka podaje 1,25663706212e-6, model deklaruje 4πe-7. Różnica względna wynosi około 5,44e-10. Wynik pozostaje niezatwierdzony do czasu sprawdzenia źródła rozbieżności; nie osłabiono gate. Jest to jawna próba `selected_only`, z `window_complete=false`. Zachowano ten sam model, L2, trzy warstwy i zweryfikowany runtime #226. Kompletność widma 8,5–16 GHz nadal jest otwarta. Dowód: `gamma226-selected-result-inspection.json` w katalogu checkpointu.
- Poprawka importu PreviewState jest na remote w commicie `17d614412672cf22e6dbb6c01a7375bdcaae5076`. RawValue zachowuje odrzucanie powtórzonych znanych pól oraz numeryczne klucze domen. Review źródeł, parser/format i kontrola whitespace przeszły. Regresje są przygotowane i nie były kompilowane. Kompilacja nowego readera, import oryginalnego FMS i weryfikacja w przeglądarce mają stan NOT VERIFIED. Pakiet #226 zawiera poprzedni reader Value.
- Trwa poprawka centralnego zasobu postępu etapów: UI ma porównywać session_id, epoch i run_id przed pokazaniem danych. Nowy build zgodnego API i UI wymaga wolnego storage; ostatni pomiar około 4,2 GiB był poniżej progu 8 GiB. Zachowano aktywne cache i mounty.
- S00–S12 pozostają OPEN. Do wykonania: zaakceptowany sweep 15 punktów, kompletność okna Γ, zgodność serial/adaptive i pomiar CPU/RAM, API/GUI/FMS/WebGL/Inspector, DE/BV/COMSOL A1 i zbieżność, S09/S10/GPU oraz integracja PR #97. Dotychczasowe cztery punkty ±10/±25 są wcześniejszymi wynikami. Zachowano pozostały WIP.

Dowody: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\preview-state-checkpoint\gamma226-terminal-inspection.json`, `gamma226-diagnostics.json`, `gamma226-nearest-launch-plan.json`; [naprawa importu FMS](2026-10-04-preview-state-json-repair.md).

<!-- adaptive-core-remote-runtime226-compiling -->
## Poprzedni checkpoint — UI source na remote; pilot Γ był aktywny

Odczyt 2026-10-04T02:50:45.579303+00:00. Źródła, build, runtime i browser pozostają oddzielnymi bramkami.

- Pakiet adaptive core 20 plików jest na remote w `841ff1151cf636295c79f4faed217d7584a6d6c4`: resource admission, procesy independent-k, child protocol/CLI, fresh checkpoint attempt i telemetry. Review bez otwartych nowych P1/P2; parser 19 wejść PASS. Dwa wcześniejsze P2 output/retry są CLOSED SOURCE. Wszystkie 20 wejść odpowiadają kapsule226 przed normalizacją Git.
- API policy/telemetry i dwa zmienione artefakty generowane zapisano w `d2bd0c6aabcd898ef8b18afa045f6feb429747a9` (12 plików). Review i źródłowe kontrole PASS. Część PreviewState w types.rs zachowano jako WIP; nie została przypadkowo dołączona. Source checkpoint nie dowodzi HTTP, browser ani serial/adaptive parity.
- Opcjonalna diagnostyka Schur/Floquet z notą naukową i mapą jest na remote w `f0290ca37a93056a6e01db3b0c0948a22e6933fe` (6 plików). Usunięto znalezioną regresję guardu bez SLEPc; focused scientific validator i source review PASS. Końcowa poprawka guardu nie jest w kapsule226: finalny macro0 build oraz enabled/disabled parity NOT VERIFIED. Metryki sondy są obserwacją, bez zmiany physical residual acceptance.
- Build226 `4c32a918a21944d68c9814fd35bf881a`, profil fem-cpu-slepc-runtime-v2, source digest `d0794df0e82e63674085327105d9d3a9a1cee398bec97f1321e73881febaefbf`: koordynator potwierdził succeeded/exit0. CLI, API i moduł Python zbudowane; worker exit0/OOMKilled=false. Publiczny driver zweryfikował receipt/hash closure i model przed live runem. Testów jednostkowych nie kompilowano; frontend nie był częścią tego profilu.
- Uruchomiono dokładnie jeden standalone Γ: model `71ba0d18225ffcc83f7f18e676de8dc051e87fd1`, SHA256 `083f8f97b705b819cee2c4a03349e06f7b0b39715ddfec0d9898aa5e8ab23038`, L2/t3, frequency_window8.5–16GHz, EPS/KSP1e-9, FGMRES restart8. Kontener `fullmag-dispersion-9b5540788cf25071e093319554264f3a` ma poprawne read-only mounty kapsuły/pakietu i nowy output. Native proces działa; ostatni odczyt wskazuje refinement subwindow31/50. Nie zmieniono progów ani nie zastąpiono solvera analityką.
- Wynik Γ pozostaje running/NOT VERIFIED. Do akceptacji wymagane: run-result, niepuste wiersze, rzeczywiste queried_after_eps, kompletne okno, full physical residual1e-8, demag i equilibrium binding. Następnie signed15 i source-bound serial/adaptive parity. Nowych zaakceptowanych punktów0; historyczny zbiór zawiera cztery ±10/±25rad/µm. Wykres15 nie jest jeszcze gotowy.
- UI Study policy/telemetry jest na remote w `b6a9abe8f7fd93586e5ac7c6d92fb93aeeca384f` (8 plików), a mesh loading/optional overlay w `a2963dbed8c6a287f0785c2677315ce777f0a7cf` (6 plików). Zlikwidowano ręczne kopie telemetry DTO na rzecz typu generated; ready projection Study wymaga session/epoch/run identity. Optional periodic-pairs TimeoutError zachowuje error/diagnostics; topology ma lokalny deadline15s i istniejący abort/generation guard.
- Root/independent source reviews bez nowego P1/P2; production TypeScript896 inputs/0test-spec/0diagnostics PASS, scoped ESLint7 plików/0errors/0warnings PASS. Framework dependencies mają dokładne zadeklarowane wersje. Staged treść8/8 zgodna z kandydatem po rozpoznaniu CRLF;6/6 Git blobs zgodne. Prepared React tests niekompilowane. Hook React Doctor8 plików zgłosił jeden index-key warning w Runtime warning FieldRow; identyczny zapis jest w bazie bf5e2f5, nie jest nową regresją. Framework-specific hook scan był gated off przy monorepo root; browser i managed paired UI nadal NOT VERIFIED.
- Całe worktree nadal nie jest na remote: PreviewState i dalsze S09 zachowano; generated client/path mają wyłącznie różnicę reprezentacji zakończeń linii i identyczny Git-normalized blob z HEAD. S00–S12, UI/WebGL/FMS/Inspector, DE/BV/COMSOL A1, convergence, S09/S10/GPU i PR97/integracja pozostają OPEN.

Dowody w katalogu wizualizacji wątku: adaptive-core-checkpoint, adaptive-api-checkpoint, floquet-diagnostics-current-review oraz adaptive-authoring-checkpoint/gamma226-controller-state.json i gamma226-dry-run.stdout.json. Bieżący native log i run-request w canonical storage: scientific-batches/nonzero-k-validation/4c32a918a21944d68c9814fd35bf881a/gamma-fgmres-current-job226-v1/de-smoke-k0/runtime.log.


<!-- adaptive-authoring-and-build225-compile-fix -->
## Aktualny checkpoint — authoring na remote, naprawiony błąd kompilacji #225

Odczyt 2026-10-04T00:58:04.183153+00:00. Ten wpis zastępuje wcześniejszy status running joba225; źródła i runtime pozostają oddzielnymi bramkami.

- Job225 `02e8a9cc4a8f487ea0c8a1a1afc1cf62` zakończył się failed/exit2. Native-build wykazał E0317 w `eigen_progress.rs`: gałąź if zwracająca Option nie miała else. Nie jest to awaria Dockera ani dowód błędu fizycznego. Poprawka zwraca None dla nietagowanych zdarzeń, zachowując rozdzielenie KSP normy i residualu fizycznego; istniejąca regresja sprawdza brak linear_solve dla zdarzenia fizycznego. Parser i scoped diff PASS; kompilacja poprawki wymaga nowego buildu.
- Commit `2ce67b768fff581c9105739e22deaa2fa3fb4455` zapisuje17 plików kontraktu IR/authoring/Python i ADR0034. Review wykryło i poprawiono utratę requested backend/device/precision w adapterze oraz różne znaczenie null polityki sceny. Historyczne brakujące pola zachowują backend/auto/double; nie wyprowadza się CPU z adaptive. Null przywraca serial zgodnie z Pythonem i metadata. Dokładnie wybrany kandydat:8 interpretowanych testów Python PASS, AST i parser Rust PASS, review bez otwartych P1/P2. Przygotowane regresje Rust niekompilowane zgodnie z zakazem. To source checkpoint authoringu, bez deklaracji działającego schedulera.
- Commit `744f4c9ffad0238b615e2adc8e893a4a0e40b92f` zawiera osobną trzywierszową poprawkę E0317. Oba commity potwierdzono na remote branchu zadania. Pozostały WIP pool/API/UI/S09 zachowano; cały worktree nie jest jeszcze na remote. Kapsuła225 powstała przed tymi zmianami i nie może ich kwalifikować.
- Dalej: jeden świeży snapshot fem-cpu-slepc-runtime-v2 przez istniejącą FIFO, z wymaganymi jawnymi untracked wejściami; po terminalnym sukcesie weryfikacja receipt/hash closure i standalone Γ na modelu71ba0d18/L2/t3/oknie8.5–16GHz, commonEPS/KSP1e-9 iFGMRESrestart8. Dopiero po pełnym residual/demag/window/query signed15 oraz serial/adaptive parity. Nowych zaakceptowanych punktów0; historyczne cztery ±10/±25 pozostają jedynym zaakceptowanym zbiorem. S00–S12, UI/WebGL/FMS/Inspector, COMSOL A1, zbieżność, S09/S10/GPU i PR97/integracja nadal OPEN.

Dowody: `adaptive-authoring-checkpoint/source-review.md`, `verification.json`, `candidate.patch`, `runner-before-next-build.json` oraz `modal-progress-compile-fix/verification.json` w katalogu wizualizacji tego wątku; terminalny stan225 i jego logi w canonical storage.


<!-- gamma-hard-error-query-runtime225-checkpoint -->
## Aktualny checkpoint — poprawki Γ/K0 na remote; build225 running

Odczyt 2026-10-04T00:18:32.791263+00:00. Commit i potwierdzony remote `9347ea5201997373f18061727506e6378cba18a1`. Dotychczasowa kampania15 pozostaje failed; żadnej z poniższych kontroli źródłowych nie należy traktować jako nowych zaakceptowanych punktów.

- Zapisano10 plików jednego przyrostu: heap-owned graf K0, kontrola hard EPS error przed getterami/teardown, mutex-guarded quarantine latch i zatrzymanie local growth/całego okna; zachowanie oryginalnego kodu i cancellation. Ujemny EPS convergence reason przy poprawnym EPSSolve nie aktywuje tej gałęzi. Nieznane outer EPS iterations są null; failed subwindow ma lokalną parę(pass,subwindow_index). Zakres production FEM CPU K0, bez deklaracji bezpieczeństwa innych lane/reference solverów.
- Dodano oddzielny Gamma query validator dla standalone i mixed frequency_window. Rzeczywiste solver_adapter/engine_id, wektor zerowy, queried_after_eps i wszystkie podokna są kontrolowane względem request i natywnego schedule. Mixed nie korzysta z top-level identity/query pierwszego Floquet. Zachowano istniejący ścisły nonzero Floquet validator i fizyczne residual acceptance.
- Review znalazło i poprawiono dwa kontraktowe P2: helper używał niepublikowanego solver_model zamiast solver_adapter; bezpośredni K0 return nie publikował request wavevector. Wrapper teraz publikuje rzeczywiście zadeklarowany wektor w diagnostics/result, bez wymyślania zer. Przygotowano actual-entry regresję C++ dla obu pól; nie kompilowano jej.
- Dowody source:75 interpretowanych testów Python PASS; dwa niezależne bounded review bez nowych otwartych P1/P2; staged AST/JSON, staged naukowa nota/mapa i scoped whitespace PASS. Hard-error isolated failure fixture i managed fault injection pozostają NOT VERIFIED; source review nie zamyka tego wymagania. Patcher workera miał błędy quoting/NUL przed zapisem; root przejął, naprawił generator i brakującą klamrę growth loop, po czym zweryfikowano rzeczywisty source diff.
- Zlecono dokładnie jeden fresh snapshot: job225 `02e8a9cc4a8f487ea0c8a1a1afc1cf62`, source_digest `5175d615fd2199e4549a4d15b706a864350ae6bc6c03ad814ec062dacf3ba682`, profil fem-cpu-slepc-runtime-v2, stan running. Snapshot zawiera wymagane jawne untracked pliki adaptive/S09; pozostały WIP nie jest przez commit9347 w całości wysłany na remote. Kapsuła capture d2525b24e2164812a7d2c6754d83f700 jest niezmienna; build obejmuje aktualne źródła Γ/common tuning/telemetry, w odróżnieniu od223. Nie kompiluje testów jednostkowych. Sukces i artifact closure jeszcze NOT VERIFIED.
- Dalej: odebrać i zweryfikować225; standalone Γ tego samego modelu/L2/t3/okna8.5–16GHz z commonEPS/KSP1e-9 oraz FGMRESrestart8; sprawdzić requested/effective query i pełny residual/demag/window. Potem signed15 oraz serial/adaptive parity i pomiar CPU/RAM. Następny sweep dostaje nowy katalog; nie nadpisuje dowodów failed223. S00–S12, UI/WebGL/FMS/Inspector, DE/BV/COMSOL A1/zbieżność, S09/S10/GPU i PR97/integracja nadal OPEN.

Dowody: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-error-contract\gamma-consumer-review.md`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-error-contract\native-lifetime-review.md`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-error-contract\modal-gamma-krylov-trial-report.md`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-error-contract\staged-source-verification.json`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-error-contract\signed15-job223-failure.json`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-error-contract\build225-status.json`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-error-contract\progress.json`.

<!-- signed15-job223-terminal-gamma-failure -->
## Aktualny checkpoint — signed15 zakończony błędem Γ; przygotowanie nowego runtime

Odczyt 2026-10-03T23:56:09.765678+00:00. Ten checkpoint zastępuje niższe deklaracje o aktywnym kontrolerze24460, obserwatorze2543 i trwającym signed15 #223.

- Kampania `signed15-fgmres-serial-job223-v1` zakończyła się failed/exit1 o 2026-10-03T23:45:33UTC. Receipt wskazuje brak artefaktów wynikowych oraz verified_absent kontenera; ścisły obserwator zakończył się błędem i nie wygenerował zaakceptowanego wykresu15.
- Przyczyna w logu: K0 frequency window not certified, 44/50 podokien completed i6 failed (4base,2refinement), stop_reason frequency_window_subwindow_failed. Sześć podokien ma stop_reason slepc_diverged. Log zawiera kandydat Γ9.29924969706835GHz, lecz certificate pass_incomplete i niedokończone spektrum nie pozwalają go uznać za zatwierdzony punkt kampanii. Nie wykazano tu nonzero PetscErrorCode ani związku z restartem Dockera. Nie zmieniono residual acceptance.
- Nowych zaakceptowanych punktów0; wcześniejsze cztery unikalne ±10/±25 pozostają jedynymi zaakceptowanymi danymi. Brak końcowego15-point plot. #223 nie zawiera wspólnego strojenia Γ/Floquet z991f24 ani telemetrii zfa41f067.
- Po restarcie Docker i istniejący koordynator są zdrowe: worker_alive/accepting_jobs true, worker_error null, active_jobs puste, storage_free_bytes12113428480. Stary klient mastera zgłosił profile allow-list mismatch; właściwy klient worktree sprawdził runtime-v2 poprawnie. Nie zmieniono koordynatora, profili ani kolejki.
- W implementacji: osobna kontrola queried-after EPS/ST dla standalone/mixed Γ, realnego native solver_adapter i kompletności par(pass,subwindow_index) wg natywnego schedule. Testy Pythona i review są aktualizowane po wykryciu błędnego pola solver_model w pierwotnym helperze. Native hard-EPS-error ownership/quarantine pozostaje odrębną poprawką; nie jest dowiedzioną przyczyną sześciu diverged podokien #223.
- Następna kolejność: skończyć i przejrzeć te dwa przyrosty; scoped commit/push; fresh snapshot runtime-v2 przez FIFO z jawnie włączonymi wymaganymi nowymi plikami; standalone Γ na identycznym modelu/L2/t3/oknie8.5–16GHz z commonEPS/KSP1e-9 iFGMRESrestart8, zweryfikować query oraz pełny residual/demag/window; dopiero potem signed15 i serial/adaptive parity. Poprawka hard-error wymaga osobnego failure-path dowodu managed, nie tylko normalnego Γ.
- Cel S00–S12 nadal OPEN: solver runtime, API/UI/WebGL/FMS/Inspector, DE/BV/COMSOL A1, zbieżność, S09/S10/GPU oraz PR97/integracja nie są zamknięte tym checkpointem.

Dowód failure: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-error-contract\signed15-job223-failure.json` oraz oryginalny run-result.json i runtime.log w kanonicznym storage. Dane zachowano.

<!-- modal-progress-api-generation-checkpoint -->
## Aktualny checkpoint — telemetria solvera na remote; klient API wygenerowany

Odczyt 2026-10-03T23:19:02.439990+00:00. Commit telemetrii i potwierdzony remote: `fa41f067e1ab88a674066672073f49a1b3074882`. Ten checkpoint zastępuje niższe bieżące deklaracje o braku generacji API i review telemetry, nie historyczne dowody runów.

- Źródłowo rozdzielono surową normę KSP od fizycznego względnego residualu modu, z jawnymi role/type/linear iteration. Callback tagged `ksp_norm` publikuje physical residual i outer EPS iteration jako null. Nieznana/niefinity/ujemna norma nie staje się zerowym residualem. Konsument i obie ścieżki CLI zachowują osobne EPS iteration oraz subwindow index; cancellation i kryterium stop pozostają niezmienione.
- Dziewięć plików stage'owano selektywnie względem zachowanych .before. Source review przyrostu nie znalazło nowych P1/P2; parser czterech staged plików Rust, parser JSON, scoped whitespace i nota/mapa naukowa PASS. Przygotowane regresje C++/Rust niekompilowane i nieuruchomione zgodnie z zakazem. Managed callback/API/UI tej poprawki NOT VERIFIED; #223 jej nie zawiera.
- Nowa konkretna pozycja P2: K0 po niezerowym `EPSSolve` może odpytywać EPS/ST/KSP po błędzie, wykonywać teardown lifetime-sensitive grafu i kontynuować kolejne podokna. Dotychczasowy guard nie zapewnia pełnej retencji: `ProductionCpuWindowOperatorScope` i owned scope bezwarunkowo niszczą kontekst. To istniejący problem poza commitem telemetry; historyczne „review bez P1/P2” nie zamyka tej nowej pozycji. Naprawa musi najpierw rozstrzygnąć bezpieczne ownership/retention całego grafu, następnie ominąć gettery po twardym błędzie, zatrzymać pozostałe podokna, zachować pierwotny kod i cancellation oraz przygotować regression failure-path. Nie wystarczy sam warunek wokół query ani wyłączenie EPSDestroy.
- Generacja OpenAPI jest wykonana w worktree: 28 zmienionych plików API/authoring/UI porównano byte-identical z kapsułą #223; eksport z rzeczywistego fullmag-api SHA `8bfc2260e2638b80d0c93add6e03b053d3a3c2bdb80bf88862e22d15f110fd46` zawiera wymagane session_id/session_epoch/run_id i parallel execution schemas. Zastosowano istniejące generatory, bez ręcznej edycji schematu, cargo ani instalacji. JSON jest semantycznie równy eksportowi po kanonicznej normalizacji build identity. API hygiene PASS.
- Produkcyjne typy UI: TypeScript5.8.3/noEmit PASS, 896 wejść/895 plików aplikacji, zero test/spec, stabilne hashe. Pierwsza kontrola zatrzymała się na brakującej ścieżce deklaracji react-dom w readonly SDK; poprawiono tylko konfigurację narzędzia walidacyjnego. Wygenerowane pliki pozostają WIP razem z producentami adaptive/API, aby nie commitować niezgodnego osobnego kontraktu. To nie dowód browser/WebGL ani odtworzenia modelu.
- Docker i runner zdrowe po restarcie: worker_alive/accepting_jobs true, worker_error null. Ten sam serial signed15 działa, kontroler24460/obserwator2543, brak finalnego receipt i nowych zaakceptowanych punktów. Wcześniejsze cztery unikalne −25,−10,+10,+25 rad/µm pozostają jedynymi zaakceptowanymi danymi. Ostatni log Γ/refinement21/50 zawiera normy wewnętrzne; nie są pełnym residualem ani dowodem stagnacji. Nie restartowano solvera, nie uruchomiono nowego ciężkiego buildu przy aktywnym lease i nie usunięto danych.
- Następne konkretne podzadania: pełny K0 hard-error lifetime fix; dopuszczenie kontrolowanego standalone Γ common tuning z osobną walidacją effective query (obecny driver wymaga niezerowego k dla trial), z zachowaniem rygorystycznego istniejącego Floquet true-residual gate; final signed15/postsolve/wykres; runtime-v2 dla aktualnego spójnego pakietu przez FIFO po zwolnieniu lease. Następnie serial/adaptive parity i pomiar zasobów. Całe S00–S12, UI/WebGL/FMS, COMSOL A1, DE/BV/zbieżność, S09/GPU i integracja PR97 pozostają OPEN.

Dowody: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\modal-progress-semantics\telemetry-review.md`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\modal-progress-semantics\staged-source-verification.json`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\modal-progress-semantics\generated-api-job223-receipt.json`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\modal-progress-semantics\generated-api-production-types-v2.json`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\modal-progress-semantics\progress.json`. Pięć źródeł aktywnego obserwatora wykresu pozostaje niezmienionych.

<!-- gamma-common-krylov-source-checkpoint -->
## Aktualny checkpoint — wspólne strojenie Γ/Floquet zapisane na remote

Odczyt 2026-10-03T22:30:37.416017+00:00; commit źródeł i potwierdzony remote `991f24cbe0eaf72c29fa9e52f3e2a8537bb874b7`.

- Zrealizowano źródłowo wspólny resolver czterech `FULLMAG_MODAL_*` dla FEM CPU K0 i Floquet. Legacy `FULLMAG_FLOQUET_*` pozostają zgodnymi aliasami tylko w Floquet. Konflikty i niepoprawne tokeny są odrzucane; dotychczasowe defaulty obu adapterów zachowano.
- Naprawiono K0: jawny dodatni limit iteracji liniowych nie jest już podnoszony do 1000 w ST ani korekcji Ritz. Budżety sprawdza się przed setup native względem `PetscInt`. K0 zapisuje rzeczywiście odczytane ustawienia EPS/KSP przed i po EPS oraz w każdym subwindow; nierozwiązany limit EPS jest null. Nowy before/after snapshot dotyczy K0; Floquet zachowuje wcześniejsze pre-query.
- Driver eksportuje wspólne parametry razem ze zgodnymi aliasami i zapisuje requested tuning z rzeczywistego polecenia. Publiczny residual acceptance, operator, demag i harmonogram okna pozostają bez zmiany. Poprawka nie stanowi kwalifikacji fizyki ani GPU.
- Weryfikacja: 45 interpretowanych testów drivera PASS; 35 kontroli walidatora dokumentacji PASS; nota i mapa źródeł PASS; scoped whitespace PASS; niezależne native source review bez otwartych P1/P2. Przygotowane testy C++ nie były kompilowane zgodnie z zakazem. Managed runtime tej poprawki NOT VERIFIED: #223 jest starszy.
- Kontroler24460 i obserwator2543 pozostają żywe; ten sam kontener signed15 jest running. Ostatni log dotyczy Γ/refinement21/50 z aktywnymi residualami wewnętrznymi. Siedem wcześniejszych zwrotów native nie jest dowodem akceptacji artefaktów. Nowych zaakceptowanych punktów0; wcześniejsze cztery unikalne ±10/±25 zachowano.
- Następne kroki: dokończyć istniejący sweep i ścisłą walidację/wykres; po zwolnieniu aktywnych zasobów zbudować aktualny pakiet runtime-v2 przez FIFO; potwierdzić konfigurację i pełne residuale Γ/nonzero-k; następnie serial/adaptive parity i zasoby. Telemetria źródła residualu i rozdzielenie shift index/EPS iteration pozostają OPEN. S00–S12, UI/WebGL/FMS, COMSOL A1, DE/BV/zbieżność, S09/GPU i integracja PR97 nadal OPEN.

Dowody: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-tuning-fix\native-review.md`, `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\gamma-tuning-fix\progress.json`; pięć źródeł obserwatora wykresu pozostaje niezmienionych.

<!-- checkpoint-attempt-roots-review -->
## Aktualny checkpoint — korzeń i ponowienia checkpointów; sweep nadal trwa

Odczyt 2026-10-03T21:53:52.227366+00:00; HEAD `c2fc778d9ccebee96244813fea8f792e04e68580`. Ten blok aktualizuje stan źródeł, nie kwalifikuje runtime ani nauki.

- Naprawiono źródłowo dwa P2: względny output root jest rozwiązywany i sprawdzany przed pierwszym native solve; każda próba dostaje świeży exclusive namespace zachowujący wcześniejsze checkpointy. Symlinki/reparse są odrzucane także przed normalizacją parent traversal. Bezpośredni writer i manifest v1 pozostają zgodne z poprzednim konsumentem.
- Helper oraz instrukcja stanowią osobny dwup­likowy commit `c2fc778d9ccebee96244813fea8f792e04e68580`, potwierdzony na remote. Hooki serial/bootstrap pozostają w zależnym dirty pakiecie adaptive; bieżący #223 nie zawiera helpera. Parser/rustfmt i scoped whitespace PASS; niezależne review bez nowych P1/P2. Sześć dodatkowych regresji Rust przygotowano, bez kompilacji zgodnie z zakazem. Rzeczywiste IO na managed mount, Windows reparse, przerwany sweep i integracja hooków NOT VERIFIED.
- Publiczny serial signed15 jest nadal uruchomiony (kontroler24460, ten sam kontener `fullmag-dispersion-7e6eb49e8c63cff21bd4883a93929fcf`). Log odnotował siedem zwrotów punktowych, ale finalny receipt i postsolve nie powstały: nowych zaakceptowanych punktów0. Dotychczasowe cztery unikalne ±10/±25 pozostają jedynymi zaakceptowanymi danymi. Obserwator2543 wygeneruje wykres dopiero po ścisłej walidacji.
- Γ poprawnie redukuje się do osobnego solvera K0; diagnostyczne ustawienia `FULLMAG_FLOQUET_*` nie obejmują tej gałęzi. Z trace źródeł #223: EPS1e-11/max2000; ST GMRES, rtol1e-13, restart do256, max1000; pełny residual acceptance nadal1e-8. Okno K0 obejmuje50 subwindows (16base+34refinement). To rozpoznana różnica konfiguracji i kosztu, a nie dowód błędnej fizyki. Następne podpunkty: zapisać effective tuning per sample; uzgodnić kontrolowane parametry Γ/nonzero-k bez osłabiania residualu ani kompletności okna; sprawdzić respektowanie jawnego `max_linear_iterations` przez obecne `max(1000, requested)`; oznaczyć źródło residualu/typ KSP w telemetrii i oddzielić indeks subwindow od liczby iteracji. Trace: `gamma-window-route-trace.md` w katalogu wizualizacji tego wątku.
- W porównaniu z kapsułą #223 28 sprawdzonych plików core jest byte-identical, a pięć różni się; ten pomiar nie dowodzi zbudowania nowych zmian. Nowy managed runtime build jest potrzebny dla aktualnego pakietu i poprawki replay; nie uruchomiono równoległego ciężkiego buildu przy aktywnym sweepie.
- Całe S00–S12, serial/adaptive parity, API/UI/WebGL, COMSOL A1, zbieżność, S09/GPU i integracja PR97 pozostają OPEN. Szczegóły: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\checkpoint-attempt-root-fix\progress.json` oraz review `helper-review.md`.

<!-- signed15-serial-after-operator-docker-restart -->
## Aktualny checkpoint — Docker odzyskany, serial signed15 rzeczywiście uruchomiony

Odczyt 2026-10-03T21:14:03.082289+00:00; zastępuje niższe deklaracje bieżącego stanu infrastruktury.

- Użytkownik zrestartował Docker Desktop. Silnik odpowiada; istniejący wspólny runner jest zdrowy, bez błędu wykonawcy i bez aktywnego joba builda. Ten sam #224 został uzgodniony przez runner jako failed/exit2. Nie zmieniono ręcznie kolejki ani nie zlecono duplikatu buildu.
- Ponownie zweryfikowano terminalny sukces #223, kapsułę źródeł i closure artefaktów FEM CPU double/SLEPc. Publiczny managed driver uruchomił jeden serial Relax→Eigen KPath z modelu `71ba0d18225ffcc83f7f18e676de8dc051e87fd1`. Potwierdzono running kontenera `fullmag-dispersion-7e6eb49e8c63cff21bd4883a93929fcf` i proces fullmag-bin; kontroler24460. To start solvera, nie akceptacja wyników.
- Zakres15: −25,−20,−15,−10,−7,−5,−2,0,+2,+5,+7,+10,+15,+20,+25 rad/µm; L2/t3, full demag, EPS/KSP1e-9, FGMRES restart8, okno8.5–16GHz. Artefakty: `C:\git\fullmag\storage\runs\eigensolve-dispersion-plan-20260-c5dfad6d7f548079\scientific-batches\nonzero-k-validation\65b2729aeb5245c3beb38dae0a88c71b\signed15-fgmres-serial-job223-v1`. Serial zachowuje bezpośredni certified Relax handoff; poprawka replay gałęzi Artifact wymaga odrębnego nowego buildu i parity.
- Dotychczasowe cztery zaakceptowane unikalne ±10/±25 pozostają jedynym wynikiem. Nowych0 w chwili checkpointu. Oczekujemy zakończenia15 i walidacji residual/Floquet/demag; wykres będzie zawierał wyłącznie rzeczywiste zaakceptowane punkty.
- W dirty worktree naprawiono publiczny eksport polityki: błędne override nie mogą nadpisać skryptu, explicit null przywraca domyślne serial. Cztery nowe regresje i cztery związane kontrole Pythona PASS. To dowód źródeł, nie runtime adaptive ani GUI; poprawka nie jest jeszcze zacommitowana.
- S00–S12, parity, browser/GUI, COMSOL, zbieżność, S09/GPU i PR97 integration OPEN. Dowód: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\static-demag-replay-runtime-v2\signed15-serial-restart-checkpoint.json`.


<!-- single-k-checkpoint-source-committed -->
## Aktualny checkpoint — surowy zapis punktu; nowych wyników brak

Odczyt 2026-10-03T20:37:24.877075+00:00. Commit i potwierdzony remote `ce2744719c8dea0f2565f2cf66a47f951d74b24c`.

- Pięcioplikowy commit zachowuje samodzielny helper IO, rejestrację modułu, konsument read-only, jego testy i instrukcję. Pełne bajty planu i artefaktów mają SHA/size; końcowy marker jest no-replace hard link. Nie zmienia operatora, progów residualu ani akceptacji punktów.
- 16 interpretowanych kontroli konsumenta PASS, parser/rustfmt i scoped whitespace PASS; review helpera bez nowych P1/P2. Przygotowane regresje Rust niekompilowane zgodnie z zakazem. Managed mount/hardlinks, writer i przerwany rzeczywisty sweep NOT VERIFIED.
- Hooki serial oraz bootstrap adaptive są wyłącznie w dirty worktree, zależne od nieukończonego pakietu adaptive/API/runtime. Ten commit nie aktywuje ich na remote ani w istniejącym #223.
- Aktualny koordynator: reconciling, TimeoutError, error_count81; API #224 nadal running mimo zweryfikowanego failed receipt I/O. Nie wystartował nowy solver. Rozważana droga po odzyskaniu silnika: atestowany #223 i publiczny serial Relax→Eigen KPath; źródłowe ominięcie błędnej gałęzi Artifact nie jest dowodem runtime.
- Nadal cztery zaakceptowane unikalne punkty −25,−10,+10,+25 rad/µm; nowych0. Sweep15, Γ, parity, GUI, COMSOL, zbieżność, S09/GPU i cały S00–S12 OPEN. PR97 bez merge. Nie usunięto danych ani nie restartowano współdzielonego Dockera.
- Dowód: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\single-k-checkpoint-candidate\committed-checkpoint.json`; instrukcja [checkpoint pojedynczego punktu](../../guides/eigensolve-single-k-checkpoints.md).


<!-- waveguide-frame-foundation-committed -->
## Aktualny checkpoint — rama falowodu i signed-k S09 zapisane na remote

Odczyt 2026-10-03T19:53:32.211097+00:00. Commit i remote `33b86550eda212a82e83972f10b5916ddc6d1a38`; PR97 OPEN z tym HEAD.

- Addytywny helper IR wymaga jawnej prawoskrętnej ramy, zapisuje requested/canonical osie i rzeczywiste metryki, zachowuje znak k oraz odrzuca składową poprzeczną. Guard gradual-underflow działa przy walidacji i każdej projekcji; nie zmienia środowiska FP. Nie aktywuje providera ani publicznego cutoveru.
- 18 niezależnych przypadków Decimal, exact Fraction counterexample scalar air island (25 dodatnich pivotów), rustfmt/parser/linki i scoped staged whitespace PASS. Review przyrostu: bez nowych P1/P2. Testy Rust niekompilowane zgodnie z zakazem; native/hardware/runtime NOT VERIFIED.
- Pozostają: typed mesh/half-edge/regions/interaction fields, fingerprint 2D+frame, V04/planner, MFEM 2.5D, equilibrium/residual i wszystkie bramki runtime/zbieżności. Helper nie jest ukończeniem S09.
- Bieżący runner: coordinator reconciling z timeoutem, accepting_jobs=true; API nadal wskazuje #224 running mimo failed receipt I/O. Nie uruchomiono następcy, solvera ani restartu Docker. Nowych zaakceptowanych punktów0; zachowane tylko cztery unikalne ±10/±25. Całe S00–S12, parity, UI, COMSOL, GPU i integration OPEN.
- Dowód: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\waveguide-frame-candidate\committed-checkpoint.json`. Pozostałe dirty/untracked zmiany zachowane poza commitem.

<!-- current-execution -->
<!-- frozen-v2-managed-driver-committed -->
## Aktualny checkpoint — konsument frozen-v2 zapisany i wysłany

Odczyt 2026-10-03T18:52:22.867217+00:00; status #224 i nauki pozostaje opisany w następnym bloku.

- Commit i potwierdzony remote `13405dac3347cb6ac0c902c7517215aa586e3de5` obejmuje tylko sześć nowych plików: managed driver frozen-v2, walidator bieżących artefaktów, walidator serial/adaptive parity, ich testy i instrukcję użycia. 33 interpretowane kontrole PASS; scope to źródła/payloady/lifecycle na fixture, bez kompilacji unit tests. Scoped staged whitespace, parser i lokalne linki PASS. Pozostałe dirty/untracked zmiany nie są objęte tym commitem.
- Review domknięte: błędna przestrzeń ścieżki EQ (oddzielny source i canonical output sidecar), obowiązkowy exact replay consumer-plan dla0/1/2, fail-closed os.walk i limit hashowania rosnącego pliku. Parzystość fizyczna wiąże50 pól identity; consumer-plan/full identity digest różnią się per mode, ale pełne identity i dokładne preimages są walidowane osobno. Nie ma nowych P1/P2 w tym przyroście.
- Rzeczywisty accepted15 bundle i wykonanie serial/adaptive nadal OPEN. Gate dostępny źródłowo nie dowodzi uruchomienia solvera ani przyspieszenia. #224 ma failed receipt przez I/O, API nadal running; koordynator przeszedł w `error`, `accepting_jobs=false` i 37 timeoutów w odczycie 2026-10-03T18:53:04.474220+00:00; obserwator zakończony przed solverem, zgoda na restart Docker oczekuje. Nowych zaakceptowanych punktów0.
- PR97 potwierdzony OPEN z tym HEAD, bez merge. Pełne S00–S12, nauka, GUI i lifecycle pozostają OPEN. Dowód: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\static-demag-replay-runtime-v2\frozen-v2-committed-checkpoint.json`. Instrukcja: [frozen-v2 parity](../../guides/eigensolve-frozen-v2-parity.md).

<!-- job224-io-failure -->
## Aktualny checkpoint — #224 nieudany build przez I/O

Odczyt 2026-10-03T18:38:26.761046+00:00; zastępuje deklaracje aktywnego kontrolera i oczekiwania na sukces #224 poniżej.

- Failed receipt #224 został odczytany z artifacts/build-receipt.json; source digest i native identity zgodne z kapsułą, oba logi sprawdzone względem receipt SHA/size. native-build exit2, koniec 2026-10-03T17:56:56.619361Z. Rust nie zapisał archiwów fullmag-ir/fullmag-application: `Input/output error (os error 5)`. To awaria infrastruktury zapisu, nie wynik solvera.
- API kolejki nadal running i coordinator reconciling przez timeout Dockera. Terminalny stan kontenera niepotwierdzony; nie zmieniono ręcznie kolejki, nie restartowano silnika i nie zgłoszono duplikatu. Własny obserwator v4/72469 zakończony po potwierdzeniu failed receiptu, przed solverem.
- Potrzebne odzyskanie kontaktu z Dockerem, uzgodnienie terminalnego stanu tego samego joba, następnie nowy atestowany build i pojedynczy sweep15. O osobną zgodę na restart współdzielonego Docker Desktop poproszono operatora; brak odpowiedzi nie jest zgodą.
- Review nowych konsumentów frozen-v2 wykryło output EQ path, brak obowiązkowego consumer-plan replay i ciche pominięcie błędów os.walk. Poprawki w toku; nie zacommitowano nieukończonego gate. 26 dotychczasowych interpretowanych kontroli PASS nie zastępuje nowych regresji ani runtime.
- Nowych zaakceptowanych punktów 0; cztery istniejące ±10/±25 zachowane. Pełne S00–S12 OPEN. Dowód: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\static-demag-replay-runtime-v2\job224-io-failure-checkpoint.json`.

<!-- job224-controller-recovery -->
## Aktualny checkpoint — odczyt runnera i kontroler sweepa

Odczyt 2026-10-03T18:14:40.614558+00:00; zastępuje niżej zachowane deklaracje aktywnego kontrolera84659.

- Kontroler v3/84659 terminalnie failed z timeoutem odczytu API przed uruchomieniem symulacji; receipt zachowany. Potwierdzono żywy kontroler v4/72469 dla tego samego joba #224. Ponawia wyłącznie przejściowe błędy transportu; nie ponawia autoryzacji/preflight, nie zgłasza drugiego buildu ani solvera. Cztery interpretowane regresje transportu PASS.
- #224 API running/exit null. Koordynator ma heartbeat i stan reconciling, zgłasza timeouty obserwacji Dockera. Trzy bounded read-only sondy engine/inspect/top również timeout; nie jest to dowód terminalnego zakończenia worker. Silnika ani runnera nie restartowano. Terminalny receipt/ABI i start sweepa pozostają OPEN.
- Nowych zaakceptowanych punktów 0; istnieją tylko cztery unikalne ±10/±25. Po sukcesie i atestacji tego buildu kontroler uruchomi jeden signed15 adaptive, postsolve i wykres/freeze. Pełne S00–S12, Γ/parity/UI/COMSOL/zbieżności/GPU/S09/integracja OPEN.
- Dowód: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\static-demag-replay-runtime-v2\controller-recovery-checkpoint.json`.

<!-- job224-static-demag-preimage-fix -->
## Najnowszy checkpoint — poprawka preimage statycznego demag

Odczyt 2026-10-03T17:17:06.430772+00:00; ten wpis zastępuje niżej zachowane deklaracje bieżące.

- #223 succeeded/exit0 i runtime FEM CPU double/SLEPc PASS. Sweep signed15 adaptive-v2 rzeczywiście wykonał bootstrap −25, ale sample1/−20 odrzucono `equilibrium_static_demag_hash_mismatch`; kampania failed/exit1, kontener verified_absent, dane zachowane. Brak nowych zaakceptowanych punktów.
- Commit i remote `128a7e309c7faf0f9b3045298a40df7839a2a8be`: dokładny subdigest h_demag/phi liczony z persisted source fields, aktualna realization z bieżącego planu; nowe artefakty z fresh fields. Wszystkie porównania numeryczne i dokładne signatures/content digests zachowane. Dodatkowo pełnodomenowe comparers odrzucają empty/shape/NaN/Inf po obu stronach. 45 interpretowanych testów artefaktów +35 validatora dokumentacji PASS, source-map/changed-page/parser PASS, bounded review bez P1/P2. Pięć regresji Rust przygotowanych, kompilacja zakazana i NOT VERIFIED.
- Nowy #224 `77962caa007c4666b861445277f33ab4`, profile runtime-v2, API running, digest `edd79229b6ad415581acb56579ee83ab83d020fed846b25df73309d09fc1d848`, snapshot `c57ca1faee7b99ec64f894903bfca5596a9ed73f236d2d13c44156b124609b78`, capture `201ac8f1bd154b529af4dacfcb7da5ff`. Aktualizacja 2026-10-03T17:45:37.739973+00:00: worker `53054223a283` running; docker top potwierdza Cargo/CMake i kompilatory C++/cc1plus. Kontroler84659 ponownie potwierdzony żywy. Nadal brak terminalnego receipt i nowych wyników solvera.
- Żywy one-shot controller handle84659 czeka na sukces i pełną atestację tego joba. Następnie uruchomi jeden adaptive sweep15 (−25,−20,−15,−10,−7,−5,−2,0,2,5,7,10,15,20,25rad/µm), a dopiero po postsolve PASS wygeneruje wykres oraz realny frozen bundle. Nie zastępuje to parity, nauki i UI.
- Pełny S00–S12, Γ, source-state replay, serial/adaptive parity, GUI/OpenAPI/browser, COMSOL A1, zbieżności, GPU, S09 i integracja PR97 OPEN. Dowód `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\static-demag-replay-runtime-v2\source-and-build-checkpoint.json`; niczego nie usunięto.

<!-- frozen-v2-parity-candidate-source -->
- Przyrost S05: osobny kandydat walidatora frozen-v2 serial/adaptive z 10 interpretowanymi kontrolami PASS; wiąże build, bundle, source/modal mesh, EQ, Floquet i częstotliwości −10,+10,−10. Residual wymaga osobnego fizycznego progu; scheduler co-activity i speedup nie są utożsamiane z parity. Kandydat jest w wizualizacjach, review trwa, nie został jeszcze przeniesiony do repo ani zacommitowany. Driver/linked native state replay, rzeczywista próba i cały S00–S12 OPEN. Dowód: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\static-demag-replay-runtime-v2\frozen-v2-parity-source-checkpoint.json`.

## Aktualny priorytet wykonania — replay równowagi

Odczyt: 2026-10-03T16:02:03.997430+00:00. Najnowszy przyrost zastępuje niżej zachowane statusy bieżące; pełny S00–S12 pozostaje otwarty.

- Commit `ed0ccc18c63493f90b7529e4f0b101a811b16c37`: porównanie H_eff0 certyfikatu obejmuje dokładnie węzły z magnetic_node_volumes>0; pełne tablice muszą mieć zgodne długości, skończone pola i skończone nieujemne wagi. Pusty support i overflow są odrzucane. Próg 1e-8 A/m oraz pełne m0, h_demag0, phi0 i signatures bez zmian. Dokumentacja fizyczna przed kodem; sześć przygotowanych regresji Rust niekompilowanych z powodu zakazu użytkownika. Rustfmt parse, source-map validator i35 interpretowanych testów validatora PASS. Niezależne bounded review: bez P1/P2.
- Nowy managed job #223 `65b2729aeb5245c3beb38dae0a88c71b`, profil `fem-cpu-slepc-runtime-v2`, stan API `running`, exit=None; digest `798904f41f474f5a782942a5dceeaa2f29bee9066ce65d411808f3536634cef6`, snapshot `7fccac6c9bd4bb39400adc9a4b9f972e34a5b31037a9b2fe9536f180a70d31fd`, capture `8a32e07a4d73469785de8e44bfa2b417`. Zgłoszenie zawiera wszystkie nieśledzone wejścia potrzebne bieżącemu kodowi. Worker `8d91c4ab9a7f` running/OOM=false; żywe docker-init i python3 potwierdzone przez docker top. Późniejszy odczyt 2026-10-03T16:24:04.510571+00:00: natywna kompilacja rozpoczęta; docker top potwierdza Cargo/CMake i kompilatory C++ (wcześniej również rustc). Istnieją logs/native-build.stdout.log i stderr.log; bieżący stderr pokazuje kompilację fullmag-application. Terminalny receipt i ABI pozostają OPEN. Kontroler one-shot v2 (handle98860) czeka na succeeded i pełną atestację, następnie uruchomi `signed15-fgmres-adaptive-v2`. Pierwszy kontroler zakończył się przed symulacją przez użycie terminal-only preflight podczas oczekiwania; jego receipt zachowano. Żaden nowy solver jeszcze nie wystartował.
- Frozen v2 adapter i generator: 23 interpretowane testy PASS (16generator+7adapter), bounded review adaptera: bez nowych P1/P2. Brak zaakceptowanego realnego bundle signed15; physical source-state replay oraz serial/adaptive parity nadal NOT VERIFIED. Adapter nie jest jeszcze podłączony do istniejącego drivera.
- Wykres użytkownika ±25 z czterema rzeczywistymi punktami ±10/±25 i dwiema krzywymi analitycznymi już zapisany i sprawdzony (PNG/PDF/receipt hash PASS); żaden dodatkowy punkt nie został dopisany na podstawie symetrii.
- Następne: terminalny receipt i ABI nowego joba → rzeczywisty adaptive seed/replay i artefakty15 punktów (w tym Γ) → frozen v2 serial/adaptive parity → spójny OpenAPI/frontend/runtime i browser. Pozostają convergence, COMSOL A1, GPU, S09 i integracja PR97; nie zmieniono zależności ani nie usunięto danych.

- Aktualizacja 2026-10-03T16:15:27.429340+00:00: commit poprawki i wcześniejsze zweryfikowane commity wysłane na origin; remote branch potwierdzony pełnym SHA `ed0ccc18c63493f90b7529e4f0b101a811b16c37`. Pozostałe dirty/untracked zmiany nie są tym dowodem objęte. PR97 pozostaje otwarty, bez merge.

- Frozen v2 generator/adapter zapisany osobno w `687bc7956649d9abbc4508ac31606089bc31d197` i push potwierdzony tym samym SHA na origin. Cztery pliki mają byte-identyczne SHA z kapsułą #223 (jej HEAD nadal ed0ccc18c63493f90b7529e4f0b101a811b16c37). 23 testy i review obejmują kod/fixture, nie wykonanie realnego replay. Podłączenie do drivera, zaakceptowany15-punktowy bundle, serial/adaptive parity i nauka pozostają OPEN.

<!-- job223-terminal-campaign-launch -->
- Aktualizacja 2026-10-03T17:02:48.059945+00:00: #223 terminalnie `succeeded`/exit0 z API kolejki. Receipt obejmuje 19 hash-bound artefaktów; runtime FEM CPU double/SLEPc, bez unit-test targets i bez frontend stages. Istniejący kontroler98860 przeszedł pełny `_validate_build_context` i uruchomił driver `signed15-fgmres-adaptive-v2` (PID 177312) z 15 punktami −25…+25rad/µm, w tym Γ, w jednym runie. Natywny bootstrap solve ukończony; worker sample1 (−20rad/µm) odrzucony `equilibrium_static_demag_hash_mismatch`, cała kampania failed/exit1, cleanup verified_absent. Dokładny preimage źródłowych h_demag/phi odtworzony i zgodny ze stored SHA; podpis był błędnie porównywany z przeliczeniem pól dopuszczającym roundoff. Poprawka źródeł zachowuje wszystkie progi i digests; nowy build i runtime OPEN. Nie ma nowych zaakceptowanych punktów; odtworzenie równowagi, parytet i cały S00–S12 OPEN. Dowód: `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\magnetic-replay-runtime-v2\job223-campaign-launch-checkpoint.json`.

### Poprzedni odczyt #222 — historia

## Aktualny priorytet wykonania

Odczyt: 2026-10-03T15:29:59.184367+00:00. Ten blok zastępuje starsze deklaracje bieżącego stanu, zachowane poniżej jako historia.

- Build #222 `15418192c13e4a119e6f75d14dde9c88`: terminalne succeeded/exit0 z API kolejki. Pełny digest `19e38280b5da573d6fc193a09c04b6578727ddd149234d755af1beeb725559f8`, commit runtime `f7ecb100648b57fb69fe2de4a932efba02717190`, source snapshot `0b77866746b2037869f8cdf5c93a810e9748129286f6ed771da721efec93faf7`. Receipt/ABI PASS: MFEM4.10, PETSc3.24.6, SLEPc3.24.3, FEM CPU double; native-build około17m58s. Bez kompilacji testów jednostkowych; GPU NOT VERIFIED.
- Próba `fgmres-km25-restart8-v2`: rzeczywisty solver completed/exit0, k=(0,-25e6,0)rad/m, f=13.557588586290586GHz. Fizyczny residual pełnego projected weak form/seams `1.926591054747952e-10 < 1e-8`, full_descriptor_certified=true dla tego modu. Trzy podokna, 169 shifted solves: wszystkie measured, zero violations/unavailable, maksymalny stosunek do progu KSP0.9964145193323742. Dynamic demag probes i potencjał/source mesh/mode binding PASS; L2/t3 PASS. To poprawny punkt numeryczny, nie kwalifikacja krzywej, pasma n0 ani zbieżności.
- Oryginalny run-result nadal failed z powodu konsumenta: błędny wymagany token schema i niewłaściwe traktowanie prawidłowego exhausted subwindow jako awarii KSP. Native producent eksportuje `frequency_domain_modal_solver_diagnostics.v1`; puste podokno wymaga dodatniego EPS/KSP, converged candidates i zerowych wszystkich liczników odrzuceń/awarii. Naprawa zachowuje pełne kryterium każdego solve. Schur action zachowany osobno dla wszystkich3 indeksowanych podokien. 15 konsument +42 driver testów PASS. Oryginalny result nie nadpisany; pełna rewalidacja i hashe w `fgmres-km25-restart8-v2/posthoc-validation-v1.json`, status completed_unqualified. Korekta z domkniętym review zapisana w commicie d8d1101b70cc11c1d29e714fbe292207f664cd7d.
- Kampania signed15-fgmres-adaptive-v1 terminalnie failed/exit1 na replay stanu równowagi: equilibrium_h_eff0_comparison_failed, różnica7.958e4A/m. Bootstrapped -25 completed, ale kampania nie ma zaakceptowanego15-punktowego produktu. Hipoteza potwierdzona w danych: h_eff0 certyfikatu ma pole zewnętrzne we wszystkich6138 węzłach; source m0 jest zerowe w5742 węzłach airboxu. Referencyjny FemLlgProblem external field zeruje węzły niemagnetyczne; porównanie pełnej tablicy h_eff0 wymaga korekty zakresu fizycznego z zachowaniem progów i całodomenowego phi0. Naprawa source/runtime tej ścieżki pozostaje OPEN.
- Serial signed15-fgmres-serial-v1 ukończył7 ujemnych przypadków w logu, następnie długo liczyłΓ. W celu wykonania jawnego priorytetu użytkownika ±25 zatrzymano wyłącznie własny kontener po weryfikacji labels/mountów: return143, cleanup verified_absent, wszystkie dane zachowane. Nie jest to dowód rozbieżności ani zaakceptowana kampania. Pierwsza osobna próba +25 została odrzucona przed solverem przez storage lease; właściwa druga próba po jego zwolnieniu zakończyła się sukcesem.
- Generator frozen v2: typed MeshIR, pełne52pola identity, snapshot bytes, onerror i osobne source/modal MeshIR; review P1 PASS,16 testów interpretowanych PASS. Realny accepted bundle i serial/adaptive replay nadal OPEN. Prywatny adapter v2 jest implementowany w odrębnych plikach bez zmiany wykonywanej kampanii.
- Następne: poprawić fizyczny zakres replay h_eff0 i zweryfikować nowym managed runtime; doprowadzićΓ oraz15 punktów do terminalnego produktu → frozen-state serial/adaptive parity → sparowane GUI/OpenAPI/browser. Całe S00–S12, COMSOL A1, zbieżności siatki/airboxu/liczby modów, GPU, S09 i integracja PR97 OPEN. PETSc/SLEPc3.26 nie wdrożono; storage/cache nie usuwano.

- Priorytetowy +25: f=13.557589545332079GHz, full relative residual2.0705177355335623e-10, full_descriptor_certified=true dla modu, row/KSP/demag/potential/source-binding PASS. Run-result completed_unqualified, solver exit0. Razem cztery różne rzeczywiste wektory ±10/±25, bez sztucznego odbicia.
- Wykres z analityką: `de-priority-k25-validated-v3/de-dispersion-plus-minus25.png` i `.pdf`, osobny plot-receipt wiąże wszystkie wejścia i oba oracles. Model sprzężonych modów N32 przy±25 daje13.641746349GHz; FEM niżej o około0.61691%. Różnica między+25 i-25 wynosi959.0415Hz. To porównanie diagnostyczne, nie dowód zbieżności ani pełnej weryfikacji solvera.
<!-- /current-execution -->


## Checkpoint wykonania — 2026-10-03, 05:40 UTC

Ten wpis zastępuje wcześniejsze deklaracje bieżącego stanu #216. Pełny cel S00–S12 pozostaje otwarty.

- #216 zakończył się failed/exit 2: E0063, brak cpu_observations w FEM serial_bootstrap_only. Dodano pustą listę, bo ta gałąź nie uruchamia procesu potomnego. Parser i niezależne review PASS; nowa kompilacja nadal OPEN.
- Aktualny snapshot #219: 358349e2f1d74e6c9c4cb6af148d47b0, digest 8bdb22ee937e3c16bdebd080c0239296da03d8834cb42fea461ee5b709e34267, profil fem-cpu-slepc-runtime-v2, model commit 71ba0d18225ffcc83f7f18e676de8dc051e87fd1. Job queued; nie wystartowała symulacja.
- Współdzielony runner został wymieniony zewnętrznie: obecny kontener 7f20873de2b1e21335b7399afa8436ce6ed0e0503dcd69d2fa366917fa3bdef2, obraz sha256:1aa31b600114e35dac112821bfe0ee1317a00641077bf4ecee546e0747550665. Health: worker_alive=true, accepting_jobs=true, worker_error=null, brak aktywnych jobów, waiting_for_disk; wolne 8 080 265 216 B, wymagane co najmniej 8 589 934 592 B. Nie zmieniono konfiguracji ani FIFO.
- Obserwator #219 v2 zakończył się przy WinError 10061 podczas wymiany runnera. V3 ponawia wyłącznie odczyty po błędach transportu; nie ponawia błędów autoryzacji ani nie zgłasza/anuluje jobów. Cztery regresje PASS. Aktualny uchwyt obserwatora: 75831; renderer oczekujący na rzeczywisty wynik: 11268.
- Naprawiono model_source_commit (rzeczywisty klucz commit) oraz walidację orientation/sampling/k_vectors dla signed-fifteen. Kontrole interpretowane driver/probe/rows/model/plot/parity: 131 PASS +45 subtests; pomocnicza obsługa kontenera: 22 PASS +15 subtests. To dowody źródeł, nie wykonania solvera. Testów jednostkowych Rust/native/React nie kompilowano.
- Generator scripts/plot_signed_de_campaign.py zapisuje PNG/PDF/receipt dopiero po zaakceptowaniu 15 rzeczywistych wierszy; bez lustrzanego kopiowania FEM lub interpolacji. Jest przygotowany, ale nowy wykres nie powstał. Nadal dostępne są wyłącznie dwa wcześniejsze punkty ±10 rad/µm.

Następna sekwencja: zwolnienie miejsca przez operatora → terminalny sukces i atestacja #219 → jedna adaptacyjna kampania 15 punktów → rzeczywisty raport puli i artefakty solvera → wykres i kontrola renderu → parytet serial/adaptive oraz GUI. Zbieżności, COMSOL, GPU, S09/2.5D i integracja PR #97 pozostają OPEN. Nie usunięto żadnych danych; operator został poproszony o zwolnienie miejsca.


## Aktualny stan wykonania — 2026-10-03, nowe obrazy wdrożone, build #216 zgłoszony

Ten checkpoint zastępuje wcześniejsze deklaracje bieżącego stanu jobów i
liczby punktów; poniższe sekcje zachowują historię. Pełny zakres S00–S12
z planu nonzero-k pozostaje obowiązujący. Adaptacyjne wykonanie jest
rozszerzeniem S05/S08, nie zamiennikiem fizyki ani kwalifikacji całego celu.

| Bramka | Dowód bieżący | Stan |
|---|---|---|
| DE +10 rad/µm | 11.205285324405772 GHz; pełny residual 2.277784989202247e-10 | Punkt zaakceptowany technicznie |
| DE −10 rad/µm | 11.205285254344654 GHz; pełny residual 2.4809101991678807e-10 | Punkt zaakceptowany technicznie |
| Integralność obu punktów | Ponownie sprawdzono 12 hashy plików run-request/result, metadata, dispersion, spectrum i mode względem raportu wykresu | PASS dla dokładnych bajtów |
| Odniesienie analityczne | Uniform n0: 11.235414178890272 GHz; różnica około −0.26816% | Porównanie dostępne; brak dowodu zbieżności |
| Wykres | de-priority-k10-validated-v2.png/.pdf, dwa rzeczywiste punkty | Dostępny; qualification NOT VERIFIED |
| Signed15 | ±2 nie przeszły shifted GMRES; 13 dodatkowych punktów nieukończone | OPEN; bez tworzenia punktów przez symetrię |
| Reader #208 | Import kopii rzeczywistego FMS i spectrum +10; WebGL działa, topology nie przyjęte wskutek deadline | Częściowy browser proof; S08 OPEN |
| PreviewState / viewport | Poprawki źródeł importu i lokalnego topology deadline 15 s | Managed frontend i browser po poprawce OPEN |
| Adaptive CPU/RAM | Polityka Python/IR/API/UI, Linux sampler, osobne procesy, live peak, pełny budżet puli, CPU coverage i zgodność request/pool; 107 interpretowanych kontroli próby/drivera/wierszy PASS; wcześniejsze produkcyjne TypeScript/React Doctor PASS | Runtime, OpenAPI i zgodność serial/adaptive OPEN |
| Telemetria puli na żywo | Próbka regulatora → istniejący zasób etapów Study → Inspector; active/admission/limit są rozdzielone | Źródła i review PASS; #213 nie zawiera późniejszych poprawek; nowy snapshot i runtime/UI OPEN |
| Diagnostyka awarii ±2 | Zapis konfiguracji KSP przed EPSSolve; review źródłowe PASS, przygotowana regresja natywna | Native build/runtime OPEN; poza kapsułą #211 |
| SLEPc #209 | Terminal failed, exit 2; osiem błędów Rust, cztery przyczyny poprawione i reviewed | Nie jest dopuszczonym runtime |
| SLEPc #211 | c554c5361f014228a301380b8ed3487c, terminal failed, exit 2; native-build exit 0; runtime fem-availability timeout 120 s | Kompilacja PASS; runtime/receipt niezaliczone; nie uruchomiono prób solvera |
| SLEPc #213 | 9e4d278669bc4d92a8895294b7e19db6, cancelled, exit143; własna starsza kapsuła; journal terminalny, wszystkie dane zachowane | Nie jest dopuszczonym runtime; nowa kapsuła wymagana |
| CPU dependency closure | 67 kontroli źródłowych PASS; obraz CPU 7139ca26… zbudowany exit0, SLEPc i MFEM 4.10 zainstalowane; sparowany koordynator 9923f33b… wdrożony; FIFO wznowione | Budowa obrazu PASS; atestacja ELF, build #216 i runtime OPEN |
| Tożsamość API/UI | Wymagane session_id/session_epoch/run_id (nullable) w schemacie; źródłowe scope guards | Rzeczywisty eksport OpenAPI/client i browser OPEN |
| S09 nodalne Ms | Dokładne momenty P1 w bounded assemblerze, 9 interpretowanych kontroli; commit 1cee2db614fcd920dbc0cfd4293df9dd3098c70d | Source-only; native regression nieskompilowana; produkcyjny MFEM/TetraX/3D OPEN |
| Pełna nauka i integracja | Γ/signed DE/BV, COMSOL A1, zbieżności, pełne pola/tracking, falowód, interakcje, GPU i integration cycle | S00–S12 nadal OPEN |

Źródła ±10: job #203 d30406a2ef6d42cb9120ce04d58d646a,
profil fem-cpu-slepc-runtime-v2, model 6cf0b786dc688e6a6993f7273df96dcb50727b1b.
Dane są w kanonicznym storage pod scientific-batches/nonzero-k-validation/
d30406a2ef6d42cb9120ce04d58d646a; raport de-priority-k10-validated-v2-report.json
zachowuje ścieżki oraz hashe wszystkich wejść i wyników. Odczyt kontrolny
priority-k10-evidence-refresh.json jest w katalogu wizualizacji tego wątku.
Wynik integrity refresh nie jest ponownym wykonaniem solvera ani pełną nauką.

Terminalny #211 zachowano z failed receiptem i logami. Rzeczywisty proces
fem-availability był aktywny przed timeoutem (około 105% CPU, 50 MiB RSS).
Nie jest to zanik obserwacji ani dowód dostępności CPU/SLEPc. Timeout 120 s
zakończył sam executor. Brakuje partial stdout/stderr tej sondy, gdyż obecny
trusted helper gubi je w obsłudze TimeoutExpired; poprawka diagnostyczna
jest w lokalnym commicie 4bb7c3736808ca7e194782292cc9beda99e0356f
(42 interpretowane regresje PASS), obecnie zawarta we wdrożonym koordynatorze 9923f33b…; zachowanie timeoutu wymaga nowego runtime proof.
#213 anulowano po zakończeniu #212, aby nie budować nieaktualnej kapsuły na
starym obrazie. Aktualizacja obrazów zakończyła się i FIFO wznowiono.
Aktualny snapshot przyjęto jako #216. Próby serial/adaptive nie
wystartują na failed #211 ani cancelled #213; użyją nowego zweryfikowanego
builda runtime-v2 i jawnego digestu tej samej kapsuły.

Build #211 jest niezmiennym snapshotem
b85acbd0d354acf7f554f72e8697c06c1508de8ff9d51fcbd8831aa38aad452c,
native identity 501308a35be5cfd1fafbbb83831f48efbef988ddd0d5dadf5ec33e0f18cd30ca.
Nie uruchomiono obejścia FIFO ani symulacji na nieudanym #209. Następnie:
terminalny receipt/ABI → próba serial/adaptive z identycznym certyfikatem,
siatką, k i tolerancjami → rzeczywisty OpenAPI/client → produkcyjny frontend
oraz import oryginalnego FMS i pełny browser proof. Błąd ±2 wymaga osobnej
diagnozy GMRES, bez osłabienia fizycznego residualu 1e-8.

Diagnoza ±2: [korekta hipotezy GMRES](../../audits/2026-10-02-signed-k2-gmres-restart-diagnostic.md).
Źródło i zaakceptowane artefakty dowodzą PC_RIGHT/unpreconditioned; ponowne
przełączenie side nie jest uzasadnioną poprawką.

Szczegóły regulatora i osobne bramki:
[plan adaptacyjnego wykonania](2026-10-02-adaptive-dispersion-execution.md).
Zakaz kompilowania unit tests zachowany; nie wykonano końcowego merge ani
cleanup worktree, gdyż wymagane bramki całego zadania pozostają otwarte.

## S06/S12 — kontrola roundoff normy modalnej, 2026-10-03

Lokalny commit `81cb6bcb475112aa1abe8bcc9e5e9128e5486351` domyka źródłowy P2 pozostały po wspólnej skali q/potencjału: istotnie zespolona norma nie jest już akceptowana wyłącznie dzięki dodatniej części rzeczywistej. Nowy evaluator przechodzi przez rzeczywiste wkłady dense/sparse, zachowuje powtórzenia sparse i liczy obwiednię outward next_down/next_up. Wymaga dodatniej dolnej granicy real oraz objęcia zera przez imaginary. To roundoff-compatible kontrola konkretnej normy, bez dowodu globalnej Hermitowskości/PD ani dokładności assembly.

Chronione są finite dane, overflow, wymiary i indeksy oraz gradual underflow (FTZ/DAZ odrzucane). Skala pochodzi z jawnej bezpośredniej sumy wkładów; legacy obserwacje grupujące wiersze pozostają odrębne. Nie zmieniono operatora, demaga, residualu 1e-8, jednostek ani wire API/IR. Sparse nie tworzy macierzy dense. Normy małe dodatnie nie są zastępowane floorem.

Weryfikacja: independent source review bez P1/P2; parser Rust PASS; exact Fraction oracle 9 PASS; source-map working/index PASS; changed-page validator dla dokładnego commita PASS. Przygotowano cztery regresje Rust (meaningful imaginary, subnormal, niepewna dodatniość wskutek cancellation, rectangular metric z atomową ochroną wejścia), bez ich kompilacji. Native/JSON consumer execution i pomiar wydajności pozostają OPEN. Commit lokalny; bez push/merge.

Dowód: modal-norm-interval-checkpoint-20261003.json, wiąże SHA256 dziewięciu plików dokładnego commita. Odczyt runnera: worker_alive=true, worker_error=null, #212 running, 15 786 156 032 B wolnych. Nowy obraz CPU dependency closure nadal nie wdrożony; nowe punkty signed15, serial/adaptive parity, OpenAPI/browser i pozostałe S00–S12 nie są ukończone.

## S05/S08 — review adaptacyjnych zasobów, 2026-10-03

Domknięto źródłowe korekty regulatora: live peak aktywnych workerów trafia do admission przed zakończeniem, dodatni krótki pomiar nie zastępuje pełnego resolved-team envelope, a cała polityka requestu musi odpowiadać parent pool przed side effects. Raport cpu_observations zapisuje pokrycie czasowe, źródło kosztu oraz zespół każdego zakończonego punktu. Re-review: bez P1/P2 w ocenianym przyroście; hipotetyczny finding null wycofano po sprawdzeniu typed producer. Regresje Rust przygotowane, parser trzech plików PASS, bez kompilacji unit tests. Kontrole driver/DSL 68 PASS oraz wcześniejszy produkcyjny TypeScript dla niezmienionych plików UI pozostają aktualne.

Runner ma 17 599 401 984 B wolnych i zdrowego workera. #212 jest potwierdzonym aktywnym kontenerem 2115dff64051 (Up 14 min; ok. 816% CPU, 806 MiB RAM), więc nie wymieniono wspólnego obrazu podczas obcego buildu. Poprzedni blocker storage ustąpił. Wdrożenie CPU dependency closure, nowa kapsuła bieżącego kodu, eksport OpenAPI/client, serial/adaptive parity i browser proof pozostają OPEN. Nie wykonano nowych punktów dyspersji ani nie zmieniono statusu naukowego S00–S12.

Dowód: adaptive-resource-review-20261003.json w katalogu wizualizacji wątku. Pełne reguły i dowody w [planie adaptacyjnego wykonania](2026-10-02-adaptive-dispersion-execution.md).

## Priorytet DE ±10 — naprawa kompilacji i ponowienie, 2026-10-02

Build #196 zakończył się błędem kompilacji: `requested_linear_iterations`
było zadeklarowane tylko w bloku tworzenia stanu Poissona, lecz użyte także
poza nim przy konfiguracji shifted KSP. Commit
`bb2a5f52916a828824592f32e2240be9c2e633e4` przenosi tę samą politykę
iteracji do wspólnego zakresu; nie zmienia tolerancji ani fizyki.
Commit jest na remote. Interpretowane kontrole reuse i Schur PASS;
kontrola różnicowa odrzuca zakres starego źródła i akceptuje poprawkę.

Nowy managed build #198: `d1ff1c5936494d83aea7ece3bff549a8`,
profil `fem-cpu-slepc-runtime-v2`, dokładny commit poprawki, source digest
`c586ff0959211467749073a5ae12431c08f6a0a85097c509a149dbf92d1f118b`.
Przy zgłoszeniu oczekuje za aktywnym zadaniem #197 innego checkoutu.
Nie przerwano jego pracy ani nie uruchomiono builda poza kolejką.

Osobny observer w `scientific-batches/nonzero-k-validation/<job-id>`
po zweryfikowanym sukcesie buildu uruchomi rzeczywiste DE +10 i −10 rad/µm,
kolejno, L2 / 3 warstwy, demag włączony, nearest ze shiftem 11 GHz.
Model pozostaje przypięty do `71ec3f159b47ee7a56e471020923248c2cac283f`.
Shift nie jest wynikiem. Drugi observer waliduje receipty i fizyczne residuale
przed aktualizacją wykresu. Nieudany pilot zatrzymuje serię do diagnozy.
Na tym checkpointcie start solvera i nowe punkty są **NOT VERIFIED**;
kolejka i działający observer nie dowodzą wykonania symulacji.

## S06/S12 — eksport rzeczywistych kandydatów, 2026-10-02

Poprzedni fragment 3245183e841c365dce8cd4171ecaa6ef1c66199a jest na remote.
Naprawiono źródłowy P1 eksportu ALL_FIELDS: jawne SaveMode/all_modes=True
przechodzi przez study.save, IR, validator IR, planner, selektor wyjść,
native single-k i publikację ścieżki. True wyklucza indices/branches,
False/brak pola zachowuje dotychczasowy kontrakt. Round-trip skryptu
zachowuje flagę i selektory próbek.

Wewnętrzny eksport trackingu też używa wszystkich zwróconych modów.
Single-k zapisuje rzeczywiste zwrócone sloty; ścieżka odczytuje natywne
raw IDs z walidowanego widma przed zatrzymaniem artefaktów. Lista
kandydatów nie jest już filtrowana przez raw_id < requested_count.
Nie renumerujemy modów ani nie utożsamiamy tego pokrycia z kompletnością
widma. Nadmiar ponad zakres identyfikatora powoduje błąd zamiast pominięcia.

Review wykrył pominięty odbiornik planner/validate.rs; poprawiono jego
wyczerpujący wzorzec, empty selector, konflikt i duplicate-all validation.
CLI zachowuje all_modes z pustymi indeksami, nie usuwa też konfliktowych
indeksów przed walidacją tego wariantu. Historyczne helpery
eigen_path_public_mode_indices/eigen_path_mode_artifact_indices mają
wyłącznie testowe wywołania i opisują dawną numerację slotów; bieżąca
publikacja używa select_eigen_outputs i rzeczywistych raw IDs.

Dowody: 40 Python/IR/benchmark tests PASS, w tym pełny canonical script
round-trip opt-in; 4 cross-consumer sourcechecks PASS; parser rustfmt
17 zmienionych plików Rust PASS; focused source-map PASS. Rust regressions
IR/planner/output_selection/path przygotowane, lecz NIE skompilowane
zgodnie z zakazem. Parser i testy Python nie dowodzą typecheck ani runtime.

Po korekcie wszystkich odbiorników pełniejszy zakres Python/IR/benchmark
i script-builder: 75 tests + 28 subtests PASS (2,58 s). Niezależny read-only
review nie znalazł pozostałego P1/P2 w tym fragmencie. Nie wykonano native
compile ani obliczeń; nie zwiększamy na tej podstawie statusu naukowego.

P1 producenta zamknięty na poziomie źródeł; pełna kampania wymaga nowego
managed buildu i rzeczywistych pól. Kapsuła #196 jest starsza i pozostaje
niezmieniona. S06/S12, punkty DE/BV, COMSOL A1, kompletność i zbieżność,
S08 browser, S09/GPU i końcowa integracja pozostają otwarte.

## S06/S12 — certyfikat tabeli i początkowe wiązanie wszystkich pól, 2026-10-02

Po bazie 62320ee8f2fd9fbe1562ff0d84c7fadf8ddc1e0a porównanie obejmuje
całą tabelę z niezależną predykcją: pokrycie raw IDs, przejścia i grupy,
score Hungarian oraz transportowane ramy. Równoważne optimum pojedynczych
par jest dopuszczane; greedy wymaga zgodnej deterministycznej pary.
Oddzielny assignment_replay może mieć pass dopiero po wszystkich krokach.
Gate dodatkowo sprawdza ich liczbę i kolejność. Nie jest to kwalifikacja
rzeczywistego runtime ani ukończenie S06/S12.

Poprawiono lukę początkowego snapshotu: poza control JSON wiąże on teraz
nagłówek i vector.bin każdego kandydata widma, także nieprzypisanego do
wybranych gałęzi. Brak pliku podczas snapshotu nie pozwala zaakceptować
późniejszych bajtów. replayed_branch_scope jawnie wynosi all_candidates.

Pozostałe korekty wskazane przez review i odczyt producenta:
- Certyfikat nie obsługuje jeszcze narodzin, zaników i luk gałęzi.
- Równoważny wybór alternatywnego zestawu grup przy remisie klastrów
  pozostaje odrzucany; wymaga odrębnej obsługi i regresji.
- FULLMAG_COMSOL_DISPERSION_ALL_FIELDS=1 używa range(requested_mode_count)
  jako raw IDs. To nie zapewnia eksportu wszystkich modów, gdy solver
  zwraca nieciągłe identyfikatory, np. 64. Należy poprawić selektor producenta
  i jego konsumentów przed uznaniem pełnej kampanii za uruchamialną.

#196 ponownie odczytany: queued, exit_code=null. Runner worker_alive=true,
accepting_jobs=true, active_jobs=[], waiting_for_disk. Odczyt wolnego miejsca:
623 894 528 B, poniżej 8 GiB. Nie restartowano ani nie zlecono duplikatu.
Nowych punktów solvera i numerycznego wykresu nie uzyskano.

Dowody bieżącego fragmentu: 73 interpretowane testy trackingu PASS,
54 testy bramki naukowej PASS (145,678 s), focused source-map PASS
i git diff --check PASS. Regresje obejmują gorsze globalne dopasowanie
przy prawdziwych lokalnych score, równoważne optimum, dwie gałęzie przy
wybraniu jednej do porównania, nieciągłe raw IDs w snapshotcie i zmianę
semantycznie identycznego nagłówka po początkowym odczycie. Wszystkie
pola są syntetyczne; test agregacji kwalifikacji korzysta z mocka komponentu
replay i nie stanowi dowodu kwalifikacji rzeczywistej kampanii.

Po review gate wymaga jawnie all_candidates, complete_continuous oraz
pokrycia pól o liczbie równej liczbie kandydatów widma. Trzy testy konsumenta
gate PASS (24,169 s), w tym cztery defekty zakresu/lifecycle/coverage/count.
73 testy trackingu i focused source-map ponownie PASS po tej korekcie;
35 testów kontraktu dokumentacji PASS. Pełny zestaw 54 testów gate był
zielony przed dodaniem tej ostatniej regresji; nie nazywamy go 55 PASS.

## S06/S12 — obliczanie globalnej polityki z pól, 2026-10-02

Checkpoint historyczny — stan przed certyfikatem tabeli opisanym powyżej.

Po `0e3869a077742ac1cb0ad5719df3390be517515c` niezależny helper oblicza
transport i score wszystkich legalnych grup, stosuje principal-angle floor,
odtwarza wybór najlepszego kandydata dla każdej pary klastrów, Hungarian
klastrów i usunięcie nakładających się grup. Dla pozostałych gałęzi oblicza
wszystkie eligible pair edges z poprzednich ram, a następnie zapisany
overlap_greedy lub overlap_hungarian z dummy/ineligible kosztami.
Przewidywane next_frames zachowują kolejność poprzednich gałęzi.

Mechanizm jest wykonywany przez replay na hash-bound polach każdej
sąsiedniej próbki. Raport global_policy_predictions zawiera przewidywane
raw IDs, score i grupy. Brak ramy/pola daje brak predykcji, bez fallbacku.
To jeszcze nie certyfikat zgodności zapisanej tabeli z predykcjami;
assignment_replay nadal NOT VERIFIED. Następny etap: porównać całą tabelę,
obsłużyć równoważne optima i zweryfikować kolejne ramy po każdym przydziale.
Wariant wyboru klastrów odtwarza bieżącą heurystykę producenta; nie jest
globalnym optimum problemu grup z dodatkowym ograniczeniem rozłączności.

67 interpretowanych testów trackingu PASS: pełne pole/policy fixtures,
różnica greedy/Hungarian, dummy bez wymuszenia niedozwolonej pary,
principal-angle floor i transportowane ramy. Dodano też automatyczną
kontrolę zgodności trzech prywatnych progów Python/Rust wskazaną w review.
Dotychczasowy P2 dodatniej częstotliwości był już naprawiony w6c5b9f10c.
Nowe pola testowe są syntetyczne; runtime/COMSOL/nauka pozostają otwarte.

## S06/S12 — odtworzenie legalnych grup częstotliwości, 2026-10-02

Checkpoint historyczny — globalna predykcja i certyfikat zostały dodane później.

Po `6c5b9f10c7a95d267b6d6491ad4d179cd1da942b` replay odtwarza legalne
kandydaty z całego widma sąsiednich próbek: grupowanie względem kotwicy,
odległość zespolona, bieżące addytywne tolerancje producenta oraz grupy
split→degenerate i degenerate→split z odrzuceniem remisu na granicy wyboru.
Indeksy klastrów, typ przejścia i zbiory uczestników zapisanej podprzestrzeni
muszą odpowiadać takiemu kandydatowi. Nie jest to jeszcze wybór globalnego
optimum spośród kandydatów; assignment_replay nadal NOT VERIFIED.

Naprawiono dwa rzeczywiste RED: sfałszowany indeks klastra i przejście
split dla grupy zdegenerowanej wcześniej przechodziły replay metryk.
Teraz są odrzucane. 60 interpretowanych testów trackingu PASS; nowe testy
obejmują brak domknięcia przechodniego, urojoną część częstotliwości,
addytywny próg, oba kierunki split, okno i remisy. Dodatkowa regresja
chroni rzeczywisty tie-break: poprzednie branch IDs i bieżące mode slots,
a nie raw IDs. Wrapper zachowuje pełną mapę gałęzi przed filtrowaniem
wybranych gałęzi. Focused source-map PASS. Pola są syntetyczne.

Następny etap pozostaje bez zmian: policzyć metryki wszystkich legalnych
kandydatów z poprzednich transportowanych ram, odtworzyć wybór klastrów
i globalny pair assignment oraz zintegrować oddzielną bramkę. Runtime,
COMSOL, zbieżność, GPU, browser proof i końcowa integracja nadal otwarte.

## S06/S12 — pola wszystkich eksportowanych kandydatów, 2026-10-02

Checkpoint `4abbc363a776c35ac9d823a7655a960d878a4bd3` jest na remote;
pełne 50 testów gate PASS (67,856 s). Niezależny read-only review nie
znalazł P1. Wskazany P2 dodatniej częstotliwości nieprzypisanych kandydatów
naprawiono: standalone replay wymaga real frequency > 0 tak samo jak
główny gate. Spójne zero/ujemne wartości w widmie i metadanych są odrzucane;
50 testów trackingu PASS. Eksport wszystkich pól zwiększa liczbę plików
z 6×8 do 61×24 dla pełnej ścieżki; jego koszt runtime pozostaje do pomiaru.

Po checkpointcie `f2d0d7219798c1b526aca5ae7f675ef09ef3086f` odczyt
trackingu obejmuje każdy raw mode zapisany w widmie, także nieprzypisany
do wybranych gałęzi. Wszystkie pola przechodzą istniejący certyfikat fazy,
mesh/support/metryki oraz wiązanie podpisanego k i zespolonej częstotliwości.
Raport zawiera liczbę eksportowanych kandydatów i ich hashe. Brak pola
kandydata daje missing; niespójna częstotliwość lub duplicate ID daje fail.
Pokrycie eksportu nie dowodzi kompletności widma solvera ani globalnego
optimum przypisania; te bramki nadal NOT VERIFIED.

Znaleziono też konkretny brak orkiestracji: domyślne mode_field_selection
ogranicza próbki, a polecenie kampanii nie aktywowało istniejącego opt-in.
Każdy case COMSOL benchmarku ustawia teraz jawnie
FULLMAG_COMSOL_DISPERSION_ALL_FIELDS=1. Zwiększa to wolumen eksportu;
nie zmienia parametrów fizycznych, solvera ani istniejącej kapsuły #196.

Dowody: dwa rzeczywiste RED przed poprawką (pominięty kandydat bez pola
oraz brak flagi w komendzie), następnie 49 testów trackingu i 19 testów
orkiestracji PASS, 2 regresje agregacji gate PASS, focused source-map PASS.
Pola testów są syntetyczne; nowych numerycznych punktów FEM nadal brak.
Następny krok: odtworzyć wybór klastrów i globalną politykę przydziału
z tego hash-bound zbioru kandydatów.

#196 został ponownie odczytany: state=queued, exit_code=null; nie restartowano
ani nie zlecono duplikatu. Ostatni pomiar runnera 710 070 272 B pozostaje
poniżej progu 8 GiB. Pełna realizacja S00–S12 i integracja są nadal otwarte.

## S06/S12 — optimum raw assignment wewnątrz grupy, 2026-10-02

Domknięto lokalną część P2 z checkpointu
`fe28cb31d6ca9edc0158d73488861bf4845a1ae8`: replay sprawdza zapisane raw IDs
względem optimum modułów rotacji Procrustesa. Niezależny Hungarian zwraca
optymalne kolumny i sumę wag; raport zawiera raw IDs, średnie wagi oraz
informację o równoważnym optimum. Gorsza jednoznaczna permutacja jest błędem.
Przy remisach nie wymagamy identycznego tie-breaku SVD/Hungarian.

Regresja RED: przed zmianą celowa zamiana raw IDs w grupie z unikalnym
optimum nie powodowała błędu. Po zmianie jest GREEN. 45 testów trackingu
PASS, w tym 80 małych kwadratowych/prostokątnych macierzy porównanych
z niezależną enumeracją, duże znane optimum, bardzo małe wagi oraz
zespolona rotacja 3×3 z niesymetrycznymi modułami wykrywająca transpozycję.
2 regresje agregacji gate PASS, mapa noty 0831 PASS. Scoped review nie
znalazł blokera algebry; wskazane P2 testu orientacji i statusów poprawiono.

To nadal tylko przypisanie wewnątrz już wybranej grupy. Wybór grup,
pełny zbiór kandydatów i globalne pair assignment pozostają do odtworzenia.
`subspace_raw_assignment_replay` może mieć pass, ale pełne
`tracking_assignment_replay` nadal blokuje QUALIFIED C1/A1. Wszystkie
fixture'y są syntetyczne; nowych punktów FEM i kwalifikacji runtime brak.
Kolejny krok: replay wyboru kandydatów/grup i globalnej polityki przydziału,
z wymaganiem rzeczywistych pól wszystkich uczestniczących kandydatów.

Runner nadal waiting_for_disk; 720 535 552 B wolnego, brak active_jobs,
worker_alive=true, accepting_jobs=true. Session 7375 nadal aktywny.
Nie restartowano procesu i nie usunięto danych.

## S06/S12 — wykonywany replay metryk całej ścieżki, 2026-10-02

`replay_tracking_fields` czyta rzeczywiste widmo, gałęzie i wszystkie pola
wybranych gałęzi wraz z zależnościami grup. Kontroluje SHA tych samych
metadanych/widma/gałęzi co bramka główna. `replay_recorded_frames` wiąże
sample/raw ID, signed k i częstotliwość zespoloną; odtwarza kolejne ramy,
overlapy, principal cosines i score. Grupa korzysta wyłącznie z ramek
poprzedniej próbki. Brak pól jest `missing`, niespójne/zmienione dane `fail`.
Główna bramka C1/A1 wykonuje ten kod; nie przyjmuje gotowego werdyktu JSON.

Kontrole: 36 testów trackingu PASS, 50 testów scientific gate PASS,
2 skupione kontrole agregacji na końcowym wariancie hash binding PASS,
mapa noty 0831 PASS. Źródła/testy są interpretowane; pola testowe syntetyczne,
bez nowych częstotliwości FEM. Scoped review nie znalazł P1 w metryce,
endpointach ani transporcie. Dodatnią częstotliwość wymuszono też w helperze.

P2 tego checkpointu obejmował Hungarian assignment wewnątrz podprzestrzeni
oraz wybór grup i globalny przydział pair edges. Część lokalna została
naprawiona w przyroście opisanym powyżej; globalna nadal pozostaje otwarta.
Test symetrycznego remisu zachowuje równoważne optima. Osobna bramka
`tracking_assignment_replay` pozostaje `missing`; nawet metric `pass`
nie może zakwalifikować C1/A1. Następny etap musi odtworzyć przydziały
z rzeczywistych kandydatów i dodać kontrolę niewłaściwej permutacji.
Pełny zakres S00–S12, runtime, COMSOL i zbieżności nadal pozostają otwarte.

Aktualny runner: #196 queued, session 7375 potwierdzony aktywny,
worker_alive=true, accepting_jobs=true, active_jobs=[], waiting_for_disk,
storage_free_bytes=729 821 184 B, poniżej 8 GiB. Nie restartowano joba,
nie usunięto danych; nowych punktów FEM: 0.

Szczegóły: [audyt replayu metryk](../../audits/2026-10-02-tracking-field-metric-replay.md).

## S06/S12 — odczyt pól i transport ram replay, 2026-10-02

Dodano `load_tracking_fields`: wykonuje rzeczywisty certyfikat fazy,
ponownie sprawdza bajty i SHA-256, wyznacza fingerprint v3 siatki oraz
sprawdza rekord masy względem jawnej partycji, supportu, kompaktowego
connectivity i objętości. Odrzuca zmienione bajty, spójnie sfałszowany
deklarowany digest, brak supportu/metryki i jednoczesną masę diagonalną.
Dodano niezależny transport Procrustesa; test pokazuje, że overlap z
przetransportowaną ramą wynosi 1, gdy raw-to-raw daje 1/sqrt(2).

Kontrole: 24 testy trackingu PASS (11 algebra, 6 odczyt, 7 istniejące
provenance), 16 istniejących certyfikatu fazy PASS. Wszystkie nowe pola
to syntetyczne fixture'y. Nie wykonano solvera ani testów natywnych.
Odczyt nie jest jeszcze podłączony do bramki C1/A1; pozostaje NOT VERIFIED.
Następny etap: wiązanie endpointów z widmem, odtworzenie wszystkich ramek
w kolejności ścieżki, porównanie overlap/score/principal angles oraz
weryfikacja przydziałów. Brakujące gate nie mogą przyjąć statusu pass
tylko na podstawie poprawnego odczytu pól.

Kontrola runtime tego etapu: sterownik session 7375 nadal aktywny;
runner worker_alive=true, accepting_jobs=true, active_jobs=[],
waiting_for_disk, storage_free_bytes=156 786 688 B. #196 nadal oczekuje;
nie utworzono nowego joba ani nowego punktu FEM, nie usunięto danych.

## S06/S12 — niezależna algebra replay, 2026-10-02

Dodano `scripts/comsol_tracking_metric.py`: lokalna forma masy Tet4 zamiast
embeddingu producenta, demodulacja signed Blocha, amplitudowy overlap oraz
kąty główne podprzestrzeni. 9 interpretowanych testów analitycznych PASS;
mapa noty 0831 PASS. To pomocnicza algebra, nie replay artefaktów ani
wynik FEM. Nie zmienia statusu bramki C1/A1: nadal NOT VERIFIED.

Inspekcja `mass_weighted_subspace_transport` wykazała, że po degeneracji
kolejna krawędź używa przetransportowanej ramy. Następne kroki: odczyt
hash-bound pól i siatki, niezależne sprawdzenie metryki/supportu, odtworzenie
ramek Procrustesa i porównanie zapisanych krawędzi/score. Nie zastępować
ramy poprzednim surowym modem. Testy syntetyczne nie dowodzą fizycznego
crossing/split/merge ani zbieżności kroku k.

Aktualna kontrola #196: queued; sterownik session 7375 żyje;
worker_alive=true, accepting_jobs=true, active_jobs=[], waiting_for_disk.
Wolne storage: 163 201 024 B, poniżej 8 GiB. Nie restartowano joba,
nie zmieniono runnera i nie usunięto danych. Nowe punkty FEM: 0.

## S06/S12 — provenance wymagane w bramce COMSOL, 2026-10-02

Bieżące źródła po checkpointcie `9d036af61c49cca7b3a5b0519405d85691d3b91a`
ujawniły lukę: `_validate_branches` akceptował kompletną tabelę częstotliwości
bez zapisanych krawędzi trackingu. Wykonana regresja na tym SHA była RED
(`pass` zamiast `fail`). Nowy kod wymaga dla C1/A1 kompletnego provenance,
spójnej masy P1, rzeczywistych sąsiadów ścieżki i zgodnych par/podprzestrzeni;
odrzuca frequency fallback, metrykę diagonalną/Euclidean i gaps/restarts.
Wykorzystuje istniejący niezależny walidator polityki oraz kątów głównych.
Historyczne tabele pozostają czytelne, ale nie przechodzą tej bramki.

Kontrole: 7 nowych Python PASS, 49 istniejących testów gate PASS (63,53 s),
mapa źródeł 0831 PASS. Fixture'y zawierają wyłącznie syntetyczne records;
ich sukces nie dowodzi ciągłości modów solvera. Raport zachowuje jawne
`field_metric_replay=NOT VERIFIED`. Replay pól, physical crossing/split/merge,
k-step convergence oraz runtime S06/S12 nadal są do wykonania.
Zmiana nie uruchamia obliczeń ani nie zamyka kwalifikacji COMSOL.

P1 review globalnego statusu naprawiono: kampania ma odrębny
`campaign_contract_status`; C1/A1 pozostają `not_qualified` i `NOT VERIFIED`
przez brak wykonywanego `tracking_field_metric_replay`. Agregator wymaga
również jawnej kwalifikacji naukowej. Pełny field-metric replay nie jest
zaimplementowany: kolejny etap musi odtworzyć hash-bound pola, spójną masę,
MAC, kąty główne i continuity, bez przyjmowania deklaracji autora JSON.

Szczegóły: [audyt bramki trackingu](../../audits/2026-10-02-comsol-tracking-record-gate.md).

## S07/S10 — rzeczywiste gamma w wynikach i oracle, 2026-10-02

Checkpoint źródłowy: `91473c678aeb8806aaaf423239ae80654dc1b4be`.
Follow-up review: domknięto guardy także w bezpośrednich producentach
single-k `execute_fem_eigen_inner` i `native_modal_artifacts`; nowa kontrola
routingu rozszerza suite gamma z 6 do 7 testów. Brak nowych punktów FEM.

Usunięto referencyjne gamma z ogólnych writerów widma, pól modów i oracle
Kittela. `PathSolveResult` przenosi obowiązkowy parametr z planu, także przez
adapter fizycznego sweepu pola. Publisher FEM waliduje gamma przed obliczeniem
i publikacją, sprawdza zgodność planu z wynikiem. Niedodatnie/nieskończone
gamma, overflow gamma0/mu0 oraz nieskończona częstotliwość Kittela są błędem;
nie mogą zostać zapisane jako null lub zastąpione wartością referencyjną.
Czytnik porównuje gamma modów ze stałymi wykonania.

Dowody: 213 testów istniejącego verifiera PASS (69,23 s), 6 nowych kontroli
źródeł/algebry/czytnika PASS; parser Rust i mapa źródeł noty 0831 PASS.
Kontrakty walidatora dokumentacji: 35 PASS (18,92 s).
Przygotowano natywne regresje wartości niereferencyjnej, dwóch modeli Kittela,
overflow i rozbieżności plan/wynik. Nie kompilowano ani nie wykonywano testów
Rust/C++; managed runtime i walidacja fizyki pozostają NOT VERIFIED.
Review wykrył dwa P2 (bezpośredni publisher FEM i overflow częstotliwości);
poprawki włączono do tego etapu.

Ta zmiana nie wyjaśnia historycznej różnicy DE około 2 MHz: tam gamma było
referencyjne. Nie powstał nowy punkt numeryczny ani nowy wykres FEM.
Pełny zakres S00–S12 pozostaje otwarty. Szczegóły:
[audyt gamma](../../audits/2026-10-02-modal-gamma-provenance.md).

Aktualny odczyt API: #196 nadal queued, worker_alive=true,
accepting_jobs=true, active_jobs=[], waiting_for_disk; storage 173 936 640 B
(około 166 MiB), poniżej 8 GiB. Sterownik session 7375 potwierdzony aktywny.
Nie restartowano ani nie powielono zadania; nie usuwano danych. Kapsuła #196
jest niezmienna i nie zawiera późniejszych zmian trackingu/gamma/2.5D.
Po zwolnieniu miejsca: kontrola receipt buildu i sześciu pilotów DE/BV,
następnie nowe obliczenia aktualnego checkpointu oraz signed ±25,
kompletność/zbieżność i porównanie z COMSOL zgodnie z całym planem.

## Aktualny stan — 2026-10-02, checkpoint nearest 71ec3f159

### Kolejka #196 — wspólny checkpoint poprawek

Commit `71ec3f159b47ee7a56e471020923248c2cac283f` jest na origin i zawiera
przyrost S05 oraz wcześniejsze poprawki raw64, referencję finite-airbox
i manifesty S07. Scoped review i kontrole źródeł zakończono przed commitem;
nie kompilowano testów jednostkowych. Zgłoszono jeden managed build
`fem-cpu-slepc-runtime-v2`, job #196 `febe368724ec4e76a1da88ad24878a9b`,
request key `eigensolve-nearest-71ec3f159b47-20261002`.
Source digest: `cb6b948883bd2c75eb1997c7a677b0da0a4a1a0335e6c00e695911f67cd68d18`.
Native source snapshot: `e4203626ed9a2a7ca4a82405831fc85c1a853af9a264dd45db623c00169ad32a`.
Capture: `3c82a3a38cfd46f78a4f75342ed7876b`; source mode `commit`, clean.

Status odczytany z API: `queued`. Runner jest zdrowy, przyjmuje zadania,
nie ma aktywnego joba, ale ostatni pomiar wolnego storage wynosi
4 952 559 616 B (około 4,61 GiB), poniżej progu startu 8 GiB.
Pytanie do operatora o zwolnienie miejsca jest nadal otwarte; nie usunięto
danych ani nie zlecono równoległego buildu.

Sterownik uruchomiono z nowej niezmiennej kapsuły, session `7375`;
pierwszy odczyt: `build_state=queued`. Konfiguracja jest w
`storage/runs/<worktree-id>/scientific-batches/nonzero-k-validation/febe368724ec4e76a1da88ad24878a9b/controller-config.json`.
Po sukcesie buildu i kontroli runtime uruchomi sześć rzeczywistych pilotów
DE/BV: k=0 oraz k=±2e6 rad/m, L2, trzy warstwy w grubości.
Nearest shifts 9/10 GHz służą wyszukiwaniu; nie zastępują częstotliwości
solvera. Pierwszy błąd zatrzyma serię do diagnozy. Brak nowych wyników,
kompletności widma i aktualizacji wykresu; pełny S00–S12 pozostaje otwarty.

### Referencja analityczna DE/BV — zakres signed ±25 rad/µm

Podczas oczekiwania #196 wygenerowano odrębny PNG/PDF/CSV oraz receipt w
`storage/runs/<worktree-id>/scientific-batches/analytic-finite-airbox-de-bv-20261002/`.
Parametry odczytano z jawnych stałych wersjonowanego
`examples/fem_de_smoke_numeric.py`; nie wykonano tego modelu ani solvera FEM.
Obie referencje pochodzą z `finite_dirichlet_thin_film_oracle.py`:
otwarty film i jednorodny n=0 ze skończonym airboxem Dirichleta.
Receipt zapisuje commit, hashe źródeł i artefaktów, parametry SI oraz
`numerical_fem_point_count=0`; 4002 wiersze są wyłącznie analityczne.
Sprawdzenie hashy, liczby wierszy, dodatnich skończonych częstotliwości
i symetrii ±k PASS; PNG obejrzano.

W Γ: open 9,309813711 GHz, finite 9,299249697 GHz.
Na próbkowanej siatce największa ujemna różnica DE wynosi około
−37,6984 MHz przy |k|=0,275 rad/µm; dla BV −10,5640 MHz w Γ.
To diagnostyka wpływu warunków brzegowych na analitykę, nie nowy wynik
Fullmaga ani rozwiązanie antydotu COMSOL A1. Nie zamyka zbieżności
airboxu, poprawności operatora, pełnego widma ani kwalifikacji dyspersji.
Sterownik #196 nadal potwierdzony żywy; job nadal `queued`.
Ostatni health: 4 107 767 808 B wolnego (około 3,83 GiB), poniżej progu.

### S09 — korekta miary przekroju przed typed routing

Audyt aktualnego bounded assemblera ujawnił błąd jednostkowy: całki
po trójkątnym przekroju 2D były drugi raz dzielone przez
`normalization_length_m`. W rezultacie pole trójkąta 1 m² raportowano
jako 0,5 przy metadanej długości 2 m; skalowane były również K, M,
sprzężenia magnetyczno-skalarne i długość brzegu. Brak produkcyjnego
konsumenta tego assemblera potwierdzono w bieżących źródłach.
Niezależny review potwierdził błąd i zalecił korektę przed integracją S09.

Nota 0831 dokumentuje tożsamość całki po przekroju z całką 3D podzieloną
przez rzeczywistą długość ekstrudowania. Assembler używa teraz fizycznej
miary 2D; dodatnia skończona długość pozostaje walidowaną i raportowaną
metadaną porównania. Przygotowano natywną regresję niezmienności wszystkich
sześciu bloków i geometrii dla różnych długości — nie kompilowano jej.
Interpreted check: baseline RED na dodatkowym dzieleniu, po poprawce
2 PASS; mapa naukowa 0831 PASS, 35 testów kontraktu dokumentacji PASS.
To kontrola źródeł i miar, nie native ani scientific qualification.

Przy walidacji mapy wykryto też ambiguity nowego przeciążenia S05.
Nowa funkcja z kontekstem otrzymała odrębną nazwę
`solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context`;
dotychczasowy dwuargumentowy entrypoint i jego zachowanie pozostają.
Header, implementacja i wywołanie production adaptera są zgodne;
regresja S05 PASS. Nazwę zapisano osobno w
`20c2fe6fd58a8504d6828871cd421de1d2b9f191`.
Zmiany powstały po kapsule #196: nie dotyczą jego
źródeł, nie zlecono drugiego buildu. Finalny niezależny re-review zakończono:
0 nowych P1/P2 dla tego przyrostu. Wszystkie trzy źródłowe regresje PASS,
cztery naukowe mapy źródeł PASS; wykonanie natywne nadal NOT VERIFIED.
Review potwierdziło poprawność miary i fixture; jego P1 sprzecznego
historycznego opisu został poprawiony przez jawne rozdzielenie dawnego
wyniku i nowej korekty. P2 mapowania właściciela S05 i prefiksowego
source check zamknięto przez dokładny symbol z kontekstem, wskazanie
wrappera `nullptr` oraz regresję jego pełnej delegacji. H6 (znaki mieszane,
k/−k) i B1 (wymuszenie fizycznego `−mu0` w przyszłym typed ownerze)
pozostają osobnymi bramkami przed produkcyjną integracją S09.
S09 nadal wymaga typed realization/routing, managed MFEM owner,
zewnętrznej domeny i jej zbieżności oraz porównania TetraX/3D.

### S09 — H6: znak względny źródła i kontrakt potencjału

Niezależne wyprowadzenie i review potwierdziły błąd bounded assemblera:
przy fazie exp(-ikz) dodatnia prawa strona słaba jest S_perp + ik S_z,
a kod łączył dodatni człon poprzeczny z ujemnym osiowym. Minus Schura
ani kontrola samej symetrii k/−k nie naprawiają tego błędu.

Wybrano kanoniczną konwencję descriptora P phi + A_phiq q = 0.
Oba człony A_phiq są teraz ujemną kopią fizycznego źródła słabego;
zmieniono znak członu poprzecznego, zachowując ujemny osiowy.
Header i nota 0831 rozróżniają prawą stronę od bloku descriptora,
co ustala również znak fizycznego potencjału przy rekonstrukcji.

Dodano niezależny oracle kwadratury ekstrudowanej dla mieszanego
zespolonego źródła P1, k=−3/0/+3 oraz trzech długości. Interpreted
regresja wykryła błąd przed korektą i przechodzi po korekcie; nie wykonuje
natywnego operatora. Natywna regresja kwadratury została przygotowana,
lecz nie jest kompilowana zgodnie z obowiązującym zakazem.
H6 jest naprawione źródłowo; runtime i integracja S09 nadal NOT VERIFIED.
Review potwierdził znak poprawki. Uzupełniono jego uwagi P2: oracle
uwzględnia x/y/z, fixture natywny używa obróconej ramy xy, a nota 0828
odróżnia równanie silne od źródła słabego i bloku descriptora.
Nowe otwarte P1: sprawdzić dense airbox bridge w
`poisson_airbox_shared_domain.cpp`: lokalne `floquet_a_phiq` jest negowane,
lecz `floquet_problem.tangent_source` może otrzymywać pierwotne dodatnie
źródło. Wymagana jest spójność obu odbiorników z rekonstrukcją potencjału,
regresja physical phi oraz ustalenie wpływu na dense/materialize route.
Nie zmieniono tej ścieżki w przyroście H6 ani nie przypisano jej błędu
pilotowi #196 bez sprawdzenia używanego routingu.
B1, typed routing, managed MFEM owner, zbieżność domeny zewnętrznej
i porównania 3D/TetraX pozostają otwarte. Nie zmieniono kapsuły #196
ani operatora 3D, więc nie jest to wyjaśnienie jego wyników.

Odczyt bieżący #196: queued; koordynator waiting_for_disk,
brak aktywnego joba. Wolne storage 2 788 474 880 B (około 2,60 GiB),
poniżej progu 8 GiB. Sterownik session 7375 potwierdzono nadal żywy.
Walidacja dokumentacji poprzedniego commita
6d31b787f8fbd774446c1e7a380d7418084f744f zakończyła się exit=0.

### Dense airbox — jawna konwencja prawej strony i descriptora

Weryfikacja konsumentów potwierdziła, że raw `tangent_source` w pełnych
blokach jest celowo dodatnią prawą stroną S: pełny residual sprawdza
P phi-S q oraz sprzężenie +mu0 S^H phi. Nie należy negować tego ownera.
Błąd dotyczył przekazania raw S do dense bridge, który traktował wejście
jako A_phiq i rekonstruował phi=-P^-1 A_phiq q. Sparse reduced owner
już wcześniej poprawnie tworzył odrębny A_phiq=-S.

Dodano wewnętrzny enum `FloquetAirboxTangentSourceConvention`:
descriptor_block zachowuje dotychczasowe algebraiczne fixtures;
weak_poisson_rhs wymusza jednorazową negację po projekcji źródła.
Shared-domain caller oraz fixture z raw MFEM blocks jawnie wybierają
weak_poisson_rhs. Nieznany wariant jest odrzucany. Raw źródło,
full-field residual i sparse adapter zachowują swoją fizyczną konwencję.
Sprawdzono wszystkie bezpośrednie wywołania bridge'a w backends/crates.

Interpreted regression: 3 testy PASS, w tym fizyczny potencjał zespolony
P_red=2, S_red=4+i i wykazanie, że sam Schur nie wykrywa błędnego znaku.
Przygotowana regresja MFEM porównuje raw RHS i jawny descriptor:
A_phiq, A_qphi, P, Schur, certyfikowany potencjał, brak mutacji ownera
oraz fail-closed nieznanego wariantu. Nie kompilowano jej.
Nota/mapa 0831 PASS. To naprawa źródłowa P1, native runtime pozostaje
NOT VERIFIED; nie kwalifikuje fizyki ani pełnej dyspersji.
Niezależny review bieżącego patcha: zaakceptowany, 0 P1/P2 dla zakresu;
potwierdzono raw owner, pełny residual, jednorazową konwersję,
wszystkich bezpośrednich callerów i fixture obu konwencji.
Regresja nearest Floquet dynamic-demag routing również PASS.

#196 zachowuje kapsułę 71ec3f159; nie zlecono drugiego buildu.
Sterownik 7375 nadal żywy. Health runnera: worker_alive/accepting_jobs true,
brak aktywnych jobów, waiting_for_disk. Najnowszy pomiar wolnego storage:
1 878 401 024 B (około 1,75 GiB), poniżej 8 GiB. Brak nowych punktów FEM.

### S06/S07 — zapis rzeczywistej krawędzi trackingu, 2026-10-02

Pierwszy checkpoint zapisano i wysłano jako
`4cee42f3f52fab5f3923ecddc87c6e64e9ad2e26`. Dalsze review wskazało P1
rozbieżnej semantyki policy custom/generic writer: naprawiono writer FEM,
aby pola pochodziły z recorded policy albo były null. Wzmocniono native
fixture o jawne sample/raw ID/signed k oraz oba aliasy i brak policy.
Dodano niezależny czytnik tracking_edge, sprawdzający policy, predecessor
sample/raw mode, gap, metric/source i principal-angle/rank/ID.
Kontrole końcowej wersji: 220 testów i 8 subtestów PASS (verifier + nowe
kontrole trackingu, 71,93 s),
parser Rust PASS. Native fixture nadal niekompilowane; brak nowych punktów FEM.
Końcowy health runnera: 70 860 800 B wolnego (~67,6 MiB),
worker_alive/accepting_jobs true, active_jobs puste, waiting_for_disk.
Niezależne końcowe review: brak P1; wskazane P2 domknięto przez kontrolę
zgodności aliasu w verifierze, wymaganie jawnego policy availability dla
obecnych rekordów i rozróżnienie restartu od braku wektorów w diagnostics.

Naprawiono w źródłach P1 utraty provenance przypisania: `TrackedBranchPoint`
przechowuje `TrackingEdgeProvenance` utworzone przy przyjęciu edge. Oba
writery przenoszą ten rekord, wraz z polityką, metryką, poprzednią próbką,
luką, rodzajem przejścia i danymi principal angles/rank/ID obu klastrów.
Ogólny writer publikuje metodę/próg wyłącznie z zgodnej zapisanej polityki;
brak lub mixed provenance ma jawny status. Alias legacy FEM dostał również
metodę/próg. Uszkodzony obecny rekord jest błędem importu.

Review ujawniło dodatkowo restart oznaczany jako seed: poprawiono go na
`new_branch` + `modal_overlap_unavailable`; summary nie promuje brakującej
ciągłości do weighted overlap. Zachowano skalarne bramki akceptacji.
Przygotowano native regresje signed [-K,0,+K], faz/reorder/split, restartu
oraz serializacji pary z luką. Nie kompilowano ani nie wykonano tych testów
zgodnie z zakazem użytkownika. Sześć interpretowanych kontroli źródeł i
niezależnej algebry consistent mass PASS; parser Rust PASS; mapa 0831 PASS.
Nie jest to dowód wykonania trackera w runtime. S06/S07 pozostają otwarte.

Job #196 potwierdzono przez klienta zachowanej kapsuły: queued; kontroler
7375 nadal działa. Runner worker_alive/accepting_jobs true, bez aktywnych
jobów, waiting_for_disk; najnowszy pomiar 643 960 832 B (~0,60 GiB).
Klient głównego checkoutu odrzucił odczyt z powodu allow-list mismatch;
odczyt zatwierdzonym klientem kapsuły działa, bez zmiany profili/restartu.
Nie usunięto danych, nie zlecono drugiego buildu i nie ma nowych punktów FEM.

Następny krok źródłowy: rzeczywiste gamma planu w ogólnych metadanych modów
(S07/S10). Po odblokowaniu storage: wynik #196 i pilot signed k, następnie
pełne okno, zbieżność, COMSOL A1, tracking runtime, UI/GPU i integracja S12.

### S06 — weryfikacja istniejącego podłączenia, 2026-10-02

Przegląd aktualnego kodu potwierdził, że starszy opis tabeli S06 był
nieaktualny: istnieją już consistent P1 embedding, kąty główne,
transport Procrustesa i podłączenie do path. Zaktualizowano tabelę;
nie oznaczono S06 jako ukończonego. Dowody źródłowe i konkretne brakujące
bramki opisuje [audyt S06](../../audits/2026-10-02-s06-tracking-source-state.md).
Niezależny przegląd integracji zakończono. Potwierdził podłączenie algorytmu,
ale ujawnił P1 utraty provenance krawędzi: principal cosines/rank/cluster
i transition/gap nie trafiają do TrackedBranchPoint ani do obu writerów.
Ogólny writer dodatkowo nie publikuje tracking_method/overlap_floor,
wymaganych przez produkcyjną bramkę k-path. Następny przyrost ma zapisać
typed edge provenance przy rzeczywistym przypisaniu i użyć tego samego
obiektu w obu writerach; bez rekonstruowania dowodu z samego confidence.
Potrzebna jest regresja [-K,0,+K] z reorder/fazą/degeneracją. Prywatna
heurystyka degeneracji wymaga jawnej polityki i walidacji; nie zmieniono
jej arbitralnie. Pozostają managed multi-k,
fizyczny crossing/split/merge, replay pól/metryki i kontrola kroku k.

Nowy potwierdzony punkt S07/S10: `modal_manifest.rs::summarize_mode`
publikuje stałe referencyjne gamma, zamiast aktualnego gamma planu.
Naprawa ma przenieść rzeczywisty parametr przez wspólny wynik path
do writerów i sprawdzić niereferencyjną wartość bez zmiany jednostek.
Nie jest to przyczyna różnic częstotliwości dla obecnego materiału
z gamma referencyjnym; to błąd metadanych dla ogólnej konfiguracji.

Sprawdzono zakończony job #195 (succeeded, exit=0) oraz rozmiar wyłącznie
jego katalogu execution: 443 802 041 B, 7592 pliki. Odzysk około 423 MiB
sam nie przekroczyłby progu 8 GiB przy ostatnim odczycie miejsca.
Nic nie usunięto i nie uznano tego katalogu za dopuszczony do kasowania
bez kontroli mountów/aktywnych użytkowników i autoryzacji.
#196 nadal queued, a sterownik 7375 potwierdzono żywy.

### Najnowszy wynik #195 i naprawa granicy build identity

Koordynator zakończył #195 statusem `succeeded`; worker exit=0,
native-build trwał 29 min 44 s. Sterownik 95215 zakończył się exit=1 po
pierwszym pilocie `gamma-t3/de-smoke-k0` (około 26 s). Relaksacja doszła do
zapisu artefaktów, który odrzucono komunikatem
`fem_relaxation_producer_provenance_invalid: producer build identity`.
Eigensolve i pozostałych pięciu punktów nie uruchomiono. Nie ma nowych
częstotliwości ani podstawy do aktualizacji scatterplotu tej serii.

Root cause jest potwierdzony przez log i kod: stamp buildu zawiera poprawny
source snapshot `b6511df906eb213ffe5f820985c202cfc6cc5364c68becd569611de8bad506a5`
w kanonicznym formacie raw64. Walidator producenta i linearization identity
stosowały walidator digestu payloadu wymagający `sha256:`. Syntetyczne fixture'y
powielały nieprawidłowy prefiks i nie wykryły błędu integracji. Poprawka
rozdziela walidację raw64 build identity od prefiksowanych digestów
payloadów; odbiorniki Python i fixture'y muszą używać identycznego kontraktu.
Nie wolno usuwać kontroli źródła ani akceptować obcych snapshotów.

Poprawka raw64 obejmuje Rust producer/identity oraz trzy interpretery Python:
producer provenance, exact linearization preimage i nonshared operator replay.
Focused checks: 47 PASS + 102 subtests; routing 6 PASS + 6 subtests;
pełny verifier 213 PASS (77,08 s); dodatkowe kontrakty discovery/routing/
nonshared 21 PASS; validator contract 35 PASS. Trzy zmienione mapy naukowe
PASS, Rust parser PASS. Native regresje są przygotowane, lecz nie kompilowane
zgodnie z zakazem; wynik managed runtime poprawki pozostaje NOT VERIFIED.
Review raw64 zamknęło też P2 inspectora: wspólny validator sprawdza raw64,
nested/top-level binding i same-source policy zarówno w writerze, jak i
w strukturalnym odbiorniku Rust. Poprawny framed hash nie omija już tej
kontroli. Przygotowano regresje samospójnego, ale prefiksowanego sidecara
oraz mismatchu źródeł; ich native wykonanie nadal NOT VERIFIED.

Następny krok: regression checks obu odbiorników, review, commit i managed
runtime-only build poprawionego źródła, następnie nowa próba w osobnym
katalogu wyników. Zachowujemy kapsułę bf25 i nieudaną próbę #195 bez zmian.
Nowa publikacja stanu, sześć punktów signed DE/BV, full-window completeness,
zbieżność, A1, GPU i browser pozostają wymaganymi, otwartymi bramkami.

### Korekty z bieżącego review przed zamrożeniem przyrostów

Checkpoint raw64 zapisano i wysłano na origin:
`2be55bdaad69686d8ed612f398cfbcebd04366b2`.
Zakres: producer/linearization identity Rust, trzy odbiorniki Python,
fixture'y, regresje i kontrakty. Dowody kontroli opisano powyżej.

- S05: ścieżka reuse musi przejść pełne `admit_floquet_modal_sparse_request`,
  a nie omijać admission przy bezpośrednim wejściu do shared-domain solvera.
- S05: twardy błąd `EPSSolve` z unsafe cleanup musi zatrzymać dalsze reuse
  i pozostawić okno nierozstrzygnięte. Lifetime obiektów referencjonowanych
  przez pozostawiony EPS wymaga jawnej obsługi; deterministyczny cleanup nie
  może być reklamowany na tej ścieżce. Review wykazało dwa P1 i jeden P2;
  trwają poprawki. Przyrost nie jest jeszcze zaakceptowany ani runtime-tested.
- Analityka/plot: selected-only record musi wiązać wszystkie parametry
  `B0`, `H0`, `mu0`, `t`, `d`, `Ms`, `Aex`, `gamma0` z resolved metadata.
  Review wykazało P1 brakujących pięciu bindingów, P2 jednostki potencjału
  (powinna wynosić A) i P2 niekontrolowanego typu geometrii. Trwają poprawki
  i regresje mutacyjne; dotychczasowe 67 zielonych testów nie pokrywało P1.
- Analityka: niezależna kontrola Decimal (70 cyfr) wykazała cancellation
  w `N_parallel` finite Dirichlet przy małym k. Dla k=1 rad/m, t=10 nm,
  d=2 um błąd względny czynnika wynosił około 31%; dla k=0,01 rad/m
  około 886 razy wartości referencyjnej. Nie oznacza to podobnego błędu
  częstotliwości (czynnik jest wówczas bardzo mały), ale blokuje twierdzenie
  o dokładnej granicy low-k. Wymagana stabilna postać algebraiczna z Taylor
  dla różnicy `2P-uF`, niezależne regresje wysokoprecyzyjne i ponowny review.

Przyrost finite-airbox po poprawkach: wszystkie parametry rekord→metadata
są wiązane, jednostka potencjału to A, błędna geometria daje kontrolowany
ValueError. Stabilna postać z Taylor eliminuje cancellation low-k; niezależny
Decimal70 daje błędy względne poniżej 3e-16 dla k=0,01, 1, 100, 10000 rad/m
w badanym modelu. Gałąź Γ nie tworzy przepełniającego 2d. 78 testów PASS,
mapa naukowa PASS. Jest to referencja jednorodnego n0, nie wynik FEM;
pełna zgodność, profil modu i zbieżność pozostają otwarte.
Checkpoint referencji finite-airbox zapisano i wysłano na origin:
`fe8170df2612fa380ef475c99e7984fa853da4eb`.

Re-review S05 ujawniło dodatkowy P1 w ścieżce bez reuse: po twardym
EPSSolve błędzie pozostawiony MatShell nadal wskazywał stack-owned context.
Samo pominięcie destroy PETSc nie zachowuje życia wektorów C++ ani callback
contextu. Wymagany jest retained heap owner również dla nearest/single-shift,
z normalnym cleanupem na sukcesie i process-bounded retention tylko wtedy,
gdy cleanup EPS jest niebezpieczny. Przyrost S05 pozostaje niezatwierdzony
do buildu do zamknięcia tej bramki i ponownego review.

Finalny przyrost S05 zamknął wskazane P1/P2 w review źródłowym: kontekst
Floqueta współdzieli real-split matrices, Poisson KSP/LU, workspace i MatShell
w obrębie jednego pełnego okna; EPS i shifted preconditioner są odrębne dla
próby. Pełna admission działa także w reuse. Twardy błąd zatrzymuje okno
z `complete=false` i `solver_error`; unsafe EPS zachowuje heap owner także
w nearest/nonreuse. Callback nie dereferencjuje zewnętrznego operator view
po powrocie. Root i niezależny review nie znalazły dalszych P1/P2. Source
regression z trzema shiftami i modelem lifetime oraz mapa naukowa PASS.
Native compile/runtime i rzeczywisty speed-up pozostają NOT VERIFIED;
zakaz dotyczy unit-test compilation, więc następny managed runtime-only
build jest autoryzowany. #193 było K0: ten przyrost nie dowodzi przyspieszenia
ani kompletności jego okna, nie zamyka pełnego S05/S04 ani S00–S12.

Przyrost S07 uzupełnia strukturalne referencje finalnej diagnostyki C ABI
w manifestach single-k i multi-k. Nowa para ma oddzielną coverage i właściwe
ścieżki `sample_NNNN/nonshared_source/...`; historyczne trzy płaskie sidecary
zachowują własny kontrakt. Python consumer sprawdza parę, ścieżki, aliasy,
typ indeksu i kolejność próbek. Review zamknęło P1 złego podkatalogu oraz P2
sortowania i kruchych asercji komentarzy. 44 testy przyrostu PASS; 213
istniejących regresji verifiera PASS. To nie jest native ani physical replay;
kompilacja/runtime nowych writerów pozostają NOT VERIFIED. Kapsuła #195
pozostaje przypięta do bf25 i nie zawiera tego późniejszego przyrostu.

Review S05 ponownie rozdzieliło zakres dowodu #193: był to `de-smoke-k0`
z `periodic_airbox_k0`, nie wykonanie operatora Floqueta dla nonzero-k.
14 kosztownych podokien miało `slepc_diverged`; nie są certyfikowanymi
pustymi przedziałami. Ich udział 98,8176% czasu uzasadnia analizę kosztu
nierozstrzygniętych shiftów, ale nie dowodzi jeszcze kosztu nonzero-k.
Następny przyrost S05 musi sprawdzić faktyczny zakres ponownego użycia
operatora i faktoryzacji; samo istnienie `borrowed_window_operator` nie
dowodzi ponownego użycia kontekstu PETSc. Limit lub pominięcie próby musi
pozostawiać przedział nierozstrzygnięty, nigdy automatycznie kompletny.

Wyprowadzenie finite-Dirichlet n0 wskazuje różnicę modeli analitycznych:
przy Γ finite airbox daje około 9,299249697 GHz, open film 9,309813711 GHz.
Dla |k|=2e6 rad/m zmiana referencji DE wynosi około -321 kHz, więc sama
nie wyjaśnia całej historycznej różnicy około -2,388 MHz. Trwa dodawanie
obu jawnych referencji z parametrów resolved metadata, wraz z niezależną
kontrolą funkcji Greena. Model jednorodny n0 nie zastępuje identyfikacji
profilu modu ani zbieżności FEM.

Spójny checkpoint natywny `bf25a30d7d8b26406bdbfc99d6412b10e4a15ae9`
jest na origin brancha zadania. Zawiera naprawy kompilacji, provenance
K0/Floquet, status nearest oraz sterownik sześciu rzeczywistych pilotów.
Submission zakończony exit0, przyjęty job #195:
`5a281e74772d4976a9d09ccc8d5c7be9`, runtime-only CPU/SLEPc, request key
`eigensolve-nearest-bf25a30d7d8b-20261001`.
Source digest `a10753dbee8313170b2a721716824496ebfbf1c255e01dc67ee446e96d89073f`,
snapshot SHA `b6511df906eb213ffe5f820985c202cfc6cc5364c68becd569611de8bad506a5`,
kapsuła `ab76858f0c0c475d898e79b71f864354/source`. Źródło czyste, commit mode.
W czasie buildu kontener `fullmag-worker-5a281e74772d4976a9d09ccc8d5c7be9`
działał. Odczyt potwierdził aktywne `make`, `cargo` i `rustc`
oraz logi native-build; etap kompilacji rozpoczął się. Przygotowanie kapsuły
wewnątrz workera zajęło około 14 minut (7584 pliki, 301 172 237 B).
Proces w trakcie przygotowania wykonywał odczyty przez system plików p9;
to obserwacja infrastruktury, nie pomiar solvera ani dowód całej przyczyny
kosztu. Worker zakończył się exit=0 i opublikował receipt `succeeded`;
native-build exit=0, duration_ms=1 783 616,963. Root sprawdził wszystkie
14 artefaktów receipt (rozmiary/SHA256), source digest i commit bf25,
CPU/double oraz runtime_contract.unit_test_targets=[]: PASS.
Dependency attestation potwierdza PETSc 3.24.6, SLEPc 3.24.3 i ten sam
snapshot źródeł; CMake attestation wiąże MFEM 4.10.0 z hash ABI.
Koordynator następnie opublikował `succeeded`. Sesja sterownika 95215
jest terminalna (exit=1); przyczynę nieudanego pilota opisano powyżej.
Punkty i kwalifikacja fizyczna nadal NOT VERIFIED.
Log potwierdził `Finished release profile ... in 14m 29s` dla pierwszej
kompilacji CLI z FEM. API zakończyło się w 9m 03s, Python core w 4m 01s.
Jest to terminalny sukces buildu, ale nie wynik fizyczny.
Health runnera odczytany w czasie buildu:
worker_alive=true, worker_error=null, accepting_jobs=true, aktywny #195,
storage_free_bytes=10 284 400 640. Ten odczyt nie jest gwarancją pojemności
dla kolejnych przebiegów ani kwalifikacją naukową.
Koordynator żywy; nie ponawiać submission po
samym timeout obserwacji. Runner preflight:
worker_alive=true, accepting_jobs=true, brak aktywnych jobów, 13 653 528 576 B
wolnego; runtime-v2 dopuszczony. To nie dowodzi sukcesu przyszłego buildu.

Review ustaliło rzeczywisty przepływ: nonzero-k shared-domain przechodzi
przez Floquet sparse operator oraz production CPU wrapper. Bezpośredni
descriptorowy writer Poisson Schur jest osobną gałęzią K0. Poprawka
`solve_complete` we wrapperze obejmuje więc rzeczywisty nonzero-k pilot;
wartość pochodzi z enumu statusu native. Nie poszerzano migracji o gałąź K0.
Kontrola źródłowa i pełny validator 0831 PASS; wykonanie NOT VERIFIED.

Sterownik przygotowany w `scientific-batches/nonzero-k-validation/5a281e74772d4976a9d09ccc8d5c7be9`.
Pierwsza próba zakończyła się przed obliczeniami: CRLF checkoutu i LF kapsuły
miały różne raw SHA. Zachowano pierwszą konfigurację jako
`controller-config.crlf-first-attempt.json`, nowa przypina raw SHA kapsuły
`a3b70295961fdb187d6462366fd9167e50c054e0101221a5e9c157db2e0c8d28`.
Uruchomiono dokładny kontroler kapsuły z `python -B`; sesja 95215 potwierdziła
build_state=running. Kontrola hashy zachowana. Przygotowanie następnych
konfiguracji naprawiono, aby zawsze odczytywało SHA kontrolera z kapsuły.

Końcowe review kolektora przyjęło dokładnie sześć przypadków i binding
targetów z konfiguracji. Wykryto P2 plotera: raportowe mu0 nie było ponownie
wiązane z metadata przed wyznaczeniem analitycznego B0. Poprawka mu0 i pola
zewnętrznego ma regresje, 53 kontrole kolektora/plotera PASS; scope w receipt
jest kanoniczny selected_only. Nie zmienia fizyki native ani progów.
Końcowe niezależne review kolektora, plotera i przygotowania kontrolera
zamknięte bez P1/P2: 64 testy i 19 subtestów PASS. Pełny validator noty nearest
PASS. Runtime/native i kwalifikacja naukowa pozostają osobnymi bramkami.

Końcowe niezależne review e6214cb39 wykryło P1 provenance:
`eigen_native_window.rs` może dla adaptera `floquet_airbox_cpu_schur_slepc`
publikować `magnetostatic_bc=periodic_airbox_k0` oraz scope/claim K0.
To nie dowodzi błędu operatora C++, ale blokuje wiarygodność artefaktów
nonzero-k. Poprawka zależna od faktycznego planu/adaptera jest zaimplementowana;
mismatch zwraca RunError, intencja Floqueta pozostaje jawna, a scope K0
dotyczy tylko CPU Schur. Parser/source/noty i końcowe niezależne review PASS.
Checkpoint `7c70e1b48c68a61280a765a0131b1dd63e47380d`; native wykonanie
NOT VERIFIED. Ostatni stale-fixture missing-boundary poprawiono na bounded K0.
Build #194 nie dostarczył runtime: zakończył się błędem kompilacji.
Po poprawce nonzero-k wymaga świeżego runtime ze spójnego SHA.
P2 review: dodano `solve_complete` bezpośrednio ze statusu native, oddzielnie
od `selected_only`/`window_complete=false`; nie jest wyliczany z tekstu JSON.
Kontrola źródłowa PASS, native wykonanie NOT VERIFIED.

Managed runtime-only build #194 zakończony `failed`, exit=2:
`e4aef98d4f0442b0ae43b43b7d055305`, profil `fem-cpu-slepc-runtime-v2`,
źródło `e6214cb39583b0644dc80a5f9183ce232a9f1246` (commit i push potwierdzone).
Request key: `eigensolve-nearest-e6214cb39583-20261001`.
Source digest: `9a4a1215693510af88d6bdb19e45d678e84d56a91061aa75ccb80226451ba227`.
Kapsuła: `runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/08f924ccf3d44f08a882dc94981cc5d5/source`.
Źródło czyste; snapshot SHA `17e838ca1f4dd7bd78dd272b7de29a8337ce0a00f7ebf1164d3713abd385284b`.
Etap native-build trwał 718 228,649 ms. Log wykazuje cztery przyczyny Rust:
import MeshTopology z niewłaściwego modułu, brak reexportu funkcji CPU
z producer identity, brak exact certificate preimage w replay payload
oraz porównanie podwójnej referencji do komponentu ścieżki (dwa E0277).
Poprawki źródłowe zapisano poniżej; parser i testy interpretowane nie wykrywały tych
błędów typów. Kolejny build dopiero ze spójnego checkpointu napraw.
Receipt `artifacts/build-receipt.json` potwierdza failed, runtime_only=true
i unit_test_targets=[]; SHA256 stderr:
`c284b99ae73ce33c97640febd81c9e494ca3c038e20acd0d8f7a5b9603eed791`.
Naprawy czterech przyczyn zapisano i wysłano w
`55c837888b903d53385b6b3ee92b7d2e0f89d0fd`: poprawny import/reexport,
typ iteratora oraz preimage tworzony raz i zachowany w replay payload.
Niezależne review źródeł, parser Rust i 56 regresji nonshared PASS.
Kompilacja tego checkpointu nadal NOT VERIFIED.
Po sukcesie:
sprawdzić receipt/hashes/MFEM loader, dry-run, Γ nearest (cel 9 GHz), następnie
osobne ±DE i ±BV dla k=2e6 rad/m. Cel Γ odsunięty od dokładnej wartości
analitycznej, aby nie zadawać shiftu na znanym biegunie. Wyniki nadal muszą
przejść oryginalne residuale, seam/phase, mesh, equilibrium i potential checks.

Sterownik otrzymał serię `nearest-single-k`: sześć rzeczywistych, kolejnych
uruchomień (Γ DE, Γ BV, ±2 rad/µm DE, ±2 rad/µm BV). Konfiguracja przypina
shift 9 GHz dla Γ/BV i 10 GHz dla DE nonzero-k; są to cele numeryczne,
a nie wyniki ani dopasowanie do analityki. Nearest ma selected-only scope
i nie dostarcza dowodu kompletności okna lub zbieżności. Kontrole sterownika:
10 PASS i 19 subtestów PASS. Przed wykonaniem sterownik sprawdza SHA własnych
bajtów i swojej kopii w kapsule; zmiana którejkolwiek blokuje uruchomienie
pilotów. Niezależne review sterownika PASS; naprawiono także kontrolowane
odrzucenie przepełnienia bardzo dużego integera celu. Kolektor i wykres
przeszły końcowe review i są zapisane w `75721ba74de947cc4e00a1311f9aa84bb35d8e3d`;
runtime NOT VERIFIED. Ten commit nie zmienia kapsuły ani źródeł buildu #195.

Zapisano i wysłano dwa kolejne checkpointy:
`c9f10a1d41780f88cdee2a36f21a430612343932` (terminalny audyt Γ) oraz
`a5ef668db1c2ef001086b4aac35b20160dea8def` (exact native input diagnostics).
Drugi przyrost przeszedł niezależne review bez blokera P1/P2, 56 lekkich
regresji, parser Rust i pełny validator noty. Główny verifier artefaktów po
integracji ma 213 testów PASS (67,88 s). Zachowuje dokładne bajty C ABI,
acykliczny preimage i referencje per próbka; native runtime pozostaje NOT VERIFIED.
Przygotowaną regresję preserve/remap nowych sidecarów rozszerzono w
`eigen_path_artifacts.rs`; parser PASS, wykonanie natywnego testu NOT VERIFIED.
Follow-up source zrealizowany: jawne strukturalne tablice ich referencji
w manifestach nonshared wraz z odbiornikiem Python; managed publikacja
nowych referencji i pełny native/physical replay nadal wymagają dowodów.

Nearest Γ/±DE/±BV jest przygotowany źródłowo: rzeczywisty adapter CPU
publikuje selected-only, planner i executor używają wspólnego capability,
który wymaga poprawnych par magnetic i airbox. Pilot wiąże cel z native
solver.v1.json; odrzuca konflikty root/sample, bool indeks i przepełnienie
GHz→Hz. 114 testów interpretowanych i 29 subtestów PASS; source contract,
parser Rust oraz walidatory not PASS. Przygotowane testy native nie były
kompilowane. Nowy managed build i fizyczne punkty pozostają NOT VERIFIED.
Świeży runner: worker_alive=true, accepting_jobs=true, active_jobs=[], brak
błędów, 13 304 324 096 B wolnego; runtime-v2 jest dopuszczony. To odczyt
preflight, nie dowód przyszłego przyjęcia joba ani wykonania symulacji.

Pilot na runtime #193 zakończył się błędem `frequency_window_subwindow_failed`:
36 z 50 podokien poprawnych, 14 rozbieżnych. Obserwator 42033 zakończył się
kodem 1, proces 168336 nie istnieje; wcześniejsze wpisy running są historyczne.
Z diagnostyki zachowano pojedynczy zaakceptowany mod Γ: 9,299249697068405 GHz,
full backward error 2,01e-13. Analityka tej samej geometrii skończonego airboxu
i konwencji engine μ0=4π·1e-7 daje 9,299249697068401 GHz. Nie powstało kompletne
widmo ani oficjalny CSV dyspersji; nie wykonano kolejnych punktów DE/BV.
Nieudane podokna zużyły 98,81765% sumy zmierzonych czasów podokien.
Szczegóły i tożsamość logu: [audyt wyniku Γ](../../audits/2026-10-01-mfem410-gamma-window-outcome.md).
Kolejny krok: spójny checkpoint nearest, świeży preflight managed runnera,
runtime-only build i osobne Γ/±DE/±BV. Kompletność okna pozostaje wymagana
w docelowym solverze; selected-only służy kontroli pojedynczych modów.

Checkpoint diagnostyki Schur/EPS:
`c5b14ffd4aadcb798c3b708381999048f6cf963f` — commit i push potwierdzone,
HEAD i origin są zgodne. Zakres: 7 plików; niezależne review czterech korekt,
source contract i pełny validator noty PASS. Zachowane limity 512/8192,
produkcyjny MatShell i dotychczasowe progi solvera. Doprecyzowano jednostki
bezwymiarowego EPS pencilu po normalizacji i powrót do fizycznej częstotliwości.
Native compilation/runtime tego SHA pozostają NOT VERIFIED.

W toku: jawny nearest pilot single-k oraz dopuszczenie go w pełnym kontrakcie
Floquet + dynamiczny demag CPU. Review wykryło lukę dowodową source testu:
selected_only z K0 nie dowodzi wyjścia Floquet nonzero-k. Potrzebne są jawne
target_kind, target_frequency_hz, spectrum_completeness=selected_only oraz
window_complete=false w rzeczywistym producerze i kontrola solver.v1.json.
Pilot musi obsługiwać osobne Γ/±DE/±BV z własnym celem; pełna kompletność
okna, ciągłość pasm i zbieżność pozostają oddzielnymi bramkami S00–S12.

Checkpoint exact mesh replay, małych macierzy i kanonicznych ścieżek:
`206a684b4f21d1439e7dcb57cce7408006e42312` — commit i push potwierdzone;
pełne lokalne HEAD i origin brancha są zgodne. Zakres: 8 plików, 28
interpretowanych regresji nonshared PASS, 13 kontraktów nonshared PASS,
parser Rust i pełny validator noty PASS. Review zamknęło P2 aliasów ścieżek.
Native build/runtime tego SHA: NOT VERIFIED.

Checkpoint consumer-plan i nonshared replay:
`dc98052f6dfc0336f0fd098b2d327822692f8515` — commit i push potwierdzone,
lokalny HEAD i origin brancha są zgodne. Zakres: 23 pliki, exact consumer
bytes, osobna publikacja/coverage nonshared, niezależny replay, kontrolowane
błędy JSON oraz regresje. 48 interpretowanych testów i 213 testów głównego
verifiera PASS; parser Rust i cztery walidatory not PASS. Native runtime
tego checkpointu nie został jeszcze zbudowany. Lokalna diagnostyka czasu
Schur/EPS jest osobnym przyrostem w review; błędy jej noty naukowej zostały
poprawione i pełny validator przeszedł. Korekty semantyki timerów,
agregacji błędów preconditionera i ochrony końcowego JSON przed obcięciem
są zaimplementowane i przechodzą source contract; niezależne review przyjęło
wszystkie cztery korekty. Nota rozróżnia bezwymiarowy EPS pencil/target po
normalizacji od fizycznej częstotliwości odtwarzanej przez angular_frequency_scale.
JSON parse nie zastępuje pełnej bramki dokumentacyjnej. Native runtime
telemetrii pozostaje NOT VERIFIED.

Kolejny przyrost source: exact mesh ref wiąże próbkę, ścieżkę, kodowanie,
długość i SHA rzeczywistych bajtów meshu. Historyczny brak ref zachowuje
jawną lukę i NOT VERIFIED. Naprawiono również algebraiczny replay małych
macierzy masowo ważonych: usunięto stałą tolerancję absolutną z porównań
macierzowych oraz dodano kontrolę zerowych bloków diagonalnych G.
Regresje odrzucają pięć podmian po samospójnym rehash przy skali 1e-24;
poprawny mały pencil pozostaje akceptowany. 21 testów helpera/skali,
5 testów routingu, 13 testów głównego kontraktu nonshared, parser Rust oraz
pełny validator noty nonshared PASS.
Ta poprawka nie zmienia progów residualu ani ustawień trwającego solvera.
Native runtime tego przyrostu pozostaje NOT VERIFIED. Niezależne review
nie wykryło P1; wskazało P2 aliasów ścieżek `./` i `//`, który naprawiono
walidacją surowych komponentów przed `Path`. Dwie nowe regresje ścieżek
przechodzą; pełny zestaw nonshared ma teraz 28 testów PASS.

Bieżący przyrost na remote: native publisher zachowuje dokładne bajty planu
konsumenta w `consumer_plan_snapshot.v1.json`; verifier wiąże raw SHA z
identity i pełnym zbiorem policzonych próbek. Niezależne review Rust nie
wykryło P1/P2; przygotowano pozytywne regresje pełnego pakietu single-/multi-k
z rzeczywistymi typami planu i pól (native tests niekompilowane).
Kontrole producenta, routingu i consumer-plan: 28 unittest PASS.
Osobny replay nonshared Floquet jest podłączony do głównego verifiera;
sprawdza canonical paths, coverage, exact preimages i relacje macierzy,
w tym gamma0 w rad/s per (A/m). Routing używa rzeczywistego interpretowanego
fixture, bez mocka: 20 testów routing/helper/consumer PASS. Deklaracje
nonshared w manifestach Rust są zaimplementowane, po review struktury;
utwardzenie canonical paths odrzuca traversal, dot/empty components i
backslash, zachowując dokładne bajty podpisanych artefaktów. Pełny native
operator replay, residuale i kwalifikacja naukowa pozostają NOT VERIFIED.
Po integracji: 40 interpretowanych regresji producenta/routingu/consumer/
nonshared PASS oraz 213 testów głównego verifiera PASS (75,58 s).
Pełne walidatory trzech not naukowych PASS; kontrola parsera nie zastępuje
kompilacji ani uruchomienia natywnego solvera.
Nie kompilowano testów native. Pilot zakończył się błędem pełnego okna;
pojedynczy zaakceptowany mod Γ jest opisany w aktualnym audycie powyżej.
Nie ma oficjalnego CSV tej serii ani nowych punktów nonzero-k na wykresie.
Review integracji wykryło dwa kolejne defekty obsługi wejścia: wszystkie
jawnie puste tablice nonshared były traktowane jak historyczny brak, a typy
JSON niezgodne z kontraktem mogły spowodować TypeError/AttributeError.
Pierwszy naprawiono z regresjami pustych/niekompletnych deklaracji (4 testy
routingu PASS). Normalizacja typów w helperze jest zaimplementowana:
embedding, damping, pair_id i konwersja ogromnej liczby JSON odrzucają dane
przez kontrolowany NonSharedReplayError. Test głównego verifiera po pełnym
rehash malformed payloadu również odrzuca podmianę; bieżący zestaw 48
interpretowanych regresji PASS. Przyrost nie jest jeszcze zbudowany.

Ta sekcja i tabela „Stan etapów” określają bieżące bramki. Pozostałe wpisy
opisują historię; dawne `running/live/queued` nie są aktualnym stanem procesu.

Checkpoint producenta, exact replay i sample binding:
`09aa7e5bc5018534c8490eabdd29a1fe9cdc33da`, commit i push potwierdzone.
Zlecenie runtime-only builda tego SHA zostało odrzucone przez preflight:
`Storage is busy: eigensolve-dispersion-plan-20260-c5dfad6d7f548079`.
Nowy job nie został wtedy przyjęty; pilot runtime #193 trzymał lock worktree
(PID 168336 na Orion). Proces już zakończył się; stan lease musi uzgodnić
świeży managed preflight. Nie użyto alternatywnego storage ani równoległego
buildu. Dla identycznego źródła można ponowić ten sam
request-key po zwolnieniu zasobu, jeśli nadal sprawdzamy 09aa7e5bc.
Dla późniejszego spójnego checkpointu użyć nowego request-key z jego pełnym
SHA; build starego checkpointu nie kwalifikuje późniejszych zmian.
W czasie oczekiwania: exact consumer-plan
sidecar oraz niezależny nonshared source/operator replay. Pełny S00–S12 otwarty.

- Na remote: checkpoint replayu pól i actual mesh `6b3b7357e1084aa91e9a5b77b9503e8929d5eb4a`,
  pełny sample-set sidecarów, własny exact identity replay Python
  i czytelna diagnostyka rzeczywistej kwadratury k0/Floquet. Review i lekkie
  regresje są dowodem źródeł, nie wykonania aktualnego solvera.
- Lokalnie w review: zweryfikowany exact-artifact handoff Rust, identity v2,
  producer own-preimage sidecar, single-/multi-k manifest links i retention.
  Otwarte: non-shared identity, provenance importu, modal identity i pełny replay.
  Focused review wykrył ponadto trzy P1 publikacji: indeks multi-k stale=0,
  ścieżki state sprzed przeniesienia oraz brak plural arrays single-k.
  Naprawy tych trzech błędów są obecne w źródłach i przechodzą niezależne
  review: realny indeks i finalne ścieżki trafiają do identity przed podpisaniem,
  single-k publikuje komplet ośmiu tablic. Runtime pozostaje NOT VERIFIED.
  Kolejne review: poprawiono cztery błędne nazwy parametrów blokujące
  kompilację; trwa utwardzenie kompletności tablic i digestów per próbka.
  Nowy replay pól wylicza fingerprint z rzeczywistej topologii, sprawdza
  node-count/CSR/roles/PBC i odrzuca zduplikowane aliasy tolerancji.
  Wrapper/base replay: 20 PASS; mesh fingerprint: 29 PASS; mapa naukowa PASS.
  Pełna integracja replay pól/źródła/operatora z głównym verifierem pozostaje
  otwarta; wynik wrappera ma jawny zakres caller-validated sygnatur.
  Nowe review wykryło brak per-sample relaksacji/producer transportu dla
  Path z próbkami pola, hardkodowany sample 0 w CSV i brak fail-closed kontroli
  dependency digestu odpowiedzi native. Poprawki trwają; nie są zaliczone.
  Standalone Python/runner dostaje lokalne identity nowej execution przed
  dispatch, z zachowaniem jawnych IDs orkiestratora i odrzuceniem częściowych
  metadanych. Parser PASS; prepared regresje nie były kompilowane.
  Adapter rzeczywistego producer planu do pełnego replayu Python jest w pracy.
  Producer discovery w głównym verifierze sprawdza pełny computed sample-set,
  canonical paths, kolejność i alias singular/plural: 8 nowych regresji PASS,
  252 dotychczasowe kontrole verifiera/sidecarów i 15 subtests PASS.
  Discovery nie kwalifikuje zawartości payloadów ani źródła.
  Checkpoint discovery jest na remote:
  `60cf6269f18f8fc629ef1a4e6d73929dab9f89f0`.
  Review adaptera źródła wykryło brak semantycznego porównania pól identity
  z rzeczywistym producer record: własny poprawny hash nie wystarcza.
  Poprawka adaptera wiąże IDs, build/plan/mesh/m0 i payload hashes;
  regresje samospójnej obcej identity odrzucają podmiany. Główny verifier
  wywołuje source adapter z dokładnymi sample paths i równowagą producenta,
  osobno wiążąc schema/content/path equilibrium/state. Kontrole przyrostu:
  25 unittest PASS; główny verifier 252 pytest i 15 subtests PASS.
  Routing mock sprawdza tylko przekazanie danych; realny pakiet bez mocków
  również PASS, z mutacjami artifact/path/hash po rehash identity.
  Suite producenta/routingu/nonshared: 30 unittest PASS. Validator noty
  adaptera PASS. Operator replay pozostaje NOT VERIFIED; do jego zamknięcia
  potrzebne są exact consumer-plan bytes i niezależne odtworzenie operatora.
  Review finalne wykryło stałe 0 w jednym write_eigen_v2_bundle: zastąpiono
  rzeczywistym artifact_sample_index. Non-sweep wrapper zwraca teraz ostatnie
  rzeczywiste m0; synthetic early-return używa handoff/plan fallback. Parser 19 zmienionych
  plików Rust PASS; brak kompilacji testów native. Nowy build runtime-only
  musi zweryfikować typy i rzeczywiste wykonanie tego checkpointu.
  Python sprawdza teraz pięć exact preimage materiału/statyki/boundary/raw
  po pełnym own-identity replay. Focused 59 i główny verifier 213 PASS.
  Poprawiono leksykalne ujemne zero, zakres deklaracji i regresje airbox/PBC;
  te kontrole nie certyfikują jeszcze pól, operatora ani źródła.
- MFEM CPU 4.10.0 jest zbudowany i odczytany z rzeczywistej biblioteki. Build
  Fullmaga #193 (`19e798d5ff07454db64c90e63ba4f3a3`) zakończył się `succeeded`,
  źródło `e78a25bac0f95c1190821524545803e4311b8ef9`. Nie zawiera nowszych przyrostów.
  Receipt zawiera 14 artefaktów. Atestacja CMake `pass` wskazuje faktyczny
  `libmfem.so.4.10.0`, SHA256 `89dfb92bea5c9019744ef8802238aa259f7689bfb3978a8d02976865801b86ae`.
  Obraz MFEM4.10: `8a508319a68c4116da81b745fdd1b084015b665d92b36b2241e1e245b5febf89`.
  Niezależny dry-run wrappera walidującego receipt/źródło zakończył się exit0.
  Jeden obserwator serii `thickness`, session `42033`, przeszedł do Γ t3.
  Kontener solvera `21c61a91ee6f` jest aktywny; log pokazuje refinament 25/50.
  Nie ma jeszcze terminalnego wyniku częstotliwości ani kwalifikacji residualu.
  Konfiguracja: `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/scientific-batches/nonzero-k-validation/19e798d5ff07454db64c90e63ba4f3a3/controller-config.json`.
  Przypięty model i runtime mają SHA `e78a25bac0f95c1190821524545803e4311b8ef9`:
  Γ t3, DE/BV k25 t3/t6/t9. Wrapper sprawdza receipt/hash/image i heavy lease,
  zatrzymuje się na pierwszym błędzie. Seria nie kwalifikuje nowszego źródła R4
  i nie zastępuje rzeczywiście liczonych ujemnych k, C0 ani COMSOL A1.
- #188 i jego kontroler są terminalne: błąd kompletności okna, 6/50 podokien.
  Lokalny kandydat 9.299249697 GHz nie jest kwalifikowanym punktem dyspersji.
- Archiwalne punkty i wykresy nie kwalifikują bieżącego źródła. Wymagane są
  nowe C0/C1, signed DE/BV, zbieżność, A1, pozostałe interakcje, 2.5D, GPU,
  Control Room/FMS/browser oraz końcowe review i integracja całego S00–S12.

## EPS — diagnostyka niepełnej zbieżności, 2026-10-01

Baza przyrostu: `99293ff8659276abfb57c2dddaff46f269e5c234` (bounded Krylov).
Przeniesiono wybrane fragmenty K0: rzeczywiste liczniki EPS/Schur/Poisson
przed obsługą ujemnego convergence reason oraz diagnostyczną rekonstrukcję
częściowych Ritz. Niepełny EPS nadal kończy się błędem przed publikacją modów.
Maksymalnie cztery dodatnie próbki zachowują niezależne residuale full/magnetic/
Poisson/gauge. Poprawiono etykietę faktycznego KSP na GMRES.

Review wykrył dwa P2: za mały bufor próbek i anulowanie podczas rekonstrukcji.
Bufor zwiększono do 1536 bajtów, niedostępność próbek jest jawna, a przepełnienie
całego JSON kończy się oznaczeniem unavailable. Powtórny odczyt cancellation
przed finalną decyzją zachowuje interrupted/cancel_requested.

Kontrola 27 literalnych wywołań diagnostyki i 18 testów interpretowanych/source/
docs PASS. Przygotowano natywną regresję liczników i braku stale/partial modes;
nie kompilowano ani nie uruchamiano testów jednostkowych zgodnie z zakazem.
Nowy runtime i nauka pozostają NOT VERIFIED. Kontroler 90201 sprawdzony live;
#188 nadal korzysta ze starszej kapsuły. Nie tworzono konkurencyjnego buildu.

Pełny zakres S00–S12 pozostaje otwarty. Dalej: review i commit tego przyrostu,
F01 prism6 quadrature, R4/replay oraz mesh/Robin; następnie nowy managed runtime
z aktualnego źródła, signed DE/BV, zbieżności i COMSOL A1 oraz pozostałe bramki.


## S01/S12 — wspólny K0/nonzero-k i bounded Krylov, 2026-10-01

Historia K0 została scalona i wypchnięta przez `9b14e53757412d91ba5cc955774e228fb71b8cf0`; checkpoint `1cf47b6d25b48cbb5b6813d6995ba5113fb03be4`. Wątek K0 utrzymuje freeze, 100 dirty/untracked pozycji zachowano. Wspólnym miejscem integracji pozostaje worktree nonzero-k. Raport: `docs/audits/2026-10-01-k0-nonzero-k-worktree-integration.md`.

Pierwszy port EPS dodaje ograniczone `nev/ncv`, uint64 mnożenie żądania i jawne `EPSSetDimensions`. Standalone dodatni nearest używa 2x; wewnętrzne wywołania nearest borrowing window zachowują 4x, dzięki jawnej kontroli `!borrowed_window_operator`. Wszystkie trzy warianty certyfikatu okna i każdy wpis podokna raportują `ncv`. Przygotowano natywne regresje ncv/warunków retry, ale nie kompilowano ani nie uruchamiano ich zgodnie z zakazem. Kontrola 26 literalnych wywołań diagnostycznych i 18 testów interpretowanych/source/docs (w tym 5 regresji kontrolera printf): PASS źródłowy; mapa źródeł PASS; runtime/science NOT VERIFIED. Niezależny review bez blokującego P1/P2; przygotowana natywna regresja obejmuje wszystkie 50 par nev/ncv, ale nie została uruchomiona.

Kolejny port EPS obejmie zachowanie liczników przy niepełnej konwergencji, ograniczone próbki odtworzonych Ritz i końcowy fail-closed bez accepted modes. Pakiety R4, mesh/Robin i qualification pozostają w planie; nie zastępujemy nimi Floquet ani Ku v8/v7. #188 controller90201 potwierdzony żywy w tej kontynuacji; jego immutable źródło nie zawiera nowych portów. Pełny cel S00–S12 nadal aktywny.


## F03/S08 — jednostki i HWHM obwiedni, 2026-10-01

- Potwierdzono writer/spec: damping_rate_hz=frequency_imag_hz=HWHM, FWHM=2*imag. Shared spectralEnvelope liczy Hz, przelicza wyłącznie oś i nie dzieli HWHM przez2. Nieznane jednostki dają unsupported; label illustrative zamiast fizycznej intensywności.
- Direct production TypeScript execution Node24 PASS: jednostki Hz/kHz/MHz/GHz, rachunek HWHM, tożsamość punktów, unknown units, undamped/empty. Recepta node apps/control-room/scripts/check-modal-envelope-units.mjs nie kompiluje jednostkowych testów, native ani bundla. Nie jest typecheck/Vitest/browser/FEM proof.
- Niezależny review F03 bez P1/P2. Przygotowane Vitest regresje niekompilowane/nieuruchomione. Współczesny FrequencyDomainCharts korzysta z innego modelu rank-vsHz; helper F03 w repo ma tylko testowe callsites. Nie podmieniono produktu na syntetyczne widmo.
- F02 source commit73cc2b1992f6f887aad389e94f07669d229618d6; parser/review PASS, runtime NOT VERIFIED. F01 quadrature, signed seria, finite-airbox Gamma, pozostałe S00–S12 i integracja nadal otwarte.


## F02/S07 — jawny sample bez podmiany legacy, 2026-10-01

- Usunięto catch-all fallback get_mode do legacy. Wspólny read_selected_eigen_mode utrzymuje autorytatywny sample także dla get_mode_v2; legacy tylko przy braku sample_index. Brak pliku404 i parse/read error nie zmieniają wyboru próbki.
- Cztery rzeczywiste filesystem regresje Rust przygotowane: brak sample0/1 z legacy; corrupt z legacy; rawmode0 w dwóch signed próbkach; dwa katalogi wyników. Parser jednego pliku PASS; niezależny review bez P1/P2; native unit tests niekompilowane, managed API runtime/browser NOT VERIFIED.
- OpenAPI request/response types i ścieżki bez zmian; facada ControlRoomApi.frequencyDomain.eigenMode korzysta z resource-first trasy. Nie dodano frontendowego fallbacku. Specyfikację selekcji uzupełniono.
- Pełny ownership run/stage i walidacja payloadów nadal wymagają bramek S07/S08. F01/F03 oraz cały S00–S12 pozostają otwarte. Ten sam kontener Gamma7df4be7c5ace running, refinement24/50; brak nowej terminalnej częstotliwości.


## Odbiór GPT PRO ab64bac, 2026-10-01

- Commit/push odbioru audytu:434b16d498feea5087957d604776bc683bafebfb; HEAD/remote zgodne, worktree czysty przed próbą builda.
- Managed runtime-v2 dla tego SHA, request-key modal-telemetry-audit-434b16d498feea50, odrzucony przed utworzeniem joba: exit1 Storage is busy, lease eigensolve-dispersion-plan-20260-c5dfad6d7f548079. Runner worker_alive/accepting_jobs=true, błędy=null, profil dostępny i43876155392B wolnego. Nie obchodzono lease; brak nowego receipt/runtime.
- Ten sam kontroler90201 pozostaje live, solver7df4be7c5ace running; najnowsze obserwowane Gamma refinement24/50 bez końcowej nowej częstotliwości. Następnie F02→F03→F01 oraz pełne bramki zgodnie z odbiorem audytu.


- Oryginał zachowany w docs/audits/2026-10-01-gpt-pro-eigensolve-ab64bac-original.md; pełny odbiór i kolejność napraw: docs/audits/2026-10-01-gpt-pro-eigensolve-remediation.md.
- F01 prism6 exchange quadrature,P1; F02 explicit-sample legacy fallback,P1; F03 Hz/axis linewidth mismatch,P2 potwierdzone w aktualnych źródłach i otwarte. Najpierw F02/F03, następnie F01 z polityką transformacji i kontrolą nullspace. Pilot tetrahedral nie korzysta z prism6.
- Dodano G04: Gamma finite-Dirichlet reference9.299249694GHz kontra open-film9.309813709GHz; porównanie po weryfikacji rzeczywistych BC i osobnej zbieżności airboxu, bez zmiany residual gate.
- G01 canonical/raw migration źródłowo799be85, lecz guard/runtime nadal otwarte; G02 multi-candidate branch/subspace, H01 realification, H02 variational texture i H03 gauge nadal wymagają dowodu. Pięć zbieżności i pełen zakres S00–S12 zachowane.
- Modal telemetry commit3b67a9f3c6a75e0d8d5c28116170477784c3a570:13parserPASS, mapa/publicexamplesPASS; review P1/P2 naprawione wraz z mixed frame. Native testy przygotowane, niekompilowane; managed runtime/browser NOT VERIFIED.



## S08/S12 — modalny postęp bez fikcyjnych pomiarów, 2026-10-01

- Potwierdzono residual wpisywany do max_h_eff i cichy dense fallback w etykiecie algorytmu. Nowe źródła zachowują residual jako diagnostykę i dokładny solver/phase; brak tożsamości daje unknown.
- CLI modal/heartbeat nie pokazuje domyślnych zer fizycznych. Scalar history pomija modalne callbacki także force/terminal; run manifest nie przypisuje im energii/czasu; status/energy resource nie tworzy fizycznego fallbacku z modalnego latest_step. Historia rzeczywistych pomiarów zachowana; current/catalog nie pokazują jej jako bieżącego pomiaru podczas callbacku modalnego.
- 13 plików Rust parser PASS, mapa źródeł PASS; regresje Rust przygotowane, niekompilowane. Existing OpenAPI dopuszcza brak wartości statusu; schematy i generated types bez zmian. Końcowe review i managed runtime/browser wymagane.
- Realtime wymaga wzrostu scalar_revision po akceptacji; historyczne scalars/tables JSON/binary/energy filtrują markery przed limit bez przepisywania archiwum. Wykres de-bv-updated-job188:27archiwalnych rekordów, brak nowych punktów i ujemnych k.
- Audyt: docs/audits/2026-10-01-eigensolve-progress-physical-metrics.md. Nie zmieniono macierzy, tolerancji ani selekcji modów.
- #188 pozostaje aktywny: kontener7df4be7c5ace około212%CPU, Γ refinement24/50; brak nowej terminalnej częstotliwości. Kapsuła nie zawiera tej poprawki ani migracji Ku. Nie restartowano obliczeń.
- Po zwolnieniu lease: managed build aktualnego pełnego SHA -> runtime/artefakty/status/browser; pełny cel signed DE/BV, zbieżność, COMSOL A1, interakcje, waveguide, GPU i integracja nadal otwarty.


## S10/S12 — zatwierdzona migracja canonical/raw Ku, 2026-10-01

- Jawna zgoda użytkownika na equilibrium_artifact.v8 / LinearizationState.v7. Ku-free zachowuje v7/v6; historyczne dane i kapsuła #188 nie są przepisywane.
- Zaktualizowano producentów i loader Rust, material_snapshot_id, nazwy plików i manifesty single-/multi-k oraz odbiorniki Python/COMSOL. Raw provenance ma zakres materialization_plan; provided source zachowany. Publiczny Ku guard nadal aktywny.
- 151 lekkich testów +54 podprzypadki PASS; 10 plików Rust parser PASS, mapa źródeł i public examples PASS. Native unit tests niekompilowane. Review bez P1/P2 po naprawieniu cichego fallbacku wersji podczas publikacji.
- Commit/push: 799be85d3e1c40ee1d7790797d6f81536e9d9ce9; zgodność HEAD/remote i czysty worktree potwierdzone.
- Managed runtime-v2 build tego SHA nie został utworzony: klient exit1 Storage is busy, lease worktree eigensolve-dispersion-plan-20260-c5dfad6d7f548079 zajęty przez #188. Runner healthy/accepting, około42,6GiB wolnego. Nie obchodzono lease i nie przydzielano innego targetu. Po zwolnieniu lease ponowić request-key ku-canonical-artifact-v8-799be85d3e1c40ee z tym samym SHA.
- Audyt: docs/audits/2026-10-01-ku-canonical-material-artifact-migration.md. Runtime migracji i bramka Ku pozostają NOT VERIFIED.
- #188 nadal Γ base4/50; kontener7df4be7c5ace running. Brak terminalnej nowej częstotliwości. Kapsuła #188 nie zawiera obecnej migracji.
- Cały S00–S12 pozostaje otwarty: signed DE/BV, zbieżność, COMSOL A1, interakcje, waveguide, GPU, browser i integracja.


## S10/S12 — zerowe H_eff, kolejny przyrost źródeł

- `validate_shared_domain_modal_scope` dopuszcza skończone zerowe pole: brak pola statycznego nie dowodzi braku krzywizny. Ujemne/NaN/Inf amplitudy odrzucane; publiczny Ku guard zachowany.
- Niezależny rachunek energii:4testy+12podprzypadkówPASS. Dwie regresje Rust przygotowane, nie uruchomione;2pliki parserPASS. Nota/source-map i public examples guardPASS. Runtime tej poprawki NOT VERIFIED, bo kapsuła188 jej nie zawiera.
- Ten sam kontroler90201 i solver7df4be7c5ace nadal liczą Gamma, base subwindow4/50; aktywnośćCPU potwierdzona. Bez nowej zaakceptowanej częstotliwości, bez restartu.
- Przyrost commit/push ab64bac46b7ceda295812da93244b2eba81174e4; niezależny review Rust/Python bez P1/P2. Uwagi do położenia wiersza źródeł w nocie poprawiono.
- Audyt: docs/audits/2026-10-01-zero-field-modal-scope.md. Następnie canonical/raw material artifact migration oraz cały S00–S12: aktualne±k, zbieżność, COMSOL A1, interakcje, waveguide, GPU, browser i integracja.


## S02/S12 — odbiór review signed-k i aktualny Γ

- #188 terminalny succeeded/exit0, source digest b2edf2fbc0295c83f6d768ad8bd3391904017c5f871d0244afe15c4b3a1a4a46;14artefaktów receipt size/SHA PASS. Receipt SHA0bf0ea60b99b550767331c6bd231a0979a79d49fe15ead150eeb06c31c70daae.
- Kontroler90201/145d8503bba24dc3abfaec6aaaf72819 wykonuje Gamma. Kontener7df4be7c5ace potwierdzony mountami i pracąCPU; min-root mapa nie blokuje już wejścia do SLEPc. Brak terminalnego wyniku i nowej częstotliwości w chwili checkpointu.
- Po review odbiór signed wymaga hasha kontrolera z kapsuły, wspólnego capsule_relative w receipcie, canonical batch/job root i pełnej niezależnej walidacji6przypadków zbieżności+Γ; k używa tolerancjiCSV.65lekkich testówPythonPASS. Zmiana postprocessingu nie wymaga nowego solver builda.
- Dalej: ten sam pilotΓ -> signed26punktów+4kontrole -> pełne pola/residuale/profile/seam/branch -> wykres i zbieżność. Pełny cel S00–S12, Ku canonical/raw identity, COMSOL A1, inne interakcje, waveguide, GPU, browser i integracja pozostają otwarte.


## S02/S12 — rzeczywiste signed-k DE/BV, 2026-10-01

- Naprawa mapy jest commit/push f33ca4e5c3c96c408eef5ca6d8edb31dea656f87; niezależne review bez P1/P2. Uzupełniony replay wiąże również kolejność runtime par (6d932e997d5e5012191270ac2066c70a25dc776e).
- Dodano serię signed-13: 26rzeczywistych punktówDE/BV (0,±2,±5,±10,±15,±20,±25rad/µm) +4kontrole6/9warstw, sekwencyjnie. Jeden model Python, indywidualne signed wektory i wyniki; bez odbicia częstotliwości.
- Signed kolektor zachowuje bramki źródeł, pól, residuali i mierzy symetrię. 35nowych lekkich testówPASS,49istniejącychPASS i21subtestówPASS; native testów nie kompilowano. Wykres gotowy do faktycznych ujemnych danych.
- Wymagany nowy snapshot runtime-v2 i terminalny receipt, potem30runów i signed scatterplot. Aktualnie bez nowych częstotliwości; Ku canonical/raw migration, COMSOL A1, zbieżność, inne interakcje, GPU, browser i integracja pełnego S00–S12 pozostają otwarte.


## S02/S12 — kanoniczne mapy periodyczne, 2026-10-01

- #187 succeeded/exit0, ale pilot Γ zakończył się przed częstotliwościami błędem producer_reduction_map_not_canonical. DE/BV nie rozpoczęto.
- Niezależny replay siatki6138 i rzeczywistych par runtime potwierdził48 błędów numeracji mapy magnetycznej. Minimum-root union daje0 i zachowuje kierunek/kolejność niezależne mapy;328 klas magnetycznych bez zmiany.
- Naprawiono generator przed składaniem operatorów, bez osłabienia certyfikatu lub residuali. Trzy regresje Rust przygotowane, niekompilowane; parser i replay PASS. Audyt docs/audits/2026-10-01-modal-periodic-map-canonical-numbering.md.
- Przyrost Ku v2 jest już commit/push813fec3948e3994551834a06721f1ac357a9ea3b. Poprzedni wpis WIP jest historyczny. Canonical/raw material artifact migration pozostaje otwarta.
- Następny krok: nowy managed snapshot runtime-v2 -> Γ -> DE/BV k25 L2/t3/t6/t9 -> bramki pól/residuali/analizy. Pełny cel S00–S12 i wszystkie bramki nauki/integracji pozostają otwarte.



## S10 — certyfikaty pól Ku v2, checkpoint 2026-10-01

- Dodano jawne pole anizotropii do wersjonowanego certyfikatu, kopię natywną H_ani, producenta i certyfikat ponownego przeliczenia v2. Modele bez Ku zachowują ścieżkę v1; deklarowane Ku=0 używa v2.
- Konsumenci wymagają zgodności wersji z materiałem; niezależny observer porównuje pole Ku oddzielnie od pola zewnętrznego. Digest wiąże faktyczne bajty pól, a walidator kontroluje natywną kolejność ich sumowania.
- 42 lekkie testy Python PASS (18 nowych regresji + 24 istniejące). Pięć zmienionych plików Rust przeszło parser rustfmt bez kompilacji; to nie dowodzi poprawności typów ani wykonania FEM. Testów jednostkowych natywnych nie budowano.
- #187 terminalny succeeded/exit0; 14 artefaktów receipt size/SHA PASS. Snapshot nie zawiera późniejszych identity/observer/v2. Kontroler28980 terminalny exit1: gamma-t3 odrzucony przed modami przez producer_reduction_map_not_canonical. Relaksacja6138 nodes/30012 tets/3steps przeszła. DE/BV nie rozpoczęto. Bez nowych częstotliwości.
- Review potwierdziło potrzebę nowego equilibrium_artifact.v8 / LinearizationState.v7: canonical material signature do zgodności fizycznej i material_snapshot_id, osobny raw hash do provenance. Historyczne v7/v6 pozostają niezmienione. Migracja i regresje są następnym krokiem, przed odblokowaniem Ku.
- Review v2: poprawiono hardkodowane v1 w bias sweepie i orchestratorze, wspólny selector plików, early scope guard, null oraz strict digest; source-only frozen refresh-v1 i ścieżki Ku=0 przygotowane. Końcowy review CPU bez nowego P1; GPU copy dostaje accepted-cache guard. Import DeError zachowany jako wymagany trait dla D::Error::custom.
- Następny runtime blocker: kanoniczne numerowanie map producenta; trzeba wyjaśnić i naprawić producer_reduction_map_not_canonical, następnie ponowić Γ i pełną serię DE/BV na nowym źródle.
- Przyrost v2 pozostaje WIP: regresje Rust przygotowane (niekompilowane), review CPU bez nowego P1, exact staged nauka56plików i Rust8plików parser PASS. Pozostaje commit/push oraz nowy managed runtime. Pełny zakres S00–S12, zbieżność, COMSOL A1, interakcje, waveguide, GPU, UI i integracja pozostaje otwarty.

## S10/S12 — Ku w źródłach; ten sam job #187

- Wdrożony koordynator 7753401fbbf748625b8ec2fda0fc244b07e8ef492426102102dd88bd22c6f901, zachowane siedem profili i dane. Worker wznowiony; nowy snapshot #187 c52c7fd053e745d9b113ffeb0268a472, digest 15733ecfc2d145cc04340f0284c50122dca3fe92f8e223d4a7440afc8fdf691a, HEAD b62bfe9025dd93914b8e13468d8320d9af4ac2a2 + jawny WIP. Kapsuła 2272f012edb6422ba50877a2c9dbe62f/source: verify_source PASS, 7491 plików. Bieżący status running; potwierdzony worker 98cb548305f4e1f07e03bf2681988eff40e09999d6e1c74e00bd02db41e2dd70. Log: stage native-build start make install-cli-dev; docker top potwierdza cargo/rustc. Poprawiony preflight przeszedł. Bez nowych częstotliwości; nie restartowano zadania.
- Native Ku: constrained Hessian, obie bazy, signed coefficient i total h_eff0; Rust owns views/digests. Nowy wspólny material builder wiąże Ku/oś w namespace v2 i zachowuje Ku-free v1. Observer rejestruje typed anisotropy zamiast zamrożonego pola Zeemana. Publiczne guardy pozostają; reszta S10 nie jest zamknięta.
- Niezależna energia: 3 Python PASS; Rust/native regresje źródłowe przygotowane, NIE kompilowane. Nota 0831 i ADR0023 rozszerzone. Audyt: docs/audits/2026-10-01-uniaxial-modal-identity-and-field-channel.md. #187 nie obejmuje dopisanych po capture identity/observer.
- Review Ku: certyfikat pól v1 nie obejmuje h_anisotropy, a material_snapshot_id/artefakty nadal haszują surowy materiał. Przed odblokowaniem potrzebne v2 pól, digest/konsumenci, spójny kanoniczny materiał oraz sprawdzenie cache modalnego i zero-h_eff. Dodane regresje source-only producer/consumer i legacy bytes/hash; wykonanie natywne nadal NOT VERIFIED. Szczegóły w audycie Ku.
- Wykres de-bv-updated-job187: 27 archiwalnych punktów i referencje P00/N32, bez nowych wyników. Następnie receipt tego samego #187, Γ+DE/BV, kompletne pola i residuale; osobny snapshot Ku, K0 i +/-k oraz zbieżność. Pełny S00–S12, COMSOL A1, interakcje, GPU, browser i integracja pozostają otwarte.

## S12 — #186 terminalny; poprawka offline nightly

- #186 failed/exit2 przed kompilacją, ponownie rustup toolchain list timeout30 s. Kontroler48901 terminalny exit1; nie ma nowych częstotliwości. Dane zachowane.
- Kontrola z katalogu kapsuły uruchamiała synchronizację stable z rust-toolchain.toml. Poprawiony inventory/version/build environment jawnie wybiera wymagany nightly i wyłącza autoinstalację. RED dwie regresje; GREEN31 lekkich testów Python PASS. Prawdziwy offline preflight tego samego obrazu/kapsuły/cache PASS w0.02253 s, rustc -Vv exit0.
- Audyt docs/audits/2026-10-01-runner-rustup-project-override.md. Następnie wdrożenie koordynatora przy pustej kolejce i potwierdzonej pauzie, nowy snapshot, Γ+DE/BV i bramki nauki. Pełny S00–S12 pozostaje otwarty.

## #186 — nowy snapshot z transportem pola statycznego

- Poprawka źródła: commit 916cb24f8f3cb4cef9dc43859371708b04a7c1c9, selektywnie siedem plików bez pozostałego WIP. Dokładna nota/mapa/źródła tego commita PASS; kapsuła #186 verify_source PASS. Test natywny nieuruchomiony; nowe częstotliwości nadal niedostępne.
- Job eb75817e0ad74168a26fcf11627b5e68, profil fem-cpu-slepc-runtime-v2, source digest 753ada8e017bd50bf741fc16898155560b17350b38196ca0a35bf290ad483450. Snapshot HEAD e3bc8ec448f3b02088c1ff4d8b45a0e4aa5a359d + tracked WIP i jawny tracking_mass.rs; kapsuła 6e783cba58c044e8b84b8485acef23c5/source.
- Zgłoszenie 4643 terminalne exit0, status koordynatora running. Kontroler 48901 potwierdzony żywy; konfiguracja tylko scientific-batches/nonzero-k-validation/eb75817e0ad74168a26fcf11627b5e68. Brak jeszcze dowodu kompilacji i nowych częstotliwości.
- #185 i kontroler 3576 terminalne failed/exit1. #186 jest osobnym buildem zmienionego źródła po diagnostycznym PASS toolchain list, nie restartem obserwacji. Przyczyna wcześniejszego opóźnienia nadal niepotwierdzona.
- Audyt: docs/audits/2026-09-30-static-field-tangent-covariance.md. Regresja natywna przygotowana, nie skompilowana. Nota i mapa źródeł PASS; niezależny przykład algebraiczny potwierdza defekt starego składania, ale nie dowodzi runtime FEM.
- Następnie ten sam #186 -> Γ + sześć DE/BV -> odbiór wszystkich pól, residuali i provenance -> N32/P00, zbieżność i nowy wykres. Pełny S00–S12 pozostaje otwarty.

## S10 — transport baz w polu statycznym; #185 terminalny

- Potwierdzono błąd: pole statyczne stosowało identyczność komponentów również między różnymi ramkami węzłów; wymiana i blok żyromagnetyczny używają projekcji kartezjańskich. Poprawka składa h_parallel razy iloczyn obu baz. Dla wspólnej bazy zachowuje poprzednie zachowanie; nie jest wyjaśnieniem rozbieżności jednorodnego filmu.
- Nota 0831 i mapa źródeł zawierają właściwą postać słabą. Weryfikacja natywna i nowy runtime pozostają NOT VERIFIED; zakaz kompilacji testów jednostkowych zachowany.
- #185 failed/exit2: rustup toolchain list przekroczył limit 30 s, przed kompilacją. Nie ma nowych częstotliwości. Dane i kapsuła zachowane; nie ponowiono zadania bez diagnozy.
- Wykres DE/BV odświeżony w de-bv-updated-job185 w katalogu visualizations tego wątku: 27 archiwalnych rekordów i porównanie P00/N32, bez nowych punktów. Pełny plan S00–S12 pozostaje otwarty.

## S12 — zgodność odbioru siedmiu przypadków kontrolera

- Kolektor obsługuje rzeczywisty raport kontrolera Γ+DE/BV, nie tylko wcześniejszy format sześciu przypadków. Wymaga pełnej serii exit0, tożsamości job/digest/config/model i wyjść w tym samym batch; częściowy raport pozostaje błędem.
- Γ ma osobny odbiór receiptów, k0 i pełnych pól/potencjałów; wynik wiąże hash konfiguracji oraz danych kontrolnych. RED brak adaptera; GREEN 24 lekkie testy Python PASS. Audyt: docs/audits/2026-09-30-seven-case-controller-collection.md.
- #185 i kontrolera 3576 nie restartowano. Kapsuła verify_source PASS, 0 .pyc; job running, bez dowodu kompilacji w chwili odczytu. Kolektor po wynikach uruchamiany z aktualnego worktree, runtime nadal capsule-bound.
- Następnie terminalne rzeczywiste siedem wrapperów → kolektor → N32/P00 i zbieżność. Pełny S00–S12 nadal otwarty; fixture nie jest dowodem nowych częstotliwości.

## #185 running po odtworzeniu nightly

- Job #185 / a5aaa693ed3f4f3db64bf7823445097f, fem-cpu-slepc-runtime-v2: kontroler 3576 potwierdził running. Source digest 2a08f6022a6c5f32e68bbc46e5cc39534aa6f3f28ff501120b74ccb31888886c; kapsuła runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/1e65a3d16374417193d39f07597bba71/source.
- Snapshot HEAD a968a7867a93ef52791a90aede367edc73952446 wraz z WIP i jawnym tracking_mass.rs; obejmuje nową kontrolę kompletności wszystkich opublikowanych modów. Nightly cache odtworzony z image i sprawdzony offline jako użytkownik workera.
- Konfiguracja i wyniki obserwatora wyłącznie w scientific-batches/nonzero-k-validation/a5aaa693ed3f4f3db64bf7823445097f. Źródła obserwuje klient worktree z -B, runtime korzysta z kapsuły. #184 oraz sesja 18780 terminalne failed/exit1; nie restartowano starego joba.
- Po buildzie Γ L2/t3, następnie DE/BV k25 L2/t3/t6/t9. Brak nowych częstotliwości i dowodu kompilacji w chwili checkpointu; sukces builda nie zamyka nauki, a cały S00–S12 pozostaje otwarty.

## S12 — #184 terminalny; nightly odtworzony offline

- #184 failed/exit2 przed kompilacją: pusty montowany cache rustup; nightly obecny w obrazie nie był dostępny pod RUSTUP_HOME workera. Kontroler 18780 terminalny exit1. Nie ma nowych częstotliwości.
- Kapsuła integralna, 0 .pyc, poprawna własność katalogu koordynatora. Dane joba zachowane. Cache odtworzono wyłącznie do wcześniej pustego canonical FEM CPU root z przypiętego image f12e618dce9e212fc7f1be5947fa1e92acbb9736d4820eca892b5b7dbc2eebcc, bez pobierania toolchainu.
- Odczyt rustc jako użytkownik workera, bez sieci i z read-only cache: exit0, nightly 1.100.0, commit cea272fa356e94bd2ee2cadf376630aa0683867a. To dostępność narzędzia, nie build/solver. Audyt: docs/audits/2026-09-30-runner-nightly-cache-recovery.md.
- Następnie nowe zgłoszenie runtime-v2 po naprawie tej konkretnej przyczyny; Γ/DE/BV i odbiór aktualnego kompletu pól. Pełne S00–S12 i wszystkie bramki nauki oraz integracji pozostają otwarte.

## S04/S07 — kompletność publikacji pól modów

- Usunięto lukę odbioru: znalezione pola nie dowodziły obecności pól wszystkich opublikowanych modów w tej samej próbce. Obecnie wymagane identyczne zbiory sample/raw mode; brakujące i nieopublikowane pola są odrzucane przed rekonstrukcją.
- RED brakujący drugi mod; GREEN 19 testów pilota i 19 potencjału PASS. Osiem historycznych przypadków #173 consistent, raport w scientific-batches/published-mode-completeness-20260930/historical-job-173.json. Audyt: docs/audits/2026-09-30-published-mode-field-completeness.md.
- #184 nie zmieniano ani nie restartowano. Po jego wynikach obowiązuje dodatkowy odbiór aktualnym walidatorem. To spójność artefaktów, nie kwalifikacja fizyki/widma; pełny plan pozostaje otwarty.

## Aktualny checkpoint #184 i wykres DE/BV — 2026-09-30

- #184 / 5718d8d81e25496b966dd77c4d0ae1b0: live running; kontener fullmag-worker-5718d8d81e25496b966dd77c4d0ae1b0 i proces build_entrypoint potwierdzone. Katalog joba utworzył koordynator. Brak jeszcze dowodu kompilacji i nowych częstotliwości.
- Profil fem-cpu-slepc-runtime-v2; source digest e1f20c2f6c39f8a8247a8460249aed1fd1f31c5f9d011fdde973040f120b5310; native snapshot SHA-256 92ffea2e1e0a62cfeb7d5247f6bfa80e427022f65e4a19ab3cd8aff2cfa37da4. Snapshot HEAD 431a5f26047c8f6b1fc6d8326f6120d399a31373 wraz z WIP i jawnym tracking_mass.rs.
- Kapsuła 78d2a29fca6443b5bf933a3703355e67/source. Pełne verify_source PASS, 0 plików .pyc w drzewie po uruchomieniu obserwatora. Konfiguracja obserwatora znajduje się wyłącznie w scientific-batches/nonzero-k-validation/5718d8d81e25496b966dd77c4d0ae1b0. Sesja 18780 potwierdzona żywa; nie zgłoszono duplikatu.
- Po sukcesie builda: Γ L2/t3, następnie DE/BV k25 L2/t3/t6/t9; pierwszy błąd zatrzymuje serię do diagnozy. #182/#183 pozostają terminalne i zachowane.
- Zaktualizowany PNG/PDF/plot-receipt.json: scientific-batches/updated-de-bv-dispersion-20260930-v2. 27 historycznych rekordów FEM, sprawdzone hashe wejść, wspólne parametry SI, P00 i referencja N32, różnice procentowe oraz poziomy siatki. Obraz obejrzany; nie dodano hipotetycznych punktów #184. Producent: commit 22802948551fee0e83d5f58a5a6d0eb621c572f8, wysłany na remote.
- Oracle ma niezależną regresję granicy A=0 względem dokładnego magnetostatycznego DE oraz degeneracji Kittela w Γ: 7 testów Python PASS, commit 431a5f26047c8f6b1fc6d8326f6120d399a31373. To dowód referencji w określonej granicy, nie kwalifikacja FEM.
- Pełne S00–S12 pozostają otwarte: bieżący runtime i residuale, zbieżność grubości/siatki/airboxu, A1/COMSOL, interakcje, GPU, browser, review i integracja. Następny krok zależy od terminalnego wyniku tego samego joba #184.

## S12 — odrębna własność katalogu obserwatora

- #183 terminalny blocked przed kompilacją: Errno 17, katalog joba utworzony za wcześnie przez konfigurację kontrolera. Kapsuła integralna, bez bytecode.
- prepare_controller_config/CLI --prepare-job zapisują konfigurację wyłącznie w scientific-batches/nonzero-k-validation/<job-id>; runtime odrzuca konfigurację pod rootem koordynatora. 6 testów Python PASS.
- Kontroler 42767 terminalny exit1. Zachowano #182/#183 i ich kapsuły. Audyt: docs/audits/2026-09-30-observer-job-root-ownership.md.
- Następnie: nowe zgłoszenie runtime-v2 i kontrolowany setup obserwatora; potem Γ/DE/BV. Brak nowych częstotliwości, cały plan nadal otwarty.

## #183 running — poprawiony kontroler i integralność kapsuły

- Job #183: 57615a161f6d4db5bd475a3499b6c5ef, runtime-v2, running. Nowa kapsuła c0bc3613dc2f41d4a6ab24be7ca09bff/source.
- Source digest: 0eb811dfd3ce7672348ef882d6718390c038ce1923b6aa44b68ff635239988b7; native snapshot SHA-256: b333c864fd02ee3a72b72098988f864ce21bca082125bbd1d8490767ec803585.
- Snapshot bazuje na 60021c3b3daa7dda7fc9704f18ebafb00b6c611f oraz WIP z jawnym tracking_mass.rs. Nowe kontrole modu i rzeczywistej siatki są w kapsule #183.
- verify_source pełnej kapsuły PASS, 0 .pyc; kontroler 42767 żywy, build_state=running. Obserwuje przez klienta worktree z -B, zachowując niezmienne źródła.
- Seria po buildzie: Γ L2/t3; DE/BV k25 L2/t3/t6/t9. Pierwszy błąd zatrzyma serię. #182 terminalny blocked i zachowany; nie jest aktywnym buildem.
- 37 testów pól/pilota i 4 kontrolera PASS; 9/9 historycznych artefaktów #173 zgodnych również z przeliczoną topologią. Nie oznacza Poissona, zbieżności ani nowych częstotliwości.
- Następny krok: receipt #183 → seria → residual/provenance/topologia/demag → porównanie oracle i zbieżność. Pełny S00–S12 pozostaje otwarty.

## S12 — naprawa obserwatora niezmiennej kapsuły

- #182 terminalny blocked przed buildem; zachowano kapsułę. Przyczyna: 8 wygenerowanych .pyc, bez zmian/braków wersjonowanych plików.
- Nowy kontroler używa klienta worktree, -B i PYTHONDONTWRITEBYTECODE=1; blocked/interrupted kończą obserwację. 4 regresje Python PASS, w tym rzeczywisty import bez modyfikacji drzewa.
- Audyt: docs/audits/2026-09-30-capsule-observer-bytecode.md. Następnie: nowa kapsuła/runtime-v2, poprawiony kontroler i seria Γ/DE/BV. Brak nowych częstotliwości.

## S04/S07 — fingerprint siatki rekonstrukcji

- Pilot przelicza v3 z rzeczywistych metadanych; 37 testów Python PASS, 9/9 historycznych artefaktów #173 zgodnych również topologicznie.
- Audyt: docs/audits/2026-09-30-physical-potential-source-mesh.md. To spójność artefaktów, nie Poisson/zbieżność.
- #182 terminalny blocked przed buildem: dodatkowe bytecode w kapsule. Obserwator zatrzymany; kapsuła i źródła zachowane. Naprawa kontrolera i ponowienie: osobny przyrost.
- Pełne S00–S12 nadal otwarte; nowych częstotliwości brak.

## S04/S07 — kontrola tożsamości potencjału; miejsce zwolnione

- Pilot wymaga zgodnych deklaracji sample/mode, siatki, operatora i fazy oraz kanonicznych ścieżek; poprawny gradient sam nie wystarcza.
- 34 testy Python PASS; 9/9 historycznych artefaktów #173 consistent. Audyt: docs/audits/2026-09-30-physical-potential-mode-binding.md.
- Runner zdrowy, ostatni odczyt 18.48 GB wolnego; #181 running, #182 queued. Kontroler 31729 zachowany, bez duplikatu.
- Poprawka postprocessingu nie wchodzi do kapsuły #182; nowe wyniki sprawdzimy nią niezależnie. Nie ma jeszcze nowych częstotliwości ani dowodu zbieżności.
- Następnie: sukces #182 → Γ/DE/BV L2/t3/t6/t9 → audyt artefaktów → zbieżność i wykres. Pełne S00–S12 nadal otwarte.

## #182 queued — snapshot poprawionej siatki i kontroler Γ/DE/BV

- Commit 494443d64655b7f65e19bd79bc12b5ad19d26cd8 jest na remote.
- Job #182 / 116603d0835d4309b03b7981d23d89f8 / runtime-v2: queued za dwoma
  wcześniejszymi jobami. Digest 6265144754cfa99cc704b8df2517ac77cb7407063efd01d37e2048d2cd5dcc72.
- Snapshot zawiera wymagany untracked tracking_mass.rs; pełna tożsamość w audycie
  2026-09-30-layered-periodic-triangulation-fix.md. Kapsuły #179 nie zmieniano.
- Kontroler 31729 żywy, build_state=queued; po sukcesie wykona Γ L2/t3, następnie
  DE/BV k25 L2/t3/t6/t9; zatrzyma się przy pierwszym błędzie.
- Scientific page working/exact-staged/changed-revision PASS; validator 35 PASS.
  Runtime poprawionej siatki, nowe częstotliwości i pełne S00–S12: nadal otwarte.

## S04 — naprawa periodycznych przekątnych i granicy airboxu

- Seria #179 jest terminalna: sześć DE/BV 3/6/9 zakończyło się przed solverem
  na certyfikacie siatki. Nie ma nowego zaakceptowanego punktu f(k).
- RED real-Gmsh: wszystkie trójkąty x/y miały błędne przekątne mimo zgodnych węzłów.
- Pomocnicze prism6 dzielone są wspólną regułą na tet4; pionowe quad4 na tri3.
  Bez nowych węzłów, z zachowaniem regionów, exact layers i dodatnich wyznaczników.
- Poprawiono też magnetic–air interface zaliczany przez bbox do Gamma_out:
  exterior wyprowadzany jest z combined domain boundary.
- Lekka regresja: 26 + 5 PASS (31 różnych przypadków). Pary x/y, pełna incydencja ścian, objętość i płaszczyzny;
  Box 3/6/9 oraz ring 1/2/3 (nie rozszerzano ograniczeń ring).
- Rust v6 i managed solve poprawionej siatki: NOT VERIFIED. Nie wyłączono bramek.
  Ostatni live storage około 1.86 GB, admission 8 GiB; niczego nie usunięto.
- Następnie: managed snapshot runtime-v2 → Γ/DE/BV → residual/provenance →
  zbieżność grubości/airbox/lateral mesh i wykres; pełne S00–S12 nadal otwarte.

## #179 succeeded; oracle grubości i nowa blokada certyfikatu siatki

- Managed #179 succeeded/exit0; etap native-build exit0, receipt/hash gate
  domknięta przez koordynatora. Wcześniejszy snapshot/digest zachowany.
- Sesja 66068 rozpoczęła serię. DE t3 wrapper_exit1: certyfikat v6 ścian
  periodycznych odrzuca bijekcję/orientację; brak częstotliwości. Dalsze przypadki
  uruchamia istniejący kontroler. Nie uruchomiono duplikatu ani nie wyłączono bramki.
- Niezależny mały oracle grubości: N=1 odtwarza P00, uwzględnienie profili
  daje DE k25 około 13.641746349 GHz zamiast 13.673868177 GHz. BV zmienia
  się zaledwie o około 1.4 kHz. To referencja otwartego jednorodnego filmu.
- Pięć testów PASS, niezależna kwadratura tensora, N i kwadratura convergence;
  working i exact-staged scientific docs validator PASS. PNG/PDF/JSON w
  scientific-batches/analytic-thickness-oracle-20260930; PNG obejrzany.
- Audyt: docs/audits/2026-09-30-thickness-oracle-reference-budget.md.
  Referencja częściowo wyjaśnia błąd modelu P00, nie zamyka zbieżności FEM.
  S00–S12, nowe wyniki, A1/COMSOL, browser i integracja nadal otwarte.

## S12 — prawdziwe zdarzenie przejęcia i żywy worker #179

- Poprzedni turn był postępem: źródłowe dopracowanie selektora S07, checkpoint
  7e8e2d5d1e6f8ead0852807fdac8a376c6c2958d na remote; job179 przejęty.
- Kontener fullmag-worker-1d5451d2fee5443591a9c7f468569c43 potwierdzony przez
  Docker ps/top; aktywny proces python3. Wszystkie trzy kontrolery żywe.
  Log workera przy obserwacji nadal pusty, bez wyniku kompilacji ani solvera.
- Naprawiono job_claimed emitowane przed admission. Callback następuje po
  rzeczywistym claim; komunikat mówi o przygotowaniu. Przy waiting_for_disk
  nie ma fałszywego startu. expected_job_id zachowuje identyczność wyboru.
- RED dwie regresje koordynatora; GREEN 25+17 lekkich testów Python.
  Scoped diff check PASS. Audyt: docs/audits/2026-09-30-runner-claim-event-admission.md.
- Kod nie wdrożony do aktywnego koordynatora; wymagany późniejszy pusty slot
  i runtime proof. S07 Rust nadal WIP bez uruchomionych regresji.
  Pełny S00–S12, zbieżność, A1/COMSOL, browser i integracja nadal otwarte.

## #179 przejęty po zwolnieniu miejsca; dalsza poprawka S07 — 2026-09-30

- Użytkownik zwolnił miejsce. Live health pokazał 14703403008 B wolnego,
  worker_alive=true, accepting_jobs=true, worker_error=null.
- #179 ma running, updated_at=1790790044.1334934, nadal ten sam snapshot/digest.
  Sesja 66068 potwierdziła przejście na running; 28993/2072 również żywe.
  Nie zgłoszono duplikatu, nie wykonano cleanupu ani zmiany profili.
- Przy pierwszym sprawdzeniu nie było jeszcze kontenera workera ani logu;
  running oznacza przejęcie joba, nie dowód kompilacji. Wykonawca weryfikuje
  kapsułę i native identity przed utworzeniem execution. Bramka buildu otwarta.
  Powtarzające się wcześniejsze job_claimed były emitowane przed admission;
  nie dowodzą powtarzanych startów kompilacji. Ostatni wpis 17:40:43 UTC.
- S07 WIP dopracowany: wspólny selektor diagnostyki z kontrolą unikalnej
  tożsamości i obiektowego diagnostics; adapter fizycznego Kittela korzysta
  z niego zamiast własnego fallbacku do korzenia. Dodane regresje źródłowe.
  rustfmt/parser i scoped diff check exit0; testy Rust nie skompilowane,
  nie uruchomione. Zmiana nie wchodzi do wcześniejszego snapshotu #179.
- Szczegóły i aktualne hashe w audycie eigen-sample-diagnostics-identity.
  Pełny zakres S00–S12 nadal otwarty; nowych wyników solvera nie ma.

## Aktualny dostęp do runnera — 2026-09-30 17:34 UTC

- Sprawdzenie głównego klienta zwróciło `Container profile allow-list mismatch`.
  Porównanie katalogów profili wykazało, że klient głównego checkoutu nie zna
  `fem-cpu-slepc-runtime-v2`; zgodny klient tego worktree odczytał #179 poprawnie.
  Nie zmieniano konfiguracji runnera ani listy dopuszczonych profili.
- #179 nadal `queued`, ten sam digest e6d33f2ab37f1d529db133f12d0d45813fd2d89721121f740e7de3402e62d0fc.
  Live health: worker_alive=true, accepting_jobs=true, worker_error=null,
  active_jobs=[], coordinator.last_result.state=waiting_for_disk.
  Wolne miejsce 5613461504 B (około 5.23 GiB); próg przyjęcia 8 GiB.
- Sesje 66068, 28993 i 2072 zostały ponownie odpytane przez swoje uchwyty:
  wszystkie nadal działają, bez nowego wyjścia. Nie uznano samych plików control
  za dowód życia i nie uruchomiono drugiej serii.
- Przygotowana seria: DE/BV k=25 rad/um dla 3/6/9 warstw przez grubość,
  następnie Gamma L2/3 warstwy. Porównanie częstotliwości, residuali i profili
  nastąpi po poprawnym managed buildzie i rzeczywistych wynikach każdego przypadku.
- Prośba o usunięcie ośmiu dokładnych katalogów execution pozostaje bez odpowiedzi.
  Niczego nie usunięto. Przed ewentualnym usunięciem nadal obowiązują świeże
  kontrole zakończenia jobów, aktywnych użytkowników, mountów i bezpieczeństwa ścieżek.
- Brak nowych wyników z poprawionej siatki. S00–S12, zbieżność, A1/COMSOL,
  browser i integracja nadal niezamknięte. Ten checkpoint potwierdza oczekiwanie
  na konkretne żywe procesy, nie kwalifikację solvera ani całego rozszerzenia.

## S01 — naprawiona kontrola rewizji dokumentacji; aktualizacja storage

- Poprzedni turn był postępem: źródłowa poprawka tożsamości diagnostyki WIP,
  audyt b5a77f982d4f6ac4bbca81514f18181861bde1e6 na remote. Rust regresje nadal
  niewykonane; nie uznawać source-only jako zamknięcia S07.
- Naprawiono mieszanie source-map z commita z roboczą stroną i źródłami w
  changed-page checkerze. RED trzy regresje; GREEN pełne 35 testów Python.
  Nota 0831 na b5a77f982 przeszła realną kontrolę rewizji exit0.
  To dokumentacja/source anchoring, nie runtime/numerical qualification.
- Audyt: docs/audits/2026-09-30-scientific-doc-revision-validation.md.
- #179 nadal queued. Miejsce 5647167488 B; stare sześć execution nie wystarczy.
  Nowa prośba obejmuje osiem terminalnych jobów tego worktree (dodano #164/#159),
  ok. 3.32 GiB. Zastępuje poprzednią niezaakceptowaną prośbę. Zgody nie ma,
  niczego nie usunięto; po odpowiedzi wymagane świeże kontrole bezpieczeństwa.
- Pełny zakres S00–S12, nowe piloty, zbieżność, A1/COMSOL, browser i integracja
  pozostają otwarte. Nie podmieniano oczekujących snapshotów ani procesów.


## S07 — diagnostyka nie może pochodzić z obcej próbki

- Poprzedni turn: postęp 59ea8fd54093e89ed8b22d4adb9bf393e89d1528 na remote;
  poprawny payload Inspectora, dziewięć testów i replay artefaktu.
- Potwierdzono fallback pierwszej próbki w sample_native_solver_diagnostics.
  Przygotowano usunięcie fallbacku, unikalne dopasowanie sample_index oraz
  regresje brakującej/obcej/zdublowanej tożsamości. Stary GPU fixture otrzymał
  jawny indeks próbki. Zachowano pozostały WIP tests.rs.
- Parser rustfmt oraz diff check PASS; regresje Rust NIE uruchomione i NIE
  skompilowane (zakaz AGENTS.md). Kod pozostaje WIP, naprawa nieukończona.
  Wymagana właściwa bramka wykonawcza; nie traktować składni jako dowodu.
- Audyt: docs/audits/2026-09-30-eigen-sample-diagnostics-identity.md.
- Job #179 jest wcześniejszym snapshotem i nie zawiera nowej poprawki.
  Kontrolery 66068/28993 potwierdzono żywe, nie restartowano ich.
- Pełne S00–S12, runtime, fizyka/zbieżność, browser i integracja nadal otwarte.


## S07/S08 — korekta diagnozy certyfikatu i koperty zasobu

- Poprzedni turn: postęp ce954ba5d76741bc31011bdb9bf577baddbcbd44 na remote.
- Rzeczywisty writer FEM eigen_output już uzupełnia block_residuals w pliku
  modu; spectrum.v3 i mode #173 są zgodne. API zachowuje pola przez flatten.
  Poprzednia hipoteza braku eksportu całej ścieżki była zbyt szeroka.
- Właściwy błąd Inspector: odczyt zewnętrznego zasobu zamiast payload.
  Naprawiono ready/identyczność sample_index i raw_mode_index; stare dane
  po zmianie selekcji nie są używane jako metadane nowego modu.
- Dziewięć testów adaptera PASS. Replay rzeczywistego artefaktu #173 zachował
  residual względny 2.1580189814434916e-10 i pełny scope. To nie live API/browser.
- Audyt został poprawiony. Pozostałe realizacje, bieżący runtime/browser,
  zbieżność i pełne S00–S12 pozostają otwarte. Sesja 66068 potwierdzona żywa.


## S08 — jawna prezentacja residuali modu

- Poprzedni turn: postęp, b2ad1981e342ab5417d7da9267e1518cf787037e na remote;
  dokładny join widma/CSV i osobne scope w porównaniu analitycznym.
- Oddzielono absolute L2, relative L2 i wartość widma o nieokreślonym typie
  w Inspectorze; scope nie jest wyprowadzany z małego residualu.
- Siedem testów adaptera, strict typy adaptera, syntax staged panelu,
  API/architecture hygiene PASS. React Doctor exit0, dwie wcześniejsze uwagi.
  Pełny typecheck i browser pozostają NOT VERIFIED; bez instalacji zależności.
- S07 nadal wymaga propagacji certyfikatu v3 do metadanych modu/API z tożsamością
  próbki/modu. Brak opublikowanego scope pozostaje jawnie niedostępny w UI.
- Audyt: docs/audits/2026-09-30-eigen-inspector-residual-semantics.md.
- Sesja 66068 ponownie potwierdzona żywa; nie restartowano oczekujących pilotów.
  Pełen zakres S00–S12, A1/COMSOL i kwalifikacja/integracja nadal otwarte.


## Porównanie analityczne i zakres certyfikatów — aktualny checkpoint

- Poprzedni turn był postępem: commit 1f28560e4e7dae11b1808bb8278532dd6962dc32
  jest na remote. Obsługa wszystkich zadeklarowanych samplingów DE, rzeczywiste
  parametry SI i grubość filmu; 16 testów PASS w dokładnej wersji staged.
- Archiwalny DE L2 k25: 13.57898179883188 GHz, referencja n=0
  13.673868175350407 GHz, -0.6939249033391826%. To stara siatka, nie nowa
  zbieżność grubości ani wynik COMSOL A1.
- Nowa regresja wykazała pominięty mod natywnego widma w CSV oraz brak scope
  w podsumowaniu residuali. Naprawiono kompletność joinu i podział maksimum
  według scope; raport nadal NOT VERIFIED. 11+6 testów PASS.
- #179 nadal queued (potwierdzone klientem runnera), ten sam digest i profil.
  Wolne miejsce 6271270912 B, poniżej 8 GiB. Procesy 66068/2072 żywe;
  nie restartowano ich. Oczekująca zgoda na sześć execution nie nadeszła.
- Kontrola exact staged źródeł/mapy jest oddzielna od changed-page checkera,
  który łączy mapę commita z roboczą treścią strony. Ten drugi ujawnił siedem
  rozbieżności symbolów z pozostałego WIP; nie nadpisano tych zmian.
- Zakres S00–S12 pozostaje bez zmian: nowe runtime, zbieżność i profile,
  Gamma, airbox, ścieżka k, A1/COMSOL, API/UI, GPU, review i integracja.


## #178 blocked, aktualizacja runnera i przejęcie przez #179 — 2026-09-30 16:06 UTC

Ta sekcja zastępuje wcześniejsze informacje o running #178 i żywych sesjach
45879/48887/83846 oraz o niewdrożonej poprawce inwentaryzacji.

- #178 blocked: brak 8 GiB po weryfikacji źródeł; zapisany CoordinatorError.
  Stare kontrolery terminalne exit 1; brak prób i nowych częstotliwości.
- Przy pustym aktywnym slocie wykonano drain i wcześniej autoryzowaną wymianę
  koordynatora na 7fa7a4a8...; pełny SHA i dowody w audycie inwentaryzacji.
  Siedem profili i oczekujące tożsamości źródeł zachowane; kolejka wznowiona.
  Wdrożone pliki mają zgodne hashe. Rzeczywisty UI pokazuje #179/#180 w FIFO.
- Kod poprawki i remote: 92c7facc3f8400e7409c22d583919aa3741aefc2.
  37 testów Python, zestaw JS i fixture browser PASS; wydajność dużego skanu
  pozostaje osobną bramką. Nie przypisywać resetu starych żądań samemu cache.
- #179 1d5451d2fee5443591a9c7f468569c43 queued, oczekiwanie na storage;
  digest e6d33f2ab37f1d529db133f12d0d45813fd2d89721121f740e7de3402e62d0fc.
  Podpięto istniejący build zamiast zlecać nowy. Model Box nadal 11155c55e.
- Nowe sesje żywe: 66068 (DE/BV 3/6/9), 28993 (kolektor/Poisson/plot),
  2072 (Γ L2, 3 warstwy, pełne okno). Control poza namespace managed joba.
- Ostatnie wolne miejsce 6547595264 B (~6.10 GiB) przy minimum 8 GiB.
  Poproszono o zgodę wyłącznie na sześć execution #173/#171/#170/#169/#167/#165
  (~2.49 GiB). Niczego nie usunięto. Ponowna ocena po odpowiedzi obowiązkowa.
- S00–S12 nadal w toku: runtime i nauka, airbox/mody/k-path, A1/COMSOL,
  tracking/API/UI/GPU, review i pełna integracja/cleanup; cel nieukończony.

## Runner — ograniczenie powtarzanych skanów 2026-09-30 15:45 UTC

- Poprzedni turn: postęp, commit e31b7522da61e3dee42c76031ab44d3a65423227
  wysłany; kontrola tożsamości receiptów nie zmieniła żywych zależności pilotów.
- #178 nadal running bez terminalnego exit code; #179 queued. Sesje 45879,
  48887 i 83846 ponownie potwierdzono żywe. Nadal brak nowych częstotliwości.
- Odtworzono i naprawiono nakładanie pełnych skanów storage, cache wygasający
  jeszcze w trakcie odczytu oraz powtarzane żądania widoku StorageView.
- 37 testów Python PASS; zestaw Runner Console JS PASS; browser fixture 8/8
  widoków i stany błędu/recovery PASS. To źródła i fixture, nie wdrożenie.
- Nie podmieniono aktywnego koordynatora; poprawka wymaga nowego obrazu
  po zakończeniu aktywnego slotu, z zachowaniem profili i kolejki. Nie ma
  dowodu, że skany są jedyną przyczyną oczekiwania #178.
- Audyt: docs/audits/2026-09-30-runner-inventory-concurrency.md.
- Pełny zakres S00–S12 zachowany. Dalej odbiór runtime/pilotów i certyfikatów,
  grubość/airbox/mody, Γ/BV i k-path, A1/COMSOL, tracking/API/UI/GPU,
  review oraz integracja/cleanup. Cel nieukończony.

## Odbiór Γ i kontrola porównania — 2026-09-30 15:25 UTC

- Poprzedni turn był zweryfikowanym oczekiwaniem: ponownie potwierdzono żywe
  sesje 45879, 48887 i 83846 oraz aktywny job #178; #179 nadal queued.
- #178 d3584c72f1d74300834aaca396902df6: running, brak terminalnego exit code.
  Na pomiarze 15:19 UTC brak run_root; koordynator działa, około 100% CPU.
  Nie utożsamiać statusu running z właściwą kompilacją. Nie restartowano joba.
- Γ k=0: sesja 83846 czeka na zakończenie batchu sześciu prób warstw.
  L2, 3 warstwy, EPS prefilter 1e-10, shifted KSP 1e-12; pełne okno
  i końcowy residual 1e-8 zachowane. To ten sam runtime #178/model 11155c55e.
  Helper SHA 8f0e9c394b40e65a81c8ab8cb95a91164d339c05ee5a7330ae3236214807f318.
  Control poza namespace joba: scientific-batches/gamma-l2-t3-<job178>.
- A1: krok relaksacji 5 fs poniżej odtworzonego oszacowania plannera 194.31 fs
  na rzeczywistej siatce (h_min 3.3333 nm); commit 06d4cfef7b1321dc99da62e60f273e6812d897cb.
  Jest to odtworzenie wzoru plannera, nie dowód stabilności ani relaksacji.
- Naprawiono kontrolę receiptów porównania DE: ścisły kod procesu, model_source,
  pilot/cases/operation; 15 testów +19 podtestów PASS. Nie zmieniono żywych
  kontrolerów ani ich przypiętych zależności. Audyt:
  docs/audits/2026-09-30-de-comparison-receipt-identity.md.
- Nadal brak nowych częstotliwości z poprawionej siatki. Pozostają wszystkie
  bramki S00–S12: Γ/BV, grubość/airbox/mody, ścieżka k, A1/COMSOL,
  tracking/API/UI/GPU oraz review/integracja/cleanup.

## Piloci DE/BV i odbior wykresu — 2026-09-30 14:36 UTC

- #177 zakonczony managed succeeded/exit 0; #178 running, #179 queued.
  Nie restartowano jobow. Wczesniejszy stan queued #178 jest nieaktualny.
- #178: d3584c72f1d74300834aaca396902df6; obserwator pilotow sesja 45879
  zyje i czeka na terminalny receipt/ABI/hash. Po nim szesc DE/BV k25 L2
  dla 3/6/9 warstw. Jeszcze brak nowych czestotliwosci.
- Kolektor zapisany na remote: 045812272c6fbe9057e120b069b00571f24c5161.
  Wykres zapisany na remote: 467634149554900bdc59147833baca29ef179658.
  46 testow +38 podtestow PASS; staged mapa naukowa PASS.
- Wykres pokazuje f(n_z) i roznice od n=0, osobno DE i BV. To kontrola
  grubosci przy stalym k, nie krzywa f(k); nie ma ekstrapolacji.
  Rzeczywisty PNG/PDF i ich QA dopiero po zweryfikowanych wynikach solvera.
- Odbior jednorazowy: sesja 48887, waiting_for_pilots, potwierdzona zywa.
  Helper SHA e2289d958dd4ccdf4379939fedf47364fe80150733ba3485e39fcda0f9c22ec1.
  Nie zmieniono zywego obserwatora 45879. Control i wyniki odbioru sa w
  runs/<worktree-id>/scientific-batches/thickness-l2-<job178>/postprocessing,
  poza managed namespace. Pinned zaleznosci, receipt hash i tozsamosc batchu.
- Po sukcesie wszystkich szesciu wrapperow: collector -> niezalezny Poisson
  -> plot PNG/PDF. Bledy i zmiana zrodel daja requires_attention; nie sa
  zamieniane na dane analityczne. Finalne NOT VERIFIED wymaga oceny naukowej.
- Pelny cel S00-S12 pozostaje otwarty: Gamma/BV, airbox/mody, sciezka k,
  A1/COMSOL, tracking/API/UI/GPU oraz review/integracja/cleanup.
- Audyt: docs/audits/2026-09-30-de-bv-thickness-collector.md.

## A1 — poprawki realizacji powietrza i rozdzielczosci 2026-09-30

- Naprawiono rzeczywiste stopniowanie zewnętrznego powietrza ring/A1:
  8571183d2fc36d7c4b72a82a355d1ae05122703b (remote).
- Rozdzielono hmax powierzchni x/y i liczbe warstw filmu:
  4ad72fe03d3d0420a411373cf75ca56103a84c9a (remote).
- Regresje RED/GREEN: stare powietrze 200 nm przy zadanym 50 nm;
  stara siatka x/y zmieniala sie z n. Obie przyczyny poprawione.
  79 testow +15 podtestow PASS; staged mapa naukowa PASS.
- Publiczna recepta A1: 102424 wezly, 574620 Tet4, powietrze <=100 nm,
  film <=3.33334 nm, dodatnie objetosci, objetosc komorki zgodna.
  Jest to generacja, nie wynik eigensolve ani zgodnosc COMSOL.
- Nowa kapsula #179 1d5451d2fee5443591a9c7f468569c43, runtime-v2, queued;
  digest e6d33f2ab37f1d529db133f12d0d45813fd2d89721121f740e7de3402e62d0fc.
  #178 i obserwator 45879 zachowane dla pilotow Box DE/BV.
- Dalej: odbior runtime/receipt, szesc pilotow warstw DE/BV, niezalezny
  Poisson/profile, Gamma i BV, zbieznosc airboxu, sciezka k i A1/COMSOL.
  Tracking/API/UI/GPU i integracja S00-S12 nadal niezamkniete.
- Audyt: docs/audits/2026-09-30-ring-air-layer-realization.md.

## Aktualny runtime i rozdzielczość filmu — 2026-09-30 (po #176)

Ta sekcja zastępuje wcześniejsze statusy #176 oraz sesji 69118.

- Rzeczywista generacja warstw i szwów: commity 61a53f4a, d050d46f,
  11155c55e76f321ec0bb62399e7a0494655003f9; wszystkie wysłane na remote.
- 75 interpretowanych testów + 15 subtests PASS. Mapy źródeł i dokładnie
  staged dokument naukowy przeszły walidację. Nie kompilowano unit tests.
- Wariant bez lokalnych pól: przed poprawką 5/5 pozycji x/y dla hmax 10/5 nm;
  po poprawce 31/99. Warstwy 3/6/9 mają zgodne płaszczyzny, dodatnie objętości,
  kompletną periodyczność także w powietrzu i orientowane fazy +/-25 rad/µm.
- #176: f1b0ffd6a64c4202864fbcb92f9cb8fd.
  Jest terminalnie blocked przed kontenerem. Obserwator agenta utworzył run_root
  za wcześnie; nie jest to awaria fizyki ani storage admission. Żaden pilot
  nie ruszył. Sesja 69118 zakończona; źródła i diagnostyka zachowane.
- Nowy #178: d3584c72f1d74300834aaca396902df6, runtime-v2, queued.
  Digest: 92baf77db14db593e4aaf0d268bde62b4f26e4e0933e7423fb2eda3315ae5e62.
  Snapshot bazuje na 11155c55e; zawiera bieżący WIP i tracking_mass.rs.
- Poprawiony obserwator: sesja 45879; działa i czeka na #178. Kontrolę zapisuje
  w runs/<worktree-id>/scientific-batches/thickness-l2-<job-id>, poza managed
  run_root. Potwierdzono brak przedwczesnego utworzenia katalogu #178.
  Po succeeded/exit 0: sześć pilotów DE/BV k25 L2, warstwy 3/6/9, każdy przez
  run_de_100nm_pilot.py i istniejące pełne kontrole. Finalny residual 1e-8
  pozostaje bez zmiany. Wyniki dopiero po receipt/ABI/hash i odbiorze artefaktów.
- Nadal wymagane: niezależny Poisson, profile, zbieżność warstw/airboxu,
  Γ i BV, ścieżka k, A1/COMSOL, tracking/API/UI/GPU i integracja S00–S12.
  Ring ma historyczne pojedyncze zewnętrzne slaby powietrza; przed A1 należy
  sprawdzić i poprawić realizację stopniowania z, nie przyjmować samego pola
  rozmiaru Gmsh za dowód rozdzielczości strukturalnej ekstruzji.
- Audyt: docs/audits/2026-09-30-box-film-layer-realization.md.
  Nie ma jeszcze częstotliwości z nowej siatki; cały cel nieukończony.


## Realizacja warstw Box — nowy checkpoint 2026-09-30

- Naprawiono rzeczywiste warstwy Tet4 Box/shared-domain oraz zewnętrzne
  szwy periodyczne. Pełny publiczny przykład DE realizuje 6 warstw;
  testy obejmują 3/6/9, niezależne płaszczyzny powietrza i ring.
- 70 interpretowanych testów + 15 subtests PASS; dokument naukowy
  i dokładnie staged mapa źródeł przeszły walidator.
- Commit i remote: 61a53f4afa668d55311ead9de7b1b659d2a41706.
- Managed #176, job f1b0ffd6a64c4202864fbcb92f9cb8fd, runtime-v2,
  snapshot digest 7fe584ed5a115a68449a5eb75629880bd3dc27c728693d4cc3fb321fd533710e.
  Zgłoszenie potwierdzone, oczekuje za obcym jobem #175. Nie restartować
  po timeoutach obserwatora. Brak jeszcze wyniku solvera z nowego generatora.
- Po succeeded: zweryfikować receipt/ABI/hash, uruchomić DE/BV k25
  dla 3/6/9 warstw przy stałym hmax i airboxie, sprawdzić rzeczywisty
  pionowy span, Poissona i pełny residual; następnie zbieżność i ścieżkę k.
- Raport actual_method poprawiony: geo_layered_tetrahedral, realizacja z.
  Linear jawnie odrzucane przed Gmsh; obsługa linear nadal niezaimplementowana.
  Błędne kontrole n_layers/hmax też odrzucane przed Gmsh.
  74 testy + 15 subtests PASS, starszy raport feature-aware: 1 PASS.
  Commit i remote: d050d46fc6165f348a3a301b1333862685133e9f.
  #176 nie zawiera tego uzupełnienia raportowania; metoda geometryczna
  benchmarku geometric jest taka sama. Nie przypisywać #176 nowego HEAD.
- Audyt: docs/audits/2026-09-30-box-film-layer-realization.md.
  Cały cel S00–S12 nadal nieukończony; Γ, BV, COMSOL/A1, tracking,
  UI/GPU i integracja pozostają odrębnymi bramkami.

## Aktualny checkpoint zbieżności — 2026-09-30

Ta sekcja zastępuje wcześniejsze informacje o aktywnych pilotach 64887/11042.
Oba procesy są zakończone; nie pozostał aktywny pilot.

- k25: DE L0/L1/L2/L3 = 13.384204251/13.436508613/13.578981799/13.596286127 GHz.
  Różnica wobec n=0: -2.118/-1.736/-0.694/-0.567%.
- BV L0/L2 = 9.664769493/9.740140954 GHz; -0.981/-0.209% wobec n=0.
  BV L1/L3 niezaakceptowane: pełny residual lub awaria SLEPc.
- Niezależny Poisson dla sześciu zaakceptowanych punktów: max 2.45e-14.
- Γ L0: sonda demagu passed, lecz certyfikat okna failed (48/50 podokien).
  Brak zaakceptowanego punktu Γ; nie zamykać S00.
- Nowy parametr 3/6/9 warstw, commit d68496b55eb36e1e89544ef9803e8e6a8f704d02,
  wysłany; 59 testów + 15 subtests PASS. Rzeczywisty run t6 ujawnił
  ignorowanie warstw przez Box free-tet: identyczna siatka jak t3.
- Naprawiono bramkę: pomiar rzeczywistego pionowego span Tet4 odrzuca t6
  (10 nm zamiast <=1.666667 nm). Metadane nie dowodzą realizacji.
  Same badania zbieżności przez grubość nadal NOT VERIFIED.
- Naprawa bramki i audyt zapisane oraz wysłane:
  2cea9bc4cfc7d5acd8d44b0a576802d944c49354.
  59 testów + 15 subtests PASS; rzeczywisty run t6 odrzucony przez nową kontrolę.
- Raport: docs/audits/2026-09-30-de-bv-mesh-convergence.md.
- Dalej: realizacja warstw Box/shared-domain, awarie BV i Γ, airbox,
  pełna ścieżka, A1/COMSOL, tracking/API/UI/GPU i integracja S00–S12.


## Aktualny odbiór runtime — 2026-09-30

Ta sekcja zastępuje historyczne informacje o trwającym buildzie #173
oraz oczekującym wdrożeniu panelu kolejki.

- #173: succeeded, exit 0; receipt/hash/source sprawdzone przed solve.
- DE/BV k7 L0: nowe completed_unqualified, eps_full 2.37e-10/2.27e-10.
- Niezależny Poisson z obu zapisanych pól: max 7.62e-15.
  Naprawa wspólnej skali q/phi potwierdzona w tych dwóch przypadkach.
- f: DE 10.669228396 GHz, BV 9.235504955 GHz.
  Różnica wobec n=0 odpowiednio -0.228451% i -0.085740%.
- Koordynator b8b00a8e wdrożony; zachowano profile i obcy job,
  kolejka wznowiona. Browser pokazuje tabelę bez response_too_large.
- k25 L0: DE 13.384204251 GHz, BV 9.664769493 GHz, zaakceptowane.
- DE k25 L1: pierwszy pilot zatrzymany przez filtr EPS 1e-11
  (estimate 1.66e-11). Retry z EPS 1e-10: 13.436508613 GHz,
  eps_full 1.93e-9; końcowy próg 1e-8 zachowany.
- Niezależny Poisson dla tych trzech punktów: max 7.81e-15.
  Różnica DE wobec n=0 maleje 2.12% -> 1.74%; L2 nadal potrzebne.
- BV L1 EPS 1e-10 zakończył się failed: pierwsze okno estimate 5.07e-10,
  brak zaakceptowanego moda; drugi kandydat poza swoim oknem.
  Nie traktować wartości kandydata 9.692659902 GHz jako wyniku.
- Proces 64887 wykonuje DE L2 EPS 1e-10, BV L1/L2 EPS 1e-9,
  z dokładniejszym shifted KSP 1e-12. Końcowy próg nadal 1e-8.
  Sesja 77607 jest terminalna; nowych runów nie nadpisano.
  Nie restartować 64887 na podstawie timeoutu obserwacji.
- Poprawka q/phi z raportem runtime zacommitowana i wysłana:
  e014283d22c062722d5e1699fb005976c31d2f4a.
- 10 interpretowanych regresji Poissona PASS; brak kompilacji unit tests.
- Raport: docs/audits/2026-09-30-de-bv-coupled-normalization-runtime.md.
- Pozostałe bramki S00–S12 otwarte; kwalifikacja NOT VERIFIED.


## Checkpoint integralności porównania — 2026-09-30

Parametry diagnostyki są teraz porównywane z dokładnie hash-bound metadata.json
runu: Ms, A, gamma0, grubość, pole bias, orientacja DE/BV i Dirichlet.
Brak/duplikat hasha lub zmiana bajtów między kontrolą a parserem są odrzucane.
9 interpretowanych regresji PASS (w tym subcases parametrów), rzeczywisty
archiwalny mod PASS, staged scientific source-map exit 0.
Ponowna kontrola 19 archiwów z walidacją parametrów zachowała poprzednią
wynikową diagnozę; max Poisson residual 0.16636683689726586, brak fitowania.
Commit ce778712cb177bc814ab0502fd35215b292bd02d wysłany na branch zadania.
To przyrost diagnostyki; nie jest nową częstotliwością ani kwalifikacją solvera.

#173: pierwszy release launcher/FEM zakończył kompilację w 15m 58s;
API nadal w budowie. Brak terminalnego receipt. Wdrożenie UI i piloci nadal
oczekują; aktywny job oraz obserwator wdrożenia nie są restartowani.


## Dodatkowa naprawa runner UI — 2026-09-30

response_too_large: kompaktowe podsumowania list API v1, filtr aktywnej kolejki
przed pagination, wszystkie strony FIFO w widoku. 23 testy backend + 13 API
oraz suite JS PASS. Commit 9cd5d9939 wysłany. Obraz b8b00a8e gotowy.
Graceful drain zachowuje aktywny build #173 i oczekujący obcy job.
Wdrożenie i browser proof oczekują; nie jest to ukończona bramka solvera.
Raport: docs/audits/2026-09-30-runner-queue-response.md.





## Najnowszy checkpoint — 2026-09-30: diagnoza f(k), runtime-v2

Ta sekcja ma pierwszeństwo przed starszymi checkpointami w tym zakresie.

- Niezależne równanie magnetyczne na archiwalnych polach: 13 spójnych par,
  max residual 2.7733e-10. Sześć niespójnych q/phi nadal odrzuconych.
- Niezależna dwufunkcyjna projekcja Ritz na tej samej siatce odtwarza niemal
  cały spadek częstotliwości względem analityki: przy k25 DE 13.393452 GHz
  vs Fullmag 13.384204 GHz vs analityka 13.673868 GHz. Główny trop: P1 demag.
  Oba narzędzia eksploracyjne; nie zastępują produkcyjnego solve ani zbieżności.
- Ciągły kernel z Dirichletem i 2 µm paddingu przy k25 zgadza się z otwartą
  analityką do pokazanej precyzji. Duży spadek Nzz w FEM nie wynika z tego
  zewnętrznego warunku. Weryfikacja Gamma/małych k i pełnej zbieżności otwarta.
- Użytkownik jawnie zezwolił na runtime-v2 i potrzebną aktualizację runnera.
  Zbudowano toolchain CPU: f12e618dce9e212fc7f1be5947fa1e92acbb9736d4820eca892b5b7dbc2eebcc.
  MFEM i HYPRE bez CUDA, rzeczywisty loader HYPRE w prefixie CPU sprawdzony.
  Kod źródłowy kanonicznego obrazu również poprawiono: CPU MFEM nie może
  używać HYPRE z CUDA. Pełny kanoniczny Dockerfile nie był osobno przebudowany.
- Aktywacja tylko runtime-v2 zachowuje wcześniejsze profile/token/tożsamość;
  również po późniejszym upgrade current-contracts. 23 testy + 4 subtests PASS.
- Nowy koordynator: 24c6f2f856f18d4bff5a6ca036b8ef1a96dc235619e5a5cf506c53fcc9a7cb66.
  Wymiana zakończona po terminalnym zakończeniu cudzego joba #172.
  Live health: ok=true, worker_alive=true, accepting_jobs=true, worker_error=null.
  Wcześniejsze profile zachowane; dodano wyłącznie runtime-v2.
  Build #173 (1b7399298fe9453eba0c432eef1a2f62) działa w runtime-v2;
  snapshot ddf56cfe3b8f1db7b23c0026f7018803c734c07d866cdcdaa4140ab0f39b86b7,
  baza 12f90bd08be257116ed2797cf3e62c42d8f06202, tracking_mass.rs w kapsule.
  Brak terminalnego receipt i nowych wyników solvera; kwalifikacja otwarta.
  Kontener f6e089418f1cb1e14432465514cb86d07df5363bb271af88ac81322b403d26d1
  running=true; start 2026-09-30T10:37:50Z. Przygotowanie kapsuły zakończone.
  Przyrost aktywacji profili zapisany i wysłany:
  f60fc7e3f796bd434dcae90cd4cd428dd451624d (23 testy + 4 subtests PASS).
  Snapshot buildu zachowuje poprzednią bazę; commit nie zmienia jego kapsuły.
- Po wymianie: konfiguracja immutable toolchain ID, snapshot z tracking_mass.rs,
  build runtime-v2 bez unit tests, weryfikacja receipt/loader/source, DE/BV k7 L0,
  następnie DE/BV k25 L0/L1/L2 z tym samym modelem i pierwotnym progiem 1e-8.
  Nowych produkcyjnych częstotliwości jeszcze nie ma.
- Raport: docs/audits/2026-09-30-de-bv-frequency-discrepancy.md.


## Najnowszy checkpoint — 2026-09-30: błąd skali q/phi (WIP)

Ta sekcja ma pierwszeństwo w zakresie spójności sprzężonych pól.
Niezależny Poisson: 13/19 par zgodnych do ~1e-14; 6/19 residual
0.089…0.1664. BV k=7,15,20,22,25 i DE k=7 rad/µm.
Potwierdzony błąd źródła: window dedup normalizował tylko q, pozostawiając
phi i certyfikaty w starej skali. Poprawka zachowuje cały oryginalny mod;
normalizowane kopie są tylko do overlap. C++ pozostaje WIP bez managed
wykonania. Częstotliwości niezmienione; ich różnica z analityką nadal otwarta.
Nie zmieniono progu residualu, nie naprawiano archiwów przez fit skali.
Szczegóły i dalsze bramki: docs/audits/2026-09-30-de-bv-coupled-normalization.md.
Audyt/narzędzie/notę zapisano i wysłano: 86f784bb9224bf68fc84dd020515409699f309dd.
10 interpretowanych regresji PASS; staged source-map exit 0. Poprawka C++
pozostaje poza commitem, jako WIP. Brak nowego uruchomienia solvera.


## Najnowszy checkpoint — 2026-09-30: S07 persisted consistent P1 (WIP)

Ta sekcja ma pierwszeństwo przed starszymi checkpointami poniżej.

- Oba writery metadanych zapisują wersjonowany rekord metryki consistent P1.
  Odtwarzanie waliduje definicję, siatkę, uporządkowane węzły, tetra i objętości.
- Adapter Kittel wybiera fizyczne węzły z pełnego pola i zachowuje pełne lifted
  real/imag; nie traci metryki podczas ponownego odczytu. Wadliwe/mieszane
  dane są odrzucane. Starsze artefakty mają jawny legacy zakres.
- Rustfmt parse/check exit 0, source-map exit 0, 32 testy dokumentacji PASS.
  Cztery nowe regresje Rust NOT RUN; źródła pozostają niezacommitowanym WIP.
- Kolejny przyrost S07 usuwa ciche filtrowanie/obcinanie pól i wag legacy,
  wymusza unique binary/metadata oraz sample/raw/Gamma identity.
  Dodano 4 dalsze regresje Rust NOT RUN (łącznie 8 dla persistence/reader).
  Focused source-map, Rustfmt parse/check i diff check: exit 0.
- Dalszy przyrost usuwa Euclidean/lifted fallback po błędzie zadeklarowanej
  metryki w samym selektorze Gamma i wymaga kompletnych lifted real/imag.
  Dwie dalsze regresje Rust NOT RUN (łącznie 10 persistence/reader/selector).
  Rustfmt parse/check, source-map i diff check exit 0. Źródła nadal WIP.
- Usunięto hardkodowany zerowy seam modu. Brak pomiaru daje pustą komórkę
  CSV oraz status partial; frequency_comparison_status jest oddzielny.
  Nowa interpretowana regresja bramki + kompletny fixture: 2 PASS.
  Dwie zmienione regresje Rust NOT RUN. Obliczenie seam nadal otwarte.
- Aktualny live runner ma 8 950 689 792 B, powyżej 8 GiB, bez aktywnych
  jobów. Blokada miejsca ustąpiła. Nadal blokuje runtime-only poza allow-list
  oraz zakaz kompilacji unit tests; nie zmieniono runnera ani nie zlecono joba.
- Pomiar magnetycznego seam jest teraz w źródłowym adapterze periodic/floquet:
  fizyczne Cartesian pole, rzeczywiste slave/root phase, normalizacja amplitudy.
  Rekordy są związane z mesh/sample/raw/k/frequency; Kittel odczytuje tylko
  zgodny pojedynczy rekord. Brak par/pola nie daje zera. Dwie regresje Rust
  NOT RUN. Rustfmt/source-map/diff exit 0. Źródła WIP, nie wykonanie solvera.
- Sama dostępność pomiaru nadal daje partial/NOT VERIFIED: tolerancja seam,
  phi/airbox i managed runtime pozostają otwarte. Nowych częstotliwości brak.
- Niezależnie zbadano 19 archiwalnych modów na jawnych parach siatki:
  28 magnetycznych par/mod; max względny defekt fazowego zszycia
  3.3852323788985243e-16. Odwrócony znak daje 0.1598…1.68294,
  pominięta faza 0.07997…0.95885. Narzędzie Python: 7 PASS.
  To rzeczywiste historyczne pola, nie wykonanie nowego Rust ani phi.
  Nie zmieniono częstotliwości i nie zwiększono liczby punktów.
- Zweryfikowany przyrost narzędzia audytu i jego naukowej dokumentacji zapisano
  i wysłano: bd70b6d9215662fe10b5a21180402fb95b253593. Staged source-map
  exit 0; staged źródła narzędzi zgodne z przetestowanymi. Pozostały solver
  WIP nie został dołączony. Cały plan i integracja pozostają nieukończone.
- Archiwalne phi/H_demag z 19 modów: pełne phi na 1980 węzłach,
  1195 par/mod, defekt Floqueta ≤2.2887833992611187e-16; phi=0 na
  obu zewnętrznych płaszczyznach z. Niezależny P1 -grad(phi) zgodny
  z elementowym H_demag: max względny L2=1.6741805960076105e-15.
  Interpretowane regresje: 6 PASS. To spójność historycznych pól,
  nie niezależny Poisson, weak flux, zbieżność ani nowy Rust/solve.
- Kontrolę archiwalnego phi/H_demag i jej dokumentację zapisano i wysłano:
  3d7690c1a39adfed4bbc4757b060a5f257cf9694. Staged source-map exit 0, staged
  narzędzia zgodne z przetestowanymi; solver WIP poza tym commitem.
- S07 pozostaje otwarty: kompilacja/runtime, pełna identity i odtwarzanie
  nonzero-k branch transport, współdzielony artefakt metryki/API provenance.
- Nowych częstotliwości brak; nadal 19 punktów. Runtime-only niedopuszczony,
  zakaz kompilacji unit tests trwa. Aktualny live odczyt miejsca podano wyżej.
  Nie usuwano danych ani nie zmieniano runnera.
- Cały S00–S12 pozostaje aktywny; ten checkpoint nie zamyka celu.

Dowody: [S07 persistence](../../audits/2026-09-30-s07-consistent-mass-persistence.md).

## Najnowszy checkpoint — 2026-09-30: produkcyjna metryka consistent P1 (WIP)

Ta sekcja ma pierwszeństwo przed starszymi checkpointami poniżej.

- W źródłach wdrożono exact consistent tet4 mass dla overlapu, transportu
  podprzestrzeni i projekcji na mod jednorodny Gamma. Lokalny embedding
  nie tworzy gęstej macierzy globalnej. Ramki wracają do nodalnych envelope.
- Adapter zachowuje wszystkie fizyczne węzły magnetyczne, także slave PBC,
  wiąże pole z fingerprintem pełnej siatki oraz współdzieli metrykę Arc/cache.
  Niezgodna lub asymetryczna metryka nie przechodzi na euklidesowy fallback.
- Niezależna kontrola formuły na 19 modach i 17 parach: max defekt normy
  4.4343018897494473e-16, recovery 1.7245868222581087e-16, overlap
  kwadratowego 8.881784197001252e-16. To nie wykonanie nowego Rust.
- Rustfmt parse/check: exit 0. Przygotowano łącznie 15 regresji Rust dla
  payload/envelope i nowej metryki; żadnej nie kompilowano/nie uruchomiono.
  Źródła pozostają niezacommitowanym WIP. Nowy tracking_mass.rs jest untracked;
  przed snapshot buildem wymaga explicit include-untracked.
- S06 nadal otwarty: kompilacja, regresje i runtime wspólnej ścieżki,
  pełna identity equilibrium oraz crossing/gap/subspace qualification.
  S07: persisted provenance i odtwarzanie metryki przy ponownym odczycie.
- Runtime zablokowany: runner zdrowy, bez jobów, 5 108 162 560 B wolnego
  przy progu 8 GiB, runtime-only poza allow-list. fem-cpu-release ma SLEPc
  OFF, więc nie zastępuje modalnego profilu. Decyzje operatora i zakaz
  kompilacji unit tests są nadal aktualne.
- Wyniki nadal 19 punktów; nowych częstotliwości i nowego wykresu brak.
  Cały S00–S12, A1/COMSOL, zbieżność, UI, GPU i integracja pozostają aktywne.

Dowody: [realizacja consistent mass](../../audits/2026-09-30-s06-consistent-mass-implementation.md).

## Najnowszy checkpoint — 2026-09-30: S06, payload trackingu i faza Blocha (WIP)

Ta sekcja ma pierwszeństwo przed starszymi checkpointami poniżej.

- W roboczych źródłach adapter trackingu nie usuwa już wadliwych wierszy
  real/imag ani nie zastępuje brakujących komponentów zerami. Wiąże pełną
  długość pól z siatką oraz raw ID/k z punktem ścieżki; sprawdza selekcję węzłów.
- Dla Floqueta odfazowuje przestrzenny mod do nodalnego envelope przez
  exp(+i k·r). Publikowane pola i temporalny phasor pozostają oddzielne.
- Sprawdzono struktury i tożsamości 19 historycznych modów (1980 węzłów).
  Legacy JSON i bound binary po odfazowaniu mają defekt względny 0.0.
  To kontrola rzeczywistych danych wejściowych, nie wykonanie zmienionego Rust.
- Rustfmt parse/check trzech plików: exit 0. Osiem regresji Rust dodano,
  ale ich nie kompilowano ani nie uruchamiano. Źródła pozostają WIP,
  niezacommitowane; wymagają builda i regresji/runtime przed zaliczeniem.
- S06 nadal wymaga consistent P1 mass zamiast diagonalnych wag, pełnej
  mesh/equilibrium identity, kontroli podprzestrzeni/crossingów i runu multi-k.
- Stan liczb: 19 punktów; żadnych nowych. Cały S00–S12 pozostaje aktywny.
  Kolejny runtime blokują wcześniej odnotowane miejsce oraz runtime-only;
  decyzje operatora i zakaz kompilacji unit tests pozostają aktualne.

Dowody: [S06 envelope preflight](../../audits/2026-09-30-s06-tracking-envelope-preflight.md).

## Najnowszy checkpoint — 2026-09-30: gęsta ścieżka DE/BV i kontrola certyfikatów

Ta sekcja ma pierwszeństwo przed starszymi checkpointami poniżej.

- Wejścia dla 52 punktów (26 DE, 26 BV, k=0…25 rad/µm co 1) są na remote:
  c8ad2811f0c9d69aa028d70a47e138d0632e08b5. Jedna relaksacja źródłowa na
  pełną ścieżkę; osobne kN/bv-kN służą diagnostyce i nie dowodzą jej handoffu.
- Odtworzono i naprawiono 19 przypadków wadliwej kontroli certyfikatów:
  pomylony operator Gamma/nonzero-k, luźniejsze residuale, dodatkowe próbki
  lub mody, niezgodny sample_count, duplikaty i niepoprawny model descriptor,
  a także inne granice Poissona lub gauge. Poprawny Gamma BV jest legalny.
- Gęsta ścieżka wymaga pełnego certyfikatu i progu nie większego niż 1e-8.
  Scope i liczba modów muszą odpowiadać żądaniu; certyfikat reduced-only
  nie kwalifikuje gęstej ścieżki. Preflight pozostaje NOT VERIFIED naukowo.
- Dokładny staged snapshot: 144 testy Python i 7 subtestów PASS; walidator
  naukowej mapy źródeł exit 0. Working checkout: 158 i 7 PASS.
  Nie kompilowano testów jednostkowych; nie wykonano nowych punktów FEM.
- Stan wyników pozostaje 19 punktów historycznych; do siatki 52 brakuje 33.
  Runner: brak aktywnych jobów, 4 705 071 104 B wolnego przy progu 8 GiB;
  profil runtime-only poza allow-list. Decyzje operatora nadal oczekują.
- Następny gate: świeży native-bound runtime, poprawny Gamma i cała ścieżka,
  kontrole pól/fazy/siatki, następnie wykres i zbieżność. Pełny zakres
  S00–S12, A1/COMSOL, tracking, API/UI, 2.5D, interakcje, GPU i integracja
  pozostaje aktywny. Ten checkpoint nie zamyka celu.

Dowody: [gęsta ścieżka](../../audits/2026-09-30-de-bv-dense-sampling.md).

## Najnowszy checkpoint — 2026-09-30: dopuszczanie runtime i profile DE/BV

Ta sekcja ma pierwszeństwo przed starszymi checkpointami poniżej.

- Kontrola source snapshot z query biblioteki działa przy publikacji runtime,
  walidacji receipt i starcie benchmarku. 65 testów Python PASS; etap zapisany
  na remote w 58252aa7d6c0aa3f1f8e15c6e5469fb6b0201a32.
- S06: odtworzono końcową kolejność siatki przez pack_mesh_by_analysis;
  fingerprint v3 zgadza się bitowo dla wszystkich 19 zapisanych modów.
  17 sąsiednich par consistent-mass: minimum DE 0.9990210150751552,
  BV 0.9999361809765960. 7 regresji Python PASS; source-map exit 0;
  10 kontroli dokumentacji matematycznej PASS. Nie zmieniono trackera.
- Jest to diagnostyczny dowód podobieństwa profili po odfazowaniu Blocha,
  nie dowód kompletności widma ani pełnej kwalifikacji gałęzi.
- Nadal 19 zaakceptowanych historycznych punktów FEM (9 DE, 10 BV),
  bez zaakceptowanego Gamma i DE k12. Nowe punkty nie zostały policzone.
  Kolejne próbkowanie: docelowo po 26 punktów od 0 do 25 rad/µm co 1.
- Nowy managed runtime poprawek native nadal NOT VERIFIED. #171 jest
  terminalnie succeeded/exit 0, ale jego biblioteka nie dowodzi tych poprawek.
  Ostatni odczyt: 4 931 870 720 B wolnego, próg 8 GiB; runtime-only v1/v2
  poza allow-list. Zakaz kompilacji unit tests pozostaje w mocy.
  Oczekujemy wcześniej zadanych decyzji operatora o cleanupie i profilu.
- C0/C1 Gamma/nonzero-k, A1/COMSOL, zbieżność siatki/airboxu/liczby modów,
  pełny tracking, artefakty/API/UI, 2.5D, interakcje lokalne, GPU i integracja
  pozostają odrębnymi wymaganiami całego S00–S12; cel nie jest zakończony.

Dowody: [dopuszczanie runtime](../../audits/2026-09-30-managed-fem-runtime-admission.md)
i [tożsamość siatki oraz profile](../../audits/2026-09-30-de-bv-mode-mesh-preflight.md).
Wynik odtwarzalny skryptem scripts/compare_de_bv_mode_profiles.py:
consistent-mass-mode-profiles-final.json w katalogu wizualizacji de-bv-ten-20260930.


## Bieżący stan — 2026-09-30, 19 punktów DE/BV; zbieżność siatki i stabilizacja multi-k

Ta sekcja ma pierwszeństwo chronologiczne przed historycznymi checkpointami poniżej.


S06 — nowy dowód diagnostyczny: odtworzono pack_mesh_by_analysis;
końcowy fingerprint siatki zgadza się bitowo dla wszystkich 19 modów.
Obliczono 17 par consistent-mass: minimum nakładania squared DE 0.9990210151,
BV 0.9999361810. 7 regresji Python PASS, source-map exit 0, 10 kontroli
matematycznej dokumentacji PASS. To dowód podobieństwa profili P1 po
odfazowaniu Blocha, nie pełna kwalifikacja gałęzi ani produkcyjnego trackera.
[Audyt i wynik](../../audits/2026-09-30-de-bv-mode-mesh-preflight.md).
Starszy checkpoint 0/19 bezpośrednich zgodności cache poniżej jest
wyjaśniony przez wymagane pakowanie kolejności węzłów; nie pozostaje blokadą
tej diagnostyki. Runtime nowych poprawek nadal wymaga buildu.

Etap dopuszczania runtime zapisany i wysłany na remote:
58252aa7d6c0aa3f1f8e15c6e5469fb6b0201a32.

Najnowszy checkpoint dopuszczania runtime: kontrole native bindingu działają
w publikacji, receipt i benchmarku; 65 testów Python PASS, w tym ponowne
hashowanie receipt ze starą biblioteką. Oddzielny CPU MFEM ABI v2 jest
zdefiniowany w źródłach, ale nie aktywowano profilu ani nie zmieniono runnera.
Managed wykonanie aktualnego native bindingu i ABI nadal NOT VERIFIED.
Audyt: [dopuszczanie runtime](../../audits/2026-09-30-managed-fem-runtime-admission.md).
Stan #171: terminalny succeeded/exit 0; historyczne wzmianki running poniżej
nie opisują aktualnego stanu. Ostatni odczyt miejsca: 4 931 870 720 B.
Plan zagęszczenia: 52 punkty (DE/BV po 26, 0–25 rad/µm co 1),
19 istniejących zaakceptowanych wyników i 33 punkty oczekujące na solver.
Nie oznacza to wykonania nowych runów ani kwalifikacji istniejącej krzywej.

Kontrola wejść S06: 19 payloadów modów i członkowie cache siatki mają
zgodne hashe, ale 0/19 manifestów cache deklaruje modalny fingerprint.
Przed consistent-mass overlap trzeba odzyskać końcową siatkę i kolejność
węzłów; różnica hashy sama nie dowodzi błędu fizycznego.
[Audyt wejść profili](../../audits/2026-09-30-de-bv-mode-mesh-preflight.md).

Najnowszy preflight: #171 terminalnie succeeded/exit 0, lecz native bundle
pozostał identyczny z #169/#170. Kolejny build czeka na dostępność
runtime-only (profil nadal poza allow-list; zakaz kompilacji unit tests obowiązuje)
i miejsce: wolne 4 963 586 048 B, próg 8 GiB. Przygotowano odczyt/dry-run
10 dokładnych katalogów execution, 4 474 033 582 B, bez aktywnych mountów;
wysłano osobne pytanie o zgodę. Nie usunięto danych i nie zmieniono runnera.
Lista: [preflight miejsca](../../audits/2026-09-30-runner-space-preflight.md).
Managed instalacja wybiera teraz bibliotekę FEM z cache zgodnego z hashem
snapshotu, zamiast najnowszego mtime, i nie ignoruje błędu kopiowania.
9 regresji Python/shell PASS; managed runtime NOT VERIFIED.
Szczegóły: [wybór biblioteki](../../audits/2026-09-30-managed-fem-library-selection.md).

Niezależna poprawka multi-k usuwa domyślny indeks 0/częstotliwość 0
przy brakach spectrum.json oraz odrzuca powtórzone indeksy. Jawne 0 Hz
pozostaje legalne. Rust parsing PASS; kompilacja i regresja NOT VERIFIED.
Szczegóły: [tożsamość modu](../../audits/2026-09-30-multi-k-mode-identity.md).

Nowe poprawki native pozostają NOT VERIFIED. Historyczne odczyty running
poniżej nie opisują aktualnego stanu #171.


Aktualizacja zagęszczenia: 19 punktów z pełnym certyfikatem (9 DE, 10 BV),
L0, k=2–25 rad/µm. Nowe wejścia: 251c4a63a2f80e84860a7709e4bba271533bb25b.
DE k12 nie przeszedł trzech konfiguracji solvera i nie trafia na wykres.
Dokładna tabela i dowody: [audyt zagęszczenia](../../audits/2026-09-30-de-bv-dense-sampling.md).
Kwalifikacja naukowa nadal NOT VERIFIED.

K0: naprawiono standalone Gamma (5749897f71d6e0e9d9dff65951cccdeaf479c836),
46 testów Python/IR PASS. #169 terminalnie succeeded, exit 0; poprawny
run 78721295af26413680a1b863406e4a30 potwierdza sondę demagu PASS
(Nz=0.9975062344), lecz fail-closed na pokryciu i dwóch divergences SLEPc.
Dodano źródłowy cache preconditionera z demagiem dla okien <=512 DOF;
natywna kompilacja/runtime nadal NOT VERIFIED. Historyczny odczyt
#170 running / #171 queued został zastąpiony poniższą korektą. Szczegóły:
[audyt k0](../../audits/2026-09-30-k0-control-and-window-preconditioner.md).

Krytyczna korekta dowodów: #170 zakończył build exit 0, ale dostarczona
libfullmag_fem.so ma ten sam hash co #169 i nie zawiera nowych signed guards,
obecnych w kapsule. Kontrolny run k0 e048e072613e408792416acc2b381692
nie jest dowodem wykonania tej poprawki. Dodano źródłowe powiązanie
Cargo/CMake z hashem snapshotu; nowy build, regresja cache i native runtime
NOT VERIFIED. #171 rozpoczął pracę, lecz poprzedza ten nowy mechanizm.
Nie promować receipt do dowodu aktualności solvera.

Ostatni terminalny odczyt #171: succeeded, exit 0, 9/9 kontraktow PASS;
wszystkie hashe artefaktow zgodne. Native library nadal identyczna z #169/#170,
bez nowych signed guards; integralnosc NIE zamyka bramki aktualnosci native.
Nowa poprawka zachowuje interrupted/cancel_requested podczas budowania
preconditionera i sprawdza przerwanie przed kazda kolumna. Source-map exit 0,
10 testow dokumentacji PASS; nowa regresja C++ pozostaje NOT VERIFIED.
Nastepny runtime musi pochodzić z buildu z bindingiem snapshotu biblioteki.


Kontrola bindingu zostala dopisana do dependency query biblioteki, runtime-only,
modal-contract i walidatora benchmarku. 47 testow Python PASS, w tym regresja
swiezy Rust / stara biblioteka; parser 5 blokow Python w shell PASS.
C++/Cargo/CMake wymagaja nowego managed buildu: NOT VERIFIED. #171 nadal
running, kontener potwierdzony jako aktywny; nie zawiera nowego bindingu.
Nie uruchomiono nowej kompilacji testow ani nie zmieniono profili runnera.
Niezalezny validator receipt i benchmark runtime-only v1/v2 rowniez
sprawdzaja native binding. Trzy zestawy Python: 64 PASS, w tym ponowne
hashowanie starego receipt nie omija kontroli. Nowy native build nadal
NOT VERIFIED; #171 aktywny, etap native-build zakonczony wedlug logu.





| Bramka | Bieżący dowód | Pozostała praca |
|---|---|---|
| Porównanie referencyjne COMSOL C0 w Γ | Fullmag #143: `2.8002642129151073 GHz`; dostarczone notatki modelu COMSOL podają `Reference value: 2.8002642 GHz`, różnica ok. `12.9 Hz`. | To zgodność z wartością referencyjną w notatkach, nie surowy wynik solvera COMSOL. Model C0 nie zawiera demagu i nie potwierdza A1 ani niezerowego `k`. |
| DE-SMOKE, `k_y=2e6 rad/m` | Run #151 `b96f1961f51e4d34b038b689ee45caaf`: `9.723336314057247 GHz`, pełny residual `2.18834e-10`, zredukowany `8.85558e-14`; wszystkie cztery szwy i obie sondy demagu przechodzą. Analityczny DE `n=0` daje `9.725724281195415 GHz`, różnica `-0.0245531%`. | Status `completed_unqualified`: pierwszy zaakceptowany punkt nonzero-k z pełnym certyfikatem, lecz nadal jeden punkt bez zbieżności siatki/airboxu/modów i bez porównania A1–COMSOL. |
| Certyfikat natywnego nonzero-k | Źródło C++ rekonstruuje pełne równania słabe i sprawdza cztery residuale szwów. Serializer Rust wylicza `eps_reduced=max(eps_q,eps_phi[,eps_gauge])`, oddzielnie od pełnego residualu i szwów. Build #151 oraz pilot k2 potwierdziły publikację i walidację tego certyfikatu w managed runtime. | Ścieżka pojedynczego `k` jest potwierdzona. Ścieżka multi-k ujawniła kolejne błędy orkiestracji handoffu i redukcji wag. Bieżąca poprawka zachowania certyfikatu relaksacji oraz poprawnego źródła równowagi czeka na managed build #157. |
| Dokumentacja kontraktu | Nota 0831, source-map i spec artefaktów rozdzielają legacy `doubled_real_split_complex_coefficients` od fizycznego `complex_coefficients`; spec opisuje zakres pełnych równań i szwów. Walidator scientific-docs: exit 0; test kontraktu dokumentacji matematycznej: 10 passed; `git diff --check`: exit 0 (ostrzeżenia wyłącznie o końcach linii w istniejącym dirty tree). | Build i artefakty runtime są osobną bramką; dokumentacja nie dowodzi działającego parsera ani poprawności fizycznej. |
| Managed build #148 | Job `1478482dc0824b8d8d0bc2333336060a` terminalnie `succeeded`, exit 0; profil `fem-cpu-slepc-runtime-v1`; źródło ma digest `3f2085e9e31ef4adbc3b7fb22d468e1dd082a53c95792c50539e7faf2f942e2f`. | Snapshot poprzedza bieżący certyfikat full-field i propagację Rust. Nie weryfikuje dzisiejszego kodu; wymagany nowy build. Kwalifikacja fizyczna pozostaje `NOT VERIFIED`. |
| Managed build #149 | Job `8a46bd70acba4ac1a97534de24e33659`, request key `f7ff9e2a26f9407a8fd4e8370428e9ba`, profil `fem-cpu-slepc-runtime-v1`, digest źródła `3ed48a013fc2d7a2ee76b0ee2e1670d681324521cea7674ea3c2fd14bfd19c72`; terminalny stan `succeeded`, exit `0`, obraz `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`. | Receipt koordynatora ma zaufane hashe entrypointów i kontekstu oraz oczekiwane `qualification: NOT VERIFIED`. Snapshot jest sprzed poprawki semantyki `eps_reduced`, więc nie jest podstawą następnego pilota. |
| Managed build #150 | Job `177d59ec92164d529d42e5ff9e1e2f07`, request key `949917e896a2407c8181b2dd836e4aa7`, profil `fem-cpu-slepc-runtime-v1`, digest źródła `0a80827543f636511d9e8987cdb8c5ce7e5f0a62690d2878a507dc79ec68ba13`; terminalny stan `succeeded`, exit `0`; 14/14 artefaktów zweryfikowano ponownie według rozmiaru i SHA-256. | Dry-run k2 przeszedł. Build potwierdza kompilację poprawki residuali, lecz sam nie kwalifikuje fizyki. |
| Pilot #150, domyślny `restart=30` | Run `a1bc955c8c154953a86d68f46d430159` zakończył się fail-closed: zero modów, limit 2000 iteracji w obu oknach; sondy demagu przeszły, lecz ostatnie rzeczywiste residuale KSP wyniosły `8.74e-7` i `1.09e-6`. | Nie jest punktem dyspersji. Domyślny restart pozostaje numerycznie nieskuteczny dla tego smoke'a. |
| Pilot #150, diagnostyczny `restart=10` | Run `567e854bea8241c6b72dc4c927a1eb85` dotarł do kandydata, lecz publikacja przerwała się komunikatem `native Floquet potential payload requires a non-empty even coefficient count, got 0`. | Przyczyna: fizyczny `complex_coefficients` błędnie kierowano także do legacy `potential_real_split.bin`. Writer rozdziela teraz fizyczny payload q/phi od legacy sidecara; dodano regresję Rust. |
| Managed build #151 | Job `a4c6abc28ede4399b2de07b6e6fc4779`, request key `79fdf5dccedf4e3d81dc64d242c1a9c0`, profil `fem-cpu-slepc-runtime-v1`, digest źródła `4b3e9d3f87a618b21c51d1cc14ed53319896668d048f4fc0b46e9ebb4589f376`; terminalny `succeeded`, exit `0`; 14/14 artefaktów ponownie zgodnych co do rozmiaru i SHA-256. | Build kompiluje poprawkę fizycznego payloadu i pełnych residuali, ale nie zawiera późniejszej naprawy promocji handoffu pierwszego punktu ścieżki multi-k. |
| Pilot #151, `k_y=2e6 rad/m`, `restart=10` | Run `b96f1961f51e4d34b038b689ee45caaf` ma `completed_unqualified`, 1 mod i `9.723336314057247 GHz`. Pełny residual wynosi `2.18834e-10`, zredukowany `8.85558e-14`, potencjału `1.25985e-14`; cztery residuale szwów przechodzą, obie sondy dynamicznego demagu przechodzą, a fizyczny `complex_coefficients` zapisuje potencjał bez legacy sidecara. Analityka `n=0`: `9.725724281195415 GHz`, różnica `-2.387967 MHz` (`-0.0245531%`). | To pierwszy poprawnie opublikowany punkt nonzero-k z demagiem i pełnym certyfikatem algebraicznym. Nadal `NOT VERIFIED`: brak zbieżności siatki/airboxu/modów, identyfikacji profilu gałęzi i porównania A1–COMSOL. |
| Pilot 11-punktowy | Run `f8a80a4c704e44a8b5dc6ac2e360df61` zatrzymał się fail-closed przed solve'em pierwszego punktu: `missing_relax_to_eigen_handoff_field: equilibrium_artifact_sha256`. | Przyczyna: `AcceptedFemRelaxStageHandoff.v3` pierwszego punktu interpretowano jak `AcceptedFemEigenEquilibriumHandoff.v1`. Parser rozróżnia teraz oba schematy, bierze zweryfikowane digests równowagi/linearyzacji z diagnostyki i promuje handoff do ponownego użycia. Dodano regresję Rust; wymagany nowy managed build i powtórzenie 11 punktów. |
| Managed build #152 i retry 11 punktów | Job `0c9c1d2f8ff641a0bac5b8702c9a3739` zakończył się `succeeded`, exit `0`; 14/14 artefaktów zweryfikowano co do rozmiaru i SHA-256. Run `399ebfffd4bf4b68b9935769d8df4063` przeszedł brakujące pola handoffu, lecz zatrzymał się na `relax_to_eigen_handoff_summary_identity_mismatch`. | Walidator porównywał fingerprint mieszanego handoffu v3 z fingerprintem periodycznym v6. Walidacja rozróżnia teraz schematy: v3 sprawdza `mixed_topology_fingerprint_v3()`, a dopiero promocja zapisuje periodyczne v6. |
| Managed build #153 i retry 11 punktów | Job `633165889dcc4d7fbb13fcad1d9abea7` zakończył się `succeeded`, exit `0`; 14/14 artefaktów ponownie zweryfikowano. Run `5040f60bfb1241eeb37e6f78385e9642` przeszedł obie wcześniejsze bramki handoffu, a następnie zatrzymał się na `eigen path FE mass metadata has 76 weights for 50 active tracking nodes`. | 76 wag odpowiada fizycznym węzłom magnetycznym, a 50 węzłów aktywnych klasom równoważności Floqueta. Ścieżka sumuje teraz dodatnie, skończone wagi fizyczne według `reduction.node_map`, zachowując całkowitą masę komórki zamiast wybierać wyłącznie reprezentantów. Dodano regresję Rust; testu nie kompilowano zgodnie z czasowym zakazem. |
| Managed build #154 | Job `e0c43cd266fa4c8ebbd14bce46d3cfd4`, request `924df1cc1f3d457b963591dbff173a04`, profil `fem-cpu-slepc-runtime-v1`, source digest `4b9c92f57c720f8a6affc279b6124b5f20d25a355ccc87ddcfbceeac4cf0fe3a`, snapshot `960022bced279486ea1d3c6ddc84d631c3b3aa8bf8123eaf679be02883706dc7`. Build zakończył się `succeeded`, exit `0`, na przypiętym obrazie `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`; niezależnie sprawdzono rozmiar i SHA-256 wszystkich 14/14 artefaktów. | Build potwierdza kompilację redukcji wag masy. Kwalifikacja receipt pozostaje zgodnie z kontraktem `NOT VERIFIED`; dowód runtime opisuje następny wiersz. |
| Pilot #154, 11 punktów | Run `bca7c3174e1d4f079d1296961e7a2b60` poprawnie zbudował siatkę (`1980` węzłów, `5720` tetraedrów, `76` węzłów filmu) i zaakceptował relaksację po 3 krokach (`max_torque=4.4063e-11 A/m < 1 A/m`), lecz zatrzymał się podczas przygotowania ścieżki: `equilibrium_artifact_v7_uncertified: accepted relaxation completion evidence is required`. | Przyczyna jest w orkiestracji kolejnych próbek: promowany handoff zachowuje hashe tożsamości, ale nie zawiera certyfikatu ukończenia ani certyfikowanych pól potrzebnych do ponownego utworzenia `equilibrium_artifact.v7`. Ścieżka zachowuje teraz oryginalny `AcceptedFemRelaxStageHandoff.v3` dla każdej próbki `k` tego samego problemu statycznego i pozostawia wtedy źródło jako `RelaxedInitialState`; dopiero ścieżka bez certyfikatu etapu może przejść na promowany `Provided`. Sweep pola nadal nie może współdzielić tego certyfikatu. Dodano regresję źródłową, bez kompilowania testów zgodnie z czasowym zakazem. |
| Managed build #156 | Snapshot `c35850cd95d43e4b62ff92849306ceda08f0e9ce2dc4c485717ebbef7227318d`, job `f8b5511786364666ad2e7ae14b220c08`, został anulowany jeszcze w stanie `queued`. | Przed startem workera wykryto, że snapshot zachowywał certyfikat, ale przełączał następną próbkę na niedozwolone dla tego handoffu `Provided`. Anulowanie oszczędziło pełny build znanego błędnego stanu. Następny snapshot zawiera poprawioną kolejność wyboru źródła równowagi. |
| Managed build #157 | Job `22a97631a3434d5fbe640fe3d3143417`, source digest `70726b3c21288f81d1c05fbf2e0d93ad33d3cf2dfda5afbfc861ae2c82116619`, snapshot `a06701cf2e98ff10ff3667453c7b67d416081452cecb415261d82009d904ca2b`, zbudował runtime na przypiętym obrazie `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`. Worker zakończył się kodem `0`, build receipt ma stan `succeeded`, a niezależna kontrola potwierdziła rozmiary i SHA-256 wszystkich 14/14 artefaktów. Po restarcie wyłącznie koordynatora startup reconciliation poprawnie uzgodnił terminalny stan kolejki na `succeeded`, exit `0`. | Build jest wiarygodnym źródłem runtime dla pilota, lecz nie zawiera późniejszej poprawki progu diagnostycznego restarta GMRES. |
| Pilot #157, 11 punktów | Run `1323aa47305b4eb48d7fd2830ffb2337` uruchomił `de-smoke-signed-eleven` z `restart=10`. Siatka (`1980` węzłów, `5720` tetraedrów, `76` węzłów filmu) i relaksacja (3 kroki, `4.4063e-11 A/m`) przeszły. Przy `k_y=-0.5e6 rad/m` PETSc przerwał pierwsze okno: residual rekurencyjny `3.07e-17`, jawnie przeliczony `5.18e-14`, początek cyklu `1.12e-13`; różnica to ok. `0.464` normy początkowej wobec domyślnego progu `0.1`. Drugi błąd `MatDenseRestoreSubMatrix` był skutkiem sprzątania SLEPc po pierwszym twardym błędzie. Run zakończył się `failed`, exit `1`, a kontener jest zweryfikowanie nieobecny. | Ustawić jawny próg PETSc `1.0` dla zagnieżdżonego GMRES Floqueta, zachować twardy błąd powyżej całej normy początku cyklu oraz niezmienione niezależne residuale i bramki fizyczne. Po managed buildzie powtórzyć identyczne 11 punktów. |
| Poprawka po pilocie #157 | Solver ustawia nazwany próg `ksp_breakdown_tolerance=1.0`, publikuje go w diagnostyce zbiorczej i obu wariantach wyniku, zachowuje `KSPSetErrorIfNotConverged(PETSC_TRUE)`, niezależny pomiar każdego zakończonego solve'u oraz niezmienione bramki oryginalnego pencila. Dodano regresję natywną i opis w nocie 0831/source-map. Walidator dokumentacji, `68` testów interpretowanych i `11` podtestów przeszło; `git diff --check` exit `0`. Natywnego testu jednostkowego nie kompilowano zgodnie z czasowym zakazem. | Świeży managed build i powtórzenie pilota są wymagane; dowód źródłowy nie zastępuje wykonania PETSc/SLEPc. |
| Próg storage przed następcą #157 | Blokada została rozwiązana zewnętrznie przez operatora. Runner raportował następnie około `45.5 GB` wolnego miejsca, `accepting_jobs=true` i brak aktywnych jobów w chwili preflightu. | Wykonane. Zachować zwykły monitoring wolnego miejsca podczas kolejnych buildów i runów. |
| Managed build #159 | Job `320a1f270cf54c5da4340cf12ec9fe09`, profil `fem-cpu-slepc-modal-v1`, source digest `804263ea6967d31b5b84d62bd3a3ce731f5814c7e9c450e8b47e392dc4d48d6b`, snapshot `885b645461e60ca3ce063ce245e980b2bfc594e3133d1c7b98280022cd749693`, obraz `sha256:829cef07222b7a108883ba0d0ff25d311e38b6b46885cf371eb4723af1e3cadf`, zakończył się `succeeded`, exit `0`. `native-build` oraz `contract-slepc-modal` przeszły; JUnit raportuje 9/9 testów, 0 failures/skips, receipt zawiera 25 artefaktów. Rekonsyliacja po kontrolowanym restarcie koordynatora uzgodniła ten sam terminalny wynik. | Jest wiarygodnym runtime dla jawnej polityki progu `1.0`, ale nie zawiera późniejszej korekty restartu `8` i progu `1.1`. |
| Rozjazd trusted bundle przed #159 | Worker #158 (`1428a957c5f74aeaa208555e89fe37cf`) ujawnił, że poprzedni koordynator przekazał starszy `build_entrypoint.py`: profil `fem-cpu-slepc-modal-v1` został wykonany jak release (`native-build`, `frontend-dependencies`, `frontend-build`) zamiast aktualnego `native-build + contract-slepc-modal`. #158 zakończył workerem `exit 0` i zachował receipt z `109` artefaktami, lecz stary koordynator pozostawił lease jako `running`. Po sprawdzeniu braku aktywnego workera i zachowaniu receiptu wymuszono terminalną rekonsyliację; nowy koordynator oznaczył #158 jako `cancelled`, `exit_code=0`. Aktualny koordynator ma kontener `b589a2b0aaa5...` i obraz `sha256:e976ea943cd8267163a81c4271e7720c4c647d9325de198b3ce748e6ac6bfa14`; profil modalny wskazuje toolchain `sha256:829cef07222b7a108883ba0d0ff25d311e38b6b46885cf371eb4723af1e3cadf`. | Replacement i health są wykonane, kolejka została wznowiona, a #159 uruchomił właściwy worker. Wyniku #158 nadal nie wolno traktować jako dowodu aktualnego kontraktu modalnego. |
| Pilotaż ścieżki po #159 | Pierwszy run z restartem `10` trafił przy `k_y=-0.5e6 rad/m` na różnicę residualu `2.58×` normy początku cyklu. Kontrolny run `f0d9de662ac748f49b15ef9bbc7e9c1a` z restartem `8` zmniejszył ją do `1.045×`; drugie podokno zbiegło w 3 iteracjach, z maksymalnym niezależnym residualem liniowym `3.0634e-9`. Pierwsze podokno nadal zostało przerwane przy progu `1.0`. Błąd `MatDenseRestoreSubMatrix` jest wtórnym skutkiem destrukcji EPS po wcześniejszym błędzie KSP. | Bieżące źródło ustawia domyślny restart `8`, próg `1.1`, zachowuje `KSPSetErrorIfNotConverged(PETSC_TRUE)` i bramkę fizyczną `1e-8`, a po błędzie EPSSolve nie wywołuje niebezpiecznego cleanupu SLEPc 3.24. Potrzebny nowy managed build i powtórzenie identycznych 11 punktów. |
| Managed build #161 | Job `22b181f6309d49199c4471938f18dcf5`, request key `nonzero-k-gmres-restart-policy-20260927-v1`, profil `fem-cpu-slepc-modal-v1`, source digest `90c5446ccbe56aee6fc5acbbee85509b878208e17a579580563c1ac9308e3dad`, capture `de68871b5697435ca51392cb2893a5ba`, zakończył się `blocked` przed utworzeniem workera z powodu bramki miejsca. | Nie ma receipt ani build proof; nie wznawiać tego terminalnego joba. Zastąpił go świeży snapshot #163. |
| Managed build #163 | Job `ee4e4f3310984623993cb908416d303d`, request key `nonzero-k-gmres-restart-policy-20260927-v2`, profil `fem-cpu-slepc-modal-v1`, source digest `f05f9ccbb624ba10608ebaefeaddcf61583388f0660a7010e630f3ed45d8c992`, capture `ea0ab61f544d439494ed289c468b9aca`, zakończył się `failed`, exit `2`. `native-build` przeszedł, a JUnit kontraktu modalnego raportuje `8/9`; jedyną porażką był `fem_floquet_modal_solver_contract`. | Test ujawnił rozjazd konfiguracji: stała domyślna wynosiła `8`, lecz parser braku `FULLMAG_FLOQUET_GMRES_RESTART` nadal zwracał `30`. Parser używa teraz jednej stałej domyślnej `8`, zachowując jawne `30` jako opcję diagnostyczną. Wymagany następny managed build i dopiero po `9/9` pilot 11-punktowy. |
| Managed build #164 | Job `24694a78889945628e811132ccb5b999`, request key `nonzero-k-gmres-restart-policy-20260929-v3`, profil `fem-cpu-slepc-modal-v1`, source digest `3c5ed2692700e54d82979ad0fd8093d34ee73ce165054bc58811281569a84918`, capture `13b5e28e2af440bd867afe7b3b113a17`, snapshot `954923282c5cef92ac94b9761fa1cb2c0aee348322138ca25f1e6caab392635f`, zakończył się `succeeded`, exit `0`, na obrazie `sha256:829cef07222b7a108883ba0d0ff25d311e38b6b46885cf371eb4723af1e3cadf`. `native-build` oraz `contract-slepc-modal` przeszły; JUnit raportuje `9/9`, bez porażek i pominięć, a terminalny receipt publikuje hashe 25 artefaktów. | To wiarygodny runtime parsera restartu `8` i progu `1.1`; nie zawiera późniejszej korekty progu na `2.0` ujawnionej przez pilot #164. |
| Pilot #164, 11 punktów | Run `a7ee1f06f26b466f8eb7adbcb377b2c1` uruchomił `de-smoke-signed-eleven --gmres-restart 8`. Siatka (`1980` węzłów, `5720` tetraedrów, `76` węzłów filmu), relaksacja (`4.4063e-11 A/m`) i obie sondy dynamicznego demagu przeszły. Przy `k_y=-0.5e6 rad/m` pierwsze podokno dotarło do restarta z residualem rekurencyjnym `1.79429e-17`, jawnym `1.64042e-13` i normą początku cyklu `1.20423e-13`; stosunek różnicy do normy początku wyniósł ok. `1.362`, więc PETSc przerwał solve przy progu `1.1`. Drugie podokno zbiegło w 3 iteracjach, z maksymalnym niezależnym residualem liniowym `3.06338e-9`, lecz nie zawierało modu w swoim zakresie. Run zakończył się fail-closed, exit `1`, bez zaakceptowanego punktu. | Próg wymiany residualu wynosi teraz `2.0`: pozwala wznowić cykl od jawnie przeliczonego residualu, lecz zachowuje `KSPSetErrorIfNotConverged`, pomiar rzeczywistego residualu oraz wszystkie progi fizyczne. Potrzebny managed build i identyczny retry 11 punktów. |
| Managed build #165 | Job `c82cfe1cc05747f4b173b5c0cf73b3b0`, request key `nonzero-k-gmres-breakdown-policy-20260929-v4`, profil `fem-cpu-slepc-modal-v1`, source digest `ed0a74580d1cd16f9363b86ff48b613bd9743cf5df30cb9295cde920305083bf`, capture `ec5755e07e044251ac6c03e1f4158cb6`, snapshot `e61372cdd80fb49a8a3c418e4b4f6da374a32ee3a16a1308c1534be7c9522ea3`, zakończył się `succeeded`, exit `0`; `native-build` i JUnit `9/9` przeszły na obrazie `sha256:829cef07222b7a108883ba0d0ff25d311e38b6b46885cf371eb4723af1e3cadf`. | Build potwierdza próg breakdown `2.0`, lecz nie kwalifikuje fizyki. |
| Piloty #165, 11 punktów | Restart `8`, run `6b37260569b042cf8603f347cdde0659`, przerwał pierwszy punkt na stosunku rozbieżności około `2.039`. Restart `10`, run `cdec8aa9e514406f8fd358ff94e25cf6`, przeszedł wcześniejszy restart, lecz później osiągnął około `2.584` i zakończył się fail-closed. Restart `16`, run `5cac291db2ac4dde8c64566122d5c198`, uniknął breakdown, ale oba podokna osiągnęły limit `2000` iteracji bez kandydatów; ostatnie jawne residuale względne KSP wyniosły około `6.68e-7` i `1.86e-6`. | Dalsze zwiększanie progu breakdown nie jest uzasadnione. Problemem jest preconditioner pomijający sprzężenie demagu, a nie bramka fizyczna. |
| Dokładny preconditioner Schura dla małych układów | Dla real-split wymiaru `<=512` źródło materializuje dokładnie ten sam MatShell Schura, odejmuje `sigma B`, skaluje i używa LU wyłącznie jako prawego preconditionera. Operator eigensolvera, próg `1e-8`, pełne residuale i sondy demagu pozostają bez zmian. Większe układy nadal jawnie używają przybliżenia magnetic-only. Dodano asercję regresyjną, notę naukową i source-map; JSON oraz `git diff --check` przechodzą. | Managed build #167 musi potwierdzić kompilację i kontrakty, po czym identyczny pilot 11 punktów sprawdzi zbieżność. Dla A1 nadal potrzebny jest skalowalny preconditioner świadomy demagu. |
| Managed build #166 | Job `0aa1aaa60eba475d80d93cbe327aa31a`, request key `nonzero-k-exact-schur-preconditioner-20260929-v1`, profil `fem-cpu-slepc-modal-v1`, source digest `3b3111e517dd261e8377663fb1dc9c211266940b42865e121a00ecfe0fe99758`, capture `a9dda67e7f4c4373ac655e3c9e331e2a`, snapshot `cbe9d21bdffecb4c6ed6aa776ea7dde8da9b47efa71c9d5a0f3fa60b445ef9cb`, został przyjęty przy około `20.1 GB` wolnego miejsca i zdrowym runnerze. | Zakończył się failed: native-build przeszedł, kontrakty 8/9. Asercja exact-Schur była omyłkowo w dużym fixture (real-split 1028), który prawidłowo używa magnetic-only. Przeniesiono ją do małego fixture (real-split 16); duży sprawdza magnetic-only. Wymagany nowy managed build. |
| Managed build #167 | Job a745f5e241dc497fad98c10c2c11cb13, profil fem-cpu-slepc-modal-v1, source digest 3f8985a7c48ab1a8f1b13341a338c41b24be380a53502d3eb0bc506ea8a83932, snapshot d602e702532ba36ce4c29c45dba110c008834d71bc75eb7e69bfc070b4406ed2. Native release build zakończył kompilację; worker jest aktywny i buduje harness kontraktowy. | Wykonany: terminalny succeeded, exit 0; JUnit 9/9, failures 0, skipped 0. Dry-run sprawdził artefakty i model przed pilotem. |
| Piloty na #167 | Run 59d3ccee204447b68ee9bc906c6f4fe2 z domyślnym prefiltracją EPS 1e-11 zakończył się przy ky=-2e6 rad/m: EPS limit 2000, estymata 1.57e-11, rzeczywisty residual KSP około 1.60e-9. Kontrolny run 1d797566d6514752b6291c840ab01657 z prefiltracją 1e-10 przeszedł do Gamma, lecz nie certyfikował okna K0 przez niestabilną normalizację sondy global_y. Oba kontenery zweryfikowano jako nieobecne; nie ma kompletnego CSV. | Nie zaliczać 11 punktów. Zachować fizyczny próg 1e-8. Naprawić normalizację sondy K0 i powtórzyć na świeżym runtime. |
| Poprawka sondy K0 | Zamiast ilorazu norm niemal zerowych działań P*phi i C*q sonda używa komponentowego błędu wstecznego z uncancelled skalą CSR. Poprzedni iloraz pozostaje w diagnostyce. Próg 1e-8, energia, pole, gauge oraz residuale modalne są zachowane. Dodano regresję: kasowanie źródła, istotny defekt, zerowe wiersze, gauge i NaN. Walidator noty/source-map oraz git diff --check przechodzą; wrapper diagnostyczny 14 testów PASS. | Snapshot przyjęty jako job #169 da4f8f86efb94b5cb32642bdb3c0893e, source digest 2f4c8ef0839165bbada6429e6429fe8f039be8e87e7136687f33ce4263277c82, snapshot 7301a6ecef9c9c2a93f333b0db77468d7e55c0b246c1dccb613f0977802da8e3, request key nonzero-k-k0-probe-backward-error-20260930-v1, stan running, etap contract-slepc-modal po native-build exit 0; następnie odebrać 9/9 i uruchomić signed-eleven z prefiltracją 1e-10. Natywnej regresji lokalnie nie kompilowano. |
| Kontrola k2 na #167 | Run 295591129ccf429893346e9cba4ab83a: completed_unqualified, 1 mod przy ky=2e6 rad/m, 9.723336314054911 GHz; pełny residual 2.771585879901679e-10. Obie sondy demagu oraz rekonstrukcja gradientu potencjału przeszły. Powstały CSV oraz analytic-comparison/dispersion.png i dispersion.pdf, wykres wizualnie sprawdzono. | Referencja n=0: 9.725724281195415 GHz, różnica -2.387967 MHz (-0.0245531%). To jeden zaakceptowany punkt i przybliżona referencja, bez identyfikacji profilu n0, zbieżności i kwalifikacji pełnej dyspersji. |
| Dodatkowe bramki K0 ujawnione przez kontrolny run | Wśród 11 nieudanych podokien Gamma: 1 k0_demag_operator_probe_failed, 2 slepc_diverged, 8 frequency_window_local_coverage_not_certified. Znaleziono dodatni mod 9.299249697068329 GHz z residualem 4.198808050267267e-15, ale certyfikat okna pozostał failed. | Poprawka sondy w #169 zamyka tylko pierwszą przyczynę. Osobno zbadać dolną krawędź widma (fundamentalny mod nie ma dodatniego sąsiada poniżej) i rozbieżność SLEPc przy degeneracji real-split. Zachować negatywną regresję one-sided saturated spectrum; nie oznaczać okna complete na podstawie samego kandydata. |
| Signed spectral guards K0 | Kod oddziela publikowane dodatnie mody od podpisanych czestotliwosci Ritz uzywanych jako dowod pokrycia okna. Kazdy guard przechodzi rekonstrukcje oryginalnego deskryptora i niezmieniony prog fizyczny; diagnostyka zapisuje rodzaj oraz liczbe guardow. Dodano regresje fundamentalnego modu bez dodatniego sasiada ponizej i zachowano negatywna regresje nasyconego jednostronnego widma. | Walidator noty 0831 i dokumentacji matematycznej PASS, wrapper pilota 14/14 PASS, diff check PASS. Natywna kompilacja i wykonanie regresji NOT VERIFIED; Zmiane przyjeto jako job #170 eb7c78ea7e134ec9bcd56314f985f583, source digest bd3eb0e59585b5a63c7a8e4336a143f2c385dead7c77ed76b7663836d1823ccd, snapshot 2145ea17e8f05e98c39d93ec936b9c817b8b24e2abc65ae92f0791510c4daacd, capture 129880aa018a44079d5fcbd234e7b991, profil fem-cpu-slepc-modal-v1; stan queued. Dwa rozbiezne podokna SLEPc pozostaja osobna bramka. |
| DE/BV przy 25 rad/um | Runtime #167, wersjonowany model 3aa1eb4b7f4c6ea5ecd8967ac661f528ba783840. DE run 1d89127285d243e58bc2ada522f3aca5: 13.384204251108984 GHz, pelny residual 2.451762140091136e-10. BV run d5bac6762d88405b99b90837b6451980: 9.664769492954655 GHz, pelny residual 2.310868858622120e-10. Oba completed_unqualified, exit 0; walidacja residuali, sond demagu i rekonstrukcji potencjalu PASS. Plot PNG/PDF de-bv-25-20260930 wizualnie sprawdzony. | Analityka n0: DE 13.673868175350407 GHz, BV 9.760535487542313 GHz; roznice -2.118376% i -0.981155%. Nie traktowac jako pelnej zgodnosci fizycznej. Nastepne kontrole: zbieznosc siatki, profil po grubosci, blad aproksymacji n0 oraz airbox. Testy wejsc/validatora/wrappera 71 PASS + 4 subtesty; samodzielna regresja modelu 2 PASS. |
| Multi-k: utrata certyfikatow przy publikacji | Run 449fb744567a492db32b95329711ed08 na #167 policzyl 6 punktow DE (2,5,10,15,20,25 rad/um), ale walidator odrzucil eksport spectrum.v3 bez block_residuals. Native exit 0 nie oznacza sukcesu calego runu. Poprawka zachowuje niezmieniony certyfikat pojedynczego modu w prywatnym rejestrze diagnostycznym powiazanym z sample_index, raw_mode_index i frequency_hz; eksport v2/v3 nie uzywa agregatu ani nie fabrykuje certyfikacji. | Rustfmt i diff check PASS, nota/source-map PASS. Dodano natywna regresje dopasowania, zmienionej czestotliwosci, duplikatu i obcej probki; lokalnie jej nie kompilowano zgodnie z zakazem. Przyjeto job #171 94d7d8e4d8444d8fa839cc77a120080a, source digest 00b606d1797674752d6240514c1017bcc564f1641f96cab2394b915bb99a1ded, request key nonzero-k-path-block-certificate-20260930-v1, stan queued. Wymagany terminalny receipt oraz ponowne 6/6 DE oraz BV. Biezace pojedyncze punkty licza sie niezaleznie na #167 z wersjonowanym modelem c9456adf73a489a870d6c7a90d5fd3de2ed95876, progiem 1e-8 i pelnymi artefaktami. |
| 12 niezaleznych punktow DE/BV | Komplet 6+6 dla k=2,5,10,15,20,25 rad/um. Dziewiec nowych runow zapisano w positive-six-independent-20260930.json; wykorzystano takze trzy zachowane single-k. Kazdy run completed_unqualified, exit 0, native block residuals i seam certificate obecne, sondy demagu i rekonstrukcja potencjalu PASS. Maksimum pelnego residualu 3.403656892868575e-10 przy progu 1e-8. independent-six-comparison zawiera comparison.csv, comparison.json oraz sprawdzony wizualnie PNG/PDF. | Systematyczna roznica z analityka n0 rosnie do DE -2.118376% i BV -0.981155% przy 25 rad/um. Nie zamyka to zbieznosci siatki/airboxu, identyfikacji profilu n0 ani multi-k publication/tracking. Wykres pokazuje punkty niezaleznych solveow, nie zaliczony zbiorczy run. |
| Rafinacja DE/BV k25 | Runtime #167, model 9ba84d078cfa1cfc47ccc6ea6374639115dfe120. DE L1 13.436508613 GHz; DE L2 13.578981799 GHz; BV L2 9.740140954 GHz, udane runy completed_unqualified. Raport docs/audits/2026-09-30-de-bv-mesh-convergence.md. | Zbieznosc NOT VERIFIED. BV L1 restart 8: EPS limit iteracji, brak zaakceptowanego modu; restart 10 takze failed (96673c3616e64a4f909a5eb3b96fcff8), podobnie KSP 1e-12 (f81f518b3e1748f4a424444cafd6d8d8). Realna liczba tetraedrow filmu 191/354/791; objetosc zgodna. L1 exact Schur, L2 magnetic-only. Potrzebne kolejne poziomy, profil modu i airbox. Wrapper odrzuca wadliwe metadane; 34 testy +7 podtestow PASS. |
| Diagnostyka profilu k25 | Piec zaakceptowanych modow L0/L1/L2: po usunieciu fazy Blocha overlap z przestrzennie stalym wektorem DE L2 0.999842103, BV L2 0.999998972, z nodalnymi wagami objetosciowymi lumped. Hashowane wejscia i wyniki w mesh-mode-profile-diagnostic-20260930.json. | Wspiera przyblizenie n0, lecz nie identyfikuje najnizszej galezi ani pokrycia okna. Norma lumped jest diagnostyczna; fizyczne certyfikaty i zbieznosc pozostaja osobnymi bramkami. |
| Czwarty poziom siatki L3 | Model c06965bf92a4a54e6a8e6433c583762e5e06d022: zadane 3.75 nm. Testy interpretowane 93 PASS +7 subtestow, nota/source-map PASS. DE run 4e59f81f28a74af4acc84441ce1b1a33 completed_unqualified, exit 0: 13.596286127 GHz, pelny residual 2.15685293911757e-10, 13507 wezlow calej domeny. | Przesuniecie DE L2-L3 17.304328 MHz (~0.127%); roznica z n0 ok. -0.567%. BV L3 failed: e09e726404d6412e802c06b8c41d5695 (restart 8, PETSc recursive/true norm discrepancy), 0766e8f0e63a4d96a92ff69b1e1c585a (restart 10, exit 1). Manifest mesh-convergence-L3-20260930.json zachowuje terminalny batch. Dalsza rafinacja, airbox i kwalifikacja pozostaja otwarte. |
| Diagnostyka KSP po bledzie EPS | Przeniesiono odczyt stanu KSP przed powrotem z EPSSolve error; zachowano pierwotny blad i fail-closed. W razie reason ITERATING po hard error diagnostyka zapisuje stan niekompletny, nie sukces. Dodano natywna regresje wymuszonego limitu wewnetrznego solve'a; nota/source-map, 10 testow matematycznego kontraktu i diff check PASS. | Kompilacja/runtime i wykonanie regresji NOT VERIFIED. Zlecenie nonzero-k-failed-ksp-observability-20260930-v1 na runtime-v1 odrzucone HTTP 400: health nie dopuszcza runtime-v1/v2. Nie przyjeto nowego joba. Decyzja uzytkownika: aktywacja runtime-only po kolejce albo wyjatek dla 9 kontraktow; aktualny zakaz kompilacji testow pozostaje. GET /jobs oraz /api/v1/jobs zwracaja HTTP 500 response_too_large; indywidualny status i health dzialaja. |
| COMSOL A1 i runner | Dostarczono widmo COMSOL `61×24` i szczegółowy kontrakt COMSOL 6.1. Build #157 zakończył się poprawnie, lecz jego pilot ujawnił błąd restarta naprawiony dopiero w bieżących źródłach. | Nie ma jeszcze Fullmag A1 solve'u ani bezpośredniego porównania. Po nowym buildzie i przejściu 11-punktowej kontroli DE uruchomić C1, skontrolować A1 w Γ/X/M w ramach pełnej ścieżki, a następnie porównać komplet A1 `61×24`. |

## Wykonawczy runbook porównania Fullmag--COMSOL A1

Konfiguracja Fullmaga odtwarza nominalną geometrię, parametry materiałowe,
drogę w przestrzeni odwrotnej i liczbę żądanych modów. Równoważność wszystkich
warunków brzegowych wymaga jeszcze rozstrzygnięcia opisanego niżej. Nie jest to
także identyczna dyskretyzacja algebraiczna: przekazany pakiet nie zawiera pliku
`.mph`, dokładnej siatki/DOF ani zespolonych wektorów własnych COMSOL. Pierwsze
porównanie jest dlatego porównaniem częstotliwości przy tych samych punktach
`k`, a zgodność profili modów pozostaje osobną bramką po uzyskaniu danych pól.

Przekazany opis modelu ma ponadto nierozstrzygniętą różnicę konwencji, której
nie wolno ukryć pod etykietą „identyczny model”. COMSOL 6.1 stosuje czasową
konwencję `exp(+i*omega*t)`, natomiast README referencji definiuje źródło
magnetyzacji jako `Menv=Ms*exp(+i*k.r)*dm`, potencjał jako
`phi_dyn=exp(-i*k.r)*psi` i nie opisuje warunku Blocha dla `dmX/dmY/dmZ`.
Fullmag stosuje jeden fizyczny ślad Blocha
`u_dst=exp(-i*k·Delta r)u_src` dla magnetyzacji i potencjału. Nie istnieje
zatem pojedyncza zmiana znaku `k`, która równocześnie odwzoruje oba zapisane
w README pola. Dopóki plik `.mph` albo uzupełniony eksport równań i warunków
brzegowych nie rozstrzygnie tej kwestii, dostarczone `61x24` jest referencją
„COMSOL as delivered”, a nie certyfikatem równoważności operatorów.

0. **Sprawdzić konwencję referencji.** Zachować standardowy, wspólny ślad
   Blocha Fullmaga i zapisać w porównaniu jawną mapę znaków. Dla
   centrosymetrycznego A1 porównać pomocniczo `+k` i `-k`, ale nie używać
   oczekiwanej wzajemności jako substytutu brakującego warunku brzegowego
   `dm`. Do pełnej równoważności wejścia wymagać eksportu ustawień periodycznych
   Micromagnetics, Frequency Domain albo poprawionego przebiegu COMSOL ze
   wspólną fazą przestrzenną magnetyzacji i potencjału. Minimalny pakiet
   rozstrzygający musi podać dla `dmX/dmY/dmZ` typ warunku na parach
   `xminus/xplus` i `yminus/yplus`, mapę source/destination, znak fazy lub
   potwierdzenie zwykłej periodyczności obwiedni oraz pełne definicje pola
   demagnetyzującego w solverze częstotliwościowym. Plik `.mph` spełnia tę
   bramkę; równoważny jest kompletny eksport ustawień i równań.
1. **Zamknąć build runtime.** Build #157 ma terminalnego workera, exit `0`,
   receipt, niezależną zgodność rozmiaru i SHA-256 wszystkich 14 artefaktów
   oraz poprawnie zreconciliowany terminalny rekord kolejki. Ten krok jest
   wykonany dla źródeł #157; każda kolejna poprawka wymaga nowego snapshotu.
2. **Potwierdzić mechanikę wielopunktowego nonzero-k.** Na buildzie zawierającym
   jawną politykę restartu `8` i progu restart-breakdown `1.1` (job #161)
   uruchomić `run_de_100nm_pilot.py --pilot de-smoke-signed-eleven
   --gmres-restart 8`. Wymagane jest 11/11 próbek: Gamma oraz
   `k_y=±(0.5,1,1.5,2,3)e6 rad/m`, jeden zaakceptowany mod na próbkę, pełne
   i zredukowane residuale poniżej obowiązujących progów, cztery szwy Floqueta,
   obie sondy demagu, wspólna tożsamość równowagi/siatki i niepusty CSV.
   Następnie `compare_de_100nm_pilot.py` tworzy roboczy wykres z analityką.
3. **Uruchomić kontrolę C1.** Z tego samego zweryfikowanego builda wykonać
   jednorodny film `200×200×10 nm` z demagiem, airboxem `2 µm` nad i pod
   filmem oraz tą samą drogą `Γ–X–M–Γ`. C1 oddziela błędy operatora
   Floqueta/demagu od wpływu otworu w A1. Wyniki kontroluje się względem
   analityki cienkiej warstwy tam, gdzie jej założenia obowiązują.
4. **Uruchomić właściwy A1.** Przypadek `a1` używa komórki
   `200×200×10 nm`, centralnego otworu `r=50 nm`, `Ms=800 kA/m`,
   `Aex=13 pJ/m`, `gamma=2.211e5 m/(A s)`, biasu `0.1 T` w `+x`, relaksacji
   od `m=+x` z `alpha=0.5` do certyfikowanej równowagi w budżecie `5 ns`,
   eigensolve z `alpha=0`, demagu w airboxie z Dirichletem na górze/dole oraz
   fazy Blocha `exp(-i k·r)` na bokach. Droga ma 61 punktów: po 20 przedziałów
   na `Γ–X`, `X–M`, `M–Γ`, a solver żąda 24 modów w `1 MHz–30 GHz`.
   Punkty `j=0,20,40,60` są kontrolami `Γ,X,M,Γ` w tym samym pełnym runie;
   nie wymagają osobnej, inaczej zdyskretyzowanej symulacji.
5. **Zweryfikować artefakty przed porównaniem.** Run musi zakończyć się bez
   błędu, zachować zgodny source/build receipt i hashe, 61 niepustych próbek,
   żądaną liczbę modów lub jawny fail-closed, residuale, szwy Floqueta, sondy
   demagu, niezmienną siatkę i równowagę dla wszystkich `k`. Najpierw ocenia
   się cztery punkty kontrolne, potem całą ścieżkę.
6. **Porównać z dostarczonym COMSOL-em.** Uruchomić
   `compare_comsol_a1_frequency_reference.py` dla zarządzanego katalogu `a1`
   i `COMSOL_A1_dispersion.csv`. Komparator zestawia lokalnie posortowane
   częstotliwości w identycznych próbkach `k`, zapisuje JSON i scatterplot.
   Nie nazywa rang częstotliwości śledzonymi pasmami, ponieważ CSV COMSOL nie
   zawiera wektorów własnych ani identyfikatorów gałęzi.
7. **Wykonać kwalifikację naukową.** Oddzielnie sprawdzić zbieżność siatki,
   wysokości airboxu, liczby modów i parametrów solvera oraz stabilność
   równowagi. Dopiero te serie pozwalają ocenić tolerancję zgodności Fullmag--
   COMSOL i nadać wynikowi status wyższy niż `completed_unqualified`.

Polecenie produkcyjne po sukcesie #157 jest jednoznaczne:

```powershell
python scripts/run_comsol_dispersion_benchmark.py --repo-root . `
  --job-id 22a97631a3434d5fbe640fe3d3143417 --cases c1,a1
```

Orkiestrator wykonuje przypadki sekwencyjnie, korzysta z binarium i kapsuły
źródeł #157, nie przebudowuje kodu i nie stosuje cichego fallbacku. Identyfikator
#157 wolno zachować w tym poleceniu tylko po jego terminalnym sukcesie i
kontroli receipt; przy poprawce źródła należy podać identyfikator nowego builda.

Poniższa tabela jest migawką sprzed powtórzonego postflightu z 2026-09-25;
szczegóły starszych buildów i prób pozostają zachowane jako historia.

| Bramka | Bieżący dowód | Pozostała praca |
|---|---|---|
| Źródła i kontrakty | Trasa FEM CPU Floqueta, dynamicznego demagu i artefaktów istnieje; regresje walidatora dla sond per-podokno dodane; celowane testy Pythona: 7 PASS | C++ serializer okienkowy zmieniony, wymaga managed build/runtime; testów natywnych nie kompilowano zgodnie z tymczasowym zakazem; pozostałe bramki S00–S12 otwarte |
| Build #142 | Terminalny `succeeded`, exit 0; 14/14 artefaktów zgodnych co do rozmiaru i SHA-256 | Sukces buildu nie potwierdza zbieżności solvera |
| Pierwszy produkcyjny punkt DE z demagiem | Pilot #142 `de-smoke-k2` dla `k_y=2e6 rad/m` zakończył się exit 1; zero zaakceptowanych modów, po 2000 iteracji EPS w każdym z dwóch okien | Rozwiązać stagnację EPS/KSP i powtórzyć fizyczną kontrolę residuali; diagnostyczny dense oracle nie zastępuje wyniku produkcyjnego |
| Residual liniowy | Niezależny względny `||Ax-b||/||b||` ostatnich solve'ów: `3.30e-6` i `5.01e-7`; norma wewnętrzna GMRES około `1e-25` | Ustalić źródło rozbieżności bez zmiany progu fizycznego `1e-8` |
| Build i pilot #143 | Build terminalnie `succeeded`, exit 0, 14/14 artefaktów zgodnych. MGS obniżył końcowy rzeczywisty residual pierwszego okna do `4.14e-8`, lecz żadne okno nie dostarczyło zaakceptowanego modu. Najgorszy rzeczywisty residual wewnętrznego KSP sięgał `1.05e-4`. | Naprawić dokładność zastosowania operatora shift-invert i zbieżność EPS; nie uznawać niższego residualu ostatniego solve'u za zbieżność całego przebiegu |
| Diagnostyka prefiltra EPS | Przy diagnostycznym `EPS_PREFILTER_ABS=1e-8` pierwsze okno dało jedną zbieżną parę blisko `9.723336314 GHz`, lecz oryginalny residual magnetyczny wyniósł `2.80e-7 > 1e-8`; para została odrzucona. | Nie podnosić wstępnego progu jako rozwiązania; pierwotna bramka fizyczna działa prawidłowo |
| COMSOL C0 w Γ | Managed run #143 `7e0f427291164864a4931521f0cf05ee`: `2.8002642129151073 GHz`, residual `3.12e-16`, 1 wiersz, 7/7 wymaganych hashy zgodnych; wynik analityczny `2.80026421291511 GHz` | C0 sprawdza jednostki/ekstrakcję bez demagu; C1 Γ, nonzero-k i A1 pozostają otwarte. Obecne szerokie okno C0 dzieli się na 16 kosztownych podokien |
| Eksperyment CGS2 #144 | Build `succeeded`, exit 0 i 14/14 hashy zgodnych; pilot k2 `905d3e1fe10c4d5abac215ebb5b0fd34` zakończył się exit 1, z 0 przyjętych modów po 2000 iteracji EPS w obu podoknach. Ostatnie rzeczywiste residuale KSP: `8.74e-7`, `1.09e-6`; największe ze wszystkich solve'ów: `8.59e-5`, `5.83e-5`. Diagnostyczny kandydat `9.723336314 GHz` miał residual magnetyczny `2.60e-7 > 1e-8`. | CGS2 nie rozwiązał problemu; zachować oryginalną bramkę fizyczną i sprawdzić restart GMRES przed pozorną zbieżnością |
| Eksperyment restartu GMRES #145 | Snapshot `4a7af19818788336e2e92afc43252bfe1c963dc6f56ae95ae8ae143b8eed5d22`; job `06549612ec9c428e9be18f0c1e18e10a` zakończony `succeeded`, exit 0, receipt 14 artefaktów. Run `5d06e0b19c564b9e8647cc734854b9f4` zakończył się exit 1 przed raportem EPS: przy zerowej liczbie modów adapter Rust odrzucił modalną metrykę wykonania, zwracając `resolved_target=None`. | Adapter zachowuje teraz attestation nawet dla pustego widma; regresja źródłowa dodana, lecz nie skompilowana zgodnie z zakazem testów natywnych. Nowy snapshot #146 ma potwierdzić poprawkę, a powtórzony k2 ustali, czy EPS znalazł mod |
| Build #146 | Snapshot `363d3e49990944dee3215234540dfe0c9bf63be2c7175d2384656a08b6cce9c1`; job `a73ba0c45de34ffcb251023b3c304792`, request `de-empty-modal-attestation-20260925`, profil `fem-cpu-slepc-runtime-v1`; receipt terminalny `succeeded`, exit 0, 14 artefaktów | Build #146 dotyczy stanu sprzed obecnej poprawki serializera; nowy managed build jest wymagany |
| Pilot #146 — DE-SMOKE k2 | Run `a9d88663d3d346199ea639ecff772ac8`, `k_y=2e6 rad/m`, `gmres_restart=10`, proces solvera exit 0; tryb `9.72333631405827 GHz`; największy rzeczywisty residual magnetyczny kandydata w pierwszym podoknie `8.86e-14`, maksymalny zmierzony true-relative KSP residual `3.89e-11` | `run-result` ma status failed podczas postflightu: serializer nie opublikował `dynamic_demag_operator_probe`; globalnie `complete=false`, `window_completeness=not_certified`, drugie podokno nie znalazło modu. To kandydat diagnostyczny, nie zaliczony punkt dyspersji |
| Przyczyna błędu sondy | Wspólna funkcja serializująca `subwindows[]` pomijała pole sondy, mimo że solver zwraca wynik sondy dla każdego podokna; tryb pojedynczego przesunięcia już serializował to pole | Serializować sondę w każdej pozycji `subwindows[]`; walidator ma wymagać i sprawdzać wszystkie rekordy |
| Następny managed pilot | Poprawiono walidator i dodano regresje dla kompletnego, brakującego i nieudanego rekordu per-podokno. C++ writer publikuje sondę w diagnostyce każdego podokna | Wykonać wszystkie testy Pythona/kontrakty, aktualizację dokumentacji i preflight; następnie build zarządzany oraz ponowny pilot k2; zaakceptować tylko gdy sonda jest obecna i przejdzie we wszystkich oknach |
| COMSOL A1 | Dostarczone CSV 61×24 i szczegółowy opis COMSOL 6.1; nominalna geometria/materiał/airbox odpowiadają modelowi A1 Fullmag | Brak wyniku Fullmag A1, stanu `m0`, siatki COMSOL i porównania numerycznego; certyfikat relaksacji A1 otwarty |
| Runner i storage | Koordynator `Fullmag_build_runner` zakończył #146 terminalnie; pilot zachowany w storage | Przed nowym buildem sprawdzić bieżący stan runnera, aktywne joby i miejsce; nie sprzątać danych bez potrzeby i autoryzacji |
| Dyspersja i nauka | `NOT VERIFIED` | Produkcyjne punkty k=0 i k≠0, wykres z analityką, C0/C1/A1, zbieżność siatki/airboxu/modów, frontend i kwalifikacja wydania |

Pełny zakres S00–S12 pozostaje aktywny. Sukces kontraktów, buildu lub pojedynczego
punktu nie zamyka GPU, Control Room, śledzenia gałęzi ani kwalifikacji naukowej.


## Managed DE-SMOKE: diagnostyka faktoryzacji — 2026-09-23

Build `9024007447fe4ec1b7fe9a4b1c76b61e` ze źródła
`3273836fa8eac08db7f77da4f1758df659a17516` zakończył się sukcesem.
Dry-run pilota przeszedł, a rzeczywisty run k2
`7ee15b286a634d3a870c3eacb27cbab9` dotarł przez obie bramki payloadu
do SLEPc. PETSc przerwał konfigurację shift-invert w LU preconditionera:
`Zero pivot row 0 value 6.19523e-62 tolerance 2.22045e-14`.
Oba podokna mają `outer_iterations=0` i brak zaakceptowanych modów.
To nadal nie jest wynik numeryczny dyspersji.

Hipoteza do sprawdzenia w nowym managed runtime: natywny operator jest
wyrażony w jednostkach SI, lecz pencil i macierz preconditionera trafiały
do SLEPc/PETSc bez normalizacji skali. Źródła mnożą teraz obie strony
uogólnionego pencila, wraz ze sprzężeniem Schura, przez wspólny czynnik
wyznaczony z normy bloków. Wartości własne pozostają bez zmian, a residual
jest nadal sprawdzany na oryginalnych blokach fizycznych. Przesunięty blok
preconditionera dostaje osobną normalizację przed LU. Obie skale są
raportowane jako `operator_normalization_scale` i
`preconditioner_normalization_scale`.
To nie jest jeszcze potwierdzona naprawa; należy wykonać runtime k2,
sprawdzić nową diagnostykę, częstość, residual oraz pole z demagiem.
Jeżeli LU nadal zawiedzie, trzeba odróżnić osobliwość bloku od błędu
skalowania na podstawie jego normy, pivota i struktury.

## Managed DE-SMOKE: rzeczywiste próby — 2026-09-23

Build 3eddf0c2cf014088a25cb7fa12c7a055 (źródło
370004426ae4955bd9d8eb993a7eb299bdb6eacb) zakończył się `succeeded`,
exit 0; receipt potwierdza profil runtime-only FEM CPU/SLEPc i 14 artefaktów.
Dry-run pilota przeszedł. Rzeczywisty run k2
`859e649542eb4994ba1d5b2b9d83ced3` przeszedł poprzednią bramkę C++
i skierował `floquet_shared_domain_sparse_matshell` do solvera, lecz zakończył
się exit 1 (`no accepted modes`). Diagnostyka obu podokien pokazała
`outer_iterations=0` i przyczynę
`floquet_modal_requires_bloch_floquet_operator_payload`: druga, niższa bramka
SLEPc odrzucała nadal znacznik `certified_shared_domain`. Poprawka i regresja
są w źródłach, lecz wymagają kolejnego managed buildu i runu. Żaden punkt
dyspersji k≠0 nie jest jeszcze **VALIDATED**.

Build 4cb9b9fdde1040f992e07eeb303cd2bc zakończył się sukcesem
(exit 0, źródło bed041c897064d8487f02653358991c50b9dca55).
Dry-run pilota potwierdził receipt, hash modelu i artefakty. Rzeczywista
próba `de-smoke-k2` (run f7f70f4dce88491b8b14bc3fe2cc3bfa)
zakończyła się jednak exit 1 z `production_cpu_modal_nonzero_k_floquet_operator_missing`.
Diagnostyka natywna wykazała `modal_periodic_pair_contract_available=true`
oraz `payload_kind=certified_shared_domain`, `assembly_owner=native_mfem`.
Bramka C++ akceptowała tylko starsze `payload_kind=bloch_floquet_tangent_operator`;
odrzucała więc przed solve nowy operator współdzielonej domeny. Poprawka
rozpoznawania obu jawnych kontraktów jest w kodzie, ale wymaga nowego managed
buildu i ponownego runu. Wynik numeryczny k≠0 nadal **NOT VERIFIED**.

Build 6b2de4a74bf64669ae0e92610b1bb078 zakończył się sukcesem
(exit 0), lecz zawiera źródło 0669d76c2306a31dfe162c2f3ae5af4cb458b552,
starsze od obecnego routingu nonzero-k. Receipt i hash zweryfikowano.

| Próba | Wynik | Znaczenie |
|---|---|---|
| Dwa punkty, model b8cf20b | Exit 1: poisson_airbox_eigen_invalid_tolerance_or_frequency przy Γ | PA-E2 odrzuca zerową domyślną tolerancję. |
| Dwa punkty, model 3599ee04f1b73c22a54fe9748346007a980f4c80 | Exit 1: frequency_window_local_coverage_not_certified przy Γ | Jawne solver_rtol=1e-8 odblokowało solve. Kandydat 9,299249697 GHz pozostaje tylko w diagnostyce; 10/50 subokien bez certyfikatu. |
| Jedno k_y=2e6 rad/m, model bed041c897064d8487f02653358991c50b9dca55 | Exit 1: nonzero-k Floquet operator is not implemented yet | Stary binary nie ma obecnego kodu nonzero-k. |

Dodatkowy błąd metodyczny: przy domyślnych 40 wątkach Gmsh powtarzane
generacje miały 1975–1980 węzłów dla tej samej nominalnej geometrii.
Od commita f1ce0f035 pilot wymusza FULLMAG_GMSH_THREADS=1. Należy
potwierdzić w nowych artefaktach identyczny fingerprint siatki między
punktami i powtórkami; samo ustawienie wątków jeszcze tego nie dowodzi.

Próba celu nearest została poprawnie odrzucona przez planner, ponieważ
obecna trasa dynamicznego demagu Floqueta wymaga frequency_window.
Eksperymentalny commit 3833babcd wycofano przez 84321fd80.

Build 4cb9b9fdde1040f992e07eeb303cd2bc używał profilu
fem-cpu-slepc-runtime-v1 bez kompilacji testów jednostkowych. Sam sukces
buildu nie dowodzi wykonania nowej trasy modalnej.

Kolejność: (1) zbudować poprawioną bramkę C++ w managed runtime, powtórzyć
de-smoke-k2 i sprawdzić niepuste wyniki, residual, pola, siatkę i operator;
(2) naprawić
kontrakt domyślnej residual_tolerance PA-E2; (3) rozwiązać brak
certyfikacji kompletnych pustych subokien bez osłabiania bramki;
(4) uruchomić dwa i pięć punktów, porównać T4 z referencją 1D
i analityką, wykonać zbieżność siatki, airboxu i liczby modów;
(5) sporządzić wykres i kwalifikację naukową.

Niezależna kontrola zapisanego -grad(phi) (4e4186f17) przeszła 10 testów,
a pilot z integracją kontroli 12 testów. Poprawka budżetu GET fixture'a
Inspectora (619d87247) przeszła 3 testy Node i kontrolę składni.
Walidator pola sprawdza spójność zapisu, a nie poprawność operatora T4.
Te poprawki są w PR #97. Dla commita
6ca40dd6dc335f0534c129aaf912f9a15207766e kontrola
generated-api-determinism i browser-fixture-smoke zakończyły się SUCCESS
(run 35833576759). To dowód fixture'a przeglądarkowego, nie walidacja
fizyki ani pełny odbiór WebGL. S04/S05/S12 pozostają NOT VERIFIED.


## Odbiór wygenerowanego API i diagnostyki UI — 2026-09-22

Pakiet transportu residuali zapisano i wysłano jako
602dd629394fcefbc7351d563d91bfb2920af417. Diagnostykę timeoutu Inspectora
(requestCounts, przekroczenie budżetu, ostatnie 20 odpowiedzi sceny)
zapisano i wysłano jako 3ba4125787cacbb4c27ff648b5b06b6ee1b5b1ce.
Nie zwiększano limitów fixture'a. node --check i diff przeszły.
Lokalny React Doctor --scope changed --base 602dd629394fcefbc7351d563d91bfb2920af417
zakończył się bez zgłoszeń; browser smoke pozostaje otwarty.

Job CI 106639461082 w runie 35694883187, dla dokładnie commita 3ba412578,
wykonał generator API i ujawnił wyłącznie oczekiwany diff nullable/optional
residual_relative_l2 w widmie v3. Zaimportowano dokładny diff z logu
generatora, po git apply --check; nie przepisywano schematu ręcznie.
Zweryfikowano zgodność wygenerowanych blobów Git z nagłówkami diffu CI:
openapi-v2-types.ts = 2d1e3b8828adcd4d79d0afe73b71a5df972f614f,
openapi-v2.json = 0f6dae86508ee201ba2e3affc93da70ba253a6b2.
Parser JSON potwierdził opcjonalność oraz number|null. Generator klienta
nie wygenerował różnic. Kolejny gate deterministyczności pozostaje do odbioru.

Managed build 6b2de4a74bf64669ae0e92610b1bb078 nadal running; nie ma jeszcze
nowego punktu DE. Kontrola źródeł potwierdziła, że sparse parser rozdziela
fizyczne q/phi od legacy pełnego certyfikatu, więc sam reduced-only status
nie blokuje eksportu. Pełna mapa redukcji potrzebna do niezależnej kontroli
pola nadal wymaga sprawdzenia w artefaktach; hash mapy nie zastępuje jej treści.

## Residuale — zakończony pakiet źródłowy transportu, 2026-09-22

SingleKModeResult otrzymał osobne Option<f64> dla residualu względnego.
Parser natywnej ścieżki przenosi tę wartość bez aliasowania residual_norm.
Manifesty, mode bundle, widma v2/v3, field sweep i podsumowanie Kittela
korzystają z właściwej wielkości. Kittel raportuje null, jeśli choć jeden
wybrany punkt nie ma tej diagnostyki; CSV pozostawia wtedy puste pole.
Fingerprint wyników uwzględnia teraz także residual względny.

Przegląd objął producenta natywnego, parser, konsumentów oraz wszystkie
konstruktory SingleKModeResult. Dodane regresje obejmują różne wartości
residualu absolutnego/względnego i brak wartości. Kontrole formatowania
zmienionych plików runnera oraz diff przeszły. Regresje Rust są przygotowane,
lecz NIEURUCHOMIONE ze względu na zakaz kompilowania testów. Nie jest to
odbiór runtime ani zakończenie S07: generacja OpenAPI/klienta, kompilacja
aktualnego źródła i dowody numeryczne nadal pozostają otwarte.

Odczyt procesów aktywnego kontenera joba 6b2de4a74bf64669ae0e92610b1bb078
potwierdził cargo i rustc, a log wskazał kompilację fullmag-runner. Job
nadal running. Nie zastępowano go nowym buildem ani nie zmieniano kapsuły.

## Residuale — kontrakt API v3, 2026-09-22

W bieżącym worktree payload widma v3 przechowuje residual względny jako
Option<f64>. Walidator dopuszcza brak dowodu, odrzuca natomiast ujemne
oraz nieskończone/NaN wartości obecne. Indeks wyników zachowuje None;
brak residualu nie staje się zerem. Dodano dwie regresje Rust obejmujące
brak pola, null, zachowanie liczby i odrzucanie niepoprawnych wartości.
Nie kompilowano ani nie uruchamiano testów Rust z powodu obowiązującego
zakazu. rustfmt --check dla frequency_domain.rs i git diff --check przeszły.
Kontrola formatowania results.rs wykazała rozległe istniejące różnice;
nie wykonano niezwiązanego formatowania całego pliku.

Zmiana pozostaje WIP razem z transportem residualu z natywnego solvera.
Regeneracja OpenAPI i typów klienta oraz weryfikacja kompilacji są nadal
otwarte; nie edytowano plików generowanych ręcznie. Job
6b2de4a74bf64669ae0e92610b1bb078 przy ostatnim odczycie nadal miał stan
running i exit_code=null. Nie obejmuje niniejszych zmian API/Rust.
Nie przybył zaakceptowany punkt nonzero-k ani dowód kwalifikacji fizycznej.

## Korekta semantyki residualu — 2026-09-22

Śledzenie producenta wykazało, że `eigen_native_artifacts.rs` zapisuje
`residual_norm` jako residual bezwzględny, osobno od `residual_relative_l2`.
Dlatego kontrola CSV DE-SMOKE nie może stosować do residual_norm progu
względnego 1e-8. Usunięto ten błędny warunek; wymagana jest nadal wartość
skończona i nieujemna. Raport nazywa maksimum jawnie
`max_absolute_residual_norm`. Odbiór względnego residualu oryginalnego
pencila pozostaje wymagany osobno. 29 testów i cztery podtesty przeszły.

Wykryto także wcześniejszy błąd eksportu ścieżki k: `eigen_path.rs` nie
przekazuje osobnego residual_relative_l2 do SingleKModeResult, a
`modal_manifest::summarize_mode` i producent mode_bundle przypisują do
pola względnego wartość bezwzględną. Naprawa Rust jest w toku; obecny build
nie będzie jej zawierał. Wyników tych pól nie wolno uznać za kwalifikację
bez kontroli oryginalnych natywnych diagnostyk. Ten wpis koryguje wcześniejszą
deklarację progu na kolumnę CSV, nie zmienia naukowego progu T3/T5.

## DE-SMOKE — wersjonowany model jako wejście runtime, 2026-09-22

Klient pilota przyjmuje opcjonalne `--model-ref <pełny SHA>` wyłącznie dla
samodzielnego DE-SMOKE. Model odczytuje przez Git z tego commita, zapisuje
osobno w nowym runie, montuje tylko do odczytu i sprawdza hash przed oraz po
wykonaniu. Zmiana wejścia daje failed także po exit 0. Domyślnie nadal
obowiązuje model zawarty w kapsule. Nie zmodyfikowano kapsuł ani ich manifestów.

To rozdzielenie wejścia problemu od skompilowanego runtime: cały istniejący
odbiór joba, binarium, obrazu, source digest i biblioteki Python pozostaje
obowiązkowy. PYTHONPATH nadal wskazuje pakiet z kapsuły, nie bieżący checkout.
Receipt zachowuje osobne `source`/`runtime` oraz `model_source` (commit,
ścieżka, SHA-256). Nie wolno przedstawiać tego jako buildu nowego commita
modelu. Stary pilot 100 nm importujący konfigurację repo nie dopuszcza tego
wariantu. Zmiana nie dodaje nowej realizacji fizyki ani kontraktu DSL/IR.

Recepta: `just run-de-smoke <job-id> two <pełny-SHA-modelu>`; `five` wybiera
pięć próbek. Aktualny runtime-only build może po sukcesie obsłużyć nowy
samodzielny model, bez powtórnego builda tylko dla skryptu. Samo zestawienie
wejścia i runtime nie dowodzi poprawności wyników — obowiązują T4–T7.

Dziewiętnaście testów Pythona i cztery podtesty klienta/wejścia przeszły.
Sprawdzono przypięcie do commita, odrzucenie ruchomych refów, niezmienność
mountów runtime/DSL, zakaz nadpisania wejścia i wykrycie mutacji po solve.

Dry-run z rzeczywistym wcześniejszym ukończonym jobem
`0c899a2c5dde45cdbc8e9605f2c57aa1` przeszedł weryfikację receiptu i hashy.
Model pobrano z `b8cf20b76711887414d3084291b054da131ba124`, SHA-256
`ea840ae7471d6234209791f58c39dc9ffc6824213184c518b776155b5fc139e8`.
Nie uruchomiono solvera ani nie uznano starego joba za dowód aktualnego
runtime. Bieżący job `6b2de4a74bf64669ae0e92610b1bb078` nadal kompiluje.

## DE-SMOKE — kontrola wierszy wynikowych, 2026-09-22

Dodano `validate_de_smoke_rows.validate_rows` i włączono ją do wykonania
obu wariantów DE-SMOKE. Wymaga pełnych dwóch/pięciu próbek, zgodności
sample_index z wektorem k, nieujemnych całkowitych ID, unikalnych modów
oraz gałęzi w próbce, skończonych częstości w zamrożonym oknie 8.5–12 GHz
i residual_norm w zakresie 0–1e-8. Brak danych nie jest zamieniany na zero.
Nawet exit 0 procesu nie daje completed_unqualified, gdy kontrola zawiedzie.

Łącznie 28 testów Python i cztery podtesty klienta/kontroli wierszy przeszły.
Wynik tej warstwy jest wyłącznie preflight: zawsze zachowuje qualification
NOT VERIFIED i wylicza brakujące wymagania. Nie zastępuje residualu
oryginalnego pencila, natywnego pochodzenia, pól/fazy, identyfikacji n0,
porównania analitycznego ani zbieżności. Pełna bramka T6 nadal otwarta;
nie zmieniono kryteriów C1.

Log joba `6b2de4a74bf64669ae0e92610b1bb078` potwierdził przejście do
native-build i kompilowanie zależności Rust. Poprzednia obserwacja samego
Pythona opisuje wcześniejszy etap. Nie ma jeszcze terminalnego wyniku.

## T4 — wzorzec demagu i stan workera, 2026-09-22

Niezależny wzorzec potencjału 1D oraz jego wyprowadzenie zapisano w commicie
`833dc2e635571b2eb1f5faeb45b89ad13d1b2a19`. Wzorzec rozwiązuje słabą
postać Poissona dla pełnego czynnika exp(-iky), z dokładnymi interfejsami
filmu i zerowym potencjałem na końcach airboxu. Nie oblicza częstości modów.

Dodatkowy przegląd wykrył zbyt dużą domyślną tolerancję bezwzględną asercji
energii; przy energii rzędu 1e-14 J/m² mogła maskować niezgodność.
Test wymaga teraz względnej zgodności 1e-9 z abs=0. Dodano kontrolę
skalowania amplitudy/energii, hermitowskości i dodatniości uśrednionej
macierzy oraz zbieżności drugiej składowej do granicy otwartego filmu.
Łącznie dziewięć testów Python przeszło. Natywne porównanie T4 pozostaje
niewykonane; nie należy utożsamiać wzorca z wynikiem produkcyjnego FEM.

Job `6b2de4a74bf64669ae0e92610b1bb078` nadal działa. Odczyt dokładnego
kontenera pokazał python3, około 63 MiB RAM i 12% CPU, bez procesu
kompilatora. W chwili próbki wchan procesu wskazywał p9_client_rpc.
To dowód oczekiwania na udostępniony system plików, nie dowód konkretnego
procentu materializacji ani zakleszczenia. API logów nadal zwracało pusty
tekst; zadania nie anulowano ani nie zastąpiono duplikatem.

## DE-SMOKE — ścieżka uruchomienia, 2026-09-22

Model zapisano i wysłano w `50f62bd4d039b1e6a5dac1e9be04ef23a593a5bf`.
Dodano receptę `just run-de-smoke <job-id> two` (lub `five`) korzystającą
z istniejącego klienta pilota. Wybór modelu ma zamkniętą listę, jawny eksport
ustawienia próbek, oddzielny katalog i wersjonowany receipt DE-SMOKE.
Sprawdzanie manifestu i hasha modelu w niemodyfikowanej kapsule pozostaje
obowiązkowe; brak modelu odrzuca uruchomienie. Nie osłabiono bramki C1.

Dwanaście testów Python oraz cztery podtesty przeszły, w tym odrzucenie
podmienionego modelu, niedozwolonego wyboru i zapis statusu niezakwalifikowanego.
`just --show run-de-smoke` i kontrola diff przeszły. To dowody klienta,
nie wykonania modelu. Aktualny build nie zawiera jeszcze nowego pliku.

API nadal raportuje job `6b2de4a74bf64669ae0e92610b1bb078` jako running;
niezależny odczyt jego dokładnego kontenera potwierdził Running=true,
OOMKilled=false. Lista procesów pokazała python3 oraz docker-init, bez
procesu kompilatora w chwili odczytu. Pusty log nie pozwala określić
postępu kompilacji. Nie uruchomiono duplikatu ani nie przerwano zadania.

## DE-SMOKE — konfiguracja 10 nm i kontrola DSL, 2026-09-22

Dodano `examples/fem_de_smoke_numeric.py`: komórka 40×40×10 nm,
2 µm powietrza z każdej strony, pełny demag Floquet, CPU/double,
Ms=800 kA/m, A=13 pJ/m, B=0.1 T w x, k w y. Domyślnie dwa
punkty (Γ, 2e6 rad/m); `FULLMAG_DE_SMOKE_SAMPLING=five` wybiera
0/1/2/3/5e6 rad/m. Okno 8.5–12 GHz, cztery mody, eksport pól we
wszystkich próbkach. Wymagane trzy warstwy są intencją siatkowania;
osiągnięta siatka nadal wymaga osobnego sprawdzenia runtime.

Trzy lekkie testy publicznego DSL→IR przeszły: oba zestawy próbek oraz
odrzucenie błędnego wyboru. Sprawdzają rzeczywistą geometrię, materiał,
oddziaływania, periodyczność, fazę, demag, okno i wyjścia. Nie kompilowano
testów natywnych. Konfiguracja nie dziedziczy ustawień pilota 100 nm ani A1.

Job `6b2de4a74bf64669ae0e92610b1bb078` nadal ma status `running`.
Nowy plik nie znajduje się w jego wcześniejszej kapsule źródeł: przed
wykonaniem trzeba zapewnić zgodną, weryfikowaną ścieżkę modelu i runtime.
Nie podmieniono plików kapsuły. T4–T7 i punkty numeryczne pozostają
NOT VERIFIED; dodanie konfiguracji nie jest wykonaniem dyspersji.

## Zabezpieczenie wykonania pilota DE — 2026-09-22

Job `6b2de4a74bf64669ae0e92610b1bb078` został potwierdzony przez API jako
`running`. Nie ma jeszcze terminalnego receiptu ani nowego wyniku fizycznego.

W `run_de_100nm_pilot.py` dodano hostowy watchdog zgodny z limitem kontenera
oraz wspólny, kontrolujący tożsamość kontenera cleanup po błędzie, timeout
lub przerwaniu. Receipt zachowuje końcowy błąd i wynik cleanupu. Naprawiono
fixture identyfikacji kontenera; sześć testów Pythona przeszło, w tym timeout
i KeyboardInterrupt. To testy lifecycle, bez wykonania FEM/Dockera.

Istniejący pilot 100 nm / dziewięć punktów nie jest zamrożonym DE-SMOKE
10 nm / pięć punktów z planu 2026-09-16. Nadal trzeba przygotować i wykonać
właściwy mały przypadek oraz kwalifikację T4–T7; wyników nie wolno mieszać.


## Odblokowanie profilu runtime-only — 2026-09-22

Runner odrzucał zgłoszenie HTTP 400, ponieważ konfiguracja operatora nie
zawierała `fem-cpu-slepc-runtime-v1`. Health błędnie raportował wszystkie
profile katalogu zamiast aktywnej listy operatora. Naprawiono ten odczyt
w `container_main.py`; 22 testy Pythona przeszły. Poprawka źródłowa health
nie jest jeszcze wdrożona w obrazie koordynatora.

Oficjalny klient włączył profil; koordynator został odtworzony na tym samym
obrazie po kontrolowanej pauzie pustej kolejki, następnie wznowiony.
API przyjęło job `6b2de4a74bf64669ae0e92610b1bb078`, profil runtime-only,
commit `0669d76c2306a31dfe162c2f3ae5af4cb458b552`, source digest
`80d37a70ea788833a1813471f0c4dca0bea9f07b34e23b3c7d1b47dadf19cd41`.
Zgłoszenie nie kompiluje testów jednostkowych. Przyjęcie joba nie dowodzi
sukcesu buildu ani fizyki; kolejnym krokiem jest receipt i diagnostyka DE.

Starszy job `0c899a2c5dde45cdbc8e9605f2c57aa1` przeszedł aktualny dry-run
walidatora receiptu i hashy. Jego 61 plików natywnego frequency-domain
jest zgodnych z bieżącymi źródłami po normalizacji końców linii, ale pięć
plików runnera FEM się różni; nie jest dowodem wykonania aktualnego brancha.


## Aktualny stan po naprawach audytu — 2026-09-21

Zweryfikowany bieżący snapshot to HEAD `deb993e27877b0428a7b2a4ea920d716af7e54d8`
na branchu `codex/eigensolve-dispersion-plan-20260912`; worktree jest czysty,
a branch jest wypchnięty do origin. Snapshot zawiera merge z
`origin/master` (`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`) oraz późniejsze
poprawki kontraktów i testów.

Pięć problemów z audytu ma następujący status źródłowy:

| Problem | Stan źródła | Dowód lub ograniczenie |
|---|---|---|
| Analityka zastępowała FEM | naprawione | `dispersion_validation` odrzuca syntetyczny solver; `execute_fem_eigen_path` wykonuje native solve, a wartości KS/DE/BV są dopisywane po solve do CSV. |
| Niestabilne `P00` przy $k\to0$ | naprawione | Python i Rust używają wspólnego rozwinięcia Taylor/expm1; regresje sprawdzają ciągłość częstości, nie tylko współczynnika. |
| Sztywne limity `3e6` i `5 GHz` | naprawione | Są wyłącznie wartościami presetu; planner waliduje skończone parametry przekazane w `runtime_metadata`, a fixture C1 podaje własny zakres. |
| Brak wykonywalnej bramki naukowej | naprawione źródłowo | Benchmark wywołuje fail-closed validator wymagający 61 próbek, 8 pasm, Kittel/KS, finite rows i trzech kampanii zbieżności; bez bundle porównawczego wynik pozostaje `NOT VERIFIED`. |
| Niespójna dokumentacja/checkpoint i telemetryka | naprawione w bieżącym opisie | Dokument rozdziela implementację źródłową, wykonanie managed i kwalifikację fizyczną; początkowy progress nie publikuje stałego `300`, a limit trafia z callbacku EPS. |

Kontrole źródłowe CI dla tego snapshotu: Rust, Python, API, generated API,
FDM i Control Room zakończyły się sukcesem. Browser smoke przeszedł bazowy
fixture i negative control, ale test mutacji Inspectora zatrzymał się na braku
`model:object:film`; jest to osobny regres UI. Managed FEM pozostaje w kolejce,
więc bieżący snapshot nadal nie ma nowego runtime receipt ani zaakceptowanej
dyspersji `k≠0`.

## Synchronizacja źródeł — 2026-09-21

Worktree `C:\\git\\fullmag\\worktrees\\eigensolve-dispersion-plan-20260912`
został zsynchronizowany z najnowszym `origin/master` przez merge commit
`60302922e`; drugim rodzicem jest
`93f11dbc564c00b725d174ccb2fd0ff9a96493c9`. Przywrócono lokalne poprawki
audytu z zachowanego stasha bez konfliktów. Włączone są aktualizacje mastera
dotyczące persystencji projektu, runtime verification, obserwowalności runnera
i UI oraz wersjonowanego AST parametrów; zachowano jednocześnie kontrakty
SLEPc/Floquet, fail-closed telemetrykę, stabilne P00, rozdzielenie solve od
analityki oraz bramkę naukową dyspersji.

Na snapshotcie przed ostatnim commitem mastera przeszły: parsowanie 23
zmienionych skryptów Python,
6 kontroli kontraktów Floquet/SLEPc oraz 15 testów orkiestratora benchmarku;
pełna bateria walidatora naukowego dała 49/49. To są dowody źródłowe, nie
dowód wykonania natywnego FEM. `cargo fmt --check` dla całego checkoutu nie
jest zielony z powodu formatowania odziedziczonego z aktualizacji mastera;
nie zmieniono go automatycznie, aby nie rozszerzać zakresu synchronizacji.

Stan fizyczny pozostaje `NOT VERIFIED`: nie ma nowego managed runtime receipt
dla tego HEAD, pełnej ścieżki C1/A1 (61 próbek, 8 gałęzi), zbieżności siatki/
airboxu/liczby modów ani browser proof. Nie uruchamiano ciężkiego buildu przy
ograniczonej przestrzeni runnera.

### Kontynuacja po synchronizacji — 2026-09-21

Po tym checkpointcie poprawiono dwa regresy ujawnione przez CI: synchronizacja
żądań obserwacyjnych nie zwiększa już rewizji widoku drugi raz w ramach jednej
mutacji (`ae6c690ec`), a test checkpointu korzysta z identyfikatora wygenerowanego
przez endpoint zamiast z nieaktualnego identyfikatora stałego (`613ca6a0b`).
Oczekiwanie testu inspekcji archiwum uwzględnia konserwatywne ostrzeżenie dla
`project/current_live_snapshot.json` bez typowanych referencji, wprowadzone w
najnowszym `masterze`. Bieżący HEAD po naprawach testowych to `deb993e27`;
source/contract CI potwierdziło ten snapshot. Nie zmienia to granicy naukowej:
brakuje świeżego managed receipt FEM, niepustego solve dla `k≠0` i kwalifikacji
pełnej relacji dyspersji.

## Audyt i korekta stanu — 2026-09-19

Bieżące ustalenia: [audyt implementacji i frontendu](../../audits/2026-09-19-dispersion-implementation-audit.md).
Dwa kontenery C1 z 2026-09-18 pozostały aktywne mimo limitów czasu klienta
(3600/21600 s). Po potwierdzeniu pełnych ID i mountów zatrzymano wyłącznie
te dwa procesy. Oddzielne pliki `audit-recovery-20260919.json` zachowują dowód
interwencji; historyczne wyniki nie zostały przepisane.

Heartbeat oraz przyrost `idle` nie dowodzą konwergencji, zakończenia punktu k
ani wejścia w konkretny podetap solvera. Poprzednie komentarze sugerujące
postęp na tej podstawie należy skorygować. Nie ma zatwierdzonych artefaktów
C1 z tych przebiegów. C0 bez demagu nie potwierdza C1 Gamma z demagiem.

Potwierdzono także utratę callbacku postępu i Stop/Pause przy przejściu przez
orchestrator ścieżki k. Trwa naprawa propagacji callbacku i kontroli czasu
życia kontenera oraz równoległy audyt fizyki, walidacji i frontendu.
Ponowienie pełnych 61 punktów wymaga najpierw rozpoznania pojedynczego solve.
Profil weryfikacyjny ewentualnego buildu: `fem-cpu-slepc-runtime-v1`, bez
kompilacji testów jednostkowych. Źródła, build, runtime i fizyka mają oddzielne
statusy; cały nonzero-k pozostaje `NOT VERIFIED` do uzyskania dowodów.


## Najnowszy checkpoint solvera — 2026-09-18

Managed job `f60da21a0f444e62bdd4ddee12577bd9` zbudował runtime i zaliczył
kontrakt SLEPc 8/8. Po normalizacji operatora pierwszy kanoniczny C0 wykonał
się poprawnie: powstał jeden punkt `k=0`, częstotliwość
`2.800264212915114 GHz`, względny residual `3.01e-27`, a błąd względem
Kittela wyniósł `1.36e-15`. C0 nie jest jeszcze kwalifikacją naukową, bo
brakuje kampanii zbieżności siatki/liczby modów; jego status bramki to
`NOT VERIFIED`. Wygenerowany wykres znajduje się w artefaktach runu jako
`c0/eigen/plots/dispersion-c0.png`.

W bieżącym worktree poprawiono solver w
`backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`: obie strony
realnej rotacji są teraz skalowane wspólnym czynnikiem wyprowadzonym z normy
operatora i targetu, a shift `MAT_SHIFT_NONZERO` pozostaje względny po tej
normalizacji. W wyniku zapisuje się `operator_normalization_scale`; dla
każdego podokna telemetria zapisuje też przyczynę odrzucenia, liczby
kandydatów dodatnich/w-oknie, zakres częstotliwości i maksymalny residual
kandydata. Nie zmienia to wartości własnych uogólnionego problemu.

Próba C1 na tym runtime wygenerowała poprawną siatkę (615242 tetraedry,
108749 węzłów), ale zatrzymała się przed modalnym solve na ochronie certyfikatu:
`canonical_preimage_length_overflow` przy starym limicie 16 MiB. Limit został
podniesiony do 256 MiB z zachowaniem skończonego fail-closed boundu w
`backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp`. Nowy
managed job `bd32ae0aa45e437580393aebba4d20a1`, profil
`fem-cpu-slepc-modal-v1`, source digest
`7fa23ebf9cdbf2e850201b2a4571c4c7909c19a304ce4587d63e70b635e5abce`, jest
terminalnie `succeeded`; kontrakt ma 8/8 testów, CPU/double/SLEPc i
`fallback_used=false`. C1 należy teraz ponowić na tym dokładnie attested
runtime, sprawdzić pełne artefakty Floqueta/demagu i dopiero uruchomić A1; do
czasu tych dowodów runtime non-zero-k, pełna fizyka dyspersji i bramka naukowa
pozostają `NOT VERIFIED`.

Ponowienie C1 na `bd32ae0aa45e437580393aebba4d20a1` uruchomiono z `--cases c1`
i limitem 3600 s. Certyfikat siatki przeszedł (615322 tetraedrów, 108788
węzłów), relaksacja zakończyła się po 3 krokach, a natywny proces modalny
pracował do wygaśnięcia limitu. Run zakończył się `status=failed`,
`timed_out=true`, bez `dispersion.csv`, widma, tabeli gałęzi i bez uruchomienia
bramki naukowej. Jest to blokada wydajnościowa pełnego C1, nie dowód błędu
fizycznego ani sukcesu runtime; diagnostyczny log zachowano w artefakcie
`comsol-dispersion/00db21eae1644871b14c71db18f23f3d/c1/runtime.log`.

Na żądanie operatora przeprowadzono ograniczone sprzątanie storage. Z katalogu
terminalnie nieudanego joba `9da3622cca884500a49f1295081e4d6a` usunięto tylko
podkatalog `execution` (0,276 GiB, bez aktywnego procesu, kontenera, mountu
ani dowiązania). Artefakty, receipt, manifest, logi i dowód błędu pozostały w
tym runie; aktywny job `bd32…` i jego dane nie były modyfikowane.

## Bieżący stan weryfikacyjny — 2026-09-18

Ten wpis jest aktualnym punktem odniesienia; dalsze sekcje dokumentu zachowują
historię wcześniejszych checkoutów, commitów i jobów. Bieżący worktree to
`C:\\git\\fullmag\\worktrees\\eigensolve-dispersion-plan-20260912`, branch
`codex/eigensolve-dispersion-plan-20260912`, HEAD
`a7723cf0b3dd179f32da5294dbda8dcd685b6e14`, z niezacommitowanymi zmianami
źródłowymi kilku etapów pracy. Nie należy interpretować historycznych wpisów
o czystym worktree ani dawnych jobach jako dowodu obecnego stanu.

| Wymaganie | Źródło | Wykonanie | Walidacja fizyczna |
|---|---|---|---|
| Analityka po rzeczywistym solve | Guard wykonania odrzuca syntetyczny K0 przy `dispersion_validation`; KS jest postsolve | C0 z f60 ma rzeczywisty solve i Kittel: `2.800264212915114 GHz`, rel. błąd `1.36e-15` | C0 punktowo potwierdzony; pełna bramka `NOT VERIFIED` |
| Stabilne P00 i ciągłość częstości | Rust/Python: Taylor + `expm1`; ciągłość częstotliwości w walidatorze | Kontrole Pythonowe przechodzą | Native FEM `NOT VERIFIED` |
| Zakres C1 | Planner nie ma sztywnych limitów `3e6`/`5 GHz`; C1 ma 61 próbek i zakres do X | Certyfikat i relaksacja przeszły na `bd32…`, ale pełny modal solve przekroczył limit 3600 s i nie zapisał artefaktów | Artefakty C1 `NOT VERIFIED`; potrzebny dłuższy przebieg lub odrębny, jawnie diagnostyczny punktowy probe |
| Bramka naukowa | Orchestrator wywołuje fail-closed gate; gate wymaga 61 próbek, 8 gałęzi, Kittel/KS i zbieżności | C0 ma poprawny artefakt, lecz tylko 1 próbkę; C1/A1 i zbieżność są otwarte | `NOT VERIFIED` |
| Polityka solvera i telemetria | Jawny PETSc/SLEPc policy; dodatni amount shiftu faktoryzacji jest względny względem norm operatorów, a KSP zgłasza niepowodzenie | Managed job `f60da21a0f444e62bdd4ddee12577bd9` zakończył się `succeeded` na PETSc 3.24.6/SLEPc 3.24.3; build i kontrakt `slepc-modal` mają exit 0, a CTest raportuje 8/8 testów | Runtime modalny C1/A1 i fizyka pełnej dyspersji `NOT VERIFIED` |

Wybrany zestaw lekkich kontroli źródłowych daje **128 passed, 54 subtests
passed**. `rustfmt --check` dla zmienionych plików Rust i `git diff --check`
przechodzą. Poprzedni poprawiony przebieg C0 (`0a7ebc1c59a8415b9072447ae99e9202`)
doszedł do produkcyjnego solvera, lecz zakończył się zerowym pivotem PETSc i
został zatrzymany po wzroście pamięci; nie powstał ważny punkt częstotliwości.
Wprowadzono teraz względny dodatni shift tylko dla faktoryzacji LU, jawne
`KSPSetErrorIfNotConverged` oraz telemetrię polityki shiftu. Job
`9da3622cca884500a49f1295081e4d6a` zakończył kompilację błędem, ponieważ
PETSc 3.24.6 nie definiuje `MAT_SHIFT_POSITIVE`; poprawiono to na
`MAT_SHIFT_NONZERO` z jawnym dodatnim amountem względem norm operatora. Job
`134a6139c0354eeab81132a0bc193fd9` również nie utworzył kontenera workera;
zamknięto go jako `blocked`, zachowując dowód braku `coordinator.json` i logów.
Managed job `f60da21a0f444e62bdd4ddee12577bd9` użył profilu
`fem-cpu-slepc-modal-v1`, snapshotu `0737933f537f48e28568d97e5bb34197` i
źródłowego digestu `4a8ea1cd8e32f8b9cdd13642695624fdfca4e7ff278a2c78eeca04cf7fe23077`.
Receipt koordynatora jest terminalnie `succeeded`, obraz ma digest
`sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`, a
kontrakt zawiera osiem zaliczonych testów Floquet/modalnych. C0 ma już wynik
solvera i wykres, ale nie zamyka C1/A1 ani zbieżności. Stare logi
`CTest/Temporary` i poprzednie przebiegi nie są dowodem dla tego joba.

Kontrola dokumentacji z 2026-09-17 usunęła sprzeczne deklaracje „nie
zaimplementowano” z kontraktów `0600`, `0700`, `0710`, `0828` i `0831`.
Dokumenty rozróżniają teraz source-visible CPU Floquet/airbox bridge od
managed-runtime i physics qualification; capability error pozostaje wymagany
dla bieżącego niezweryfikowanego snapshotu. Walidatory map źródłowych, walidator
podziału produktów oraz 32 testy kontraktu dokumentacji przechodzą; poprawiono
też dwie stare asercje fixture'ów runtime, a wybrany zestaw kontraktów daje
**79 passed**. Nowego snapshotu nie wysyłano, ponieważ storage runnera ma
około **0,74 GB** wolnego miejsca.

W tej samej kontroli zamknięto M6 na granicy fizycznego bridge'a: niehermitowski
Schur dynamicznego demagu z względnym residualem powyżej `1e-8` jest odrzucany
przed przekazaniem do modalnego operatora. Niski oracle algebraiczny pozostaje
dopuszczający fixture'y manufakturowane. Źródłowy test kontraktowy tej
osłony przechodzi (`2 passed`); nie jest to jeszcze dowód managed runtime.


## Aktualizacja stanu źródeł i runtime — 2026-09-16

Bieżący checkout to worktree `eigensolve-dispersion-plan-20260912`, branch
`codex/eigensolve-dispersion-plan-20260912`; aktualny HEAD należy zweryfikować
przez `git rev-parse HEAD`. Worktree jest czysty przed tym checkpointem.
Commit źródłowy `5f53ee304` naprawia serializację JSON diagnostyki modalnego
okna CPU (`ksp_rtol`), która przerwała
poprzedni przebieg C0 przed walidacją artefaktów.
Poniższa tabela opisuje aktualny snapshot, a dalsze sekcje zachowują historię.

| Zakres | Stan źródła | Aktualny dowód / ograniczenie |
|---|---|---|
| Analityka kontra FEM | DE/BV jest postsolve oracle; ścieżka `dispersion_validation` przechodzi przez numeryczny solve. Jawny syntetyczny solver pozostaje wyłącznie ograniczonym K0-3 oracle. | Kod rozdziela `reference_oracle` od produkcyjnej `FemEigenExecutionResolutionIR`; brak jeszcze dowodu fizycznego z pełnego runtime. |
| P00 i ciągłość przy Γ | Stabilny Taylor + `expm1` istnieje w Pythonie i Rust; bramka porównuje także ciągłość częstotliwości. | Dowód źródłowy; wynik native nadal oczekuje na benchmark. |
| Zakres C1 | Planner nie narzuca `3e6 rad/m` ani `5 GHz`; limity są parametrami walidacji i presetów. | Kanoniczny C1 obejmuje 61 próbek do X; pozostaje sprawdzenie na artefaktach native. |
| Bramka naukowa | Runner wywołuje scientific gate po sprawdzeniu artefaktów; gate wymaga 61 próbek, 8 gałęzi, Kittel/KS, finite rows, residualu, fazy oraz zbieżności. | Status nadal `NOT VERIFIED`, bo nie ma jeszcze zakończonego C0/C1/A1. |
| Operator Floquet | Sprzężenie shared-domain stosuje `A_qphi=-mu0*A_phiq^H`; wynik przechowuje właścicieli MFEM form/coefficientów. | Wymaga kompilacji i wykonania managed MFEM/SLEPc; źródło nie jest dowodem runtime. |
| Telemetria/polityka | Początkowe `max_iterations=None`; callback publikuje rzeczywisty limit. Jawna polityka PETSc pozostaje single-process CPU. | Pomiar skalowania i runtime są otwarte. |
| Ostatni C0 | Przebieg na wcześniejszym buildzie doszedł do natywnego solvera, ale zakończył się błędem parsera JSON w diagnostyce modalnego CPU (`123"ksp_rtol`). | Błąd serializacji naprawiono w `5f53ee304`; poprzedni wynik nie kwalifikuje fizyki. Po poprawionym buildzie trzeba ponowić C0. |
| Bieżący managed build | Job `a39c46d3dd484cc385c64924d1e0ec8b`, profil `fem-cpu-slepc-runtime-v1`, commit `5f53ee304`, stan `running`; runner potwierdza zdrowie i przyjęcie joba. | Log kompilacji jest jeszcze pusty w początkowej fazie przygotowania. Po zakończeniu trzeba uruchomić C0, następnie C1/A1. Kwalifikacja pozostaje `NOT VERIFIED`. |

Kwalifikacja naukowa, wykres dyspersji z rzeczywistego operatora oraz release
pozostają otwarte. Syntetyczne wartości analityczne i testy kontraktowe nie są
dowodem wykonania natywnego FEM.


## Aktualizacja po uruchomieniu natywnego C0 i osłonach skalowania — 2026-09-15

Aktualny checkout to worktree `eigensolve-dispersion-plan-20260912`, branch
`codex/eigensolve-dispersion-plan-20260912`, HEAD
`82e726b13`. Branch jest wypchnięty na `origin`. Wcześniejsze SHA, joby i wyniki
pozostają historią; poniższy wpis opisuje aktualny kod i najnowsze dowody
wykonania.

| Zakres audytu | Stan źródła | Dowód wykonania / ograniczenie |
|---|---|---|
| Analityka kontra FEM | `dispersion_validation` jest porównaniem postsolve; `eigen_path.rs` wykonuje numeryczny single-k solve, a kolumny analityczne są dopisywane do CSV po wyniku. Produkcyjna rozdzielczość odrzuca referencyjny/syntetyczny solver. | Nie jest to jeszcze dowód natywnego wyniku; każdy przypadek musi zakończyć się poprawnym receipt'em i artefaktami. |
| Stabilność `P00` przy `k→0` | Python i Rust używają wspólnego schematu Taylor + `expm1`; bramka sprawdza ciągłość częstości, nie tylko współczynnika. | Dowód źródłowy/testy kontraktowe; brak zakończonej kampanii FEM. |
| Zakres C1 | Planner nie narzuca już stałych `3e6 rad/m` ani `5 GHz`; zakres wynika z metadanych i sprawdzanej stosowalności modelu. | C1 nadal wymaga rzeczywistych próbek i zgodności z analityką w dozwolonym zakresie. |
| Bramka naukowa | Runner wywołuje walidator scientific gate; wymaga pełnych przypadków C0/C1/A1, ścieżki 61 próbek, ośmiu gałęzi, pól, Kittel/KS i zbieżności. | Status pozostaje `NOT VERIFIED`, dopóki nie ma kompletnych wyników. |
| Polityka solvera/telemetria | Adapter publikuje rzeczywiste limity z callbacku; początkowe `max_iterations` pozostaje `None`, zamiast stałej `300`. Polityka PETSc jest jawnie opisana. | Weryfikacja managed runtime z bieżącym HEAD i pomiar skalowania pozostają otwarte. |
| Transport operatora | Runner zachowuje macierze do rekonstrukcji modalnej, ale przekazuje także jawny CSR; duża diagnostyka gęsta jest pomijana i raportuje `skipped_large_operator`. | Commity `c69c16b7` i `82e726b1`; wymagany jest nowy managed build i wynik runtime. |
| Ostatni managed build | Job `56a8e337581144899a91d90274d43ee5` zakończył się `succeeded` dla profilu `fem-cpu-slepc-runtime-v1`, lecz źródło receiptu to wcześniejszy commit `20d6ae76`; wynik kwalifikuje tylko build, nie fizykę. | Nie jest dowodem dla HEAD `82e726b13`. |
| Bieżący managed C0 | Run `03066685758b414b820531c15dd8f807`, przypadek C0, używa runtime z joba `56a8e337...`; kontener jest żywy i natywny SLEPc raportował postęp do kroku 30. | Brak terminalnego receiptu i artefaktów widma; należy dokończyć ten przebieg albo, po jego terminalnym stanie, uruchomić nowy build z bieżącego HEAD. |

Pierwszy aktualny przebieg potwierdza wejście do natywnego solvera, ale nie
zamknął jeszcze etapu zapisu artefaktów. C0 jest tylko kontrolą w punkcie Γ;
C1/A1, pełna ścieżka 61 próbek i wykres dyspersji nadal pozostają otwarte.


## Bieżący checkpoint po poprawce ciągłości częstotliwości — 2026-09-14

Aktualny worktree `eigensolve-dispersion-plan-20260912` na branchu
`codex/eigensolve-dispersion-plan-20260912` zawiera implementację ciągłości z
`3b8065466` oraz ten checkpoint; bieżący commit potwierdza
`git rev-parse HEAD`.
Worktree jest czysty. Ten checkpoint rozdziela dowody źródłowe od wykonania
managed runtime i od kwalifikacji fizycznej.

| Zakres | Stan bieżący | Dowód lub następny krok |
|---|---|---|
| P1 — numeryczny solve i analityczne porównanie | Zaimplementowane w źródłach | `eigen_path.rs` wykonuje numeric single-k solve; analityka pozostaje referencją postsolve |
| P00 przy `k→0` | Zaimplementowane w źródłach | Rust/Python używają Taylor + `expm1`; nowa kontrola sprawdza ciągłość częstotliwości |
| Zakres C1 | Zaimplementowane w plannerze/walidatorze | Brak sztywnych limitów `3e6 rad/m` i `5 GHz`; pozostaje walidacja stosowalności modelu |
| Bramka naukowa C0/C1/A1 | Kod bramki gotowy, wynik naukowy otwarty | Wymagane rzeczywiste 61 próbek, 8 gałęzi, Kittel/KS i zbieżność mesh/airbox/mode-count |
| Polityka PETSc/telemetria | Zaimplementowane w źródłach | Sequential PETSc, LU dla Poissona, GMRES/Jacobi dla układu przesuniętego, odczyt rzeczywistych limitów |
| Managed runtime | W TRAKCIE | Job `669d35c722c54745aed4965d6de191ed` (commit `fbbc87a4`) kompiluje się na obrazie koordynatora `sha256:42596c689843141ec68cf782d50ae9bcf90bc1d219c553b665186ecce3b1af36`; po zakończeniu potrzebny jest nowy job dla bieżącego HEAD tego worktree |
| Kwalifikacja fizyki i release | NOT VERIFIED | Nie ma jeszcze receiptu z poprawnym runtime ani wyników benchmarku C0/C1/A1; B4–B6 pozostają otwarte |

Weryfikacja po zmianie: `test_validate_comsol_dispersion_scientific_gate.py`
**43/43**, `test_verify_fem_frequency_domain_eigen_artifacts.py` **203 passed**.
Te testy nie są wykonaniem natywnego operatora FEM. Kontrola ciągłości w bramce
raportuje pary próbek KS, a walidator artefaktów odrzuca skok częstotliwości
między sąsiednimi próbkami scenariuszy DE/BV.

## Audyt GPT PRO 6 — korekta priorytetów 2026-09-14

Obowiązuje [integracja 20 ustaleń i zaktualizowana kolejność napraw](2026-09-14-non-k0-pro6-audit-integration.md).
Audyt bazuje na master `33aa26f`; aktualność sprawdzono na worktree HEAD
`3833c93eb2d52f575e2b8c67d7723225bc3cd61c` oraz roboczych plikach bramki.
Najpierw osłony starego adaptera, fizyczny operator i certyfikat odzyskanego modu;
potem kwalifikacja istniejącej sparse ścieżki CPU z demag. NK-17/18 są poprawione
w źródłach; nie oznacza to native qualification. B4–B6 nadal otwarte, teraz także
z kontrolą pola/fazy/n=0 i kampanią co najmniej 3 siatek oraz 3 airboxów.
Poniższe checkpointy zachowują historię; starsze SHA, wyniki testów i statusy jobów
nie opisują automatycznie stanu bieżącego. Aktualizacja planu nie stanowi naprawy NK-01–20.

### Managed runtime — wynik joba 51 i korekta loadera CUDA — 2026-09-14

Job `d6f1e5c18ab640c79761f8320feff2ba` zbudował natywny runtime dla commita
`ffbbf8650c62b848d7c86b03f081a3b336cd9380` w obrazie FEM
`sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`.
Etap `make install-cli-dev` zakończył się kodem 0, a poprawiony trusted runner
znalazł zagnieżdżony `release/build/fullmag-fem-sys/<hash>/out/native-build/CMakeCache.txt`;
job zakończył się jednak `NOT VERIFIED` z powodu probe:
`fullmag-bin` nie ładował `libcuda.so.1`, ponieważ worker nie dodawał obrazu
`/usr/local/cuda/compat` do `LD_LIBRARY_PATH`. Nie jest to błąd solvera FEM ani
dowód kwalifikacji fizycznej.

W źródłach dodano fail-closed wykrywanie image-owned compatibility SONAME,
wiązanie ścieżki w `runtime-attestation.json` oraz regresje entrypointu. Ostatnia
weryfikacja lokalna: `test_local_runner_build_entrypoint.py` **26 OK** i
`test_local_runner_build_executor.py` **14 OK**. Po commicie trzeba ponownie
zbudować obraz koordynatora, uruchomić nowy managed runtime build, a dopiero po
receipcie uruchomić benchmark C0/C1/A1; B4–B6 pozostają otwarte.

### Wdrożenie trzech poziomów zbieżności — 2026-09-14

Robocza bramka v2 wymaga coarse/medium/fine dla mesh i airbox (C0 bez demag:
not_applicable). Sprawdza kierunek zmiany hmax/odległości, fizykę wspólną dla
przebiegów, oba sąsiednie przyrosty częstości i brak rosnącego trendu ponad
margines 1e-8. Nie wyznacza z tego automatycznie błędu continuum.
Test regresyjny wykazał wcześniej fałszywe qualified dla dwóch poziomów
(mesh i airbox); po poprawce zestaw bramka/agregacja/benchmark:
**36 passed, 15 subtests passed**. Są to interpretowane testy z syntetycznymi
artefaktami, nie wynik kampanii FEM. Dodatkowo naprawiono pomylenie bezwymiarowego
airbox.factor (401) z paddingiem w metrach (2e-6): tożsamość airboxu pochodzi teraz
z DomainFrameIR. Test red→green potwierdził błąd. Kontrola rzeczywistych pól/fazy
jest w toku; review wykrywa też ryzyko porównania różnych siatek przez surowe
tablice równowagi w sygnaturze, które wymaga dalszej korekty przed kwalifikacją.

Odczyt managed runnera przy tej aktualizacji: worker_alive=true,
accepting_jobs=true, job 44 `635451d7648a446a83e8d88e21c0279b` nadal running,
źródło `28f552b959455957bbf6dada8a522a241425552c`. Nie restartowano runnera;
nowy obraz koordynatora pozostaje niewdrożony. Ten job nie kwalifikuje HEAD3833.

### Certyfikat pól i korekty review bramki — 2026-09-14

Bramka v2 jest połączona z niezależnym odczytem vector.bin dla gałęzi i punktów
kontrolnych. Odrzuca brak pola, błędną fazę mimo nowego hasha i podmianę pola
Gamma za próbkę nonzero-k. Sprawdza pełną kolejność węzłów, pary i translacje.
Residuum Blocha normalizuje całym niezerowym polem; zerowy ślad na brzegu
spełnia warunek i nie jest mylony z zerowym modem w całej domenie.

Dalsze poprawki: target i siatka są stałe w mode-count comparison, fe_order
jest stały przy h-refinement, a magnetyczne bounds i hmax przy zmianie airboxu.
Stałe nodalne pola nie różnią się podpisem przez samą liczbę powtórzeń.
Wersje spectrum/branches/manifest są kontrolowane w primary i comparison runs.
Agregator odrzuca qualified z niepustymi lub nieprawidłowymi reasons.

Weryfikacja: **68 passed, 25 subtests passed** — certyfikat, scientific gate,
agregacja, benchmark runner i testy dokumentacji. Brak kompilacji native.
Wcześniejszy błąd tuple/Path w trakcie integracji certyfikatu został usunięty;
wynik powyżej pochodzi z ponownego wykonania całego wymienionego zestawu.

**Nadal otwarte:** profil KS n=0 z pól kontrolnych, przestrzenna zgodność
niejednorodnej równowagi między siatkami (surowe tablice nie są poprawnym
transferem), rzeczywista kampania C0/C1/A1 oraz kwalifikacja operatora i widma.
Syntetyczne fixtures nie dowodzą tych punktów. B4–B6 i cel pozostają W TRAKCIE.

## Aktualizacja po review — 2026-09-14

Stan: **W TRAKCIE**, fizyka non-k0 **NOT VERIFIED**. Sprawdzony HEAD:
`55aadf7f2cbfd2fced91b3cf896e8e17cbb7ce61`, plus niezacommitowane poprawki
bramki naukowej i profilu produkcyjnego SLEPc bez kompilacji unit testów; branch i worktree pozostają
te same. Checkpoint z 13 września poniżej stanowi historię, również w zakresie
runnera, jobów, tokena i wolnego miejsca; nie jest aktualnym health-checkiem.

| Problem review | Implementacja | Dowód / pozostała praca |
|---|---|---|
| Walidacja przełącza FEM na analitykę | Naprawiona w źródłach | Usunięte obejścia planera/runnera; kontrakt manifestu i 8 testów DE/BV passed; native niekompilowany |
| P00 przy k do zera | Wspólne stabilne kernele Python i Rust | 27 testów Python, w tym 80-cyfrowa referencja Decimal i ciągłość częstości; brak kompilacji Rust |
| Sztywne 3e6 rad/m i 5 GHz | Usunięte z walidatorów Python/plannera; defaulty zachowane | 2 testy Python API passed, w tym zakres C1 i NaN/Inf; planner niekompilowany |
| Bramka naukowa C0/C1/A1 | Implementacja w toku | B4–B6 otwarte do rzeczywistych wyników i zbieżności |
| Dokumentacja | Noty 0600/0828 i spec artefaktów zaktualizowane | 10 testów dokumentacji, 32 testy jej narzędzi, source-map 0828 pass; checkpoint aktualizowany wraz z pracą |
| Polityka solvera / telemetria | Naprawiona w źródłach | Jawny single-process CPU, KSPGetTolerances dla obu układów, usunięte zgadywane 300; native niekompilowany |


### Ostatnia kontrola roboczego snapshotu

[Review bieżącego stanu](2026-09-14-non-k0-current-review.md) zawiera zakres,
ustalenia i ograniczenia. Kontrole P00/KS/agregacji: **51 passed**. Kontrole
bramki naukowej i runnera benchmarku: **11 passed, 2 failed**; pozytywny fixture
nie odpowiada jeszcze aktualnemu formatowi natywnych artefaktów. Są to wyniki
roboczej wersji w trakcie poprawek, a nie dowody dla przyszłego commita.

Profil `fem-cpu-slepc-runtime-v1` oraz jego obsługa w benchmarku są zapisane
w commicie `a020f46f0829362d942b7eeebbdd923afcc6f0f2`. Wspólny zestaw
kontroli entrypoint/executor/client/benchmark: **80 passed, 4 subtests passed**.
Hash biblioteki wiąże konfigurację CMake z runtime, a startup stamp musi mieć
snapshot zgodny z receipt. To dowód kontraktu źródłowego, nie wykonania FEM.

Recepta `just runner-coordinator-image` zakończyła się exit 0 i przygotowała
obraz `sha256:4e52622ba0da64d8f4de76539ec4bff6f1511c7c6fd74370c3a7827de9ffcd0e`.
Obraz nie został wdrożony. Odczyt runnera po buildzie wykazał aktywne zadanie
`635451d7648a446a83e8d88e21c0279b` (44), stan running, profil
`fem-cpu-slepc-modal-v1`, źródło `28f552b959455957bbf6dada8a522a241425552c`.
Nie zatrzymano ani nie podmieniono aktywnego koordynatora. Jego allow-list nie
obejmuje jeszcze nowego profilu. Zbudowanie obrazu nie stanowi kwalifikacji
managed runtime ani B4–B6.

Testy Python uruchomiono z `-B` i wyłączonym cache pytest. Pierwsze zebranie
testów API nie znalazło pakietu `fullmag`; ponowienie z repozytoryjnym
`PYTHONPATH=packages/fullmag-py/src` zakończyło się powodzeniem.
Obowiązuje zakaz kompilacji testów jednostkowych. Żaden z powyższych wyników
nie jest dowodem wykonania natywnego MFEM/SLEPc ani poprawności pełnego widma.

Wcześniejszy odczyt `just runner-container-status` (2026-09-14; nie ponowiony przy tej aktualizacji):
`worker_alive=true`, `accepting_jobs=true`, około 48.0 GB wolnego miejsca.
Job 43 `9ce502f938a64abd85d74d4e391b5d3a` jest `running`, dla czystego
commita `95763e6a7f3d6a7c19657bd214d5d805082b926b`; nie obejmuje zmian review.
Nie uruchomiono nowego buildu ani nie zmieniono koordynatora.
Kontrole: 7 testów istniejącego walidatora DE/BV passed, 10 testów dokumentacji
passed, walidacja source-map noty 0828 exit 0. Są to dowody źródłowe,
a nie wynik obliczenia dyspersji. Dodano regresję planera C1 i ujemnego k;
pozostaje niekompilowana zgodnie z ograniczeniem użytkownika.

Dodatkowa kontrola stosowalności KS: odrzucenie pola przeciwnego/poprzecznego,
niezerowego DMI/anizotropii i niejednorodnych pól Ms/A. Wynik: **18 passed**
(11 regresji stosowalności oraz 7 istniejących testów DE/BV).
Review nowej bramki naukowej wykazało, że same deklaracje częstości w evidence
nie wystarczają; wymagane jest powiązanie obserwacji z rzeczywistymi artefaktami
kontrolnymi i zagęszczonymi. Ten punkt pozostaje w naprawie.

Przyrost `da9a0ecf54767823dcc8eb1f4a62807ced0e61cb`:
niezależne referencje Decimal (80 cyfr) dla P00 i częstości BV/DE oraz
przenośne asercje ścieżek Windows/Linux. Generator: **27 passed**.
Pełny walidator: **199 passed, 3 failed** wyłącznie na separatorach ścieżek;
po poprawie trzech asercji ich ponowienie: **3 passed**, 199 deselected.
Nie jest to ponowne wykonanie wszystkich 202 testów po poprawce.
Staged lista dwóch plików i diff/check zostały sprawdzone przed commitem.
Równoległy commit `cfab8109d7e44a7693b8c6d405cb2450611d1ead` zawierał
wcześniejsze zmiany całego worktree; jego obecność nie stanowi kwalifikacji.

Przyrost `052bf7d0f9626b8d6e0d9600a06d57d28e3250fb` domyka kontrakt
numerycznego porównania: usunięty stary wariant solvera referencyjnego,
manifest wskazuje KS jako niezależny model, walidator akceptuje tę postać
i odrzuca analityczne źródło dynamicznego demagu dla wyniku numerycznego.
Osiem testów DE/BV (w tym nowa regresja manifestu) passed. Rust: sprawdzony
źródłowo i przez rustfmt przez agenta routingu; brak kompilacji. Recepta
samodzielnego generatora CSV pozostaje jawnym wejściem do analityki.

Dokumentacja polityki i mapy źródeł została zapisana w
`be01c536032f3dbff9752bd1abc341b93be760ba`. Przeszło 10 testów dokumentacji,
32 testy narzędzi scientific-documentation-contract oraz walidator mapy 0828.
Odczyt profili wykazał brak istniejącej trasy SLEPc runtime-only:
`fem-cpu-release` ustawia SLEPc OFF, a `fem-cpu-slepc-modal-v1` wymaga
kompilacji kontraktów. Trwa przygotowanie odrębnego profilu produkcyjnego bez
kompilacji testów; nie wdrożono go do aktywnego koordynatora.
Wcześniejszy test bramki/runnera: 12 passed, 1 failed (asercja treści komunikatu);
ponadto review wskazało niezgodności z rzeczywistym schematem manifestu oraz
brakujące kontrole zgodności danych. Nie wolno oznaczać bramki jako ukończonej
na podstawie samego usunięcia tej asercji.

Przyrost `55aadf7f2cbfd2fced91b3cf896e8e17cbb7ce61`: przykład low-k po
usunięciu analitycznego obejścia otrzymał po 2 mikrometry powietrza, zamiast
10 nm. Odczyt publicznego DSL i eksport ProblemIR potwierdził domenę
80 x 80 x 4020 nm, film 20 nm oraz zachowaną walidację DE/BV. Test regresji
przeszedł (1 passed). Jednowymiarowe oszacowanie częstości Gamma dla
Dirichleta daje błąd względem otwartej warstwy 0.194%, wcześniej 21.9%.
To oszacowanie brzegowe i test wejścia, nie wykonanie FEM ani zbieżność siatki.

## Historyczny checkpoint — 2026-09-13

Data: 2026-09-13. Status zadania: **W TRAKCIE**. Kwalifikacja solvera non-k0: **NOT VERIFIED**.

## Aktualne kryterium ukończenia — 2026-09-13

Użytkownik zlecił dokończenie implementacji tak, aby Fullmag rzeczywiście
policzył ten sam model co przepis COMSOL. Żaden skrót modelu nie zamyka zadania.
Bazowy checkpoint HEAD: `15577c802c5065305f0522650e7956fc2d0e316a`;
obecny worktree zawiera również sprawdzone, niezapisane jeszcze przyrosty.

| Bramka | Wymagany wynik | Stan |
|---|---|---|
| B0 — model | C0/C1/A1, geometria i parametry z przepisu, skrypt publicznego DSL | W TRAKCIE |
| B1 — brzegi | Fizyczny Dirichlet potencjału ztop/zbottom oraz Floquet x/y na magnetyku i powietrzu | W TRAKCIE; wcześniejsze odrzucenie chroniło przed błędnym Neumannem |
| B2 — skalowanie | Native MFEM/SLEPc sparse lub matrix-free, bez dense512 i bez gęstego K/M w Rust | W TRAKCIE |
| B3 — równowaga | Rzeczywista relaksacja i zaakceptowany, identyczny handoff dla wszystkich k | DO WYKONANIA runtime |
| B4 — kontrola | C0 oraz C1 w Γ, zgodność jednostek/gamma/demag i mały nonzero-k | DO WYKONANIA runtime |
| B5 — pełna dyspersja | A1 L1, 61 punktów Γ–X–M–Γ, 8 fizycznych gałęzi, zespolone mody/potencjały, wykres | DO WYKONANIA runtime |
| B6 — weryfikacja i integracja | Kontrole siatki/airbox/liczby modów, residuale, review/build/PR/merge | DO WYKONANIA |

Zapisany przyrost `19fac315c6e66f2ce5c7b8c96518c2c3e2e2a249`:
wcześniejsza selekcja ciężkich artefaktów wzdłuż ścieżki k, bez usuwania
wektorów potrzebnych do śledzenia gałęzi. Test `eigen_path`: **8 passed**,
log `sparse-modal-path-selection-tests.log`; staged diff/check zweryfikowane.
Ten commit nie zamyka natywnego solvera ani całego zadania.

Przyrost wykresu `8e460ea3dfd8a8714c01cc912bbb3939a1caa13a`: oddzielne
gałęzie według `branch_id`, przerwy przy brakujących próbkach, brak łączenia
modów bez trackingu i usunięcie fałszywego podpisu „no demag”. **7 testów passed**,
w tym render PNG; obejrzany obraz pochodzi z fixture, nie z benchmarku A1.

Bieżący test diagnostyczny `cargo test -p fullmag-runner --lib eigen --offline`:
**259 passed, 0 failed** (log `physical-native-residual-scope-tests.log` w build root
profilu `windows-native`). Obejmuje usunięcie gęstej macierzy z normalizacji,
przekazanie shared-domain Floquet bez gęstego K/M w Rust i test rekonstrukcji
pełnego potencjału. Nie kompiluje natywnego MFEM/SLEPc ani nie dowodzi
wykonania modelu. Pełny eksport potencjału i pola elementowego jest podłączony
w kodzie; natywny operator nadal wymaga kompilacji i wykonania. Testy kontraktu
publicznego benchmarku oraz dokumentacji: **18 passed**, z wyłączonym cache pytest.
Rzeczywista materializacja A1 na Windows zakończyła się błędem access violation
w NumPy podczas ścisłej walidacji siatki; nie powstał zaakceptowany ProblemIR.
Trwa sprawdzenie identycznego modelu w kontrolowanym środowisku Linux.

Profil `fem-cpu-slepc-modal-v1` jest aktywowany (8 CPU, 24 GiB, istniejący
obraz PETSc/SLEPc `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`).
Zachowano sześć profili allow-list i istniejące konfiguracje workerów. Po
zakończeniu joba 41 koordynator został zastąpiony obrazem
`sha256:fe2931c6e4fe5e43eb4a4da1fc18a24696cb50c3e36df84fd1db21897ba69175`,
kontener `20601ed2d46245996ba5768f5aa408af50e25266c6562fc447bebc311becf90b`.
Graceful drain wykonano po świeżym dowodzie pustej kolejki; aktualny health
potwierdza `worker_alive=true`, `accepting_jobs=true` i brak aktywnych jobów.

Job 41 zbudował pierwszy target modalny, ale zakończył się `exit_code=2` na
linkowaniu kolejnego kontraktu przez brak symboli CUDA w `libceed.so`. Źródło
naprawy zapisano w `377230523`; retry wymaga osobnej zgody automatycznego
przeglądu. Wolne miejsce wynosi około **50.9 GB**, nie usuwano danych.
Ostatnia weryfikacja GitHub wykazała nieważny token; integracja pozostaje otwarta.

Job #118 ma niezmienny snapshot źródeł `91d52458008dbba8ec68ba508525f6376d19537d79d95cc6698a6e6d60617e73`.
Natywna kompilacja tego snapshotu zakończyła się exit 0, a instalacja zależności
frontendu nadal trwa. Snapshot zawiera poprzedni sparse Schur source i regresję
`q_complex_dof_count=514`, ale nie obejmuje późniejszej poprawki znaku
`A_phiq` ani fail-fast walidacji planera. Nie daje jeszcze wyniku runu w
MFEM/SLEPc dla bieżących źródeł.

Poniższe sekcje i dawna tabela S00–S12 są historią etapów. Ich datowane
HEAD-y, liczby wolnego miejsca i opisy brakujących funkcji nie zastępują
powyższego kryterium ani bieżącego kodu. Nie ma jeszcze kwalifikacji non-k0.

## Cel i źródła

Realizacja [planu S00–S12](2026-09-12-eigensolve-dispersion-nonzero-k-plan.md), po osobnym zleceniu implementacji. Zakres obejmuje CPU z pełnym dynamicznym demag-k, falowód 2.5D, interakcje, GPU, artefakty, API i Control Room. Etap źródłowy lub pojedynczy test nie zamyka tego celu.

- Baza `master`: `5084a94ed14b151fc865e8def5a5c28401e98b44`.
- Branch: `codex/eigensolve-dispersion-plan-20260912`.
- Worktree: `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`.
- Ostatni zapisany kodowy przyrost: `beca34bb0` (`fix(eigensolve): reject conflicting Floquet wavevectors`), nad rozdzieleniem assemblacji K0 `2e8362463`, handoffem phase/window `bed355f41`, walidacją payloadu `de72a5b1f`, właścicielem solvera `80736831e`, routingiem dynamicznego demag-k `e3fa509db`, zmianą nodalnego `Ms` `c511cb413`, testem wymuszonego GPU `71ce348b0`, routingiem Γ `1114e1aa0` i podłączeniem providera `f2acf7b9b425733899bdfde63cb0566d16d74a59`.
- Właściciel: `codex:01a0941c-eb15-7261-a7ee-7cf099385525`.
- Rejestr: `eigensolve-dispersion-plan-20260-c5dfad6d7f548079`; reaktywowany do implementacji.
- Fizyczne źródła COMSOL: oba lokalne podręczniki modułu mikromagnetycznego wymienione w planie; szczególnie s. PDF 21–28 i 40–43. Przykład RF jest wzorem sprzężenia pól, a nie gotowym dowodem modalnym.

## Stan etapów

| Etap | Stan | Pozostały warunek |
|---|---|---|
| S00 — baza K0 i dowody | W TRAKCIE | Γ selected-only #227 zachowane; pełne okno #228 zakończyło 43/50 podokien. Pakiet #231 i attestations PASS; pełne aktualne okno Γ, demag i dowody kompletności nadal OPEN. |
| S01 — nauka, ADR, kontrakty | W TRAKCIE | Noty, mapy źródeł, walidatory i review |
| S02 — Python/IR | W TRAKCIE | Walidacja k i selektorów, round-trip, testy konsumentów |
| S03 — natywny operator magnetyczny Blocha | W TRAKCIE | Prolongacja i bounded sparse operator są w źródłach; geometry-aware tet/prism oraz ich rzeczywista kwadratura mają review. Wymagane są bieżący managed assembly/runtime i pełne certyfikaty deskryptora. |
| S04 — dynamiczny demag-k CPU | W TRAKCIE | Sześć actual prób #231 +10/+25 × air growth 1,3/1,15/1,075 przechodzi kontrolę artefaktów i pełnego residualu modu. Body mesh zachowany, replay pól zgodny w istniejącym progu; trend względem 1D poprawia się do -0,0742%/-0,3711%. Pełna zbieżność filmu, paddingu, descriptor/gauge/geometry certification i kwalifikacja nadal OPEN. |
| S05 — natywny solver spektralny | W TRAKCIE | #231 runtime/eksport PASS, nearest FGMRES oraz sześć window selected-mode wyników zapisane. GMRES hard-error zachowany; źródłowa migawka pre-unwind KSP w 445186008 z interpretowanymi regresjami PASS wymaga nowego managed build/runtime. Pełne Γ/window/resume, głębsza diagnoza GMRES i zbieżność pozostają OPEN. |
| S06 — śledzenie gałęzi | W TRAKCIE | Źródła mają Hungarian/gaps, spójną masę P1, kąty główne i transport Procrustesa podprzestrzeni; pozostają wykonanie/regresje runtime, fizyczny crossing/split/merge, stabilność kroku k i zgodność publikacji |
| S07 — artefakty i API | W TRAKCIE | Exact producer/consumer/mesh/native input replay zapisano i zreviewowano. Nowe refs diagnostyki mają odrębny writer/consumer i coverage, 44 regresje przyrostu oraz 213 głównego verifiera PASS; historyczne 56 regresji nonshared pozostają osobnym dowodem. P1 oznaczania nonzero-k jako K0 naprawiony w źródłach bf25. Nadal potrzebne pełne native matrix/physical replay, managed publikacja nowych refs, aktualne binary fields/selektory i managed evidence. |
| S08 — Control Room | W TRAKCIE | Źródła authoring/scatterplot, selekcji k/pola i linewidth zostały poprawione. Wymagane są bieżący managed frontend/runtime, browser/WebGL, FMS round-trip, dostępność pól i stabilność Inspectora. Historyczny #119 nie jest aktualnym buildem. |
| S09 — falowód 2.5D | W TRAKCIE | Bounded provider i deterministyczny P1 assembler przekroju są zapisane; pozostają typed realization/routing, managed/MFEM owner, open-boundary convergence i porównania TetraX/3D |
| S10 — interakcje | W TRAKCIE | Ku tangent terms i canonical/raw artifact v8/v7 mają implementację źródłową; guard/runtime i pełna kwalifikacja nadal otwarte. DMI, surface terms, niejednorodność, seam transport i damping `include` wymagają odpowiednich implementacji i walidacji bez osłabiania capability guards. |
| S11 — GPU | DO WYKONANIA | Jawna trasa double bez fallbacku, residency i parytet |
| S12 — kwalifikacja i integracja | W TRAKCIE | Master eae25cc scalony jako 79a9dcb8, poprawki PBC/nazwy wyników 3da4b53d wysłane. Runtime #232 succeeded/0; aktualna ścisła kontrola 29 artefaktów PASS. Poprawki retencji archiwów i tożsamości mountów wysłane i wdrożone w koordynatorze. PR97 pozostaje OPEN/CONFLICTING względem nowego mastera d4292406; preview wskazał trzy konflikty. Aktualna integracja, science/browser, wymagane review/CI, merge PR, main fast-forward i kontrolowany cleanup nadal OPEN. |

## Zweryfikowane warunki wykonania

Repozytorium bazowe ma ModalEigenRequest ABI **19**. Historyczne numery ABI w dokumentach nie zastępują bieżącego nagłówka. Kanoniczny układ styczny to `q[2*node+component]`, zgodnie z `tangent_frame.cpp` i natywnym assembly `A_qq`.

Odczyt runnera: kontener `Fullmag_build_runner` działa w kontekście `desktop-linux`. Job `908c9b8a781a4af4b77c104a07f925ec` innego worktree, dla tego samego commita bazowego, ma stan `blocked`, bez exit code. Nie jest to wynik testu tego zadania. Odczyt storage wskazał 3 343 511 552 bajty wolnego miejsca; dokumentowany próg runnera wynosi 8 GiB. Nie usuwano cudzych buildów, cache ani wyników.

Próba lekkiej kompilacji nowego testu C++ przez `fullmag_storage.py run` została odrzucona przed kompilacją: `Container runner owns heavy builds on this host; submit a snapshot through just runner-build`. Nie obchodzono tej bramki. Nie uzyskano czerwonego ani zielonego wyniku testu C++.

### S00 — zgłoszony build bazy

Po zmianie stanu środowiska ponowny odczyt o 06:40 UTC wykazał 45 222 551 552 bajty wolnego miejsca, `health.accepting_jobs=true` i pusty aktywny slot. Wcześniejszy brak miejsca nie jest aktualną blokadą.

Zgłoszono własny build dokładnego bazowego commita przez `local_runner_cli.py submit --operation build --profile fem-cpu-release --source commit --ref 5084a94ed14b151fc865e8def5a5c28401e98b44` (klient exit 0):

- Job: `1d31af520bb547848e23be8888fde8d8`, sequence 13; ostatni odczyt przy zgłoszeniu: `queued`.
- Source digest kapsuły: `d8cd645e71228de87ec7a8b9252f8317fd5c402a409e25ba5685aca836ce991a`.
- Native source snapshot SHA256: `bd5d415203e5a59041b580bfd1befbd9a70ed38ebd4b6ac16810274b9418c634`, dirty=false.
- Kapsuła: `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/16a8789ca9a746c19369f95b9a94ce86/source`.
- Skonfigurowany obraz CPU: `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`, 2 CPU, 8 GiB RAM.

Kolejny odczyt: job przeszedł do `running` (updated_at 1789195476.7236419). Profil ma `FULLMAG_FEM_WITH_SLEPC=OFF`, więc może potwierdzić bazowy build CPU, lecz nie kwalifikuje solvera modalnego SLEPc ani bramki fizycznej K0.

Ten build dotyczy bazy, a nie bieżących niezacommitowanych zmian. Wynik i receipt wymagają osobnego odczytu; S00 obejmuje następnie uruchomienie i walidację fizyczną K0.

## Zasady zaliczania przyrostów

Każdy przyrost otrzymuje pełny hash commita, zakres, wykonane polecenie i exit code po weryfikacji. Źródła, build, managed runtime, nauka, browser/WebGL i kwalifikacja wydania są odrębnymi dowodami. Przyrost dokumentacyjny zapisano w commicie `9c5be5d2212995f1437823178e7f7af83ee883e0`: plan i checkpoint (dwa pliki). Kontrole UTF-8, bloków Markdown, etapów S00–S12, linków, whitespace oraz zgodności staged bytes ze sprawdzonymi plikami przeszły (exit 0); plan miał też niezależne review z domkniętymi uwagami. Commit kodu `f2acf7b9b425733899bdfde63cb0566d16d74a59` istnieje i przechodzi kontrolę Rust; nie ma jeszcze managed receipt ani wyniku runtime. Odrzucenia nieobsługiwanych kombinacji non-k0/demag/GPU pozostają aktywne poza dostarczonym wariantem CPU.


### S03 — fundament redukcji Blocha

W źródłach dodano `FloquetTangentProlongation`, wewnętrzny opis klas i `FloquetReducedMagneticOperator` oraz target `fem_floquet_magnetic_operator_contract`. To prolongacja fazy i bazy oraz działanie `C†AC` nad zwykłym operatorem MFEM; nie ma jeszcze połączenia z ABI solvera, pełnego magnetycznego assembly ani dynamicznego demag-k.

Niezależne review potwierdziło algebrę `C` i operatora sprzężonego. Po uwagach dodano jawny wewnętrzny budżet pamięci (domyślnie 256 MiB, regulowany przez przyszłego właściciela solvera), kontrolę wymiarów/budżetu przed alokacją oraz testy ogromnego requestu, małego budżetu, niewłaściwego kształtu i rzeczywistej mapy dla obrotu spinowego. Zawężono komentarz dotyczący alokacji: własne bufory są przygotowane, lecz zachowanie dostarczonego operatora MFEM wymaga instrumentacji. Kompilacja i wykonanie nowego testu pozostają NOT VERIFIED.

### Przyrost adaptera dynamicznego demag-k

Do natywnego `ModalEigenRequest` dodano jawny, opcjonalny payload gęstej
macierzy realifikowanej `C(k)` dla dynamicznego demag-k. Dostawca musi przekazać
macierz w tych samych zredukowanych współrzędnych i jednostkach co magnetyczny
Hessian; faza Blocha oraz eliminacja potencjału skalarnego muszą być wykonane
przed granicą ABI. Natywny adapter sprawdza niezerowe `k`, tryb Floquet,
`include_demag`, zgodność rozmiaru `n*n`, finite values, trasę gęstą i brak
konfliktu ze ścieżką CSR, a następnie dodaje macierz do efektywnego Hessianu
przed solverem okna, shift-invert i contour. Digest liniowego pencil obejmuje
ten sam przyrost, a diagnostyka zachowuje jego rodzaj i liczbę wartości.

Był to początkowo kontrakt i fail-closed bridge dla już złożonego operatora.
Commit `f2acf7b9b425733899bdfde63cb0566d16d74a59` podłącza bounded właściciela
assemblacji do shared-domain dla jednego wariantu CPU; skalowalny owner
`A_{q\phi}(k)`, `P(k)`, `A_{\phi q}(k)` nadal pozostaje do wykonania. Kompilacja
managed, wykonanie testów C++ oraz walidacja fizyczna tego operatora pozostają
**NOT VERIFIED**.


### Przyrost po kolejnym review (12 września)

Poprzedni obrót celu klasyfikuję jako **postęp**: zapisano commit planu, kod i wyniki kontroli. Bieżąca kontynuacja również zmienia źródła; pełny cel S00–S12 pozostaje aktywny.

- S02: Python odrzuca niecałkowite/ujemne/przepełnione ID, niepoprawne wektory i kontrolne punkty ścieżki. Fokus API/IR dla eigensolve: 35 passed; pełny `test_problem_ir.py`: 26 passed. Rust zachowuje `branches`, `sample_selector`, `include_branch_table`; planner pozwala na unię żądań dla różnych selektorów próbek, a testy IR/plannera/runnera zostały wykonane diagnostycznie.
- S06: implementacja Hungarian i luk zachowuje surowe ID; `overlap_prev` jest rzeczywistym znormalizowanym overlapem, a `tracking_confidence` wynikiem 0.85 overlap + 0.15 frequency. Próg filtruje rzeczywisty overlap. Brak wektora ma jawny fallback częstotliwościowy i `overlap_prev=None`. Usunięto klonowanie bieżących dużych wektorów. Gdy oba artefakty mają zgodne dodatnie wagi FE, overlap używa metryki masy na aktywny węzeł; starsze lub niezgodne wektory zachowują fallback euklidesowy. Fizyczne podprzestrzenie pozostają do wykonania.
- S07: helper selekcji poprawiono po review. ID obecne jednocześnie w modzie i tabeli gałęzi są legalne; tabela waliduje swoje punkty. Etykieta Γ wybiera wszystkie pasujące próbki w ścieżce Γ–X–Γ. Diagnostyka może wymagać trackingu bez eksportu widma.
- S07: writer FEM używa tożsamości `(sample_index, raw_mode_index)`, rozwiązuje wybór gałęzi po trackingu, zachowuje pełne widmo dla `SaveDispersion` i ogranicza osobno pola. Wyłączenie tabeli gałęzi wyłącza jej pliki i linki w manifeście, ale nie tracking. Niewybrane pola zachowują stabilne ID, dostają `mode_field_available=false` i nie mają aktywnego linku. Wybrane pola wymagają metadanych i binarnego payloadu. Dodano i wykonano regresje, poprawiono zachowanie grupy próbki Zarr; bezpośredni writer orchestratora, API i UI pozostają do integracji.
- `rustfmt --check` dla trzech zmienionych writerów oraz selektora i trackingu: exit 0. Nie jest to dowód kompilacji. `git diff --check`: exit 0.
- S01: oba walidatory source-map i końcowy test dokumentacji matematycznej przeszły. Usunięto pięć zdublowanych wierszy indeksu 0831 oraz poprawiono odwołania 0830 do aktualnych właścicieli symboli.

Odczyt runnera 07:23 UTC: własny job `1d31af520bb547848e23be8888fde8d8` pozostaje `running`, żywy worker i aktywny job są potwierdzone API. Log `native-build` zawiera kompilację Cargo. Wolne miejsce wynosiło 68 298 076 160 bajtów; historyczny błąd braku miejsca nie jest aktualną blokadą. Nadal brak terminalnego receipt. Profil nie wykonuje ukierunkowanych testów Rust/native i ma SLEPc OFF; istniejące osobne przepisy managed runtime wymagają dalszego ustalenia prawidłowej trasy w tym hoście.

Kod C++/Rust i nowe testy są zapisane w osobnych, spójnych commitach, lecz nadal są
**NOT VERIFIED przez managed kompilację lub runtime**. Żaden z poniższych wyników
hostowych nie kwalifikuje relacji dyspersji ani dynamicznego demag-k.

### Zapisane przyrosty implementacji

- `964e9f87f` — kontrakt Python → IR → planner, walidacja żądań dyspersji oraz selektory `branches`/`sample_selector`/`include_branch_table`; testy pozwalają również na samodzielne `dispersion_curve` i `eigen_diagnostics`.
- `509db79c2` — śledzenie gałęzi z Hungarian/gaps i fallbackiem częstotliwościowym oraz publikacja selekcjonowanych artefaktów dyspersji z trwałą tożsamością próbki i surowego modu.
- `4c83ea4b2` — fundament redukcji Floqueta i fail-closed adapter dense real-split dla dostarczonego dynamicznego demag-k w natywnym solverze CPU; digest pencila obejmuje efektywną macierz.
- `1300b8035` — dokumentacja dwóch reprezentacji non-k0, źródeł COMSOL/TetraX oraz granicy między adapterem a przyszłym providerem assemblacji.
- `b360f7490` — overlap śledzenia gałęzi z dodatnią metryką masy FE na aktywny węzeł, z fallbackiem dla niezgodnych starszych artefaktów i regresjami.
- `11183f7e8` — bounded dense provider Schura dynamicznego demag-k: zespolone `A_{qφ}(k)`, `P(k)`, `A_{φq}(k)`, kontrola niezerowego `k`, pivotu, gauge, budżetu i realifikacji ABI; test kontraktu CMake.
- bieżący przyrost S05 — ścieżka `execute_native_cpu_modal_window_from_bloch_floquet_complex` przekazuje callbacki anulowania/postępu, zachowuje `artifact_sample_index` i attestation planera oraz publikuje `eigen/partial.v1.json` po przerwaniu; ukierunkowana kompilacja Rust i test parsera postępu przechodzą.
- `55a9c28be` — writer ścieżki rozróżnia jawny sweep `bias_field_samples` od próbek `k-path`/pojedynczego `k`; Gamma na ścieżce nie otrzymuje już przez przypadek identyfikatora `bias-field-sample-*`. Regresja sprawdza oba namespace'y w `spectrum.v2` i `spectrum.v3`.
- `6ce1ced8e` — jednokowy writer `write_eigen_v2_bundle` publikuje `sample_id` w `spectrum.v2` i `spectrum.v3`, wybierając namespace z planu zamiast oznaczać każdy wynik jako sweep pola; regresja provenance sprawdza `k-sample-0000`.
- `72645805b` — checkpoint doprecyzowuje rozdział namespace'ów artefaktów dla sweepu pola, ścieżki k i pojedynczego k.
- `43fbba45d` — dokumentacja fizyki i spec artefaktów zawierają indeksy obu bounded providerów demag-k oraz kontrakt nieprzezroczystych `sample_id`; walidator map źródeł został uruchomiony na bazie mastera.
- `41e80e534` — bounded MFEM bridge `floquet_airbox_operator`, test redukcji `CᴴP_fullC`/`CᴴAφq`, osobna recepta managed oraz regresja pinowania pojedynczego DOF w providerze Schura; źródła są zapisane, lecz kompilacja z MFEM pozostaje niezweryfikowana.
- `4336d8166` — fail-closed guard w `solve_modal_eigen_contract` blokuje wejście non-k0 Floquet do shared-domain i starszego Poisson-airbox K0; dwie regresje native sprawdzają oba wejścia.
- `d1f2ac9b3` — rozdzielenie reprezentacji `shifted_envelope`/`full_field_phase_constrained` w skalarnej assemblacji Floqueta oraz maskowanie powietrza i redukcja magnetycznych DOF w źródle; testy MFEM zapisane, wykonanie managed nadal oczekuje na poprawny runtime.
- `1894f09a8` — phase-aware Schur bridge redukuje także magnetyczne DOF przez `C_\phi^H A_{\phi q,full} C_q`, zachowując zgodność ze starszym wejściem już zredukowanym.
- `e2a7890c7` — producent shared-domain buduje na jednej siatce MFEM pełnopolowy operator skalarny, `C_\phi(k)`, źródło `A_{\phi q,full}` z maską magnetyczną i nodalnym `M_s` oraz `C_q(k)`; waliduje graf translacji, fazę `-k\cdot R`, kompletność klas i odrzuca niezerowe `k` bez par. To jest seam właściciela natywnego, bez podłączenia do runnera.

- `f2acf7b9b425733899bdfde63cb0566d16d74a59` — runner przekazuje accepted
  shared-domain handoff wraz z fazowym pencilem do produkcyjnego CPU, a
  `modal_eigen_solver` konsumuje go przez k-aware importer i dodaje bounded
  Schur `D(k)` w real-split do magnetycznego Hessianu. Integracja pozostaje
  ograniczona do `Full2x2 + Floquet + include_demag + nonzero-k + native CPU`;
  GPU, SLEPc/managed runtime i większy matrix-free owner są nadal zamknięte.

Adapter dynamicznego demag-k przyjmuje wyłącznie kompletną macierz dostarczoną
przez właściciela `A_{q\phi}(k)`/`P(k)`/`A_{\phi q}(k)`; aktualny bounded
provider buduje tę macierz z zaakceptowanego shared-domain payloadu tylko na
trasie native CPU. S04/S05 pozostają otwarte w zakresie skalowania i
kwalifikacji, a S08–S12 nadal wymagają realizacji.

Provider `floquet_dynamic_demag_k` domyka algebraiczny etap Schura dla małych
problemów walidacyjnych i zwraca `[[Re D,-Im D],[Im D,Re D]]`, gdzie
`D(k)=-A_{qφ}(k)P(k)^{-1}A_{φq}(k)`. Przyjmuje wyłącznie niezerowe,
finite `k`, nie maskuje osobliwości `P(k)`, a `pin_first_dof` jest jawny. Nie
ma jeszcze skalowalnego assemblera bloków na siatce MFEM ani dowodu pełnego
shared-domain modal runtime; poza podłączonym wariantem native CPU runner
pozostaje fail-closed dla non-k0 z demag-k.

W commicie `41e80e534` dodano bounded MFEM bridge
`assemble_floquet_airbox_dynamic_demag_k`. Bridge odczytuje zespolone bloki
`P_full(k)`, `C(k)` i `A_{φq,full}`, materializuje
`P(k)=CᴴP_fullC`, `A_{φq}(k)=CᴴA_{φq,full}` oraz jawne sprzężenie
`A_{qφ}=A_{φq}ᴴ`, a następnie deleguje eliminację do providera Schura. Ma
limit 512 DOF na blok i jeden budżet obejmujący macierze pośrednie, wynik oraz
LU/RHS providera; odrzuca nie-Hermitowskie lub niepełne bloki i nie publikuje
częściowego wyniku. Regresja z fazą `exp(-iπ/2)` sprawdza redukcję seamów i
realifikację wyniku. To nadal bounded oracle: nie jest assemblerem siatkowym,
nie zmienia capability planera i nie otwiera runnerowej ścieżki dynamicznego
demag-k.

Dodano również fail-closed guard na granicy `solve_modal_eigen_contract`: żądanie
Floquet z niezerowym `k` nie może wejść ani przez shared-domain importer, ani
przez starszy syntetyczny blok Poisson-airbox do rzeczywistej ścieżki K0. Guard
zwraca jawny status `unavailable`, wymagany przyszły operator
`bloch_floquet_airbox_shared_domain_operator` i stabilny powód
`nonzero_k_floquet_k0_poisson_path`. Dwie regresje C++ wywołują bezpośredni
native contract, aby sprawdzić oba wejścia. Nie otwiera to jeszcze produkcyjnej
assemblacji non-k0; usuwa tylko możliwość cichego policzenia non-k0 jako K0.

W commicie `d1f2ac9b3` rozdzielono dwie reprezentacje skalarnego problemu Blocha
we właścicielu MFEM. `shifted_envelope` zachowuje człony `k²` i sprzężone
konwekcje w operatorze obwiedni, natomiast
`full_field_phase_constrained` składa wyłącznie zwykłe pochodne; zależność od
`k` w tej drugiej reprezentacji może pochodzić tylko z osobnej macierzy fazowej
`C(k)`. Źródło `M_s δm → φ` przyjmuje teraz maskę elementów magnetycznych i
kompletną mapę klas magnetycznych DOF, redukując kolumny przed późniejszym
sprzężeniem fazowym. Dodano regresje dla braku przesuniętego bloku urojonego,
maskowania powietrza i redukcji klas. To usuwa mieszanie reprezentacji w
przyszłym assemblerze, ale nie podłącza jeszcze producenta `P(k)`,
`A_{qφ}(k)`, `A_{φq}(k)` do shared-domain ani nie otwiera ścieżki runnera.

W S09 dodano analogiczny, jawnie oddzielony provider 2.5D
`floquet_waveguide_demag_k`. Buduje on `P(k)=K⊥+k²M`, przyjmuje osobne
poprzeczne i osiowe sprzężenia `A_qphi`/`A_phiq`, zachowuje znak źródła `−ik
δM_z` w danych wejściowych i zwraca ten sam real-split Schur w przestrzeni
`[Re(q), Im(q)]`. Test kontraktu obejmuje wartość `k²`, granicę `k=0`, pinowanie
gauge oraz błędne kształty/budżet. Jest to bounded oracle dla algebry
falowodu, nie assembler siatki przekroju ani dowód otwartej granicy; kompilacja
i wykonanie testu pozostają **NOT VERIFIED** przez managed runner.

Dodano recepty managed dla tych kontraktów źródłowych:
`verify-fem-modal-floquet-magnetic-contract` uruchamia test operatora Blocha,
a `verify-fem-modal-floquet-airbox-cpu` uruchamia bridge oraz oba ograniczone providery
demag-k. Recepty korzystają z `ensure-managed-fem-runtime` i nie zmieniają
statusu fizycznej assemblacji ani kwalifikacji runtime. Na bieżącym hoście
runner nadal zwraca 503/profile mismatch przed utworzeniem joba, więc te
bramki pozostają **NOT VERIFIED**.

### Walidacja po domknięciu przyrostu

- `cmake -S native -B C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-airbox -DFULLMAG_ENABLE_CUDA=OFF -DFULLMAG_ENABLE_FEM_GPU=OFF -DFULLMAG_USE_MFEM_STACK=OFF -DFULLMAG_FEM_WITH_SLEPC=OFF`: konfiguracja CMake zakończyła się exit 0 i wygenerowała nowy target bridge.
- Bezpośrednia kompilacja MSVC (`FULLMAG_HAS_MFEM_STACK=0`) dla `floquet_airbox_operator.cpp`, jego testu oraz providera `floquet_dynamic_demag_k` zakończyła się exit 0. Zlinkowany test `floquet_dynamic_demag_k_contract` zakończył się exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib fem::eigen_tests::runner_rejects_floquet_dynamic_demag_gate --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-airbox-cargo-target -- --nocapture`: 1 passed, exit 0; runner nadal odrzuca warianty bez podłączonego, certyfikowanego providera.
- Próba kompilacji bridge z `FULLMAG_HAS_MFEM_STACK=1` zatrzymała się na braku `mfem.hpp`; managed test `fem_floquet_airbox_operator_contract` nie został wykonany, więc implementacja MFEM pozostaje **NOT VERIFIED**.
- `cargo +nightly check --locked -p fullmag-ir -p fullmag-plan -p fullmag-runner --lib --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: exit 0; ostrzeżenia są istniejące lub dotyczą nieużytych elementów oczekujących na integrację.
- `cargo +nightly check --locked -p fullmag-cli --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target` oraz `cargo +nightly check --locked -p fullmag-runner --tests --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: exit 0.
- `cargo +nightly test --locked -p fullmag-ir --lib`: 101 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-ir --tests`: 101 unit + 229 integration tests passed, exit 0; `cargo +nightly test --locked -p fullmag-plan --lib`: 461 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib output_publication_tests`: 5 passed; `--lib tracking`: 13 passed, exit 0.
- Po dodaniu metryki masy FE `cargo +nightly test --locked -p fullmag-runner --lib tracking --target-dir C:/Users/Mateusz/AppData/Local/Temp/fullmag-eigensolve-cargo-target`: 15 passed, exit 0.
- Po zmianie S05 `rustfmt +nightly --check crates/fullmag-runner/src/fem/eigen_native_window.rs crates/fullmag-runner/src/fem/eigen_execution.rs`: exit 0; `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/fullmag-eigensolve-cargo-target`: exit 0; `cargo +nightly test --locked -p fullmag-runner --lib fem::eigen_progress --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 1 passed, exit 0. Jest to dowód kompilacji i kontraktu callbacku, nie managed C++ ani physics qualification.
- Po poprawce namespace'ów `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/fullmag-eigensolve-cargo-target`: exit 0; `cargo +nightly test --locked -p fullmag-runner --lib eigen::artifacts --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 41 passed, a `cargo +nightly test --locked -p fullmag-runner --lib eigen::orchestrator --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 3 passed. Ostrzeżenia pozostają istniejące lub dotyczą oczekujących integracji.
- Po poprawce jednokowego writer’a `cargo +nightly test --locked -p fullmag-runner --lib native_eigen_v2_mode_metadata_preserves_operator_provenance --target-dir D:/fullmag-eigensolve-cargo-target -- --nocapture`: 1 passed. Kompilacja testu zakończyła się exit 0.
- Po dodaniu wierszy providerów do indeksów źródłowych `python .agents/skills/scientific-documentation-contract/scripts/validate_changed_scientific_docs.py --base 5084a94ed14b151fc865e8def5a5c28401e98b44`: exit 0; `python -m pytest scripts/test_frequency_domain_math_contract_docs.py -q -p no:cacheprovider`: 9 passed, exit 0.
- `cargo +nightly test --locked -p fullmag-runner --lib eigen`: 226 passed, 1 failed. Jedyna porażka to istniejące `eigen::response_block_real::tests::field_driven_sweep_builds_artifact_ready_response_payload`, równość `1.0000000000000002` vs `1.0`; plik testu nie należy do tego przyrostu.
- Python: pełny `test_problem_ir.py` 26 passed; fokus API/IR dla eigensolve 35 passed; pełny `test_api.py` wykonał 277 passed i 19 failures środowiskowych (brak `h5py`/`zarr`, odmowa zapisu w lokalnym cache/worktree oraz `run_output`), bez błędu w fokusie eigensolve.
- Test kontraktu dokumentacji matematycznej: 9 passed. Walidatory source-map i `git diff --check`: exit 0.
- Próba nowego managed snapshotu nie utworzyła dodatkowego joba: runner zgłosił aktywny lock/storage dla rejestru `eigensolve-dispersion-plan-20260-c5dfad6d7f548079` i nakazał użyć istniejącego joba lub zaczekać. Najnowszy własny snapshot to job `b5200ded44964953a03491183dffaae1`, sequence 19, source digest `b59eadab5a1dd98e7b394403bd722bce864c81ea4d7659e24acd790f70853757`; ostatni odczyt pozostaje `queued` bez exit code. Nie uzyskano kompilacji C++ ani runtime dla bieżącego snapshotu.
- Bezpośrednia kompilacja MSVC testu kontraktu po dodaniu regresji routingu zakończyła się exit 0 z `FULLMAG_HAS_MFEM_STACK=0` i `/D_USE_MATH_DEFINES`. Kompilacja całego `modal_eigen_solver.cpp` w tym trybie nadal zatrzymuje się na istniejących typach shared-domain dostępnych wyłącznie z MFEM (`PoissonAirboxSharedDomainAssemblyResult`); nie jest to ścieżka kwalifikacyjna FEM. Pełny test z MFEM pozostaje **NOT VERIFIED**.
- Dla `d1f2ac9b3` bezpośrednia kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` zakończyła się exit 0 osobno dla `floquet_bloch_scalar.cpp` i `floquet_bloch_scalar_test.cpp`; zlinkowany test no-MFEM zakończył się exit 0. CMake skonfigurował target, lecz pełna biblioteka zatrzymała się na wcześniejszych błędach bazowych MSVC (`std::snprintf`, `__atomic_*`, brak pól Poisson w trybie bez MFEM), więc nie jest to dowód wykonania ciała MFEM. Managed test `verify-fem-frequency-domain-floquet-bloch-scalar` pozostaje **NOT VERIFIED**.
- Dla `e2a7890c7` bezpośrednia kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` zakończyła się exit 0 osobno dla `floquet_bloch_scalar.cpp`, `floquet_airbox_operator.cpp` i `floquet_airbox_operator_test.cpp`. Test MFEM zawiera ścieżkę sukcesu producenta, niespójnej fazy i braku par, ale na tym hoście ciało MFEM nie zostało wykonane. Pełny target CMake nadal zatrzymuje się na wcześniejszych błędach bazowych bez MFEM; managed test `fem_floquet_airbox_operator_contract` pozostaje **NOT VERIFIED**.
- Dla `f2acf7b9b425733899bdfde63cb0566d16d74a59` `rustfmt +nightly --edition 2021 --check` dla trzech zmienionych plików Rust zakończył się exit 0, `cargo +nightly check --locked -p fullmag-runner --lib --target-dir D:/git/fullmag-eigensolve-cargo-target` zakończył się exit 0, a test `native_fem::frequency_domain::tests::production_shared_domain_request_accepts_only_the_certified_payload` zakończył się `1 passed`, exit 0.
- Próba `cargo +nightly check --locked -p fullmag-runner --lib --features fem-native --target-dir D:/git/fullmag-eigensolve-fem-native-target` zakończyła się exit 101 podczas budowania zależności native C++. Konfiguracja wygenerowała `FULLMAG_USE_MFEM_STACK=OFF`; log zatrzymuje się na istniejących błędach MSVC (`std::snprintf`, `__atomic_*`, `M_PI`, pola `Context::poisson_demag`) oraz na znanym ukryciu typów shared-domain bez MFEM. Źródła nowych `floquet_bloch_scalar.cpp` i `floquet_airbox_operator.cpp` zostały wykryte w przebiegu, lecz nie uzyskano managed receipt.
- Ponowiony target CMake `fem_floquet_airbox_operator_contract` w konfiguracji bez MFEM zakończył się exit 1 na tej samej bazowej serii błędów; dodatkowe błędy `modal_eigen_solver.cpp` wynikają z wyłączenia `FULLMAG_HAS_MFEM_STACK`, nie z kompilacji nowej gałęzi provider'a. Nie wykonano testu z MFEM.

Próba `just worktree-finish ... state=review` z aktualnym HEAD została
zatrzymana przez ten sam preflight (`Container runner owns heavy builds on this
host`). Rejestr pozostaje więc `active` z historycznym HEAD-em bazowym; nie
wykonywano ręcznej mutacji pliku ani obchodzenia blokady. Następny krok to
zwolnienie/rozliczenie dokładnego lease runnera, a potem ponowienie
`worktree-finish`.

Kontrolny odczyt `python scripts/local_runner_cli.py container-status` oraz
`status b5200ded44964953a03491183dffaae1` po ostatnim commicie zakończył się
exit 1 z komunikatem `Container profile allow-list mismatch`; nie utworzono
nowego joba i nie uzyskano dodatkowego receipt. Managed kompilacja C++/runtime
bieżącego worktree pozostaje zatem **NOT VERIFIED**.

Stan integracji pozostaje **W TRAKCIE**. Bounded provider `A_{q\phi}(k)`/
`P(k)`/`A_{\phi q}(k)` jest podłączony do natywnego właściciela CPU; otwarte
pozostają managed C++/SLEPc, skalowalny matrix-free owner, walidacja fizyczna,
PR oraz ścieżki Control Room/GPU.

### Aktualny przyrost integracyjny non-k0

W worktree domknięto granicę właścicieli dla pierwszego wariantu CPU. Runner
rozpoznaje plan `Full2x2 + Floquet + include_demag + nonzero-k` tylko przy
produkcyjnym native CPU, buduje zaakceptowany
`NativeModalEigenSharedDomainProblem` z handoffu równowagi i przekazuje go
razem z fazowymi macierzami magnetycznymi. Natywny solver C++ używa wtedy
rozszerzonego importera shared-domain: z tej samej siatki i markerów domeny
składa pełnopolowy `P(k)`, `C_\phi(k)`, `A_{\phi q,full}(k)` oraz `C_q(k)`,
wylicza przez Schura `D(k)=-A_{q\phi}(k)P(k)^{-1}A_{\phi q}(k)` i dodaje
realifikację do magnetycznego Hessianu. Flaga `k=0` nie może wejść do tej
gałęzi, a GPU i inne kombinacje pozostają fail-closed.

Ten przyrost ma test kontraktu Rust i kompilację źródeł/targetów bez MFEM.
Pełny build `fem-native` został uruchomiony, ale zakończył się na znanych
problemach konfiguracji hosta (`FULLMAG_USE_MFEM_STACK=OFF`, brak działającego
managed MFEM/SLEPc oraz wcześniejsze błędy MSVC w CUDA/Context); nie jest to
receipt wykonania operatora. Managed runtime, wynik fizyczny `f(k)`, artefakty,
API/UI i GPU nadal mają status **NOT VERIFIED**.

### Przyrost S09 — assembler przekroju 2.5D

Dodano `floquet_waveguide_cross_section`: bounded element-level P1 assembler
dla trójkątnego przekroju 2D. Assembler składa `K_perp`, `M`, jawny warunek
Robin, sprzężenia `A_phiq_perp`/`A_phiq_axial` z maską domeny magnetycznej i
lokalnym `M_s`, a następnie wyprowadza blok sprzężony przez hermitowskie
sprzężenie zwrotne. Historycznie macierze błędnie skalowano przez odwrotność
`normalization_length_m`; korekta z 2026-10-02 usuwa drugie dzielenie miary 2D.
Całki po przekroju są już na jednostkę długości, a pole pozostaje metadaną
odcinka porównawczego. Poniższy historyczny test wykonywał dawny kod i nie
potwierdza wykonania tej późniejszej poprawki. Jest to
referencyjny właściciel elementowy, nie deklaracja managed MFEM assemblacji ani
dowód zbieżności otwartej granicy.

Izolowany projekt MSVC z assemblerem, providerem Schura i testem kontraktu
skonfigurował się (exit 0), zbudował (exit 0), a wykonanie zakończyło się
`floquet waveguide cross-section contract tests passed` (exit 0). Test
sprawdza macierze masy/stiffness, długość brzegu Robin, znak źródła `-i k M_z`,
sprzężenie hermitowskie, odrzucenie wadliwej mapy oraz przejście przez
real-split Schur. Pełny target `fullmag_fem` nadal zatrzymuje się na
wcześniejszych błędach bez MFEM; nowy plik został w tym przebiegu
przetworzony przez MSBuild bez własnych błędów.

### Przyrost routingu planera dla non-k0

Commit `8d266d778` otwiera w plannerze wąską, jawnie opisaną kombinację
`Full2x2 + Floquet + include_demag + nonzero-k + FloquetAirbox + Poisson`.
Warunki wykonania są strict, double precision i CPU; ścieżki z GPU, innym
warunkiem magnetostatycznym albo inną reprezentacją operatora pozostają
fail-closed. Ścieżka może zawierać Γ: orchestrator materializuje próbkę Γ jako
`Periodic` z istniejącym K0 shared-domain, a punkty niezerowe pozostają w
Floquet Schur. Dla `auto` dispatch przypina tę kombinację do CPU, aby
dostępność GPU w rejestrze nie wybrała nieobsługiwanej realizacji. Planner
publikuje notę provenance o bounded CPU Poisson-airbox Schur providerze.

Weryfikacja tego przyrostu:

- test planera `fem_eigen_floquet_dynamic_demag_requires_explicit_airbox_cpu_path` — `1 passed`, exit 0;
- pełny `fullmag-plan --lib` — `461 passed`, exit 0;
- testy runnera ścieżki non-k0 — `4 passed`, exit 0;
- `runner_rejects_floquet_dynamic_demag_gate` — `1 passed`, exit 0;
- `fem_eigen_path_rejects_floquet_dynamic_demag_before_sample_solves` — `1 passed`, exit 0;
- `git diff --check` i ukierunkowany `rustfmt --check` — exit 0.

### Przyrost zgodności materiałowej shared-domain

Commit `c511cb413` otwiera nodalne `Ms` w bounded CPU providerze. Natywny
descriptor już przenosi pełny wektor `saturation_magnetisation_a_per_m`, więc
runner nie odrzuca go przed assemblacją; digest wejścia operatora obejmuje teraz
zarówno wektor nodalny, jak i wartość uniform fallback. Certyfikat okresowości
pozostaje obowiązkowy: wartości `Ms` na sparowanych seamach muszą być zgodne.

Regresje `fem_eigen_floquet_dynamic_demag_requires_explicit_airbox_cpu_path`
(`fullmag-plan`) oraz `shared_domain_builder_rejects_missing_accepted_linearization_state`
i `native_cpu_modal_window_accepts_nonzero_floquet_airbox_demag_path`
(`fullmag-runner`) przeszły; szerokie przebiegi dały odpowiednio `461/461` i
`142/142` testów, exit 0. Nodalne `Aex`, anizotropia, DMI i damping nadal są
jawnie poza tym bounded wariantem.

To jest bramka planowania i routingu, a nie kwalifikacja fizyczna. Nadal brak
managed MFEM/SLEPc receipt, wykonania operatora na siatce, residuali
oryginalnego układu, zbieżności paddingu oraz porównania COMSOL/TetraX. Damping
i GPU pozostają poza otwartym wariantem. Worktree pozostaje
niezintegrowany z `master`; push/PR/merge są zablokowane przez brak poprawnego
uwierzytelnienia GitHub i wcześniejszą odmowę automatycznego review.

### Przyrost dokładnej rozdzielczości wykonania non-k0 — `e3fa509db`

Wprowadzono osobny token `floquet_airbox_cpu_schur_slepc` w `FemEigenEngineIR`.
Planner nadaje go wyłącznie ścisłemu, podwójnej precyzji wariantowi
`Full2x2 + Floquet + include_demag + nonzero-k + FloquetAirbox + Poisson` i
publikuje rozróżnienie żądania urządzenia, urządzenia rozwiązanego, fallbacku
oraz przyczyny wyboru. Jawne GPU, GPU z runtime override i nieznany fallback są
odrzucane; `auto` może zapisać tylko udokumentowany fallback GPU→CPU dla tej
samej fizyki. Runner sprawdza zgodność silnika z zakresem planu i nie pozwala
użyć dynamicznego tokenu dla zwykłego K0. Punkt Γ na ścieżce może zachować
top-level Floquet resolution, ale wykonuje się przez certyfikowany alias K0.

W natywnym solverze C++ naprawiono granicę właścicieli: wynik bounded
shared-domain providera `D(k)` jest przekazywany do `effective_request`, a ten
sam envelope trafia do adaptera dense SLEPc, digestu pencila i diagnostyki.
Kompletny dostarczony dynamiczny payload również otrzymuje osobny engine ID,
więc nie może zostać opisany jako ogólny `production_cpu_modal_eigen_unavailable`.
Regresja C++ została rozszerzona o tę asercję; nie wykonano jej na tym hoście,
ponieważ repozytoryjna recepta zatrzymuje się w preflight z
`Container profile allow-list mismatch`.

Dowody źródłowe tego przyrostu:

- `cargo +nightly check --locked -p fullmag-plan -p fullmag-runner -p fullmag-ir` — exit 0;
- `cargo +nightly test --locked -p fullmag-ir --lib` — `102 passed`, exit 0;
- `cargo +nightly test --locked -p fullmag-plan --lib` — `461 passed`, exit 0;
- `cargo +nightly test --locked -p fullmag-runner fem::eigen_tests --lib` — `142 passed`, exit 0;
- ukierunkowane testy dynamicznego engine/attestation — `3 passed`, exit 0;
- ukierunkowany `rustfmt --check` i `git diff --check` — exit 0.

Brama `just verify-fem-modal-floquet-airbox-cpu` nie doszła do kompilacji C++:
`ensure-managed-fem-runtime` wymaga ścieżki zarządzanego build runnera, a
`python scripts/local_runner_cli.py container-status` zwraca
`local-runner: Container profile allow-list mismatch`. Brak receiptu oznacza,
że managed MFEM/SLEPc, wykonanie na rzeczywistej siatce, residuale, zbieżność
paddingu/warunku otwartego oraz porównanie liczbowe z COMSOL/TetraX nadal mają
status **NOT VERIFIED**. Nie wykonano push/PR/merge ani usunięcia worktree.

### Przyrost właściciela solvera Floquet dense/sparse — `80736831e`

Dodano jawny moduł `cpu/frequency_domain/modal/floquet_modal_solver.*` jako
granicę między fazowo zredukowanym operatorem Blocha a adapterem SLEPc. Moduł
sprawdza finite, niezerowy trójwymiarowy wektor `k`, warunek Floquet, komplet
par periodycznych, marker zaakceptowanego operatora oraz obecność
realifikowanego pencila. Wymuszona ścieżka GPU jest odrzucana bez fallbacku.
Dense CPU z dynamicznym demag-k wymaga payloadu real-split, a sparse CSR bez
demag-k ma osobną funkcję admission i routing; sparse z demag-k jest odrzucany
ze stabilnym powodem i kierowany do właściciela dense Schura. Obie ścieżki są
wywoływane z produkcyjnego adaptera zamiast ogólnego wejścia K0.

Dodano target `fem_floquet_modal_solver_contract` oraz regresje dla poprawnego
non-k0 CPU, braku payloadu demag-k, wymuszonego GPU, zerowego `k`, braku seamów,
poprawnego sparse CSR i odrzucenia sparse+demag. Bezpośrednia kompilacja MSVC
z `FULLMAG_HAS_MFEM_STACK=0` dla nowego modułu, testu, adaptera produkcyjnego,
adaptera SLEPc i kinematyki zakończyła się exit 0; zlinkowany i uruchomiony
`floquet_modal_solver_test.exe` zakończył się exit 0. Jest to dowód źródłowy i
izolowany test kontraktu, nie managed MFEM/SLEPc ani dowód fizycznego `f(k)`.

Pełny `cargo +nightly check --features build-native` ponownie zatrzymał się na
znanych błędach bazowych konfiguracji bez MFEM (`Context::poisson_demag`,
`mkdir`, typy shared-domain); nowe pliki nie zgłosiły własnych błędów w tym
przebiegu. Brama `just verify-fem-modal-floquet-airbox-cpu` nadal zatrzymuje
się przed kompilacją przez `Container profile allow-list mismatch`. Managed
receipt, residual po rekonstrukcji potencjału, zbieżność, porównania COMSOL/
TetraX, UI, GPU oraz PR pozostają **NOT VERIFIED**.

### Walidacja payloadu właściciela Floquet — `de72a5b1f`

Właściciel dense sprawdza teraz rozmiar `n×n` i skończoność real-split
dynamicznego demag-k względem wymiaru pencila; sparse CSR ma analogiczną
walidację kształtu, offsetów, indeksów i wartości. Diagnostyka produkcyjna
rozróżnia model Floquet sparse od ogólnego sparse SLEPc. Regresje obejmują
niepełny i nie-skończony payload dense oraz przyjęcie poprawnego sparse bez
demag-k.

Ponowiona kompilacja MSVC i uruchomienie izolowanego testu kontraktu zakończyły
się exit 0; zmodyfikowany adapter produkcyjny także skompilował się exit 0.
Przyrost nie zmienia granicy kwalifikacji: managed MFEM/SLEPc, fizyczny
residual, zbieżność, porównania COMSOL/TetraX, UI i GPU są nadal **NOT VERIFIED**.

### Konwencja fazy i okno częstotliwości w handoffie SLEPc — `bed355f41`

Produkcja przekazuje teraz `ModalEigenRequest.phase_convention` do wszystkich
czterech konstrukcji żądania SLEPc: dense nearest, dense window, sparse nearest
i sparse window. Wewnętrzny request CSR ma ten sam jawny token i propaguje go do
wspólnego adaptera, więc `exp(+iωt)` oraz `exp(-iωt)` nie są przypadkiem
zamieniane przez wartość domyślną. Właściciel Floqueta odrzuca także ujemne,
nieskończone i odwrócone okna; `(0,0)` pozostaje jawnie rozpoznanym trybem bez
okna, a dodatnie `max > min` jest oznaczane jako wybrane okno.

Regresje obejmują odwrócone i ujemne okno oraz poprawne okno finite; bezpośrednia
kompilacja MSVC z `FULLMAG_HAS_MFEM_STACK=0` dla właściciela, testu, adaptera
SLEPc i adaptera produkcyjnego zakończyła się exit 0, a zlinkowany
`floquet_modal_solver_test.exe` zakończył się exit 0. Jest to dowód kontraktu
źródłowego; managed SLEPc, residual, fizyczne `f(k)`, porównania COMSOL/TetraX,
UI, GPU i integracja PR pozostają **NOT VERIFIED**.

### Rozdzielenie assemblacji dynamicznego Floqueta od K0 — `2e8362463`

Importer `assemble_poisson_airbox_shared_domain_payload` rozpoznaje teraz
dynamiczny wariant wyłącznie wtedy, gdy jednocześnie dostaje wektor `k` oraz
osobny wynik `FloquetAirboxDynamicDemagKResult`. Niepełny handoff, niefinite lub
zerowy `k` oraz brak par periodycznych kończą się stabilnym błędem walidacji.
W wariancie non-k0 importer pomija assemblację legacy K0 i buduje tylko cztery
bloki fazowe oraz ograniczony Schur `D(k)`; wynik oznacza się jako
`floquet_dynamic_demag_k`, aby pustych macierzy K0 nie można było odczytać jako
udanej assemblacji. Wywołanie bez argumentów Floqueta zachowuje dotychczasową
ścieżkę K0.

Zmiana jest zapisana w `2e8362463` i przechodzi `git diff --check`; pełny test
ciała MFEM nie został wykonany, ponieważ managed runner nadal odrzuca profil
(`Container profile allow-list mismatch`), a host nie ma nagłówków MFEM. Wobec
tego managed wykonanie, residual, zbieżność fizyczna, porównania COMSOL/TetraX,
UI, GPU i kwalifikacja wydania pozostają **NOT VERIFIED**.

### Spójność dwóch źródeł wektora Floqueta — `beca34bb0`

Właściciel modalny odrzuca teraz request, w którym legacy
`operator_request.k_vector_rad_m` i append-only `floquet_k_vector_rad_per_m`
opisują różne wartości albo niepełny wymiar. Gdy obecne jest tylko jedno źródło,
pozostaje ono legalnym nośnikiem trójwymiarowego `k`; oba źródła są wymagane do
zgodności, gdy zostały dostarczone jednocześnie. Stabilny powód
`floquet_modal_k_vector_payload_mismatch` chroni przed zmianą fazy bez zmiany
identyfikatora próbki.

Regresja konfliktu przechodzi w izolowanym `floquet_modal_solver_test.exe`
(MSVC, `FULLMAG_HAS_MFEM_STACK=0`), a kompilacja właściciela, adapterów i testu
kończy się exit 0. Managed MFEM/SLEPc, residual, fizyczne `f(k)` i pozostałe
bramki S04–S12 są nadal **NOT VERIFIED**.


### R01 — naprawa LU po audycie

Wykonano permutacje RHS przed podstawianiem z finalnym L. Nowa regresja
3×3 wymusza dwa pivoty i testuje zespolone multiple RHS oraz niezależny
Schur oracle. Natywny MSVC: RED exit 1 przed zmianą, GREEN exit 0 po zmianie
wraz ze wszystkimi wcześniejszymi testami pliku. Managed bramka nadal
kończy się przed kompilacją przez politykę kolejki runnera. R01 jest
naprawione źródłowo; managed potwierdzenie oraz R02 pozostają otwarte.

### R02 — certyfikacja bloku potencjału, częściowo

Provider odrzuca residual powyżej 1e-8 i sprawdza oryginalny wiersz pinowania.
Test obejmuje niezgodny RHS, niezerowy residual oraz brak publikacji outputu;
cały izolowany test C++ providera zakończył się exit 0. Zmieniono importer,
aby zachować certyfikat w diagnostics/result JSON, jawnie bez certyfikowania
pełnego modu. Ta część MFEM pozostaje nieskompilowana przez zablokowaną
managed trasę. Source-map validator noty 0828 i diff check: exit 0.
R02 nie jest zamknięte: S05.R02/full descriptor V9 i managed evidence otwarte.

### S05.R02 — fundament rekonstrukcji potencjału

Dodano owned FloquetPotentialReconstruction w wyniku bridge i natywny
reconstruct_floquet_potential. Zachowuje P/A_phiq/A_qphi i odtwarza
kompleksowy potencjał z oryginalnym residualem obejmującym pinned row.
Cały izolowany test MSVC exit 0: manufactured complex q, dwa pivoty,
zgodny gauge, odrzucenie niezgodnego źródła i brak starego pola po błędzie.
Nie podłączono jeszcze do wektorów SLEPc ani publikacji pól; magnetyczny
residual oraz Bloch BC nie są certyfikowane. S05.R02/V9 nadal OTWARTE.


### Aktualizacja S05.R02 — integracja dense SLEPc

Podłączono rekonstrukcję do nearest/window i każdego zwróconego modu.
Kontrola używa oryginalnego stiffness, sprzężeń i masy, a nie wyłącznie
macierzy Schura. Natywny JSON przenosi podwojony zespolony potencjał oraz
osobne residuale magnetyczny/potencjału. Błędny descriptor odrzuca solve.
Contour z kontekstem rekonstrukcji jest fail-closed. Izolowane testy providera
przechodzą (exit 0), adapter production_cpu_modal_eigen.cpp kompiluje się
MSVC bez MFEM (exit 0). To nie jest wykonanie SLEPc ani końcowa kwalifikacja.
Nadal do wykonania: geometryczne BC/pełna siatka, binary publikacja potencjału
przez runner, contour i managed/physics V9. R02 pozostaje częściowe.

### R03/R05 — naprawa pokrycia recepty i wznowienie rejestru

Na bazie 71a98514c410ebac82a610ccc2a17ff172533a23 rozszerzono managed recipe
do siedmiu kontraktów Floquet, ustawiono CPU realization i oddzielny CMake
build directory, poprawiono czas życia LD_LIBRARY_PATH dla wszystkich testów.
`just --show`, Bash syntax i porównanie targetów z CMake: PASS (7/7).
Nie uruchomiono jeszcze kompilacji w kolejce; receipt i fizyka pozostają otwarte.
Oficjalny resolver register: exit 0, poprawny pełny SHA i aktywny właściciel.

### R03 — commit oraz S08.R06 — wybór punktu dyspersji

Naprawę recepty i stan rejestru zapisano w
`92f272681ece6479d2e3ea51e531c533c086e2d7` (just/Bash/target coverage PASS).
Następnie naprawiono utratę k/ID/rewizji w parserze i dwóch ścieżkach
selekcji UI. Regresje RED→GREEN; trzy pliki Vitest: 115 passed.
Instalację 771 zależności wykonano offline w resolverowym frontend storage
z dokładnych manifestów i lockfile; instalator przez junction worktree
wcześniej kończył się ENOTDIR. Nie kopiowano zależności innego worktree.
Runtime, browser/FMS i pełne zamknięcie S08 nadal otwarte.

Dodatkowe kontrole R06: typecheck, API hygiene i architecture hygiene exit 0.
Lokalny react-doctor 0.9.12: cztery zmienione pliki, brak ustaleń, exit 0.
Logi i manifest kontroli są w resolverowym frontend storage zadania.

### S04.R07 — zachowanie tolerancji faktoryzacji

R06 UI zapisano jako `5331dc5c866266b8c67c96097d0b6afb4d9d3d43`.
Następnie poprawiono niespójny pivot tolerance Schur→rekonstrukcja.
Małoskalowy oracle P=1e-15: MSVC RED→GREEN, wszystkie testy pliku providera
exit 0. Dodatkowy bridge test wymaga MFEM i pozostaje niewykonany.
Source-map validator 0828 exit 0; pierwsze wywołanie omyłkowej ścieżki
scripts/validate_scientific_docs.py nie uruchomiło walidatora.
Diagnostyka C++ zapisana w resolverowym windows-native/floquet-potential-contract.

### R06b — brak danych CSV nie oznacza zera

Dodatkowa regresja wykryła konwersję pustych komórek CSV do zera oraz
obcinanie niecałkowitego indeksu modu. Parser dyspersji odróżnia teraz brak
k/residualu/linewidth od liczby zero i odrzuca wiersze z brakującymi lub
niepoprawnymi indeksami/częstotliwością/ścieżką. RED: cztery wiersze zamiast
jednego; GREEN: 116 testów w trzech plikach Vitest. Nie zmieniono
fizycznych tolerancji ani nie uzupełniano danych arbitralnymi wartościami.


### Referencja COMSOL — przepis dla operatora, 2026-09-13

Użytkownik nie ma dotychczas wyników COMSOL/TetraX i zadeklarował wykonanie
nowej symulacji. Zapisano kompletny przepis
[comsol-nonzero-k-dispersion-benchmark](../../guides/comsol-nonzero-k-dispersion-benchmark.md),
parametry SI oraz 61 punktów Γ–X–M–Γ. Model A1: film Permalloy
200×200×10 nm, otwór kołowy r=50 nm, μ0H=0.1 T w +x,
alpha eigen=0, skończony airbox z Dirichlet w z i periodycznością x/y.
Dynamiczny demag opisano przez periodyczną obwiednię potencjału; fazor
magnetyzacji zachowuje Floquet exp(-ik·r). Dwa testy kontrolne filmu
i eksport zespolonych pól poprzedzają pełny benchmark.
Sprawdzono stałe, jednostki, 61 punktów i znaki transformacji;
wykonanie COMSOL i wyniki porównania pozostają NOT VERIFIED.
Brak danych jest teraz zadaniem oczekującym na pomiar operatora,
a nie podstawą do deklarowania ukończonej walidacji naukowej.


### Aktualizacja 2026-09-13 — najnowszy obraz UI i wynik joba 41

Aktywny wcześniej job `cdc83e275b9948628fd968b8e9b783cf` zakończył się
terminalnie z `exit_code=2`. CMake i target
`fem_poisson_airbox_modal_eigen_slepc_contract` zbudowały się, lecz drugi
target (`fem_floquet_magnetic_operator_contract`) nie zlinkował się, ponieważ
`/opt/fullmag-deps/lib/libceed.so` wymagał symboli sterownika CUDA (`cu*`).
Receipt `artifacts/contracts/slepc-modal/result.json` ma `status=fail`,
`ctest_completed=false`, a więc nie jest dowodem wykonania żadnego kontraktu.

Źródłową przyczynę poprawiono w commicie `377230523`:
`add_fem_source_facade_contract` dołącza bibliotekę CUDA compatibility do
każdego targetu korzystającego z `fullmag_fem`, a nie tylko do targetu modalnego.
Poprawka nie ma jeszcze świeżego managed builda, więc pozostaje
**NOT VERIFIED**.

Koordynator został po zakończeniu joba kontrolowanie podmieniony na najnowszy
obraz `sha256:fe2931c6e4fe5e43eb4a4da1fc18a24696cb50c3e36df84fd1db21897ba69175`;
kontener `20601ed2d46245996ba5768f5aa408af50e25266c6562fc447bebc311becf90b`
działa na porcie 8765. Health z autoryzowanym odczytem potwierdza
`worker_alive=true`, `accepting_jobs=true`, pustą kolejkę i obecność profilu
`fem-cpu-slepc-modal-v1`. Publiczny `/ui/` zwraca HTTP 200 z tytułem
„Fullmag Build Runner — Panel Operacyjny”; publiczny
`/api/v1/auth/session` zwraca `authenticated=false`; chronione `/health`,
`/api/v1/auth/session` i `/api/v1/overview` działają z tokenem, a bez tokenu
`/health` nadal prawidłowo odrzuca żądanie HTTP 401. Problem `unauthorized`
był skutkiem starego obrazu bez UI i został usunięty bez wyłączenia ochrony API.

Obecne granice dowodu są niezmienione: nie wykonano jeszcze C0/C1/A1,
61 punktów Γ–X–M–Γ ani porównania z COMSOL/TetraX. Ponowne zgłoszenie
managed joba z commitem `377230523` wymaga osobnej zgody z powodu aktywnej
reguły automatycznego przeglądu dotyczącej budowania testów.

### Aktualizacja 2026-09-15 — pierwszy natywny przebieg C0 i korekta kroku

Managed runtime `fem-cpu-slepc-runtime-v1` z commitem
`be546257895a89733f6ce81162fc1f4073a5fb6a` zakończył się poprawnie (`exit_code=0`),
a receipt i attestation potwierdziły dostępność natywnego FEM CPU/SLEPc w double
precision. Pierwszy przebieg C0 przeszedł do materializacji siatki, ale został
odrzucony przez bramkę stabilności: dla siatki 614333 tetraedrów limit wymiany
wyniósł `9.363104e-15 s`, podczas gdy kontrakt żądał `dt_s=1.0e-14 s`.
Nie powstał więc artefakt częstotliwości.

`RELAX_DT_S` zmieniono na `5.0e-15 s`, z zachowaniem jawnego `rk23` i ścisłego
trybu CPU. Następny krok to nowy managed build z tą zmianą i ponowne C0;
częstotliwość, wykres oraz kwalifikacja naukowa pozostają **NOT VERIFIED** do
czasu odczytu niepustych artefaktów solvera.


### Aktualizacja 2026-09-15 — jawna polityka solvera modalnego

Dodano `FemEigenSolverPolicyIR` oraz mapowanie `runtime_metadata.modal_solver_policy`
do natywnego adaptera PETSc/SLEPc. Brak polityki zachowuje natywne domyślne
wartości; runner nie nakłada już ukrytych limitów `300/1000`. Żądane limity,
tolerancja i rozwiązane przez EPS/KSP limity są rozdzielone w diagnostyce.
Walidacja odrzuca wartości zerowe i przekraczające natywny zakres `i32`.

Zmiana jest w bieżącym worktree i wymaga osobnego managed builda; aktywny job
`56a8e337581144899a91d90274d43ee5` buduje wcześniejszy czysty commit
`20d6ae76f8bac504a835a791d205e0e2494a3bea`, więc nie stanowi jeszcze dowodu
dla tej poprawki. Dopóki ten build się nie zakończy, nie ma nowego binarium
do uruchomienia C0. Po jego zakończeniu pozostają: ponowny C0 po korekcie
`RELAX_DT_S=5e-15`, następnie C1 i A1, niepuste artefakty solvera, bramka
61 próbek/8 gałęzi, zgodność Kittel/KS oraz zbieżność siatki, airboxa i liczby
modów.

### Aktualizacja 2026-09-16 — rozdzielenie C0, C1-Γ i pełnej dyspersji

Ten wpis zastępuje wcześniejsze statusy odnoszące się do starszych SHA i
starszych jobów. Bieżący checkout to worktree
`C:\git\fullmag\worktrees\eigensolve-dispersion-plan-20260912`, gałąź
`codex/eigensolve-dispersion-plan-20260912`, HEAD
`a7723cf0b3dd179f32da5294dbda8dcd685b6e14`. Worktree zawiera również
niezależne, niezatwierdzone zmiany innych etapów; nie są one dowodem ani
przedmiotem tego checkpointu.

| Warstwa | Stan bieżący | Dowód i ograniczenie |
|---|---|---|
| Rozdzielenie analityki od solve | **ZAIMPLEMENTOWANE ŹRÓDŁOWO** | `eigen_path.rs` uruchamia natywny solve dla `dispersion_validation`; analityczna częstość jest dopisywana po solve. Jawny syntetyczny K0 jest odrzucony, gdy żądany jest benchmark dyspersji. |
| P00 i ciągłość $k\to0$ | **ZAIMPLEMENTOWANE ŹRÓDŁOWO** | Python i Rust używają stabilnego rozwinięcia dla małego $|k|t$ oraz `expm1`; istnieją testy ciągłości referencji. |
| Zakres C1 | **ZAIMPLEMENTOWANE ŹRÓDŁOWO** | Planner nie narzuca już `3e6` ani `5e9`; zakres benchmarku C1 może jawnie użyć `pi/(200e-9)` i `15e9`. |
| Analityka po dowolnym kącie | **ZAIMPLEMENTOWANE ŹRÓDŁOWO** | CSV przechowuje `analytic_frequency_hz`, `relative_error` i `validation_geometry` dla BV, DE oraz odcinków ukośnych; bramka przelicza je z eksportowanego wektora `k`. |
| Bramka naukowa | **ZAIMPLEMENTOWANE ŹRÓDŁOWO; NIEZWERYFIKOWANA RUNTIME** | Gate wymaga 61 próbek, 8 gałęzi, Kittel/KS, pól, residuali i zbieżności; porównanie fundamentalnej gałęzi C1 obejmuje wszystkie próbki. Fixture testowy został dostosowany do ścieżki kątowej. |
| C0 bez demagu | **WYKONANE DIAGNOSTYCZNIE** | Natywny wynik `2.8002642129151187 GHz` zgadza się z kontrolą Kittela bez demagu do około `3e-15` względnie. To nie jest dowód operatora dynamicznego demagu. |
| C1, Γ z demagiem | **WYKONANE DIAGNOSTYCZNIE; NIEZAKWALIFIKOWANE** | Preview z 391 węzłami, jedną warstwą po grubości i około `1 µm` airboxa dał `8.9065823815 GHz`, residual `1.05e-15`; analityka otwartego filmu daje `9.3098137114 GHz`. Różnica `−4.331%` jest obciążona skończonym airboxem i coarse siatką. |
| C1, $k\ne0$ | **BLOKADA W STARYM BINARIUM** | Próba X zakończyła się jawnym `production_cpu_modal_nonzero_k_floquet_operator_missing`; trzeba zbudować świeży managed obraz z aktualnych źródeł. |
| Kwalifikacja fizyczna / release | **NOT VERIFIED** | Nie ma jeszcze świeżego, pełnego C0/C1/A1 z aktualnym binarium, zbieżnością i pustą listą powodów bramki. |

#### Interpretacja obecnego wykresu

Wykres z preview miesza trzy różne modele. `2.800264 GHz` należy do C0 bez
dynamicznego demagu. `9.309814 GHz` to otwarty-filmowy limit analityczny C1 w
$\Gamma$. `8.906582 GHz` to natywny C1 z periodycznym, skończonym airboxem na
siatce diagnostycznej. Zgodność C0 sprawdza jednostki, znak i skalę operatora
bez demagu; nie sprawdza jeszcze jądra dynamicznej demagnetyzacji, wpływu
airboxa, rozdzielczości po grubości ani operatora Floqueta dla $k\ne0$.
Obecny obraz należy traktować jako diagnostyczny, a nie jako wykres
„analityka kontra numeryka” dla jednego i tego samego problemu.

Odwrócenie liczby `8.906582 GHz` przez skalarne równanie Kittela daje
$N_z\approx0.906821$. W modelu kontrolnym
$N_z=1-t/(t+2d)$ odpowiada to $d\approx48.7\,\mathrm{nm}$, a $d=50\,\mathrm{nm}$
daje $8.916623\,\mathrm{GHz}$. Kanoniczne C1 ma $d=2\,\mu\mathrm{m}$,
$N_z\approx0.997506$ i przewidywane $9.299250\,\mathrm{GHz}$ dla skończonego
airboxa. Stary preview należy zatem traktować jako artefakt o nieustalonej
geometrii normalnej lub zbyt grubej dyskretyzacji, mimo małego residualu.
Pierwszy krok diagnostyki C1 to porównanie rzeczywistych `DomainFrameIR`
`mesh_bounds` z deklarowanym paddingiem; dopiero potem rozdzielamy błąd
airboxa od błędu liczby warstw i assemblacji demagu.

#### Następne kroki

1. Zbudować świeży managed runtime z bieżącego checkoutu i ponowić C0 jako
   kontrolę regresji.
2. Uruchomić C1 w $\Gamma$ na co najmniej trzech siatkach, trzech airboxach
   i z kontrolą liczby warstw po grubości; dopiero ich granica może być
   porównana z otwartym-filmowym KS.
3. Uruchomić kilka punktów $k\ne0$ na aktualnym operatorze Floqueta i zapisać
   pełne CSV z rozróżnieniem BV/DE/oblique.
4. Dopiero po uzyskaniu niepustych artefaktów i przejściu gate oznaczyć B4–B6
   jako zweryfikowane fizycznie.

#### Kontynuacja po kontroli runnera — 2026-09-17

Ponowne sprawdzenie nie uruchomiło nowego buildu: `runner-container-status` i
`runner-doctor` nie uzyskały odpowiedzi od koordynatora Docker Desktop, a
`C:\git\fullmag\storage` znajduje się na dysku z zerową ilością wolnego
miejsca. Job `0524d64f5e07432387b09a356da5ba89` pozostaje `queued` i nie jest
dowodem dla bieżącego snapshotu. Nie wykonano prune ani usuwania artefaktów.

Pakiet lekkich kontroli kontraktowych dla adaptera SLEPc, bridge'a Floquet i
orchestratora przeszedł **15 testów**. Pełny test fixture'a bramki naukowej
nie mógł zapisać dużych danych C1/A1 i zakończył się błędem systemowym
`[Errno 28] No space left on device`; nie jest to wynik fizyki ani regresja
walidatora. T4–T7, natywny solve, punkty DE i wykres pozostają `NOT VERIFIED`.

## Najnowszy checkpoint runtime i kolejki — 2026-09-23

Poniższy stan opiera się na receiptach i źródłach odczytanych z bieżącego
worktree oraz na live runnerze. Zastępuje starszy wpis o buildzie 104 jako
opis aktualnej poprawki.

**Build 104 i zerowy pivot są historyczne.** Job
`9024007447fe4ec1b7fe9a4b1c76b61e` (`fem-cpu-slepc-runtime-v1`, exit 0)
zbudował czysty commit `3273836fa8eac08db7f77da4f1758df659a17516`. Jego k2
zatrzymał się na zerowym pivocie LU przed iteracją. Źródło tego buildu nie
zawierało jeszcze `normalize_native_floquet_pencil`; commit `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`
z normalizacją jest późniejszy.

**Build 109 jest najnowszym zweryfikowanym runtime dla tej gałęzi.** Job
`d4a26468c5124354b9956ac5ddb92aef` zakończył się sukcesem na HEAD `479d5c5…`
i snapshotcie `8467417fdf6ce3265f00c5dd61b5390b1c32352dd6475421d39b74344b89d052`.
Kapsuła zawierała `floquet_modal_solver.cpp` o SHA-256
`a66b79873b2a1d02a474439fa9d58d103e46366a7fc65e94f39a45ede6085370`, z
normalizacją i normowanym przesunięciem LU wyłącznie dla preconditionera.
Smoke k2 dotarł do kandydata `9.7233362727 GHz`, lecz odrzucił go: residual
magnetyczny `2.1678405358e-7` przekroczył `1e-8`; residual potencjału wyniósł
około `1.42e-14`. Nie zaakceptowano żadnego modu. Ten build potwierdza, że
ścieżka przeszła faktoryzację, ale nie daje punktu dyspersji.

**Bieżące źródła są nowsze od buildu 109.** Lokalny plik
`floquet_modal_solver.cpp` ma SHA-256
`C40D19EAFCEEEA734E2351D775034D7A56356A6DDF1946C27272C6EFE050338A` i dodaje
absolutny true-residual test `EPS_CONV_ABS`, osobny od bramki fizycznych
residuali oryginalnych bloków. Dodano też liczniki kandydatów i rozbicie
residuali EPS/magnetycznego/potencjału. Tego pliku buildu 109 nie zawierał
(`EPSSetConvergenceTest` nie występuje w jego kapsule). Zmiany i regresja C++
pozostają **source changed; managed runtime NOT VERIFIED**; nie kompilowano
testów jednostkowych.

**Runner pozostaje zajęty.** Live koordynator
`26ad46a25f6aecff5534bd51ea0b7e5b8484d424363d7495ee332828f9d8efec` działa na
obrazie `sha256:e9f46ae4690d96dfcdfa915584265733b6d9930fdecf60b16b95f6bfb26101fc`.
Health zgłasza `worker_alive=true` i `accepting_jobs=true`, ale aktywna
allowlista nie zawiera `fem-cpu-slepc-runtime-v1`. Job #111
`e087d668915e4e6099d5404d5b8ebc0c` należy do innego worktree. Jego kontener
`337f0cae831ede0d92e46a4714ddeafd49bf45f6934669df295ce7ed1af0361f` jest
potwierdzony jako `running=true`; `docker top` wykazał proces `cargo`. Timeout
`just runner-wait ... 30` nie zakończył joba. Nie zatrzymywać ani nie
podmieniać koordynatora; obecny profil modalny nie może zastąpić runtime-only,
a submit odrzuca profil spoza allowlisty przed utworzeniem wpisu kolejki.

Przy health z 22:01 czasu lokalnego wolne było `8,650,276,864` bajtów — około
60 MB ponad próg przyjęcia 8 GiB. Worker runtime-only jest skonfigurowany na
obrazie `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`
(2 CPU, 8 GiB RAM), a obraz jest lokalnie dostępny. Odczyt
`just runner-retention-plan` timeoutował na API; nie uzyskano listy kandydatów
i niczego nie usunięto. Przed następnym zgłoszeniem ponownie sprawdzić wolne
miejsce; nie obchodzić progu ani retencji.

**Następny krok.** Czekać na terminalny stan #111 i zweryfikować pustą listę
aktywnych zadań. Dopiero wtedy, przez obsługiwany cykl koordynatora, włączyć i
potwierdzić profil runtime-only, wysłać snapshot bieżącego worktree, sprawdzić
hash źródła/receipt oraz ponowić `de-smoke-k2`. Wynik musi mieć zaakceptowany
mod, residuale poniżej `1e-8`, poprawny Floquet/demag i niepusty wiersz
częstotliwości. Dopiero potem można rozszerzyć próbkę do kilku k i wykreślić
numeryczne `f(k)` obok zgodnej analityki. B0–B6, zbieżność oraz pełna
kwalifikacja nadal pozostają otwarte.

### Kontynuacja kolejki — świeży odczyt 2026-09-23

Uwierzytelniony `/health` działającego koordynatora raportuje
`worker_alive=true`, `accepting_jobs=true`, `worker_error=null`; aktywny jest
job #111 (`e087d668915e4e6099d5404d5b8ebc0c`) z innego worktree. FIFO działa.
Hostowy `storage/index/local-runner-container.json` wymienia
`fem-cpu-slepc-runtime-v1`, lecz live allowlista działającego kontenera kończy
się na `fem-cpu-slepc-modal-v1`. To rozjazd konfiguracji hosta i procesu
koordynatora.

Snapshot bieżącego worktree został przygotowany, ale żądanie z kluczem
`24aa119e7f5848e1b927dc12b3a24f82` zwróciło HTTP 400. Lista jobów nie zawiera
tego klucza ani naszego nowego wpisu. Kapsuły źródłowe z dwóch prób pozostają
w storage; niczego nie usuwano. Nie zatrzymano ani nie zmieniono aktywnego joba.

Live health podaje `5,807,996,928` wolnych bajtów, poniżej progu 8 GiB, więc
build nie może jeszcze wystartować nawet po dopuszczeniu profilu. Po terminalnym
zakończeniu #111 potwierdzić wolny slot i miejsce, zastosować hostową allowlistę
przez wspierany cykl pauzy/wymiany dokładnie tego koordynatora, sprawdzić live
health, a następnie przesłać snapshot. Status poprawki pozostaje **source
changed; managed runtime NOT VERIFIED**; nie ma zaakceptowanego punktu `k2` ani
wykresu.

#### Kontrola live health — 2026-09-23, 20:24 UTC

Job #111 nadal jest aktywny; osobne `runner-wait` zakończyło się timeoutem
API, który nie anuluje joba. Live health nadal pokazuje żywego workera i
`accepting_jobs=true`, lecz runtime nie znajduje się w allowliście. Wolne
miejsce spadło do `4,866,473,984` bajtów. Wpis naszego żądania nie powstał;
nie przeładowywać teraz koordynatora ani nie uruchamiać buildu.

Kolejny odczyt o 20:27 UTC nadal pokazuje aktywny job #111 i tę samą
allowlistę; wolne miejsce wynosi `4,772,020,224` bajty.

### Re-audyt solvera i kolejki — 2026-09-23, 21:12 UTC

Bezpośredni authenticated `/health` i odczyt rekordu joba rozstrzygnęły
poprzednią niespójność: job #111 zakończył się `failed`, `exit_code=2`;
koordynator ma pustą listę `active_jobs`, `worker_alive=true`,
`accepting_jobs=true` i `worker_error=null`. Wolne miejsce wynosi
`62,508,752,896` bajtów. Live allowlista nadal nie zawiera
`fem-cpu-slepc-runtime-v1`, więc naszego zadania nie można zarejestrować pod
wymaganym profilem. `just runner-container-status` nadal zwraca
`Docker Desktop coordinator request failed`; nie podmieniono obrazu ani nie
zmieniono wspólnego koordynatora. Queue jest współdzieloną kolejką FIFO.

Potwierdzono błąd N2 w natywnym Schurze: `KSPPREONLY` stosuje preconditioner
raz, a niejawny `MAT_SHIFT_NONZERO` w LU bloku Poissona zmieniał efektywne
$P(\mathbf k)^{-1}$ w operatorze fizycznym. Źródło ustawia teraz jawnie
`MAT_SHIFT_NONE`, osobno raportuje `poisson_factorization_shift_policy`, a
test C++ wymaga tej polityki i sprawdza oryginalny residual potencjału.
Poprawiono notę 0831 i jej source-map. Jest to **source changed**; testu C++
ani managed runtime nie uruchomiono. Poprzedni `k2` nadal nie ma zaakceptowanego
modu i wykazał residual magnetyczny `2.17e-7` przy bramce `1e-8`.

W S06 poprawiono błąd analogiczny w podprzestrzeniach zdegenerowanych:
normalizacja i odważanie wektora wymagają teraz dokładnie
`3 * liczba_wag_węzłowych` składowych; nie wnioskują liczby składowych z
dzielenia długości wektora. Dodano regresję z układem dwóch składowych na
węzeł. Test Rust nie został uruchomiony.

Weryfikacja źródłowa/dokumentacyjna: source-map validator exit 0, testy
kontraktu dokumentacji `32/32`, JSON source-map poprawny,
`git diff --check` exit 0. `rustfmt +nightly --check` dla całego
`tracking.rs` zgłosił formatowanie w niezmienionych sekcjach pliku; nowy test
nie ma osobnego sygnału błędu formatowania. Nie wykonywano kompilacji/testów
backendu ani buildu.

Nie podnoszono `floquet_descriptor_certified` dla sparse solvera: aktualne
residuale dotyczą zredukowanych oryginalnych bloków, a brak osobnego dowodu
geometrii szwów i transportu ramy Blocha pozostaje powodem `false`. Nadal
otwarte są podstawa/polityka odcięcia pure-Neumann `|k|L > 1e-3`, diagnostyka
proweniencji i niejednoznacznych przypisań S06/S07, frontendowa flaga
`mode_field_available`, stabilne `sample_id`/`mode_id`, S08–S11 oraz
kwalifikacja fizyczna.

Szacunek postępu na ten odczyt: około **45% prac implementacyjnych i
przygotowawczych**, lecz **0% ukończonego wyniku dla `k\ne0`** (brak
zaakceptowanej częstotliwości, kilku punktów i wykresu porównanego z analityką).


### Kontynuacja audytu artefaktów — 2026-09-24

Usunięto pozorną wartość ambiguous_assignment_count: 0 z producenta ścieżki
wielu wektorów k. eigen/spectrum.v2.json i eigen/branches.v2.json publikują
teraz null, ambiguous_assignment_count_available: false oraz jawny powód
assignment_ambiguity_metric_not_computed. Validator sprawdza spójność tej
trójki w podsumowaniu spectrum i branches; specyfikacja v2 opisuje kontrakt.
Trzy testy regresyjne najpierw wykazały, że dawny validator przepuszczał
sprzeczne false + 0, a po poprawce przechodzą.

Weryfikacja źródeł: scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
— 212/212; AST Pythona — OK; git diff --check — exit 0. Nie kompilowano
testów backendu ani nie uruchamiano buildu managed. Frontend/API z ostatniego
przyrostu nadal nie mają testów integracyjnych ani dowodu w przeglądarce.
Odczyt just runner-container-status z 24.09 zwracał
Docker Desktop coordinator request failed, więc aktualnego stanu kolejki nie
można potwierdzić tym interfejsem. Nie użyto trasy zastępczej.

To nie zmienia bramki naukowej: ostatni zapisany wynik k2 miał residual
2.17e-7 przy wymaganiu <1e-8; brak zaakceptowanej częstotliwości dla
k != 0, kilku punktów f(k) i wykresu z porównaniem analitycznym. Szacunek
prac przygotowawczych i źródłowych pozostaje około 45%; wynik naukowy
pozostaje 0% do czasu zaakceptowanego rozwiązania i porównania.

### S05 — snapshot SLEPc zgloszony do kolejki — 2026-09-24

Ponowny odczyt runnera potwierdził health OK, worker_alive=true,
accepting_jobs=true, brak worker_error oraz około 61 GB wolnego miejsca.
Profil fem-cpu-slepc-modal-v1 jest dozwolony. Bez przerywania aktywnego joba
innego worktree zgłoszono nasz pelny, dirty snapshot do wspólnej kolejki FIFO:
job 50515860dec847189d97f0fc2d7284d9, sequence 114, request key
95c0e50ee8d843a7866d3358182426a1, source_digest
d5ade1037f4ae44d5ecd92d5c0fad9b47c80bc00365790307409193f1643403e,
native source snapshot SHA
eaa39903aa77342191dd6016e494061d959168edd8ac9157c7e4b37db2319104.
Przy zgłoszeniu aktywny byl job 84972dfa8cfe485f92110d6d0e3c3e42 z innego
worktree. Oczekujemy na terminalny stan joba; submission nie jest dowodem
builda ani testów kontraktowych.

### Korekta pure-Neumann Floquet i odświeżenie kolejki — 2026-09-24

Usunięto prewencyjny próg `|k| L > 1e-3` z assemblera shared-domain.
Nie uwzględniał rzeczywistych wektorów translacji siatki i arbitralnie
odrzucał część niezerowych `k`. Dla Floqueta kontrakt teraz publikuje
`gauge_policy=require_invertible`, nie przenosi wektora mean-zero z `k=0`,
a o rozwiązywalności decydują fazowo zredukowany operator Poissona,
faktoryzacja bez zmiany operatora fizycznego i residual oryginalnego bloku.
Dodano regresję małego niezerowego `k` obejmującą gotowość sparse operatora,
brak odziedziczonego gauge i jego jawną politykę w metadanych.

Zaktualizowano notę naukową i mapę źródeł. Nota rozdziela residual sparse
SLEPc od pełnej certyfikacji deskryptora: sparse path nadal nie certyfikuje
szwów/frame ani pre-Schur reconstruction i nie publikuje
`floquet_descriptor_certified=true`.

Kontrole źródłowe: `git diff --check` — exit 0; source-map JSON — poprawny;
`scripts/check_physics_docs_gate.py --base HEAD --head WORKTREE` — pass;
stary próg i związany z nim komunikat nie występują już w assemblerze ani
regresji. Nie kompilowano C++ ani testów backendu — wymagają managed runnera.

Job #112 z innego worktree zakończył się `succeeded`, exit 0, i zwolnił slot.
Nasz job #114 (`50515860dec847189d97f0fc2d7284d9`) w ostatnim odczycie nadal
był `queued`. Jego niezmienny snapshot SHA `eaa39903aa77342191dd6016e494061d959168edd8ac9157c7e4b37db2319104`
powstał przed powyższą korektą, więc nawet jego sukces nie zweryfikuje tej
zmiany. Po terminalnym stanie #114 należy zgłosić nowy snapshot z aktualnym
diffem; bez lokalnego fallbacku.

Ta korekta usuwa ukryte geometryczne odrzucenie punktów, ale nie dowodzi
dokładności bardzo małego `k`. Potrzebne pozostają managed SLEPc, residuale,
zbieżność po `k`/siatce/airboxie i zaakceptowany wykres względem analityki.


### Odświeżenie snapshotu i rewalidacja S06 — 2026-09-24

Stary job #114 (`50515860dec847189d97f0fc2d7284d9`) anulowano przed
uruchomieniem: jego snapshot `eaa39903aa77342191dd6016e494061d959168edd8ac9157c7e4b37db2319104`
nie zawierał poprawki pure-Neumann. Następny submit chwilowo trafił na żywą
blokadę tego worktree; po zakończeniu procesu capture zgłoszono bieżący
snapshot jako job #115 (`f26f2304554741eebb5618c5dd0891e6`), request key
`1508573ea61647d3b4e2c33a3c7a0818`, profil `fem-cpu-slepc-modal-v1`, source
digest `265edeea56b2d1421980d59c502636b8c3603034a01a91eda0dfec63b301c354`,
native dirty identity `d8646c6cbab544d37d089b8f8aae3c8d41b6f29522458c3b0855f1be36ad4912`
i source snapshot SHA
`6bec2ae5a8bf40c2aed5ec6159e818604bfb16ef382f2574fb1ae0d4793d06d3`.
Job #115 obejmuje poprawkę Floquet; przy ostatnim odczycie nadal czekał FIFO
za jobem #113 z innego worktree. Job #116 anulowano jako duplikat: miał
identyczne digesty i snapshot SHA co #115. Nie zatrzymano ani nie zmieniono
jobu #113. `runner-doctor` nie mógł poświadczyć kontekstu Docker Desktop;
odczyt kolejki i logu #113 nadal potwierdzał jego stan `running`, bez
terminalnego wyniku dla #115.

Reaudyt zgłoszonej niezgodności proweniencji śledzenia S06 nie potwierdził
opisanego przypadku fallbacku przy niepoprawnej metryce masy. W bieżącym
`tracking.rs` częstotliwościowy fallback jest używany tylko wtedy, gdy brakuje
wektora własnego; jeśli wektory istnieją, ale overlap FE nie daje się obliczyć,
`tracking_edge_metrics_views` nie tworzy krawędzi. Krawędź z `overlap_prev=None`
przy obecnych wektorach powstaje dla jawnego transportu podprzestrzeni, więc
heurystyka źródła nie jest tu sprzeczna z faktyczną metodą. To rozstrzygnięcie
opiera się na przeglądzie źródła — testów Rust nie kompilowano ani nie
uruchamiano. S06 pozostaje otwarte w zakresie walidacji fizycznego transportu
zdegenerowanych podprzestrzeni.

**Następny krok:** poczekać na terminalny wynik #113, następnie zweryfikować
build #115 i uruchomić `de-smoke-k2` na dokładnie tym receipcie. Job w kolejce
nie jest wynikiem kompilacji ani solve; nie ma nadal zaakceptowanej
częstotliwości dla `k\ne0`, kilku punktów dyspersji ani wykresu porównanego z
analityką.

### Aktualizacja kolejki i dowodów UI — 2026-09-24

Job #113 (cea04ed70f7c4a698939ef9e798a6c3a) z worktree eigensolve-k0-finalization zakończył się terminalnie statusem succeeded, exit_code=0. Log potwierdził też kompilację aplikacji Control Room i ukończenie TypeScript w tym jobie; nie jest to dowód dla źródeł ani solvera tego worktree.

Nasz job #115 (f26f2304554741eebb5618c5dd0891e6) przeszedł z queued do running na koordynatorze local-host. Nadal dotyczy wyłącznie snapshotu 6bec2ae5a8bf40c2aed5ec6159e818604bfb16ef382f2574fb1ae0d4793d06d3, source digest 265edeea56b2d1421980d59c502636b8c3603034a01a91eda0dfec63b301c354. Ostatnie wait potwierdziło running, bez exit code i bez dostępnego jeszcze logu; nie uruchomiono duplikatu ani nie przerwano joba.

runner-doctor i lokalny runner-container-status nie mogły poświadczyć kontekstu Docker Desktop; bezpośredni odczyt Docker zakończył się odmową dostępu do lokalnych metadanych kontekstu. Odczyt i oczekiwanie na joby przez API runnera działają. Nie odzyskiwać lease na podstawie wieku.

Kontrola UI S08: istniejąca karta http://localhost:3110/workspace zwróciła ERR_CONNECTION_REFUSED. Browser/WebGL proof pozostaje NOT VERIFIED i wymaga dostępnego serwera właściwego obrazu/runtime.

Następny krok: monitorować dokładnie #115. Po sukcesie zweryfikować receipt, source identity i artefakty buildu, a potem uruchomić just run-de-smoke f26f2304554741eebb5618c5dd0891e6 k2. Po porażce zbadać terminalny log i poprawiać przyczynę; job w stanie running/timeout nie jest wynikiem solvera.

### Luka analitycznego porównania DE-SMOKE — 2026-09-24

Przegląd ścieżki artefaktów wykazał, że wejście DE-SMOKE deklaruje porównanie jako postsolve-only i nie ustawia DispersionValidationIR. Walidator wierszy pozostawia jawne rozpoznanie gałęzi n=0 i porównanie analityczne jako wymagania otwarte. Plotter rysuje linię analityczną tylko wtedy, gdy w wejściowym dispersion.csv są wartości analytic_frequency_hz. Zatem obecny fixture nie zapewnia jeszcze porównania w swoim CSV.

Istniejący generator Kalinikosa n=0 jest związany z parametrami benchmarku C1 i referencją otwartego filmu. Nie wolno użyć jego gotowego CSV dla 10 nm DE-SMOKE ani traktować go jako rozwiązania skończonego airboxu. Istniejąca formuła bazowa jest wielokrotnego użytku, ale porównanie DE-SMOKE musi zostać policzone z parametrami tego runu i wyraźnie oznaczone jako otwarto-filmowa referencja; efekt skończonego brzegu i kontrola Gamma pozostają osobnymi pozycjami.

Po pierwszym udanym pilocie sprawdzić metadata.json, parametry fizyczne, źródło modelu i hash dispersion.csv. Dodać porównawczy sidecar oraz wykres FEM/analityka bez nadpisywania surowych artefaktów. Sidecar ma wiązać run/job, source identity, wybór gałęzi, residual i wersję modelu; wynik pozostaje niekwalifikowany do czasu kontroli profilu n=0, zbieżności siatki/airboxu/liczby modów oraz dalszych punktów k.

### Etap native-build joba #115 — 2026-09-24

Nowy odczyt logu joba #115 zawiera marker [fullmag runner] stage native-build start oraz polecenie make install-cli-dev. Status pozostaje running, exit_code=null; receipt i końcowy wynik buildu nie są jeszcze dostępne. Jest to dowód wejścia w kompilację natywną, nie dowód jej sukcesu ani wykonania solvera. Zmiany dopisane później wyłącznie do tego planu nie zmieniają już zgłoszonej kapsuły runtime.

### Reaudyt S06 — wymiar wektora overlapu — 2026-09-24

Zgłoszony finding o wyprowadzaniu liczby składowych z ilorazu długości wektora i liczby wag nie występuje w bieżącym worktree. tracking_subspace.rs wymaga checked_mul(node_count, TRACKING_VECTOR_COMPONENTS_PER_NODE) == vector_len i odrzuca niezgodność w obu kierunkach ważenia. tracking.rs dodatkowo zwraca LengthMismatch i nie stosuje fallbacku euklidesowego. Regresja modal_overlap_rejects_unaligned_mass_metadata_without_euclidean_fallback sprawdza brak krawędzi overlapu dla niespójnych wymiarów.

Weryfikacja była źródłowa; testu Rust nie kompilowano ani nie uruchamiano zgodnie z ograniczeniem AGENTS.md. Zmienione tracking.rs i tracking_subspace.rs należą do snapshotu #115; job kompiluje się, lecz nie daje jeszcze terminalnego wyniku ani runtime dowodu śledzenia gałęzi.

### Poprawka kontraktu gauge po awarii joba #115 — 2026-09-24

Job #115 (f26f2304554741eebb5618c5dd0891e6) zakończył się terminalnie
failed, exit 2. Natywna kompilacja wskazała użycie floquet_k_rad_per_m
poza zakresem w poisson_airbox_shared_domain.cpp:2597: helper
assemble_poisson_airbox_shared_domain nie otrzymuje wektora k.

Naprawiono przepływ jawnie w kontrakcie żądania assemblacji:
PoissonAirboxPureNeumannGaugePolicy rozróżnia teraz
mean_zero_augmented dla k=0 oraz require_invertible dla Floqueta.
Assembler tworzy wektor średniej wyłącznie dla pierwszej polityki;
politykę Floqueta ustawia wrapper przed assemblacją fazową. Metadane
i digest operatora wynikają teraz z tej samej jawnej wartości. Dodano
regresję dla braku odziedziczonego wektora mean-zero i właściwej etykiety
require_invertible. Nie zmieniono operatora fizycznego ani nie
przywrócono arbitralnego progu |k|L.

Job #116 (7bb08983c4c344f08e04be2e1d9b327d) został anulowany i miał ten
sam stary source digest co #115; nie weryfikuje powyższej poprawki.
Aktualny runner-list nie wykazał aktywnych jobów, ale
just runner-container-status zakończył się komunikatem
Docker Desktop coordinator request failed, a runner-doctor
Cannot attest Docker Desktop context. API list/status działa, lecz
przed nowym buildem trzeba odzyskać wiarygodną attestację zdrowia i
dopuszczonego profilu. Nie uruchomiono lokalnej kompilacji. git diff
--check i kontrola źródłowa po poprawce przeszły; regresja C++ i nowy
managed build pozostają NOT VERIFIED.

Następny krok: po potwierdzeniu zdrowia runnera zgłosić świeży snapshot
worktree, sprawdzić receipt/tożsamość źródeł i uruchomić de-smoke-k2.
Dopiero potem można ocenić residuale oryginalnych bloków, otrzymaną
częstotliwość i pole demagu; nadal brak zaakceptowanego punktu k!=0,
porównania analitycznego oraz wykresu.

### Snapshot po poprawce zgłoszony do FIFO — 2026-09-24

Zgodnie z poleceniem użytkownika świeży snapshot został przyjęty przez
wspólną kolejkę jako job #117: 79649ebe340c4e4cac9121867a70bc32,
profil fem-cpu-slepc-modal-v1, source digest
b1f4cd130f80f7cd580b5b2aa2b0f22b8e256a107046eaff38416b09b9ef38db,
source snapshot SHA
f9202249112f68bec88b986e50088f41b02073a36104c33b1e5aad858b5b0bd6.
Odczyt statusu po 30-sekundowym wait potwierdził state=running,
exit_code=null. Wait klienta zwrócił timeout 124, co nie kończy ani nie
anuluje joba. Poprzednie #115/#116 są terminalne; nie zgłoszono duplikatu.

Snapshot zawiera poprawkę jawnej polityki gauge i regresję oraz poprzednie
zmiany S04/S05/S06/S07. Profil i capture zostały zaakceptowane przez
kolejkę, lecz Docker Desktop nadal nie jest poświadczony przez
runner-doctor/container-status. Wynik kompilacji, receipt i test C++
pozostają NOT VERIFIED. Następny krok to sprawdzać ten sam job #117 do
stanu terminalnego; przy sukcesie zweryfikować receipt i odpalić
de-smoke-k2 z tego dokładnego runtime.

### S05 — kontrola ram stycznych na modalnych szwach Floqueta — 2026-09-24

Reaudyt shared-domain assemblera potwierdził, że `build_phase_entries`
sprawdza indeksy, klasy, fazę `-k·R` i spójność grafu translacji, ale modalny
producer nie sprawdzał, czy lokalne ramy styczne na sparowanych węzłach są
zgodne. Współczynnikami tangent constraint były identyczności dla obu
składowych, co jest poprawne tylko przy zgodnych `m`, `e1` i `e2`; różnica
ramy wymagałaby jawnej macierzy transportu 2×2, której ten backend nie
implementuje.

Dodano fail-closed `validate_periodic_tangent_frames`: dla aktywnych
magnetycznie par weryfikuje skończoność i maksymalną składową różnicę
`m/e1/e2` nie większą niż `1e-10`, zgodnie z istniejącym modalnym
kontraktem Floqueta w solverze odpowiedzi wymuszonej. Pary air-only z
nieaktywną klasą magnetyczną pozostają pominięte. Dodano regresję obracającej
się o 90° poprawnej ortonormalnej ramy, która musi zostać odrzucona przed
assembly bloków. Zaktualizowano notę fizyczną i mapę źródeł.

Geometria par i translacja są osobnym warunkiem: runner tworzy `MeshTopology`
przez `MeshTopology::from_ir`, które uruchamia `validate_mesh_for_execution`,
a następnie przekazuje z tej samej topologii węzły i translacje. Faza oraz
cykle są dodatkowo sprawdzane w natywnym producerze. Nie zmieniono flagi
`floquet_descriptor_certified`: residuale sparse nadal nie dowodzą pełnej
rekonstrukcji i nie wolno na tej podstawie publikować kwalifikowanego pola.

`git diff --check` przechodzi. Testu C++ nie kompilowano lokalnie zgodnie z
regułą managed-build; job #117 jest nadal `running` i jego zamrożony snapshot
nie zawiera tego przyrostu. Nowy test oraz implementacja czekają na świeży
managed build po terminalnym zakończeniu #117; test i fizyka pozostają
`NOT VERIFIED`.


### Terminalny wynik managed buildu #117 i poprawka kompilacji — 2026-09-24

Ponowny odczyt joba `79649ebe340c4e4cac9121867a70bc32` wykazał stan
`failed`, `exit_code=2`, profil `fem-cpu-slepc-modal-v1`, source digest
`b1f4cd130f80f7cd580b5b2aa2b0f22b8e256a107046eaff38416b09b9ef38db`.
Build zatrzymał się po około 41 minutach na etapie `native-build`, zanim
powstał używalny runtime. Kompilator wskazał
`crates/fullmag-runner/src/eigen/artifacts/modal_manifest.rs:807`:
Rust nie obsługuje bezpośredniego dostępu do pola w przechwyconym formacie
`{point.sample_index}`. Zmieniono wyłącznie zapis na pozycyjny
`format!("sample-{:04}/mode-{:04}", point.sample_index, point.raw_mode_index)`,
co zachowuje ten sam identyfikator artefaktu. `git diff --check` dla pliku
przechodzi, a wyszukanie w `crates/fullmag-runner/src` nie znalazło innych
analogicznych interpolacji pól. Poprawki nie kompilowano; job #117 nie zawiera
ani tej poprawki, ani późniejszej kontroli ram stycznych Floqueta. Nie
uruchomiono `de-smoke-k2`.

Po awarii `runner-list` nie wykazał jobów w stanie queued/running/dispatched.
`just runner-doctor` nadal kończy się `Cannot attest Docker Desktop context`,
a `just runner-container-status` — `Docker Desktop coordinator request failed`.
Nie zgłoszono duplikatu ani nowego snapshotu, bo zdrowie wspólnego runnera nie
jest poświadczone. Następny krok: przywrócić wiarygodną attestację istniejącego
runnera, ponownie potwierdzić pusty slot i zgłosić jeden świeży snapshot
z poprawką formatu oraz kontrolą ram. Dopiero po sukcesie buildu i walidacji
jego receipt uruchomić `de-smoke-k2` z dokładnie tego runtime.

S05 i S12 pozostają w toku. Nadal brak zaakceptowanej częstotliwości `k != 0`,
porównania numeryczno-analitycznego i wykresu dyspersji.

### Wznowienie managed runnera i snapshot #118 — 2026-09-24

Odczyt `just runner-doctor` i `just runner-container-status` w zwykłym sandboxie
nie miał dostępu do metadanych kontekstu Docker Desktop. Po dopuszczonym odczycie
diagnostycznym stan został potwierdzony: kontekst `desktop-linux`, kontener
`Fullmag_build_runner` `running`, `health.ok=true`, worker `running`, bez błędu,
`accepting_jobs=true`, `active_jobs=[]`, a profil `fem-cpu-slepc-modal-v1` jest
na liście dozwolonych. W chwili zgłoszenia nie działał żaden managed job; slot
kolejki był wolny. Nie uruchamiano drugiego koordynatora ani lokalnego builda.

Bieżący worktree przeszedł `git diff --check` (exit 0; wyłącznie ostrzeżenia
konwersji LF/CRLF). Świeży snapshot został przyjęty jako job #118:
`674dac1a46fc4cf4ba5268459f4fc845`, profil `fem-cpu-slepc-modal-v1`, HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`, source digest
`175f5c31e5a57dac4a1c8364d473a69ab1452ffe620031af161ff9761ee8b283`, capture
`301a1f6a3568427eb1b1bad978f15016`, source snapshot SHA
`91d52458008dbba8ec68ba508525f6376d19537d79d95cc6698a6e6d60617e73`.
Manifest snapshotu zawiera poprawiony `modal_manifest.rs` oraz kontrolę ram
stycznych w `floquet_airbox_operator.cpp`. Potwierdza to objęcie snapshotem
poprawki formatu wskazanej przez kompilator joba #117 i późniejszej poprawki
Floqueta. Job #118 jest `running`; pierwszy odczyt logu zwrócił pusty ogon.
Nie ma jeszcze terminalnego wyniku, receipt ani runtime; nie uruchomiono
`de-smoke-k2` i nadal brak częstości `k != 0`.

**Następny krok:** obserwować dokładnie job #118, bez ponownego zgłoszenia.
Po sukcesie sprawdzić receipt, hashy i tożsamość źródeł, a potem wykonać
`de-smoke-k2` z tego runtime. Po terminalnej porażce przeanalizować jej log i
naprawić konkretny błąd przed kolejnym snapshotem.

#### Wyjaśnienie heartbeat podczas joba #118 — 2026-09-24

Po przejęciu #118 API health zwrócił `active_jobs=[#118:running]`, worker
`running`, `accepting_jobs=true` i brak błędu. Puste `coordinator.active_job_ids`
nie oznacza utraty lease: `scripts/local_runner/service.py` zapisuje
`state=running, active_job_ids=[]` przed wejściem w callback `execute`, a
`container_main._health_snapshot()` pobiera rzeczywiste aktywne rekordy osobno
z `queue.active()`. Zatem obie wartości mogą się różnić w trakcie kompilacji.
Ostatni ogon logu pozostaje pusty; job jest żywy i obserwujemy ten sam identyfikator.
Nie restartowano runnera i nie wysłano duplikatu.

#### Kontener worker #118 wystartował — 2026-09-24

Journal joba ma `phase=start-requested` i zapamiętany dokładny container ID
`1bc90756169efd4feca7404c7f8f75f5914defe60d15a3a49d95834849abe619`.
Odczyt stanu tego kontenera przez Docker Desktop zwrócił `Status=running`,
`Running=true`; health API nadal wymienia #118 jako aktywny, worker żyje,
przyjmuje zadania i nie raportuje błędu. Nie ma dowodu awarii ani utraty lease.

`runner-logs` zwraca pusty ogon, ponieważ `build_executor.py::finish_build`
pobiera i zapisuje `docker logs` dopiero po terminalnym stanie kontenera.
Pusty log w trakcie pracy nie dowodzi zawieszenia. Nie użyto reconcile, cancel,
restartu ani drugiego joba; dalej obserwować ten sam #118 do wyniku terminalnego.

#### #118 wszedł do kompilacji natywnej — 2026-09-24

Odczyt oficjalnego `just runner-logs` wykazał marker `stage native-build start`
i polecenie `make install-cli-dev`; worker kompiluje zależności Rust, m.in.
`fullmag-quantities`, `fullmag-fdm-demag`, `fullmag-ir`, `fullmag-build-info`,
`fullmag-fem-sys`, `fullmag-engine`, `fullmag-plan`, `fullmag-session` i
`fullmag-application`. Job #118 nadal jest `running`, bez terminalnego exit code.
Na razie brak zgłoszonego błędu kompilatora, receiptu, testów lub wykonania
modelu. Po zakończeniu trzeba sprawdzić pełny log i receipt przed DE-SMOKE.

### Reaudyt S04/S05 i korekta postępu — 2026-09-24

Niezależny audyt zgłosił sześć luk Floquet/SLEPc. Reprodukcja na bieżącym
wywołaniu produkcyjnym potwierdziła niezgodność znaku `A_phiq`: słaby człon
Poissona daje `P phi = S q`, natomiast deskryptor wymaga
`A_phiq q + P phi = 0`, czyli `A_phiq = -S`. Importer odwraca teraz znak przed
projekcją przez ograniczenia Floqueta; do testu payloadu dodano kontrolę
analitycznego znaku dla próbki tetraedrycznej.

Nie potwierdzono osobnego zgłoszenia o niezgodnych wymiarach źródła i
ograniczenia stycznego w ścieżce produkcyjnej. `assemble_floquet_airbox_shared_domain_blocks`
tworzy `source_request` bez mapy `magnetic_reduced_node`, zatem producent
zwraca pełne kolumny q; istniejący test integracyjny oczekuje tego samego.
Niskopoziomowy assembler nadal ma opcję redukcji dla niezależnych zastosowań,
ale bieżący importer z niej nie korzysta.

Pozostają otwarte: pełny residual deskryptora z warunkami szwów i gauge;
transport baz stycznych `Q` dla nieidentycznych ram (obecny guard je odrzuca);
certyfikat kompletności widma/okna; oraz plannerowa legalność i obsługa
interakcji, w tym damping i niezerowe k.
Nie wolno z tych luk wyprowadzać kwalifikacji runtime.

Ponowny przegląd `native_poisson_airbox_mode_from_json` wykazał, że runner
normalizuje `q` przez masową metrykę zredukowaną i dzieli fizyczne `phi` przez
ten sam czynnik. `mass_norm` jest liczony ponownie po normalizacji. Zatem
normalizacja jest obecna w źródle; jej potwierdzenie w zbudowanym runnerze i
opublikowanym artefakcie pozostaje NOT VERIFIED.

`git diff --check` przechodzi. Regresji C++ nie zbudowano z powodu
tymczasowego zakazu kompilowania testów jednostkowych. Job #118
`674dac1a46fc4cf4ba5268459f4fc845` nadal jest `running` na natywnej kompilacji
i został utworzony przed poprawką znaku; jego snapshot nie zawiera tej zmiany.
Po wyniku terminalnym trzeba sprawdzić receipt i zlecić świeży managed build
bieżącego źródła przed `DE-SMOKE`.

Aktualny, heurystyczny szacunek: **20–25% celu end-to-end**, około **45% prac
przygotowawczych/źródłowych** i **0% zaakceptowanego wyniku naukowego dla
`k != 0`**. Nadal nie ma częstotliwości, porównania z analityką ani wykresu.

Ponowny odczyt joba #118 wykazał, że kompilacja przeszła do `fullmag-runner`;
log zawiera ostrzeżenia o nieużywanym imporcie i metodzie deprecated, bez
zgłoszonego błędu kompilatora na tym etapie. Job nadal nie ma wyniku
terminalnego, a jego snapshot nie obejmuje poprawki znaku Floqueta.

### Fail-fast legalność interakcji Floqueta — 2026-09-24

Reaudyt wykazał rozjazd: natywny shared-domain solver odrzucał anizotropię,
DMI, niejednorodne `A` i anizotropię powierzchniową dopiero podczas
przygotowania runtime, podczas gdy `plan_fem_eigen` mógł zwrócić poprawny
plan CPU `FloquetAirbox`. Planner sprawdza teraz te same pola przed
opublikowaniem planu i zwraca jawny błąd `fallback=none`; bazowa ścieżka
exchange/Zeeman/demag oraz provenance pozostają bez zmian.

Dodano regresje planera dla anizotropii jednoosiowej i bulk DMI. Nie
uruchomiono testów Rust ani ich kompilacji zgodnie z aktywnym zakazem.
`git diff --check` przechodzi. `cargo fmt -p fullmag-plan -- --check` wskazał
już istniejące, niepowiązane formatowanie w tych dużych plikach (m.in. importy
i funkcje w `fem.rs`, starsze asercje w `tests.rs`); szerokiego formatowania
nie zastosowano.

Nie zmienia to zakresu opublikowanej capability: niezerok-Floquet demag nadal
nie jest kwalifikowany. Wymagane jest źródłowe sprawdzenie przez następny
managed build oraz dowód, że niedozwolone wejścia zatrzymują się na plannerze.
Wiersz dyspersji w `docs/specs/capability-matrix-v0.md` doprecyzowano tak,
by odróżniał istniejący w źródle operator od produkcyjnej capability; nie
włączono `production_cpu` dla demagu niezerowego k.
Job #118 nadal jest aktywny po `runner-wait` z timeoutem 30 s; ponowny status
potwierdził `running`, `exit_code=null` i ten sam snapshot. Nie anulowano ani
nie zdublowano joba. Po jego terminalnym zakończeniu należy zbudować aktualny
snapshot, zawierający poprawkę znaku i walidację planera, przed kolejnym
`DE-SMOKE`.

#### Postęp joba #118 — 2026-09-24

Odczyt oficjalnego `runner-logs` wykazał
`native-build end exit_code=0` po `3,009,736 ms`, a potem rozpoczęcie
`frontend-dependencies` (`pnpm install --frozen-lockfile`). Status joba nadal
`running`, `exit_code=null` w chwili tego odczytu; nie było wtedy terminalnego
receipt. To potwierdza
kompilację natywnego snapshotu #118, ale nie zmiany z poprawką znaku Floqueta
ani fail-fast walidacją planera, które powstały po jego capture. Nie wysłano
drugiego joba; po zakończeniu tego builda następny snapshot musi zawierać
aktualne źródła.

### S08 — wektor k w handoffie punktu i gałęzi — 2026-09-24

Audyt kodu Control Room wykazał, że wybór próbki wykresu zachowywał wektor
`k` z kolumn CSV, ale gubił go, gdy jedynym źródłem były kontrolne punkty
`path_metadata`; wybór próbki w tabeli gałęzi nie niósł ani `k`, ani `path_s`.
Model wykresu odtwarza teraz każdy wektor z liniowego podziału kolejnych
kontrolnych `k_vector` zgodnie z `samples_per_segment`. Model gałęzi łączy
punkt po `(sample_index, raw_mode_index)` z tym samym artefaktem dyspersji,
a selekcja i polecenie podglądu 3D przekazują `wavevectorKf` i `pathS`.
Eksport CSV gałęzi zawiera teraz próbkę, mod, współrzędną ścieżki oraz
składowe `k`. Wiersz piku FMR nie publikuje pola 3D, gdy producent jawnie
ustawił `mode_field_available=false`, nawet jeśli obecne jest ID pola.

Dodano regresje modelu dla interpolacji wektora k, selekcji gałęzi i
niedostępnego pola FMR. Nie uruchomiono testów jednostkowych z powodu
obowiązującego zakazu ich kompilacji/uruchamiania. `git diff --check` przechodzi.
S08 nadal nie jest zweryfikowane w przeglądarce; wymagany jest modalny flow
chart → wybrany punkt/gałąź → overlay z przestrzenną fazą Floqueta, kontrola
widocznego canvas/WebGL i rysującego bufora oraz export/import FMS.

### Terminalny wynik managed build #118 — 2026-09-24

Job `674dac1a46fc4cf4ba5268459f4fc845` (`fem-cpu-slepc-modal-v1`, snapshot
`175f5c31e5a57dac4a1c8364d473a69ab1452ffe620031af161ff9761ee8b283`)
zakończył się `succeeded`, exit code 0. Log potwierdza sukces
`native-build` (3 009 736 ms), instalacji zależności frontendu (1 017 022 ms)
i `frontend-build` (379 148 ms); produkcyjny build Next.js zakończył
kompilację, TypeScript i prerender bez błędu. To dowód buildu dla zamrożonego
źródła #118, nie dla bieżących edycji S08 ani późniejszej poprawki znaku
`A_phiq`. Job nie uruchamiał solvera ani nie wyprodukował zaakceptowanego
punktu dyspersji.

Po zakończeniu #118 odczyt stanu przez uprawniony, tylko-odczytowy dostęp
potwierdził `Fullmag_build_runner` `running`, `health.ok=true`, żywego workera,
`accepting_jobs=true`, pustą kolejkę i 42 576 662 528 bajtów wolnego miejsca.
Profil `fem-cpu-slepc-modal-v1` jest dozwolony. Następny krok to jeden świeży
snapshot bieżącego worktree, a potem kontrola jego receipt i uruchomienie
`DE-SMOKE` z runtime przypisanym do tego snapshota.

### Świeży snapshot #120 — 2026-09-24

Po terminalnym sukcesie #118 potwierdzono stan wspólnego runnera:
`health.ok=true`, `worker_alive=true`, `accepting_jobs=true`, `active_jobs=[]`,
profil `fem-cpu-slepc-modal-v1` dozwolony i 42 576 662 528 bajtów wolnego
storage. Zgłoszono bieżący worktree jako job #120:
`90a4051188614844bb1b64b9a5e0841c`, source digest
`0221cae0e29db59ba330e4636fc60188e987ed0915294393b1b3e70f3c839790`, capture
`e42ba5f0a6fe4da49f865b59022dbb54`, snapshot SHA-256
`e3d650b15730a1263754cc0e391321e8a1117b813ed5a5ae12288f26f7e6b3d7`, bazowy
HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Z kapsuły odczytano i
porównano z worktree hashe aktualnego `frequencyDomainChartModels.ts`,
`EigenBranchInspectorPanel.tsx`, poprawionego
`poisson_airbox_shared_domain.cpp` i fail-fast walidacji `fullmag-plan`; każdy
porównany plik jest identyczny z bieżącym. Job ma stan `queued`, więc nie ma
jeszcze wyniku builda ani runtime. Po jego terminalnym zakończeniu trzeba
zweryfikować receipt/hashy, następnie uruchomić `DE-SMOKE` i sprawdzić
niezerowy punkt k przed uznaniem S04/S05.

### S04/S05 — lokalna baza styczna na szwie Floqueta — 2026-09-24

Współdzielony modalny operator Blocha nie wymaga już identycznych składowych
`e1/e2` na parze periodycznej. Dla reprezentanta klasy i jej członka buduje
`R = T_member^T T_rep`, a ograniczenie magnetyczne stosuje
`exp(-i k·Δr) R`. Akceptacja nadal wymaga zgodnych fizycznych wektorów
magnetyzacji równowagowej oraz skończonych, ortonormalnych i prawoskrętnych
ram stycznych. Inna magnetyzacja lub niejednostkowa fizyczna rotacja spinowa
`Q` pozostają odrzucane przez ten kontrakt.

Dodano regresję dla obrotu lokalnej bazy o 90 stopni, współczynników fazowanej
macierzy `2×2` i osobne odrzucenie niezgodnego fizycznego stanu równowagi.
Zgodnie z aktywną instrukcją repozytorium nie kompilowano ani nie uruchamiano
testów jednostkowych. `git diff --check` przechodzi; kompilacja i test regresji
pozostają NOT VERIFIED.

Ponowny odczyt wspólnego runnera wykazał job #119 (`3c386adf…`) w stanie
`running` i #120 (`90a40511…`) w stanie `queued`; oba zgłaszają ten sam source
digest `0221cae0…`. Ich niezmienne snapshoty powstały przed poprawką mapy ram,
więc nie walidują tego przyrostu. Nie przerwano żadnego joba. Po zwolnieniu
worktree-lock należy zarejestrować jeden snapshot najnowszych źródeł i potwierdzić
receipt przed smoke `DE`.

Odczyt `runner-logs` dla #119 pokazuje trwający etap `native-build` (`make
install-cli-dev`) i kompilację crate'ów Rust; widoczne są tylko ostrzeżenia, bez
zgłoszonego błędu kompilatora. Job nie ma terminalnego wyniku ani receipt.

Poprawka dotyczy aktualnego shared-domain modalnego importera. Osobny
driven-response validator w `driven_response_solver.cpp` nadal wymaga zgodnych
lokalnych ram; ta ścieżka nie jest dowodem obsługi ogólnego `Q` i wymaga osobnego
zakresu, jeśli ma dzielić tę samą elastyczną semantykę.


### S04/S05 — korekta Rust preflight ram Floqueta — 2026-09-24

Rust preflight shared-domain Full2x2 niepotrzebnie wymagał identycznych lokalnych ram stycznych, choć natywny operator C++ już transportuje współrzędne macierzą T_member^T T_rep. Zmieniono go na kontrolę zgodności fizycznych wektorów równowagi m0 dla translacyjnego Q = I; zmiana orientacji lokalnej bazy stycznej jest dozwolona, a niezgodność m0 nadal kończy się błędem.

Dodano testy dla obu przypadków. Nie kompilowano ani nie uruchamiano testów jednostkowych zgodnie z obowiązującą instrukcją repozytorium. git diff --check przechodzi; ta korekta pozostaje niezweryfikowana runtime.

Bieżący odczyt managed runnera: job #119 3c386adf… nadal running, job #120 90a40511… nadal queued; oba mają digest 0221cae0… i snapshot zarejestrowany przed tą poprawką. Nie anulowano ani nie zdublowano jobów. Po zwolnieniu kolejki potrzebny jest świeży snapshot bieżącego worktree, następnie build z receipt i run DE-SMOKE.

Szacunek end-to-end pozostaje heurystyczny: **20–25%**; prace źródłowe/przygotowawcze około **45%**; zaakceptowany naukowo punkt k != 0 nadal **0%**.


### S08 — błąd TypeScript w managed buildzie #119 — 2026-09-24

Job #119 3c386adf… zakończył się jako failed, exit code 2. Etap native-build przeszedł, ale frontend-build dwukrotnie zatrzymał się na błędzie TypeScript w frequencyDomainChartModels.ts:1885: niedozwolony końcowy przecinek po typie wartości generyka Map. Usunięto ten przecinek w bieżącym worktree.

Job #120 90a40511… jest teraz running, ale używa tego samego digestu 0221cae0… i zawiera błąd sprzed poprawki. Nie przerwano go. Ani #119, ani #120 nie budują obecnej wersji po poprawce; po terminalnym #120 potrzebny będzie świeży managed build bieżącego snapshotu.

Błąd składni jest poprawiony źródłowo, lecz jego naprawa pozostaje bez managed build proof. End-to-end: **20–25%**; źródło/przygotowanie: około **45%**; zaakceptowany naukowo punkt k != 0: **0%**.

### Aktualizacja checkpointu kolejki i postępu — 2026-09-24

Status #120 (`90a4051188614844bb1b64b9a5e0841c`) odczytany ponownie: `running`, bez `exit_code`, ze starym digestem `0221cae0…`, sprzed obecnych poprawek. Nie anulowano joba ani nie dodano duplikatu. `just runner-container-status` nie potwierdził zdrowia kontenera (`Docker Desktop coordinator request failed`), więc przed kolejnym snapshotem trzeba poczekać na terminalny wynik #120 i ponownie poświadczyć runner.

Szacunek celu end-to-end: **20–25%**; źródła i przygotowanie: około **45%**; zaakceptowany wynik naukowy `k != 0`: **0%**. Aktualny kod nie ma managed-build proof, a częstotliwość, porównanie analityczne i wykres pozostają do uzyskania.

### S05 — świeży build bieżących poprawek #122 — 2026-09-24

Wspólny managed runner ma `health.ok=true`, żywego workera, `accepting_jobs=true`, brak błędu workera, dozwolony profil `fem-cpu-slepc-modal-v1` i 34 362 441 728 B wolnego storage. Job #120 (`90a4051188614844bb1b64b9a5e0841c`) nadal jest `running` na starym source digest `0221cae0…`. Jego stanu nie zmieniano. Raport koordynatora ma `active_job_ids=[]`, lecz kolejkowy endpoint nadal zwraca #120 jako running; nie uznaję go za zakończony ani nie odzyskuję lease.

Bieżący snapshot zgłoszono poprawną receptą managed z dedykowanego worktree. Job #122: `3f6c3486725745af9349895a0588a72b`, `state=queued`, `exit_code=null`, source digest `b4af0bd998b64b4eb68528cbe7432707419892b455df65036f6b2d05873ab8a6`, capture `e1733f2c90ab4c5eb3dd945b0ef92364`, source snapshot SHA `2f16693d4cc14f16cbf587442b2a85ce830802825a5b4534bc9e741eb140a9d4`, HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Wspólna lista pokazuje wyłącznie #120 running i #122 queued; #121 z worktree eigensolve-k0-finalization jest terminalnie cancelled. Brak równoległego buildu.

Nie ma jeszcze receipt ani aktualnego build proof. Po terminalnym #120 runner powinien podjąć #122; następnie zweryfikować receipt/hashe, uruchomić `DE-SMOKE` na runtime przypisanym do dokładnego snapshotu i ocenić k2 z residualem, polami oraz demagiem. Testów jednostkowych nie kompilowano ani nie uruchamiano.

Szacunek: **20–25% celu end-to-end**, około **45% źródeł/przygotowania**, **0% zaakceptowanego wyniku naukowego `k != 0`**.

### S04/S05 — rozdzielenie proweniencji residuali — 2026-09-24

Parser wyniku Floqueta nie kopiuje już residualu względnego do pól
`residual_absolute_l2`, `residual_linf` ani `backend_reported_residual`.
Każde pole przyjmuje wyłącznie własną wartość producenta; gdy jej nie ma,
artefakt zachowuje brak zamiast publikować syntetyczne zero lub alias innej
normy. Residuale obliczane ponownie po stronie runnera pozostają osobno
oznaczone jako obliczone, a nie raportowane przez SLEPc.

Dodano regresje parsera i serializacji ścieżki modalnej. `rustfmt +nightly
--check` dla pięciu zmienionych plików Rust oraz `git diff --check` przeszły.
Testów Rust nie kompilowano ani nie uruchamiano z powodu obowiązującej
instrukcji repozytorium. To poprawia wiarygodność diagnostyki, ale nie
certyfikuje pełnego residualu deskryptora, szwów ani gauge.

### S08 — wybór punktu, dostępność pola i ciągłość wykresu — 2026-09-24

Oba wykresy dyspersji w panelach Dispersion i k-Path przekazują kliknięty
punkt do selekcji. Podgląd modalnego pola wymaga teraz opublikowanego klucza
zasobu; samo ID nie tworzy już pozornego handoffu 3D. Explorer preferuje
wektor `k` z CSV, gdy artefakt nie ma sidecara ścieżki. Serie śledzonych
gałęzi zachowują przerwy między brakującymi próbkami, a nieśledzone surowe
mody są rysowane jako punkty, bez łączenia ich w pozorne gałęzie.

Dodano regresje dla brakującego klucza pola, przerw w danych, nieśledzonych
modów, null-sentinela renderera i wektora `k` w CSV. `git diff --check`
przechodzi. Formatowania Prettier nie można było sprawdzić, bo formatter nie
jest zainstalowany w tym worktree. Testów jednostkowych nie uruchomiono.
Zmiany nie mają jeszcze managed-build ani browser/WebGL proof.

Job #120 (`90a4051188614844bb1b64b9a5e0841c`) pozostaje `running` ze starym
digestem `0221cae0…`; job #122 (`3f6c3486725745af9349895a0588a72b`) jest
`queued` z digestem `b4af0bd…`. Żaden snapshot nie zawiera powyższych poprawek.
Po zwolnieniu kolejki i potwierdzeniu zdrowia runnera potrzebny jest jeden
świeży snapshot, jego terminalny build/receipt, następnie `DE-SMOKE` z tego
runtime. Nadal nie ma obliczonej ani zaakceptowanej częstotliwości `k != 0`.

Szacunek pozostaje heurystyczny: **20–25% celu end-to-end**, około **45% prac
źródłowych/przygotowawczych** i **0% zaakceptowanego wyniku naukowego dla
`k != 0`**.

### Reattestacja runnera po zmianach S08 — 2026-09-24

Po ostatnim odczycie recepta `just runner-container-status` zakończyła się
błędem `Docker Desktop coordinator request failed`. To nie dowodzi awarii
solverowego workera, ale nie pozwala potwierdzić aktualnego zdrowia kontenera.
Lista kolejki nadal pokazywała #120 jako `running` i #122 jako `queued`;
nie zmieniono ani nie anulowano ich stanu. Nie zgłoszono nowego snapshotu i
nie uruchomiono alternatywnego builda. Kolejny build wymaga ponownej
reattestacji przez obsługiwaną receptę.

### Bieżąca reattestacja kolejki i procent postępu — 2026-09-24

Aktualny odczyt managed runnera: kontener działa, `health.ok=true`, worker żyje, przyjmuje zadania, nie zgłasza błędu; profil `fem-cpu-slepc-modal-v1` jest dozwolony, wolne miejsce: 29 166 612 480 B. Job #120 (`90a4051188614844bb1b64b9a5e0841c`) zakończył się błędem (`exit_code=2`): kompilacja natywna i instalacja zależności frontendowych przeszły, ale frontend zatrzymał się na błędzie TypeScript `frequencyDomainChartModels.ts:1885` (końcowy przecinek w typie `Map`). Naprawa składni jest już w bieżącym worktree.

Job #122 (`3f6c3486725745af9349895a0588a72b`) pozostaje `running`, na starszym snapshotcie (`source_snapshot_sha256=2f16693d…`, source digest `b4af0bd…`) sprzed najnowszych poprawek residuali i paneli frontendowych. Runner zgłasza go w `active_jobs`, mimo że `active_job_ids` jest puste. Nie przerywano joba ani nie odzyskiwano lease. Należy dodać aktualny snapshot do serialnej kolejki i poczekać na wynik obu buildów.

Ocena postępu jest szacunkiem, nie miarą ukończonych punktów planu: **20–25% całego celu**, około **45% prac źródłowych/przygotowawczych**, **0% naukowej walidacji niezerowego k**. Mamy kod i regresje źródłowe dla części kontraktów oraz wykresów, ale nie mamy potwierdzonej częstotliwości z solvera dla `k != 0`, porównania z analityką ani wykresu z obliczonych danych. Testów jednostkowych nie kompilowano ani nie uruchamiano zgodnie z obowiązującą regułą repozytorium. Aktualny kod nie ma jeszcze managed-build proof ani browser/WebGL proof.

### Job #123 — snapshot bieżącego worktree w kolejce — 2026-09-24

Po potwierdzeniu zdrowia runnera zgłoszono bieżący snapshot do wspólnej kolejki: #123 (`c62f1d5990ec4806bba82d8fb33beda3`), profil `fem-cpu-slepc-modal-v1`, `state=queued`. Job #122 (`3f6c3486725745af9349895a0588a72b`) był w chwili zgłoszenia nadal `running`; jobów nie uruchomiono równolegle ani nie anulowano. #123 ma `source_digest=c5768e4253f359e16e993af2d4a91ab1ae1a349f7713df1801c3d6d3eb5abeb0`, `capture_id=6fcb48331d8e48028c1e42fea2da021a`, `source_snapshot_sha256=f05ba3d65e0cf3f0be98d01aabfa6a8fa1c6b0cd6d02bfeb75dbaab4304775af`, bazowy HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Jest to build źródła, nie dowód wyniku fizycznego; po terminalnym buildzie nadal wymagane są receipt, DE-SMOKE i akceptacja częstotliwości, residuali, fazy Floqueta i demagu.

### T4 — częściowy operatorowy probe demagu, 2026-09-24

Dodano źródłowy przyrost do ścieżki niezerowego `k`: assembler tworzy dwa
jednorodne zaburzenia poprzeczne w lokalnych współrzędnych stycznych, a solver
przed EPS rozwiązuje dla nich ten sam blok potencjału `P phi = -A_phiq q`.
Diagnostyka raportuje residual równania potencjału, energię z bloku potencjału,
energię ze sprzężenia zwrotnego i defekt Hermitowskości. Przekroczenie progu
`1e-8` dla obserwowalnego wymuszenia zatrzymuje solve; jawny status probe trafia
do diagnostyki i wyniku natywnego.

To nie zamyka T4. Brakuje testu `Gamma` dla składowych równoległej i
prostopadłej oraz kontroli `N_z` wynikającego z geometrii, rekonstrukcji pola,
markerów interfejsów i fazy Floqueta, a także porównania niezerowego `k_y` z
niezależnym profilem 1D. Gdy jedno z globalnych wymuszeń nie jest obserwowalne,
obecny solver oznacza probe jako `not_observable` i kontynuuje; walidator
benchmarku musi wymagać `passed` dla konfiguracji DE. Testy nie zostały
skompilowane ani uruchomione. `git diff --check` przechodzi.

Job #122 zakończył się sukcesem (exit 0), ale nie zawiera bieżącego przyrostu
T4. Job #123 (`c62f1d5990ec4806bba82d8fb33beda3`) nadal działa; jego źródłowy
snapshot został przechwycony przed tym przyrostem, więc jego sukces nie będzie
dowodem kompilacji nowego probe. Po zakończeniu #123 wymagany jest kolejny
snapshot z aktualnego worktree. Nie ma zaakceptowanego wyniku dla `k != 0`;
szacunek end-to-end pozostaje **20–25%**, a naukowa walidacja `k != 0` **0%**.

### T4 — fail-closed dla nieobserwowalnej osi K0 — 2026-09-24

Reaudyt agregatora probe ujawnił lukę: próbka kierunku oznaczonego jako
nieobserwowalny zwracała z helpera `true` bez wykonania solve'a, a agregator
sprawdzał tylko, czy wykonano jakąkolwiek próbę. Przy obserwowalnym `y` i
nieobserwowalnym `z` status mógł więc przejść i dopuścić solve EPS, mimo że
artefakt Gamma nie zawierał pełnego pomiaru obu osi wymaganych dla DE.

Agregacja wymaga teraz obserwowalności obu osi i sukcesu obu prób; w innym
przypadku natywny solve kończy się przed EPS. Dodano negatywny fixture
walidatora: status główny `passed` z niepodjętą próbą `global_z` musi zostać
odrzucony.

Parser składni Pythona dla walidatora i jego testu oraz `git diff --check`
przeszły. Testów jednostkowych nie uruchomiono ani nie kompilowano zgodnie z
regułą repozytorium. Job #123 nie zawiera tej poprawki; po jego zakończeniu
potrzebny jest nowy snapshot w kolejce i runtime Gamma. Postęp pozostaje
heurystycznie **20–25% end-to-end**, około **45% kodu/przygotowania** i **0%**
zaakceptowanej naukowo dyspersji dla `k != 0`.

### Terminalny wynik joba #123 i poprawki po jego awarii — 2026-09-24

Job #123 (`c62f1d5990ec4806bba82d8fb33beda3`) zakończył się `failed`,
`exit_code=2`. Log potwierdza `native-build` z `exit_code=0` oraz instalację
zależności frontendu z `exit_code=0`; dwukrotna próba `web-build-static`
zatrzymała się na błędzie TypeScript w
`apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts:1106`.
Typ `kind` został poszerzony do `string`, choć kontrakt serii dopuszcza tylko
`line | scatter`. Zmienna otrzymała jawny typ `NonNullable<...kind>`, bez zmiany
wyboru scatter dla surowych modów i line dla śledzonych gałęzi. Poprawka nie ma
jeszcze potwierdzenia managed buildem.

Po awarii `just runner-container-status` zwrócił
`Docker Desktop coordinator request failed`. Status i log joba dało się
odczytać, ale zdrowie/akceptowanie zadań nie zostało potwierdzone; nie wysłano
duplikatu ani nowego snapshotu. Następny krok: ponowić reattestację istniejącego
runnera przez obsługiwaną receptę; dopiero przy potwierdzonym zdrowiu wysłać
świeży snapshot z worktree i kontynuować po FIFO.

Kontrole źródłowe po poprawkach: Python AST walidatora i fixture'u oraz
`git diff --check` przeszły. Testów jednostkowych i kompilacji lokalnej nie
uruchomiono. Wyniku dla `k != 0`, porównania analitycznego ani wykresu nadal nie
ma; postęp pozostaje **20–25% end-to-end**, około **45% źródła/przygotowania**,
**0% naukowo zaakceptowanego wyniku `k != 0`**.

### Reattestacja wspólnego runnera — 2026-09-24

Wspierana recepta `just runner-container-status`, uruchomiona z dostępem hosta,
potwierdziła istniejący kontener `Fullmag_build_runner`: `health.ok=true`,
worker żyje, `accepting_jobs=true`, `active_jobs=[]`, profil
`fem-cpu-slepc-modal-v1` jest dozwolony, a wolne miejsce wynosi
14,895,345,664 B. Odczyt listy kolejki potwierdził, że #123 jest terminalnie
`failed` (`exit_code=2`), #122 zakończył się sukcesem i nie ma nowszego aktywnego
jobu. Poprzedni błąd kontroli zdrowia był granicą dostępu do Docker Desktop w
ograniczonym środowisku; użyto tej samej read-only recepty z dostępem hosta,
bez zmiany konfiguracji.

Runner jest gotowy do przyjęcia kolejnego snapshotu po zatrzymaniu edycji na
czas capture. Nowy build musi zawierać poprawkę TypeScript i fail-closed K0;
wynik #123 ich nie obejmuje. Nie ma jeszcze wyniku solvera dla `k != 0` ani
wykresu, więc szacunki celu pozostają **20–25% end-to-end**, około **45%**
źródła/przygotowania i **0%** zaakceptowanej naukowo dyspersji `k != 0`.

### Job #124 — świeży snapshot po poprawkach — 2026-09-24

Wysłano jeden snapshot istniejącego worktree do wspólnego FIFO po potwierdzeniu
zdrowia runnera i pustego slotu. Job #124 ma ID
`40e05e4a2bff497fbcd6f1c853a24221`, profil `fem-cpu-slepc-modal-v1`, digest
`30cc17ad49fdd7df6ad9876bc006187a1f3b5724f92cea397496ea3475c067fc`, capture
`ff908a7894f94d1faaa2e3af61ccd895`, source snapshot SHA
`453398d2c4b6d96d8131a2864946b88d0b52a78ed92c73a864327194c503613d` i bazowy
HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Przy pierwszym odczycie po
zgłoszeniu stan zmienił się z `queued` na `running`; nie ma drugiego joba.

To jest nowy build aktualnego snapshotu, nie wynik solvera. Po terminalnym
sukcesie wymagane są receipt/hashy, pilot Gamma/k2 z tego runtime, kontrola
residuali/Floquet/demagu i analityczne porównanie. Wykres nadal nie istnieje.
### Wynik #124 i poprawka błędu kompilacji — 2026-09-24

Job #124 zakończył się `failed`, `exit_code=2`. Kompilator wskazał w
`backends/fem/src/frequency_domain/modal_eigen_solver.cpp:467` niepoprawne
łączenie dwóch literałów `const char[]` operatorem `+`. Pierwszy operand
zmieniono na `std::string`; `git diff --check` przeszedł. `native-build`
zakończył się po 592414 ms przed receipt runtime i bez uruchomienia solvera.

Świeży snapshot przyjęto jako #125, ID
`b03024288adc4cf0849a1b9c51b375be`, profil `fem-cpu-slepc-modal-v1`, digest
`a21e7963914525b5c635f4130e6aad3b3473fc08d64df3473e0145fb21e2bee3`, capture
`195d849d85b34eca8405fcffa575ed0f`, source snapshot SHA
`2f53f1eface1e332aa37b07f1b79cf243273f8ba0db099dbd964b3a215613b3c`, HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Job przeszedł do `running`.
Nie ma jeszcze częstotliwości `k != 0`, porównania analitycznego ani wykresu.

### Terminalny wynik #125 — rozjazd profilu runnera i receipt, 2026-09-24

Job #125 (`b03024288adc4cf0849a1b9c51b375be`) zakończył się `succeeded`,
`exit_code=0`, dla profilu `fem-cpu-slepc-modal-v1`, source digest
`a21e7963914525b5c635f4130e6aad3b3473fc08d64df3473e0145fb21e2bee3` i snapshotu
`2f53f1eface1e332aa37b07f1b79cf243273f8ba0db099dbd964b3a215613b3c`. Etapy
`native-build`, `frontend-dependencies` i `frontend-build` przeszły. UI uzyskał
webpack success, TypeScript success oraz statyczny eksport. Natywny build trwał
2074116 ms; instalacja zależności 1115914 ms; build UI 400443 ms.

`just run-de-smoke b03024288adc4cf0849a1b9c51b375be k2` zostało odrzucone przed
uruchomieniem kontenera. Bezpośrednia diagnostyka walidatora wykazała
`Build receipt contract scenario list mismatch`: receipt ma
`contract_scenarios=null`, etapy zawierają wyłącznie native/UI, a artefaktów
`contracts/slepc-modal` brak. To nie jest błąd solvera ani wynik częstotliwości.
Lokalny profil wymaga `contract_scenarios=["slepc-modal"]` oraz etapu
`contract-slepc-modal`; sukces statusu joba #125 nie dowodził więc wykonania
kontraktu modalnego.

Przyczyną był nieaktualny obraz koordynatora `sha256:f1235e1a…`, którego
zaufany entrypoint nie realizował kontraktu z bieżącego worktree. Zbudowano
obraz `sha256:eed020f1664bde606b20412968681094a885f3e7080679c6d21c90a4160253e4`
z aktualnych plików `scripts/local_runner/`. Po sprawdzeniu braku zadań
aktywnych i oczekujących koordynator zatrzymano łagodnie, wymieniono dokładnie
kontener `Fullmag_build_runner` i wznowiono. Nowy kontener
`8d1bb4980a6231a44c9109585ea000179e87a4658093334179dccb9eb3295fd3` jest zdrowy,
przyjmuje zadania, dopuszcza `fem-cpu-slepc-modal-v1`; storage i kolejka
pozostały zachowane. Aktualny worker ma 0 aktywnych jobów.

Następny krok: wysłać świeży snapshot jako #126, potwierdzić w receipt
`contract_scenarios=["slepc-modal"]`, przejście `contract-slepc-modal` i zgodność
pełnego source identity. Dopiero po terminalnej walidacji uruchomić ponownie
`de-smoke-k2`; akceptacja nadal wymaga niepustej częstotliwości, residuali,
fazy Floqueta i kontroli demagu.

### Job #126 — zablokowany przed uruchomieniem, 2026-09-24

Jeden świeży snapshot trafił do wspólnej kolejki jako #126, ID
`7ab40a3eb5ed4a3e9b1ba4ae06fbeebc`, digest `28c84c0fd2cc4762632a4ba63572d4248b91c29330a7b091b7d0d0afee189e11`,
capture `4e16b88e26f8404a9a1ba8bd73c262de`, snapshot SHA
`2f53f1eface1e332aa37b07f1b79cf243273f8ba0db099dbd964b3a215613b3c`, HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Koordynator później oznaczył job
`blocked`; `runner-logs` zwraca puste `tail`, a katalog run, `coordinator.json`,
`artifacts` i `execution` nie powstały. Nie uruchomiono kontraktu SLEPc ani
solvera, więc brak wyniku częstotliwości `k != 0`.

Przy reattestacji runner był zdrowy i bez aktywnych jobów; wolne miejsce wynosiło
`7,966,253,056 B`, poniżej bramki `8 * 1024^3 B`. Kod
`scripts/local_runner/build_executor.py` ponawia sprawdzenie miejsca przed
utworzeniem `run_root` i odrzuca start poniżej 8 GiB. To najbardziej prawdopodobna
przyczyna blokady, ale job nie zachował pola z dokładnym błędem; nie nazywamy jej
udowodnioną. Nie znaleziono innego żywego procesu hosta odnoszącego się do ID
kandydatów retencji; worker i koordynator są idle, bez aktywnych ani legacy jobów.

Read-only planner retencji, uruchomiony na danych z autoryzowanego `list`,
wykazał 16 wygasłych kandydatów (łącznie `2,550,514,582 B`). Siedem niezerowych
katalogów `execution` w tym samym worktree ma łącznie `1,961,268,011 B`:
`2550ff2862c5471babe6e09f99168265`, `3c596f0c88484245938fd01294ef2d1e`,
`877ebb8481a641b0b61f03ba2470c320`, `d6e69265e6314ac5ad17cf9f1d533c78`,
`dd96c72330e2422e9dd014f268457bc0`, `eacae28e4cd740259773b4c2b57c3632`,
`f906018149c64956b7ce0b8976124b39`. Są to terminalne failed/cancelled
execution trees; artefakty, logi, manifesty i historię kolejki można zachować.
Nie usunięto żadnych danych. Wcześniejsza jednorazowa autoryzacja dotyczyła
jobu `9da3622cca884500a49f1295081e4d6a` i została już wykorzystana, więc nie
obejmuje tych siedmiu nowych katalogów.

Następny krok wymaga albo stabilnego wzrostu wolnego miejsca ponad 8 GiB, albo
osobnej zgody na usunięcie wskazanych katalogów execution. Ewentualne odzyskane
`1.96 GB` dałoby około `9.27 GiB` przy ostatnim pomiarze, tylko `1.27 GiB` ponad
bramkę; nie jest to gwarancja bezpiecznego szczytowego miejsca. Dopiero po
sprawdzeniu bieżącego wolnego miejsca i nowym pojedynczym snapshotcie można
ponowić modalny build. Postęp celu pozostaje **20–25% end-to-end**, około **45%**
źródła/przygotowania i **0%** naukowo zaakceptowanej dyspersji `k != 0`.

#### Ponowny odczyt #126 — 2026-09-24

Job #126 pozostaje `blocked`; runner zdrowy i idle, `active_jobs=0`, `legacy_jobs=0`. Wolne miejsce spadło do `7,752,859,648 B` (około `7.22 GiB`), nadal poniżej bramki. Katalogi execution z retencji pozostają nieusunięte; oczekuje się na stabilne wolne miejsce albo odpowiedź operatora na dokładnie wskazany zakres. Nie wykonano solvera.

#### Zatwierdzone sprzątnięcie i wznowienie runnera — 2026-09-24

Operator zatwierdził usunięcie wyłącznie siedmiu katalogów `execution` jobów
`2550ff2862c5471babe6e09f99168265`, `3c596f0c88484245938fd01294ef2d1e`,
`877ebb8481a641b0b61f03ba2470c320`, `d6e69265e6314ac5ad17cf9f1d533c78`,
`dd96c72330e2422e9dd014f268457bc0`, `eacae28e4cd740259773b4c2b57c3632`
i `f906018149c64956b7ce0b8976124b39`. Bezpośrednio przed usunięciem lista
runnera potwierdziła dla wszystkich tych ID stan `failed` albo `cancelled`,
właściwy `worktree_id` i zero zadań oczekujących lub aktywnych. Każda ścieżka
została rozwiązana pod katalogiem storage; nie wykryto punktów dowiązania.
Usunięto tylko liście `execution`, łącznie `1,961,268,011 B`. Dla wszystkich
siedmiu jobów zachowano katalogi nadrzędne oraz `artifacts`, `trusted`,
`coordinator.json`, `receipt.json` i `worker.log`; kontrola po operacji
potwierdziła ten stan.

Pauza przyjmowania została przyjęta i po sprzątnięciu cofnięta. Weryfikacja
przez managed runner potwierdziła kontener `Fullmag_build_runner` w stanie
`running`, `health.ok=true`, `worker_alive=true`, `accepting_jobs=true`,
`worker_error=null`, koordynator `idle`, `active_jobs=[]`, `legacy_jobs=[]`,
brak żądania stop oraz dozwolony profil `fem-cpu-slepc-modal-v1`. Wolne miejsce
wynosiło `37,390,938,112 B` (około `34.8 GiB`). Odczyt doctor wykazał również
jeden działający kontener BuildKit GPU; nie uruchamiamy ani nie zmieniamy jego
obciążenia. Odczyt statusu wymagał uprawnionego dostępu do Docker Desktop;
managed API potwierdziło stan powyżej.

Job #126 (`7ab40a3eb5ed4a3e9b1ba4ae06fbeebc`) pozostaje `blocked` i nie dostarczył
wyniku solvera. Nie wysłano jeszcze nowego zadania po jego blokadzie. Następny
krok to wysłać jeden świeży snapshot z tego worktree do profilu
`fem-cpu-slepc-modal-v1`, potwierdzić receipt i kontrakt `slepc-modal`, a dopiero
po sukcesie uruchomić pilot `de-smoke-k2`. Obecnie nadal brak zaakceptowanej
częstotliwości dla `k != 0`, porównania numeryka–analityka i wykresu dyspersji.
Szacunek postępu pozostaje **20–25% end-to-end**, około **45% źródła/przygotowania**
i **0% naukowo zaakceptowanej dyspersji**.

#### Job #127 — managed build w toku — 2026-09-24

Po przywróceniu zdrowego runnera wysłano jeden świeży snapshot do profilu
`fem-cpu-slepc-modal-v1`: job #127, ID
`1078b783555b491a9dba90184a97f864`, capture
`1121f8197ad44876bcb4f14f4a49603b`, source digest
`757357d77e0071b9e5aa093c646186ea9de331ff97adfe1499eda71b801cb882`,
snapshot SHA `2f53f1eface1e332aa37b07f1b79cf243273f8ba0db099dbd964b3a215613b3c`,
HEAD `479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Rekord joba wiąże source digest z native source identity; końcowy build receipt jeszcze nie powstał.

Kontener joba `1abf7e296f32b46962c6e223e4dcc57d01f412e4670e6b28ca88774b3d7ba5a4`
uruchomił `build_entrypoint.py`. Zweryfikowano materializację 7 413 plików
(około 304 MB), a następnie etap `native-build` przez `make install-cli-dev`.
Procesy CMake/GMake, C++/CUDA i Rust są aktywne; najnowszy log pokazuje
kompilację `fullmag-runner` i ostrzeżenia kompilatora bez błędów. Status joba
pozostaje `running`, worker zdrowy, bez OOM; nie ma jeszcze końcowego receipt
ani raportu `contract-slepc-modal`. Solver nie policzył jeszcze częstotliwości.

Następny krok: czekać na zamknięcie native build, a potem sprawdzić w receipt
`contract_scenarios=["slepc-modal"]` oraz wynik `contract-slepc-modal`. Pilot
`de-smoke-k2` pozostaje warunkowy wobec zaliczenia kontraktu. Do tej chwili
postęp pozostaje **20–25% end-to-end**, około **45% źródła/przygotowania**
i **0% naukowo zaakceptowanej dyspersji k != 0**.
#### Job #127 — zakończony native-build, kompilacja kontraktu SLEPc — 2026-09-24

Etap `native-build` zapisał wynik instalacji launchera `fem-cpu`; logi
zawierają ostrzeżenia kompilatora, bez błędu. Następnie runner uruchomił
`contract-slepc-modal`. Aktualny log tego etapu pokazuje budowanie targetu
`fullmag_fem` przez CMake (około 50% w ostatnim odczycie). Scenariusz testowy
nie zakończył się jeszcze, nie ma raportu wyniku ani końcowego build receipt.
Job #127 pozostaje `running`; worker działa w managed containerze i nie zgłasza
błędu. Nie uruchomiono pilota `de-smoke-k2` i nadal brak częstotliwości `k != 0`.

Następny krok: poczekać na koniec `contract-slepc-modal`, zweryfikować jego
raport i receipt, a potem — wyłącznie po przejściu kontraktu — wykonać pilot k2.

#### Job #127 — kontrakt zaliczony, pilot k2 zatrzymany przed widmem — 2026-09-24

Job `1078b783555b491a9dba90184a97f864` zakończył managed build i kontrakt
`contract-slepc-modal` wynikiem `passed`: 8/8 scenariuszy, w tym Floquet,
dynamic demag i waveguide demag. To potwierdza zbudowanie oraz kontrakt solvera,
ale nie kwalifikuje dyspersji.

Pilot `de-smoke-k2` zakończył się przed zwróceniem częstotliwości. Operator
`certified_shared_domain` i żądanie dla `k=[0, 2e6, 0] rad/m` dotarły do modalnej
ścieżki; walidacja odrzuciła je ogólnym powodem
`floquet_modal_shared_domain_sparse_operator_is_invalid`. Relaksacja była
`matched`, a statyczne szwy demagu PBC miały `status=ok`; w pilocie nie ma
zaakceptowanych modów, residuali ani punktu do porównania z analityką.

#### Job #128 — kompilacja przerwana przez stare wywołanie walidatora — 2026-09-24

Managed job `bc673fb078fd41679c402ad7da8a2b98`, source digest
`c3bd25470d03675f38536216110f5e6848804e4fd8c2568dcbb1cf9f3448a39f`, zakończył
się `failed`, `exit_code=2`. Kompilator C++ zatrzymał się w
`backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp`: po zmianie
walidatora na `floquet_shared_operator_invalid_reason` druga ścieżka solvera
nadal wywoływała usunięty symbol `floquet_shared_operator_is_valid`. To błąd
źródła, nie awaria runnera; nie wykonano ponownie kontraktu ani solvera.

Poprawiono tę drugą ścieżkę: propaguje teraz szczegółowy powód zwrócony przez
`floquet_shared_operator_invalid_reason`. `git diff --check` przechodzi, a
wyszukiwanie potwierdza brak pozostałych wywołań starego symbolu. Testów
jednostkowych nie uruchomiono zgodnie z tymczasowym zakazem kompilowania ich z
`AGENTS.md`; następną bramką jest świeży managed snapshot/build.

Przed kolejną wysyłką stan runnera potwierdzono read-only: kontener zdrowy,
`accepting_jobs=true`, worker żywy, koordynator `idle`, brak aktywnych i legacy
jobów, profil `fem-cpu-slepc-modal-v1` dozwolony, wolne miejsce
`35,299,020,800 B`. Następny krok: wysłać snapshot po tej poprawce; po sukcesie
ponownie sprawdzić kontrakt i dopiero wtedy uruchomić nowy pilot k2.

#### Job #129 — snapshot zweryfikowany, managed native-build trwa — 2026-09-24

Snapshot przyjęto jako job `f9f89773ae544aed9ebc6feecfa75a90`, profile
`fem-cpu-slepc-modal-v1`, source digest
`cfc8f194e93eddfb5e497b608cdda682675e309a1512bf49f5ff5266921d52e6`, capture
`eaae8d21b3944d8eb9a03cd7a208ae0e`, snapshot SHA
`2c0c391967ef7b6519d0abd5e583d4d8f9a8c258ced65ba5f9414b02e7303407` i HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`. Managed runner zweryfikował
tożsamość kapsuły i uruchomił worker container
`71d454421bec0ff3e75e411ccc135911ed2e2564ffda3af564cd76cd3416a9e4`.

Job utworzył `coordinator.json` oraz katalogi `artifacts`, `trusted` i `execution`;
przeszedł do `native-build`. Logi pokazują kompilację C++/Rust backendu FEM,
bez zgłoszonego błędu. Ostatni stan obserwatora: `running`, `exit_code=null`;
receipt końcowy i kontrakt SLEPc nie są jeszcze dostępne. Pilot k2 pozostaje
zablokowany do terminalnego sukcesu buildu i kontraktu.

#### Referencja analityczna DE-SMOKE — obliczona przed solve — 2026-09-24

Z kanonicznej funkcji
`scripts/verify_fem_frequency_domain_eigen_artifacts.py::kalinikos_slab_n0_frequency_hz`
obliczono otwarto-filmową referencję Kalinikosa–Slavina dla parametrów
`examples/fem_de_smoke_numeric.py`: DE, $t=10\,\mathrm{nm}$,
$M_s=800\,\mathrm{kA\,m^{-1}}$, $A=13\,\mathrm{pJ\,m^{-1}}$,
$B_0=0.1\,\mathrm{T}$ i
$\gamma_0=2.211\times10^5\,\mathrm{m\,A^{-1}\,s^{-1}}$.
Wynik referencyjny: $f_{n=0}(k=0)=9.309813711$ GHz oraz
$f_{n=0}(k_y=2\times10^6\,\mathrm{rad\,m^{-1}})=9.725724284$ GHz.
Nie są to częstotliwości FEM ani dopasowane wartości; nie uwzględniają błędu
skończonego airboxu i nie zamykają kontroli profilu gałęzi ani zbieżności.

#### Job #129 — native-build zaliczony, kontrakt SLEPc kompiluje się — 2026-09-24

API runnera potwierdza marker
`stage native-build end exit_code=0` (czas `2,119,951.866 ms`) i rozpoczęcie
`contract-slepc-modal`, które uruchomiło
`scripts/run_fem_cpu_slepc_modal_contract.sh slepc-modal`. Ostatni odczyt
kontraktu pokazuje około 42% budowy `fullmag_fem`, aktywny `cc1plus` i pusty
stderr. Job nadal ma stan `running`; nie ma jeszcze końcowego receipt ani wyniku
scenariusza SLEPc. Pilot k2 pozostaje zablokowany do terminalnego sukcesu.

### Job #129 — kontrakt SLEPc, najnowszy odczyt — 2026-09-24 19:52:04 +02:00

Log kontraktu SLEPc doszedł do około 97% budowania targetu fullmag_fem
(ostatnie obiekty CUDA); odpowiadający log błędów pozostaje pusty. Job
f9f89773ae544aed9ebc6feecfa75a90 nadal ma stan running i nie ma kodu wyjścia.
To jest postęp kompilacji, nie wynik kontraktu ani solvera. Brakuje jeszcze
końcowego receipt i raportu scenariuszy; pilot de-smoke-k2 pozostaje warunkowy
wobec zakończenia kontraktu.

### Job #129 — wynik końcowy, pilot i poprawka sond demagu — 2026-09-24

Odczyt API potwierdził `succeeded`, exit 0 dla joba
`f9f89773ae544aed9ebc6feecfa75a90`. Raport
`artifacts/contracts/slepc-modal/result.json` potwierdza osiem wykonanych
scenariuszy CTest, zero failures i zero skipped. Ten zestaw nie zawierał
kontraktu `fem_poisson_airbox_shared_domain_contract`.

Rzeczywisty pilot `de-smoke-k2`, zapisany pod tym jobem w
`comsol-dispersion/2898532814214c60934bc3ad373e6bbd`, zakończył się exit 1.
Relaksacja osiągnęła próg torque; obie podpróby okna modalnego zatrzymały się
przed iteracjami z `floquet_shared_domain_demag_probe_shape_mismatch`.
Wektor k wynosił [0, 2000000, 0] rad/m, liczba tangent DOF 100;
liczba zaakceptowanych modów wynosiła zero.

Przyczyna w źródłach: wrapper publikował sondy przed wywołaniem
`assemble_poisson_airbox_shared_domain`, które resetuje cały rekord wyniku.
Publikację sond przeniesiono za pomyślne assembly; dodano kontrolę zgodności
ich rozmiaru z ograniczonym operatorem stycznym i regresję C++ w istniejącym
kontrakcie shared-domain. Profil modalny oraz walidatory raportu rozszerzono
z ośmiu do dziewięciu scenariuszy, włączając ten kontrakt. Poprawka kodu nie
stanowi jeszcze dowodu usunięcia błędu w runtime.

### Job #130 — weryfikacja poprawki w toku — 2026-09-24

Job `def0f8d0da6842389b0bd888c1efac6d`, profil `fem-cpu-slepc-modal-v1`,
korzysta ze snapshotu worktree o HEAD
`479d5c5ca060ca7f8d00705fa96b62e52493bf3c`, source digest
`b6bb86f0604ccd7e9493f4f76221971bdeb344bb07aa94fd5a80be64f4ebd4f1`
i source snapshot SHA
`c987aed77f5178abaefd4d6bae6b586aae07eab086588a7dfcaa6cfcc4c0e126`.
API potwierdza `running`, bez kodu wyjścia. Odczyt procesów workera potwierdził
aktywne `make install-cli-dev` i kompilatory C++ backendu FEM; nie jest to
wyłącznie odczyt starego rekordu kolejki. Brak końcowego receipt i wyniku
rozszerzonego kontraktu.

Następna sekwencja: odebrać ten sam job; zweryfikować receipt/tożsamość
źródeł i dziewięć scenariuszy; wykonać `run-de-smoke JOB k2`; sprawdzić
niepuste częstotliwości, residual i pole z demagiem. Dopiero po tym rozszerzyć
próbkowanie na dwa i pięć punktów oraz przygotować porównanie z analityką.
Żaden zaakceptowany wynik nonzero-k ani kwalifikacja S04/S05/S12 nie wynika
z samego trwającego buildu.

#### Regresja klienta odbioru kontraktu — 2026-09-24

Dodano `test_modal_contract_requires_executed_shared_domain_regression` do
`scripts/test_run_comsol_dispersion_benchmark.py`. Niezależna lista dziewięciu
wymaganych scenariuszy akceptuje kompletny raport; pięć negatywnych wariantów
odrzuca brak metadanych shared-domain, starą listę ośmiu wykonanych targetów,
brak scenariusza w JUnit, skipped test i niezgodny snapshot. Uruchomienie
`python scripts/test_run_comsol_dispersion_benchmark.py`: 16 testów PASS.
To kontrola klienta odbioru raportu, bez kompilowania natywnych testów i bez
awansu kwalifikacji solvera. Test zależy od bieżącego przyrostu profilu oraz
walidatora i należy do tego samego logicznego commita. Snapshot joba #130
pozostaje niezmieniony; dodany test klienta wykonano poza nim.

### Narzędzie porównania DE — parametry z artefaktów, 2026-09-24

Usunięto założenie CLI `compare_de_100nm_pilot.py`, że każdy run ma film
100 nm i dziewięć punktów. Istniejące narzędzie obsługuje teraz de100 oraz
DE-SMOKE k2/two/five. Parametry referencji (grubość, Ms, A, gamma0, B/mu0),
padding i próbkowanie pochodzą z metadanych konkretnego runu. CLI wymaga
zakończonego pilota, zgodności job/source/model między request i result,
wersjonowanego deskryptora, poprawnej orientacji i warunku Dirichleta.
DE-SMOKE dodatkowo przechodzi istniejący preflight sond demagu i wierszy.
Indeksy próbek muszą odpowiadać zadeklarowanym wektorom k.

Wykres prezentuje wszystkie numeryczne mody jako punkty oraz istniejącą
kanoniczną referencję Kalinikosa n=0. Wybór gałęzi pozostaje jawny;
narzędzie nie dobiera najbliższego modu do analityki. Raport zachowuje
`NOT VERIFIED`, parametry z metadanych i hashe CSV oraz metadata.json.
Jednopunktowy wynik k2 jest obsługiwany, lecz nie dowodzi pełnej dyspersji.
Uzupełniono metadane przykładu 100 nm o materiał/pole/próbkowanie/schema;
starsze wyniki bez tych danych są jawnie odrzucane zamiast przyjmowania
stałych ze skryptu.

Weryfikacja: `python scripts/test_compare_de_100nm_pilot.py` — 8 PASS,
w tym rozróżnienie 10/100 nm, odrzucenie brakujących parametrów, obcego
schematu, failed runu, niezgodnej tożsamości i zamienionych próbek oraz
renderowanie PNG/PDF/CSV/JSON dla syntetycznego dwupunktowego fixture.
Fixture służy wyłącznie weryfikacji narzędzia; nie jest wynikiem FEM.
Nie powstał jeszcze wykres rzeczywistej dyspersji. Narzędzie korzysta z
bieżącej rozszerzonej sygnatury `validate_rows`; zmiany muszą być zapisane
wraz z tym zależnym przyrostem. Snapshot aktywnego #130 nie został zmieniony.

#### Zgodność metadanych porównania z modelem Python→IR — 2026-09-24

Lekki odczyt `fem_de_film_100nm_numeric_pilot.py` przez publiczny DSL
potwierdził zgodność metadanych porównania z obniżonym IR: Ms, A, gamma0,
wektor pola, grubość obiektu, wysokość airboxu i rozwinięte dziewięć próbek k.
Kontrolę utrwalono jako
`test_de100_comparison_metadata_matches_lowered_physics` w
`scripts/test_de_smoke_model.py`, z dodatkową zgodnością realizacji demagu.
`python -m pytest scripts/test_de_smoke_model.py -q -p no:cacheprovider`:
4 PASS. To dowód authoringu/metadanych, bez meshowania ani solve'a.
Job #130 po kolejnym bounded wait pozostaje `running`; nie wysłano duplikatu.

### Job #130 — native-build zakończony, kontrakt SLEPc uruchomiony — 2026-09-24

Log zarządzanego joba `def0f8d0da6842389b0bd888c1efac6d` potwierdza
`stage native-build end exit_code=0 duration_ms=2185546.971`
(około 36 min 26 s). Wewnątrz tego etapu kompilacja CLI zakończyła się
po 29 min 16 s, API po 2 min 40 s, a natywny moduł Pythona po 1 min 16 s.
Następnie wystartował `contract-slepc-modal` z receptą
`scripts/run_fem_cpu_slepc_modal_contract.sh slepc-modal`.
To potwierdza kompilację snapshotu, ale jeszcze nie wynik dziewięciu
kontraktów, receipt końcowy ani poprawne obliczenie k2. Stan joba `running`;
nie wysłano kolejnego zadania i nie uruchomiono pilota przed kontraktami.

### Checkpoint 2026-09-24 — job #130 i korekta wdrożenia koordynatora

- Job `def0f8d0da6842389b0bd888c1efac6d` wykonał native-build (exit 0) i wszystkie 9 kontraktów CTest (9/9 PASS), w tym regresję `fem_poisson_airbox_shared_domain_contract` (0,25 s). Nie stanowi to jeszcze wyniku dyspersji.
- Koordynator oznaczył job jako failed przy exit 0: `SLEPc modal receipt does not prove all required CTest targets ran`. Odczyt kodu działającego obrazu `sha256:eed020f1664bde606b20412968681094a885f3e7080679c6d21c90a4160253e4` potwierdził stary zestaw dokładnie 8 testów. Jest to błąd zgodności wdrożenia walidatora z rozszerzonym profilem.
- Niezależna walidacja tylko do odczytu, aktualnym `validate_build_receipt`, zaakceptowała raport oraz hashe 25 artefaktów. Stan kolejki i oryginalne receipty pozostały niezmienione. Brak wspieranej ponownej walidacji terminalnego failed; reconcile obsługuje running/cancel_requested.
- Zbudowano i wdrożono przez standardową wymianę koordynator `sha256:22c6b494f9190995486ab0af084a60128a2167b56212205d695fb998fca486c9`; pauza i brak aktywnych jobów potwierdzone przed wymianą. Nowy kontener `93efc83df86e94e761914203bdcf41002cf0a9e3beca0df7cf5c66893249eee3` ma właściwy zestaw 9 testów. Po wznowieniu worker_alive=true, accepting_jobs=true, worker_error=null.
- Włączono istniejący profil `fem-cpu-slepc-runtime-v1` przez klienta operatorowego, z dotychczasowym obrazem workera `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`, 2 CPU i 8 GiB RAM. Zachowano pozostałe profile. Profil buduje runtime bez testów jednostkowych i bez frontendu; jest zgodny z bieżącym zakazem kompilacji testów. Jego sukces nie zastępuje bramek naukowych.
- Następny krok: osobny managed runtime build, weryfikacja receipt, następnie DE-SMOKE k2 przez istniejącą receptę. Wynik #130 pozostaje failed, a zaakceptowanych numerycznych punktów nonzero-k nadal 0.
- Dług techniczny runnera: dodać wersjonowanie zestawu kontraktów i kontrolę zgodności klient/worker/koordynator przed kosztownym buildem; zaprojektować audytowalną ponowną walidację artefaktów terminalnego joba bez nadpisywania pierwotnego zdarzenia i bez ponownej kompilacji.
- Zgłoszono job #131 `e042f7013fe7401892adf537cd1ee51f`, profil `fem-cpu-slepc-runtime-v1`, snapshot digest `a2a4aa350f029df2f7f7b74b1124a59f899c2fe9e15ca92b0be3a3180564cfb0`; odpowiedź submit: queued. Nie jest to dowód zakończenia buildu.
- Klient starego głównego checkoutu zgłasza `Container profile allow-list mismatch` po włączeniu runtime. Operacje wykonujemy przez aktualny `scripts/local_runner_cli.py` w worktree zadania (dla innych źródeł z jawnym `--worktree`). Do planu korekt dochodzi kompatybilność walidacji listy profili starszych klientów. Nie zmieniono współdzielonego dirty checkoutu.

### Job #131 — rozpoczęta kompilacja runtime

Worker `fullmag-worker-e042f7013fe7401892adf537cd1ee51f` zakończył przygotowanie kapsuły (7413 plików, 304172774 bajty) i uruchomił `stage native-build start command=["/usr/bin/make", "install-cli-dev"]`. Potwierdzono procesy Cargo/CMake i log kompilacji `fullmag-application`. Status nadal running, brak receipt końcowego. Diagnostyka wcześniejszego oczekiwania wykazała aktywne odczyty/zapisy oraz `p9_client_rpc`; nie anulowano ani nie powielono joba. Nadal brak nowego wyniku DE.

### Job #131 — worker zakończony poprawnie, odbiór koordynatora w toku

Kontener `b24d01387bd0b4aaa5f4c1d674b12e698c5a8ccbe72b52f8fd4123fdfec76014` zakończył się 2026-09-24T21:34:02.974Z z ExitCode=0 i OOMKilled=false. Workerowy build-receipt.json: state=succeeded, runtime_only=true, error=null, 14 artefaktów. CLI: 29m01s; API: 7m38s; końcowy etap modułu Pythona: 2m44s. Kolejka podczas kontroli nadal running: odbiór koordynatora nie jest jeszcze potwierdzony. Nie uruchomiono pilota przed zakończeniem tej bramki.

### Job #131 zaakceptowany; rzeczywisty pilot k2 — brak zbieżnych modów

Koordynator zakończył #131 statusem succeeded, exit 0. Dry-run pilota przeszedł. Uruchomiono `just run-de-smoke e042f7013fe7401892adf537cd1ee51f k2`; run `8d74a094a36843f791e8c7aa0f9a33ee` zakończył się failed, exit 1. Snapshot źródeł: `effaedea87d40737b9a19c73b236980b6f0c5d018fc0e6095e7712b63f1e46a6`; model SHA256 `4f2782b4d692af9a8033c18a613985094da94ded9e627a63599f9d5ef74f475f`.

Relaksacja przeszła (stop torque, 3 kroki). Siatka: 1980 węzłów, 5720 elementów. Solver przyjął `floquet_shared_domain_sparse_matshell`, 100 tangent DOF; wcześniejszy `floquet_shared_domain_demag_probe_shape_mismatch` nie wystąpił. Oba podokna wykonały 100 outer_iterations, ale converged candidates=0, accepted modes=0, unsupported_reason=no_positive_frequency_eigenpair. EPS używa absolute_true_residual i tolerancji 1e-10; operator_normalization_scale=7.9529629105481888e16. Nie jest to częstotliwość ani zwalidowana dyspersja.

Następny krok: odczytać i raportować EPSConvergedReason (obecny kod odczytuje tylko iteracje i liczbę zbieżnych par), odróżnić wyczerpanie iteracji od braku dodatniego widma; zbadać kryterium zbieżności znormalizowanego uogólnionego pencila i rozwiązywanie shift-invert. Nie osłabiać fizycznych residuali ani zastępować rozwiązania analityką. Zwiększenie limitu samo w sobie nie dowodzi naprawy. Runtime log i wynik zachowane pod storage/runs/<worktree-id>/<job-id>/comsol-dispersion/8d74a094a36843f791e8c7aa0f9a33ee.

### Diagnostyka EPS po nieudanym k2 z #131

Dodano odczyt EPSGetConvergedReason i nullable eps_converged_reason w diagnostyce podokien. Przy zerowej liczbie zbieżnych par ujemny reason odróżnia limit iteracji od braku dodatniego widma. Monitor EPS przechowuje wyłącznie ostatnią iterację i błąd pierwszego niezbieżnego przybliżenia (null przy braku estymaty); nie publikuje go jako częstotliwości ani zaakceptowanego residualu. Regresję istniejącego fixture uzupełniono o przyczynę zbieżności i numer iteracji monitora. Diff check PASS; kompilacja i runtime nowych zmian NOT VERIFIED. Testów jednostkowych nie kompilowano zgodnie z zakazem.

W chwili tego checkpointu nowy runtime build nie był zgłoszony: około 8,19 GiB wolnego przy progu 8 GiB. Dalsze usuwanie wymagało zgody; obecny checkpoint poniżej odnotowuje zakres później zatwierdzony.

### Checkpoint 2026-09-25 — cleanup i diagnostyczny runtime #132

Za zgodą użytkownika usunięto tylko katalogi `execution` jobów #130 (`def0f8d0da6842389b0bd888c1efac6d`) i #131 (`e042f7013fe7401892adf537cd1ee51f`). Potwierdzono brak aktywnych jobów i procesów workerów. Pozostały katalogi `artifacts`, `trusted`, receipty, logi oraz cały wynik pilota; nie usuwano cache ani kapsuł źródeł. Wolne miejsce wzrosło do około 9,3 GB.

Zgłoszono do wspólnej kolejki job #132 `60a2a77007e7462aa10bba1d6732588f`, profil `fem-cpu-slepc-runtime-v1`, request key `de-eps-monitor-20260924-cleanup130131`, source digest `1cdf6838edf696afd0fd4d7d2ac6b9a3f657bf2275e24af0d995fc4152760b4c`. Worker wystartował, skopiował i zweryfikował kapsułę, po czym rozpoczął etap `native-build`; job pozostaje `running`. Aktywne testy jednostkowe nie są częścią tego runtime-only profilu. Po sukcesie wymagane są receipt i kontrola artefaktów, następnie dry-run oraz nowy rzeczywisty run `de-smoke-k2`. Do tego czasu nie ma zaakceptowanego punktu dyspersji k≠0.

### Checkpoint 2026-09-25 — stagnacja EPS i korekta progu wstępnego

- Potwierdzono job #132 jako zaakceptowany runtime-only build (exit 0, 14 artefaktów); modelowa próba `--model-ref` przeszła dry-run i użyła pliku z commita `7a8b57cf1ca6b64902cdee60945cebdda9e2bd4c` (SHA-256 `b954b934e20abbc85db3d59a52228ecae303ec0c07652b2946022c340ebc2ee4`).
- Pilot `ca448b26d8934e849c8bb50460e92612` zakończył się failed po 37 s; run container potwierdzono jako usunięty. Żadna częstość nie została opublikowana.
- Model żądał `include_demag=true`, $\mathbf k=(0,2\times10^6,0)$ rad/m; solver osiągnął `floquet_shared_domain_sparse_matshell`, 1195 par periodycznych i dwa zadane podokna. Oba wykorzystały limit 500 iteracji, `EPS_DIVERGED_ITS=-1`, 0 zbieżnych modów i brak ewaluacji residualu oryginalnych bloków.
- Estymaty EPS (`3.4957520e-9`, `6.0189714e-9`) były identyczne jak w próbie 100-iteracyjnej, mniejsze niż żądany residual `1e-8`, lecz większe niż wewnętrzny próg `1e-10`. To wskazuje na nadmiernie ostrą bramkę konwergencji EPS; nie dowodzi, że kandydat spełni niezależną bramkę magnetyczną/potencjałową.
- Źródła są zmieniane tak, by wewnętrzny próg EPS wynosił $\max(100\epsilon_{\mathrm{machine}},\mathrm{rtol}_{\mathrm{requested}})$. Akceptacja nadal wymaga oryginalnych residuali obu bloków ≤ żądane rtol. Wymagany następny krok: runtime-only build z tą zmianą, odbiór receipt, dry-run, a następnie rzeczywisty pilot k2; jeśli przejdzie filtr EPS, ocenić częstotliwość, oba residuale, fazę, demag i pola.
- Nie ma jeszcze punktu nonzero-k ani wykresu. Analiza z teorią Kalinikosa/Slavin pozostaje oczekująca. Wolne miejsce 48 973 856 768 B; nie usuwano nowych danych.

### Checkpoint 2026-09-25 — runtime #133 i korekta kryterium EPS

- Managed job #133 (`059f9538791346289316580c94ce4a36`) zakończył runtime-only build `fem-cpu-slepc-runtime-v1` sukcesem, exit 0, 14 artefaktów. Source digest: `9c1312cad6b253fa0345e601de42d2fc2b11aeda0e497e934770a8bbb2714f6d`; snapshot SHA: `11a754ab43488ba74a9684b4c9dddea72239089604c0787108647f7d9535ac1a`; CPU FEM/SLEPc dostępne, GPU niewłączone.
- Pilot `f45f34706cf24e35ad57612b2309bcdf` dla modelu z commita `7a8b57cf1ca6b64902cdee60945cebdda9e2bd4c` nie przyjął modów. Kontrolny pilot `f683308e79b449e7a2db987253ae9535` użył modelu z commita `673dc10b2704a0e12e193f145a86b33ae53ca13e`, zwiększającego limit iteracji z 500 do 2000 bez zmiany żądanego residualu fizycznego `1e-8`; również zakończył się `failed`, exit 1, 0 zaakceptowanych modów.
- Oba przebiegi dotarły do FEM CPU/SLEPc, dynamicznego demagu Floqueta dla `k=(0,2e6,0) rad/m`, 1195 par periodycznych i 100 stopni swobody stycznej. Kontrolny run wykonał 2000 iteracji w podoknie, lecz EPS zgłosił `EPS_DIVERGED_ITS`; dwa kandydaty około `9.7233363 GHz` pozostały niezaakceptowane. EPS absolute true residual wyniósł `3.4957520e-9`, residual magnetyczny oryginalnego bloku `2.1678405e-7` (> `1e-8`), a potencjałowy `1.4175e-14`. Większy limit iteracji sam w sobie nie poprawił wyniku.
- Przyczyną do dalszej weryfikacji jest zbyt luźne absolutne kryterium EPS po globalnym skalowaniu pencila względem per-modowego residualu oryginalnych bloków. Zmieniono wewnętrzny EPS cutoff na `max(100*machine_epsilon, 1e-3*requested_rtol)`; fizyczna bramka `1e-8` nie została zmieniona. Regresja źródłowa i nota naukowa są zaktualizowane, ale ta poprawka czeka na managed build i kolejny pilot.
- Artefakty obu przebiegów zachowano pod `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/059f9538791346289316580c94ce4a36/comsol-dispersion/`. Nie ma zaakceptowanego punktu `k != 0`, poprawnego wiersza CSV ani wykresu dyspersji. Następny krok: zarejestrować jeden snapshot po kontroli zdrowia kolejki, odebrać build/receipt, wykonać dry-run i powtórzyć `k2`; nie rozszerzać jeszcze do pięciu punktów.

### Job #134 — build poprawki kryterium EPS przyjęty do kolejki

Managed runner przyjął snapshot `8a7b9ff2e8c91609a925055d31ee51ae3c3135090bef40873c40c3336c6ecd5f` jako job #134 (`f29dad61e46048ff934ada17e75cde53`), stan `queued`, profil `fem-cpu-slepc-runtime-v1`. Source digest: `d90df5fb5da8eb13cd15326c1b44b527cd54dbd571645ca1ab636ffeab7e84a0`; capture `68ff64ee5c724ac8b040656659d28400`; bazowy HEAD `673dc10b2704a0e12e193f145a86b33ae53ca13e`. Runner przed capture potwierdził `worker_alive=true`, `accepting_jobs=true`, `active_jobs=[]`, brak błędów i około 47 GB wolnego storage. Kapsuła zawiera bieżącą zmianę EPS, regresję źródłową i aktualizacje dokumentacji. Job nie ma jeszcze końcowego receipt; po `succeeded` trzeba zweryfikować hashe, wykonać dry-run modelu, a następnie jeden pilot k2. Nie zgłaszać równoległego buildu.

### Job #134 — rozpoczęty managed native-build (2026-09-25)

Koordynator zalogował `job_claimed` dla #134 o 01:40:48 UTC; worker-container pozostał aktywny. Przygotowanie kapsuły obejmowało 7413 plików i 304198252 B, z kopiowaniem oraz ponowną weryfikacją hashy per plik. Około 01:53 UTC pojawił się log `native-build`, proces `make install-cli-dev` i proces Cargo. Job pozostaje `running`; brak końcowego receipt i brak pilota k2. Nie wysyłać duplikatu; po terminalnym stanie odbierz receipt i zweryfikuj tożsamość artefaktów, a dopiero potem dry-run i pilot.


### Uzupełnienie checkpointu — job #134, runtime #135 i pilot k2 (2026-09-25)

- Job #134 zakończył się sukcesem: `f29dad61e46048ff934ada17e75cde53`, exit 0, profil `fem-cpu-slepc-runtime-v1`. Poprzednia sekcja „rozpoczęty managed native-build” jest historyczna; końcowy status #134 to `succeeded`.
- Z runtime #134 wykonano piloty `de-smoke-k2` (`2959f883fa954f09ab9885c6b400ebf4`, `3c7bb4a6dac14a1386957de91907431b`) na k=(0, 2e6, 0) rad/m. EPS nie zwrócił zbieżnych modów, więc nie ma zaakceptowanej częstości ani wiersza dyspersji. Korekta identyfikatora: wcześniej przypisany tutaj `ca448b26d8934e849c8bb50460e92612` pochodzi z #132.
- Na podstawie tamtej awarii dodano diagnostykę rzeczywistego KSP shift-invert. Job #135 `a31670fd5df145479a2054fd4c02e23c` zakończył managed runtime build sukcesem (exit 0), profile `fem-cpu-slepc-runtime-v1`; source digest `7d9c4a5dac4e5c0f9615549fbfef5f471cea24ed66777284d66d4ef868a491ff`, snapshot SHA `5f06161c8a196cbf4070afac5c1f501289c1296c7da632146172f0f066749516`, obraz `sha256:e5f70bd632011f9a0d8163430dab81bc6f248e07e4af086dfdf77bcd087471d7`. Koordynator zweryfikował receipt, manifest zawiera 14 artefaktów, `validation_error=null`; CPU FEM/SLEPc jest dostępne, GPU nie jest włączone.
- Dry-run przyjął ten dokładny runtime oraz model `examples/fem_de_smoke_numeric.py` z commita `4e7ab1528d008ed487c1ed2789f976ba6c8bf3af`, SHA-256 `36684fb6eeaabdaf579f76a880d715232ff9d9a83e3c1bfcd1015662a558a98d2`. Rzeczywisty przebieg zapisał się pod `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/a31670fd5df145479a2054fd4c02e23c/comsol-dispersion/4d5d2c97987447a09721477d52740dec/`; kontener został potwierdzony jako usunięty przez watchdog.
- Model użył `include_demag=true`, `k=(0, 2e6, 0) rad/m`, jednego żądanego modu i siatki shared-domain z 5720 tetraedrami, 1980 węzłami i 1195 parami periodycznymi. Solver użył `floquet_shared_domain_sparse_matshell` i dwóch podokien częstotliwości.
- W obu podoknach EPS wykonał 2000 iteracji i zwrócił `EPS_DIVERGED_ITS`; estymaty true residual wyniosły odpowiednio `3.4957520169599251e-9` i `6.0189714412340221e-9`, przy wewnętrznym progu `1e-11`. Nie było zbieżnych kandydatów, dlatego nie obliczono residuali fizycznych modów. Nie jest to wynik `f(k)`.
- Nowa telemetria pokazuje, że ostatnie solve'y KSP zakończyły się kodem `KSP_CONVERGED_RTOL` (reason 2), po 15 i 13 iteracjach, z raportowanymi normami `1.3217272668620667e-24` i `1.5471221846117597e-23`; suma iteracji liniowych na okno to 321674 i 288664. Korekta interpretacji: jest to zbieżność według wewnętrznej normy KSP, która może być przybliżona i preconditioned. Bez niezależnego względnego `b-Ax` nie wyklucza błędu shift-invert, także w ostatnim solve'ie.
- Oddzielny wcześniejszy przebieg #133 z luźniejszym progiem EPS znalazł kandydata około 9.7233363 GHz, ale jego residual magnetyczny wynosił `2.1678405e-7`, powyżej żądanych `1e-8`; sparowany residual potencjału wynosił `1.2442e-14` (maksimum wśród kandydatów: `1.4175e-14`). Kandydat został odrzucony zgodnie z zadanym kontraktem. Audyt tolerancji poniżej koryguje wcześniejszy bezwzględny zakaz zmiany progu i pokazywania częstości: dopuszczalna jest jawna kalibracja oraz wykres diagnostyczny z widocznym statusem odrzucenia; nie wolno przedstawiać go jako zaliczonego benchmarku.
- Diagnoza robocza: plateau EPS pozostaje nierozstrzygnięte. Kolejna zmiana powinna ujawnić rzeczywisty wymiar podprzestrzeni Krylov–Schur i przetestować jego kontrolowane zwiększenie dla małego modelu, pozostawiając `EPSSetTrueResidual` oraz oba oryginalne fizyczne gate'y bez zmian. To hipoteza do sprawdzenia, nie potwierdzona przyczyna.
- Status naukowy i produktu pozostaje: zaakceptowane punkty k!=0 — 0; poprawny wiersz CSV — 0; wykres rzeczywistej dyspersji — brak; porównanie z analityką — NOT VERIFIED. Runner zakończył build i pilot; następny krok to poprawa zbieżności EPS i powtórzenie pojedynczego k2 przed rozszerzeniem do kilku punktów.

Do weryfikacji metody iteracyjnej użyto aktualnej dokumentacji SLEPc: [EPS manual](https://slepc.upv.es/release/documentation/manual/eps.html), [EPSSetDimensions](https://slepc.upv.es/release/manualpages/EPS/EPSSetDimensions.html) i [EPSSetTrueResidual](https://slepc.upv.es/release/manualpages/EPS/EPSSetTrueResidual.html). Kod 2 KSP oznacza `KSP_CONVERGED_RTOL` według [PETSc KSPConvergedReason](https://petsc.org/release/manualpages/KSP/KSPConvergedReason/).

### Job #136 — kontrolowana próba większego `ncv` (2026-09-25)

- Po #135 ustalono, że ostatni solve KSP converged, a EPS zatrzymał się po 2000 iteracjach z residualem true około $3.50\times10^{-9}$ wobec wewnętrznego cutoffu $10^{-11}$. Nie było zbieżnych Ritz par, więc bieżący solve nie podał residualu fizycznego moda.
- Zmieniono rozmiar podprzestrzeni dla Floquet EPS: `ncv=min(N,max(32,2*nev))`, gdzie $N$ to wymiar real-split. Próg EPS i oryginalne bramki magnetyczna/potencjałowa pozostały bez zmian. Dodano serializację wymiarów z `EPSGetDimensions` i regresję źródłową; testów jednostkowych nie kompilowano. Walidator scientific docs, tekstowa regresja kontraktu dokumentacji, JSON source-map i `git diff --check` zakończyły się powodzeniem.
- Runner przyjął job #136 `b1e00ef90b494fa08801036bd4d4f17a`, profil `fem-cpu-slepc-runtime-v1`, stan `running`; HEAD worktree `4e7ab1528d008ed487c1ed2789f976ba6c8bf3af`, source digest `1b7ee7adbeb2b83260277eb5285d7f2460b633ff5c7c74440d84d7173704f96b`, snapshot SHA `c26f2f6f2890cde8955398e91e9d4e50542d31a1d63a152965c67eea4ccf344c`, capture `f26b01f74dcd4d9ba49769873bb6b54b`. Receipt nie jest jeszcze dostępny.
- Po terminalnym sukcesie zweryfikować receipt i hashe, wykonać dry-run modelu, a następnie pojedynczy `de-smoke-k2`. Rozstrzygnięcie wymaga rzeczywistych `nev/ncv`, reason/iteracji EPS i KSP, częstotliwości oraz obu fizycznych residuali. Nie liczyć jeszcze innych punktów $k$ ani nie publikować wykresu.

### Wynik joba #136 i rzeczywistego pilota k2 — 2026-09-25

- Managed job #136 (b1e00ef90b494fa08801036bd4d4f17a) zakończył się succeeded, exit 0, profil fem-cpu-slepc-runtime-v1; receipt potwierdza digest źródeł 1b7ee7adbeb2b83260277eb5285d7f2460b633ff5c7c74440d84d7173704f96b, snapshot SHA c26f2f6f2890cde8955398e91e9d4e50542d31a1d63a152965c67eea4ccf344c, SLEPc CPU/double oraz 14 artefaktów buildu. Sukces buildu nie oznacza wyniku naukowego.
- Dry-run przeszedł, po czym rzeczywisty de-smoke-k2 (8cbc020e2e594c39ac77e192d7067b68) zakończył się failed, kod 1, qualification=NOT VERIFIED. Nie wyemitowano częstotliwości ani artefaktów dyspersji.
- Model żąda include_demag=true dla dynamicznego operatora Floqueta z magnetostatic_bc="floquet_airbox" i k=(0,2e6,0) rad/m. demag_mode=none w logu dotyczy tylko relaksacji równowagi LLG; nie oznacza wyłączenia dynamicznego demagu w modalnym operatorze.
- Siatka miała 1980 węzłów, 5720 tetraedrów, 1195 par periodycznych i 100 zespolonych tangent DOF, czyli 200 w reprezentacji real-split EPS. Dwa okna EPS zakończyły się po 2000 iteracjach każde z EPS_DIVERGED_ITS; nev=8, ncv=32, mpd=32, estymaty końcowe true residualu 3.4957520204820899e-9 i 6.0189714339300876e-9 przy wewnętrznym progu 1e-11. W obu oknach liczba zbieżnych kandydatów wyniosła zero, więc nie obliczono residuali fizycznych moda.
- Ostatnie układy shift-invert KSP zgłosiły KSP_CONVERGED_RTOL (reason 2): 15 i 13 iteracji, raportowane normy odpowiednio 9.291867865464143e-25 i 5.1041410667766433e-24; łączne iteracje KSP na okno wyniosły 474071 i 416220. Są to normy wewnętrzne KSP, a nie niezależnie policzone względne residuale oryginalnego równania; nie wykluczają problemu shift-invert.
- Kontrolowana próba ncv=32 nie usunęła problemu. Nie powtarzać jej bez zmiany hipotezy; następny krok to osobno sprawdzić zachowanie exact Floquet Schur operatora i preconditionera shift-invert oraz poprawić diagnostykę przebiegu błędu EPS. Nie luzować fizycznych bramek residualu.
- Dla fixture'u 10 nm poprawne otwarte-filmowe analityczne wartości referencyjne to: k=0 9.309814 GHz, ky=1e6 9.520135 GHz, ky=2e6 9.725724 GHz, ky=3e6 9.926925 GHz, ky=5e6 10.317376 GHz. Szacunek Gamma dla skończonego airboxu 2 µm wynosi 9.299250 GHz. Są to wartości analityczne, a nie wyniki Fullmaga.
- Status: 0 zaakceptowanych punktów k!=0, 0 poprawnych wierszy CSV, brak wykresu numerycznej dyspersji, porównanie FEM–analityka NOT VERIFIED. Nie przechodzić jeszcze do pięciu punktów ani pełnego C1.

### Audyt progu residualu i korekta dalszego planu — 2026-09-25

Wykonano [audyt tolerancji](../../audits/2026-09-25-de-residual-threshold-audit.md) z [odczytem ośmiu historycznych pilotów](../../audits/2026-09-25-de-residual-threshold-evidence.json) oraz niezależnym przeglądem matematyki i konfiguracji EPS/KSP. Ta aktualizacja zastępuje wcześniejszy bezwzględny nakaz utrzymywania `1e-8` niezależnie od wymaganej dokładności częstotliwości.

`1e-8` jest żądaną tolerancją algebraiczną, której optymalności i osiągalności w tej realizacji jeszcze nie wykazano. Mnożnik EPS `1e-3` jest heurystyką. Plateau nie dowodzi granicy double, a reason 2 i małe `KSPGetResidualNorm` nie dowodzą dokładności oryginalnego układu liniowego. Odrzucony kandydat #133 różni się od faktycznej referencji `n=0` dla 10 nm o −2.388011 MHz (−0.0245536%); to zachęcająca obserwacja, bez oceny osobno błędu algebraicznego, siatki, airboxu i przybliżenia referencji.

Aktualny priorytet T3/T5:

1. **C1 — pomiar błędu:** true residual shift-invert, resolved strona/norma KSP, normy RHS/bloków, pełna zespolona wartość własna i wpływ projekcji. Stan: zaplanowane, niezrealizowane.
2. **C2 — mała referencja bezpośrednia:** oryginalny Schur z demagiem i `B` z tej samej siatki; zgodność działania MatShell i niezależne rozwiązanie małego problemu, bez badanego shift-invert. Stan: zaplanowane, niezrealizowane.
3. **C3 — kalibracja:** osobno kryterium kandydatów EPS, oryginalne tolerancje `1e-6/1e-7/1e-8` i dokładność wewnętrznych solve'ów. Porównać częstotliwość, profil, koszt i różnicę do C2; nie dobierać progu pod analitykę. Stan: zaplanowane, niezrealizowane.
4. **C4 — kilka punktów:** po C1–C3 policzyć 3–5 k i wykres z jawnym statusem jakości. Kandydatów diagnostycznych nie oznaczać jako zaakceptowanych. Stan: oczekuje na kalibrację.
5. **C5 — walidacja fizyczna:** siatka, airbox, profile, kompletność oraz właściwe przybliżenie analityczne. Stan: oczekuje na wyniki.

W tej aktualizacji poprawiono dokumentację i plan, nie kod solvera ani historyczne statusy. Nie zlecono następnego buildu ani kompilacji testów. Nadal 0 zaakceptowanych punktów przy `1e-8`; nie ma jednak podstaw, by twierdzić, że kandydat z residualem około `2e-7` jest z definicji bezużyteczny do wykresu roboczego.

Walidator noty 0831 przeszedł. Kontrola tekstowa kontraktów dokumentacji: 9/10 poprawnych; otwarte pozostaje dopasowanie `test_modal_dispersion_artifact_contract_names_tracking_and_mode_handoff` do wcześniejszej zmiany nagłówka CSV (`sample_id`, `mode_id`, `mode_field_available`). To zaległość zakresu artefaktów, oddzielna od kalibracji T3; nie zmieniono jej w tym audycie.

### Wdrożenie diagnostyki C1 i job #137 — 2026-09-25

- Dodano niezależne obliczenie `||b−A_shift x||₂ / ||b||₂` dla **ostatniego** solve'a KSP oraz odczyt resolved preconditioning side i norm type. `KSPGetResidualNorm` pozostaje osobną liczbą z PETSc. Dla najgorszego ocenionego kandydata dodano residual z pełną zespoloną wartością własną przed projekcją, jej pominiętą część urojoną w obróconym układzie i normę projekcji modu. Brak danych zapisuje się jako niedostępny/`null`.
- C1 jest częściowe: nie ma jeszcze maksimum true residualu po wszystkich działaniach shift-invert, norm osobnych bloków ani eksportu odrzuconych wektorów. Bramka akceptacji i `1e-8` pozostały bez zmian. Test natywny uzupełniono w źródle, ale nie kompilowano go zgodnie z zakazem. Walidator dokumentacji naukowej przeszedł.
- Współdzielony runner był bez aktywnych jobów. Po pauzie zbudowano i włączono obraz koordynatora `sha256:22c6b494f9190995486ab0af084a60128a2167b56212205d695fb998fca486c9`, skonfigurowano profil `fem-cpu-slepc-runtime-v1` na istniejącym obrazie workera i wznowiono kolejkę; kontrola health wykazała `worker_alive=true`, `accepting_jobs=true`. Ten profil buduje runtime FEM CPU/SLEPc bez celów testowych.
- Zgłoszono snapshot job #137 `454a9276184546ec8b64e4dabd681727`, source digest `dff926e497801da6c77b61ba467a47ae9f0be6c45210f2d62afca5c2d5621430`, source snapshot SHA `148eb4317aa7ec450d31ffdf19b9f5d771c22636facbb357409ddfdff4d22df7`. Stan przy wpisie: `running`, bez receipt; build i pilot pozostają **NOT VERIFIED**.
- Naprawiono zaległy test nagłówka CSV artefaktów (`sample_id`, `mode_id`, `mode_field_available`); `python -B -m pytest -q scripts/test_frequency_domain_math_contract_docs.py` zakończył się `10 passed`. To kontrola dokumentacji, nie dowód solvera.
- C2 doprecyzowano jako bounded dense oracle oryginalnego Schura `(Aqq−Aqphi P⁻¹ Aphiq, Bqq)` w wymiarze 200×200 dla pilota, z osobnym Poisson LU, porównaniem z MatShell i `EPSLAPACK`/zerowym `STSHIFT` bez shift-invert. Implementacja oraz uruchomienie C2 nadal są otwarte.

Późniejszy checkpoint: kod diagnostyki C2 jest już dodany za prywatnym opt-in
`FULLMAG_FLOQUET_DENSE_ORACLE=1`, z limitem 512 real-split DOF i oddzielnym
JSON. Pilot `de-smoke-k2` otrzymał jawny przełącznik `--dense-oracle`; jego
interpreted regression zakończył się `6 passed`. Po przeglądzie dodano filtr
zaniedbywalnej fizycznej rekonstrukcji modu, usunięto własny próg EPS `1e-12`
i sprawdzono resolved zerowy `STSHIFT`. Walidator noty naukowej i diff check przeszły.
**C2 nie jest w snapshotcie #137**; kompilacja i numeryczne porównanie C2
pozostają `NOT VERIFIED` do osobnego managed builda i pilota.

### Checkpoint 2026-09-25 — pilot #137 i korekta czasu życia wektorów

- Build #137 `454a9276184546ec8b64e4dabd681727` zakończył się `succeeded`, exit 0. Jego pilot `de-smoke-k2` `7327c19e1f4b422fa7ad59eb840c9585` zakończył się PETSc `SIGSEGV` (kod 59), bez wyniku modu. Valgrind na diagnostycznej kopii modelu z jedną iteracją EPS zlokalizował nieprawidłowy odczyt w `MatMult` nowego pomiaru C1 po `EPSSolve`: pożyczone RHS/solution KSP nie były już ważne.
- C1 poprawiono źródłowo przez kopię ostatnich RHS/solution w callbacku `KSPSetPostSolve`. Nie zmieniano fizyki, progu akceptacji ani EPS/KSP tolerancji. Trzeba potwierdzić w managed runtime, że pilot nie ulega awarii i zapisuje rzeczywisty residual.
- Job #138 `289819783c8e4a2bb39920a9a7cedf25` został zablokowany przed wykonaniem, gdy działał diagnostyczny kontener Valgrind; nie jest dowodem C2. Po jego zakończeniu zgłoszono #139 `4c768fc34f814983b811c45e28dc7550` ze wspólnym snapshotem poprawki C1 i diagnostyki C2. Stan przy wpisie: `running`, bez receipt i bez kwalifikacji fizycznej.
- Oddzielna obserwacja Valgrind: podczas inicjalizacji Poissona/MFEM występują zapisy poza przydzielony obiekt `mfem::SparseMatrix`. To otwarta kontrola zgodności ABI nagłówków/biblioteki obrazu. Nie ma podstaw, by na jej podstawie uznać punkt dyspersji za obliczony.

Przed uznaniem wyniku C4/C5 należy zamknąć nową bramkę ABI MFEM: ustalić
definicje kompilacyjne i rozmiar `SparseMatrix` w samej bibliotece obrazu,
zapewnić zgodność z klientem Fullmag, przebudować obraz i powtórzyć mały
diagnostyczny przebieg pamięciowy oraz pilot. Samo przejście #139 nie zamknie
tej bramki, ponieważ używa tego samego obrazu zależności.

Źródłowo przygotowano też C3: DE-SMOKE może jawnie przyjąć tylko
`1e-8`, `1e-7` lub `1e-6` przez `FULLMAG_DE_SMOKE_SOLVER_RTOL`, a pilot
`de-smoke-k2` zapisuje wybór z `--solver-rtol` w żądaniu i w metadanych IR.
Domyślnie nadal używa `1e-8`. Dziesięć interpretowanych testów wejścia przeszło.
Ta zmiana powstała **po** snapshotcie #139 i wymaga następnego managed builda;
same testy wejścia nie kalibrują tolerancji ani nie dostarczają częstotliwości.
To na razie **wspólny sweep żądanego `solver_rtol`**: obecna implementacja
wyprowadza z niego także próg EPS i wewnętrzne `KSP rtol`. Do rozdzielenia
trzech przyczyn stagnacji C3 nadal potrzebuje jawnych, niezależnych ustawień
diagnostycznych albo serii kontrolnej o stałym KSP/EPS oraz porównania z C2.

Build #139 zakończył się `failed`, exit 2: kompilator odrzucił `STNONE` w C2,
ponieważ SLEPc 3.24.3 nie udostępnia takiej stałej. To błąd źródłowy oracle,
bez uruchomienia fizyki. Poprawiono konfigurację na jawny `STSHIFT` z
przesunięciem zero i odczytem resolved typu/przesunięcia; zgodnie z manualem
SLEPc jest to domyślna transformacja bez shift-invert. Nowy build i pilot
pozostają wymagane.

Zgłoszono managed runtime job #140 `3243430c4f5341fab4a138d92703b4b7`,
profil `fem-cpu-slepc-runtime-v1`, source digest
`bd0b53df79fc64c04418c32983a3410ba859c22061221650796ed7bc5465d0ab`,
snapshot SHA
`2f66acdc713753c7cd0ef4baed4e9f07462451ab1581198527ee3b93e46b0b67`.
Stan przy wpisie: `running`; receipt, pilot C1/C2 i punkty dyspersji nadal
**NOT VERIFIED**.

Proponowana ścieżka naprawy ABI przed kwalifikacją fizyczną:

1. Ustalić rozmiar/definicje `SparseMatrix` w bibliotece i u klienta z tego samego obrazu oraz potwierdzić wykryty zapis poza obiekt na minimalnym managed CPU przypadku.
2. Dla trasy FEM CPU/SLEPc przygotować spójny wariant MFEM bez CUDA w osobnym prefiksie obrazu (bez zmiany GPU lane), jawnie wskazać ten prefiks w nowym profilu builda i w runtime. Obecne `build.rs` włącza CUDA przy każdym `FULLMAG_USE_MFEM_STACK=ON`, więc wymaga osobnego, źródłowo zweryfikowanego przełącznika CPU native.
3. Zweryfikować soname i rzeczywistą ścieżkę ładowanej biblioteki, powtórzyć kontrolę pamięci oraz C0 i `k2` na nowym receipcie. Dopiero ten wynik może wejść do bramki C4/C5. To plan techniczny, nie wykonana naprawa obrazu.

Po snapshocie #140 dodano osobne, prywatne przełączniki C3 dla EPS absolute
prefilter i shift-invert KSP `rtol`, ograniczone do diagnostycznego pilota
`de-smoke-k2`. Pozwalają utrzymać fizyczny `solver_rtol=1e-8`, zmieniając
jedną tolerancję algebraiczną naraz; wartości żądane trafiają do run-request,
a resolved liczby do diagnostyki solvera. Kod nie był w #140, wymaga
następnego managed builda i porównania z oracle C2 przed jakimkolwiek wnioskiem
o akceptacji częstotliwości.

Przygotowano źródłowo profil `fem-cpu-slepc-runtime-v2` dla naprawy ABI:
osobny MFEM CPU w obrazie, przełącznik natywnej kompilacji bez CUDA i
post-build attestacja ścieżki CMake oraz załadowanego `libmfem.so`. Profil v1
pozostaje bez zmian. Testy interpretowane profilu przeszły, lecz obraz v2 nie
został jeszcze zbudowany ani przypięty do koordynatora; nie ma managed receiptu,
Valgrind pass ani pilota v2. Kod pilota v2 odczytuje digest obrazu z
operatorowego katalogu runnera i sprawdza go względem receiptu oraz kontenera;
bez przypiętego obrazu kończy się błędem. Trwa #140 na starym obrazie, więc nie
uruchamiano równoległego ciężkiego buildu.

Po ponownym przeglądzie callbacku C1 zabezpieczono również czas życia macierzy
przesuniętej: snapshot utrzymuje własną referencję PETSc do `Mat` aż do pomiaru
residualu i zwalnia ją podczas cleanup. #140 zawiera kopię wektorów, ale nie tę
późniejszą poprawkę własności macierzy; wymaga ona kompilacji w następnym jobie.

#140 `3243430c4f5341fab4a138d92703b4b7` zakończył się `failed`, exit 2,
przed wydaniem binarium: C++ odrzucił konkatenację dwóch literałów tekstowych
w `production_cpu_modal_eigen.cpp:152` przy serializacji diagnostyki oracle.
Poprawiono początek wyrażenia na `std::string`; log nie wykazał innego błędu
kompilacji. Nowy managed job #141 `13d5788e1fab4cfdb3d13d13843eb611`
zgłoszono na profilu v1 ze source digest
`cc9d56011e6b81128f8ff98a84961c672adc12c363f55e54352bd5eadb069258`
i snapshot SHA
`6c9712f1453c1c80fba2a2422c69989ebec1adc2ae50d6d5fec3bc553f70bbea`.
Stan przy wpisie: queued; C1/C2/C3 oraz dyspersja nadal **NOT VERIFIED**.

### Checkpoint 2026-09-25 — #141, pierwszy punkt diagnostyczny nonzero-k

Managed build #141 zakończył się `succeeded`, exit 0; receipt i attestacje
źródła, SLEPc oraz biblioteki natywnej przeszły. Pilot `de-smoke-k2`
`5751554e315e4b308bbbe40a696a8369` zakończył się błędem: po 2000
iteracjach w każdej z dwóch części okna SLEPc nie zwrócił zaakceptowanego
modu. Rzeczywisty względny residual ostatniego przesuniętego KSP wynosił
około `5.10e-7` / `3.11e-7`, choć normy konfigurowane PETSc były rzędu
`1e-24`. Zatem zwykła ścieżka iteracyjna nadal **nie** publikuje punktu
dyspersji.

Osobny pilot diagnostyczny C2 `8fc0e111aea349918e1a21025bb1aa46`
na tym samym buildzie również zakończył się błędem zwykłego solvera, lecz
bounded dense oracle oryginalnego Schura przeszedł własne kontrole:
`k_y=2e6 rad/m`, `f_FEM=9.723336314058123 GHz`, residual magnetyczny
`1.6761e-14`, residual potencjału `1.3141e-14`, błąd zgodności akcji
z MatShell `4.1471e-16`. Referencja analityczna n=0 dla parametrów modelu
wynosi `9.725724281195415 GHz`, różnica względna `-2.45531e-4`. To
**jeden punkt numeryczny o małym residualu w diagnostycznej ścieżce C2**,
nie ukończona dyspersja ani kwalifikacja naukowa. W katalogu pilota zapisano
`diagnostic-scatter/dispersion-one-point-diagnostic.png` i JSON z pochodzeniem
danych. Zapis `metadata.json` i standardowej tabeli modów nie powstał,
ponieważ zwykła ścieżka zwróciła błąd.

Przygotowano źródłowo próbkowanie `signed-eleven`: Gamma oraz pięć par
`k_y=±(0.5,1,1.5,2,3)e6 rad/m`, jeden mod na próbkę, przy niezmienionej
geometrii 10 nm i parametrach materiału. Kontrakt wejścia i preflight ma
`70 passed, 7 subtests passed`. To nie jest jeszcze przebieg numeryczny:
przed uruchomieniem 11 próbek trzeba doprowadzić solver iteracyjny do
akceptacji pojedynczego `k2` albo opracować osobno oznaczoną ścieżkę
diagnostyczną publikacji wyników dense oracle. ABI MFEM w wariancie v2
pozostaje bramką otwartą.

### Checkpoint 2026-09-25 — rozdzielenie EPS/KSP i job #142

Na niezmienionym buildzie #141 powtórzono `k2` z jedyną zmianą diagnostyczną
`--eps-prefilter 1e-8` (run `c6ebf525641a49bbb2964385b54e83a1`). EPS
zwrócił dwa kandydaty w pierwszej części okna, oba blisko 9.723336 GHz,
ale oryginalny względny residual magnetyczny pozostał
`2.167840537744029e-7` i obie pary zostały odrzucone przy fizycznym
`solver_rtol=1e-8`. Zmiana samego filtra EPS nie wystarcza. True residual
ostatniego przesuniętego KSP wyniósł `2.8102105064276275e-7` w pierwszej
części i `2.2916007962827794e-7` w drugiej. Diagnostyka wciąż mierzy
ostatnie rozwiązanie liniowe, nie maksimum ze wszystkich iteracji.

W źródle FEM CPU zmieniono przesunięty GMRES na prawostronne
prekondycjonowanie z jawną `KSP_NORM_UNPRECONDITIONED`. PETSc dopuszcza tę
parę i mierzy wtedy normę residualu oryginalnego równania liniowego zamiast
lewo-prekondycjonowanej. Kryterium fizyczne `1e-8` oraz operator Schura
pozostały bez zmian. Managed job #142 `65636004e798435ca763c3821088d0cf`,
profil `fem-cpu-slepc-runtime-v1`, source digest
`de2f7489d76790dadc55bae547a2033160f9c048fee35b23fc337e72c85d92bb`
i snapshot SHA
`7119109bef9605fb51385018fcf55f94fc8742f10800fcf9476208467742a314`
jest w kolejce/wykonywaniu. Dopiero terminalny build i pilot pokażą, czy
ten eksperyment usuwa stagnację; nie jest jeszcze zaliczonym rozwiązaniem.

Próba zbudowania osobnego obrazu zależności dla profilu v2 przez
`just build fem-gpu-runtime` została odrzucona przez projektowy preflight:
`Container runner owns heavy builds on this host; submit a snapshot through
just runner-build`. Obecny katalog kolejki nie ma operacji budowy obrazu
zależności, a istniejący obraz nie zawiera `/opt/fullmag-mfem-cpu`.
Nie uruchomiono ręcznego buildu Dockera poza bramką. Trasa v2 wymaga
obsługi obrazu przez zatwierdzony mechanizm operatorowy/runnerowy.

Po snapshocie #142 dodano jeszcze źródłową diagnostykę C1 wszystkich
zakończonych wewnętrznych solve'ów KSP: callback mierzy ich true residual,
liczy udane i nieudane pomiary oraz zapisuje maksimum. Osobny test natywny
sprawdza resolved `PC_RIGHT`/`KSP_NORM_UNPRECONDITIONED` i spójność maksimum
z ostatnim pomiarem. Zgodnie z tymczasowym zakazem testów jednostkowych nie
kompilowano go; tych zmian **nie ma** w #142. Doc validator i diff check
przeszły, ale kompilacja oraz runtime pozostają `NOT VERIFIED` do kolejnego
managed builda.

Dla tej samej próbki 10 nm przygotowano także osobny pilot `de-smoke-k0`
z jednym żądanym modem, zamiast podstawiać wynik Gamma z innej geometrii.
Walidator wymaga w nim operatorowego testu demag Gamma oraz deklarowanych
parametrów finite airbox; nie wymaga sondy dynamicznego demag nonzero-k,
bo żaden taki punkt nie jest próbkowany. Łączne interpretowane testy modelu
i preflightu: `54 passed` (z testami porównania). Pilot `k0` powstał po
snapshocie #142 i pozostaje `NOT VERIFIED` do managed runtime.

### Odbiór zewnętrznych częstotliwości COMSOL A1 — 2026-09-25

Użytkownik przekazał pięć plików w katalogu
`docs/plans/active/eignensolve_non_k0/` głównego checkoutu. Skopiowano je bez
zmian do izolowanego worktree, a integralność i zakres danych opisano w
[audycie odbioru](../../audits/2026-09-25-comsol-a1-received-data-audit.md).
CSV ma 61 punktów Γ–X–M–Γ i 24 lokalnie posortowane częstotliwości na punkt;
nominalne parametry odpowiadają A1 z przepisu, nie pilotowi jednorodnego filmu
DE-SMOKE. Nie wolno nakładać na ten wykres punktów DE-SMOKE jako porównania
tego samego modelu.

Pierwszy README nie podawał faktycznego airboxu, siatki ani wersji COMSOL.
Późniejszy załącznik `COMSOL_A1_model_details_user.txt` deklaruje COMSOL 6.1,
`d_air=2 µm` na stronę, siatkę docelowo około 5 nm/3 warstwy, jawne słabe
potencjały statyczny i dynamiczny oraz C0 ≈2.8003 GHz i C1 ≈9.2992 GHz.
To rozwiązuje brak opisu konfiguracji, ale nie zastępuje `.mph`, logu,
dokładnej siatki/DOF, stanu równowagi i zespolonych pól. CSV ma
sześć miejsc dziesiętnych w GHz, mniej niż 15 cyfr znaczących wymaganych w
protokole. Dlatego jest referencją **wstępną** do porównania widma, nie
zatwierdzoną bramką naukową. Poproszono użytkownika o provenance i dostępne
oryginalne artefakty. Kolejność dalszej pracy: przyjąć pojedynczy punkt
produkcyjny C1/DE, skontrolować C0/C1, uruchomić A1 w Γ/X/M, następnie całą
ścieżkę A1, porównać zbiory modów bez udawania śledzonych gałęzi i wykonać
kontrole zbieżności. Przy odbiorze #142 pozostawał `running` bez końcowego
receipt; Fullmag A1 nadal ma 0 obliczonych punktów.

Dodano `scripts/compare_comsol_a1_frequency_reference.py`. Narzędzie
waliduje komplet referencji 61×24 i kanoniczną ścieżkę, wymaga ukończonego
managed runu A1 o zgodnym hashu i nominalnych parametrach, a wynik oznacza
`frequency_only_unqualified`, bez utożsamiania `frequency_order` z gałęzią.
Zapisuje JSON i opcjonalny wykres punktowy. Poprawka dopasowania wymusza
porównanie lokalnych rang od najniższej częstotliwości, zamiast dobierania
dowolnego podzbioru 24 modów COMSOL, co mogło ukryć brak niskiego modu.
Sześć interpretowanych testów
PASS, rzeczywisty CSV przechodzi walidację 61×24. Nie ma jeszcze wyniku
Fullmag A1, więc komparator nie wykonał porównania numerycznego.
Korektę zapisano i wysłano jako `970167a80`.

Odbiór sześciu plików, audyt i komparator zapisano jako osobny commit
`61d9d7d0fdacf23053ca3ab92d413c1aced8693c`. Lokalny `.gitattributes`
utrzymuje dokładne bajty przekazanego CSV mimo hostowego `core.autocrlf`;
wszystkie staged bloby danych porównano z oryginałami bajt po bajcie.
Późniejszy audyt wskazał różnicę budżetu relaksacji: COMSOL opisuje pierwszy
odcinek 5 ns, a Fullmag miał `50_000 × 5 fs = 0.25 ns`. Kontrakt A1
zwiększono do `1_000_000 × 5 fs = 5 ns` jako górny limit kroków; zmiana
nie weszła do wcześniejszego snapshotu builda #144. Nadal trzeba potwierdzić
faktyczną równowagę certyfikatem momentu obrotowego oraz stabilnością stanu,
zachowując jeden stan/siatkę dla wszystkich k. To otwarta bramka fizyczna,
nie automatyczny dowód błędu częstotliwości.

### Runtime #142 i pilot DE-SMOKE k2 — 2026-09-25

Managed job #142 (`65636004e798435ca763c3821088d0cf`) zakończył się
terminalnie `succeeded`, exit 0. Receipt ma zgodny digest źródła
`de2f7489d76790dadc55bae547a2033160f9c048fee35b23fc337e72c85d92bb`;
wszystkie 14 wymienionych artefaktów przeszło kontrolę rozmiaru i SHA-256.
To jest dowód buildu CPU/SLEPc, nie dowód zbieżności modów.

`de-smoke-k2` uruchomiono z tego binarium przez `just run-de-smoke` dla
`k=(0,2e6,0) rad/m`. Run zakończył się `failed`, return code 1, bez
zaakceptowanych modów. Oba podokna osiągnęły limit 2000 iteracji EPS;
`EPS_DIVERGED_ITS`, `candidate_modes=0`. W podoknach końcowe rzeczywiste
residua względne KSP wyniosły odpowiednio `3.2976637102177511e-6` i
`5.0090086153465195e-7`, choć raportowane przez KSP normy wyniosły
`3.6154343056941193e-25` i `5.3816915164660712e-25`. Snapshot #142
rozwiązuje `PC_RIGHT` i `KSP_NORM_UNPRECONDITIONED`, lecz samo ustawienie
strony/normy nie usunęło rozbieżności względem niezależnie liczonego
`||Ax-b||/||b||`. Bramka fizyczna `1e-8` pozostała bez zmian; nie ma jeszcze
produkcyjnego punktu dyspersji ani porównania numerycznego z A1 COMSOL.

Następny krok: zbadać przyczynę różnicy między normą PETSc i rzeczywistym
residualem operatora shift-invert oraz zbieżność EPS, wykorzystując dodaną
po #142 diagnostykę wszystkich wewnętrznych solve'ów KSP. Następny managed
snapshot musi zawierać tę diagnostykę; nie należy interpretować samego
zielonego buildu #142 jako naprawy solvera.

Po przeglądzie implementacji i dokumentacji PETSc przygotowano eksperyment
modified Gram--Schmidt dla GMRES z prawym preconditionerem. PETSc wyraźnie
opisuje normę `KSPGetResidualNorm` dla GMRES jako potencjalnie przybliżoną;
zmiana ortogonalizacji jest hipotezą poprawy stabilności, nie dowodem
przyczyny ani obniżeniem bramki fizycznej. Nota 0831 i source-map zapisują
zakres FEM CPU oraz kryteria: rzeczywisty residual `||Ax-b||/||b||`, zbieżność
EPS i oryginalne residuale magnetyczny/potencjałowy. Walidator noty i 32 testy
jej kontraktu przeszły; testów natywnych nie kompilowano.

Managed job #143 (`58afb60a8b204a83a132f25d351a1cdb`) przyjął snapshot
`a0ca9e214c8901e21f1b566e24b0986be3c81da553abb93c7e825ee03736d7dd`.
SHA-256 pliku solvera w kapsule jest identyczny z lokalnym
`568ec1bf0d639a55c7b132204987ec3dbef88a52c8db42f2b08c585d2aea55a2`
i zawiera wywołanie `KSPGMRESModifiedGramSchmidtOrthogonalization`. Przy
zapisie tego checkpointu job był `running`; wynik i pilot pozostają otwarte.

Osobny dry-run trasy COMSOL C0 na terminalnym buildzie #142 zakończył się
`dry_run`, exit 0: preflight potwierdził kapsułę, obraz i binarium oraz
przygotował dokładne polecenie dla przypadku `c0`. Nie uruchomiono jeszcze
fizycznego C0 i nie ma jego częstotliwości. Pomoc skryptu benchmarku
skorygowano tak, aby wymieniała oba rzeczywiście obsługiwane profile
`fem-cpu-slepc-modal-v1` i `fem-cpu-slepc-runtime-v1`; parser i `py_compile`
przeszły. Ten tekstowy fix powstał po snapshocie #143, nie wpływa na jego
binarium ani na zaplanowany pilot k2.

### Runtime #143 — MGS i kontrola prefiltra EPS

Build #143 zakończył się terminalnie `succeeded`, exit 0. Receipt zachowuje
source digest `a0ca9e214c8901e21f1b566e24b0986be3c81da553abb93c7e825ee03736d7dd`;
14/14 artefaktów przeszło niezależną kontrolę rozmiaru i SHA-256.
Identyczny produkcyjny `de-smoke-k2` z `k_y=2e6 rad/m` uruchomiono z jego
binarium w runie `4f28aacae6414ed3b0dfbe3e1693de62`. Exit 1, zero
zaakceptowanych modów, oba podokna `EPS_DIVERGED_ITS` po 2000 iteracji.
Końcowe prawdziwe względne residua KSP wyniosły `4.137571917091711e-8`
i `1.5254634713457512e-7`, wobec #142 `3.2976637102177511e-6` i
`5.0090086153465195e-7`. To poprawa częściowa, nie ukończony solve.
Pomiar po wszystkich 32016 wewnętrznych solve'ach każdego okna nie miał
błędów pomiaru, ale maksimum wyniosło odpowiednio `1.047275813012921e-4`
i `2.4981913857495865e-5`; na ostatniej iteracji oszacowania EPS pierwszej
niezbieżnej pary wynosiły `4.51e-9` i `6.39e-9` przy prefiltrze `1e-11`.

Kontrolny run `9c919c67c65b46fdad870173dc6c5bad` ustawił wyłącznie
diagnostyczny prefiltr EPS na `1e-8` bez zmiany oryginalnej tolerancji
magnetycznej/potencjałowej `1e-8`. W pierwszym oknie uzyskano jedną
zbieżną parę `9.723336314085032 GHz`, lecz jej residual magnetyczny
`2.796933879467072e-7` przekroczył bramkę fizyczną, przy residuale
potencjałowym `1.2723466903501634e-14`; para została prawidłowo odrzucona.
W drugim oknie dwie pary były poza jego zakresem częstotliwości. Oba okna
znów zakończyły się `EPS_DIVERGED_ITS`; łączny wynik pozostaje `failed`.
Sam prefiltr EPS nie jest przyczyną braku produkcyjnego punktu.

Następny krok numeryczny: zbadać kondycję przesuniętego Schur i jakość
preconditionera, który obecnie pomija sprzężenie demag `A_qphi P^-1 A_phiq`.
Zweryfikować na tej samej kapsule wpływ restarta/ortogonalizacji GMRES lub
refinementu na **maksimum rzeczywistego** `||Ax-b||/||b||` we wszystkich
solve'ach, a potem na oryginalny residual modu. Nie zmieniać progu
fizycznego tylko po to, aby otrzymać punkt. Diagnostyczny dense oracle
pozostaje kontrolą tego samego operatora, nie produkcyjnym fallbackiem.

### Kontrola COMSOL C0 w Γ na buildzie #143

Managed run `7e0f427291164864a4931521f0cf05ee` uruchomił rzeczywisty
model C0 z kapsuły #143: pełny film bez otworu, wymiana i bias `0.1 T`,
bez statycznego/dynamicznego demagu, jeden punkt Γ. Run zakończył się
`completed_unqualified`, return code 0. `eigen/dispersion.csv` zawiera
jedną częstotliwość `2.8002642129151073e9 Hz` z residualem
`3.1166874077185831e-16`. Wzór `gamma Hbias/(2π)` w przepisie daje
`2.80026421291511e9 Hz`; różnica w zapisanej precyzji wynosi około
`2.9e-6 Hz`. Weryfikacja siedmiu wymaganych artefaktów względem receiptu
przeszła kontrolę rozmiaru i SHA-256. Diagnostyka wskazuje
`production_cpu`, `status=ok`, `accepted_mode_count=1`, lecz naukowa bramka
całego runu nadal jest `NOT VERIFIED`: brak kampanii zbieżności siatki i
liczby modów. C0 potwierdza konwencję jednostek i przeliczenie gamma dla
tego przypadku, nie demag ani ścieżkę Floqueta.

Obecny C0 bez demagu odziedziczył airbox `4.01 µm` oraz bardzo szerokie
okno `1 MHz–30 GHz`: siatka miała `615597` tetraedrów, a solver podzielił
okno na 16 podokien dla jednego żądanego modu. W trakcie runu zaobserwowano
użycie pamięci około `43 GiB`. To kosztowny kontrakt kontrolny; przed
powtarzaniem C0 warto osobno ocenić zawężenie *wyłącznie C0* do
analitycznie uzasadnionego okna i pominięcie nieużywanego powietrza.
Nie wolno przenosić takiej optymalizacji do C1/A1, gdzie airbox i demag
są częścią fizycznego problemu.

### Następny managed eksperyment #144

Kod FEM CPU zastępuje MGS przez klasyczną ortogonalizację Gram--Schmidta
z wymuszonym refinementem przy każdym kroku GMRES
(`KSP_GMRES_CGS_REFINE_ALWAYS`). Jest to eksperyment numeryczny według
dokumentacji PETSc, nie poluzowanie tolerancji. Diagnostyka raportuje
`ksp_orthogonalization=classical_gram_schmidt_refine_always`. Nota 0831,
source-map, 10 testów kontraktu matematycznego i 32 testy narzędzia
dokumentacyjnego przeszły; testów jednostkowych natywnych nie kompilowano
zgodnie z tymczasową regułą repozytorium.

Job #144 `f5c88d52b5884ac9a4d35e81733ad4f2` (profil
`fem-cpu-slepc-runtime-v1`) został przyjęty przez jedyną kolejkę jako
snapshot `3d7ded5031c71bfe81fa76cd29af2a523a9156c30e9db9b8095d4e1382aafb44`.
Hash źródła solvera w kapsule i worktree jest identyczny:
`cd41d27fe92870eec849eb29d8bad229095a4a9cf1c217355b2f7b6421562491`.
Job zakończył się `succeeded`, exit 0. Receipt potwierdza zgodny digest
źródeł oraz 14/14 artefaktów zweryfikowanych co do rozmiaru i SHA-256.
Jest to wyłącznie sukces buildu runtime, bez kwalifikacji naukowej.
Dry-run pilota `de-smoke-k2` przeszedł.

Produkcyjny pilot `905d3e1fe10c4d5abac215ebb5b0fd34` dla
`k=(0,2e6,0) rad/m` zakończył się exit 1: dwa podokna osiągnęły
`EPS_DIVERGED_ITS` po 2000 iteracji każde; przyjęto 0 modów i nie
powstał wiersz CSV. Przy domyślnym prefiltrze `1e-11` ostatnie rzeczywiste
względne residuale KSP wyniosły odpowiednio `8.74e-7` oraz `1.09e-6`,
a największe zarejestrowane w każdym podoknie `8.59e-5` oraz `5.83e-5`.
Wymuszony refinement CGS nie poprawił tych pomiarów względem poprzedniego
pilota z MGS.

Osobny przebieg diagnostyczny `7a48da1936574c35835660a5b4ea057f`
zmienił wyłącznie prefiltr EPS na `1e-8`. Ujawnił kandydata
`9.723336314088953 GHz`, lecz jego oryginalny residual magnetyczny
`2.603591055862589e-7` przekroczył niezmieniony próg fizycznej
akceptacji `1e-8`; 0 modów przyjęto. Wartość jest bliska referencji
analitycznej jednorodnego filmu `9.725724281195415 GHz`: różnica wynosi
`-2.387967 MHz` (`-0.024553%`). Od wcześniej obliczonej wartości własnej
dense Schur oracle `9.723336314058123 GHz` różni się tylko o około
`0.031 Hz`, lecz oracle pochodzi z wcześniejszego przebiegu, a zgodność
samej wartości własnej nie certyfikuje wektora, residualu ani zbieżności
siatki. Kandydat nie jest produkcyjnym punktem dyspersji. Następny
kontrolowany eksperyment powinien
wymusić restart GMRES przed obserwowaną pozorną zbieżnością po około
13--15 iteracjach, raportować rzeczywisty residual po ponownym starcie
i zachować oryginalne progi. Dopiero po udanym punkcie C1/DE należy
przejść do A1 i porównania z przekazanym CSV COMSOL.

### Diagnostyka restartu GMRES — managed job #145

Dodano ograniczone wartości `FULLMAG_FLOQUET_GMRES_RESTART` 8, 10, 12, 16
i 30 dla pilota `de-smoke-k2`; domyślne 30 zachowuje dotychczasową politykę.
Wynik solvera zapisuje rzeczywistą wartość `ksp_restart` w diagnostyce
podokna. Próg fizycznego residualu `1e-8`, prefiltr EPS, normę KSP,
preconditioner i geometrię pozostawiono bez zmiany. Celem jest pomiar,
czy wcześniejszy restart przed obserwowaną pozorną zbieżnością po około
13--15 iteracjach poprawia rzeczywisty residual układu.

Interpretowane testy narzędzi pilota: 25 PASS i 4 subtesty PASS; walidator
noty 0831, jej 32 testy kontraktowe i test dokumentacji matematycznej
przeszły. Natrywnych testów jednostkowych nie kompilowano zgodnie z
tymczasową regułą repozytorium. Job #145
`06549612ec9c428e9be18f0c1e18e10a`, profil
`fem-cpu-slepc-runtime-v1`, snapshot source digest
`4a7af19818788336e2e92afc43252bfe1c963dc6f56ae95ae8ae143b8eed5d22`,
capture `dd2a7210b0e04124875d0bc18eadf8b8`, został przyjęty do
wspólnej kolejki; ostatnio odczytany stan `running`. Snapshot wykonano
przed późniejszą korektą przestarzałych atrap w testach Pythona; nie
zmieniła ona produkcyjnego kodu solvera ani pilota. Po terminalnym
receipcie wymagany jest dry-run i rzeczywisty pilot przy restarcie 10,
następnie porównanie z domyślnym 30 na tym samym binarium. Żaden z tych
kroków nie oznacza jeszcze kwalifikacji fizycznej.

### S08 — stan lokalnej kontroli frontendowej podczas #145

Próba uruchomienia czterech skupionych testów Vitest modelu dyspersji,
renderera i selekcji punktu nie dotarła do testów: `vitest` nie jest
dostępny w tym worktree. `apps/control-room/node_modules` jest junctionem
do przypisanego katalogu `storage/builds/<worktree-id>/frontend/...`, lecz
jego cel obecnie nie istnieje. To brak lokalnych zależności, nie wynik
`PASS` ani `FAIL` funkcji UI. Nie tworzono drugiego cache ani nie
uruchamiano instalacji równolegle do aktywnego managed buildu #145.
Po zakończeniu buildu należy odtworzyć zależności zgodnie z resolverem
storage i ponowić testy; osobno potrzebny jest dowód browser/WebGL.

### S02 — kontrola publicznego przykładu periodycznego

`packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py`
przeszedł: 9 testów i 6 podtestów PASS, z `PYTHONPATH` wskazującym
`packages/fullmag-py/src` również dla subprocessu eksportującego konfigurację.
Pierwsza próba bez tej ścieżki zatrzymała się na `ModuleNotFoundError` podczas
zbierania testów; próba z lokalnym `sys.path` przeszła 8/9, lecz subprocess
nadal nie widział pakietu. Ostateczny poprawny przebieg nie zmienia
źródeł. Dowód obejmuje authoring/eksport Python, nie managed FEM runtime,
fizykę dyspersji ani kwalifikację S02 jako całości.

Końcowe review wskazało dalsze obejścia P2: kolejka CLI mogła przyjąć bezpośrednio przypisany marker, opóźniony realtime sample mógł przeżyć wejście w tryb modalny, a licznik iteracji trafiał do physical total_steps. Dodano centralne filtry candidate/enqueue, anulowanie pending QoS pod wspólną blokadą przejścia oraz total_steps=0 dla callbacku bez fizycznych kroków. Historia pozostaje zachowana. Legacy completed z końcowym markerem pozostaje fail-closed; odzyskanie pomiaru wymaga jawnej tożsamości obserwacji, nie fallbacku do niesprawdzonego final_e_*.

Review EPS po poprawkach: brak blokera produkcyjnego. Przygotowana regresja
akceptuje obie rzeczywiste przyczyny niepełnego EPS (diverged/not_converged),
zamiast narzucać kod zależny od wersji SLEPc. Wymuszenie braku zbieżności przez
limit jednej iteracji pozostaje do potwierdzenia natywnie; nie jest dowodem PASS.


Checkpoint publikacji EPS: commit `1b017436f0738e24e84962b24b08cb30b4c32d3c`,
branch `codex/eigensolve-dispersion-plan-20260912`; push oraz pełny SHA remote
potwierdzone. 18 kontroli PASS i source-map/diff checks PASS. Native/runtime
pozostają NOT VERIFIED. Końcowe review nie znalazło blokera produkcyjnego.
Przygotowana regresja dopuszcza rzeczywiste diverged/not_converged; jej zachowanie
na limicie jednej iteracji wymaga późniejszego natywnego wykonania.

Kontroler 90201 i kontener 7df4be7c5ace sprawdzone live: solver pracuje około
3h14min, CPU około213%; Γ refinement25/50, bez terminalnego nowego punktu.
Nie zmieniono kapsuły #188 ani kolejki. F01 w implementacji w osobnych plikach;
R4 w niezależnym review różnic. Robin open-axis helper jest już wspólny.
Modal mixed-mesh fingerprint v3 i osobny handoff source identity mają pierwszeństwo
przed starszą K0-only propozycją fingerprint v6; nie kopiować jej mechanicznie.


## R4 — dokładne preimages, pierwszy fragment źródłowy

W `equilibrium_identity.rs` identyfikatory przechowują dokładne compact JSON
użyte do wyliczenia pięciu hashów. Materiał bez Ku zachowuje v1, materiał
constant Ku zachowuje nasze canonical v2; nie przeniesiono K0 V1-only buildera.
Namespace, separator0, LE byte length i bytes pozostają niezmienione.
Przygotowano natywne regresje golden legacy replay oraz Ku sign/scaling/signed0.
Parser Rust1file PASS; 10 kontraktów dokumentacji i source-map PASS. Niezależny
Python/hashlib replay historycznych golden bytes PASS, mutacje namespace i bytes
zmieniają digest. To nie jest wykonanie nowych funkcji Rust.

Pełny port accepted/recomputed fields, source/modal identity V2, certificate
publication, niezależny walidator i runtime nadal OPEN. Review pierwszego
fragmentu trwa. F01 ma dodatkowy pre-commit blocker: MFEMv4.7 tetraorder4 ma
ujemną wagę, a exchange wymaga dodatnich; korygowana polityka tet5/prism4.
Nie publikowano błędnego wspólnego order4. Zakres S00–S12 pozostaje otwarty.

R4 foundation po niezależnym review: brak blokera źródłowego. Uzupełniono
przygotowane replay/mutation regresje wszystkich pięciu rodzin tożsamości.
Parser dwóch plików Rust PASS; natywne testy nadal NOT VERIFIED. Pełny R4
nie jest gotowy: accepted/recomputed fields, V2/Ku namespace, Provided continuation
multi-k, remap accepted/identity artifacts i Python V1/V2 validator wymagają
spójnego portu. K0-only topologyV6 override nie zastępuje naszego mixedV3.


## Checkpoint F01 i MFEM 4.10 — 2026-10-01

F01 naprawiony źródłowo: exchange prism6 nie używa już centroid/order1.
Polityka zależna od geometrii to tet5/prism4, z dodatnimi wagami referencyjnymi
i fizycznymi. Ten sam wybór dotyczy field/anisotropy i sprzężeń mixed.
Digest wiąże topologię, FE order, requested/resolved order i rzeczywistą liczbę
punktów. Nie zmieniono Aex ani progu residualu.

Niezależny oracle afinicznego prism6 ma rank5, centroid rank3. Energia pola
hourglass wynosi 2/3 zamiast błędnego0; K00=5/12 zamiast11/36. Dowód Python
PASS; source-map PASS; wcześniejsze dziewięć kontraktów dokumentacji PASS.
Niezależne review po korekcie tet5/prism4 nie wskazało blokera źródłowego.
Przygotowane native checks obejmują exact tetra gradients, prism rank/nullspace,
PSD, tangent-frame transport i air isolation. Nie kompilowano ich.
Runtime, zdeformowany prism i zbieżność order4/5/7 nadal NOT VERIFIED.
Czytelny eksport szczegółów kwadratury obok hasha pozostaje luką evidence P2.

MFEM4.10 source pin jest na remote: commit
`2548bbb9440603d6128d34daeaab0009ab53b5fb`. Nowe obrazy, ABI attestation
i runtime nadal NOT VERIFIED. Kontener #188 pozostaje live/running na starym
obrazie; nie nadpisano go ani nie uruchomiono równoległego ciężkiego buildu.
R4 exact-preimage foundation opublikowano jako
`2c9ed3c5836ffff9e574271a7c39afd07590b5e5`; full accepted replay nadal OPEN.
Zakres S00–S12 nie został zawężony ani uznany za ukończony.


## R4 — evidence multi-k niezależny od wyboru pól modów

WIP źródłowy w eigen_path_artifacts/eigen_path_manifest: accepted fieldsV1/V2
i linearization identityV2 otrzymują sample metadata paths i manifest arrays.
Podpisane equilibrium/state/identity dokumenty zachowują dokładne bajty,
zamiast recursive sample string rewriting. Certyfikaty policzonych próbek
pozostają dla spectrum-only i przy selekcji pól z innego sample.
Przygotowana regresja sprawdza whitespace/preimage strings oraz sample0/2/7,
empty mode selection i indeksowanie paths. Parser2Rust PASS,10docs PASS,
source-map PASS po naprawie czterech wymaganych wpisów indeksu.
Natywne wykonanie nadal NOT VERIFIED, review w toku, nie jest to zamknięcieR4.
Szczegółowe pozostałe P1/P2 i kroki A1:
`docs/audits/2026-10-01-r4-replay-and-comsol-a1-gates.md`.
F01 opublikowany; #188 nadal live refinement27/50, bez końcowej częstotliwości.

Review R4 path wykryło dodatkowy P1: spectrum-only deklarował binary mode
exports bez payloadu. Poprawiono wybór format none/zarr/binary na podstawie
rzeczywistych niepustych artefaktów i przygotowano regresję. Uzupełniono spec
frequency-domain-artifacts-v2 o nowe tablice ścieżek i scope replay.
Parser2Rust/10docs/source-map PASS; końcowe review w toku, runtime NOT VERIFIED.
Brama zdeformowanego prism6: przygotowany niezależny GL4/5/7 oracle używa
4/5/7 punktów na osi, nie MFEM orders4/5/7; dokumentacja korygowana,
produkcyjna zbieżność kwadratury i native execution nadal OPEN.


## Terminalny #188 i R4path checkpoint

#188 failed:6/50podokien EPSdiverged,44ukończone. Lokalne9.299249697GHz
nie jest końcowym certyfikowanym punktem. Pełna diagnoza:
`docs/audits/2026-10-01-job188-frequency-window-failure.md`.
Ten sam kontroler90201terminal exit1; kontener nie istnieje. Runner zdrowy,
lecz aktualnie wykonuje job189 na innym checkoutcie. MFEMimagebuild nadal
oczekuje, bez restartowania/zmiany cudzegojob.

R4path source commit5a2257f31: review po poprawieniu storage_formatnone
bezP1; replayPython/plural sample-set/runtime nadal OPEN. AcceptedR4port
wykrył P1 wCLI(staraarność+legacybypass), jest poprawiany przedcommit.
MFEMobservedversion attestation38lighttestsPASS; nativeheadercontract
przygotowany. F01deformed referenceGLconvergence przygotowana; rootmathprobe
potwierdził GL4→GL5 max4.0978971e-8, GL5→GL7max1.5717799e-10
bezfaktora2Aex,scalar rank5 i dodatniJacobian. Nie jest to MFEMruntime.
Pełny S00–S12 nadal otwarty.

R4 accepted replay: CLI P1 skorygowany źródłowo, accepted payload ładowany
oddzielnie; verifiedconstructorpublic,legacyinternal, load_state czyści
accepted continuation. Repo-wide search nie znalazł już produkcyjnego
legacycallera;4interpretedchecksPASS i parserPASS wedługautora.
Końcowe niezależne review pending. PełneV3/sourceidentity i Pythonartifactreplay
nadal OPEN. Nie uznano fragmentu za runtime/science qualification.
Remotecheckpoint poprzednich etapów ecb614bd36de754286cd09788f9cc8f4c5a1bddb.

R4 accepted fragment po końcowym review: P1 CLIarity/legacybypass closed
źródłowo. Dodatkowe P2 stale continuation po interaktywnym load_state i remesh
naprawione: import używa wspólnego invalidation helper, remesh czyści
mesh/completion/stage/accepted/certified cache. AktualnyCLIparserPASS,
14lightchecksPASS, stageddiffPASS po usunięciu pustej liniiEOF noty.
Native/build/runtime i V3/sourceidentity/pełny Pythonreplay pozostają OPEN.

## R4 — kolejny checkpoint implementacji, 2026-10-01

- `283ee3aaaf2ae6debb4b31a577ca6bbd2eff6bd9`: exact material preimage replay
  wybiera namespace V1/V2 ze schematu, zachowuje Ku=0 i oryginalne bajty.
  Niezależny oracle Python i mapa naukowa PASS; native tests przygotowane.
- `fefe69fd1d960c5f69883370453d1d7f1534ccc6`: walidacja przed i po przejściu
  RelaxedInitialState → Provided, bez ponownej relaksacji i bez ponownego
  użycia jednej równowagi dla field sweepu. Trzy source checks PASS;
  regresje drift m0/material/static/boundary/mesh są przygotowane.
- `7967801ee4bf85596516c9ef17c9678011ec96f3`: Python sprawdza siedem tablic
  endpointów/certyfikatu/identity, rodziny i sample-sety. 25 regresji PASS,
  dziewięć istniejących V7 PASS. CLI jawnie raportuje R4 NOT VERIFIED;
  `--require-r4-replay` nie dopuszcza częściowego dowodu.
- Agregator zachowuje certified fields i recomputed certificate V1/V2
  bajt w bajt, również spectrum-only. Konflikt dwóch podpisanych payloadów
  jednej ścieżki kończy się błędem przed dedupikacją i publikacją manifestu.
  Niezależne review bez blokera; przygotowano test rzeczywistego manifestu.
- Niezależny Python field replay ma 8 grup PASS: frozen binary digests V1/V2,
  różnice, tolerancje, Ku/anisotropy i typed exact certificate preimage.
  Brak producer preimage/source-context nie jest ukrywany jako PASS.

Nie wykonano native compilation/test execution ani nowego solvera.
Najbliższy krytyczny krok R4: zachować accepted endpoint oraz recomputed
certificate w handoff, opublikować je wraz z exact preimage i identity V2,
wiążąc źródło, raw/canonical materiał, m0 i oddzielne topologie. Obecny
verified constructor kontroluje dane, lecz handoff zachowuje tylko certified
fields. Następnie podłączyć cały replay do głównego walidatora.

MFEM 4.10 ma source pin i observed-version attestation; obraz nadal pending.
Konkretny job #189 / 529ac93e81744c5faf50494306d50a11 potwierdzono running.
Nie rozpoczęto równoległego ciężkiego imagebuild. #188 jest terminal failed
6/50 podokien; lokalny cluster nie jest końcowym punktem dyspersji.
Po bezpiecznym zwolnieniu runnera: nowy obraz/ABI → pełny SHA runtime-only
build → Γ → signed DE/BV → kompletne artefakty, zbieżność i COMSOL A1.
Zakres S00–S12, waveguide, interakcje, GPU, browser/FMS i integracja pozostają
w celu. Nie oznaczono całego celu ani R4 jako ukończonych.

## R4 coverage i MFEM — checkpoint 2026-10-01

Kontrola pełnego sample-set jest wdrożona: wszystkie opublikowane próbki ze
spectrum.v2 muszą mieć zgodne sidecary, również przy spectrum-only. Zniknięcie
całego punktu ze wszystkich tablic jest błędem. Liczniki/indeksy bool lub float,
duplikaty i dodatkowe punkty są odrzucane. 31 regresji sidecarów i 213 testów
pytest walidatora PASS. Pełny replay identity/payload i managed runtime OPEN.

MFEM4.10: review sześciu konstruktorów HyprePCG potwierdziło jawne SetTol oraz
SetMaxIter (d7789a563). Job189 succeeded; job191 zakończył się failed, exit2.
Drain osiągnął paused bez aktywnych jobów. Uruchomiono operatorską budowę
nowego obrazu CPU MFEM4.10 przez just; żywy handle24954. Pierwsza próba z
raw imageID w FROM została odrzucona; użycie sprawdzonego lokalnego tagu
z właściwym immutableID rozpoczęło kompilację. Terminalny obraz/ABI/build
Fullmaga nadal NOT VERIFIED. Rekord stanu jest w kanonicznym storage/builds,
profil operator-mfem410-20261001. Pełny S00–S12 i bramki naukowe są otwarte.

## MFEM4.10 — obraz wykonany, runtime-only build przyjęty

Nowy obraz8a508319a68c4116da81b745fdd1b084015b665d92b36b2241e1e245b5febf89
zbudowany exit0. Header/CMake/loaded MFEM4.10.0 potwierdzone; CPU MFEM bez
CUDA, istniejący libCEED korzysta z image-owned compatibility driver.
Profil runtime-v2 przypięty do tego obrazu, inne profile/zasoby zachowane.
Kolejka wznowiona. Job193 / 19e798d5ff07454db64c90e63ba4f3a3 przyjęty queued
z commita e78a25bac0f95c1190821524545803e4311b8ef9. Bez unit compilation.
Toolchain diagnostic PASS; managed Fullmag receipt/ABI/solver jeszcze OPEN.
Bieżące fullR4 i F01kwadratura są w lokalnym review, poza tą kapsułą.

## R4/F01 — wyniki niezależnego review, 2026-10-01

Audyt: `docs/audits/2026-10-01-r4-identity-and-quadrature-review.md`.
Review potwierdziło lukę exact own identity preimage i brak kompletnego identity
w non-shared Floquet. Otwarte są producer provenance importu, operator input
signature oraz produkcyjne modal identity (damping/k/operator). Nie zastępujemy
statycznego identity porównaniem raw damping relaksacji i eigen.

F01: nested klucz może tłumić top-level provenance; poprawka jest w review,
wymaga również obsługi pustego JSON z whitespace i przygotowanej regresji
natywnej. Source-only Python nie dowodzi wykonania C++.

Niezależny Python own preimage replay ma 9 grup regresji PASS, lecz pozostaje
lokalnym przyrostem; publikacja sidecara i podłączenie pełnego replay do głównej
bramki nadal OPEN. Runner zdrowy, aktywny #192, nasz #193 queued. Wymagany
terminalny receipt oraz późniejszy build nowego spójnego SHA. S00–S12 zachowane.

## R4 — exact own preimage w głównym walidatorze

`fem_linearization_identity_replay.py` odtwarza raw/framed hash dokładnych bajtów
i typowane wartości 52 pól identity. Główny walidator przyjmuje addytywną tablicę
preimage paths, wymaga pełnego sample-set i zgodnego sample_index w payloadzie.
Historyczny brak zachowuje NOT VERIFIED. Poprawny własny digest jest osobnym
wynikiem, także przy brakujących polach recomputed; pełny gate nadal OPEN.

Review bez P1; P2 nadmiernego zagnieżdżenia i utraty informacji o poprawnym
hashu przy missing_recomputed poprawione z regresjami. 48 testów przyrostu PASS,
213 testów dotychczasowego walidatora PASS. Scientific source-map PASS.
Rust sidecar producer, non-shared handoff, source provenance i modal identity
są w dalszej implementacji. Ten etap nie dowodzi managed runtime ani fizyki.

## F01 — czytelna rzeczywista kwadratura, poprawki review

Wynik składania publikuje agregat geometrii, rzędu FE, requested/resolved rule,
rzeczywistej liczby punktów MFEM i liczby magnetycznych elementów. Jest on
dołączany do digestu w diagnostics/result dla k0, sparse Floquet i legacy
dynamic-demag-k po udanym składaniu. Dotychczasowy preimage digestu i C ABI
nie zmieniają się.

P2 nested key/whitespace naprawione; pusty obiekt nie generuje błędnego
przecinka. Prepared regresje obejmują tet/prism/Floquet oraz bezpośredni
kontrakt solvera i publiczne C ABI z nested operator diagnostics. Focused
review bez nowych P1/P2; source-only wiring i scientific source-map PASS.
Native testy nie były kompilowane. Wykonanie i wartości w artefaktach solvera
wymagają nowego managed builda spójnego SHA; #193 nie zawiera tego przyrostu.

## S05 — kontrola początkowego przydziału gałęzi, 2026-10-02

Niezależny replay porównuje początkowe branch_id z kolejnością slotów modów
solvera. Przestawione lub niekanoniczne identyfikatory wykluczają certyfikat
assignment_replay, nawet gdy kolejne metryki są poprawne. Regresja wykazała
fałszywy PASS na poprzedniej implementacji; po poprawce 31 testów replay PASS.
Nie jest to dowód wykonania FEM ani zamknięcie S05: narodziny, przerwy i zaniki
gałęzi nadal wymagają pełnego odtworzenia historii.

Job #196 (febe368724ec4e76a1da88ad24878a9b) odczytany jako queued.
Aktualny pomiar hosta: około 4 MB wolnego na C:, później około 2,6 MB.
Brak nowych punktów dyspersji. Nie uruchomiono nowych buildów ani czyszczenia.

## S05 — replay pełnej historii gałęzi, 2026-10-02

Replay zachowuje ostatnią ramę i częstotliwość każdej gałęzi, odtwarza
dopuszczalność według max_branch_gap oraz kolejne ID narodzin w kolejności
nieprzypisanych slotów solvera. Obsługuje puste próbki, zmienną liczbę modów,
zaniki i restart po wygaśnięciu. Zgodnie z native tracking mieszane próbki
poprzedników wyłączają transport podprzestrzeni, pozostawiając dopasowanie par.
Globalny certyfikat nadal sprawdza wszystkie kandydaty i całe historie.
Bramka complete_history wymaga wykonanego branch_lifecycle_replay z dokładną
liczbą próbek; nie zmienia wymagań kompletności wybranych pasm benchmarku.

Pięć poprawnych scenariuszy historycznych odrzuconych przez bazę 855671777
przechodzi nową ścieżkę. 78 testów metryk/pól/przydziału/klastrów/replay PASS;
trzy kontrole konsumenta bramki PASS, w tym pięć wariantów certyfikatu historii.
Pełny zestaw bramki naukowej: 56 testów PASS. Niezależne review nie wykazało
P1/P2 w dopuszczalności, przydziale narodzin, przerwach ani pokryciu kandydatów.
Równoważny alternatywny zestaw grup lub narodzin przy remisie pozostaje
fail-closed, a wykonanie rzeczywistego FEM i walidacja naukowa nadal OPEN.

## Priorytet użytkownika — DE k=±10 rad/µm, 2026-10-02

Po zwolnieniu miejsca runner widzi 17 845 354 496 B wolnego i #196 ma
stan running. Nie zlecono drugiego buildu. Zatrzymano wyłącznie własnego
obserwatora sześciu pilotów (PID 178268, poprzedni handle 7375); sam job,
kapsuła źródeł i dane pozostają zachowane.

Nowy obserwator handle 95490 wykona w pierwszej kolejności dwa rzeczywiste
piloty DE k_y=+1e7 oraz -1e7 rad/m, L2, trzy warstwy, z dotychczasową fizyką
demag i airboxu. Źródła runtime/modelu pozostają przypięte do 71ec3f159b47ee7a56e471020923248c2cac283f.
Nearest shift 11 GHz jest jawnym parametrem wyszukiwania, nie wynikiem.
Przed obliczeniami istniejący wrapper zweryfikuje receipt i źródła buildu.

Lekki obserwator wykresu handle 6342 sprawdzi rzeczywiste run-request/result,
signed k, pełny residual, pola i model; po każdym zakończonym punkcie użyje
istniejących collector/plotter do narysowania scatter i analityki. Wyniki i
sterowniki są w kanonicznym scientific-batches/nonzero-k-validation/
febe368724ec4e76a1da88ad24878a9b, pliki priority-k10-*. Symetria nie jest
używana do tworzenia punktów. W chwili checkpointu nadal 0 nowych punktów;
build i oba obserwatory są aktywne, kwalifikacja całego celu pozostaje OPEN.

## S09 — nodalne Ms i jednostki źródła, 2026-10-03

Lokalny commit `1cee2db614fcd920dbc0cfd4293df9dd3098c70d` naprawia całkowanie nodalnego Ms w bounded assemblerze przekroju. Zamiast Ms w węźle źródła razy mass używa dokładnych momentów P1 stopnia drugiego i trzeciego. Gałąź bez nodalnego bufora zachowuje dotychczasową arytmetykę uniform. Nota [0832](../../physics/0832-fem-waveguide-nodal-ms-quadrature.md) rozróżnia bezwymiarowe delta_m od delta_M [A/m] oraz A_phiq_perp [A] od A_phiq_axial [A m]. Review domknęło błędy oznaczeń i jednostek. Dziewięć interpretowanych kontroli PASS; regresja odróżnia historyczną błędną regułę, mapa JSON ma poprawne referencje i jednostki. Native test przygotowano, bez kompilacji. To nie jest ukończone S09: typed production routing, owner MFEM, exchange k², rekonstrukcja pól, boundary/k→0, TetraX i extruded3D nadal OPEN.


### Checkpoint 2026-10-03 — admission i diagnostyka przed main

Pełny cel S00–S12 pozostaje aktywny. Nowa adaptacyjna pula i ustawienia UI
nie zastępują walidacji Γ/DE/BV/COMSOL, zbieżności, waveguide ani GPU.
Źródłowe review poprawiło nieograniczone ponawianie telemetrii, kalibrację
krótkiego workera z samej średniej CPU, deklarację źródeł cgroup, stare
zmienne pamięci Slurm, limit wątków ustawiany dopiero po exec oraz
nieograniczony odczyt RAM przy przycinaniu logów. Rustfmt/diff PASS;
przygotowane regresje Rust nie były kompilowane. Te poprawki nie należą
jeszcze do kapsuły #213.

Działający nowy sterownik diagnostyczny wykonał sondy --help/availability
na runtime #211 w osobnym kontenerze 1 CPU/1 GiB. Wszystkie sondy Fullmaga
zatrzymały się przed main; loader kończy log na inicjalizacji cublasLt.
To lokalizacja awarii, nie dowód wewnętrznej przyczyny ani PASS solvera.
Raport i kontener zachowano; sześć interpretowanych kontroli sterownika PASS.
Audyt: docs/audits/2026-10-03-fem-cpu-startup-cuda-dependency-audit.md.
Izolowane dodatkowe sondy bibliotek wymagają odpowiedzi na otwarte pytanie
po odrzuceniu tego rozszerzenia przez auto-review. Nie uruchomiono ich.

Runner jest zdrowy, ale ma 6782971904 B wolnego, poniżej bramki 8 GiB.
#212/#213 czekają w niezmienionej FIFO. Nie usunięto danych. Po odblokowaniu
runtime potrzeba przypiętej próby serial/adaptive, nowego GUI i dalszej
kampanii naukowej. Wykres nadal zawiera dwa zaakceptowane punkty ±10 z #203.

Końcowy read-only review przyrostu admission nie znalazł nowego P1/P2.
Budżet CPU krótkiego workera pochodzi z wartości zapisanej przez rodzica;
przy natychmiastowym zamknięciu telemetrii journal zachowuje przyczynę.
CPU90% pozostaje celem alokacji Fullmaga, nie globalną gwarancją użycia
całego węzła przez wszystkich konsumentów. Regresje Rust pozostają nieuruchomione.

Lokalny checkpoint diagnostyki: 237243e13e665fee237513da480e0e656066615d (5 plików).
Osiem interpretowanych regresji PASS; walidacja realnego zatrzymanego
kontenera Docker PASS bez startu i bez nowych sond. Nie opublikowano
niezweryfikowanego przyrostu adaptive; full runtime/UI/science nadal otwarte.

Live admission jest samplowany także po przyjęciu ostatniego punktu,
a ostatnie zdarzenie puli ma aktualne active/pending counts. Review nie
wykazał ryzyka dodatkowego spawn/indexowania przy pending=0. Jeśli końcowy
pomiar jest niedostępny, raport zachowuje terminal_telemetry_unavailable;
nie tworzy sztucznego CPU/RAM. Przygotowano regresję no_pending_samples,
bez kompilacji. UI review wskazało stale dane podczas invalidation oraz
maskowanie malformed import — poprawki źródłowe są w toku. Wygenerowany
OpenAPI wymaga przyszłego eksportu z nowego managed API i nie jest
ręcznie podmieniany. Browser/runtime pozostają NOT VERIFIED.


### Końcowy checkpoint źródeł UI/API — 2026-10-03

Poprawiono stale zasób etapów: loading/stale/error wygasza dane, a ready
wymaga zgodnych session_id/session_epoch/run_id. Backend publikuje te
identyfikatory z tego samego snapshotu co stage records; wspólny helper
zachowuje dotychczasową semantykę epoch. Brak identity w starym API jest
niedostępnością, nie podstawą do wymyślania identyfikatorów klienta.
Review źródłowe identity/epoch/scope PASS. Regresje API/React przygotowano,
ale zgodnie z zakazem nie kompilowano ani nie wykonywano ich.

Malformed policy import pozostaje błędem: bool/whitespace/zły kształt/
nieznany mode nie stają się domyślnym serial ani liczbą. UI wyjaśnia,
że CPU/RAM/reserve/workers sterują wyłącznie adaptive i następnym runem.
W trakcie kontroli produkcyjnej poprawiono brakującą nazwę zmiennej
w komponencie (używa stageExecution zwróconego już po scope guardzie).

Produkcja TypeScript PASS: 799 plików, zero test/spec, niezmienione hashe
czterech źródeł w trakcie kontroli. Zachowano poprzedni failed wynik.
Dowód: adaptive-ui-scope-production-types-20261003-v2.json w wizualizacjach
wątku. React Doctor 0.9.12, scope changed vs HEAD: exit0, complete=true,
14 źródeł (lint/AST, bez kompilacji testów), brak nowych diagnostyk; brak
sieci i wysyłania telemetrii. Dowód: adaptive-ui-react-doctor-20261003.json.

Generated OpenAPI JSON/types nadal nie zawiera nowych identity/pól
parallel_execution/schematu telemetry. To blocker zgodności kontraktu,
nie naprawiamy go ręcznie. Wymaga eksportu z nowego managed API.
#213 nie zawiera późniejszych poprawek admission ani identity; przyszła
kwalifikacja musi przypiąć nową kapsułę aktualnych źródeł. Nie wykonano
serial/adaptive runtime, nowego browser proof ani pomiaru przyspieszenia.
Pełny cel S00–S12 pozostaje aktywny; dwa punkty ±10 nie są pełną dyspersją.

## S05/S12 — oddzielenie pełnego stosu modalnego CPU, 2026-10-03

[Przyrost zależności CPU](../../audits/2026-10-03-fem-cpu-dependency-stack-remediation.md)
usuwa mieszany wybór CPU MFEM/HYPRE oraz CUDA PETSc/libCEED z konfiguracji
nowego obrazu. 45 interpretowanych regresji preflightu i składnia czterech RUN
PASS. Nie zbudowano obrazu ani nie zmieniono koordynatora/FIFO. Nowy image ID,
receipt, rzeczywisty startup i kwalifikacja ELF pozostają NOT VERIFIED.
Odczyt runnera w tej turze: worker_alive=true, accepting_jobs=true, brak
active jobs, waiting_for_disk, storage_free_bytes=6693638144 < 8 GiB.
Błąd początkowego odczytu Docker był błędem uprawnień sandboxa, nie dowodem
zatrzymania runnera. #213 nadal jest starszą, niezmienną kapsułą.

Checkpoint źródeł CPU: lokalny commit `e0ac047f38410b41c0139fcfe07b383b2ff48621`,
4 pliki, 45 interpretowanych regresji PASS. Indeks po commicie pusty.
Pozostałe zmiany adaptacyjne/API/UI/pilota pozostają w worktree. Nie wykonano
push, merge, nowego obrazu ani runtime; review niezależne tego przyrostu
pozostaje w toku. Ten checkpoint nie zamyka żadnej bramki naukowej.

### Follow-up CPU stack — cztery punkty review

Domknięto źródła wrappera operatorowego, pełne CPU library binding w
producencie/konsumencie atestacji, obsługę disabled macro0 i ponowne
rozstrzygnięcie cache PETSc/SLEPc/MFEM. 47+18 interpretowanych regresji PASS;
CMake NONE cache regression PASS bez kompilacji. Szczegóły w raporcie CPU
remediation. Nowy obraz i managed runtime pozostają NOT VERIFIED; nie
uruchomiono dodatkowych diagnostycznych sond wymagających zgody.

### Checkpoint CPU modal — c8394a502f4326f83808e9cd537fb717a5af6cd5

Domknięto rzeczywisty wrapper obrazu runtime-v2, pełne wiązanie pięciu bibliotek CPU i discovery PETSc/SLEPc, parser makr z wartością 0 oraz invalidation cache CMake. Niezależne review nie znalazło blokującego P1; dwie dodatkowe uwagi także poprawiono (puste listy preloadu CUDA, cache CMAKE_PREFIX_PATH). 47+19+1 lekkich kontroli PASS, bez kompilacji testów. Dowód hash-bound: cpu-modal-stack-followup-20261003-final.json.

Runner zdrowy, zero aktywnych wykonań, waiting_for_disk; 6 656 266 240 bajtów wolnych poniżej 8 GiB. Nie zbudowano ani nie wdrożono nowego obrazu. #213 zawiera starszą kapsułę. Następny krok: operatorowo zbudować i dopuścić nowy obraz przy bezpiecznym zasobie storage, uzyskać receipt runtime-v2 z nową kapsułą, wyeksportować OpenAPI i wykonać serial/adaptive wraz z rzeczywistym browser proof. Pełny cel S00–S12 nadal aktywny; źródłowa poprawka nie zamyka nauki ani integracji.

### Zachowanie pomiarów admission — 2026-10-03

W raporcie adaptive znaleziono utratę danych: deduplikacja porównywała obciążenie CPU i RAM, lecz pomijała cpu_available_cores i worker_peak. Zmiana wolnej mocy w hierarchii cgroup albo nowy peak CPU/RSS mogła więc nie trafić do raportu, choć live callback dostawał próbkę. Wydzielono same_admission_state, który uwzględnia te wielkości; same timestampy nadal są deduplikowane, a limit 2048 zdarzeń pozostaje.

Parser rustfmt PASS; przygotowano regression admission_deduplication_retains_free_capacity_and_worker_peak_changes (timestamp-only, free cores, pojawienie peak, zmiana CPU i RSS). Nie kompilowano ani nie uruchomiono testu Rust. Dowód source-change: adaptive-admission-report-dedup-20261003.json. Przyrost jest częścią niezakwalifikowanego pakietu adaptive, bez osobnego commita oderwanego od zależności. Runner nadal waiting_for_disk (6 649 659 392 B); nowe obliczenia i browser proof pozostają OPEN.

### HPC: nieograniczony przodek cgroup — 2026-10-03

Sampler przypisywał nieograniczonemu przodkowi pojemność leaf affinity i odejmował usage wszystkich jego potomków. Dla alokacji 4 CPU i 12 CPU zużytych przez obce zadania poza affinity dawało to fałszywe zero. Dokumentacja jądra potwierdza, że cpu.stat obejmuje potomków, a cpu.max=max nie jest skończonym limitem. Źródła teraz rozróżniają leaf accounting i przodków z finite quota; konkurencja na przydzielonych rdzeniach pozostaje mierzona przez proc/stat affinity. Wszystkie skończone limity CPU i limity pamięci pozostają obowiązujące. Historia usuniętej quota jest odrzucana; ponowne włączenie finite wymaga nowego okresu pomiaru.

Parser Rust PASS; native regression przygotowana, bez kompilacji/runtime. Źródłowe review wcześniejszej poprawki deduplikacji raportu: bez P1/P2; rozszerzono test także o append, limit 2048, events_truncated i zachowanie pierwszego/najnowszego zdarzenia. Nowe review HPC trwa. Dowód: adaptive-hpc-cpu-scope-20261003.json. Zaktualizowano ADR 0034 zgodnie z semantyką kernel. Brak nowych wyników dyspersji; zdrowy runner nadal waiting_for_disk (6 644 613 120 B).

### Review HPC/admission — 2026-10-03

Niezależne review zakończone: brak P1/P2 dla selekcji domen CPU, zachowania finitequota i wszystkich limitów pamięci oraz resetu historii po zmianie quota. Potwierdzono też bezpośrednią regresję append_admission_event: deduplikacja, 2048 zdarzeń, events_truncated, first/latest. Dowód: adaptive-hpc-cpu-scope-20261003-reviewed.json. Nadal source-only: test Rust niekompilowany, nowy obraz, solver, serial/adaptive i GUI NOT VERIFIED.

### S09: granica typed representation — 2026-10-03

Odebrano niezależny source audit: obecny Python/IR/planner/native ABI 19 nie ma osi/przekroju/reprezentacji waveguide; bounded assembler nie jest produkcyjnym providerem MFEM. Wymagana jest decyzja ProblemIR z ADR 0031. Przygotowano ADR 0035 z konkretną propozycją full_3d | waveguide_2p5d, zachowaniem historycznego K0, signed k, jawnej ramy/przekroju, producer certificate oraz osobnego ownera 2D i per-length norms. Nie aktywowano fikcyjnego publicznego API ani capability. Kontrakt pozostaje proposed/review; format przekroju/ramy/tolerancji i brzegu musi być domknięty przed publicznym kodem.

CPU3D S00–S08 nadal jest pierwszym kamieniem milowym. Runner zdrowy, #213 queued, waiting_for_disk; 6 383 943 680 B wolnych. Nie ma nowych wyników solvera, nowego obrazu ani serial/adaptive/runtime UI proof. Pełny cel S00–S12 zachowany.

Lokalny checkpoint propozycji kontraktu S09: `0ca640b0d94d2ed0171cf7a1b10b19a3c17c41f1`; kontrola 4 odnośników i 10 istniejących ścieżek PASS, staged whitespace check PASS. Review trwa. Kontrakt/owner 2D nie jest zaimplementowany ani dostępny; pełna nauka i integracja pozostają otwarte.

### S09: uszczegółowienie po review kontraktu — 2026-10-03

Review ADR0035 wskazało brak BC, schematu invariance, migracji Γ, normy, frame/k serializacji i topologii. Spec fem-waveguide-spatial-representation-v1 wybiera jawny finite-air Dirichlet model, natural free exchange z osobnym capability guardem, trzy odrębne Γ przypadki, structural_2d certificate z pełnymi immutable input bindings i osobnym equilibrium certificate, frame/signed k/projection errors oraz nowy triangle/edge descriptor. Wspólna tolerance 1e-12 dotyczy geometrii, nie solvera. Zapisano lokalne linki i source hashes; review spec oraz osobna naukowa nota normalizacji trwają. To dokumenty proposed, bez aktywowanego public API/ABI/provider. Pełny S09 i S00–S12 nadal OPEN.

### S06/S09 — spójna skala pól sprzężonego modu, 2026-10-03

Przegląd aktualnej normalizacji ujawnił istniejący błąd pełnego 3D: dense consumer skalował q przez sqrt(max(I,1e-30)), a certyfikat potencjału przez max(sqrt(max(I,0)),1e-30). Dla I=1e-40 skale różnią się o 100000. Wspólny `normalize_complex_mode_and_scale` liczy skalę raz; block consumer również zwraca tę samą skalę. Zero, ujemna/niefinitywna norma, błędny wymiar i overflow znormalizowanych współczynników są błędem, bez sztucznego floor. `mode_phi_*` korzysta z tego samego checked helpera, co zamyka P1 overflow ujawnione w review. Zapisano trzy regresje Rust; nie kompilowano ich. Parser rustfmt PASS, focused map0830 PASS, 35 interpretowanych testów walidatora PASS. Niezależne przykłady odtworzyły rozbieżność i overflow, ale nie wykonują regulatora ani solvera Rust.

Otwarty podpunkt normy: znacząca urojona część q†Mq musi być odrzucona na podstawie error bound wyprowadzonego z rzeczywistych wkładów i liczby operacji dense/sparse. Sam finite check i re>0 nie wystarczają do certyfikatu Hermitowskiej normy. Nie dodano arbitralnego epsilon. Runtime tej korekty pozostaje NOT VERIFIED i wymaga nowej kapsuły po wdrożeniu kompletnego stosu CPU.

Review proposed kontraktu S09 pozostawiło dwa P1 przed authoring/IR: (1) jawny dyskryminator wersji nowego payloadu i migracja obecnego IR0.3.0 z zachowaniem obecności legacy BC, (2) dokładny wire descriptor mesha/regionów/outer-boundary z kompletnym mapping do świata i object_id. Potrzebne także oddzielne nazwy tolerancji frame/collinearity i triangle roundoff. Provider nadal unavailable. Nie promujemy proponowanej noty normalizacji ani bounded oracle do produkcyjnej realizacji. Pełny S00–S12 pozostaje aktywny.

Checkpoint lokalny naprawy wspólnej skali: `b45736bfda2fae3470555b510034f99542506bfa` (6 plików; scoped stage nowej sekcji 0830 zachował wcześniejsze working edits). Re-review zamknęło P1 overflow mode_phi źródłowo; P2 Hermitian roundoff-bound pozostaje OPEN. Bez push/merge i bez kompilacji testów. Nota 0833 i mapa są przygotowane: poprawna continuous tangency do m0, oddzielona nodalna tangency, norma geometryczna P1 z Ti^T Tj, Cartesian nodal max, wspólna skala q/phi/gauge oraz jednostki 2D/3D. Dowód agenta: focused validator exit0, 7 interpretowanych kontroli OK. Nie jest to dostępny provider ani jego runtime. Kolejny krok źródłowy: dokładny wire/version contract S09 oraz błąd normy wyprowadzony z sumowania; bramki obrazu/runtime/OpenAPI/browser/signed DE/BV/COMSOL/zbieżności nadal OPEN.


### Adaptive: aktualny build i próba porównawcza — 2026-10-03

Próba `de-smoke-parallel-probe` nie jest już związana z historycznym jobem #211.
Wymaga jawnego `--probe-build-source-digest <SHA256>` zgodnego z wybranym,
zweryfikowanym managed kontekstem, profilu CPU `fem-cpu-slepc-runtime-v2`
i obecności sześciu źródeł adaptive w niezmiennej kapsule. Oba uruchomienia
serial/adaptive muszą wskazać ten sam job i digest. Model, siatka, equilibrium,
manifest wejściowy i polityka próby zachowują dotychczasowe hashe i parametry.
Historyczny commit modelu jest provenance wejścia, nie wersją runtime.

Naprawiono też brakujący import `PARALLEL_PROBE_VECTORS_RAD_PER_M`: jego użycie
w walidacji po zakończeniu solvera powodowałoby NameError. `_parallel_probe_root`
używa kanonicznego `fullmag_storage.validate_path`, który odrzuca przekierowanie
przez symlink/junction, także w pośrednim katalogu. Regresja symuluje przekierowany
ancestor; nie jest dowodem utworzenia rzeczywistego Windows junction.

Kontrole interpretowane: 13 testów probe + 36 drivera PASS. Zachowany aktualny
wynik 58 testów walidatora wierszy PASS; jego źródło i zależności walidacyjne
nie zmieniły się po tym wykonaniu. Razem 107 kontroli. Próba unittest dla pliku
pytest zgłosiła NO TESTS RAN; następnie właściwe pytest wykonało wszystkie 58.
Review nie wykryło P1; finding P2 dotyczący storage naprawiono. Żaden test
jednostkowy Rust/native/React nie został skompilowany.

#212 zakończył się `succeeded`, exit0. Wstrzymano admission na czas autoryzowanej
aktualizacji obrazu i anulowano wyłącznie własny nieaktualny #213; journal
potwierdza `cancelled`, exit143. Dane obu zadań zachowane. Przed budową obrazu
potwierdzono brak aktywnych jobów, brak worker_error i 14 364 770 304 B wolnych.
Worker nie działa podczas świadomej pauzy; nie oznaczamy tego jako worker_alive PASS.

Uruchomiono `just runner-build-image` z CPU_MFEM_ONLY=1. Bazowy obraz:
`sha256:8a508319a68c4116da81b745fdd1b084015b665d92b36b2241e1e245b5febf89`,
lokalny alias `fullmag/toolchain-pinned:8a508319a68c-adaptive-20261003`.
Docelowy tag: `fullmag/local-runner-build:slepc-cpu-complete-adaptive-20261003`.
Dwie próby zakończyły się przed kompilacją: BuildKit nie obsługuje bridge jako
build network, a surowe sha256 w FROM interpretował jako repozytorium.
Właściwa próba używa network=default i zweryfikowanego lokalnego aliasu.
Build obrazu trwa (sesja narzędzia 82647); hypre CPU rozpoczął kompilację.
Nie ma jeszcze końcowego ID/receiptu obrazu ani aktualnego builda Fullmaga.

Następne kroki: odczytać terminalny wynik budowy obrazu, zweryfikować immutable ID,
skonfigurować runtime-v2 zachowując pozostałe profile, wznowić FIFO i zgłosić
aktualny snapshot ze wszystkimi wymaganymi untracked wejściami. Następnie
wyeksportować OpenAPI, zregenerować klienta, uruchomić identyczne wejścia
serial/adaptive i sprawdzić wyniki, raport procesów, faktyczną równoległość,
zużycie zasobów oraz UI. Kampanijne skrypty plan-only w storage nadal wymagają
aktualizacji wywołania (digest zamiast #211); nie wolno traktować ich jako wykonanego runtime.
Managed runtime, browser proof, przyspieszenie i pełny cel S00–S12 pozostają OPEN.

Re-review poprawki ścieżki: P2 zamknięte, brak nowych P1/P2. Budowa obrazu przeszła hypre i libCEED; konfiguracja PETSc zakończona, trwa kompilacja jego biblioteki. Sesja 82647 pozostaje aktywna; nie ma jeszcze końcowego sukcesu obrazu ani nowego runtime Fullmaga.

## Adaptacyjne wykonanie — wdrożenie pary obrazów, 2026-10-03

Obraz CPU `sha256:7139ca2622b622ca934e53a573372b41c3c2c48b7ba67bc128883b36eb541d6e` zbudowano z kodem po poprawce prefix-based SLEPc (lokalny commit `fc3d8246db2f3f77f830d97a95197222b0a2de02`). Koordynator `sha256:9923f33b147b52b6534a9f2161bf4a00c4b138679575035676bffb52512da0db` zachowuje guard ograniczonych instancji browser oraz pozostałe profile; guard/executor: 26 interpretowanych kontroli PASS. Wymianę wykonano przy pustym aktywnym slocie i wstrzymanym przyjmowaniu. FIFO wznowiono; nie zmieniono kolejności obcych zadań. Runtime-v2 zachował limit buildu 2 CPU/8 GiB.

Nowy build **#216**: `a1d3dfd0c1914c5bb63d0179c113d01b`, digest kapsuły `8dda784a98471ee52e4e09b6cabb00a80bf5eb565c30673f0dd9bbe98b49f960`, snapshot HEAD `fc3d8246db2f3f77f830d97a95197222b0a2de02` z bieżącymi zmianami i jawnymi nowymi źródłami adaptive. Stan przy przyjęciu: queued. Recepta próby wymaga teraz jawnego job_id oraz source_digest zamiast starego nieudanego #211; probe/driver: 49 interpretowanych kontroli PASS.

Budowa obrazu nie dowodzi jeszcze działania Fullmaga ani scheduler parity. Następnie: terminalny receipt #216 i CPU dependency closure, eksport OpenAPI/client, rzeczywiste serial/adaptive z tymi samymi wejściami, raport puli z dowodem równoległości i obciążenia, managed UI/browser. Brak nowych punktów naukowych; pełne S00–S12 pozostają otwarte. Log obrazu i stan przejścia zapisano w wizualizacjach wątku.

## Kontrola raportu adaptacyjnego — checkpoint lokalny, 2026-10-03

Commit `51da8c43b0e3e3f5fc375d269ca9963ac240847b` dodaje wyłącznie interpretowany walidator rzeczywistego ProcessPoolReportV1 i admission journal oraz jego regresje (12 PASS). Kontrola obejmuje bounded JSON, politykę, bindingi, CPU coverage/envelope, zgodność resolved threads i status wykonania. Timestamped active_workers≥2 dowodzi wyłącznie chwilowej współaktywności procesów schedulera; nie dowodzi overlap EPSSolve ani speedup. Bezpośredni raport nie zawiera terminal_state, więc wymaga osobnego powiązania z zakończonym execution — nadal OPEN. Serial może nie emitować raportu puli; porównanie częstotliwości/mesh/equilibrium korzysta z rzeczywistych artefaktów benchmarku, bez syntetycznego serial reportu.

#216 pozostaje queued za #214/#215 według ostatniego odczytu. Nowy commit jest hostowym narzędziem analizy po przechwyceniu kapsuły; nie zmienia przypiętego HEAD/digestu ani źródeł natywnego buildu #216. Brak nowych punktów solvera, kwalifikacji adaptive i browser proof. Wykryty HTTP500 pełnej historii dotyczy starszego /jobs; stronicowane /api/v1/jobs działa. Klient CLI pełnej historii wymaga osobnej korekty, bez zwiększania limitów odpowiedzi.


### 2026-10-03 — priorytet użytkownika: adaptacyjna kampania i rzeczywiste punkty

Brak nowych wyników: na dotychczasowym wykresie pozostają dwa zaakceptowane punkty ±10 rad/µm. Przygotowany backend puli nie jest jeszcze dowodem równoległego wykonania. Dotychczasowy zewnętrzny kontroler signed15 wykonywał pojedyncze piloty seryjnie; został zastąpiony nową trasą jednej grupowanej ścieżki.

Model `71ba0d18225ffcc83f7f18e676de8dc051e87fd1` definiuje 15 punktów DE: −25, −20, −15, −10, −7, −5, −2, 0, 2, 5, 7, 10, 15, 20, 25 rad/µm. Jawne `--parallel-mode adaptive` uruchamia publiczną pulę; limit CPU 90%, RAM 80%, rezerwa 1 GiB, jeden wątek na proces i dobór liczby procesów przez pomiary. Sterownik wiąże wersję modelu i digest buildu; wynik ma zawierać rzeczywisty raport puli z SHA256. Nie rozluźniono residualu 10⁻⁸ ani kontroli demag przy Gamma. Lekkie kontrole: 52 sterownika/probe, 4 modelu oraz 59 kontroli wierszy PASS.

Build #216 (`a1d3dfd0c1914c5bb63d0179c113d01b`) jest aktywny; jego kontener rozpoczął pracę o 04:51 UTC. Jednorazowy kontroler (sesja 34636) oczekuje na sukces i weryfikację receipt; następnie uruchomi `signed15-adaptive-v1` w kanonicznym storage. Pierwsza próba kontrolera zakończyła się przed wywołaniem solvera; poprawiona v2 sprawdza stan przez API i nie powiela buildu. Symulacja i nowy wykres pozostają OPEN.

Kontynuacja: terminalny build → rzeczywiste 15 próbek → kontrola artefaktów i pomiarów puli → wykres scatter oraz analityka → oddzielny parytet serial/adaptive i dowód GUI. S09/2.5D zachowano jako WIP poza kapsułą #216; parser/review nie dowodzą kompilacji ani runtime. Pozostałe S00–S12, zbieżność, COMSOL, GPU i integracja PR #97 pozostają otwarte.

Checkpoint źródeł: commit `c1ec5c797730430d95738912260017cc5417f9d7` obejmuje 11 skryptów/testów kampanii, bound receipt, serial/adaptive parity i generatora. Review korekt P1/P2 oraz helpera cleanup PASS. 153 testy interpretowane +60 subtests PASS; kompilacji unit tests nie wykonywano. Commit nie zastępuje wykonania #219 i nie zmienia jego modelu/digestu. Nie wykonano push/merge; wymagane bramki runtime/UI/nauki pozostają otwarte.

### Powtarzająca się blokada storage — 2026-10-03, 05:42 UTC

Job #219 nadal queued; runner healthy, active_job_ids=[], waiting_for_disk. Wolne 8 071 225 344 B wobec minimum 8 589 934 592 B. Ten sam warunek utrzymuje się trzeci kolejny raz. Źródła kampanii zapisano w c1ec5c797730430d95738912260017cc5417f9d7; wymagane wykonanie solvera, eksport OpenAPI i GUI nie mogą być uznane za zaliczone. Rejestr worktree: blocked; pełny zakres S00–S12 pozostaje niezakończony. Obserwator 75831 i renderer 11268 są potwierdzone live; nie ponowiono ani nie anulowano joba. Następny krok wymaga zewnętrznego zwolnienia miejsca lub jawnej zgody na dokładne katalogi execution, po ponownych kontrolach bezpieczeństwa. Read-only lista kandydatów #209/#206/#196: 911 641 541 B, brak aktywnych mountów, niczego nie usunięto; taki odzysk przekracza próg admission, ale nie dowodzi wystarczającej pojemności dla szczytu buildu. PR97 i integracja nadal OPEN.

### Zwolnienie miejsca i wznowienie FIFO — 2026-10-03, 09:13 CEST

Operator zgłosił zwalnianie 20 GB. Health runnera potwierdza 11 433 320 448 B wolnych (około 10,65 GiB), ponad próg 8 GiB. Bieżący stan kolejki: #218 running, #219 queued, #217 blocked. Worker_alive=true, accepting_jobs=true, worker_error=null. Poprzednia blokada storage przestała blokować admission; rejestr worktree ponownie active. Uchwyty 75831 i 11268 są live. Nie zgłoszono nowego joba ani nie zmieniono FIFO; model, digest i wyjście kampanii #219 zachowane. Nowych punktów i wykresu nadal brak. Przekroczenie progu nie dowodzi wystarczającego miejsca dla szczytowego zużycia buildu. Następny krok: terminalny sukces #219 i rzeczywista kampania signed15.

### Autoryzowane sprzątanie starych wykonań — 2026-10-03

Po jawnym zleceniu operatora usunięto wyłącznie execution nieudanych jobów #184/#185/#186/#194/#196/#206/#209, razem 2 129 378 727 B plików. Dry-run sprawdził matching job/journal/owner/source, stan terminalny, brak pin, containment i brak reparse; bezpośrednio przed usunięciem ponownie sprawdzono procesy hosta, zatrzymane kontenery i brak aktywnych mountów tych execution. Artefakty, logi, journal, kapsuły źródeł, cache oraz wyniki solvera zachowane. Receipt: authorized-storage-cleanup-20261003-receipt.json w wizualizacjach wątku. Wolne po operacji: 24 631 119 872 B; różnica wolnego miejsca obejmuje też równoległe zwalnianie danych przez operatora, więc nie jest miarą odzysku wyłącznie tej operacji. #219 nadal queued; nie zgłoszono kolejnego joba.

### Weryfikacja oczekiwania za #218 — 2026-10-03, 10:11 CEST

#218 jest rzeczywiście live: kontener e7eae2be9f8a, native-build exit0, trwa frontend-dependencies. Odczyt Docker: CPU13,58%, RAM554,7MiB/8GiB; brak ingerencji w obcy job. #219 nadal queued z tym samym digestem; wolne 24 147 927 040 B. Obserwator 75831 zakończył się terminalnym dwugodzinnym timeoutem bez zgłoszenia/anulowania joba. Wznowiono wyłącznie obserwację jako v4/uchwyt64900 z ośmiogodzinnym limitem, tym samym modelem i katalogiem wyjścia; renderer11268 pozostaje live. Nie restartowano buildu ani symulacji. Brak nowych punktów. Po sukcesie/atestacji #219 nadal ma nastąpić kampania15 → walidacja → rzeczywisty wykres → parytet i GUI.

### Korekta powiązania obserwatora wykresu z kampanią

Obserwator11268 śledził historyczny signed15-controller-v2.json, zamiast aktualnego v4; nie wykryłby terminalnego błędu obecnej kampanii. Po potwierdzeniu dokładnego procesu54376, stanu waiting_for_actual_result i braku run-result/renderu zatrzymano wyłącznie ten własny obserwator. Uchwyt11268 potwierdził terminal exit1. Nowy obserwator55231 czyta signed15-controller-v4.json; AST i kontrola zachowania samego wyjścia oraz wymogu completed_unqualified/return0 PASS. Generator, tolerancje, job/digest, solver i FIFO bez zmian. Kontroler64900 pozostaje live; #219 nadal queued za live #218 (frontend-dependencies, odczyt CPU15,03%). Nie powstał nowy wykres ani nowe punkty solvera.


## Aktualny checkpoint S06/S05/S12 — 2026-10-06

Historyczne P2 przy sekcji „S06/S09 — spójna skala pól sprzężonego modu” jest
**zamknięte źródłowo** przez commit `81cb6bcb475112aa1abe8bcc9e5e9128e5486351`.
`eigen_normalization_metric.rs` sumuje rzeczywiste wkłady dense/sparse i rozszerza
przedziały po każdej operacji przez next_down/next_up. Consumer wymaga dodatniej
dolnej granicy normy i przedziału części urojonej zawierającego zero. Nie stosuje
arbitralnego epsilon; overflow, FTZ/DAZ i niepewny znak są odrzucane. Wspólna
skala q/phi oraz różne jednostki norm 2D/3D pozostają zachowane. Regresje Rust
oraz dokładny oracle Fraction są zapisane; ten checkpoint nie jest sam w sobie
dowodem ich wykonania ani poprawności całej macierzy assembly.

Managed runtime #233 dał dwa zaakceptowane punkty DE dla ±10 rad/µm:
11.205285324453774 i 11.205285254423218 GHz. Różnica wynosi około 70.03 Hz;
odchylenie od referencji thickness-oracle N32 wynosi około -0.205%. Residuale
magnetyczne/potencjału przeszły niezmienione bramki. Są to wybrane mody,
`completed_unqualified`; dwa punkty nie zamykają dyspersji, zbieżności ani GUI.

Pierwszy adaptacyjny sweep #233 odrzucono na kontroli digestu workera. Commit
`888be1c223d851aa4af1f1365f1e7cf3fc3106b9` kanonizuje kolejność kluczy map
w digestach rodzica i workera, zachowując kontrolę integralności planu i stanu.
Regresje workerów przeszły GitHub Actions 37385900573. Build #234 ma ten dokładny
SHA i digest kapsuły a8aa1b32c194a44fe54b26008d2c04a4a9d0584341f164c161a1862a71e68370.
Kontener zakończył się exit0; przy obserwacji 23:11 UTC koordynator nadal wskazuje
running, dlatego dispatch signed15 czeka na terminalny sukces oraz walidację
receiptu. Nie ponowiono ani nie anulowano joba.

Branch zawiera master `1bdb48274050e66aabcb490b52873c5b9cc02f98` przez merge
`5e2d2e205feb089f7d62290b8013895412eeea98`, wypchnięty na remote. CI ma zielone
Python/API/browser-fixture/Windows-volatile/FDM; Control Room ma jeden błąd
ScratchAuthoringInspectorStability po ACK materiału (odczyt undefined.Aex).
Trwa diagnoza kontraktu odpowiedzi; Rust jeszcze wykonywany. PR #97 pozostaje
bez merge. Pełne S00–S12, signed15, serial/adaptive, DE/BV/convergence, COMSOL A1,
GUI, produkcyjny provider S09 i kwalifikacja GPU pozostają otwarte.


### Terminalny build #234 i rozpoczęcie signed15

Koordynator potwierdził #234 `succeeded`, exit0. Kontroler 59878 zakończył
export-runner-openapi i dry-run z kodem0 oraz uruchomił rzeczywisty signed15.
Wyjście: `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/4ea6f05931f045a3a644a3c424cc1da2/comsol-dispersion/097dc22ea59f4c2b89553cc0eba63fa3`.
Kontener `fullmag-dispersion-5c8c23188a54738dd9ef9d50442f2733` jest live;
proces fullmag-bin wykonuje natywny FEM CPU, a log potwierdza etap relaksacji.
Brak jeszcze terminalnego rezultatu sweepa ani dowodu przyspieszenia.

CI 37385900573 ukończone: API Rust 977 PASS / 0 FAIL / 3 ignored, w tym
historyczny test coupled M3. Dwie pozostałe blokady mają konkretne przyczyny:
(1) mock material ACK bez obowiązkowego `properties`, odczytywanego podczas
rebase Inspectora; (2) fixture certyfikatu CLI bez nowego pola
`max_h_anisotropy_difference_a_per_m`. Poprawki obejmują wyłącznie fixtures:
pełne SI properties zgodne z edycją oraz None dla istniejącego certyfikatu v1
bez Ku. Asercje stabilności/fokusu/scroll/draftów pozostają bez zmian.
Kontrola diff i parser Rust PASS; wykonanie regresji wymaga następnego CI.
Nie wykonywano lokalnych testów ani ich kompilacji.


### Wynik pierwszego sweepa #234 — korekta kalibracji przy kończeniu workera

Signed15 zakończył się exit1 przed ukończeniem całej ścieżki. Pierwszy worker
(sample_index=1) zwrócił ok=true i autentyczny terminal getrusage: RSS358105088 B,
CPU1.0534538148971548 cores. Journal zachował345 poprawnych interwałów próbkowania
przez34.782354057 s, sampled CPU peak1.1933280551107535. Parent mimo tego trwale
zamknął telemetrię po błędzie „worker memory high water mark unavailable”.
Poprawka digestu zadziałała w rzeczywistym workerze; pełna pula nadal nie ma PASS.

Kod czyta stat i status oddzielnie, następnie sprawdza try_wait. Wynik jest zgodny
z przejściem procesu do zakończenia, kiedy VmHWM może zniknąć przed potwierdzeniem
waitable exit. Chwilowego status nie utrwalono, więc nie deklarujemy dowodu jego
konkretnego stanu. Naprawa w toku: odrębny stan oczekiwania na reconciliację,
zamknięcie nowych admissions podczas tej niepewności, ograniczony deadline,
pełna walidacja terminal response i rzeczywistego ru_maxrss przed kalibracją.
Inne błędy telemetrii pozostają fail-closed. Nie przyjmujemy RSS=0, nie obniżamy
limitów, nie uruchamiamy cichego serial fallbacku. Kontener próby jest nieaktywny;
artefakty i błędny wynik zachowano. Nowego sweepa jeszcze nie zgłoszono.

Dwie korekty fixtures i poprzedni checkpoint wypchnięto w HEAD
`a1f8cb094dd8043e275b328e42076b6ee805a905`. Następne CI jest uruchomione.
Pełny cel pozostaje aktywny; terminalny build nie zastępuje wyników całego sweepa.


Kolejne CI37387643334 potwierdziło przejście od undefined.Aex do jawnego błędu
braku potwierdzenia parametrów po assignment ACK. Druga fixture odpowiedź
`assignedScene` nadal usuwała materials (scene helper miał pustą listę).
Uzupełniono również tę odpowiedź o ten sam utworzony materiał i SI properties,
z aktualną revision oraz przypisaniem object-a. Nie osłabiono asercji Ku1 draft
ani production rebase guard; potwierdzenie wymaga jeszcze kolejnego CI.


### S09 — doprecyzowanie compiler bindings po przeglądzie rejestrów V04

Surowy region_id przekroju jest odrębną przestrzenią identyfikatorów od
ObjectRegionIR. Należy dodać jawny mapping section region -> RegionRefIR
(object_id oraz opcjonalny region_id; None oznacza cały obiekt). Materiały V04
są indeksowane MaterialIR.name; magnetyzm wynika z MagnetizationModuleIR oraz
zgodnego ObjectMaterialAssignmentIR, nie z object_type/nazwy. Air nie ma
magnetic MaterialIR ani wariantu obiektu Air; musi mieć rzeczywisty object_id
oraz dowód braku magnetization na wskazanym pokryciu. Nie wybieramy pierwszego
z nakładających się regional/whole-object assignmentów.

Następny przyrost source: złożyć problem.validate() oraz istniejące kontrole
contours -> embedding -> elements/incidence; zachować sprawdzoną mapę
triangle -> scalar component, którą obecne summarize_scalar_components wyrzuca.
Walidacja Dirichlet ma wiązać wybrane boundary_component_id wyłącznie z
one-owner exterior air half-edges i sprawdzić faktyczny anchoring każdego
komponentu. Dodatnie external_air_edge_counts same w sobie nie dowodzą
wybranego anchoring. Descriptor pozostaje prywatny, z niepodrabialnym validated
wynikiem i fingerprintem dokładnych danych/frame/polityki. Nie jest certyfikatem
structural invariance ani dostępnością providera. Typed V04/routing, fields/BC,
accepted equilibrium, MFEM2D i wszystkie bramki naukowe nadal są wymagane.


### Bezpieczeństwo loggera Gmsh — 2026-10-06

CI37388197050 (HEAD469f964414) potwierdziło Control Room i browser fixture PASS.
Python meshing suite zakończyło się SIGSEGV139 w
`test_multi_object_sizing_cylinder_and_waveguide`; nie zapisano native stack.
Oba porównywane CI używały Gmsh4.15.2, więc nie potwierdzono driftu zależności.

Przegląd odkrył konkretny wyścig: `_GmshProgressLogger._poll` odczytywał
logger.get podczas mesh.generate, a timed join pozwalał zatrzymać/finalizować
logger z wciąż żywym observerem. Oficjalny [kod Gmsh4.15.2](https://github.com/gmsh-project/gmsh/blob/gmsh_4_15_2/src/common/gmsh.cpp)
chroni writer apiMsg przez critical, lecz kopia _log w get nie używa tej samej
synchronizacji. To uzasadnia naprawę wyścigu; nie dowodzi, że właśnie on wywołał
zaobserwowany crash bez stosu.

Observer emituje teraz tylko Python heartbeat z rzeczywistym elapsed time,
bez wywołań Gmsh i bez wymyślonego procentu. Owner czeka na zakończenie observera,
czyta log po natywnej fazie i zawsze wykonuje logger.stop w finally. Trwale
zablokowany progress sink może opóźnić cleanup; nie wolno wtedy finalizować
wokół żywego observera. Parametry/algorytmy/quality assertions siatki nie zmienione.
Dwie znaczące regresje wykrywają foreign-thread/native read podczas generowania
oraz przedwczesny cleanup blokowanego observera. AST i diff PASS, niezależne
source review bez istotnych uwag. Regresje i dokładny OCC test oczekują na CI;
źródłowa naprawa nie jest kwalifikacją siatki ani dyspersji. Dodatkowa diagnostyka
faulthandler w następnym CI ma zachować stos ewentualnej awarii.


### S09 — zachowanie sprawdzonej mapy komponentów

`WaveguideMeshIncidenceReport` zachowuje scalar_component_by_triangle z
istniejącego traversal, zamiast wyrzucać tę mapę. Getter/serialized report
nie nadają BC/admission. Nowa regresja waliduje pełną incidence dwóch
rozłącznych domen: membership0/1, exterior-air counts[12,0] oraz serializację;
druga domena zawiera zamkniętą wyspę air. Parser Rust i niezależne review PASS,
bez lokalnych testów/kompilacji. Wykonanie regresji w GitHub Actions otwarte.
To prerequisite registry/Dirichlet bindings, nie ukończony descriptor ani S09.
Wybranie/powiązanie essential nodes, registry target mapping, fingerprint,
structural/equilibrium certificates oraz MFEM2D nadal wymagają implementacji.


### Scheduler — typowana reconciliacja końca procesu

Sampling ma teraz osobny WorkerSampleError::ProcessExitRace dla braku VmHWM
lub NotFound wyłącznie na własnych /proc/<pid>/{cgroup,stat,status}. Błąd
/proc/self/cgroup, inny cgroup/PID, parse/units/overflow pozostają Other i
zamykają admission. Parent najpierw sprawdza try_wait; zakończonego procesu
nie próbkuje. Niepewność aktywnego procesu zachowuje pierwszy monotonic deadline
30s, wstrzymuje nowe admissions i utrzymuje dotychczasowe peaks/identity.
Świeży poprawny pomiar lub confirmed exit + pełna walidacja response/identity/
artefaktów i dodatni finite terminal CPU/RSS rozstrzygają przejście. Kalibracja
zachowuje max sampled/terminal RSS; nie wprowadza zera ani current-RSS fallback.
Cancellation/reaping zachowane. Timeout jest konserwatywny i obejmuje również
walidację artefaktów; wolna walidacja może być odrzucona, bez osłabienia guardu.

Parser trzech plików Rust, diff i niezależne review PASS. Regresje przejść,
nieodnawianego deadline, invalid/missing peak oraz rzeczywistego Linux
worker-owned proc NotFound są zapisane. CI dodaje k_process_pool,
adaptive_resources i waveguide_mesh; meshing ma faulthandler. Testów lokalnie
nie kompilowano ani nie uruchamiano. Wymagany kolejny immutable build/runtime
adaptive; helper regressions nie dowodzą całej pętli procesów.

CI37389228028 dla ab4955abb: Python meshing295 PASS, w tym dokładny wcześniejszy
OCC case i dwie nowe regresje loggera. Control Room/browser/API również PASS.
Rust wykazał dwa sporadyczne błędy: restore spin_cache_identity500 zamiast400
oraz izolowany reopen SessionStore z writer busy. Rooty fixture mają PID+nanos;
nie potwierdzono ENV collision. Przyczyna oczekuje na body/stage/lock diagnostykę,
bez blanket retry/serializacji ani usuwania walidacji identity.

Osobno uruchomiono wymagany serial reference signed15 na runtime234, z identycznym
modelem/ref/solver controls i jawnym parallel-mode serial. To nie zastępuje
nieudanego adaptive ani jego dowodu. Uchwyt80293 i kontener
fullmag-dispersion-60db3c9d49a9a30192955a3f565592fc potwierdzone live; native FEM
wykonuje kolejne solve. Wyjście kończy się UUIDefb6cd49bf8e4cd6bc0366b65c315628.
Nie ma jeszcze terminalnych15 zaakceptowanych wierszy ani parytetu.


### Trwałość writer lease — poprawka hazardu i diagnostyka API

W `WriteTransaction::drop` samo zamknięcie własnego descriptoru nie musi zwolnić
Linux flock, gdy ten sam open-file-description ma clone/inherited descriptor.
Wynika to z [flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html) i
kontraktu [File::unlock](https://doc.rust-lang.org/std/fs/struct.File.html#method.unlock).
To potwierdzony hazard lifetime, zgodny z obserwowanym StoreWriterBusy; dokładna
przyczyna obu sporadycznych błędów CI nadal nie jest udowodniona.

Release własnego tokenu przy depth=0 jawnie unlockuje File przed zamknięciem.
Nested lease nie zwalnia blokady; błąd unlock zachowuje descriptor i sentinel
odrzucający następne acquire. Nie usuwa lock inode, nie przejmuje obcego tokenu
ani nie używa PID/age do recovery. Linux regression z try_clone sprawdza
exclusion podczas nested/outer lease, zwolnienie po outer drop przy żywym
clone oraz brak zwolnienia nowego właściciela przez późniejsze zamknięcie clone.
Source review i parser PASS; unlock-error sentinel nie ma oddzielnej fault
injection regresji. Wykonanie CI pozostaje wymagane.

Fixture restore zachowuje status400 i wszystkie no-mutation assertions,
lecz błąd wypisuje bounded64KiB body i root. Coordinator opens mają stage/root
context. Nie dodano retry ani globalnej serializacji testów. CI ma focused
fullmag-session --lib writer gate, oprócz istniejących API/CLI kontraktów.

Pierwszy submit kolejnego buildu ebc3edfdb odrzucono lokalnie StorageBusy przed
przygotowaniem kapsuły; nie utworzono joba. Serial15 pozostaje rzeczywiście live.
Jednorazowy kontroler75798 czeka na jego terminalny stan i wtedy zgłosi exact
SHAebc3edfdb837f81dceeff436f67400bb67c1560a z tym samym request key. Ta kapsuła
nie obejmuje późniejszej poprawki writer; kwalifikację każdej wersji raportujemy
oddzielnie. Nowego numeru joba/receiptu nie ma jeszcze. Nie restartowano sweepa.


### Aktualizacja oczekującego buildu i wynik CI070d

Przed source capture zatrzymano wyłącznie własny observer97828/uchwyt75798,
po sprawdzeniu dokładnej command line, creation time, fazy waiting i braku
submit log/job. Serial solver pozostał live. Zachowano poprzednie źródło/state
oraz supersession receipt. Nowy jednorazowy observer28749/ PID84692 ma exact
commit070d277a8f01cb86795bb3e8e69872cc2d73c91f i nowy request key, obejmujący
również poprawkę writer. Czeka na terminalny serial reference; nie ma jeszcze
job ID ani udanego submit. Nie zmieniono źródeł istniejącego runtime234.

CI37392644899: deterministyczne worker contracts PASS, nowy k_process_pool gate
PASS (10), adaptive_resources PASS, nowy disconnected-components regression
PASS. Waveguide mesh gate ma39 PASS/1 FAIL: istniejący
positive_length_collinear_overlap_is_rejected oczekuje konkretnej klasyfikacji
CollinearEdgeOverlap. Trwa ustalenie ścieżki walidacji/fixture; nie osłabiono
odrzucania błędnych meshów. Następne Rust writer/API kroki są SKIPPED, więc nie
stanowią dowodu PASS. Control Room, browser, Python, generated API i pozostałe
bramki bootstrap PASS. Pełne CI, runtime adaptive i nauka pozostają otwarte.

Serial15 ma nadal aktywny native solve. Log po siedmiu completion events
przeszedł do Γ frequency-window refinement, subwindow30/50, window_s1735.7.
Te zdarzenia nie są zaakceptowanymi finalnymi rows. Zapisano rzeczywisty postęp;
nie restartowano obliczeń z powodu długości przebiegu ani nie zmieniono tolerancji.


Source-order diagnosis testu overlap: elementy/incidence są poprawne, lecz
stary apex drugiego trójkąta(2,-1) ustawia AABB jego ukośnej edge4 przed base
edge3. Najpierw edge0/4 daje EdgeContactWithoutSharedNode (endpoint na obcej
krawędzi), zanim detector sprawdzi collinear overlap0/3. Test zmienia apex na
(5,-1), jawnie sprawdza poprawność element/incidence i dokładny overlap pair0/3.
Nie zmieniono produkcyjnej walidacji ani nie poszerzono assertion o dowolny błąd.
Parser i diff PASS; CI ma potwierdzić tę korektę oraz wcześniej skipped writer/API.


### Zielone bramki źródeł b08500ae02 — 2026-10-06

GitHub Actions bootstrap37394599087 zakończył się success dla
b08500ae02d73b353f78f9c56868057fbbb76e6c. Wszystkie jobs PASS: Rust,
Control Room, browser fixture, Python, generated API, Windows volatile,
FDM qualification i API hygiene. Rust obejmuje nowe kpool/adaptive_resources,
waveguide mesh (w tym poprawiony overlap i component lookup), writer lease,
application oraz quantity/API/CLI gates. Nie zastępuje to managed runtime,
rzeczywistego GUI, GPU ani walidacji naukowej S00–S12.

Oddzielny controller73417/PID106356 czeka na terminalny serial reference.
Generuje wykres PNG/PDF dopiero po completed_unqualified/return0, zgodności
modelu/runtime, hashów wszystkich required artifacts, row-preflight PASS
oraz dokładnych15 wektorach. Żaden FEM punkt nie powstaje przez odbicie lub
podstawienie analityki. Porównanie używa istniejącego thin-film thickness oracle
N32; render wymaga jeszcze wizualnego review. Jeśli solve zawiedzie, kontroler
zachowuje błąd i nie tworzy wykresu.


### S09 — prywatny registry binding i aktualny runtime, 2026-10-06

Dodano pożyczony, opaque fragment compiler bindings w
`crates/fullmag-ir/src/waveguide_mesh_bindings.rs`. Wiąże exact raw region targets
z V04 object/region/material/assignment/module i odrzuca niepokryte moduły,
niejednoznaczne providers, obce/disabled regiony oraz magnetyczny air.
Składa istniejące geometryczne validators. Nie aktywuje structural_2d ani
production admission; regionalne pokrycie/precedence, frame/world mapping,
Dirichlet anchoring, invariance/equilibrium, routing i MFEM owner pozostają OPEN.

Nowe regresje są objęte istniejącym CI filter waveguide_mesh. Lokalnie nie
uruchamiano ani nie kompilowano unit tests. Review/parser i wykonanie nowego CI
należy raportować oddzielnie; source fragment nie jest ukończonym S09.

Obserwacja bieżącego serial15: kontener
fullmag-dispersion-60db3c9d49a9a30192955a3f565592fc rzeczywiście Up, Γ frequency
window refinement41/50, window_s3522.2. Kontrolery kolejnego managed buildu
PID84692 i wykresu PID106356 mają potwierdzone procesy z właściwą command line.
Brak terminalnego signed15 produktu. Nie ponawiano ani nie restartowano solvera.
Kolejny build nadal czeka przed submit na zwolnienie worktree lease i będzie
przypięty do070d277a8f01cb86795bb3e8e69872cc2d73c91f; nowy fragment S09 nie jest
częścią tej kapsuły. Pełny S00–S12 pozostaje aktywny.

Niezależny source review prywatnych bindings bez blockerów. Dodano także jawne
odrzucenie regional-provider -> whole-object oraz niezgodnych regional targets,
z osobnym sprawdzeniem poprawności ProblemIR w obu fixture. Rust parser/format
PASS; git diff whitespace PASS. Wykonanie regresji w nowym CI pozostaje OPEN.


CI37397140598 odrzuciło f5f57f1de podczas kompilacji: pierwszy wiersz nowego
pliku Rust był nagłówkiem ścieżki z rustfmt --emit stdout. Wcześniejszy parser
sprawdzał wejście formattera, nie jego później zapisane wyjście; deklaracja
PASS nie dowodziła poprawności finalnych bajtów. Usunięto wyłącznie nagłówek,
formatowanie przełączono na stdin bez file heading i ponownie sparsowano
rzeczywiście zapisany plik. Parser finalnych bajtów PASS; nowe CI wymagane.
Runtime234 i oczekująca kapsuła070d nie zawierają tego fragmentu S09.


### S09 — jawne finite-air Dirichlet bindings

Prywatny validator waveguide_mesh_dirichlet wiąże żądane exact boundary IDs
z tym samym pożyczonym registry mesh. Dopuszcza wyłącznie Air/Outer/one-owner,
wyznacza deterministic essential node union i odrzuca każdą niezakotwiczoną
składową skalarną. Powietrze na interfejsie nie otrzymuje Dirichleta; marker outer
nie zastępuje sprawdzenia incidence. Przygotowano sukcesy/odrzucenia i dwie
rozłączne domeny z porównaniem kolejności selekcji. Parser zapisanych bajtów
PASS; lokalnych testów nie wykonano. Review i CI raportowane osobno.

To następny prerequisite S09, bez publicznego authoring/admission/provider.
Kolejne zależności: frame/world representability i exact fingerprints,
pełne regional coverage/precedence oraz structural invariance i equilibrium,
atomowy typed routing i natywny owner MFEM. Sweep15 i poprawiony adaptive runtime
pozostają odrębnymi aktywnymi bramkami; pełny S00–S12 nadal OPEN.

Niezależny review Dirichlet bez blockerów. Dopisano bezpośrednią regresję
Air/Outer na interfejsie two-owner, oprócz air-hole. Parser finalnych bajtów PASS.
CI37397452595: produkcyjna kompilacja IR i generated API/FDM PASS; Rust unit
compile odrzuciło fixture E0505 (borrow object_id i move target w jednym call).
Poprawiono target.clone, bez zmiany zachowania walidatora. Python meshing:
295 testow, 1 failure i 1 skip; density test oczekuje median<=5nm, zaobserwował
14.719nm. To osobny wymagający diagnozy problem, bez zmiany progu/skip/retry.

Serial runtime234 zakończył się exit1: Gamma shared-domain Schur frequency
window_subwindow_failed. Kontener potwierdzony absent, state terminal
failed_preserved_review_required; niepełny sweep nie jest zaakceptowanym
produktem. Kompletny structured diagnostics JSON zachowano poza checkoutem.
Plot nie jest generowany dla błędu. Observer następnego buildu przeszedł do
submitting_once; numer/jobID/receipt wymaga odczytu, bez ponawiania submit.


CI37398052818: Python295 PASS oraz frontend/browser/API/FDM/Windows PASS.
Rust unit compile zgłosił E0433: w nowej regresji union użyto BTreeSet bez importu
w lokalnym module tests. Dodano jawny import (scope produkcyjny miał go osobno).
Nie zmieniono asercji ani walidatora. Parser finalnego Rust PASS; wykonanie
regresji w następnym CI nadal wymagane.


### Γ frequency-window — większa przestrzeń Kryłowa, hipoteza do runtime

Dokładny diagnostics234: 43/50 subwindows zakończone, siedem EPS reason-1 po2000
iteracji; w failed podoknach zero odrzuceń original-descriptor residuals.
Window certificate zachował rank1 mod9.299249697GHz, lecz perturbation_result
pass_incomplete; to nie jest zaakceptowany punkt ani pełny sweep. Diagnoza
źródłowa potwierdza pełny window kontrakt mimo requested_mode_count1.

Przyrost zmienia wyłącznie window NCV z2NEV na4NEV (bounded wymiarem): base8→16,
refined16→32; standalone shifts zachowują2NEV. NEV, MPDdefault, tolerancje,
restart8,50podokien i acceptance/certificate bez zmian. Actual queried
NEV/NCV/MPD nadal publikowane. Polityka certificate jest jawnie v2. Nota0831
z równaniem/SI/mapą źródeł poprzedziła zmianę kodu. Focused doc validator PASS,
37 diagnostic printf calls PASS, niezależny review bez blockerów. Native unit
regressions zmienione, ale nie kompilowane lokalnie; skuteczność NOT VERIFIED.

Build235 queued na070d pozostaje starą polityką. Poprawkę musi objąć osobna
immutable kapsuła i controlled Γ runtime przed ponowieniem pełnego signed15.
Stan disk guard:5.46GB przy wymaganych8GiB; operator pytany o dodatkowe miejsce.
Nie osłabiono guardów i nie ponowiono nieudanego solvera.


### Regionalne zagęszczenie — zachowanie niezależnego ownera

Audit density fixture ujawnił dwa błędy: deklarowana recepta waveguide20/5nm nie
była przekazywana, a _strip_overridden_geometry_fields usuwało również pola
Source=region_mesh_policy tej geometrii. Przywrócono istniejącą receptę i
zachowano region-owned fields podczas zastępowania bulk. To realizuje kontrakt
0104 material-regions-implementation-mapping i zakaz cichego porzucenia regionu;
nie zmienia wsparcia geometrycznego, fizyki, region shape ani progu median5nm.

Nowa regresja generuje rzeczywisty field stack i sprawdza usunięcie bulk,
zachowanie tego samego pola regionu3nm/radius15nm/height10nm oraz foreign field,
włącznie z aliasem geometry name. Density fixture wymaga applied bulk20nm i
applied region3nm w resolved report oraz dotychczasowej gęstości actual mesh.
AST obu plików i diff review PASS; wykonanie296-test meshing gate w CI wymagane.
Globalny hmin i odkrywanie całkowicie wewnętrznego małego support nie zmienione;
pozostają przedmiotem diagnozy, jeśli właściwe pola nie dadzą wymaganej siatki.
Poprzedni CI Python sukces nie zamyka tego produkcyjnego defektu.


### Próba Γ i dowody realnego zagęszczenia — dalsza kwalifikacja

Dodano opcjonalny expected_window_krylov_policy do istniejącego postprocessora
Gamma: exact label, queried NEV/NCV/MPD w każdym zaplanowanym podoknie oraz
zgodność z requested dimensions i bounded polityką. Brak parametru zachowuje
historyczny query-only kontrakt. Nowe mutation regressions i CI gate obejmują
brak/failed query, stary label/basis, wrong queried NCV i invalid MPD. Nie nadaje
kwalifikacji fizycznej; AST, source review i focused scientific map PASS.
Kontrolowana recepta k0 zachowuje okno8.5–16GHz i modelba0045fef; nie podstawia
węższego standalone default8.5–12GHz. Nowego runtime/probe jeszcze nie uruchomiono.

CI37399201738: zachowanie regionalnego field działa (applied20/3nm assertions
PASS), ale actual median cylinder edges14.5276nm nadal przekracza5nm.
Zapis failure-only NPZ+JSON zachowuje pełną siatkę/ROI i dokładny report/input;
próg i finite-cylinder membership nie zmienione. Instrumentacja jest aktywna
wyłącznie po jawnym ustawieniu CI env. To dowód do diagnosis generatora,
nie naprawa actual density. Seeding/global minimum wymaga analizy tego mesha.

Automatyczna kontrola odrzuciła upload tych dwóch plików do GitHubActions,
podając brak bezpośredniej zgody na payload+destination. Upload nie wdrożony;
konkretna propozycja stałego synthetic fixture i retencji7dni przygotowana
poza repozytorium, pytanie do użytkownika oczekuje. Niezależne źródła i GammaCI
mogą być ukończone; bez uploadu evidence runnera jest ulotne. Build235 wciąż
queued/disk guard, brak nowego pełnego signed15/plot; S00–S12 aktywny.

CI37399201738 Rust job112062315220 zakończony success: regresje registry i
Dirichlet, kpool/adaptive_resources, writer oraz API przeszły. Generated API,
Control Room, browser fixture, Windows, FDM i API hygiene również PASS.
Python gate FAIL wyłącznie na actual mesh density; prywatne S09 helpery mają
wykonany dowód CI, lecz provider/MFEM2D i runtime/nauka nadal nie są potwierdzone.


### Γ policy proof — wykonawczy forwarding i preflight

CLI pilota udostępnia expected-window-krylov-policy jako postsolve guard.
Opcja jest zapisana w dry-run i przekazywana do Gamma actual-query report;
nie zmienia native command/IR. Review P2 wykryło pominięcie proof przez
programmatic execute z shifted_ksp_type=None; wspólny preflight sprawdza
policy/KSP/Γ przed dispatch. Przygotowano forwarding/noGamma/noDispatch
regresje. AST i focused doc validator PASS; nowe CI wymagane.
Controlled recipe ma explicit window8.5–16GHz i expected v2, lecz runtime
jeszcze nie wykonany. Source-only forwarding nie domyka Γ ani signed15.


### Korekta jawnej konfiguracji density fixture, bez zmiany generatora

Potwierdzony clamp: recipe body minimum5nm trafia do global Gmsh minimum;
regionalny upper target3nm nie może go ominąć. Kanoniczne równanie0104
max(min eligible upper,max eligible lower) zachowuje parent lower bound w ROI.
Dlatego wcześniejsze żądanie body[5,20] i region[1.5,3]nm nie opisuje testu
actual3nm. Fixture jawnie zmienia body minimum na1.5nm, zachowując bulk20nm,
regionalny target3nm, geometrię i threshold5nm. Nie zmieniono _mesh_hmin_value,
nie zastosowano globalnej cichej redukcji ograniczeń, skip ani retry.

AST/source review PASS; CI actual density nadal wymagane. Osobne ujawnione
luki produkcyjne pozostają OPEN: regionalne minimum jest metadata bez runtime
consumer oraz brakuje scoped lower-bound composition dla wielu właścicieli.
Nie promujemy tej korekty fixture do kompletnej naprawy polityki meshing.
Najnowszy CI37400348160:21 Gamma query regressions PASS, density8.1449nm FAIL;
synthetic failure capture bez zgłoszonego błędu, upload nadal nieautoryzowany.


CI37401671540 dla67ef8f9ba: python-contracts success, w szczególności Gamma
query/pilot routing contracts oraz actual meshing density case PASS przy
niezmienionym threshold5nm i skorygowanym jawnym body minimum1.5nm.
To wykonany dowód fixture/configuration, nie kwalifikacja eigensolve ani
pełnej scoped lower-bound policy. Pozostałe jobs CI jeszcze obserwowane.
World mapping prerequisite jest w implementacji; zmiany tej sekcji/note0833
pozostają WIP do ukończenia źródła/review/parser/CI, bez public admission.


### S09 — source world representability i uporządkowany bieżący status

Prywatny validate_waveguide_world_mapping wiąże te same Dirichlet/registry
borrows i canonical frame. Fixed f64 operation order, global node collisions
(±0), exact BigInt orientation oraz scaled3D P1 area/quality/mass/gradient/
stiffness guards są źródłowo zaimplementowane. Wynik nie jest publicznym
3D meshem, geometric-equivalence ani invariance/admission certificate.
Measured projection/plane errors pozostają pomiarami, bez ukrytegoepsilon.

Prepared regressions obejmują identity/rotation, zgodne axis+UV+winding reversal,
huge-origin collapse,±0, overflow, tinypositivearea, roundedorientation reversal
i pełne borrowed-token integration. Root dodał Debug dla privatehelperresult
wymagany przez expect_err; nie była to zmiana walidacji. Final-byte Rust parser,
whitespace check, niezależny review i focused0833 scientificmap PASS.
Unit tests nie kompilowane lokalnie. CI dodaje pełny waveguide_frame filter
obok waveguide_mesh, żeby nowa zależność nie opierała się na samym parse.

Aktualna tabela stanu jest na początku planu; historyczne checkpointy zachowano.
Pełny S09 wymaga jeszcze worldequivalence/fingerprint/structuralinvariance/
equilibrium/typedrouting/MFEMowner/runtime/science. S00–S12 nadal aktywny.
Read-only buildobserver235 PID99292/exec76080 potwierdzony live i sprawdza
exact source identity tego samego queued joba; nie restartuje ani nie submituje.


CI37403974091 odrzuciło nowy world fragment: conflicting Debug implementations
na WorldGeometry (derive Debug,Debug). Root przy końcowej poprawce dodał derive
już obecny przed strukturą; rustfmt połączył oba. Parser potwierdzał syntax,
nie trait coherence. Usunięto wyłącznie duplikat; brak zmiany walidacji/matematyki.
Python, frontend/browser, Windows i API hygiene PASS; Rust/FDM/generated API
zablokowane tą wspólną kompilacją IR. Nowe CI wymagane przed deklaracją PASS.


CI37405082553 dla98907f6af zakończone success we wszystkich8jobs. Nowe
waveguide_frame oraz waveguide_mesh (w tym world mapping) regresje wykonane
w GitHub Actions; Python/actual density, frontend/browser i API również PASS.
To zamyka source/CI world prerequisite, nie completeS09/operator admission.
Kolejny private geometry identity protocol wiąże rawmesh/map/frame/Dirichlet/
world i validationpolicy. Liczby materiałowe, k, equilibrium i build identity
pozostają osobnymi required bindings; nie używać geometryhash jako cachekey
pełnego operatora. Implementacja identity nadal WIP, spec przygotowana.


## Checkpoint — geometry identity S09, 2026-10-06

Prywatny borrowed geometry identity wiąże dokładne wejścia world mapping,
raw mesh/target map, obie ramy, normalization/tolerance, world nodes i jawny
Dirichlet. Spec dokumentuje byte-level typed preimage SHA-256 oraz granicę
scope. Review źródłowe nie znalazło błędów; prepared regressions wykonuje
istniejący waveguide_mesh gate wyłącznie w GitHub Actions. Nowe CI pending.
Nie jest to operator cache key, equilibrium fingerprint ani admission 2.5D.
World equivalence, invariance/material/field/interaction/equilibrium bindings,
MFEM owner/routing oraz cały cel S00–S12 pozostają otwarte.

Read-only API potwierdziło healthy coordinator, worker alive i brak aktywnych
jobów; retention_busy=true. Preview plan-a925ec0bb61d41ef8fce801299d01b9c
nadal planning35/235/applied=false; API zmierzyło1108758528B wolnego. Build235 obserwowany tym samym live
handle, bez submit/cancel/restart i bez usuwania danych.

### Następny przyrost S09: typed intent i admission

Po geometry identity nie dokładamy kolejnych izolowanych helperów geometrii.
Priorytetem jest StudyIRV04 w istniejącym staging ProblemIRV04 (physics_object.rs),
typed tagged spatial representation i jawna macierz missing/null/BC z ADR0035.
Publiczny writer0.3 pozostaje niezmieniony do atomowego cutoveru konsumentów;
nowe pole w0.3 nadal musi być odrzucane, a legacy0.3→0.4 zachowuje full_3d
oraz provenance defaulted_from_missing. Γ nie przełącza waveguide na3D.

Kolejność implementacji i warunki odbioru:

1. Typed StudyIRV04/spatial variants oraz atomic migrator: roundtrip,
   missing/null/unknown fields/conflicting legacy BC, brak mutacji przy odmowie.
2. V04 admission: root/script/serializer version checks i pełna walidacja;
   waveguide unsupported dla innych study kinds i unavailable przed3D meshing.
3. Kompletny structural2D model: wszystkie material/applied-field/interactions/
   BC/equilibrium bindings; żadnego nieznanego callbacku ani pominiętego terms.
4. Dedicated MFEM2D owner, append-only ABI i triangle/edge payload. Bounded
   reference assembler nie jest providerem ani dowodem produkcji.
5. Operator/rekonstrukcja: P(k)=K_perp+k²M, exchange A k², P1 nodalMs quadrature,
   physical feedback -μ0 i signed longitudinal derivative; outer-air Dirichlet
   także przyΓ bez dodatkowego gauge. Pełne residuals i nowe artefakty/normy dA.
6. ManagedCPU/oddzielnyGPU, convergence/extruded3D/TetraX, OpenAPI/generated
   client i rzeczywisty browser proof, potem capability promotion/cutover.

Ten kontrakt wynika ze sprawdzonych źródeł IR/planner/native i ADR0035/spec.
Nie deklaruje gotowego typed admission ani dostępnego providera. Równoległym
priorytetem runtime pozostaje kontrolowane Γ nowej polityki NCV i signed15.


## Checkpoint — identity CI PASS i typed V04 w przygotowaniu

Remote c458f57b2769e44492e066b285d7a8a67c34b932, source/parser/docs/review PASS.
CI37408473006 potwierdziło waveguide_frame i waveguide_mesh wraz z ośmioma
nowymi geometry identity regresjami; siedemjobs PASS, końcowy Rust/API/CLI trwa.
Pozostałe źródła w tym ci się nie zmieniły. Nowe obliczenia FEM nie powstały.

Rozpoczęto typed StudyIRV04 w istniejącym staging V04 wraz z presence-aware
BC i atomową migracją. Publiczny writer0.3 i historyczne guards zachowane.
Spec opisuje exact tagged finite-air BC/selected boundary IDs. Model/shape
validation pozostaje oddzielna od unavailable provider guard; brak lossy
konwersji waveguide→full3d i brak capability promotion. Implementacja WIP.

API read-only preview potwierdziło planning38/235/applied=false; brak deletion,
restartu lub nowego skanu. Exact job235 nadal queued. Obserwatory235 iCI pozostają
live. Cały S00–S12, kontrolowane NCV4Γ/signed15, nauka, GUI/GPU i integracja OPEN.


## Checkpoint — obsolete235 cancelled, właściwy runtime c458 przygotowany

Własny queued job235 (ownerMateusz, profil runtime-v2, exact070d) został
anulowany API przed startem. Odpowiedź state=cancelled/exit_code=null; źródła,
historia i dane zachowane. Obserwator76080 zakończony terminalnie, nie jest
ponawiany. To nie sukces ani awaria naukowego solvera — build nie wykonał się.

Właściwa próba Γ NCV4 ma exactc458, full8/8 sourceCI i prepared recipe8.5–16GHz.
Nowego joba/kapsuły nie utworzono przy725MB wolnego; rekomendacja pojemności
uwzględnia315MB wcześniejszej kapsuły i około27GB poprzedniego pełnego buildu.
Nie obniżamy globalnego8GiB admission ani nie używamy R dla Docker/FEM.
Read-only preview43/235/applied=false nadal trzyma maintenance slot.

W ramach wcześniejszej zgody na koordynację powiadomiono wątek „Scal audyty i
plan refaktoryzacji” o pojemności C: i poproszono o sprawdzenie własnych nowych
snapshotów/bundle przed kolejnym buildem. Nie zlecono przerwania aktywnych
procesów, usunięcia wspólnego cache ani zmian jego zakresu.

Typed StudyIRV04 zapisany w źródłach, integracja/migracja/bindings/regresje WIP.
Review wykrył i przekazał do naprawy dokładne tokeny serde przy cyfrze oraz
programmatic non-Eigen waveguide guard i standalone study BC presence guard.
Cały S00–S12, noweΓ/signed15, science/GUI/GPU/pełna2.5D/integracja nadal OPEN.


## Checkpoint — typed V04 source/review gotowe, CI wymagane

StudyIRV04 ma jawne full_3d/waveguide_2p5d, exact region_targets oraz finite-air
BC. Odrzuca null BC także przy bezpośrednim study decoderze; legacy0.3/history
presence guard pozostaje. Shared defaults pięciu study kinds zachowane.
Migrator sprawdza wersje i provenance conflicts, tworzy kandydat, sprawdza jego
rzeczywistą odczytywalność V04 i dopiero wtedy swap. Błąd nie modyfikuje wejścia.

Model validation wiąże frame, basic k sampling i projekcję requested control
vectors, rzeczywiste rejestry, Dirichlet oraz world representability bez
rekurencyjnego validate. Generated samples, global geometric equivalence,
invariance/material/applied-field/equilibrium certificates i provider dalej OPEN.
Availability guard zwraca waveguide_2p5d_unavailable, nie ma legacy fallbacku.

31 prepared integration regressions oraz aktualizacja historycznej V04 guard
fixture; final source review Sol nie wykrył błędów. Rustfmt/parser/diff i focused
scientific docs przechodzą; lokalne unit tests/kompilacja nie są wykonywane.
Nowa bramka GHA obejmuje cały fullmag-ir zamiast nakładających się filterów.
Dopiero jej wynik może potwierdzić wykonanie/regresje tego przyrostu.

Publiczny writer/API0.3 i capability nie przełączone. Cały S00–S12 i naukowy
runtime C58 Γ/signed15/COMSOL/GUI/GPU/integracja pozostają otwarte. Równoległy
cooperative preview cancel jest oddzielnym źródłowym przyrostem, niewdrożonym.
