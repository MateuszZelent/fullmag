# FEM K0 — S00: baseline, zabezpieczenie dowodów i decyzje o odzysku

Data: 2026-09-10 (czas lokalny Europe/Warsaw; pomiary zapisano w UTC).
Zlecenie: wykonać pierwszy etap [planu S00–S14](../superpowers/plans/2026-09-09-fem-k0-production-remediation-sol.md).
Zakres odbioru: **S00 / historyczne dane i baseline źródeł**, nie kwalifikacja solvera.

## 1. Wynik i granice

- Zachowano dokładną kopię historycznego bundle Neumanna: **162 pliki,
  19 311 322 bajty**, wraz z wejściem wykresu i samym wykresem.
- SHA256 wszystkich plików zgadzają się przed kopiowaniem, w kopii i po
  walidacji. Nie edytowano historycznych JSON, skryptów ani `.gitignore`.
- Niezależnie odtworzono 15-punktowe porównanie z Kittlem:
  maksimum błędu względnego **5.194679480952314e-14**.
- Oryginał i kopia są tak samo odrzucane przez obecny walidator tożsamości
  meshu. Zachowanie tego błędu jest wymaganiem baseline, nie udaną naprawą S04.
- Odnaleziono manifest Windows/Docker z tym samym `source_snapshot_sha256`
  co metadata wyniku. Odczytano też rzeczywiste hashe zachowanych plików runtime.
- Rozliczono historię obu niezintegrowanych commitów; nie scalono ich w ciemno.
- Utworzono i zarejestrowano osobny worktree na aktualnym lokalnym masterze.
  Żadna zmiana kodu solvera, ABI, capability, progu, przykładu wykonawczego ani
  launchera nie jest częścią S00.

**Rozstrzygnięcie zależności planu:** zdanie S00 o przeniesieniu sprawdzonych
zmian nie upoważnia do pominięcia zależności S01 → S02, gdzie plan jawnie
umieszcza integrację Gamma. W S00 przeniesiono sprawdzone materiały planu i
dowody, sklasyfikowano zmiany we wszystkich 34 plikach poprawki i wskazano
zależności dalszego odzysku.
Poprawki zmieniające fizykę pozostają do S01–S03; nie zadeklarowano ich jako
już wdrożonych. Odbiór S00 nie oznacza odbioru S01–S14 ani globalnego PASS.

## 2. Checkout, bazowe commity i zasoby

| Element | Zweryfikowana wartość |
|---|---|
| Główny checkout | `C:/git/fullmag/fullmag` |
| Lokalny master podczas S00 | `1620d2762d99b58cddcfc93f7eb505b84dfbf178` |
| HEAD głównego checkoutu | `c6fd35e909bb1fbc7b62fc35e1c180c6cef8374b` |
| Branch głównego checkoutu | `fix/viewport-3d-audit-s16-postprocessing-20260909` |
| Worktree zadania | `C:/git/fullmag/worktrees/k0-remediation-s00-20260910` |
| Branch zadania | `codex/k0-remediation-s00-20260910` |
| Worktree ID | `k0-remediation-s00-20260910-2717a03f5c1f094a` |
| Owner | task Codex `01a04c3b-7546-7cc2-b555-fde34bf26ccb` |
| Profil | `windows-native`, tylko kontrole danych/tekstów; bez builda FEM |
| Konfiguracja storage | odczytana przez `scripts/fullmag_storage.py` z `.env` głównego checkoutu |
| Rejestr | `C:/git/fullmag/storage/index/k0-remediation-s00-20260910-2717a03f5c1f094a.json` |

Główny checkout zawiera cudze usunięcia artefaktów UI, zmiany submodułów oraz
aktywne zmiany `justfile` i launcherów. Nie stage'owano i nie zmieniano tych
plików. Oryginalny nieśledzony plan pozostawiono tam bez zmian; jego wersja
z checkpointem S00 jest w worktree zadania.

Historyczne worktree pozostają zachowane:

- `C:/git/fullmag/worktrees/eigensolve-k0-finalization`, HEAD
  `e3241af9a7815b63809cb8b99e83be5efbc51a18`: ancestor lokalnego mastera;
- `C:/git/fullmag/worktrees/k0-exchange-only-diagnosis`, HEAD
  `93e1ca38423ddb661a21c76b05bb02bfaf5c9826`: zawiera kopię źródłową wyniku;
  przed S00 miał zmianę `.gitignore`, której nie przejęto.

Po początkowej odmowie sandboxa odczyt Docker/CIM wykonano za zgodą poza nim.
Aktualny Docker context to `desktop-linux`. Snapshot mountów pokazał aktywne
kontenery głównego checkoutu, `gpu-master-integration-20260906` i
`contract-b-witness-20260910`; nie pokazał kontenera bind-mountującego worktree
S00. Dwa procesy `wsl.exe` miały odwołania do zakresu sprawdzanych worktree;
nie przypisano im właściciela na podstawie nazwy i nie zatrzymywano ich.
Zapis `resource-snapshot.json` jest obserwacją chwilową, nie zgodą na cleanup.

## 3. Zachowane artefakty i manifesty

Korzeń dowodów S00, dalej oznaczany **E**:

`C:/git/fullmag/storage/runs/k0-remediation-s00-20260910-2717a03f5c1f094a/baseline`

Kopia: `E/neumann.zarr`. Oryginał:
`C:/git/fullmag/worktrees/k0-exchange-only-diagnosis/examples/fem_eigen_k0_kittel_periodic_airbox.zarr`.

| Plik pod E | SHA256 |
|---|---|
| `neumann-files.sha256.json` | `a45f5fe91e28d0f73e4ac24f99fbc12fa183ae533f22f6992596418014b62b7b` |
| `reference-files.sha256.json` | `bfd7b2f4ace7aca1c7171dbba7addd467cd0190b2b7b14cf31cf9623555aed2a` |
| `preservation.json` | `5836ec94e05dcafea4c1ff794ebe3b7d57fdbdeacdfce465139c612d64dc52ef` |
| `checks.json` | `788a1186cc48aa861db19a560d00838f05dea26f7f10d42f0b4ed0db464adb14` |
| `historical-inventory.json` | `52a63f7ded5a0003c5c247f88fea5bc17cda8e7eaf90722e0cbb4d995d2611d4` |
| `reference-files/neumann-runtime-manifest.json` | `ed6a404dc7b5cb0629d90115f997a7efcb6cc8ff1aa923202d1f706e55752f5b` |
| `reference-files/validator.py` | `b183d33cde928a65d56de71e46f8f57a271c3c90946baeea59ee946e4d42f865` |
| `resource-snapshot.json` | `680f8a07b87a0570d0821ad594f4dd78c009204587b9f567351caea9be958cdf` |

`reference-files/` zachowuje oba runtime manifests, aktualnie istniejący
historyczny przykład filmu, skrypt wykresu, historyczne snapshot/launcher
helpers, dane Robin i kod użytego walidatora. Samo skopiowanie skryptu z
historycznego worktree nie dowodzi jego identyczności z plikiem w chwili builda.
Manifest kopii nie zaciera tej różnicy.

Zachowano też `gamma-f0986ede.patch`, rodziców merge `93e1ca`, jego combined
diff oraz listę zmian względem drugiego rodzica. To kopie do przeglądu,
**nie patche zastosowane do bieżącego solvera**. Duże wyniki nie trafiają do Git.

Jednorazowe, zachowane skrypty zbierające dowody są o poziom wyżej od E:
`capture-s00.ps1` i `inventory-s00.ps1`. Uruchomiono je przez `fullmag_storage.py
run` z tym samym profilem; używają `assert-lock` i `validate` przed zapisami.
Nie znaleziono dedykowanej recepty `just` dla takiej kopii audytowej; nie
zastąpiono żadnej recepty native FEM hostowym solve'em. Polecenia i exit codes
są w `checks.json`; stan wrappera jest w przypisanym `build-status.json`.

## 4. Chronologia Robin / Neumann i tożsamość builda

| Etap | Dane i znaczenie |
|---|---|
| Starszy `k0-kittel-cpu-v3` | Robin, `beta=25e6 1/m`, gauge `none`; 15 punktów, max error `0.039032979923277054` (3.9033%). Osobny punkt odniesienia. |
| Manifest z 2026-09-01 14:47:29 UTC | Dirty snapshot `4c66a153388aff3ef1e84eff5d02ea87aadbe181bb0723eaf4c0ecb52c803ca5`; **nie** tożsamość zachowanego wyniku Neumanna. |
| Neumann — embedded build 15:56:42 UTC | `git_commit=4c7897f218eb0c32612db1f43a844502a316b4f6`, `worktree_state=dirty`, snapshot `e5679faa14d8f6fc5010aef436c117aad52194e02caab50f3411d49ae5a8fd3a`. |
| Windows runtime manifest 16:02:51 UTC | Ten sam commit i snapshot `e5679…`; obraz `sha256:848bb9a918a0830dc9a2de563c79cd642520e18138e4724461f919f12288bb33`. |
| S00, 2026-09-09 22:30–22:31 UTC | Ponowny odczyt, dokładna kopia, niezależny recompute i powtórzenie odrzucenia bundle. Nie wykonano nowego solve'u. |

Odnaleziony zapis uruchomienia z 2026-09-01 16:01:02 UTC wskazuje
`C:/git/fullmag/worktrees/k0-exchange-only-diagnosis` i poniższą komendę.
Jest to **historyczny zapis, nie obecny runbook**: stare ścieżki storage nie
mogą być używane do nowego uruchomienia.

```powershell
$env:FULLMAG_WINDOWS_FEM_CPU_IMAGE='fullmag/fem-cpu:windows-local-k0-exchange-only-diagnosis-7fe878b5ed0d7dc8'
$env:FULLMAG_WINDOWS_BUILD_ROOT='C:\fullmag-build\k0-neumann-fresh-20260901'
$env:FULLMAG_WINDOWS_CACHE_ROOT='C:\fullmag-cache\k0-neumann-fresh-20260901'
$env:FULLMAG_WINDOWS_TEMP_ROOT='C:\fullmag-tmp\k0-neumann-fresh-20260901'
& .\scripts\windows\run_fullmag_docker.ps1 -BuildMode true -Frontend dev -Backend fem -Device cpu -RunMode headless -ScriptPath .\examples\fem_eigen_k0_kittel_periodic_airbox.py
```

Sprawdzono zachowany `local/bin/fullmag` i `fullmag-api`: ich SHA256 odpowiadają
polom manifestu. **Ważne ograniczenie:** `binary_sha256` tego manifestu hashuje
wrapper `fullmag` (3156 bajtów), nie właściwy `fullmag-bin`. Rzeczywisty
`fullmag-bin` ma obecnie SHA256
`c7bfc7a2a9ab15df726d00e050a622024d5b00cf9d8ba17a6dd36baccaa38382`;
jego nowy pomiar nie jest wstecznym dowodem build-time identity. W
`preservation.json` zapisano też pomiary `.so`, bez promowania ich do
historycznego, zweryfikowanego manifestu wykonania.

W sprawdzonych katalogach `state` obu historycznych namespace'ów oraz w
`C:/fullmag-tmp/k0-neumann-fresh-20260901` nie odnaleziono pełnego manifestu
dirty-file entries ani zmaterializowanego snapshotu. Historyczny build root
`C:/fullmag-build/k0-neumann-fresh-20260901` nie istnieje. Zakres poszukiwania
jest ograniczony; nie twierdzimy, że snapshot nie istnieje nigdzie indziej.

**Wniosek:** powiązanie danych i runtime manifestu po `e5679…` jest potwierdzone.
Równoważność tego dirty snapshotu z czystym `f0986ede…` pozostaje
**NOT VERIFIED**. Zachowany Git patch nie zastępuje brakującej listy dokładnych
dirty inputs i ich hashy. S13 nadal wymaga własnego immutable candidate.

## 5. Odtworzone kontrole C01–C03

| Kontrola | Exit | Wniosek |
|---|---:|---|
| C01: finalizacja `e3241af9…` ancestor mastera | 0 | Finalizacja została zintegrowana. |
| C01: `f0986ede…` ancestor mastera | 1 | Poprawka Gamma nie jest ancestor tej bazy. |
| C01: `master..codex/k0-exchange-only-diagnosis-20260901` | 0 | Dwa pending commity: poprawka i późniejszy merge. |
| C02: niezależny recompute z surowych solved points | 0 | 15 pól, `Ms=800000`, `gamma0=221100`, max `5.194679480952314e-14`. |
| C03: Neumann — oryginał | 1, oczekiwany | Konflikt tożsamości meshu. |
| C03: Neumann — kopia | 1, oczekiwany | Identyczny konflikt; kopia nie naprawia danych. |
| C03: Neumann z obiema opcjami Kittel | 1, oczekiwany | Ten sam błąd kontraktu. |
| C03: Robin z obiema opcjami Kittel | 0 | Obecny ogólny walidator akceptuje starszy bundle; to nie kwalifikacja S05. |

Dokładny odtworzony błąd:

```text
eigen/modes/sample_0000/mode_0000.json.source_mesh_topology_sha256
vs source_mesh_identity.topology_fingerprint
got:      sha256:f4fec5288a6d60572e746a6f49d0609e6e59400a6e90bcecc90a05daa166ab2f
expected: sha256:24b579a71f974f28bf441ab35adca69326ad4faf8514a3daacb00f449190cc03
```

Solver diagnostics nadal zapisują `production_cpu`, `pure_neumann`,
`mean_zero_augmented`, `robin_beta=0`, `solve_succeeded=true`, ale też
`validation_state=unvalidated`, `spectrum_completeness=selected_only`,
`window_complete=false`. Fit ma `validation_status=passed`, lecz
`status=partial`, `complete=false`, `statistical_fit_covariance_not_available`.
Nie utożsamiono tych różnych statusów i nie poprawiano ich ręcznie.

## 6. Inwentaryzacja Q1 / Q2 / Q3

`historical-inventory.json` obejmuje **62 katalogi** w trzech jawnych rootach:
historyczne `C:/fullmag-cache/state/fem-gpu/reports`, przeniesione raporty pod
`storage/migrations/checkout-compat-20260909-212136/dot-fullmag/reports` i dwa
K0 `.zarr` w historycznych `examples`. 37 katalogów ma modal solver diagnostics,
9 zawiera tylko markery storage, 3 są puste. To inwentaryzacja, nie ponowna
kwalifikacja 62 przebiegów.

| Lane/bramka | Co znaleziono | Stan wymagania produkcyjnego |
|---|---|---|
| Q1 CPU film | Neumann Schur SLEPc 15 pól oraz liczne starsze warianty Robin; także wcześniejsze full-coupled fixtures | Wynik Neumanna odtworzony liczbowo; aktualny kompletny bundle i convergence pozostają do S04–S06. |
| Q1 CPU antidot/window | `periodic-antidot-q1-cpu-current` ma tylko marker; `.zarr` skanu antydotu ma 9 markerów, bez spectrum/solver diagnostics; przeniesiony `fem-periodic-antidot-relax-eigenmodes` ma 4 pliki, bez eigen diagnostics | `NOT VERIFIED`; brak końcowego okna w tych lokalizacjach nie jest globalnym dowodem nieistnienia innych runów. |
| Q2 GPU modal Poisson | `k0-kittel-gpu-v3` ma tylko marker; wcześniejszy GPU Kittel używa `cusolverdn_dense_k0_macrospin_modal` | `NOT VERIFIED`; makrospin i driven-response GPU nie są dowodem gauge/residency/parity pełnego Poissona. |
| Q3 API/FMS/browser | W dwóch jawnych katalogach Control Room nie znaleziono nazw plików K0/frequency/eigen ani `.fms` | `NOT VERIFIED`; filename-only search nie wyklucza dowodu pod inną nazwą. Brak powiązanego receipt w S00. |
| FDM CPU / GPU | Nie są przedmiotem tego planu FEM K0 | `not_applicable_with_reason`; bez nowego claimu fizyki FDM. |

Starszy summary CPU/GPU z błędami około `1e-14` zachowuje własny zakres
makrospinowy. Nie wolno użyć go jako zamknięcia Q2 lub pominąć go w historii
tylko dlatego, że nie kwalifikuje bieżącego produktu.

## 7. Ledger i dalsza praca

Maszynowy ledger z SHA dowodów oraz source mapą:
[2026-09-10-fem-k0-s00-baseline-and-evidence.ledger.json](2026-09-10-fem-k0-s00-baseline-and-evidence.ledger.json).
Klasyfikacja wszystkich 34 plików poprawki:
[2026-09-10-fem-k0-s00-patch-inventory.md](2026-09-10-fem-k0-s00-patch-inventory.md).

| S00 outcome | Status | Następny krok |
|---|---|---|
| Checkout/refs/chronologia | `verified` | Zachować pełne SHA jako baseline; nie przypisywać dirty runu do czystego commita. |
| Oddzielny worktree/profile/owner | `verified` | Zakończyć cykl integracji dokumentów; zachować storage. |
| Bundle + manifest + wykres/input | `verified` | Używać kopii do regresji S04, nie modyfikować historycznych danych. |
| C02 i negatywny C03 | `verified` | Naprawa writerów dopiero w S04, z regression testem. |
| Runtime manifest/command search | `verified` w zakresie poszukiwania | Dirty snapshot→commit oraz pełna tożsamość executable pozostają `NOT VERIFIED`. |
| Klasyfikacja patchy i decyzja o imporcie | `verified` | S01 uzgadnia kontrakt; S02/S03 integrują dopiero sprawdzone hunki. |
| Q1/Q2/Q3 inventory | `verified` w zakresie poszukiwania | Nie podnosić statusu naukowej/produkcyjnej kwalifikacji. |

Następny etap planu to **S01: kontrakt granicy i zakresu produkcyjnego**.
S00 nie naprawia artifact identity, gauge GPU, convergence, window ani UI.
Nie uruchomiono nowego native FEM, GPU trace, browser/WebGL ani pełnego DoD.
Stan PR/integracji/retencji jest rejestrowany osobno w oryginalnym rekordzie
worktree; samo `verified` powyżej nie oznacza zakończonego cleanupu.
