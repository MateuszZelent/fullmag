# Pierwsza odmowa interpolacji RT0 — plan ograniczonej diagnostyki

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Zachować dane rzeczywistej odrzuconej komórki bez zmiany bramki przyjmowania wyniku.
**Architecture:** Dopisać świadka do istniejącego RunError tylko przy pierwszej odmowie. Istniejący stderr/supervisor zapisze go w worker exit receipt; brak nowego endpointu lub accepted artefaktu.
**Tech Stack:** Rust, serde_json, istniejący FEM CPU/double, managed just Docker/WSL.
**Spec:** [wynik próby](2026-11-08-generated-authoring-corner25-sequence-result.md) i [nota właściciela fizyki](../../physics/0951-sushruth-2020-forward-volume-reference.md).

Status: propozycja do decyzji. Patch produkcyjny nie jest wdrożony.
Nowy build/Prepare/Submit/Solve w ramach tego planu:0.
Poprzednia pojedyncza zgoda została wykorzystana; Failed zakończył jej sekwencję.

## Potwierdzony stan i dowód pomocniczy

Run0b9ca0be… zakończył się Failed przy cell-local J interpolation mismatch.
Walidacja closed_loop_v2.rs::build poprzedza zapis artefaktów. Worker nie istnieje,
temp jest pusty, w worker-attempts zostały tylko execution_started i live_observation.
Nie mamy snapshotu rzeczywiście odrzuconej komórki.

Wykonana niezależna arytmetyka użyła współrzędnych komórki5843 z przygotowanej
siatki i syntetycznych współczynników RT0 po2^-100 A. Nie rozwiązywała obwodu.
Dokładne ułamki, jawny model sumowania z64bitami mantysy dla long double
i końcowe nearest-even binary64 dają różnicę6,333070233679038e-29 A/m²
przy dotychczasowym budżecie3,450721313193274e-30 A/m²: iloraz18,3528881612826.
Po dokładnej translacji y do lokalnego początku różnica znika.
Kontrola stałego pola i kontrole zaokrąglania przechodzą; sześć kontroli PASS.
To dowód możliwości niespójności próbkowania, NIE przyczyny rzeczywistego runu,
wykonania C++ ani kwalifikacji źródła.

Dowody ext4: examples/sushruth_2020_closed_gsg/centroid_arithmetic_20261108/.
arithmetic_audit.py SHA256:9d7a0969205cdb6a10a94291a8c40e9c548d0ff4cb075b7b60a8f88cd763c2f9.
arithmetic-audit.json:07916965091ec3260aadad72840afd3a71b0f98218756cc666a5269f659ce7b3.
manifest.json:76a134c48f7d197b24f80ede395451285078b7d814f936c53357ebc8edcbc4d0.

## Global Constraints

- Predykat finite i128epsilon64, kolejność komórek/osi, affinity/moments i bilanse pozostają identyczne.
- Nie zastępować center J średnią wierzchołków. Nie publikować częściowego wyniku.
- Bez zmian Python/ProblemIR, accepted schematu, OpenAPI/UI, .env, limitów, profili lub recovery.
- Nowy build wyłącznie w istniejącej grupie3203; bez lokalnej kompilacji testów Rust.
- Bez Gmsh, nowego meshowania i docker-dev-gsg-mesh-prepare: jedna proponowana próba użyje tej samej siatki40728Tet4/14194węzły/20H. Nowy run przejdzie zwykłe admission/materialization/przygotowanie; bez kopiowania receipt poprzedniego taska.
- Bez H-only, LLG, automatycznego retry, usuwania danych i zmiany historycznego Failed.
- Każda odmowa kończy sekwencję. Requested minima i resolved grant raportować oddzielnie.

## Review Focus

1. Diagnostyka nie może dodać panic, zastąpić pierwotnego powodu lub zmienić wyniku predykatu.
2. Bity u64/f64 zachować dokładnie, również signed zero i NaN payload; JSON bez liczbowego NaN/Infinity.
3. Cały RunError.message<=2048B: supervisor zachowuje2816B raportu, receipt dopuszcza4096B.
4. Świadek dotyczy pierwszej odmowy; niewalidowane jeszcze preimages nie są nazwane potwierdzonym źródłem.
5. Normalny supervisor zachowuje komunikat; jego awaria przed zapisem NIE gwarantuje odzyskania świadka.

## Zadanie1 — świadek i regresje bez zmiany walidacji

**Files:**
- Modify: crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2.rs.
- Modify: crates/fullmag-runner/src/antenna_field_solution/closed_loop_identity_v2_affinity_tests.rs.
- Modify: crates/fullmag-api/src/accepted_study_supervisor.rs — tylko regresja istniejącego transportu.

**Interfaces:** prywatne verify_center_current(cell:&ClosedLoopCurrentCellV2,
points:&[[f64;3];4],axis:usize,faces:&BTreeMap<[u64;3],f64>)->Result<(),RunError>.
Przenieść obecne mean/j_scale/predykat bez zmiany arytmetyki.
Wywołać w tym samym miejscu verify_owned_geometry; bez alokacji przy sukcesie.
Przy odmowie zachować początek closed-loop identity refused: cell-local J interpolation mismatch.
Dopisać compact ASCII JSON schema fullmag.rt0_center_failure.v1:
element,axis,4vertex IDs,12XYZ,12vertex J,3center XYZ,3center J,
mean/scale/absolute_difference/budget oraz4canonical face flux.
U64/f64.to_bits kodować hex16. Strumienie w kolejności opposite_local_vertex,
lookup po posortowanych stable IDs, znak canonical_sorted_ids; brak lookup=null.
Bez pełnych preimages, swobodnych stringów lub deklarowania nieobecnych współczynników MFEM.
Lokalne XYZ już są bitowo porównane z globalnymi przed tą bramką; jedna kopia wystarcza.

- [ ] Step1: Test center_current_failure_diagnostic_preserves_bits_and_bound:
  fixture zawiera u64::MAX, signed zero i center J z NaN payload. Odczyt wszystkich bitów
  z JSON jest dokładny, rozmiar całego błędu<=2048B. RED przed nowym helperem.
- [ ] Step2: Test center_current_failure_diagnostic_keeps_gate:
  cztery stałe wartości8A/m²; center8+128epsilon*8 jest przyjmowane,
  kolejna większa liczba binary64 jest odrzucana; dwie błędne osie dają pierwszą oś0.
  Niefinitywne vertex J nadal dają dotychczasową wcześniejszą odmowę.
  Sprawdzić rzeczywiste verify_owned_geometry: błędne J osi0 wraz z błędną
  geometrią osi1 daje odmowę J osi0; błędna geometria osi0 wraz z błędnym J osi0
  daje dotychczasową odmowę geometrii. Zachować przeplatanie XYZ/J, bez reorder.
- [ ] Step3: Wdrożyć wyłącznie wskazany prywatny helper i warunkowe tworzenie świadka.
  Nie dodawać release-assertion lub truncation zastępujących rzeczywistą odmowę.
- [ ] Step4: Test worker_failure_reason_keeps_rt0_center_witness:
  pełny wrapper anyhow/RunError, wcześniejszy szum i640B stdout; cały świadek przetrwa
  worker_failure_reason; wyodrębnić i sparsować cały JSON, porównać wszystkie bity.
  Raport od accepted worker failed:<=2816B, failure_reason<=4096B; serialize,
  deserialize i FmsWorkerProcessExitReceipt::validate_for_lease zachowują świadka.
  Bez obietnicy recovery po awarii supervisora.
- [ ] Step5: Review dokładnego diffu, nowe regresje i istniejące affinity/moments
  oraz testy transportu przez dozwolone CI. Bez skip i lokalnego Cargo.
  Brak pozytywnego końcowego CI blokuje aktualizację. Commit/push brancha zadania.

## Zadanie2 — jeden odbiór na identycznym przygotowanym wejściu

Bez nowego meshowania nie oznacza pominięcia przygotowania/admission nowego taska.

**Interfaces:** istniejące docker-dev-restart-saved-authoring,
docker-dev-submit-accepted oraz materialize-accepted wyłącznie dla tego samego runu.

- [ ] Step1: Potwierdzić profil exec:default@1, brak aktywnych workerów/lease,
  pustą kolejkę/control i źródła. Zachować scenę/FMS/Python oraz nowy checkpoint.
- [ ] Step2: Jedna managed aktualizacja3203 z natywnym drain; odebrać pakiet/API/CLI,
  scenę i historyczne wyniki. Bez zmiany mountów i kasowania kontenerów.
  API może być czasowo niedostępne podczas aktualizacji.
- [ ] Step3: Zamrozić nowy request z compact80b177c9f483ae5288c9d7dc80cc121bc63d6e3ebde25a8bf28faa262bc2a8d0
  z Prepare9440b363eda74047ba4d768dac1baaa1. Zmienić tylko
  run_intent.specification.run_id oraz run_intent.idempotency_key.
  Wygenerować ID raz i zachować nowe bajty/SHA przed Submit.
  Reszta JSON, piny/asset_paths, fizyka i zasoby muszą być identyczne.
  Zachować różnicę JSON dowodzącą dokładnie dwóch zmian. API wyliczy nowy
  fingerprint, bo obejmuje on run_id; nie przypinać fingerprintu poprzednika.
  Odmowa admission kończy zakres, bez nowego Prepare.
- [ ] Step4: Run404 i brak fence, potem jeden Submit. Niepewny transport oznacza GET,
  nigdy powtórny Submit. Ten sam fingerprint w pending_materialization pozwala
  na jedną istniejącą materializację tego runu.
- [ ] Step5: Failed: zachować exit receipt i świadek na ext4; offline odtworzyć
  centroid, RT0 z kanonicznych momentów oraz obecną nierówność. Nie nazywać świadka
  zaakceptowanym source snapshotem. Succeeded: odebrać V/J/H publicznym API,
  bez kolejnej próby wymuszającej błąd. Sprawdzić zwolnienie lease/rezerwacji.
- [ ] Step6: Raport z pinami i faktycznym wynikiem. Brak trwałego komunikatu po awarii
  nadzorcy oznacza NOT VERIFIED, bez nowego recovery. Dane naukowe na ext4;
  techniczne dowody buildu w wolumenie grupy.

## Decyzja i ograniczenia

Przyszła poprawka semantyki centroidu wymaga pomiaru i oddzielnego uzasadnienia.
Ten plan obejmuje diagnostykę, testy, jeden build i jedną nową próbę bez nowej siatki.
Nie deklaruje reprodukcji publikacji, E3 ani poprawy eta.
Przekazane AGENTS.md §8 wymaga zgody na zmianę chronionej bramki wyniku;
poprzednia zgoda zakończyła się po jednym Failed.
Skill writing-plans wymaga przeglądu planu przed implementacją.


## Przegląd przed decyzją

Niezależny odczyt potwierdził zgodność powyższej ścieżki z kodem.
Uwzględniono trzy wymagane doprecyzowania: przeplatanie XYZ/J,
pełne parsowanie świadka po rzeczywistym worker_failure_reason i rozróżnienie
meshowania od zwykłego przygotowania accepted taska.
Publiczny RunIntent pozwala na nowy run_id/idempotency z tym samym wejściem;
istniejący router_v2/tests/project_documents.rs sprawdza ten wzorzec z HTTP201.
Nie kompilowano nowej diagnostyki ani jej testów; to odbiór gotowości planu.
