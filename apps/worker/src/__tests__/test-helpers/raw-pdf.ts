/**
 * A PDF of `objects` as written, numbered from 1 with the catalog first, then
 * the cross-reference table and the trailer: for a test of what a reader makes
 * of a file, where a writer would add what it was not asked to.
 */
export function rawPdf(objects: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')]
  const offsets: number[] = []
  let at = parts[0].length
  objects.forEach((body, i) => {
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      Buffer.isBuffer(body) ? body : Buffer.from(body),
      Buffer.from('\nendobj\n'),
    ])
    offsets.push(at)
    parts.push(part)
    at += part.length
  })
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
  ].join('')
  return Buffer.concat([...parts, Buffer.from(xref)])
}
