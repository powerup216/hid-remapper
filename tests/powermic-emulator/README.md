# PowerMic edition emulator tests

This test runs `remapper.uf2` on the [rp2040js](https://github.com/wokwi/rp2040js) emulator and acts as the USB host. It checks:

- the device identity (0554:1001, bcdDevice 1.43, "Nuance" / "PowerMicII-NS")
- that there are exactly two HID interfaces, and that interface 1 carries the genuine 64-byte PowerMic descriptor
- that GET_REPORT and SET_REPORT on the PowerMic interface work (Input, LED output, 39-byte feature)
- the HID Remapper configurator protocol over interface 0: GET_CONFIG, the default F1–F4 mappings, ADD_MAPPING
- that a GPIO input mapped to Dictate or Custom Right produces the correct reports on endpoint 0x83, across repeated presses
- that a press and release are both delivered while the host polls only every 10 ms (the "worked once" bug)
- that synthetic Report ID 4 never appears on the keyboard interface

## Setup

```
mkdir emu && cd emu
git clone https://github.com/wokwi/rp2040js        # tested at a304c74
git -C rp2040js apply ../rp2040js-busy-endpoint.patch   # models a host that polls the IN endpoint every N ms
cp ../test-powermic.ts ../test-stock.ts .
echo '{"type":"module"}' > package.json
cat > tsconfig.json <<'EOF'
{ "compilerOptions": { "target": "es2020", "module": "NodeNext", "moduleResolution": "NodeNext",
  "outDir": "./out", "rootDir": ".", "strict": false, "skipLibCheck": true,
  "useDefineForClassFields": false, "types": [] }, "files": ["test-powermic.ts", "test-stock.ts"] }
EOF
npx tsc -p tsconfig.json      # type errors about node typings are harmless, it still emits
node out/test-powermic.js path/to/remapper.uf2
```

### Dual-chip boards (Mavercade / original board, v7)

On these boards the A chip processes inputs only on ticks sent by the B chip. Run the A-side firmware with `FAKE_B_SIDE=1` to emulate those ticks:

```
FAKE_B_SIDE=1 node out/test-powermic.js build-board/remapper_dual_a.uf2
```

### Switching to stock mode and rebooting

rp2040js does not emulate flash writes, so the test copies the image the firmware builds in RAM into the flash dump. Get the buffer address with `arm-none-eabi-nm -C remapper.elf | grep "persist_config()::buffer"`. For the Feather, the config offset is 0x7ff000.

```
SAVE_STOCK_FLASH=stock.bin PERSIST_BUF_ADDR=<addr> CONFIG_FLASH_OFFSET=7ff000 node out/test-powermic.js remapper.uf2
LOAD_FLASH=stock.bin node out/test-stock.js -
```

Set `EPLOG=1` to print endpoint 0x83 traffic with simulated timestamps. Set `TRACE=1` to print emulator progress and the firmware's UART output.
