# Weryfikacja i remediacja audytu relaksacji FDM/FEM z 2026-08-20

## Zakres i poziom dowodu

Zweryfikowano pakiet `fullmag_relaxation_audit_evidence_bundle (1).zip` względem
bieżącego drzewa źródłowego. Pakiet audytu był audytem D1 opartym na źródłach:
nie zawierał świeżego uruchomienia zarządzanego runtime, parity CPU/GPU ani
kwalifikacji FP32. Dlatego poniższe wyniki rozdzielają:

- potwierdzony defekt źródłowy i wykonaną naprawę,
- twierdzenie przesadzone lub niepotwierdzone,
- lukę kwalifikacyjną, której nie wolno uznać za naprawioną testem jednostkowym.

Nie zmieniono statusu żadnego lane'u na production-qualified.

## Werdykt dla znalezisk

| ID | Werdykt po weryfikacji | Remediacja / pozostały gate |
|---|---|---|
| FM-RELAX-001 | Częściowo trafne, priorytet P0 przesadzony | `production_executable` nie oznacza `validated`; brak `validated_workload` pozostaje jawną luką kwalifikacyjną. Bez zmiany semantyki capability. |
| FM-RELAX-002 | Potwierdzone i naprawione | Legacy `torque_tolerance_unit="T"` jest konwertowane do A/m; dodano walidację jednostki i testy konfliktu aliasów. |
| FM-RELAX-003 | Potwierdzone w części i naprawione | Projekcja używa teraz dzielenia przez `m·m`; zerowa, subnormalna, niefinitywna retraction aktywnego spinu jest odrzucana przed ewaluacją backendu. Zero jest zachowane tylko dla jawnie nieaktywnej komórki. |
| FM-RELAX-004 | Potwierdzone i naprawione | Secanty PG-BB są transportowane do zaakceptowanej przestrzeni stycznej; usunięto nieosiągalną gałąź fallback. Naprawiono ścieżkę wspólną oraz referencje CPU SoA/AoS. |
| FM-RELAX-005 | Niepotwierdzone jako defekt P1; kontrakt zaostrzony | Audyt nie dostarczył kontrprzykładu błędnej akceptacji po retraction, ale CPU/reference i aktywna ścieżka CUDA używają teraz reprezentowalnego chordu z rzeczywistego trialu. Test adversarial Armijo przechodzi; nie jest to dowód kwalifikacji produkcyjnej. |
| FM-RELAX-006 | Potwierdzone i naprawione w aktywnej ścieżce | FDM CUDA obserwuje torque przed klasyfikacją zdegenerowanego gradientu i wymaga kanonicznego potwierdzenia próbkami; status GPU nadal wymaga managed receiptu. |
| FM-RELAX-007 | Potwierdzone i naprawione | Referencyjne direct minimizers CPU odrzucają zerowy/subnormalny aktywny stan przed polem, nie kończą stanu początkowego po pojedynczej próbce torque, a potwierdzenie ignoruje ponowną obserwację tego samego zaakceptowanego `accepted_step`. |
| FM-RELAX-008 | Potwierdzone i naprawione w kontrakcie CPU/GPU | FEM CPU i GPU nie publikują `Gradient` jako równowagi przy zerowym gradiencie i wysokim torque; taki stan kończy się `numerical_stagnation`, a niski torque bez kryterium energii pozostaje w ścieżce potwierdzenia. Przy aktywnym kryterium energii degeneracja również kończy się fail-closed jako `numerical_stagnation`. Kontenerowy test kontraktu przechodzi; runtime qualification nadal otwarta. |
| FM-RELAX-009 | Potwierdzone w części i naprawione w potwierdzonym zakresie | FEM tangent-plane implicit używa teraz wspólnego `direct_minimizer_armijo_accepts`, który liczy reprezentowalny chord energii i wykonuje ograniczone doprecyzowanie interwału Armijo; kanoniczne potwierdzenie torque pozostaje wymagane. Sam zarzut cancellation nie ma w audycie kontrprzykładu produkcyjnego, więc nie rozszerzono wniosku ponad istniejący kontrakt numeryczny. |
| FM-RELAX-010 | Defekt ABI potwierdzony, zasięg publiczny przesadzony; naprawione fail-closed | Planner już odrzuca publiczne multilayer+transport. Natywne ABI przenosi teraz wybór multilayer przed rozpoczęcie transakcji, a binding transportu odrzuca multilayer-v2. |
| FM-RELAX-011 | Potwierdzone i naprawione | Provenance zapisuje requested/resolved direction policy, solver i preconditioner wraz z nazwami zmiennych środowiskowych; GPU nie deklaruje polityk CPU. |
| FM-RELAX-012 | Niepotwierdzone jako błąd semantyczny | CPU i GPU mają odrębne realization IDs, co jest zgodne z dopuszczoną remediacją audytu. Parity obu realizacji nadal wymaga runtime gate. |
| FM-RELAX-013 | Potwierdzone i naprawione | Usunięto niepodłączoną, rozbieżną kopię workflow relaksacji pod `src/solvers/fdm/workflows/relaxation`; dodano kontrakt zapobiegający jej odtworzeniu. |
| FM-RELAX-014 | Potwierdzone; poprawiono osiągalność i ograniczono czas gate | Moduł testów fizycznych FDM został podłączony do integration-test root i otrzymał recepty `just` z twardymi limitami 180 s dla smoke oraz 900 s dla release. Smoke był wcześniej zaliczony, ale bieżące uruchomienie Rust jest zablokowane obcą zmianą w dirty worktree (`hysteresis.rs:5874`, brak `MagnetIR.object_id`); pełna kwalifikacja nadal pozostaje otwarta. |
| FM-RELAX-015 | Potwierdzona luka zakresu, nie defekt do lokalnej poprawki | Ogólna kwalifikacja FEM dla materiałów niejednorodnych i DG0 Ms wymaga osobnego projektu fizyczno-numerycznego. Bez zmiany. |
| FM-RELAX-016 | Potwierdzone i naprawione | Poprawiono antydampingowy znak w komentarzu równania modułu FEM overdamped LLG. |
| FM-RELAX-017 | Potwierdzona luka kwalifikacyjna; kontrakt gate zaostrzony | Macierz ma 16 legalnych komórek i 4 jawne `not_applicable` dla TPI. Dodano source-bound producer dla legalnych lane'ów, 18 rekordów runu na workload, 30 pomiarów w logu procesu, realne hashe artefaktów, przeliczaną parity i osobny subprocess oracle. Brak świeżych receiptów, czystego live `source_root`, managed runtime oraz runtime parity nadal daje `BLOCKED`; nie wolno tego traktować jako production-qualified. |
| FM-RELAX-018 | Potwierdzone ryzyko propagacji; naprawione w kontrakcie publikacji | Finalna, typowana proweniencja zawiera authored/effective/resolved execution i waliduje rzeczywisty engine/device oraz fallback. Asynchroniczne artefakty `fields/**/*.json`, `.zattrs`, osobny root stage-autosave i manifest multilayer dostają finalną `execution_resolution` przed publikacją; test osobnego rootu przechodzi `1/1`, ale pełny runtime nadal wymaga kwalifikacji. |

## Wprowadzone zabezpieczenia

1. Ujednolicono jednostkę tolerancji torque do A/m na granicy Python API.
2. Projekcja styczna i retraction są odporne na stan poza rozmaitością oraz aktywne
   wektory zerowe; błędny trial nie trafia do backendu.
3. PG-BB używa transportowanych secantów w nowej przestrzeni stycznej.
4. Stopy wynikające z degeneracji gradientu nie omijają potwierdzenia torque.
5. Multilayer-v2 nie może rozpocząć transakcji transportowej, której nie domknie.
6. Runtime provenance ujawnia środowiskowe polityki direct minimizer FEM.
7. Usunięto martwą, rozbieżną implementację relaksacji.
8. Ignorowane testy fizyczne FDM stały się osiągalne przez dedykowaną receptę.
9. Receipt FDM i macierzy używają wspólnego schematu workloadów z jawną precyzją; CPU smoke nie może wystawić receipt kwalifikacyjnego, a pusty allowlist GPU pozostaje fail-closed.
10. Macierz wymaga czystego live source tree; tryb offline zawsze kończy się `BLOCKED`, a flagi `assume-unchanged`/`skip-worktree`, dirty nested gitlink, arbitralna receptura i współdzielony artefakt są odrzucane.
11. Receipty nie są akceptowane na podstawie samego JSON-a: każdy poziom D4/D5/D6 musi wskazywać semantyczny artefakt z właściwą komórką, workloadami, oracle, źródłem, runtime i wynikiem.
12. Limity timeoutów FDM są walidowane przed uruchomieniem i nie można ich podnieść ponad 180 s smoke / 900 s release.
13. Zerowy gradient FEM z niespełnionym torque albo aktywnym kryterium energii nie jest publikowany jako równowaga; zostaje jawnie oznaczony jako `numerical_stagnation`.
14. Finalizacja proweniencji obejmuje także odrębny root stage-autosave, a nie tylko `output_dir/fields`.

## Świeże dowody wykonane podczas remediacji

- Kontrakty Python receiptów, macierzy, producer-a i niezależnego oracle: `93 passed` (`16` FDM qualification, `39` production matrix, `33` capability evidence, `5` source-bound producer); kontrakt Python API relaksacji: `17` testów i `23` subtesty.
- W czystym checkoutcie bieżącego `HEAD`, poza współdzielonym dirty worktree,
  testy źródłowe konwergencji zaliczyły `10/10`, referencyjnego direct minimizer
  `13/13`, a provenance `5/5`; jest to dowód źródłowy, nie kwalifikacja managed
  runtime.
- Semantyka minimizatorów Rust: `55/55` testów zaliczonych, w tym transported secant,
  aktywny wektor zerowy, masked inactive zero i Armijo.
- Bieżący czysty checkout z poprawkami: `55/55` testów modułów direct-minimizer,
  w tym test chordu Armijo, preflight stanu początkowego i potwierdzenie exact
  equilibrium; osobny test autosave provenance `1/1`.
- Kontenerowa diagnostyka wynikająca z recipe zbudowała i uruchomiła kontrakty
  `fem_relaxation_source_contract`, `fem_relaxation_energy_derivative_contract`,
  `fem_stage_completion_contract` i `fem_rk_explicit_contract`; pełny recipe
  nadal nie przechodzi wcześniejszego gate'u inwentarza siatki.
- Po remediacji TPI te same dwa kontrakty źródłowy i energii zostały ponownie
  zbudowane w managed containerze; źródłowy kontrakt wymaga już wspólnego
  ownera `direct_minimizer_armijo_accepts`, a wykonanie zakończyło się kodem 0.
- `just verify-relaxation-production-matrix` wykonał fail-closed orchestrator:
  wynik `FM-RELAX-017 BLOCKED`, z brakującymi receiptami wszystkich 16 legalnych
  komórek oraz odrzuconym dirty source tree; wszystkie cztery nowe receptury
  istnieją i przechodzą `just --dry-run`, ale nie wyprodukowano ich receiptów.
- Kontrakt receiptów wymaga teraz materializacji i hashy `input-contract`,
  metadata, scalarów, logu i `m_final` dla warmup oraz pięciu pomiarów na każdym
  poziomie `coarse/medium/fine`; scope refinement/repeatability jest porównywany
  z tymi rekordami, a parity sprawdza ponownie `abs(target-baseline) <= tolerance`.
- Niezależny oracle jest uruchamiany jako osobny subprocess, sprawdza normę
  spinów, zgodność scalarów z `m_final`, analityczne ustawienie macrospinu oraz
  monotoniczność energii `exchange_demag`; jego implementacja ma własny hash
  i jest weryfikowana przez matrix/FDM/capability validators.
- Provenance Rust w konfiguracji domyślnej: 5 testów zaliczonych.
- Provenance w zarządzanym kontenerze z `--features fem-gpu`: 5 testów zaliczonych;
  kompilacja objęła rzeczywiste ścieżki FEM CPU/GPU.
- Semantyczny kontrakt spójności FEM: zaliczony.
- FDM physics qualification: `exchange_only_random_to_uniform` oraz
  `uniform_field_alignment` zaliczone po podłączeniu modułu i certyfikatu siatki.
- `git diff --check`: zaliczony.

## Bramki niezaliczone lub nieukończone

- `verify-fem-relaxation-source-contract` zatrzymuje się przed kontraktami
  relaksacji na niezależnym dryfcie inwentarza dostępu/producentów siatki FEM.
  Nie aktualizowano oczekiwanych skrótów, ponieważ bieżące drzewo współdzielone
  zawiera obce zmiany w tym obszarze.
- Pełna recepta FDM physics qualification nie kończy się w praktycznym czasie:
  scenariusze thin-film/SP4 nadal wykonują do 50 000 kroków referencyjnego CPU.
  Uruchomienia przerwano bez wyniku; nie są PASS ani FAIL fizyki.
- Pełny managed runtime, świeże CPU/GPU parity, FP32, mesh refinement,
  powtarzalność i wykonanie source-bound producer-a z niezależnym oracle
  pozostają wymagane przed użyciem produkcyjnym; same testy kontraktu nie są
  receipt-em runtime.
- Hostowa próba CUDA nie jest dowodem kwalifikacyjnym i wcześniej zatrzymała się
  na `ptxas fatal: Internal error: writing file`; nie zastępuje recepty zarządzanej.
- Bieżący ukierunkowany build Rust nie doszedł do testów artefaktów/proweniencji:
  dirty, niezależne zmiany Frozen Spins/selection blokują kompilację:
  `crates/fullmag-runner/src/hysteresis.rs:5874` nie uzupełnia `MagnetIR.object_id`,
  a `crates/fullmag-plan/src/selection/certificate.rs:106` odwołuje się do
  `prepare_expression_realization`, którego nie ma. Tych obcych plików nie zmieniano.
- Wcześniejsza presja miejsca WSL wymusiła uruchamianie testów Python w
  `/dev/shm`; najnowszy odczyt root filesystemu pokazuje około 21 GB wolnego
  miejsca, a `lsof +L1` nie wykazał już otwartych usuniętych plików. Nie ubijano
  procesu ani nie usuwano aktywnego runtime'u.

## Końcowy status

Potwierdzone błędy źródłowe zostały naprawione i objęte wąskimi regresjami.
Audyt był użyteczny do znalezienia defektów, lecz przeszacował część priorytetów
i zasięgów. Fullmag relaxation nadal nie ma kompletnego dowodu produkcyjnego dla
całej macierzy FDM/FEM × CPU/GPU × FP64/FP32 × algorytm. W szczególności nie wolno
z tego raportu wyprowadzać statusu production-qualified ani gotowości do wyników
naukowych bez brakujących bramek runtime i niezależnych oracle.
