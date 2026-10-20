"""Private calibration adapter: standard protobuf, explicit monotonic time only.

This names code containers, never inlined leaves or exclusive CPU. It is not
admitted for application traces: deletion has no independent complete ledger.
"""
import os
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path[:0] = [str(ROOT / 'bindings'), str(ROOT / 'runtime')]
os.environ['PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION'] = 'python'
from perfetto.protos.perfetto.trace import perfetto_trace_pb2 as pb


class Unqualified(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Unqualified(reason)


def string(value):
    encoding = value.WhichOneof('encoded_string')
    require(encoding is not None, 'missing string encoding')
    return getattr(value, encoding).decode({'latin1': 'latin1', 'utf16_le': 'utf-16-le', 'utf16_be': 'utf-16-be'}[encoding], errors='strict')


@dataclass
class Range:
    pid: int
    isolate: int
    start: int
    size: int
    since: int
    until: int | None
    function: tuple | None


def decode(data, expected_pid):
    require(len(data) <= 32 * 1024 * 1024, 'trace byte cap')
    trace = pb.Trace.FromString(data)
    require(len(trace.packet) <= 100_000, 'packet cap')
    states, events = {}, []
    for packet in trace.packet:
        require(packet.machine_id == 0, 'foreign machine clock')
        require(not packet.previous_packet_dropped, 'packet loss')
        require(not packet.HasField('compressed_packets') and not packet.HasField('zstd_compressed_packets'), 'compressed packets unsupported')
        if packet.HasField('trace_stats'):
            stats = packet.trace_stats
            require(not any(getattr(stats, key) for key in ('chunks_discarded', 'patches_discarded', 'invalid_packets', 'flushes_failed')), 'trace loss')
            require(stats.final_flush_outcome != pb.TraceStats.FINAL_FLUSH_FAILED, 'failed final flush')
            for buffer in stats.buffer_stats:
                require(not any(getattr(buffer, key) for key in ('bytes_overwritten', 'chunks_overwritten', 'chunks_discarded', 'patches_failed', 'abi_violations', 'trace_writer_packet_loss')), 'buffer loss')
        kind = packet.WhichOneof('data')
        code = kind in ('v8_js_code', 'v8_internal_code', 'v8_wasm_code', 'v8_reg_exp_code', 'v8_code_move')
        reset = packet.sequence_flags & 1 or packet.incremental_state_cleared
        if not code and not reset and not packet.HasField('interned_data') and not packet.HasField('trace_packet_defaults'):
            continue
        require(packet.HasField('trusted_packet_sequence_id') and packet.trusted_packet_sequence_id > 0, 'missing sequence')
        seq = packet.trusted_packet_sequence_id
        if reset:
            states[seq] = {'maps': {}, 'clock': None, 'tid': None}
        require(seq in states, 'missing incremental reset')
        state = states[seq]
        if packet.HasField('trace_packet_defaults'):
            defaults = packet.trace_packet_defaults
            state['clock'] = defaults.timestamp_clock_id if defaults.HasField('timestamp_clock_id') else None
            state['tid'] = defaults.v8_code_defaults.tid if defaults.HasField('v8_code_defaults') else None
        for field, values in packet.interned_data.ListFields():
            if not field.name.startswith('v8_'):
                continue
            entries = state['maps'].setdefault(field.name, {})
            for entry in values:
                require(entry.iid > 0, 'zero interned id')
                if field.name == 'v8_js_script':
                    require(not entry.HasField('source'), 'script body forbidden')
                if field.name == 'v8_wasm_script':
                    require(not entry.HasField('wire_bytes'), 'wasm body forbidden')
                old = entries.get(entry.iid)
                require(old is None or old == entry, 'conflicting interned id')
                entries[entry.iid] = entry
        if not code:
            continue
        clock = packet.timestamp_clock_id if packet.HasField('timestamp_clock_id') else state['clock']
        require(clock == 3 and packet.HasField('timestamp'), 'explicit monotonic clock required')
        value = getattr(packet, kind)
        for field, _ in value.ListFields():
            require(field.name not in ('machine_code', 'bytecode', 'to_machine_code', 'to_bytecode'), 'instructions forbidden')
        maps = state['maps']
        isolate_iid = value.isolate_iid if kind == 'v8_code_move' else value.v8_isolate_iid
        isolate = maps.get('v8_isolate', {}).get(isolate_iid)
        require(isolate is not None and isolate.HasField('pid') and isolate.HasField('isolate_id'), 'missing isolate')
        if isolate.pid != expected_pid:
            continue
        if packet.HasField('trusted_pid'):
            require(packet.trusted_pid == isolate.pid, 'producer pid mismatch')
        tid = value.tid if value.HasField('tid') else state['tid']
        require(tid is not None and tid > 0, 'missing code tid')
        function = None
        if kind == 'v8_js_code':
            fn = maps.get('v8_js_function', {}).get(value.v8_js_function_iid)
            require(fn is not None, 'missing function')
            script = maps.get('v8_js_script', {}).get(fn.v8_js_script_iid)
            name = maps.get('v8_js_function_name', {}).get(fn.v8_js_function_name_iid)
            require(script is not None and name is not None, 'missing script/name')
            native = value.HasField('tier') and value.tier in (pb.V8JsCode.TIER_SPARKPLUG, pb.V8JsCode.TIER_MAGLEV, pb.V8JsCode.TIER_TURBOSHAFT, pb.V8JsCode.TIER_TURBOFAN)
            if native and fn.HasField('line') and fn.HasField('column') and script.HasField('name'):
                function = (script.script_id, string(script.name), string(name), fn.line, fn.column)
        size = value.instruction_size_bytes
        start = value.to_instruction_start_address if kind == 'v8_code_move' else value.instruction_start
        require(size > 0 and start > 0 and start + size <= 2**64, 'invalid code extent')
        origin = value.from_instruction_start_address if kind == 'v8_code_move' else None
        events.append((packet.timestamp, kind, isolate.isolate_id, start, size, origin, function))
    require(events, 'no owned code events')
    events.sort(key=lambda event: event[0])
    timestamp_counts = Counter(event[0] for event in events)
    ranges = []
    for timestamp, kind, isolate, start, size, origin, function in events:
        # Equal timestamps cannot establish create/move order, even across sequences.
        require(timestamp_counts[timestamp] == 1, 'ambiguous event timestamp')
        live = [r for r in ranges if r.until is None]
        if kind == 'v8_code_move':
            old = [r for r in live if r.isolate == isolate and r.start == origin and r.size == size]
            require(len(old) == 1, 'missing or mismatched move origin')
            function = old[0].function
            for r in old:
                r.until = timestamp
        for r in live:
            if r.until is None and start < r.start + r.size and r.start < start + size:
                r.until = timestamp
        ranges.append(Range(expected_pid, isolate, start, size, timestamp, None, function))
        require(len(ranges) <= 65_536, 'range cap')
    return ranges


def classify(ranges, pid, time_ns, ip, *, expected_isolate=None, collection=None):
    # Timestamp ties and missing, deleted or conflicting extents stay UNKNOWN.
    if expected_isolate is None or collection is None or not collection[0] < time_ns < collection[1]:
        return None
    owners = [r for r in ranges if r.pid == pid and r.isolate == expected_isolate and r.since < time_ns and (r.until is None or time_ns < r.until) and r.start <= ip < r.start + r.size]
    return owners[0].function if len(owners) == 1 else None
