/**
 * Victoria's nine fire weather districts and the spellings each source uses for them. Matching is
 * by whole normalised name only, so "NORTH CENTRAL" can never match "Central".
 */
import type { DistrictKey } from "./types.js";

export interface District {
  key: DistrictKey;
  /** Title case, as VicEmergency and CFA print it. */
  name: string;
  /** BoM area code in IDV18555 / IDV18560. */
  aac: string;
}

export const DISTRICTS: readonly District[] = [
  { key: "mallee", name: "Mallee", aac: "VIC_FW001" },
  { key: "wimmera", name: "Wimmera", aac: "VIC_FW002" },
  { key: "northern_country", name: "Northern Country", aac: "VIC_FW003" },
  { key: "north_east", name: "North East", aac: "VIC_FW004" },
  { key: "east_gippsland", name: "East Gippsland", aac: "VIC_FW005" },
  { key: "west_and_south_gippsland", name: "West and South Gippsland", aac: "VIC_FW006" },
  { key: "central", name: "Central", aac: "VIC_FW007" },
  { key: "north_central", name: "North Central", aac: "VIC_FW008" },
  { key: "south_west", name: "South West", aac: "VIC_FW009" },
];

/** "North Central" / "NORTH CENTRAL" / "north_central" / "north-central" → "north_central". */
export function normKey(s: string): string {
  return s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "");
}

const BY_KEY = new Map(DISTRICTS.map((d) => [d.key, d]));
const BY_NORM = new Map(DISTRICTS.map((d) => [normKey(d.name), d]));
const BY_AAC = new Map(DISTRICTS.map((d) => [d.aac, d]));

/** Any source's spelling of a district, or its BoM AAC, to the key; unknown → null. */
export function districtKey(s: unknown): DistrictKey | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim();
  return BY_AAC.get(t.toUpperCase())?.key ?? BY_NORM.get(normKey(t))?.key ?? null;
}

export function districtName(key: DistrictKey): string {
  return BY_KEY.get(key)!.name;
}

export function districtAac(key: DistrictKey): string {
  return BY_KEY.get(key)!.aac;
}
