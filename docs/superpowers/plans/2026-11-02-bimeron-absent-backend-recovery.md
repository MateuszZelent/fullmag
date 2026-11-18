# Odtworzenie grupy bimeronu po usunięciu backendu

Cel: wykonać jawnie zlecony rebuild backendu/frontendu i nowy Solve dla filmu z rDMI oraz walca R50/H30 nm ze szczeliną 5 nm. Zachować wszystkie stare runy, cache i ich nieznane historyczne stany.

Zakres źródeł: aplikacja pozostaje w `rdmi-object-scope-20261029/fullmag`; helper operacyjny w istniejącym `frontend-refresh-reconcile-20261030/fullmag`, owner `/root`, branch `codex/frontend-refresh-reconcile-20261030`, bazowy HEAD `56e701fa90e00a6b2d63790d0cbb1da7c63e396e`. Nie przejmować innych grup. Brak kompilacji unitów.

## Kontrakt i ograniczenia

- Usunięty kontener backendu jest faktem, nie dowodem historycznego drainu.
- Nie rekonstruować pozornego inspect ani prepared-before-removal. Nie zmieniać OWNER/process-tree, locków ani starych wyników.
- Nowy typ dowodu ma jawnie rozróżniać obecny, zatrzymany frontend od nieobecnego backendu. Przypina exact current/config/engine/IDs/OWNER/process/launch oraz tożsamości store i ledgera.
- Przyjąć wyłącznie pełny inventory runów/historii, brak żywych konsumentów i kwalifikowaną nieobecność starego backendu w inspect i inventory Dockera. Pod lease powtórzyć/CAS dowody przed mutacją.
- Odtworzenie nie uruchamia Solve. Nowe wejście jest osobnym żądaniem dopiero po zdrowym runtime i potwierdzeniu zgodnego buildu.
- GPU required, bez CPU fallback. Cache/build/logi/receipty wyłącznie w wolumenach przypisanej grupy Compose.

## Kroki

1. **Root + read-only explorer:** odczytać aktualny Docker/control/store; wskazać dlaczego standardowy up i istniejące recovery odmawiają. DONE: backend absent; frontend Exited255; brak prepared transition.
2. **Sol implementer, zakres `scripts/docker_volume_absent_backend_recovery.py`, interpretowane testy, minimalny glue:** najpierw zweryfikować natywny konsumujący kontrakt. Jeśli wymaga niedostępnego historycznego inspect, przerwać przed implementacją i opisać brakującą granicę. W przeciwnym razie dodać uczciwy, wersjonowany proof, read-only prepare oraz apply ze wznowieniem i istniejącą autoryzacją namespace absence. Nie osłabiać globalnych walidatorów.
3. **Root review:** sprawdzić exact scope, history/store/ledger identity, drift, obcego konsumenta, żywy proces, niejednoznaczną nieobecność, crash/reentry. Wykonać interpretowane testy regresji; żadnych unit-buildów. Dopiero po dowodach zapisać spójny commit helpera.
4. **Root runtime:** wykonać przygotowanie, przejrzeć konkretny proof/request, zastosować raz w grupie bimeronu, następnie managed build/start backendu i frontend. Potwierdzić receipt/source identity/API ready/GPU realization. Po nieznanym wyniku tylko odczyt i reconciliation.
5. **Root simulation:** aktywować raz zatwierdzony skrypt z film-only rDMI D=0.004 J/m² i H30/gap5. Potwierdzić accepted krok i dane obu obiektów. Raport `converged=false` pozostaje diagnozą osobnego błędu propagacji completion; nie zmieniać kryterium solvera.

## Aktualny stan

Nie rozpoczęto mutacji recovery ani rebuilda. Standardowe up odmówiło przed zmianą usług. Skrypt poprawiony, SHA256 `2a872ad769fdcc7b4f207a3379c3a11e5e25597e45d79a6c8fa59be7ac01f5cd`; kopia w katalogu qualification użytkownika. Diagnoza completion potwierdzona przez źródła i ponowny odczyt metadata zakończonego runu.

## Wynik oceny natywnego konsumenta

Krok 2 zatrzymany przed zapisem kodu: `runtime_service.py:3927–3951` wymaga rzeczywistych historycznych Config SHA, DeviceRequests SHA i private PID namespace z inspect usuniętego backendu. Zachowane current/Compose nie zastępują tych pinów; brak uprzedniego prepared/manifest. Nie sfabrykowano dowodu, nie zmieniano native request ani globalnych walidatorów.

Zadano użytkownikowi konkretny wybór: nowy build w niezależnej własnej grupie z zachowaniem wszystkich starych danych albo pełne wersjonowane rozszerzenie recovery. Zależne operacje czekają na odpowiedź.


## Historyczny checkpoint po kontynuacji

Powyższy opis zachowuje stan decyzji z etapu recovery. Dalsze wykonanie objęło
niezależną grupę `fullmag-worktree-fullmag-cfc887ff26db7673` i skrypt bimeronu
w tym worktree. Bieżące dowody build/runtime/parytetu i pomiarów znajdują się
w [planie wydajności](2026-11-02-bimeron-performance.md). Nie rekonstruowano
brakującego historycznego inspect, nie osłabiono kontroli ownera ani receiptów.
