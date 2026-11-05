# ADR 0077: pojedyncza symulacja sterowana terminalem

Status: przyjęte dla implementacji; kwalifikacja runtime pozostaje osobnym dowodem.

## Kontekst

Użytkownik chce uruchamiać edytowalny skrypt jednym poleceniem, widzieć logi
budowania i obliczeń, oglądać opcjonalne UI oraz zamykać własne uruchomienie
przez Ctrl+C. Dotychczasowe `docker-dev` pozostaje trwałą grupą po zakończeniu
polecenia, a dawne `fullmag` wybierało inne ścieżki wykonania.

## Decyzja

Publiczny kontrakt to `just fullmag [gui|headless] <źródła> <skrypt.py>`.
Brak prefiksu oznacza GUI. Źródła wybierają zarejestrowany checkout `master`,
worktree lub lokalny branch. Lokalny branch bez checkoutu otrzymuje
zarejestrowany, przypięty do commita detached worktree. Nie ma automatycznego
fetch, przełączania cudzych gałęzi ani zmiany fizyki skryptu.

Konsola używa istniejącego Docker DEV i jego resolvera oraz dokładnie tej
grupy Compose, która należy do wybranych źródeł. Tryb GUI uruchamia obie usługi;
headless tworzy zdefiniowaną parę, pozostawiając frontend zatrzymany. Pole
`ui_mode` w receipcie rozróżnia celowy headless od awarii frontendu.
Jedna konsola otrzymuje losową tożsamość `console_session_id`, wiązaną z
operacjami oraz pełnymi ID i StartedAt usług. Aktywna istniejąca grupa blokuje
przejęcie przez kolejną konsolę.

Po zakończeniu obliczeń konsola i GUI czekają na operatora. Ctrl+C zatrzymuje
przyjęty run z dokładnymi pinami API/session/run/epoch, czeka na stan terminalny,
a następnie wykonuje istniejący native drain i zatrzymuje obie usługi.
Podczas aktywacji sygnał jest zapamiętywany do czasu poznania przyjętego runu;
POST nie jest przerywany ani ponawiany. Podczas dependency BuildKit konsola
czeka na zamknięcie bieżącej zarządzanej operacji. Podczas kompilacji aplikacji
może zatrzymać dokładnego supervisora tylko po zamrożeniu i potwierdzeniu,
że runtime jeszcze nie wystartował. Niepotwierdzony wynik wymaga recovery;
nie usuwa się ownerów, lease ani danych. Wyniki i wolumeny są zachowywane.

## Zgodność i granice

Kanoniczny Python DSL, ProblemIR, planowanie CPU/GPU oraz API v2 nie zmieniają
się. `headless` dotyczy usługi frontend, a nie fizyki ani wyboru urządzenia.
Dawna recepta pozostaje prywatnym `fullmag-reference` wyłącznie dla istniejących
jawnych kwalifikacji naukowych. Jej właścicielem jest ścieżka qualification;
można ją usunąć po migracji ostatniego jawnego konsumenta, zachowując wymagane
dowody tych kwalifikacji. Nie jest publiczną alternatywą codziennego DEV.

Historyczne grupy z niezamkniętą mutacją wymagają swojej procedury recovery.
Konsola nie resetuje ich automatycznie i nie tworzy zastępczej grupy.

## Implementacja i weryfikacja

Recepta i zamknięty parser shell przekazują literalne argumenty do
`fullmag_console.py`; `fullmag_console_runtime.py` zarządza obserwacją i
zamykaniem. Istniejące moduły `docker_dev_up`, `docker_volume_dev`,
`docker_dev_defaults`, `docker_volume_activate` i `docker_dev_run_script`
obsługują jawny headless. `docker_build_control` zapisuje tożsamość konsoli
oraz blokuje następną mutację po żądaniu przerwania startu.

Regresje obejmują rzeczywistą granicę `just`/shell, selektory źródeł, tryby,
receipty, run cancellation i wyścigi start/stop. Testy źródeł i CI są odrębne
od runtime Docker, browser/WebGL i kwalifikacji naukowej. Wycofanie publicznej
recepty nie usuwa wyników ani nie zezwala na replay nieznanej operacji.
