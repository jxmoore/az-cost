// Runtime settings, read from /config.json so one built image serves any tenant: the Docker entrypoint writes it
// from AZCOST_CLIENT_ID and AZCOST_TENANT_ID. Nothing here is secret: a SPA's client id is public by design.
export interface AppConfig {
  clientId: string;
  tenantId: string;
}

const PLACEHOLDER = /^0{8}-0{4}-0{4}-0{4}-0{12}$|^$|^YOUR_/i;

export async function loadConfig(): Promise<AppConfig | null> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = (await res.json()) as AppConfig;
    return PLACEHOLDER.test(cfg.clientId ?? "") || PLACEHOLDER.test(cfg.tenantId ?? "") ? null : cfg;
  } catch {
    return null;
  }
}
