"""Candidate-only finite cleanup policy; no runtime adapter or launcher is installed.

Capabilities must come from the caller's already established tool ownership. This
nominal boundary is not an ownership discovery/authentication mechanism.
"""

from dataclasses import dataclass, field, replace
from enum import Enum
import errno
import hashlib
import math
from typing import Callable, Dict, Optional, Protocol, Tuple, TypeVar


class Phase(str, Enum):
    SPAWN = "spawn"
    GROUP_CHECK = "group-check"
    TERM = "term"
    TERM_WAIT = "term-wait"
    CLOCK = "clock"
    KILL = "kill"
    GROUP_FINAL = "group-final"
    ROOT_POLL = "root-poll"
    ROOT_REAP = "root-reap"
    STDOUT = "stdout-collect"
    STDERR = "stderr-collect"
    STDOUT_SUMMARY = "stdout-summary"
    STDERR_SUMMARY = "stderr-summary"
    CHECKPOINT = "checkpoint"
    STDOUT_WRITE = "stdout-write"
    STDERR_WRITE = "stderr-write"
    RESULT = "result"
    MANIFEST = "manifest"
    TERMINAL = "terminal"


class Category(str, Enum):
    NOT_REACHED = "not-reached"
    ENTERED = "entered"
    RETURNED = "returned"
    ABSENT = "absent"
    TIMEOUT = "timeout"
    PERMISSION = "permission-denied"
    INTERRUPTED = "interrupted"
    IO = "io-error"
    UNKNOWN = "unknown"
    NO_HANDLE = "no-handle"


class Group(str, Enum):
    ALIVE = "alive"
    ABSENT = "absent"


class Signal(str, Enum):
    TERM = "term"
    KILL = "kill"


class Record(str, Enum):
    CHECKPOINT = "checkpoint"
    STDOUT = "stdout"
    STDERR = "stderr"
    RESULT = "result"
    MANIFEST = "manifest"
    TERMINAL = "terminal"


class OwnedToolHandle:
    """Nominal handle base for an adapter's already acquired owned tool only."""


@dataclass(frozen=True)
class OwnedToolCapability:
    handle: OwnedToolHandle

    def __post_init__(self) -> None:
        if not isinstance(self.handle, OwnedToolHandle):
            raise TypeError("owned tool handle required")


@dataclass(frozen=True)
class RootObservation:
    exited: Optional[bool] = None
    exit_code: Optional[int] = None
    reaped: Optional[bool] = None


@dataclass(frozen=True)
class StreamRead:
    available: Optional[bool] = None
    complete: Optional[bool] = None
    data: Optional[bytes] = None


@dataclass(frozen=True)
class StreamSummary:
    available: Optional[bool] = None
    complete: Optional[bool] = None
    byte_count: Optional[int] = None
    sha256: Optional[str] = None


@dataclass
class PhaseState:
    category: Category = Category.NOT_REACHED
    errno: Optional[int] = None
    calls: int = 0
    first_failure: Optional[Category] = None
    first_failure_errno: Optional[int] = None


@dataclass
class CleanupState:
    root: RootObservation = field(default_factory=RootObservation)
    group_absent: Optional[bool] = None
    stdout: StreamSummary = field(default_factory=StreamSummary)
    stderr: StreamSummary = field(default_factory=StreamSummary)
    phases: Dict[Phase, PhaseState] = field(
        default_factory=lambda: {phase: PhaseState() for phase in Phase}
    )
    persisted: Dict[Record, Optional[bool]] = field(
        default_factory=lambda: {record: None for record in Record}
    )


class Adapter(Protocol):
    def group(self, capability: OwnedToolCapability) -> Group: ...
    def signal(self, capability: OwnedToolCapability, signal: Signal) -> None: ...
    def poll(self, capability: OwnedToolCapability) -> RootObservation: ...
    def reap(self, capability: OwnedToolCapability, budget: float) -> RootObservation: ...
    def collect(
        self, capability: OwnedToolCapability, stream: Record, budget: float
    ) -> StreamRead: ...
    def pause(self, budget: float) -> None: ...


class Clock(Protocol):
    def now(self) -> float: ...


class Sink(Protocol):
    def write(self, record: Record, payload: object) -> None: ...


_ALLOWED_ERRNOS = frozenset(
    (errno.ESRCH, errno.EPERM, errno.EACCES, errno.EINTR,
     errno.EIO, errno.EBADF, errno.ENOSPC, errno.EEXIST)
)
T = TypeVar("T")


def classify(error: BaseException) -> Tuple[Category, Optional[int]]:
    number = error.errno if isinstance(error, OSError) else None
    number = number if type(number) is int and number in _ALLOWED_ERRNOS else None
    if isinstance(error, KeyboardInterrupt) or number == errno.EINTR:
        return Category.INTERRUPTED, number
    if isinstance(error, TimeoutError):
        return Category.TIMEOUT, number
    if number == errno.ESRCH:
        return Category.ABSENT, number
    if number in (errno.EPERM, errno.EACCES):
        return Category.PERMISSION, number
    if number in (errno.EIO, errno.EBADF, errno.ENOSPC, errno.EEXIST):
        return Category.IO, number
    return Category.UNKNOWN, number


def _attempt(state: CleanupState, phase: Phase, action: Callable[[], T]) -> Tuple[bool, Optional[T]]:
    slot = state.phases[phase]
    slot.calls += 1
    slot.category, slot.errno = Category.ENTERED, None
    try:
        value = action()
    except (Exception, KeyboardInterrupt) as error:
        slot.category, slot.errno = classify(error)
        if slot.first_failure is None:
            slot.first_failure, slot.first_failure_errno = slot.category, slot.errno
        return False, None
    slot.category = Category.RETURNED
    return True, value


def _view(state: CleanupState) -> dict:
    # Copies prevent a sink retaining an old record from seeing later mutations.
    return {
        "root": replace(state.root),
        "groupAbsent": state.group_absent,
        "stdout": replace(state.stdout),
        "stderr": replace(state.stderr),
        "phases": {phase: replace(slot) for phase, slot in state.phases.items()},
        "persisted": dict(state.persisted),
    }


def _persist(state: CleanupState, sink: Sink, record: Record, phase: Phase, payload: object) -> None:
    ok, _ = _attempt(state, phase, lambda: sink.write(record, payload))
    state.persisted[record] = ok


def _root(state: CleanupState, value: RootObservation) -> None:
    previous = state.root
    # Positive exit/reap facts survive a subsequent unknown or stale negative.
    state.root = RootObservation(
        True if previous.exited is True else (
            value.exited if value.exited is not None else previous.exited
        ),
        previous.exit_code if previous.exit_code is not None else value.exit_code,
        True if previous.reaped is True else (
            value.reaped if value.reaped is not None else previous.reaped
        ),
    )


def summarize(value: StreamRead) -> StreamSummary:
    return StreamSummary(
        value.available,
        value.complete,
        len(value.data) if value.data is not None else None,
        hashlib.sha256(value.data).hexdigest() if value.data is not None else None,
    )


def _group(state: CleanupState, phase: Phase, capability: OwnedToolCapability, adapter: Adapter) -> None:
    ok, value = _attempt(state, phase, lambda: adapter.group(capability))
    if (ok and value is Group.ABSENT) or state.phases[phase].category is Category.ABSENT:
        state.group_absent = True
    elif ok and value is Group.ALIVE and state.group_absent is not True:
        state.group_absent = False


def _signal(state: CleanupState, phase: Phase, signal: Signal,
            capability: OwnedToolCapability, adapter: Adapter) -> None:
    _attempt(state, phase, lambda: adapter.signal(capability, signal))
    if state.phases[phase].category is Category.ABSENT:
        state.group_absent = True
    # A returned signal is not evidence that the group ended.


def cleanup_candidate(
    capability: Optional[OwnedToolCapability], adapter: Adapter, clock: Clock, sink: Sink,
    budget: float = 5.0, max_polls: int = 8,
    summary: Callable[[StreamRead], StreamSummary] = summarize,
) -> CleanupState:
    """Pure policy over supplied adapters; no spawn, PID, PGID or OS discovery.

    Each adapter call must honor its supplied remaining budget. The iteration
    bound also terminates a stopped fake clock; this is not a runtime timeout
    implementation. Root/streams are independent legs even when the group is absent.
    """
    if capability is not None and type(capability) is not OwnedToolCapability:
        raise TypeError("owned tool capability required")
    if not math.isfinite(budget) or budget < 0 or not 1 <= max_polls <= 32:
        raise ValueError("finite budget and bounded poll count required")
    state = CleanupState()
    if capability is None:
        state.phases[Phase.SPAWN].category = Category.NO_HANDLE
        return state
    state.phases[Phase.SPAWN].category = Category.RETURNED
    ok, start = _attempt(state, Phase.CLOCK, clock.now)
    remaining = budget if ok and start is not None and math.isfinite(start) else 0.0

    def checkpoint() -> None:
        _persist(state, sink, Record.CHECKPOINT, Phase.CHECKPOINT, _view(state))

    def refresh_budget() -> float:
        nonlocal remaining
        ok_now, now = _attempt(state, Phase.CLOCK, clock.now)
        if not ok_now or now is None or start is None or not math.isfinite(now):
            remaining = 0.0
        else:
            remaining = min(remaining, max(0.0, budget - max(0.0, now - start)))
        return remaining

    _group(state, Phase.GROUP_CHECK, capability, adapter)
    checkpoint()
    if state.group_absent is not True:
        _signal(state, Phase.TERM, Signal.TERM, capability, adapter)
        checkpoint()
        for _ in range(max_polls):
            if state.group_absent is True or refresh_budget() <= 0:
                break
            ok_pause, _ = _attempt(state, Phase.TERM_WAIT, lambda: adapter.pause(remaining))
            if not ok_pause:
                break
            _group(state, Phase.GROUP_CHECK, capability, adapter)
            checkpoint()
        if state.group_absent is not True:
            if state.phases[Phase.TERM_WAIT].category is Category.RETURNED:
                state.phases[Phase.TERM_WAIT].category = Category.TIMEOUT
                if state.phases[Phase.TERM_WAIT].first_failure is None:
                    state.phases[Phase.TERM_WAIT].first_failure = Category.TIMEOUT
            _signal(state, Phase.KILL, Signal.KILL, capability, adapter)
            checkpoint()
    _group(state, Phase.GROUP_FINAL, capability, adapter)
    checkpoint()
    for phase, action in (
        (Phase.ROOT_POLL, lambda: adapter.poll(capability)),
        (Phase.ROOT_REAP, lambda: adapter.reap(capability, refresh_budget())),
    ):
        ok_root, value = _attempt(state, phase, action)
        if ok_root and value is not None:
            _root(state, value)
        checkpoint()
    for stream, collect_phase, summary_phase, write_phase in (
        (Record.STDOUT, Phase.STDOUT, Phase.STDOUT_SUMMARY, Phase.STDOUT_WRITE),
        (Record.STDERR, Phase.STDERR, Phase.STDERR_SUMMARY, Phase.STDERR_WRITE),
    ):
        ok_stream, value = _attempt(
            state, collect_phase, lambda: adapter.collect(capability, stream, refresh_budget())
        )
        if ok_stream and value is not None:
            # Availability/completeness are committed even if summarizing later fails.
            known = StreamSummary(value.available, value.complete)
            setattr(state, stream.value, known)
            checkpoint()
            ok_summary, result = _attempt(state, summary_phase, lambda: summary(value))
            if ok_summary and result is not None:
                setattr(state, stream.value, result)
        _persist(state, sink, stream, write_phase, getattr(state, stream.value))
        checkpoint()
    return state


def finalize_candidate(state: CleanupState, sink: Sink) -> CleanupState:
    """Append independent result, manifest and terminal receipt once, never rewrite.

    The terminal receipt describes result/manifest persistence after both attempts.
    Its own failure is returned in memory as incomplete; file existence is never
    treated as proof. There is no self hash or claim of repairing the old wrapper.
    """
    if any(state.persisted[record] is not None for record in (
        Record.RESULT, Record.MANIFEST, Record.TERMINAL
    )):
        raise ValueError("finalization already attempted")
    _persist(state, sink, Record.RESULT, Phase.RESULT, _view(state))
    _persist(state, sink, Record.MANIFEST, Phase.MANIFEST, _view(state))
    complete = all(state.persisted[record] is True for record in Record if record is not Record.TERMINAL)
    _persist(state, sink, Record.TERMINAL, Phase.TERMINAL,
             {"complete": complete, "status": _view(state)})
    return state


def persistence_complete(state: CleanupState) -> bool:
    return all(state.persisted[record] is True for record in Record)
