# Instalator Windows: wszystkie backendy

## Cel i decyzja użytkownika

Jednorazowy `fullmag.exe` przygotowuje środowisko budowy i wspólny pakiet Fullmaga z obsługą FDM CPU, FDM GPU, FEM CPU oraz FEM GPU. Nie zawiera wyboru backendu instalacji. Backend i urządzenie są wybierane dla każdej symulacji w aplikacji; zmiana nie wymaga ponownej instalacji. Instalator zachowuje konfigurację `.env`, licencję i interfejs Avalonia/Fluent.

`native` opisuje sposób uruchomienia w Windows i nie jest nazwą backendu. Prywatny zakres instalatora `all` nie rozszerza publicznego DSL ani słownika planera.

## Implementacja

1. Usunąć selektor z interfejsu i wymagać potwierdzenia pełnego zakresu we wszystkich odpowiedziach brokera.
2. Zbudować jeden fizyczny pakiet `windows-native-fem-gpu`, zawierający kod czterech realizacji. Opublikować osobny agregat `windows-full-runtime/build-manifest.json` z czterema dowodami komponentów oraz powiązaniem ze źródłowym manifestem i artefaktami.
3. Dodać zamknięte recepty `windows-full-workspace-build` i `windows-full-workspace`, z lease, preflightem oraz terminalnym receiptem. Uruchamiać workspace z backend/device `auto`, bez narzucania trybu pojedynczej symulacji. `ExpectedBuildId` przypina SHA agregatu.
4. Dostosować workflow instalatora i BA do wspólnego pakietu. Starszy receipt pojedynczego backendu nie potwierdza gotowości całej instalacji.
5. Zweryfikować nowy EXE, rzeczywisty GUI, bezpieczny podgląd/zapis `.env`, uruchomienie workspace i symulację FEM GPU; wykonać review i cykl integracji zadania.

## Kryteria dowodowe

- Interpretowane kontrole pozytywne i negatywne walidują manifesty, hashe, receipty i odrzucenie niepełnej instalacji. Nie kompilować testów jednostkowych bez osobnego zezwolenia.
- Sukces kompilacji potwierdza pakiet, lecz nie kwalifikuje wykonania fizyki. Installed support, dostępność sprzętu GPU i wynik runtime są oddzielnymi faktami.
- Wymuszone GPU bez zgodnego sprzętu kończy się jawnym błędem, bez cichego przejścia na CPU.
- Dowód GUI obejmuje licencję, brak selektora backendu, widoczny podgląd zmian `.env`, zachowanie sekretów i poprawny etap Ready. Dowód przeglądarki obejmuje widoczny canvas, zachowany WebGL i niezerowy drawing buffer.

## Bieżący checkpoint

2026-10-15: usunięcie selektora, kontrola źródeł UI, pięć interpretowanych kontroli pełnego manifestu na Windows oraz natywna kontrola receiptu v2 przeszły. Native FEM build attempt `9357f523c3da47dc840454990f34779d` skompilował cały produkt C++/CUDA/Rust i przeszedł weryfikację wejść kompilatora. Zatrzymał się przy pakowaniu: walidator receiptu Boost był załadowany tylko w lokalnym scope wcześniejszej funkcji. Poprawkę zakresu potwierdza pięć kontroli natywnych oraz ponowna walidacja rzeczywistego receiptu i zamrożonych źródeł. Kolejny build z nowym pełnym agregatem pozostaje wymagany. Dotychczasowy przebieg nie stanowi dowodu działania ani kompletności instalatora.

Nowy pełny pakiet, nowy EXE/GUI, runtime FEM GPU, przeglądarka i końcowa integracja: **NOT VERIFIED**. Zachować wszystkie używane cache, źródła, logi i receipty; nie usuwać danych w ramach tej zmiany.

Uwaga o weryfikacji: w starszej uruchomionej paczce regresji fixture `public_url_probe` skompilował mały harness Rust pomimo tymczasowego zakazu. Zostało to zgłoszone użytkownikowi; cała ta ścieżka jest wykluczona z kolejnych uruchomień. Wyniku tej paczki nie opisujemy jako kontroli bez kompilacji.

## Kontynuacja po review — 2026-10-15

Build instalatora z commita `389b11bd8ff88a3ef19dc30b389b049d05c19d55` doszedł do kompilatora MSVC i zakończył się błędem brakującego nagłówka `<set>`. Wcześniejszy EXE nie potwierdza nowego zakresu wszystkich backendów. Nagłówek i przekazywanie zakończenia planowania Burn na wątek UI poprawiono; 21 interpretowanych kontroli brokera przeszło.

Review wykryło też niespójne dopuszczenie skryptu z głównego checkoutu, utratę przypięcia manifestu przy `SkipLocalChanges`, niepełną walidację odzyskiwania cache narzędzi oraz brak jawnego przypięcia MPI przy wyłączonym SLEPc. Poprawki zachowują autorski skrypt i jego hash, dokładny pakiet build-to-run oraz istniejące zweryfikowane cache. Interpretowane regresje tych ścieżek przeszły; integracja MPI wymaga rzeczywistego buildu.

Workspace FEM/full wymaga własnego procesu API. Zgodny serwer FDM działający obok nie może być użyty zamiast nowego API. Instalator i nowy pełny pakiet wymagają ponownej kompilacji, dowodu GUI/Ready, przeglądarki i wykonania oryginalnego skryptu FEM GPU. Te bramki oraz integracja PR pozostają **NOT VERIFIED**.

## Dowody kompilacji i GUI — kontynuacja 2026-10-15

Instalator z zamrożonego commita `9a471b5d94713b0828b15f3ef091a4c87d946376` został zbudowany i zweryfikowany: 43 689 649 bajtów, SHA-256 `f801d2defbb0de69de0f8bc64fa17635a7bd1b9db23a22a2faa2bd3b5b676926`, poprawny PE/Burn oraz zgodne receipt i provenance. Rzeczywisty GUI potwierdził licencję, ekran ścieżek i brak selektora backendu. Regresja wykazała utratę rozróżnienia brakującej i pustej wartości `.env`; poprawkę potwierdza natywny test PowerShell, lecz nowy EXE i ponowny przebieg GUI są wymagane.

Kontrola rzeczywistych wymagań środowiska dla zakresu `all` zakończyła się wynikiem `ready`: wszystkie 19 kontroli przeszło, bez instalacji zależności i zmiany bajtów operatorowego `.env`. Naprawiono lokalny scope walidatora Boost w tej trasie.

Pełny build Windows z tego samego zamrożonego commita przeszedł konfigurację MPI, całą kompilację C++/CUDA, Cargo release (14 min 16 s) i weryfikację wejść kompilatora. Pakowanie przerwało się na rozdzieleniu ścieżki CUDA zawierającej spacje w wywołaniu planera zależności PE. Nie powstał dowód ukończenia pełnego pakietu ani wykonania FEM. Logi i cache zachowano do diagnozy oraz dalszej kompilacji przyrostowej; niczego nie usunięto.

Przyjęto aktualny lokalny i zdalnie potwierdzony `master` `5260690815131bc610450606398e951439d6f290` przez merge `f6500b6a4322cd014f0c7801d38819857805e329`. Aktualizacja obejmuje m.in. poprawki meshingu Pythona i utrwalania źródeł. Dalsza kwalifikacja musi dotyczyć zaktualizowanej gałęzi. Nowy pełny pakiet, GUI Ready, rzeczywista symulacja FEM GPU, przeglądarka i końcowa integracja nadal mają stan **NOT VERIFIED**.

## Aktualizacja dowodów: GUI i pakowanie — 2026-10-15

Instalator z zamrożonego commita `026cd841c0abd810c6c74f8d442e0a2a89a82f94` został rzeczywiście zbudowany: 43 690 065 bajtów, SHA-256 `02ec59fdb85058ccb3f30dac18100ed819a4216eb805c621bb071040eac43e8d`. Weryfikacja PE/Burn, receiptu i provenance przeszła. Rzeczywisty przebieg GUI potwierdził licencję, brak selektora backendu, podgląd brakującego `RUST_LOG` jako `<unset>` i proponowanego `debug`, redakcję sekretów oraz anulowanie bez zmiany operatorowego i testowego `.env`. Ten przebieg nie obejmował zatwierdzenia zmienionej konfiguracji ani etapu Ready.

Pełny build z tego samego commita zakończył kompilację C++/CUDA, Cargo release (18 min 32 s) oraz weryfikację wejść kompilatora. Poprawione przekazywanie ścieżek ze spacjami zadziałało. Pakowanie zatrzymało się na prawidłowym odrzuceniu sterownika `nvcuda.dll`, znalezionego podczas indeksowania szerokiego katalogu System32 używanego dla zależności MPI. Sterownik pozostaje zależnością zewnętrzną; poprawka musi ograniczyć indeksowanie bez dopuszczenia go do pakietu. Build nie potwierdza gotowości pełnego agregatu ani wykonania GPU. Logi, źródła i cache zachowano.

Commit `9c8ff5e5f3ba442971b025590e8d5386f902dfe1` dodatkowo wymaga `all_runtime_ready` przed pokazaniem Ready w trybie początkowej pełnej budowy. Zbudowany wyżej EXE nie zawiera tej poprawki; wymagany jest nowy artefakt i rzeczywisty przebieg Ready. Instrukcje dopasowano do wcześniej przyjętego ADR 0053 o natywnym Windows FEM.

Użytkownik jawnie zezwolił na CI GitHub kompilujące testy Rust/C++ dla gałęzi instalatora. Lokalny zakaz kompilowania testów pozostaje w mocy. Pełny agregat, literalne polecenie użytkownika wraz z wykonaniem oryginalnej symulacji FEM GPU z UI, dodatni licznik czasu urządzenia, GUI Ready, dowód przeglądarki i końcowa integracja nadal wymagają potwierdzenia.

## Nowy instalator i kontrola zależności — 2026-10-15

Zbudowano instalator z czystego commita `11ca04b18caa367878ac80f47d726f61c20471a1`: 43 690 093 bajty, SHA-256 `286c3639926211f6ccf6ba364b123f29567067bfaa40753d91d3b83f02657bc5`. Weryfikacja PE/Burn, receiptu i pochodzenia źródeł przeszła. Nowy EXE zawiera wymaganie `all_runtime_ready`. Rzeczywisty przebieg okien potwierdził licencję, ścieżki, brak selektora backendu oraz podgląd konfiguracji i anulowanie bez zmiany operatorowego i syntetycznego `.env`. Nadal nie jest to dowód zatwierdzenia zmienionej konfiguracji ani Ready po pełnej instalacji. Artefakt i dowody zapisano odpowiednio w `windows-installer-source-895aebd013f24d59b863b3094aacf682` i `installer-env-preview-cancel-9e2be3d2f49a4525be14db71e9716939`, pod katalogiem runów tego worktree.

Naprawiono indeksowanie zależności PE: z kanonicznego System32 dozwolony jest wyłącznie bezpośredni `msmpi.dll`; odrzucenie sterowników i katalogów SDK pozostaje aktywne. Na kopii rzeczywistych wyników kompilacji z commita `026cd841c0abd810c6c74f8d442e0a2a89a82f94` planner wybrał 14 zależności dla trzech plików produktu, w tym `fullmag_fdm.dll`. Ich inventory dokładnie odpowiada audytowanemu zestawowi 17 obrazów PE; audyt zakończył się kodem 0. Diagnostyka nie zmieniła zapieczętowanego stagingu i nie stanowi dowodu nowego pakietu ani wykonania symulacji. Dowody: `pe-closure-026-source-trace-20261015-01`.

Rzeczywiste polecenie użytkownika `just fullmag windows=True build=True dev fem gpu C:\git\fullmag\fullmag\examples\permalloy_layer_cofeb_rings_relax_300nm.py` uruchomiono na źródłach `11ca04b18caa367878ac80f47d726f61c20471a1`. Po instalacji zależności pnpm kontrola wejść kompilatora odrzuciła dowiązanie w ignorowanym `node_modules`. Build zatrzymał się przed kompilacją; poprawka tej granicy i nowy przebieg są wymagane. Log: `native-build-528582288e994990ab212ff125df0557.log`; dowody polecenia: `literal-fem-edge-cdp-3662643de8b04fae88b15133d6d01161`. Nie uruchomiono symulacji.

CI dla tego commita potwierdziło już kontrakty Windows/Linux, deterministyczność wygenerowanego API oraz testy, typowanie, lint i build Control Room. Pozostałe zadania CI trwają lub czekają. PR #173 pozostaje draft. Pełny pakiet, pozytywny Ready, runtime FEM GPU, dowód przeglądarki i integracja pozostają **NOT VERIFIED**. Zachowano źródła, logi, receipty i cache; niczego nie usunięto.

Poprawiono granicę weryfikacji po `pnpm install`: ignorowane drzewa `node_modules` są przycinane przed sprawdzaniem dowiązań, z zachowaniem szczególnego zakazu podkatalogów Tauri. Wcześniejsze 35 natywnych kontroli snapshot/compiler-inputs oraz trzy natywne regresje końcowej granicy pnpm/Tauri przeszły. Pełna natywna weryfikacja rzeczywistego snapshotu `18a28ea4de236774a9274aef91bce9c4cba9e1a9e92ef11bd29c3da3a2bacb5c`, który wcześniej zatrzymał build, także przeszła bez zmiany rekordu. Niezależne review końcowej poprawki nie wykazało dalszego blokera. Nowy EXE i build produktu z poprawką pozostają wymagane.

Natywne interpretowane testy edytora `.env` i embedded helper potwierdziły rzeczywisty zapis syntetycznej konfiguracji, zachowanie komentarzy, obcych kluczy i sekretów, backup, anulowanie, konflikty i ochronę ścieżek. Guardy setup zakończyły się wynikiem trzy PASS i jeden SKIP zależny od istniejącej konfiguracji storage hosta. Poprawiony istniejący test pre-admission przeszedł po dopasowaniu fixture do wymaganego zakresu `all`, zachowując odrzucenie starego separatora i brak zapisu przed admission. Te kontrole nie zastępują pozytywnego Ready po pełnym buildzie.

### Pełna rodzina runtime i wybór desktop CRT — 15.10.2026

- Native FEM/CUDA oraz Cargo release dla `68f03e297adca28995646863577020c3926e12cb` skompilowały produkt. Pakowanie zatrzymał niepoprawny wybór `onecore/x86/vcruntime140.dll` z całego `VCToolsRedistDir`. Nie był to dowód uruchomienia UI ani GPU.
- Staging wybiera teraz wyłącznie desktop `x64/Microsoft.VC143.CRT`. Rzeczywisty statyczny PE closure dla artefaktów tego buildu przeszedł: 12 EXE oraz FEM/FDM i zależności, łącznie 27 obrazów. Dowody: `storage/runs/fem-script-launch-20261013-50f3956723fcec2d/diagnostic/`. To nie kwalifikuje ładowania DLL, ABI ani obliczeń.
- Browser AllBackends stage i manifest obejmują kanoniczną rodzinę `runtime_bundle.BINARY_NAMES` poza desktop UI. Ponowne użycie pakietu oraz Python readiness/handoff sprawdzają pełny zbiór i hashe audytowanych EXE/DLL w stagingu i katalogu uruchomienia. Inventory pochodzi z zamrożonych źródeł.
- Interpretowane regresje Windows: package/launcher 4 PASS, 1 SKIP (opcjonalny reparse); obejmują rzeczywisty selektor desktop CRT i odrzucenie onecore-only/brakującego vcruntime. Full workspace 5 PASS; końcowa korekta testu podmienia istniejącą audytowaną DLL przy niezmienionym ExpectedBuildId, 5 PASS w 4.67 s. Dowód: `final-family-regression-98345c5cb82e495db40b623989b8caae`. Parser PowerShell PASS; review stagingu i walidatora bez Required.
- Kolejny managed build z końcowego czystego commita, literalny FEM GPU, canvas/WebGL, dodatni czas urządzenia oraz pozytywny Ready nadal **NOT VERIFIED**. Zgoda użytkownika na CI instalatora obejmuje testy Rust/C++; lokalnie nie kompilowano testów w tym etapie.

### Hardlinki Cargo i kompletność wąskiej trasy FEM — 15.10.2026

- Literalny test `ab16aa3d728a09e76a5345a41a281236702e3f7d` zakończył się błędem pakowania po poprawnym zbudowaniu DLL FEM/CUDA, Cargo release (10 min 35 s) i sprawdzeniu wejść kompilatora. Guard błędnie odrzucił zwykłe hardlinki Cargo jako dowiązania symboliczne. Nie uruchomiono UI ani obliczeń; cleanup potwierdzony, log `native-build-a704d73c6dde41e09c3b74e8ae8f48ed.log`.
- Poprawka dopuszcza odczyt zwykłego liścia EXE typu HardLink, zachowuje blokadę reparse/symlink i restrykcyjne cele zapisu. EXE nie są kopiowane z powrotem nad pliki Cargo; ich ścieżki i hashe są sprawdzane. Każda trasa FEM stage'uje pełną kanoniczną rodzinę programów, ponieważ Cargo buduje wszystkie binaria API także dla bezpośredniego skryptu. Dokładny audit staged/launch pozostaje wymagany.
- Interpretowane testy Windows: package 5 PASS / 1 SKIP (opcjonalny reparse), w tym wykonywalny test hardlinków i auditu; parser PowerShell PASS. Niezależny review nie wykazał Required. Rzeczywisty replay produkcyjnego stagingu na kopiach plików, następny build i końcowe runtime/Ready/browser pozostają **NOT VERIFIED** na moment zamrożenia tej noty. Późniejsze wyniki będą zapisane w terminalnych receiptach storage i w PR, bez modyfikowania źródeł w trakcie kwalifikacji.
- Cloud CI dla `ab16aa3d7` zakończyło się sukcesem. Wymagany job `frontend-3d-managed-fem` czeka na canonical runner `fem-managed-docker`; jedyny runner jest zajęty prywatną kwalifikacją PR #175. Nie zmieniono jego etykiet, zmiennych ani działania.


### Wznowienie i integracja bieżących źródeł — 20.10.2026

- Wznowiono istniejące, czyste i zarejestrowane worktree `fem-script-launch-20261013`, owner `codex-root`, HEAD przed integracją `2af347c0f6be63157aa0d157e1aa2cb176c709fd`.
- Integracja jest przypięta do `master` `759c1e66799c0c8b28c4c8974ef38a7f676bb0bd`. Zachowuje Docker Compose jako codzienny DEV oraz osobną, już zatwierdzoną kwalifikację natywnego instalatora/pakietu Windows z ADR 0053.
- Dokumentacja mixed-P1 zachowuje zarówno plan regionalnych pól warstwa/pierścień, jak i nowszy, zaimplementowany wyłącznie na poziomie źródeł/kontraktu certyfikat rozłącznych ciał v2. Nie promuje to statusu runtime, operatorów ani parytetu CPU/GPU. Walidator source-map i 41 testów kontraktu dokumentacji przeszły.
- Ostatnia próba `native-full-workspace-build-invocation-953874fff7f1467e97072a8d76683105` nie uruchomiła buildu: odmówiła przy około 4.24 GB wolnego. W bieżącym odczycie Windows jest około 54 GB wolnego. Poprzedni błąd znikającego `R:` ma zachowany receipt, a RAM-disk został wcześniej wyłączony przez zatwierdzoną transakcję `.env`.
- Po przeglądzie i commicie scalenia: `just windows-installer-build initial-build` tworzy nowy `fullmag.exe` z zamrożonych źródeł. Następnie rzeczywisty przepływ instalatora ma przygotować pełny pakiet przez `windows-full-workspace-build static 0`, potwierdzić konfigurację i Ready, a dopiero później uruchomić ten sam przypięty pakiet i niezmieniony autorski model FEM GPU.
- Kryteria pozostają oddzielne: EXE/provenance; widoczny Avalonia/Fluent/licencja; bezpieczna konfiguracja `.env`; agregat czterech component proofs; pozytywny Ready; browser canvas/WebGL; rzeczywisty native FEM GPU bez fallbacku; CI/review/PR/integracja/cleanup. Stare artefakty ani anulowane smoke GUI nie dowodzą tych bramek dla nowego źródła.
- Retencja: zachowujemy przyrostowe cache, providery, ostatnie zweryfikowane artefakty oraz wszystkie referencjonowane źródła/logi/receipty. Nie zlecono kasowania. Skill `fullmag-build-stage-cleanup` nie jest dostępny; stosujemy reguły retencji governance i ponowną ocenę przed ciężkim buildem.

### Instalator i zgodność wyboru GPU — 20.10.2026

- Czysty merge źródeł `999b5d82cdcab61e221242af1d1f4e2ccd61f516` przeszedł wymagane CI. Zarządzany producent zakończył się kodem 0 i utworzył `fullmag.exe` (43 690 097 bajtów, SHA-256 `ab6fa43f5a5fcc997889543731e1d0ec559a7e84534cdc030dcd1e210e9919a2`). Receipt PE/Burn i snapshot `aef79aaeec368ca8c21fb9a13cf859414e9605e966449df6623b8e1cdd6b3983` potwierdzają czyste źródła. To dowód producenta EXE, nie pełnego pakietu runtime.
- Rzeczywiste okno potwierdziło Welcome, Apache, blokadę kontynuacji przed akceptacją i ekran Paths bez selektora backendu. Własne okno zamknięto przez Cancel, `.env` zachował hash i metadane. Dowody: `installer-positive-ready-17561fb795bc434e82853f10d83585c4` w runach tego worktree. Nie klikano Install ani Launch.
- Poprawka rozdziela niezmienne żądanie buildu `auto` pełnego pakietu od jawnego żądania symulacji `gpu`. Ponowne użycie pełnego pakietu wymaga istniejących walidatorów agregatu, originu, komponentów i receiptów. Zwykły pojedynczy pakiet FEM GPU nadal korzysta z dotychczasowej trasy bez agregatu; nie wprowadzono fallbacku CPU.
- Interpretowane regresje storage: 65 testów, OK, 1 skip; dwie dodatkowe kontrole FEM i siedem kontroli źródłowych launchera przeszły. Regresja obejmuje też odrzucenie zmiany originu auto→gpu po przypięciu agregatu. Natywny parser PowerShell launchera i automatu GUI przeszedł. Nowy EXE z poprawką, pełna instalacja Ready, wykonanie oryginalnego modelu GPU i przeglądarka nadal **NOT VERIFIED**.
- Przed kolejnym buildem odczytano 52 003 594 240 bajtów wolnego na C:. Nie było aktywnych procesów produktu ani kompilatorów wymienionych w kontroli Windows. Zachowujemy poprzedni EXE, logi, cache i receipty; niczego nie usuwamy.

### Przypięty producent i końcowy stan błędów — 20.10.2026

- Poprawka wyboru GPU została zapisana jako `ff7ef858beab705726aac56f5195e71075784ead` i wypchnięta do PR #173. Producent z tego czystego commita zakończył się kodem 0 (run `windows-installer-source-7646e14331b64998a33c68d894638572`). EXE ma 43 690 095 bajtów i SHA-256 `51604dede3e2526519b6b6a7585437cdcb425d9e3f435600442f9cb5572cf793`; niezależne porównanie pliku z receiptem oraz kontrola PE/Burn przeszły.
- Niezależny review wykrył błędną klasyfikację nieudanego sprawdzenia agregatu po zakończeniu procesu: `interrupted` zamiast `failed`. Rewalidacja znajduje się teraz we wspólnym bloku obsługi błędów manifestu; odrzucenie oznacza kod 1 i stan `failed`. Bounded review tej korekty nie wykazał dalszego Blockera.
- Nowy artefakt z końcową korektą oraz pełne GUI Ready, natywne FEM GPU i przeglądarka pozostają wymagane. Weryfikacja runtime ma użyć bieżącego autorskiego skryptu z głównego checkoutu, zachowując jego bajty i zapis tabel co zaakceptowany krok.

### Rzeczywisty przebieg końcowego EXE i pętla sesji — 20.10.2026

- Producent czystego `f7087e3b50ccba60c132a2090bc8fb205b5264eb` zakończył się kodem 0. EXE `windows-installer-source-1b3b511c3a8c43b2aa7693055af55d87/fullmag.exe` ma 43 690 101 bajtów i SHA-256 `356968b151d6ca8688fe62c33f87a95b2574b4cce784a2c6af50149133642315`. Hash pliku, receipt PE/Burn i czysty snapshot `b02e891ff60deaadfdff660dedcb47a11028fb6b4cb7e73861796d6603c03a42` zweryfikowano niezależnie. CI: 20 sukcesów, 10 pominiętych, bez awarii i oczekujących kontroli.
- Pełna próba GUI `installer-full-ready-f7087e3b-1438895def6a4dd9a0dea4fd00a0b1e3` potwierdziła rzeczywistą licencję, Paths, Environment oraz pusty podgląd `.env`. Zatrzymała się przed commit/setup: przygotowanie wymagań tworzy nową sesję konfiguracji, a reset sesji unieważnia preview i prowadzi z powrotem do jego przeglądu. Powtarzanie Prepare ponownie zmienia sesję, więc Progress/Install jest nieosiągalne.
- Po potwierdzeniu przyczyny rodzic użył normalnego Cancel wyłącznie w zweryfikowanym własnym oknie. Procesy Burn/UI/helper zakończyły się; hash, długość i metadane `.env` przed/po są identyczne. Nie rozpoczęto buildu pełnego Fullmaga. Error receiptu automatu mówi o niedostępnym oknie wskutek tego kontrolowanego Cancel; przyczynę pierwotną dokumentuje kod i `parent-cancel.json`.
- Wymagana poprawka musi zachować realne edycje konfiguracji i granicę sekretów między admission. Samo odtworzenie preview na nowej sesji po skasowaniu pól nie wystarcza, ponieważ zgubiłoby propozycję użytkownika. Ponowny rzeczywisty GUI ma potwierdzić poprawne przejście do instalacji. Pełny agregat, Ready, native FEM GPU, browser i integracja pozostają **NOT VERIFIED**.

- Poprawiony przepływ zachowuje świeżohostowy `Preadmission` przed odczytem Git, następnie `Requirements → Discover → Prerequisites` na związanej sesji. Pola są udostępniane dopiero po tym przygotowaniu. Edycja unieważnia preview, ale nie powoduje ponownego bootstrapu; jawne Continue po widocznym podglądzie prowadzi do Progress. Pierwszy bootstrap Git/Python i późniejszy idempotentny check związanej sesji mają odrębne wymagane guardy; nie pomijamy pierwszego na nowym hoście.
- Interpretowana kontrola `Fullmag.Setup.UI/test_protocol.py` oraz `git diff --check` przeszły dla tej poprawki. Nie jest to jeszcze dowód wykonania nowej maszyny stanów: wymagane są build EXE i ponowny rzeczywisty GUI. Osobny wykryty błąd edytowalnego, później nadpisywanego pola storage w Environment wymaga poprawki readonly, z zachowaniem edycji na Paths.

### Blokady konfiguracji i nawigacji kreatora — 20.10.2026

- Pole `FULLMAG_PROJECT_STORAGE_ROOT` na Environment jest readonly; wybór katalogu pozostaje na Paths. Setter nie przyjmuje ignorowanych edycji i nie oznacza tego pola jako dirty.
- Environment wymaga gotowych prerequisites, związanej sesji i pól. Zmiana Paths cofa frontier nawigacji, a Back pomija niedostępne kroki.
- Interpretowana regresja protokołu, parser XML oraz kontrola diff przeszły; niezależny bounded review nie wykazał Blocker/Required. Nie kwalifikuje to wykonania GUI. Następny wymagany etap to czysty producent EXE, rzeczywisty Install/Ready, pełny pakiet i oryginalny FEM GPU.

### Rzeczywisty kontrakt bound prerequisites — 20.10.2026

- Producent czystego `4d7ece5296eef512e3d81474fc36771bdb052741` zakończył się kodem 0. EXE `windows-installer-source-c4be965705eb461391e242b3a6b4a349/fullmag.exe` ma 43 690 408 bajtów, SHA-256 `c5f0a545ace2bb15f612df2007317dae999c6d06d026eb3f7fc5031016098c07`; hash pliku zgadza się z manifestem i receiptem. CI: 20 success, 10 skipped.
- Dwie rzeczywiste próby GUI potwierdziły Welcome, Apache i Paths, lecz zatrzymały się przed setup. Pierwsza ujawniła koszt wielokrotnych pełnych snapshotów procesów w automacie. Poprawiony automat przyspieszył przejścia, ale druga próba nadal nie osiągnęła Environment. Obie zachowały hash i metadane `.env`; procesy UI zakończyły się. Dowody: `installer-full-ready-4d7ece52-7730ae8115274b069d372ec596fa7d02` oraz `installer-full-ready-4d7ece52-9dc492601bf6435fa8f5c15d76bf0dfb`.
- Potwierdzona przyczyna produktu: sukces embedded `bootstrap_prerequisites` tworzy publiczną sesję bez `lane`, a natywny walidator wymaga zgodności tego pola z zatwierdzonym zakresem `all`. Odrzucenie zawiera nowy session_id; reset sesji w UI dodatkowo zasłania właściwy błąd. Poprawka musi uzupełnić odpowiedź i zachować komunikat odrzucenia, bez rozluźniania walidatora lub ochrony sesji.
- Kolejny czysty EXE, rzeczywisty Install/Ready, pełny agregat Windows, oryginalny FEM GPU, browser i integracja nadal wymagają kwalifikacji. Nie kasowano cache, źródeł, providerów ani dowodów.

- Poprawka zachowuje rzeczywisty `report.lane`, sprawdza jego zgodność przed rebindem i zachowuje błąd po zastosowaniu metadanych sesji. Natywne interpretowane testy transportu: 5 PASS. Wykonywalny RED/GREEN na Windows odrzuca brak lane, zachowuje all i nie maskuje niezgodności zakresu. Kontrola native source: 22 PASS; UI protocol PASS; diff check PASS. Niezależny bounded review bez Blockera; zdublowane przypisanie usunięto. Nie kompilowano testów C++/Rust. Nowy EXE i pełne wykonanie pozostają wymagane.

### Rzeczywista instalacja i typ ścieżki admission — 20.10.2026

- Czysty `af52d41513d3961f8850e91126ca9478e25019e8` wyprodukował EXE 43 690 641 bajtów, SHA-256 `c7c1924daaab25bf1cd6c79f1e9fcdc331bea99ba5f2e990cbcef60c176cfae4`, snapshot `86ae5fe131c416cc7d6a5009f2f453378f5966a650e2a65d716cabe09c499991`. Producent exit 0; hash/manifest/receipt zweryfikowano.
- GUI `installer-full-ready-af52d415-6eacdad36ca64d39b5a7c47b4d481c10` rzeczywiście przeszło Environment, readonly storage, podgląd, Continue i Install. Instalacja została odrzucona przed kompilacją: `PrepareSourceFirstBurnVariables` sprawdzało istniejący katalog runs regułą dla pliku. Poprawka rozróżnia istniejący katalog od celu plikowego, zachowuje granice lokalnego storage i odrzuca nieznane błędy dostępu. Zapisany automat GUI jest wykonywalną regresją tej trasy; pozytywny przebieg po poprawce pozostaje wymagany.
- Przed setupem commit rzeczywiście zapisał `.env` i utworzył prywatny backup `.env.backup.20261020T031255842Z.ba167a339c964c6587f466840056235a` w `storage/tmp/host-config-backups`. Hash backupu odpowiada wejściu `d82bcc6a2edfdb26669170a2101f4d381288e0ec60e0f1fdbe6303e7c40e015f`; nowy hash `a8b6fd613d21fcb791ce0942d1f697ad0bef95bdc223182bfc13300ef7b9c9d8`. Jedyna zmiana to separatory FULLMAG_PROJECT_STORAGE_ROOT, z zachowaniem tej samej ścieżki Windows. Pusty widoczny preview wymaga osobnego wyjaśnienia kontraktu; nie nazywamy tego dowodem zgodnego podglądu i zapisu.
- Rodzic użył zwykłego Cancel po potwierdzeniu blokady. Końcowy błąd automatu o niedostępnym oknie wynika z tego Cancel. Nie rozpoczęto pełnego buildu Fullmaga. Gotowy all4 runtime, Ready, FEM GPU, browser i integracja nadal NOT VERIFIED. Cache i dowody pozostają zachowane.

- Kontrola źródłowego protokołu po rozróżnieniu katalog/pliki: 22 PASS; diff check PASS. Niezależny review bez Blocker/Required. Poprawiony zachowany automat ma parser PowerShell PASS i wykrywa ponownie aktywne Install po odrzuconym setupie zamiast czekać pełny timeout. Natywny pozytywny przebieg tej poprawki nadal wymagany; nie kompilowano testów jednostkowych.

### Spójny no-op konfiguracji i świeży storage — 20.10.2026

- Ukryta zmiana slashy wynikała z rozbieżnych map Effective/Changes. Przy kanonicznie równoważnej ścieżce usuwamy klucz z Changes, pozostawiając istniejącą wartość w Effective. Dzięki temu nie przepisujemy oryginalnej linii, także przy odstępach, quoting i komentarzach.
- Rzeczywisty interpretowany RED/GREEN Windows zakończył się kodem 0 (sesja 81800, `verify-env-slash-red-green.py` w zachowanym katalogu kwalifikacji): oryginalny moduł wymagał ukrytego zapisu, poprawiony przeszedł test transakcyjny z pustym diffem, write_required=false, wrote=false, niezmienionymi bajtami/hashem i bez backupu. Wcześniejszy błąd escapowania fixture oraz niepełna korekta przypisująca tę samą wartość zostały odrzucone przez tę regresję; nie są dowodami sukcesu. Niezależny review końcowej korekty bez Blocker/Required.
- Trace nowego hosta wykazał odrębny brak: prerequisites zwraca storage_resolver=not_run, a preview/commit używają readonly resolve. Po zatwierdzonym commit trzeba jawnie wywołać managed resolve --create i sprawdzić jego wynik przed Burn; nie tworzyć katalogów poza resolverem. Implementacja tego kroku trwa; pełny runtime/Ready/FEM GPU/browser pozostają NOT VERIFIED.

- Kolejność kwalifikacji po końcowym czystym źródle: najpierw oryginalne `just fullmag windows=True build=True dev fem gpu` z niezmienionym plikiem z głównego checkoutu; dopiero potem finalny GUI build statycznego all4/Ready. Build dev nadpisuje physical origin i mógłby unieważnić już potwierdzony agregat statyczny. Na końcu należy ponownie użyć przypiętego statycznego pakietu do oryginalnego FEM GPU bez przebudowy. Bieżący surowy SHA pliku autora: `c986e1d8472cca81aef393d24118f4e0dbd215e1587727d114e3a859f8045cf6`; hash i bajty wymagają ponownego sprawdzenia przy admission. Nie zmieniamy geometrii, materiałów ani wymuszonego GPU.

### Jawne przygotowanie storage po commit — 20.10.2026

- Prywatna operacja helpera `prepare_storage_layout` wymaga podpisanej sesji po commit, także gdy konfiguracja pozostała niezmieniona. Rewaliduje źródła, hash `.env`, profil i katalog, a dopiero potem wywołuje istniejący resolver z `--create`. Preview i zwykły commit pozostają bez tworzenia layoutu.
- Natywna kontynuacja sprawdza dokładny session_id, checkout, hash, storage_root i runs_root oraz rzeczywiste katalogi bez reparse przed przygotowaniem admission i Burn Plan. Zachowuje generation, cancel i blokadę zmian konfiguracji.
- Rzeczywisty interpretowany test embedded PowerShell na Windows: 1 PASS, 46.230 s, exit 0 (sesja 19992). Obejmuje odmowę przed commit, utworzenie layoutu przez resolver po commit unchanged oraz odmowę zmiany profilu, hasha i root bez zapisu w alternatywnym root. Native source protocol: 23 PASS; Avalonia UI protocol PASS. Istniejący transport helpera: 5 PASS; pełna transakcyjna regresja `.env`: 2 PASS, 110.338 s, exit 0 (sesja 51230). Nie kompilowano testów C++/Rust.
- Wolne miejsce przed kolejnym producentem: 34 275 889 152 bajty. Zachowujemy wcześniejsze EXE, providerów, cache, snapshoty i dowody, ponieważ są referencjonowane przez kwalifikację; nie wykonano cleanup. Brak skilla fullmag-build-stage-cleanup. Nowy EXE, rzeczywisty Install/Ready i pełny natywny FEM GPU pozostają wymagane.

- Fragment layout zapisany w `9513b191ad5c9ccf2761702f60a072781787f72b` jako checkpoint. Review wykrył dwie luki przed buildem: broker stosował pola mimo blokady mutacji, a resolver create nie miał końcowej kontroli zmiany `.env`. Korekta brokera odrzuca mutujące operacje przed ApplyBrokerInputs; status/cancel/shutdown nigdy nie stosują pól. Źródłowa kontrola protokołu po tej korekcie: 24 PASS; niezależny review brokera bez dalszego Required. Korekta TOCTOU i jej wykonywalna regresja trwają. Nie wyprodukowano EXE z tym checkpointem.

- Końcowa korekta utrzymuje lock `.env` przez preview, managed create i końcową rewalidację hash/root/profile/runs_root. Rzeczywista regresja Windows (sesja 47293) zakończyła się exit 0: 1 PASS, 35.083 s, w tym wymuszona mutacja między preview a create, jej odrzucenie i zachowanie zmienionej treści. Statyczny review obu korekt bez Required/Blocker. Usunięto także niepotrzebne mutable z const-lambda callbacku; kompilację C++ potwierdzi dopiero nowy producent EXE.
- CI ostatniego wypchniętego źródła: 20 success, 10 skipped, bez failed/pending; PR #173 pozostaje draft. Nie zastępuje to nowego CI po korekcie ani runtime/Ready/FEM GPU.


### Kwalifikacja Windows `f4de89928` — 20.10.2026

- Źródła `f4de89928970aa7c8eccdbc061731de943d7835a` są zapisane i wypchnięte; CI: 21 success, 10 skipped, zero failed/pending. Producent notices przeszedł natywnie 61 testów i 8 podprzypadków (1 test artefaktu pominięty przed nowym EXE). Rzeczywiste 30 archiwów dało 40 tekstów, 14 jawnych fallbacków upstream i zachowane 72 znaki form-feed. Nowy EXE z tymi payloadami nadal wymaga produkcji i próby.
- Zarządzany natywny build Windows zakończył się sukcesem; Rust release trwał 12 min 40 s. Ukończony manifest dev ma SHA-256 `7699d63adbac838fbb16f956477656b5779813e6adb485b7934387959ffbc409`, a source snapshot SHA-256 `242f32948b18b7b4ce17f3672261b4a02363236aae9368aa601848b9fd423f73`. Bajty manifestu są zachowane w `build-manifest-f4de8992-dev.json` katalogu kwalifikacji. ID rekordu snapshotu `5280429616465d1b40cbcc1b2cfe8913bb21c05f2329ad45626cf2e508c2595e` jest odrębną tożsamością.
- Niezmieniony skrypt autora (raw SHA `c986e1d8472cca81aef393d24118f4e0dbd215e1587727d114e3a859f8045cf6`) utworzył siatkę 1 086 536 komórek / 183 704 węzłów / 52 454 ścian. Przygotowanie osiągnęło ready, a runner potwierdził `fem_native_gpu`, `fallback=None`; wcześniejszy błąd certyfikatu nie wystąpił. Runtime wskazał `.zarr` obok skryptu w `examples`, zgodnie z żądaniem użytkownika.
- Pierwsza próba Solve zakończyła runtime naturalnym exit 1 przed pierwszym krokiem: `strict FEM GPU demag requires finite positive visual recovery weight for every P1 state node`. Jest to nowy, rzeczywisty blocker wykonania modelu, nie błąd buildu. Log: `native-build-50118dcdf1e64e978f4c46fb08be7100.log`; nowy cache shared-domain: `9e58d6cde5907df33d1e175e0eb4edea23d907b7343f08daa13f4fefb3d1536a.fullmag-mesh`. Cache, częściowy wynik, logi i dowody pozostają zachowane.
- Plan domknięcia: (1) sprawdzić pokrycie globalnych węzłów connectivity rzeczywistego artefaktu — log sugeruje 2 węzły poza sumą części; (2) po potwierdzeniu przyczyny opisać invariant w nocie mixed P1, naprawić producenta i dodać wykonywalną regresję bez osłabienia dodatniości wag ani fallbacku; (3) przypiąć czyste źródła i ponowić zarządzany Windows FEM GPU oraz browser. Następnie pozostają negative Close, nowy EXE, GUI all4/Ready, static GPU i integracja PR #173.

### Usunięcie osieroconych węzłów shared-domain — 20.10.2026

- Przyczyna została potwierdzona na niezmiennym artefakcie SHA `be505b6637df82dc0d815c4dafdaed6779dd0da035ec1af3229e81ccba8c71d9`: dwa punkty CAD (globalne indeksy 4 i 18) nie należą do żadnej komórki ani fasety. Nie są poprawnymi węzłami air-only.
- Producent kompaktuje volume-supported node space przed `MeshData` i remapuje connectivity, periodic pairs oraz vertex identity. Odrzuca facet/periodic references do orphanów; nie zmienia geometrii, materiałów, kwadratury ani GPU guardów. Kontrakt cache `fullmag.fem.volume-node-space.compaction.v1` i wersja v11 odcinają stare artefakty bez ich usuwania.
- Windows Python: pięć nowych regresji PASS; istniejąca regresja swept cylinder PASS. Rzeczywisty milionowy artefakt po zastosowaniu helpera ma 183 702 węzły; współrzędne każdego odwołania komórki i fasety pozostały identyczne. Dowód: `volume-node-compaction-real-artifact.json` w katalogu kwalifikacji. To test producenta, nie wykonanie solvera.
- Review źródłowy bez Blockera dla naprawy producenta; nota definiuje odrębne wagi visual/magnetic i invarianty wsparcia. Focused source-map validator PASS, 41 testów kontraktu dokumentacji PASS. Następny krok: czysty commit, integracja bieżącego origin/master, zarządzany build Windows i oryginalny FEM GPU z obserwacją automatycznego Solve. EXE/Ready/static GPU pozostają wymagane.

### Integracja bieżącego mastera i bramki kompilacji — 20.10.2026

- Commit `f32d37144f951c5929f4588b4375a344cb7b0cb8` zapisuje poprawkę node space. Następnie `59a4c71abd3b44e3a37d2a1d703ba4f73b1ae37f` scala opublikowany master `a63b50ca0c0c4b457f440b0ac276b483d282c555`. Konflikt source map rozstrzygnięto bez duplikatów ID; focused validator i changed-page validator poprawki przeszły. Gałąź i PR #173 są wypchnięte, draft pozostaje do zakończenia dowodów.
- CI actual-gmsh dla `59a4c71ab` zakończyło się sukcesem. Pozostałe awarie ujawniły wspólne błędy odziedziczonego kodu: niemutowalne `latest_stats` z późniejszym przypisaniem materialization states, jedenaście diagnostyk TypeScript oraz fixture’y bez jawnego namespace/carrier revision. Przygotowane korekty zachowują guards produkcji; nie zmieniają matchera, fizyki ani backendów.
- Regresje protokołu aktywacji po poprawieniu fixture’ów: 19 PASS. Dodatkowa bezemisyjna kontrola 1262 plików ze zmianami pięciu modułów UI w pamięci, przy zależnościach zarządzanego profilu Windows, dała zero diagnostyk w TypeScript 6.0.3. Jest to diagnostyka źródeł; kanoniczny CI używający TypeScript native 7, pełne testy i rzeczywisty browser/WebGL pozostają wymagane.
- Build Windows `59a4c71ab` zamroził snapshot record `4bf61c3d299c6c8d1df0c671de30b86e059e46b17d316ba2850acfc677078454`, source SHA `cf61e16bec6d94d4b1f5b04b805c7687746ce1531b2179517aa9803c18f14816`. Zmiany robocze po zamrożeniu należą wyłącznie do następnego buildu. Bieżący wynik końcowy należy odczytać z `native-build-82978ce432074985bb827b75c032ee34.log` i receiptu; nie kwalifikuje on jeszcze poprawionego źródła.
- Poprzedni nieudany Zarr `run-session-1792483990424-143060` zabezpieczono pod wyłącznym writer lockiem: 20 plików, 3962 bajty, archiwum SHA `b339009cf1417460c95bdf5c576b6b4513eabe5147de6a9e2698d8b39c0b0f03`, z potwierdzoną niezmiennością danych źródłowych. Zachowano także 22-bajtowy nieudany pusty ZIP pierwszej próby; żadnych danych nie usunięto.
