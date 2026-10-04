# P6-67 — propozycja zwolnienia miejsca na runnerze

Status historycznej propozycji: manifest zatwierdzony przez użytkownika 02.10.2026;
wszystkie 44 cele usunięte po ponownej kontroli. [Wynik wykonania](72-approved-cache-cleanup.md).

Proponowane cele to fizyczne katalogi `frontend/next/dev-3250` w zakończonych próbach fixture przeglądarkowego. Linki `.next-control-room-3250` pozostają w snapshotach źródeł; po usunięciu cache mogą być dangling do czasu odbudowy. Snapshoty, receipts, logi i zrzuty ekranu pozostają. Zakres nie obejmuje Cargo target, runtime, wyników naukowych ani worktree.

Dokładne bezwzględne cele: [manifest JSON](67a-terminal-frontend-cache-manifest.json).
Łącznie **44 katalogi, 11,441,688,600 bajtów logicznych (10.66 GiB)**. Odzysk miejsca trzeba zmierzyć; rozmiar logiczny nie jest gwarancją odzysku.

## Kontrole

- Receipts wskazują właściwy fixture, profil i checkout; zakończony stan oraz `owned_server_terminal=true`.
- Każdy link źródłowy rozwiązuje się do dokładnie wskazanego fizycznego cache danej próby. Fizyczne cele pozostają wewnątrz próby; nie stwierdzono linków/reparse points w celach ani ich poddrzewach.
- Odczyt Windows procesów nie wykazał node/python używającego fixture lub portu 3250.
- Runner montuje cały storage do `/storage`; mount nie został zignorowany. Aktualny odczyt: brak aktywnych jobs, zdrowy worker, `waiting_for_disk`, 631881728 B wolnego (około 0,59 GiB), próg 8 GiB.
- Przed wykonaniem ponowić kontrole aktywnych procesów, mountów, kolejki, receipt i containment, w tym wszystkich przodków ścieżek. Stwierdzone użycie wyklucza dany cel.

Niezależny przegląd z 02.10.2026: brak P0/P1. Potwierdzono 44 unikalne cele,
dokładną sumę rozmiarów, mapping junctionów, brak nieoczekiwanych reparse points
w celach i przodkach oraz brak aktywnych zarejestrowanych PID-ów serwerów.
Przegląd nie zastępuje ponownej kontroli użycia bezpośrednio przed operacją
ani zgody na usunięcie; manifest pozostaje niezmieniony.

Przewodnik `docs/guides/fullmag-build-storage-governance.md` wymaga: „pozostałe usuwanie wymaga osobnej autoryzacji dla dokładnych celów”. Zgoda dotycząca `_to_delete_legacy_web` nie obejmuje tych cache.

## Kandydaci

| Run ID | Stan | Cache MiB |
|---|---|---:|
| `06247ed07230446a875ebc690c032cf7` | failed | 465.7 |
| `0aa28875b1114b7a972f82814147cb50` | failed | 205.4 |
| `0dd2665a463940d380ffbf16394bde94` | failed | 202.7 |
| `14bcb2c7689f49c28920491da3b5e058` | passed | 202.3 |
| `23a8f44b80e243e9815504b772573ede` | failed | 468.3 |
| `2737a4f0f4844261b0c9b6b0293e7d8b` | failed | 201.8 |
| `315e151080844c2baaa1cf7d83956821` | failed | 184.2 |
| `3469f4eb4236478da9813a5254627678` | passed | 206.6 |
| `373378d47ba04d3ba20dc86c24975b79` | passed | 217.7 |
| `38dcbbde33e44f019610834ccad49809` | failed | 210.8 |
| `464b0e94d04744bb900cf487b5f6c20b` | passed | 195.3 |
| `48f34dbae7ba4db0bd724544749c18c8` | failed | 217.8 |
| `54f2b796a24a4c768b68cdb11704f508` | failed | 208.5 |
| `61eb30972324468a81cb4d3f5695b5ae` | failed | 210.1 |
| `67518819a1a745a78d58f2436be3ceb4` | passed | 195.9 |
| `746cd56dfe4c40639650fdfaede5c5aa` | failed | 467.7 |
| `7ef7ebe1e63a49eab25c66bf421767e0` | passed | 201.7 |
| `85131388173242c99beba44952deb2c4` | failed | 211.0 |
| `86b4eeaf24f94286be3b2e77d8a4487f` | failed | 185.3 |
| `8fc66d09571c4999930d0573a2bd42d1` | failed | 210.2 |
| `914c8069b85e4d23a319c3b4c6b3d829` | failed | 210.7 |
| `92d0c767518240f9aeb0e69907e74933` | failed | 185.5 |
| `9c7743582ed6453b90ee598f46701271` | failed | 217.3 |
| `9e025e380d434572ae1c9aceb721cc59` | failed | 199.9 |
| `9f07a06c5d634a4fa344538fe4691c4b` | passed | 205.7 |
| `a586f9a0ecc743fa8915d86115778fc5` | failed | 210.3 |
| `a83b0c506be44a1388d832a3781cb97c` | failed | 200.7 |
| `ac37d939885448959fa2cbf0d620ca47` | failed | 516.0 |
| `b4c7ef3944af42ebae4a71592e4693d2` | passed | 205.9 |
| `b6d08cb2db6d42cb93aa43555fbe8596` | failed | 194.9 |
| `b9944ecab1de494bae232da19d7572eb` | passed | 205.6 |
| `c2f9f0ff87fa4479b015563c68dc0d60` | failed | 470.0 |
| `c4db46c7c77d449ca8cafc2e032853e7` | failed | 215.8 |
| `c9e04a0b6fe64410a73d1d5b51fccf01` | failed | 456.8 |
| `cb544e6e39784f8e90d581f29c01c193` | failed | 217.7 |
| `d1a85d2572c64743b952d874cb7a41b3` | failed | 202.4 |
| `d4005c7b30454456a4cdcf239a289d91` | failed | 210.4 |
| `d836530e926145f58d371a3f3506764d` | passed | 217.6 |
| `daa68f0747e84930ba9158ecb4a3a52b` | passed | 207.8 |
| `dc1e76d4d26c49dd9b214ec311170dc8` | passed | 195.8 |
| `e122bce4d0ae4cd58460e3aac024c759` | passed | 206.1 |
| `e35a34cff59c42bea9cefff100567bc1` | failed | 217.6 |
| `f09ec602d25c42519084c13693372e74` | failed | 215.3 |
| `f9adf801660745d0b43b71473c4ef658` | failed | 456.9 |

Po zatwierdzeniu manifestu i ponownej kontroli użycia: usunąć wyłącznie dokładne fizyczne cele, zmierzyć wolne miejsce, wrócić do managed buildu i natywnej bramki P6-66. Zwolnienie miejsca nie jest kwalifikacją backendu.
