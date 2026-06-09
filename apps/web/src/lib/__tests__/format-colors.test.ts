import { describe, it, expect } from 'vitest'
import { getFormatColorClass } from '../format-colors'

describe('getFormatColorClass', () => {
  it('should return default gray for null/undefined/empty', () => {
    const defaultClass = 'bg-gray-500 text-white'
    expect(getFormatColorClass(null)).toBe(defaultClass)
    expect(getFormatColorClass(undefined)).toBe(defaultClass)
    expect(getFormatColorClass('')).toBe(defaultClass)
  })

  it('should return correct color for tabular data formats', () => {
    expect(getFormatColorClass('csv')).toBe('bg-green-600 text-white')
    expect(getFormatColorClass('tsv')).toBe('bg-green-600 text-white')
  })

  it('should return correct color for structured data formats', () => {
    expect(getFormatColorClass('json')).toBe('bg-violet-600 text-white')
    expect(getFormatColorClass('geojson')).toBe('bg-indigo-600 text-white')
    expect(getFormatColorClass('xml')).toBe('bg-teal-600 text-white')
    expect(getFormatColorClass('rdf')).toBe('bg-cyan-700 text-white')
  })

  it('should return correct color for text and markup formats', () => {
    expect(getFormatColorClass('txt')).toBe('bg-slate-500 text-white')
    expect(getFormatColorClass('md')).toBe('bg-slate-500 text-white')
    expect(getFormatColorClass('html')).toBe('bg-orange-500 text-white')
    expect(getFormatColorClass('htm')).toBe('bg-orange-500 text-white')
  })

  it('should return correct color for Office formats', () => {
    expect(getFormatColorClass('xlsx')).toBe('bg-emerald-700 text-white')
    expect(getFormatColorClass('xls')).toBe('bg-emerald-700 text-white')
    expect(getFormatColorClass('ods')).toBe('bg-emerald-700 text-white')
    expect(getFormatColorClass('doc')).toBe('bg-blue-600 text-white')
    expect(getFormatColorClass('docx')).toBe('bg-blue-600 text-white')
    expect(getFormatColorClass('odt')).toBe('bg-blue-600 text-white')
    expect(getFormatColorClass('rtf')).toBe('bg-blue-600 text-white')
    expect(getFormatColorClass('ppt')).toBe('bg-rose-600 text-white')
    expect(getFormatColorClass('pptx')).toBe('bg-rose-600 text-white')
    expect(getFormatColorClass('odp')).toBe('bg-rose-600 text-white')
  })

  it('should return correct color for PDF', () => {
    expect(getFormatColorClass('pdf')).toBe('bg-red-600 text-white')
  })

  it('should return correct color for image formats', () => {
    const imageColor = 'bg-fuchsia-600 text-white'
    expect(getFormatColorClass('png')).toBe(imageColor)
    expect(getFormatColorClass('jpeg')).toBe(imageColor)
    expect(getFormatColorClass('jpg')).toBe(imageColor)
    expect(getFormatColorClass('gif')).toBe(imageColor)
    expect(getFormatColorClass('webp')).toBe(imageColor)
    expect(getFormatColorClass('svg')).toBe(imageColor)
    expect(getFormatColorClass('bmp')).toBe(imageColor)
    expect(getFormatColorClass('tif')).toBe(imageColor)
    expect(getFormatColorClass('tiff')).toBe(imageColor)
  })

  it('should return correct color for archive formats', () => {
    expect(getFormatColorClass('zip')).toBe('bg-gray-600 text-white')
  })

  it('should be case-insensitive', () => {
    expect(getFormatColorClass('CSV')).toBe('bg-green-600 text-white')
    expect(getFormatColorClass('Pdf')).toBe('bg-red-600 text-white')
    expect(getFormatColorClass('JSON')).toBe('bg-violet-600 text-white')
    expect(getFormatColorClass('JPEG')).toBe('bg-fuchsia-600 text-white')
  })

  it('should return default gray for unknown formats', () => {
    expect(getFormatColorClass('unknown')).toBe('bg-gray-500 text-white')
    expect(getFormatColorClass('mp4')).toBe('bg-gray-500 text-white')
  })
})
