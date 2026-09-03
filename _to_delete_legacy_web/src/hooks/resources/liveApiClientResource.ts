import {
  getLiveSessionClient,
  initLiveSessionClient,
} from "../../api/client/LiveSessionClient";
import { resolveApiBase } from "@/lib/apiBase";

export function ensureLiveApiResourceClient() {
  try {
    return getLiveSessionClient();
  } catch {
    return initLiveSessionClient({ baseUrl: resolveApiBase() });
  }
}
