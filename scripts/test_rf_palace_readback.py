"""Regression coverage for RF probe import at the documented Palace format."""
import json

import numpy as np
import pytest
from scipy.constants import mu_0

from rf_cpw_reference import make_case
from rf_palace_preflight import write_case
from rf_palace_readback import read_driven_vector, import_run


def table(path, field, probes=(2,1), excitations=(1,2), incomplete=False):
    unit = "Wb/m²" if field == "B" else "V/m"
    header = ["f (GHz)"]
    row = [22.12]
    for ex in excitations:
        for i in probes:
            for n, axis in enumerate("xyz"):
                key = f"{field}_{axis}[{i}]" + (f"[{ex}]" if len(excitations)>1 else "")
                header.extend((f"Im{{{key}}} ({unit})",f"Re{{{key}}} ({unit})"))
                row.extend((-ex*10-i-n/10,ex*10+i+n/10))
    if incomplete:
        del header[-1]
        del row[-1]
    path.write_text(", ".join(header)+"\n"+", ".join(map(str,row))+"\n",encoding="utf-8")


def test_reader_uses_probe_id_axis_quadrature_and_excitation(tmp_path):
    csv_path = tmp_path/"probe-B.csv"
    table(csv_path, "B")
    got = read_driven_vector(csv_path, "B", (1,2), 22.12e9, excitation=2)
    want = np.array([[21,21.1,21.2],[22,22.1,22.2]])
    np.testing.assert_array_equal(got,want-1j*want)
    with pytest.raises(ValueError,match="frequency"):
        read_driven_vector(csv_path,"B",(1,2),21.12e9,excitation=2)


def test_reader_rejects_incomplete_complex_vector(tmp_path):
    csv_path = tmp_path/"probe-E.csv"
    table(csv_path, "E", excitations=(1,), incomplete=True)
    with pytest.raises(ValueError,match="columns"):
        read_driven_vector(csv_path,"E",(1,2),22.12e9)


def test_import_preserves_si_fields_and_requires_a_separate_current(tmp_path):
    deck = tmp_path/"deck"
    config = write_case(make_case(cpw=1),deck,mode=1)
    probe_ids = range(1,162)
    results = tmp_path/"results"
    results.mkdir()
    for name in ("E","B"):
        table(results/f"probe-{name}.csv",name,probes=probe_ids,excitations=(1,))
    result = tmp_path/"readout"
    manifest = import_run(deck,results,result)
    assert manifest["normalized_basis_status"] == "unresolved"
    assert manifest["input_file_sha256"] == config["sha256"]
    with np.load(result/"fields.npz",allow_pickle=False) as fields:
        assert "probe_H_over_I_per_m" not in fields
        np.testing.assert_array_equal(fields["probe_E_Vpm"][0], [11-11j,11.1-11.1j,11.2-11.2j])
        np.testing.assert_allclose(fields["probe_H_Apm"],fields["probe_B_T"]/mu_0)
    numerator = results/"probe-B.csv"
    normalization = tmp_path/"current.json"
    normalization.write_text(json.dumps({
        "frequency_hz":22.12e9, "reference_current_a":[2,1],
        "phasor_convention":"peak, exp(+i omega t)",
        "definition":"total current entering the signal strip in +x at the input plane",
        "probe_b_sha256":manifest["result_file_sha256"][numerator.name],
        "provenance":"Fixture current receipt",
    }))
    with_current = tmp_path/"readout-normalized"
    assert import_run(deck,results,with_current,normalization)["normalized_basis_status"] == "provisional"
    with np.load(with_current/"fields.npz",allow_pickle=False) as fields:
        np.testing.assert_allclose(fields["probe_H_over_I_per_m"],fields["probe_H_Apm"]/(2+1j))



def test_terminal_current_is_derived_without_mixing_observation_positions(tmp_path):
    from scipy.constants import epsilon_0

    deck = tmp_path / "deck"
    case = make_case(cpw=2)
    preflight = write_case(case, deck, mode=1, terminal_current=True)
    count = preflight["observation_probe_count"]
    extra = preflight["terminal_probe_count"]
    results = tmp_path / "results"
    results.mkdir()
    table(results / "probe-E.csv", "E", probes=range(1, count + extra + 1), excitations=(1,))
    table(results / "probe-B.csv", "B", probes=range(1, count + 1), excitations=(1,))
    out = tmp_path / "readout"
    manifest = import_run(deck, results, out)
    assert manifest["normalized_basis_status"] == "provisional"
    assert len(manifest["terminal_currents_a_positive_x"]) == 6
    with np.load(out/"fields.npz", allow_pickle=False) as fields, np.load(
        deck/preflight["terminal_quadrature"], allow_pickle=False
    ) as quadrature:
        assert fields["probe_xyz_m"].shape == (161, 3)
        np.testing.assert_array_equal(fields["terminal_probe_xyz_m"], quadrature["xyz_m"])
        selected = quadrature["terminal_index"] == 1
        integral = quadrature["weight_m2"][selected] @ fields["terminal_probe_E_Vpm"][selected, 0]
        expected = (5.88e7 + 2j*np.pi*22.12e9*epsilon_0) * integral
        np.testing.assert_allclose(manifest["reference_current_a"], [expected.real, expected.imag])
        np.testing.assert_allclose(fields["probe_H_over_I_per_m"],fields["probe_H_Apm"]/expected)



def test_optional_center_probes_round_trip_in_a_driven_deck(tmp_path):
    deck = tmp_path/"deck"
    preflight = write_case(make_case(cpw=2), deck, mode=1, terminal_current=True, center_current=True)
    count = preflight["observation_probe_count"]
    end = count+preflight["terminal_probe_count"]
    total = end+preflight["center_probe_count"]
    results = tmp_path/"results"
    results.mkdir()
    table(results/"probe-E.csv","E",probes=range(1,total+1),excitations=(1,))
    table(results/"probe-B.csv","B",probes=range(1,count+1),excitations=(1,))
    out = tmp_path/"readout"
    manifest = import_run(deck,results,out)
    assert manifest["center_probe_count"] == total-end
    assert manifest["normalized_basis_status"] == "provisional"
    assert manifest["center_conduction"]["trace_x"] == "+"
    assert 0 < manifest["center_conduction"]["ground_gap_fraction"] < 1
    with np.load(out/"fields.npz",allow_pickle=False) as fields:
        assert len(fields["probe_H_Apm"]) == count
        assert len(fields["terminal_probe_E_Vpm"]) == end-count
        assert len(fields["center_probe_E_Vpm"]) == total-end
        np.testing.assert_allclose(fields["center_probe_E_Vpm"][0,0],(11+end)*(1-1j))
