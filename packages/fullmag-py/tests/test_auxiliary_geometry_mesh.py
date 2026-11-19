import numpy as np
import pytest

import fullmag as fm
from fullmag import world
from fullmag.runtime.script_builder import export_builder_draft, render_loaded_problem_as_script, render_scene_document_as_script
from fullmag.runtime.scene_document import build_scene_document_from_builder


SCRIPT = """import fullmag as fm
study = fm.study('auxiliary-mesh')
study.engine('fem')
study.device('cpu', precision='double')
study.mode('strict')
study.objects.mesh.defaults(maximum_element_size=0.2e-6, order=1)
source = study.antenna_object(fm.Box(0.6e-6, 0.4e-6, 0.2e-6), name='Source display', object_id='source-id')
sampling = study.geometry_object(fm.Box(0.4e-6, 0.3e-6, 0.2e-6), name='Sampling display', object_id='sampling-id')
study.objects.mesh.by_id('source-id')(maximum_element_size={source_hmax}, order=1)
study.objects.mesh.by_id('sampling-id')(maximum_element_size=0.15e-6, minimum_element_size=0.15e-6, order=1)
"""


def load_script(tmp_path, text, name='authored.py'):
    path = tmp_path / name
    path.write_text(text, encoding='utf-8')
    return fm.load_problem_from_script(path, lightweight_assets=True)


def recipes(problem):
    return {entry['geometry']: entry for entry in problem.runtime_metadata['mesh_workflow']['per_geometry']}


def test_exact_identity_validation_and_legacy_handles():
    study = fm.study('identity')
    shape = study.geometry_object(fm.Box(1e-6, 1e-6, 1e-6), name='display', object_id='immutable')
    assert isinstance(shape, fm.Box)
    handle = study.objects.mesh.by_id('immutable')
    assert not isinstance(handle._owner, world.MagnetHandle)
    assert not hasattr(handle._owner, 'Ms')
    assert handle.quality() is None
    assert handle(hmax=1e-7) is handle
    assert study.objects.mesh.by_id('immutable') is handle
    for value in ('display', 'missing', '', ' immutable'):
        with pytest.raises(ValueError):
            study.objects.mesh.by_id(value)
    with pytest.raises(TypeError):
        study.objects.mesh.by_id(7)
    with pytest.raises(ValueError, match='duplicate object_id'):
        study.antenna_object(fm.Box(1e-6, 1e-6, 1e-6), name='other', object_id='immutable')
    magnet = study.geometry(fm.Box(1e-6, 1e-6, 1e-6), name='magnet', object_id='magnet-id')
    assert study.objects.mesh.by_id('magnet-id') is magnet.mesh
    study.geometry_object(fm.Box(1e-6, 1e-6, 1e-6), name='unconfigured')
    with pytest.raises(ValueError, match='cell_size requires'):
        study.objects.mesh.by_id('unconfigured')(cell_size=(1e-8, 1e-8, 1e-8))


def test_auxiliary_recipe_export_reimport(tmp_path):
    loaded = load_script(tmp_path, SCRIPT.format(source_hmax=0.1e-6))
    assert not loaded.problem.magnets
    assert loaded.problem.auxiliary_geometry_roles == {'Source display': 'antenna', 'Sampling display': 'geometry'}
    exported = render_loaded_problem_as_script(loaded)
    assert 'study.objects.mesh.by_id("sampling-id")' in exported
    reloaded = load_script(tmp_path, exported, 'reimported.py')
    assert recipes(reloaded.problem) == recipes(loaded.problem)
    assert reloaded.problem.auxiliary_geometry_object_ids == loaded.problem.auxiliary_geometry_object_ids


def test_inherited_auxiliary_mesh_and_validation(tmp_path):
    text = SCRIPT.format(source_hmax=0.1e-6).split("study.objects.mesh.by_id('source-id')")[0]
    loaded = load_script(tmp_path, text)
    assert all(entry['mode'] == 'inherit' for entry in recipes(loaded.problem).values())
    assert loaded.problem.runtime_metadata['mesh_workflow']['default_mesh']['hmax'] == 0.2e-6
    study = fm.study('validation')
    study.geometry_object(fm.Box(1e-6, 1e-6, 1e-6), name='sample')
    with pytest.raises(ValueError):
        study.objects.mesh.by_id('sample')(hmax=-1)


def test_independent_auxiliary_gmsh_mesh_across_source_levels(tmp_path, monkeypatch):
    monkeypatch.setenv("FULLMAG_GMSH_THREADS", "1")
    monkeypatch.setenv("FULLMAG_FEM_MESH_CACHE_DIR", "")
    meshes = []
    source_cell_counts = []
    for index, hmax in enumerate((0.15e-6, 0.10e-6, 0.075e-6)):
        # hmax alone is an upper bound: Gmsh may already choose a finer mesh.
        # Author a uniform source size to exercise three actual refinements.
        script = SCRIPT.format(source_hmax=hmax) + (
            f"study.objects.mesh.by_id('source-id')(minimum_element_size={hmax})\n"
        )
        loaded = load_script(tmp_path, script, f'level{index}.py')
        ir = loaded.problem.to_ir(include_geometry_assets=True)
        assert ir['magnets'] == []
        assets = {
            entry['geometry_name']: entry['mesh']
            for entry in ir['geometry_assets']['fem_mesh_assets']
        }
        meshes.append(assets['Sampling display'])
        source_cell_counts.append(len(assets['Source display']['cells']['types']))
    for mesh in meshes[1:]:
        np.testing.assert_array_equal(mesh['nodes'], meshes[0]['nodes'])
        assert mesh['cells'] == meshes[0]['cells']
        assert mesh['facets'] == meshes[0]['facets']
    assert len(set(source_cell_counts)) == 3
    assert source_cell_counts == sorted(source_cell_counts)
    # This verifies authoring/meshing policy, not convergence of V, J, or H.
    print(
        f"sampling nodes={len(meshes[0]['nodes'])} "
        f"cells={len(meshes[0]['cells']['types'])}; "
        f"source cells={source_cell_counts}; Gmsh threads=1"
    )


def test_scene_auxiliary_recipe_export_reimport(tmp_path):
    loaded = load_script(tmp_path, SCRIPT.format(source_hmax=0.1e-6))
    scene = build_scene_document_from_builder(export_builder_draft(loaded))
    exported = render_scene_document_as_script(scene)
    reloaded = load_script(tmp_path, exported, 'scene_reimported.py')
    assert recipes(reloaded.problem) == recipes(loaded.problem)
    assert not reloaded.problem.magnets


def test_mesh_context_lifetime_and_ambiguous_identity():
    with fm.execution_context():
        study = fm.study('owner')
        study.geometry_object(fm.Box(1e-6, 1e-6, 1e-6), name='sample', object_id='id')
        handle = study.objects.mesh.by_id('id')
        with fm.execution_context():
            with pytest.raises(RuntimeError, match='different authoring context'):
                handle(hmax=1e-7)
            with pytest.raises(RuntimeError, match='different authoring context'):
                study.objects.mesh.by_id('id')
        # Corrupt identity state deliberately to exercise the fail-closed guard.
        world._state._auxiliary_geometry_object_ids['alias'] = 'id'
        world._state._auxiliary_mesh_owners['alias'] = handle._owner
        with pytest.raises(ValueError, match='ambiguous'):
            study.objects.mesh.by_id('id')


def test_auxiliary_full_recipe_methods_roundtrip(tmp_path):
    text = SCRIPT.format(source_hmax=0.1e-6) + """
study.objects.mesh.by_id('sampling-id').algorithm(dim2=6, dim3=1)
study.objects.mesh.by_id('sampling-id').size_field('Ball', VIn=0.15e-6, VOut=0.2e-6, Radius=0.1e-6)
study.objects.mesh.by_id('sampling-id').optimize('Netgen', iterations=2).smooth(iterations=2).refine(steps=1)
"""
    loaded = load_script(tmp_path, text)
    reloaded = load_script(tmp_path, render_loaded_problem_as_script(loaded), 'recipe_reimported.py')
    assert recipes(reloaded.problem) == recipes(loaded.problem)
