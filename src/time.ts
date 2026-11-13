// With its UTC offset, so the model can compare post times with tool results in other zones.
// Follows TZ.
const toTheMinute: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'shortOffset',
};
const formats = {
  minutes: new Intl.DateTimeFormat('sv-SE', toTheMinute),
  seconds: new Intl.DateTimeFormat('sv-SE', { ...toTheMinute, second: '2-digit' }),
};

/** A time as the model is given it, such as `2026-10-25 17:00 GMT+1`, or with `seconds`, `17:00:40`. */
export function formatTime(ms: number, { seconds = false } = {}): string {
  return formats[seconds ? 'seconds' : 'minutes'].format(ms);
}
