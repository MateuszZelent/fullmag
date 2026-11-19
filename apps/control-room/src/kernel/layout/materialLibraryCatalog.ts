import type { MaterialLibraryEntryResource, PublishedMaterialVersion } from "@/kernel/api/apiTypes";

export type MaterialCatalogFilter = "all" | "builtin" | "custom" | "modified" | "published";
export const MATERIAL_CATALOG_FILTERS = [
  { value: "all", label: "All" }, { value: "builtin", label: "Built-in" },
  { value: "custom", label: "Custom" }, { value: "modified", label: "Modified" },
  { value: "published", label: "Published" },
] as const;
export const MATERIAL_KIND_LABELS = { builtin: "Built-in", custom: "Custom", modified: "Modified" } as const;
export const MATERIAL_VERSION_KEY_PATTERN = "[a-z][a-z0-9_]{0,47}";
const materialVersionKey = new RegExp(`^${MATERIAL_VERSION_KEY_PATTERN}$`);

export function builtinMaterialFamily(id: string): string | null {
  if (!id.startsWith("builtin:")) return null;
  const family = id.slice("builtin:".length);
  return materialVersionKey.test(family) ? family : null;
}

export function publishedMaterialKey(material: PublishedMaterialVersion): string {
  const key = material.source.version;
  return key ? `${key.family}.${key.version}` : material.source.catalog_id;
}

type CatalogRow = { id: string; entry: MaterialLibraryEntryResource } | { id: string; published: PublishedMaterialVersion };
interface CatalogGroup {
  family: string | null;
  title: string;
  rows: CatalogRow[];
}

export function materialCatalogView(
  entries: readonly MaterialLibraryEntryResource[],
  versions: readonly PublishedMaterialVersion[],
  filter: MaterialCatalogFilter,
  query: string,
  showArchived: boolean,
) {
  const originals = new Map<string, MaterialLibraryEntryResource>();
  for (const entry of entries) {
    const family = entry.kind === "builtin" ? builtinMaterialFamily(entry.id) : null;
    if (family) originals.set(family, entry);
  }

  const search = query.trim().toLocaleLowerCase();
  const matches = (...terms: (string | null | undefined)[]) =>
    !search || terms.some((term) => term?.toLocaleLowerCase().includes(search));
  const versionGroups = new Map<string, CatalogGroup>();
  const visibleVersions = versions.filter((published) => showArchived || !published.archived);
  if (filter === "all" || filter === "published") {
    for (const published of visibleVersions) {
      const family = published.source.version?.family;
      if (!family) continue;
      const title = originals.get(family)?.name ?? family;
      if (!matches(published.display_name, published.source.name, publishedMaterialKey(published), title,
        published.source.version?.source_project, published.source.version?.copied_from_family)) continue;
      const group = versionGroups.get(family) ?? { family, title, rows: [] };
      group.rows.push({ id: published.source.catalog_id, published });
      versionGroups.set(family, group);
    }
  }

  const groups: CatalogGroup[] = [];
  for (const entry of entries) {
    const family = entry.kind === "builtin" ? builtinMaterialFamily(entry.id) : null;
    const group = family ? versionGroups.get(family) : undefined;
    const original = { id: entry.id, entry };
    if ((filter === "all" || entry.kind === filter) &&
      (matches(entry.name, entry.summary, entry.id) || (filter === "all" && group))) {
      if (group) group.rows.unshift(original);
      else groups.push({ family: null, title: entry.name, rows: [original] });
    }
    if (group && family) {
      groups.push(group);
      versionGroups.delete(family);
    }
  }
  groups.push(...versionGroups.values());
  return {
    groups,
    visibleVersions,
    families: [...new Set([
      ...originals.keys(),
      ...versions.flatMap(({ source }) => source.version ? [source.version.family] : []),
    ])].sort(),
  };
}
