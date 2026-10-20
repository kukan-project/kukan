import { describe, it, expect, vi } from 'vitest'

const mergeOptions = vi.fn()

vi.mock('leaflet', () => ({
  default: { Icon: { Default: { prototype: {}, mergeOptions } } },
}))
vi.mock('leaflet/dist/leaflet.css', () => ({}))
// What Next's static image import hands back: a path on our own origin
for (const name of ['marker-icon-2x', 'marker-icon', 'marker-shadow']) {
  vi.doMock(`leaflet/dist/images/${name}.png`, () => ({
    default: { src: `/_next/static/media/${name}.png`, width: 1, height: 1 },
  }))
}

describe('geojson-map marker images', () => {
  it('points the default marker at bundled images, not a CDN', async () => {
    await import('../geojson-map')
    expect(mergeOptions).toHaveBeenCalledOnce()
    const options = mergeOptions.mock.calls[0][0] as Record<string, string>
    expect(options).toEqual({
      iconRetinaUrl: '/_next/static/media/marker-icon-2x.png',
      iconUrl: '/_next/static/media/marker-icon.png',
      shadowUrl: '/_next/static/media/marker-shadow.png',
    })
  })
})
