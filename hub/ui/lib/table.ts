/** Column budgets include cell padding; the panel's outer edges replace two 10px insets. */
export function tableLayout(columns: readonly number[], width: number, name: number, edges = 24): 'table' | 'list' {
  return columns.reduce((sum, column) => sum + column, name + edges) <= width ? 'table' : 'list';
}
