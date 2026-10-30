export type CatalogId = "orders" | "regions";

export type OrderRow = {
  region: string;
  product: string;
  units: number;
  revenue: number;
  customer: string;
};

export type RegionRow = {
  region: string;
  offices: number;
};

export type ColumnKind = "int" | "text";

export type Column = { name: string; kind: ColumnKind };

/** Synthetic shop totals. Names are placeholders, not people. */
export const ORDER_ROWS: OrderRow[] = [
  { region: "east", product: "cedar-oil", units: 12, revenue: 240, customer: "acme" },
  { region: "east", product: "linen", units: 4, revenue: 80, customer: "northwind" },
  { region: "west", product: "cedar-oil", units: 7, revenue: 140, customer: "contoso" },
  { region: "west", product: "slate", units: 3, revenue: 90, customer: "adventure" },
  { region: "north", product: "linen", units: 9, revenue: 180, customer: "wideworld" },
  { region: "north", product: "cedar-oil", units: 2, revenue: 40, customer: "fabrikam" },
  { region: "south", product: "slate", units: 6, revenue: 150, customer: "litware" },
  { region: "south", product: "linen", units: 5, revenue: 100, customer: "tailspin" },
  { region: "restricted", product: "slate", units: 20, revenue: 800, customer: "internal-lab" },
  { region: "restricted", product: "cedar-oil", units: 15, revenue: 600, customer: "internal-lab" },
];

export const REGION_ROWS: RegionRow[] = [
  { region: "east", offices: 2 },
  { region: "west", offices: 1 },
  { region: "north", offices: 1 },
  { region: "south", offices: 3 },
];

export const ORDER_COLUMNS: Column[] = [
  { name: "region", kind: "text" },
  { name: "product", kind: "text" },
  { name: "units", kind: "int" },
  { name: "revenue", kind: "int" },
  { name: "customer", kind: "text" },
];

export const REGION_COLUMNS: Column[] = [
  { name: "region", kind: "text" },
  { name: "offices", kind: "int" },
];

export const CATALOGS: CatalogId[] = ["orders", "regions"];

export function columnsFor(catalog: CatalogId): Column[] {
  return catalog === "orders" ? ORDER_COLUMNS : REGION_COLUMNS;
}

export function bucketName(configured: string | undefined): string {
  return configured && configured.trim() ? configured.trim() : "tech-demos-lake-catalog";
}

export function dataPath(bucket: string, catalog: CatalogId): string {
  return `r2://${bucket}/catalogs/${catalog}/`;
}

export function parquetKey(catalog: CatalogId): string {
  return `catalogs/${catalog}/${catalog}.parquet`;
}
