/** @jsxRuntime automatic */
import {type ReactNode,type RefObject} from 'react';
import {withColumn, withHidden, type Arrange} from '../lib/view';
import {t} from '../i18n';
import {HideRow, Popover, SlidersIcon, SwitchRow} from './Popover';
import {TableHeading,type TableSorting} from './TableWidget';
import {tableCell as shown,TableDetails,type Cell,type TimedCell} from './TableCell';
import {TablePreview} from './TablePreview';
import {Name} from './Kit';
export type {Cell,TimedCell} from './TableCell';

export type AnalyticsColumn<Id extends string> = {id: Id; title: string; hint?: string; width: number; align?: 'right'};
export type AnalyticsRow<Id extends string> = {key: string; name: string; hint?: string; color?: string; cells: Record<Id, Cell | TimedCell>};

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

/** Shared cells in the layout and page supplied by the common table widget. */
export function AnalyticsTable<Id extends string>({columns, rows, name, lead, sorting, onOpen,layout,body,still=false}: {
  columns: readonly AnalyticsColumn<Id>[]; rows: AnalyticsRow<Id>[];
  name: string; lead?: Id;layout:'table'|'list';body?:RefObject<HTMLElement|null>;still?:boolean;
  sorting?: Pick<TableSorting<Id|'name'>,'active'|'onSort'>;
  onOpen?:(key:string)=>void;
}) {
  const rowName=(row:AnalyticsRow<Id>)=>onOpen&&!still?<button type="button" className="agents-open" data-activity-group={row.key} onClick={()=>onOpen(row.key)}><Name name={row.name}/></button>:<span><Name name={row.name}/></span>;
  const openRow=(row:AnalyticsRow<Id>,target:EventTarget)=>{if(onOpen&&!(target as Element).closest('button'))onOpen(row.key);};
  const details=(row:AnalyticsRow<Id>,column:AnalyticsColumn<Id>,cell:Cell)=>cell.details===undefined?undefined:<>{[row.name,row.hint,column.title].filter(Boolean).join('\n')}{'\n'}<TableDetails details={cell.details}/></>;
  if (layout === 'list') return <ul ref={body as RefObject<HTMLUListElement|null>} className="analytics-compact">{rows.map(row => <li key={row.key} onClick={event=>openRow(row,event.target)}><TablePreview label={row.name} still={still}>
    <div className="analytics-compact-main">
      {row.color && <span className="swatch" style={{background: row.color}}/>}
      <span className="analytics-compact-name" title={row.hint}>{rowName(row)}</span>
      {columns.filter(column => column.id === lead).map(column => shown(column.id, row.cells[column.id], (cell, time) =>
        <TablePreview label={column.title} details={details(row,column,cell)} still={still} time={time}><span className={cell.className} title={cell.title}><span className="sr-only">{column.title}: </span>{cell.content}</span></TablePreview>,still))}
    </div>
    {columns.some(column => column.id !== lead) && <div className="analytics-compact-details">{columns.filter(column => column.id !== lead).map(column => shown(column.id, row.cells[column.id], (cell, time) =>
      <TablePreview label={column.title} details={details(row,column,cell)} still={still} time={time}><span title={cell.title}>{column.title} <span className={['analytics-cell-value',cell.className].filter(Boolean).join(' ')}>{cell.content}</span></span></TablePreview>,still))}</div>}
  </TablePreview></li>)}</ul>;
  return <div className="table-wrap"><table className="analytics-table">
    <colgroup><col/>{columns.map(column => <col key={column.id} style={{width: column.width}}/>)}</colgroup>
    <thead><tr><TableHeading id={'name' as Id|'name'} title={name} sorting={sorting}/>{columns.map(column => <TableHeading key={column.id} {...column} sorting={sorting}/>)}</tr></thead>
    <tbody ref={body as RefObject<HTMLTableSectionElement|null>}>{rows.map(row => <tr key={row.key} onClick={event=>openRow(row,event.target)}>
      <td><TablePreview label={row.name} still={still}><span className="analytics-name" title={row.hint}>{row.color && <span className="swatch" style={{background: row.color}}/>}{rowName(row)}</span></TablePreview></td>
      {columns.map(column => shown(column.id, row.cells[column.id], (cell, time) => <td data-time={time} className={[cell.className, column.align && 'is-' + column.align].filter(Boolean).join(' ') || undefined} title={cell.title}><TablePreview label={column.title} details={details(row,column,cell)} still={still}>{cell.content}</TablePreview></td>,still))}
    </tr>)}</tbody>
  </table></div>;
}
