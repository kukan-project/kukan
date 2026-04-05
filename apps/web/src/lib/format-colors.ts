const FORMAT_COLORS: Record<string, string> = {
  csv: 'bg-green-600 text-white',
  xls: 'bg-blue-700 text-white',
  xlsx: 'bg-blue-700 text-white',
  pdf: 'bg-red-600 text-white',
  json: 'bg-purple-600 text-white',
  geojson: 'bg-indigo-600 text-white',
  html: 'bg-orange-500 text-white',
  zip: 'bg-gray-600 text-white',
  doc: 'bg-blue-500 text-white',
  docx: 'bg-blue-500 text-white',
  ppt: 'bg-orange-600 text-white',
  pptx: 'bg-orange-600 text-white',
  xml: 'bg-teal-600 text-white',
  rdf: 'bg-cyan-600 text-white',
  txt: 'bg-gray-500 text-white',
}

export function getFormatColorClass(format: string | null | undefined): string {
  if (!format) return 'bg-gray-500 text-white'
  return FORMAT_COLORS[format.toLowerCase()] ?? 'bg-gray-500 text-white'
}
