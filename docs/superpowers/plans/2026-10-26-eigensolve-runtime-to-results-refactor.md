# Plan refaktoryzacji: uruchomienie eigensolve i trwały zapis danych

Data: 26.10.2026. Audyt i plan zapisano przed wznowieniem celu. Obecny etap:
**zadanie 4/8 — kontrolowany restart po potwierdzonym zwolnieniu historycznej rezerwacji**.

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
| 4/8 — poprawny start runtime | Otwarte; przyczyna sample admission nieustalona | Ready owner i bieżący sample, działający scheduler bez kwarantanny |
| 5/8 — zaakceptowany Relax | Historyczny native Relax jest; nowa publikacja otwarta | Certyfikat w CAS i zaakceptowane wyjście do Eigen w nowym runie |
| 6/8 — rzeczywisty Eigen +10 | Brak wyniku nowego runu | Native frequency + residual + zespolony mod i terminalny sukces |
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
- [ ] Rzeczywisty runtime Ready, API commandable i aktualny sample właściwego owner/epoch; bez aktywnej historycznej blokady.
- [ ] Tożsamość builda/runtime zapisana; nie wystartował niezamówiony lub powtórzony Solve.

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

- [ ] Nowy Relax ma prawdziwe completed/converged i diagnostyki wymaganej konfiguracji CPU/double.
- [ ] Certyfikat w CAS i accepted output są spójne z exact planem/siatką/właścicielem.
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

Bieżący krok: **4.2–4.3**, managed diagnostic stop i odtworzenie runtime.
Release potwierdzony; nowy Relax/Eigen, trwały odczyt i UI pozostają do wykonania.
