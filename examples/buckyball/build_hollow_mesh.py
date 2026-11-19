"""Case-specific conforming mesh of the supplied hollow buckyball STL.

Run only in the selected managed backend. Gmsh coordinates are micrometres;
Fullmag imports the resulting mesh with coordinate_unit='um'.
Gmsh geo.addVolume([outer, inner]) declares a cavity; disconnected STL shells
must not be imported as two independent magnetic solids.
Reference: https://gmsh.info/doc/texinfo/#gmsh_002fmodel_002fgeo_002faddVolume
"""
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import struct
import time


def add_box_shell(gmsh, half_extent, hmax):
    points = [gmsh.model.geo.addPoint(x*half_extent, y*half_extent,
                                    z*half_extent, hmax)
              for x,y,z in ((-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),
                            (-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1))]
    lines = {}
    surfaces = []
    for face in ((0,3,2,1),(4,5,6,7),(0,1,5,4),
                 (1,2,6,5),(2,3,7,6),(3,0,4,7)):
        oriented = []
        for a,b in zip(face, face[1:]+face[:1]):
            key = tuple(sorted((a,b)))
            if key not in lines:
                lines[key] = gmsh.model.geo.addLine(points[key[0]], points[key[1]])
            oriented.append(lines[key] if a < b else -lines[key])
        loop = gmsh.model.geo.addCurveLoop(oriented)
        surfaces.append(gmsh.model.geo.addPlaneSurface([loop]))
    return gmsh.model.geo.addSurfaceLoop(surfaces), surfaces


def add_nested_volumes(gmsh, outer_shell, inner_shell, universe_shell):
    return {
        'magnetic': gmsh.model.geo.addVolume([outer_shell, inner_shell]),
        'internal_air': gmsh.model.geo.addVolume([inner_shell]),
        'external_air': gmsh.model.geo.addVolume([universe_shell, outer_shell]),
    }


def _surface_components(gmsh):
    parents = {tag: tag for _,tag in gmsh.model.getEntities(2)}
    def find(x):
        while parents[x] != x:
            parents[x] = parents[parents[x]]
            x = parents[x]
        return x
    edge_owner = {}
    for surface in parents:
        for _,edge in gmsh.model.getBoundary([(2,surface)], oriented=False):
            edge = abs(edge)
            if edge in edge_owner:
                parents[find(surface)] = find(edge_owner[edge])
            else:
                edge_owner[edge] = surface
    groups = defaultdict(list)
    for surface in parents:
        groups[find(surface)].append(surface)
    return list(groups.values())


def _shell_volume(gmsh, surfaces, xyz_by_tag):
    import numpy as np
    total = 0.0
    for surface in surfaces:
        types, _, blocks = gmsh.model.mesh.getElements(2, surface)
        for kind, block in zip(types, blocks):
            if kind != 2:
                raise ValueError('Expected linear STL triangles')
            xyz = np.asarray([xyz_by_tag[int(tag)] for tag in block]).reshape(-1,3,3)
            total += float(np.einsum('ij,ij->i',xyz[:,0],
                                      np.cross(xyz[:,1],xyz[:,2])).sum()/6)
    return total


def _measure_volumes(gmsh, volumes):
    import numpy as np
    tags, coords, _ = gmsh.model.mesh.getNodes()
    xyz = np.asarray(coords).reshape(-1,3)
    index = np.full(int(max(tags))+1, -1, dtype=np.int64)
    index[tags] = np.arange(len(tags))
    summary = {'nodes':len(tags), 'domains':{}}
    for name, volume in volumes.items():
        kinds, _, blocks = gmsh.model.mesh.getElements(3, volume)
        if list(kinds) != [4]:
            raise ValueError('Expected Tet4 cells in every domain')
        cells = np.asarray(blocks[0]).reshape(-1,4)
        total = 0.; max_edge = 0.; minimum_volume = math.inf
        for start in range(0,len(cells),100000):
            points = xyz[index[cells[start:start+100000]]]
            signed = np.linalg.det(points[:,1:]-points[:,:1])/6
            if not np.isfinite(signed).all() or (signed <= 0).any():
                raise ValueError('Invalid or inverted tetrahedron')
            total += float(signed.sum()); minimum_volume=min(minimum_volume,float(signed.min()))
            for a,b in ((0,1),(0,2),(0,3),(1,2),(1,3),(2,3)):
                max_edge=max(max_edge,float(np.linalg.norm(points[:,a]-points[:,b],axis=1).max()))
        summary['domains'][name]={'tetrahedra':len(cells),'volume_m3':total*1e-18,
                                 'minimum_cell_volume_m3':minimum_volume*1e-18,
                                 'maximum_edge_m':max_edge*1e-6}
    return summary


def build_hollow_mesh(source, destination, *, magnetic_size_m=32e-9):
    import gmsh
    import numpy as np
    source, destination = Path(source), Path(destination)
    source_bytes = source.read_bytes()
    settings={'source_sha256':hashlib.sha256(source_bytes).hexdigest(),
              'magnetic_size_m':magnetic_size_m,'air_size_m':500e-9,
              'outer_bbox_extent_m':5e-6,'universe_size_m':15e-6,
              'gmsh_version':gmsh.__version__, 'mesher_schema':'buckyball.hollow-mesh.v1'}
    report_path=destination.with_suffix('.mesh-report.json')
    if destination.exists():
        report=json.loads(report_path.read_text())
        if report['settings'] != settings:
            raise ValueError('Existing mesh settings differ; use a separate mesh path')
        if hashlib.sha256(destination.read_bytes()).hexdigest() != report['mesh_sha256']:
            raise ValueError('Existing mesh digest differs')
        return destination
    destination.parent.mkdir(parents=True,exist_ok=True)
    # Scale before classification, avoiding CAD tolerances at SI nanometre scale.
    raw=np.frombuffer(source_bytes, dtype=np.dtype([('normal','<f4',(3,)),
        ('vertices','<f4',(3,3)),('attribute','<u2')]), offset=84).copy()
    extent=np.ptp(raw['vertices'].reshape(-1,3),axis=0).max()
    raw['vertices'] *= 5.0/extent
    scaled=destination.with_suffix('.scaled.stl')
    scaled.write_bytes(source_bytes[:84]+raw.tobytes())
    start=time.monotonic()
    gmsh.initialize()
    gmsh.option.setNumber('General.Terminal',0)
    gmsh.option.setNumber('General.NumThreads',8)
    gmsh.logger.start()
    try:
        gmsh.model.add('buckyball_hollow')
        print('BuckyBall mesh: classify hollow STL',flush=True)
        gmsh.merge(str(scaled))
        gmsh.model.mesh.classifySurfaces(math.radians(40),True,True,math.pi)
        gmsh.model.mesh.createGeometry()
        groups=_surface_components(gmsh)
        if len(groups)!=2:
            raise ValueError(f'Expected exactly two closed shells, found {len(groups)}')
        tags, coords, _=gmsh.model.mesh.getNodes()
        xyz_by_tag=dict(zip(map(int,tags),np.asarray(coords).reshape(-1,3)))
        shells=sorted(((_shell_volume(gmsh,g,xyz_by_tag),g) for g in groups),
                      key=lambda item:abs(item[0]),reverse=True)
        if shells[0][0]*shells[1][0]>=0:
            raise ValueError('Shell orientations do not define an exterior and a cavity')
        expected_magnetic=(abs(shells[0][0])-abs(shells[1][0]))*1e-18
        outer=gmsh.model.geo.addSurfaceLoop(shells[0][1])
        inner=gmsh.model.geo.addSurfaceLoop(shells[1][1])
        universe, outer_faces=add_box_shell(gmsh,7.5,0.5)
        volumes=add_nested_volumes(gmsh,outer,inner,universe)
        gmsh.model.geo.synchronize()
        for dim, entities, tag, name in (
            (3,[volumes['magnetic']],1,'buckyball'),
            (3,[volumes['internal_air'],volumes['external_air']],2,'airbox'),
            (2,outer_faces,1,'outer'),
            (2,shells[0][1]+shells[1][1],2,'magnetic_air')):
            gmsh.model.addPhysicalGroup(dim,entities,tag)
            gmsh.model.setPhysicalName(dim,tag,name)
        h=magnetic_size_m*1e6
        distance=gmsh.model.mesh.field.add('Distance')
        gmsh.model.mesh.field.setNumbers(distance,'SurfacesList',shells[0][1]+shells[1][1])
        gmsh.model.mesh.field.setNumber(distance,'Sampling',30)
        growth=gmsh.model.mesh.field.add('MathEval')
        gmsh.model.mesh.field.setString(growth,'F',f'Min(0.5, {h:.17g}+0.5*F{distance})')
        constant=gmsh.model.mesh.field.add('MathEval')
        gmsh.model.mesh.field.setString(constant,'F',str(h))
        restricted=gmsh.model.mesh.field.add('Restrict')
        gmsh.model.mesh.field.setNumber(restricted,'InField',constant)
        gmsh.model.mesh.field.setNumbers(restricted,'VolumesList',[volumes['magnetic']])
        minimum=gmsh.model.mesh.field.add('Min')
        gmsh.model.mesh.field.setNumbers(minimum,'FieldsList',[growth,restricted])
        gmsh.model.mesh.field.setAsBackgroundMesh(minimum)
        gmsh.option.setNumber('Mesh.MeshSizeMin',h)
        gmsh.option.setNumber('Mesh.MeshSizeMax',0.5)
        gmsh.option.setNumber('Mesh.MeshSizeFromPoints',0)
        gmsh.option.setNumber('Mesh.MeshSizeFromCurvature',0)
        gmsh.option.setNumber('Mesh.MeshSizeExtendFromBoundary',0)
        gmsh.option.setNumber('Mesh.Algorithm3D',10)
        gmsh.option.setNumber('Mesh.ElementOrder',1)
        gmsh.option.setNumber('Mesh.MshFileVersion',4.1)
        gmsh.option.setNumber('Mesh.Binary',1)
        print(f'BuckyBall mesh: generate Tet4, magnetic target {magnetic_size_m:g} m',flush=True)
        gmsh.model.mesh.generate(3)
        report=_measure_volumes(gmsh,volumes)
        measured=report['domains']['magnetic']['volume_m3']
        if abs(measured/expected_magnetic-1)>0.02:
            raise ValueError(f'Magnetic mesh volume mismatch: {measured} vs {expected_magnetic}')
        total=sum(domain['volume_m3'] for domain in report['domains'].values())
        if abs(total/(15e-6)**3-1)>1e-7:
            raise ValueError('Mesh domains do not partition the universe')
        gmsh.write(str(destination))
        report.update(settings=settings,elapsed_seconds=time.monotonic()-start,
                      expected_magnetic_volume_m3=expected_magnetic,
                      mesh_sha256=hashlib.sha256(destination.read_bytes()).hexdigest())
        report_path.write_text(json.dumps(report,indent=2)+'\n')
        print('BuckyBall mesh: '+json.dumps(report),flush=True)
        return destination
    except Exception:
        destination.with_suffix('.gmsh-log.txt').write_text('\n'.join(gmsh.logger.get()))
        raise
    finally:
        gmsh.logger.stop()
        gmsh.finalize()
