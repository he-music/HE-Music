package nativegen

// rustSupport is the part of the generated Rust that is the same for every
// module, MODULEError replaced by the module's errors: the types the
// implementation uses (Error, Context, Stream, Closer, Rect, Buffer) and
// the runtime of the glue, with the standard library only.
const rustSupport = `
// Types for the implementation.

/// The values a method yields, which Go asks for one at a time, on a thread
/// of their own.
pub type Stream<T> = Box<dyn Iterator<Item = T> + Send>;

/// Makes a Stream of an iterator.
pub fn stream_of<I>(it: I) -> Stream<I::Item>
where
    I: Iterator + Send + 'static,
{
    Box::new(it)
}

/// An error an implementation returns, or Go did.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// One the module declares, which Go compares with errors.Is.
    Module(MODULEError),
    /// Reaches Go as errors.ErrUnsupported: the system lacks what the
    /// implementation needs.
    Unsupported,
    /// Reaches Go as native.ErrClosed.
    Closed,
    /// The call was canceled: Go's context is done.
    Canceled,
    /// An error a Go function or method returned.
    Go(String),
    /// Any other error, which Go reports with its message.
    Other {
        domain: String,
        number: i64,
        message: String,
    },
}

impl Error {
    /// An error that says what message does.
    pub fn other(message: impl std::fmt::Display) -> Self {
        Error::Other {
            domain: String::new(),
            number: 0,
            message: message.to_string(),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Module(e) => f.write_str(e.code()),
            Error::Unsupported => f.write_str("unsupported"),
            Error::Closed => f.write_str("closed"),
            Error::Canceled => f.write_str("canceled"),
            Error::Go(m) => f.write_str(m),
            Error::Other { domain, number, message } => {
                if message.is_empty() {
                    write!(f, "{} error {}", domain, number)
                } else {
                    f.write_str(message)
                }
            }
        }
    }
}

impl std::error::Error for Error {}

/// What stops what a method started, as Go's io.Closer.
pub trait Closer: Send + Sync {
    fn close(&self) -> Result<(), Error>;
}

struct FnCloser(std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>>);

impl Closer for FnCloser {
    fn close(&self) -> Result<(), Error> {
        let f = self.0.lock().unwrap().take();
        if let Some(f) = f {
            f();
        }
        Ok(())
    }
}

/// A Closer that runs f, once.
pub fn closer(f: impl FnOnce() + Send + 'static) -> Box<dyn Closer> {
    Box::new(FnCloser(std::sync::Mutex::new(Some(Box::new(f)))))
}

/// The context of a method that takes one in Go: Go cancels it.
pub struct Context {
    canceled: std::sync::Mutex<bool>,
    cond: std::sync::Condvar,
}

impl Context {
    fn new() -> Self {
        Context {
            canceled: std::sync::Mutex::new(false),
            cond: std::sync::Condvar::new(),
        }
    }

    fn cancel(&self) {
        *self.canceled.lock().unwrap() = true;
        self.cond.notify_all();
    }

    /// Reports whether Go canceled the call.
    pub fn is_canceled(&self) -> bool {
        *self.canceled.lock().unwrap()
    }

    /// Returns Err(Error::Canceled) once Go canceled the call.
    pub fn check(&self) -> Result<(), Error> {
        if self.is_canceled() {
            Err(Error::Canceled)
        } else {
            Ok(())
        }
    }

    /// Waits d, or until Go cancels the call, which returns
    /// Err(Error::Canceled).
    pub fn sleep(&self, d: Duration) -> Result<(), Error> {
        let deadline = std::time::Instant::now() + d;
        let mut canceled = self.canceled.lock().unwrap();
        loop {
            if *canceled {
                return Err(Error::Canceled);
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Ok(());
            }
            canceled = self.cond.wait_timeout(canceled, deadline - now).unwrap().0;
        }
    }
}

/// A rectangle of native UI: a ui.Rect.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// Memory of Go's that the implementation fills: a *native.Buffer, valid
/// during the call that takes it.
#[derive(Debug)]
pub struct Buffer {
    p: *mut u8,
    n: usize,
}

unsafe impl Send for Buffer {}
unsafe impl Sync for Buffer {}

impl Buffer {
    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn bytes(&self) -> &[u8] {
        if self.p.is_null() {
            return &[];
        }
        unsafe { std::slice::from_raw_parts(self.p, self.n) }
    }

    pub fn bytes_mut(&mut self) -> &mut [u8] {
        if self.p.is_null() {
            return &mut [];
        }
        unsafe { std::slice::from_raw_parts_mut(self.p, self.n) }
    }
}

// The runtime of the glue.

type Callback = unsafe extern "C" fn(u64, u64, i64, *const u8, usize) -> *mut u8;
type Malloc = unsafe extern "C" fn(usize) -> *mut u8;
type Free = unsafe extern "C" fn(*mut u8);

struct Runtime {
    cb: Callback,
    id_base: u64,
    malloc: Malloc,
    free: Free,
}

static RUNTIME: std::sync::OnceLock<Runtime> = std::sync::OnceLock::new();

fn rt() -> &'static Runtime {
    RUNTIME.get().expect("the module is not initialized: Go loads it")
}

const KIND_RESULT: u64 = 1;
const KIND_ITEM: u64 = 2;
const KIND_NOTIFY: u64 = 3;
const KIND_ASK: u64 = 4;
const KIND_RELEASE: u64 = 5;
const KIND_INVOKE: u64 = 6;
const KIND_INVOKE_ASYNC: u64 = 7;
const KIND_CANCEL: u64 = 8;

const STATUS_OK: i64 = 0;
const STATUS_ERROR: i64 = 1;
const STATUS_PENDING: i64 = 2;
const STATUS_END: i64 = 3;

// Values cross in a binary encoding, which package native describes, in
// the order of the declarations: every integer as 8 bytes, little-endian,
// floats as f64, bools as a byte, strings, bytes, vectors and maps as their
// length then their contents, options as a bool then the value, structs as
// their fields, enums as their values.

/// Writes values for Go, after the 16 bytes of a block's head: its status
/// and its length.
struct Writer {
    b: Vec<u8>,
}

impl Writer {
    fn new() -> Self {
        let mut b = Vec::with_capacity(128);
        b.resize(16, 0);
        Writer { b }
    }

    fn reset(&mut self) {
        self.b.truncate(16);
    }

    fn data(&self) -> &[u8] {
        &self.b[16..]
    }

    fn u64(&mut self, v: u64) {
        self.b.extend_from_slice(&v.to_le_bytes());
    }

    fn u8(&mut self, v: u8) {
        self.b.push(v);
    }

    fn i64(&mut self, v: i64) {
        self.u64(v as u64);
    }

    fn bool(&mut self, v: bool) {
        self.u8(v as u8);
    }

    fn f64(&mut self, v: f64) {
        self.u64(v.to_bits());
    }

    fn count(&mut self, n: usize) {
        self.i64(n as i64);
    }

    fn string(&mut self, s: &str) {
        self.count(s.len());
        self.b.extend_from_slice(s.as_bytes());
    }

    fn bytes(&mut self, b: &[u8]) {
        self.count(b.len());
        self.b.extend_from_slice(b);
    }

    fn time(&mut self, t: &SystemTime) {
        let (s, ns) = match t.duration_since(SystemTime::UNIX_EPOCH) {
            Ok(d) => (d.as_secs() as i64, d.subsec_nanos() as i64),
            Err(e) => {
                let d = e.duration();
                let (mut s, mut ns) = (-(d.as_secs() as i64), d.subsec_nanos() as i64);
                if ns > 0 {
                    s -= 1;
                    ns = 1_000_000_000 - ns;
                }
                (s, ns)
            }
        };
        self.i64(s);
        self.i64(ns);
    }

    fn duration(&mut self, d: &Duration) {
        self.i64(d.as_nanos().min(i64::MAX as u128) as i64);
    }

    fn rect(&mut self, r: &Rect) {
        self.f64(r.x as f64);
        self.f64(r.y as f64);
        self.f64(r.w as f64);
        self.f64(r.h as f64);
    }

    fn buffer(&mut self, b: &Buffer) {
        self.u64(b.p as u64);
        self.count(b.n);
    }

    /// Gives the values to Go as a block, in memory Go frees.
    fn block(&mut self, status: i64) -> *mut u8 {
        let n = self.b.len() - 16;
        self.b[..8].copy_from_slice(&status.to_le_bytes());
        self.b[8..16].copy_from_slice(&(n as i64).to_le_bytes());
        unsafe {
            let p = (rt().malloc)(self.b.len());
            if !p.is_null() {
                std::ptr::copy_nonoverlapping(self.b.as_ptr(), p, self.b.len());
            }
            p
        }
    }
}

/// Reads the values Go wrote.
struct Reader<'a> {
    b: &'a [u8],
}

fn short() -> Error {
    Error::Go("a value from Go ends early".into())
}

impl<'a> Reader<'a> {
    unsafe fn new(p: *const u8, n: usize) -> Reader<'a> {
        if p.is_null() || n == 0 {
            return Reader { b: &[] };
        }
        Reader {
            b: std::slice::from_raw_parts(p, n),
        }
    }

    fn take(&mut self, k: usize) -> Result<&'a [u8], Error> {
        if k > self.b.len() {
            return Err(short());
        }
        let (v, rest) = self.b.split_at(k);
        self.b = rest;
        Ok(v)
    }

    fn u64(&mut self) -> Result<u64, Error> {
        let b = self.take(8)?;
        Ok(u64::from_le_bytes(b.try_into().unwrap()))
    }

    fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }

    fn i64(&mut self) -> Result<i64, Error> {
        Ok(self.u64()? as i64)
    }

    fn bool(&mut self) -> Result<bool, Error> {
        Ok(self.u8()? != 0)
    }

    fn f64(&mut self) -> Result<f64, Error> {
        Ok(f64::from_bits(self.u64()?))
    }

    /// Reads the length of a vector or a map, whose elements take a byte
    /// each at least.
    fn count(&mut self) -> Result<usize, Error> {
        let n = self.i64()?;
        if n < 0 || n as u64 > self.b.len() as u64 {
            return Err(short());
        }
        Ok(n as usize)
    }

    fn string(&mut self) -> Result<String, Error> {
        let n = self.count()?;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }

    fn bytes(&mut self) -> Result<Vec<u8>, Error> {
        let n = self.count()?;
        Ok(self.take(n)?.to_vec())
    }

    fn time(&mut self) -> Result<SystemTime, Error> {
        let s = self.i64()?;
        let ns = self.i64()?.clamp(0, 999_999_999) as u32;
        let t = if s >= 0 {
            SystemTime::UNIX_EPOCH.checked_add(Duration::new(s as u64, ns))
        } else {
            SystemTime::UNIX_EPOCH
                .checked_sub(Duration::new(s.unsigned_abs(), 0))
                .and_then(|t| t.checked_add(Duration::new(0, ns)))
        };
        Ok(t.unwrap_or(SystemTime::UNIX_EPOCH))
    }

    /// Reads a time.Duration, which is zero when negative.
    fn duration(&mut self) -> Result<Duration, Error> {
        Ok(Duration::from_nanos(self.i64()?.max(0) as u64))
    }

    fn rect(&mut self) -> Result<Rect, Error> {
        Ok(Rect {
            x: self.f64()? as f32,
            y: self.f64()? as f32,
            w: self.f64()? as f32,
            h: self.f64()? as f32,
        })
    }

    fn buffer(&mut self) -> Result<Buffer, Error> {
        let p = self.u64()? as *mut u8;
        let n = self.i64()?.max(0) as usize;
        Ok(Buffer { p, n })
    }
}

// The kinds of errors, as they cross both ways: the kind, then the code,
// domain, number and message.
const ERR_OTHER: u8 = 0;
const ERR_CODE: u8 = 1;
const ERR_UNSUPPORTED: u8 = 2;
const ERR_CLOSED: u8 = 3;
const ERR_CANCELED: u8 = 4;
const ERR_GO: u8 = 5;

fn write_error(w: &mut Writer, e: &Error) {
    let (kind, code, domain, number, message) = match e {
        Error::Module(c) => (ERR_CODE, c.code(), "", 0, String::new()),
        Error::Unsupported => (ERR_UNSUPPORTED, "", "", 0, String::new()),
        Error::Closed => (ERR_CLOSED, "", "", 0, String::new()),
        Error::Canceled => (ERR_CANCELED, "", "", 0, String::new()),
        Error::Go(m) => (ERR_GO, "", "", 0, m.clone()),
        Error::Other { domain, number, message } => (ERR_OTHER, "", domain.as_str(), *number, message.clone()),
    };
    w.u8(kind);
    w.string(code);
    w.string(domain);
    w.i64(number);
    w.string(&message);
}

fn read_error(r: &mut Reader) -> Error {
    let mut read = || -> Result<Error, Error> {
        let kind = r.u8()?;
        let code = r.string()?;
        let domain = r.string()?;
        let number = r.i64()?;
        let message = r.string()?;
        Ok(match kind {
            ERR_CODE => MODULEError::from_code(&code).map(Error::Module).unwrap_or(Error::Go(message)),
            ERR_UNSUPPORTED => Error::Unsupported,
            ERR_CLOSED => Error::Closed,
            ERR_CANCELED => Error::Canceled,
            ERR_OTHER if !domain.is_empty() => Error::Other { domain, number, message },
            _ => Error::Go(message),
        })
    };
    read().unwrap_or_else(|_| Error::Go("an error of Go's that does not decode".into()))
}

fn panic_error(p: Box<dyn std::any::Any + Send>) -> Error {
    let msg = if let Some(s) = p.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "a panic".to_string()
    };
    Error::Other {
        domain: "panic".into(),
        number: 0,
        message: msg,
    }
}

/// Runs f, catching a panic, which must not unwind into Go.
fn guard<R>(f: impl FnOnce() -> R) -> Result<R, Error> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(panic_error)
}

/// Runs what returns at once, which writes its result to the writer.
fn run(body: impl FnOnce(&mut Writer) -> Result<(), Error>) -> *mut u8 {
    let mut w = Writer::new();
    match guard(|| body(&mut w)).and_then(|r| r) {
        Ok(()) => w.block(STATUS_OK),
        Err(e) => {
            w.reset();
            write_error(&mut w, &e);
            w.block(STATUS_ERROR)
        }
    }
}

/// Runs what starts an asynchronous call or a stream: Go waits for its
/// results through the callback.
fn start(body: impl FnOnce() -> Result<(), Error>) -> *mut u8 {
    let mut w = Writer::new();
    match guard(body).and_then(|r| r) {
        Ok(()) => w.block(STATUS_PENDING),
        Err(e) => {
            write_error(&mut w, &e);
            w.block(STATUS_ERROR)
        }
    }
}

/// Tells Go something, with the values w holds, and returns its answer, a
/// block to read with answer, if any.
fn send(kind: u64, id: u64, status: i64, w: Option<&Writer>) -> *mut u8 {
    let rt = rt();
    unsafe {
        match w {
            Some(w) if !w.data().is_empty() => (rt.cb)(kind, id, status, w.data().as_ptr(), w.data().len()),
            _ => (rt.cb)(kind, id, status, std::ptr::null(), 0),
        }
    }
}

/// Reads a block Go answered with, and frees it.
fn answer<R>(p: *mut u8, read: impl FnOnce(&mut Reader) -> Result<R, Error>) -> Result<R, Error> {
    if p.is_null() {
        return Err(Error::Closed);
    }
    unsafe {
        let head = std::slice::from_raw_parts(p, 16);
        let status = i64::from_le_bytes(head[..8].try_into().unwrap());
        let n = i64::from_le_bytes(head[8..].try_into().unwrap()) as usize;
        let mut r = Reader::new(p.add(16), n);
        let v = if status == STATUS_ERROR {
            Err(read_error(&mut r))
        } else {
            read(&mut r)
        };
        (rt().free)(p);
        v
    }
}

fn retain(o: Obj) -> u64 {
    Box::into_raw(Box::new(o)) as u64
}

fn object<'a>(h: u64) -> Result<&'a Obj, Error> {
    if h == 0 {
        return Err(Error::Closed);
    }
    Ok(unsafe { &*(h as *const Obj) })
}

struct Table<V> {
    m: std::sync::Mutex<Option<HashMap<u64, V>>>,
}

impl<V> Table<V> {
    const fn new() -> Self {
        Table {
            m: std::sync::Mutex::new(None),
        }
    }

    fn put(&self, k: u64, v: V) {
        self.m.lock().unwrap().get_or_insert_with(HashMap::new).insert(k, v);
    }

    fn remove(&self, k: u64) -> Option<V> {
        self.m.lock().unwrap().as_mut().and_then(|m| m.remove(&k))
    }

    fn with<R>(&self, k: u64, f: impl FnOnce(&V) -> R) -> Option<R> {
        self.m.lock().unwrap().as_ref().and_then(|m| m.get(&k)).map(f)
    }
}

/// The contexts of asynchronous calls and streams, by their call, which
/// Go cancels.
static TASKS: Table<Arc<Context>> = Table::new();
/// Go's demands for the next values of streams.
static DEMANDS: Table<std::sync::mpsc::Sender<()>> = Table::new();
/// The calls waiting for Go to answer, by their continuation.
static CONTS: Table<std::sync::mpsc::Sender<usize>> = Table::new();

static LAST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The id of a continuation: the module's index, from Go, in its high bits
/// makes it unique among modules.
fn next_id() -> u64 {
    rt().id_base | (LAST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1)
}

fn cancel(call: u64) {
    TASKS.with(call, |c| c.cancel());
    // A stream waiting for Go's next demand stops.
    DEMANDS.remove(call);
}

fn demand(call: u64) {
    DEMANDS.with(call, |d| {
        let _ = d.send(());
    });
}

fn resume(cont: u64, block: *mut u8) {
    match CONTS.remove(cont) {
        Some(c) => {
            let _ = c.send(block as usize);
        }
        None => unsafe { (rt().free)(block) },
    }
}

/// Runs an asynchronous call on a thread of its own, which reports its
/// result through the callback.
fn task(call: u64, body: impl FnOnce(&Context, &mut Writer) -> Result<(), Error> + Send + 'static) {
    let ctx = Arc::new(Context::new());
    TASKS.put(call, Arc::clone(&ctx));
    std::thread::spawn(move || {
        let mut w = Writer::new();
        let status = match guard(|| body(&ctx, &mut w)).and_then(|r| r) {
            Ok(()) => STATUS_OK,
            Err(e) => {
                w.reset();
                write_error(&mut w, &e);
                STATUS_ERROR
            }
        };
        TASKS.remove(call);
        send(KIND_RESULT, call, status, Some(&w));
    });
}

/// Runs a stream on a thread of its own, which yields a value each time Go
/// asks for one.
fn stream<T: 'static>(
    call: u64,
    make: impl FnOnce(&Context) -> Stream<Result<T, Error>> + Send + 'static,
    enc: fn(&mut Writer, &T),
) {
    let ctx = Arc::new(Context::new());
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    TASKS.put(call, Arc::clone(&ctx));
    DEMANDS.put(call, tx);
    std::thread::spawn(move || {
        let mut w = Writer::new();
        let mut it = match guard(|| make(&ctx)) {
            Ok(it) => Some(it),
            Err(e) => {
                write_error(&mut w, &e);
                None
            }
        };
        while rx.recv().is_ok() {
            let Some(s) = it.as_mut() else {
                send(KIND_ITEM, call, STATUS_ERROR, Some(&w));
                break;
            };
            w.reset();
            match guard(|| s.next()) {
                Ok(None) => {
                    send(KIND_ITEM, call, STATUS_END, None);
                    break;
                }
                Ok(Some(Ok(v))) => {
                    enc(&mut w, &v);
                    send(KIND_ITEM, call, STATUS_OK, Some(&w));
                }
                Ok(Some(Err(e))) | Err(e) => {
                    write_error(&mut w, &e);
                    send(KIND_ITEM, call, STATUS_ERROR, Some(&w));
                    break;
                }
            }
        }
        DEMANDS.remove(call);
        TASKS.remove(call);
    });
}

/// A Go function the implementation calls: a notification, or a question
/// Go answers at once.
struct GoFunc {
    id: u64,
}

impl GoFunc {
    fn new(id: u64) -> Self {
        GoFunc { id }
    }

    fn notify(&self, w: Writer) {
        if self.id != 0 {
            send(KIND_NOTIFY, self.id, 0, Some(&w));
        }
    }

    fn ask<R>(&self, w: Writer, read: impl FnOnce(&mut Reader) -> Result<R, Error>) -> Result<R, Error> {
        if self.id == 0 {
            return Err(Error::Closed);
        }
        answer(send(KIND_ASK, self.id, 0, Some(&w)), read)
    }
}

impl Drop for GoFunc {
    fn drop(&mut self) {
        if self.id != 0 {
            send(KIND_RELEASE, self.id, 0, None);
        }
    }
}

/// Calls the method of a value of Go's that w names, with the arguments
/// after it.
fn invoke<R>(id: u64, w: Writer, read: impl FnOnce(&mut Reader) -> Result<R, Error>) -> Result<R, Error> {
    answer(send(KIND_INVOKE, id, 0, Some(&w)), read)
}

/// Calls a method of Go's that takes a context, which ctx cancels, and
/// waits for its answer.
fn invoke_async<R>(id: u64, ctx: &Context, w: Writer, read: impl FnOnce(&mut Reader) -> Result<R, Error>) -> Result<R, Error> {
    let cont = next_id();
    let (tx, rx) = std::sync::mpsc::channel::<usize>();
    CONTS.put(cont, tx);
    send(KIND_INVOKE_ASYNC, id, cont as i64, Some(&w));
    let mut canceled = false;
    let p = loop {
        match rx.recv_timeout(Duration::from_millis(10)) {
            Ok(p) => break p,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if !canceled && ctx.is_canceled() {
                    canceled = true;
                    send(KIND_CANCEL, cont, 0, None);
                }
            }
            Err(_) => break 0,
        }
    };
    answer(p as *mut u8, read)
}
`
