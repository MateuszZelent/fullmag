# Fullmag MCP — macierz testów, kwalifikacji i dowodów odbioru

**Status dokumentu:** plan kwalifikacji, **nie raport wykonanych testów produktu**.  
**Wszystkie T001–T100 mają w tym opracowaniu status NOT_RUN.**  
**Baseline źródłowy audytu:** `f95aa31e1d216008513770afe6b0ea9fad1b5260`.

## 1. Trzy różne rodzaje sukcesu

**Zgodność protokołu** oznacza, że klient i serwer poprawnie wymieniają MCP i schematy. **Zgodność aplikacyjna** oznacza zachowanie intencji, trwałości, uprawnień i workflow Fullmaga. **Poprawność naukowa** oznacza zgodność wyników z niezależnym oracle i uprzednio ustalonymi tolerancjami. Żaden z tych poziomów nie wynika automatycznie z pozostałych.

Porównanie MCP i REST jest bardzo potrzebne, ale oba wejścia mogą prowadzić do tego samego błędu solvera. Dlatego transport-equivalence nie jest samodzielnym testem fizycznym. Podobnie zielony health, obecność GPU czy wygenerowany obraz nie są dowodem poprawnego przebiegu obliczeń. [R07] [R18]

## 2. Oznaczenia i polityka wykonania

| Symbol | Rodzaj kontroli |
|---|---|
| A | Statyczna: schema, fixtures, dependency graph, źródła, config i docs |
| C | Black-box contract: HTTP/stdio/application boundary |
| R | Rzeczywisty managed runtime: native execution, storage, recovery |
| N | Numeryczna/fizyczna: niezależny oracle, tolerancje, convergence |
| S | Bezpieczeństwo: negatywne przypadki na izolowanej instancji |
| U | Współpraca z Control Room / UI i render lifecycle |

Tabela zawiera **100 rodzin scenariuszy**; implementacja może mieć więcej parametrów i testów niż 100. Nie wolno utożsamiać liczby scenariuszy z liczbą istniejących testów w repozytorium. Każdy scenariusz parametryzuje się istotnymi lane, transportami, rolami i momentami awarii.

Obowiązuje rootowy zakaz kompilowania testów jednostkowych. [R02] Planowanie testu jest dozwolone; wykonanie zakazanej kompilacji nie. Dozwolony black-box harness uruchamiany przez managed recipe testuje gotowy kwalifikowany proces i nie może ukrywać unit-build pod inną nazwą. Wymagany test niedostępny z powodu instrukcji/sprzętu ma status BLOCKED/NOT_RUN i blokuje właściwą deklarację release.

Statusy receipts: PASS, FAIL, BLOCKED, NOT_RUN; opcjonalne profile wyłączone z zakresu mają osobny `applicability=false` z powodem, nie fałszywy PASS. Dla obowiązkowych przypadków wszystkie wyniki muszą być PASS. Wewnętrzny smoke na lokalnych dokumentach tego pakietu nie jest żadnym z T001–T100.

## 3. Macierz przypadków

### Uwierzytelnianie, autoryzacja i zaufanie

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T001 | C/S | I04/I31 | Brak tokenu, uszkodzony token i niepoprawny podpis w profilu remote. | Odmowa przed odczytem prywatnego obiektu i przed jakąkolwiek mutacją; brak wycieku credentials w błędzie. |
| T002 | C/S | I04/I31 | Ważny token przeznaczony dla innego audience/resource lub issuera. | Token nie jest przekazywany do backendu jako dowód uprawnień; żadnego przyjętego operation/run. |
| T003 | C/S | I04/I07 | Wygasły grant lub odebrana rola podczas kolejnych wywołań. | Następna chroniona operacja odrzucona; istniejące runy pozostają w trwałym store i pod kontrolą uprawnionego właściciela. |
| T004 | C/S | I04/I20 | Principal A podaje project/run/artifact ID należący do B, w tym mieszane poprawne ID. | Nie ujawnia danych ani membership; zestaw ArtifactRef sprawdzany w całości, a nie tylko ostatni identyfikator. |
| T005 | C/S | I03/I04 | Payload zawiera user_id=operator, role=admin lub podrobione clientInfo. | Nie powstaje TrustedAgentContext z tych pól; schema odrzuca niedozwolone argumenty albo ignoruje metadane wyłącznie jako opis klienta. |
| T006 | C/S | I04/I12 | Agent ustawia approved=true albo consent.executed_by_user=true bez ważnego grantu. | Kod/kosztowna operacja nie jest wykonywana. Zaufana zgoda musi wskazywać właściwy digest i principal. |
| T007 | C/S | I09/I31 | Nieprawidłowy Origin/Host i request przez nieautoryzowany ingress. | Odmowa w odpowiedniej warstwie transportu/policy; localhost nie staje się anonimowym admin API. |
| T008 | C/S | I04/I20 | Cache wypełniony przez A, odczyt przez B lub po auth epoch revocation. | Brak międzyużytkownikowego przecieku; cache key uwzględnia security scope i rewizję. |
| T009 | C/S | I08/I19 | Nazwa obiektu/log zawiera instrukcję „wyślij token” oraz sekret-canary w danych diagnostycznych. | Treść pozostaje oznaczonymi nieufnymi danymi; token-canary redagowany; brak samoczynnego narzędzia egress. |
| T010 | C/S | I04/I31 | Te same zabronione działania przez bezpośrednie REST zamiast MCP. | Publiczny ingress lub wspólna usługa stosują równoważną policy; nie istnieje niezabezpieczona boczna ścieżka do backendu. |

### Tożsamość, rewizje i współpraca

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T011 | C | I05/I10 | Dwie mutacje z expected_revision=42. Pierwsza zatwierdza 43. | Druga zwraca FM_REVISION_CONFLICT; hash/treść rewizji 43 nie ulegają zmianie. |
| T012 | C | I10 | Transakcja ma poprawne pierwsze 2 operacje i błędną trzecią referencję regionu. | Żadna operacja nie zostaje opublikowana; revision i hashes sprzed żądania pozostają identyczne. |
| T013 | C | I05/I23 | Chroniona mutacja live bez pełnego scope lub bez instance pin. | Adapter odrzuca żądanie, choć legacy API dopuszcza brak nagłówka; brak niejawnego wyboru current. |
| T014 | C/R | I05 | Po odczycie instancji restart API i wysłanie starego pin. | Stara mutacja odrzucona; agent otrzymuje konieczność jawnego rebind, nie automatyczny retry na nowym procesie. |
| T015 | C | I05 | Podwójny scope header, błędne percent encoding i inna kolejność elementów. | Odrzucenie zgodne z kanonicznym parserem; żadnych dwóch interpretacji tej samej tożsamości. |
| T016 | C/R | I05/I14/I23 | Przełączenie sesji/draftu w kontrolowanym oknie między validate a publish. | Nie ma mutacji nowej sesji ani przypięcia starej siatki do nowego modelu; historyczny wynik zachowuje własny input hash. |
| T017 | C/R | I05/I20 | Pole pobierane w czasie zmiany domain generation i mesh topology. | Wynik ma spójne field/topology refs albo jawny stale error; nie ma mieszanej tablicy z innej generacji. |
| T018 | C/R | I05/I18 | Control i artifact publication ze starego attempt/ownership_epoch. | Odmowa; nowa próba pozostaje nietknięta. Fencing działa także przy opóźnionym worker ACK. |
| T019 | C | I03/I10 | Zmiana display name/type obiektu bez operacji fizyki. | Kanoniczne parametry oddziaływań pozostają identyczne; nazwa nie aktywuje modelu materiałowego ani solver feature. |
| T020 | C/U | I10/I23 | Headless agent tworzy inny projekt, gdy użytkownik edytuje aktywny workspace. | Current projektu użytkownika nie zmienia się; UI i agent nie używają wspólnego mutable scratch modelu. |

### Trwałość przyjęcia i idempotency

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T021 | C/R | I06/I17 | Ten sam key/payload wysłany dwukrotnie z różnymi JSON-RPC id. | Ten sam operation_id/logical run_id; drugi receipt oznacza replay, nie nowe wykonanie. |
| T022 | C | I06/I17 | Ten sam key przy zmienionym profile, start_policy lub wartości parametru. | FM_IDEMPOTENCY_CONFLICT; niezmieniony dotychczasowy RunSpec. |
| T023 | R | I06/I30 | 20 jednoczesnych identycznych requestów submit w jednym scope. | Dokładnie jeden logiczny intent; wszystkie skuteczne receipts odnoszą się do niego; brak nielimitowanego stormu workerów. |
| T024 | R | I06/I30 | Awaria po rezerwacji operation, ale przed przyjęciem native intent. | Recovery wznawia bezpiecznie tę samą rezerwację albo oznacza ją nieprzyjętą; nie ma ghost receipt durable=true. |
| T025 | R | I06/I17/I30 | Awaria po trwałym RunIntent, przed wysłaniem odpowiedzi klientowi. | Reconciliation odnajduje przyjęty run; replay nie tworzy drugiego ID ani drugiej autoryzacji kosztu. |
| T026 | R | I06/I19 | Restart procesu API między submit a późniejszym get/retry. | Ledger nie znika z pamięcią procesu; wynik odczytu odnosi się do pierwotnego runu. |
| T027 | C/R | I04/I06 | Ten sam tekst idempotency_key u dwóch principal/project scopes. | Rozdzielone rezerwacje i brak wycieku receipt A do B; nie ma globalnego oracle istnienia runów. |
| T028 | R | I06/I30 | Przerwana publikacja receipt/outbox albo niespójny digest danych w ledgerze. | Kontrolowany recovery lub integrity failure; nie zgadywać nowego inputu i nie akceptować innego payloadu pod starym kluczem. |
| T029 | C/R | I18/I30 | Odłączenie klienta po potwierdzonym accepted; osobno anulowanie trwającego read/prepare request. | Accepted run trwa zgodnie z policy; anulowany transport nie zmienia go w cancelled. Praca przed commit respektuje własny kontrakt anulowania. |
| T030 | R | I18/I30 | Cancel intent przyjęty, ale worker jeszcze nie potwierdził stopu. | Stan cancel_requested; zasoby nadal zarezerwowane aż do właściwego native evidence lub kontrolowanego recovery. |

### Zasoby i preflight

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T031 | C | I07 | Requested minimum cpu_millis=4000 i plan 4 wątków. | Interpretacja jako 4 jednostki CPU, nie 4 sekundy ani 4000 ms zużycia; walltime raportowane odrębnie. |
| T032 | C | I07/I16 | Minimum RAM/VRAM większe od ceiling grantu. | Odmowa przed admission; brak automatycznego przycięcia rozmiaru problemu. |
| T033 | C/R | I07 | Przekroczony walltime grant podczas bounded workload. | Runtime otrzymuje kontrolowany stop zgodny z policy; wyniki częściowe i przyczyna zachowane, brak niejawnego przedłużenia. |
| T034 | C | I07/I14/I24 | Rozmiary grid lub liczby osi batch powodują overflow bądź gigantyczne rozwinięcie. | Checked arithmetic i limit przed alokacją; brak zawieszenia/OOM przy samym planowaniu. |
| T035 | R | I07/I14/I30 | Brak miejsca podczas checkpoint/publikacji artefaktu. | Brak zatwierdzonego manifestu wskazującego niekompletny blob; jawna awaria/storage pressure i cleanup tylko własnego stagingu. |
| T036 | R | I07 | Dwa concurrent requests próbują zarezerwować ostatnią dostępną VRAM/CPU capacity. | Nie przekraczają globalnej pojemności; przegrany dostaje busy/quota, bez drugiego niespójnego lease. |
| T037 | C/R | I07/I18/I24 | Automatyczne retry i batch przypadki sumują koszty ponad grant. | Kolejne przyjęcie zablokowane; licznik nie resetuje się po restarcie agenta ani zmianie JSON-RPC id. |
| T038 | C | I04/I16 | Zmiana plan_sha256/profile po approval; wygasły prepared input. | FM_APPROVAL_REQUIRED/EXPIRED albo conflict; nie wykorzystuje się starej zgody do innej pracy. |

### DSL, fidelity i izolacja

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T039 | C | I11 | Źródło o niepełnym round-trip otwarte jako source_authoritative. | Scena pozostaje projekcją; save/export nie przepisują źródła na uproszczony model. |
| T040 | C | I10/I11 | Structured authoring → canonical Python → IR dla fixture deklarującej pełne fidelity. | Semantic IR hashes i znaczące parametry zgodne z umówioną kanonikalizacją; różnice prezentacyjne nie udają zmiany fizyki. |
| T041 | S/R | I12 | Skrypt próbuje odczytać/zapisać plik hosta poza sandboxem. | Dostęp zablokowany; sentinel hosta bez zmian; wynik ma kontrolowany error i nie publikuje projektu. |
| T042 | S/R | I12 | Skrypt próbuje połączenia do Internetu i adresu usług wewnętrznych. | Brak egress; nie można użyć compile jako SSRF ani kanału eksfiltracji. |
| T043 | S/R | I12 | Skrypt wypisuje env i próbuje znaleźć sekret-canary lub Docker socket. | Sekret i socket nie są dostępne; logi nie zawierają canary. |
| T044 | S/R | I12 | Skrypt tworzy nadmiar procesów/pliki lub zużywa pamięć do limitu. | Granice procesów/RAM/output zatrzymują worker bez destabilizacji API i innych runów. |
| T045 | S/R | I12 | Nieskończona pętla importu/kompilacji. | Worker kończy się według compile walltime policy, rezultat terminalny z przyczyną; brak pozostawionych orphan processes. |
| T046 | S/R | I12/I19 | Wielogigabajtowy stdout/stderr z wykonywanego źródła. | Bounded logs i jawny log_overflow; brak nieograniczonego bufora w API/SDK lub odpowiedzi MCP. |
| T047 | C/R | I12 | Skrypt publicznego DSL normalnie auto-Solve lub jawnie wywołuje run. | Compile-only capture nie uruchamia solvera; zachowuje deklarację badania albo odrzuca niedozwolony efekt. |
| T048 | C/S | I04/I12 | Brak kwalifikowanego izolatora lub approval pomimo poprawnego źródła. | fm_script_compile niedostępne lub jawnie odmówione; brak fallbacku do from-script w procesie z szerszymi prawami. |
| T049 | C/S | I11/I13 | Zmieniony import asset/dependency przy tym samym źródle tekstowym. | Digest kompilacji i planu zmienia się; stary receipt/prepared run nie zostaje uznany za zgodny. |
| T050 | C | I11/I12 | Użytkownik/agent próbuje zmienić source_authoritative na scene_authoritative mimo fidelity fail. | Wymagana jawna konwersja i zaakceptowany semantic diff; brak ukrytej utraty pól modelu. |

### Lifecycle i capability

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T051 | C/R | I01/I16/I17 | Submit hold oraz submit after_admission na tym samym typie workloadu. | Held nigdy nie startuje przed release. After_admission startuje tylko przez istniejącego coordinatora i po prawidłowym admission. |
| T052 | A/C/R | I03/I14/I15 | Porównanie ścieżki MCP i canonical direct path dla identycznego inputu. | Ten sam plan/spec/mesh/IR intent i ten sam właściciel native execution; brak alternatywnego solver runnera. |
| T053 | C/R | I08/I17/I29 | Wymuszony GPU, ale właściwy GPU runtime niedostępny. | Jawna odmowa; brak uruchomienia CPU i brak zmiany requested intent. |
| T054 | C/R | I08/I17 | device=auto przy legalnej polityce wyboru. | Zachowane requested=auto, resolved/device i faktyczne executed evidence; wybór jest audytowalny. |
| T055 | A/C/R | I08/I29 | Żądanie FDM CPU w bieżącym kontrakcie. | Reklamowana jest legalna CpuReference; sam katalog native nie tworzy nowego wspieranego silnika. |
| T056 | R/N | I27/I29 | FEM CPU workload z kwalifikowanego pakietu. | Evidence wskazuje właściwy native backend i precyzję; nie wystarcza host health ani proces o odpowiedniej nazwie. |
| T057 | R/N | I27/I29 | FEM GPU i FDM GPU workload, z odczytem rzeczywistych etapów wykonania. | Wykazane GPU execution dla deklarowanej pracy; ewentualne dozwolone host stages jawne. Nie udawać full device residency bez dowodu. |
| T058 | C | I08/I27 | Nowy build/driver/profile z dawnym qualification receipt. | Nie przenosić qualified=true bez zgodności zakresu dowodu; stale manifest daje unknown/qualification_required. |
| T059 | C | I08/I15/I27 | Niekwalifikowane połączenie fizyki, BC, geometrii lub precyzji. | Preflight zwraca reason code przed kosztem; nie wyłącza po cichu DMI/PBC/demag ani nie zmienia discretization. |
| T060 | C/R/N | I22/I27 | Proces ukończony, lecz kryterium relaksacji/solver accuracy nieosiągnięte. | lifecycle=completed może współistnieć z quality_state=fail/warn; raport nie opisuje tego jako sukcesu naukowego. |

### Native control, recovery i checkpoint

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T061 | R | I18/I19 | Pause/resume/cancel podczas kwalifikowanej fazy runtime. | Osobne requested i acknowledged; control targeting sprawdza stage/task/attempt i nie zatrzymuje innej pracy. |
| T062 | C/R | I17/I19 | Timeout/reconnect po wielokrotnym progress bez końcowego response. | Odczyt trwałego runu rozstrzyga stan. Agent nie dostaje fałszywego failed wyłącznie z braku odpowiedzi. |
| T063 | R | I06/I18/I30 | Stary worker odzyskuje łączność po utracie lease i po uruchomieniu nowego attempt. | Jego artifact publication oraz ACK nie zmieniają current attempt; ślad starej próby zostaje do diagnostyki. |
| T064 | C/R | I19 | Cursor poza retencją, utracone zdarzenia i burst wielu updates. | gap/resync_required, bounded bufor/coalescing; snapshot działa bez event streamu i nie ma memory leak. |
| T065 | C/R/N | I21 | Checkpoint zawierający tylko stan fizyczny przy żądaniu exact_resume. | Odmowa lub jawny niższy poziom wymagający nowego wyboru; brak marketingowego exact resume. |
| T066 | C/R/N | I21 | Restart z różnym mesh/layout/ABI/precision lub bez wymaganego RNG/historii integratora. | Compatibility gate odrzuca niedozwolone połączenie przed startem i podaje konkretną przyczynę. |

### Kampanie i współbieżne badania

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T067 | C/R | I07/I24 | Niezależny batch z deterministycznymi osiami i skończonym limitem. | Stała liczba i identyfikatory przypadków, właściwy aggregate budget i brak dwóch runów tego samego case po retry. |
| T068 | C | I15/I24 | Te same osie użyte jako zip oraz Cartesian product. | Jawnie różne plany/count/digests; nierówne długości zip odrzucone według typed policy. |
| T069 | C/R/N | I15/I24 | Hysteresis lub sweep z inicjalizacją ze stanu poprzedniego kroku. | Zachowana sekwencja i zależność ArtifactRef; nie zrównoleglono jako niezależnych przypadków. |
| T070 | C/U/R | I23/I24 | Agent anuluje własny batch, podczas gdy UI i drugi agent pracują nad innym runem. | Zakres anulowania obejmuje tylko wskazany batch/catalog revision; sesja UI i cudze lease bez zmian. |

### Dane, integralność i semantyka naukowa

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T071 | C/N | I20/I27 | Quantities B/H, m/M i f/omega/k z odpowiednimi konwencjami. | Units i interpretacja po MCP są identyczne z canonical registry; brak niejawnej konwersji lub zmiany osi. |
| T072 | C/S | I20 | Artefakt z prawidłowym ID, ale złym digestem lub inną attempt/revision. | FM_RESULT_INTEGRITY_ERROR albo odmowa ACL przed zwróceniem wartości liczbowych. |
| T073 | N/R | I21/I29 | Checkpoint przeniesiony między wspieranymi środowiskami oraz porównanie wyników. | Poziom reproducibility odpowiada rzeczywistemu dowodowi; bitwise nie jest wymagane/obiecane dla numerically_bounded migration. |
| T074 | C | I19/I20 | Duża lista i 1024 wartości przekraczające wspólnie 64 KiB po serializacji. | Przestrzegany limit bajtowy całej odpowiedzi, także tekstowej kopii structuredContent; cursor/ref zamiast uciętego JSON. |
| T075 | C/N | I14/I20/I27 | Pole FEM z ROI, interpolation/resampling oraz pole FDM z materiałową maską. | Association/weighting/approximation podane; node average nie jest błędnie nazwane volume average. |
| T076 | C/N | I20/I22 | Zespolone mody, dtype single/double, kolejność osi i indexing. | Manifest i próbki są spójne; real/imag/phase nie zmieniają konwencji po drodze, jednostki osi jawne. |
| T077 | C | I20/I27 | Żądanie quantity, która nie została zapisana lub wyliczona. | Unavailable z powodem; brak zerowych tablic udających pomiar i brak kosztownego compute w read. |
| T078 | C/S | I13/I20 | Ticket binarny wygasły, z innego principal, za szeroki range lub przekroczony byte budget. | Odmowa/restrykcja do dozwolonego zakresu, bez arbitralnych ścieżek i publicznego udostępnienia danych. |
| T079 | S | I13/I31 | Arbitrary URL, metadata IP, ścieżka ../, UNC, symlink escape i archive bomb w import/export. | Każda klasa zatrzymana na odpowiedniej granicy; brak odczytu/publikacji poza registered storage i upload scope. |
| T080 | C/S | I19/I22/I23 | Viewer wykonuje zapytanie wymagające nowej kosztownej analizy lub renderowania. | Brak ukrytego admission z prawami read; wymagane osobne budgeted operation i odpowiedni scope. |

### Scenariusze naukowe i adaptacyjne

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T081 | N/R | I22/I29 | Mała relaksacja/dynamika z niezależnie ustaloną odpowiedzią referencyjną. | Błędy mieszczą się w uprzednio przypiętym tolerance manifest; report odróżnia zgodność transportu od poprawności naukowej. |
| T082 | C/N | I15/I22/I27 | Bloch eigen, skończony falowód z odbiciami i wariant termiczny bez anteny. | Trzy semantyki pozostają rozdzielone; analiza wskazuje BC/źródła/obserwację i nie dodaje niezamówionego wzbudzenia. |
| T083 | C/R | I25 | Autonomiczny dobór kolejnych parametrów, osiągnięty limit/stop criterion i restart agenta. | Kampania kończy się zgodnie z policy, zachowuje observations/proposals i nie resetuje budżetu po nowej rozmowie. |

### Eksploatacja i kwalifikacja

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T084 | A/R | I00/I32 | Uruchomiony profil DEV z MCP. | Tylko dwie stałe usługi aplikacji; build/runtime należą do właściwej grupy i port jest jawnie przypisany. |
| T085 | A/R | I13/I32 | Build/import/compile outputs i próba zapisu do źródeł. | Source mount readonly, tech artefacts w approved volumes, user results w resolved storage; brak przypadkowego host cache. |
| T086 | C/R | I09/I32 | Zamknięcie stdio proxy podczas istniejącego runu. | Proxy kończy się, run dalej obserwowalny po nowym połączeniu; stdout nie ma logów aplikacji. |
| T087 | R | I30/I32 | Upgrade API przy żywych workerach oraz zmiana instance identity. | Stare live tokens odrzucane; run ownership zachowane lub kontrolowany drain. Nie następuje powtórny Solve. |
| T088 | R | I30/I32 | Kill switch nowych mutacji, rollback oraz backup/restore drill. | Odczyt/reconciliation działają; nie utracono CAS/receipts, nie cofnięto schematu bez migracji i nie przyjęto drugi raz intentu. |
| T089 | A | I00/I28 | Wymagany przypadek wymaga zakazanej kompilacji testu jednostkowego. | Status BLOCKED, brak wykonania i brak exit=0 dla niepełnej wymaganej kwalifikacji. |
| T090 | N/R | I21/I29 | Fixture matrix na FDM CPU, FDM GPU, FEM CPU, FEM GPU. | Oddzielne receipts dla każdej lane i jej workloadu; brak wspólnego PASS przy brakującym sprzęcie lub wyniku. |
| T091 | A | I00/I32 | Raport wskazuje inną rewizję kodu, docs lub policy niż testowany build. | Drift wykryty; brak przeniesienia dawnego PASS na nowy SHA, źródła i constraints aktualizowane jawnie. |
| T092 | C/R/N | I29/I33 | Pełny workflow z provenance bundle odtworzony w czystym uprawnionym środowisku. | Wejścia/spec/algorithm refs rozliczone; wynik zgodny z zadeklarowanym poziomem reproducibility i niezależnym oracle. |

### Protokół i klient

| ID | Typ | Właściciel | Scenariusz | Oczekiwany wynik / oracle |
|---|---|---|---|---|
| T093 | C | I02/I09/I28 | Klient modern wykonuje dozwolone RPC zgodnie z profilem 2026-07-28. | SDK i adapter spełniają przypięty kontrakt M01; aplikacja nie uzależnia działania od legacy session handshake. |
| T094 | C | I09/I28 | Rzeczywisty klient profilu 2025-11-25. | Poprawna obsługa wybranej ery; modern DTO nie przeciekają do niewspieranego wariantu wire. |
| T095 | C | I02/I28 | Klient żąda nieobsługiwanej wersji protokołu. | Rozpoznawalny błąd zgodny z M01, lista wspieranych wersji i brak skutku domenowego. |
| T096 | C | I09/I28 | Niespójne metadane body/header albo błędne HTTP framing. | SDK odrzuca zgodnie z przypiętym M02; nie dochodzi do operacji naukowej mimo poprawnych argumentów wewnętrznych. |
| T097 | A/C | I03/I28 | Valid/invalid input i każdy wariant success/domain-error output. | Schematy są spójne; unknown fields/NaN/u64 overflow odrzucone; nie ma odpowiedzi naruszających własny outputSchema. |
| T098 | C | I08/I28 | Powtarzane tools/list po różnych rozmowach i zmianach modelu, z różnymi scope. | Katalog deterministyczny dla profilu/auth; nie zależy od przypadkowej historii połączenia, a cache nie ujawnia uprawnień innych użytkowników. |
| T099 | C | I26/I28 | Klient bez Tasks capability oraz klient z przypiętym qualified extension. | Core submit/get zawsze działa; żadnego niezamówionego task result. Dla włączonego rozszerzenia sprawdzić stan/TTL/ACL wg jego osobnego manifestu. |
| T100 | C/R | I09/I26/I28 | Anulowanie requestu, zamknięcie streamu i wygaśnięcie opcjonalnego task handle. | Transport stosuje właściwy profil SDK; skutki domenowe odpowiadają jawnej semantyce submit/control, nie przypadkowemu lifecycle socketu. |


## 4. Numeryczne fixtures do kwalifikacji lane

Poniższe pliki są **projektowane** pod `tests/fixtures/mcp/physics/`. Przed ich uruchomieniem trzeba zweryfikować istniejące referencje Fullmaga i odwołać się do nich, zamiast tworzyć drugi konkurencyjny zestaw golden data. Brak istniejącej referencji wymaga jej jawnego przygotowania i niezależnej recenzji. Parametrów tolerancji nie dobiera się po obejrzeniu wyniku implementacji.

| Fixture | Cel | Obserwacje | Sposób odniesienia |
|---|---|---|---|
| `macrospin_llg` | Jednostki, znak precesji, czas, integrator i damping | m(t), norm error, frequency/phase, energy/stop reason | Analityczny lub niezależnie zwalidowany model dla jawnie wybranego przypadku; gamma convention w manifeście |
| `nonuniform_relaxation` | Realistyczny rozkład m i kryteria relaksacji | Energy terms, torque/norm metrics, accepted terminal state | Przypięty benchmark i convergence, nie tylko total energy jednej siatki |
| `two_region_interface` | Regions/material assignments/coupling i numeracja | Mapy parametrów, membership, wymiana i interface observables | Kanoniczny model i osobne testy zachowania region IDs; ważne po zmianach multilayer |
| `finite_waveguide_antenna` | Źródło pola, skończone brzegi, zapis przestrzenno-czasowy | m(r,t), source manifest, propagation/reflections, sampling | Reference w tym samym modelu BC; osobno porównanie rozdzielczości i czasu próbkowania |
| `periodic_bloch_eigen` | k=0 vs non-k0, faza i jednostki k/f | Eigenvalues, residuals, mode fields, branch IDs | Przypięty problem modalny i residual/dispersion criteria; nie wynik finite FFT |
| `thermal_no_antenna` | Brak niezamówionego wzbudzenia, RNG i statystyka | Seed/RNG state, ensemble summaries, dynamic spectrum | Powtarzalność dla identycznej realizacji oraz osobne testy statystyczne; nie wymaganie identyczności niezależnych seeds |
| `checkpoint_continuation` | Restart w połowie obliczeń | State/time, solver history, RNG, późniejsze obserwacje | Porównanie z uninterrupted run na deklarowanym poziomie exact/numerically_bounded |
| `mesh_convergence` | Sensowna zgodność FEM/FDM i precyzji | Zbieżność częstotliwości/energii/obserwabli | Badanie refinement i niezależna tolerancja; nie pointwise equality różnych carrierów |

### 4.1 Tolerance manifest

Każda fixture musi mieć niezmienne pola: `fixture_version`, `input_digest`, `reference_source`, `reference_digest`, `quantity_id`, `comparison_operator`, `absolute_tolerance`, `relative_tolerance`, `units`, `valid_regime`, `justification` i `reviewer_receipt`. Dla testów statystycznych dochodzą ensemble size, test statistic i kontrola błędu wielokrotnych porównań. Brak obowiązkowego parametru daje INVALID_FIXTURE, nie zastosowanie ukrytej tolerancji domyślnej.

Obserwable o różnej skali wymagają różnych kryteriów. W pobliżu zera sama względna tolerancja jest niewystarczającym kontraktem; manifest definiuje operator łączący absolute/relative bounds. Test musi porównywać w tej samej jednostce i na właściwym nośniku. Interpolację i jej błąd ujmuje się jawnie, a nie maskuje szeroką tolerancją globalną.

Kwalifikacja GPU ma dwie części: poprawność wartości oraz dowód, że wykonała się deklarowana implementacja. Dopuszczalne etapy hostowe są jawnie wymienione w capability; nie traktujemy automatycznie hostowego Krylov jako dowodu braku GPU, ale też nie nazywamy takiej ścieżki w pełni device-resident bez dowodu. [R05]

### 4.2 Macierz wymaganej kwalifikacji

| Obszar | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|
| Canonical input/spec parity | wymagane | wymagane | wymagane | wymagane |
| Native execution provenance | wymagane | wymagane z GPU evidence | wymagane dla właściwej ścieżki | wymagane z podziałem host/device |
| Relax/time-domain dla reklamowanej fizyki | per fixture | per fixture | per fixture | per fixture |
| Mesh/grid/readout semantics | grid/mask | grid/mask/device copy | FE support/interpolation | FE support/device copy |
| Pause/resume/cancel | tylko deklarowane capability | tylko deklarowane capability | tylko deklarowane capability | tylko deklarowane capability |
| Checkpoint level | per integrator/profile | per integrator/profile | per integrator/profile | per integrator/profile |
| Eigen/response/thermal | osobny gate, jeśli reklamowane | osobny gate, jeśli reklamowane | osobny gate, jeśli reklamowane | osobny gate, jeśli reklamowane |
| Forced-lane no fallback | wymagane | wymagane | wymagane | wymagane |

**Status wszystkich komórek w tym audycie: NOT_RUN.** Słowo „wymagane” opisuje test przyszłego produktu. Nie zakładamy, że wszystkie metody naukowe już istnieją w każdej realizacji.

## 5. Fault injection: dokładne punkty przecięcia

| Punkt awarii | Co mogło już nastąpić | Co musi pokazać recovery |
|---|---|---|
| Przed reservation | Brak skutku | Brak accepted run; retry legalny z tym samym key |
| Po reservation, przed intent | Trwała tożsamość planowanej operacji | Ponowienie tej samej publikacji, bez nowego run_id |
| Po intent, przed receipt | Praca logicznie przyjęta | Reconciliation zwraca istniejący RunRef |
| Po admission, przed worker claim | Zasoby przyznane, brak startu | Recovery lease/queue bez zgadywania running |
| Po claim, przed first progress | Istnieje owner/attempt | Run przypisany do próby; brak podwójnego właściciela |
| Po checkpoint blob, przed manifest | Nieopublikowany blob/staging | Czytelnik nie widzi niekompletnego checkpointu |
| Po terminal native event, przed artifact commit | Obliczenia mogły się skończyć | Osobne execution i artifact publication state |
| Po lease expiry, późny worker | Stara próba nadal może pisać | Fencing blokuje publikację i kontrolę nowej próby |
| Po commit artefaktów, przed event delivery | Dane są trwałe, event zagubiony | Snapshot/catalog nadal znajduje prawidłowy wynik |
| Przy rollout/rollback API | Transport i instance zmienione | Run ownership nie przechodzi do przypadkowego nowego procesu |

Testy wykonuje się na odrębnym projekcie i kontrolowanym środowisku. Fault injection nie może celować w istniejące badania użytkownika, globalny ledger innych grup ani realne urządzenia laboratoryjne.

## 6. Obciążenie i limity

Pierwszy load profile obejmuje 20 równoczesnych klientów agentowych plus jednego klienta Control Room, katalog 10 000 małych rekordów wyników oraz ograniczoną liczbę aktywnych native tasks zależną od grantu hosta. Nie oznacza to 20 równoczesnych ciężkich symulacji GPU. Limity admission pozostają aktywne.

Mierzyć p50/p95/p99 czasu odczytu i trwałego przyjęcia, pamięć API/SDK, rozmiar kolejki eventów, writer contention, liczbę powtórzeń i odrzuceń, czas reconciliation oraz ilość danych wysłanych do klienta. Osobno raportować czas obliczeń, oczekiwania w kolejce i publikacji artefaktów. Test nie może poprawiać wyniku p95 przez ACK przed fsync/receipt.

Payload test porównuje **rzeczywiste bajty po serializacji**, w tym tekstową reprezentację structuredContent i metadata. Paginacja nie zwraca „sukcesu” z uciętym JSON. Dane przekraczające limit stają się artefaktem lub kolejną stroną. Limity z katalogu są propozycją produktu, więc po pomiarze wolno zmienić je wyłącznie jawnie i z policy revision.

## 7. Zgodność klientów i opcjonalnych funkcji

Tabela odbioru musi wskazywać application name/build, SDK/profile, transport, authentication mode i wykonane T093–T100. Nie wystarczy ogólne „działa z agentami”. Dla każdej reklamowanej ery potrzebny jest przynajmniej jeden rzeczywisty klient oraz niezależny harness zgodności.

Tasks nie jest wymagane dla trwałych obliczeń. W profilu bez niego testuje się, że zwykły submit/get/control działa i serwer nie reklamuje rozszerzenia. W profilu z nim obowiązuje osobny pin specyfikacji i SDK oraz interpretacja statusów według rozszerzenia. Przykładowo końcowy wynik narzędzia z błędem domenowym nie musi odpowiadać protokołowemu failed. [M07]

Cache/list/resources testować zarówno jako Viewer, Author, Runner, jak i po odebraniu uprawnień. Przejście do innego projektu w rozmowie nie zmienia security scope ani listy tools na podstawie „pamięci” serwera. Resource URI podlega tej samej autoryzacji co równoważny tool read. [M10]

## 8. Wymagany format receipt

Przykład poniżej jest **szablonem wyniku NOT_RUN**, nie dowodem testu. Pola build/hardware i evidence zostają null do czasu rzeczywistego wykonania.

```json
{
  "schema_version": "fullmag.mcp.verification.v1",
  "case_id": "T025",
  "source_sha": "f95aa31e1d216008513770afe6b0ea9fad1b5260",
  "build_digest": null,
  "compose_group": null,
  "runtime_profile_ref": null,
  "hardware_manifest_ref": null,
  "policy_digest": null,
  "applicable": true,
  "status": "NOT_RUN",
  "expected": "Exactly one logical run after crash between durable intent and response",
  "observed": null,
  "evidence_refs": [],
  "limitation": "Static audit and implementation planning only"
}
```

Po wykonaniu receipt jest niezmienny, zapisany razem z logami i artefaktami testu w dozwolonym storage profilu. Raport agregujący linkuje jego digest. Nie nadpisywać starego FAIL nowym PASS; nowa próba kwalifikacji dostaje nowy receipt i relację supersedes.

## 9. Reguły werdyktu release

**PASS**: wszystkie obowiązkowe przypadki dla reklamowanego profilu zakończyły się PASS, nie ma otwartych P0/P1 naruszających obietnicę tego profilu, a docs/capabilities odpowiadają dowodom. **CONDITIONAL**: dopuszczony wąski profil, np. lokalny read-only lub jeden lane, z wyłączonymi niezakwalifikowanymi funkcjami. Nie wolno tak nazywać pełnego wydania z pominiętymi krytycznymi testami. **FAIL**: niezamknięta granica bezpieczeństwa, integralności lub trwałości w reklamowanym zakresie.

Brak GPU, ograniczenie narzędzi, zakaz unit-build czy brak niezależnej referencji nie świadczą automatycznie o błędzie produktu, ale **uniemożliwiają pozytywną deklarację, której nie ma czym poprzeć**. Ta zasada jest częścią projektu MCP: sam agent otrzymuje te same jawne ograniczenia, zamiast wiarygodnie brzmiących zapewnień.


## Odsyłacze źródłowe

[R01]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r01
[R02]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r02
[R03]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r03
[R04]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r04
[R05]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r05
[R06]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r06
[R07]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r07
[R08]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r08
[R09]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r09
[R10]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r10
[R11]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r11
[R12]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r12
[R13]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r13
[R14]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r14
[R15]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r15
[R16]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r16
[R17]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r17
[R18]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r18
[R19]: 06_REJESTR_ZRODEL_I_DECYZJI.md#r19
[M01]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m01
[M02]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m02
[M03]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m03
[M04]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m04
[M05]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m05
[M06]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m06
[M07]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m07
[M08]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m08
[M09]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m09
[M10]: 06_REJESTR_ZRODEL_I_DECYZJI.md#m10
