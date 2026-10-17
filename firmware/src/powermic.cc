#include <string.h>

#include <tusb.h>

#include "powermic.h"

// Verbatim 64-byte report descriptor of a genuine PowerMic II (VID 0x0554,
// PID 0x1001, HID interface), as captured with USBPcap. This is the same
// descriptor the working Tartarus "pmtest" build presented.
const uint8_t powermic_report_descriptor[] = {
    0x05, 0x01,        // Usage Page (Generic Desktop)
    0x09, 0x00,        // Usage (Undefined)
    0xA1, 0x01,        // Collection (Application)
    0x05, 0x08,        //   Usage Page (LED)
    0x09, 0x4B,        //   Usage (Generic Indicator)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x01,        //   Logical Maximum (1)
    0x95, 0x08,        //   Report Count (8)
    0x75, 0x01,        //   Report Size (1)
    0x91, 0x02,        //   Output (Data,Var,Abs)          -- LED byte
    0x05, 0x09,        //   Usage Page (Button)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x01,        //   Logical Maximum (1)
    0x75, 0x01,        //   Report Size (1)
    0x95, 0x08,        //   Report Count (8)
    0x81, 0x01,        //   Input (Const)                  -- byte 0 padding
    0x19, 0x01,        //   Usage Minimum (Button 1)
    0x29, 0x0E,        //   Usage Maximum (Button 14)
    0x15, 0x00,        //   Logical Minimum (0)
    0x25, 0x01,        //   Logical Maximum (1)
    0x95, 0x0E,        //   Report Count (14)
    0x81, 0x02,        //   Input (Data,Var,Abs)           -- buttons 1..14
    0x95, 0x02,        //   Report Count (2)
    0x81, 0x01,        //   Input (Const)                  -- 2 bits padding
    0x05, 0xFF,        //   Usage Page (0xFF)
    0x09, 0x00,        //   Usage (0)
    0x15, 0x00,        //   Logical Minimum (0)
    0x26, 0xFF, 0x00,  //   Logical Maximum (255)
    0x75, 0x08,        //   Report Size (8)
    0x95, 0x27,        //   Report Count (39)
    0xB1, 0x00,        //   Feature (Data,Array,Abs)       -- vendor feature
    0xC0,              // End Collection
};

const uint16_t powermic_report_descriptor_length = sizeof(powermic_report_descriptor);

static_assert(sizeof(powermic_report_descriptor) == 64, "PowerMic II report descriptor is 64 bytes");

// Every state change is queued, so a press and its release can never be
// collapsed or lost while interface 1 is still busy with the previous report.
// The original build called tud_hid_n_report() without checking whether the
// endpoint was free and discarded the report if it was not; a lost release
// leaves PowerScribe believing the button is still held, after which further
// presses do nothing.
#define PM_QUEUE_LEN 32

static uint8_t pm_queue[PM_QUEUE_LEN][POWERMIC_REPORT_LEN];
static uint8_t pm_head = 0;
static uint8_t pm_count = 0;

// Last state queued (what the host will see once the queue drains).
static uint8_t pm_last_queued[POWERMIC_REPORT_LEN] = { 0, 0, 0 };
// Last state actually handed to the USB stack (answer for GET_REPORT(Input)).
static uint8_t pm_last_sent[POWERMIC_REPORT_LEN] = { 0, 0, 0 };

static uint8_t pm_led_state = 0;
static uint8_t pm_feature[POWERMIC_FEATURE_LEN] = { 0 };

void powermic_reset() {
    pm_head = 0;
    pm_count = 0;
    memset(pm_last_queued, 0, sizeof(pm_last_queued));
    memset(pm_last_sent, 0, sizeof(pm_last_sent));
}

static void pm_enqueue(const uint8_t* report) {
    if (memcmp(report, pm_last_queued, POWERMIC_REPORT_LEN) == 0) {
        return;
    }
    if (pm_count == PM_QUEUE_LEN) {
        // Queue full (host not polling). Replace the newest entry so the final
        // state is still correct when the host comes back.
        uint8_t newest = (pm_head + pm_count - 1) % PM_QUEUE_LEN;
        memcpy(pm_queue[newest], report, POWERMIC_REPORT_LEN);
    } else {
        uint8_t tail = (pm_head + pm_count) % PM_QUEUE_LEN;
        memcpy(pm_queue[tail], report, POWERMIC_REPORT_LEN);
        pm_count++;
    }
    memcpy(pm_last_queued, report, POWERMIC_REPORT_LEN);
}

void powermic_queue_from_synthetic(const uint8_t* report_with_id, uint8_t len) {
    // Synthetic report: [4][buttons 1-8][buttons 9-14 in bits 0..5, 2 pad bits]
    uint8_t report[POWERMIC_REPORT_LEN] = {
        0x00,
        (uint8_t) ((len >= 2) ? report_with_id[1] : 0),
        (uint8_t) ((len >= 3) ? (report_with_id[2] & 0x3F) : 0),
    };
    pm_enqueue(report);
}

void powermic_task() {
    if (pm_count == 0) {
        return;
    }
    if (!tud_mounted()) {
        return;
    }
    if (tud_suspended()) {
        // A PowerMic button press should wake the host, like a key press does.
        if (pm_queue[pm_head][1] | pm_queue[pm_head][2]) {
            tud_remote_wakeup();
        }
        return;
    }
    if (!tud_hid_n_ready(1)) {
        return;
    }
    if (tud_hid_n_report(1, 0, pm_queue[pm_head], POWERMIC_REPORT_LEN)) {
        memcpy(pm_last_sent, pm_queue[pm_head], POWERMIC_REPORT_LEN);
        pm_head = (pm_head + 1) % PM_QUEUE_LEN;
        pm_count--;
    }
}

// The original build returned 0 (STALL) for every GET_REPORT on interface 1.
// A real PowerMic answers these, so we do too.
uint16_t powermic_get_report(uint8_t report_id, uint8_t report_type, uint8_t* buffer, uint16_t reqlen) {
    switch (report_type) {
        case HID_REPORT_TYPE_INPUT: {
            uint16_t n = (reqlen < POWERMIC_REPORT_LEN) ? reqlen : POWERMIC_REPORT_LEN;
            memcpy(buffer, pm_last_sent, n);
            return n;
        }
        case HID_REPORT_TYPE_OUTPUT:
            if (reqlen >= 1) {
                buffer[0] = pm_led_state;
                return 1;
            }
            return 0;
        case HID_REPORT_TYPE_FEATURE: {
            uint16_t n = (reqlen < POWERMIC_FEATURE_LEN) ? reqlen : POWERMIC_FEATURE_LEN;
            memcpy(buffer, pm_feature, n);
            return n;
        }
        default:
            return 0;
    }
}

void powermic_set_report(uint8_t report_id, uint8_t report_type, const uint8_t* buffer, uint16_t bufsize) {
    switch (report_type) {
        case HID_REPORT_TYPE_INVALID:  // interrupt OUT (not used, no OUT endpoint)
        case HID_REPORT_TYPE_OUTPUT:
            if (bufsize >= 1) {
                // PowerScribe drives the handset LEDs (record indicator) here.
                pm_led_state = buffer[0];
            }
            break;
        case HID_REPORT_TYPE_FEATURE: {
            uint16_t n = (bufsize < POWERMIC_FEATURE_LEN) ? bufsize : POWERMIC_FEATURE_LEN;
            memcpy(pm_feature, buffer, n);
            break;
        }
        default:
            break;
    }
}
