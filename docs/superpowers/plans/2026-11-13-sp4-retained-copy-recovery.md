# Wznowienie kwalifikacji zachowanej kopii SP4

Stan: zatwierdzona migracja wykonała drain i odtworzyła PAX/payload na nowym
ext4. Końcowy manifest odmówił z powodu driftu fingerprintu pliku. Bind,
admission, restart i Solve nie wystąpiły. Journal/failure oraz oba oryginały
pozostają zachowane. Ten plan dotyczy koniecznej naprawy wykonania migracji;
nie udziela nowej zgody na usuwanie danych ani zmianę istniejących plików E:.

1. Oddzielić obserwacyjną alokację `st_blocks` od strażników niezmienności.
   Zachować dev/inode/type/mode/uid/gid/size/mtime/ctime, xattrs i SHA treści.
   Diagnostyka odmowy ma wskazywać faktycznie różniące się pola. Błąd tego
   guardu nie dowodzi, które pole zmieniło się w konkretnym zakończonym biegu.
2. Dodać jawne `recover-copy` wyłącznie dla potwierdzonej porażki kopiowania
   przed bindem. Nie ponawiać Create, Attach, formatowania, mountu ani zwykłego
   `copy_verified`. Nie nadpisywać starego requestu, failure ani journala.
3. Przed native fences i selector CAS wykonać uwierzytelniony odczytowy root
   probe wszystkich odmów, także prywatnego manifestu po częściowym v1.
   Probe jest obserwacją bez authority i bez zapisów. Znany klient musi być
   terminalny przed unwind. W jednej żywej blokadzie hosta i nowej operacji
   zarządzanej potwierdzić
   poprzedni terminal klienta i grupy. Ponownie sprawdzić konsumentów i zdobyć
   wszystkie pięć native fences. Odmówić przy dowodzie bindu/pending/registration,
   zmienionym urządzeniu/namespace/boot, źródłach lub niepotwierdzonym procesie.
4. Utworzyć osobny request i journal odzyskiwania. Journal dziedziczy dokładnie
   osiem udanych zdarzeń przez `group-drained`; wskazuje zachowany failed parent
   i poprzedni selector. Selector przełączyć przez CAS. Nowe zdarzenia kopiowania
   wskazują nowy request recovery; stary request pozostaje historycznym intentem.
5. Izolowany root bootstrap przypina cały bieżący graf komponentów. Read-only
   uwierzytelnia oryginalny request/failure/drain, chronione ścieżki PAX/payload,
   UUID i inode mountu oraz świeże ack fences. Pod blokadą oryginałów i istniejącym
   lockiem writer kopii liczy nowe pełne manifesty source/payload.
6. Potwierdzić zawartość zachowanego PAX przez ekstrakcję wyłącznie do nowego,
   prywatnego katalogu w tym samym VHDX i niezależny pełny manifest. Niczego
   nie nadpisywać w istniejącym payload. Porównać wszystkie wpisy, SHA, hardlinki,
   właścicieli, tryby, mtime i xattrs/ACL oraz stabilność źródeł i archiwum.
7. Dopiero po zgodności wszystkich trzech widoków opublikować manifest prywatny
   i byte-identical export oraz wynik copy v2 z jawnym completion_mode,
   SHA nowego requestu recovery i SHA zachowanego failure. Wynik zachowuje
   oryginalny copy intent, a osobno identyfikuje wykonanie recovery.
8. Czytelnicy completed-copy akceptują v2 wyłącznie po pełnym sprawdzeniu tej
   linii pochodzenia i bieżącego grafu recovery. Zwykły v1 nadal odmawia przy
   failure lub zmianie źródeł. Nie wprowadzać ogólnego skip-source-check.
9. Po potwierdzonym terminalu root i fence ack nowy managed context może wydać
   rzeczywisty `_CopiedGroupScope` w tym samym procesie/wątku/hostlock.
   Nie odtwarzać starego capability ze snapshota. Dalej istniejący bind →
   admission → restart → świeży FEM GPU/full Zarr → rejestracja.

Bramki: regres alokacji i odmowy rzeczywistych zmian; zamknięte request/result
v2; odrzucenie nieznanej porażki, złego parent/selector/fences/grafu oraz replay;
brak nadpisania oryginałów/PAX/payload; zmieniony archive/payload/source odmawia;
znany proces musi być terminalny przed unwindingiem. Testy źródłowe i review
nie zastępują rzeczywistego przełączenia ani nowego pomiaru SP4.
