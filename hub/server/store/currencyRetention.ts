import type {DatabaseSync} from 'node:sqlite';
import type {RateChangeRow} from './currencyRegistry.js';

/** Retain the decision at real native anchors, including readers who have no binding yet. */
export function pruneCurrencyTimeline(db:DatabaseSync,cutoff:number) {
  db.prepare(`DELETE FROM currency_unavailable_observations AS m WHERE observation_at<?
    AND observation_at<(SELECT max(n.observation_at) FROM currency_unavailable_observations n
      WHERE n.owner_id=m.owner_id AND n.source_id=m.source_id AND n.from_currency=m.from_currency
        AND n.target_currency=m.target_currency AND n.anchor=m.anchor AND n.observation_at<?)
    AND NOT EXISTS(SELECT 1 FROM state,json_each(state.payload,'$.meters') v WHERE state.source_id=m.source_id
      AND json_extract(v.value,'$.at')=m.observation_at AND json_extract(v.value,'$.unit')=m.from_currency)
    AND NOT EXISTS(SELECT 1 FROM readings r WHERE r.source_id=m.source_id AND r.unit=m.from_currency AND (r.at=m.observation_at OR r.previous_at=m.observation_at))
    AND NOT EXISTS(SELECT 1 FROM meter_spans s WHERE s.source_id=m.source_id AND (s.from_at=m.observation_at OR s.to_at=m.observation_at))
    AND NOT EXISTS(SELECT 1 FROM money_valuations v WHERE v.source_id=m.source_id AND v.native_unit=m.from_currency AND (v.at=m.observation_at OR v.previous_at=m.observation_at))`).run(cutoff,cutoff);
  const anchors=(db.prepare(`SELECT DISTINCT at FROM (
    SELECT json_extract(m.value,'$.at') at FROM state,json_each(state.payload,'$.meters') m
    UNION SELECT at FROM readings UNION SELECT previous_at FROM readings
    UNION SELECT from_at FROM meter_spans UNION SELECT to_at FROM meter_spans
    UNION SELECT at FROM money_valuations UNION SELECT previous_at FROM money_valuations
    UNION SELECT observation_at FROM currency_bindings UNION SELECT through_at FROM currency_bindings
    UNION SELECT observation_at FROM currency_unavailable_observations
  ) WHERE at IS NOT NULL AND at<? ORDER BY at`).all(cutoff) as {at:number}[]).map(row=>row.at);
  anchors.push(cutoff);
  const referenced=new Set((db.prepare(`SELECT initial_quote_id id FROM currency_definitions WHERE initial_quote_id IS NOT NULL
    UNION SELECT json_extract(s.value,'$.id') FROM currency_bindings b,json_each(b.steps) s`).all() as {id:string}[]).map(row=>row.id));
  const groups=new Map<string,RateChangeRow[]>();
  for(const row of db.prepare('SELECT * FROM currency_rate_changes ORDER BY effective_at,sequence').all() as RateChangeRow[]){const key=JSON.stringify([row.owner_id,row.currency_id,row.base]);let group=groups.get(key);if(!group)groups.set(key,(group=[]));group.push(row);}
  const remove=db.prepare('DELETE FROM currency_rate_changes WHERE sequence=?');
  for(const rows of groups.values()) {
    const keep=new Set<number>();let position=-1;
    for(const at of anchors){while(position+1<rows.length&&rows[position+1].effective_at<=at)position++;if(position>=0)keep.add(rows[position].sequence);}
    for(const row of rows)if(row.effective_at<cutoff&&!keep.has(row.sequence)&&!(row.quote_id&&referenced.has(row.quote_id)))remove.run(row.sequence);
  }
  db.prepare('DELETE FROM currency_mutations WHERE created_at<?').run(Date.now()-7*86_400_000);
}
