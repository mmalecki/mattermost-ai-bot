// With its UTC offset, so the model can compare post times with tool results in other zones.
// Follows TZ.
const timeFormat = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'shortOffset',
});

/** A time as the model is given it, such as `2026-10-25 17:00 GMT+1`. */
export function formatTime(ms: number): string {
  return timeFormat.format(ms);
}
