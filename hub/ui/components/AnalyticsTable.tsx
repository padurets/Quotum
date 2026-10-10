/** @jsxRuntime automatic */
import {Fragment, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {useClock} from '../lib/clock';
import {tableLayout} from '../lib/table';
import {withColumn, withHidden, type Arrange} from '../lib/view';
import {t} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';

export type Cell = {content: ReactNode; title?: string; className?: string};
export type TimedCell = {time: string; changesAt: (now: number) => number | null; at: (now: number) => Cell};
export type AnalyticsColumn<Id extends string> = {id: Id; title: string; hint?: string; width: number; align?: 'right'};
type Row<Id extends string> = {key: string; name: string; color?: string; cells: Record<Id, Cell | TimedCell>};

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

/** Column widths decide when both tables become labelled rows; cells have one renderer. */
export function AnalyticsTable<Id extends string>({columns, rows, name, nameWidth, lead}: {
  columns: readonly AnalyticsColumn<Id>[]; rows: Row<Id>[];
  name: string; nameWidth: number; lead?: Id;
}) {
  const body = useRef<HTMLDivElement | HTMLUListElement>(null);
  const [layout, setLayout] = useState<'table' | 'list'>('table');
  const width = nameWidth + columns.reduce((sum, column) => sum + column.width, 0);
  useLayoutEffect(() => {
    const element = body.current!.parentElement!;
    const fit = () => {
      const style = getComputedStyle(element);
      const edges = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) - 20;
      setLayout(tableLayout(columns.map(column => column.width), element.clientWidth, nameWidth, edges));
    };
    const observer = new ResizeObserver(fit); observer.observe(element); fit();
    return () => observer.disconnect();
  }, [width]);
  if (layout === 'list') return <ul ref={element => {body.current = element;}} className="analytics-compact">{rows.map(row => <li key={row.key}>
    <div className="analytics-compact-main">
      {row.color && <span className="swatch" style={{background: row.color}}/>}
      <span className="analytics-compact-name">{row.name}</span>
      {columns.filter(column => column.id === lead).map(column => shown(column.id, row.cells[column.id], (cell, time) =>
        <span data-time={time} className={cell.className} title={cell.title}><span className="sr-only">{column.title}: </span>{cell.content}</span>))}
    </div>
    {columns.some(column => column.id !== lead) && <div className="analytics-compact-details">{columns.filter(column => column.id !== lead).map(column => shown(column.id, row.cells[column.id], (cell, time) =>
      <span data-time={time} title={cell.title}>{column.title} <span className={cell.className}>{cell.content}</span></span>))}</div>}
  </li>)}</ul>;
  return <div ref={element => {body.current = element;}} className="table-wrap"><table className="analytics-table">
    <colgroup><col/>{columns.map(column => <col key={column.id} style={{width: column.width}}/>)}</colgroup>
    <thead><tr><th>{name}</th>{columns.map(column => <th key={column.id} title={column.hint} className={column.align && 'is-' + column.align}>{column.title}</th>)}</tr></thead>
    <tbody>{rows.map(row => <tr key={row.key}>
      <td><span className="analytics-name">{row.color && <span className="swatch" style={{background: row.color}}/>}<span>{row.name}</span></span></td>
      {columns.map(column => shown(column.id, row.cells[column.id], (cell, time) => <td data-time={time} className={[cell.className, column.align && 'is-' + column.align].filter(Boolean).join(' ') || undefined} title={cell.title}>{cell.content}</td>))}
    </tr>)}</tbody>
  </table></div>;
}
