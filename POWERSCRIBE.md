# HID Remapper: PowerMic edition

This fork of [HID Remapper](https://github.com/jfedor2/hid-remapper) (based on r2026-05-25) adds a seventh **emulated device type: "Mouse and keyboard + PowerMic II (PowerScribe)"**.

In that mode the remapper passes your keyboard and mouse through as normal and also presents itself to the PC as a Nuance PowerMic II. Any key, mouse button or GPIO input can be mapped to a PowerMic button. PowerScribe receives those buttons through its PowerMic driver, so dictation works without PowerScribe being the focused window. Dictation audio comes from your usual microphone; this device only provides the buttons.

The other six device types behave exactly like stock HID Remapper.

## Which firmware file

It works on every board HID Remapper supports. The Mavercade HID Remapper is the MeisterConverter board.

| Board | File |
|---|---|
| Mavercade HID Remapper (MeisterConverter) | `remapper_meisterconverter.uf2` |
| HID Remapper board (original dual-chip board) | `remapper_board.uf2` |
| HID Remapper board v7 | `remapper_board_v7.uf2` |
| HID Remapper board v8 | `remapper_board_v8.uf2` |
| Adafruit Feather RP2040 USB Host | `remapper_feather.uf2` |

Flash it the usual way: hold the button on the board while plugging it in, then copy the UF2 to the drive that appears. For the dual-chip boards, the combined file also updates the second chip.

## Configuring

Use this fork's web configurator (published to GitHub Pages from `config-tool-web/`):

1. Open the configurator in Chrome or Edge and click **Open device**.
2. In **Settings**, set **Emulated device type** to **Mouse and keyboard + PowerMic II (PowerScribe)**.
3. In **Mappings**, add mappings. The output picker has a PowerMic section ("PowerMic Dictate (Record)" and so on).
4. Click **Save to device**, then unplug and replug the remapper so it re-connects as a PowerMic.

**Examples** has two ready-made PowerScribe setups: F1–F4, and mouse back/forward/middle buttons.

The stock configurator at remapper.org also works, but it doesn't offer device type 6 in its list and shows the PowerMic targets as raw codes (`0xff010003`).

### Fresh boards

A board with no saved configuration starts in PowerMic mode with these mappings:

| Key | Target |
|---|---|
| F1 | PowerMic Previous Field |
| F2 | PowerMic Dictate |
| F3 | PowerMic Next Field |
| F4 | PowerMic Custom Left |

A saved configuration always takes precedence.

## PowerMic buttons

| Target usage | Button | Report sent to PowerScribe |
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

## How the PowerMic mode works

The USB device always has two HID interfaces. No third interface is added.

| | Interface 0 | Interface 1 |
|---|---|---|
| Stock modes 0–5 | Emulated device | HID Remapper configuration (stock) |
| PowerMic mode 6 | Keyboard/mouse + synthetic PowerMic targets (Report ID 4) + configuration collection (Report IDs 100/101) | Genuine 64-byte PowerMic II descriptor, 10 ms endpoint |

In mode 6 the device uses VID 0x0554, PID 0x1001, bcdDevice 1.43, "Nuance" / "PowerMicII-NS", matching a real PowerMic II.

1. A mapping sets bit n of the internal Report ID 4, which is never sent on interface 0.
2. `do_send_report()` hands it to `powermic.cc`, which converts it to the 3-byte PowerMic report and queues it.
3. `powermic_task()` sends queued reports on interface 1 only when the endpoint is free, so a press or release is never lost. A lost release was why an earlier build "worked once": PowerScribe saw Dictate held down forever.
4. GET_REPORT and SET_REPORT on interface 1 (input, LED output, 39-byte feature) are answered the way a real handset answers them.

Each top-level HID collection is its own device on the host. The configurator therefore finds the configuration collection on interface 0 in mode 6 and on interface 1 in the stock modes, with no change on its side.

## Building

```
git submodule update --init
cd firmware
mkdir build-board && cd build-board
PICO_BOARD=meisterconverter cmake ..  # or remapper, remapper_v7, remapper_v8, feather_host
make remapper                         # dual-chip boards (remapper, remapper_v7): make remapper_dual_combined
```

The dual-chip build needs `srec_cat` (Debian/Ubuntu package `srecord`).

Pushing a tag that starts with `r` (for example `r2026-10-17-powermic`) runs the release workflow, which builds every board and attaches the UF2 files to a GitHub Release.

## Tests

`tests/powermic-emulator/` runs the firmware on the rp2040js emulator with a scripted USB host. It checks:

- PowerMic identity and descriptors
- the configurator over interface 0
- PowerMic button reports, including a release that happens while the previous report is still in flight
- switching back to stock mode, saving, and rebooting
- keyboard passthrough in stock mode
- the dual-chip A side, with emulated B-side ticks
