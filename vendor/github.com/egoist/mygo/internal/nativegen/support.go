package nativegen

// swiftSupport is the part of the generated Swift that is the same for
// every module, MODULE replaced by its name: the types the implementation
// uses (NativeError, Closer, NativeCloser, NativeBuffer) and the glue Go
// calls through.
const swiftSupport = `
// MARK: - Types for the implementation

/// Errors an implementation throws that are not the module's own.
public enum NativeError: Error, Sendable {
    /// Reaches Go as errors.ErrUnsupported: the system lacks what the
    /// implementation needs, such as a framework of a newer version.
    case unsupported
    /// Reaches Go as native.ErrClosed.
    case closed
    /// An error a Go function or method returned.
    case go(String)
}

/// What stops what a method started, as Go's io.Closer.
public protocol Closer: AnyObject {
    func close() throws
}

/// A Closer that runs a closure, once.
public final class NativeCloser: Closer, @unchecked Sendable {
    private let lock = NSLock()
    private var fn: (() -> Void)?

    public init(_ fn: @escaping () -> Void) { self.fn = fn }

    public func close() {
        lock.lock()
        let f = fn
        fn = nil
        lock.unlock()
        f?()
    }
}

/// Memory that Go and the implementation both use: a *native.Buffer.
public final class NativeBuffer: @unchecked Sendable {
    /// The buffer's memory, valid as long as the buffer.
    public let bytes: UnsafeMutableRawBufferPointer
    private let owned: Bool
    /// The pool the buffer goes back to once Go is done with it.
    fileprivate weak var pool: NativeBufferPool?

    /// Makes a buffer of count bytes, which the implementation may yield
    /// from a stream: Go reads it until its loop asks for the next value.
    public init(count: Int) {
        bytes = .allocate(byteCount: Swift.max(count, 1), alignment: 16)
        owned = true
    }

    public var count: Int { bytes.count }

    /// The buffer of Go's at p.
    init(p: UInt64, count: Int) {
        bytes = UnsafeMutableRawBufferPointer(start: UnsafeMutableRawPointer(bitPattern: UInt(p)), count: count)
        owned = false
    }

    deinit {
        if owned { bytes.deallocate() }
    }

    /// Gives the buffer back to its pool, as Go's loop moved on.
    fileprivate func recycle() { pool?.put(self) }
}

/// Buffers of one size that a stream yields, each reused once Go's loop
/// moves on from it, so that a stream of buffers allocates none once it
/// runs: get one, fill it, yield it.
public final class NativeBufferPool: @unchecked Sendable {
    /// The size of the pool's buffers.
    public let size: Int
    private let lock = NSLock()
    private var free: [NativeBuffer] = []

    public init(size: Int) { self.size = size }

    /// Returns a buffer Go is done with, or a new one.
    public func get() -> NativeBuffer {
        lock.lock()
        defer { lock.unlock() }
        if let b = free.popLast() { return b }
        let b = NativeBuffer(count: size)
        b.pool = self
        return b
    }

    fileprivate func put(_ b: NativeBuffer) {
        lock.lock()
        free.append(b)
        lock.unlock()
    }
}

/// An image on the GPU that native UI shows: a *native.Texture. Present
/// frames into it, IOSurfaces or CVPixelBuffers backed by them, which show
/// in the next frame of the windows showing it.
public final class NativeTexture: @unchecked Sendable {
    let id: UInt64

    init(id: UInt64) { self.id = id }

#if canImport(IOSurface)
    /// The attributes of the pixel buffers native UI draws without
    /// converting them: 32-bit BGRA, backed by IOSurfaces, for Metal.
    public var pixelBufferAttributes: [String: Any] {
        [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
    }

    /// Shows surface, 32-bit BGRA, in the next frame. Native UI keeps it
    /// until another one replaces it: draw the next frame into another
    /// surface, as a pool of pixel buffers gives.
    public func present(_ surface: IOSurfaceRef) {
        let p = Unmanaged.passRetained(surface).toOpaque()
        _mygoSend(_mygoKindPresent, id, Int64(Int(bitPattern: p)), nil)
    }

    /// Shows the IOSurface backing buffer in the next frame.
    public func present(_ buffer: CVPixelBuffer) {
        guard let s = CVPixelBufferGetIOSurface(buffer)?.takeUnretainedValue() else { return }
        present(s)
    }

    /// Calls f on each refresh of the display, with the host time the
    /// frame will show at, in seconds (as CACurrentMediaTime counts),
    /// until the link is invalidated.
    public func displayLink(_ f: @escaping @Sendable (CFTimeInterval) -> Void) -> NativeDisplayLink {
        NativeDisplayLink(f)
    }
#endif
}

#if canImport(IOSurface)
/// Calls back on each refresh of the display, until invalidated.
public final class NativeDisplayLink: @unchecked Sendable {
    private var link: CVDisplayLink?

    init(_ f: @escaping @Sendable (CFTimeInterval) -> Void) {
        CVDisplayLinkCreateWithActiveCGDisplays(&link)
        guard let link else { return }
        let frequency = CVGetHostClockFrequency()
        CVDisplayLinkSetOutputHandler(link) { _, _, out, _, _ in
            f(Double(out.pointee.hostTime) / frequency)
            return kCVReturnSuccess
        }
        CVDisplayLinkStart(link)
    }

    /// Stops the callbacks.
    public func invalidate() {
        if let link { CVDisplayLinkStop(link) }
        link = nil
    }

    deinit { invalidate() }
}
#endif

// MARK: - Glue

public typealias _MygoCallback = @convention(c) (UInt64, UInt64, Int64, UnsafeRawPointer?, Int) -> UnsafeMutableRawPointer?

nonisolated(unsafe) var _mygoCallback: _MygoCallback?

let _mygoKindResult: UInt64 = 1
let _mygoKindItem: UInt64 = 2
let _mygoKindNotify: UInt64 = 3
let _mygoKindAsk: UInt64 = 4
let _mygoKindRelease: UInt64 = 5
let _mygoKindInvoke: UInt64 = 6
let _mygoKindInvokeAsync: UInt64 = 7
let _mygoKindCancel: UInt64 = 8
let _mygoKindPresent: UInt64 = 9

// Values cross in a binary encoding, which package native describes, in
// the order of the declarations: every integer as 8 bytes, little-endian,
// floats as Double, bools as a byte, strings, Data, arrays and
// dictionaries as their count then their contents, optionals as a Bool
// then the value, structs as their fields, enums as their raw values.

/// Writes values for Go, after the 16 bytes of a block's head: its status
/// and its length.
struct _MygoWriter {
    private(set) var p: UnsafeMutableRawPointer
    private var cap: Int
    private(set) var n = 16

    init() {
        cap = 128
        p = malloc(cap)!
    }

    private mutating func reserve(_ k: Int) {
        if n + k <= cap { return }
        cap = Swift.max(cap * 2, n + k)
        p = realloc(p, cap)!
    }

    mutating func raw(_ b: UnsafeRawBufferPointer) {
        guard let base = b.baseAddress, b.count > 0 else { return }
        reserve(b.count)
        (p + n).copyMemory(from: base, byteCount: b.count)
        n += b.count
    }

    mutating func u64(_ v: UInt64) {
        reserve(8)
        p.storeBytes(of: v.littleEndian, toByteOffset: n, as: UInt64.self)
        n += 8
    }

    mutating func u8(_ v: UInt8) {
        reserve(1)
        p.storeBytes(of: v, toByteOffset: n, as: UInt8.self)
        n += 1
    }

    mutating func i64(_ v: Int64) { u64(UInt64(bitPattern: v)) }
    mutating func bool(_ v: Bool) { u8(v ? 1 : 0) }
    mutating func double(_ v: Double) { u64(v.bitPattern) }
    mutating func count(_ c: Int) { i64(Int64(c)) }

    mutating func string(_ s: String) {
        var s = s
        s.withUTF8 { b in
            self.count(b.count)
            self.raw(UnsafeRawBufferPointer(b))
        }
    }

    mutating func data(_ d: Data) {
        count(d.count)
        d.withUnsafeBytes { self.raw($0) }
    }

    mutating func date(_ d: Date) {
        let t = d.timeIntervalSince1970
        var s = t.rounded(.down)
        var ns = ((t - s) * 1e9).rounded()
        if ns >= 1e9 {
            s += 1
            ns -= 1e9
        }
        i64(Int64(s))
        i64(Int64(ns))
    }

    mutating func rect(_ r: CGRect) {
        double(Double(r.minX))
        double(Double(r.minY))
        double(Double(r.width))
        double(Double(r.height))
    }

    mutating func buffer(_ b: NativeBuffer) {
        u64(UInt64(UInt(bitPattern: b.bytes.baseAddress)))
        count(b.count)
    }

    mutating func texture(_ t: NativeTexture) { u64(t.id) }

    /// The values written, without the head.
    var bytes: UnsafeRawBufferPointer { UnsafeRawBufferPointer(start: p + 16, count: n - 16) }

    /// Forgets what was written.
    mutating func reset() { n = 16 }

    /// Gives the values to Go as a block, which Go frees.
    func block(_ status: Int64) -> UnsafeMutableRawPointer {
        p.storeBytes(of: status, as: Int64.self)
        p.storeBytes(of: Int64(n - 16), toByteOffset: 8, as: Int64.self)
        return p
    }

    /// Frees the writer, which a block Go was given does not need.
    func free() { Foundation.free(p) }
}

enum _MygoWireError: Error {
    case short
    case value(String, String)
}

/// Reads the values Go wrote.
struct _MygoReader {
    let p: UnsafeRawPointer?
    let n: Int
    var i = 0

    init(_ p: UnsafeRawPointer?, _ n: Int) {
        self.p = p
        self.n = n
    }

    mutating func take(_ k: Int) throws -> UnsafeRawPointer {
        guard k >= 0, k <= n - i, let p else { throw _MygoWireError.short }
        defer { i += k }
        return p + i
    }

    mutating func u64() throws -> UInt64 { UInt64(littleEndian: try take(8).loadUnaligned(as: UInt64.self)) }
    mutating func u8() throws -> UInt8 { try take(1).load(as: UInt8.self) }
    mutating func i64() throws -> Int64 { Int64(bitPattern: try u64()) }
    mutating func bool() throws -> Bool { try u8() != 0 }
    mutating func double() throws -> Double { Double(bitPattern: try u64()) }

    /// Reads the count of an array or a dictionary, whose elements take a
    /// byte each at least.
    mutating func count() throws -> Int {
        let c = try i64()
        guard c >= 0, c <= Int64(n - i) else { throw _MygoWireError.short }
        return Int(c)
    }

    mutating func string() throws -> String {
        let c = try count()
        return String(decoding: UnsafeRawBufferPointer(start: try take(c), count: c), as: UTF8.self)
    }

    mutating func data() throws -> Data {
        let c = try count()
        return Data(bytes: try take(c), count: c)
    }

    mutating func date() throws -> Date {
        let s = try i64()
        let ns = try i64()
        return Date(timeIntervalSince1970: Double(s) + Double(ns) / 1e9)
    }

    mutating func rect() throws -> CGRect {
        CGRect(x: try double(), y: try double(), width: try double(), height: try double())
    }

    mutating func buffer() throws -> NativeBuffer {
        let p = try u64()
        return NativeBuffer(p: p, count: Int(try i64()))
    }

    mutating func texture() throws -> NativeTexture { NativeTexture(id: try u64()) }
}

/// Tells Go something, with the values w holds, and returns its answer, a
/// block to read with _mygoAnswer, if any.
@discardableResult
func _mygoSend(_ kind: UInt64, _ id: UInt64, _ status: Int64, _ w: _MygoWriter?) -> UnsafeMutableRawPointer? {
    guard let cb = _mygoCallback else { return nil }
    guard let w, w.n > 16 else { return cb(kind, id, status, nil, 0) }
    return cb(kind, id, status, w.p + 16, w.n - 16)
}

/// Reads a block Go answered with, and frees it.
func _mygoAnswer<R>(_ p: UnsafeMutableRawPointer?, _ read: (inout _MygoReader) throws -> R) throws -> R {
    guard let p else { throw NativeError.closed }
    defer { free(p) }
    let st = p.loadUnaligned(as: Int64.self)
    var r = _MygoReader(p + 16, Int(p.loadUnaligned(fromByteOffset: 8, as: Int64.self)))
    if st == 1 { throw _mygoReadError(&r) }
    return try read(&r)
}

/// Runs what returns at once, which writes its result to w.
func _mygoRun(_ body: (inout _MygoWriter) throws -> Void) -> UnsafeMutableRawPointer? {
    var w = _MygoWriter()
    do {
        try body(&w)
        return w.block(0)
    } catch {
        w.reset()
        _mygoWriteError(&w, error)
        return w.block(1)
    }
}

func _mygoRunMain(_ body: @MainActor (inout _MygoWriter) throws -> Void) -> UnsafeMutableRawPointer? {
    _mygoRun { w in try MainActor.assumeIsolated { try body(&w) } }
}

/// Runs what starts an asynchronous call or a stream: Go waits for its
/// results through the callback.
func _mygoStart(_ body: () throws -> Void) -> UnsafeMutableRawPointer? {
    var w = _MygoWriter()
    do {
        try body()
        return w.block(2)
    } catch {
        _mygoWriteError(&w, error)
        return w.block(1)
    }
}

func _mygoCall<T>(_ f: () throws -> T) rethrows -> T { try f() }

@MainActor func _mygoCallMain<T>(_ f: @MainActor () throws -> T) rethrows -> T { try f() }

func _mygoMust<T>(_ f: () throws -> T) -> T {
    do {
        return try f()
    } catch {
        fatalError("MODULE: Go failed to answer: \(error)")
    }
}

func _mygoFail<T>() -> T { fatalError("MODULE: Go failed to answer") }

// The kinds of errors, as they cross both ways: the kind, then the code,
// domain, number and message.
let _mygoErrOther: UInt8 = 0
let _mygoErrCode: UInt8 = 1
let _mygoErrUnsupported: UInt8 = 2
let _mygoErrClosed: UInt8 = 3
let _mygoErrCanceled: UInt8 = 4
let _mygoErrGo: UInt8 = 5

func _mygoWriteError(_ w: inout _MygoWriter, _ error: any Error) {
    var kind = _mygoErrOther
    var code = "", domain = "", message = ""
    var number = 0
    switch error {
    case let e as MODULEError:
        kind = _mygoErrCode
        code = e.rawValue
    case NativeError.unsupported:
        kind = _mygoErrUnsupported
    case NativeError.closed:
        kind = _mygoErrClosed
    case NativeError.go(let m):
        kind = _mygoErrGo
        message = m
    case is CancellationError:
        kind = _mygoErrCanceled
    default:
        let ns = error as NSError
        if type(of: error) is NSError.Type {
            domain = ns.domain
            message = ns.localizedDescription
        } else {
            let name = String(describing: type(of: error))
            domain = name
            message = (error as? LocalizedError)?.errorDescription ?? "\(name).\(error)"
        }
        number = ns.code
    }
    w.u8(kind)
    w.string(code)
    w.string(domain)
    w.i64(Int64(number))
    w.string(message)
}

func _mygoReadError(_ r: inout _MygoReader) -> any Error {
    guard let kind = try? r.u8(), let code = try? r.string(), (try? r.string()) != nil, (try? r.i64()) != nil, let message = try? r.string() else {
        return NativeError.go("an error of Go's that does not decode")
    }
    switch kind {
    case _mygoErrCode: return MODULEError(rawValue: code) ?? NativeError.go(message)
    case _mygoErrUnsupported: return NativeError.unsupported
    case _mygoErrClosed: return NativeError.closed
    case _mygoErrCanceled: return CancellationError()
    default: return NativeError.go(message)
    }
}

func _mygoRetain(_ v: AnyObject) -> UInt64 {
    UInt64(UInt(bitPattern: Unmanaged.passRetained(v).toOpaque()))
}

func _mygoAnyObject(_ h: UInt64) -> AnyObject {
    guard let p = UnsafeRawPointer(bitPattern: UInt(h)) else { fatalError("MODULE: Go passed nil for an object") }
    return Unmanaged<AnyObject>.fromOpaque(p).takeUnretainedValue()
}

func _mygoObject<T>(_ h: UInt64) -> T {
    guard let v = _mygoAnyObject(h) as? T else { fatalError("MODULE: Go passed an object of the wrong type for \(T.self)") }
    return v
}

func _mygoRelease(_ h: UInt64) {
    guard let p = UnsafeRawPointer(bitPattern: UInt(h)) else { return }
    Unmanaged<AnyObject>.fromOpaque(p).release()
}

#if canImport(AppKit)
@MainActor func _mygoWindow(_ h: UInt64) -> NSWindow {
    let w: NSWindow = _mygoObject(h)
    return w
}

/// Turns a rectangle of native UI, whose origin is the window's top-left,
/// into the coordinates of the window's content view.
@MainActor func _mygoFlip(_ r: CGRect, in w: NSWindow) -> CGRect {
    guard let v = w.contentView, !v.isFlipped else { return r }
    return CGRect(x: r.minX, y: v.bounds.height - r.minY - r.height, width: r.width, height: r.height)
}
#endif

final class _MygoTable<V>: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [UInt64: V] = [:]
    func put(_ k: UInt64, _ v: V) { lock.lock(); values[k] = v; lock.unlock() }
    func get(_ k: UInt64) -> V? { lock.lock(); defer { lock.unlock() }; return values[k] }
    @discardableResult func remove(_ k: UInt64) -> V? { lock.lock(); defer { lock.unlock() }; return values.removeValue(forKey: k) }
}

/// The tasks of asynchronous calls and streams, by their call, which Go
/// cancels.
final class _MygoTasks: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [UInt64: Task<Void, Never>] = [:]
    private var done: Set<UInt64> = []
    private var canceled: Set<UInt64> = []

    func put(_ call: UInt64, _ t: Task<Void, Never>) {
        lock.lock()
        defer { lock.unlock() }
        if done.remove(call) != nil { return }
        if canceled.remove(call) != nil { t.cancel() }
        tasks[call] = t
    }

    func finish(_ call: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        if tasks.removeValue(forKey: call) == nil { done.insert(call) }
        canceled.remove(call)
    }

    func cancel(_ call: UInt64) {
        lock.lock()
        let t = tasks.removeValue(forKey: call)
        if t == nil, done.remove(call) == nil { canceled.insert(call) }
        lock.unlock()
        t?.cancel()
    }
}

let _mygoTasks = _MygoTasks()
let _mygoDemands = _MygoTable<AsyncStream<Void>.Continuation>()
let _mygoConts = _MygoTable<CheckedContinuation<_MygoBlock, Never>>()

/// A block Go answered with, for a continuation.
struct _MygoBlock: @unchecked Sendable {
    let p: UnsafeMutableRawPointer?
}

private let _mygoIDLock = NSLock()
nonisolated(unsafe) private var _mygoLastID: UInt64 = 0
/// The module's index, from Go, in the high bits of every id, which makes
/// the ids of continuations unique among modules.
nonisolated(unsafe) var _mygoIDBase: UInt64 = 0

func _mygoNextID() -> UInt64 {
    _mygoIDLock.lock()
    defer { _mygoIDLock.unlock() }
    _mygoLastID += 1
    return _mygoIDBase | _mygoLastID
}

func _mygoFinish(_ call: UInt64, _ body: (inout _MygoWriter) async throws -> Void) async {
    var w = _MygoWriter()
    var status: Int64 = 0
    do {
        try await body(&w)
    } catch {
        w.reset()
        _mygoWriteError(&w, error)
        status = 1
    }
    _mygoTasks.finish(call)
    _mygoSend(_mygoKindResult, call, status, w)
    w.free()
}

func _mygoTask(_ call: UInt64, _ body: @escaping (inout _MygoWriter) async throws -> Void) {
    _mygoTasks.put(call, Task { await _mygoFinish(call, body) })
}

func _mygoTaskMain(_ call: UInt64, _ body: @escaping @MainActor (inout _MygoWriter) async throws -> Void) {
    _mygoTasks.put(call, Task { @MainActor in await _mygoFinish(call, body) })
}

func _mygoIterate<S: AsyncSequence & Sendable>(_ call: UInt64, _ s: S, _ demand: AsyncStream<Void>, _ enc: (inout _MygoWriter, S.Element) -> Void) async {
    var it = s.makeAsyncIterator()
    var lent: S.Element? = nil
    var w = _MygoWriter()
    for await _ in demand {
        // Go is done with what the previous value lent.
        (lent as? NativeBuffer)?.recycle()
        lent = nil
        w.reset()
        do {
            guard let v = try await it.next() else {
                _mygoSend(_mygoKindItem, call, 3, nil)
                break
            }
            lent = v
            enc(&w, v)
            _mygoSend(_mygoKindItem, call, 0, w)
        } catch {
            _mygoWriteError(&w, error)
            _mygoSend(_mygoKindItem, call, 1, w)
            break
        }
    }
    w.free()
    withExtendedLifetime(lent) {}
    _mygoDemands.remove(call)
    _mygoTasks.finish(call)
}

func _mygoDemand(_ call: UInt64) -> AsyncStream<Void> {
    var cont: AsyncStream<Void>.Continuation!
    let demand = AsyncStream<Void>(bufferingPolicy: .unbounded) { cont = $0 }
    _mygoDemands.put(call, cont)
    return demand
}

func _mygoStream<S: AsyncSequence & Sendable>(_ call: UInt64, _ make: @escaping () -> S, _ enc: @escaping (inout _MygoWriter, S.Element) -> Void) {
    let demand = _mygoDemand(call)
    _mygoTasks.put(call, Task { await _mygoIterate(call, make(), demand, enc) })
}

func _mygoStreamMain<S: AsyncSequence & Sendable>(_ call: UInt64, _ make: @escaping @MainActor () -> S, _ enc: @escaping (inout _MygoWriter, S.Element) -> Void) {
    let demand = _mygoDemand(call)
    _mygoTasks.put(call, Task { @MainActor in await _mygoIterate(call, make(), demand, enc) })
}

/// A Go function the implementation calls: a notification, or a question
/// Go answers at once. Both take the writer of the arguments, and free it.
final class _MygoGoFunc: @unchecked Sendable {
    let id: UInt64
    init(_ id: UInt64) { self.id = id }
    deinit { if id != 0 { _mygoSend(_mygoKindRelease, id, 0, nil) } }

    func notify(_ w: _MygoWriter) {
        if id != 0 { _mygoSend(_mygoKindNotify, id, 0, w) }
        w.free()
    }

    func ask<R>(_ w: _MygoWriter, _ read: (inout _MygoReader) throws -> R) throws -> R {
        defer { w.free() }
        guard id != 0 else { throw NativeError.closed }
        return try _mygoAnswer(_mygoSend(_mygoKindAsk, id, 0, w), read)
    }
}

/// Calls the method of a value of Go's that w names, with the arguments
/// after it, and frees w.
func _mygoInvoke<R>(_ id: UInt64, _ w: _MygoWriter, _ read: (inout _MygoReader) throws -> R) throws -> R {
    defer { w.free() }
    return try _mygoAnswer(_mygoSend(_mygoKindInvoke, id, 0, w), read)
}

func _mygoInvokeAsync<R>(_ id: UInt64, _ w: _MygoWriter, _ read: (inout _MygoReader) throws -> R) async throws -> R {
    let cont = _mygoNextID()
    let b = await withTaskCancellationHandler {
        await withCheckedContinuation { (c: CheckedContinuation<_MygoBlock, Never>) in
            _mygoConts.put(cont, c)
            _mygoSend(_mygoKindInvokeAsync, id, Int64(bitPattern: cont), w)
            w.free()
        }
    } onCancel: {
        _mygoSend(_mygoKindCancel, cont, 0, nil)
    }
    return try _mygoAnswer(b.p, read)
}
`

// swiftNanos reads and writes time.Duration, for modules that use it:
// Duration needs macOS 13.
const swiftNanos = `
@available(macOS 13, iOS 16, *)
extension _MygoReader {
    /// Reads a time.Duration: nanoseconds.
    mutating func duration() throws -> Duration { .nanoseconds(try i64()) }
}

@available(macOS 13, iOS 16, *)
extension _MygoWriter {
    mutating func duration(_ d: Duration) {
        let c = d.components
        i64(c.seconds * 1_000_000_000 + c.attoseconds / 1_000_000_000)
    }
}
`
