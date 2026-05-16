/**
 * Interaction — Command Initializer
 *
 * Registers all built-in commands at app startup.
 * Call once from the root layout or ControlRoom provider.
 */

import { registerCameraCommands } from "../commands/commands.camera";
import { registerTransformCommands } from "../commands/commands.transform";
import { registerMagnetizationCommands } from "../commands/commands.magnetization";
import { registerMeshCommands } from "../commands/commands.mesh";

let initialized = false;

export function initializeInteractionCommands(): void {
  if (initialized) return;
  initialized = true;

  registerCameraCommands();
  registerTransformCommands();
  registerMagnetizationCommands();
  registerMeshCommands();
}
