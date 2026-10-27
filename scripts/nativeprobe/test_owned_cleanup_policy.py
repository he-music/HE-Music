"""All fixtures are synthetic; no process, signal, socket or system clock calls."""

import errno
import unittest

from scripts.nativeprobe.owned_cleanup_policy import (
    Category, CleanupState, Group, OwnedToolCapability, OwnedToolHandle, Phase,
    Record, RootObservation, Signal, StreamRead, classify, cleanup_candidate,
    finalize_candidate, persistence_complete, summarize,
)


class FakeHandle(OwnedToolHandle):
    pass


class ControllerHandle:
    pass


class LSObject:
    pass


class FakeClock:
    def __init__(self, values=None):
        self.values = list(values or [0.0])
        self.last = 0.0
        self.calls = 0

    def now(self):
        self.calls += 1
        if self.values:
            value = self.values.pop(0)
            if isinstance(value, BaseException):
                raise value
            self.last = value
        return self.last


class FakeSink:
    def __init__(self, failures=()):
        self.failures = set(failures)
        self.records = {record: [] for record in Record}
        self.attempts = []

    def write(self, record, payload):
        self.attempts.append(record)
        if record in self.failures:
            raise OSError(errno.ENOSPC, "synthetic-only")
        self.records[record].append(payload)


class FakeAdapter:
    def __init__(self, group=None, term=None, kill=None, poll=None, reap=None,
                 stdout=None, stderr=None, pause=None):
        self.groups = list(group or [Group.ABSENT])
        self.last_group = Group.ABSENT
        self.term = term
        self.kill = kill
        self.root_poll = poll if poll is not None else RootObservation(True, 0, False)
        self.root_reap = reap if reap is not None else RootObservation(True, 0, True)
        self.streams = {
            Record.STDOUT: stdout if stdout is not None else StreamRead(True, True, b"fake-a"),
            Record.STDERR: stderr if stderr is not None else StreamRead(True, True, b"fake-b"),
        }
        self.pause_result = pause
        self.calls = []
        self.budgets = []

    def take(self, name, value, capability=None):
        if capability is not None:
            if type(capability) is not OwnedToolCapability:
                raise AssertionError("unexpected capability")
        self.calls.append(name)
        if isinstance(value, BaseException):
            raise value
        return value

    def group(self, capability):
        if self.groups:
            self.last_group = self.groups.pop(0)
        return self.take("group", self.last_group, capability)

    def signal(self, capability, signal):
        return self.take(signal.value, self.term if signal is Signal.TERM else self.kill, capability)

    def poll(self, capability):
        return self.take("poll", self.root_poll, capability)

    def reap(self, capability, budget):
        self.budgets.append(budget)
        return self.take("reap", self.root_reap, capability)

    def collect(self, capability, stream, budget):
        self.budgets.append(budget)
        return self.take(stream.value, self.streams[stream], capability)

    def pause(self, budget):
        self.budgets.append(budget)
        return self.take("pause", self.pause_result)


class OwnedCleanupPolicyTests(unittest.TestCase):
    def run_policy(self, adapter=None, clock=None, sink=None, **kwargs):
        adapter = adapter or FakeAdapter()
        clock = clock or FakeClock()
        sink = sink or FakeSink()
        state = cleanup_candidate(OwnedToolCapability(FakeHandle()), adapter, clock, sink, **kwargs)
        return state, adapter, clock, sink

    def test_esrch_races_on_probe_term_and_kill(self):
        cases = (
            (FakeAdapter(group=[OSError(errno.ESRCH, "synthetic-only")]), Phase.GROUP_CHECK, False),
            (FakeAdapter(group=[Group.ALIVE, Group.ABSENT], term=OSError(errno.ESRCH, "synthetic-only")), Phase.TERM, False),
            (FakeAdapter(group=[Group.ALIVE, OSError(errno.ESRCH, "synthetic-only")]), Phase.GROUP_CHECK, False),
            (FakeAdapter(group=[Group.ALIVE, Group.ALIVE, Group.ABSENT], kill=OSError(errno.ESRCH, "synthetic-only")), Phase.KILL, True),
        )
        for adapter, phase, killed in cases:
            with self.subTest(phase=phase, killed=killed):
                state, _, _, _ = self.run_policy(adapter, max_polls=1)
                self.assertTrue(state.group_absent)
                self.assertEqual(state.phases[phase].category, Category.ABSENT)
                self.assertEqual("kill" in adapter.calls, killed)
                self.assertIn("reap", adapter.calls)
                self.assertIn("stdout", adapter.calls)
                self.assertIn("stderr", adapter.calls)

    def test_signal_return_is_not_group_end(self):
        state, adapter, _, _ = self.run_policy(
            FakeAdapter(group=[Group.ALIVE, Group.ALIVE, RuntimeError("synthetic-only")]),
            max_polls=1,
        )
        self.assertEqual(state.phases[Phase.KILL].category, Category.RETURNED)
        self.assertIs(state.group_absent, False)
        self.assertEqual(adapter.calls.count("kill"), 1)
        self.assertEqual(state.phases[Phase.GROUP_FINAL].category, Category.UNKNOWN)

    def test_root_exit_is_independent_of_pipe_timeout_and_reap_failure(self):
        state, _, _, sink = self.run_policy(FakeAdapter(
            reap=OSError(errno.EIO, "synthetic-only"), stdout=TimeoutError(),
            stderr=RuntimeError("synthetic-only"),
        ))
        self.assertTrue(state.root.exited)
        self.assertEqual(state.root.exit_code, 0)
        self.assertIs(state.root.reaped, False)
        self.assertIsNone(state.stdout.byte_count)
        self.assertIsNone(state.stdout.sha256)
        self.assertEqual(state.phases[Phase.STDOUT].category, Category.TIMEOUT)
        self.assertEqual(state.phases[Phase.STDERR].category, Category.UNKNOWN)
        self.assertTrue(any(row["root"].exited for row in sink.records[Record.CHECKPOINT]))

    def test_group_absent_still_reaps_and_collects_both_streams(self):
        state, adapter, _, _ = self.run_policy()
        self.assertTrue(state.root.reaped)
        self.assertNotIn("term", adapter.calls)
        self.assertNotIn("kill", adapter.calls)
        self.assertEqual(adapter.calls[-4:], ["poll", "reap", "stdout", "stderr"])

    def test_no_handle_never_signals_or_guesses_identity(self):
        adapter, clock, sink = FakeAdapter(), FakeClock(), FakeSink()
        state = cleanup_candidate(None, adapter, clock, sink)
        self.assertEqual(state.phases[Phase.SPAWN].category, Category.NO_HANDLE)
        self.assertEqual(adapter.calls, [])
        self.assertEqual(clock.calls, 0)
        self.assertEqual(sink.attempts, [])
        self.assertIsNone(state.root.exited)

    def test_rejects_controller_ls_and_raw_identifiers(self):
        for value in (ControllerHandle(), LSObject(), 123, "123", object()):
            with self.subTest(kind=type(value).__name__):
                with self.assertRaises(TypeError):
                    OwnedToolCapability(value)
                adapter = FakeAdapter()
                with self.assertRaises(TypeError):
                    cleanup_candidate(value, adapter, FakeClock(), FakeSink())
                self.assertEqual(adapter.calls, [])

    def test_poll_and_collect_failures_do_not_skip_other_legs_or_tools(self):
        state, adapter, _, _ = self.run_policy(FakeAdapter(
            poll=RuntimeError("synthetic-only"), stdout=OSError(errno.EBADF, "synthetic-only")
        ))
        self.assertTrue(state.root.reaped)
        self.assertTrue(state.root.exited)
        self.assertTrue(state.stderr.complete)
        self.assertIn("stderr", adapter.calls)
        self.assertEqual(state.phases[Phase.ROOT_POLL].category, Category.UNKNOWN)
        second, _, _, _ = self.run_policy()
        self.assertTrue(second.root.reaped)
        self.assertTrue(second.stdout.complete)

    def test_partial_and_unknown_stream_summaries(self):
        state, _, _, sink = self.run_policy(FakeAdapter(
            stdout=StreamRead(True, False, b"synthetic-part"), stderr=StreamRead()
        ))
        self.assertIs(state.stdout.complete, False)
        self.assertEqual(state.stdout.byte_count, 14)
        self.assertEqual(len(state.stdout.sha256), 64)
        self.assertIsNone(state.stderr.complete)
        self.assertIsNone(state.stderr.byte_count)
        self.assertIsNone(state.stderr.sha256)
        self.assertIsInstance(sink.records[Record.STDOUT][0].sha256, str)

    def test_summary_and_sink_failures_are_independent(self):
        count = [0]

        def summary(value):
            count[0] += 1
            if count[0] == 1:
                raise RuntimeError("synthetic-only")
            return summarize(value)

        sink = FakeSink([Record.STDOUT, Record.CHECKPOINT])
        state, _, _, _ = self.run_policy(sink=sink, summary=summary)
        self.assertTrue(state.stdout.available)
        self.assertTrue(state.stdout.complete)
        self.assertIsNone(state.stdout.byte_count)
        self.assertEqual(state.stderr.byte_count, 6)
        self.assertIs(state.persisted[Record.STDOUT], False)
        self.assertIs(state.persisted[Record.STDERR], True)
        self.assertTrue(state.root.reaped)
        self.assertEqual(state.phases[Phase.STDOUT_SUMMARY].category, Category.UNKNOWN)
        self.assertEqual(state.phases[Phase.STDOUT_WRITE].category, Category.IO)

    def test_stopped_clock_has_finite_iterations_and_no_wallclock_assertion(self):
        state, adapter, clock, _ = self.run_policy(
            FakeAdapter(group=[Group.ALIVE]), max_polls=3
        )
        self.assertEqual(adapter.calls.count("pause"), 3)
        self.assertEqual(adapter.calls.count("kill"), 1)
        self.assertLessEqual(clock.calls, 8)
        self.assertTrue(all(0 <= value <= 5 for value in adapter.budgets))
        self.assertTrue(state.root.reaped)

    def test_fake_deadline_and_keyboard_interrupt_keep_other_legs(self):
        state, adapter, _, _ = self.run_policy(
            FakeAdapter(group=[Group.ALIVE]), FakeClock([0.0, 5.0])
        )
        self.assertNotIn("pause", adapter.calls)
        self.assertTrue(state.root.reaped)
        state, adapter, _, _ = self.run_policy(FakeAdapter(
            group=[Group.ALIVE, Group.ABSENT], pause=KeyboardInterrupt(),
            stdout=KeyboardInterrupt(),
        ))
        self.assertTrue(state.root.reaped)
        self.assertTrue(state.stderr.complete)
        self.assertEqual(state.phases[Phase.STDOUT].category, Category.INTERRUPTED)
        self.assertEqual(state.phases[Phase.TERM_WAIT].category, Category.INTERRUPTED)
        self.assertIn("stderr", adapter.calls)

    def test_initial_clock_interrupt_preserves_failure_and_finishes_legs(self):
        state, adapter, _, _ = self.run_policy(clock=FakeClock([KeyboardInterrupt(), 0.0]))
        self.assertEqual(state.phases[Phase.CLOCK].first_failure, Category.INTERRUPTED)
        self.assertTrue(state.root.reaped)
        self.assertIn("stdout", adapter.calls)
        self.assertIn("stderr", adapter.calls)

    def test_second_summary_failure_preserves_first_stream_and_known_flags(self):
        count = [0]

        def summary(value):
            count[0] += 1
            if count[0] == 2:
                raise RuntimeError("synthetic-only")
            return summarize(value)

        state, _, _, _ = self.run_policy(summary=summary)
        self.assertEqual(state.stdout.byte_count, 6)
        self.assertEqual(len(state.stdout.sha256), 64)
        self.assertTrue(state.stderr.available)
        self.assertTrue(state.stderr.complete)
        self.assertIsNone(state.stderr.byte_count)
        self.assertIsNone(state.stderr.sha256)
        self.assertEqual(state.phases[Phase.STDERR_SUMMARY].category, Category.UNKNOWN)

    def test_unknown_reap_cannot_revert_observed_exit(self):
        state, _, _, _ = self.run_policy(FakeAdapter(
            poll=RootObservation(True, 7, True), reap=RootObservation()
        ))
        self.assertTrue(state.root.exited)
        self.assertTrue(state.root.reaped)
        self.assertEqual(state.root.exit_code, 7)

    def test_first_group_failure_survives_later_return(self):
        state, adapter, _, _ = self.run_policy(FakeAdapter(
            group=[RuntimeError("synthetic-only"), Group.ABSENT]
        ))
        slot = state.phases[Phase.GROUP_CHECK]
        self.assertEqual(slot.category, Category.RETURNED)
        self.assertEqual(slot.first_failure, Category.UNKNOWN)
        self.assertIsNone(slot.first_failure_errno)
        self.assertTrue(state.group_absent)
        self.assertTrue(state.root.reaped)
        self.assertIn("stdout", adapter.calls)
        self.assertIn("stderr", adapter.calls)

    def test_error_categories_have_only_whitelisted_errno_and_no_body(self):
        class UnknownException(Exception):
            def __str__(self):
                raise AssertionError("must not stringify")

            def __repr__(self):
                raise AssertionError("must not repr")

        self.assertEqual(classify(UnknownException()), (Category.UNKNOWN, None))
        self.assertEqual(classify(OSError(9999, "synthetic-only")), (Category.UNKNOWN, None))
        for number in (errno.ESRCH, errno.EPERM, errno.EACCES, errno.EINTR,
                       errno.EIO, errno.EBADF, errno.ENOSPC, errno.EEXIST):
            self.assertEqual(classify(OSError(number, "synthetic-only"))[1], number)
        state, _, _, _ = self.run_policy(FakeAdapter(poll=UnknownException()))
        self.assertEqual(state.phases[Phase.ROOT_POLL].category, Category.UNKNOWN)

    def test_result_manifest_and_terminal_failures_leave_finite_receipt(self):
        for failed in (Record.RESULT, Record.MANIFEST, Record.TERMINAL):
            with self.subTest(failed=failed):
                sink = FakeSink([failed])
                state, _, _, _ = self.run_policy(sink=sink)
                finalize_candidate(state, sink)
                self.assertIs(state.persisted[failed], False)
                self.assertFalse(persistence_complete(state))
                self.assertEqual(sink.attempts[-3:], [Record.RESULT, Record.MANIFEST, Record.TERMINAL])
                self.assertEqual(sink.attempts.count(Record.RESULT), 1)
                if failed is not Record.TERMINAL:
                    self.assertFalse(sink.records[Record.TERMINAL][0]["complete"])
                if failed is Record.MANIFEST:
                    old = sink.records[Record.RESULT][0]
                    self.assertIsNone(old["persisted"][Record.MANIFEST])
                    receipt = sink.records[Record.TERMINAL][0]["status"]
                    self.assertIs(receipt["persisted"][Record.MANIFEST], False)
        state, _, _, sink = self.run_policy()
        finalize_candidate(state, sink)
        self.assertTrue(persistence_complete(state))
        self.assertTrue(sink.records[Record.TERMINAL][0]["complete"])
        with self.assertRaises(ValueError):
            finalize_candidate(state, sink)
        self.assertEqual(sink.attempts.count(Record.RESULT), 1)

    def test_sink_retains_early_fact_snapshots_without_late_mutation(self):
        state, _, _, sink = self.run_policy()
        first = sink.records[Record.CHECKPOINT][0]
        self.assertIsNone(first["root"].exited)
        self.assertTrue(state.root.exited)
        self.assertIsNone(first["persisted"][Record.STDERR])

    def test_invalid_budgets_never_touch_adapter(self):
        for budget, polls in ((float("inf"), 1), (-1.0, 1), (1.0, 0), (1.0, 33)):
            adapter = FakeAdapter()
            with self.assertRaises(ValueError):
                self.run_policy(adapter, budget=budget, max_polls=polls)
            self.assertEqual(adapter.calls, [])
