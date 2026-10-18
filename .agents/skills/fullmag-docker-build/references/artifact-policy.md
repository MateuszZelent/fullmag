# Kontrola danych builda — kontrakt operacyjny

Czytaj przy pierwszym buildzie, zmianie recept/launcherów, diagnozie wzrostu
zajętości i wycofywaniu grupy. To kryteria wdrożenia, nie deklaracja, że aktualny
launcher je egzekwuje. Audyt Compose obejmuje tylko część tej granicy.

Bieżące funkcje i niezgodne miejsca zapisu wskazuje
[audyt writerów](writer-inventory.md). Zweryfikuj je ponownie po zmianie kodu.

## Jeden właściciel i jedno miejsce dla każdego zapisu

Dla każdej recepty prześledź zależności, wrappery, subprocessy i narzędzia do
końcowego procesu zapisującego. Rejestruj: komendę, fazę, writer, efektywną
ścieżkę, mount/volume/image, właściciela, klucz ponownego użycia, maksymalną
liczbę kopii, konsumentów, warunek usunięcia i dowód. Niezidentyfikowany writer
lub ścieżka oznacza `NOT VERIFIED`, nawet gdy końcowy Compose przechodzi audyt.

Sprawdź też recepty, których nazwa nie zawiera `build`: start, run, test,
check, codegen, docs, release, benchmark i bootstrap mogą kompilować lub
pobierać zależności. Oddziel trasy DEV, release/CI i legacy; obecność recepty
w `justfile` nie czyni jej dozwolonym fallbackiem DEV.

| Klasa | Docelowa kontrola powielania |
| --- | --- |
| Źródła | Jeden readonly checkout + jeden synchronizowany cień na profil. Kopiuj tylko zmienione pliki; usuwaj z cienia pliki usunięte ze źródła, nie cache. Bez pełnego snapshotu/archive na każdy run. |
| Kontekst Docker | Minimalna allowlista i `.dockerignore`; bez storage, target, node_modules, VHDX, sekretów, `.git` poza wymaganymi danymi wersji. Generowany kontekst w volume, identyczna treść ponownie użyta. |
| Toolchain | Przypięty digest/wersje; nowa generacja tylko przy zmianie rzeczywistych wejść. Wspólne immutable warstwy mogą obsługiwać kilka grup. |
| Cargo/CMake | Stałe ścieżki i cache zależne od toolchaina/profilu/ABI; commit, port, czas i UUID uruchomienia nie tworzą nowego targetu. Zmiany kodu obsługuje system przyrostowy. |
| pnpm/Next/Python | Jawne store, node_modules, `.next*`, Corepack, pip/uv, venv i `__pycache__` w Docker-managed miejscu; frozen lockfile. Ponowny start bez zmiany wejść nie tworzy nowego workspace. |
| Publikacja aplikacji | Jeden bieżący pakiet, jeden zweryfikowany rollback i najwyżej jeden aktywny kandydat pod blokadą. Cache-hit nie kopiuje ani nie pakuje ponownie aplikacji. |
| Eksporty | DEV nie produkuje wheel/ZIP/TAR/OCI-export per start. Artefakt wydania tylko na jawnej trasie release, raz na tożsamość wejść; eksport na host tylko gdy zamówiony. |
| Kontrola i diagnostyka | Jeden manifest opisujący wejścia, niewielki rekord próby; odwołanie do hashy zamiast ponownego osadzania pełnych manifestów/logów. Jawny budżet rozmiaru/liczby rekordów. |
| Tymczasowe | Osobny katalog operacji w volume, bounded tmpfs tylko dla małych ulotnych danych. Cleanup po sukcesie/błędzie; osierocone katalogi wymagają identyfikacji operacji i dowodu braku procesu/lease. |

Nie wprowadzaj deduplikacji przez hardlink między mutowalnym targetem Cargo a
uruchamianym pakietem: późniejszy zapis może zmienić aktywne binarium. Immutable
blob/CAS lub reflink wymaga wykazanej niezmienności, poprawnej publikacji i GC
referencji; nie jest warunkiem wdrożenia prostego modelu current + rollback.

## Zapisy niewidoczne w tabeli mountów

Sprawdź rzeczywiste środowisko procesu i rozwiązywanie symlinków: `HOME`,
`XDG_CACHE_HOME`, `CARGO_HOME`, `CARGO_TARGET_DIR`, `RUSTUP_HOME`, `TMPDIR`,
`TEMP`, `TMP`, pnpm store, `COREPACK_HOME`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`,
`CUDA_CACHE_PATH`, cache kompilatora i Playwright. Wartości domyślne narzędzi
też są writerami. Override wskazujący `/state` nie staje się dozwolony dlatego,
że ten mount jest prawidłowy dla wyników symulacji.

Obejmij audytem Docker daemon logs, BuildKit build history/cache mounts,
warstwy obrazów, zatrzymane kontenery, buildx buildery oraz hostowy launcher
(stderr/stdout do pliku, `TemporaryDirectory`, wygenerowany Compose/env,
receipty/index, profile debuggera i core dumpy). Szybki `--help` lub dry-run może
wykonać setup przed parsowaniem argumentów — najpierw czytaj implementację.

Technical CUDA JIT/cache, frontend `/state/development` i build receipts nie
są wynikami użytkownika tylko dlatego, że leżą pod `/state`. Zachowaj Windows
wyłącznie provenance wymagane przez runtime konkretnej symulacji. Techniczne
provenance builda (w tym obecny hostowy handoff) należy do volume. Przenoś techniczne dane
builda/cache. Uprzywilejowane maintenance `nsenter` i host ledger mają osobny
kontrakt. Migracja nie uprawnia do montowania Docker socketu w aplikacji.

Rotacja logu w aplikacji nie ogranicza kopii utrzymywanej przez Docker logging
driver. Sprawdź efektywny driver i jego limit bajtów/plików. Nie zapisuj tego
samego pełnego strumienia równolegle w kilku miejscach bez uzasadnienia.
Sekrety nie mogą trafić do manifestu, logu, image layer lub renderu zapisanego
jako dowód. Hostowy `.env` to konfiguracja operatora, nie produkt buildu.

## Retencja jest częścią operacji, a nie późniejszym globalnym prune

Budżety bajtów/generacji i reserve muszą być jawne w konfiguracji oraz
sprawdzane przed alokacją. Nie wymyślaj uniwersalnej wartości GiB. Rozmiar
pierwszego buildu jest estymacją; mierz peak, nie tylko stan po zakończeniu.
Gdy bezpieczne usuwanie nie zwolni wymaganej rezerwy, zatrzymaj alokację z
konkretną diagnozą. Nie kasuj aktywnego cache dla sztucznego zmieszczenia buildu.

Do decyzji GC używaj grafu referencji: aktywne procesy i kontenery (także
zatrzymane z zaplanowanym wznowieniem), mounty, lease, bieżący pakiet, rollback,
wyniki/projekty i wymagane dowody. Sam wiek lub inny commit nie dowodzi zbędności.
Po awarii publikacji zachowaj działający pakiet; cleanup nigdy nie powinien
wymagać usunięcia go przed weryfikacją następcy.

Retencja metadanych nie może oznaczać nieskończonego archiwum `.retired`.
Zachowaj dowody potrzebne do odtworzenia wyników i aktywne receipty. Pozostałe
rekordy podlegają jawnej polityce agregacji/rotacji; ustaw limit zanim nazwiesz
retencję kompletną. Symulacyjne provenance i ledger nie są logami builda do GC.

## Cztery różne operacje żywotności

| Operacja | Efekt wymagany w DEV |
| --- | --- |
| Restart backendu | Cache i wolumeny pozostają; weryfikacja wejść, przyrostowy build tylko gdy potrzebny. |
| Odtworzenie/usunięcie kontenera | Warstwa zapisywalna kontenera znika; named volumes, obrazy i BuildKit pozostają. To **nie jest sprzątnięcie builda**. |
| Usunięcie build-data jednej grupy | Osobna jawnie autoryzowana operacja na wyliczonych nazwach/etykietach build volumes po kontroli wszystkich konsumentów; cache tej grupy zostaje utracony. |
| Usunięcie nieużywanego toolchaina/BuildKit | Oddzielna decyzja dla współdzielonych danych; skasowanie grupy nie uprawnia do usunięcia zasobów innych grup. |

Nie podawaj `docker compose down -v` jako uniwersalnego cleanupu: usuwa także
inne zadeklarowane wolumeny i nie usuwa wszystkich danych BuildKit/external.
Utwórz preview dokładnych celów, potwierdź role i własność, następnie wykonaj
wyłącznie zatwierdzone cele. Brak bezpiecznej komendy w launcherze to luka do
wdrożenia, nie powód do wymyślenia działającej recepty. Dane Windows użytkownika
oraz ledger pozostają poza zakresem tej operacji.

Przed usunięciem volume zawierającego receipt zachowaj minimalny dowód operacji
w pozostającym Docker-managed rejestrze; nie archiwizuj tam usuwanych binariów.
Jeżeli także rejestr ma być usunięty, uzgodnij wymagany zakres dowodu; nie obiecuj
trwałego receipt bez istniejącego miejsca zapisu. Usunięte bajty wewnątrz VM nie
muszą od razu zmniejszyć fizycznego VHDX na Windows. Raportuj oba pomiary osobno.

## Próby odbiorcze dla mechanizmu, nie wyłącznie instrukcji

1. Zimny start: spis wszystkich zapisów i peak zajętości, runtime dane Windows
   oddzielnie. Nie wystarczy `docker inspect` po buildzie.
2. Kilka restartów identycznych wejść: stałe volume IDs, brak nowych pełnych
   źródeł/pakietów i brak wzrostu poza zadeklarowanym budżetem małych rekordów.
3. Edycja backendu, frontend HMR i uruchomienie innego `.py`: nie tworzą nowego
   cache ze względu na run/port; rzeczywiste zmienione wejścia są w provenance.
4. Przerwanie kopiowania/kompilacji/publikacji oraz ENOSPC w izolowanym fixture:
   ostatni zweryfikowany pakiet pozostaje, osierocony staging jest wykrywalny.
5. Dwie grupy jednocześnie: oddzielne mutable cache i settings, współdzielony
   immutable toolchain; GC jednej nie usuwa referencji drugiej.
6. Odtworzenie kontenera: porównaj przed/po dokładne nazwy, labels, driver
   i ownership volumes; cache przetrwał. Oddzielny autoryzowany cleanup grupy:
   usunięte dokładnie build volumes, dane użytkownika zachowane.

Ciężkie próby wykonuj dopiero przy zleceniu implementacji/kwalifikacji i zgodnej
trasie. Dla samego audytu/skilla opisuj je jako `NOT VERIFIED`; nie uruchamiaj
symulacji ani destrukcyjnego ENOSPC na działającym środowisku.
