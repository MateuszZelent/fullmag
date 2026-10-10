# Wdrożenie planu eigensolve R2 — checkpoint 10.10.2026

Właściciel: ten wątek Codex, worktree `eigensolve-dispersion-plan-20260912`.
Baza to rzeczywiste pliki izolacji, nie master. [Tożsamość wejść i źródeł](baseline-20261010.json).
[Plan R2](../2026-10-10-eigensolve-reference-adaptation-and-physics.md) oraz
[raport R2](../../../audits/2026-10-10-eigensolve-fullmag-tetrax-tetmag-comsol.md)
są zachowanymi wejściami użytkownika. Ich historyczne „implementacja niezlecona”
nie opisuje bieżącego zadania: użytkownik zlecił wdrożenie.

## Zakres i granice dowodu

P0–P10 pozostają zakresem autoryzowanej implementacji; P11 jest poza nim.
CPU Floquet/dynamiczny demag istnieje. Nie wdrażamy go ponownie.
Nie przenosimy historycznego wyniku #231 na aktualny snapshot.
Budowanie i testy wykonujemy wyłącznie w GitHub Actions, zgodnie z wcześniejszą
zgodą użytkownika. Nie zmieniamy progów residualów w celu dopasowania do wyników.
Zachowujemy cudze pliki, aktywny HEAD, indeks i stash. Brak merge i cleanup.

## Zadania i kryteria odbioru

| Etap | Stan na starcie | Konkretny następny wynik | Bramka |
|---|---|---|---|
| P0 kontrakt/baseline | W toku: wejścia i hashe zapisane | Wersjonowane pochodzenie damping i spectrum; ograniczenie reference oracle | Source review, serializacja/round-trip CI, mapy naukowe |
| P1 Bloch/frame/FE | Istniejąca produkcyjna reprezentacja pełnego phasoru | Sparse payload, covariance i osobna zbieżność envelope/full-field | Frame/action tests i refinement |
| P2 demag-k CPU | Źródła istnieją, kwalifikacja otwarta | Domknięcie błędów KSP; geometry/exterior i trzy h levels | Runtime, residuale, airbox convergence, DE/BV |
| P3 exact damping | Reference linewidth istnieje; native Include gated | B_alpha z lokalnymi wagami, complex physical sector, decay/growth | Circular/elliptic/overdamped macrospin i energy balance |
| P4 spectrum/skala | Sparse solver i contour owner istnieją | Oddzielne search_stable/count oraz sparse assembly bez N² | Hidden-block/count/region, RAM i inner true residual |
| P5 GPU | K0 ma osobną trasę; nonzero-k gated | Pełna ta sama fizyka na GPU bez fallback | Device runtime i CPU/GPU parity |
| P6 modalny FEM/BEM | Demag owners istnieją; tangent provider do weryfikacji | Open-boundary modalny provider i kompresja | Analytic/open-exterior/compression convergence |
| P7 odpowiedź RF | Driven owner istnieje | Left/right lub direct/block reduction z feedthrough | Direct-response parity i modal convergence |
| P8 DMI/STT/EASA | Reference ma uproszczenia; brak kwalifikacji | Signed Hessian/JVP/BC i current-driven equilibrium | FD/JVP, signs, chirality, growth i BC |
| P9 referencje/tracking | Artefakty i tracking istnieją | COMSOL A1 matching, subspaces, FM FFT/ringdown | Inputs/receipts, numerical errors i convergence |
| P10 Python/UI/API | Obecny wspólny workflow istnieje | Versioned exact/approximate/partial semantics, pełny round-trip | Python→IR→native→artefakt→UI→Python oraz browser |

Nie podajemy procentu naukowej kwalifikacji na podstawie obecności źródeł.
Ukończenie pojedynczej poprawki P0 nie oznacza ukończenia P0–P10.

## Zależności od wcześniejszego review

Nieopublikowany typed CPU transport ma source review Rust PASS; producent C++
wymaga pełnego review i CI. API fixture migration to osobna, trwająca praca.
Hosted native run 38062145700: 7/12 PASS; podstawowy i mixed Floquet solve oraz
trzy fixtures diagnostyczne nadal FAIL. Pełny Pmat copy zgadza się z reference,
ale nie dowodzi poprawnego stanu live factorization. A1 geometry run 38064506397:
dwie fixtures wymagają korekt bez osłabienia geometry gate. Te problemy muszą być
zamknięte, zanim zażądamy kwalifikacji P2/P9.


## Korekty przygotowane po odczycie R2

- Reference alfa/provenance: implementacja w toku; brak exact damping claim.
- Typed CPU transport: pełny root review C++ wykrył zgubione scalar gauge
  coefficients. Są zachowane dla CPU/GPU jako metadata; dodano regresję.
  Izolowana bramka CTest w istniejącym profilu modal-phase-slepc dociera do
  contour i augmented Poisson bez wcześniejszego błędu pełnej suite.
- A1 fixture CI: oczekiwany powód odrzucenia pełnego slab odpowiada teraz
  rzeczywistemu geometry guard. Syntetyczne nominalne mesh tiers mają różne
  hmax i zagęszczoną ścianę cylindra. To test kontraktu metadanych, nie proof
  rzeczywistego globalnego hmax ani zbieżności FEM. Geometry gate nie osłabiono.
- E18 ponownie sprawdzony w rzeczywistym Schur owner: base/refinement schedules
  porównują wybrane klastry. Coverage counter nie jest independent eigenvalue
  count. Integracja count i migracja nowej emisji pozostają zadaniem P4.


## Checkpoint publikacji pierwszych korekt

- Commit `39a20c4596231563e0568a2eec9cb4c4529aed56` jest na branchu remote;
  zawiera baseline/plan/raport i naprawy syntetycznych fixture A1.
- Hosted `dispersion-artifact-consumers` #38068292627 został uruchomiony na tym
  SHA; terminalny wynik jeszcze nieznany.
- Alfa/reference provenance: implementacja źródłowa przygotowana i reviewed;
  `Ignore` też odrzuca nielegalne alfa, duże alfa nie przepełnia alpha²,
  derived nonfinite frequencies nie są publikowane. `Include` pozostaje
  jawnie przybliżone. Method evidence jest w summary, v2 sample,
  diagnostics oraz manifeście przed hashowaniem rewizji.
- Typed CPU transport: źródła reviewed, zachowują layout/phase/full phi/gauge;
  brak bulk JSON i syntetycznych native cluster IDs; GPU legacy zachowane.
  CABI/Rust execution pending GHA, nie ma promocji fizyki.
- Migracja fixture API: pełny source review po poprawie scalar-only step9
  bez powtórnej magnetyzacji. Oczekiwań statusów nie osłabiono; nadal wymaga
  pełnego hosted run dla wcześniejszych 105 błędów.
- P0 pozostaje częściowe; P1–P10 nie są uznane za zakończone. Najbliższy
  krok po CI: domknąć compile/regression failures, potem count integration,
  residual norms i rzeczywiste benchmarki P2/P9. Exact damping, GPU,
  FEM/BEM/RF/DMI/STT/EASA oraz pełny UI pozostają w tabeli zakresu.


## Dowody hosted i naprawa kompilacji

Publikacja korekt: `f8ccb47a82e1fc026ae22390736e875a798f82c9` (fixture API)
oraz `19bcb4fd8dba368ab14e405f319a243c4e5577b8` (typed CPU transport,
reference method evidence, nota/ADR i CI).

Hosted #38068292627 na exact `39a20c4596231563e0568a2eec9cb4c4529aed56`
**SUCCESS**: primary geometry/provenance 113 PASS +136 subtests, verifier
5 PASS, root/plot/parity consumers 104 PASS +70 subtests. Terminal producer
Linux 44 PASS, Windows 43 PASS. Potwierdza naprawę fixture A1; nie jest
wynikiem obliczenia dyspersji.

Hosted #38068679693 na exact `19bcb4fd8dba368ab14e405f319a243c4e5577b8`
**FAIL**: E0432, brak re-exportu `NativeModalComplex64` i
`NativeModalEigenTypedResult` przez crate-private fasadę `native_fem`.
Źródłowa poprawka dodaje tylko te istniejące typy do listy `pub(crate) use`;
nie zmienia widoczności publicznej ani zamrożonego ABI. Hosted testy runnera
nie wykonały się w tym nieudanym jobie. Fresh CI wymagane.

Native phase/typed job #38068716019 i pełny Rust/API #38068718203 zostały
zlecone na `19bcb4fd...`; terminalny wynik jeszcze nieznany. Nadal brak
kwalifikacji runtime/nauki nowego exact damping/GPU i całego P0–P10.


## Checkpoint: CI i przyczyny błędów po 924c261

Hosted #38068966497 (924c26129a0b5e5b3aadf32bfb3df852479ef4e4):
kompilacja runnera PASS; 1561 PASS, 30 FAIL, 1 ignored. Wszystkie siedem
nowych przypadków typed CPU oraz siedem R2 damping/method evidence PASS.
Pełna suite pozostaje FAIL. Hosted #38069118693: API nie skompilowało się
przez niezadeklarowane latest_fields w fixture FrozenSpins. Naprawa używa
istniejącego admit_test_latest_fields_from_physical_step bez zmiany oczekiwań.

Hosted #38068716019 na 19bcb4fd8dba368ab14e405f319a243c4e5577b8:
modal-phase-slepc SUCCESS. To bramka natywnego kontraktu fazy/typed CPU,
nie zbieżność dyspersji ani kwalifikacja całego P2/P9. Receipt należy zachować.

Wykryte rzeczywiste przyczyny i przygotowane poprawki:
- Bias-field path: przygotowanie point_plan usuwa listę sweepu, więc ponowne
  rozpoznanie intencji z tej listy omijało per-field Relax→Eigen owner.
  Serial adapter używa zewnętrznej intencji i istniejącego właściciela
  relaksacji/provenance/potential publication. Test nadal wymaga producer ID.
- Synthetic K0 Kittel: jednoskładowy reduced_vector nie miał legalnego layoutu
  XYZ i blokował wybór gałęzi. Zastępuje go spójny unit Euclidean XYZ
  placeholder; nie jest to wektor FEM ani fizyczna eliptyczność. Regresja
  wymaga wszystkich trzech punktów, reference lane i NOT VERIFIED.
- R4 fixture: pełna tożsamość rodziny jest zachowana przed usunięciem tylko
  badanych evidence. Positive Floquet fixture deklaruje rzeczywistą parę X/Y.
  Poisson fixture podaje jawnie oba block residuals zamiast niejawnego EPS.
  Produkcyjne guardy i tolerancje pozostają bez zmian.

Reconciliation R2: 51 fragmentów z 31 plików; 46 hashy zgodnych ze snapshotem,
5 zmienionych. JSON zapisuje źródła, aktualne hashe i drift; nie dowodzi runtime.

P4: direct sparse assembler ma N² staging, ale jedyny caller to contract test.
Nie wolno przedstawiać jego optymalizacji jako obniżenia RAM rzeczywistych runów.
Najpierw trzeba połączyć rzeczywistego producenta z direct local CSR i budget.
E18 porównuje wybrane klastry dwóch schedule, bez niezależnego count; zachowanie
historyczne nie jest dowodem kompletności całego okna. Korekta nowej emisji i
independent count pozostają otwarte. P0–P10 nie są zakończone.


Cztery dispatch provenance fixtures poprawiono źródłowo: puste sample lists
wymagają missing observed provenance, a positive native sample bierze
solver_diagnostics z kanonicznego publishera przez helper cfg(test). Nie
odtwarzamy execution/phasor z enum. Zachowano negative capability/operator
assertions. Source syntax i niezależny review wymagane; wykonanie oczekuje GHA.

P3 scan: istniejący nodewise action B_alpha nie dowodzi poprawnych wag weak
production pencil. Shared-domain mass assembly nie używa jeszcze alpha_per_node.
Generic i Floquet mają odrębne complex Ω filters; samo ich usunięcie może
przyjąć mirror sector. Następny bounded etap wymaga physical projection,
original residual i complex eigenvalue clustering, potem weak-alpha energy
balance. Obecne Include reference nie jest exact solve i nie otwiera native gate.


## Checkpoint 2101053 — ponowne CI

`5c8d6480a259294f23ebe43d262e3e44f4e4bf5d` oraz
`2101053ab52bdaa2ac3c8242ee902d076c1f7263` są na remote.
Hosted #38072216297: 1572 PASS, 19 FAIL, 1 ignored. Wszystkie nowe typed i R2
method cases nadal PASS; 11 z 12 wcześniej błędnych przypadków eigensolve
przeszło. Bias producer-identity guard, synthetic K0 trzech pól, cztery
Floquet classification fixtures, R4 i jawny Poisson block residual PASS.
Ostatnia dispatch assertion zakładała brak klucza validated_scope, podczas
gdy canonical Option emituje null. Source-reviewed korekta dopuszcza wyłącznie
brak lub null, nadal odrzuca każdy string dla validation_state=unvalidated.

Trzy dalsze fixture artifacts przygotowano zgodnie z produkcyjnym kontraktem:
canonical typed torque family payloads, object identity dla scoped graph oraz
jawny fem_cpu_native/double dla testu completion. Guardy i assertions
wykonanych IDs/completion zachowane. To naprawy fixture, nie rozszerzenie
fizyki FDM. Wykonanie nowych zmian oczekuje następnego CI.

Pełny Rust/API #38072219897 trwa na exact 2101053; jego wynik nie jest
przypisywany późniejszym zmianom. P4 native v2 search-stability/count-unavailable
przygotowywane osobno; independent count i P0–P10 nadal nie są zamknięte.


## Checkpoint 976fd188 — wszystkie 12 regresji eigensolve PASS

Commit `976fd1888f986bf852e2915be6dfb2c022b0c965` jest na remote.
Hosted #38072580027: 1576 PASS, 15 FAIL, 1 ignored. Ostatni modalny dispatch
case i trzy artifacts fixtures teraz PASS. Wszystkie 12 naprawionych
przypadków eigensolve przeszło; pozostałe 15 nie pozwala uznać pełnej suite
za zieloną. Przygotowano source-reviewed recertification finalnych FDM grid
fixtures, named checkpoint bit i jawne Extended w pozytywnych fallback
fixtures. Test current artifact zachowuje Strict i jawnie wybiera CPU.
Strict production guard nie został osłabiony. Późne odrzucenie Strict+FDM
fallback przed publikacją, zamiast przed solve, jest dodatkowym otwartym
problemem runtime; nie reinterpretujemy auto jako wyjątku od polityki.

Przygotowana korekta P4: nowe CPU Schur/GPU K0 certificates v2 oddzielają
search stability od count, whole-window complete zawsze false bez count.
Status ok wymaga starego stability predicate i kompletnego certificate JSON;
truncation/failure/cancel zachowane. Independent count nadal nie wdrożony.
SOURCE review wykrył pozostawiony error_message gate; naprawiono oba
producery i dodano positive regression pustego błędu przy status ok.
Focused CPU CTest zachowuje dziewięć przypadków i istniejące phase/typed
bramki w profilu modal-phase-slepc. GPU wykonanie nadal NOT VERIFIED.

P3/P10 signed UI: Inspector zachowuje growth, pokazuje Gamma/2pi w Hz,
stability i amplitude lifetime w s. Nieoscylujące/growing mody nie mają
FWHM/Q. Brak jawnego phasoru nie tworzy domyślnego znaku. Reviewer wykrył
nielegalny spectrum fallback Number(false/empty/null)->0; ścisły parser
modalnych frequencies naprawiono i dodano decoder→chart point→derived
observables regression. Pozostałe rodziny parserów nie zostały zmienione.
SOURCE review PASS; type/Vitest/React Doctor tylko w GHA, browser pending.

R2 źródłowa nota i mapy zaktualizowane przed zachowaniem. AST, YAML data
parser, diff i scientific source-map walidacja wymagane przed publikacją.
Plan P0–P10 pozostaje otwarty, szczególnie exact damped pencil, count,
large sparse producer, demag convergence, GPU/BEM/RF/DMI/STT/EASA i pełny
round-trip/qualification. Nowe poprawki nie są dowodem tych rozszerzeń.


## Checkpoint f9c29e2 — kolejne bramki i korekta przygotowania UI

Commit `f9c29e2b2bc195d598e600bbcb3bd47316e58251` jest na remote.
Hosted #38074310935: 1581 PASS, 10 FAIL, 1 ignored. Wszystkie wcześniej
naprawione przypadki eigensolve pozostają PASS. Po dopuszczeniu fallback
w pozytywnym Extended fixture ujawniła się rzeczywista różnica nazw:
planner używa fdm_cpu_reference, producent zapisuje cpu_reference.
Korekta ma rozpoznawać wyłącznie dwie istniejące pary CPU/CUDA, bez
przepisywania historycznych artefaktów i bez osłabienia Strict.

Pełna bramka Rust/API #38072219897 na exact 2101053 zakończyła się FAIL:
1004 PASS, 6 FAIL, 3 ignored, 355 filtered w głównej suite API. Błędy
dotyczą completion compute_fields, trzech FrozenSpins FEM preview,
materializacji mat_ms i authoritative live magnetization. Nie są dowodem
niepowodzenia fizyki modalnej, ale blokują pełne uznanie suite za zieloną.
Ich przyczyna wymaga osobnej analizy kontraktu; nie zmieniono oczekiwań
wyłącznie dla uzyskania PASS.

UI #38074311071 na exact f9c29e2: FAIL przed wykonaniem testów. pnpm
zatrzymał instalację na przygotowanym source node_modules symlink
(ENOTDIR). Upload-artifact odrzucił dodatkowo ścieżkę zawierającą .. .
Naprawa przygotowuje wyłącznie root/app manifests w fizycznym, kanonicznym
frontend_root resolvera, z SHA źródeł i pojedynczych manifestów. Instalacja
używa tego katalogu; testy nadal korzystają z checkoutu przez istniejące
zarządzane links. Upload wykorzystuje znormalizowane ścieżki. To korekta
CI, nie dowód działania UI. AST/YAML sprawdzono; wykonanie tylko GHA.
Native #38074313403 nadal trwa; exact źródła i wynik zostaną zapisane
po terminalnym zakończeniu. P0–P10 pozostaje otwarty.


## Checkpoint 71dd3539 - terminalne bramki

Commit `71dd3539aa9e5284c040eb734383dcab5eb7bba2` publikuje przygotowanie
physical pnpm workspace. Hosted UI #38075838610 ujawnil blad helpera:
analiza dependencies parsowala takze pnpm-lock.yaml jako JSON. Naprawa
ogranicza parsowanie dependencies do package.json, nadal kopiuje dokladne
YAML bytes i sprawdza apps/* oraz closure workspace dependencies. Dodano
piec GHA regression cases. Znormalizowane env paths sa eksportowane po
walidacji resolvera, przed admission manifests, aby zachowac final status
rowniez przy nieudanym admission. Testy UI nadal NOT VERIFIED.

Native #38074313403 na exact f9c29e2 zakonczyl sie FAIL podczas linkowania
fem_poisson_airbox_modal_eigen_slepc_contract: szesc funkcji testowych GPU
odwoluje sie do symboli nieobecnych w obrazie CPU. Runtime skip flag nie
usuwa tych symboli z obiektu. Nie wykonano nowych trzech CTest cases.
Naprawa ma odzwierciedlac rzeczywisty compile-time GPU source gate, bez
stubow i bez zmiany dziewieciu CPU window assertions. Poprzedni phase/typed
PASS #38068716019 pozostaje dowodem tylko niezmienionego zakresu.

Consumer #38074310973 na exact f9c29e2: SUCCESS. Nie dowodzi runtime solvera.

Source-reviewed FDM identity fix normalizuje tylko istniejace CPU/CUDA
aliasy do porownan final writer; surowy zapis provenance zostaje zachowany.
Piec regresji writer obejmuje sukces Extended, mismatch, pozorny fallback
pomiedzy aliasami, unknown engine i zachowanie Strict rejection. Wykonanie
tej poprawki oczekuje GHA. Pozne odrzucenie Strict fallback nadal otwarte.


## Checkpoint ea59d2cb - wykonane kontrakty FDM i frontend

Commity `26bf0b0abe5870d94a3d5fa5cd750a8effef967d` i
`ea59d2cb201d4e24c7755ec48a6335b7143854a7` sa na remote.
Hosted #38076097697: 1593 PASS, 3 FAIL, 1 ignored. Wszystkie piec nowych
writer regressions FDM identity PASS; auto batch/live, managed override,
session registries i prescribed current artifact tez PASS. Pozostaly trzy
stare oczekiwania topology/capability fixtures; source-reviewed korekty
zachowuja fail-closed frequency/GPU-provenance/unsupported integrator.

Hosted UI #38076097699 na exact ea59: manifest regression, physical install,
architecture i pelny typecheck PASS. Vitest: 100 PASS, 1 FAIL: undamped
minus phasor generowal -0 zamiast kanonicznego +0. Poprawka dotyczy wylacznie
zera; cztery nowe ±0/phasor combinations, signed growth bez zmian.
Inspector siedem i chart osiemdziesiat trzy przypadki PASS. Browser nie
zostal wykonany. React Doctor FAIL: 617 issues (9 errors), score 57/100
w analizowanej aplikacji. Nie omijamy bramki; zachowujemy raporty jako
artefakty i wymagamy klasyfikacji zakresu/przyczyn. To nie dowod, ze wszystkie
617 zostaly wprowadzone przez te poprawki.

Przygotowano native CPU-link correction: compile-time GPU macro odpowiada
rzeczywistemu warunkowi dolaczenia modal_petsc_slepc.cpp. GPU helper bodies
i calls znikaja z CPU obiektu; runtime skip flag pozostaje dla GPU buildu.
Dziewiec focused CPU window cases i ich assertions sa niezmienione.
SOURCE review i kolejne hosted native wykonanie wymagane.

Sprawdzono kodowanie UTF-8 tracker; poprawiono wylacznie dopisane checkpointy
z niepoprawnym kodowaniem Windows. Historyczny prefix zachowany.


## Checkpoint fe99244d - runner suite zielona, UI kontrakty PASS

`d6bbf4ff3aec8263f629b58b07881b4ad040efa7`,
`87dc6a748cd9a6ccab0a4f6c640a4b78d8579d74` oraz
`fe99244d060489a3f67c4afc7de09445bdba5220` sa na remote.
Hosted #38076746447: 1596 PASS, 0 FAIL, 1 ignored. Pelny default-feature
runner kontrakt jest zielony; nie jest dowodem fizyki, FEM/GPU czy calego API.
Hosted UI #38076746462: 105 Vitest PASS w czterech plikach, piec manifest
regressions PASS, architecture i pelny typecheck PASS. Cale workflow nadal
FAIL przez React Doctor: 9 errors/617 issues/57 score. Dokladny report
i manifest source identity pobrano; hashe zapisano w ci-evidence JSON.
[Zakres blokady UI](ui-ci-gates-20261010.md) rozdziela te wyniki od browser.

Native CPU selected-window rerun #38076759242 na exact fe99244d trwa.
R2 P2 note/map przed kolejnym diagnostic change dopuszcza odczyt konfiguracji
live PCLU przez publiczne PCFactorGetShiftType/GetShiftAmount z pinned
PETSc v3.24.6. Jest to read-only configuration query, nie pomiar rzeczywistej
perturbacji faktora ani zmiana polityki LU. Getter failure nie moze byc
zastepowany requested value; source/runtime proof i dalszy eksperyment
unshifted exact-Schur pozostaja odrebne. Mapa naukowa przeszla walidator.
P0-P10 nadal nie jest zamkniete.


## P2/P10 - kolejne source-reviewed korekty

Private live-PCLU query zostal zlozony bez zmiany solver configuration,
operatora ani residual gate. SOURCE review PASS: exact PCLU guard, niezalezne
getter codes, raw/mapped enum, finite amount i null/partial dla braku odczytu.
Serializer zachowuje perturbation_measured=false i nie duplikuje kluczy.
Review wykryl, ze count-only fixture wraca przed nowymi query assertions.
Dlatego istnieje osobny CLI/CTest alias live_shift_configuration w istniejacym
floquet-count-slepc profile; count-only nadal pozostaje osobny.
GHA rzeczywistego odczytu oczekuje wykonania, bez przypisywania mu PASS
na podstawie fixture serializer. Mapa naukowa i AST profilu PASS.

Piec API fixture corrections ma SOURCE review PASS: missing m usuwa oba
zrodla, mat_ms jest opublikowane przez fizyczny publisher, trzy FrozenSpins
requests maja rzeczywista revision po publikacji; stale/topology guards
pozostaja. To nie zamyka szostego API failure. Wspolny resolver m wybiera
stary cache z jawna provenance przed rzeczywiscie nowszym physical live m.
Sam precedence fix jest niewystarczajacy: carry-forward starego bufora moze
falszywie nadac mu nowy step, a meta/frame/bundle/readiness maja oddzielne
selektory. Nastepna poprawka musi zachowac payload source identity i atomowe
bundle, a status materializer oceniac wzgledem wybranego zrodla.
Nie zmieniono oczekiwania failing live-vector testu ani guards produkcyjnych.


## P4 - poprawne wymuszenie lokalnego retry

Native #38076759242 na exact fe99244d zbudowal CPU test poprawnie. Phase
i typed transport CTest PASS; selected-window FAIL na wymaganiu lokalnego
retry. Dotychczasowe trzy bliskie modes nie wymuszaja nasycenia nowego
4x NEV raw pool. Source-reviewed fixture ma szesc bliskich frequencies i
zewnetrzne witnesses: base request 2/NEV8 musi powiekszyc sie do4/NEV16.
Final lokalny accepted list jest ograniczony do4; raw pool i certified
guards osobno dowodza krawedzi. Refined NEV/NCV pozostaja bounded actual
split dimension. Nie zmieniono produkcji, tolerancji ani rank gates.

Review nowej assertion ujawnil drugi problem helpera testowego: pierwszy
'}' nie zamyka calego subwindow przy nested modal_krylov_tuning. Matcher
teraz uwzglednia nesting, strings i escapes. Wszystkie nowe odczyty sa
ograniczone do jednego obiektu; osobna regresja odrzuca pole z nastepnego
obiektu oraz unclosed JSON. SOURCE review PASS, wykonanie wymaga GHA.
Private live-factor query w b6e13fc60 ma osobny hosted run #38078081246;
nie przypisujemy jego ewentualnego wyniku pozniejszym fixture sources.


Private query run #38078081246 na exact b6e13fc60: native build PASS,
count-admission CTest PASS (certified_count odrzuca brak count certificate).
Serializer regression przed CLI branches wykonala sie bez bledu. Osobny
live-shift CTest FAIL przed production SLEPc na legacy synthetic fixture;
actual getter measurement pozostaje NOT VERIFIED. Poprawka ma uzyc
kanonicznego native FIELD/DEMAG fixture, ktory przeszedl count-admission,
zamiast oslabienia R4. Bounded failure diagnostic jest wymagany przed
asercja, aby zachowac rzeczywisty status i powod odrzucenia.


## Checkpoint b176d824 — poprawione fixtures P2/P4

Poprawka lokalnego retry i odczytu zagnieżdżonych obiektów JSON jest na remote
`b176d824ce21eca7f96132ebac6579e61d53a753`. Hosted modal-phase-slepc
[38080351130](https://github.com/MateuszZelent/fullmag/actions/runs/38080351130)
trwa; nie zapisujemy sukcesu przed terminalnym receipt.

Osobna fixture pomiaru konfiguracji PCLU korzysta teraz z fizycznego
shared-domain/native-count owner, pustego legacy Aqq CSR i targetu gamma0 H /
(2 pi) z niezależnego oracle. Zachowuje dotychczasowe strict admission i limit
jednej iteracji. Wypisuje ograniczoną diagnostykę przed asercjami. Pomiar
konfiguracji getterów nie oznacza pomiaru faktycznej perturbacji faktoryzacji.

Root i niezależny source review: PASS po poprawce źródła liczników PCApply
(rodzic live_pc_observation; gettery w borrowed_pmat_copy). Faktyczne wejście
do SLEPc, oczekiwany hard failure i wykonanie getterów pozostają NOT VERIFIED
do hosted CTest. Nie zastępuje to rozwiązania problemu KSP ani kwalifikacji P2.


## P3/P7 — korekta jednostek właścicieli i potwierdzona luka RF

Kanoniczna nota 0831 rozdziela lokalny generator LLG (1/s, masa
bezwymiarowa), objętościową formę dynamiczną (m3/s, m3) i shared-domain
hesjan energii (J, Js). Sprzężenie potencjału do wiersza energii ma J/A;
magnetyczny residual tego właściciela ma J. Geometryczna masa overlap
w m3 pozostaje oddzielna. Root i niezależny source review: PASS;
walidator mapy naukowej: PASS. Korekta nie zmienia macierzy runtime.

Nowy podpunkt P7: obecny producer RF projektuje bezpośrednio pole w A/m
na tangent frame, a driven solver kopiuje przekazaną projekcję do RHS.
Nie wykazano realizacji wymaganego torque i przekształcenia wierszy SI.
Przed kwalifikacją RF należy poprawić konwersję u konkretnego właściciela
i potwierdzić circular/elliptic macrospin, amplitudę, fazę, znak oraz
direct-response parity. Shared-domain modal assembler nie ma obecnie RF
RHS. Nie zmieniamy wejściowego raportu R2 ani nie deklarujemy, że ta luka
została naprawiona tylko przez aktualizację dokumentacji.

P2 getter fixture jest na remote `b8675a329e34db1ea491a5b96aa9410cdca66e63`;
hosted floquet-count-slepc [38080625714](https://github.com/MateuszZelent/fullmag/actions/runs/38080625714)
trwa, oczekiwany pomiar pozostaje NOT VERIFIED.


## P3 — prywatny kontrakt energy mass i niezależny oracle

Przed kodem zapisano wymagany znak B_alpha=-G-R_alpha oraz bilans energii
w nocie 0831, razem z osobnymi interpolacjami Ms/alpha i domyślnie
wyłączonym prywatnym opt-in. Canonical source-map validator: PASS.

Dodano siedem niezależnych testów algebry: original complex QZ kontra
doubled-real physical sector, circular/elliptic/overdamped macrospin,
complex Hermitian Hessian, physical degeneracy rank, frame covariance
i energy-loss sign. Root oraz niezależny source/math review: PASS;
AST: PASS. Testy nie importują adapterów Fullmaga, nie mierzą realnego
demag i nie kwalifikują siatki/Floqueta ani native Include.

Workflow eigensolve-damping-oracle wykonuje je wyłącznie w GHA
z NumPy 2.2.6 i SciPy 1.15.3. Wykonanie pending. Prywatna realizacja
energy mass jest przygotowywana w oddzielnym fragmencie; jej source
review, hosted assembly i dopiero integracja exact-damping physical
sector/original residual pozostają wymaganymi etapami P3.


## P10 — spójność wybranego fizycznego źródła m

Poprawiono wspólny resolver wartości/meta/catalog/frame/bundle/readiness.
Nowszy kwalifikowany physical live payload nie jest ukrywany przez starszy
Latest/Preview. Przed progress lub starszym callbackiem 8→7→6 bufor kroku 8
jest zachowany w istniejącym cache z pierwotną tożsamością, bez wymyślonego
scientific revision. Grid overflow, jawna obca FEM generation i sama zmiana
topologii nie kwalifikują starego m. Actual bindery nie certyfikują ponownie
zarejestrowanego starego payloadu w nowej domenie. Nie przenosimy starego
m preview przez zmianę domain/topology.

Starszy Pending/Error nie degraduje wybranego accepted physical m także po
jego zachowaniu w Latest; brak accepted frame i status tego samego/nowszego
kroku nadal blokują. Reguła dotyczy tylko m, pozostałe quantity guards
zachowano. Bundle wymaga rzeczywistego zgodnego physical scalar row i
carriera; positive fixture wymaga nonnull i sprawdza exact frame/topology/
fingerprint. Negative cases obejmują absent/mismatched row.

Root i niezależny source review PASS po naprawie dwóch dodatkowych P1
(utrata m8 przez starszy callback i recertyfikacja w actual binderach) oraz
statusu po zachowaniu bufora w cache. Cztery pliki parsują się stdout-only
rustfmt, diff check PASS. Kompilacja i wykonanie API pozostają NOT VERIFIED
do świeżego hosted rust run; nie jest to zamknięcie całego P10 ani browser proof.

Aktualny dowód P3: hosted [38081980214](https://github.com/MateuszZelent/fullmag/actions/runs/38081980214)
na `36da16235309b3c57db253bb784cdea9ffeb1df4` — 7/7 niezależnych testów
algebry PASS. Dowód P4 [38080351130](https://github.com/MateuszZelent/fullmag/actions/runs/38080351130)
na b176d824 — build, phase i typed transport PASS, selected-window FAIL;
dokładna fixture/powód nie są widoczne w dotychczasowym logu. Dodawana
diagnostyka nie zmienia modelu ani progów. Receipty i hashe zapisano w JSON.


## P3 — prywatny assembly gotowy do hosted weryfikacji

Dodano default-false include_gilbert_damping, alpha pointer/count/fallback
i przekazanie alpha z descriptoru. Produkcja nadal nie aktywuje opt-in
i nie dopuszcza native Include. Aktywny B składa -R_alpha przed C^H B C;
Ms/alpha interpolowane są osobno. Dodano walidację, overflow guard i
active-only dependency digest. Ignore B i dotychczasowy digest zachowane
dla legalnych alpha. Nie zmieniono publicznego ABI ani tolerancji.

Root i niezależny source/math review PASS. Regresje tet/prism mierzą
alpha0 wraz ze strukturą CSR, independent quadrature, wrong-product
discrimination, Rayleigh sign, phase/frame covariance, fallback, zmianę
aktywnego alpha/digest i invalid/overflow. Map validator oraz diff check
PASS. Compile/execution pending hosted positive-mass; nie jest to publiczna
ani zakwalifikowana exact-damping capability.

Oracle rozszerzono o ósmy przypadek: dodatnie alpha przy saddle Hessian
zachowuje genuine growing physical mode. Nie wolno odrzucać go tylko
przez znak Im Omega. Historyczne 7/7 z #38081980214 pozostaje dowodem
niezmienionych siedmiu przypadków; wykonanie ósmego pending.

P2 [38080625714](https://github.com/MateuszZelent/fullmag/actions/runs/38080625714)
na b8675a329 — build i count contract PASS; native nearest dociera do
SLEPc, lecz max_linear_iterations=1 kończy się przed dodatnim recursive
callbackiem (true_probe_attempt_count=0), więc live getters nie wykonują
się. Source correction zwiększa wyłącznie budżet fixture do 64; asercje
prawdziwego pomiaru pozostają. Nie zmieniamy polityki LU bez jego dowodu.

P10 jest na remote `21403fc7331d6dd01e22fb4057ab09e059490592`;
hosted Rust [38082733810](https://github.com/MateuszZelent/fullmag/actions/runs/38082733810)
uruchomiony, terminalny wynik jeszcze nieznany.


## P2/P4 — fixture observability po terminalnych błędach

P2: max_linear_iterations 1→64 dotyczy wyłącznie prywatnej native-count
measurement fixture. Callback mierzący candidate jest wywoływany dopiero
po dodatnim default recursive reason. Poprzedni limit 1 nie osiągnął tego
punktu; nie zwiększamy tolerancji ani nie fabrykujemy wartości getterów.
Nowy budżet sam nie gwarantuje pomiaru ani hard failure — test nadal wymaga
prawdziwych kodów 0, finite configuration, PCApply i EPS callback counters.

P4: dziewięć focused cases wypisuje nazwę przed wykonaniem. Dwa positive
window solves bez wcześniejszej diagnostyki drukują bounded certificate,
diagnostics oraz head/tail subwindows tylko po błędzie. Ten sam solve,
model, kolejność, asercje i returned status pozostają zachowane.
Root i niezależny source review PASS. Hosted powtórzenie wymagane.

P3 private assembly jest na remote `f2bbdf31043ce80c2c859d5a58aa529867225574`;
hosted positive-mass [38083353383](https://github.com/MateuszZelent/fullmag/actions/runs/38083353383)
uruchomiony. Wykonanie wciąż NOT VERIFIED.


## Hosted checkpoint — osiem oracle PASS, API compile fixture correction

[38083332284](https://github.com/MateuszZelent/fullmag/actions/runs/38083332284)
na `f2bbdf31043ce80c2c859d5a58aa529867225574`: **8/8 PASS** niezależnego
complex-QZ/physical-sector oracle, także genuine growth przy dodatnim
alpha. To nadal nie jest assembly/runtime FEM qualification.

[38082733810](https://github.com/MateuszZelent/fullmag/actions/runs/38082733810)
na `21403fc7331d6dd01e22fb4057ab09e059490592`: kompilacja nowych API
regresji zatrzymała się na E0597, tymczasowym RwLockWriteGuard w tail
expression testu zmiany topologii. Poprawka tylko fixture: jawny guard
i obowiązkowe expect obecnej sesji. Source parse PASS; brak production
code change. Nowy hosted run jest wymagany; wcześniejszy nie wykonał
nowych regresji i nie dowodzi runtime.

Native fixture observability jest na remote
`c26c87f934309d625aa64a87124e61e4fe9b7ed6`. Ponowienia z tym source SHA:
count/live LU [38083482772](https://github.com/MateuszZelent/fullmag/actions/runs/38083482772)
oraz selected-window/phase/typed [38083492602](https://github.com/MateuszZelent/fullmag/actions/runs/38083492602).
Oba pending; private assembly #38083353383 również pending.


## Hosted checkpoint — private assembly PASS, P2/P4 nadal otwarte

#38083353383 na f2bbdf31043ce80c2c859d5a58aa529867225574: prywatne
MFEM assembly 1/1 PASS (także Gilbert mass). SLEPc i GPU OFF;
pełny damped solve pozostaje NOT VERIFIED.

#38083482772 na c26c87f934309d625aa64a87124e61e4fe9b7ed6:
build/count contract PASS, live LU measurement FAIL. Nawet budżet 64
nie osiągnął dodatniego recursive reason; true_probe_attempt_count=0,
EPS error82. Potrzebna zmiana sposobu obserwacji lub adekwatnej fixture,
nie kolejne ślepe zwiększenie budżetu ani zmyślony pomiar.

#38083492602 na tym samym SHA: named retry fixture FAIL z
frequency_window_refinement_disagreement / cluster_frequency_mismatch.
Base/refinement wybierają różne mody z gęstego pasma; analiza przyczyny
trwa. Certyfikat słusznie pozostaje not_certified, window_complete=false.

P0 direct C ABI: potwierdzona utrata intencji Include w shared-domain
assembly. Korekta fail-closed w przygotowaniu; null zachowa legacy Ignore,
unknown/empty token będzie validation_error, shared Include unavailable.
Caller-provided matrices mają odrębnego właściciela i nie są globalnie blokowane.


## P4 — korekta utraty interior modes przez publication cap

Źródłowo potwierdzono, że child cap odrzucał wykryte fizyczne mody,
a szersze signed guards mogły zatrzymać retry. Prywatny window child
zachowuje teraz istniejący deduplikowany pool po residual certification;
agregacja filtruje go do child interval. Public nearest i final global
cap nie zmieniają się. Brak dodatkowej kopii eigenvectors lub zmiany ABI.

Regresja dense interior sprawdza cztery właściwe częstotliwości
1.10/1.12/1.14/1.16 GHz i sześć lokalnych modów; nie wymaga retry, jeśli
EPS już zwrócił wystarczający pool. Osobne retry/edge-failure przypadki
zachowano. Root i niezależny source review PASS, diff/map validator PASS.
Hosted wykonanie pozostaje wymagane; spectrum count nadal not_performed.


## P0 — direct C ABI damping admission

Po ABI/enums walidujemy null/ignore/include; unknown/empty są validation_error.
Shared-domain Include jawnie zwraca unavailable przed każdym aliasem assembly,
zachowując requested execution i brak fallbacku/modów. Caller-provided
matrices pozostają poza tą blokadą. Nie jest to aktywacja exact damping.

Dodano dedicated CLI/CTest do istniejącego managed modal-phase-slepc: tokeny,
null/ignore parity, CPU K0/sparse/dense i GPU-v20 (odmowa bez GPU execution),
alpha0/dodatnie oraz nonshared matrices. OFF build ma zwrócić unavailable3,
nie full PASS za pominięte shared cases. Root/static i niezależny review
PASS po tej korekcie; hosted wykonanie wymagane.

P4 private discovery jest na remote 7be53ea1524d018fcc56295f4a01fe5542040f1d;
ponowienie #38085530937 w toku. P10 Rust #38083872121 również w toku.
