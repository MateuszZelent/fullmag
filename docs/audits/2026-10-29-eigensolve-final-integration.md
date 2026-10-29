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


## Natywny Floquet/SLEPc — aktualny dowód CI

Workflow 40865035881, job 123417530842, źródła 97e94e906, profil
floquet-modal-slepc: obraz CPU z GMP/MPFR i kompilacja kontraktów ukończone.
CTest: 19/21 PASS, dwa FAIL. Artefakt GitHub zachowany
fem-cpu-source-contract-floquet-modal-slepc-40865035881-1 (457782 B ZIP).

- fem_floquet_modal_solver_contract: explicit multi-mode refill kończy partial
  z floquet_nev_refill_outer_iteration_budget_exhausted mimo dwóch zaakceptowanych
  modów; trzeba prześledzić goal/outer budget i fixture. Nie zwiększono budżetu
  ani nie zmieniono oczekiwania w ciemno.
- fem_modal_eigen_hard_ksp_nearest_contract: nie spełnia łącznej asercji stop reason
  / failure-only scalar callback probe przy twardym błędzie KSP; dokładny
  niespełniony składnik wymaga dalszej diagnostyki. Potrzebne review
  przepływu awarii i metadanych, a nie poluzowania residualu.

Oba są otwartymi konkretnymi punktami I6. To nie jest PASS pełnej ścieżki
natywnej ani kwalifikacja naukowa. Nie ponowiono identycznego joba bez poprawki.


## Recovery zastosowane i korekta rozpoznania miejsca

CI źródeł 38079580c: python-contracts 123431887364 i control-room-contracts
123431887066 zakończone SUCCESS. Dziewięć regresji stop-bootstrap wykonano
w kroku Python GitHub Actions; lokalnie nie kompilowano ani nie uruchamiano testów.

Świeża obserwacja resume ad7d5bd5dfef43a5b7bb24c6eec9fd45 nie restartowała
backendu. Zachowała inkarnację e6ab0da98540, StartedAt
2026-10-29T11:13:16.581353245Z i opublikowała pełne IDs przed odmową admission.
Stop-bootstrap d2797c1d2df047faa9bd4db5fb0eb501: SUCCEEDED, stopped-confirmed.
Zatrzymano wyłącznie własny diagnostyczny backend. OWNER hash przed/po
fe65b122ce8c13be9364b408c0f5d0a771734bde03de79e35497f51245eb0585 jest identyczny;
sesje i resource leases untouched. Native execution pozostaje unknown,
a nie fikcyjnie drained. Frontend nadal działa, ale nie jest to dowód działającego solvera.
Kolejny krok wymaga legalnego recovery starego native OWNER; samo stop-bootstrap
nie udziela prawa do skasowania OWNER lub obejścia jego weryfikacji.

Korekta wcześniejszej diagnozy dysku: df / dotyczy dystrybucji WSL (~6,5 GiB).
Demon Docker to Docker Desktop; BuildControl.space dla własnej grupy raportuje
300818042880 B dostępnego (~280 GiB), ponad próg 32 GiB. Docker DataFolder
C:\ProgramData\DockerDesktop\vm-data ma około 165 GiB wolnego na Windows.
Wycofano prośbę o zwolnienie 30 GiB WSL. Niczego nie usunięto.

Browser CI 123431887164 przeszedł poprzednie kontrole mode/viewport, ale zatrzymał
się na przestarzałym odczycie owner identity w Overview dyspersji. Naprawiono
nawigację smoke do Provenance przed niezmienionymi asercjami run/stage/revision,
następnie do Data przed importem CSV. Nie usunięto testu importu/precyzji ani
asercji przypisania wyniku do właściciela. Nowy przebieg wymaga CI.

Bramka Rust 123431887588 dla 38079580c zakończyła SUCCESS po wszystkich
kontraktach. Generated API determinism, native modal C ABI, checkpoint Windows,
FDM qualification oraz Inspector actions browser smoke również SUCCESS.
Profile SLEPc w automatycznym bootstrap są SKIPPED, nie PASS; osobny ręczny
run 40865035881 pozostaje dowodem 19/21. Jedyną porażką automatycznego
bootstrap był browser-fixture-smoke opisany powyżej.


## I6 — poprawki wejścia Floqueta, 29 października

Naprawiono źródłowo trzy otwarte błędy: pusty selektor oznacza wszystkie pary
zgodnie z plannerem; każdy punkt k jest sprawdzany względem osi periodycznych;
wspólny resolver osi v6 nie indeksuje pustego Vec przy zerowej translacji.
Resolver zachowuje pierwszeństwo axis_hint i translacyjny fallback oraz cutoff
1e-15 m. Składowa k na otwartej osi musi być dokładnie zerowa, także poniżej
progu Gamma 1e-12 rad/m; nie zmieniono ani nie zaokrąglono k i progów residualu.

Rozszerzono istniejący test selektora i dodano trzy regresje signed/mixed/path,
translacji bez hintu oraz braku/zera/oblique/nonfinite translacji. Wszystkie
cztery funkcje jawnie objęto CI. Lokalnie wykonano tylko rustfmt --emit stdout
(parsowanie), JSON i diff-check. Native provider trackingu, dwie porażki CTest,
kwalifikacja runtime i nauki nadal są otwarte. Nie oznaczono całego I6 jako PASS.
Dokument 0600 i source map opisują nowe warunki bez deklarowania fizycznej
kwalifikacji. Master 6caa3e226 scalono bez konfliktów jako 2bf23f6ff; chronione
14 plików WIP pozostały byte-for-byte identyczne. Usunięto wyłącznie pustą linię
na końcu testu dostarczonego przez master, aby diff-check przechodził.

Uwaga do hooka: commit 6cce2aadd i merge 2bf23f6ff uruchomiły React Doctor.
Zgłosił odpowiednio 8 ostrzeżeń w starych częściach smoke-analysis-plots oraz
3 ostrzeżenia w RealtimeInvalidationBridge z mastera, poza czterema dodanymi
liniami nawigacji testu. Hook nie blokował commitu. Nie dodano suppressions ani
nie obniżono bramek. Ocena tych wskazań pozostaje oddzielna od zielonego CI.


Natywny refill: znaleziono różnicę między domyślnym celem N i jawnym celem N
mimo identycznej zaakceptowanej puli. Jawny cel równy requested_mode_count ma
teraz tę samą semantykę co domyślny; mniejszy best-effort zachowuje dawną bramkę
EPS. Nie zmieniono NEV/NCV/MPD, budżetu 160, residualu 1e-10 ani certyfikacji
per-mode. Test dodatkowo wymaga obu niezależnie znanych częstotliwości. EPS
reason i iteracje pozostają widoczne; count fulfillment nie daje kompletności
okna. Wymaga potwierdzenia natywnym CTest w CI.

Druga porażka nearest KSP dostała wyłącznie ograniczoną diagnostykę składnika
asercji (status/probe/callback/stop reason/true probe attempts), bez zmiany
oczekiwań. Dotychczasowy log nie zawierał tych wartości. Ponowienie profilu
po tej zmianie jest zbieraniem brakującego dowodu, a nie ślepym rerunem.
Context7 nadal odmawia z powodu miesięcznej kwoty; oficjalna dokumentacja
SLEPc EPSSetDimensions nie uzasadniała zgadywanej zmiany NEV/NCV, więc jej
nie wykonano: https://slepc.upv.es/release/manualpages/EPS/EPSSetDimensions.html.


Browser run 40872170503 przeszedł nawigację Provenance i poprawny import CSV.
Następna asercja po odrzuceniu pliku ponad 4 MiB nadal odczytywała owner jako
widoczny tekst w Data. Frame publikuje teraz stabilne semantyczne atrybuty
run/stage/artifact revision na każdej zakładce; test czterech zakładek zabezpiecza
ich przypisanie. Smoke sprawdza wszystkie trzy identyfikatory po odrzuceniu,
pozostawiając Data zamontowane, żeby nie skasować błędu/wyboru pliku przed
screenshotem. Zachowano test braku File.text dla za dużego pliku, braku POST,
czyszczenia poprzednich kontrolek i dokładnej tożsamości wybranego węzła.


## Decyzja runtime na podstawie zwolnionych zasobów

Istniejący read-only _released_snapshot dla bieżących mountów e6ab0da98540:
active_count=0, 20 rezerwacji hosta i 20 lokalnych leases. Każdy wpis released
ma zweryfikowany autentyczny release proof. SHA-256 kanonicznej obserwacji:
5ae150bf14d1e6e71ee0d51b73d4dcf08e26da60e99c6f4a1b1f227193a52ed0.
To aktualny dowód braku aktywnych zasobów, nie domniemanie z OWNER Ready.
Docker ma obecnie 223374323712 B wolnego, nadal ponad 32 GiB.

Następna operacja: istniejące canonical recreate-volume --fresh-state dla
b1b3dd2c031b41778d6d8983e765ca7e / config 9788eca276e839741b6b291812003037802d50aee7fa2b662646093c2e7abc05,
source_root tego worktree, port 3217. Zachowuje cały dawny runtime-control
atomowym archiwum, stare state_root oraz ledger; usuwa tylko dwa własne
kontenery e6ab0da98540 i 5979f13fe9d6, następnie buduje nowy runtime w tej samej
grupie. Nie edytuje ani nie usuwa historycznego OWNER i nie udaje drained.
Dane fizyczne i historia pozostają dostępne, a nowy namespace nie przejmuje
starego właściciela. To jawne odtworzenie nowego runtime, nie recovery aktywnego
native lease (żaden nie jest aktywny).

Przed operacją potwierdzono odtwarzalne archiwum signed15:
/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/eigensolve-modal-updated-signed15-20261027/de-signed15-with-references-20261028.fms
size=158456496, SHA-256=2338882b585bc40f9911ec3334676e672cb23c2a55448d4945e711533b57b6cf, ZIP entries=349, integralność PASS.
Po starcie wymagane jest przywrócenie tego modelu/importu, a następnie nowe
obliczenia i R6; pusty backend ani sam stary import nie zamykają celu.


## Bieżący runtime i rzeczywiste UI — dowód 29.10

Canonical fresh-state zakończył się SUCCEEDED: recreate 447b8d642dcb4682b5b783c0b5b90b91,
nowy development c2810c89e195482eac664f37379919a2, config
0b0db2898ea73851e0d8f659364832f624bfba43edd3dd9cb78207aec15aa2e7.
Runtime źródeł acb0330ea, snapshot d58fc8162ba1ecfea790ea422941e9df502aaba1609e4b99dbb4cff712c98fbc.
Nowy OWNER Ready potwierdza ten build i host c281; historyczny OWNER ma w
runtime-archives/447b… dokładnie ten sam SHA-256 fe65… co przed archiwizacją.
Nie dodawano kolejnej ścieżki recovery ani nie edytowano ręcznie OWNER.

Rzeczywisty import UI zwrócił HTTP 200: odzyskane 15 próbek, Γ=9,299249697 GHz.
Browser pokazał signed dyspersję z dwiema referencjami oraz rzeczywisty mod Γ
z widocznym samym filmem 40x40x10 nm. Fit mode działa; poprzedni skrypt używał
nieaktualnego Fit view. Weryfikacja końcowa: PASS, zero pageerror/HTTP failure,
WebGL contextLost=false, bufor 888x573. To odtworzone dane, nie nowe obliczenie.
Screeny i proof: final-integration-20261029/restored-runtime w katalogu artefaktów.

Nowa aktywacja Gamma frequency_window db0bdb00b71244ffb6c3528c6a43a811: succeeded,
run ffe91832… / request eigensolve-gamma-window-r6-acb0330ea-20261029-1.
Obserwator R6 zaliczył 14/14 operacji na tym samym running runie przed/po,
zero pageerror i numerycznych mutacji. RUN NADAL TRWA; nie zaliczono jeszcze
końcowego R6 bez completed i widma. Żywy worker PID 29195 potwierdzono w Dockerze
(17 min elapsed, ponad 22 min CPU); sam status API nie był podstawą czekania.

CI acb0330ea: Rust, Control Room i cały browser fixture smoke SUCCESS.
Dwie bramki dokumentacji odrzuciły brak tabeli source-code index dla ośmiu
nowych mapowań i niejednoznaczny bare symbol C++. Uzupełniono tabelę i prefiks
void definicji; rzeczywisty statyczny walidator 0600 PASS, bez zmiany walidatora.

Native CTest 40877529745: 20/21 PASS — refill poprawiony. Pozostałe FAIL dotyczy
wyłącznie błędnego żądania true_probe_attempt_count=0. Status error=4, stop reason,
failure-only serializer i callback są poprawne; licznik ma sześć prób i jawny
zakres całego EPS. Produkcyjny callback nie resetuje historii i ma prawidłową
bramkę nonpositive-default. Istniejący bezpośredni test KSP sprawdza breakdown
przed jakąkolwiek próbą oraz positive-default/build-breakdown z attempts>0.
Test C ABI wymaga teraz ścisłej spójności scope/liczników/ordinal i positive
default dla zapisanej próby; końcowy nonpositive callback nie może dodawać próby.
Zachowano error/stop reason, null norms i pozostałe asercje. Brak zmiany solvera,
macierzy lub tolerancji. Nowa asercja wymaga ponowienia CTest w GitHub Actions.

[Strukturalny checkpoint i dokładne identyfikatory](2026-10-29-eigensolve-final-integration.evidence.json).


## Kolejna obserwacja storage i kontraktu KSP

Świeży pomiar mountów backendu rozdziela `/state` (bind z WSL, około
6,5 GiB wolnego) od `/build` i runtime-control (named volumes Dockera,
około 186 GiB wolnego). Fizyczny C: ma około 69 GiB; wolna przestrzeń
wewnątrz wirtualnego dysku nie gwarantuje możliwości jego dalszego wzrostu.
Nie ma podstaw do żądania dodatkowych 30 GiB w dystrybucji WSL na build.
Nie usunięto danych. Odczyt `du` ma odmowy dostępu i nie jest kompletną
kwalifikacją wyników do retencji; cache uv/pip są jedynie kandydatami.

Native CI 40887820514 nadal ma 20/21 PASS. Jedyny fail wymagał, by candidate
zawsze był unavailable po hard KSP error. Log zachował jednak poprawną
obserwację z dodatniego callbacku 20 przed późniejszym MatSolve failure.
Test sprawdza teraz powiązanie zachowanej próbki z ordinalem ostatniego
true-probe; unavailable/null dotyczy braku dodatniej historii. Kod produkcji,
residuale, progi i przerwanie przy hard error pozostają bez zmian. Poprawka
wymaga kolejnego GitHub Actions; nie ogłaszamy 21/21 przed wynikiem.

Bieżący run Gamma `run-live-ffe91832f1f9a883c7ac8f0b227e89bbed56580f3304d119a6bfdef7734720be`
ma status running. Rzeczywisty worker PID 29195 zwiększa zużyty czas CPU;
nie jest to wyłącznie wiszący status API. Nie aktywowano drugiego runu ani
nie restartowano usług. Dowód 14 operacji R6 pozostaje zachowany wraz z
nieukończonym jeszcze oczekiwaniem na końcowe wyniki tej generacji.


## I6 — podłączony native P1 CSR, odbiór oczekuje

Provider Tet4/Prism6 i bounded immutable C ABI odtworzono z atomów historycznych.
Natywny CSR faktycznie wyznacza iloczyn M w serial/adaptive/bias tracking,
normalizacji i Procrustes transport. Nie użyto M^2 ani sidecaru ignorowanego
przez konsumenta. Starszy Rust Tet4 v1 pozostaje dla jawnej referencji i replay.
Nowe v2 ma czytniki Rust i niezależną kontrolę Tet4 w Pythonie: jednostki m^3,
pełne węzły, puste wiersze powietrza, mapy, CSR i typed hashe źródeł.

Review wykrył i naprawił brak source SHA w direct Compose: snapshot korzysta
ze wspólnego runtime build-info, a hosted profil MFEM testuje generated-header
route (DIRECT_COMPOSE=1). Dodano oddzielny no-MFEM unavailable profile.
Review wykrył też nierówne długości adjacent strict zip w nowym readerze
Python; poprawiono je przed wykonaniem testów. Statyczny parser i mapa naukowa
PASS; nowe testy i kompilacja native/Rust pozostają wyłącznie w GitHub Actions.
Zmiany nie rozszerzają produkcyjnego MeshTopology poza Tet4.

Run Gamma ffe91832… zakończył się failed o około 15:18 UTC. Relax ma succeeded,
eigen failed/disconnected i zero artefaktów modalnych. Nie ma nowej częstotliwości.
Backend i frontend pozostały healthy. Trwa diagnoza autorytatywnej przyczyny;
nie przypisujemy jej diskowi, solverowi ani panelom bez dowodu. R6 zachowuje
14 poprawnych operacji podczas pracy, ale wymaganego końcowego spectrum nie ma.
Wcześniejszy podpisany sweep15 i zrzuty UI pozostają odrębnym dowodem.


Autorytatywna diagnoza Gamma: worker exit1, bez timeout i stop request;
`frequency_window_subwindow_failed`, brak kompletnego bazowego klastra.
Brak dowodu awarii dysku lub przekroczenia limitu revision10000. Obcięcie
failure message do1024 znaków zgubiło window_certificate i dokładną przyczynę
pierwszego nieudanego podokna. Następny krok to bounded failure-only sidecar
przed truncation, następnie diagnoza tej samej fizyki i ponowny pilot.

Review kolejnego CI40897875054 ustalił błędny zakres odczytu fixture'u:
`candidate_operator_diagnostic` jest pod `last_true_probe`, nie bezpośrednio
pod failure_probe. Poprawiono depth-1 lookup; równość z faktycznym callbackiem
pozostaje sprawdzana. Nie zmieniono produkcji, KSP ani physical acceptance.


I6 checkpoint wypchnięty: `14fc9280e39a1551743a375a491257819012ce5e`.
Hosted source profiles: MFEM/directCompose40905285319, no-stack40905296548,
Floquet/SLEPc40905306186, method40905319431. Ostatni przeszedł nowe testy
Python v2 i mapę naukową; Rust1853PASS/1FAIL/1ignored wykrył złą kolejność
alokacji metryki przed odmową niecertyfikowanej równowagi. Naprawiono kod:
cache identity sprawdzamy przed solve, nowy native tracking powstaje dopiero
po zaakceptowanym completion i raw checkpoint. Oczekiwanie testu i gate
`uncertified_provided_equilibrium` pozostały bez zmian. Wymagany recheck CI.


## D1 — zachowanie przyczyny awarii przed obcięciem wiadomości

W prywatnym epoch modalnego workera dodano failure-only
`native_failure_diagnostic.v1.json` z ownerem run/task/step/attempt/epoch.
Nie zmieniono limitu publicznego failure_reason, RunError, statusów ani
katalogu zaakceptowanych wyników. Source marker diagnostics_json odpowiada
rzeczywistemu formatterowi native runnera. Limit wejścia parsera to 1 MiB,
certyfikatu 16 KiB, całego pliku 64 KiB; zapisywany jest rzeczywiście ograniczony
fallback, nie jego większy oryginał. Istniejący immutable writer zachowuje
create-new i fsync. Zwykła ścieżka FDM pozostaje bez nowego sidecara.

Certyfikat ma allowlist znanych scalarów, schedule summaries oraz niewielkich
list częstotliwości/ranków. Nie zapisuje pól przestrzennych, operatorów,
environment ani tokenów. Pierwszy failed subwindow zachowuje rzeczywisty
status i kody/flags EPS; `status=ok` nie jest przekształcany w failure na
podstawie samego stop_reason. `diagnostics_truncated` pozostaje jawne.
Review poprawił realny błąd fallback serialization oraz zbędną mutację FDM.
Hipotezę globalnego root odrzucono po odczycie callera: root=&attempt jest
już prywatnym epoch, a storage.data_root to osobny argument autosave_root.

Dodano regresje realnego rozmiaru zapisanego pliku przy pretty inflation,
niemutowalności, filtracji payloadów, markerów oraz dostępności metadanych.
Wykonanie wyłącznie GitHub Actions; managed/runtime zapis po nowej Gamma
pozostaje NOT VERIFIED. Nie uruchomiono ponownie pełnego okna bez tej naprawy.

Odczyt artefaktów hosted 14fc rozdzielił dwie przyczyny:
- MFEM 40905285319 i stub 40905296548: brak zamykającego #endif w teście
  snapshot C ABI (biblioteka zlinkowana); poprawka dodaje samo zamknięcie.
- SLEPc 40905306186: build/link oraz **21/21 CTest PASS**. Dopiero finalizacja
  CI próbuje automatycznie retire głównego checkoutu i jest prawidłowo blokowana.
  Cały workflow pozostaje failure; nie osłabiono ochrony main checkout.

To konkretne otwarte bramki integracji I6, nie dowód błędu nowego algorytmu
fizycznego. Podsumowanie z SHA logów/receiptów zachowano w pliku
2026-10-29-eigensolve-native-ci-failures.evidence.json. Poprawiany jest zakres
finalizacji ephemeral CI, z zachowaniem obowiązkowych production guards.


Finalizacja CI używa teraz istniejącego owner-finish(state=review) dla passed
main-checkout, z jawnym cleanup_state=not_applicable_main_checkout.
Managed worktree zachowuje state=completed i wszystkie guardy retire.
Nie zmieniono produkcyjnego storage/retirement API. Atexit nie przepisuje
tego rozróżnienia na fałszywy cleanup completed. Dodano hosted regresję wyboru
kontraktu; pełny workflow stanowi rzeczywistą próbę tej finalizacji.
Końcowe source review D1 nie znalazło błędu produkcyjnego. Główny fixture
przestawiono na rzeczywiste CPU pole subwindows, zachowując osobne aliasy.


## Bieżący build i rzeczywisty wyścig preparation

Na c8330392428194abc6b9ca7a9f72c2b597e3bf26 wszystkie trzy hosted profile
native oraz pełny runner/Python method workflow przeszły. Bootstrap zatrzymał
się na jednej nowej asercji planera: zero/oblique/wrong-axis odrzuca wcześniej
mesh periodic-node-pair residual validator, missing/NaN odrzuca bounded
admission. Fixture zachowuje pięć negatywnych przypadków i wymaga konkretnego
komunikatu właściwej warstwy. Kod produkcyjny tego guardu jest bez zmian.

Kontrolowany restart własnej grupy przeszedł terminal-catalog proof i native
drain. Iteracja 1bf0177c89fd435bbead059aa29fd5e9: make exit=0, build 561926 ms,
pakiet opublikowany, API zdrowe. Runtime snapshot to
ad1c117b4f871c664cd452e8642b4f66e3e305ee6bf121bb8345da3a61b08d03.

Jednorazowa aktywacja e603ca28017940beb9f171ca6da8ba00 utworzyła run abb3…,
ale HTTP409 accepted_preparation_receipt_invalid zatrzymał Compute.
To inny błąd niż wcześniejszy native window failure: solver nie ruszył,
oba preparery wyszły kodem0 i zwolniły lease, a trwałe receipts są prawidłowe.
Przyczyną jest scanner store.rs czytający folder w trakcie atomic_write:
writer tworzy .<uuid-v4>.part, a scanner przed rename wymaga suffixu .json.

Poprawka reuse istniejącego is_atomic_write_staging_filename w collectorach
launch/exit pomija wyłącznie rozpoznane regularne pliki staging. Symlinki,
katalogi, nieznane nazwy, null i malformed JSON pozostają hard errors.
Regresje sprawdzają częściowe pliki, rename/publication, brak receiptu oraz
negatywne dane; wykonanie wyłącznie GitHub Actions, runtime fix NOT VERIFIED.
Nie ponowiono aktywacji ani Compute na podstawie samego upływu czasu.
Dowody: 2026-10-29-eigensolve-preparation-staging-race.evidence.json.

Przy review historycznego f098 potwierdzono obecne native operator/sentinel
pure-Neumann atoms. Historyczne automatyczne przełączenie boundary pozostaje
osobną kwestią modelu; nie zmienia się jawnego finite-Dirichlet benchmarku ani
analityki dla uzyskania PASS.


## Granice dysków i recovery po anulowaniu przed Compute — 29.10, 19:13 UTC

Pomiar z wnętrza bieżącego backendu rozdziela dwa filesystemy: named volumes
`/build` i `/opt/fullmag/control` mają około 260 GiB wolnego (`/dev/sdf`),
a bind `/state` korzysta z Ubuntu WSL (`/dev/sdd`, około 6 GiB wolnego).
Na Windows C: jest około 13 GiB wolnego. Wcześniejsza prośba o 30 GiB
w Ubuntu nie była uzasadnionym warunkiem przekroczenia dockerowego progu
32 GiB dla buildu. Pojemność filesystemu gościa nie dowodzi jednak możliwości
rozrostu pliku VHDX przy małej ilości miejsca na Windows.

`storage` w Ubuntu zajmuje około 17 GiB: runtime'y 15 GiB, user-data 1,2 GiB,
runy 806 MiB; hostowe builds mają mniej niż 1 MiB. To inwentarz, nie lista
danych zakwalifikowanych do usunięcia. Zachowano sesje, wyniki, bieżący cache,
control i ledgery. Szeroki skan całego home przerwano jako zbyt kosztowny;
nie wyciągamy wniosków o pozostałych katalogach z niepełnego pomiaru.

Run `abb3…` anulowano pojedynczym scope-bound Stop. Komenda jest completed,
run cancelled, oba zadania w katalogu cancelled; Compute nigdy nie wydano.
Oryginalny helper aktywacji wciąż poprawnie zachowuje lease. Poprzedni
`cancelled-activation-recovery/current.json` ma potwierdzone archiwum.
Nowa procedura jawnego `cancel-before-start` zachowuje legacy failed-preparation,
waliduje komplet successful preparation receipts, brak start_release/admissions,
wszystkie solver leases danego runu, host owners i canonical artifact catalog.
Przejście do kolejnego current używa CAS i zachowuje predecessor anchor/journal.

Niezależne review wykryło pomijanie released/orphan leases, orphan host owner
oraz canonical artifact catalog. Poprawiono także fail-closed walk, walidację
ścieżek/stagingu i daty katalogu. Nowe regresje wykonują rzeczywiste wygenerowane
bloki na tymczasowym filesystemie; wykonanie wyłącznie w GHA. Aktualny produkcyjny
preview przeszedł: plan SHA-256
`d94a5fcbacdbbc5f96cc91d310e38044a65bee1c9595defd24e85f4891437f60`.
Nie wykonano jeszcze apply ani nowego Compute. Runtime recovery pozostaje
NOT VERIFIED do wykonania procedury i świeżego startu aplikacji.

Pełny hosted planner `40935795721` wykonał 596 testów: 583 PASS, 13 FAIL.
Poprawiony XY/Gamma fixture już PASS. Jedenaście błędów antenna/spin ma poprawki
w pobranym masterze; nie przepisujemy ich równolegle. Dwa nasze fixture'y FEM
preparation nie zadawały wymaganych wyjść widmowych — poprawiono źródła testów,
zachowując produkcyjne guardy i obsługę FemEigen/FemFrequencyResponse.
Nowe wykonanie CI i scalenie nowszego mastera pozostają konieczne.


### Wynik zastosowania recovery

Hosted workflow [40938573256](https://github.com/MateuszZelent/fullmag/actions/runs/40938573256)
przeszedł, w tym nowe behawioralne regresje wygenerowanych bloków probe'a.
Zastosowano dokładny plan d94a5f… po ponownej walidacji. Operator zakończony
kodem 0: backend b26f… exited=0, OOM=false; oryginalny helper zwolnił lease,
oryginalne rekordy są zachowane. Stan `stopped-awaiting-fresh-archive`,
restart policy `fresh-state-only`: to potwierdzenie drain i zamknięcia lease,
jeszcze nie potwierdzenie ponownie działającego API lub obliczeń.
Publiczne, zredagowane dowody: [recovery evidence](2026-10-29-eigensolve-cancel-before-start-recovery.evidence.json).

Pobrano master 9f70be04f8e60a55c5c321d26c2e2fde41798d4c i połączono
z dotychczasowym checkpointem 5a17e1925. Jedyny konflikt fixture browser QA
rozwiązano przez kanoniczny `metadata_cache_key` i metadane next.config.mjs
z upstream, zachowując asercje owned labels. Pozostałe 14 chronionych plików
pozostało identyczne; source-map przeszła statyczny validator. Finalne review,
commit merge, hosted CI i świeża aplikacja następują po tym checkpointcie.
