// Runs inside the ZetaOffice worker. Opens each file read-only in the visible
// frame, closing the previous one, and reports page/sheet/slide counts.
import { ZetaHelperThread } from '/node_modules/zetajs/source/zetaHelper.js'

const zHT = new ZetaHelperThread()
const { zetajs, css, desktop } = zHT

let xModel

function hideChrome(ctrl) {
  try {
    ctrl.getFrame().getContainerWindow().FullScreen = true
    ctrl.getFrame().LayoutManager.hideElement('private:resource/menubar/menubar')
    zHT.dispatch(ctrl, 'Sidebar')
  } catch {}
}

function counts(model) {
  const out = {}
  try {
    if (model.queryInterface(zetajs.type.interface(css.sheet.XSpreadsheetDocument))) {
      out.sheets = model.getSheets().getCount()
    } else if (model.queryInterface(zetajs.type.interface(css.drawing.XDrawPagesSupplier))) {
      out.slides = model.getDrawPages().getCount()
    } else if (model.queryInterface(zetajs.type.interface(css.text.XTextDocument))) {
      const cursor = model.getCurrentController().getViewCursor()
      cursor.jumpToLastPage()
      out.pages = cursor.getPage()
    }
  } catch (e) {
    out.countError = String(e?.Message ?? e)
  }
  return out
}

zHT.thrPort.onmessage = (e) => {
  const { cmd, id, path } = e.data
  if (cmd !== 'open') return
  try {
    if (xModel && xModel.queryInterface(zetajs.type.interface(css.util.XCloseable))) {
      try {
        xModel.close(true)
      } catch {}
    }
    const readOnly = new css.beans.PropertyValue({ Name: 'ReadOnly', Value: true })
    const noMacros = new css.beans.PropertyValue({
      Name: 'MacroExecutionMode',
      Value: css.document.MacroExecMode.NEVER_EXECUTE,
    })
    xModel = desktop.loadComponentFromURL('file://' + path, '_default', 0, [readOnly, noMacros])
    if (!xModel) throw new Error('loadComponentFromURL returned null')
    hideChrome(xModel.getCurrentController())
    zHT.thrPort.postMessage({ cmd: 'opened', id, ...counts(xModel) })
  } catch (err) {
    let message
    try {
      const exc = zetajs.catchUnoException(err)
      message = `${zetajs.getAnyType(exc)}: ${zetajs.fromAny(exc).Message}`
    } catch {
      message = err instanceof Error ? err.message : String(err)
    }
    zHT.thrPort.postMessage({ cmd: 'failed', id, error: message })
  }
}

zHT.thrPort.postMessage({ cmd: 'started' })
