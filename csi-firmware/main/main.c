/* ESP-WebSDR CSI sensor: Wi-Fi channel state information over USB.
 *
 * One firmware, two roles chosen at run time over the USB Serial/JTAG console:
 *   RX  - promiscuous receiver that reports CSI for every OFDM frame it hears,
 *         optionally only from one transmitter MAC;
 *   TX  - illuminator that broadcasts short ESP-NOW frames at a fixed rate as
 *         HT20 MCS0 (OFDM), so a receiver gets CSI at a known packet rate.
 * CSI lines use Espressif esp-csi's CSV layout so existing tools parse them.
 *
 * Commands (one per line):  INFO | CH <1-13> | RX [mac] | TX <hz> | STOP
 */
#include <inttypes.h>
#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "driver/usb_serial_jtag_vfs.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_now.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#define CSI_MAX 384
#define QUEUE_LEN 32

typedef struct {
    wifi_pkt_rx_ctrl_t rx;
    uint8_t mac[6];
    bool first_invalid;
    uint16_t len;
    uint32_t seq;
    int8_t buf[CSI_MAX];
} csi_item_t;

static QueueHandle_t csi_queue;
static volatile bool rx_on, tx_on;
static volatile uint32_t tx_hz = 100, dropped;
static uint8_t filter_mac[6];
static bool filter_on;
static uint8_t channel = 6;
static uint32_t rx_seq;
static const uint8_t broadcast[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};

static void reply(const char *s)
{
    fputs(s, stdout);
    fflush(stdout);
}

/* Wi-Fi task context: copy and hand off; printing happens in csi_task. */
static void csi_cb(void *ctx, wifi_csi_info_t *info)
{
    if (!rx_on || !info || !info->buf) return;
    if (filter_on && memcmp(info->mac, filter_mac, 6)) return;
    csi_item_t item;
    item.rx = info->rx_ctrl;
    memcpy(item.mac, info->mac, 6);
    item.first_invalid = info->first_word_invalid;
    item.len = info->len > CSI_MAX ? CSI_MAX : info->len;
    item.seq = rx_seq++;
    memcpy(item.buf, info->buf, item.len);
    if (xQueueSend(csi_queue, &item, 0) != pdTRUE) dropped++;
}

static void csi_task(void *arg)
{
    static csi_item_t item;
    static char line[CSI_MAX * 5 + 256];
    for (;;) {
        if (xQueueReceive(csi_queue, &item, portMAX_DELAY) != pdTRUE) continue;
        const wifi_pkt_rx_ctrl_t *r = &item.rx;
        int n = snprintf(line, sizeof(line),
                         "CSI_DATA,%" PRIu32 "," MACSTR ",%d,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%d,%u,%u,%u,%u,%u,%u,%u,%u,%d,\"[",
                         item.seq, MAC2STR(item.mac), r->rssi, r->rate, r->sig_mode, r->mcs, r->cwb, r->smoothing,
                         r->not_sounding, r->aggregation, r->stbc, r->fec_coding, r->sgi, r->noise_floor,
                         r->ampdu_cnt, r->channel, r->secondary_channel, (unsigned)r->timestamp, r->ant, r->sig_len,
                         r->rx_state, item.len, item.first_invalid);
        for (int i = 0; i < item.len && n < (int)sizeof(line) - 8; i++)
            n += snprintf(line + n, sizeof(line) - n, i ? ",%d" : "%d", item.buf[i]);
        n += snprintf(line + n, sizeof(line) - n, "]\"\n");
        fwrite(line, 1, n, stdout);
    }
}

static void tx_task(void *arg)
{
    uint8_t payload[16] = {'E', 'S', 'P', 'W', 'S', 'D', 'R'};
    uint32_t seq = 0;
    int64_t next = esp_timer_get_time();
    for (;;) {
        if (!tx_on) {
            vTaskDelay(pdMS_TO_TICKS(20));
            next = esp_timer_get_time();
            continue;
        }
        memcpy(payload + 8, &seq, 4);
        seq++;
        esp_now_send(broadcast, payload, sizeof(payload));
        next += 1000000 / tx_hz;
        int64_t wait = next - esp_timer_get_time();
        if (wait > 1000) vTaskDelay(pdMS_TO_TICKS(wait / 1000));
        else if (wait < -100000) next = esp_timer_get_time();
    }
}

static bool parse_mac(const char *s, uint8_t mac[6])
{
    unsigned v[6];
    if (sscanf(s, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) return false;
    for (int i = 0; i < 6; i++) {
        if (v[i] > 255) return false;
        mac[i] = v[i];
    }
    return true;
}

static void set_channel(uint8_t ch)
{
    channel = ch;
    ESP_ERROR_CHECK(esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE));
}

static void command(char *line)
{
    char h[96];
    unsigned v;
    if (!strcmp(line, "INFO")) {
        uint8_t mac[6];
        esp_wifi_get_mac(WIFI_IF_STA, mac);
        snprintf(h, sizeof(h), "CSI 1 esp32s3 " MACSTR " ch %u rx %d tx %d hz %" PRIu32 " dropped %" PRIu32 "\n",
                 MAC2STR(mac), channel, rx_on, tx_on, tx_hz, dropped);
        reply(h);
    } else if (sscanf(line, "CH %u", &v) == 1 && v >= 1 && v <= 13) {
        set_channel(v);
        reply("OK\n");
    } else if (!strcmp(line, "RX")) {
        filter_on = false;
        rx_on = true;
        reply("OK\n");
    } else if (!strncmp(line, "RX ", 3)) {
        if (!parse_mac(line + 3, filter_mac)) {
            reply("ERR args\n");
            return;
        }
        filter_on = true;
        rx_on = true;
        reply("OK\n");
    } else if (sscanf(line, "TX %u", &v) == 1 && v >= 1 && v <= 1000) {
        tx_hz = v;
        tx_on = true;
        reply("OK\n");
    } else if (!strcmp(line, "STOP")) {
        rx_on = tx_on = false;
        xQueueReset(csi_queue);
        reply("OK\n");
    } else if (line[0]) {
        reply("ERR command\n");
    }
}

static void wifi_init(void)
{
    esp_err_t e = nvs_flash_init();
    if (e == ESP_ERR_NVS_NO_FREE_PAGES || e == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ESP_ERROR_CHECK(nvs_flash_init());
    }
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    ESP_ERROR_CHECK(esp_wifi_start());
    set_channel(channel);

    wifi_promiscuous_filter_t filter = {.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT | WIFI_PROMIS_FILTER_MASK_DATA};
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous_filter(&filter));
    ESP_ERROR_CHECK(esp_wifi_set_promiscuous(true));

    /* Keep sub-carriers independent (no channel filter) for sensing work. */
    wifi_csi_config_t csi = {
        .lltf_en = true,
        .htltf_en = true,
        .stbc_htltf2_en = true,
        .ltf_merge_en = true,
        .channel_filter_en = false,
        .manu_scale = false,
        .shift = 0,
    };
    ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi));
    ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(csi_cb, NULL));
    ESP_ERROR_CHECK(esp_wifi_set_csi(true));

    ESP_ERROR_CHECK(esp_now_init());
    esp_now_peer_info_t peer = {.channel = 0, .ifidx = WIFI_IF_STA, .encrypt = false};
    memcpy(peer.peer_addr, broadcast, 6);
    ESP_ERROR_CHECK(esp_now_add_peer(&peer));
    esp_now_rate_config_t rate = {.phymode = WIFI_PHY_MODE_HT20, .rate = WIFI_PHY_RATE_MCS0_LGI};
    ESP_ERROR_CHECK(esp_now_set_peer_rate_config(broadcast, &rate));
}

void app_main(void)
{
    usb_serial_jtag_driver_config_t usb = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    usb.rx_buffer_size = 1024;
    usb.tx_buffer_size = 8192;
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));
    usb_serial_jtag_vfs_use_driver();
    setvbuf(stdout, NULL, _IOFBF, 4096);

    csi_queue = xQueueCreate(QUEUE_LEN, sizeof(csi_item_t));
    wifi_init();
    xTaskCreatePinnedToCore(csi_task, "csi", 6144, NULL, 5, NULL, 1);
    xTaskCreatePinnedToCore(tx_task, "tx", 3072, NULL, 5, NULL, 1);

    char line[64];
    int n = 0;
    for (;;) {
        uint8_t c;
        if (usb_serial_jtag_read_bytes(&c, 1, portMAX_DELAY) != 1) continue;
        if (c == '\r') continue;
        if (c == '\n') {
            line[n] = 0;
            command(line);
            n = 0;
        } else if (n < (int)sizeof(line) - 1) {
            line[n++] = c;
        }
    }
}
