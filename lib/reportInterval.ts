// How often this app means to report, in ms. lib/settings keeps it in step with the
// update preset. The server uses it to tell how long the device counts as online when
// it only reports in short visits, after Android ended the foreground service.
let intervalMs: number | undefined;

export function setReportInterval(ms: number) {
  intervalMs = ms;
}

export function reportInterval(): number | undefined {
  return intervalMs;
}
