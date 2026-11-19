"""Materialize self-contained strict Fullmag inputs for the ABL reflection matrix."""
import argparse
import itertools
import json
import math
from pathlib import Path

ENGINES = ("fdm", "fem")
DEVICES = ("cpu", "gpu")
RESOLUTIONS_NM = (4, 2)
PROFILES = ("off", "logarithmic", "tanh", "custom")


def cases():
    return itertools.product(ENGINES, DEVICES, RESOLUTIONS_NM, PROFILES)


def case_name(engine, device, h_nm, profile):
    return f"abl_{engine}_{device}_{h_nm}nm_{profile}"


def packet(x):
    displacement = x + 256e-9
    transverse = 0.001 * math.exp(-0.5 * (displacement / 64e-9) ** 2)
    phase = -2 * math.pi * displacement / 64e-9
    return [math.sqrt(1 - transverse**2), transverse * math.cos(phase), transverse * math.sin(phase)]


def slab_mesh(nx):
    """Six positively oriented P1 tetrahedra per axial slab, outward boundary triangles."""
    nodes = [[(i / nx - 0.5) * 1280e-9, y, z]
             for z in (-2e-9, 2e-9) for y in (-2e-9, 2e-9) for i in range(nx + 1)]
    stride = nx + 1
    elements = []
    exterior = {}
    for i in range(nx):
        a, b, c, d = i, i + 1, i + stride + 1, i + stride
        e, f, g, h = (v + 2 * stride for v in (a, b, c, d))
        for tet in ((a, b, c, g), (a, c, d, g), (a, d, h, g), (a, h, e, g),
                    (a, e, f, g), (a, f, b, g)):
            elements.append(tet)
            p, q, r, s = tet
            for face in ((q, r, s), (p, s, r), (p, q, s), (p, r, q)):
                key = tuple(sorted(face))
                if key in exterior:
                    del exterior[key]
                else:
                    exterior[key] = face
    return {"nodes": nodes, "elements": elements,
            "element_markers": [1] * len(elements), "boundary_faces": list(exterior.values()),
            "boundary_markers": [1] * len(exterior)}


def prepare_case(root, engine, device, h_nm, profile):
    name = case_name(engine, device, h_nm, profile)
    folder = root / name
    folder.mkdir()
    nx = 1280 // h_nm
    if engine == "fem":
        from fullmag.meshing import MeshData

        mesh = slab_mesh(nx)
        MeshData.from_legacy_tet4(**mesh).save(folder / "film.npz")
        x_positions = (point[0] for point in mesh["nodes"])
        mesh_setup = f'film.mesh(source=str(Path(__file__).with_name("film.npz")), maximum_element_size={h_nm}e-9, order=1)'
    else:
        x_positions = (((i + 0.5) / nx - 0.5) * 1280e-9 for i in range(nx))
        mesh_setup = f"study.cell({h_nm}e-9, 4e-9, 4e-9)"
    state = {"values": [packet(x) for x in x_positions]}
    (folder / "packet.json").write_text(json.dumps(state), encoding="utf-8")
    boundary = ""
    if profile != "off":
        expression = ', expression="u**3"' if profile == "custom" else ""
        boundary = (f'film.alpha.absorbing_boundary(total_width=160e-9, ramp_width=96e-9, '
                    f'max_damping=0.6, faces=("x+",), profile="{profile}"{expression})')
    source = Path(__file__).with_name("scenario.py.in").read_text(encoding="utf-8")
    for key, value in {"CASE": name, "ENGINE": engine, "DEVICE": device, "MESH": mesh_setup,
                       "BOUNDARY": boundary}.items():
        source = source.replace(f"@{key}@", value)
    script = folder / f"{name}.py"
    script.write_text(source, encoding="utf-8")
    return script


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="new user-owned qualification directory")
    directory = parser.parse_args().directory
    directory.mkdir(parents=True)
    for case in cases():
        print(prepare_case(directory, *case))
