# Scalenie implementacji dyspersji z masterem — checkpoint

Data: 2026-10-04. Worktree: `eigensolve-dispersion-plan-20260912`.
Branch: `codex/eigensolve-dispersion-plan-20260912`.

## Zakres

Checkpoint brancha przed integracją: `33647d62ff08f55e6873167056b7d7ebdaa6a00a`.
Pierwszy merge obejmuje master `6d658d58cca4e4885caa1a2dc69cd95889c656df`.
W trakcie rozwiązywania 40 konfliktów remote przesunął się do
`1010f5d94cb13a9aae2e5644992c0fc26c93f33e`; wymagany jest również drugi merge.

Zachowano kontrakty mastera dotyczące tożsamości artefaktów, sesji i request epoch,
publicznego SceneDocument oraz materializacji wyników. Dołączono adaptacyjną politykę
wykonania niezależnych próbek k, provenance i właściwy względny residual brancha.
CSV COMSOL obu stron zawiera te same 1464 rekordy; zachowano oryginalne bajty brancha.

Review ujawniło poprawki konieczne do spójnej integracji:

- Opcjonalny względny residual pozostaje nieznany, gdy solver go nie raportuje;
  nie zastępuje się go wartością bezwzględną.
- Jawne `mode_field_available=false` blokuje publikację referencji pola.
- Adapter frequency-domain czyta payload i digest z jednego ograniczonego snapshotu.
- SceneDocument dopuszcza `parallel_execution`, a istniejący adapter waliduje jego
  pola i ograniczenia backendu; dodano 14 regresji round-trip i odrzucania błędów.
- CPU runtime-v2 wymaga zgodnych aliasów CUDA oraz `FULLMAG_ENABLE_FEM_GPU=OFF`.
- Niekompletność nieznanego dokumentu sesji pozostaje blokująca również obok
  dwóch znanych, nieprzezroczystych dokumentów projektu.
- Poprawiono źródłowe mapowanie interakcji po podziale plików FDM na masterze.

## Dowody źródłowe

Przed zapisem merge uzyskano 503 przechodzące testy interpretowane Pythona
oraz 42 subtesty: 228 verifier/dokumentacja, 43 material/replay, 86 wykresy/raporty,
63 SceneDocument, 58 entrypoint i 25 executor. Produkcyjny TypeScript:
985 plików, bez wejść testów jednostkowych, zero błędów. Kontrola API hygiene
i parserowe kontrole edytowanych plików Rust/TypeScript przeszły.
Mapy źródeł 0104 i 0830 przeszły walidację.

Testów jednostkowych Rust, C++ ani React nie kompilowano. Dodane regresje Rust
są przygotowane w kodzie, ale niewykonane. Te dowody nie zastępują managed builda,
eksportu OpenAPI, przeglądarki ani kwalifikacji naukowej. Commit z `[skip ci]`
zapobiega zakazanej kompilacji testów; pominięte CI nie oznacza zaliczonego CI.

## Pozostałe bramki

1. Zapisać i wysłać oba merge; potwierdzić brak konfliktów i zgodność z remote.
2. Zaktualizować zaufany koordynator pustej kolejki, zachowując konfigurację,
   profile i dane; stary koordynator deklaruje FEM_GPU=ON dla CPU runtime-v2.
3. Zbudować pełny SHA przez `fem-cpu-slepc-runtime-v2` bez kompilowania unit tests.
4. Wyeksportować OpenAPI z potwierdzonego artefaktu runnera i zweryfikować generatory.
5. Sprawdzić wymagane review i bramki PR #97 przed integracją do mastera.
6. Zweryfikować lokalną integrację bez naruszenia cudzych zmian głównego checkoutu.

Istniejący specjalizowany manifest FEM nadal ma historyczne aliasy `current`;
sam ten merge nie jest dowodem pełnego cutoveru wszystkich producentów.
15 punktów DE i dwa punkty diagnostyki airboxu pozostają wynikiem częściowym.
Konwergencja, pełne okno Gamma, native grouped/adaptive parity, GUI, COMSOL,
GPU i waveguide pozostają otwarte. Cały plan S00–S12 nie jest zakończony.

## Zamknięcie konfliktów i poprawka capture

Oba merge zapisano i wypchnięto: `9085b6a0242b3cde9737bfd87c854e278c537616`
oraz `cfc3fc3d28f461543048b4bfac8c6a5e36b03878`.
GitHub potwierdził PR #97 jako `MERGEABLE / CLEAN`; brak konfliktów.
Drugi merge obejmuje tylko trzy pliki testowe z mastera; kontrola parserów przeszła.
Pełny staged whitespace check pierwszego merge zgłasza jedynie niezmieniony patch
`docs/validation/external-solver-patches/mumax3-sp4-local.diff` z mastera
(blob `d8e11e7c67748b95dcdc73b3a68e8076ebcdb4b5`).
Hook React Doctor zgłosił 60 ostrzeżeń, wynik 73/100; to nie jest potwierdzenie
browser gate ani pełne zamknięcie diagnostyki frontendu.

Koordynator zaktualizowano przy pustym aktywnym slocie przez graceful stop/replace/resume.
Obraz: `sha256:17792f5bcba0515336bddd0f91073135cff75815bf6bb6b373b7fd170fa304aa`.
Profile, sekret i konfiguracja buildów pozostały bez zmian.
Trusted entrypoint ma hash `b049deb6ca0a74c225de176695442d688e3f57abec89c5b9f01a88943173325e`;
CPU runtime-v2 jawnie deklaruje CUDA OFF, FEM_GPU OFF i brak unit test targets.

Pierwsze zgłoszenie exact-SHA zostało odrzucone przed utworzeniem joba:
`start-screen.tokens.css` błędnie sklasyfikowano jako plik z credential tokens.
Rozszerzono istniejący wyjątek tylko o dwa przejrzane arkusze design tokens:
`apps/control-room/src/design/styles/start-screen.tokens.css` i
`docs/design/start-screen/tokens/start-screen.tokens.css`.
Nie zastosowano wildcardów ani osłabienia reguł dla innych plików z sekretami.
Regresje sprawdzają capture commit/snapshot oraz odrzucanie podobnych ścieżek.
Build wymaga nowego, pełnego SHA poprawki; master merge i kwalifikacja pozostają otwarte.

Weryfikacja poprawki capture: scripts/test_local_runner_source.py — 15 testów OK, exit 0 (60,4 s); bez kompilacji testów jednostkowych.


## Terminalny wynik #229 — zgodność startup stamp

Job `b0fbe5759e5940ceb41c0bc283cef8ff` zakończył się failed/exit2 po native-build
exit0 (2503003,827 ms, około41m43s). Availability subprocess zakończył się exit0
i `native_fem_cpu_available=true`; `native_fem_gpu_available=false`. Attestacja
odrzuciła nowy stamp `[fullmag] version: … | build: … | commit: … | clean | source snapshot: …`,
ponieważ `scripts/local_runner/build_entrypoint.py` wybierał tylko wiersz zaczynający
się `[fullmag] build:`. Producentem jest `crates/fullmag-build-info/src/lib.rs::print_startup_stamp`.
Actual snapshot `2a932af34c40391797e1f9804e1d77b5b8c25c3fb454ce3459001d14c6d01b0c`
jest dokładnie zgodny z przypiętymi źródłami. To błąd parsera attestacji,
nie dowód awarii numerycznej. Runtime ani pakiet nie otrzymują PASS tylko dlatego,
że kompilacja i availability probe się powiodły.

Kontroler nearest zatrzymał się przed OpenAPI/dry-run/solve. Nie uruchamiał ani nie
ponawiał nowego buildu, nie zmieniał failed receipt i nie usuwał danych. Wymagana
poprawka zachowuje ścisły SHA match i odrzuca niejednoznaczne/malformed stampy.
Następnie potrzebne są aktualny trusted runner i nowy managed job z poprawką.

Niezależny managed dry-run rafinacji air1,075 na starszym #228 zakończył się
`managed build receipt verification failed` przed wykonaniem solvera. Jego
historyczny runtime-v2 ma FEM_GPU=ON, podczas gdy aktualny kontrakt CPU-only
po integracji wymaga OFF. Stare wyniki pozostają historycznym dowodem dokładnie
tych kapsuł; nie zmieniono receiptów ani bramki dopuszczenia nowego runu.

S09: read-only trace wskazuje brak kanonicznego wiązania mesh→V04 registries,
odrębnego od geometrii/incidence. Nie aktywowano providera ani nie wprowadzono
niejawnego dziedziczenia przypisań. GUI: runtime-v2 nie buduje frontendu; domyślny
tsconfig Next obejmuje także test inputs, a production-source check ma odrębną
konfigurację. Przed buildem GUI potrzebna jest jawna produkcyjna trasa bez unit
inputs oraz późniejszy dowód browser/WebGL i zgodności frontend/runtime.


### Poprawka parsera — dowód źródłowy

`scripts/local_runner/build_entrypoint.py::_validate_runtime_startup_stamp`
rozpoznaje pełny historyczny format build/commit/state/snapshot oraz bieżący
version/build/commit/state/snapshot; zachowuje wcześniejszy skrócony legacy
fixture. Wymaga jednego stampu, pełnej poprawnej struktury, poprawnego czasu
pełnych formatów i dokładnego SHA-256 snapshotu; nie wybiera pierwszego z wielu
stampów i nie akceptuje dowolnego wiersza zawierającego marker.

`scripts/test_local_runner_build_entrypoint.py`: 60 interpretowanych testów PASS
(2,55s), w tym rzeczywisty fixture #229 i pełny legacy #228, mismatch, brak pola,
niepoprawny/uppercase/krótki digest, błędny timestamp i duplikaty. Root review
poprawiło początkowy wariant legacy rozpoznający jedynie skrócony fixture.
Scoped diff check PASS. Niezależny odczyt zachowanych stderr #228/#229 przez
helper również PASS z hashami wejść; nie wykonał runtime'u ani nie zmienił
receiptów. Żadnych testów Rust/C++/React nie skompilowano.

Zakres jest źródłowy. Aktualny obraz koordynatora nadal wymaga tej poprawki,
a następny managed build musi potwierdzić pełną attestację i pakiet. Failed
#229 pozostaje failed; nie promujemy samego kompilowanego workspace do runtime.


## Kolejne przesunięcie mastera — PR125/126

Po push poprawki parsera `569947856713b622d52aacd0044556d68a82e28b`
GitHub ponownie zgłosił konflikty, ponieważ master przesunął się do
`01e1b113f5a1f17aef0e506e3c9dbf965401e300`. Nowy merge ma pięć
konfliktujących plików; wcześniejsze 40 rozwiązań pozostaje zachowane.

Dokumentacja `Problem.parameters` i jej mapa zachowują normalizację SI
oraz dokładniejsze reguły mastera: odrzucanie nieznanych referencji, cykli
i konfliktów wymiarów przy konstrukcji; lowering przenosi metadane authoringu.
To odpowiada `Problem.__post_init__`, `Problem.to_ir` i `ParameterLibrary`.

Kontrola produkcyjnego TypeScript: 997 plików, zero wejść jednostkowych,
zero błędów, noEmit. API hygiene PASS. Wygenerowane przez openapi-typescript
typy są identyczne po normalizacji końców linii z auto-merged typami;
SHA-256 znormalizowanego tekstu:
`a1810784d0b51635d5bfbfeed7ef7a54e08b26dfb7340f8d0c31e73ec43331d7`.
Walidator mapy dokumentacji PASS i 35 interpretowanych kontroli narzędzi PASS.

Managed generate-client zatrzymał się przed generacją: link node_modules
tego worktree wskazuje niedostępne zależności. Kontrolę porównawczą wykonano
przez odczyt istniejących zależności głównego checkoutu, z wynikiem zapisanym
poza źródłami. Nie instalowano pakietów ani nie kompilowano testów; nie jest
to managed runtime lub browser qualification. Bramka builda pozostaje otwarta.

Rozwiązanie smoke Inspectora zachowuje helper `reloadInspectorDocument`: resetuje
wyłącznie budżet GET nowego dokumentu, zachowując kumulacyjne liczniki i limity
mutacji całego scenariusza. Masterowe `requestCounts.clear()` usuwałoby telemetry
z kumulacyjnej mapy aliasowanej przez requestBudget; nie przeniesiono go.
Mocki zachowują eksporty oryginalnego KernelContext i wymagane API mastera;
mock jakości siatki dostarcza także własny kontekst z tym samym kernel fixture.

Wszystkie kontrole źródłowe pozostają odrębne od wykonania testów React,
przeglądarki, nowego native builda i kwalifikacji fizyki.

Końcowa kontrola wszystkich 111 scalonych plików TypeScript: zero błędów
parsera; kontrola node --check smoke Inspectora PASS. Brak unresolved entries
i markerów w pięciu konfliktujących plikach. Whitespace check z istniejącym
CRLF traktowanym jako koniec linii PASS; nie wykonano szerokiej zmiany formatów.
Ograniczony przegląd dziewięciu plików backendu/infrastruktury nie znalazł
otwartego błędu specyficznego dla merge: zachowano ukrytego workera eigensolve,
kontrakty parallel execution, modalne recepty i integrację workspace DB mastera.
To review źródłowe; nowy native typecheck, runtime i fizyka pozostają NOT VERIFIED.

## Wdrożenie parsera, build #231 i konieczność danych storage

Trusted koordynator otrzymał parser startup stamp przy pustym aktywnym slocie.
Obraz sha256:69760bc41867c5f0c55b107c077a9ac762f29a16706cda2ff2c151da44706851;
Hash helpera: 3a55adeb3598b9af2ddb7584905b42846e03feb4d1fa39adb45e37e882be2461.
Profile, sekret i konfiguracja buildów zachowane; health po resume potwierdził
worker_alive/accepting_jobs i brak błędu. Wdrożenie nie zastępuje attestacji.

Po blocked #230 przed utworzeniem kontenera zgłoszono #231 przez API kolejki,
z tym samym źródłem 4b34ec7b91dadb18ac87d7f8b98b3a2cf5c8f574, digestem
860b3872cce76d190bd18076edf039d66299933a8aa4cdf31e2d44aa1e3153c7 i kapsułą
9756cdb852ce42ff9d2dc6d7ee7f8f21. Nowej kopii źródeł nie wykonano.
Docker potwierdził running/bez OOM dla kontenera 1044d9bc59a9543e16abfd459f047dbbd8096f02ac3981324df6201238f13ca7;
native-build rozpoczął się 2026-10-04T19:23:32Z. Cały build, receipt i nowy runtime
pozostają NOT VERIFIED przed terminalnym sukcesem. PID270544 obserwuje ten sam
job; nearest GMRES/FGMRES rozpocznie się po bramkach builda/OpenAPI/dry-run.
Porażka pierwszego trialu zatrzymuje drugą próbę do review, bez ślepego retry.

Osobno przypięto sześć niewysłanych prób air-mesh: +10/+25 i growth 1,3/1,15/1,075.
Zachowano model 408492f3f19c852ff992776a6fb3b2d3934ac69a33dc668b740ebbe26a6f5b8b,
dziewięć hashy drivera i solver controls. Trzy poziomy należy wykonać na jednym
runtime; historyczne baseline nie zapewniają izolacji różnic pakietu. Kontrola
przygotowania PASS, managed dry-run i actual isolation/solve NOT VERIFIED.

Audyt storage nie wykazał konieczności utrzymywania wszystkich pełnych kopii.
Prywatne execution są potrzebne podczas kompilacji; późniejszy benchmark bierze
źródła z source/tree i runtime z artifacts/outputs/.fullmag/local. Usunięcie
terminalnego execution wymaga sprawdzenia aktualnych użytkowników, pinów,
lease i mountów. Wyniki, wejścia, mesh/equilibrium/modes, manifesty i receipty
zachowują odrębne wymagania i nie podlegają ogólnemu TTL buildu.

Kod policy/apply ma tylko preview i nie ma wykonawcy ani schedulera usuwania.
Ostatni skan strukturalny obserwował 154,13 GB logicznie/2,98 mln plików,
w tym 87,29 GB execution i 46,36 GB source. 154 manifesty deklarują 45,62 GB treści
i 0,86 GB unikalnych hashy. To historyczne pomiary z ograniczeniami opisanymi
w audyt-koniecznosci-danych-i-lista-sprzatania.md oraz JSON-ach w artefaktach
wątku; nie są jednoczesnym stanem ani gwarantowanym fizycznym odzyskiem.
W ramach analizy nie usuwano danych, nie wprowadzono GC ani migracji CAS.

PR97 OPEN, bieżąca gotowość merge UNKNOWN. Nowych częstotliwości brak;
Γ full window, shared signed15, serial/adaptive parity/zasoby, convergence,
GUI, A1-COMSOL, S09/GPU i całe S00–S12 pozostają OPEN.

## Pakiet #231, master PR127 i rzeczywiste porównanie nearest — 2026-10-04 21:00 UTC

Poprzedni zapis #231 running jest historyczny. Job zakończył się succeeded/0;
native-build trwał około 28 min 56 s. Receipt zawiera 29 artefaktów, attestations
CMake/runtime/dependencies mają pass, requested/resolved FEM CPU/double/SLEPc.
Źródło 4b34ec7b91dadb18ac87d7f8b98b3a2cf5c8f574, snapshot
4371ba58265f3973d942eef85cb954b0d944832b4af4b12d9e54d25aeacd4f1b;
pakiet CPU: MFEM 4.10, PETSc 3.24.6 i SLEPc 3.24.3, CUDA/FEM GPU OFF.
Nie zbudowano unit targets ani frontendu. Nie jest to release qualification.

Merge f01644bd6cc16d99101deee52b7a951ed5292278 zachowuje master
6c0c76551b6095b064e996cbb4c80a4ba7952aa9 i nasze kontrakty modalne.
Jedyny konflikt dotyczył nazwy zmiennej testowego fixture; zachowano dynamiczne ID.
Produkcja TS: 1000 plików, zero unit inputs i błędów; parser 14 plików bez błędów,
API hygiene i 6/13/5 grup interpretowanych kontroli kernel/transport/handoff PASS.
Źródła nie zmieniły się podczas kontroli. Odczytano istniejące zależności main
bez instalacji; package zgodny, lock zgodny po CRLF i semantycznej kontroli YAML.
To source-only evidence, nie uruchomienie UI. Niezależny review pięciu plików
produkcji nie znalazł P1/P2 w tym zakresie. Hook React Doctor 73/100 i 6 ostrzeżeń
nie jest PASS. Przegląd ostrzeżeń: sekwencyjne bounded range reads zachowują offsety;
sekwencyjny setup, JSON normalization cross-VM i guarded find są w lekkich fixture;
URL jest walidacją wejścia smoke. Nie stwierdzono wymaganej poprawki zachowania
w tym zestawie; nie wprowadzono suppressions ani nie przedstawiono tego jako audytu całego UI.

Eksporter najpierw odrzucił poprawny runtime-v2 przez arbitralne 15-output gate.
Commit fb5f9510efcc3352e06387c8a981e12669a05676 wymaga zadeklarowanego API
po pełnej walidacji receipt właściwego profilu. 29 interpretowanych regresji PASS.
Rzeczywisty eksport następnie ujawnił brak libmfem.so.4.10.0, exit 127.
Commit a5dbff4b6930bf6dcdded5dfa4828430c114a342 zachowuje zaufany profilowy
LD_LIBRARY_PATH, z /package/lib i /opt/fullmag-deps/lib; nie zmienia obrazu ani
ochrony sieci/readonly/hash/source. 30 interpretowanych regresji PASS.
Eksport edfb4def9e264f3fb3d51b2639377587: succeeded/0,
input_hashes_verified=true, cleanup_confirmed=true. Surowe OpenAPI 1 496 225 B,
SHA-256 1ec237b7976406815d464fba5db818e1cd287500f478302a4ba382cc3d6061ee.
Zachowano wcześniejsze porażki i ich receipty. Native package nie przebudowano:
zmiany dotyczyły eksportera, frontendu/fixture i dokumentacji, nie skompilowanego solvera.

| Próba +10 rad/µm, nearest 11,2 GHz | Stan | Wynik i kontrola |
|---|---|---|
| GMRES, ba9776a1cb644316850b490d82b3259c | failed/1, około 39,91 s | PETSc: residual rekurencyjny 5,9689e-16 wobec obliczonego 4,6044e-11; brak zaakceptowanej częstotliwości. |
| FGMRES, 8f3291c45ba34023a998349c6520d863 | completed_unqualified/0, około 50,89 s | 11,205285324453773 GHz; wybrany mod ma pełny certyfikat i residual 1,8215819390878056e-13. |

Bajty model-input.py obu prób są identyczne (408492f3f19c852ff992776a6fb3b2d3934ac69a33dc668b740ebbe26a6f5b8b).
Runtime, źródło, requested L2/3layers/growth1,3, EPS/KSP1e-9, restart8,
nearest11,2GHz są identyczne poza typem KSP. Physical solver tolerance pozostała 1e-8;
usunięto tylko redundantny diagnostyczny argument --solver-rtol, niedozwolony dla k10.
Native shared operator digest obu prób:
322ff24be7f9a115a585720a005178df0f2d5862493376e80f9ba88118e3be33.
Failed GMRES nie eksportuje osobnych hashy mesh/equilibrium/phase; ich zgodność
nie jest niezależnie potwierdzona. Oba dokładne kontenery sprawdzono jako nieobecne.

FGMRES: 32 solve/32 true-residual measurements, 0 violations/0 unavailable,
max tolerance ratio 0,9806801026128354, EPS reason1/KSP reason2. Row preflight pass,
jeden mod i physical potential; rekonstrukcja pola zgadza się z zapisanym potencjałem.
Certyfikat pochodzi z spectrum.v2 samples[0].modes[0].block_residuals,
scope full_projected_weak_form_and_periodic_seams, eps_phi 3,77517e-14,
seam residuale 0 lub około 1,67e-36. solver.v1 summary ma null/false dla tych bloków;
nie zastępuje certyfikatu modu. geometric_bc_certified nadal false.
Wynik selected_only/window_complete=false; pojedynczy sukces nie ustala przyczyny
błędu GMRES, kompletności okna, n0 ani kwalifikacji demag. Zakres głównej symulacji
to jednorodny film DE, a nie COMSOL A1 antidot.

Nowe korekty planu: przejrzeć politykę KSP i linearność/zmienność PC, poprawić
telemetry również przy hard-error, wyjaśnić summary block certificate i geometric BC.
Następny eksperyment to sześć przygotowanych frequency-window prób +10/+25
z growth1,3/1,15/1,075 na jednym #231; każdy dry-run i wynik wymaga własnej kontroli.
Actual body/equilibrium/mode isolation i zbieżność pozostają NOT VERIFIED.

Dowody lokalne w preview-state-checkpoint: master127-source-checks-v2/verification.json,
merge-master127-ui-review.md, exporter-runtime-profile-verification.json,
exporter-profile-loader-verification.json, nearest231-pair-artifact-audit.json,
nearest231-comparison-v2.json oraz receipty/trial artifacts pod #231/comsol-dispersion.
Rejestr i PR muszą odzwierciedlać ten stan. Remote master ponownie przesunął się
do eae25cc2b393f78e7ff0e9da727344f08c62ee41; ten commit nie jest jeszcze scalony.
PR97 pozostaje OPEN, odczyt zgłosił CONFLICTING/DIRTY. Nie wykonano merge PR.

Audyt storage potwierdzono również przez bieżące API: mode preview,
automatic_mode_available=false. Planer zachowuje drzewa z linkami jako unsafe;
107 takich rekordów jest historycznym wynikiem podglądu, nie pomiarem aktualnego
odzysku. Wykonawca GC, link-safe retention i deduplikacja CAS są propozycjami;
w tym audycie ich nie wdrożono ani nie usuwano danych. S00–S12 pozostają OPEN.


## Ograniczony review polityki shifted KSP i certyfikatów

Niezależny agent przeczytał właściwe ścieżki źródeł bez edycji/testów/buildów.
Zewnętrzny PC i solve Poissona używają stałego LU; nie potwierdzono zmienności PC.
Actual FGMRES diagnostics: 656 tangent DOF, magnetic-only shifted LU. Nie ma
podstaw do globalnej zmiany defaultu GMRES na podstawie pojedynczego A/B.
Konfiguracja residual replacement threshold 2 wyjaśnia bezpośredni trigger
GMRES przy computed residual około 366 razy większym niż początek cyklu;
głębsza przyczyna luki rekurencyjnego residualu nadal nie jest ustalona.

KSPSetPostSolve nie musi zdążyć przed błędem EPSSolve. Failed path celowo nie
odpytuje końcowych uchwytów KSP, bo SLEPc może zachować pożyczony widok macierzy.
Proponowana poprawka to bezpieczny snapshot z monitora przed unwindem:
ostatnia iteracja/reason/residual, serializacja bez KSPGet po hard-error.
Implementacja i managed regresja tej poprawki pozostają do wykonania.

Summary block_residuals null/false jest zamierzonym brakiem solver-level danych;
mode certificate powstaje i jest konsumowany osobno. UI korzysta z wybranego
modu, więc nie potwierdzono błędu konsumenta. Ten podpunkt review zamknięto
bez zmiany semantyki lub wypełniania summary certyfikatem dowolnego modu.
Geometric BC, pełne okno i zbieżność pozostają osobnymi bramkami.

Referencje: backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp
(PC 1189/3321/3637, GMRES 891/3511, snapshot 946/3723),
backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp:124,
crates/fullmag-runner/src/fem/eigen_native_window.rs:2580,
crates/fullmag-runner/src/fem/eigen_native_artifacts.rs:34,
apps/control-room/src/shared/domain/analysis/eigenResidualSummary.ts:19.
Pełny bounded raport: preview-state-checkpoint/review-shifted-ksp-policy231.md.
Aktualna macierz air: wszystkie sześć managed dry-run PASS, dwie pierwsze
próby zakończyły się completed_unqualified; dalsze wykonanie jest w osobnym
controller state. Nie uznano tego za actual isolation/convergence PASS.
