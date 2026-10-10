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
