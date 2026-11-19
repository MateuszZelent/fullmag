# Odzysk publikacji ukończonej inspekcji anteny — 27.10.2026

## Problem i kryterium odbioru

Pełna próba run-5654db21201dd6c660f7ecae78baf8588477fe2a7d90480d9d64b30e4d050080
ukończyła obliczenie 1145 punktów, lecz konflikt zapisu zakończył proces i task
błędem. Bundle CAS 39f795b2178f12c47f7622157f298d43e65aac39582467018abe058bf6b37c7e
ma 12485669 bajtów. Cel: odzyskać do kanonicznego SolutionSet rzeczywiste V/J/H
oraz ich geometrię, bez Solve i bez zmiany Failed w historii próby.

1. Zweryfikować pełny wynik natywnym dekoderem i zaakceptowanym ProblemIR.
   Dowód: rzeczywisty CLI preview, ścisłe odmowy niezgodnych żądań.
2. Opublikować istniejący model SolutionSet ze stanem Closed/Failed/Unassessed.
   Dowód: odczyt z publicznego API, zachowany task/journal/lease i oryginalny CAS.
3. Potwierdzić idempotencję i dane V/J/H po ponownym odczycie.
   Dowód: identyczny replay bez nowej rewizji, dokładne rozmiary i skróty
   payloadów, własna geometria przewodnika oraz Global.
4. Powrócić do wizualizacji Universe w istniejącym UI.
   Dowód wymagany osobno: rzeczywista przeglądarka/WebGL. Wcześniejsza blokada
   narzędzia nadal obowiązuje; testy źródeł nie zastępują tego odbioru.

## Kontrakt operacji

Istniejące binarium fullmag-api-accepted-worker otrzymuje jawny tryb
--recover-inspection-publication --store-root <absolute> --request <absolute>
--request-sha256 <canonical-json-sha256> [--verify-only].
Ten tryb nie obsługuje Start i nie wywołuje solvera. Zachowuje kontrolę
przypiętego pakietu verify_runtime_owner_build.

Żądanie fullmag.completed_inspection_publication_recovery_request.v1 zawiera:
project/run/task/attempt/epoch, dokładny bundle, exit receipt, uzasadnienie
i mapę expected_evidence. Preview bez mapy tworzy propozycję przypiętego
żądania, ale niczego nie publikuje. Apply wymaga całej mapy zgodnej z bieżącym
odczytem i jej SHA256. Brak pola albo nieznane pole są błędem.

Weryfikacja wykorzystuje istniejące Started/Completed DTO i
recover_completed_worker_execution, a nie alternatywny dekoder.
Sprawdza zaakceptowany RunSpec/plan/ProblemIR i preparation, pełny zbiór portów,
dokładny Start, CAS, budżety oraz jedną zakończoną operację. Dopuszcza wyłącznie
Failed po reaped StoreWriterBusy, bez timeout, Stop lub cancellation,
z dokładną Released CPU lease. Stan koordynatora jest odtwarzany tylko do
odczytu. Odnowiona sekwencja heartbeat nie może unieważniać legalnego Started.

Preview utrzymuje wspólną blokadę odczytu. Apply ponawia wszystkie kontrole
pod jedną natywną blokadą writer i publikuje wyłącznie SolutionSet/CAS.
Normalny publish_study_outputs, aktywne lease, bramki Succeeded/Completed,
artifact catalog, scheduler i dependency gates pozostają bez wyjątków.

## Dane i pochodzenie wyniku

Producent publish_recovered_inspection_solution używa istniejących
study_inspection_tensor::materialize, materialized datasets i owned sample
geometry. Zachowuje V w V, J w A/m², H w A/m; nie tworzy pola bazowego na amper
ani stanu magnetycznego. Identyfikator wiąże oryginalną próbę i przypięte żądanie.
Inny odzysk tej samej próby jest konfliktem. Identyczny replay musi dać ten sam
zamknięty wynik i pełny graf artefaktów.

Diagnostic fullmag.completed_inspection_publication_recovery.v1 zapisuje
żądanie i skróty wszystkich dowodów. Task, historia, lease, bundle i dane
wejściowe pozostają bez zmian. Failed/Unassessed jest widoczne w zapisanym
wyniku. Odzysk nie oznacza kwalifikacji fizycznej, bazy ani dopuszczenia do LLG.

## Weryfikacja i build

Niezależny przegląd sześciu źródeł: 0 otwartych Required po poprawkach
odnowienia claim, kontroli build identity i ścisłego powiązania evidence.
Raport: wolumen kontrolny grupy,
verification/completed-inspection-recovery-20261027/review-final.json.
Parser Rust oraz diff check przeszły; testów Rust nie kompilowano.

W chwili sporządzenia: managed build, rzeczywiste preview/apply/replay,
HTTP i wizualizacja pozostają NIEZWERYFIKOWANE. Statusy należy uzupełnić po
wykonaniu, bez przypisywania sukcesu na podstawie samego kodu.

Brak skilla fullmag-build-stage-cleanup w używanym worktree. Zastosowano
fallback z build-storage governance i procedury fullmag-docker-build.
Cache, ostatni zweryfikowany pakiet, rollback, wyniki oraz dowody pozostają
zachowane. Nie stwierdzono zbędności konkretnych starych generacji; brak usuwania.
Ponowna ocena po udanym buildzie i sprawdzeniu referencji. Pomiar przed buildem:
D: 90609287168 B wolnego; Docker build/package około 316.7 GiB, user storage
około 219.4 GiB. Pomiar jest chwilowy, bez deklarowania quota.


## Rzeczywisty preview i odmowa pierwszego apply

Build ce9b38acd1b542bab7b6326caed22fdf zakończył się poprawnie w tym samym
kontenerze backend własnej grupy. Baza 537b77d700fd37f4778eed2c5be44f275b2ca57a,
snapshot e82fd29f5e3c72b7c2554ed7b5f340eb54a763de0698257270a0561f3329e984.
Scena, bieżący historyczny run i oryginalny pakiet pozostały niezmienione.

Natywny Rust preview dwukrotnie zdekodował i zweryfikował pełny pakiet1145
względem zaakceptowanego modelu. Siedem przypadków negatywnych odmówiło
z właściwym powodem: obca epoka, inny bundle, zmieniony pin Completed,
brak pina journal, nieznane pole żądania, niezgodny SHA żądania oraz obcy
snapshot pakietu. Wszystkie 1391 plików runu i CAS pozostały identyczne.
Dowody: native-preview-01/, request SHA
131c00412e1819132a4be4df38cb35d80cf91aa52feba64932158aab9ffe7a81.

Pierwszy apply zakończył się bez publikacji: dokładna bramka Released lease
odmówiła. Replay zawiera wydany heartbeat686, ale trwała Released lease oraz
receipt wyjścia potwierdzają685; Started/Completed zawierają0. Wydanie heartbeat
zwiększa claim przed ACK i utrwaleniem rezerwacji. Nie zmieniono trwałych danych
ani nie obniżono bramki producenta. Powód i exit1 zachowano w apply.stderr.log
oraz apply.receipt.json. Nie ponowiono Solve.

Poprawka weryfikatora rozróżnia wydane i potwierdzone odnowienie. Wymaga
pełnej zgodności CPU/token/resource/identity/budżetów, zakresu
genesis_sequence <= released_sequence <= replayed_sequence i dokładnego
exit_sequence == released_sequence. Lokalna kopia służąca wyłącznie jako dowód
otrzymuje potwierdzoną Released sequence. Started/Completed nowsze od Released
są odrzucane istniejącym predykatem; journal, task, rezerwacja i ich historia
pozostają niezmienione. Preview i apply używają tej samej bramki lease.

Dodano cztery regresje Rust tej granicy; pozostają niekompilowane zgodnie
z zakazem repozytorium. Parser i 11 kontroli źródłowych przeszły. Ponowny
managed build, natywny preview/apply/replay, HTTP i wizualizacja tej poprawki
pozostają na tym checkpointcie NIEZWERYFIKOWANE. Wcześniejsze dowody nie
zostały nadpisane. UI Telemetry/Antenna z ETA zapisano niezależnym commitem
78136fb8feb0f57014d10cf171a1cec83ef55f62.


## Końcowa weryfikacja tej operacji — 27.10.2026

Zarządzany przyrostowy build zakończył się succeeded: operacja
33ef2755a79347249532ffa86dd8c957, bazowy commit
78136fb8feb0f57014d10cf171a1cec83ef55f62, snapshot
4bebea9124ee772f7c624c8b02444ea4bce60c3ee0d12d5efbed83c195ad8252.
Wszystkie sześć przejrzanych źródeł odpowiada wejściom kompilatora. API i runtime
są ready, zainstalowany dowód terminal observation odpowiada nowemu pakietowi.
Scena i tożsamość bieżącego historycznego runu pozostały bez zmian.

Natywna regresja native-preview-02 przeszła: dwa prawidłowe preview i siedem
odmów z kontrolą dokładnych przyczyn. 1391 oryginalnych plików runu i bundle
pozostały identyczne. SHA przypiętego żądania pozostał taki sam jak w próbie01.
Apply-02 zakończył się exit0 w 20,250 s, bez uruchomienia solvera. Utworzył
recovered-solution-82e8f2e82ae2989cdd17519be89552b34085aa792e9d47b46285797bd9a1687a,
revision1, member-3b95b7b2e4db7105c0882033765b478eee4060e53896a127af2130f793d2620f.
Manifest jest Closed/Failed/Unassessed, ma 11 artefaktów, w tym trzy tensory,
trzy materialized datasets, trzy owned geometries, źródłowy bundle i dowód
odzyskania. Nie zmieniono Failed w task ani nie nadano kwalifikacji bazy.

Publiczne API persistence udostępniło discovery, przypięty manifest, member,
artefakty, trzy datasety oraz kompletne wycinki FMDS:

| Quantity | Jednostka | Liczba próbek | Składowe | Bajty wartości |
|---|---|---:|---:|---:|
| V_electric | V | 677 | 1 | 5416 |
| J_charge | A/m² | 7424 lokalne ślady w 1856 Tet4 | 3 | 178176 |
| H_ant | A/m | 1145 węzłów Universe | 3 | 27480 |

Wartości są skończone i bitowo identyczne z odpowiednimi payloadami
v_raw, j_local_raw i h_raw oryginalnego bundle. Odczyt zachowuje jednostki,
normalizację none, pierwotną próbę i status Failed/Unassessed. Geometria każdego
quantity wróciła przez istniejące saved-field-geometry oraz binarne topology
FMMT i support FMSP, ze zgodnymi deklarowanymi długościami i SHA256.
H ma 1145 węzłów oraz 6428 Tet4 Global; J zachowuje lokalny nośnik, bez
uśredniania wspólnych węzłów. Trzy żądania z obcym manifestem odmówiły409.

Pierwsze dwa kontrolery HTTP miały pomyłki w samych asercjach/parametrach:
range_sha256 w FMDS ma prefiks sha256:, a support ma osobny limit1MiB.
Zachowano te dowody w http-02/ i http-03/; poprawiono tylko kontroler.
Końcowy verify_saved_http_04.py i http-04/field-report.json przeszły bez
kolejnej zmiany źródeł aplikacji. Nie maskowano błędu produktu.

Replay-02 zakończył się exit0 w 31,791 s i zwrócił identyczny graf wyniku.
Dwa pliki katalogu SolutionSet i 1391 oryginalnych plików runu są identyczne,
revision nadal1. Scena i current session pozostały takie same. To potwierdza
idempotencję opublikowania, nie ponowne wykonanie obliczeń. Wszystkie dowody
znajdują się w tym samym kontrolnym wolumenie grupy, katalogu niniejszej operacji.

Pozostaje NOT VERIFIED: rzeczywista wizualizacja WebGL, niezależna kwalifikacja
fizyczna tego obwodu, baza na amper i konsument LLG/FFT. Odzysk danych nie
włącza żadnej z tych funkcji. Nie kompilowano ani nie uruchamiano testów Rust.
Historia i wyniki poprzednich prób pozostają zachowane; nie wykonano prune.
