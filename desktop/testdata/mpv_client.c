// 隔离测试库，仅实现已使用的公开 C ABI，不模拟真实解码或发声。
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
#include <stdio.h>

#ifndef TEST_API_VERSION
#define TEST_API_VERSION ((2UL << 16) | 6)
#endif

typedef struct { union { char *string; int flag; int64_t integer; double number; void *list; } u; int format; } node;
typedef struct { int count; node *values; char **keys; } node_list;
typedef struct { int id; int error; uint64_t reply; void *data; } event;
typedef struct { int reason; int error; int64_t entry; int64_t insert_id; int inserts; } end_event;
_Static_assert(sizeof(node) == 16, "node ABI");
_Static_assert(offsetof(node_list, values) == 8, "list ABI");
_Static_assert(sizeof(event) == 24, "event ABI");
_Static_assert(sizeof(end_event) == 32, "end ABI");

typedef struct {
    int idle, paused, loaded, device_missing, fail_pause, fail_device, fail_enumerate;
    double position, volume, speed, loads, seeks, destroys;
    int64_t entry;
    int queue[32], count, cursor;
    event event_storage;
    end_event end_storage;
    char device[128], ao[128], format[128];
} handle;

unsigned long mpv_client_api_version(void) { return TEST_API_VERSION; }
void *mpv_create(void) {
    handle *h = calloc(1, sizeof(handle));
    h->idle = 1; h->paused = 1; h->speed = 1; h->volume = 100;
    strcpy(h->device, "auto"); return h;
}
int mpv_set_option_string(void *ctx, const char *name, const char *value) {
    handle *h = ctx;
    if (!strcmp(name, "pause")) h->paused = !strcmp(value, "yes");
    return 0;
}
int mpv_initialize(void *ctx) { return ctx ? 0 : -1; }
void mpv_terminate_destroy(void *ctx) { free(ctx); }
int mpv_set_property_string(void *ctx, const char *name, const char *value) {
    handle *h = ctx;
    if (!strcmp(name, "pause")) { if (h->fail_pause) return -11; h->paused = !strcmp(value, "yes"); }
    if (!strcmp(name, "volume")) h->volume = atof(value);
    if (!strcmp(name, "speed")) h->speed = atof(value);
    if (!strcmp(name, "audio-device")) { if (h->fail_device) return -11; snprintf(h->device, sizeof(h->device), "%s", value); }
    if (!strcmp(name, "ao")) snprintf(h->ao, sizeof(h->ao), "%s", value);
    if (!strcmp(name, "demuxer-lavf-format")) snprintf(h->format, sizeof(h->format), "%s", value);
    return 0;
}
int mpv_command(void *ctx, const char **args) {
    handle *h = ctx;
    if (!args || !args[0]) return -4;
    if (!strcmp(args[0], "stop")) { h->idle = 1; h->loaded = 0; h->queue[0] = 7; h->count = 1; h->cursor = 0; h->end_storage = (end_event){.reason = 2, .entry = h->entry}; }
    if (!strcmp(args[0], "loadfile")) {
        if (!args[1] || !args[2] || args[3]) return -4;
        h->loads++; h->entry++; h->idle = 0; h->loaded = 1;
        h->queue[0] = 6; h->queue[1] = 8; h->count = 2; h->cursor = 0;
    }
    if (!strcmp(args[0], "seek")) { h->position = atof(args[1]); h->seeks++; h->queue[0] = 20; h->queue[1] = 21; h->count = 2; h->cursor = 0; }
    return 0;
}

static node device_values[4];
static node device_maps[2];
static char *device_keys[] = {"name", "description"};
static node_list maps[2], devices;
int mpv_get_property(void *ctx, const char *name, int format, void *out) {
    handle *h = ctx;
    if (format == 3) {
        int value = !strcmp(name, "idle-active") ? h->idle : !strcmp(name, "pause") ? h->paused : 0;
        *(int *)out = value; return 0;
    }
    if (format == 5) {
        double value = 0;
        if (!strcmp(name, "time-pos")) value = h->position;
        if (!strcmp(name, "duration")) value = 10;
        if (!strcmp(name, "test-loads")) value = h->loads;
        if (!strcmp(name, "test-seeks")) value = h->seeks;
        if (!strcmp(name, "volume")) value = h->volume;
        if (!strcmp(name, "speed")) value = h->speed;
        *(double *)out = value; return 0;
    }
    if (format == 6 && !strcmp(name, "audio-device-list")) {
        if (h->fail_enumerate) return -11;
        device_values[0] = (node){.u.string="auto", .format=1};
        device_values[1] = (node){.u.string="默认", .format=1};
        device_values[2] = (node){.u.string="coreaudio/test", .format=1};
        device_values[3] = (node){.u.string="测试输出", .format=1};
        for (int i=0; i<2; i++) { maps[i] = (node_list){2, device_values+i*2, device_keys}; device_maps[i] = (node){.u.list=maps+i,.format=8}; }
        devices = (node_list){h->device_missing ? 1 : 2, device_maps, NULL};
        *(node *)out = (node){.u.list=&devices, .format=7}; return 0;
    }
    return -10;
}
void mpv_free_node_contents(node *value) { memset(value, 0, sizeof(*value)); }
#ifndef TEST_MISSING_WAIT
const event *mpv_wait_event(void *ctx, double timeout) {
    (void)timeout;
    handle *h = ctx;
    memset(&h->event_storage, 0, sizeof(event));
    if (h->cursor < h->count) {
        int id = h->queue[h->cursor++]; h->event_storage.id = id;
        if (id == 6) h->event_storage.data = &h->entry;
        if (id == 7) h->event_storage.data = &h->end_storage;
    }
    return &h->event_storage;
}
#endif
void test_mpv_flags(void *ctx, int missing, int pause, int device, int enumerate) {
    handle *h=ctx; h->device_missing=missing; h->fail_pause=pause; h->fail_device=device; h->fail_enumerate=enumerate;
}
void test_mpv_end(void *ctx, int reason, int64_t entry) {
    handle *h=ctx; h->queue[0]=7; h->count=1; h->cursor=0;
    h->end_storage=(end_event){.reason=reason,.entry=entry};
}
