"""Create one disposable, scope-pinned FDM browser fixture on an empty local API."""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import fullmag as fm
from fullmag.client import Client
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.script_builder import export_builder_draft


def seed(origin, destination):
    url = urlsplit(origin)
    if url.scheme != "http" or url.hostname not in {"localhost", "127.0.0.1", "::1"} or (
        url.port is None or url.netloc != url.netloc.rsplit("@", 1)[-1]
        or url.path not in {"", "/"} or url.query or url.fragment
    ):
        raise ValueError("A local HTTP origin with an explicit port is required")
    origin = origin.rstrip("/")
    if destination.exists() or not destination.parent.is_dir():
        raise ValueError("Choose an unused fixture filename in an existing directory")
    name = "ABL browser QA " + uuid4().hex
    object_id = "ABL QA film"
    with TemporaryDirectory() as directory:
        script = Path(directory) / "abl_form.py"
        script.write_text(f"""import fullmag as fm
study = fm.study({name!r})
study.engine("fdm")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(160e-9, 40e-9, 10e-9), center=(0, 0, 0), padding=(0, 0, 0))
study.cell(5e-9, 5e-9, 5e-9)
film = study.geometry(fm.Box(160e-9, 40e-9, 10e-9), name={object_id!r}, object_id={object_id!r})
film.Ms = 800e3
film.Aex = 13e-12
film.alpha = 0.01
film.m = fm.texture.uniform(1, 0, 0)
study.demag(enabled=False)
study.stages.add_run(stage_id="wave", until=1e-12)
study.wait_for_solve(True)
""", encoding="utf-8")
        scene = build_scene_document_from_builder(
            export_builder_draft(fm.load_problem_from_script(script, lightweight_assets=True))
        )
    with Client(origin, timeout=30, retry_budget_s=0) as client:
        health = client.health()
        if health["status"] != "ok" or health["active_session"] is not False or client.sessions.list()["sessions"]:
            raise RuntimeError("A healthy, empty QA group is required to create the test session")
        client.sessions.create(name, backend="fdm", device="cpu", precision="double")
        session = client.sessions.status()["session"]
        if session["name"] != name:
            raise RuntimeError("New session identity changed")
        pin = {key: session[key] for key in ("session_id", "session_epoch", "request_scope_epoch")}
        if not all(isinstance(value, str) and value for value in pin.values()):
            raise RuntimeError("Incomplete session scope")
        print(f"Created QA session {pin['session_id']}", flush=True)
        client.session_scope = urlencode(dict(session=pin["session_id"], epoch=pin["session_epoch"],
                                              request_scope_epoch=pin["request_scope_epoch"]))
        before = client.model.scene()
        if before["revision"] != 0 or before["objects"]:
            raise RuntimeError("Refusing to replace a nonempty scene")
        client.model.replace_scene(scene, base_revision=0)
        saved = client.model.scene()
        if saved["scene"]["name"] != name or [item["id"] for item in saved["objects"]] != [object_id]:
            raise RuntimeError("Unexpected fixture identity after save")
        grid = client.commands.submit("fdm_grid_refresh", reason="explicit_build_grid",
                                      precondition={"scene_revision": saved["revision"]})
        grid.wait(90)
        if grid.status != "completed":
            raise RuntimeError(f"Initial Build Grid ended in {grid.status}")
        with destination.open("x", encoding="utf-8") as output:
            json.dump(dict(origin=origin, name=name, object_id=object_id, pin=pin,
                           baseline_grid_command=grid.command_id), output, indent=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--allow-create-session", action="store_true", required=True)
    args = parser.parse_args()
    seed(args.url, args.fixture)
