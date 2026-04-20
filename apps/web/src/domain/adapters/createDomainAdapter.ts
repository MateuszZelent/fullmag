/**
 * Factory: create the appropriate SpatialDomainAdapter from DomainMeta.
 */

import type { DomainMeta } from "../../api/generated/openapi-types";
import type { DecodedTopology } from "../../api/codecs/types";
import type { SpatialDomainAdapter } from "./SpatialDomainAdapter";
import { FdmDomainAdapter } from "./FdmDomainAdapter";
import { FemDomainAdapter } from "./FemDomainAdapter";

export function createDomainAdapter(
  meta: DomainMeta,
  topology?: DecodedTopology,
): SpatialDomainAdapter {
  switch (meta.discretization) {
    case "fdm":
      return new FdmDomainAdapter(meta);
    case "fem": {
      if (!topology) {
        throw new Error("FEM domain requires decoded topology");
      }
      return new FemDomainAdapter(meta, topology);
    }
    default:
      throw new Error(`Unknown discretization: ${meta.discretization}`);
  }
}
