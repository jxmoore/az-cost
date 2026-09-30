// The type view: every resource grouped by what it is (virtual machines, disks, storage accounts...), so you can
// see each VM and how it changed. Built from the resource view the run already read: no extra Azure calls.
// A resource's amount is everything billed to it (a VM's compute, and the bandwidth charged to it); its disks are
// resources of their own, under Disks.
import { accumulate } from "./pack";
import type { CostData, PackedRow, ViewData } from "./types";

export const NO_TYPE = "(no resource)"; // charges with no resource id: some marketplace, support and reservation lines
const TINY = "(under a cent each)";

/** "microsoft.sql/servers/databases" from ".../providers/Microsoft.Sql/servers/sql1/databases/orders". */
export function typeOf(resourceId: string): string {
  const i = resourceId.toLowerCase().lastIndexOf("/providers/");
  if (i < 0) return NO_TYPE;
  const [ns, ...rest] = resourceId.slice(i + "/providers/".length).toLowerCase().split("/").filter(Boolean);
  const types = rest.filter((_, j) => j % 2 === 0); // type, name, child type, child name, ...
  return ns && types.length ? `${ns}/${types.join("/")}` : NO_TYPE;
}

const NAMES: Record<string, string> = {
  "microsoft.compute/virtualmachines": "Virtual machines",
  "microsoft.compute/virtualmachinescalesets": "VM scale sets",
  "microsoft.compute/disks": "Disks",
  "microsoft.compute/snapshots": "Snapshots",
  "microsoft.compute/images": "Images",
  "microsoft.compute/galleries": "Compute galleries",
  "microsoft.containerservice/managedclusters": "AKS clusters",
  "microsoft.containerinstance/containergroups": "Container instances",
  "microsoft.app/containerapps": "Container apps",
  "microsoft.app/managedenvironments": "Container app environments",
  "microsoft.containerregistry/registries": "Container registries",
  "microsoft.web/serverfarms": "App Service plans",
  "microsoft.web/sites": "App Services & Functions",
  "microsoft.web/staticsites": "Static web apps",
  "microsoft.logic/workflows": "Logic apps",
  "microsoft.storage/storageaccounts": "Storage accounts",
  "microsoft.recoveryservices/vaults": "Recovery Services vaults",
  "microsoft.dataprotection/backupvaults": "Backup vaults",
  "microsoft.sql/servers": "SQL servers",
  "microsoft.sql/servers/databases": "SQL databases",
  "microsoft.sql/servers/elasticpools": "SQL elastic pools",
  "microsoft.sql/managedinstances": "SQL managed instances",
  "microsoft.documentdb/databaseaccounts": "Cosmos DB accounts",
  "microsoft.cache/redis": "Redis caches",
  "microsoft.cache/redisenterprise": "Redis Enterprise",
  "microsoft.dbforpostgresql/flexibleservers": "PostgreSQL servers",
  "microsoft.dbformysql/flexibleservers": "MySQL servers",
  "microsoft.network/publicipaddresses": "Public IPs",
  "microsoft.network/natgateways": "NAT gateways",
  "microsoft.network/privateendpoints": "Private endpoints",
  "microsoft.network/loadbalancers": "Load balancers",
  "microsoft.network/applicationgateways": "Application gateways",
  "microsoft.network/azurefirewalls": "Firewalls",
  "microsoft.network/virtualnetworkgateways": "VPN gateways",
  "microsoft.network/bastionhosts": "Bastion hosts",
  "microsoft.network/dnszones": "DNS zones",
  "microsoft.network/privatednszones": "Private DNS zones",
  "microsoft.network/virtualnetworks": "Virtual networks",
  "microsoft.cdn/profiles": "Front Door & CDN profiles",
  "microsoft.apimanagement/service": "API Management",
  "microsoft.operationalinsights/workspaces": "Log Analytics workspaces",
  "microsoft.insights/components": "Application Insights",
  "microsoft.insights/webtests": "Availability tests",
  "microsoft.keyvault/vaults": "Key vaults",
  "microsoft.security/pricings": "Defender plans",
  "microsoft.cognitiveservices/accounts": "AI services & OpenAI",
  "microsoft.machinelearningservices/workspaces": "Machine learning workspaces",
  "microsoft.search/searchservices": "AI Search services",
  "microsoft.datafactory/factories": "Data factories",
  "microsoft.eventhub/namespaces": "Event Hubs namespaces",
  "microsoft.servicebus/namespaces": "Service Bus namespaces",
  "microsoft.synapse/workspaces": "Synapse workspaces",
  "microsoft.databricks/workspaces": "Databricks workspaces",
  "microsoft.kusto/clusters": "Data Explorer clusters",
};

/** A type in words: "Virtual machines", or "natgateways (network)" for one this table doesn't name. */
export function typeLabel(type: string): string {
  if (type === NO_TYPE || type === TINY) return type;
  if (NAMES[type]) return NAMES[type];
  const [ns, ...types] = type.split("/");
  return `${types.join(" / ")} (${ns.replace(/^microsoft\./, "")})`;
}

/** The type view from the resource view: [type, resource id] rows, summed where resources share a key. */
export function typeView(resource: ViewData, n: number): ViewData {
  const rows = new Map<string, number[]>();
  for (const r of resource.rows) {
    const [, rid] = r.k;
    // the resource view's "(under a cent each)" rows are per resource group: one per type is enough here
    const key: [string, string] = rid === TINY ? [TINY, TINY] : rid.startsWith("/") ? [typeOf(rid), rid] : [NO_TYPE, rid];
    const acc = accumulate(rows, key, n);
    r.d.forEach((v, i) => (acc[i] += v));
  }
  const packed: PackedRow[] = [...rows].map(([k, d]) => ({ k: k.split("\u0000") as [string, string], d }));
  return { dims: ["ResourceType", "ResourceId"], names: {}, rows: packed };
}

/** The run's data with the type view added, once the resource view is there. */
export function withTypeView(data: CostData): CostData {
  if (!data.views.resource || data.views.type) return data;
  return { ...data, views: { ...data.views, type: typeView(data.views.resource, data.days.length) } };
}
