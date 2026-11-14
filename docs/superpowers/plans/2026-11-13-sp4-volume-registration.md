# Domknięcie migracji magazynu SP4

Cel: wykonać zatwierdzoną migrację obu datasetów do nowego ext4 i umożliwić
dalszą serię SP4 z pełnym Zarr. Nowy mount i provisioning są już potwierdzone;
grupa 3274 nadal działa na oryginałach. Nie zatrzymywać jej do niegotowej ścieżki.

1. Dodać odczytową kwalifikację pełnego nowego Zarr: dokładny run/skrypt/build,
   wymuszona realizacja FEM bez fallbacku, wszystkie tablice, energie i torque
   do 1e-8 T. Sprawdzić zapisane native residuum do 1e-12 i osobno przypiąć
   źródłowy kontrakt jego niezależnego wyznaczenia; nie nazywać odczytu Zarr
   nowym przeliczeniem operatora.
2. Powiązać rzeczywisty StartedGroup z dokładnym wykonaniem przez standardowy
   launcher, nowymi bindami, świeżym probe zapisu obu datasetów i wynikiem Zarr.
   Qualification scope zamknąć i ponownie sprawdzić przed publikacją.
3. Końcowy publisher pod oryginalnym hostlock i nową operacją grupy przyjmuje
   już wykonane dowody runtime/Zarr, zapisuje receipty i fazy journala, następnie
   registration i referencję indeksu przez CAS z zachowaniem cudzych pól.
   Pierwszy append zużywa dotychczasowe capability. Nie poszerzać ich allowlist.
4. Dla pending + registration wymagać osobnego końcowego commit-witness,
   opublikowanego po sprawdzeniu pary i terminalu volume-registered. Częściowa
   publikacja blokuje zwykły startup. Grupy bez pending zachowują zachowanie.
5. Po testach i review połączyć istniejące managed copy → bind → admission →
   restart → świeży pełny Zarr → rejestracja w jednym żywym hostscope. Dopiero
   potem, po świeżej kontroli referencji i zgodności archiwum, wykonać osobny
   etap usunięcia dokładnych starych duplikatów WSL.

Odbiór: dowody pochodzą z rzeczywistego nowego runtime i pełnego Zarr na nowym
ext4; zwykły guard akceptuje kompletną rejestrację, a odmawia każdej niepełnej
parze/commitowi. Wyniki, archiwum i pozostałe środowiska pozostają zachowane.
Kwalifikacja magazynu nie zastępuje pełnego porównania czterech solverów z
MuMax3 GPU ani kwalifikacji dynamiki SP4.
