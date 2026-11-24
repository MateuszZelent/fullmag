"""Exact incidence diagnostics; fixtures do not qualify the saved current."""
from fractions import Fraction as F
import hashlib
import itertools
import json
from pathlib import Path
import struct
import tempfile
import unittest

from antenna_saved_flux_admissibility import (
    SELECTED, audit_cut_potential, audit_fluxes, cross, dot, read_selected_bundle, sub,
)


def tetra_nodes():
    return {1:(F(0),F(0),F(0)),2:(F(1),F(0),F(0)),
            3:(F(0),F(1),F(0)),4:(F(0),F(0),F(1))}


def constant_flux(nodes, cells, current=(F(2),F(-3),F(5))):
    values = {}
    for cell in cells:
        for face in itertools.combinations(sorted(cell),3):
            a,b,c = [nodes[i] for i in face]
            values[face] = dot(current,cross(sub(b,a),sub(c,a)))/2
    return values


def cut_fixture():
    nodes = tetra_nodes()
    nodes.update({5:nodes[1],6:nodes[2],7:nodes[3],8:(F(0),F(0),F(-1))})
    cut = dict(translation_m=[0.,0.,0.],potential_drop_v=.001,
               face_pairs=[dict(minus_face_vertex_ids=[1,2,3],plus_face_vertex_ids=[5,6,7])])
    return nodes,cut


def bundle_bytes():
    payloads = {key:(key+"-binary").encode() for key in SELECTED|{"ignored"}}
    descriptors = {key:dict(path=f"antenna/field_solutions/example/{key}.bin",
                    byte_length=len(value),sha256=hashlib.sha256(value).hexdigest())
                   for key,value in payloads.items()}
    manifest = dict(schema_version="antenna_field_solution.v2",status="inspection_only",
                    solution_id="example",payloads=descriptors)
    raw = json.dumps(manifest,sort_keys=True).encode()
    output = b"FMACLB01"+struct.pack("<QI",len(raw),len(payloads))+raw
    for key in sorted(payloads):
        path = descriptors[key]["path"].encode()
        output += struct.pack("<H",len(path))+path+struct.pack("<Q",len(payloads[key]))+payloads[key]
    return output,payloads


class SavedFluxAdmissibilityTests(unittest.TestCase):
    def test_all_tetra_vertex_permutations_preserve_outward_balance(self):
        nodes = tetra_nodes()
        for cell in itertools.permutations(nodes):
            result = audit_fluxes(nodes,[cell],constant_flux(nodes,[cell]),{"face_pairs":[]})
            self.assertEqual(result["cell_balance"]["nonzero_count"],0)
            self.assertEqual(result["face_count"],4)

    def test_orientation_matches_geometric_normal_for_skew_tetrahedra(self):
        for opposite in ((F(-3),F(2),F(-7)),(F(2,7),F(-3,11),F(8,13))):
            nodes = tetra_nodes()
            nodes[4] = opposite
            fluxes = constant_flux(nodes,[(4,2,1,3)])
            result = audit_fluxes(nodes,[(4,2,1,3)],fluxes,{"face_pairs":[]})
            self.assertEqual(result["cell_balance"]["nonzero_count"],0)
            self.assertEqual(result["insulating_boundary"]["nonzero_count"],4)

    def test_exact_sum_detects_residual_hidden_by_float_cancellation(self):
        nodes = tetra_nodes()
        tiny = F.from_float(2.**-60)
        fluxes = {(2,3,4):F(1),(1,3,4):-tiny,(1,2,4):F(-1),(1,2,3):F(0)}
        self.assertEqual(1.+float(tiny)-1.,0.)
        result = audit_fluxes(nodes,[(1,2,3,4)],fluxes,{"face_pairs":[]})
        self.assertEqual(result["cell_balance"]["maximum_absolute_exact"],str(tiny))
        self.assertEqual(result["cell_balance"]["nonzero_count"],1)

    def test_internal_face_has_two_opposite_incidence_signs(self):
        nodes = tetra_nodes()
        nodes[5] = (F(0),F(0),F(-1))
        cells = [(1,2,3,4),(1,3,2,5)]
        result = audit_fluxes(nodes,cells,constant_flux(nodes,cells),{"face_pairs":[]})
        self.assertEqual(result["interior_face_count"],1)
        self.assertEqual(result["cell_balance"]["nonzero_count"],0)

    def test_duplicate_overlapping_cells_and_missing_faces_are_refused(self):
        nodes = tetra_nodes()
        fluxes = constant_flux(nodes,[(1,2,3,4)])
        with self.assertRaisesRegex(ValueError,"oriented"):
            audit_fluxes(nodes,[(1,2,3,4)]*2,fluxes,{"face_pairs":[]})
        fluxes.pop((1,2,3))
        with self.assertRaisesRegex(ValueError,"missing"):
            audit_fluxes(nodes,[(1,2,3,4)],fluxes,{"face_pairs":[]})

    def test_paired_cut_checks_local_outward_opposites(self):
        nodes,cut = cut_fixture()
        cells = [(1,2,3,4),(5,7,6,8)]
        fluxes = constant_flux(nodes,cells)
        result = audit_fluxes(nodes,cells,fluxes,cut)
        self.assertEqual(result["cut_face_count"],2)
        self.assertEqual(result["paired_cut_balance"]["nonzero_count"],0)
        fluxes[(5,6,7)] += F(1,100)
        result = audit_fluxes(nodes,cells,fluxes,cut)
        self.assertEqual(result["paired_cut_balance"]["maximum_absolute_exact"],"1/100")

    def test_paired_cut_same_side_normals_detected_even_for_zero_flux(self):
        nodes,cut = cut_fixture()
        nodes[8] = nodes[4]
        cells = [(1,2,3,4),(5,6,7,8)]
        fluxes = {face:F(0) for face in constant_flux(nodes,cells)}
        result = audit_fluxes(nodes,cells,fluxes,cut)
        self.assertEqual(result["paired_cut_balance"]["nonzero_count"],0)
        self.assertEqual(result["paired_cut_area_opposition"]["count"],3)
        self.assertEqual(result["paired_cut_area_opposition"]["nonzero_count"],1)
        self.assertEqual(result["paired_cut_area_opposition"]["maximum_absolute_exact"],"1")
        self.assertEqual(result["paired_cut_area_opposition"]["unit"],"m^2")

    def test_exact_potential_jump_and_coincident_geometry(self):
        nodes,cut = cut_fixture()
        jump = F.from_float(.001)
        potentials = {i:(jump if i in (5,6,7) else F(0)) for i in nodes}
        result = audit_cut_potential(nodes,potentials,cut)
        self.assertEqual(result["paired_vertices"],3)
        self.assertEqual(result["jump"]["nonzero_count"],0)
        potentials[1] = F.from_float(2.**-60)
        result = audit_cut_potential(nodes,potentials,cut)
        self.assertEqual(result["jump"]["maximum_absolute_exact"],str(F.from_float(2.**-60)))

    def test_wrong_cut_geometry_is_refused(self):
        nodes,cut = cut_fixture()
        nodes[7] = (F(0),F(2),F(0))
        with self.assertRaisesRegex(ValueError,"geometry"):
            audit_cut_potential(nodes,{i:F(0) for i in nodes},cut)

    def test_pinned_corner25_saved_flux_and_potential_diagnostic(self):
        import os
        import resource
        import time
        from antenna_saved_flux_admissibility import run_saved_audit
        root = Path(__file__).resolve().parents[1]
        experiment = root/"examples/sushruth_2020_closed_gsg"
        paths = list((experiment/"restart_20261111/input/fem_antenna_gsg_corner25_restart_20261111.zarr").glob("*/*/antenna-inspection.bundle"))
        self.assertEqual(len(paths),1)
        address_space = resource.getrlimit(resource.RLIMIT_AS)
        cpu = resource.getrlimit(resource.RLIMIT_CPU)
        affinity = os.sched_getaffinity(0)
        started = time.monotonic()
        try:
            resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,address_space[1]))
            consumed = resource.getrusage(resource.RUSAGE_SELF)
            resource.setrlimit(resource.RLIMIT_CPU,(int(consumed.ru_utime+consumed.ru_stime)+120,cpu[1]))
            os.sched_setaffinity(0,{min(affinity)})
            report = run_saved_audit(paths[0],experiment/"edge_field_20261111/input/gsg-source-preparation.json")
        finally:
            resource.setrlimit(resource.RLIMIT_AS,address_space)
            resource.setrlimit(resource.RLIMIT_CPU,cpu)
            os.sched_setaffinity(0,affinity)
        self.assertFalse(report["complete_admissibility_verified"])
        self.assertFalse(report["raw_J_trace_checked"])
        self.assertFalse(report["rigorous_energy_bound_computed"])
        self.assertEqual(report["flux"]["cell_balance"]["count"],40728)
        self.assertEqual(report["cut_potential"]["paired_vertices"],16)
        self.assertEqual(report["flux"]["paired_cut_area_opposition"]["count"],54)
        self.assertEqual(report["flux"]["paired_cut_area_opposition"]["nonzero_count"],0)
        report["elapsed_seconds"] = time.monotonic()-started
        report["peak_rss_bytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024
        print("ANTENNA_SAVED_FLUX_AUDIT_JSON:"+json.dumps(report,sort_keys=True),flush=True)

    def test_stream_reader_checks_all_payloads_but_retains_only_selected(self):
        raw,payloads = bundle_bytes()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/"bundle.bin"
            path.write_bytes(raw)
            manifest,data = read_selected_bundle(path,hashlib.sha256(raw).hexdigest())
            self.assertEqual(data,{k:payloads[k] for k in SELECTED})
            self.assertIn("ignored",manifest["payloads"])
            corrupted = raw.replace(b"ignored-binary",b"ignored-BINARY")
            path.write_bytes(corrupted)
            with self.assertRaisesRegex(ValueError,"payload digest"):
                read_selected_bundle(path,hashlib.sha256(corrupted).hexdigest())

    def test_stream_reader_rejects_trailing_bytes_and_wrong_bundle_digest(self):
        raw,_ = bundle_bytes()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/"bundle.bin"
            path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError,"digest"):
                read_selected_bundle(path,"0"*64)
            path.write_bytes(raw+b"x")
            with self.assertRaisesRegex(ValueError,"trailing"):
                read_selected_bundle(path,hashlib.sha256(raw+b"x").hexdigest())


if __name__ == "__main__":
    unittest.main()
