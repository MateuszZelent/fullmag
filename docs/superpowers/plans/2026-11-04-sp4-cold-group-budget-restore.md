# SP4: przywrócenie zapisanego budżetu grupy po cold startup refusal

## Cel i aktualne dowody

Dokończyć pierwotne porównanie SP4: FDM/FEM CPU/GPU z MuMax3 GPU,
relaksacje, wszystkie energie i torque, pełne trajektorie A/B do 1 ns,
oryginalny Zarr i działający podgląd. Ta poprawka usuwa blokadę startu FEM;
nie zastępuje pomiarów R2 ani pełnych symulacji.

HEAD `61ca893bcd92d7f1500a3735b1b03d883f6c9db3` przeszedł zarządzany native
contract `befa51bf46ba4412870f920a5f65c3e5` i opublikował pakiet. Snapshot:
`16faa0427e7fadbcc2812d9aa44303ede45a7b5ac9d01f0f76a34caacf3f60d7`.
Uruchomienie development `eb076337e6334725a2380a737c62345e` zakończyło się
`failed-confirmed`: cold diagnostic API odrzuca wyłącznie zmianę RAM
z efektywnych 31 GiB do 63 GiB. Backend ma odpowiednio 32/64 GiB;
pozostałe pola polityki są identyczne. Historyczny owner i process tree są
Drained. Zachowane 39 rezerwacji ma stan released; oddzielne sprawdzenie
release proofs i wszystkich lokalnych lease jest obowiązkowe przed mutacją.

Dowody: `diagnostics/cpu-fixed-coupling/current-head-native-passed-ledger-startup-refusal`
w zewnętrznym katalogu raportów zadania. Historyczny idle-drain:
`7c7acce90c7c4b8186017dbb9f14bbce`. Globalny `.env` pozostaje bez zmian.

## Rozstrzygnięcie i granice

Przywrócić dokładnie dotychczasowy budżet tej grupy z uwierzytelnionego ledgeru
i historycznego Compose. Nie migrować polityki group ledgeru do 64 GiB,
nie używać migracji host-capacity, nie tworzyć nowego ledgeru lub fresh state,
nie resetować ownera/lease, nie wykonywać Solve ani pozornego resume.
Budżet jest operacyjny; fizyka, siatka, stan początkowy, tolerancje i kadencja
obserwacji pozostają zgodne z przygotowanymi wejściami SP4.

Stare, wyspecjalizowane recovery predicates pozostają obowiązujące. Nowy
wariant ma osobny typ kontekstu i jawny producer/consumer; pusty słownik nie
może udawać dowodu recovery. Zmiana dotyczy jednej grupy DEV.

## Etapy i kryteria

1. Uwierzytelnić immutable failed-development/config oraz dokładny backend,
   image, StartedAt, API instance i startup failure fence. Jedyną różnicą
   requested/stored policy musi być wzrost memory_bytes; CPU, GPU, storage,
   host, topology, epoch i revision są zgodne.
2. Powiązać historyczne iteration terminal i receipt, backend-drain,
   process-receipt SHA, ready owner oraz obecny Drained/terminal owner.
   Nie zastępować tego dowodem terminal-observation z innego workflow.
3. Read-only helper musi zachować `HostConfig.Mounts.VolumeOptions.Subpath`
   rzeczywistego mountu ledgeru; znormalizowane `Mounts` nie zawiera subpath.
   Potwierdzić pod shared WRITER locks każdą rezerwację i jej release-proof
   SHA/identity oraz wszystkie compute/preparation leases jako released.
   Osobno sprawdzić terminalność run_catalog i zachować inventory hashy;
   brak żywych lub nieznanych procesów i wolny OWNER.lock są wymagane.
4. Preview SHA → trwały intent → stop wyłącznie bieżącego diagnostic API
   i supervisora → potwierdzenie graceful stop i incarnation → ponowne
   inventory → terminal journal. Nie nadpisywać starego native drainu.
5. Retained recreate uwierzytelnia journal i nakłada odtworzony budżet po
   `.env` i saved-budget, przed ostatecznym hashem Compose. RAM wyprowadza
   z zapisanej pamięci i istniejącego headroom, CPU z cpu_millis. Limity
   kontenera, FULLMAG_DOCKER_* i Cargo jobs są spójne. Pochodzenie override
   jest zapisane w receipt i zachowane przy następnym retained recreate.
6. Potwierdzić w realnym preview/apply brak zmian ledgeru, release proofs,
   lease, historii i oryginalnego Zarr. Uruchomić nowy backend zarządzaną
   trasą, z wymaganym native gate i bez startup Solve. Gotowość wymaga
   zdrowego API oraz aktualnego ownera, źródeł i opublikowanej biblioteki.

## Weryfikacja i własność

Implementacja: worker `cold_group_budget_restore`, source scripts/CLI/just
oraz focused interpreted Python tests. Root: ten plan, dokumentacja użycia,
review i rzeczywiste operacje runtime. Bez hostowej kompilacji i bez ręcznego
Docker restartu. Każdy build pozostaje w stałym backendzie przypisanej grupy.

RED/GREEN obejmuje rzeczywisty kształt cold memory-only increase z historycznym
drainem. Negatywne przypadki: Ready/unknown owner, aktywne lub niepotwierdzone
rezerwacje/lease/release proofs, zmiana innych pól policy, zły stary drain,
config/CAS/incarnation/fence, interrupted/nongraceful stop, zmiana inventory
lub restore pin. Testować parser → producer i consumer → render oraz
zachowanie native gate, explicit untracked inputs i braku Solve.

Po gotowości: pięć oryginalnych pomiarów Zarr na R2, porównanie A/B przy tej
samej liczbie wątków, wszystkie energie/pola/torque, memory/time, CI i review
PR #394, integracja najnowszego mastera. Następnie pełne FEM CPU/GPU A/B 1 ns,
powtórzenie końcowego czasu FDM CPU i końcowe porównanie z MuMax3 GPU.
Żaden z tych etapów nie jest ukończony przez sam pozytywny native contract.
