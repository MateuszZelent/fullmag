function sceneArray(scene, key) {
  return Array.isArray(scene?.[key]) ? scene[key] : [];
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Antenna scene is missing ${label}.`);
  }
  return value;
}

export function assertAntennaScene(scene) {
  const antennaObjects = sceneArray(scene, "objects").filter(
    (object) => object?.role === "antenna",
  );
  if (antennaObjects.length !== 1) {
    throw new Error(
      `Expected exactly one authored antenna object, got ${antennaObjects.length}.`,
    );
  }
  const objectId = requiredString(antennaObjects[0]?.id, "the antenna object id");
  const ports = sceneArray(scene, "antenna_port_modes").filter(
    (port) => port?.source_object_id === objectId,
  );
  if (ports.length !== 1) {
    throw new Error(`Expected one antenna port for ${objectId}, got ${ports.length}.`);
  }
  const portId = requiredString(ports[0]?.id, "the antenna port id");
  if (!Array.isArray(ports[0]?.branches) || ports[0].branches.length < 2) {
    throw new Error(`Antenna port ${portId} does not contain a signal/return branch pair.`);
  }
  const branches = ports[0].branches;
  const signal = branches.find((branch) => branch?.id === "signal");
  const returnBranch = branches.find((branch) => branch?.id === "return");
  if (
    ports[0]?.schema_version !== "antenna_port_mode.v2" ||
    branches.length !== 2 ||
    signal?.signed_weight !== 1 ||
    signal?.inlet_terminal_ref !== "signal_in" ||
    signal?.outlet_terminal_ref !== "signal_out" ||
    returnBranch?.signed_weight !== -1 ||
    returnBranch?.inlet_terminal_ref !== "return_in" ||
    returnBranch?.outlet_terminal_ref !== "return_out"
  ) {
    throw new Error(`Antenna port ${portId} does not match the balanced microstrip preset.`);
  }

  const stages = sceneArray(scene, "antenna_field_solve_stages").filter(
    (stage) => stage?.source_object_id === objectId,
  );
  if (stages.length !== 1) {
    throw new Error(`Expected one antenna field-solve stage for ${objectId}, got ${stages.length}.`);
  }
  const stage = stages[0];
  const stageId = requiredString(stage?.id, "the antenna stage id");
  if (
    stage?.current_transport_id !== ports[0]?.current_transport_id ||
    !Array.isArray(stage?.port_mode_ids) ||
    stage.port_mode_ids.length !== 1 ||
    stage.port_mode_ids[0] !== portId
  ) {
    throw new Error(`Antenna field-solve stage ${stageId} is not linked to its port and transport.`);
  }
  const output = sceneArray(stage, "outputs").find(
    (candidate) => candidate?.quantity === "H_ant_basis",
  );
  const outputId = requiredString(output?.id, "the H_ant_basis output id");
  const transportId = requiredString(
    stage?.current_transport_id ?? ports[0]?.current_transport_id,
    "the current transport id",
  );
  const transports = sceneArray(scene, "current_transports");
  if (!transports.some((transport) => transport?.id === transportId || transport?.name === transportId)) {
    throw new Error(`Antenna current transport ${transportId} is not present in the scene.`);
  }

  return { objectId, portId, stageId, outputId, transportId };
}

export function antennaExplorerNodeIds(objectId, portId, stageId) {
  const parent = `model:object:${objectId}:antenna`;
  return {
    conductor: `${parent}:conductor`,
    port: `${parent}:port:${encodeURIComponent(portId)}`,
    solution: `${parent}:solution:${encodeURIComponent(stageId)}`,
  };
}
