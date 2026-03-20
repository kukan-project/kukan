/**
 * Worker thread for CPU-intensive CSV → Parquet conversion.
 * Receives a CSV buffer, parses it, and returns a Parquet buffer.
 */

import { parentPort } from 'node:worker_threads'
import { parseBuffer } from '../parsers/csv-parser.js'
import { parquetWriteBuffer } from 'hyparquet-writer'

interface WorkerInput {
  csvBuffer: Buffer
  rowGroupSize: number
}

parentPort?.on('message', (input: WorkerInput) => {
  const buf = Buffer.from(input.csvBuffer)
  const extracted = parseBuffer(buf)

  if (extracted.headers.length === 0) {
    parentPort?.postMessage({ parquetBuffer: null, encoding: extracted.encoding })
    return
  }

  const columnData = extracted.headers.map((header, colIndex) => ({
    name: header || `column_${colIndex}`,
    data: extracted.rows.map((row) => row[colIndex] ?? ''),
    type: 'STRING' as const,
  }))

  const parquetBuf = parquetWriteBuffer({ columnData, rowGroupSize: input.rowGroupSize })
  parentPort?.postMessage({ parquetBuffer: Buffer.from(parquetBuf), encoding: extracted.encoding })
})
