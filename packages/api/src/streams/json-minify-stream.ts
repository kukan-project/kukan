import { Transform, type TransformCallback } from 'stream'

/** Strips insignificant whitespace from a JSON byte stream without buffering. */
export class JsonMinifyStream extends Transform {
  private inString = false
  private escape = false

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    // All JSON structural characters (" \ space tab CR LF) are single-byte ASCII,
    // so byte-level processing is safe even with multi-byte UTF-8 sequences.
    let writeStart = 0
    let writeLen = 0

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]

      if (this.inString) {
        writeLen++
        if (this.escape) {
          this.escape = false
        } else if (b === 0x5c /* \ */) {
          this.escape = true
        } else if (b === 0x22 /* " */) {
          this.inString = false
        }
      } else {
        // Outside string — skip insignificant whitespace
        if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) {
          if (writeLen > 0) {
            this.push(chunk.subarray(writeStart, writeStart + writeLen))
          }
          writeStart = i + 1
          writeLen = 0
          continue
        }
        writeLen++
        if (b === 0x22 /* " */) {
          this.inString = true
        }
      }
    }

    if (writeLen > 0) {
      this.push(chunk.subarray(writeStart, writeStart + writeLen))
    }
    callback()
  }
}
