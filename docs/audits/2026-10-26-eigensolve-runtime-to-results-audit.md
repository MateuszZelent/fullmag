# Audyt: od uruchomienia Fullmaga do solvera i trwałych wyników

Data: 26.10.2026. Stan po poleceniu użytkownika: zatrzymać dalszą implementację,
najpierw przygotować audyt i plan refaktoryzacji. Ten dokument jest bieżącą
oceną blokad wykonania; wcześniejsze checkpointy zachowują znaczenie historyczne.

## Werdykt

**Obecny run nie uruchomił solvera. Najpilniejszy problem dotyczy cyklu życia
runtime, rezerwacji i pochodzenia programu odzyskania, a nie wykazanej awarii
samego operatora nonzero-k.** API pokazuje `waiting_for_compute`, 0 kroków,
`disconnected`, `commandability=forbidden`.

Zbudowanie pakietu i zielone testy źródłowe nie doprowadziły jeszcze do
prawidłowo opublikowanego wyniku Eigen. Rozbudowa mechanizmów odzyskania przed
sprawdzeniem całego kontraktu start→solve→save zwiększyła zakres i opóźniła
pierwszy wynik. Należy teraz realizować ograniczone etapy z dowodami końcowymi.

Plan wykonania: [8 zadań refaktoryzacji i odbioru](../superpowers/plans/2026-10-26-eigensolve-runtime-to-results-refactor.md).
Źródła, fragmenty z liniami, hashe i piny prób: [evidence JSON](2026-10-26-eigensolve-runtime-to-results-audit.evidence.json).

## Tożsamość i zamrożenie

| Warstwa | Potwierdzony stan |
|---|---|
| Worktree | `/home/kkingstoun/git/fullmag/worktrees/eigensolve-integration-ui-20261026` |
| Branch | `codex/eigensolve-integration-ui-20261026` |
| Zapisany i wypchnięty HEAD | `a6dcd4db3c21c1ec458c09b83958df04bd7124e2` |
| PR | [#262](https://github.com/MateuszZelent/fullmag/pull/262), draft; bez merge |
| Działający runtime | commit `2f99894c54bc6745bc9353634dd06487a106cc51`, snapshot `dd4c5627c95ef8415256d3c1fdcaf81c706e3f83a9c7a924cf56b8a09070473f` |
| Ostatni pakiet maintenance | HEAD `a6dcd4db3…`, snapshot `be753e4d9209e2ef476e27649db42aee2f5b069e9ccb2ac3403e1e82b2b69a29`; build sukces, native preview odmowa |
| Lokalny WIP | 9 zmienionych plików; nieobjęte zielonym CI HEAD i niegotowe do buildu |
| Nowe punkty częstotliwości / rzeczywisty mod obecnego runu | Brak / NOT VERIFIED |

Przerwano implementację subagenta. Zachowano kopię 9 plików i binarny patch
w `eigensolve-refactor-audit-freeze` pod katalogiem wizualizacji tego wątku;
pełna ścieżka i hashe są w JSON. Niczego nie cofnięto, nie usunięto ani nie
podmieniono w ledgerze. Nie rozpoczęto nowego builda lub Solve po zmianie zakresu.

**Ważne:** WIP deklaruje `mod failed_worker_maintenance`, lecz pliku modułu ani
jego `mod.rs` nie ma. To przerwana implementacja, nie gotowa poprawka. Nie wolno
przedstawiać jej jako stanu zielonego brancha albo wdrażać z live checkoutu.

## Co naprawdę wykonano

1. Dodano accepted preparation i dispatch modalny, typowany Relax→Eigen handoff,
   codec wyników i kontrolę właściciela. Ich obecność ma dowód źródłowy/CI,
   nie nowy pozytywny dowód pełnego wykonania.
2. Historyczna próba obecnej integracji rzeczywiście wykonała Relax: completed,
   converged, 3 kroki. Publikacja została odrzucona przez niedeterministyczną
   serializację planu; deterministyczny zapis map naprawiono w `2f99894c…`.
3. W `6337f200…` naprawiono sprzężenie błędu publikacji z cleanup oraz wykrywanie
   nadal aktywnego lease po terminalnym Failed. Poprawki nie działają w starym
   uruchomionym runtime.
4. W `7658c1d2…` dodano wąski protokół exact failed exit → normalny release proof.
   W `a6dcd4db…` dodano zarządzany wrapper. CI HEAD przeszło bootstrap, kontrakty
   eigensolve, UI i odbiorników dyspersji. To nie dotyczy późniejszego WIP.
5. Rzeczywisty preview wrappera przeszedł. Pakiet maintenance zbudowano w tej
   samej grupie i backendzie. Natywny preview odmówił na granicy storage/provenance;
   `--apply` nie uruchomiono. Późniejszy odczyt potwierdził te same surowe hashe
   katalogu, lease i exit receipt; 14 artefaktów zachowane, proof nadal nie istnieje.
6. Harness UI istnieje i wymaga rzeczywistego zespolonego pola oraz WebGL.
   Pozytywnego odbioru tego pola jeszcze nie przeprowadzono.

Historyczne raporty starszych branchy obejmują wykonane punkty dyspersji.
Nie zastępują wyniku dla aktualnego SHA/runtime. Przygotowana obecnie krzywa
analityczna pozostaje REFERENCE ONLY, bez nowych punktów FEM tego runu.

## Mapa ścieżki i miejsca przerwania

`Python DSL → accepted RunIntent → preparation → Relax → certyfikat CAS →
Eigen → modal generation/CAS → portable SolutionSet → API data plane → UI`.

Obecny run zatrzymał się przed preparation/compute. Osobna historyczna próba
zaszła do Relax i zachowanych artefaktów, lecz jej cleanup pozostawił Active
lease + Quarantined host reservation. Z tego powodu normalny diagnostic stop
odmawia. Nowy maintenance candidate nie jest równoważny aktywnemu runtime
w delegacji storage, więc prawidłowo odmawia również normalne store identity.

## Ustalenia według priorytetu

| ID | Priorytet i charakter | Ustalenie / skutek | Dowód | Stan i dalsze działanie |
|---|---|---|---|---|
| A01 | P0, spójność źródeł | Niedokończony moduł maintenance jest zadeklarowany, ale nie istnieje. Bieżący WIP nie stanowi budowalnego punktu wyjścia. | E11, missing_module w JSON | Wstrzymane. Zadanie 2 ma wybrać i przywrócić spójny zakres, zachowując kopię WIP. |
| A02 | P0, kontrakt wykonania | Nowy executable maintenance nie przechodzi delegacji storage starego canonical runtime. Build nie sprawdza tego kontraktu. | E05–E06; rzeczywista odmowa `compiled source commit differs from runtime provenance` | Potwierdzone. Potrzebny jawny, ograniczony kontrakt; bez spoofingu, env bypassu i podmiany provenance. |
| A03 | P1, cleanup | Failed bez SolutionSet ponownie walidował nieudaną publikację, blokując drogę do release. Terminalny status bywał mylony z zamknięciem lease. | E01–E03; commit `6337f200…`; historyczny Active/Quarantined | Źródłowo naprawione i CI PASS; niewdrożone w aktualnym runtime. Zadanie 3 musi potwierdzić normalny proof. |
| A04 | P1, start runtime | Admission odrzucił sample aktywnego compute-node ownera. Komunikat obejmuje kilka warunków i nie ustala, który zawiódł w chwili admission. | E09; stderr zachowanej próby | Objaw potwierdzony, przyczyna NOT VERIFIED. Nie wolno twierdzić, że na pewno chodzi tylko o wiek próbki. Zadanie 4. |
| A05 | P1, dług architektoniczny | Wrapper ma 1661 linii, łączy odczyt kontekstu, build, source capture, walidację pakietu, wznowienie i embedded scripts. Silne mockowanie ukryło problemy ujawnione dopiero w realnym preview. | E12–E16; poprawki limitu control, aliasu WSL i short/full container ID | Refaktoryzacja wokół jednego modelu operacji, z reużyciem kanonicznych helperów. Nie dodawać kolejnego niezależnego launchera. |
| A06 | P2, obserwowalność i replay | Część source/build działa przed blokiem utrwalania wyniku błędu. Błąd tej fazy może nie mieć kompletnego własnego terminal receipt. Natywny preview został konserwatywnie zapisany jako outcome-unknown. | E12, E15; prepare receipt w JSON | Potrzebny jawny state machine, faza błędu i rozróżnienie niewywołanej mutacji od nieznanego wyniku apply. Nie nadpisywać historycznego receiptu. |
| A07 | P1, brak odbioru E2E | Certyfikat Relax→Eigen i modal bundle mają implementację, ale aktualny run nie przeszedł ścieżki do zaakceptowanego widma/pola. | E17–E20; stan runu | Luka weryfikacji, nie dowiedziony nowy błąd fizyczny. Zadania 5–6. |
| A08 | P1, trwałość i UI | Nie wykazano odczytu zapisanych danych po restarcie ani rzeczywistego pola w UI dla tego runu. HTTP 200 i testy fixture nie dowodzą widocznego modu. | E18, E21; brak accepted frequency/mode | Zadanie 7: zapis, odczyt bez Solve i pozytywny browser proof. |
| A09 | P2, integracja | Remote HEAD i lokalny WIP mają różny zakres. Zielone CI HEAD nie kwalifikuje WIP. Public documentation ma osobną porażkę CI. | Git status; CI w JSON | Nie scalać ani nie opisywać całego worktree jako zweryfikowanego. Oddzielić commit dokumentacji i późniejsze poprawki. |
| A10 | P1, metodologia odbioru | Kilka lub 15 punktów i zgodna krzywa nie dowodzą kompletności okna, dowolnych materiałów/geometrii, GPU lub pełnej zbieżności. | Audyt worktrees/master; istniejące deklaracje selected_only i NOT VERIFIED | Utrzymywać wąski zakres. Zadanie 8 daje dowód sweepa, dalsze bramki naukowe pozostają jawne. |

### Poprawione błędy, których nie należy naprawiać drugi raz

- Deterministyczny zapis metadanych planu: `2f99894c…`.
- Cleanup Failed/no SolutionSet i settled lookup po konkretnym exit receipt:
  `6337f200…`.
- Budżet odczytu control: limit pozostaje 8 MiB, nie 16 MiB. Poprawiono klienta.
- Mount WSL: zaakceptowany tylko po dowodzie tożsamości inode, nie po podobnym prefiksie.
- Container ID: porównywane pełne inspected Id, nie skrót z `docker ps`.
- Candidate execution: inventory i rzeczywiste bajty oraz otwarty descriptor,
  zamiast samego deklarowanego SHA w receipt.
- Replay sukcesu: dokładny run/task/receipt/iteration, zamiast samego UUID.

Ostatnie pięć pozycji jest zapisane w HEAD `a6dcd4db…`; dalsze rozszerzenie
cross-build admission jest nieukończonym WIP. Usunięcie tych kontroli w celu
szybszego uruchomienia nie jest naprawą.

### Odrzucona hipoteza z review

Nie potwierdzono, że `SessionStore::open_existing` sam wymaga compiled-runtime
provenance i dlatego potrzebuje nowego konstruktora. Prześledzona ścieżka to
`SessionStore::open_existing` → `CasStore::existing`: kontrola katalogów i CAS,
bez tej weryfikacji (E07–E08). Błąd pochodzenia występuje w kontrakcie
`HostResourceLedger::store_id` → `linux_native_store_identity` →
`validate_development_runtime_identity` (E05–E06).

Plan nie dodaje alternatywnego opener-a na podstawie niepotwierdzonego review.
Kolejność guardów i brak mutacji przed admission nadal wymagają kontroli, ale
są innym pytaniem niż przyczyna zaobserwowanego błędu.

## Ocena dotychczasowego sposobu pracy

- Rozwiązywano kolejne lokalne odmowy bez uprzedniego zamknięcia modelu całego
  cyklu odzyskania. Cross-build storage admission należało sprawdzić przed
  wielominutową kompilacją kandydata.
- Dokumenty narastały jako checkpointy. Brakowało jednego bieżącego rejestru:
  wymagany wynik → dokładny dowód → blokada → następny ograniczony krok.
- Testy fixture i source gates nie wystarczały do oceny gotowości startu.
  Potrzebne są scenariusze awarii całego protokołu i jeden rzeczywisty run.
- Błędy operacyjne, naukowe i UI mieszały się w raportowaniu postępu.
  Obecny blocker jest operacyjny; fizyka nie została ponownie zmierzona.

## Granice audytu

Audyt obejmuje lifecycle, provenance/storage, cleanup, typed handoff,
publikację i odbiór danych/UI. Nie jest nowym pełnym review matematyki całego
FEM ani certyfikacją CPU/GPU. Nie uruchamiano nowych obliczeń ani testów
kompilowanych. Wykorzystano istniejące wyniki CI i lekkich testów.
Parametry pilota w przykładzie są jawnymi danymi benchmarku, nie dowodem
hardkodowania odpowiedzi w solverze. Nie obniżono tolerancji, nie wygenerowano
fikcyjnej częstotliwości ani pola.

Automatyczna kontrola uprawnień odrzuciła wcześniej dodatkowe rozszerzenie
na skanowanie wszystkich lease'ów tasku. Nie wdrożono go. Plan pozostaje przy
konkretnym autorytatywnym process-exit receipt i dokładnym fence zasobów.

## Uzupełnienie z wykonania zadania 3 — 26.10.2026

**A11, P1: wznowienie porównywało tożsamość zdarzenia capture zamiast
stabilnej zawartości źródeł.** Producent `backend_source.py` dodaje nowe
`capture_id` i `created_at` przed wyznaczeniem `live_manifest_sha256`.
Wrapper przechwytywał ponownie do tej samej ścieżki przed apply, nadpisując
manifest przygotowania. Mimo niezmienionego commita `ccc38b7c3`, source digest
`a7c78b1ad0b9a7bddc90d7a8c5333601eaaa992caee37f137db8f05b5d92441c`
i snapshotu `5910b824a084d0d43969ce0b8947d928a723e4162a5f98b9469188c2758166b0`
hash capture zmienił się z `6ba19b8ce80e46db2366f1659a1cec30d630e0afdc61812e0b5a364ab15ca400`
na `9cc84a36b1583530ae01053a9d831826baae4c900038ea33c956c01d8d691a0e`.

Dowód: operacja `ada79f8d-9916-41dd-a9ec-c8053c2da6d8` uzyskała
`candidate-prepared` / native `validated`, a apply zapisało
`apply-pre-native-failure-6592320f31e2886c6008a0beb338d57b2930e4b3e6ccf5664331525124ffefc0.json`.
`native_invoked=false`; nie powstał release proof. Odczyt przed apply potwierdził
oryginalny hash katalogu, 14 artifact IDs, local Active / host Quarantined.
Nie wykonano naprawy starych danych. Poprawkę i kryteria odbioru opisuje
zadanie 3.5 planu; jej runtime pozostaje otwarte do nowego prepare→apply.

## Zamknięcie A11 i historycznej rezerwacji

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

## A12 — P1: poprawne typowane wejście odrzucane przy ponownej walidacji

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

Dowód runtime: [captured input, katalog, certyfikat i log](2026-10-26-eigensolve-relax-to-eigen-replay.evidence.json).
Nie zmieniano danych runu. Obecny runtime jest diagnostyczny po awarii compute;
nie ma nowej częstotliwości ani pola modu.


## A13 — P1: wznowienie niewystartowanego Eigen po zmianie inventory owner

Poprawka A12 w commicie `d4f0aee42266bff0a11c7fdd46eef99aee444226`
przeszła [bootstrap CI](https://github.com/MateuszZelent/fullmag/actions/runs/40407571491),
w tym regresję `study::dependency_tests`. Zarządzany build aplikacji zakończył
się powodzeniem (make 99,790 s; pakowanie 2,370 s), snapshot
`ae57b1bf8addf8d2323ec7e0d5b01b84a8d44230f6e23d826dbd47cdaffeb299`.
Development `03460acf40f24ef4b928831c2b4da67c` kończy się jednak
`failed-confirmed`: nowy compute scheduler odmawia wznowienia na
`host request is fenced by a different compute-node inventory owner`.

Porównano rzeczywiste stare i nowe Compose: oba używają tego samego wolumenu
`fullmag-dev-group-ledger-v1-5787a505f9bb481d9ce08ac0`, tożsamości hosta oraz
generacji `9281648fd4965acf6b42b7c7061e0f36a2b1ecf7da98307c2c5c7629270ed305`.
Rezerwacja Eigen pozostaje `Committed` / launch gate `Pending`, związana z
inventory epoch 2; bieżący rekord ownera ma epoch 4. Katalog nadal ma rewizję
22, to samo task/attempt i brak genesis/Start. Relax nie został powtórzony.
Numer epoch ledgera zasobów jest odrębny od ownership epoch zadania.

Kontrola `worker_launch_index` poprawnie blokuje użycie historycznego ownera.
Luką jest brak potwierdzonej ścieżki przekazania takiej rezerwacji w procedurze
resume. Nie wolno usuwać kontroli epoch, ręcznie przepisywać ledger/admission,
ani traktować nowego commita jako uprawnienia do startu. Korekta 6.1b wymaga
jawnej rewalidacji dokładnego niewykorzystanego przydziału albo normalnego
zamknięcia bez spawn i ponownego admission z zachowaniem Relax; wybór po
sprawdzeniu istniejących kontraktów i testów. Kolejny build dopiero po regresji.

Dowód: [niezmieniony katalog, Compose, owner i błąd scheduler-a](2026-10-26-eigensolve-pending-admission-restart.evidence.json).
A12 ma **CI PASS**, ale jego przejście w realnym Eigen pozostaje
**NOT VERIFIED**, ponieważ A13 występuje wcześniej. Brak nowej częstotliwości
lub zespolonego modu; API pozostaje diagnostyczne.

Review roboczej korekty A13: blokady host→store i zachowanie zwykłego fencing
nie wykazały błędu, ale przed commitem/CI trzeba związać receipt recovery
autorytatywnym digestem z rezerwacją (obecnie usunięcie pliku po publikacji
nie jest wykrywane), poprawić fixture brakującego admission tak, aby miał
run intent, i dodać negatywne przypadki starszego epoch/innego producer ID.
Kod tej korekty pozostaje WIP; nie uruchamiano z niego buildu ani obliczeń.

Domknięcie review A13: dodano `pending_inventory_recovery_sha256` do dokładnej
rezerwacji i walidację content-addressed receiptu przy każdym odczycie ledgera.
Receipt zachowuje poprzednią rezerwację, nowy request i powiązanie z admission;
dopuszcza zmianę tylko epoch tego samego producenta. Testy obejmują missing/
tampered proof, monotoniczny owner, brak admission, watermark, consumed/closed,
nieaktualne zasoby oraz przerwanie publikacji. Niezależne powtórne review nie
wykazało dalszego błędu w tym zakresie. Syntax/rustfmt nowego modułu i diff
check PASS; testy kompilowane i runtime nadal wymagają CI oraz nowego buildu.
