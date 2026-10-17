#ifndef _POWERMIC_H_
#define _POWERMIC_H_

#include <stdint.h>

// Nuance PowerMic II emulation on HID interface 1.
//
// Interface 0 carries the normal HID Remapper keyboard/mouse/consumer
// descriptor plus a synthetic vendor collection (Usage Page 0xFF01, Report ID
// 4) whose 14 button usages FF01:0001..FF01:000E are the mapping targets for
// PowerMic buttons 1..14. Report ID 4 is never sent on interface 0; main.cc
// hands it to powermic_queue_from_synthetic(), which turns it into the genuine
// 3-byte PowerMic report and sends it on interface 1.
//
// Wire format on interface 1 (no report ID):
//   byte 0: constant padding (always 0)
//   byte 1: buttons 1..8
//   byte 2: buttons 9..14 in bits 0..5, bits 6..7 padding
//
//   Button 1  Transcribe       00 01 00     Button 6  Fast Forward    00 20 00
//   Button 2  Previous Field   00 02 00     Button 7  Stop/Play       00 40 00
//   Button 3  Dictate          00 04 00     Button 8  Custom Left     00 80 00
//   Button 4  Next Field       00 08 00     Button 9  Enter/Select    00 00 01
//   Button 5  Rewind           00 10 00     Button 10 Custom Right    00 00 02

#define POWERMIC_SYNTHETIC_REPORT_ID 4
#define POWERMIC_REPORT_LEN 3
#define POWERMIC_FEATURE_LEN 39

extern const uint8_t powermic_report_descriptor[];
extern const uint16_t powermic_report_descriptor_length;

// Called with the internal [ID 4][buttons 1-8][buttons 9-14] report.
void powermic_queue_from_synthetic(const uint8_t* report_with_id, uint8_t len);

// Called every main loop iteration; sends queued reports when interface 1 is ready.
void powermic_task();

// Drop any pending reports and return to "nothing pressed" (on mount/unmount).
void powermic_reset();

uint16_t powermic_get_report(uint8_t report_id, uint8_t report_type, uint8_t* buffer, uint16_t reqlen);
void powermic_set_report(uint8_t report_id, uint8_t report_type, const uint8_t* buffer, uint16_t bufsize);

#endif
