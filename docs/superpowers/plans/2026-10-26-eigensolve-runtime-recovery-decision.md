# Ponowienie obliczeń eigensolve — decyzja po odmowie preflightu

Stan: 26.10.2026. Użytkownik wybrał wariant B: naprawa uzgadniania w obecnym worktree. To checkpoint implementacji i blokady wykonania, nie kwalifikacja solvera.

## Kod i wykonanie

Branch: `codex/eigensolve-integration-ui-20261026`.

Kod numeryczny i integracyjny zapisany oraz wypchnięty w `2f99894c54bc6745bc9353634dd06487a106cc51`. Zbudowany runtime ma ten commit oraz snapshot `dd4c5627c95ef8415256d3c1fdcaf81c706e3f83a9c7a924cf56b8a09070473f` (dirty: lokalny harness weryfikacji UI). Managed build `a88722cf8121416b91c0666c119f68c2` zakończył się sukcesem. Make: 274389 ms; pakiet i bramki startu przeszły. UI/API: port 3217.

W tej iteracji dodano jawny DAG Relax→Eigen, typowany CAS certyfikatu równowagi, niezależny ścisły replay przed publikacją i konsumpcją, przekazanie certyfikatu runnerowi oraz deterministyczny zapis map metadanych siatki. Kontrole raw/framed SHA i zgodności planu nie zostały obniżone.

CI źródeł: 1817 testów runnera przeszło, 0 niepowodzeń, 1 ignored. Kontrole UI, odbiorników dyspersji i kontraktów przeszły. Bootstrap przeszedł etap `cargo test -p fullmag-ir`, obejmujący nowy test 32 odtworzeń bajtów planu z wieloma domenami i obiektami. Pełny bootstrap `40352367030` zakończył się success. Niezależna dokumentacja nie przechodzi checkoutu niedostępnego commita zewnętrznego submodułu; to osobna bramka integracji.

## Rzeczywiste próby

| Run | Wynik | Częstotliwość / pole modu |
| --- | --- | --- |
| `run-live-4cd7393582b224ab05d2bedb9b336fe35815f2f00c09f15f7186922c89c9817c` | Błąd dispatchera przed solve. Poprawka w `1b1483edb5ffacb966d4fe0cc2c72a8b06d2b214`. Run zakończony kanonicznym Stop. | Brak |
| `run-live-1847f2c8e4d2f2fe177065a6a4488f3ca4eaf2e006a6db27a2e849508fb2163d` | Natywna relaksacja completed/converged, 3 kroki, moment `2.6466332450953524e-11 A/m <= 1 A/m`. Dokładny owner run/stage. Publikacja wyniku odrzucona przy ponownej serializacji HashMap w planie. Poprawka deterministycznego zapisu w `2f99894c54bc6745bc9353634dd06487a106cc51`. | Brak eigensolve; zachowane oryginalne wyniki Relax i certyfikaty |
| `run-live-dc3488974c0dc80d00bf30e3b00d5695408dab5be1422a459875f007c46dcef5` | Zaakceptowane dwa zadania; brak preparation lease, compute lease i uruchomionego solvera. Usługa natywna zakończyła się przy admission: `host admission requires a current sample for the active compute-node owner`. | Brak |

Przyczyna ostatniego błędu nie jest jeszcze ostatecznie rozpoznana. Właściciel i epoka później odczytanego snapshotu zgadzają się; nie dowodzi to, który warunek był niespełniony podczas admission. Sam obecnie stary snapshot nie stanowi dowodu, że jego wiek spowodował pierwotny błąd.

## Dokładna blokada odzyskania

Aktywacja `3a44611704e14f56b8dea45c1547f9ab` zachowała stan `outcome-unknown-resources-retained` po HTTP 503 `accepted_preparation_runtime_failed`. Oryginalny helper trzyma własną blokadę; API jest tylko diagnostyczne.

Zarządzany `stop-diagnostic-volume --pending-activation ...` został uruchomiony i **odmówił przed zatrzymaniem lub zmianą danych**: `active or unknown resource lease`.

Historyczny worker z runu `1847…` ma:

- task `task-d1f206ffa2c39bf085d2f88217bf9b811671b2cce9419d2134e2d4dcd187476a`;
- attempt `attempt-617267a981944687a74929095bd0da07`, ownership epoch 1;
- lease `lease-ad1b7669c0c247f3b012afcc3a19b279`, heartbeat 2, lokalnie nadal `active`;
- rezerwację hosta `quarantined` oraz `consumed` launch gate;
- zapisane wyjście procesu i artefakty; task `failed`;
- brak odpowiadającego normalnego release proof.

Budżet tej rezerwacji: 6000 CPU millis, 24964497408 B RAM, 7516192768 B storage, 0 GPU. Kwarantanna nie oznacza zwolnionej rezerwacji. Nie wolno przedstawiać jej jako zasobów wolnych ani ręcznie oznaczyć `released`.

Istniejący release wymaga lokalnego lease Released. Orphan teardown wymaga braku exit receipt i nie pasuje do tego przypadku. Anulowanie zadania nie pasuje do historycznego Failed workera. To brakujący przypadek uzgodnienia supervisora po błędzie publikacji wyników.

Obserwowane inne grupy Fullmaga mają osobne wolumeny ledgerów. Nie stwierdzono współdzielenia tej rezerwacji z innym worktree. Nie zatrzymywano innych grup.

## Dwa możliwe dalsze kroki

### A — osobny izolowany worktree do obliczeń (wariant niewybrany)

Proponowany nowy zarejestrowany checkout: `worktrees/eigensolve-numeric-ui-20261026`, branch `codex/eigensolve-numeric-ui-20261026`, z końcowego checkpointu obecnego brancha. Uruchomienie tylko przez jego własną grupę Docker Compose, własny stan sesji i ledger. Najpierw ten sam pilot DE +10, następnie zapisany sweep 15 punktów −25…+25 i rzeczywisty mod w UI.

Zachowujemy dotychczasowe worktree, diagnostyczny runtime, kwarantannę, aktywne receipty i wyniki. To świadomy wyjątek od reguły jednego worktree dla zadania; nowy build będzie miał własny koszt i nie daje gwarancji, że inne błędy wykonania nie wystąpią. Nie jest to naprawa starego ledgera ani ukończenie integracji na master.

### B — najpierw naprawa uzgadniania zakończonego workera (wybrane)

Potrzebny jest odrębny, testowany kontrakt supervisora/maintenance: exact failed task + claim/attempt/epoch + authoritative process-exit receipt + dokładna lokalna aktywna lease + dokładna quarantined reservation. Po potwierdzeniu zakończenia procesu zamknąć lease i wygenerować istniejący normalny release proof przez właściciela protokołu, bez kwalifikowania artefaktów lub ponownego solve. Obsłużyć częściowe publikacje i idempotentne wznowienie.

Wymaga to testów negatywnych dla wszystkich tożsamości i granic publikacji, review oraz zarządzanej ścieżki maintenance tej samej grupy. Dopiero później można odtworzyć usługę i ponowić obliczenia. Natywny protokół i CLI są zaimplementowane w `7658c1d2753b4cbbd7a8f8dcf4446756fe0ce079`; poprawka przyczyny i test awarii drugiej fazy w `6337f20075bfc1952d0c564623e0d43e9288e4a8`. Zarządzany wrapper jest w weryfikacji przed wykonaniem. Nie zastępuje go ręczny zapis JSON lub pominięcie preflightu.

## Niezależne prace

Referencja analityczna DE dla 101 punktów od −25 do +25 rad/µm jest przeliczona; +10: coupled thickness N=8 około 11.228266 GHz. To REFERENCE ONLY, nie wynik FEM. Scenariusz `examples/fem_eigen_mode_ui_de_signed15.py` jest zapisany na remote, ale nie został jeszcze wykonany. Harness `scripts/verify_eigen_mode_ui.mjs` wymaga teraz pobrania pola zespolonego z dokładnym field/generation/session scope, zgodnych nagłówków FMVP i markeru gotowości kontrolera po dekodowaniu. Niezależnie sprawdza canvas/WebGL. `node --check` oraz `--help` przeszły; pozytywny browser/runtime pozostaje NOT VERIFIED.

## Kontrakt wdrażanej procedury B

- `reconcile-failed-worker` działa w istniejącym backendzie i pod nadal trzymaną blokadą pierwotnej aktywacji. Wymaga przypięcia udanej iteracji, pełnego kontenera i jego czasu startu, źródeł, konfiguracji, ownera Failed, task/attempt/epoch, exit receipt, lease i rezerwacji hosta.
- Domyślny preview nie zmienia sesji ani ledgera. `--prepare-candidate` buduje osobny pakiet w `/build/maintenance/<UUID>/package` kanoniczną receptą tego samego backendu, korzystając ze wspólnego cache `/build`. Natywny preview waliduje kontrakt bez release. Pakiet nie zastępuje aktywnego pakietu i nie uruchamia API, schedulera ani Solve.
- `--apply` wykorzystuje ten sam UUID, niezmienny request i dokładny przygotowany pakiet. Przed wykonaniem sprawdza cały inventory pakietu oraz SHA rzeczywistych bajtów runtime-service; wykonuje otwarty, zweryfikowany deskryptor pliku. Ponowne użycie UUID dla innego run/task/receipt/iteration jest odrzucane.
- Release ma dwie fazy, nie jest atomową transakcją dwóch magazynów: pod blokadami waliduje wszystkie normalne warunki i zwalnia lokalny lease, następnie istniejący `release_worker_after_exit` publikuje normalny proof i zwalnia host reservation. Awaria drugiej fazy zachowuje host Quarantined; dokładne wznowienie kończy protokół. Test wymusza tę awarię I/O i sprawdza brak zmiany katalogu oraz zachowanie oryginalnego release timestamp.
- Surowy digest lease obowiązuje dla początkowego Active. Replay po prawdziwym lokalnym release wymaga pełnej zgodności semantycznej poza stanem i timestampem release. Nie dopisuje fikcyjnego proof.
- Błąd po wywołaniu natywnej procedury pozostaje outcome-unknown; nie wolno wnioskować o braku mutacji. Trzeba zachować request i zbadać oba magazyny przed ponowieniem. Końcowy raw-check katalogu może zgłosić błąd również po faktycznym release.
- Failed pozostaje Failed, artefakty nie są rekwalifikowane, solver nie jest powtarzany. Dopiero potwierdzony normalny proof pozwala użyć istniejącego diagnostic stop, zachowującej historię archiwizacji i zwykłego restartu tej grupy.

Poprawka prewencyjna: Failed/Cancelled/Interrupted bez SolutionSet nie przechodzą ponownej walidacji poprawności zakończonego rozwiązania, która wcześniej blokowała sprzątanie po utrwaleniu Failed. Nadal obowiązuje walidacja udanego rozwiązania i istniejącego SolutionSet. Scheduler rozpoznaje niewygaszony lease po dokładnym exit receipt, niezależnie od terminalnego lifecycle.

Review wrappera wykryło i skorygowało kontrolę samego deklarowanego SHA zamiast binarnych bajtów oraz niepełny scope replay sukcesu. Rzeczywisty preview ujawnił też błędny budżet 16 MiB dla dokumentów control (właściwy limit pozostaje 8 MiB), alias mountu WSL oraz krótkie ID z `docker ps`; poprawki nie obniżają kontroli tożsamości.

Dodatkowe rozszerzenie na skanowanie lease'ów całego tasku zostało odrzucone przez automatyczną kontrolę uprawnień i nie zostało zastosowane. Obowiązuje węższy kontrakt konkretnego potwierdzonego exit receipt.

Status podczas pierwotnego checkpointu: bez nowego punktu FEM i bez pola modu. 61 lekkich testów Pythona przeszło; testy kompilowane Rust wyłącznie w GitHub Actions. Wynik rzeczywistego native preview/apply i restartu należy dopisać po wykonaniu, a nie na podstawie samych testów źródeł.


## Rzeczywiste wykonanie maintenance i ujawniona granica pochodzenia

Checkpoint wrappera: `a6dcd4db3c21c1ec458c09b83958df04bd7124e2`, wypchnięty na PR #262.
Zarządzany preview przeszedł, a izolowany pakiet został zbudowany w tej samej
grupie. Candidate receipt SHA: `5303fc0297e71504d06887301be8b350818b490f9fa383e94fef635738b2fce1`;
source snapshot: `be753e4d9209e2ef476e27649db42aee2f5b069e9ccb2ac3403e1e82b2b69a29`.
Operacja `a744cb36-c8a0-4ca6-bb30-e1b0c50e32bc` zakończyła natywny preview
odmową `compiled source commit differs from runtime provenance`. Nie wywołano
`--apply`. Konserwatywny prepare receipt zachował outcome-unknown; oddzielny
odczyt potwierdził niezmienione raw SHA katalogu, lease i exit receipt, lokalne
Active, host Quarantined, brak proof oraz zachowane 14 artifact IDs. API nadal
raportuje waiting_for_compute / disconnected / commandability forbidden.

Przyczyna: normalna delegacja storage dopuszcza bieżący executable wyłącznie
z kanonicznego runtime/provenance. Osobny nowy pakiet maintenance ma inny
commit i binarne SHA. Sam pomyślny build nie rozwiązuje tego kontraktu.

Wdrażana korekta to jawny typ `FailedWorkerMaintenanceStorageAdmission`.
Nie jest globalną flagą pominięcia kontroli. Wiąże konkretny root magazynu,
UUID operacji, Failed owner, dokładny request uzgodnienia oraz niezmienny
candidate receipt. Zachowuje wszystkie kontrole profilu linux-native-v1
(host, engine, image, filesystem, owner, sentinele, probe i namespace).
Osobno potwierdza historyczny kanoniczny runtime względem ownera oraz nowy
executable względem compiled commit/snapshot i rzeczywistych hashy inventory
kandydata. Dowód jest przekazywany tylko do dwóch metod Failed-worker;
normalne store identity oraz pozostałe release/admission pozostają ścisłe.
Nie zmienia kanonicznego pakietu ani provenance. Inne profile storage nie
otrzymują automatycznego cross-build fallbacku.

Kolejne bramki: negatywne testy tożsamości i plików w CI, review granicy
admission, nowy izolowany candidate i native preview, dopiero potem exact
apply i zwykły diagnostic stop/recreate. Pierwsza odmówiona operacja pozostaje
w historii; nowa poprawiona kapsuła otrzyma osobny UUID. Mod i nowe punkty FEM
pozostają NOT VERIFIED do rzeczywistego Solve oraz pobrania pola w UI.
