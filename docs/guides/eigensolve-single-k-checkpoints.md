# Surowy checkpoint jednego próbnego punktu FEM

## Cel i granica dowodu

`single_k_checkpoint.rs` udostępnia bezpośredni writer `write_raw_single_k_checkpoint(process_root, sample_index, requested_global_k_rad_per_m, point_plan, artifacts)`. Zachowuje dokładne bajty punktowego `FemEigenPlanIR` z `serde_json::to_vec`, pełny przekazany slice oryginalnych `AuxiliaryArtifact` oraz manifest SHA-256. Jego kontrakt pozostaje taki sam: `process_root` jest istniejącym bezwzględnym katalogiem, a nazwa próbki w tym root pozostaje niezmienna. Plan musi wskazywać ten sam pojedynczy wektor `k`; plan bez `k_sampling` jest dopuszczony wyłącznie dla dokładnego Γ `[0, 0, 0]`. Plan ścieżki jest odrzucany.

Przykładowa struktura dla próbki 7 w świeżej próbie:

```text
<output_dir>/eigen/raw-checkpoint-attempts/attempt-<pid>-<unix-nanos>-<counter>/
  eigen/sample-checkpoints/sample-0007/
    point-plan.json
    artifacts/
      eigen/spectrum.json
      ...pozostałe oryginalne artefakty...
    manifest.pending
    manifest.json
```

Manifest `fullmag.single_k_checkpoint.internal.v1` używa pola `schema` i zawiera indeks próbki, globalne `k` w `rad/m`, rozmiar i digest planu, listę artefaktów (`relative_path`, źródłowa ścieżka, rozmiar i SHA-256) oraz jawne pola `result_disposition=raw_native_returned`, `requires_postsolve=true`, `campaign_complete=false`, `branch_tracking_complete=false`, `scientific_qualification=NOT VERIFIED`. Digesty są zapisane jako 64 małe znaki szesnastkowe bez prefiksu. Gotowe bajty manifestu są najpierw zapisywane i synchronizowane pod nazwą `manifest.pending`; końcowy `manifest.json` jest publikowany jako no-replace hard link i stanowi ostatnią operację. Jeśli system plików nie obsługuje hardlinków, zapis kończy się błędem bez słabszego fallbacku, a plik pending zostaje. Odbiorca musi odrzucić brakujący lub nieparsowalny manifest i ponownie sprawdzić digesty. Sama obecność checkpointu dowodzi zachowania bajtów, nie poprawności solvera, akceptacji punktu, kompletności kampanii, śledzenia gałęzi ani kwalifikacji naukowej.

## Zachowanie zapisu

Funkcja wymaga istniejącego, bezwzględnego `process_root`, sprawdza symlinki i punkty reparse w ścieżce oraz rodzicach, odrzuca istniejącą nazwę próbki i nie nadpisuje plików. Przed utworzeniem namespace sprawdza skończoność `k`, zgodność punktowego planu, niepusty zestaw artefaktów, dokładny `eigen/spectrum.json`, portable path components, nazwy zarezerwowane Windows, aliasy bez uwzględniania wielkości liter i kolizje prefiksów plik/katalog.

Każdy nowy payload i `manifest.pending` powstaje przez `create_new`, a po zapisie jest wywoływane `sync_all`. Publikacja markera używa atomowego hard linku bez nadpisania. Błąd zachowuje już utworzone częściowe dane; czytelnik ignoruje `manifest.pending` i traktuje wyłącznie poprawny `manifest.json` jako marker. Funkcja nie obiecuje trwałości wpisów katalogów po utracie zasilania, szczególnie na Windows/CIFS.

Checkpoint zachowuje pełną surową closure, więc może zauważalnie zwiększać zajętość storage i I/O. Nie usuwa checkpointów automatycznie po zakończeniu i nie wykonuje cleanupu; retencja wymaga osobnej, jawnej decyzji. Przekazane artefakty są kopiowane, bez zmian w kanonicznym `eigen/path/spectrum` i bez modyfikacji statusu `ExecutedRun`.

Przed uruchomieniem solvera hook przygotowuje output root: ścieżkę względną rozwiązuje względem bieżącego katalogu, tworzy brakujące katalogi komponent po komponencie i odrzuca każdy napotkany symlink lub punkt reparse. Dopiero po tej kontroli ścieżki z kropką i parent są normalizowane. Znormalizowany output root pozostaje katalogiem wyjściowym i stagingiem puli; surowe hooki serial/bootstrap zapisują pod świeżym attempt root utworzonym dla tej próby. Katalog próby ma nazwę z PID, czasem Unix w nanosekundach i licznikiem atomowym; istniejące próby nie są ponownie używane ani usuwane. Bezpośredni writer zachowuje dotychczasowy kontrakt: zapisuje niezmienny sample-XXXX w istniejącym katalogu przekazanym jako process_root.

## Wskazówki integracji

- **Serial po rzeczywistym native solve:** punkt wywołania znajduje się w `crates/fullmag-runner/src/fem/eigen_path.rs`, w `KSolverAdapter::solve_single_k`, gdy lokalne `executed` zawiera `auxiliary_artifacts`. Hook powinien zapisać surowy wynik przed dalszą walidacją magnetyzacji i parsowaniem widma. Adapter potrzebuje jawnie przekazanego zarządzanego `process_root`; nie wyprowadzać storage ze ścieżek artefaktów.
- **Bootstrap adaptive:** w `crates/fullmag-runner/src/fem/eigen_k_pool.rs`, po powrocie `bootstrap_run` i przed uruchomieniem workera/puli. Zapisać `bootstrap_point_plan`, `bootstrap_sample.sample_index`, jego dokładne globalne `k` i oryginalny slice z `bootstrap_run`. Ten checkpoint ma zachować surowy zwrot native także wtedy, gdy późniejszy parsing lub reszta puli zawiedzie.
- **Pozostałe próbki adaptive:** rodzic może użyć helpera po zweryfikowanym wczytaniu artefaktów workera, jeśli worker nie zapisał już tej samej closure przed wysłaniem odpowiedzi. Nie kopiować jej drugi raz wyłącznie dla nowej etykiety; istniejące odpowiedzi i artefakty workera same pozostają dowodem, który należy sprawdzić. Ostateczny wybór hooka należy do integrującego rodzica.

## Weryfikacja

W module przygotowano inline Rust regression cases dla hashy dokładnych bajtów, Γ bez jawnego k_sampling, niezgodnego k, planu ścieżki, pustego lub brakującego spectrum, niebezpiecznych i kolidujących ścieżek, istniejącego namespace, symlinka, błędu I/O przed manifestem, przygotowania względnego i nieistniejącego output root, bezpiecznego parent normalization, prefiksu niebędącego katalogiem, dwóch zapisów tego samego sample index w oddzielnych próbach oraz równoległej alokacji prób. Zgodnie z obowiązującym zakazem testy Rust nie zostały skompilowane ani uruchomione. rustfmt --check jest kontrolą parsowania i formatowania, nie runtime IO ani dowodem integracji hooków. Managed wykonanie solvera i zapis na rzeczywistym mount pozostają NOT VERIFIED.

## Stan podłączenia i konsument

Hooki źródłowe zapisują serial native return oraz bootstrap przed uruchomieniem puli. Nie tworzą checkpointów synthetic K0 ani nie kopiują ponownie pól workera adaptive. Brak zarządzanego output root (wywołanie in-memory) pozostawia wcześniejsze zachowanie; nie wprowadza alternatywnego storage. Każdy punkt nadal wymaga osobnego postsolve, a cała ścieżka wymaga trackingu i końcowych artefaktów.

Read-only konsument `scripts/inspect_eigen_sample_checkpoint.py` sprawdza exact closure i plan/k/index, odrzuca aliasy/reparse points, używa stabilnych odczytów oraz dekoduje widmo z tych samych zahashowanych bajtów. Wynik pokazuje wyłącznie raw mode frequency w Hz, zawsze `requires_postsolve=true` i `scientific_qualification=NOT VERIFIED`. Nie jest importerem ukończonego runu, bramką residualu, wznawianiem ani certyfikatem native build identity. Namespace ma być niezmienny podczas odczytu; konsument nie jest systemową granicą uprawnień wobec obcych procesów.

```text
python -B scripts/inspect_eigen_sample_checkpoint.py <managed-output>/eigen/raw-checkpoint-attempts/attempt-<pid>-<unix-nanos>-<counter>/eigen/sample-checkpoints/sample-0007
python -B -m unittest discover -s scripts -p test_inspect_eigen_sample_checkpoint.py -q
```

Domyślne jawne limity inspekcji: JSON 64 MiB, pojedynczy artefakt 1 GiB, całe closure 4 GiB, 4096 artefaktów. Można je zmienić przez `--max-json-bytes`, `--max-artifact-bytes`, `--max-total-bytes`, `--max-artifacts`; wszystkie muszą być dodatnimi liczbami całkowitymi. Przekroczenie kończy się jawnym błędem.

16 interpretowanych kontroli konsumenta PASS dotyczy fixture i ochrony odczytu. Rust regression source, managed mount/hardlink support, trwałość writer IO, zachowanie punktu po awarii następnego oraz sam solver nadal NOT VERIFIED. Przed użyciem nowego binarium wymagana jest managed próba na rzeczywistym mount. Istniejący atestowany #223 nie zawiera tego helpera i pozostaje osobną możliwością serialnego sweepa po odzyskaniu Dockera.


## Granica commita źródłowego

Samodzielny commit obejmuje helper IO, jego rejestrację modułu, read-only konsument, interpretowane testy i tę instrukcję. Hooki w `eigen_path.rs` oraz `eigen_k_pool.rs` są w bieżącym worktree jako zależna część nieukończonego pakietu adaptive/API/runtime; nie są dowodem podłączenia na remote ani aktywacji w binarium. Zakwalifikowanie całego przyrostu wymaga ich spójnego commita, managed buildu i rzeczywistego przerwanego sweepa. Dodatkowa przygotowana regresja Rust sprawdza zachowanie pierwszej próbki po błędzie późniejszej oraz brak końcowych manifestów kampanii; nie została uruchomiona.
