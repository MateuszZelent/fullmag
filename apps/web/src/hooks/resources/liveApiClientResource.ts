import {
  getLiveApiClient,
  initLiveApiClient,
} from "../../api/client/LiveApiClient";
import { resolveApiBase } from "@/lib/apiBase";

export function ensureLiveApiResourceClient() {
  try {
    return getLiveApiClient();
  } catch {
    return initLiveApiClient({ baseUrl: resolveApiBase() });
  }
}
