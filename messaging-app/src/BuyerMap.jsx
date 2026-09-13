// BuyerMap.jsx — where the book has bought. One circle per city, sized by how
// many investors financed a property there; the deal being matched sits on
// top as an amber pin. Clicking a city filters the table to it.

import React from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { REGIONS, cityLabel } from "@shared/dispo-regions.js";

export default function BuyerMap({ points = [], deal = null, selectedCity = "", onPickCity, height = 380 }) {
  const max = Math.max(1, ...points.map((p) => p.investors));
  const center = deal?.lat ? [deal.lat, deal.lng] : [47.45, -122.25];
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200">
      <MapContainer key={deal?.lat ? `${deal.lat},${deal.lng}` : "book"} center={center} zoom={deal?.lat ? 10 : 9}
        scrollWheelZoom={false} style={{ height, width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {points.map((p) => {
          const on = selectedCity === p.city;
          return (
            <CircleMarker key={p.city} center={[p.lat, p.lng]}
              radius={5 + Math.sqrt(p.investors / max) * 22}
              eventHandlers={{ click: () => onPickCity?.(on ? "" : p.city) }}
              pathOptions={{ color: on ? "#1e3a8a" : "#1d4ed8", weight: on ? 3 : 1.5, fillColor: "#3b82f6", fillOpacity: on ? 0.7 : 0.35 }}>
              <Tooltip direction="top">
                <b>{cityLabel(p.city)}</b> · {REGIONS[p.region]?.label || ""}<br />
                {p.investors} investor{p.investors === 1 ? "" : "s"} · {p.purchases} propert{p.purchases === 1 ? "y" : "ies"} financed
              </Tooltip>
            </CircleMarker>
          );
        })}
        {deal?.lat && (
          <CircleMarker center={[deal.lat, deal.lng]} radius={9}
            pathOptions={{ color: "#b45309", fillColor: "#f59e0b", fillOpacity: 0.95, weight: 2 }}>
            <Tooltip permanent direction="top" offset={[0, -8]}>{deal.address?.split(",")[0] || "Deal"}</Tooltip>
          </CircleMarker>
        )}
      </MapContainer>
    </div>
  );
}
