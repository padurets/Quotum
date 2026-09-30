import {closeSync, fstatSync, openSync, readSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {SecretError, SecretKey} from './crypto.js';

export type ResetIntent = {from: string | null; to: string};
export type StorageAtStart = 'keystore' | 'file' | 'waiting' | 'missing';
export type SecretInputs = {current: SecretKey | null; previous: SecretKey | null; reset: ResetIntent | null; storageAtStart: StorageAtStart | null; wasFileAtStart: boolean};

const fingerprint = (text: string) => /^[0-9a-f]{16}$/.test(text);
export function resetIntent(from: string, to: string): ResetIntent {
  if (!(from === 'none' || fingerprint(from)) || !fingerprint(to)) throw new SecretError('secret_key_reset_invalid');
  return {from: from === 'none' ? null : from, to};
}

/** Capture once, including presence of empty variables, then remove the whole namespace. */
export function readInputs(env: Record<string, string | undefined>, dataDir: string, local: boolean): SecretInputs {
  try {
    const read = (name: string): SecretKey | null => {
      const value = env[name];
      const file = env[`${name}_FILE`];
      if (value !== undefined && file !== undefined) throw new SecretError('secret_key_configuration_invalid');
      if (file !== undefined) return readKeyFile(file, dataDir);
      if (value === undefined) return null;
      const bytes = Buffer.from(value, 'utf8');
      try { return SecretKey.parse(bytes); } finally { bytes.fill(0); }
    };
    const current = read('QUOTUM_SECRET_KEY');
    const previous = read('QUOTUM_SECRET_KEY_PREVIOUS');
    if (previous && !current) throw new SecretError('secret_key_configuration_invalid');
    const resetValue = env.QUOTUM_SECRET_KEY_RESET;
    if (resetValue !== undefined && !local) throw new SecretError('secret_key_configuration_invalid');
    let reset: ResetIntent | null = null;
    if (resetValue !== undefined) {
      const parts = resetValue.split(':');
      if (parts.length !== 2) throw new SecretError('secret_key_reset_invalid');
      reset = resetIntent(parts[0], parts[1]);
      if (!current || reset.to !== current.fingerprint) throw new SecretError('secret_key_reset_conflict');
    }
    const state = local ? env.QUOTUM_SECRET_KEY_STATE : undefined;
    if (state !== undefined && !['keystore', 'keystore_was_file', 'file', 'waiting', 'missing'].includes(state)) throw new SecretError('secret_key_configuration_invalid');
    return {current, previous, reset, storageAtStart: state === 'keystore_was_file' ? 'keystore' : (state as StorageAtStart | undefined) ?? null, wasFileAtStart: state === 'keystore_was_file' || state === 'file'};
  } finally {
    for (const name of Object.keys(env)) if ((process.platform === 'win32' ? name.toUpperCase() : name).startsWith('QUOTUM_SECRET_KEY')) delete env[name];
    // Node 24 supports this; the pinned Node type declarations predate it.
    (process.report as typeof process.report & {excludeEnv: boolean}).excludeEnv = true;
  }
}

function readKeyFile(file: string, dataDir: string): SecretKey {
  let fd: number | undefined;
  const bytes = Buffer.alloc(46);
  try {
    const resolved = realpathSync(file);
    const relative = path.relative(realpathSync(dataDir), resolved);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new SecretError('secret_key_file_in_data');
    fd = openSync(resolved, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 43 || stat.size > 45) throw new SecretError('secret_key_invalid');
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    const ending = bytes.subarray(43, count);
    if (!(count === 43 || count === 44 && ending[0] === 10 || count === 45 && ending[0] === 13 && ending[1] === 10)) throw new SecretError('secret_key_invalid');
    return SecretKey.parse(bytes.subarray(0, 43));
  } catch (error) {
    throw error instanceof SecretError ? error : new SecretError('secret_key_file_unavailable');
  } finally {
    bytes.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}
