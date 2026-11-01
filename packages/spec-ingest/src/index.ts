import { gridsToText, loadGrids } from "./workbook";

export { extractFromWorkbook, extractFromGrids } from "./extract";
export type { ExtractedSpec, ExtractOptions, SheetSummary, ExamplePayload } from "./extract";
export { loadGrids, gridsToText } from "./workbook";
export type { SheetGrid } from "./workbook";
export * as parsers from "./parse";

/** Compact, cell-addressed text rendering of a workbook (for LLM prompts). */
export async function workbookToText(data: Uint8Array | ArrayBuffer): Promise<string> {
  return gridsToText(await loadGrids(data));
}
