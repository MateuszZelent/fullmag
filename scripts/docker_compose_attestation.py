"""Read-only ownership checks shared by the Docker launcher and verifier."""
import re


def _expected_network_name(project, network_name):
    name = network_name or project + "_fullmag"
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", name):
        raise ValueError("Fullmag network name is invalid")
    return name


def service_network(document, project, *, hostname=None, network_name=None):
    name = _expected_network_name(project, network_name)
    networks = document.get("NetworkSettings", {}).get("Networks") or {}
    if (document.get("HostConfig", {}).get("NetworkMode") != name
            or set(networks) != {name}):
        raise ValueError("Fullmag service must use only its project-scoped Compose network")
    network_id = networks[name].get("NetworkID", "")
    if not re.fullmatch(r"[0-9a-f]{64}", network_id):
        raise ValueError("Fullmag service network identity is missing")
    if hostname is not None and document.get("Config", {}).get("Hostname") != hostname:
        raise ValueError("Fullmag backend hostname differs from its storage namespace")
    return network_id


def network_owner(document, project, network_id, *, network_name=None):
    name = _expected_network_name(project, network_name)
    labels = document.get("Labels") or {}
    if (document.get("Id") != network_id
            or document.get("Name") != name
            or document.get("Driver") != "bridge"
            or document.get("Scope") != "local"
            or document.get("Ingress") is True
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.network") != "fullmag"):
        raise ValueError("Fullmag network identity, driver or Compose ownership differs")
