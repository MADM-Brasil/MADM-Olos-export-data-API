import { identifiedAgentPattern, operatorNameWhitespace, operatorNamePlaceholderPattern } from './identified-operator.js';
import type { historyPeriod } from './history-period.js';
import { preservedHistoryRead } from './preserved-history.js';

// The literal operator predicate must match migration 008. A bound parameter
// alone cannot prove a partial-index predicate in a generic prepared plan.
// This is a code constant, never user/configuration input.
export function drainSelection(source: string, limit: number, period: ReturnType<typeof historyPeriod>, gaps: boolean) {
  const recovered = gaps ? `EXISTS(SELECT 1 FROM olos_http.history_gap_members gm
    JOIN olos_http.reads gr ON gr.id=gm.read_id WHERE gm.source_key=o.source_key AND gm.source_id=o.source_id AND gr.state='done')` : 'false';
  return {
    text: `SELECT o.source_id FROM olos_http.records r
    JOIN olos_http.corporate_outbox o USING(source_key,source_id) JOIN olos_http.reads h ON h.id=$2
    WHERE r.source_key=$1 AND r.agent_id ~ '${identifiedAgentPattern}'
    AND o.state='pending' AND ((o.created_at<h.started_at AND r.created_at<h.started_at) OR ${recovered})
    AND o.target_id::text=o.source_id AND r.target_id=o.target_id
    AND jsonb_typeof(o.payload->'nome_agente')='string'
    AND btrim(o.payload->>'nome_agente',$4)<>''
    AND btrim(o.payload->>'nome_agente',$4) !~* $5
    AND jsonb_typeof(o.payload->'data_ligacao')='string' AND o.payload->>'data_ligacao' ~ $6
    AND (o.payload->>'data_ligacao') COLLATE "C" >= $7 AND (o.payload->>'data_ligacao') COLLATE "C" < $8
    ORDER BY r.target_id LIMIT $3 FOR UPDATE OF o,r NOWAIT`,
    values: [source,preservedHistoryRead,limit,operatorNameWhitespace,operatorNamePlaceholderPattern,period.pattern,period.start,period.end],
  };
}
