// counties.js — parcel GIS config, seeded with King County. Adding Snohomish /
// Kitsap / etc. is a config addition here, NOT a code change (§3). Each entry:
//   parcelQueryUrl — an ArcGIS FeatureServer/MapServer layer that supports
//                    point-intersect queries returning parcel polygons.
//   fieldMap       — candidate attribute names for apn / lot_sqft (first hit wins).
//
// The King County endpoint can be overridden with MAPBOX_PARCEL_KINGCOUNTY_URL
// so it's tunable without a redeploy if the county changes their service.

export const COUNTIES = {
  "king-wa": {
    id: "king-wa",
    name: "King County, WA",
    parcelQueryUrl:
      process.env.MAPBOX_PARCEL_KINGCOUNTY_URL ||
      "https://gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_Parcels/MapServer/0",
    fieldMap: {
      apn: ["PIN", "PARCEL_ID", "MAJOR", "ACCT_NBR"],
      lot_sqft: ["SQFT_LOT", "LOTSQFT", "LOT_SQFT", "SHAPE_Area"],
      address: ["ADDR_FULL", "SITUS_ADDRESS", "SITEADDRESS"],
    },
  },
  // Example of how a new county drops in (URL/fields to be filled when needed):
  // "snohomish-wa": { id, name, parcelQueryUrl, fieldMap },
};

export function countyFor(id) {
  return COUNTIES[id] || COUNTIES["king-wa"];
}

// Pick the first present attribute from a candidate list.
export function pick(props, candidates) {
  for (const c of candidates) {
    if (props[c] != null && props[c] !== "") return props[c];
  }
  return "";
}
