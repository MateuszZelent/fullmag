// Frozen Gmsh 4.15.2 feasibility fixture for a conforming mixed-P1 airbox.
//
// The axis-aligned film is a one-layer structured extrusion inside an explicit
// outer Box surface loop. The air volume uses the film boundary as an inner
// surface loop, so both domains own the same interface node IDs. Film top and
// bottom remain tri3, film laterals are quad4, and Gmsh's unstructured air
// mesher inserts pyramid5 at quad transitions with tet4 in the far air. This
// freezes topology feasibility only; it does not call Fullmag meshing code.

Mesh.MshFileVersion = 4.1;
Mesh.ElementOrder = 1;
Mesh.Algorithm = 6;
Mesh.Algorithm3D = 1;
Mesh.RandomFactor = 0;

// Geometry is normalized because this fixture certifies topology, not scale.
film_x = 4;
film_y = 2;
film_t = 0.2;
air_x = 8;
air_y = 6;
air_z = 3;
lc_film = 0.8;
lc_air = 1.2;

Point(1) = {-film_x / 2, -film_y / 2, -film_t / 2, lc_film};
Point(2) = { film_x / 2, -film_y / 2, -film_t / 2, lc_film};
Point(3) = { film_x / 2,  film_y / 2, -film_t / 2, 0.5 * lc_film};
Point(4) = {-film_x / 2,  film_y / 2, -film_t / 2, lc_film};
Line(1) = {4, 3};
Line(2) = {3, 2};
Line(3) = {2, 1};
Line(4) = {1, 4};
Curve Loop(5) = {2, 3, 4, 1};
Plane Surface(6) = {5};

film[] = Extrude {0, 0, film_t} {
  Surface{6}; Layers{1}; Recombine;
};

Point(101) = {-air_x / 2, -air_y / 2, -air_z / 2, lc_air};
Point(102) = { air_x / 2, -air_y / 2, -air_z / 2, lc_air};
Point(103) = { air_x / 2,  air_y / 2, -air_z / 2, lc_air};
Point(104) = {-air_x / 2,  air_y / 2, -air_z / 2, lc_air};
Point(105) = {-air_x / 2, -air_y / 2,  air_z / 2, lc_air};
Point(106) = { air_x / 2, -air_y / 2,  air_z / 2, lc_air};
Point(107) = { air_x / 2,  air_y / 2,  air_z / 2, lc_air};
Point(108) = {-air_x / 2,  air_y / 2,  air_z / 2, lc_air};

Line(101) = {101, 102};
Line(102) = {102, 103};
Line(103) = {103, 104};
Line(104) = {104, 101};
Line(105) = {105, 106};
Line(106) = {106, 107};
Line(107) = {107, 108};
Line(108) = {108, 105};
Line(109) = {101, 105};
Line(110) = {102, 106};
Line(111) = {103, 107};
Line(112) = {104, 108};

Curve Loop(201) = {101, 102, 103, 104};
Plane Surface(211) = {201};
Curve Loop(202) = {105, 106, 107, 108};
Plane Surface(212) = {202};
Curve Loop(203) = {101, 110, -105, -109};
Plane Surface(213) = {203};
Curve Loop(204) = {102, 111, -106, -110};
Plane Surface(214) = {204};
Curve Loop(205) = {103, 112, -107, -111};
Plane Surface(215) = {205};
Curve Loop(206) = {104, 109, -108, -112};
Plane Surface(216) = {206};

Surface Loop(301) = {211, 212, 213, 214, 215, 216};
Surface Loop(302) = {6, film[0], film[2], film[3], film[4], film[5]};
Volume(401) = {301, 302};

Physical Volume("film") = {film[1]};
Physical Volume("air") = {401};
Physical Surface("film_top_bottom") = {6, film[0]};
Physical Surface("film_lateral") = {film[2], film[3], film[4], film[5]};

Mesh 3;
