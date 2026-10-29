# Domknięcie integracji eigensolve i UI — checkpoint

## Cel i warunki zakończenia

Użytkownik zlecił dokończenie planu, integrację z masterem i sprzątnięcie worktree.
Nie utożsamiamy ukończonego R6 ze scaleniem PR ani pełną kwalifikacją naukową.
Kolejność: uzgodnienie źródeł → review i CI → weryfikacja zintegrowanego runtime
→ merge PR → aktualizacja mastera przy zachowaniu WIP → drain grupy i cleanup
wyłącznie zweryfikowanego worktree i prywatnych zasobów. Bez kasowania wyników.

## Aktualna baza

- Gałąź: `codex/eigensolve-integration-ui-20261026`, PR #262.
- Początek etapu: `6a71b3142d666989408d0db68f787b2fa36ca26e`.
- Pobrany master: `c276a163ba` (pełny SHA w merge commicie).
- Rozbieżność początkowa: master 369 / branch 176 commitów; 419 plików PR.
- 14 plików wcześniejszego WIP worktree i 20 plików współdzielonego mastera
  skopiowano wraz z hashami do zewnętrznego checkpointu `final-integration-20261029`.
  Nie stage'owano ich ani nie resetowano głównego checkoutu.

## Rozwiązania konfliktów (29 plików)

- Frontend: zachowano modalne sterowanie i nowsze helpery geometrii bez pola.
  Duży konflikt testu był głównie formatowaniem; trzy wersje sparsowano
  TypeScript-em i znormalizowano bez kompilacji. Zachowano testy obu gałęzi.
- Telemetria: zwijane metryki w wynikach oraz nowe postępy anten z mastera.
- Timeout proxy: budżet faz z mastera, limit archiwum FMS z brancha; oba testy.
- Runner: Relax handoff i Frozen Spins mają odrębne argumenty oraz guardy.
  Centralny materializator runtime-control rozpoznaje dokładny port certyfikatu
  równowagi FEM; wrapper API deleguje do wspólnej implementacji.
- Retirement: nowszy importer-issued observation proof z mastera zastępuje
  starszą lokalną implementację imported_read_only; zachowano bounded retry
  otwarcia store/ledger. Nie omijamy dowodu importera ani lease.
- Przygotowanie: masterowy spójny dowód nieudanej preparacji i wcześniejsze
  helpery/regresje diagnostyczne; porty modalne i publikacja zachowane.
- FMS: zachowano staged/spawn_blocking import, modalną walidację, nowszą
  projekcję zaakceptowanej definicji i prywatny dowód geometrii anten.
  Testy Compact/Solved oraz pustych CAS assets pozostają niezależne.
- Launcher: zachowano exact failed-worker recovery i nowsze preowner/catalog
  recovery; wielozadaniowy katalog jest walidowany, nie zredukowany do 1 zadania.
- Diagnostyka: redagowany structured worker observation, reporty MFEM/MPI,
  guard brakującej próbki zasobów oraz oryginalna granica worker error chain.

## Stan dowodów

Składnia wszystkich konfliktowych Rust/TS/Python PASS (parsery, bez lokalnej
kompilacji testów). `git diff --check` PASS. To nie zastępuje kompilacji,
review ani uruchomienia po scaleniu; wymagane są aktualne CI w GitHub Actions.

R1–R6 mają wcześniejsze dowody UI, w tym 14 rodzajów operacji podczas realnego
solvera w dwóch kwalifikujących przebiegach. Wymagają oceny wpływu integracji.
Pozostałe stare fragmenty solvera I1/I6 oraz kwalifikacja I7 mają oddzielne
otwarte pozycje w planie; nie oznaczono ich jako ukończonych przez ten merge.
PR pozostaje draftem; cleanup nie został uruchomiony.


Uwaga o współbieżności: podczas etapu zewnętrzny writer zmienił lokalny
`FooterTelemetry.tsx` w głównym checkoutcie. Oryginalna kopia pozostaje
zachowana, a bieżący plik mastera nie był przez ten wątek zapisywany.
Staged diff merge'a zawiera też wcześniejsze whitespace w dokumentach
pochodzących z mastera; nie przerabiano historycznych plików patch.


## Pierwsze pełne CI po merge

UI: 1459 testów PASS / 1 FAIL — ujawniono ciche nadpisanie budżetu proxy
przez transport FMS. Naprawa łączy oba ograniczenia w jednej konfiguracji.
Pełny lint ujawnił synchroniczne odtwarzanie preferencji w efekcie; użyto
leniwego odczytu i useSyncExternalStore z serwerowym snapshotem hydracji.
Rust: uzgodniono brakujące/nadmiarowe argumenty łączące Relax i Frozen Spins,
identyczny helper fixture'u FMS zduplikowany przez scalanie testów oraz nowy
opcjonalny external_cas w fixture ArchiveWalker. Python: usunięto podwójne
zadeklarowanie --stop-only. Nie osłabiono oczekiwań, progów ani testów.
Kompilowane testy pozostają wyłącznie w GitHub Actions.


Drugi przebieg: 1460 testów UI PASS, typy i architektura PASS; React Doctor
wskazał jeszcze browser-dependent branch szerokości. Odczyt szerokości
przeniesiono do pierwszego pomiaru layoutu requestAnimationFrame i zdarzeń
resize, z identyczną wartością początkową po stronie SSR/klienta. Nie wyciszono
reguły. Fixture pre-admission uzupełnia teraz pełny interfejs BuildControl
(namespace_registry=None), zamiast osłabiać kontrolę namespace w produkcji.

Przy inwentaryzacji zastano obie usługi grupy zakończone exit255 o 07:24:39 UTC,
bez OOM i bez błędu Dockera w State.Error. Nie przypisujemy zatrzymania
zmianie Next config; wymaga ono osobnej kontrolowanej ścieżki wznowienia.


Pełny frontend: 9393 PASS / 7 FAIL. Pięć awarii wynikało z braku rzeczywistego
SelectionController w fixture powłoki; diagnostyka wymaga teraz zakładki
Diagnostics. Zachowano asercje statusu i wyraźne rozróżnienie fₙ(k) / A(k,f).
Kompilacja API ujawniła nowy allow_operation_profile (dla modalnego false),
terminal_publication (modalny bundle nie publikuje terminalnego stanu czasowego)
oraz brakujące opcjonalne pola i cache w starszych fixture'ach. Uzupełniono
inicjalizatory zamiast usuwać walidację i testy. Te poprawki wymagają kolejnego CI.


Browser smoke ujawnił brak semantycznej etykiety splittera Inspector oraz resetu
rozmiaru w nowym drzewie. Uchwyty nazywają teraz sąsiednie panele. Double-click
odtwarza domyślny układ: remount dotyczy wyłącznie anchorów i splitterów;
WorkspaceWindow pozostają w stabilnej warstwie. Browser gate nadal sprawdza
360/416/560px i reset, ale względem początkowego rozmiaru nowego dock layout,
a nie hardkodowanego dawnego 416px. Weryfikacja runtime po scaleniu otwarta.


Trzeci przebieg: kontrola SSR nadal śledziła localStorage z leniwego inicjalizatora
stanu aż do drzewa. Inicjalizacja tree/explicitDocked/restored ma teraz wyłącznie
stałe wartości. Preferencje i szerokość są ładowane razem w pierwszej klatce
layoutu; zapis preferencji pozostaje wyłączony do zakończenia tego odczytu.
Nowa regresja porównuje markup serwera przy obecnym/nieobecnym window i wymaga
zera odczytów localStorage podczas renderu. Nie wyłączono reguły doktora.
Fixture frontend volume aktualizuje niezależnie wyliczony digest o metadata
files, zgodnie z bieżącym kluczem produkcyjnym (guard label drift zachowany).


Browser smoke po korekcie uchwytów przeszedł Inspector resize/reset i dotarł do
wykresów. Stary odczyt wymagał jednoczesnego pokazania identity/field/resource
w jednym panelu. Aktualny test przechodzi przez Data (sample/mode/field),
Provenance (exact resource) i Diagnostics (niezależne residuale), a potem wraca
do Overview. Zachowuje wcześniejsze asercje właściciela JSON, generacji,
equilibrium i indeksu źródłowego rzeczywistego kliknięcia ECharts.


## Korekta pomiaru dysku i wznowienia runtime

Pomiar `df /` dystrybucji WSL (6,5 GiB) nie opisywał filesystemu demona
Docker Desktop. Kanoniczny `BuildControl.space` potwierdził 300818042880 B
wolnego w VM Dockera (około 280 GiB); fizyczny C: z DataFolder Dockera ma
około 165 GiB wolnego. Prośba o 30 GiB sprzątania WSL była nieuzasadniona.
Nie obniżono progu 32 GiB i nie usunięto żadnych danych.

Resume `40a38150f556478682c8ae027d8acb0b` zakończył się failed-confirmed:
stary obraz nie zawiera GMP/MPFR wymaganych przez nowy master. Kanoniczny
bootstrap Compose zakończył `toolchain` sukcesem, attempt
`2b267de511f64ead930925e0ca4a08ac`, image
`sha256:84bd740324c9c498cd23b4fdeb026603e5e039073b2fc31ec126f56878517d67`.
Recepta wymaga teraz kontrolowanego odtworzenia usług z tym toolchainem.

Browser CI ujawnił rzeczywisty pusty Provenance przy bezpośrednim wyborze
legacy EigenModeInspectorPanel. Mod publikuje teraz własny panel provenance
(run/stage/equilibrium/revision/sample/mode/field/resource) zarówno dla tego
route'u, jak i physics-first. Wrapper deleguje tę zakładkę zamiast dublować
metadane. Browser gate sprawdza aktywną zakładkę własnego panelu modu.


Kontrola wszystkich inicjalizatorów HostResourceReservation wykazała jeszcze
jeden stary fixture w failed_worker_recovery::tests::reservation (wykrywany
przez feature runtime-service-control CI). Dodano opcjonalny pin recovery=None.
Obraz CPU bramek MFEM również nie instalował GMP/MPFR wymaganych przez wspólny
CMake; dodano późną warstwę z tym samym pinem MPFR co w obrazie GPU oraz
pkg-config preflight. Weryfikacja natywna wyłącznie w GitHub Actions.


## Recovery failed admission — luka producent/konsument

Build i API ukończone; admission failed-confirmed b1b3dd2c031b41778d6d8983e765ca7e,
config 9788eca276e839741b6b291812003037802d50aee7fa2b662646093c2e7abc05.
Native OWNER Ready pochodzi z innego buildu. Obserwacyjne resume
9869254e01c9445d9977ce1ddec89a70 potwierdza ten sam target/build mismatch;
nie restartowało backendu i nie ponawiało Solve. Stop-bootstrap odmówił przed
mutacją, ponieważ failed development nie ma top-level container IDs, które
_finish publikował dopiero po readiness. Oba receipty mają ten sam cgroup Ready.

Naprawa publikuje IDs przed wait/publication. Dla historycznego failed start
stop-bootstrap wymaga świeżych IDs w nowym resume, identycznego cgroup i
StartedAt z wcześniejszego development, pełnego config/source/image binding
oraz wszystkich istniejących live probes. Succeeded z brakującymi IDs,
zmieniona inkarnacja i sprzeczne obecne IDs nadal są odrzucane. Żaden stary
receipt nie jest zmieniany; fallback ma prawdziwe, odrębne pin_sources.
Dziewięć nowych testów tego kontraktu dodano do GitHub Actions; lokalnie tylko AST.

Rust CI wykazał cztery regresje utraty szczegółu powodu niedostępnej próbki
hosta w Display. Context zachowuje teraz reason również w Display i nadal
zachowuje ComputeNodeSampleNotCurrent jako typed source; dodano asercję typu.
Browser zachowuje test residualu względnego i wymaga braku niepublikowanego
Absolute residual, zgodnie z nowym UI (null w fixture oznacza brak wiersza).

I6 — dalsze konkretne ustalenia do naprawy: runtime guard pustego selektora
Floqueta jest sprzeczny z plannerem (pusty oznacza wszystkie pary); guard k
powinien używać tej samej maski osi co certyfikat v6, łącznie z translacyjnym
fallbackiem przy braku axis_hint. Producent v6 używa eager then_some(nonzero[0]),
co może spanikować przy pustej liście osi. Historycznego WIP nie można przenieść
wprost: uwzględniał tylko axis_hint, a obecny certyfikat wspiera też translację.
Te punkty i native tracking provider pozostają otwarte; nie oznaczono I6 jako PASS.
