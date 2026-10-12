/** @jsxRuntime automatic */
import type {TableSort} from '../lib/tableSort';
import {t} from '../i18n';
import {Popover} from './Popover';

export function SortHeader<Id extends string>({id, title, hint, align, active, onSort}: {
  id: Id; title: string; hint?: string; align?: 'right'; active: TableSort<Id>; onSort: () => void;
}) {
  const chosen = active?.column === id;
  return <th scope="col" title={hint} className={align && 'is-' + align} aria-sort={chosen ? active.descending ? 'descending' : 'ascending' : undefined}>
    <button type="button" className="table-sort" onClick={onSort}>
      {title}<span className="table-sort-arrow" aria-hidden="true">{chosen ? active.descending ? '↓' : '↑' : ''}</span>
    </button>
  </th>;
}

export function SortChoices<Id extends string>({active, columns, defaultLabel, onSort}: {
  active: TableSort<Id>; columns: readonly {id: Id; title: string}[]; defaultLabel: string;
  onSort: (column: Id | null, cycle?: boolean) => void;
}) {
  return <>
    <button type="button" className="popover-row" aria-pressed={!active} onClick={() => onSort(null)}>
      <span>{defaultLabel}</span><b aria-hidden="true">{!active ? '✓' : ''}</b>
    </button>
    {columns.map(column => <button type="button" className="popover-row" key={column.id} aria-pressed={active?.column === column.id} onClick={() => onSort(column.id, false)}>
      <span>{column.title}</span>
      {active?.column === column.id && <b><span aria-hidden="true">{active.descending ? '↓' : '↑'}</span><span className="sr-only">{t(active.descending ? 'table.descending' : 'table.ascending')}</span></b>}
    </button>)}
  </>;
}

const SortIcon = () => <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
  <path d="M4 3v10M1.5 10.5 4 13l2.5-2.5M9 4h5M9 8h3.5M9 12h2" />
</svg>;

export function SortMenu<Id extends string>(props: Parameters<typeof SortChoices<Id>>[0]) {
  return <Popover label={t('table.sort')} icon={<SortIcon/>}>
    <div className="popover-title">{t('table.sort')}</div>
    <SortChoices {...props}/>
  </Popover>;
}
