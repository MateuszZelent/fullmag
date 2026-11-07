"""Explicit private subnet validation and read-only Docker network preflight."""
from __future__ import annotations

from collections.abc import Mapping
from ipaddress import IPv4Network, ip_network
import json
import re

from docker_build_control import BuildControlError, docker_capture


_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_NETWORKS = 4096
MAX_INSPECT_BATCH = 32
_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
_DOCKER_TIMEOUT_SECONDS = 60
_RFC1918 = tuple(ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def parse_requested_subnet(value):
    """Return a canonical allowed IPv4 subnet string, or None when omitted."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise BuildControlError("Requested Docker network subnet must be a canonical IPv4 CIDR string")
    try:
        subnet = IPv4Network(value, strict=True)
    except ValueError as error:
        raise BuildControlError("Requested Docker network subnet is not a strict IPv4 network") from error
    if str(subnet) != value:
        raise BuildControlError("Requested Docker network subnet must use canonical IPv4 CIDR notation")
    if not 16 <= subnet.prefixlen <= 29:
        raise BuildControlError("Requested Docker network subnet prefix must be between /16 and /29")
    if not any(subnet.subnet_of(private) for private in _RFC1918):
        raise BuildControlError("Requested Docker network subnet must be inside an RFC1918 private range")
    return str(subnet)


def _project_network(document):
    if not isinstance(document, Mapping):
        raise BuildControlError("Compose document must be an object for Docker network subnet handling")
    networks = document.get("networks")
    if not isinstance(networks, Mapping) or set(networks) != {"fullmag"}:
        raise BuildControlError("Compose document must define exactly the project-scoped fullmag network")
    network = networks.get("fullmag")
    if not isinstance(network, Mapping):
        raise BuildControlError("Compose fullmag network definition is incomplete")
    if network.get("driver") != "bridge":
        raise BuildControlError("Compose fullmag network must use the bridge driver")
    if "external" in network and network["external"] is not False:
        raise BuildControlError("Compose fullmag network must not be external")
    ipam = network.get("ipam")
    if not isinstance(ipam, Mapping) or ipam.get("driver") != "default":
        raise BuildControlError("Compose fullmag network must retain the default IPAM driver")
    if "config" in ipam:
        config = ipam["config"]
        if not isinstance(config, list) or any(not isinstance(item, Mapping) for item in config):
            raise BuildControlError("Compose fullmag network IPAM config is malformed")
    if not isinstance(network, dict) or not isinstance(ipam, dict):
        raise BuildControlError("Compose fullmag network must be mutable for subnet application")
    return network, ipam


def apply_requested_subnet(document, value):
    """Mutate only ``networks.fullmag.ipam.config`` for an explicit subnet."""
    subnet = parse_requested_subnet(value)
    if subnet is None:
        return None
    _, ipam = _project_network(document)
    ipam["config"] = [{"subnet": subnet}]
    return None


def validate_retained_subnet(document, value):
    """Require a requested subnet to match the sole persisted Compose subnet."""
    subnet = parse_requested_subnet(value)
    if subnet is None:
        return None
    _, ipam = _project_network(document)
    config = ipam.get("config")
    if not isinstance(config, list) or len(config) != 1 or not isinstance(config[0], Mapping):
        raise BuildControlError("Retained Compose fullmag network must contain exactly one subnet")
    retained = config[0].get("subnet")
    try:
        canonical = parse_requested_subnet(retained)
    except BuildControlError as error:
        raise BuildControlError("Retained Compose fullmag network subnet is invalid") from error
    if canonical != subnet:
        raise BuildControlError("Retained Compose fullmag network subnet does not match the requested subnet")
    return None


def _json_no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_json_constant(value):
    raise ValueError(f"invalid JSON constant {value}")


def _decode_json(data, detail):
    if not isinstance(data, bytes) or len(data) > _MAX_OUTPUT_BYTES:
        raise BuildControlError(f"Docker network {detail} output is incomplete or exceeds its byte budget")
    try:
        text = data.decode("utf-8")
        return json.loads(text, object_pairs_hook=_json_no_duplicates, parse_constant=_reject_json_constant)
    except (UnicodeDecodeError, ValueError) as error:
        raise BuildControlError(f"Docker network {detail} output is not valid canonical JSON") from error


def _read_docker(*args):
    try:
        result = docker_capture(*args, timeout=_DOCKER_TIMEOUT_SECONDS, allow_failure=True)
    except BuildControlError as error:
        raise BuildControlError(f"Docker network observation failed: {error}") from error
    except (OSError, TypeError, ValueError) as error:
        raise BuildControlError(f"Docker network observation failed: {error}") from error
    if not hasattr(result, "returncode") or not hasattr(result, "stdout"):
        raise BuildControlError("Docker network observation returned an incomplete result")
    if result.returncode != 0:
        detail = getattr(result, "stderr", b"")
        if isinstance(detail, bytes):
            detail = detail.decode("utf-8", "replace")
        elif not isinstance(detail, str):
            detail = ""
        detail = detail.strip()[:1024]
        raise BuildControlError("Docker network observation failed" + (f": {detail}" if detail else ""))
    output = result.stdout
    if not isinstance(output, bytes) or len(output) > _MAX_OUTPUT_BYTES:
        raise BuildControlError("Docker network observation is incomplete or exceeds its byte budget")
    return output


def _network_ids():
    output = _read_docker("network", "ls", "--quiet", "--no-trunc")
    try:
        text = output.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BuildControlError("Docker network inventory IDs are not valid UTF-8") from error
    lines = text.splitlines()
    if len(lines) > _MAX_NETWORKS:
        raise BuildControlError("Docker network inventory exceeds its bounded network count")
    identifiers = []
    seen = set()
    for line in lines:
        identifier = line
        if not identifier or identifier.strip() != identifier or _HEX64.fullmatch(identifier) is None:
            raise BuildControlError("Docker network inventory has an incomplete or invalid network ID")
        if identifier in seen:
            raise BuildControlError("Docker network inventory contains a duplicate network ID")
        seen.add(identifier)
        identifiers.append(identifier)
    return identifiers


def _inspect_batch(identifiers):
    output = _read_docker("network", "inspect", *identifiers)
    documents = _decode_json(output, "inspect")
    if not isinstance(documents, list) or len(documents) != len(identifiers):
        raise BuildControlError("Docker network inspection is incomplete for the listed network IDs")
    expected = set(identifiers)
    observed = set()
    for document in documents:
        if not isinstance(document, Mapping):
            raise BuildControlError("Docker network inspection contains an incomplete network record")
        identifier = document.get("Id")
        if not isinstance(identifier, str) or _HEX64.fullmatch(identifier) is None:
            raise BuildControlError("Docker network inspection contains an invalid network ID")
        if identifier not in expected or identifier in observed:
            raise BuildControlError("Docker network inspection IDs do not match the listed inventory")
        observed.add(identifier)
    if observed != expected:
        raise BuildControlError("Docker network inspection is incomplete for the listed network IDs")
    return documents


def _network_subnets(document):
    driver = document.get("Driver")
    if not isinstance(driver, str) or not driver:
        raise BuildControlError("Docker network inspection has no complete network driver")
    ipam = document.get("IPAM")
    if not isinstance(ipam, Mapping):
        raise BuildControlError("Docker network inspection has incomplete IPAM data")
    ipam_driver = ipam.get("Driver")
    if not isinstance(ipam_driver, str) or not ipam_driver:
        raise BuildControlError("Docker network inspection has no complete IPAM driver")
    config = ipam.get("Config")
    if config is None:
        if driver in {"host", "null"} and ipam_driver == "default":
            return []
        raise BuildControlError("Docker network inspection has incomplete IPAM subnet data")
    if not isinstance(config, list):
        raise BuildControlError("Docker network inspection has malformed IPAM subnet data")
    subnets = []
    seen = set()
    for entry in config:
        if not isinstance(entry, Mapping):
            raise BuildControlError("Docker network inspection has an incomplete IPAM subnet record")
        raw = entry.get("Subnet")
        if not isinstance(raw, str):
            raise BuildControlError("Docker network inspection has a missing IPAM subnet")
        try:
            subnet = ip_network(raw, strict=True)
        except ValueError as error:
            raise BuildControlError("Docker network inspection contains a malformed IPAM subnet") from error
        if str(subnet) != raw:
            raise BuildControlError("Docker network inspection contains a noncanonical IPAM subnet")
        if raw in seen:
            raise BuildControlError("Docker network inspection contains a duplicate IPAM subnet")
        seen.add(raw)
        subnets.append(subnet)
    return subnets


def _network_inventory():
    identifiers = _network_ids()
    inventory = []
    names = set()
    for offset in range(0, len(identifiers), MAX_INSPECT_BATCH):
        batch = identifiers[offset:offset + MAX_INSPECT_BATCH]
        for document in _inspect_batch(batch):
            name = document.get("Name")
            if not isinstance(name, str) or not name or name.strip() != name:
                raise BuildControlError("Docker network inspection has an incomplete network name")
            if name in names:
                raise BuildControlError("Docker network inspection contains a duplicate network name")
            names.add(name)
            inventory.append((document, _network_subnets(document)))
    return inventory


def check_requested_subnet_available(value, network_name):
    """Read Docker's complete network inventory and reject IPv4 subnet overlap."""
    requested = parse_requested_subnet(value)
    if requested is None:
        return None
    if not isinstance(network_name, str) or not network_name or network_name.strip() != network_name:
        raise BuildControlError("Selected Compose network name is invalid")
    subnet = IPv4Network(requested, strict=True)
    inventory = _network_inventory()
    matching = [(document, subnets) for document, subnets in inventory
                if document["Name"] == network_name]
    if len(matching) > 1:
        raise BuildControlError("Docker inventory contains multiple networks with the selected name")
    own = matching[0] if matching else None
    if own is not None:
        own_ipv4 = [item for item in own[1] if item.version == 4]
        if len(own_ipv4) != 1 or own_ipv4[0] != subnet or len(own[1]) != 1:
            raise BuildControlError("Existing selected Docker network subnet does not match the requested subnet")
    for document, subnets in inventory:
        if own is not None and document is own[0]:
            continue
        for observed in subnets:
            if observed.version == 4 and subnet.overlaps(observed):
                raise BuildControlError(
                    f"Requested Docker network subnet {subnet} overlaps network {document['Name']} ({observed})"
                )
    return None
