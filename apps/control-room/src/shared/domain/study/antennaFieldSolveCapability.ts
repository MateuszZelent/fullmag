/** Matches AntennaFieldSolveStage in the public Python DSL and raw planner. */
export function antennaFieldSolveDefinitionPortError(portIds: readonly string[]): string | null {
  return portIds.length === 1 && portIds[0].trim()
    ? null
    : "Executable field-solve definitions currently require exactly one port mode. Create a separate single-port definition for each solve; selecting one port does not make a multiport definition executable.";
}
