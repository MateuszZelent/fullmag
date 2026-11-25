# Aktualizacja selektora anteny i nowa warunkowa próba corner25

Status: propozycja do decyzji, bez uruchomienia buildu lub nowej próby.
Ostatnia zgoda wykluczała build i restart, a jedno Prepare zostało zużyte
i zakończyło się odmową przed Solve. Pełny [wynik i przyczyna](2026-11-08-corner25-post-update-experiment-result.md).

## Gotowa poprawka

Commit: e78009f7c46c5f65da2c795e9650c371c490e071.
Zmiana produkcyjna obejmuje wyłącznie istniejący
script_stage_materialization.rs::parse_antenna_solve_selection:
dwa znane pola flag wykonania są dopuszczane po ścisłej kontroli boolean.
Nieznane pola, niepoprawne selektory i nieboolean nadal są odrzucane.
Parser niczego nie aktywuje ani nie modyfikuje. Dodano dwie regresje
w istniejącym module script_pipeline_compilation_tests.rs.

SHA256 patcha Git obejmującego te dwa pliki: c8fd0726c4742be1abea4aef457c4a248a7b2b4a6c37c1bc0ffc7e713576f82a.
SHA256 aktualnego roboczego pliku produkcyjnego (z zachowaniem jego starszych
niezacommitowanych zmian): d8f591bb992d8a7d4c87f44849b62c9228b1ebf19990df9570d6573b4115843f.
SHA256 aktualnego pliku testów: e2c3c737ac08b7b8b2f607d59d4b560ec1cdab7d52a608ee39b2aa1381272df2.

Dozwolone CI dla tego commita:
https://github.com/MateuszZelent/fullmag/actions/runs/42492318729.
Wykonanie poniższego zakresu wymaga jego pozytywnego końcowego odbioru,
w tym rzeczywistego wykonania nowych regresji. Sukces testów przeglądarkowych
nie zastępuje Rust. Nie kompilować lokalnie testów jednostkowych Rust.

## Zakres proponowanej jednej sekwencji

1. Zachować aktualny projekt i scenę, ponownie potwierdzić pustą kolejkę,
   brak aktywnych workerów/rezerwacji i operacji control oraz piny pakietu.
   Przygotować aktualny checkpoint istniejącej sesji authoringu. Nie używać
   starego checkpointu wskazującego inną inkarnację.
2. Jedna zarządzana aktualizacja wyłącznie grupy 3203, przez istniejącą
   docker-dev-restart-saved-authoring i jej natywny drain. Build w tym samym
   stałym backendzie; frontend w istniejącej usłudze. Zapisany projekt i wszystkie
   wyniki pozostają. Odmowa kończy zakres bez obchodzenia bramki i retry.
3. Odebrać rzeczywistą wersję, snapshot, receipty oraz hashe API/CLI nowego
   pakietu. Potwierdzić zachowanie sceny i dawnych wyników przez publiczne API.
   Sam udany build nie oznacza naprawy Prepare ani kwalifikacji fizyki.
4. Dokładnie jedno nowe docker-dev-gsg-mesh-prepare corner25 na tym pakiecie,
   z identycznymi 10 FIXED_FILES opisanymi w poprzedniej propozycji.
   Zachować cache. Nie przerabiać historycznej próby e3103f24 ani jej requestu.
5. Wyłącznie po pełnym odbiorze producenta i publicznego compact requestu,
   zgodnej fizyce, nośnikach, zasobach i bieżącym profilu — dokładnie jedno
   docker-dev-submit-accepted tego requestu przez istniejący trwały fence.
   Zapisać rzeczywisty SHA256 i tożsamość nowego runu przed Submit.
6. Obserwować dokładnie ten run/task do zakończenia. Odczytać zachowane
   V/J/H, wspólne provenance, bilanse i eta, porównać z local50 na tych samych
   20 targetach. Zachować wyniki i dane do ich interpretacji na WSL.

API/UI 3203 może być czasowo niedostępne podczas kontrolowanej aktualizacji.
Nie obiecujemy czasu buildu lub Solve przed pomiarem. Nie wykonano żadnego
z tych punktów na podstawie samego istnienia tego dokumentu.

## Przypięta grupa i granice

Worktree: /home/kking/git/fullmag/worktrees/antenna-transport-e2e-20261011.
Grupa: fullmag-worktree-antenna-transport-e2e-20261011-5d5deadcd16e0fb1.
DEV attempt: 894d4efb43eb483eb6179d8d49fd449e.
Config SHA256: 1c0a74f52438f272836dd5c248dd06559cf19774c2c92b8394efd23a4ec10bd4.
Backend: 05de79a8e6d4f33d1c7b8b201c69cc9813fa3beec0ccbe9d99013941de301ced.
Frontend: 271d8c4d455871a1b7b4b2fc34c55b9a122a3df305e0cd0c3382f072ac6779c4.
Obecny pakiet: 571513d2972cab78f3e355d0171fde51f3915b2955d875ed6c5664108b7f7578.

Żądanie: pełne GSG, FEM CPU/double/strict, 1000 mCPU, 4 GiB RAM,
512 MiB storage, 0 GPU. Te same 20 punktów H / 24 Tet4.
Ten sam profil volume_inspection_v1, tolerancje i dotychczasowe limity:
72 911 komórek, 4 mln par, request 96 MiB, spool 256 MiB.
Helper Prepare zachowuje 4 GiB przestrzeni adresowej i 1 CPU.
Nie zwiększać limitów grupy, zmieniać .env, montować nowych katalogów,
usuwać kontenerów/wolumenów, ręcznie czyścić cache ani modyfikować historii.
Istniejąca kwalifikowana automatyka retencji zachowuje current i rollback.

Brak H-only, LLG, nowych geometrii, profili, recovery i automatycznego retry.
Odmowa/Failed kończy sekwencję; utrata samej obserwacji nie upoważnia
do ponownego Submit. Źródło pozostaje inspection-only do pełnej kwalifikacji.
Raport nie zmienia równań ani nie ustanawia nowych progów zbieżności.

## Zakończona weryfikacja przed decyzją

CI42492318729 ma końcowy success dla commita e78009f7c46c5f65da2c795e9650c371c490e071.
Oba wybrane joby Rust i browser zakończyły się sukcesem. Pełny log Rust
potwierdza wykonanie obu nowych regresji zarówno we wcześniejszym filtrze,
jak i w pełnej grupie testów aplikacji. Nie jest to kwalifikacja naukowa źródła.
[Piny i logi](2026-11-08-corner25-post-update-experiment-result.md).

Odczyt cache potwierdził rzeczywiste zagęszczenie wszystkich ośmiu naroży:
mediana największej krawędzi elementu w pasie do100nm zmalała70,4202→39,9583nm.
Nie przewidujemy z tego wynikueta lub H. Nie zmienia to zakresu i limitów
opisanej powyżej jednej proponowanej sekwencji. Nadal oczekuje ona na decyzję.
