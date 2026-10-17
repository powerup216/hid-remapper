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
if (process.env.LOAD_FLASH) mcu.flash.set(readFileSync(process.env.LOAD_FLASH));
const uf2 = process.env.LOAD_FLASH ? Buffer.alloc(0) : readFileSync(uf2Path);
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
async function main() {
  writeSync(2, `flash@7fe000=${hex(mcu.flash.subarray(0x7fe000,0x7fe008))} via bus=${[0,1,2,3].map(i=>mcu.readUint8(0x107fe000+i).toString(16)).join(' ')} flashlen=${mcu.flash.length}\n`);
  mcu.gpio[5].setInputValue(true);
  mcu.core.PC = 0x10000000;
  sim.execute();
  await resetPromise;
  await control([0x00, 5, 1, 0, 0, 0, 0, 0], 'none', 0, 'SET_ADDRESS');
  const dev: Uint8Array = await getDesc(1, 0, 18);
  const dv = new DataView(dev.buffer, dev.byteOffset);
  const vid = dv.getUint16(8, true), pid = dv.getUint16(10, true), bcd = dv.getUint16(12, true);
  writeSync(2, `our_descriptor_number=${mcu.sram[0x2771b]} our_descriptor=${(mcu.sram[0x25b94]|mcu.sram[0x25b95]<<8|mcu.sram[0x25b96]<<16|mcu.sram[0x25b97]<<24).toString(16)}\n`);
  console.log(`device: VID ${vid.toString(16)} PID ${pid.toString(16)} bcdDevice ${bcd.toString(16)}`);
  check(vid === 0xcafe && pid === 0xbaf2 && bcd === 0x0100, 'stock mode: stock HID Remapper identity (cafe:baf2, 1.00)');
  const mfr = utf16(await getDesc(3, dev[14], 255, 0x0409));
  const prod = utf16(await getDesc(3, dev[15], 255, 0x0409));
  console.log(`strings: "${mfr}" / "${prod}"`);
  check(prod.startsWith('HID Remapper '), 'stock mode: stock product string');
  const cfgHead: Uint8Array = await getDesc(2, 0, 9);
  const conf: Uint8Array = await getDesc(2, 0, cfgHead[2] | (cfgHead[3] << 8));
  const itfs: any[] = [];
  for (let i = 0; i < conf.length; i += conf[i]) {
    if (conf[i + 1] === 4) itfs.push({ n: conf[i + 2] });
    if (conf[i + 1] === 0x21) itfs[itfs.length - 1].rdlen = conf[i + 7] | (conf[i + 8] << 8);
    if (conf[i + 1] === 5) Object.assign(itfs[itfs.length - 1], { ep: conf[i + 2], interval: conf[i + 6] });
  }
  console.log('interfaces:', JSON.stringify(itfs));
  await control([0x00, 9, 1, 0, 0, 0, 0, 0], 'none', 0, 'SET_CONFIGURATION');
  const rd0: Uint8Array = await getDesc(0x22, 0, itfs[0].rdlen, 0, 0x81);
  const rd1: Uint8Array = await getDesc(0x22, 0, itfs[1].rdlen, 1, 0x81);
  check(hex(rd1).startsWith('06 00 ff 09 20 a1 01') && itfs[1].interval === 1, 'stock mode: interface 1 is the stock config interface');
  check(!hex(rd0).includes('06 01 ff') && !hex(rd0).includes('06 00 ff'), 'stock mode: interface 0 is the plain stock descriptor (no PowerMic, no config)');
  // configurator on interface 1, as upstream
  const p = cfgPacket(3);
  await setReport(1, 3, 100, p);
  const r: Uint8Array = await getReport(1, 3, 100, 33);
  const body = r[0] === 100 ? r.subarray(1) : r;
  check(body[0] === CONFIG_VERSION && body[23] === 0, `stock mode: configurator on interface 1, device type 0 [type ${body[23]}]`);
  // map GPIO5 -> keyboard A, expect a keyboard report on EP1
  const sendCfg = async (cmd: number, data: number[] = []) => setReport(1, 3, 100, cfgPacket(cmd, data));
  await sendCfg(10);
  await sendCfg(5, [...u32(0x00070004), ...u32(0xfff40005), ...u32(1000), 0x01, 0, 0]);
  await sendCfg(11);
  await sleep(300);
  epData[1] = [];
  mcu.gpio[5].setInputValue(false);
  let got = '';
  for (let i = 0; i < 5 && !got; i++) { const b = await readEp(1).catch(() => null); if (b) writeSync(2, `  ep1: ${hex(b)}\n`); if (b && b[0] === 2 && Array.from(b).slice(1).some((x) => x !== 0)) got = hex(b); }
  mcu.gpio[5].setInputValue(true);
  check(got !== '', `stock mode: keyboard passthrough works (EP1 report ${got.slice(0, 26)}...)`);
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('ERROR', e.message); process.exit(2); });
