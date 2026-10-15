/** Column budgets include cell padding; the panel's outer edges replace two 10px insets. */
export function tableLayout(columns: readonly number[], width: number, name: number, edges = 24): 'table' | 'list' {
  return columns.reduce((sum, column) => sum + column, name + edges) <= width ? 'table' : 'list';
}

export type TableSort<Id extends string> = {column: Id; descending: boolean} | null;
export function nextTableSort<Id extends string>(sort: TableSort<Id>, column: Id | null, cycle = true): TableSort<Id> {
  if (column === null) return null;
  if (sort?.column !== column) return {column, descending: false};
  return sort.descending && cycle ? null : {column, descending: !sort.descending};
}
export const visibleTableSort = <Id extends string>(sort: TableSort<Id>, columns: readonly Id[]): TableSort<Id> =>
  sort && columns.includes(sort.column) ? sort : null;

export const TABLE_PAGE_ROWS = 10;
/** Larger pages extend this initial static measurement to their fitting rows. */
export const TABLE_MEASURE_MIN_ROWS = 50;

/** Whole-row pages; measured heights follow identities through sorting and live changes. */
export function tablePages(keys: readonly string[], heights: ReadonlyMap<string, number>, fallback: number, budget: number, border = 0): number[] {
  const starts = [0];
  let used = 0, rows = 0;
  for (let i = 0; i < keys.length; i++) {
    const height = heights.get(keys[i]) ?? fallback;
    if (rows && used + height - border > budget + .5) {
      starts.push(i); used = 0; rows = 0;
    }
    used += height; rows++;
  }
  return starts;
}
