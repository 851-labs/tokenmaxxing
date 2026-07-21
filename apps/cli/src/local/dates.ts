/**
 * Local-time day bucketing for the native collectors. ccusage buckets by
 * local time, so dates emitted here must be local-time YYYY-MM-DD too —
 * they are opaque strings downstream and never re-parsed into Dates.
 */

/** Epoch seconds -> local YYYY-MM-DD. */
function localDay(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/** YYYY-MM-DD string compare works for the --since lower bound. */
function onOrAfter(day: string, since: string | undefined): boolean {
  return since === undefined || day >= since;
}

export { localDay, onOrAfter };
