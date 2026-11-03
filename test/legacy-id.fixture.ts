// Synthetic historical state only. Runtime has no switch back to sequence IDs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import type { Config } from '../src/config.js';
import { columns, mapRecord, type Cache } from '../src/mapping.js';
import { freeze } from '../src/corporate-delivery/contract.js';
import { deliveryDigest } from '../src/corporate-delivery/payload.js';

export async function seedLegacyIds(db: Client | PoolClient, cfg: Config, input: Record<string,unknown>[], cache: Cache) {
  assert.equal(process.env.OLOS_DIRECT_DISPOSABLE_TEST,'true');
  assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name,'olos_direct_test');
  const target='"raw"."olos_calls"';
  await db.query('BEGIN');
  try {
    const shape=cfg.corporateDelivery
      ? new Map((await db.query('SELECT destination_shape FROM olos_http.corporate_control WHERE singleton')).rows[0].destination_shape)
      : undefined;
    for (let offset=0;offset<input.length;offset+=500) {
      const mapped=input.slice(offset,offset+500).map(r => mapRecord(r,cache,cfg.sourceTimeZone,!!cfg.corporateDelivery));
      const markers=(await db.query(`INSERT INTO olos_http.records(source_key,source_id,target_table,target_id,source_hash,agent_id,campaign_id,disposition_id)
        SELECT $1,x.source_id,$2,nextval('raw.olos_calls_internal_id_olos_seq'),x.source_hash,x.agent_id,x.campaign_id,x.disposition_id
        FROM jsonb_to_recordset($3::jsonb) AS x(source_id text,source_hash text,agent_id text,campaign_id text,disposition_id text)
        RETURNING source_id,target_id::text`,[cfg.sourceKey,target,JSON.stringify(mapped)])).rows;
      const ids=new Map(markers.map(r => [r.source_id,r.target_id]));
      const payload=mapped.map(r => ({...r,internal_id_olos:ids.get(r.source_id)}));
      if (cfg.corporateDelivery) {
        const frozen=await freeze(db as PoolClient,payload,shape as Parameters<typeof freeze>[2],cfg.corporateDelivery);
        for (let i=0;i<frozen.length;i++) await db.query(`INSERT INTO olos_http.corporate_outbox
          (source_key,source_id,target_id,source_hash,payload,payload_hash,origin) VALUES($1,$2,$3,$4,$5,$6,'capture')`,
        [cfg.sourceKey,mapped[i]!.source_id,frozen[i]!.internal_id_olos,mapped[i]!.source_hash,JSON.stringify(frozen[i]),deliveryDigest(frozen[i]!)]);
      } else {
        const declarations=columns.map(c => `${c} ${c==='data_ligacao'?'timestamptz':c==='tma_origem'?'numeric':'text'}`).join(',');
        await db.query(`INSERT INTO raw.olos_calls(internal_id_olos,${columns.join(',')}) OVERRIDING SYSTEM VALUE
          SELECT internal_id_olos,${columns.join(',')} FROM jsonb_to_recordset($1::jsonb) AS x(internal_id_olos bigint,${declarations})`,[JSON.stringify(payload)]);
      }
    }
    await db.query(`INSERT INTO olos_http.reads(id,source_key,target_table,spec,state,response_body,processed_count,received_count,finished_at)
      VALUES($1,$2,$3,'{"kind":"current"}','done',$4,$5,$5,clock_timestamp())`,[randomUUID(),cfg.sourceKey,target,JSON.stringify(input),input.length]);
    await db.query('COMMIT');
  } catch(error) {await db.query('ROLLBACK');throw error;}
}
