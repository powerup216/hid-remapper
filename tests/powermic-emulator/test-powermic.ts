// Scripted USB host for the PowerMic HID Remapper firmware, running on rp2040js.
// Usage: node --experimental-transform-types --import ./register.mjs test-powermic.ts <firmware.uf2>
import { readFileSync, writeSync } from 'node:fs';
import { Simulator } from './rp2040js/src/simulator.js';
import { ConsoleLogger, LogLevel } from './rp2040js/src/utils/logging.js';
import { bootromB1 } from './rp2040js/demo/bootrom.js';

const uf2Path = process.argv[2];
const sim = new Simulator();
const mcu = sim.rp2040;
mcu.loadBootrom(bootromB1);
mcu.logger = new ConsoleLogger(LogLevel.Error);

// --- load UF2 ---
const uf2 = readFileSync(uf2Path);
for (let off = 0; off + 512 <= uf2.length; off += 512) {
  const dv = new DataView(uf2.buffer, uf2.byteOffset + off, 512);
  if (dv.getUint32(0, true) !== 0x0a324655) continue;
  const addr = dv.getUint32(12, true);
  const size = dv.getUint32(16, true);
  mcu.flash.set(uf2.subarray(off + 32, off + 32 + size), addr - 0x10000000);
}

// --- UART log (firmware printf) ---
let uartLine = '';
mcu.uart[0].onByte = (b: number) => {
  if (b === 10) { if (process.env.UARTLOG || process.env.TRACE) writeSync(2, '  [uart] ' + uartLine + '\n'); uartLine = ''; }
  else uartLine += String.fromCharCode(b);
};

const usb = mcu.usbCtrl;
const hex = (a: ArrayLike<number>) => Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(' ');

// ---- minimal control-transfer host ----
type Pending = { kind: 'in' | 'out' | 'none'; want: number; got: number[]; data?: Uint8Array; sent?: number; resolve: (v: any) => void; reject: (e: any) => void; timer: any };
let pending: Pending | null = null;
const epData: Record<number, Uint8Array[]> = {};
const epWaiters: Record<number, ((b: Uint8Array) => void)[]> = {};

usb.onUSBEnabled = () => usb.resetDevice();
let resetDone: () => void;
const resetPromise = new Promise<void>((r) => (resetDone = r));
usb.onResetReceived = () => resetDone();

usb.onEndpointWrite = (ep: number, buf: Uint8Array) => {
  if (ep === 0) {
    if (!pending) return;
    if (pending.kind === 'in') {
      pending.got.push(...buf);
      if (pending.got.length >= pending.want || buf.length < 64) finish(Uint8Array.from(pending.got));
    } else {
      if (buf.length === 0) finish(null); // status stage ZLP
    }
    return;
  }
  if (process.env.EPLOG && ep === 3) writeSync(2, `  [ep3 @${(Number(sim.clock.nanos)/1e6).toFixed(2)}ms] ${hex(buf)}\n`);
  const w = epWaiters[ep]?.shift();
  if (w) w(buf); else (epData[ep] ??= []).push(buf);
};
usb.onEndpointRead = (ep: number, size: number) => {
  if (ep !== 0) return;
  if (pending && pending.kind === 'out' && pending.data && pending.sent! < pending.data.length) {
    const chunk = pending.data.subarray(pending.sent!, pending.sent! + Math.min(size, 64));
    pending.sent! += chunk.length;
    usb.endpointReadDone(0, chunk);
  } else {
    usb.endpointReadDone(0, new Uint8Array(0)); // status stage for IN transfers
  }
};
function finish(v: any) {
  const p = pending!; pending = null; clearTimeout(p.timer); p.resolve(v);
}
function control(setup: number[], kind: 'in' | 'out' | 'none', wantOrData: number | Uint8Array = 0, label = ''): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = null; reject(new Error('timeout/STALL: ' + label)); }, 4000);
    pending = { kind, want: typeof wantOrData === 'number' ? wantOrData : 0, got: [], data: typeof wantOrData === 'number' ? undefined : wantOrData, sent: 0, resolve, reject, timer };
    usb.sendSetupPacket(Uint8Array.from(setup));
  });
}
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const getDesc = (type: number, idx: number, len: number, wIndex = 0, rt = 0x80) =>
  control([rt, 6, idx, type, ...le16(wIndex), ...le16(len)], 'in', len, `GET_DESCRIPTOR ${type}`);
const getReport = (itf: number, type: number, id: number, len: number) =>
  control([0xa1, 0x01, id, type, ...le16(itf), ...le16(len)], 'in', len, `GET_REPORT itf${itf} type${type} id${id}`);
const setReport = (itf: number, type: number, id: number, data: Uint8Array) =>
  control([0x21, 0x09, id, type, ...le16(itf), ...le16(data.length)], 'out', data, `SET_REPORT itf${itf}`);
function readEp(ep: number, timeoutMs = 3000): Promise<Uint8Array> {
  const q = epData[ep];
  if (q && q.length) return Promise.resolve(q.shift()!);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no data on EP' + ep)), timeoutMs);
    (epWaiters[ep] ??= []).push((b) => { clearTimeout(t); resolve(b); });
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function utf16(d: Uint8Array) { let s = ''; for (let i = 2; i < d[0]; i += 2) s += String.fromCharCode(d[i] | (d[i + 1] << 8)); return s; }

// ---- config protocol (HID Remapper) ----
const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const CONFIG_VERSION = 18;
function cfgPacket(cmd: number, data: number[] = []) {
  const p = new Uint8Array(33); p[0] = 100; // report id
  p[1] = CONFIG_VERSION; p[2] = cmd; p.set(data, 3);
  new DataView(p.buffer).setUint32(29, crc32(p.subarray(1, 29)), true);
  return p;
}
async function cfg(cmd: number, data: number[] = []) { await setReport(0, 3, 100, cfgPacket(cmd, data)); }
async function cfgGet() {
  const r: Uint8Array = await getReport(0, 3, 100, 33);
  const body = r[0] === 100 ? r.subarray(1) : r;
  const ok = crc32(body.subarray(0, 28)) === new DataView(body.buffer, body.byteOffset).getUint32(28, true);
  return { body, ok };
}
const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

let failures = 0;
function check(cond: boolean, msg: string) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; }

const t0 = Date.now();
if (process.env.TRACE) setInterval(() => {
  writeSync(2, `[trace] wall ${((Date.now() - t0) / 1000).toFixed(0)}s sim ${(Number(sim.clock.nanos) / 1e6).toFixed(1)}ms PC=${mcu.core.PC.toString(16)} uart="${uartLine.slice(-60)}"\n`);
}, 3000).unref();
// Dual-chip boards: the A side only processes inputs on START_OF_FRAME ticks
// sent by the B side over uart1. FAKE_B_SIDE=1 sends those ticks every 1 ms.
function startFakeBSide() {
  const msg = [0x08];
  const c = crc32(Uint8Array.from(msg));
  const raw = [...msg, c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff];
  const pkt: number[] = [];
  for (const b of raw) { if (b === 0xc0) pkt.push(0xdb, 0xdc); else if (b === 0xdb) pkt.push(0xdb, 0xdd); else pkt.push(b); }
  pkt.push(0xc0);
  const al = (sim.clock as any).createAlarm(() => { for (const b of pkt) mcu.uart[1].feedByte(b); al.schedule(1e6); });
  al.schedule(1e6);
}
async function main() {
  if (process.env.FAKE_B_SIDE) startFakeBSide();
  mcu.gpio[5].setInputValue(true); // idle high (inputs are active-low)
  mcu.gpio[6].setInputValue(true);
  mcu.core.PC = 0x10000000;
  sim.execute();
  await resetPromise;
  await control([0x00, 5, 1, 0, 0, 0, 0, 0], 'none', 0, 'SET_ADDRESS');

  const dev: Uint8Array = await getDesc(1, 0, 18);
  const dv = new DataView(dev.buffer, dev.byteOffset);
  const vid = dv.getUint16(8, true), pid = dv.getUint16(10, true), bcd = dv.getUint16(12, true);
  console.log(`device: VID ${vid.toString(16)} PID ${pid.toString(16)} bcdDevice ${bcd.toString(16)}`);
  check(vid === 0x0554 && pid === 0x1001, 'device identifies as Nuance PowerMic II (0554:1001)');
  check(bcd === 0x0143, 'bcdDevice 1.43 like the genuine handset');
  const mfr = utf16(await getDesc(3, dev[14], 255, 0x0409));
  const prod = utf16(await getDesc(3, dev[15], 255, 0x0409));
  console.log(`strings: "${mfr}" / "${prod}"`);
  check(mfr === 'Nuance' && prod === 'PowerMicII-NS', 'manufacturer/product strings match PowerMic');

  const cfgHead: Uint8Array = await getDesc(2, 0, 9);
  const total = cfgHead[2] | (cfgHead[3] << 8);
  const conf: Uint8Array = await getDesc(2, 0, total);
  const itfs: any[] = [];
  for (let i = 0; i < conf.length; i += conf[i]) {
    if (conf[i + 1] === 4) itfs.push({ n: conf[i + 2], cls: conf[i + 5], proto: conf[i + 7] });
    if (conf[i + 1] === 0x21) itfs[itfs.length - 1].rdlen = conf[i + 7] | (conf[i + 8] << 8);
    if (conf[i + 1] === 5) Object.assign(itfs[itfs.length - 1], { ep: conf[i + 2], interval: conf[i + 6] });
  }
  console.log('interfaces:', JSON.stringify(itfs));
  check(itfs.length === 2 && itfs.every((x) => x.cls === 3), 'exactly two HID interfaces (architecture preserved)');

  await control([0x00, 9, 1, 0, 0, 0, 0, 0], 'none', 0, 'SET_CONFIGURATION');

  const rd0: Uint8Array = await getDesc(0x22, 0, itfs[0].rdlen, 0, 0x81);
  const rd1: Uint8Array = await getDesc(0x22, 0, itfs[1].rdlen, 1, 0x81);
  check(rd0.length === itfs[0].rdlen, `interface 0 report descriptor delivered in full (${rd0.length} bytes)`);
  const genuine = '05 01 09 00 a1 01 05 08 09 4b 15 00 25 01 95 08 75 01 91 02 05 09 15 00 25 01 75 01 95 08 81 01 19 01 29 0e 15 00 25 01 95 0e 81 02 95 02 81 01 05 ff 09 00 15 00 26 ff 00 75 08 95 27 b1 00 c0';
  check(hex(rd1) === genuine, 'interface 1 report descriptor is the genuine 64-byte PowerMic II descriptor');
  check(hex(rd0).includes('06 00 ff 09 20 a1 01'), 'interface 0 exposes the HID Remapper config collection (FF00:0020)');

  // SET_IDLE on both interfaces (what Windows does)
  await control([0x21, 0x0a, 0, 0, 0, 0, 0, 0], 'none', 0, 'SET_IDLE 0');
  await control([0x21, 0x0a, 0, 0, 1, 0, 0, 0], 'none', 0, 'SET_IDLE 1');

  // --- PowerMic interface answers class requests instead of stalling ---
  const feat: Uint8Array = await getReport(1, 3, 0, 39);
  check(feat.length === 39, 'GET_REPORT(Feature) on PowerMic interface returns 39 bytes (old build stalled)');
  const inr: Uint8Array = await getReport(1, 1, 0, 3);
  check(hex(inr) === '00 00 00', 'GET_REPORT(Input) on PowerMic interface returns idle state 00 00 00');
  await setReport(1, 2, 0, Uint8Array.from([0x01]));
  const led: Uint8Array = await getReport(1, 2, 0, 1);
  check(led[0] === 0x01, 'LED output report from PowerScribe is accepted and stored');

  // --- configurator over interface 0 ---
  await cfg(3); // GET_CONFIG
  const gc = await cfgGet();
  const mappingCount = new DataView(gc.body.buffer, gc.body.byteOffset).getUint16(7, true);
  console.log(`GET_CONFIG: version ${gc.body[0]}, crc ok ${gc.ok}, mapping_count ${mappingCount}`);
  check(gc.ok && gc.body[0] === CONFIG_VERSION, 'configurator protocol works on runtime firmware (no config-mode flash needed)');
  check(mappingCount === 4, 'fresh board has the 4 default F1-F4 PowerMic mappings');
  check(gc.body[23] === 6, `fresh board starts in emulated device type 6 (PowerMic) [got ${gc.body[23]}]`);
  const defaults: string[] = [];
  for (let i = 0; i < mappingCount; i++) {
    await cfg(6, u32(i)); // GET_MAPPING
    const m = (await cfgGet()).body; const v = new DataView(m.buffer, m.byteOffset);
    defaults.push(`${v.getUint32(4, true).toString(16)}->${v.getUint32(0, true).toString(16)}`);
  }
  console.log('  mappings:', defaults.join(', '));
  check(defaults.join(',') === '7003a->ff010002,7003b->ff010003,7003c->ff010004,7003d->ff010008', 'default mappings are F1 Prev, F2 Dictate, F3 Next, F4 Custom Left');

  // our usages list must contain the 14 PowerMic targets
  await cfg(8, u32(0));
  const ou = (await cfgGet()).body; const ouv = new DataView(ou.buffer, ou.byteOffset);
  const ranges: string[] = []; for (let i = 0; i < 3; i++) { const a = ouv.getUint32(i * 8, true), b = ouv.getUint32(i * 8 + 4, true); if (a) ranges.push(a.toString(16) + '..' + b.toString(16)); }
  console.log('  target usage ranges (first packet):', ranges.join(' '));

  // Add GPIO5 -> Dictate (FF01:0003) and GPIO5... keep defaults, then press GPIO5
  await cfg(10); // SUSPEND (what the web configurator does before changing mappings)
  await cfg(5, [...u32(0xff010003), ...u32(0xfff40005), ...u32(1000), 0x01, 0, 0]); // ADD_MAPPING (in RAM)
  await cfg(5, [...u32(0xff01000a), ...u32(0xfff40006), ...u32(1000), 0x01, 0, 0]); // GPIO6 -> Custom Right (button 10)
  await cfg(11); // RESUME -> mappings applied
  await sleep(300);

  // drain anything already queued on EP3
  epData[3] = [];

  mcu.gpio[5].setInputValue(false); // press "Dictate"
  const p1 = await readEp(3);
  check(hex(p1) === '00 04 00', `Dictate press -> PowerMic report ${hex(p1)} on EP 0x83 (interface 1)`);
  mcu.gpio[5].setInputValue(true);
  const r1 = await readEp(3);
  check(hex(r1) === '00 00 00', `Dictate release -> ${hex(r1)}`);

  // Repeat several times: the "only worked once" failure would show here
  let okCycles = 0;
  for (let i = 0; i < 5; i++) {
    await sleep(80);
    mcu.gpio[5].setInputValue(false); const a = await readEp(3).catch(() => new Uint8Array());
    await sleep(80);
    mcu.gpio[5].setInputValue(true); const b = await readEp(3).catch(() => new Uint8Array());
    if (hex(a) === '00 04 00' && hex(b) === '00 00 00') okCycles++;
  }
  check(okCycles === 5, `5 further press/release cycles all delivered (${okCycles}/5)`);

  // Button 10 lives in byte 2
  await sleep(50);
  mcu.gpio[6].setInputValue(false); const c = await readEp(3);
  mcu.gpio[6].setInputValue(true); const d = await readEp(3);
  check(hex(c) === '00 00 02' && hex(d) === '00 00 00', `Custom Right (button 10) -> ${hex(c)} / ${hex(d)}`);

  // Keyboard passthrough interface still alive: EP1 should not have received any report ID 4
  const ep1 = (epData[1] ?? []).filter((b) => b[0] === 4);
  check(ep1.length === 0, 'synthetic report ID 4 never leaks onto the keyboard interface');

  // Stress: host polls the PowerMic endpoint every 10 ms (its bInterval), and
  // the button is released 4 ms after it was pressed, while the press report is
  // still waiting on the endpoint.
  // The original build discarded the release here (tud_hid_n_report on a busy
  // endpoint), leaving PowerScribe with Dictate stuck "down".
  const simSleep = async (ms: number) => { const end = Number(sim.clock.nanos) + ms * 1e6; while (Number(sim.clock.nanos) < end) await sleep(1); };
  (usb as any).inPollDelayMicros[3] = 10000;
  await simSleep(100); epData[3] = [];
  let quickOk = 0;
  for (let i = 0; i < 3; i++) {
    if (process.env.EPLOG) writeSync(2, `  press @${(Number(sim.clock.nanos)/1e6).toFixed(2)}ms\n`); mcu.gpio[5].setInputValue(false);
    await new Promise<void>((res) => { const al = (sim.clock as any).createAlarm(() => { mcu.gpio[5].setInputValue(true); res(); }); al.schedule(4e6); }); if (process.env.EPLOG) writeSync(2, `  release @${(Number(sim.clock.nanos)/1e6).toFixed(2)}ms\n`);
    const a = await readEp(3, 8000); const b = await readEp(3, 8000).catch(() => new Uint8Array([0xee]));
    console.log(`  tap ${i + 1}: ${hex(a)} then ${hex(b)}`);
    if (hex(a) === '00 04 00' && hex(b) === '00 00 00') quickOk++;
    await simSleep(60);
  }
  check(quickOk === 3, `quick taps during an in-flight report keep both press and release (${quickOk}/3)`);
  (usb as any).inPollDelayMicros[3] = 0;

  const inr2: Uint8Array = await getReport(1, 1, 0, 3);
  check(hex(inr2) === '00 00 00', 'GET_REPORT(Input) reflects released state after use');

  // Optionally switch to stock "Mouse and keyboard" (type 0), persist, and dump
  // flash so test-stock.ts can boot from it.
  if (process.env.SAVE_STOCK_FLASH) {
    const b = gc.body;
    // set_config_t: flags, mask, partial_scroll_timeout(4), interval_override,
    // tap_hold_threshold(4), gpio_debounce_time_ms, our_descriptor_number, macro_entry_duration
    await cfg(2, [b[1], b[2], b[3], b[4], b[5], b[6], b[17], b[18], b[19], b[20], b[21], b[22], 0, b[24]]);
    await cfg(7); // PERSIST_CONFIG
    let rc = -1;
    for (let i = 0; i < 50 && rc < 0; i++) {
      await sleep(100);
      const r: Uint8Array = await getReport(0, 3, 100, 33).catch(() => new Uint8Array());
      if (r.length >= 2) rc = r[0] === 100 ? r[1] : r[0];
    }
    check(rc === 1, `configuration with device type 0 saved to flash (return code ${rc})`);
    // rp2040js does not emulate flash programming, so copy the image the
    // firmware built in persist_config()'s RAM buffer into flash ourselves.
    const bufAddr = parseInt(process.env.PERSIST_BUF_ADDR!, 16) - 0x20000000;
    const flashOff = parseInt(process.env.CONFIG_FLASH_OFFSET!, 16);
    mcu.flash.set(mcu.sram.subarray(bufAddr, bufAddr + 4096), flashOff);
    (await import('node:fs')).writeFileSync(process.env.SAVE_STOCK_FLASH, mcu.flash);
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('ERROR', e.message); process.exit(2); });
