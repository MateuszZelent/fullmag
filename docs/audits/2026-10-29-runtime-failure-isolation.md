# Izolacja błędów runtime — dalsza realizacja celu, 29.10.2026

## Zakres i stan odbioru

Celem pozostaje: błąd zadania kończy zadanie, konflikt writera odracza pracę,
awaria runtime blokuje nowe obliczenia przy dostępnym API/diagnostyce/wynikach.
Nie wolno automatycznie ponawiać Solve ani restartować backendu. Komunikat ma
wskazywać etap, przyczynę, stan zadania i możliwe dalsze działanie.

Praca na lokalnym `master`, bazowy HEAD
`b2b159c58fb921efbf278c120d12d268d958d03b`, bez worktree i testów.
Zachowano obce dirty pliki oraz wcześniej ukończony CoFeB. Odbiór poprzedniego
uruchomienia i stan bieżącej przebudowy są odrębnymi dowodami.

## Bieżąca przebudowa — blokada konfiguracji zasobów

Próba `7e0b39179f574e778e8cd7aebf5f70a3` zbudowała aplikację w backendzie
`fullmag-master`: make exit0, 215,979 s, tryb `cuda-fem-gpu`, snapshot
`dbe0b3f2e6ae4a5bca5a648cacc00a09501598fb71e98d69c16961b3e644b36e`.
Natywny startup następnie odmówił: nowy Compose użył domyślnych 32 GiB/8 CPU,
a zachowany ledger grupy nadal deklaruje wcześniejszy budżet 128 GiB/16 CPU.
To nie awaria siatki ani ponowne wykonanie Solve.

API pozostało uruchomione: health zwraca HTTP200/degraded, current/status
HTTP503/runtime_unavailable, bez aktywnej sesji. Backend nie zakończył się po
tym błędzie. Nowy owner ani schedulery nie zostały uruchomione; zapisane
OWNER/process-tree nadal odpowiadają autentycznemu wcześniejszemu Drained.

Zarządzane zwiększenie `8108c77ad5a84e17a25d50888fc63cf3` zachowało profil
128 GiB/16 CPU w prywatnym namespace grupy. Receipt SHA256:
`5920d03474e1a711a806eb76336b636a82a5ae26cb8aad3ffc98ab9396177cd1`.
Kernelowe limity obecnego kontenera już są poprawne, lecz jego niezmienny
environment nadal zawiera 32/8. Potrzebne jest odtworzenie usługi z zapisanym
profilem; zwykły restart ani samo zwiększenie limitów kontenera nie zmienią
environment. Nie zmieniano globalnego `.env`, polityki ledgera ani danych runu.

Przygotowano osobną ścieżkę zatrzymania wyłącznie cold diagnostic API:
wiąże bieżący kontener, źródła, startup failure, brak procesów solvera,
zwolnione lease, inode OWNER.lock i zachowane katalogi z autentycznym
wcześniejszym drain. Jej journal jawnie zapisuje `native_drain_performed=false`.
Nie udaje nowego nativeDrained ani uprawnienia do replay. Podglądy ujawniły
niezgodne założenia o polach failed receiptu, formacie native OWNER i argumentach
entrypointu; poprawiono czytniki bez przepisywania tych danych. Wykonanie
stop/recreate i ponowny odbiór pozostają w toku.

## Poprawiony odbiór Completed i aktualny runtime

Development `80088b44d21c497199550c8857ed14c6` zakończył się succeeded,
Compose SHA256 `7e370a5ec8a4ce75de76826247470820fa593ca57f0696c9b6e12db1bbc72369`.
Backend `4bad825625c0ada691a8bb2eb54536867294a4a188c1f0f87a3fbd073d042059`
ma Docker i native environment zgodne z 128 GiB/16 CPU. Health HTTP200/ok,
runtime-service Ready; obraz `sha256:85d508e510da7f209f550e8209ac033307a57794eae47ed88e963f702e1cf12f`.

Poprzednia próba `f16c1cd4b19f4d7cadef35aaaeb0673f` ujawniła pozostawione
literalne `failed` w Pythonowym odbiorze installed receipt i readbacku.
Rust poprawnie zainstalował Completed, lecz nadzorca odmawiał admission.
Czytnik bierze teraz status wyłącznie z publicznego preflightu wskazanego
przez niezmienny proof i jego raw SHA256. Dopuszcza failed/completed,
nadal porównując pełny installed receipt i bieżącą tożsamość API/runu.
API zachowało ten rzeczywisty błąd diagnostycznie, zamiast kończyć proces.

Explicit stop-only `14c18bb027364c53a8712dba441052e9` wykonał prawdziwy native
drain Ready ownera po sprawdzeniu tego dokładnego błędu, Completed, pustego
inventory zadań aktywnych, zwolnionych leases i braku procesów workerów.
Kod kontenera 1 zachował pierwotny błąd nadzorcy; obaj schedulery zakończyli
się poprawnie i native Drained pozostał obowiązkowy. Osobny CAS-pinned
preflight, archived process-before i konsument wiążą nowy drain z historycznym
source proof, nie utożsamiając obu stopów. Recreate `99a5667efc064510adcfa9c1e0352785`
i powyższy zdrowy development potwierdziły wykonanie tej ścieżki.

**Ograniczenie:** terminal-observation odtwarza obecnie terminalny model/status,
bez `fem_mesh`, `live_state` i `latest_fields`. GET domeny pozostaje unmaterialized,
a m/meta zwraca 404; sam Completed nie dowodzi wizualizacji odzyskanych wyników.
Po zachowaniu starego runu uruchomiono istniejący retirement→activate-script
z nowym requestem `cofeb-master-gpu-20261029-visualization-04`. Jest to nowa,
jawnie zlecona próba z tego samego skryptu; nie ponawia starego Solve.
Nowa próba zakończyła 10 iteracji; mesh, binarne m/H_demag/H_eff i render zostały
odebrane. [Bieżący wynik i dowody](2026-10-29-cofeb-master-current-build.md).

## Potwierdzone luki i przygotowane poprawki

### Odczyt wyniku po błędzie workera

W `accepted_scheduler_main.rs` zakończony worker był usuwany z mapy, a
`task_outcome_settled(...)?` odczytywał RunCatalog i aktywny lease. Wyczerpanie
pięciosekundowego retry `StoreWriterBusy` propagowało się do `main`, kończąc
scheduler z exit 1. Analogiczny problem występował po odzyskaniu procesu
workera z istniejącym exit receiptem. To odrębna ścieżka od admission deferral.

Nowy `PendingTaskOutcome` zachowuje run/task/resource/attempt/epoch i oryginalny
błąd. W kolejnych przebiegach pętli ponawiane są wyłącznie dwa one-shot odczyty.
Nie ma ponownego supervisor/admission/spawn/Start. Pending blokuje odpowiedni
run i zasób, nadal pozwala obsługiwać pozostałe zakończone workery i uniemożliwia
fałszywe `drained`. Potwierdzony settled usuwa rekord i publikuje błąd zadania;
hard error albo niepotwierdzony wynik zachowuje dotychczasowy fail-stop.

Preparation ma już oddzielne typed `TerminalPreparationFinalizationPending` i
`pending_checkpoint`; nie zmieniano tych ścieżek ani pre-spawn `WorkerLaunchDeferred`.

### Komunikat i przejście do diagnostyki

`WorkspaceShellClient.tsx` rozdziela teraz komunikat o błędzie zadania od
banera awarii usługi. Dla bieżącego failed/error runu pobiera istniejący zasób
StageExecution, sprawdza jego `ready` i zgodność run ID oraz korzysta z walidacji
session/request identity w resource hooku. Pokazuje etap,
`state_transition_reason`, stan zadania i dalsze działanie. Brak danych jest
opisany jawnie; nie przypisuje przyczyny z innego runu.

Przyciski otwierają istniejące panele Engine i Operations przez kernel layout,
zamykając zasłaniający je Home overlay. Nie wysyłają komend solvera. Home bez
workspace podaje miejsce logu kontenera zamiast przycisku do nieistniejącego
docka. Nie dodano endpointów, store, obliczeń w UI ani automatycznego retry.

Etap i przyczyna live Accepted Study były już obecne w typed API:
`live_accepted_projection` przypisuje `state_transition_reason` z dopasowanego
dziennika zadania. Wcześniejsza hipoteza, że brakuje tego pola w live API, była
zbyt szeroka. Historyczne `ProjectRunTaskResource` nadal nie zawiera takiej
diagnostyki — nie należy utożsamiać tych dwóch kontraktów.

## Weryfikacja i granice dowodu

- Obydwie delty przeszły niezależne review źródłowe bez P1/P2.
- Parser Rust (`rustfmt --emit stdout`, bez zapisu źródła) oraz `git diff --check`
  przeszły. Nie jest to sprawdzenie typów Rust ani build.
- Typecheck, ESLint zmienionego pliku i architecture-hygiene przeszły w istniejącej
  usłudze frontend `fullmag-master`. Receipt r6:
  `verification/runtime-feedback-20261029-r6/receipt.json` w wolumenie kontrolnym.
  Wcześniejszy r2 wykrył błędne użycie opakowania zasobu zamiast `data`;
  poprawiono je przed r3. R1 dotyczył wyłącznie przycisków. Nie uruchamiano testów.
- Historyczny receipt innej grupy, build `f19e5863d5f5d3a4cebe47e6c6c97e37b4fa5aea`,
  potwierdza `failed_outcome_retained` i `api_diagnostic_only=true`. Dowodzi
  istniejącej ścieżki zachowania API, nie nowego PendingTaskOutcome.
- Istniejący PR330/commit `d9400cd7c74c247e9e37a9a126bf90077accee21` ma osobne
  dowody CI dla compute-sample/prelaunch deferral. Nie uruchamiano tych testów
  tutaj; nie obejmują nowej ścieżki odczytu wyniku po join.

## Zachowanie CoFeB przed przebudową

[Odbiór CoFeB i pól](2026-10-29-cofeb-master-runtime-result.md) pozostaje ważny
dla przypiętego tam buildu. Run
`run-live-f83f7552cf05f87b1eeb213f88de34fbf9202abcbf918bfa8634bb8f17db68c1`
jest Completed po 10 iteracjach. Z istniejącego binarium wykonano wyłącznie
read-only `service-inspect-terminal-run`, który potwierdził:

- native config SHA256 `4bfee3acb8bcec75b46cd2f1a98b913acbeb032f7bc956ed8ddcf56a4e0e0f5e`;
- terminal evidence SHA256 `88ffe5c5ad1dbf345bc527791779476ed07b65b736e0d392da62ebf0b45f889c`;
- `mutations_applied=false`, `solve_replayed=false`.

Prywatny producer/reader terminal-observation przyjmował wyłącznie Failed,
choć natywna bramka potrafi sprawdzić Completed. Przed restartem potrzebna jest
zgodna obsługa ukończonej obserwacji: zgodny preflight Completed i katalog
złożony wyłącznie z Succeeded, przy zachowaniu wszystkich digestów, claims,
lease/drain i natywnego terminal fence. Sam stan Completed nie kwalifikuje pól
ani poprawności naukowej; odbiór danych i renderu pozostaje osobny.

## Wykonane wdrożenie i granice weryfikacji

1. Zapisany profil 128 GiB/16 CPU obejmuje Docker limits, native environment
   i Cargo jobs. Obecna grupa jest zdrowa, bez automatycznego restartu.
2. Typed writer-busy podczas odczytu wyniku zakończonego workera jest odraczany
   bez ponownego spawn/Start. Nowy kod zbudowano i wdrożono; celowo nie
   wymuszano konfliktu blokady ani błędu workera. Ta konkretna gałąź runtime
   pozostaje **NOT VERIFIED**, zgodnie z ograniczeniem bez testów.
3. Rzeczywiste błędy host policy i odbioru terminalnego receipt pozostawiły
   działające API diagnostyczne, zachowany run i zamknięte admission.
4. Błąd zadania ma osobny komunikat etapu/przyczyny/stanu oraz odsyłacze do
   Engine/Operations; Home rozróżnia niedostępny runtime i utratę połączenia.
   Typecheck/ESLint/architecture r6 przeszły. Nie pozorowano awarii w UI.
5. Aktualny nowy run przeszedł materializację, mesh i 10 iteracji GPU. Wszystkie
   trzy pola mają source_step10 i complete/stale=0; m odpowiada native GPU.
   Obejrzano rzeczywisty PNG/WebGL bez utraty kontekstu. Stary catalog pozostał
   bajtowo niezmieniony. Retencja e9b964df046b46e1bdc3058186b1094e succeeded.

Scoped react-doctor nie rozpoznał Git w cieniu frontendu i wykonał pełny scan;
exit1 pochodzi z diagnostyki całego istniejącego projektu. Nie znaleziono
w tym logu diagnoz dla zmienionego WorkspaceShellClient. Nie traktujemy tego
jako zielonego scanu całego projektu ani nie poprawialiśmy niepowiązanych plików.

Odtwarzanie mesh/pól po restarcie, niespójność scalar Step0/step10 i profilowanie
dużych wejść pozostają osobnymi punktami w bieżącym raporcie CoFeB. Nie
maskowano tych ograniczeń numerem kroku ani danymi zastępczymi.
