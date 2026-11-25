/**
 * Spreadsheet uploads: Excel files are converted to CSV in the browser so
 * the server only ever parses one format.
 */
export type Cell = string | number | boolean | Date | null | undefined;

function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

export function rowsToCsv(rows: Cell[][]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return rows.map((r) => r.map((c) => esc(cellText(c))).join(",")).join("\n") + "\n";
}

export function isExcel(file: File): boolean {
  return /\.(xlsx|xlsm)$/i.test(file.name) || file.type.includes("spreadsheetml");
}

/** CSV text for a .csv or .xlsx file (first sheet). */
export async function fileToCsv(file: File): Promise<string> {
  if (!isExcel(file)) return file.text();
  const { readSheet } = await import("read-excel-file/browser");
  return rowsToCsv((await readSheet(file)) as Cell[][]);
}
