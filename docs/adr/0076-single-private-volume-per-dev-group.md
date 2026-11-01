# ADR 0076: Jeden prywatny volume na grupę Docker DEV

Status: przyjęte 31.10.2026. To wiążący kontrakt topologii daily DEV. Zmiana
dokumentacji nie dowodzi implementacji; zgodność kodu, Compose, mountów i runtime
pozostaje **NOT VERIFIED** do czasu sprawdzenia na docelowym hoście.

## Kontekst

Dotychczasowe opisy i wersje launcherów tworzyły kilka prywatnych wolumenów dla
backendu, pakietu, frontendu, control i ledgeru. Klucze cache mogły zależeć od
toolchaina, profilu albo dependency identity, co mnożyło wolumeny dla tej samej
grupy. Zachowujemy grupową izolację i walidację fingerprintów, lecz stabilizujemy
fizyczną tożsamość prywatnego volume.

## Decyzja

1. Każdy zarejestrowany worktree/grupa Compose ma dokładnie jeden prywatny
   Docker named volume: istniejący stabilnie nazwany `BuildControl.volume`.
   Nazwa wynika wyłącznie z tożsamości Compose project/worktree. Nie zależy od
   toolchaina, profilu, dependency hash, portu ani attempt; zmiana tych wejść
   nigdy nie tworzy kolejnego prywatnego volume.
2. Zachowujemy dotychczasowy root volume jako root control/lock/namespace.
   Nie wymagamy nowego katalogu `control/` i nie zmieniamy zapisanej struktury
   receipts/locks. Backend i uprawnione helpery otrzymują dotychczasowy mount
   control rootu oraz wymagane subpath mounts.
3. Prywatne mutable dane grupy są rozdzielone ścieżkami wewnątrz tego volume:
   - `private/backend` → backend `/build` i jego cache, staging, cień źródeł,
     bounded build logs/provenance;
   - `private/frontend` → frontendowy workspace, `node_modules`, Next state i
     bounded frontend logs;
   - `private/ledger` → DEV `group-ledger-v1`, montowany do backendu pod
     dotychczasowym `/host-ledger`.
4. Frontend dostaje wyłącznie potrzebne frontendowe subpath oraz jawnie
   dozwolone mounty źródła/danych użytkownika. Nie montuje volume root, control
   namespace, `private/backend` ani `private/ledger`. Nie przyznawaj mu
   dodatkowego host namespace, Docker socketu ani praw do backendowego cache.
5. Project-scoped shared Cargo registry/git, pnpm store i immutable package
   store pozostają globalnymi wolumenami `fullmag-shared-*`. Pakiet grupy nadal
   należy do dokładnego `groups/<unit_key>` we shared packages; nie jest
   przenoszony do prywatnego volume. Obrazy i BuildKit pozostają magazynem
   Dockera. Nie hardlinkuj mutable danych pomiędzy wolumenami.
6. ABI, toolchain, dependencies i build inputs nadal wymagają fingerprintu i
   walidacji. Fingerprint steruje zgodnością cache i inwalidacją cache zależności,
   nigdy nazwą volume. Prywatne compiler outputs `.fullmag-build` podlegają
   osobnemu cyklowi z punktu 7. Rebuild nie czyści root control,
   `private/ledger`, źródeł checkoutu, sesji, wyników, projektów, historii ani
   innych danych użytkownika.
7. Zachowuj pakiet current i jeden zweryfikowany rollback do udanej atomowej
   publikacji następcy; nie usuwaj ostatniego dobrego pakietu przed publikacją,
   walidacją samowystarczalności i sprawdzeniem referencji/lease. Przed każdą
   rzeczywistą kompilacją czyść wyłącznie rozpoznane compiler outputs
   `.fullmag-build`; po publikacji i ponownej walidacji pakietu usuń je ponownie,
   zachowując workspace źródeł, logi/diagnostykę, current i rollback oraz
   control/ledger, a cache-hit current/shared nie czyści ani nie kompiluje.
   Nieudany build może pozostawić najwyżej jedną generację w tym samym katalogu
   do następnego prebuild; nie twórz volume’ów ani katalogów per-profile/attempt,
   runtime uruchamia verified package, a zmiana źródeł może wymagać pełnej kompilacji.

## Migracja i zgodność wsteczna

Stare Compose receipts i layouts pozostają czytelne dla odczytu i recovery.
Nie przepisuj ich w miejscu, nie twórz nowego volume jako obejścia blokady i
nie usuwaj dawnych volume’ów automatycznie. Migruj po jednej grupie, dopiero po
zarządzanym stop/drain oraz ponownej kontroli ownera, procesów, kontenerów,
mountów, lease, źródeł, config fingerprint i receipts. Zarchiwizuj wymagane
control/provenance i metadane starego layoutu. Zweryfikuj nowy volume mountem i
receiptami przed osobnym, dokładnym reference checkiem dawnych zasobów. Zachowuj
stare volume’y do zakończenia tych kontroli. Błąd, nieznany owner, aktywny
writer lub drift oznacza pozostawienie obu układów i recovery; żadnego global
prune ani dotykania cudzej grupy.

## Skutek i zakres

Ta decyzja supersedes rekomendację osobnych prywatnych `/build` i
`/opt/fullmag/package` z ADR 0061 oraz starsze topology tabele w przewodnikach.
Nie zmienia aplikacyjnych kontraktów pakietów, właścicieli/control namespace,
schematu `group-ledger-v1`, izolacji między grupami z ADR 0067, źródła ani
lokalizacji wyników. Dla DEV ledgeru zastępuje fizyczne położenie w osobnym
named volume po wdrożeniu, zachowując jego ścieżkę mountu i semantics.

Implementacja wymaga późniejszego potwierdzenia: Compose mounts per service,
stabilnego ID po zmianie toolchain/profil/dependencies, odmowy dostępu frontend
do root/backend/ledger, zachowania control/ledger/results po cache cleanup oraz
restartu i build cache reuse. Do uzyskania tych dowodów bieżący runtime jest
**NOT VERIFIED**.
