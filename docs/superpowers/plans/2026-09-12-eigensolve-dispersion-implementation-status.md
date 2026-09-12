# Eigensolve dyspersji — checkpoint implementacji

Data: 2026-09-12. Status zadania: **W TRAKCIE**. Kwalifikacja solvera non-k0: **NOT VERIFIED**.

## Cel i źródła

Realizacja [planu S00–S12](2026-09-12-eigensolve-dispersion-nonzero-k-plan.md), po osobnym zleceniu implementacji. Zakres obejmuje CPU z pełnym dynamicznym demag-k, falowód 2.5D, interakcje, GPU, artefakty, API i Control Room. Etap źródłowy lub pojedynczy test nie zamyka tego celu.

- Baza `master`: `5084a94ed14b151fc865e8def5a5c28401e98b44`.
- Branch: `codex/eigensolve-dispersion-plan-20260912`.
- Worktree: `C:/git/fullmag/worktrees/eigensolve-dispersion-plan-20260912`.
- Właściciel: `codex:01a0941c-eb15-7261-a7ee-7cf099385525`.
- Rejestr: `eigensolve-dispersion-plan-20260-c5dfad6d7f548079`; reaktywowany do implementacji.
- Fizyczne źródła COMSOL: oba lokalne podręczniki modułu mikromagnetycznego wymienione w planie; szczególnie s. PDF 21–28 i 40–43. Przykład RF jest wzorem sprzężenia pól, a nie gotowym dowodem modalnym.

## Stan etapów

| Etap | Stan | Pozostały warunek |
|---|---|---|
| S00 — baza K0 i dowody | W TRAKCIE | Bieżący managed runtime, Kittel, pełny zaakceptowany handoff |
| S01 — nauka, ADR, kontrakty | W TRAKCIE | Noty, mapy źródeł, walidatory i review |
| S02 — Python/IR | W TRAKCIE | Walidacja k i selektorów, round-trip, testy konsumentów |
| S03 — natywny operator magnetyczny Blocha | W TRAKCIE | Prolongacja fazowa, MFEM sparse/matrix-free, testy i połączenie produkcyjne |
| S04 — dynamiczny demag-k CPU | DO WYKONANIA | Nowy właściciel airbox, sprzężenie, gauge, zbieżność brzegu |
| S05 — natywny solver spektralny | DO WYKONANIA | SLEPc, realifikacja, reszty, kompletność, cancellation/resume |
| S06 — śledzenie gałęzi | W TRAKCIE | Hungarian/gaps, następnie fizyczna metryka i podprzestrzenie |
| S07 — artefakty i API | DO WYKONANIA | Stabilne ID, faza/obwiednia, selektory, binarne pola |
| S08 — Control Room | DO WYKONANIA | Authoring, dyspersja, wybór modu i przestrzenna faza; browser/WebGL |
| S09 — falowód 2.5D | DO WYKONANIA | Modified Helmholtz i normalizacja na długość |
| S10 — interakcje | DO WYKONANIA | Anizotropia, DMI seams, Gilbert i legalność |
| S11 — GPU | DO WYKONANIA | Jawna trasa double bez fallbacku, residency i parytet |
| S12 — kwalifikacja i integracja | DO WYKONANIA | Managed benchmarki, review, commity, PR, merge, weryfikacja mastera |

## Zweryfikowane warunki wykonania

Repozytorium bazowe ma ModalEigenRequest ABI **19**. Historyczne numery ABI w dokumentach nie zastępują bieżącego nagłówka. Kanoniczny układ styczny to `q[2*node+component]`, zgodnie z `tangent_frame.cpp` i natywnym assembly `A_qq`.

Odczyt runnera: kontener `Fullmag_build_runner` działa w kontekście `desktop-linux`. Job `908c9b8a781a4af4b77c104a07f925ec` innego worktree, dla tego samego commita bazowego, ma stan `blocked`, bez exit code. Nie jest to wynik testu tego zadania. Odczyt storage wskazał 3 343 511 552 bajty wolnego miejsca; dokumentowany próg runnera wynosi 8 GiB. Nie usuwano cudzych buildów, cache ani wyników.

Próba lekkiej kompilacji nowego testu C++ przez `fullmag_storage.py run` została odrzucona przed kompilacją: `Container runner owns heavy builds on this host; submit a snapshot through just runner-build`. Nie obchodzono tej bramki. Nie uzyskano czerwonego ani zielonego wyniku testu C++.

### S00 — zgłoszony build bazy

Po zmianie stanu środowiska ponowny odczyt o 06:40 UTC wykazał 45 222 551 552 bajty wolnego miejsca, `health.accepting_jobs=true` i pusty aktywny slot. Wcześniejszy brak miejsca nie jest aktualną blokadą.

Zgłoszono własny build dokładnego bazowego commita przez `local_runner_cli.py submit --operation build --profile fem-cpu-release --source commit --ref 5084a94ed14b151fc865e8def5a5c28401e98b44` (klient exit 0):

- Job: `1d31af520bb547848e23be8888fde8d8`, sequence 13; ostatni odczyt przy zgłoszeniu: `queued`.
- Source digest kapsuły: `d8cd645e71228de87ec7a8b9252f8317fd5c402a409e25ba5685aca836ce991a`.
- Native source snapshot SHA256: `bd5d415203e5a59041b580bfd1befbd9a70ed38ebd4b6ac16810274b9418c634`, dirty=false.
- Kapsuła: `storage/runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/16a8789ca9a746c19369f95b9a94ce86/source`.
- Skonfigurowany obraz CPU: `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`, 2 CPU, 8 GiB RAM.

Kolejny odczyt: job przeszedł do `running` (updated_at 1789195476.7236419). Profil ma `FULLMAG_FEM_WITH_SLEPC=OFF`, więc może potwierdzić bazowy build CPU, lecz nie kwalifikuje solvera modalnego SLEPc ani bramki fizycznej K0.

Ten build dotyczy bazy, a nie bieżących niezacommitowanych zmian. Wynik i receipt wymagają osobnego odczytu; S00 obejmuje następnie uruchomienie i walidację fizyczną K0.

## Zasady zaliczania przyrostów

Każdy przyrost otrzymuje pełny hash commita, zakres, wykonane polecenie i exit code po weryfikacji. Źródła, build, managed runtime, nauka, browser/WebGL i kwalifikacja wydania są odrębnymi dowodami. Aktualnie nie ma jeszcze commita implementacyjnego ani nowego wyniku runtime. Odrzucenia nieobsługiwanych kombinacji non-k0/demag/GPU pozostają aktywne do dostarczenia właściwej realizacji i dowodów.
