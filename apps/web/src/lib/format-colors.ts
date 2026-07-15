// Data-type identity colors, intentionally raw palette values rather than
// theme tokens: they distinguish formats and don't follow brand overrides.
const FORMAT_COLORS: Record<string, string> = {
  // Tabular data — green
  csv: 'bg-green-600 text-white',
  tsv: 'bg-green-600 text-white',

  // Structured data
  json: 'bg-violet-600 text-white',
  geojson: 'bg-indigo-600 text-white',
  xml: 'bg-teal-600 text-white',
  rdf: 'bg-cyan-700 text-white',

  // Plain text — slate
  txt: 'bg-slate-500 text-white',
  md: 'bg-slate-500 text-white',

  // Web markup — orange
  html: 'bg-orange-500 text-white',
  htm: 'bg-orange-500 text-white',

  // Excel / Spreadsheet — emerald
  xlsx: 'bg-emerald-700 text-white',
  xls: 'bg-emerald-700 text-white',
  ods: 'bg-emerald-700 text-white',

  // Word / Document — blue
  doc: 'bg-blue-600 text-white',
  docx: 'bg-blue-600 text-white',
  odt: 'bg-blue-600 text-white',
  rtf: 'bg-blue-600 text-white',

  // PowerPoint / Presentation — rose
  ppt: 'bg-rose-600 text-white',
  pptx: 'bg-rose-600 text-white',
  odp: 'bg-rose-600 text-white',

  // PDF — red
  pdf: 'bg-red-600 text-white',

  // Images — fuchsia
  png: 'bg-fuchsia-600 text-white',
  jpeg: 'bg-fuchsia-600 text-white',
  jpg: 'bg-fuchsia-600 text-white',
  gif: 'bg-fuchsia-600 text-white',
  webp: 'bg-fuchsia-600 text-white',
  svg: 'bg-fuchsia-600 text-white',
  bmp: 'bg-fuchsia-600 text-white',
  tif: 'bg-fuchsia-600 text-white',
  tiff: 'bg-fuchsia-600 text-white',

  // Archive — gray
  zip: 'bg-gray-600 text-white',
}

export function getFormatColorClass(format: string | null | undefined): string {
  if (!format) return 'bg-gray-500 text-white'
  return FORMAT_COLORS[format.toLowerCase()] ?? 'bg-gray-500 text-white'
}
