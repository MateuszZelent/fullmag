"""Geometry and postprocessing fixtures for the CPW Maxwell reference."""
import numpy as np
import pytest

from rf_cpw_reference import make_case, transverse_spectrum, locate_points


@pytest.mark.parametrize("cpw, signal_nm", ((1, 65), (2, 260)))
def test_cpw_cross_section_and_oriented_terminal_groups(cpw, signal_nm):
    case = make_case(cpw=cpw, refinement=0)
    coordinates = case.points_m
    tet_coordinates = coordinates[case.tetrahedra]
    volumes = np.linalg.det(tet_coordinates[:, 1:] - tet_coordinates[:, :1]) / 6
    assert np.all(volumes > 0)
    assert volumes.sum() == pytest.approx(2e-6 * (6e-6)**2, rel=1e-13, abs=0.0)
    for name, ids in case.terminals.items():
        extent = np.ptp(coordinates[ids], axis=0)
        width_nm = signal_nm if "signal" in name else (1500 - signal_nm - 2*95) / 2
        np.testing.assert_allclose(extent, [0, width_nm*1e-9, 10e-9], atol=1e-21)
        expected_x = -1e-6 if name.endswith("input") else 1e-6
        np.testing.assert_allclose(coordinates[ids, 0], expected_x, atol=1e-21)
    all_terminal_points = np.concatenate(tuple(case.terminals.values()))
    assert len(np.unique(all_terminal_points)) == len(all_terminal_points)
    assert case.voltages_v["signal_input"] == 1
    assert case.loads_ohm == {"signal_output": 50}
    copper_volume = volumes[case.conductivity_spm > 0].sum()
    assert copper_volume == pytest.approx(2e-6 * (1500-2*95)*1e-9 * 10e-9, rel=1e-13, abs=0.0)


def test_locator_reconstructs_points_and_keeps_monitor_in_yig():
    case = make_case(cpw=2, refinement=0)
    rng = np.random.default_rng(146)
    random_points = rng.uniform([-1e-6, -3e-6, -3e-6], [1e-6, 3e-6, 3e-6],
                                size=(600, 3))
    observations = np.column_stack((np.zeros(41), np.linspace(-1.6e-6, 1.6e-6, 41),
                                    np.full(41, -7.5e-9)))
    points = np.concatenate((random_points, observations))
    cell_indices = locate_points(case, points)
    assert np.all(case.material_id[cell_indices[-41:]] == 3)  # passive YIG
    verts = case.points_m[case.tetrahedra[cell_indices]]
    gradients = np.transpose(verts[:, 1:] - verts[:, :1], (0, 2, 1))
    barycentric = np.linalg.solve(gradients, (points - verts[:, 0])[..., None])[..., 0]
    assert barycentric.min() >= -1e-12
    assert np.sum(barycentric, axis=1).max() <= 1 + 1e-12
    with pytest.raises(ValueError, match="outside"):
        locate_points(case, np.array([[0.0, 3.1e-6, 0.0]]))


def test_spectrum_keeps_complex_quadrature_and_uses_angular_wavenumber():
    y = np.linspace(-1.6e-6, 1.6e-6, 161)
    amplitude = 3-4j
    wavenumber = 5e6
    hy = amplitude * np.exp(1j*wavenumber*y)
    fft = transverse_spectrum(y, hy, np.array([wavenumber]))
    np.testing.assert_allclose(fft, [amplitude*(y[-1]-y[0])], rtol=1e-14)


def test_refinement_resolves_cross_section_without_growing_axial_grid():
    coarse = make_case(2, 0)
    refined = make_case(2, 1)
    np.testing.assert_array_equal(coarse.axes_m[0], refined.axes_m[0])
    for axis, new in zip(coarse.axes_m[1:], refined.axes_m[1:]):
        assert np.all(np.isin(axis, new))
        assert len(new) > len(axis)
    assert len(refined.tetrahedra) < 4*len(coarse.tetrahedra)
    assert len(make_case(2, 0, axial_refinement=1).axes_m[0]) == 9


@pytest.mark.parametrize("model", ["maxwell", "darwin"])
def test_cli_preflight_does_not_assemble(monkeypatch, capsys, model):
    import json
    import sys
    from rf_cpw_reference import main

    monkeypatch.setitem(sys.modules, "rf_fullwave_reference", None)
    monkeypatch.setitem(sys.modules, "rf_darwin_reference", None)
    monkeypatch.setattr(sys, "argv", ["rf_cpw_reference.py", "--model", model])
    main()
    report = json.loads(capsys.readouterr().out)
    assert report["planned_model"] == model
    assert report["execution"] == "mesh_preflight_only"
    assert report["tetrahedra"] > 10_000


@pytest.mark.parametrize("model", ["maxwell", "darwin"])
def test_artifacts_preserve_quadrature_and_observed_terminal_voltage(monkeypatch, tmp_path, model):
    import json
    from types import SimpleNamespace
    import rf_fullwave_reference
    import rf_darwin_reference
    from rf_cpw_reference import _solve

    def fake_assemble(points, cells, sigma, eps, frequency):
        def fake_solve(terminal_ids, input_voltage, loads):
            currents = dict.fromkeys(terminal_ids, 0j)
            currents.update(signal_input=0.1+0.005j, signal_output=-0.01-0.001j,
                            left_ground_input=-0.09-0.004j)
            voltage = {**input_voltage, "signal_output": 0.5+0.05j}
            scalar = np.zeros(len(points), dtype=complex)
            for name, term in terminal_ids.items():
                scalar[term] = voltage[name]
            return SimpleNamespace(
                electric_edge_v=np.ones(5, dtype=complex),
                curl_edge_v=0.25*np.ones(5, dtype=complex), terminal_currents_a=currents,
                terminal_voltages_v=voltage, relative_residual=0.0, power_joule_w=0.045,
                scalar_potential_v=scalar, gauge_relative_residual=0.0,
                gauge_force_relative_residual=0.0, power_mix_w=0.0,
            )

        def fake_sample(edges, samples, indices, *, curl_edge_v=None):
            e = np.tile([(1+1j)*edges[0], 0, 0], (len(samples), 1))
            h = np.tile([0, 10+20j, 0], (len(samples), 1))
            return e, h

        return SimpleNamespace(solve_ece=fake_solve, sample=fake_sample,
                               points_m=points, edges=np.array([[0, 1], [0, 2], [0, 3],
                                                              [0, 4], [0, 5]]))

    monkeypatch.setattr(rf_fullwave_reference, "assemble", fake_assemble)
    monkeypatch.setattr(rf_darwin_reference, "solve_darwin_ece",
                        lambda system, *args: system.solve_ece(*args))
    output = tmp_path/"result"
    _solve(make_case(), output, 20.0, model)
    report = json.loads((output/"manifest.json").read_text())
    assert report["model"] == model
    assert report["cross_section"]["displacement_model"] == (
        "electric_full" if model == "maxwell" else "scalar_potential_gradient"
    )
    assert report["terminals_v"]["signal_output"] == [0.5, 0.05]
    assert report["load_law_residual_a"]["signal_output"] < 1e-18
    with np.load(output/"fields.npz") as fields:
        assert fields["probe_H_Apm"].shape == (161, 3)
        np.testing.assert_allclose(fields["probe_H_over_I_per_m"][:, 1],
                                   (10+20j)/(0.1+0.005j))
        assert ("potential_nodes_V" in fields) == (model == "darwin")
