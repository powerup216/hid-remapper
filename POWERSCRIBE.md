# HID Remapper: PowerMic II edition (Adafruit Feather RP2040 USB Host)

This is HID Remapper r2026-05-25. It passes your keyboard and mouse through as normal and also presents itself to the PC as a Nuance PowerMic II. Any key, mouse button or GPIO input can be mapped to a PowerMic button. Those buttons reach PowerScribe through its PowerMic driver, so dictation works even when PowerScribe is not the focused window.

Build target: `PICO_BOARD=feather_host`.

## USB architecture (unchanged: two HID interfaces)

| | Interface 0 | Interface 1 |
|---|---|---|
| Purpose | Keyboard, mouse, consumer passthrough, plus HID Remapper configuration | PowerMic II buttons |
| Report descriptor | HID Remapper keyboard/mouse descriptor + synthetic PowerMic targets (Report ID 4) + config collections (Report IDs 100/101) | Genuine 64-byte PowerMic II descriptor, verbatim |
| Endpoint | 0x81, 1 ms | 0x83, 10 ms |

Device identity: VID `0x0554`, PID `0x1001`, bcdDevice `0x0143`, manufacturer "Nuance", product "PowerMicII-NS". These match the genuine handset and the Tartarus `pmtest` build that worked with PowerScribe.

No third interface was added.

## How a PowerMic button travels

1. A mapping targets `0xFF01000n`, where n is the PowerMic button number.
2. HID Remapper sets that bit in the internal Report ID 4. That report is never sent on interface 0.
3. `do_send_report()` hands it to `powermic.cc`, which converts it to the 3-byte PowerMic report `[00][buttons 1-8][buttons 9-14]` and queues it.
4. `powermic_task()` sends queued reports on interface 1 only when the endpoint is free, so no press or release is ever dropped.

| Target usage | PowerMic button | Wire report |
|---|---|---|
| 0xFF010001 | Transcribe | 00 01 00 |
| 0xFF010002 | Previous Field | 00 02 00 |
| 0xFF010003 | Dictate | 00 04 00 |
| 0xFF010004 | Next Field | 00 08 00 |
| 0xFF010005 | Rewind | 00 10 00 |
| 0xFF010006 | Fast Forward | 00 20 00 |
| 0xFF010007 | Stop/Play | 00 40 00 |
| 0xFF010008 | Custom Left | 00 80 00 |
| 0xFF010009 | Enter/Select | 00 00 01 |
| 0xFF01000A | Custom Right | 00 00 02 |
| 0xFF01000B–E | Buttons 11–14 | 00 00 04 … 00 00 20 |

## Default mappings (fresh board only)

If no valid configuration is saved in flash, these mappings are used. A saved configuration always takes precedence.

| Key | Usage | Target |
|---|---|---|
| F1 | 0x0007003A | 0xFF010002 Previous Field |
| F2 | 0x0007003B | 0xFF010003 Dictate |
| F3 | 0x0007003C | 0xFF010004 Next Field |
| F4 | 0x0007003D | 0xFF010008 Custom Left |

## Configuring

No separate configuration firmware is needed any more. The configuration collection now sits on interface 0, so the standard web configurator talks to the running PowerMic firmware:

1. Open https://www.remapper.xyz/ in Chrome or Edge and click **Open device**. Pick the entry for the HID Remapper configuration interface.
2. Add mappings as normal. In the target list, the PowerMic buttons appear as `0xff010001` to `0xff01000e` (use the table above). The copy of the configurator in `config-tool-web/` shows them by name instead ("PowerMic: Dictate (Record)" and so on).
3. Click **Save to device**.

The input monitor on the configurator page also works.

Only the two keyboard/mouse emulation modes are supported. The gamepad modes change the VID/PID, which would drop the PowerMic identity. If one of them is selected, the firmware falls back to keyboard/mouse.

## Fixes compared with the earlier build (commit 6f372f9)

The earlier build worked once and then stopped. These are the defects found and fixed:

1. **Lost button releases.** The PowerMic report was sent with `tud_hid_n_report()` without checking whether interface 1 was ready, and a failed send was silently discarded. If a release was lost, PowerScribe saw Dictate held down forever and ignored every later press. This was reproduced in an RP2040 emulator with a 10 ms host poll: the original logic delivered `00 04 00` and dropped the following `00 00 00`, and nothing reached the host after that. Reports are now queued and sent only when the endpoint is free.
2. **Configuration mappings disappearing.** The mappings could only be changed by flashing a separate configuration firmware. A configuration saved from firmware that does not know the PowerMic targets replaces the PowerMic defaults, so the PowerMic mappings vanish. The configurator now works on the PowerMic firmware itself.
3. **Stalled requests on the PowerMic interface.** Every GET_REPORT on interface 1 was answered with a STALL. Input, Output (LED) and the 39-byte Feature report are now answered the way a real handset answers them, and LED/feature writes from PowerScribe are accepted.
4. **Altered PowerMic descriptor.** The descriptor had been edited to declare 11 buttons instead of the genuine 14. The verbatim 64-byte descriptor is restored, and the synthetic targets cover all 14 buttons.
5. **USB identity.** bcdDevice and the manufacturer/product strings now match the genuine PowerMic II (they were "RP2040" / "HID Remapper XXXX").

## Building

```
cd firmware
mkdir build && cd build
cmake -G Ninja -DPICO_BOARD=feather_host ..
ninja remapper
# -> remapper.uf2
```

## Testing without hardware

`tests/powermic-emulator/` contains a scripted USB host for the rp2040js emulator. It enumerates the firmware, checks the descriptors and identity, drives the configurator protocol over interface 0, maps GPIO inputs to PowerMic buttons, and checks the reports that arrive on endpoint 0x83, including the busy-endpoint case above. See the README in that folder.

## Files changed

- `firmware/src/powermic.cc`, `powermic.h` (new): descriptor, report queue, GET/SET_REPORT handling
- `firmware/src/main.cc`: hands Report ID 4 to the PowerMic queue, routes the monitor through interface 0, limits modes to keyboard/mouse
- `firmware/src/tinyusb_stuff.cc`: USB identity, interface 0 descriptor plus config collection, report routing
- `firmware/src/our_descriptor.cc`: 14-button synthetic PowerMic targets, also added to the absolute-mouse mode
- `firmware/CMakeLists.txt`: adds `powermic.cc`
- `config-tool-web/usages.js`: PowerMic target names
