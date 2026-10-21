'use client'

import { useRef, useEffect } from 'react'
import type { StaticImageData } from 'next/image'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// Leaflet guesses its marker image paths from the stylesheet, which bundling
// breaks. Served from our own origin rather than a CDN, so a closed network
// still shows the markers and no viewer's address goes to a third party.
// Turbopack hands an image from node_modules over as the bare URL string, not
// the StaticImageData the type declares, so `.src` alone would be undefined.
function assetUrl(image: StaticImageData | string): string {
  return typeof image === 'string' ? image : image.src
}
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: assetUrl(markerIcon2x),
  iconUrl: assetUrl(markerIcon),
  shadowUrl: assetUrl(markerShadow),
})

/** Default center: Japan */
const DEFAULT_CENTER: L.LatLngExpression = [36.0, 138.0]
const DEFAULT_ZOOM = 5

function escapeHtml(str: string): string {
  return str.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  )
}

function displayValue(v: unknown): string {
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

function onEachFeature(feature: GeoJSON.Feature, layer: L.Layer) {
  const props = feature.properties
  if (!props || Object.keys(props).length === 0) return

  const rows = Object.entries(props)
    .filter(([, v]) => v != null && v !== '')
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 8px 2px 0;font-weight:600">${escapeHtml(String(k))}</td><td style="padding:2px 0">${escapeHtml(displayValue(v))}</td></tr>`
    )
    .join('')

  if (rows) {
    layer.bindPopup(`<table style="font-size:12px">${rows}</table>`, { maxWidth: 400 })
  }
}

export default function GeoJsonMap({ data }: { data: GeoJSON.GeoJsonObject }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Clean up previous map instance (data changed)
    if (mapRef.current) {
      mapRef.current.remove()
      mapRef.current = null
    }

    const map = L.map(containerRef.current)
    mapRef.current = map

    // Tile layers
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    })
    const gsi = L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
      attribution:
        '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    })

    osm.addTo(map)
    L.control
      .layers({ OpenStreetMap: osm, 国土地理院: gsi }, undefined, { position: 'topright' })
      .addTo(map)

    // GeoJSON layer
    const geoJsonLayer = L.geoJSON(data, { onEachFeature }).addTo(map)

    // Fit bounds or fall back to default center
    const bounds = geoJsonLayer.getBounds()
    if (bounds.isValid()) {
      map.fitBounds(bounds)
    } else {
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM)
    }

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [data])

  return (
    <div
      ref={containerRef}
      className="relative z-0 overflow-hidden rounded-lg border"
      style={{ height: 500 }}
    />
  )
}
