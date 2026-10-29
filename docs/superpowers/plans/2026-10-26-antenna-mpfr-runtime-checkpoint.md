# Kandydat MPFR dla pola anteny — checkpoint 26.10.2026

## Cel i klasyfikacja postępu

Poprzedni turn przyniósł postęp: poprawiono stany inspektora Universe/anteny,
23 kontrole renderowania/nawigacji oraz typecheck i lint przeszły. Nie był to
dowód pola na pełnym Universe. Pełny cel E0–E12 pozostaje otwarty.

Niniejszy etap usuwa przeszkodę wydajności operatora bez zmniejszania siatki,
zmiany źródła, tolerancji, limitu 1800 s ani pominięcia przejść kontrolnych.
Przygotowany kandydat MPFR128/160 jest FEM CPU, inspection-only. Nie jest
zakwalifikowaną bazą, realizacją GPU ani wynikiem pełnego Universe.

## Baza i przygotowanie źródeł

HEAD: 5bc05ae5880687b5fd27292931f4a60b868cab5c; istniejący dirty worktree
zachowano. Referencja native:
22c08a0585a5511d6737b9d429de180b9f22bdf4ed249382665ed7c42815c909.
Bundle: 6bacf94351693955f5b97ab7485613e5a23cc29e835ffaf02527cdb6389e0ca4.
Referencyjne 14 punktów wymagało 363,113 s operatora. Pełny przykład jest
osobnym zadaniem; nie zastępujemy go małym benchmarkiem.

Kandydat używa allocate_stack i et_off oraz nowej jawnej tożsamości
fem_oersted_rt0_surface.mpfr128_160_rndn_etoff.inspection.v1. Stare archiwa
pozostają czytelne pod dokładną starą tożsamością. Świeży native output wymaga
nowej. Wszystkie formuły, exact geometry, kolejność sumowania i odmowy
pozostają w kodzie. Dwa typy nie stanowią niezależnego oracle.

W tym turnie naprawiono mapę źródeł: jednoznaczne symbole właścicieli zamiast
nierozpoznawanych aliasów/kwalifikatorów i niejednoznacznego serialize.
CMake ma jeden wymagany moduł GMP/MPFR. Przypięty base Compose to Ubuntu22.04;
MPFR dev/runtime 4.1.0-3build3. Nie zmieniono base działającego API ani .env.
Prerejestracja i macierz realizacji pozostają w kanonicznej nocie 0950.

## Przygotowane dowody i procedura próby

Wolumen kontrolny grupy, verification/antenna-mpfr-20261026:

- toolchain-preflight.json: przypięta stara biblioteka, zdrowe API, wolne miejsce
  i decyzje retencji; około 133 GiB na D: oraz 220 GiB w WSL przed buildem;
- scene-before-image-change.json i status-before-image-change.json;
- runs-before-image-change.json: inwentarz historii przez publiczne API;
- preregistration-pins.json i baseline-source: wcześniejsze niezmienne piny;
- comparison-expectations-v1.json: wymagane 21 identycznych payloadów,
  dokładna zmiana reserved bytes +7126, wszystkie pozostałe liczniki zgodne;
- run-mpfr-candidate.py: jedna próba z nowym run ID i kontrolą braku wcześniejszego
  zlecenia, frozen request SHA i jawnie podanym SHA nowej biblioteki;
- compare-mpfr-candidate.py: porównanie 21 payloadów, źródła, polityki,
  tożsamości, diagnostyk, liczników i receiptu faz. Nie wykonano go na
  nieistniejącym wyniku kandydata.

Nie uruchomiono Solve MPFR. Skrypt próby nie ponawia automatycznie żądania;
observation timeout nie stanowi zakończenia workera. Sprawdzenie Pythona
hosta3.8 ujawniło brak removeprefix; walidator uruchamiany jest właściwym
Pythonem3.10 istniejącego backendu, bez zmieniania walidatora.

Zachowana scena jest dokładnie zgodna z istniejącym kanonicznym FMS:
c05d8176471e7de2e8ef439375f362223a22e0023a6e64c1a267bde861f9ed87.
Nie wykonano kolejnego odrzuconego compact export, nie zmieniono sceny
ani zapisanych wyników. Brak skilla fullmag-build-stage-cleanup; zastosowano
retencję governance: zachować aktywny cache, pakiet referencyjny, wyniki,
obrazy i staging, nie wykonywać żadnego prune/usuwania.

## Faktycznie aktywny build i następny krok

Z katalogu tego worktree uruchomiono just docker-dev-toolchain. Grupa:
fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1.
Nowy input tag: fullmag/fem-gpu-toolchain:inputs-8eda4c1644405bd9c8c303ea.
Handle terminala 33865 jest nadal żywy; ostatnia odczytana faza: MFEM
90/269, etap instalacji runtime zakończony. Efektywne parametry:
CUDA86-real/86-virtual, hypre86, MFEM jobs2, fast-compile0. Część zależności
była cached, MFEM i warstwa pakietów runtime są rzeczywiście przebudowywane.
To obraz zależności, nie osobny backend-build ani symulacja. Dotychczasowe
API/front pozostają uruchomione. Nie wolno wnioskować o nowym pakiecie lub
przyspieszeniu z samego postępu BuildKit.

Po zakończeniu tego samego handle sprawdzić terminal i imageID. Potem ponowić
kontrolę bieżącego API/runów oraz operacji control. Dla ukończonej sesji użyć
istniejącego managed restart-idle-volume z allow-prepared-session i stop-only,
nie fałszować saved-authoring checkpointu. Zachować dwa stare accepted runy;
nie nazywać ich manualnie wstrzymanymi bez dowodu i nie zwalniać ich blokad
ręcznie. Następnie just docker-dev-recreate-volume z canonical start
 aa0121dc39f84ebfa89b804f13881921 oraz config
5ae11c7ec51fbc05cebde982e3b7281f82e5318d23d6765ab136d45302b33fb6,
fresh_state=false, bez skryptu startowego/Solve. Kontroler musi sam dopuścić
stan i migrację konfiguracji po authenticated drain. Nowy obraz oznacza nowe
app-container IDs; zachowanie danych/cache nie oznacza tożsamości kontenerów.
Jeśli preflight odmówi, nie omijać bramki.

Dalsze bramki: aplikacyjny build w stałym backendzie, link/manifest MPFR,
ponowny odczyt starych wyników, jedna próba14, prerejestrowane porównanie,
szersza niezależna kwalifikacja i pełny Universe. Kontrole przeglądarki,
pełna baza/projekcja/LLG/FFT/BORIS i E12 nadal nie są zaliczone.


## Dokładne wejścia obecnego Universe — uzupełnienie

Następny turn przyniósł konkretny postęp przygotowania rzeczywistej pełnej
próby. Obecny manifest API ma 1162 nodes i 6548 Tet4, z czego 1726 conductor
oraz 4822 air. Historyczna próba ace433… miała 1154 nodes i źródło1862;
mały benchmark ma14 nodes i źródło1865. Nie są to te same siatki.
Aktualny FMS zawiera źródło677 nodes/1859Tet4 i Global1162/6548, zgodne
z zachowaną natywną preparation oraz bieżącą generacją
1068f1dda14706c4ebbb5f81c280ae0d8025f70d1cbf5a4aaa8d834b69a9097b.

Przygotowano pełny publiczny request w podkatalogu kontrolnym
full-universe-replay/frozen-submit-request.json. SHA256:
3dd66fe134bedbc66fb90fa40bfb510ac4aa2bbcb64953c2b5ce08620af7c6cb,
41 684 035 B. Archiwum projektu SHA256:
f8d8abafa021fb490c597692ccaa7b0a3c119aa143a2df51ebe336048b2bdbfc.
Kontrola replay-input-validation.json przeszła: identyczne bity wszystkich
punktów, connectivity/markery, generacja API, scena, ProblemIR, plan i katalog;
ponownie sprawdzono hashe wszystkich1973 assetów. Zmieniono tylko run ID
oraz metadata aktywacji samodzielnego runu. Nie wykonano remeshingu ani POST.
Projekt10909b… ma katalog runów HTTP200 i zachowany run2f2f…; bare GET projektu
nie jest kanoniczną trasą, więc jego404 nie dowodziło braku projektu.

Pełna próba obejmuje 2 160 158 par przy niezmienionym limicie4 mln/1800s.
run-full-universe-once.py wymaga najpierw wyniku21-payload parity z małego
MPFR i zgodnego SHA biblioteki. Sprawdzono dwie rzeczywiste odmowy preflightu:
mała próba nie startuje na starym pakiecie22c08…, pełna nie startuje bez
zaliczonego małego porównania. Obie zakończyły się przed submission-started;
żadnego Solve. Dowód trial-preflight-negative-checks.json.

Odrębny audyt dokładnej geometrii zachowano w future-geometry-reuse-proof.py
oraz JSON. 462 porównania Fraction wszystkich13 pól i sześciu permutacji
przeszły; jeden degenerujący po binary64 trójkąt jawnie pominięto. Dla obecnego
źródła jest7436 lokalnych ścian i4365 unikalnych trójkątów według bitów
współrzędnych. Potencjał ograniczenia powtórzeń geometry wynosi41,30% przed
narzutem. Nie zaimplementowano cache, nie współdzielono prądu/FacePass, nie
sprawdzono native guards/RSS i nie uznano tego modelu algebraicznego za
kwalifikację naukową. Najpierw osobny parytet MPFR; sam czas fazy exact z
małego benchmarku sugeruje, że MPFR-only może nie wystarczyć dla1800s, lecz
jest to ekstrapolacja, nie pomiar obecnego Universe.

Build33865 pozostaje aktywny, ostatnia obserwacja MFEM205/269. Właściwa trasa
DEV deleguje do build_volume_toolchain; końcowe piny znajdują się w
 toolchain/attempts/<attempt>/terminal.json i toolchain/current.json lub
verified.json. Stary toolchain/bootstrap-receipt.json nie jest producentem
tej trasy. Nowy obraz, aplikacyjny build, mała próba i pełna mapa są nadal
NOT VERIFIED. Źródła kernela pozostają wyłącznie kandydatem MPFR.


## Bramka tożsamości wykonania — przed pierwszą próbą MPFR

Niezależny przegląd wykrył lukę w przygotowanym comparatorze: porównywał
21 payloadów, lecz nie wiązał ich dostatecznie z publicznym katalogiem,
manifestem zakończonego zadania i biblioteką faktycznie załadowaną przez worker.
Naprawiono lokalne narzędzia w wolumenie kontrolnym przed jakimkolwiek nowym Solve.
Nie zmieniono fizycznych wejść, metod, tolerancji, limitów ani publicznego API.

Nowa kontrola wiąże project/run/task/attempt/epoch/step/case, codec, artifact IDs,
SHA256 obu obiektów CAS i rzeczywisty rozmiar bundle. Porównuje pełną identity
started/completed/profile w pamięci; raportuje wyłącznie jej digest i jawne
identyfikatory, bez wartości lease. Weryfikuje także zgodność żądania i konfiguracji
profilera. Runner przypina nagłówek inkarnacji API we wszystkich odpowiedziach.

W czasie rzeczywistej próby wymagany jest odczyt procesu dopasowanego po dokładnych
argumentach store/run/task: PID i start_ticks, executable oraz mapowania biblioteki
FEM muszą odpowiadać inode/device/hash przypiętych plików. Obserwacja wiąże również
receipt rozpoczęcia workera. Przed próbą, w obserwacji i po zakończeniu sprawdzane
są worker, biblioteka i hash receiptu pakietu. Jest to pojedyncza obserwacja procesu,
nie ciągła attestation. Brak obserwacji odmawia promocji, bez automatycznego Solve.

Zakres pinów pakietu jest jawny: dwa rzeczywiste pliki (worker i FEM library) oraz
receipt. Nie jest to ponowny audyt rzeczywistych bajtów wszystkich pozostałych plików
pakietu. Pełna próba wymaga tych samych pinów, pozytywnego małego porównania oraz
własnej obserwacji workera. Przypięty runner porównuje fizyczne wejście z frozen
request przed POST; comparator nie odtwarza samodzielnie całej tej transformacji.

Weryfikacja narzędzi: 80 kontroli interpretowanych PASS, w tym binding rzeczywistego
zachowanego wyniku i celowo podmienione identity, metadane i mapowania. Jawnie oznaczony
fixture całego verifiera nie jest obserwacją żywego procesu. Dwie odmowy preflight
PASS: stara biblioteka oraz brak pozytywnej małej próby. Po obu sprawdzono brak
submission-started. Nie kompilowano testów jednostkowych. Niezależny ponowny przegląd
nie znalazł blokera w zakresie exact worker/exact FEM; zachowano powyższe ograniczenia.

Dowody: verification/antenna-mpfr-20261026/ w kontrolnym wolumenie grupy:
trial_runtime_binding.py, check-trial-runtime-binding.py, runtime-binding-checks.json,
runtime-binding-preregistration-v1.json i trial-preflight-negative-checks-v2.json.
Klucz full_trial_requires_identical_package w prerejestracji oznacza porównanie
wskazanych dwóch plików oraz receiptu, a nie pełny actual-file audit.
SHA256 helpera: b1accf5776a22e54a953a8e9c186a074db81ee2101ba597b8c0f50862c6fc44e.
SHA256 małego runnera: 5fff8f2390f2ba66e99dff044b5d6c977e0127ec345b8828af57c576350360c3.
SHA256 comparatora: 661e1fc4ca431ca956f275dcb73763594a0e7be094d9e29c0cfd8f325d63c209.
SHA256 pełnego runnera: 8bb0dce027c472a7b28875b41abe5b3741b6736b594ccbd41996e37fdbdb2315.

Stan wykonania: aktywny toolchain attempt 899638a17d5e4f5389cbfebcf3f8af69,
uchwyt 33865; MFEM CUDA zakończony 269/269, hypre/PETSc/SLEPc CPU zbudowane,
trwa MFEM CPU. Stare API nadal działa. Nowy pakiet aplikacji, próba MPFR i pełny
Universe pozostają NOT VERIFIED. To kontynuacja aktywnego E0–E12, nie zakończenie zadania.

## Zakończony toolchain i zarządzana zmiana obrazu — 26.10.2026

Uchwyt 33865 zakończył się kodem 0; próba toolchain
899638a17d5e4f5389cbfebcf3f8af69 ma state=succeeded. Zweryfikowano current,
verified, terminal i rzeczywisty image ID:
sha256:5cf062bca3cb250be119f043f7886fd2c2ed4f975033ffa8b909c2645c62d767.
Installed manifest SHA256:
e540daa06adab1de7177ef2019ebd10881fdab8731991ad932fd0671b9c2d054.
Skopiowany JSON w kontrolnym wolumenie jest reserializowany; jego odmienny
hash nie jest automatycznie błędem integralności instalowanego pliku.

Porównanie dotyczy zagnieżdżonej sekcji `actual`, nie pól o tej samej nazwie
na poziomie root, których tam nie ma. Commity hypre/libCEED/MFEM/PETSc/SLEPc
pozostały zgodne. Boost/GMP oraz wersje CMake, Node, nvcc, pnpm i Python są
zgodne; MPFR ma wersję 4.1.0-3build3. Rust jednak zmienił się z
1.101.0-nightly (12433c307 2026-10-24) na
1.101.0-nightly (76456a688 2026-10-25). Nie ma podstaw do twierdzenia, że
cały toolchain jest identyczny, że cache Cargo nie zostanie unieważniony albo
że ewentualne przyspieszenie całego zadania wynika wyłącznie z MPFR.
Dokładny manifest i porównanie zachowano w
verification/antenna-mpfr-pre-image-change-20261026-1d555f29/.

Świeży preflight: API instance 57e3a412-7ca4-48fc-8925-2d72cbf97189,
solver/session completed, is_busy=false, brak procesu scientific worker.
Scena dokładnie równa zachowanemu FMS; canonical scene SHA256
6329d1f4ff232383a9e46ef39c024e83c2695185fe5dfb0e61e082749e130ba7.
Nie zastąpiono sceny ani wyników. `restart-idle-volume --allow-prepared-session
--stop-only` zakończył się succeeded, attempt
70248cdfa80b449a9966dc4f94d1e568, idle_backend_stopped=true.
Obie przypięte usługi zatrzymane z ExitCode=0, bez OOM, PID=0.
Dowód drain ma schema fullmag.docker-idle-restart-drain.v1 i process receipt
SHA256 8025e0cc0bdbaf0c3206680f2cdf8339711330d734f75e64bc4fc0fba6731063.

Pierwsza próba recreate 6b1b3332aa6447428d9b313a307845ff odmówiła w preflight:
moje jawne PATH pominęło /usr/lib/wsl/lib, więc nie widziało nvidia-smi.
Sprawdzono rzeczywiste nvidia-smi i GPU, a kolejne polecenia zachowują PATH.
Recreate 1d1b49b70b38497c96da7f5c8bfdb919 zakończyło odtworzenie succeeded,
ale dalszy start zatrzymał hostowy Python 3.8 na str.removeprefix.
Nie ponawiano usuwania usług: użyto docker-dev-resume-recreation przypiętego
do dokładnie tej zakończonej operacji. Sam override storage_python w just
nie rozwiązał błędu, ponieważ just_storage_shell.sh wykonuje własny wybór
interpretera i rekonstruuje argumenty docker_dev.py.

Po drugim identycznym błędzie przeanalizowano warianty: (1) dopięcie istniejącego
Pythona do PATH z zachowaniem narzędzi WSL, (2) dedykowany FULLMAG_STORAGE_PYTHON,
(3) propagacja interpretera w wrapperze, (4) zgodny z Pythonem 3.8 zapis operacji
na prefiksie. Wybrano istniejący, jawnie obsługiwany wariant (2):
FULLMAG_STORAGE_PYTHON=/home/kking/.local/bin/python3, zweryfikowany 3.12.10.
Nie instalowano nowego interpretera ani nie zmieniono .env, wrappera, polityki
restartu lub trybu GPU. [Dokumentacja Pythona](https://docs.python.org/3.13/library/stdtypes.html#str.removeprefix)
potwierdza wprowadzenie removeprefix w 3.9; [manual just](https://just.systems/man/en/setting-variables-from-the-command-line.html)
rozróżnia override zmiennej receptury, zaś faktyczny wybór w tym repo dowodzi
kod scripts/just_storage_shell.sh:30–55 i gałąź docker_dev.py.

Wznowione polecenie ma uchwyt 45074. Toolchain attempt
13522ca9565c48c6add0d271ee7e048d jest cache_hit=true i wskazuje powyższy image ID.
Trwa zarządzany build development-dev:inputs-0259ccb9ab2c3d1d32d0cda2 na tym
rodzicu, obecnie warstwa apt/ripgrep. To nie jest jeszcze ukończony aplikacyjny
build ani działające API. Nowa para usług, rzeczywista biblioteka MPFR,
próba14 i pełny Universe nadal wymagają dowodów. Nie uruchomiono kolejnego Solve.


### 26.10.2026 — zakończenie buildu i pojedyncza próba kandydata

Zarządzana operacja `4eca82a5aa7d4e86aec9a60e8e344e75` zakończyła się stanem `succeeded`, kodem 0, bez cache hit pakietu. Config SHA256: `d60d9d7e0a33f1fb2b0a268c006c372f3253d97ed2e61edb38ad94b65182039f`. Make ukończony kodem 0 po 2521,822 s; pakiet 24 plików przeszedł walidację oraz bramki linux-native-v1 i worker-cgroup. Backend i frontend uruchomiono w tej samej grupie WSL; pozostałe grupy nie były zmieniane.

Nowa biblioteka FEM SHA256: `23a06fa8113074fdad31360b5795aa71155ef09287c62e286f1563e2d42121ba`; receipt pakietu: `ffd5f0b25bcadbcaf374500d0e703d96b9be32a04be37437d021d41262bf7c51`; native source identity: `1e91f8abbbc760034f69062822fc9d1fc6a2e86920af737deb1b82e12d9c9854`. Przeliczenie identity musi stosować dokładny format launchera, łącznie z końcowym znakiem nowej linii. Dynamiczne zależności obejmują libmpfr.so.6 i libgmp.so.10. Hash trzech źródeł operatora porównano z rzeczywistym cieniem kompilacji i receiptem.

API inkarnacja `5a030fd0-fef6-4c52-82fd-9dee0a28c3dc` odpowiedziało health=ok. Przy braku aktywnej sesji zaimportowano zachowany FMS o SHA256 `c05d8176471e7de2e8ef439375f362223a22e0023a6e64c1a267bde861f9ed87` w trybie visualization_only, bez Solve; odpowiedź 200, bez ostrzeżeń, active_session=true. Zachowano wyniki i historię.

Przed wysłaniem próby poprawiono błędne założenie narzędzia kontrolnego: zoptymalizowany ELF nie musi zawierać pełnego literału wersji jako ciągłych bajtów. Tożsamość pozostała przypięta do dokładnego native source identity oraz hashy biblioteki/workera/receiptu; pełny operator_version nadal musi przejść kontrolę w dowodach numerycznych. Nie zmieniono fizycznych wejść, tolerancji, budżetów ani zasad jednorazowego wysłania. Opis mechanizmów optymalizacji: [dokumentacja GCC](https://gcc.gnu.org/onlinedocs/gcc-15.2.0/gcc/Optimize-Options.html). Poprzednie narzędzia zachowano w `verification/antenna-mpfr-20261026/optimized-elf-preflight-amendment/`. Nowe SHA256: mały runner `2dce8647d6ef65b58d2087589a376db9cf68a85ba63963fa72efee0f7e5daa74`, pełny runner `ef79ae6c9068a40992d7734c4226d058fc5b8c372140f808d3fc520284dd4a00`.

Mały run `run-antenna-mpfr-20261026-01` został przyjęty przez publiczne API i przeszedł do running; task `task-524870aa5f7414211a86aee5f24f7e74445538dd263b76cfff7620aecfefbe15`. Nie jest to jeszcze zaliczenie porównania 21 payloadów ani pełnego Universe. Kolejne kroki: zakończenie obserwacji i powiązania workera z biblioteką → porównanie → dopiero przy sukcesie jednokrotna pełna próba.


### 26.10.2026 — wynik małej próby: ukończony Solve, niezaliczona promocja

Run `run-antenna-mpfr-20261026-01`, task `task-524870aa5f7414211a86aee5f24f7e74445538dd263b76cfff7620aecfefbe15`, attempt `attempt-1cabdeeafb8b44c5a13cd10e31141404`, epoch 1 zakończył się `succeeded`. Pakiet wyniku CAS: `ed9e6ed4089d552ca7511408de9246f56f4d8a0d93b8bfd57e36fc1da2d1faf5`. Diagnostyczne porównanie potwierdziło byte-identical 21 z 21 naukowych payloadów i oczekiwany pełny operator_version MPFR. Czas operatora wyniósł 88,759490982 s wobec 363,112640028 s referencji; to pojedynczy pomiar, bez kwalifikacji wydajności i przy odnotowanej zmianie kompilatora.

**Bramka promocji nie przeszła.** Pierwszy obserwator zatrzymał się na błędnej interpretacji SONAME: rzeczywisty worker mapował `lib/libfullmag_fem.so.0`, podczas gdy kontrola oczekiwała `lib/libfullmag_fem.so`. Odczyt żywego procesu PID 21879 pokazał zgodny hash `23a06fa8113074fdad31360b5795aa71155ef09287c62e286f1563e2d42121ba`, inode 3250814, device 08:40 oraz zgodny wpis receiptu. Nie zachowano jednak kompletnego pliku obserwacji obejmującego wszystkie prerejestrowane kontrole. Późniejsze wznowienie wyłącznie GET (bez POST) odczytało już wynik terminalny; nie sfabrykowano brakujących danych i nie oznaczono runtime_binding_verified=true.

Obserwator poprawiono wyłącznie dla konkretnej, receipted kopii SONAME w tym samym pakiecie: identyczny digest/rozmiar, zgodny device/inode i niezmieniony receipt. Nadal odrzuca obcy plik, inny digest, niewłaściwy inode, usunięty plik i błędny/brakujący wpis receiptu. Nowy helper SHA256 `b454677785e741e0affe786e46a17984d4f4ff053d571b16b58d14dc98d979f0`; 88 lekkich sprawdzeń przeszło. Narzędzie wznowienia tylko obserwacji ma SHA256 `04c94d0a0caaebce8fe80a86fb45a8da46cd65c1f134d1c53b7f9f32b3012db1`. Poprzednie źródła zachowano w `verification/antenna-mpfr-20261026/soname-observer-amendment/`. Te sprawdzenia nie uzupełniają utraconego dowodu live.

Niezależnie porównanie wykryło różnicę licznika `real_divisions`: targety 10–13 mają po 16 operacji mniej, pozostałe liczniki poza prerejestrowaną zmianą rozmiaru outputu pozostają do oceny. Nie zmieniono oczekiwań po obejrzeniu wyniku. Diagnostyka jest zapisana jako `on/failed-promotion-diagnostic.json`, status `not_qualified`; nie utworzono zielonego `comparison.json`. Pełnego Universe nie wysłano i nie powtórzono Solve. Następna praca: wyjaśnić ścieżkę tych dzielników, zachować kwalifikację osobno od zgodności raw payloadów i dopiero przygotować kolejną kontrolowaną próbę.


## Kontynuacja 26.10.2026 — próba potwierdzająca v2 i wejście Universe

Pierwszy run `run-antenna-mpfr-20261026-01` pozostaje niezakwalifikowany.
Model dokładnych znaków v1 nie przeszedł późniejszego preflightu per-target;
żaden run v1 potwierdzający nie został zgłoszony. Różnice −2/−2/+2/+2 dla
punktów 0/4/8/9 wynikały z zaokrąglonych predykatów binary64. Niezależny
odczytowy przegląd potwierdził osiem krawędzi; zgodność sum globalnych
ukrywała lokalne różnice. Zachowano źródło, oczekiwania i status błędu v1.

Model v2 wyznacza geometrię przez Fraction i oblicza wyłącznie predykaty
logarytmicznych gałęzi w binary64 oraz libmpfr 427/533 bitów RNDN; nie
rozwiązuje pola i nie odczytuje liczników nowego wyniku. Przypięto model,
wyjściowy JSON, bibliotekę MPFR, flagi kompilacji, źródło konwersji Boost,
FEM library/worker/receipt i referencję. Przeszło 351 kontroli dodatnich
oraz mutacji liczników i odmów. Walidacja noty i source-map: kod 0.
To orakel kontraktu pracy implementacji, nie niezależne potwierdzenie H.

Nowy `run-antenna-mpfr-confirmatory-v2-20261026-01` zakończył się succeeded.
Task: `task-7db7d7ae980867760d8aa1f0fddf7bef5ef4c7b168714be87ff88fbc3048305e`;
attempt: `attempt-ffeb99a13c9043be8ca5919ddd115edf`, epoch 1.
Bundle: `84e0867160f5911575d8e5b1357a898dee1b6f03006ad46f2af6d987ffee7873`.
Porównanie: PASS; 21/21 naukowych payloadów byte-identical z referencją;
liczniki według modelu; diagnostyki binary64 bez zmian; wszystkie pozostałe
liczniki poza opisaną rezerwacją zgodne. Zachowano pełną obserwację żywego
workera i jego mapowania FEM oraz dodatkową obserwację mapowania MPFR.
Protokół: `57979088fd40a9bac6b65b0a81c2e8dac389dd79feeb6e387ad40438faf53c3e`.
Porównanie: `5af42d2d8abd1a90dfa012520114dff05d3df08803d42ae7759275242644a83f`.
Operator: 95.632500854 s, lifetime peak RSS 538775552 B. Nie wykonano B–C–B;
nie deklarujemy ogólnej kwalifikacji wydajności lub nowych geometrii.
Runtime nie publikuje macierzy target×precision; obserwowane są jej marginesy.
Dowody: `verification/antenna-mpfr-confirmatory-v2-20261026/` w wolumenie grupy.

Pierwszy Submit pełnego Universe `run-antenna-universe-mpfr-20261026-01`
odrzucono HTTP400 przed utworzeniem runu (późniejszy autorytatywny GET404).
Przyczyną był brak `study.execution_profile` w osobnym dokumencie sceny,
który nie odpowiadał zamrożonej definicji. Nie obchodzono bramki archiwum.
Dokument odtworzono z exact frozen definition.scene. Pozostałe wpisy ZIP,
StudyPlan, ProblemIR, siatki, immutable assets i specyfikacja fizyczna są
identyczne. Źródłowa definicja, a nie późniejszy widok FMS, jest właścicielem.
Istniejący runtime-free endpoint `run-intent` potwierdził HTTP200 i RunSpec
identyczny poza run_id. Przy porównywaniu ZIP trzeba otwierać świeże czytniki;
przekazanie tego samego ZipInfo do writestr zmienia jego offset w pamięci.

Naprawione wejście ma hash
`923efd35b14f91a68bcaf1834f374f7e306db4c2bda3d16e7e06c60afb7c48f5`.
Procedura dla `run-antenna-universe-mpfr-20261026-02` jest uruchomiona;
przyjęcie i zakończenie wymagają odczytu bieżącego stanu, nie wynikają z tego
wpisu. Bez automatycznych ponowień i bez zmiany limitów. Domena Global ma
1162 węzły/6548 Tet4; niezależny przewodnik 677 węzłów/1859 Tet4. Pełne pole
oraz jego wyświetlenie w UI nadal nie zostały potwierdzone.

Osobny commit schedulera `c0dcc2d587c4ee97674be29899300d02f5246b68`
obejmuje pięć przejrzanych plików i 127 kontroli źródłowych. Cztery źródła
runtime są identyczne z już zbudowanym cieniem. Dwa wcześniejsze wpisy
współdzielonego indeksu zachowano bez zmiany. Nie jest to osobny build
czystego HEAD ani kwalifikacja wydajności schedulera.


Bieżący odczyt po kanonicznej naprawie: HTTP201 Submit, HTTP200 materialization,
`run-antenna-universe-mpfr-20261026-02` ma lifecycle **running**.
Task `task-c26227af3111378b8457ac9191d567437edd0f857114e2b31330973d71a49124`,
attempt `attempt-4db486ff90504edbadd497e6bd376c69`, epoch 1.
Zachowano obserwację rzeczywistego workera PID32480 i FEM SONAME o przypiętym
SHA256. W chwili odczytu proces był R, czas CPU80.65s, elapsed74s. To dowód
trwającego wykonania, nie ukończonego pola. Monitor tego samego runu działa;
nie wolno wnioskować o zakończeniu z wygaśnięcia obserwacji ani uruchamiać
kolejnej próby automatycznie. Artefakty i status w
`verification/antenna-mpfr-20261026/full-universe-canonical-scene-replay/`.
