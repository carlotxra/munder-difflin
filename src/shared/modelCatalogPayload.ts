/** One row of the catalog. `minAppVersion` / `maxAppVersion` are INCLUSIVE app
 *  version bounds; null (or an absent key) means unbounded in that direction.
 *  See the long note on the filter in src/renderer/src/store/config.ts. */
export interface CatalogModel {
  /** absent = use the CLI default (no --model flag) */
  id?: string;
  label: string;
  minAppVersion?: string | null;
  maxAppVersion?: string | null;
}

export interface ModelCatalog {
  version: number;
  providers: Record<string, CatalogModel[]>;
}
