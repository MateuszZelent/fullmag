/**
 * Version-check interceptor.
 * Validates the `x-api-contract-version` response header against expected.
 */

import { LiveApiError } from "../errors/LiveApiError";
import { EXPECTED_API_CONTRACT_VERSION } from "../../../config/featureFlags";

const CONTRACT_HEADER = "x-api-contract-version";

export function checkContractVersion(response: Response): void {
  const actual = response.headers.get(CONTRACT_HEADER);
  if (!actual) {
    // Header absent — backend may not send it yet; skip check.
    return;
  }
  if (actual !== EXPECTED_API_CONTRACT_VERSION) {
    throw LiveApiError.contractMismatch(EXPECTED_API_CONTRACT_VERSION, actual);
  }
}
