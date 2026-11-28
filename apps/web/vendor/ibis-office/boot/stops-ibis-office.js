/* global WebAssembly */
/**
 * Whether an error the frame did not catch means ibisOffice has stopped, so the
 * parent should point to the extracted text instead of a blank frame.
 *
 * Before it has drawn, any error does. Out of memory under the ceiling, or a
 * panic, traps (a RuntimeError) whenever it happens. A string evaluated as
 * script (an EvalError) does too: this frame's CSP allows none, so ibisOffice
 * has taken a path it cannot finish here — it does so for a workbook it cannot
 * open (an Excel 5.0/95 one), after it has drawn. Anything else once it has
 * drawn is not the end of it: copying rejects here, as the frame may not use
 * the clipboard. A ResizeObserver loop's report carries no error at all.
 */
export function stopsIbisOffice(err, drawn) {
  if (err == null) return false
  return !drawn || err instanceof WebAssembly.RuntimeError || err instanceof EvalError
}
