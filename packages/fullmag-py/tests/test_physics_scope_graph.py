from types import SimpleNamespace

import fullmag as fm
from fullmag.model.physics_scope import PhysicsActivation, build_physics_graph


class _Module:
    def __init__(self, payload: dict[str, object], **attrs: object) -> None:
        self._payload = payload
        for key, value in attrs.items():
            setattr(self, key, value)

    def to_ir(self) -> dict[str, object]:
        return dict(self._payload)


def _problem(**overrides: object) -> SimpleNamespace:
    values = {
        "current_modules": (),
        "spin_transports": (),
        "spin_torques": (),
        "energy": (),
        "field_drives": (),
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_missing_transport_module_emits_no_transport_nodes() -> None:
    graph = build_physics_graph(_problem())
    assert graph.to_ir()["modules"] == []


def test_zero_current_preserves_transport_module() -> None:
    current = _Module(
        {
            "kind": "current_transport",
            "name": "current:film",
            "model": "prescribed_density",
            "current_density": [0.0, 0.0, 0.0],
            "domain": [{"object_id": "film"}],
        },
        name="current:film",
        model="prescribed_density",
        current_density=(0.0, 0.0, 0.0),
        domain=(SimpleNamespace(object_id="film", region_id=None),),
    )
    graph = build_physics_graph(_problem(current_modules=(current,)))
    module = graph.modules[0]
    assert module.id == "current:film"
    assert module.activation is PhysicsActivation.INACTIVE


def test_missing_current_blocks_dependent_spin_transport() -> None:
    spin = _Module(
        {
            "kind": "spin_transport",
            "id": "spin:film",
            "current_source_id": "missing-current",
            "domain": [{"object_id": "film"}],
        },
        id="spin:film",
        current_source_id="missing-current",
        domain=(SimpleNamespace(object_id="film", region_id=None),),
    )
    graph = build_physics_graph(_problem(spin_transports=(spin,)))
    assert graph.modules[0].activation is PhysicsActivation.BLOCKED


def test_spin_torque_graph_kind_is_generic_and_family_stays_in_payload() -> None:
    torque = fm.ZhangLiSTT(
        current_density=(1e12, 0.0, 0.0),
        degree=1.0,
        beta=0.05,
        id="sp5_zhang_li",
        target=fm.RegionRef("film"),
        lande_g=2.0,
        operator_version="zl_mumax3_central_v1",
    )

    graph = build_physics_graph(_problem(spin_torques=(torque,)))

    assert len(graph.modules) == 1
    module = graph.modules[0]
    assert module.id == "sp5_zhang_li"
    assert module.kind == "spin_torque"
    assert module.family_payload["kind"] == "zhang_li"
    assert module.applies_to[0].kind == "object"
    assert module.applies_to[0].object_id == "film"


def test_spin_torque_edges_preserve_dependency_semantics() -> None:
    current = _Module(
        {
            "kind": "current_transport",
            "name": "current:film",
            "model": "prescribed_density",
            "current_density": [1.0, 0.0, 0.0],
            "domain": [{"object_id": "film"}],
        }
    )
    spin = _Module(
        {
            "kind": "spin_transport",
            "id": "spin:film",
            "current_source_id": "current:film",
            "domain": [{"object_id": "film"}],
        }
    )
    transport_torque = _Module(
        {
            "kind": "drift_diffusion_spin_torque",
            "id": "torque:transport",
            "solve_id": "spin:film",
            "target": {"object_id": "film"},
        }
    )
    current_torque = fm.ZhangLiSTT(
        current_source="current:film",
        id="torque:current",
        target=fm.RegionRef("film"),
        lande_g=2.0,
        operator_version="zl_central_reference_v1",
    )

    graph = build_physics_graph(
        _problem(
            current_modules=(current,),
            spin_transports=(spin,),
            spin_torques=(transport_torque, current_torque),
        )
    )

    assert [edge.to_ir() for edge in graph.edges] == [
        {
            "kind": "current_to_spin_transport",
            "source_id": "current:film",
            "target_id": "spin:film",
            "status": "active",
        },
        {
            "kind": "current_to_torque",
            "source_id": "current:film",
            "target_id": "torque:current",
            "status": "active",
        },
        {
            "kind": "spin_transport_to_torque",
            "source_id": "spin:film",
            "target_id": "torque:transport",
            "status": "active",
        },
    ]


def test_reordering_authored_families_keeps_graph_order() -> None:
    first = _Module({"kind": "current_transport", "name": "current:a", "model": "prescribed_density", "current_density": [1.0, 0.0, 0.0], "domain": []}, name="current:a", model="prescribed_density", current_density=(1.0, 0.0, 0.0), domain=())
    second = _Module({"kind": "current_transport", "name": "current:b", "model": "prescribed_density", "current_density": [2.0, 0.0, 0.0], "domain": []}, name="current:b", model="prescribed_density", current_density=(2.0, 0.0, 0.0), domain=())
    a = build_physics_graph(_problem(current_modules=(first, second))).to_ir()
    b = build_physics_graph(_problem(current_modules=(second, first))).to_ir()
    assert [item["id"] for item in a["modules"]] == [item["id"] for item in b["modules"]]


def test_problem_ir_publishes_the_same_graph_contract() -> None:
    geometry = fm.Box(size=(10e-9, 10e-9, 2e-9), name="film")
    material = fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01)
    problem = fm.Problem(
        name="scope-graph",
        magnets=[fm.Ferromagnet(name="film", geometry=geometry, material=material)],
        energy=[fm.Exchange()],
        study=fm.TimeEvolution(dynamics=fm.LLG(), outputs=[]),
        current_modules=[
            fm.CurrentTransport(
                name="current:film",
                current_density=(0.0, 0.0, 0.0),
                domain=[fm.RegionRef("film")],
            )
        ],
    )
    payload = problem.to_ir(include_geometry_assets=False)
    graph = payload["physics_graph"]
    assert graph["schema_version"] == "physics_graph.v1"
    assert graph["modules"][0]["activation"] == "inactive"
