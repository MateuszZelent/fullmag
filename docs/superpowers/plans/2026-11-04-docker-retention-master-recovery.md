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
