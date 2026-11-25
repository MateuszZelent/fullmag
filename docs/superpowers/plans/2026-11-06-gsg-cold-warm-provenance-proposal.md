# GSG: stabilna identyfikacja przygotowania i zapis dowodu zagęszczenia

> Wymagana metoda wykonania: zachować istniejące worktree WSL i receptę kontenerową just; implementacja w tej sesji po przeglądzie użytkownika.

## Stan i cel odbioru

Odtworzenie wyników Sushruth et al. (2020) pozostaje priorytetem i NIE jest potwierdzone.
Zachowane V/J/H100/75/50nm istnieją, ale eta50/eta75≈0,913 przekracza uprzednio ustaloną granicę0,8.
Kontrole9/9 punktów H potwierdzają całkowanie dla tego samego zachowanego źródła; nie zastępują zbieżności transportu lub odpowiedzi fal spinowych.
Nowy lokalny mesh bulk75/local50nm jest diagnostyką zagęszczenia obwodu, nie kolejnym globalnym poziomem dawnej serii.

Ostatnia zatwierdzona próba prepare-only72d5a8ef82614288bb3f8e80e9a2584a została wykorzystana.
Publiczny CLI zakończył się exit0, ale końcowy kontroler słusznie odmówił odbioru: failed-confirmed/exit2.
Zachowano34265Tet4/12586węzłów. Nie wykonano nowego Solve.
Ten plan nie uznaje historycznej odmowy za sukces ani nie omija porównania hashy.

Cel: nowy cold prepare i warm export muszą opisywać identyczny kanoniczny mesh oraz źródło,
przy zachowaniu statystyk i rzeczywistego dowodu wykonania size fields poza zadanym workflow.

## Przyczyny potwierdzone kodem i danymi

1. Mesher dopisuje _gmsh_status/_gmsh_field_id do współdzielonych deskryptorów.
   Cold producent hashuje zmutowany zamiar, warm cache już go nie mutuje.
   Różnica źródła obejmuje wyłącznie cztery pochodne pola digestu.
2. Python MeshData.to_ir dołącza diagnostyczne mesh_statistics. Rust MeshIR/FemMeshAssetIR nie mają tego pola.
   Round-trip usuwa je, choć wszystkie współrzędne i pozostałe wspólne wartości są identyczne.
   Pole o tej nazwie w FemSharedDomainBuildReportIR nie jest polem object assetu.
3. Dotychczasowy cache nie zachowuje raportu wykonania zagęszczenia. Zadane parametry nie dowodzą statusu applied.

Nie zmieniamy kodera tożsamości, preimage źródła, walidatora porównań ani modelu matematycznego.

## Wybrany wariant i alternatywa

Wybrano odłączenie wykonawczych deskryptorów na granicy meshera oraz addytywny raport cache/receipt.
Zachowuje to zarówno requested intent, jak i resolved execution.
Samo usunięcie prywatnych flag po meshowaniu byłoby krótsze, lecz gubiłoby dowód wykonania;
nie stanowi przyjętego wariantu. Nie zmieniamy istniejącej umowy aliasowania deskryptorów w ogólnym plannerze.

## Konkretny kandydat

Patch przygotowano wyłącznie w prywatnym control volume, NIE zastosowano go do produkcyjnego Python.
Ścieżka względem rootu tego wolumenu:
verification/gsg-junction-preparation-20261106/cold-warm-provenance-proposal-v1/candidate.patch

**SHA256: 4290ce356183511dc4a19ed7bde9f09c842ec967904b963de00d251f72ccdc4a**,20534B.

Zakres dokładnie czterech plików:
- packages/fullmag-py/src/fullmag/meshing/_gmsh_types.py:
  opcjonalne size_field_realization, walidacja JSON i schematu mesh_size_field_realization.v1,
  round-trip JSON/NPZ, zachowanie przez oriented_copy i from_legacy_tet4.
- packages/fullmag-py/src/fullmag/meshing/_antenna_coincident_cut.py:
  głęboka kopia size_fields/lower_bound_fields na granicy wykonania,
  raport istniejącego _realized_size_field_report, zachowanie raportu przez sourcecut.
- packages/fullmag-py/src/fullmag/runtime/antenna_coincident_materialization.py:
  niezależny snapshot workflow, kanoniczny numeryczny mesh bez mesh_statistics;
  pełne statystyki zachowane w istniejącym otwartym receipt jako prepared_mesh_statistics.
  prepared_size_field_realization oddziela recorded/report od not_recorded/null.
- packages/fullmag-py/tests/test_antenna_size_field_provenance.py:
  samodzielne testy bez prywatnych plików/cache.

Brak zmian Rust/ProblemIR, algorytmu źródła, geometrii, tolerancji, CPU/RAM lub polityki kwalifikacji.
To nowy wersjonowany raport metadanych; nie jest certyfikatem poprawnego pola.
Stare cache bez raportu pozostają czytelne jako not_recorded; bez migracji, przepisywania lub domyślnego applied.
Numeryczny MeshIR i fingerprint topologii nie zawierają nowego raportu.
Nie promujemy starego wyniku do bazy H/I, FFT lub LLG.

## Wykonane dowody kandydata

- Dziesięć regresji odtwarzało błędy na źródłach produkcyjnych; kandydat je naprawił.
- Niezależny przegląd wskazał utratę raportu w oriented_copy i zależność testów od prywatnego cache.
  Obie uwagi domknięto: test odwróconego Tet4 najpierw FAIL, potem PASS; fixtures są samodzielne.
- Końcowo11/11 PASS,0,138s w istniejącym backendzie,1CPU/AS4GiB,
  z zakazem importu/dlopen Gmsh/MFEM. Nie kompilowano testów Rust.
- Odczytowy publiczny accepted_source_capture na zachowanym wejściu72d5a8ef:
  inventory/export exit0, stderr0, dzieci zebrane, bez Gmsh/prepare/Solve.
  Mesh i źródło dokładnie zgodne z zachowanym requestem publicznego CLI;
  statystyki zachowane dokładnie, stary cache uczciwie not_recorded.
  Dowód dotyczy kandydata przed jednowierszowym zachowaniem raportu w oriented_copy;
  ten dodatkowy przypadek pokrywa końcowa regresja.
- Testy nie zastępują nowego rzeczywistego cold prepare ani naukowej zbieżności.

Dowody: candidate-v3.stderr.log/candidate-v3.json, candidate-review-red.stderr.log,
candidate-source-pins-v3.json i saved-input-public-capture/result.json w tym samym katalogu wolumenu.
Źródłowy inventory SHA256:0f54fcdb21065fc172af94d8140448a19aaf5da03ececfe956c9d5445030fd2d.

## Plan wdrożenia po zatwierdzeniu

1. Potwierdzić aktualne źródła i ich bazowe SHA z candidate-source-pins-v3.json.
   W razie zmian przerwać aplikację patcha, nie nadpisywać cudzej pracy.
   Zastosować wyłącznie przypięte cztery pliki; indeks Git pozostawić zachowany.
   Odbiór: diff zgodny z patchem, świeże importy i11regresji bez meshera PASS.
2. Wykonać dokładnie JEDNĄ nową próbę prepare-only50nm niezmienioną receptą:
   just docker-dev-gsg-mesh-prepare <bieżący worktree> <DEV attempt> <config SHA> 50.
   Recepta zachowuje producenta cold cache, publiczny run-script-accepted --prepare-only,
   inventory i końcowy warm export. Brak automatycznych ponowień.
   Odbiór: wszystkie fazy exit0, dzieci zebrane, terminal success kontrolera,
   identyczności request/producer/inventory/mesh/source PASS.
3. Sprawdzić raw cache i receipt: rzeczywisty recorded/report dla obu zadanych lokalnych pól,
   brak _gmsh_* w authored workflow, pełne statystyki poza kanonicznym mesh.
   Odbiór: brak utraty raportu po cache/sourcecut/orientation, dodatnie Tet4,
   pełne rozłączne pokrycie części, zgodne sourcecut/stable IDs, niezmieniony carrier20/24.
   Odmowa pozostaje odmową; niczego nie poprawiać w historycznych artefaktach.
4. Zapisać wyniki, pełne identyfikatory i terminalny stan w istniejącym dzienniku.
   W razie niepowodzenia zatrzymać tę serię. Przy sukcesie przygotowanie jest gotowe
   do osobnego, jawnie zatwierdzonego Solve; sam plan go nie uruchamia.

## Piny wykonania i ograniczenia

Worktree:/home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011
Branch:codex/antenna-transport-e2e-20261011
HEAD:8cfce0e19095609a921d4f92c15853c4ab8cb795
Grupa:fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1
DEV attempt:894d4efb43eb483eb6179d8d49fd449e
Config SHA256:1c0a74f52438f272836dd5c248dd06559cf19774c2c92b8394efd23a4ec10bd4
Kontroler SHA256:e7d67b33ad251c8f0b2d5d39e8e4b924cd422d56513a1d289fed19b3abee7e76

Nie tworzyć worktree, kontenera lub wolumenu. Użyć istniejącej grupy i cache jej próby.
Helper1CPU/AS4GiB, bez zwiększania limitów. Bez nowego buildu, restartu, Submit,
V/J/H Solve, H-only, LLG,35/25nm lub automatycznego retry.
Wyniki, historia i stare cache pozostają; wszystkie nowe duże dowody w prywatnym wolumenie.
Oryginalne63wpisy indeksu pozostają bez zmian; ewentualny późniejszy commit ma własny przegląd zakresu.

## Review Focus

- Mutacje cold wykonania nie zmieniają zadanego workflow/digestu.
- Stary cache bez dowodu nie otrzymuje statusu applied.
- JSON/NPZ odrzucają nieznany schemat, błędne wpisy i NaN.
- Sourcecut i naprawa orientacji zachowują raport oraz współrzędne fizyczne.
- Statystyki nie znikają przy kanonicznym round-trip Rust; strict identity pozostaje wymagane.

## Decyzja

Plan i patch są gotowe do przeglądu; wdrożenie czeka na decyzję użytkownika.
Powód: przekazane AGENTS.md§8 wymaga pytania dla zmiany wersjonowanego kontraktu,
a .agents/skills/writing-plans/SKILL.md wymaga: „wait for that review before implementation”.
Dotychczasowa zgoda obejmowała dokładnie jedną wykorzystaną próbę, nie nowy format raportu.

## Wykonanie po zatwierdzeniu — 07.11.2026

Powyższe sekcje dokumentują projekt przed decyzją. Użytkownik zatwierdził
dokładnie patch4290ce… i jedną próbę prepare-only50nm. Odczytany przed
wdrożeniem plan miał SHA25634c906356ad6e36eddeba477fa0913fce9035729c5db40c41a8993be9fef97cb.
Patch zastosowano bez zmian, po sprawdzeniu trzech bazowych SHA.

**Odbiór przygotowania PASS; Solve niewykonany.**
Operacja155483362d284e87a8113daddc76119b ma state=succeeded,
recepta just exit0, pełny stdout i stderr zachowane. Czas całej recepty154,344s.
Inventory przed/po/final i producent exit0, publiczny CLI exit0;
wszystkie dzieci zebrane. Nie wykonano retry, buildu lub restartu.

| Wielkość | Rzeczywisty wynik |
|---|---|
| Raw cache | 12573węzły/34243Tet4 |
| Po rozcięciu źródła | 12589węzłów/34243Tet4,18par powierzchni |
| Raport zagęszczenia | recorded, schema mesh_size_field_realization.v1 |
| Oba lokalne pola | applied, rzeczywiste Gmsh IDs1 i2 |
| Numeryczna siatka i źródło | producent i publiczny CLI identyczne |
| Statystyki i workflow | zachowane dokładnie w receipt |
| Zadany workflow | bez prywatnych flag _gmsh_* |
| Nośnik obserwacji | niezmieniony,20węzłów/24Tet |
| Cache przed/po odczycie | identyczny; nowy raport zachowany |
| Native limit liczby par/eta-helper cells | nieprzekroczony; nie oznacza kwalifikacji bazy |

Compact request SHA25658dc1e2a4cde747c18a88920960789d5e25fd2f7df3ba0640581fc3650f7737e.
Result SHA25663dde92ee34f9296d857feff80d2bd3616cede25b16fc5a9e450c24f56365259.
Source mesh SHA2569dd1a99d7862f5c9ce630c42747d35ec4071c9d79cb784e909bc0603b6a3ff63.
Source SHA256afbaaaef1140e6f5c2ebadf31f3cf8068e6f399247f7500741ec50695bff3f6b.
Raw cache1540172B, SHA25622eda14183924282788b6c026d4703a8c08350ee561b449f5c6ce844a0c3da4d.

Po wdrożeniu11/11 regresji PASS na rzeczywistych źródłach.
Osobno11/11 PASS na czystej kopii HEAD8e88448cbd338f552d7170070e66a37ac5609579
z wyłącznie zatwierdzonym patchem, bez wcześniejszych roboczych zmian GSG.
Nie powtarzano niezmienionych wcześniejszych testów kontrolera.

Dowody w prywatnym control volume:
verification/gsg-junction-preparation-20261106/attempts/155483362d284e87a8113daddc76119b/
oraz cold-warm-provenance-proposal-v1/approved-execution-20261107/
(application.json,tests.json,isolated-tests.json,managed-recipe-result.json,final-acceptance.json).
Nie modyfikowano dawnych cache lub historycznego Failed.

Wszystkie cztery kroki tego planu wykonano w zakresie prepare-only.
Na nowej siatce nie policzono V/J/H; oryginalna ocena eta i NOT VERIFIED
reprodukcji pozostają. Kolejny Solve wymaga oddzielnej decyzji, zgodnie
z zatwierdzonym ograniczeniem tego wykonania.
