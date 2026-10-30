import { CATALOGS, ORDER_ROWS, REGION_ROWS, dataPath, type CatalogId } from "../shared/rows";

export const PARQUET_NOTE = "pending first nightly build";

export type MapCatalog = {
  id: CatalogId;
  durableObjectId: string;
  dataPath: string;
  rows: number;
  parquetNote: string;
};

export type MapPayload = {
  registryId: string;
  catalogs: MapCatalog[];
};

const ROW_COUNTS: Record<CatalogId, number> = {
  orders: ORDER_ROWS.length,
  regions: REGION_ROWS.length,
};

/** Ids, paths, and row counts are fixed by the sample. This does not wake a Durable Object or touch R2. */
export function catalogMap(opts: {
  registryId: string;
  bucket: string;
  objectId: (id: CatalogId) => string;
}): MapPayload {
  return {
    registryId: opts.registryId,
    catalogs: CATALOGS.map((id) => ({
      id,
      durableObjectId: opts.objectId(id),
      dataPath: dataPath(opts.bucket, id),
      rows: ROW_COUNTS[id],
      parquetNote: PARQUET_NOTE,
    })),
  };
}
