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
