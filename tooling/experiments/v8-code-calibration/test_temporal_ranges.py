import copy
import hashlib
import json
import sys
import unittest
from pathlib import Path
from temporal_ranges import pb, decode, classify as raw_classify, Unqualified

PID = 321
URL = 'http://127.0.0.1:12345/calibration.js'
A = (7, URL, 'calibrationA', 2, 3)
B = (7, URL, 'calibrationB', 8, 3)


def classify(ranges, pid, time_ns, ip):
    return raw_classify(ranges, pid, time_ns, ip, expected_isolate=4, collection=(50, 300))


def fixture():
    trace = pb.Trace()
    p = trace.packet.add(trusted_packet_sequence_id=1, sequence_flags=1)
    p.trace_packet_defaults.timestamp_clock_id = 3
    p.trace_packet_defaults.v8_code_defaults.tid = PID
    d = p.interned_data
    d.v8_isolate.add(iid=1, pid=PID, isolate_id=4)
    s = d.v8_js_script.add(iid=1, script_id=7)
    s.name.latin1 = URL.encode()
    for iid, name, line in [(1, 'calibrationA', 2), (2, 'calibrationB', 8)]:
        d.v8_js_function_name.add(iid=iid, latin1=name.encode())
        d.v8_js_function.add(iid=iid, v8_js_function_name_iid=iid, v8_js_script_iid=1, line=line, column=3)
    create(trace, 100, 1000, 1)
    return trace


def create(trace, at, address, function, size=100):
    p = trace.packet.add(trusted_packet_sequence_id=1, sequence_flags=2, timestamp=at)
    p.v8_js_code.CopyFrom(pb.V8JsCode(v8_isolate_iid=1, v8_js_function_iid=function, tier=pb.V8JsCode.TIER_TURBOFAN, instruction_start=address, instruction_size_bytes=size))
    return p


def move(trace, at, origin, target, size=100):
    p = trace.packet.add(trusted_packet_sequence_id=1, sequence_flags=2, timestamp=at)
    p.v8_code_move.CopyFrom(pb.V8CodeMove(isolate_iid=1, from_instruction_start_address=origin, to_instruction_start_address=target, instruction_size_bytes=size))
    return p


def ranges(trace):
    wire = trace.SerializeToString()
    assert pb.Trace.FromString(wire) == trace
    return decode(wire, PID)


class TemporalTests(unittest.TestCase):
    def test_roundtrip_preserves_64bit_addresses_and_clock_defaults(self):
        trace = fixture()
        trace.packet[1].v8_js_code.instruction_start = 2**60 + 1
        self.assertEqual(classify(ranges(trace), PID, 101, 2**60 + 2), A)

    def test_move_closes_old_address_and_preserves_new_lifetime(self):
        trace = fixture(); move(trace, 200, 1000, 2000)
        r = ranges(trace)
        self.assertEqual(classify(r, PID, 150, 1001), A)
        self.assertIsNone(classify(r, PID, 250, 1001))
        self.assertIsNone(classify(r, PID, 150, 2001))
        self.assertEqual(classify(r, PID, 250, 2001), A)
        # A static post-map would wrongly name the new address before its move.
        self.assertEqual(next(x.function for x in r if x.start == 2000), A)

    def test_reused_or_overlapping_extent_invalidates_whole_old_container(self):
        trace = fixture(); create(trace, 200, 1050, 2)
        r = ranges(trace)
        self.assertEqual(classify(r, PID, 150, 1051), A)
        self.assertEqual(classify(r, PID, 250, 1051), B)
        self.assertIsNone(classify(r, PID, 250, 1001))

    def test_non_js_creation_invalidates_old_js_extent(self):
        trace = fixture()
        p = trace.packet.add(trusted_packet_sequence_id=1, timestamp=200)
        p.v8_internal_code.CopyFrom(pb.V8InternalCode(v8_isolate_iid=1, instruction_start=1000, instruction_size_bytes=100))
        self.assertIsNone(classify(ranges(trace), PID, 250, 1001))

    def test_missing_or_partial_move_origin_rejects_instead_of_naming_old_source(self):
        for origin, size in [(9000, 100), (1000, 50), (1050, 100), (1000, 101)]:
            trace = fixture(); move(trace, 200, origin, 2000, size)
            with self.subTest(origin=origin, size=size), self.assertRaises(Unqualified): ranges(trace)

    def test_explicit_isolate_and_collection_window_are_required(self):
        r = ranges(fixture())
        self.assertIsNone(raw_classify(r, PID, 150, 1001))
        self.assertIsNone(raw_classify(r, PID, 150, 1001, expected_isolate=4))
        self.assertIsNone(raw_classify(r, PID, 150, 1001, collection=(50, 300)))
        for at in [50, 300, 500]:
            self.assertIsNone(raw_classify(r, PID, at, 1001, expected_isolate=4, collection=(50, 300)))

    def test_foreign_isolate_same_coordinates_cannot_be_named(self):
        trace = fixture(); trace.packet[0].interned_data.v8_isolate.add(iid=2, pid=PID, isolate_id=5)
        create(trace, 200, 2000, 1).v8_js_code.v8_isolate_iid = 2
        self.assertIsNone(classify(ranges(trace), PID, 250, 2001))
        # Foreign-isolate address reuse still retires the earlier local mapping.
        trace.packet[2].v8_js_code.instruction_start = 1000
        self.assertIsNone(classify(ranges(trace), PID, 250, 1001))

    def test_unknown_and_ignition_tiers_never_name_native_ip(self):
        for tier in [None, pb.V8JsCode.TIER_UNKNOWN, pb.V8JsCode.TIER_IGNITION]:
            trace = fixture(); trace.packet[1].v8_js_code.ClearField('tier')
            if tier is not None: trace.packet[1].v8_js_code.tier = tier
            with self.subTest(tier=tier): self.assertIsNone(classify(ranges(trace), PID, 150, 1001))

    def test_boundary_and_other_pid_are_unknown(self):
        r = ranges(fixture())
        for pid, at, ip in [(PID, 100, 1001), (PID, 99, 1001), (PID + 1, 150, 1001), (PID, 150, 1100)]:
            self.assertIsNone(classify(r, pid, at, ip))

    def test_reset_does_not_retroactively_rebind_live_code(self):
        trace = fixture()
        reset = copy.deepcopy(trace.packet[0]); reset.interned_data.v8_js_function_name[0].latin1 = b'other'
        trace.packet.append(reset)
        create(trace, 200, 2000, 1)
        r = ranges(trace)
        self.assertEqual(classify(r, PID, 250, 1001), A)
        self.assertEqual(classify(r, PID, 250, 2001)[2], 'other')

    def test_missing_or_conflicting_interned_evidence_rejects_trace(self):
        for change in ['missing', 'conflict', 'reset', 'sequence']:
            trace = fixture()
            if change == 'missing': trace.packet[0].interned_data.ClearField('v8_js_function')
            if change == 'conflict': trace.packet[0].interned_data.v8_js_function_name.add(iid=1, latin1=b'other')
            if change == 'reset': trace.packet[0].sequence_flags = 0
            if change == 'sequence': trace.packet[1].trusted_packet_sequence_id = 2
            with self.subTest(change=change), self.assertRaises(Unqualified): ranges(trace)

    def test_empty_incremental_reset_does_not_preserve_old_ids(self):
        trace = fixture(); trace.packet.add(trusted_packet_sequence_id=1, sequence_flags=1)
        create(trace, 200, 2000, 1)
        with self.assertRaises(Unqualified): ranges(trace)

    def test_empty_or_partial_defaults_replace_old_clock_and_tid(self):
        for field in [None, 'clock', 'tid']:
            trace = fixture(); p = trace.packet.add(trusted_packet_sequence_id=1)
            p.trace_packet_defaults.SetInParent()
            if field == 'clock': p.trace_packet_defaults.timestamp_clock_id = 3
            if field == 'tid': p.trace_packet_defaults.v8_code_defaults.tid = PID
            create(trace, 200, 2000, 1)
            with self.subTest(field=field), self.assertRaises(Unqualified): ranges(trace)

    def test_unknown_clock_loss_and_simultaneous_events_reject(self):
        for change in ['clock', 'loss', 'buffer', 'tie', 'flush', 'machine']:
            trace = fixture()
            if change == 'clock': trace.packet[0].trace_packet_defaults.timestamp_clock_id = 6
            if change == 'loss': trace.packet[1].previous_packet_dropped = 1
            if change == 'buffer': trace.packet.add().trace_stats.buffer_stats.add(bytes_overwritten=1)
            if change == 'tie': create(trace, 100, 2000, 2)
            if change == 'flush': trace.packet.add().trace_stats.final_flush_outcome = pb.TraceStats.FINAL_FLUSH_FAILED
            if change == 'machine': trace.packet[1].machine_id = 1
            with self.subTest(change=change), self.assertRaises(Unqualified): ranges(trace)

    def test_source_and_instruction_bodies_are_forbidden_even_empty(self):
        for change in ['source', 'machine', 'bytecode', 'move', 'wasm']:
            trace = fixture()
            if change == 'source': trace.packet[0].interned_data.v8_js_script[0].source.latin1 = b''
            if change == 'machine': trace.packet[1].v8_js_code.machine_code = b''
            if change == 'bytecode': trace.packet[1].v8_js_code.bytecode = b''
            if change == 'move': move(trace, 200, 1000, 2000).v8_code_move.to_machine_code = b''
            if change == 'wasm': trace.packet[0].interned_data.v8_wasm_script.add(iid=1, wire_bytes=b'')
            with self.subTest(change=change), self.assertRaises(Unqualified): ranges(trace)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(TemporalTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    receipt = {'scope': 'synthetic standard-protobuf temporal-container controls only', 'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors), 'applicationCapture': False, 'runtimeCalibration': False, 'repositoryEdits': 0,
               'inputs': {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in ['temporal_ranges.py', 'test_temporal_ranges.py']}}
    target = sys.argv[1] if len(sys.argv) > 1 else 'temporal-fixtures-revised-first.json'
    (Path(__file__).parent / target).open('x').write(json.dumps(receipt, indent=2) + '\n')
    raise SystemExit(0 if result.wasSuccessful() else 1)
