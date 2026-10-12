export type TableSort<Id extends string> = {column: Id; descending: boolean} | null;

/** Headers cycle through default; menus have an explicit default row. */
export function nextTableSort<Id extends string>(sort: TableSort<Id>, column: Id, cycle = true): TableSort<Id> {
  if (sort?.column !== column) return {column, descending: false};
  return sort.descending && cycle ? null : {column, descending: !sort.descending};
}
