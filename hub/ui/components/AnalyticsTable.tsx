/** @jsxRuntime automatic */
import {Fragment, memo, useLayoutEffect, useState, type ReactNode, type RefObject} from 'react';
import {useClock} from '../lib/clock';
import {tableLayout} from '../lib/table';
import {withColumn, withHidden, type Arrange} from '../lib/view';
import {t} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';
import {SortHeader} from './TableSort';

export type Cell = {content: ReactNode; title?: string; className?: string};
export type TimedCell = {time: string; changesAt: (now: number) => number | null; at: (now: number) => Cell};
export type AnalyticsColumn<Id extends string> = {id: Id; title: string; hint?: string; width: number; align?: 'right'};
export type AnalyticsRow<Id extends string> = {key: string; name: string; hint?: string; color?: string; cells: Record<Id, Cell | TimedCell>};
export type TableSorting<Id extends string>={active:{column:Id|'limit';descending:boolean}|null;cycle:(column:Id|'limit')=>void};

/** Only the cell reads the clock; its table and unrelated rows remain asleep. */
function Timed({cell, render}: {cell: TimedCell; render: (cell: Cell, time: string) => ReactNode}) {
  return render(cell.at(useClock(cell.changesAt)), cell.time);
}
const shown = (key: string, cell: Cell | TimedCell, render: (cell: Cell, time?: string) => ReactNode) =>
  'at' in cell ? <Timed key={key} cell={cell} render={render}/> : <Fragment key={key}>{render(cell)}</Fragment>;

export function TableSettings<Id extends string>({arrange, widget, columns, visible, children}: {
  arrange: Arrange; widget: string; columns: readonly AnalyticsColumn<Id>[]; visible: readonly Id[];
  children?: ReactNode;
}) {
  return arrange.owner || children ? <Popover label={t('forecast.settings')} icon={<SlidersIcon/>}>
    {children}
    {arrange.owner && <>
      <div className="popover-section">
        <div className="popover-title">{t('table.columns')}</div>
        {columns.map(column => <SwitchRow key={column.id} on={visible.includes(column.id)} onChange={on => arrange.update(view => withColumn(view, widget, column.id, on))}>{column.title}</SwitchRow>)}
      </div>
      <HideRow onHide={() => arrange.update(view => withHidden(view, widget, true))}>{t('widget.hide')}</HideRow>
    </>}
  </Popover> : null;
}

/** The rows and toolbar use the same fit decision, including column visibility. */
export function useTableLayout(panel: RefObject<HTMLElement | null>, columns: readonly {width: number}[], nameWidth: number) {
  const [layout, setLayout] = useState<'table' | 'list'>('table');
  const width = nameWidth + columns.reduce((sum, column) => sum + column.width, 0);
  useLayoutEffect(() => {
    const element = panel.current!;
    const fit = () => {
      const style = getComputedStyle(element);
      const edges = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) - 20;
      setLayout(tableLayout(columns.map(column => column.width), element.clientWidth, nameWidth, edges));
    };
    const observer = new ResizeObserver(fit); observer.observe(element); fit();
    return () => observer.disconnect();
  }, [panel, width]);
  return layout;
}

/** Column widths decide when both tables become labelled rows; cells have one renderer. */
function Table<Id extends string>({columns, rows, name, lead, sorting, layout = 'table'}: {
  columns: readonly AnalyticsColumn<Id>[]; rows: AnalyticsRow<Id>[];
  name: string; lead?: Id; sorting?: TableSorting<Id>; layout?: 'table' | 'list';
}) {
  if (layout === 'list') return <ul className="analytics-compact">{rows.map(row => <li key={row.key}>
    <div className="analytics-compact-main">
      {row.color && <span className="swatch" style={{background: row.color}}/>}
      <span className="analytics-compact-name" title={row.hint}>{row.name}</span>
      {columns.filter(column => column.id === lead).map(column => shown(column.id, row.cells[column.id], (cell, time) =>
        <span data-time={time} className={cell.className} title={cell.title}><span className="sr-only">{column.title}: </span>{cell.content}</span>))}
    </div>
    {columns.some(column => column.id !== lead) && <div className="analytics-compact-details">{columns.filter(column => column.id !== lead).map(column => shown(column.id, row.cells[column.id], (cell, time) =>
      <span data-time={time} title={cell.title}>{column.title} <span className={cell.className}>{cell.content}</span></span>))}</div>}
  </li>)}</ul>;
  const header=(id:Id|'limit',title:string,hint?:string,align?:'right')=>{
    return sorting ? <SortHeader key={id} id={id} title={title} hint={hint} align={align} active={sorting.active} onSort={() => sorting.cycle(id)}/>
      : <th key={id} scope="col" title={hint} className={align && 'is-' + align}>{title}</th>;
  };
  return <div className="table-wrap"><table className="analytics-table">
    <colgroup><col/>{columns.map(column => <col key={column.id} style={{width: column.width}}/>)}</colgroup>
    <thead><tr>{header('limit',name)}{columns.map(column=>header(column.id,column.title,column.hint,column.align))}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.key}>
      <td><span className="analytics-name" title={row.hint}>{row.color && <span className="swatch" style={{background: row.color}}/>}<span>{row.name}</span></span></td>
      {columns.map(column => shown(column.id, row.cells[column.id], (cell, time) => <td data-time={time} className={[cell.className, column.align && 'is-' + column.align].filter(Boolean).join(' ') || undefined} title={cell.title}>{cell.content}</td>))}
    </tr>)}</tbody>
  </table></div>;
}
export const AnalyticsTable=memo(Table) as typeof Table;
