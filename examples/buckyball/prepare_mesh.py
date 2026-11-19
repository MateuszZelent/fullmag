"""Convert the case mesh once in the selected managed backend, before API capture.

Usage inside this task's backend:
    python3 prepare_mesh.py /user-data/.../relax.msh /user-data/.../relax.mesh.json

The public Gmsh importer validates SI topology and region semantics. The solve
script declares the resulting MeshIR file without repeating the import while
the API reads the study configuration. No solver is started here.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import time

from fullmag.meshing.persistence import import_gmsh_mesh


def prepare_mesh(source: Path, target: Path) -> None:
    if target.exists():
        raise FileExistsError(f'Refusing to overwrite a prepared mesh: {target}')
    temporary = target.with_suffix(target.suffix + '.preparing')
    if temporary.exists():
        raise FileExistsError(f'Previous preparation is incomplete: {temporary}')
    started = time.monotonic()
    print('BuckyBall: importing and validating the shared-domain mesh', flush=True)
    artifact = import_gmsh_mesh(
        source, region_map={'buckyball': 1},
        boundary_map={'outer': 1, 'magnetic_air': 2}, coordinate_unit='um',
    )
    print('BuckyBall: writing SI MeshIR for the native planner', flush=True)
    mesh_ir = artifact.mesh.to_ir(artifact.mesh_name)
    with temporary.open('x', encoding='utf-8') as stream:
        json.dump(mesh_ir, stream, separators=(',', ':'), allow_nan=False)
        stream.write('\n')
    # Same-filesystem publication must never replace a concurrently prepared file.
    os.link(temporary, target)
    temporary.unlink()
    def digest(path):
        checksum = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024*1024), b''):
                checksum.update(block)
        return checksum.hexdigest()
    report = {
        'status': 'mesh_prepared_no_solver_started',
        'source_sha256': digest(source), 'mesh_ir_sha256': digest(target),
        'nodes': artifact.mesh.n_nodes, 'elements': artifact.mesh.n_elements,
        'region_markers': artifact.region_markers,
        'topology_fingerprint': artifact.topology_fingerprint,
        'coordinate_unit': 'm', 'elapsed_seconds': time.monotonic()-started,
    }
    target.with_suffix('.preparation.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('target', type=Path)
    arguments = parser.parse_args()
    prepare_mesh(arguments.source, arguments.target)
