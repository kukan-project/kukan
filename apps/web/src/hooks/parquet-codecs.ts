/**
 * The one codec hyparquet cannot decode on its own (#242).
 *
 * Preview Parquet is written by DuckDB (ADR-046) and ZSTD is what it uses;
 * hyparquet handles UNCOMPRESSED and SNAPPY built in, and nothing else here
 * writes the other four codecs Parquet allows.
 *
 * Taken straight from `fzstd` rather than through `hyparquet-compressors`,
 * which is the obvious import and the wrong one. That barrel is 73 KB gzipped
 * against fzstd's 3.8 KB — two thirds of it a brotli dictionary that cannot be
 * tree-shaken, for codecs this project never produces. It also *replaces*
 * SNAPPY rather than adding to it (`hyparquet/src/datapage.js` gives a supplied
 * codec precedence over its own), routing every existing preview through a WASM
 * decoder it compiles synchronously at import — under Chrome's 4 KB sync limit
 * with 638 bytes to spare, and blocked outright by a CSP without
 * `wasm-unsafe-eval`. Leaving SNAPPY out keeps all of that away from the files
 * that are already out there.
 */
import { decompress } from 'fzstd'

export const compressors = {
  /**
   * hyparquet passes the uncompressed page size as a second argument; fzstd's
   * second parameter is an output *buffer*, not a length, so it is dropped
   * rather than forwarded.
   *
   * Handing fzstd a `new Uint8Array(size)` built from that number is the
   * obvious next thought and it is slower — measured 1.7x over 40 page reads,
   * because zeroing a page-sized buffer up front costs more than the growth
   * fzstd does across the blocks inside the frame.
   *
   * One-shot rather than fzstd's streaming `Decompress`: the page is already
   * whole in memory by the time this is called, having arrived as a range read.
   */
  ZSTD: (input: Uint8Array) => decompress(input),
}
