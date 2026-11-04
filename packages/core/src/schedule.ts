// Timer schedules (timer start event, scheduleKey), in the two forms the tenant uses: the table the designer writes
// into the iFlow (or into parameters.prop when externalized), and the short form of the Configurations API. Every
// format here was recorded from the designer and the tenant (run once; simple: every n minutes or hours; advanced:
// cron fields; start and end; time zones).

/** run once after deploy; a simple schedule; or an advanced one (Quartz cron: s m h day-of-month month day-of-week [year]) */
export type Schedule =
  | 'once'
  | ({ every: number; unit: 'minutes' | 'hours' } & ScheduleWindow)
  | ({ cron: string } & ScheduleWindow);
export interface ScheduleWindow {
  /** first run not before (local time in timeZone, "2026-11-05T08:00:00") */
  from?: string;
  /** no run after */
  until?: string;
  /** IANA time zone id, e.g. "Europe/Warsaw"; default UTC (Etc/GMT) */
  timeZone?: string;
}

const UTC_LABEL = '( UTC 0:00 ) Greenwich Mean Time(Etc/GMT)';
/** Ids the designer offers that are not IANA ids (Java's short ids), with the label it writes (recorded) */
const DESIGNER_ZONES: Record<string, string> = { NST: '( UTC 12:00 ) New Zealand Standard Time(NST)' };
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * The designer's label of a time zone: "( UTC 12:00 ) New Zealand Standard Time(NST)" (recorded). Built from the
 * zone's standard (winter) offset and name; the runtime reads only the id.
 */
export function zoneLabel(id: string): string {
  if (id === 'Etc/GMT') return UTC_LABEL;
  if (DESIGNER_ZONES[id]) return DESIGNER_ZONES[id];
  try { new Intl.DateTimeFormat('en-US', { timeZone: id }); } catch { throw new Error(`"${id}" is not a time zone id (use IANA ids such as Europe/Warsaw)`); }
  const part = (date: Date, style: 'longOffset' | 'long') =>
    new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: style }).formatToParts(date).find((p) => p.type === 'timeZoneName')!.value;
  const minutes = (o: string) => { const m = o.match(/GMT([+-])(\d{2}):(\d{2})/); return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0; };
  // the standard offset is the smaller one of January and July (summer time adds)
  const [jan, jul] = [new Date(Date.UTC(2026, 0, 15)), new Date(Date.UTC(2026, 6, 15))];
  const std = minutes(part(jan, 'longOffset')) <= minutes(part(jul, 'longOffset')) ? jan : jul;
  const off = minutes(part(std, 'longOffset'));
  const offText = `${off < 0 ? '-' : ''}${Math.floor(Math.abs(off) / 60)}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  return `( UTC ${offText} ) ${part(std, 'long')}(${id})`;
}

const RANGES: Array<[string, number, number]> = [['second', 0, 59], ['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 1, 7], ['year', 1970, 2199]];
const NAMES: Record<number, RegExp> = { 4: /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/, 5: /^(SUN|MON|TUE|WED|THU|FRI|SAT)$/ };

/** The seven Quartz fields of a cron expression, checked (the year defaults to *) */
export function cronFields(cron: string): string[] {
  const f = cron.trim().split(/\s+/);
  if (f.length === 6) f.push('*');
  if (f.length !== 7) throw new Error(`cron "${cron}" needs 6 or 7 fields: second minute hour day-of-month month day-of-week [year], e.g. "0 15 8 ? * MON-FRI"`);
  f.forEach((field, i) => {
    const [name, lo, hi] = RANGES[i]!;
    const value = (v: string) => /^\d+$/.test(v) ? Number(v) >= lo && Number(v) <= hi : !!NAMES[i]?.test(v.toUpperCase());
    const ok = field === '*' || (field === '?' && (i === 3 || i === 5)) || field.split(',').every((part) => {
      const [base, step] = part.split('/');
      if (step !== undefined && !/^\d+$/.test(step)) return false;
      if (base === '*') return step !== undefined;
      const [a, b] = base!.split('-');
      return value(a!) && (b === undefined || value(b)) || (i === 3 && /^(L|LW|\d{1,2}W)$/.test(part)) || (i === 5 && /^[1-7A-Z]{1,3}(#\d|L)$/i.test(part));
    });
    if (!ok) throw new Error(`cron "${cron}": "${field}" is not a valid ${name} (${lo}-${hi}, *, lists, ranges, steps like 0/15)`);
  });
  if ((f[3] === '?') === (f[5] === '?')) throw new Error(`cron "${cron}": exactly one of day-of-month and day-of-week must be "?"`);
  return f;
}

/** A schedule object as an agent passes it: exactly one of every+unit and cron */
export function checkSchedule(s: unknown): Schedule {
  if (s === 'once') return s;
  const o = (s ?? {}) as Record<string, unknown>;
  if (('every' in o) === ('cron' in o)) throw new Error('a schedule is "once", {every, unit} (simple) or {cron} (advanced)');
  if ('every' in o && o.unit !== 'minutes' && o.unit !== 'hours') throw new Error('a simple schedule needs unit "minutes" or "hours"');
  return o as unknown as Schedule;
}

function window(s: ScheduleWindow) {
  for (const [k, v] of [['from', s.from], ['until', s.until]] as const) if (v !== undefined && !DATE.test(v)) throw new Error(`${k} "${v}" must look like 2026-11-05T08:00:00`);
  if (s.from && s.until && s.from >= s.until) throw new Error(`until ${s.until} is not after from ${s.from}`);
  const tz = s.timeZone ?? 'Etc/GMT';
  return { tz, label: zoneLabel(tz), from: s.from ?? '', until: s.until ?? '' };
}

/** The table the designer writes (recorded for run once, simple and advanced schedules, character for character) */
export function scheduleTable(input: Schedule): string {
  const schedule = checkSchedule(input);
  const esc = (v: string) => v.replace(/&/g, '&amp;');
  let rows: Array<[string, string]>;
  if (schedule === 'once') {
    rows = [
      ['dateType', ''], ['timeType', ''], ['dayValue', ''], ['monthValue', ''], ['yearValue', ''], ['onWeekly', ''], ['onMonthly', ''],
      ['OnEveryMinute', ''], ['fromInterval', ''], ['toInterval', ''], ['timeZone', UTC_LABEL], ['secondValue', '0'],
      ['minutesValue', ''], ['hourValue', ''], ['triggerType', 'simple'], ['noOfSchedules', '1'], ['schedule1', 'fireNow=true'],
    ];
  } else {
    const w = window(schedule);
    const tail = `&trigger.timeZone=${w.tz}${w.from ? `&trigger.startAt=${w.from}` : ''}${w.until ? `&trigger.endAt=${w.until}` : ''}`;
    let cron = ['*', '*', '*', '?', '*', '*', '*'];
    let schedule1: string;
    if ('every' in schedule) {
      const max = schedule.unit === 'minutes' ? 59 : 23;
      if (!Number.isInteger(schedule.every) || schedule.every < 1 || schedule.every > max) throw new Error(`every ${schedule.unit}: a whole number from 1 to ${max}`);
      schedule1 = `simple.repeat=${schedule.unit === 'minutes' ? 'MINUTES' : 'HOURS'}&simple.every=${schedule.every}${tail}`;
    } else {
      cron = cronFields(schedule.cron);
      schedule1 = `${cron.join('+')}${tail}`;
    }
    rows = [
      ['dateType', 'every' in schedule ? 'SIMPLE' : 'ADVANCED'], ['secondValue', '0'], ['minutesValue', ''], ['hourValue', ''], ['toInterval', '1'], ['fromInterval', '0'],
      ['OnEveryMinute', '1'], ['timeType', 'TIME_INTERVAL'], ['timeZone', w.label], ['throwExceptionOnExpiry', 'true'],
      ['second', cron[0]!], ['minute', cron[1]!], ['hour', cron[2]!], ['day_of_month', cron[3]!], ['month', cron[4]!], ['dayOfWeek', cron[5]!], ['year', cron[6]!],
      ['startAt', w.from], ['endAt', w.until],
      ['attributeBehaviour', 'isThrowExceptionOnExpiryVisible,isScheduleAdvancedVisible,isScheduleAdvancedStartEndVisible,isScheduleSimpleVisible'],
      ['triggerType', 'cron'], ['noOfSchedules', '1'], ['schedule1', schedule1],
    ];
  }
  return rows.map(([k, v]) => `<row><cell>${k}</cell><cell>${esc(v)}</cell></row>`).join('');
}

/**
 * The short form the Configurations API shows (recorded): "simple.repeat=MINUTES --simple.every=30 --tz=NST
 * --startAt=… --endAt=…", or the cron fields "* 0/15 0/8 ? * MON,TUE * --tz=Etc/GMT …". Run once has no recorded form.
 */
export function scheduleConfigValue(schedule: Exclude<Schedule, 'once'>): string {
  const w = window(schedule);
  const head = 'every' in schedule
    ? `simple.repeat=${schedule.unit === 'minutes' ? 'MINUTES' : 'HOURS'} --simple.every=${schedule.every}`
    : cronFields(schedule.cron).join(' ');
  return `${head} --tz=${w.tz}${w.from ? ` --startAt=${w.from}` : ''}${w.until ? ` --endAt=${w.until}` : ''}`;
}
