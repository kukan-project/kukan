'use client'

import { MapContainer, TileLayer, GeoJSON, LayersControl } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix Leaflet default marker icon paths (broken by webpack/Next.js bundling)
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

interface GeoJsonMapProps {
  data: GeoJSON.GeoJsonObject
}

/** Default center: Japan */
const DEFAULT_CENTER: L.LatLngExpression = [36.0, 138.0]
const DEFAULT_ZOOM = 5

function onEachFeature(feature: GeoJSON.Feature, layer: L.Layer) {
  const props = feature.properties
  if (!props || Object.keys(props).length === 0) return

  const rows = Object.entries(props)
    .filter(([, v]) => v != null && v !== '')
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 8px 2px 0;font-weight:600">${k}</td><td style="padding:2px 0">${v}</td></tr>`
    )
    .join('')

  if (rows) {
    layer.bindPopup(`<table style="font-size:12px">${rows}</table>`, { maxWidth: 400 })
  }
}

export default function GeoJsonMap({ data }: GeoJsonMapProps) {
  const geoJsonLayer = L.geoJSON(data)
  const bounds = geoJsonLayer.getBounds()
  const isValid = bounds.isValid()

  return (
    <div className="overflow-hidden rounded-lg border" style={{ height: 500 }}>
      <MapContainer
        bounds={isValid ? bounds : undefined}
        center={isValid ? undefined : DEFAULT_CENTER}
        zoom={isValid ? undefined : DEFAULT_ZOOM}
        style={{ height: '100%', width: '100%' }}
      >
        <LayersControl position="topright">
          <LayersControl.BaseLayer checked name="OpenStreetMap">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          </LayersControl.BaseLayer>
          <LayersControl.BaseLayer name="国土地理院">
            <TileLayer
              attribution='&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>'
              url="https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"
            />
          </LayersControl.BaseLayer>
        </LayersControl>
        <GeoJSON data={data} onEachFeature={onEachFeature} />
      </MapContainer>
    </div>
  )
}
