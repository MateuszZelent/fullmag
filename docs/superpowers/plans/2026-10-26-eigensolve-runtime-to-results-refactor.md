# Plan refaktoryzacji: uruchomienie eigensolve i trwały zapis danych

Data: 26.10.2026. Audyt i plan zapisano przed wznowieniem celu. Obecny etap:
**zadanie 6/8 — A13 runtime PASS; worker Eigen wystartował i zakończył się exit 1; A14 ucina przyczynę błędu**.

Źródło stanu: [audyt wykonania](../../audits/2026-10-26-eigensolve-runtime-to-results-audit.md)
i [evidence JSON](../../audits/2026-10-26-eigensolve-runtime-to-results-audit.evidence.json).
Bieżąca lista zadań znajduje się w tym pliku, zgodnie z repozytoryjnym
katalogiem planów. Nie tworzymy konkurencyjnego `tasks/todo.md`.

## Cel i warunek zakończenia

Użytkownik uruchamia Fullmaga w przypisanej grupie Docker, wykonuje accepted
Relax→Eigen dla jednego DE nonzero-k, otrzymuje zaakceptowaną częstotliwość
oraz rzeczywisty zespolony mod. Dane są trwale zapisane i dają się odczytać
po restarcie bez ponawiania Solve. UI pokazuje wynik właściwego run/stage/
sample/mode i jego pole. Następnie ten sam przepływ wykonuje signed sweep
15 punktów i generuje wykres z rzeczywistych artefaktów.

Dowód końcowy zawiera: worktree/SHA/snapshot, manifest builda i rozwiązania,
requested/resolved CPU double, run/attempt/epoch, dokładny k w SI, częstotliwość,
diagnostyki i residuale, certyfikat równowagi, zespolone pole/topologię,
release proof, ścieżki i hashe danych oraz pozytywny odczyt po restarcie.

To nie jest zgoda na obniżenie tolerancji ani certyfikat dowolnego solvera.
Kompletność widma, zbieżność i COMSOL A1 ≤0,5% pozostają oddzielnymi bramkami.

## Reguły realizacji i raportowania

1. Każdy komunikat podczas dalszej pracy zaczyna się od `Zadanie X/8:`.
   Po tym: konkretny wynik, obecna blokada i najbliższa weryfikacja.
2. Numery 1–8 pozostają stałe. Mniejsze prace oznaczamy 3.1, 3.2 itd.
   Nowy problem trafia do istniejącego etapu lub jawnej rewizji planu, bez
   ukrytego dodawania niezależnej migracji.
3. `Kod gotowy`, `CI PASS`, `runtime PASS`, `dane odczytane` i `UI PASS` są
   odrębnymi stanami. Etap jest zakończony wyłącznie po własnym odbiorze.
4. Jedna hipoteza i jeden ograniczony diff na krok. Najpierw dowód przyczyny,
   potem poprawka i adekwatna regresja. Bez ponownej naprawy czegoś już obecnego.
5. Bez nowych buildów z niekompletnego WIP, replay Solve po nieznanym wyniku,
   ręcznej edycji lease/proof, podmiany provenance lub uruchamiania poza grupą.
6. Testy kompilowane Rust/JS tylko w GitHub Actions. Lokalnie lekkie testy
   Pythona, odczyty i dozwolone kontrole składni. Build aplikacji przez istniejącą
   receptę Docker; dane techniczne pozostają w jej wolumenach.
7. Zachowujemy foreign WIP, stare sesje, artefakty i receipty. Obecna kopia
   przerwanej implementacji pozostaje nienaruszona. Nie łączymy tego planu
   z aktualizacją bibliotek, czyszczeniem dysków lub przebudową całego launchera.

## Docelowy podział odpowiedzialności

| Warstwa | Odpowiedzialność |
|---|---|
| Launcher Python | Wybór grupy, exact source/config/container pins, wywołanie kanonicznej recepty i natywnej operacji; bez ustalania fizycznego sukcesu |
| Kontekst operacji maintenance | Jeden utrwalony request i model faz, brak konkurencyjnych interpretacji sukcesu/replay; referencje do canonical receiptów |
| Rust/session + ledger | Autoryzacja i walidacja zasobów, fencing, rzeczywisty release i normalny proof; bez kwalifikowania wyników naukowych |
| Supervisor | Wyjście procesu, trwała projekcja terminalna i cleanup niezależny od nieudanej konwersji SolutionSet |
| Accepted Relax/Eigen adapters | Wyłącznie typowane wejście/wyjście, certyfikat równowagi i modal bundle właściwego ownera |
| Result publication | CAS/generation/manifest/SolutionSet w uporządkowanej publikacji; Succeeded po pełnej barierze |
| API/UI | Odczyt commitowanej generacji oraz dokładna selekcja run/stage/sample/mode; brak syntetycznych danych |

Refaktoryzacja ma usunąć duplikujące się odpowiedzialności, nie tylko rozdzielić
1661 linii na kilka równie złożonych plików. Reużywamy istniejących helperów
control/source/package zamiast nowego launchera lub drugiego systemu grantów.

## Rejestr etapów

| Zadanie | Stan przy publikacji planu | Dowód wymagany do zakończenia |
|---|---|---|
| 1/8 — audyt i zamrożenie | Zakończone dokumentacyjnie | Audyt, evidence, kopia WIP, ten plan |
| 2/8 — spójny kontrakt i źródła | Zakończone: Rust CI i native preview PASS dla `ccc38b7c3` | Review kontraktu, kompletny zakres kodu, zielony odpowiedni build/CI |
| 3/8 — zamknięcie zakończonego workera | Zakończone: local/host Released, normalny proof i zachowane dane | Exact local Released + host Released + normalny proof, dane bez zmian |
| 4/8 — poprawny start runtime | Start runtime i bieżący sample potwierdzone; późniejsza awaria compute opisana w A12 | Ready owner i bieżący sample, działający scheduler bez kwarantanny |
| 5/8 — zaakceptowany Relax | Nowy Relax Succeeded, handoff CAS i certyfikat matched; odbiór Eigen blokuje A12 | Certyfikat w CAS i zaakceptowane wyjście do Eigen w nowym runie |
| 6/8 — rzeczywisty Eigen +10 | StepOutput CI PASS; nowy build gotowy, wznowienie blokuje A13 | Native frequency + residual + zespolony mod i terminalny sukces |
| 7/8 — trwały zapis i UI | Kod istnieje, pozytywny odbiór otwarty | Readback po restarcie bez Solve oraz widoczny właściwy mod |
| 8/8 — signed sweep i raport | Skrypt przygotowany, nowy sweep niewykonany | 15 rzeczywistych próbek, wykres/provenance i jawne ograniczenia |

Nie nadajemy procentów nieporównywalnym dowodom. Zakończenie zadania 1 nie
znaczy wykonania 12,5% pracy obliczeniowej.

## Zadanie 1/8: audyt i zamrożenie punktu wyjścia

**Zależności:** brak. **Zakres:** dokumentacja i odczyty, bez implementacji.

- [x] Sprawdzić HEAD, runtime commit/snapshot, lokalny WIP i rzeczywisty status solvera.
- [x] Zachować przerwane pliki; wskazać brakujący moduł i granice dowodów CI.
- [x] Spisać ustalenia, zależności i kryteria odbioru 2–8.

**Weryfikacja:** source excerpts/hashe w evidence JSON; 9 zachowanych plików;
status `waiting_for_compute`, 0 kroków. Dokumentacyjny diff bez zmian runtime.

## Zadanie 2/8: wybrać minimalny kontrakt i przywrócić spójne źródła

**Zależności:** 1. **Powiązane ustalenia:** A01, A02, A05, A06, A09.

**Sposób wykonania:**

- 2.1. Uzgodnić jeden model `inspect → prepared → validated → applying →
  released`, z osobnym `failed_before_apply` i `outcome_unknown`. Opisać
  restart po każdej granicy publikacji oraz właściciela każdej zmiany.
- 2.2. Zapisać decyzję dla cross-build maintenance. Wariant rekomendowany do
  review: jawny typowany dowód związany z exact store/request/Failed owner,
  historycznym canonical runtime oraz rzeczywistym nowym candidate i jego
  niezmiennym receiptem. Nie wprowadzać env/threadlocal bypassu. Nie dodawać
  alternatywnego SessionStore opener-a bez udowodnionej potrzeby.
- 2.3. Porównać ten wariant z istniejącym lifecycle. Sam pełny restart jest
  obecnie zablokowany przez Active/Quarantined; nie przedstawiać go jako
  dostępnego obejścia. Każde inne rozwiązanie musi przejść te same dowody.
- 2.4. Przejrzeć 9 plików WIP; zachować wyłącznie części wybranego kontraktu
  i dostarczyć brakujący moduł albo wycofać niekompletne referencje po kopii
  i review. Nie porzucać obcych zmian ani stage'ować całego worktree.
- 2.5. Odchudzić wrapper przez jeden typowany kontekst operacji i reużycie
  istniejących bounded read/source/package helperów. Każdy błąd od capture
  do terminal ma receipt z fazą i informacją, czy apply w ogóle wywołano.

**Przewidywane pliki:** `scripts/docker_volume_failed_worker_reconciliation.py`,
jego testy, `crates/fullmag-api/src/runtime_service_failed_worker_exit.rs`,
mały wyodrębniony moduł admission i rejestracja. Zmiany session/ledger osobno
w 2.2/2.4, nie jako jedna wielka przebudowa.

**Odbiór:**

- [x] Kontrakt ma review i brak niepotwierdzonych nowych abstrakcji; zwykłe admission nie osłabione.
- [x] Brak brakujących modułów; negatywne testy owner/path/SHA/source/replay i wymagane CI przechodzą dla dokładnego commita.
- [x] Zarządzany preview pełnej procedury działa; build aplikacji nie jest utożsamiany z release ani Solve.

### Decyzja 2.1–2.2: ograniczony kontrakt cross-build

Zwykłe admission nadal wiąże uruchomiony executable z kanonicznym pakietem i
provenance. W tym przypadku istniejący owner Failed pochodzi z wcześniejszego
buildu, a program realizujący naprawę z nowego. Normalny managed restart nie
jest alternatywą przed zwolnieniem rezerwacji, bo jego preflight słusznie
odrzuca Active/Quarantined. Nie ma podstaw do dodania innego opener-a sesji.

Kontrakt maintenance używa jawnego dowodu typowanego i wiąże jego czas życia
z faktycznym guardem ownera konkretnego magazynu. Pod istniejącymi blokadami
sprawdza ponownie: ścieżkę i root store, Failed owner i dokładny request,
exit receipt/lease/reservation, host/engine/image/fs/sentinele/probe/namespace,
kanoniczny historyczny pakiet i provenance względem builda ownera oraz osobny
pakiet kandydata względem compiled commit/snapshot, niezmiennego receipt,
źródeł i operation record. Hashowane są rzeczywiste pliki inventory;
wykonywany inode musi należeć do pakietu kandydata. Standardowe admission i
normalny publiczny release nie przyjmują dowolnego store ID lub zmiennej
środowiskowej znoszącej weryfikację. Inne profile storage odmawiają tej
ścieżki, dopóki nie mają własnego kontraktu.

| Faza | Trwały stan | Zachowanie po przerwaniu |
|---|---|---|
| Inspekcja | Preview, bez receiptu mutacji | Powtórzyć tylko po ponownym sprawdzeniu kontekstu. |
| Capture/build | Request/operation, ewentualnie `pre-native-failure.json` | Brak uruchomienia native; po timeout sprawdzić, czy proces Dockera nadal działa. Ten UUID nie wznawia automatycznie buildu. |
| Native preview | `prepare-receipt.json`: `candidate-prepared` wyłącznie po `validated` | Zmiana źródła, ownera, receipt lub scope odrzuca apply. Odmowa preview nie jest release. |
| Apply | Niezmienny `apply-start.json` przed wywołaniem native | Brak terminala oznacza wynik nieznany; wrapper nie ponawia go automatycznie. |
| Release | `terminal.json` z normalnym proof | Odtworzenie sukcesu wymaga tego samego requestu i exact scope. |
| Częściowe apply | outcome unknown, lokalny Released i host Quarantined są możliwe | Najpierw odczyt obu magazynów i ocena liveness workera; operacyjne wznowienie po potwierdzeniu brzegów jest częścią zadania 3, nie symulacją ani ręczną edycją JSON. |

Pod jednym aktywnym helperem rodzica wykorzystujemy istniejący kontrolowany
`resource-budget.lock` do serializacji operacji maintenance i zmiany zasobów.
Nie tworzy on nowego właściciela `/control/active`. Pojedynczy kontekst
`ReconciliationOperation` prowadzi fazę oraz informację, czy wywołano native;
błędy po timeout klienta zachowują informację o możliwym procesie Dockera.

Stan dowodów tego wycinka: lokalne testy Pythona przechodzą; zarządzany
preview **bez buildu i apply** przeszedł 26.10.2026 dla operacji
`741f2ee9-7388-4132-b828-0ca6217af629`. Osobny odczyt potwierdził zgodność
commita, snapshotu, receiptu i hasha historycznego pakietu z Failed ownerem.
Dalszy odbiór: commit `ccc38b7c3fe9cb1ecde0d85a4e32fc8790938b0a`; bootstrap Rust
`40398845779` i eigensolve `40398845759` PASS (1817 testów runnera, 0 błędów,
1 ignored). Linux/Windows artifact attestation `40398845844` PASS. Native preview
operacji `ada79f8d-9916-41dd-a9ec-c8053c2da6d8` zakończyło się
`candidate-prepared` / `validated`; receipt pakietu
`7ffc231f387fb2ee77b71f32f7387164c2774901cde8265aab77bfb84e727299`.
Nie jest to dowód zwolnionego lease ani uruchomienia solvera.

## Zadanie 3/8: zamknąć dokładnie historyczny Failed worker

**Zależności:** 2. **Ustalenia:** A02–A03, A06.

**Sposób wykonania:**

- 3.1. Ponownie odczytać pod guardami ownera, task/attempt/epoch, receipt,
  heartbeat, local lease, host reservation i policy. Użyć konkretnego exit
  receipt; nie skanowania wszystkich lease'ów jako zamiennika fence.
- 3.2. Przenieść do runtime istniejącą poprawkę rozdzielającą nieudaną
  konwersję SolutionSet od cleanup; sprawdzić, że normalny sukces nadal
  wymaga pełnej walidacji wyników.
- 3.3. Native preview nowej, przypiętej kapsuły; następnie exact apply przez
  właściciela protokołu. Pierwszy odmówiony UUID pozostaje w historii.
- 3.4. Sprawdzić obie fazy: faktyczny lokalny release, następnie normalny
  host proof. Przy awarii drugiej fazy host nadal Quarantined. Replay
  zachowuje pierwotny timestamp i nie dotyka katalogu/artefaktów.

**Przewidywane pliki:** `host_resource_ledger/failed_worker_exit.rs`, normalny
private release helper, testy; poprawki `solution_set.rs`/scheduler już istnieją.

**Odbiór:**

- [x] Wstrzyknięta awaria między fazami daje poprawny, idempotentny replay bez sztucznego proof.
- [x] W rzeczywistym runtime lease i rezerwacja są Released, istnieje normalny proof i dokładny scope wszystkich tożsamości.
- [x] Failed pozostaje Failed; 14 artifact IDs i raw katalog zachowane, brak ponownego Solve.

**Checkpoint po 2–3:** nie zaczynać restartu z niepotwierdzonym wynikiem apply.
Odmowa lub timeout wymaga inspect, nie zmiany progu lub ręcznej edycji JSON.

### Korekta 3.5: capture przy wznowieniu

Pierwsze apply operacji `ada79f8d-9916-41dd-a9ec-c8053c2da6d8` odmówiło
przed native (`native_invoked=false`, `daemon_operation_may_remain=false`):
`prepared candidate source capture differs from the current source`.
Commit, `source_digest` i snapshot pozostały identyczne. Producent manifestu
wiąże `live_manifest_sha256` także z nowym `capture_id` i `created_at`.
Wrapper błędnie przechwytywał ponownie do oryginalnej ścieżki i wymagał
identycznego hasha obu zdarzeń capture.

Poprawka zachowuje pierwotny `source-capture`, a aktualny odczyt wykonuje w
`source-verification`. Stabilny commit/content/snapshot musi pozostać zgodny.
Pakiet nadal wymaga pierwotnego live hash oraz niezmiennego receiptu;
bajty zachowanego manifestu są dodatkowo sprawdzane względem
`candidate.source.manifest_sha256`. Zmienione źródła albo manifest zatrzymują
procedurę przed `apply-start.json`. Test prepare→apply obejmuje różne hashe
capture, trzy rodzaje driftu i naruszenie oryginalnych bajtów. Dodatkowy test wykonuje embedded script na
rzeczywistych plikach tymczasowych i potwierdza zachowanie oryginału po dwóch
verification captures; 71 testów Pythona PASS. Review nie wykazało błędu
produkcyjnego; wskazana luka pokrycia została uzupełniona. Nowy rzeczywisty
prepare→apply zakończył się sukcesem; dowody poniżej.
Stara operacja i jej failure receipt zostały zachowane bez naprawiania manifestów.

### Odbiór zadania 3 — rzeczywisty runtime

Commit `4a99aaf1d4b7f661d77d15b72310714da0a0a9f9`, operacja
`218d327b-eb0a-4fde-8c0a-af6d2385f21e`: prepare i apply zakończone kodem 0,
`state=succeeded`, native `disposition=released`. Receipt kandydata:
`0b158e32153f1883d8dabcb471f66d982af209f7416e43fe7d7024231cbb4096`.
Normalny plik `host_resource_release_proof.v1` odczytano niezależnie i
sprawdzono jego SHA-256:
`570303f0d011757e00a3e3a0a62f8de47b3caddc1f8ab17b577e71addd745597`.

Proof wiąże konkretny historyczny run/task/attempt/epoch=1 i lease
`lease-ad1b7669c0c247f3b012afcc3a19b279` z process-exit receipt
`worker-process-exit-a81cd4224bf8f2fe21c3377c1c59945373a18f3fc96318f0b6c71715d13bd17f`.
Local i host mają `released`; timestamp `2026-10-26T21:21:22.644006017Z`.
Task pozostaje Failed, katalog zachował SHA-256
`90a7c1fc71aba6ef5129136862276da6c52866af1bf477cfeb59821c4211dd7d`
i wszystkie 14 artifact IDs. `solver_replayed=false`,
`artifacts_requalified=false`; oryginalny manifest zachował zgodność z receiptem.
To dowód odzyskania zasobów, nie nowy wynik fizyczny.

## Zadanie 4/8: wystartować runtime z poprawnym admission

**Zależności:** 3. **Ustalenie:** A04.

**Sposób wykonania:**

- 4.1. Rozbić diagnostykę warunku sample na brak ownera/sample, owner/epoch,
  status i wiek. Zapisywać expected/observed w chwili admission. Na tej
  podstawie odtworzyć wyścig albo ustalić inną przyczynę; nie zakładać wieku.
- 4.2. Zastosować istniejący managed diagnostic stop i zachowujące historię
  odtworzenie. Jeżeli potrzebny pusty stan bieżącej sesji, najpierw normalne
  archiwum i weryfikacja odczytu; bez kasowania starych wyników.
- 4.3. Zbudować i uruchomić dokładny checkpoint w tej samej grupie Docker.
  Admission startuje dopiero po zgodnym owner/sample i faktycznej gotowości
  schedulerów. Nie rozszerzać limitów freshness, by ukryć wyścig.

**Przewidywane pliki:** sampler/startup w `runtime_service_main.rs`, walidacja
host admission oraz wąski test kolejności, tylko jeśli diagnoza potwierdzi błąd.

**Odbiór:**

- [ ] Test brakującego/starego/obcego sample jest jednoznaczny i odrzucany, a prawidłowa sekwencja przechodzi.
- [x] Rzeczywisty start runtime Ready i zgodny sample owner/epoch potwierdzone; API przyjęło aktywację. Późniejsza awaria compute nie unieważnia dowodu startu, ale blokuje obliczenia (A12).
- [x] Tożsamość builda/runtime zapisana; nie wystartował niezamówiony lub powtórzony Solve.

## Zadanie 5/8: wykonać i opublikować accepted Relax

**Zależności:** 4. **Ustalenie:** A07.

**Sposób wykonania:**

- 5.1. Uruchomić raz nowy request `examples/fem_eigen_mode_ui_de_k10.py` przez
  normalną aktywację. Zapisać request/run/task/attempt przed dalszymi akcjami.
- 5.2. Odczytać native Relax receipt i certyfikat. Sprawdzić exact mesh,
  material, plan, owner i niezależny replay certyfikatu przed CAS publication.
- 5.3. Potwierdzić deterministyczne bajty planu i zaakceptowane wyjście
  `equilibrium_handoff` konsumowane przez Eigen. Przy nieznanym wyniku
  najpierw journal/inspect; bez drugiej aktywacji tego samego celu.

**Przewidywane pliki:** istniejące `accepted_relax_equilibrium.rs`,
`study_equilibrium.rs`, preflight/adapter; zmieniać tylko po konkretnym błędzie.

**Odbiór:**

- [x] Nowy Relax ma prawdziwe completed/converged i diagnostyki wymaganej konfiguracji CPU/double: 3 kroki, torque 2,6466332450953524e-11 A/m przy progu 1 A/m; demag residual 1,6180945995077723e-12.
- [x] Certyfikat w CAS i accepted output są spójne z exact planem/siatką/właścicielem.
- [ ] Eigen otrzymuje ten certyfikat; brak ponownej relaksacji i brak niejawnego fallbacku.

**Checkpoint po 4–5:** raportować osobno native Relax i opublikowany handoff.
Sam wcześniejszy wynik 3 kroków nie zalicza tego etapu nowemu runowi.

## Zadanie 6/8: obliczyć rzeczywisty Eigen dla DE +10 rad/µm

**Zależności:** 5. **Ustalenie:** A07.

**Sposób wykonania:**

- 6.1. Prześledzić modal dispatch, potwierdzić resolved `FemEigen`, CPU/double,
  `full_2x2`, dynamiczny demag i dokładny Floquet k z przyjętego planu.
- 6.2. Wykonać istniejącą ścieżkę PETSc/SLEPc. Zebrać częstotliwość,
  diagnostyki/residuale i prawdziwy zespolony mod. Nie zamieniać `nearest=1`
  na deklarację kompletnego okna.
- 6.3. Opublikować typowany modal bundle i SolutionSet właściwego run/stage.
  Rozdzielić błąd solvera, konwersji i publikacji. Succeeded dopiero po
  wymaganej barierze, cleanup również przy każdym błędzie.

**Przewidywane pliki:** `accepted_modal_study_worker.rs`, modal codec,
`accepted_study_worker.rs` i publikacja; numerics tylko jeśli dowody wskażą
konkretny błąd i po aktualizacji wymaganej noty naukowej.

**Odbiór:**

- [ ] Natywny solver faktycznie uruchomiony; niepusta zaakceptowana częstotliwość dla dokładnego k, brak syntetycznej wartości.
- [ ] Istnieją wymagane niezależne residuale oraz pełne zespolone pole/topologia i niezmienny certyfikat równowagi.
- [ ] Modal output commitowany, task terminalny zgodnie z wynikiem i zasoby zwolnione normalnym protokołem.

### Checkpoint startu i rzeczywistego Relax

Źródła/runtime: `a5dda59c19334a5978a13dabffe1c4d8b9ecb92f`, snapshot
`912c9ace1300929db4f198c4bbab7e7080e33a5e3f8325159e67e25516084a59`.
Managed recreate `a25efbe5d55e4892a912df62c1154eaa` oraz development
`12c0e5cf9063405b8d1b138b316eddd9` zakończone sukcesem. Compose config
`4cc87b1108b2e98eb17e1ecd05e601fec7ea62f290faeecdc80c21e8e47c4833`.
API health `ok`, runtime owner `Ready`, oba schedulery uruchomione;
snapshot zasobów `current` z tym samym host owner i epoch=2.

Jednorazowa aktywacja `c99e031df7e34fa39f40256791e6b291`, request
`eigensolve-ui-de-k10-recovered-20261026-a5dda59c1933`, run
`run-live-f63ba231e32a6fb77200a029c46b33430ad2b4d993ada7860029c11d8cc46b08`.
Nowy native Relax: `completed`, 3 kroki, task `Succeeded`, 14 artefaktów.
Handoff CAS ma 3154415 bajtów i rzeczywisty hash
`b31f903a09fc5616eeea65c821253d2adb8cf6e982a2342ee79c3b61c421988f`.
Certyfikat `RecomputedFemLinearizationCertificate.v1`: `matched`, 758 węzłów;
różnica H_demag/H_eff `8.138520186984135e-24 A/m`, H_ex/H_ext zero.
Siatka: 2530 komórek; CPU/double. Dowody zapisane w
[evidence ponownej walidacji](../../audits/2026-10-26-eigensolve-relax-to-eigen-replay.evidence.json).

### Korekta 6.1a — idempotentna walidacja typowanego StepOutput

Eigen przygotowano i przydzielono, ale compute scheduler zakończył się na
`equilibrium_handoff does not match its pinned artifact identity and digest`.
Captured input i katalog mają identyczny artifact ID i SHA. Rozbieżnością
jest wyłącznie `study_artifact=Some(...)` dodane podczas pierwszej walidacji
wobec `None` w nowo odtworzonym wpisie katalogowym. Ponowne porównanie całej
struktury odrzuca prawidłowe wejście przed Prepare/startem workera.

Poprawka porównuje identity/digest, zachowuje dostarczony opis typu i ponownie
porównuje go z niezależnie odczytanym manifestem. Dekodowanie CAS i wszystkie
kontrole current attempt/epoch pozostają obowiązkowe. Regresja obejmuje
resolve→bind→serde→resolve→bind, zmiany siedmiu pól oraz brak payload/manifest
w CAS. Test włączono do GitHub Actions, bez lokalnej kompilacji. Runtime tej
poprawki i końcowy Eigen pozostają **NOT VERIFIED**.

### Korekta 6.1b — przekazanie niewystartowanego admission po restarcie

CI commita `d4f0aee42266bff0a11c7fdd46eef99aee444226` zakończone sukcesem.
Managed stop `08c13cae92414ff08b5d3d6c47b4989e` i recreate
`c2ec7d4f2b444abf8d693aa5c0e83fdf` zachowały store. Nowy build aplikacji
udany; development `03460acf40f24ef4b928831c2b4da67c` odrzucony przez
inventory-owner fence przed Prepare. Szczegóły: A13 audytu oraz
[evidence restartu](../../audits/2026-10-26-eigensolve-pending-admission-restart.evidence.json).

- [x] Sprawdzić faktyczne old/new Compose: ten sam ledger, source root i runtime generation.
- [x] Zachować katalog/admission/Relax; potwierdzić brak nowego worker Start.
- [x] Wybrano jawną rewalidację wyłącznie pre-coordinator Pending, z przypiętym hashem dowodu i niezmienionym zwykłym fencing; review PASS.
- [x] Dodano regresje restartu, odmów i integralności dowodu; wykonanie kompilowanych testów pozostaje do potwierdzenia w GitHub Actions.
- [ ] Po CI wznowić normalnym launcherem i potwierdzić odbiór certyfikatu Relax przez Eigen.

### Korekta celu reprodukcji po wskazaniu historycznego wykresu

Użytkownik wskazał wykres `de-signed15-air-refinement.png`. Historyczne obliczenia
istnieją: [signed15](../../raports/2026-10-04-de-signed15-runtime.md) i
[manifest dwóch refinementów](../../raports/assets/de-signed15-20261004/two-air-trials-manifest.json).
Baseline obejmuje 15 rzeczywistych pozycji od −25 do +25 rad/µm, dynamiczny
demag, film 40×40×10 nm, Ms=800000 A/m, Aex=13e-12 J/m, Bx=0,1 T,
PBC xy, powietrze po 2 µm, siatkę L2 5 nm / 3 warstwy, air growth1,3.
Actual mesh: 6138 węzłów i 30012 tetraedrów (1476 film, 28536 air).
Dwa pomarańczowe punkty +10/+25 używają air growth1,15 przy tym samym filmie.

Dotychczasowy pilot `fem_eigen_mode_ui_de_k10.py` ma 10 nm / 6 warstw,
wybór nearest i inną aktualną siatkę. Jest testem integracji, **nie reprodukcją
tego wykresu**. Nie wolno nim zastąpić benchmarku, ani uznać jego wyniku za
odtworzenie historycznych wartości.

Priorytet zadania 6 po usunięciu blokady wykonania: użyć wersjonowanego
`examples/fem_de_smoke_numeric.py` z historycznym L2/3 i przypiętymi opcjami
okna/KSP z manifestu runtime #228; najpierw +10 i −10, następnie pozostałe
signed15 oraz dwa refinementy. Oczekiwany historyczny +10 baseline:
11,205285324 GHz; +25:13,557589546 GHz. To wartości porównawcze z raportu,
nie nowe wyniki. W razie zmiany actual siatki raportować różnicę przed
porównaniem częstotliwości. Γ zachowuje historyczny selected-only scope;
nie deklarować pełnej kompletności okna. Nowy UI ma następnie konsumować te
wyniki; jego pozostałe poprawki nie zastępują odtworzenia obliczeń.

Zachowane są CSV, PNG/PDF i inspection JSON w dokumentacji/visualizations.
Historycznego rootu raw runs nie znaleziono pod dwiema dokładnymi ścieżkami
C:/git/fullmag/storage i /home/kkingstoun/git/fullmag/storage; to nie jest
stwierdzenie, że wszystkie kopie wyników zostały usunięte.

## Zadanie 7/8: trwale zapisać, odczytać i pokazać mod w UI

**Zależności:** 6. **Ustalenie:** A08.

**Sposób wykonania:**

- 7.1. Wskazać jeden autorytatywny zapis: accepted store/CAS, manifest
  `frequency_domain/manifest.v1.json`, `eigen/spectrum.v2.json` i wskazane
  przez manifest artefakty zespolonego pola. Sprawdzić referencje, rozmiary,
  hashe, owner oraz committed generation; dane techniczne nie trafiają
  do zapisu wyników. Format dodatkowego eksportu wynika z istniejącego
  kontraktu, nie z założenia, że dowolny FMS/Zarr już obsługuje te dane.
- 7.2. Po kontrolowanym restarcie odczytać dokładnie te same dane bez Solve.
  Zgodność częstotliwości, pola i tożsamości ma wynikać z hashy i referencji,
  nie tylko obecności katalogu lub HTTP 200.
- 7.3. Wykonać `verify_eigen_mode_ui.mjs` dla exact run/stage/sample/mode:
  binary full complex field, zgodne nagłówki i generacja, decoded overlay,
  widoczny canvas, WebGL bez utraty kontekstu i niezerowy buffer. Sprawdzić
  real/imag/abs/phase oraz sterowanie fazą/animacją na rzeczywistym polu.

**Przewidywane pliki:** istniejąca publikacja/session save/load oraz harness UI;
frontend resource hooks tylko przy odtworzonym problemie lifecycle/owner.

**Odbiór:**

- [ ] Istnieje udokumentowany trwały zapis z pełnym manifestem i hashami; częściowa publikacja nie udaje gotowego wyniku.
- [ ] Po restarcie dane są czytelne i identyczne, liczba uruchomień solvera nie wzrosła.
- [ ] Pozytywny raport browser/API z rzeczywistym modem; weryfikacja GPU sprzętowego pozostaje osobną sprawą.

**Checkpoint po 6–7:** podstawowy cel „solver + trwałe dane + mod UI” jest
osiągnięty dopiero tutaj. Testy fixture i stary wykres nie zastępują odbioru.

## Zadanie 8/8: powtórzyć signed sweep i wydać raport odbioru

**Zależności:** 7. **Ustalenie:** A10; domknięcie wcześniejszego żądania punktów.

**Sposób wykonania:**

- 8.1. Tym samym zaakceptowanym przepływem wykonać przygotowany signed15:
  `−25, −20, −15, −10, −7, −5, −2, 0, 2, 5, 7, 10, 15, 20, 25 rad/µm`.
  Ujemne k liczone rzeczywiście, nie kopiowane z symetrii dodatnich.
- 8.2. Zweryfikować każdą próbkę, residual, owner, k w SI i zapis pola.
  Jeden jawny plan sweepa; concurrency tylko w już kwalifikowanym zakresie.
- 8.3. Wykres f(k) i porównanie z właściwą analityką powstają z manifestów
  i zaakceptowanych rekordów. CSV/rysunek/provenance wskazują liczbę
  rzeczywistych punktów, błędy i brakujące próbki.
- 8.4. Uzupełnić raport i PR wymaganymi dowodami. Integrację na master
  oraz cleanup prowadzić istniejącym etapem I5 po wymaganych kontrolach;
  zewnętrzna porażka Public documentation nie jest dowodem błędu solvera,
  lecz musi zostać rozstrzygnięta przed deklaracją pełnej integracji.

**Przewidywane pliki:** `examples/fem_eigen_mode_ui_de_signed15.py`, istniejący
skrypt porównania/wykresu i raport; bez nowej implementacji solvera na tym etapie.

**Odbiór:**

- [ ] 15 jawnych próbek aktualnego runu, poprawne zapisane artefakty i brak wywnioskowanych punktów numerycznych.
- [ ] Czytelny scatter/wykres z analityką, powtarzalny eksport i jawne niepowodzenia zamiast zamaskowanych luk.
- [ ] Raport odróżnia PASS workflow od niezamkniętej kwalifikacji naukowej; status PR/master/cleanup zgodny z rzeczywistością.

## Szablon komunikatu i zakończenia etapu

`Zadanie 6/8: Solver uruchomiony dla k=…; wynik … . Zweryfikowano … .
Pozostaje …; kolejna kontrola … .`

Zakończenie każdego etapu: zakres diffu → adekwatny test → review → commit
spójnej zmiany i push zgodnie z istniejącą autoryzacją → zapis dokładnego
commita i dowodu odbioru. Nie commitować nieukończonych referencji do modułów.
Nie obiecywać, że „następny build na pewno uruchomi solve”. Jeśli etap blokuje
nieznany kontrakt, raport wskazuje konkretną granicę i zatrzymuje prace zależne.

Bieżący krok: **6.1a**, review i GitHub CI ponownej walidacji StepOutput.
Nie ponawiać aktywacji: istniejący run ma udany Relax i przydzielony Eigen bez
uruchomionego workera. Najpierw sprawdzić zarządzaną ścieżkę wznowienia tego
admission i zachować jego niezmienne wejścia; nie edytować lease ani receiptów.


### Checkpoint 27.10 — wznowienie działa, diagnostyka wymaga poprawki

A13 zamknięto dowodem runtime: ten sam pending admission uruchomił worker,
po exit 1 nastąpił normalny local/host release, a owner pozostał Ready.
Bootstrap CI `40415076292` PASS. Szczegóły i niezmienne receipty w audycie A14.
Zadanie 6 pozostaje otwarte: nie opublikowano częstotliwości ani modu.

- [x] Wznowić oczekujący task po restarcie inventory owner bez nowego Solve.
- [x] Potwierdzić natywną ścieżkę Floqueta, terminal i normalne zwolnienie zasobów.
- [ ] A14: wdrożyć poprawkę zachowania początku jawnego błędu workera i uzyskać
  rzeczywistą przyczynę odmowy; nie obniżać progów ani zgadywać przyczyny.
- [ ] Odtworzyć historyczny model L2/3 dla ±10, następnie signed15 i refinementy.
- [ ] Zweryfikować trwałe mody w UI i nowy wykres z analityką.


### Wejście kolejnej próby po A14

`examples/fem_eigen_mode_ui_de_k10.py` skorygowano do historycznej geometrii,
żądanej siatki L2/3, air growth 1,3, okna 8,5–16 GHz, count=1 i bramki
residualu 1e−8. Jest to pierwsze porównanie tego samego problemu fizycznego
na obecnym backendzie; actual mesh musi być zweryfikowana po materializacji.

Ważne ograniczenie: obecna managed konfiguracja nie przekazuje historycznych
override'ów FGMRES/restart8/KSP1e−9/EPS1e−9. Skrypt jawnie zapisuje tę różnicę
w metadata i korzysta z bieżących domyślnych ustawień backendu. Nie ustawiamy
zmiennych w procesie authoringu, udając przekazanie ich do oddzielnego workera.
Wynik może potwierdzić odtworzenie częstotliwości przy tych samych parametrach
fizycznych i progu residualu, lecz nie identyczność ustawień iteracyjnych ani
bitową reprodukcję. Dokładne historyczne tuning overrides pozostają osobną
pozycją reprodukcji; nie uzasadniają zmiany domyślnych ustawień całego solvera.


### Checkpoint 27.10 — nowa próba L2/3 uruchomiona

- A14: bootstrap CI [40418572140](https://github.com/MateuszZelent/fullmag/actions/runs/40418572140)
  PASS; kod diagnostyki wdrożony. Nie wystąpił jeszcze kolejny błąd natywny,
  więc poprawność komunikatu w tym runtime nie jest oddzielnie potwierdzona.
- Model L2/3 zapisany i wysłany jako `d8dc2fb61887fab68cad0d07f844f13e5a40877a`.
  Kontrolowany restart `9d96f99e9a7e4876ad48a1ae2c07744e` PASS, backend
  `f14ddb0a2f54`, snapshot `99d73672279d8f1cac9292baa03701b596230bbb24f30246c8663636d432fd37`.
- Aktywacja `b473278fa5124f37891dd4f1ca750f1f`, request
  `eigensolve-de-l2-k10-20261027-d8dc2fb61`, source SHA
  `c1538636bd59bd6258f910b9add19392aeeae86b7b603ba17d90ccb5e68a46e2`.
- Run `run-live-90f9afb5b6531a4f5e5600bf355e5715f6b857d7709eca56a258168697bcc724`;
  session `docker-startup-51ba6bbc896cc2bf19641a1c378ed98d28ed20e3fc234fa050f0bb04e4159484`.
- Catalog revision 147: Relax Succeeded (14 artefaktów), Eigen Running (0
  opublikowanych artefaktów). Worker Eigen PID 3607 potwierdzony aktywny.
  Task `task-f370c6f7db8847d319bc6dd3b62d4479091c6fd9838148936a108c3ec4369010`,
  attempt `attempt-7eb2346d3f4c4f3d98ece676945d31ce`.
- API ma aktywny model i domain.cell_count=7134. Historyczna siatka miała
  30012 tetraedrów: ta sama zadana L2/3 nie odtworzyła tej samej actual mesh.
  Wymagany pomiar magnetic/air topology przed interpretacją różnicy f.
- Receipt procesu Relax wskazuje błąd końcowego heartbeat po utracie aktywnego
  claim, mimo opublikowanego Succeeded. Nie traktować tego receiptu jako sukcesu
  procesu; przed kwalifikacją sprawdzić terminalny protokół i handoff CAS.
- Nie ma jeszcze nowej częstotliwości, zespolonego modu ani dowodu renderowania.
  Kontynuować obserwację tego runu; nie ponawiać aktywacji przy samym timeout.


### Checkpoint 27.10 — terminal L2/3 i różnica względem historycznego solvera

- Ponowny odczyt runu `run-live-90f9afb5b6531a4f5e5600bf355e5715f6b857d7709eca56a258168697bcc724`:
  catalog revision 399, receipt Eigen `worker-process-exit-d21c2082417a8a878d43f7b0337737de2c31d489cc17bce59f7e200e2c494805`,
  exit_code=1, status_success=false. Poprzedni checkpoint Running jest historyczny.
- A14 potwierdzone w runtime: komunikat zachował przyczynę
  `Floquet window remained incomplete after bounded refill`. Nie ma nowej
  zaakceptowanej częstotliwości ani modu; nie ponowiono Solve.
- Porównano kod z historycznym commitem `57182911c6e8e721b8ee9705aa7f70491c70fe94`:
  również wtedy Rust przekazywał `completeness_policy: 1`. Nowy backend ma
  jawny guard `native_floquet_certified_count_unavailable`; historyczny plik
  tego guarda nie zawierał. Sam hardcode adaptera nie jest nową regresją.
  Błąd refill oraz brak certyfikatu kompletności wymagają osobnego rozpoznania.
- A15: dodano ograniczony, redagowany zapis stdout/stderr zakończonego workera
  do trwałego logu schedulera (`worker_process_observed.v1`, 64 KiB/strumień,
  jawne total_bytes/truncated). Wspólny helper z preparation zachowuje ochronę
  tokenu również na granicy ucięcia. Receipt i bramki solvera bez zmian.
  Testy regresji skierowano do GitHub Actions; wykonanie i nowy runtime jeszcze
  NOT VERIFIED. Nie jest to trwały artefakt naukowy ani gwarancja zachowania
  całego JSON większego niż limit.
- Kolejność: CI A15 → jawny kontrakt wyboru kompletności i historycznych
  ustawień Kryłowa → pomiar rzeczywistej siatki → jeden +10 → trwały mod/UI
  → signed15 i analityka. Nie zastępować odtworzenia luźniejszym residualem,
  nearest-only ani nie przedstawiać best_effort jako kompletnego widma.


### A16 — jawna polityka kompletności, 27.10

- Dodano opcjonalne `solver_completeness` do authoringu etapów: `best_effort`
  lub `certified_count`. Ominięcie zachowuje strict. Python → scena → canonical
  rewrite → IR/plan → native window zachowuje wybór; provenance rozróżnia
  requested/resolved. Puste/null pole sceny usuwa override, błędne jest odrzucane.
- Trzy testy Python (walidacja, pełny round-trip i kasowanie override) PASS;
  57 testów `test_script_builder_roundtrip.py` PASS; trzy istniejące testy
  `test_api.py -k eigen_solver_policy` PASS. Regresje Rust IR, materializacji,
  planera i mapowania ABI dopisane do GitHub Actions, wykonanie NOT VERIFIED.
- Przykłady +10 i signed15 jawnie żądają best_effort: celem jest zapis modów
  spełniających residual, bez fałszywego certyfikatu pełnego pasma. Nadal nie
  odtworzono historycznych ustawień Kryłowa ani rzeczywistej siatki powietrza.
  Nie uruchomiono nowego Solve; aktualny runtime nie zawiera jeszcze A15/A16.
- A15 commit `865c3e683b357ee9523936c5876fabc9268e61af` na remote;
  bootstrap CI `40423974808` obserwowano jako in_progress. Brak nowej
  częstotliwości i zespolonego modu; zadania 6–8 pozostają otwarte.


### Runtime A15/A16 — uruchomiona próba +10, 27.10

- Przyrostowy build/restart `46b14c761a9145d5b55dc2e70ba0249c`: succeeded,
  API i runtime Ready. Źródła `29b1587b2a0d98b4a5c03c3f3c57d77ccd62ff4f`,
  grupa `fullmag-worktree-eigensolve-integration-ui-202610-78b341212cbdaa7d`,
  backend `f14ddb0a2f54`, port 3217. Cache i dane poprzednich prób zachowane;
  przed buildem /build i control miały 271 GiB, /state 6,3 GiB wolnego.
  Nie usuwano danych: cache jest używany, wyniki nieudanej próby potrzebne diagnozie.
- Aktywacja `93c9058e41654f9d9936b1617823e91e`, request
  `eigensolve-de-l2-k10-best-effort-20261027-29b1587b2`, source SHA
  `aa6f9ae92a0e596285b1fc466cb512900ba2d69792fc4d2e8a7ae0737a9f9465`.
- Run `run-live-e6659da78e02a743dd99fa873d6bc481d7b657ac322dbf1ec369e0ea36b710bf`,
  session `docker-startup-c16aa4edf15fb8bcc49ae8b7da0a36eafba76665dc644ab756bd10208859d96b`.
  Catalog revision 33: Relax succeeded, Eigen running.
  Task Eigen `task-3b447fd11d52eda9e9b5b9743041500cb8bd30c9e2f064a9c187f0b3fa6c2305`,
  attempt `attempt-cee508db05d34b659d7952c044742c88`, aktywny PID 5590.
- Nie jest to jeszcze wynik: brak nowej zaakceptowanej częstotliwości i dowodu
  pola w UI. Następny odczyt dotyczy tego samego runu; nie powtarzać aktywacji
  na podstawie timeout obserwacji. Obecne ustawienia Kryłowa nadal domyślne,
  a identyczność historycznej siatki powietrza nie jest potwierdzona.
- CI bootstrap `40425386896`: job Python success, Rust in_progress
  (Run Rust quantity, API and CLI contracts). Nie uznawać całego CI za zielone.


### Terminal A16 i kolejny krok A17

Run `run-live-e6659da78e02a743dd99fa873d6bc481d7b657ac322dbf1ec369e0ea36b710bf`
jest terminalny: catalog revision 428, Relax succeeded / Eigen failed.
Worker PID5590 zakończony; nie uruchomiono kolejnego Solve. Zachowano pełną
natywną diagnostykę w `docs/audits/2026-10-27-eigensolve-best-effort-terminal.evidence.json`.
CI bootstrap40425386896 success; nowe testy A15/A16 faktycznie wykonane.

A17 z audytu zastępuje zgadywanie tolerancji: dwa podokna wyczerpały EPS
w refill NEV8→31 przy NCV32, choć jest jeden mod z residualem1,03e−13.
Publiczne count1 jest zastąpione wewnętrznym guard count przy wywołaniu
sparse. Naprawę trzeba oprzeć na rozdzieleniu obu celów i regresjach,
bez dopuszczenia obecnego nieudanego runu. Mod11,211886650GHz pozostaje
wyłącznie diagnostyczny, nie jest jeszcze punktem zaakceptowanego wykresu.


### Implementacja A17 — oddzielny cel refillu

- Wewnętrzny sparse request ma opcjonalny certified_refill_target (0=stary
  kontrakt). Produkcyjny CPU Floquet ustawia min(count, guard) wyłącznie
  dla best_effort. Początkowe NEV/NCV/MPD i pojemność finalizatora pozostają.
- Wcześniejsze zakończenie wymaga certyfikowanej puli po deduplikacji w metryce masy oraz dodatniego powodu zbieżności EPS, bez błędów rekonstrukcji.
  Nie konwertuje istniejącej próby failed na sukces ani nie ignoruje budżetu.
- Dodano natywne regresje jednego/wielu modów, wymiarów Kryłowa,
  nieprawidłowego celu i budżetu; C ABI sprawdza przekazany cel w telemetry.
  Native testy i runtime A17 jeszcze NOT VERIFIED. Wymagany dedykowany CI
  workflow_dispatch contract_scope=floquet-modal-slepc oraz zwykłe CI.


### Checkpoint A17 — kod na remote, weryfikacja i build w toku

- Commit `a85fdf0bb701680b7f8f6bb0e492d18e7088662c` wypchnięty na branch
  `codex/eigensolve-integration-ui-20261026`. Walidacja zmienionej noty
  naukowej i source-map względem 29b1587b2 przeszła.
- Test budżetu rozróżnia zakończoną zbieżność EPS w ostatniej dopuszczonej
  iteracji od ujemnego statusu EPS. W pierwszym przypadku osiągnięty cel
  jednego modu może zakończyć obliczenie; drugi nie jest akceptowany.
- Natywne CI: https://github.com/MateuszZelent/fullmag/actions/runs/40430469653
  (job121946616991, kompilacja obrazu MFEM i kontrakt Floquet/SLEPc w toku).
  Zwykłe CI: https://github.com/MateuszZelent/fullmag/actions/runs/40430393405
  również w toku. Nie są jeszcze dowodem PASS.
- Uruchomiono zarządzany restart/build w dotychczasowej grupie Compose,
  z bazowym attempt3305c687a5e941ce835afc29b695b7d6 i niezmienionym pinem
  konfiguracji. Przed startem brak procesu workera obliczeń; /build265GiB
  wolnego, /state6,2GiB. Launcher dopuścił przebudowę; trwa kompilacja.
- Nie uruchomiono kolejnej aktywacji. Po kontroli CI i API Ready następny
  request ma odtworzyć `examples/fem_eigen_mode_ui_de_k10.py`; wymagany
  terminalny sukces, zapis zespolonych modów i rzeczywisty dowód UI.
  Wynik A16 pozostaje diagnostyczny. Signed15 i nowy wykres nadal otwarte.


### A17 — runtime gotowy, obliczenie +10 uruchomione

- Managed build/restart `bd14a0751e9e433fbf66be6e402d566b`: succeeded.
  API Ready, runtime_bundle `0.1.0-dev.20261027.ga85fdf0bb701+9796`.
- Aktywacja `18ab9594f10c4de9a1e244d80aa21011`: succeeded (przyjęcie,
  nie ukończenie obliczeń), request
  `eigensolve-de-l2-k10-refill-target-20261027-a85fdf0bb`.
- Run `run-live-a89e1a9e31d2a78e228919b17398bc1325f6c5dfb85250e83878bdbb2b5f7c06`,
  session `docker-startup-ec022f7550939c23d7324782b43a4dbda4ddbf2236e7a95a71088d97e57999a3`.
  Catalog revision27: Relax succeeded, Eigen running. Eigen task
  `task-5ef4df49336aadf2eecb65eff64718a4b6ccb766c024070ffaf41397051853e3`,
  attempt `attempt-e0d0bb1a5e9942a8a1832410f3a2e581`.
- Proces workera potwierdzony przez Docker top (host PID86036,
  około97% jednego CPU przy pierwszej obserwacji). Native CI nadal w toku;
  próba runtime to niezależna weryfikacja i nie zastępuje testów.
- Obserwować ten run; brak powodu do kolejnej aktywacji lub restartu.


### A17 terminal PASS; A18 — utracone żądanie zapisu modu

Run A17 zakończony: oba taski succeeded (catalog revision48), API run
completed. Widmo opublikowane: k=(0,1e7,0)rad/m, f=11211886649,716702Hz,
pełny residual1,0316027197209396e−13; CPU/double, źródła a85fdf0bb.
To wynik zaakceptowany, nie kandydat z poprzedniej próby. Nie dowodzi
kompletności widma, zbieżności siatki ani zakończenia całej kwalifikacji.

Weryfikator UI zakończył się `mode is not ready: missing`.
Widmo zawiera mode_field_available=false, endpointy mode JSON i field meta
zwracają missing. Nie ma dowodu wizualizacji modu. Dowody zapisano w
`docs/audits/2026-10-27-eigensolve-a17-success-mode-output-gap.evidence.json`.

Nowa konkretna przyczyna do naprawy A18: zapisany snapshot definicji
cc3749fdbc74e467de0018c084e3d8420d0bbc4cced1c32604fb7f9fc3464bd6
ma scene.outputs={}, mimo study.save(mode, indices=(0,), sample_indices=(0,))
w skrypcie. Python runtime/scene_document.py emituje puste outputs.items,
a scene_document_ir.py odrzuca niepustą listę jako unsupported.
Należy prześledzić i zachować selektory zapisu Python→SceneDocument→ProblemIR
oraz accepted modal worker, z regresją roundtrip. Nie zmieniać flagi
mode_field_available na true bez zapisania rzeczywistych danych.
Natywne CI A17 nadal w toku przy ostatnim odczycie.


### A18 — doprecyzowanie przyczyny i poprawka skryptów

Puste globalne scene.outputs nie dowodzi samo błędu kontraktu globalnego.
Etapy przejmują snapshot ustawień w chwili add_stage. W obu przykładach
save(mode) następowało po add_eigenmodes: bezpośrednio załadowany Python
miał jedynie domyślne eigen_spectrum. Przeniesiono cztery deklaracje save
przed dodanie etapu eigen (po Relax), bez zmiany fizyki ani selektorów.
Regresja test_eigen_mode_ui_examples.py: przed poprawką 2 FAIL (brak mode),
po poprawce 2 PASS; obejmuje dokładne próbki [0] oraz [0..14].

Pozostała niezależna luka: export_builder_draft dla poprawionego wejścia
nadal emituje etap eigen bez sampling. Renderer sceny nie odtwarza zapisów
modalnych. Następny krok wymaga pełnego roundtrip stage sampling i jego
przekazania w Rust materialization, bez wprowadzania drugiego mechanizmu
zapisu ani sztucznego mode_field_available. Należy także zachować
EigenDiagnostics, którego eigen_sampling_from obecnie nie uwzględnia.
Zwykłe CI40430393405 zakończone success; natywne CI nadal in_progress.


### A18 — implementacja przekazania wyjść etapu

- Eksport Python dodaje sampling.outputs do istniejącego payloadu etapu
  eigenmodes. Renderer sceny odtwarza kanoniczne SaveSpectrum, SaveMode,
  SaveDispersion i SaveEigenDiagnostics przed dodaniem etapu; zachowuje
  selektory indeksów, gałęzi, all_modes, próbek i etykiet. Nie wprowadzono
  globalnego scene.outputs ani alternatywnego formatu plików wynikowych.
- Rust materialization stosuje jawny snapshot sampling.outputs; przy braku
  pola zachowuje dziedziczenie. Odrzuca niewłaściwe typy oraz wyjścia spoza
  rodziny modalnej. eigen_sampling_from zachowuje teraz EigenDiagnostics.
- Regresje obu rzeczywistych przykładów przechodzą pełny obieg
  loaded Python→builder→scene→rendered Python→loaded sampling (dokładna
  równość). Zestawy roundtrip i problem_ir: 71 PASS; dodatkowe negatywne
  przypadki selektorów sprawdzone osobno. Nowy test Rust zostanie wykonany
  w GitHub Actions; lokalnie nie kompilowano testów.
- Nie jest to jeszcze dowód zapisania pola przez runtime. Wymagane CI,
  managed rebuild i ponowienie +10, potem actual mode UI verifier.


### A18 startup i terminalne CI A17 — dwie niezależne przeszkody

- Build A18 b60f94a22 skompilowany, pakiet zweryfikowany, API uruchomione
  wyłącznie diagnostycznie. Fence api-failure-1bec93455db748338edb8bd99180ab25.json:
  native Docker host profile initialization failed / nvidia-smi bounded timeout.
  Kontrolny odczyt nvidia-smi później PASS (RTX4080SUPER). Nie aktywowano Solve.
- Iteration dfb2be8228464d1d989ff0d6d072b482 nadal obserwowana przez launcher.
  Early diagnostic API celowo zachowuje poprzedni drained process-tree;
  readiness loop docker_volume_dev.py sprawdza failed process receipt i inny
  tekst logu, więc nie rozpoznaje tej awarii. Nie restartować ręcznie ani
  nie usuwać lease. Potrzebny kontrolowany terminal/recovery tej próby,
  uwzględniający dokładny startup fence i brak aktywnego runtime/workera.
- Native CI A17 run40430469653/job121946616991 zakończone FAILURE:
  15/21 PASS, sześć failures. Pobraną diagnostykę opisuje
  `2026-10-27-eigensolve-a17-native-ci-failures.evidence.json`.
  Assertions: explicit multi-mode goal; best_effort incomplete coverage;
  dimension-limited best_effort (cztery warianty hard-KSP).
  Nie obniżać wymagań automatycznie: porównać rzeczywiste statusy i cel
  fixture z nową semantyką osobnego celu refillu. Runtime +10 pozostaje
  udanym punktem, ale nie kwalifikuje całego kontraktu solvera.
- Porównanie zaakceptowanego +10 z istniejącym finite-Dirichlet n=0 oracle:
  FEM11,2118866497GHz / referencja11,2354141789GHz, różnica−0,20940509%.
  Nie jest to certyfikat zbieżności ani kompletności widma.


### Korekta regresji po A17

Dwie rodziny fixture count1 oczekiwały dawnego wyczerpania internal guard,
choć celem A17 jest właśnie zakończenie na publicznym count1. Oczekiwania
native i C ABI dopasowano do not_certified (lub rzeczywistego truncation),
bez komunikatu niewykonanego dimension-limit refillu. Zachowano wymagania
complete=false, certification_method=none i residualów. Nie jest to jeszcze
PASS — wymaga kolejnego natywnego CI.

Regresja explicit multi-mode pozostaje nierozstrzygnięta. Dodano pełną
telemetrię wyniku oraz identycznego kontrolnego solve z domyślnym celem,
bez zmiany warunku zaliczenia. Następne CI ma ujawnić EPS reason, liczbę
prób, finalizowaną pulę i residual. Nie zakładać automatycznie błędu fixture
ani dopuszczać niezbiegłych wyników.


### A19 — rozpoznawanie early-startup failure bez zmiany starego OWNER

Readiness loop otrzymał kontrolę logu wyłącznie bieżącej inkarnacji
kontenera i odczyt dokładnie wskazanego pliku api-failure-UUID.json przez
bounded regular-file reader w kanonicznym technical root. Waliduje schemat,
stage i reason, zapisuje startup-failure.json operacji i kończy oczekiwanie
błędem z zachowaniem usług. Nie nadpisuje starego process-tree/OWNER.

Pięć testów PASS. Odczyt tego samego helpera na aktualnym kontenerze potwierdził
fence1bec93455db748338edb8bd99180ab25 i timeout nvidia-smi. Nie jest to recovery:
wcześniej uruchomiony obserwator iterationdfb2be8228464d1d989ff0d6d072b482
nadal wykonuje stary kod w pamięci. Nie uruchomiono ponownie obliczeń ani
nie zmieniono ręcznie lease. Następny krok musi zamknąć tę konkretną obserwację
zarządzaną ścieżką i wznowić startup po potwierdzeniu braku workerów.
Native CI40434089875 nadal in_progress przy ostatnim odczycie.
