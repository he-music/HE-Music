package nativegen

// zigSupport is the part of the generated Zig that is the same for every
// module: the types the implementation uses (Time, Rect, Buffer, Entry,
// Iterator, Closer, Context) and the runtime of the glue, with the
// standard library only.
const zigSupport = `
// Types for the implementation.

/// The allocator of what outlives a call: the C library's.
pub const allocator = std.heap.c_allocator;

/// The Io the implementation sleeps and waits with.
pub fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

/// A time: Unix seconds and nanoseconds, as a time.Time.
pub const Time = struct {
    sec: i64 = 0,
    nsec: i64 = 0,

    /// The time plus ns nanoseconds.
    pub fn add(t: Time, ns: i64) Time {
        const total = @as(i128, t.sec) * std.time.ns_per_s + t.nsec + ns;
        return .{ .sec = @intCast(@divFloor(total, std.time.ns_per_s)), .nsec = @intCast(@mod(total, std.time.ns_per_s)) };
    }
};

/// A rectangle of native UI: a ui.Rect.
pub const Rect = struct {
    x: f32 = 0,
    y: f32 = 0,
    w: f32 = 0,
    h: f32 = 0,
};

/// Memory of Go's that the implementation fills: a *native.Buffer, valid
/// during the call that takes it.
pub const Buffer = struct {
    ptr: ?[*]u8,
    len: usize,

    pub fn bytes(b: Buffer) []u8 {
        const p = b.ptr orelse return &.{};
        return p[0..b.len];
    }
};

/// An entry of a map of Go's, whose keys are strings.
pub fn Entry(comptime V: type) type {
    return struct {
        key: []const u8,
        value: V,
    };
}

/// The values a method yields, which Go asks for one at a time, on a thread
/// of their own. Make one of a pointer with of: its type has
///
///     pub fn next(self: *T, arena: Allocator) Error!?V
///
/// which returns null at the end, and may have deinit, which runs once Go
/// is done with the values, for what the method allocated with allocator.
pub fn Iterator(comptime V: type) type {
    return struct {
        ptr: *anyopaque,
        nextFn: *const fn (*anyopaque, Allocator) Error!?V,
        deinitFn: ?*const fn (*anyopaque) void,

        pub fn of(pointer: anytype) @This() {
            const T = @typeInfo(@TypeOf(pointer)).pointer.child;
            const vt = struct {
                fn vt_next(o: *anyopaque, arena: Allocator) Error!?V {
                    return @as(*T, @ptrCast(@alignCast(o))).next(arena);
                }
                fn vt_deinit(o: *anyopaque) void {
                    if (@hasDecl(T, "deinit")) @as(*T, @ptrCast(@alignCast(o))).deinit();
                }
            };
            comptime checkMethod(T, "Iterator", "next", fn (*T, Allocator) Error!?V);
            return .{ .ptr = pointer, .nextFn = vt.vt_next, .deinitFn = if (@hasDecl(T, "deinit")) vt.vt_deinit else null };
        }

        pub fn next(self: @This(), arena: Allocator) Error!?V {
            return self.nextFn(self.ptr, arena);
        }
    };
}

/// What stops what a method started, as Go's io.Closer. Make one of a
/// pointer with of: its type has
///
///     pub fn close(self: *T) Error!void
///
/// and may have deinit, which runs once Go lets go of the Closer.
pub const Closer = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        close: *const fn (*anyopaque) Error!void,
        deinit: ?*const fn (*anyopaque) void,
    };

    pub fn of(pointer: anytype) Closer {
        const T = @typeInfo(@TypeOf(pointer)).pointer.child;
        const vt = struct {
            fn vt_close(o: *anyopaque) Error!void {
                return @as(*T, @ptrCast(@alignCast(o))).close();
            }
            fn vt_deinit(o: *anyopaque) void {
                if (@hasDecl(T, "deinit")) @as(*T, @ptrCast(@alignCast(o))).deinit();
            }
            const table: VTable = .{ .close = vt_close, .deinit = if (@hasDecl(T, "deinit")) vt_deinit else null };
        };
        comptime checkMethod(T, "Closer", "close", fn (*T) Error!void);
        return .{ .ptr = pointer, .vtable = &vt.table };
    }

    pub fn close(self: Closer) Error!void {
        return self.vtable.close(self.ptr);
    }
};

/// The context of a method that takes one in Go: Go cancels it.
pub const Context = struct {
    canceled: std.atomic.Value(bool) = .init(false),

    /// Reports whether Go canceled the call.
    pub fn isCanceled(c: *Context) bool {
        return c.canceled.load(.acquire);
    }

    /// Returns error.Canceled once Go canceled the call.
    pub fn check(c: *Context) Error!void {
        if (c.isCanceled()) return error.Canceled;
    }

    /// Waits ns nanoseconds, or until Go cancels the call, which returns
    /// error.Canceled.
    pub fn sleep(c: *Context, ns: i64) Error!void {
        var left = ns;
        while (left > 0) {
            try c.check();
            const step = @min(left, 2 * std.time.ns_per_ms);
            io().sleep(.fromNanoseconds(step), .awake) catch {};
            left -= step;
        }
        try c.check();
    }
};

threadlocal var detail_domain: [256]u8 = undefined;
threadlocal var detail_domain_len: usize = 0;
threadlocal var detail_message: [1024]u8 = undefined;
threadlocal var detail_message_len: usize = 0;
threadlocal var detail_number: i64 = 0;

fn setDetail(domain: []const u8, number: i64, msg: []const u8) void {
    detail_domain_len = @min(domain.len, detail_domain.len);
    @memcpy(detail_domain[0..detail_domain_len], domain[0..detail_domain_len]);
    detail_message_len = @min(msg.len, detail_message.len);
    @memcpy(detail_message[0..detail_message_len], msg[0..detail_message_len]);
    detail_number = number;
}

/// Returns error.Other, which Go reports with the domain, number and message
/// given.
pub fn fail(domain: []const u8, number: i64, msg: []const u8) Error {
    setDetail(domain, number, msg);
    return error.Other;
}

/// Returns error.Go, which Go reports with the message given.
pub fn failGo(msg: []const u8) Error {
    setDetail("", 0, msg);
    return error.Go;
}

/// The message of the last error.Go or error.Other of this thread, as a
/// function of Go's returned it.
pub fn message() []const u8 {
    return detail_message[0..detail_message_len];
}

/// Checks at compile time that T has the method name of type Want.
pub fn checkMethod(comptime T: type, comptime iface: []const u8, comptime name: []const u8, comptime Want: type) void {
    if (!@hasDecl(T, name)) {
        @compileError(@typeName(T) ++ " implements " ++ iface ++ " without pub fn " ++ name ++ ": " ++ @typeName(Want));
    }
    const Have = @TypeOf(@field(T, name));
    if (Have != Want) {
        @compileError(@typeName(T) ++ "." ++ name ++ " is " ++ @typeName(Have) ++ ", but " ++ iface ++ " wants " ++ @typeName(Want));
    }
}

// The runtime of the glue.

const Callback = *const fn (u64, u64, i64, ?[*]const u8, usize) callconv(.c) ?[*]u8;
const Malloc = *const fn (usize) callconv(.c) ?[*]u8;
const Free = *const fn (?[*]u8) callconv(.c) void;

var runtime: struct {
    cb: ?Callback = null,
    id_base: u64 = 0,
    malloc: ?Malloc = null,
    free: ?Free = null,
} = .{};

const kind_result: u64 = 1;
const kind_item: u64 = 2;
const kind_notify: u64 = 3;
const kind_ask: u64 = 4;
const kind_release: u64 = 5;
const kind_invoke: u64 = 6;
const kind_invoke_async: u64 = 7;
const kind_cancel: u64 = 8;

const status_ok: i64 = 0;
const status_error: i64 = 1;
const status_pending: i64 = 2;
const status_end: i64 = 3;

// Values cross in a binary encoding, which package native describes, in
// the order of the declarations: every integer as 8 bytes, little-endian,
// floats as f64, bools as a byte, strings, slices and maps as their length
// then their contents, optionals as a bool then the value, structs as their
// fields, enums as their values.

/// Writes values for Go, after the 16 bytes of a block's head: its status
/// and its length.
const Writer = struct {
    b: std.ArrayList(u8) = .empty,

    fn init() Writer {
        var w: Writer = .{};
        w.b.appendNTimes(allocator, 0, 16) catch @panic("out of memory");
        return w;
    }

    fn deinit(w: *Writer) void {
        w.b.deinit(allocator);
    }

    fn reset(w: *Writer) void {
        w.b.shrinkRetainingCapacity(16);
    }

    fn data(w: *Writer) []const u8 {
        return w.b.items[16..];
    }

    fn raw(w: *Writer, v: []const u8) void {
        w.b.appendSlice(allocator, v) catch @panic("out of memory");
    }

    fn uint(w: *Writer, v: u64) void {
        var buf: [8]u8 = undefined;
        std.mem.writeInt(u64, &buf, v, .little);
        w.raw(&buf);
    }

    fn int(w: *Writer, v: i64) void {
        w.uint(@bitCast(v));
    }

    fn byte(w: *Writer, v: u8) void {
        w.raw(&.{v});
    }

    fn boolean(w: *Writer, v: bool) void {
        w.byte(@intFromBool(v));
    }

    fn float(w: *Writer, v: f64) void {
        w.uint(@bitCast(v));
    }

    fn count(w: *Writer, n: usize) void {
        w.int(@intCast(n));
    }

    fn string(w: *Writer, s: []const u8) void {
        w.count(s.len);
        w.raw(s);
    }

    fn time(w: *Writer, t: Time) void {
        w.int(t.sec);
        w.int(t.nsec);
    }

    fn rect(w: *Writer, r: Rect) void {
        w.float(r.x);
        w.float(r.y);
        w.float(r.w);
        w.float(r.h);
    }

    fn buffer(w: *Writer, b: Buffer) void {
        w.uint(@intFromPtr(b.ptr));
        w.count(b.len);
    }

    /// Gives the values to Go as a block, in memory Go frees.
    fn block(w: *Writer, status: i64) ?[*]u8 {
        const items = w.b.items;
        std.mem.writeInt(i64, items[0..8], status, .little);
        std.mem.writeInt(i64, items[8..16], @intCast(items.len - 16), .little);
        const p = runtime.malloc.?(items.len) orelse return null;
        @memcpy(p[0..items.len], items);
        return p;
    }
};

/// Reads the values Go wrote, into the arena.
const Reader = struct {
    b: []const u8,
    arena: Allocator,

    fn take(r: *Reader, n: usize) Error![]const u8 {
        if (n > r.b.len) return failGo("a value from Go ends early");
        const v = r.b[0..n];
        r.b = r.b[n..];
        return v;
    }

    fn uint(r: *Reader) Error!u64 {
        return std.mem.readInt(u64, (try r.take(8))[0..8], .little);
    }

    fn int(r: *Reader) Error!i64 {
        return @bitCast(try r.uint());
    }

    fn byte(r: *Reader) Error!u8 {
        return (try r.take(1))[0];
    }

    fn boolean(r: *Reader) Error!bool {
        return try r.byte() != 0;
    }

    fn float(r: *Reader) Error!f64 {
        return @bitCast(try r.uint());
    }

    /// Reads the length of a slice or a map, whose elements take a byte
    /// each at least.
    fn count(r: *Reader) Error!usize {
        const n = try r.int();
        if (n < 0 or n > r.b.len) return failGo("a value from Go ends early");
        return @intCast(n);
    }

    fn string(r: *Reader) Error![]const u8 {
        return r.arena.dupe(u8, try r.take(try r.count()));
    }

    fn time(r: *Reader) Error!Time {
        return .{ .sec = try r.int(), .nsec = try r.int() };
    }

    fn rect(r: *Reader) Error!Rect {
        return .{
            .x = @floatCast(try r.float()),
            .y = @floatCast(try r.float()),
            .w = @floatCast(try r.float()),
            .h = @floatCast(try r.float()),
        };
    }

    fn buffer(r: *Reader) Error!Buffer {
        const p = try r.uint();
        const n = try r.int();
        return .{ .ptr = @ptrFromInt(p), .len = @intCast(@max(n, 0)) };
    }
};

fn bytesOf(p: ?[*]const u8, n: usize) []const u8 {
    const q = p orelse return &.{};
    return q[0..n];
}

// The kinds of errors, as they cross both ways: the kind, then the code,
// domain, number and message.
const err_other: u8 = 0;
const err_code: u8 = 1;
const err_unsupported: u8 = 2;
const err_closed: u8 = 3;
const err_canceled: u8 = 4;
const err_go: u8 = 5;

fn writeError(w: *Writer, e: Error) void {
    var kind = err_other;
    var code: []const u8 = "";
    var domain: []const u8 = "";
    var msg: []const u8 = "";
    var number: i64 = 0;
    if (errorCode(e)) |c| {
        kind = err_code;
        code = c;
    } else switch (e) {
        error.Unsupported => kind = err_unsupported,
        error.Closed => kind = err_closed,
        error.Canceled => kind = err_canceled,
        error.Go => {
            kind = err_go;
            msg = message();
        },
        error.OutOfMemory => msg = "out of memory",
        else => {
            domain = detail_domain[0..detail_domain_len];
            number = detail_number;
            msg = message();
        },
    }
    w.byte(kind);
    w.string(code);
    w.string(domain);
    w.int(number);
    w.string(msg);
}

fn readError(r: *Reader) Error {
    const kind = r.byte() catch return failGo("an error of Go's that does not decode");
    const code = r.string() catch return failGo("an error of Go's that does not decode");
    const domain = r.string() catch return failGo("an error of Go's that does not decode");
    const number = r.int() catch return failGo("an error of Go's that does not decode");
    const msg = r.string() catch return failGo("an error of Go's that does not decode");
    return switch (kind) {
        err_code => errorOfCode(code) orelse failGo(msg),
        err_unsupported => error.Unsupported,
        err_closed => error.Closed,
        err_canceled => error.Canceled,
        err_other => if (domain.len > 0) fail(domain, number, msg) else failGo(msg),
        else => failGo(msg),
    };
}

const Body = fn (arena: Allocator, w: *Writer, h: u64, a: *Reader) Error!void;

/// Runs what returns at once, which writes its result to the writer.
fn run(h: u64, args: ?[*]const u8, n: usize, comptime body: Body) ?[*]u8 {
    var state = std.heap.ArenaAllocator.init(allocator);
    defer state.deinit();
    var w = Writer.init();
    defer w.deinit();
    var r: Reader = .{ .b = bytesOf(args, n), .arena = state.allocator() };
    body(state.allocator(), &w, h, &r) catch |e| {
        w.reset();
        writeError(&w, e);
        return w.block(status_error);
    };
    return w.block(status_ok);
}

/// The answer of a call that failed to start.
fn failed(e: Error) ?[*]u8 {
    var w = Writer.init();
    defer w.deinit();
    writeError(&w, e);
    return w.block(status_error);
}

fn pending() ?[*]u8 {
    var w = Writer.init();
    defer w.deinit();
    return w.block(status_pending);
}

/// Tells Go something, with the values w holds, and returns its answer, a
/// block to read with answer, if any.
fn send(kind: u64, id: u64, status: i64, w: ?*Writer) ?[*]u8 {
    const cb = runtime.cb orelse return null;
    if (w) |v| {
        const d = v.data();
        if (d.len > 0) return cb(kind, id, status, d.ptr, d.len);
    }
    return cb(kind, id, status, null, 0);
}

/// Reads a block Go answered with, into the arena, and frees it.
fn answer(p: ?[*]u8, arena: Allocator, comptime R: type, comptime read: fn (*Reader) Error!R) Error!R {
    const b = p orelse return error.Closed;
    defer runtime.free.?(b);
    const status = std.mem.readInt(i64, b[0..8], .little);
    const n: usize = @intCast(std.mem.readInt(i64, b[8..16], .little));
    var r: Reader = .{ .b = b[16 .. 16 + n], .arena = arena };
    if (status == status_error) return readError(&r);
    return read(&r);
}

fn retain(o: Obj) Error!u64 {
    const p = try allocator.create(Obj);
    p.* = o;
    return @intFromPtr(p);
}

fn object(h: u64) Error!*Obj {
    if (h == 0) return error.Closed;
    return @ptrFromInt(h);
}

/// A table of what Go refers to by an id, as calls by their call.
fn Table(comptime V: type) type {
    return struct {
        mutex: std.Io.Mutex = .init,
        map: std.AutoHashMapUnmanaged(u64, V) = .empty,

        fn put(t: *@This(), k: u64, v: V) Error!void {
            t.mutex.lockUncancelable(io());
            defer t.mutex.unlock(io());
            try t.map.put(allocator, k, v);
        }

        fn remove(t: *@This(), k: u64) ?V {
            t.mutex.lockUncancelable(io());
            defer t.mutex.unlock(io());
            const kv = t.map.fetchRemove(k) orelse return null;
            return kv.value;
        }

        /// Runs f with the value of k, if any, holding the table.
        fn with(t: *@This(), k: u64, comptime f: fn (V) void) void {
            t.mutex.lockUncancelable(io());
            defer t.mutex.unlock(io());
            if (t.map.get(k)) |v| f(v);
        }
    };
}

/// An asynchronous call or a stream, running on a thread of its own.
const Task = struct {
    arena: std.heap.ArenaAllocator,
    ctx: Context = .{},
    demand: std.Io.Semaphore = .{},
    call: u64,
    h: u64,
    args: []const u8 = &.{},

    fn new(call: u64, h: u64, args: ?[*]const u8, n: usize) Error!*Task {
        const t = try allocator.create(Task);
        t.* = .{ .arena = .init(allocator), .call = call, .h = h };
        errdefer t.free();
        // The arguments are Go's during the call that starts the task only.
        t.args = try t.arena.allocator().dupe(u8, bytesOf(args, n));
        return t;
    }

    fn free(t: *Task) void {
        t.arena.deinit();
        allocator.destroy(t);
    }
};

/// The tasks of asynchronous calls and streams, by their call, which Go
/// cancels.
var tasks: Table(*Task) = .{};

fn cancel(call: u64) void {
    tasks.with(call, struct {
        fn f(t: *Task) void {
            t.ctx.canceled.store(true, .release);
            t.demand.post(io());
        }
    }.f);
}

fn demand(call: u64) void {
    tasks.with(call, struct {
        fn f(t: *Task) void {
            t.demand.post(io());
        }
    }.f);
}

const TaskBody = fn (arena: Allocator, ctx: *Context, w: *Writer, h: u64, a: *Reader) Error!void;

/// Starts an asynchronous call on a thread of its own, which reports its
/// result through the callback.
fn start(call: u64, h: u64, args: ?[*]const u8, n: usize, comptime body: TaskBody) ?[*]u8 {
    const t = Task.new(call, h, args, n) catch |e| return failed(e);
    tasks.put(call, t) catch |e| {
        t.free();
        return failed(e);
    };
    const th = std.Thread.spawn(.{}, struct {
        fn main(task: *Task) void {
            var w = Writer.init();
            defer w.deinit();
            var r: Reader = .{ .b = task.args, .arena = task.arena.allocator() };
            var status = status_ok;
            body(task.arena.allocator(), &task.ctx, &w, task.h, &r) catch |e| {
                w.reset();
                writeError(&w, e);
                status = status_error;
            };
            _ = tasks.remove(task.call);
            _ = send(kind_result, task.call, status, &w);
            task.free();
        }
    }.main, .{t}) catch {
        _ = tasks.remove(call);
        t.free();
        return failed(failGo("no thread for the call"));
    };
    th.detach();
    return pending();
}

/// Starts a stream on a thread of its own, which yields a value each time
/// Go asks for one.
fn stream(
    comptime V: type,
    call: u64,
    h: u64,
    args: ?[*]const u8,
    n: usize,
    comptime make: fn (Allocator, *Context, u64, *Reader) Error!Iterator(V),
    comptime enc: fn (*Writer, V) void,
) ?[*]u8 {
    const t = Task.new(call, h, args, n) catch |e| return failed(e);
    tasks.put(call, t) catch |e| {
        t.free();
        return failed(e);
    };
    const th = std.Thread.spawn(.{}, struct {
        fn main(task: *Task) void {
            defer task.free();
            defer _ = tasks.remove(task.call);
            var w = Writer.init();
            defer w.deinit();
            var r: Reader = .{ .b = task.args, .arena = task.arena.allocator() };
            const it = make(task.arena.allocator(), &task.ctx, task.h, &r) catch |e| {
                task.demand.waitUncancelable(io());
                writeError(&w, e);
                _ = send(kind_item, task.call, status_error, &w);
                return;
            };
            defer if (it.deinitFn) |d| d(it.ptr);
            var item = std.heap.ArenaAllocator.init(allocator);
            defer item.deinit();
            while (true) {
                task.demand.waitUncancelable(io());
                if (task.ctx.isCanceled()) return;
                _ = item.reset(.retain_capacity);
                w.reset();
                const v = it.next(item.allocator()) catch |e| {
                    writeError(&w, e);
                    _ = send(kind_item, task.call, status_error, &w);
                    return;
                } orelse {
                    _ = send(kind_item, task.call, status_end, null);
                    return;
                };
                enc(&w, v);
                _ = send(kind_item, task.call, status_ok, &w);
            }
        }
    }.main, .{t}) catch {
        _ = tasks.remove(call);
        t.free();
        return failed(failGo("no thread for the stream"));
    };
    th.detach();
    return pending();
}

/// A function or a value of Go's that the implementation holds, until the
/// last of its holders releases it.
const GoFunc = struct {
    id: u64,
    refs: std.atomic.Value(u32) = .init(1),

    fn new(id: u64) Error!*GoFunc {
        if (id == 0) return failGo("Go passed nil for a function or a value");
        const f = try allocator.create(GoFunc);
        f.* = .{ .id = id };
        return f;
    }

    fn retain(f: *GoFunc) void {
        _ = f.refs.fetchAdd(1, .monotonic);
    }

    fn release(f: *GoFunc) void {
        if (f.refs.fetchSub(1, .acq_rel) == 1) {
            _ = send(kind_release, f.id, 0, null);
            allocator.destroy(f);
        }
    }

    fn notify(f: *GoFunc, w: *Writer) void {
        _ = send(kind_notify, f.id, 0, w);
    }

    fn ask(f: *GoFunc, arena: Allocator, w: *Writer, comptime R: type, comptime read: fn (*Reader) Error!R) Error!R {
        return answer(send(kind_ask, f.id, 0, w), arena, R, read);
    }
};

/// Calls the method of a value of Go's that w names, with the arguments
/// after it.
fn invoke(id: u64, arena: Allocator, w: *Writer, comptime R: type, comptime read: fn (*Reader) Error!R) Error!R {
    return answer(send(kind_invoke, id, 0, w), arena, R, read);
}

/// A call of a method of Go's that takes a context, waiting for Go's
/// answer.
const Cont = struct {
    event: std.Io.Event = .unset,
    block: ?[*]u8 = null,
};

var conts: Table(*Cont) = .{};
var last_id: std.atomic.Value(u64) = .init(0);

/// The id of a continuation: the module's index, from Go, in its high bits
/// makes it unique among modules.
fn nextId() u64 {
    return runtime.id_base | (last_id.fetchAdd(1, .monotonic) + 1);
}

fn resumeCall(id: u64, block: ?[*]u8) void {
    const c = conts.remove(id) orelse {
        if (block) |b| runtime.free.?(b);
        return;
    };
    c.block = block;
    c.event.set(io());
}

/// Calls a method of Go's that takes a context, which ctx cancels, and
/// waits for its answer.
fn invokeAsync(id: u64, arena: Allocator, ctx: *Context, w: *Writer, comptime R: type, comptime read: fn (*Reader) Error!R) Error!R {
    var c: Cont = .{};
    const cont = nextId();
    try conts.put(cont, &c);
    _ = send(kind_invoke_async, id, @bitCast(cont), w);
    var canceled = false;
    while (true) {
        c.event.waitTimeout(io(), .{ .duration = .{ .raw = .fromMilliseconds(10), .clock = .awake } }) catch {
            if (!canceled and ctx.isCanceled()) {
                canceled = true;
                _ = send(kind_cancel, cont, 0, null);
            }
            continue;
        };
        break;
    }
    return answer(c.block, arena, R, read);
}
`
