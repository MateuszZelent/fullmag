# Retencja Dockera i odzyskanie mastera — plan wykonania

**Cel:** zachować wyniki i aktywne zadania, wycofać kwalifikowane stare zasoby oraz umożliwić nowy bimeron przez `just fullmag master examples/bimeron-cylinder-relax/relax.py`.

**Baza:** `ffb1ee58a65685e1200e50cf11eaf9cf7d8c89af`; istniejący worktree `fullmag-console-20261104`, branch `codex/docker-retention-master-recovery-20261104`, owner `/root`. Bez nowej grupy aplikacji. Główny checkout ma obcą zmianę submodułu `external_solvers/3`, którą zachowujemy.

## Stan i granice

- Snapshot Dockera: 505 wolumenów, 432 nazwy zaczynające się od `fullmag`, 27 grup Fullmaga, cztery uruchomione. Nazwy i liczniki są obserwacją, nie listą do usunięcia.
- Ostatnia grupa bimeronu `fullmag-worktree-fullmag-cfc887ff26db7673` została przez użytkownika zatrzymana zarządzanym drainem. Wyniki pozostają w storage.
- `fullmag-master` ma nieznaną operację `recreate-services/c74e96cb2fb64e76a00baa6a89cd8e7c` po nieudanym bootstrapie snapshotu `c1b31c15d177439fb92ec3df61ca8e26`. Helper nie istnieje; dwa dokładnie przypięte kontenery są zatrzymane. Trzy katalogi przebiegów są terminalne. Nie ma autentycznego drainu dawnego ownera; nie wolno go fabrykować ani przejmować na podstawie PID/wieku.
- Jeden stabilny prywatny volume na grupę pozostaje obowiązkowy. Shared dependencies, control/provenance, aktywne piny i wyniki są chronione. Wszystkie mutacje mają dokładne cele, ponowny CAS i trwały receipt. Żadnego globalnego prune.

## 1. Recovery nieudanego bootstrapu

- [ ] Zachować istniejące ścieżki drain/recreate bez osłabiania ich dowodów.
- [ ] Dodać osobną kwalifikację preview/apply dla terminalnego snapshotu i przerwanej rekreacji: `native_owner_drained=false`, stary namespace oraz jego `active` pozostają niezmienione, nowy namespace w tym samym volume/projekcie nie odtwarza starych żądań.
- [ ] Powiązać registry, snapshot, provenance, development/Compose, unknown receipt, pełne container IDs/image IDs/StartedAt, OWNER/LAUNCH/process i config. Historyczność OWNER pozostaje diagnostyką: osobna kwarantanna nie certyfikuje drainu ani nie przejmuje OWNER. Jeśli historia nie jest potwierdzona, receipt jawnie zapisuje `owner_history_verified=false`; bezpieczeństwo wymaga pełnego inventory konsumentów, locków i terminal/released closure, nie wieku/PID.
- [ ] Pod istniejącymi blokadami potwierdzić terminalne katalogi, zwolnione wszystkie leases/reservations, brak niedokończonych komend/admission/helperów i obcych konsumentów. Powtórzyć odczyty bezpośrednio przed publikacją registry.
- [ ] Usunąć wyłącznie dokładnie przypiętą zatrzymaną parę dopiero po trwałym receiptcie kwarantanny; nie usuwać sesji, źródeł ani wolumenów z danymi.
- [ ] Zachować wykonywalne regresje odmów dla driftu, aktywnych locków/procesów/leases, niepotwierdzonego OWNER i nieznanego wyniku mutacji.

## 2. Retencja

- [ ] Powiązać kandydatów z bieżącymi i historycznymi tożsamościami oraz istniejącymi receipts; opisy `purpose` nie zastępują aktualnego inventory konsumentów.
- [ ] Użyć istniejącej retencji dla kwalifikowanych prywatnych cache i namespaces; brakujący bezpieczny etap wycofania zatrzymanych kontenerów uzupełnić z CAS i receiptami, bez globalnego usuwania.
- [ ] Rozliczyć pozostałość zakończonego `viz-parity` oraz własną zatrzymaną grupę bimeronu. Stare ledger volumes kwalifikować dopiero po zachowaniu wymaganych metadanych i sprawdzeniu odwołań.
- [ ] Zapisać konkretne pozostałe blokady zamiast uznawać `unreferenced` za zgodę na kasowanie. Potwierdzić inventory po apply oraz zachowanie aktywnych grup i katalogów wyników.

## 3. Integracja i sprawdzenie użytkowe

- [ ] Adekwatne testy sterownika, niezależny review, commit spójnych etapów, PR i wymagane CI, merge oraz fast-forward lokalnego mastera.
- [ ] Zbudować i uruchomić wyłącznie `fullmag-master` zarządzanym launcherem z limitem 64 GiB. Użyć dokładnie `just fullmag master …`; nie zastępować selektora worktree.
- [ ] Potwierdzić FDM CUDA, rDMI i parametry skryptu, postęp kroków, UI na 3342 oraz obsługę Ctrl+C przez foreground launcher. Po próbie zachować wyniki i pozostawić użytkownikowi jasne polecenie start/stop.
- [ ] Końcowy rejestr: pełne SHA/PR, receipts, liczby przed/po, konkretne zachowane zasoby z warunkiem ponownej oceny. Cleanup worktree wykonuje zachowany executor; aktywne przypięcie lub primary checkout pozostaje jawną blokadą.

## Checkpoint wykonania — 4.11.2026

Potwierdzone operacje (receipty znajdują się w stabilnych wolumenach control, bez zapisu danych buildu do storage hosta):

| Zakres | Dowód | Wynik |
| --- | --- | --- |
| Stara grupa bimeronu `fullmag-worktree-fullmag-cfc887ff26db7673` | retire-only `738e2ba8ad794426b3db516d08148389` | Usunięta dokładnie zatrzymana para backend/frontend po autentycznym drainie; runtime i ledger zarchiwizowane, bez uruchomienia następcy. |
| Cache tej grupy | retirement `3fd1eb5ec5d44f68a71ba5ee5cda4dd2` | Wyczyszczone kwalifikowane frontend cache/node_modules; usunięty prywatny package namespace `6820d82099c14490c1808e64e9d146be771748fef32c4af9fa1f7421f8fb2cbf` (80 plików). Control, diagnostyka, dane naukowe i shared dependencies zachowane. |
| Zablokowany master | recovery `d5caee179fce44569fa9eabc16bc7101`, finalny plan SHA256 `d2b70d08ce194a334047e1813b7cbe3160ef89620f2a824f9128195b2f80e64f` | Opublikowany nowy namespace w tym samym root volume i projekcie; dokładna stara para kontenerów nie istnieje. Stary namespace i OWNER niezmienione; `native_owner_drained=false`. Żadnych starych żądań ani Solve nie odtworzono. |
| Domknięcie mastera | `removed-containers.json`, SHA256 `64323d1757529fac0abe9a928f4d62be6814a8b52e8a3af8f88f69adce82c658` | Potwierdzone zakończenie tej samej operacji. Wersjonowany sidecar wiąże poprawkę parsera odpowiedzi Docker CLI; transakcja publikacji pozostała identyczna. |

Commity etapów: `38551cfdc3d9f32450614553c4d49d8ad2151f89` (recovery i retire-only), `aaa67d0d7baa2208a7223679e0ce50cbc5a9d08a` (tożsamość store i dwukierunkowy dowód locka), `870121f9f` (domknięcie po odpowiedzi Docker CLI małymi literami). Niezależny review nie zgłosił pozostałych P1/P2 w tych ścieżkach.

**Pozostałe wolumeny nie są zbiorczo zakwalifikowane.** Preview dla `fullmag-backend-v2-3922bf60bcdc7493e92f24fe-package` odmawia: `Reference root coverage incomplete: []`. Brak zarejestrowanego pełnego pokrycia historycznych consumer roots w Linux storage; dane konsumentów występują pod `runs`, `runtimes` i `user-data`, a audyt napotkał nieczytelne katalogi oraz limit rozmiaru metadata. Sam brak kontenerów lub referencji w przeczytanej części nie dowodzi zbędności. Następny krok wymaga kompletnego audytu odwołań i jego udokumentowanej rejestracji; nie ustawiono `legacy_inventory_complete=true` ani nie wykonano apply. Historyczne control/ledger, dane wyników, shared cache i wszystkie nieznane zasoby pozostają zachowane.

Lokalny `.env` głównego checkoutu ma port `3342` oraz limit backendu `64` GiB; kopia sprzed zmiany jest w user settings backups. Uruchomienie po integracji oraz cgroup limit wymagają jeszcze dowodu runtime. Aktualny rejestr zadania ma bazę `ffb1ee58a65685e1200e50cf11eaf9cf7d8c89af` i właściciela `/root`.
