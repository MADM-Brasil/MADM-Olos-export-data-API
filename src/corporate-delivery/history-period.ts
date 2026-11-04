import { DateTime } from 'luxon';
import { SyncError } from '../corporate-sync/errors.js';
import type { Shape } from '../corporate-sync/mapping.js';

// Fixed business scope: September and October 2026 in America/Sao_Paulo.
// Compare the existing canonical six-digit payload projection, preserving
// microseconds and avoiding session-timezone-dependent SQL casts.
export function historyPeriod(shape: Shape, timestampZone?: string) {
  const type = shape.get('data_ligacao')?.type;
  if (type !== 'timestamp' && type !== 'timestamptz') throw new SyncError('DRAIN_HISTORY_PERIOD_INVALID');
  const zone = type === 'timestamptz' ? 'UTC' : timestampZone;
  if (!zone) throw new SyncError('TIMESTAMP_SEMANTICS_NOT_CONFIRMED');
  const boundary = (date: string) => {
    const time = DateTime.fromISO(date, { zone: 'America/Sao_Paulo' }).setZone(zone);
    if (!time.isValid) throw new SyncError('DRAIN_HISTORY_PERIOD_INVALID');
    return time.toFormat("yyyy-MM-dd'T'HH:mm:ss") + '.000000' + (type === 'timestamptz' ? 'Z' : '');
  };
  return { start: boundary('2026-09-01'), end: boundary('2026-11-01'),
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}' + (type === 'timestamptz' ? 'Z$' : '$') };
}

export function inHistoryPeriod(payload: Record<string, unknown>, period: ReturnType<typeof historyPeriod>) {
  const value = payload.data_ligacao;
  return typeof value === 'string' && new RegExp(period.pattern).exec(value)?.[0] === value &&
    value >= period.start && value < period.end;
}
