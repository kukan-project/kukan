//! An Ichitaro document laid out a sheet at a time, for KUKAN's preview. Only
//! reading is exported, so EZPZ File JTD's editor is not in the build.

use ezpzjtd_core::doc::{Block, Sheet};
use ezpzjtd_core::layout::{self, PageSetup};
use wasm_bindgen::prelude::*;

/// The most pages a sheet is drawn on. Public documents come to under 40, and
/// plain text past about 1,000 outgrows the module's memory anyway.
const MAX_PAGES: usize = 1000;
/// The most JSON a sheet may come to, which leaves the module's memory ceiling
/// for the worker's and the page's heaps. Public documents take under 2.1 MB.
const MAX_JSON_BYTES: usize = 32 << 20;

/// The pages of `blocks` as JSON, or none where they run past a limit: the
/// first pages alone would pass for the whole sheet.
fn pages_json(
    blocks: &[Block],
    setup: &PageSetup,
    max_pages: usize,
    max_json_bytes: usize,
) -> Option<String> {
    let laid = layout::layout_with(blocks, setup, false, None, max_pages);
    if laid.truncated {
        return None;
    }
    let json = serde_json::to_string(&laid.pages).unwrap_or_else(|_| "[]".into());
    (json.len() <= max_json_bytes).then_some(json)
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
            setup: doc.page.unwrap_or_default(),
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
    /// the text and lines to draw on it. Empty past the last sheet; an error
    /// where the sheet is too long to draw.
    #[wasm_bindgen(js_name = sheetPages)]
    pub fn sheet_pages(&self, index: usize) -> Result<String, JsError> {
        let Some(sheet) = self.sheets.get(index) else {
            return Ok("[]".into());
        };
        pages_json(&sheet.blocks, &self.setup, MAX_PAGES, MAX_JSON_BYTES)
            .ok_or_else(|| JsError::new("The sheet is too long to draw"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ezpzjtd_core::blank::new_document;
    use ezpzjtd_core::edit::Editor;

    fn long_sheet() -> Vec<Block> {
        let mut editor = Editor::new(new_document());
        editor.insert_text(&"あ".repeat(10_000));
        editor.doc.sheets.swap_remove(0).blocks
    }

    #[test]
    fn a_sheet_past_the_page_limit_gives_no_pages() {
        let setup = PageSetup::default();
        assert_eq!(pages_json(&long_sheet(), &setup, 1, MAX_JSON_BYTES), None);
    }

    #[test]
    fn a_sheet_past_the_json_limit_gives_no_pages() {
        let setup = PageSetup::default();
        assert_eq!(pages_json(&long_sheet(), &setup, MAX_PAGES, 1), None);
    }

    #[test]
    fn a_small_paper_with_the_default_margins_is_laid_out() {
        let small = PageSetup {
            height_mm: 50.0,
            ..PageSetup::default()
        };
        assert!(small.pitch() < 0.0);
        assert!(pages_json(&long_sheet(), &small, MAX_PAGES, MAX_JSON_BYTES).is_some());
    }
}
