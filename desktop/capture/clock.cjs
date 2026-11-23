// Capture processes share an offset from the same wall clock; timers keep running at normal speed.
function installClock(offset) {
  const WallDate = Date;
  class CaptureDate extends WallDate {
    constructor(...args) { super(...(args.length ? args : [WallDate.now() + offset])); }
    static now() { return WallDate.now() + offset; }
  }
  globalThis.Date = new Proxy(CaptureDate, {apply: () => new CaptureDate().toString()});
}

module.exports = installClock;
if (process.env.SHOWCASE_OFFSET_MS !== undefined) {
  const offset = Number(process.env.SHOWCASE_OFFSET_MS);
  if (!Number.isSafeInteger(offset)) throw new Error('Expected SHOWCASE_OFFSET_MS in milliseconds');
  installClock(offset);
}
