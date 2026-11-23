import assert from 'node:assert/strict';

export function requiredRow<T>(row: T | undefined): T {
  assert.ok(row !== undefined, 'the benchmark evidence must contain the expected row');
  return row;
}
