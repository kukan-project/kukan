//! An Ichitaro document laid out a sheet at a time, for KUKAN's preview. Only
//! reading is exported, so EZPZ File JTD's editor is not in the build.

use ezpzjtd_core::doc::Sheet;
use ezpzjtd_core::layout::{self, PageSetup};
use wasm_bindgen::prelude::*;

/// The narrowest line pitch, in points, a page is laid out on. EZPZ falls back
/// to its default margins where a file's do not fit its paper, but on a small
/// paper those can outgrow it too: the text area's height goes negative, and
/// laying out never ends — a line adds the pitch until it is tall enough.
const MIN_PITCH_PT: f32 = 1.0;

/// Whether laying out on `setup` ends: its pitch and cell are of a size.
fn usable(setup: &PageSetup) -> bool {
    setup.pitch() >= MIN_PITCH_PT && setup.cell() > 0.0
}

#[wasm_bindgen]
pub struct JtdViewer {
    /// The document's page setup (文書スタイル), which every sheet is laid out on.
    setup: PageSetup,
    sheets: Vec<Sheet>,
}

#[wasm_bindgen]
impl JtdViewer {
    #[wasm_bindgen(constructor)]
    /// Takes the bytes by value: wasm-bindgen copies them into the module once,
    /// which a slice would copy again.
    pub fn new(bytes: Vec<u8>) -> Result<JtdViewer, JsError> {
        let doc = ezpzjtd_core::open(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(JtdViewer {
            setup: doc.page.clone().filter(usable).unwrap_or_default(),
            sheets: doc.sheets,
        })
    }

    #[wasm_bindgen(js_name = sheetCount)]
    pub fn sheet_count(&self) -> usize {
        self.sheets.len()
    }

    /// The sheet's name, or empty where the file gives none: EZPZ names such a
    /// sheet `Sheet n`, which is not the file's.
    #[wasm_bindgen(js_name = sheetName)]
    pub fn sheet_name(&self, index: usize) -> String {
        match self.sheets.get(index) {
            Some(s) if s.name != format!("Sheet {}", index + 1) => s.name.clone(),
            _ => String::new(),
        }
    }

    /// The sheet laid out on Ichitaro's character grid, as EZPZ File JTD's
    /// editor lays it out: a JSON array of pages, each its size in points and
    /// the text and lines to draw on it. Empty past the last sheet.
    #[wasm_bindgen(js_name = sheetPages)]
    pub fn sheet_pages(&self, index: usize) -> String {
        let Some(sheet) = self.sheets.get(index) else {
            return "[]".into();
        };
        let laid = layout::layout(&sheet.blocks, &self.setup, false, None);
        serde_json::to_string(&laid.pages).unwrap_or_else(|_| "[]".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_paper_with_the_default_margins_is_not_laid_out_on() {
        let small = PageSetup {
            height_mm: 50.0,
            ..PageSetup::default()
        };
        assert!(small.pitch() < 0.0);
        assert!(!usable(&small));
        assert!(usable(&PageSetup::default()));
    }
}
