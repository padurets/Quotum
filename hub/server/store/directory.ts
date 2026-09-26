import type {DatabaseSync} from 'node:sqlite';
import {newId, secretHash} from '../domain/auth.js';
import {EMPTY_VIEW, type View} from '../domain/view.js';

export type User = {id: string; email: string; name: string; createdAt: number};
export type Board = {id: string; name: string; personal: boolean; role: 'owner' | 'member'};
/** A machine token: machines started with it join as its person. */
export type Token = {id: string; userId: string; name: string; hint: string; createdAt: number; lastUsedAt: number | null};
export type Machine = {id: string; name: string; os: string; arch: string};

export type Device = {
  id: string;
  /** Whose machine it is: the person who confirmed its code, or the owner of its token. */
  userId: string;
  machineId: string;
  /** What the machine calls itself (its host name, unless its agent is told otherwise). */
  name: string;
  /** What people named it on the hub; shown instead of the name when set. */
  label: string | null;
  os: string;
  arch: string;
  agent: string;
  /** The machine token it joined with; null for devices connected with a code. */
  tokenId: string | null;
  /** Connected with a one-time code: it has a token of its own. */
  byCode: boolean;
  createdAt: number;
  lastSeenAt: number | null;
};

export type DeviceCode = {
  id: string;
  userCode: string;
  machine: Machine & {agent: string};
  createdAt: number;
  expiresAt: number;
  polledAt: number | null;
  status: 'pending' | 'approved' | 'denied' | 'used';
  userId: string | null;
};

const user = (row: any): User => ({id: row.id, email: row.email, name: row.name, createdAt: row.created_at});

const device = (row: any): Device => ({
  id: row.id,
  userId: row.user_id,
  machineId: row.machine_id,
  name: row.name,
  label: row.label,
  os: row.os,
  arch: row.arch,
  agent: row.agent,
  tokenId: row.token_id,
  byCode: row.token_hash !== null && row.token_id === null,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

const code = (row: any): DeviceCode => ({
  id: row.id,
  userCode: row.user_code,
  machine: JSON.parse(row.machine),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  polledAt: row.polled_at,
  status: row.status,
  userId: row.user_id,
});

const token = (r: any): Token => ({id: r.id, userId: r.user_id, name: r.name, hint: r.hint, createdAt: r.created_at, lastUsedAt: r.last_used_at});

/**
 * People and what is theirs: users and sessions, boards with members and invites, the
 * machines of each person (devices, machine tokens, pending device codes). Secrets are
 * stored as hashes only.
 */
export class Directory {
  constructor(private readonly db: DatabaseSync) {}

  /** Runs `work` as one write transaction of the hub's database, which the store shares; inside one already, as part of it. */
  transaction<T>(work: () => T): T {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // ---------- users and sessions ----------

  userCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM users').get() as {n: number}).n;
  }

  /** Creates a user with their personal board. */
  createUser(email: string, name: string, passwordHash: string, now: number): User {
    return this.transaction(() => {
      const id = newId();
      const board = newId();
      this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(id, email, name, passwordHash, now);
      this.db.prepare('INSERT INTO boards VALUES (?, ?, 1, ?, ?)').run(board, '', id, now);
      this.db.prepare('INSERT INTO members VALUES (?, ?, ?, ?)').run(board, id, 'owner', now);
      return this.user(id)!;
    });
  }

  user(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? user(row) : null;
  }

  /** The user and their password hash, for signing in. */
  credentials(email: string): {user: User; password: string} | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
    return row ? {user: user(row), password: row.password} : null;
  }

  createSession(secret: string, userId: string, now: number, ttlMs: number) {
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(secretHash(secret), userId, now, now + ttlMs);
  }

  sessionUser(secret: string, now: number): User | null {
    const row = this.db
      .prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND sessions.expires_at > ?')
      .get(secretHash(secret), now);
    return row ? user(row) : null;
  }

  deleteSession(secret: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(secretHash(secret));
  }

  /** Every session of a person ends. */
  deleteSessions(userId: string) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  /** The one person of a hub that has only one (the desktop app's). */
  soleUser(): User | null {
    const rows = this.db.prepare('SELECT * FROM users LIMIT 2').all();
    return rows.length === 1 ? user(rows[0]) : null;
  }

  /** Changes a person's name, email or password; with a new password their other sessions end. */
  updateUser(id: string, change: {name?: string; email?: string; passwordHash?: string}, keepSession: string | null) {
    this.transaction(() => {
      if (change.name !== undefined) this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(change.name, id);
      if (change.email !== undefined) this.db.prepare('UPDATE users SET email = ? WHERE id = ?').run(change.email, id);
      if (change.passwordHash !== undefined) {
        this.db.prepare('UPDATE users SET password = ? WHERE id = ?').run(change.passwordHash, id);
        this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(id, keepSession ? secretHash(keepSession) : null);
      }
    });
  }

  // ---------- views ----------

  /** How a board is arranged; the default until its owner changes anything. */
  view(boardId: string): View {
    const row = this.db.prepare('SELECT payload FROM views WHERE board_id = ?').get(boardId) as {payload: string} | undefined;
    // A view saved before a field existed gets that field's default.
    return row ? {...EMPTY_VIEW, ...(JSON.parse(row.payload) as Partial<View>)} : EMPTY_VIEW;
  }

  saveView(boardId: string, view: View, by: string, now: number) {
    this.db.prepare('INSERT OR REPLACE INTO views VALUES (?, ?, ?, ?)').run(boardId, JSON.stringify(view), by, now);
  }

  // ---------- boards, members, invites ----------

  boards(userId: string): Board[] {
    return (
      this.db
        .prepare(
          'SELECT boards.id, boards.name, boards.personal, members.role FROM members JOIN boards ON boards.id = members.board_id' +
            ' WHERE members.user_id = ? ORDER BY boards.personal DESC, boards.created_at',
        )
        .all(userId) as any[]
    ).map(r => ({id: r.id, name: r.name, personal: !!r.personal, role: r.role}));
  }

  board(id: string): {id: string; name: string; personal: boolean} | null {
    const row = this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as any;
    return row ? {id: row.id, name: row.name, personal: !!row.personal} : null;
  }

  membership(boardId: string, userId: string): 'owner' | 'member' | null {
    const row = this.db.prepare('SELECT role FROM members WHERE board_id = ? AND user_id = ?').get(boardId, userId) as {role: 'owner' | 'member'} | undefined;
    return row?.role ?? null;
  }

  /**
   * Deletes a shared board with its members, invites and view (the store forgets what
   * was shared with it: call both in one transaction). The sources on it stay with the
   * people who measure them.
   */
  deleteBoard(id: string) {
    for (const table of ['members', 'invites', 'views', 'boards']) {
      this.db.prepare(`DELETE FROM ${table} WHERE ${table === 'boards' ? 'id' : 'board_id'} = ?`).run(id);
    }
  }

  /** Someone leaves a board, or its owner removes them. What they shared goes with them (Store.unshareOrphans). */
  removeMember(boardId: string, userId: string) {
    this.db.prepare("DELETE FROM members WHERE board_id = ? AND user_id = ? AND role <> 'owner'").run(boardId, userId);
  }

  renameBoard(id: string, name: string) {
    this.db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name, id);
  }

  createBoard(name: string, userId: string, now: number): Board {
    const id = newId();
    this.transaction(() => {
      this.db.prepare('INSERT INTO boards VALUES (?, ?, 0, ?, ?)').run(id, name, userId, now);
      this.db.prepare('INSERT INTO members VALUES (?, ?, ?, ?)').run(id, userId, 'owner', now);
    });
    return {id, name, personal: false, role: 'owner'};
  }

  members(boardId: string): (User & {boardRole: 'owner' | 'member'})[] {
    return (
      this.db
        .prepare('SELECT users.*, members.role AS board_role FROM members JOIN users ON users.id = members.user_id WHERE members.board_id = ? ORDER BY members.joined_at')
        .all(boardId) as any[]
    ).map(r => ({...user(r), boardRole: r.board_role}));
  }

  addMember(boardId: string, userId: string, now: number) {
    this.db.prepare('INSERT OR IGNORE INTO members VALUES (?, ?, ?, ?)').run(boardId, userId, 'member', now);
  }

  createInvite(secret: string, boardId: string, userId: string, now: number, ttlMs: number) {
    this.db.prepare('INSERT INTO invites VALUES (?, ?, ?, ?, ?)').run(secretHash(secret), boardId, userId, now, now + ttlMs);
  }

  /** The board an invite leads to, while it is valid. Invites can be used by several people. */
  inviteBoard(secret: string, now: number): {id: string; name: string} | null {
    const row = this.db
      .prepare('SELECT boards.id, boards.name FROM invites JOIN boards ON boards.id = invites.board_id WHERE invites.id = ? AND invites.expires_at > ?')
      .get(secretHash(secret), now) as {id: string; name: string} | undefined;
    return row ?? null;
  }

  /** Every invite link of a board stops working. */
  revokeInvites(boardId: string): number {
    return Number(this.db.prepare('DELETE FROM invites WHERE board_id = ?').run(boardId).changes);
  }

  // ---------- machine tokens ----------

  createToken(secret: string, hint: string, userId: string, name: string, now: number): Token {
    const id = newId();
    this.db.prepare('INSERT INTO tokens VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)').run(id, userId, name, secretHash(secret), hint, now);
    return {id, userId, name, hint, createdAt: now, lastUsedAt: null};
  }

  /**
   * Gives a token a new secret in place: its machines stay connected under the same id,
   * which revoking and creating another would not do.
   */
  setToken(id: string, secret: string, hint: string) {
    this.db.prepare('UPDATE tokens SET hash = ?, hint = ? WHERE id = ?').run(secretHash(secret), hint, id);
  }

  tokens(userId: string): Token[] {
    return (this.db.prepare('SELECT * FROM tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at').all(userId) as any[]).map(token);
  }

  /** The token a secret belongs to, with whether it was revoked: machines still using it are told so. */
  tokenBySecret(secret: string): (Token & {revoked: boolean}) | null {
    const r = this.db.prepare('SELECT * FROM tokens WHERE hash = ?').get(secretHash(secret)) as any;
    return r ? {...token(r), revoked: r.revoked_at !== null} : null;
  }

  touchToken(id: string, now: number) {
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now, id);
  }

  /** Revoking a machine token also disconnects every device that joined with it. */
  revokeToken(userId: string, id: string, now: number): boolean {
    return this.transaction(() => {
      const changed = this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now, id, userId).changes;
      if (changed) this.db.prepare('UPDATE devices SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL').run(now, id);
      return changed > 0;
    });
  }

  // ---------- devices ----------

  /** The devices that joined with a machine token. */
  devicesOfToken(tokenId: string): string[] {
    return (this.db.prepare('SELECT id FROM devices WHERE token_id = ?').all(tokenId) as {id: string}[]).map(row => row.id);
  }

  /** The device a device token belongs to, with whether it was disconnected. */
  deviceBySecret(secret: string): (Device & {revoked: boolean}) | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(secretHash(secret)) as any;
    return row ? {...device(row), revoked: row.revoked_at !== null} : null;
  }

  /** A person's device by the agent's machine id, with whether it was disconnected. */
  deviceByMachine(userId: string, machineId: string): (Device & {revoked: boolean}) | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE user_id = ? AND machine_id = ?').get(userId, machineId) as any;
    return row ? {...device(row), revoked: row.revoked_at !== null} : null;
  }

  /**
   * Registers a person's machine, or updates it. Registering connects it again: an
   * approved code gives it a new secret of its own; joining with a machine token drops
   * any secret it had, so a secret it was disconnected for never works again (the
   * ingest decides when a token may take a machine back).
   */
  saveDevice(input: {userId: string; machine: Machine; agent: string; tokenId: string | null; secret?: string}, now: number): Device {
    const existing = this.deviceByMachine(input.userId, input.machine.id);
    const hashed = input.secret ? secretHash(input.secret) : null;
    if (existing) {
      this.db
        .prepare(
          'UPDATE devices SET name = ?, os = ?, arch = ?, agent = ?, token_id = ?, token_hash = ?,' +
            ' revoked_at = NULL, last_seen_at = ? WHERE id = ?',
        )
        .run(input.machine.name, input.machine.os, input.machine.arch, input.agent, input.tokenId, hashed, now, existing.id);
      return this.deviceById(existing.id)!;
    }
    const id = newId();
    this.db
      .prepare('INSERT INTO devices VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL)')
      .run(id, input.userId, input.machine.id, input.machine.name, input.machine.os, input.machine.arch, input.agent, input.tokenId, hashed, now, now);
    return this.deviceById(id)!;
  }

  deviceById(id: string): Device | null {
    const row = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    return row ? device(row) : null;
  }

  touchDevice(id: string, machine: Machine, agent: string, now: number) {
    this.db.prepare('UPDATE devices SET name = ?, os = ?, arch = ?, agent = ?, last_seen_at = ? WHERE id = ?').run(machine.name, machine.os, machine.arch, agent, now, id);
  }

  devices(userId: string): Device[] {
    return (this.db.prepare('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC').all(userId) as any[]).map(device);
  }

  /** Names a device on the hub; an empty name gives it back the name the machine reports. */
  renameDevice(userId: string, id: string, label: string): boolean {
    return this.db.prepare('UPDATE devices SET label = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(label || null, id, userId).changes > 0;
  }

  revokeDevice(userId: string, id: string, now: number): boolean {
    return this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now, id, userId).changes > 0;
  }

  /** Forgets sessions, invites and device codes that expired a day ago or earlier. */
  prune(now: number) {
    const cutoff = now - 86_400_000;
    for (const table of ['sessions', 'invites', 'device_codes']) this.db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(cutoff);
  }

  // ---------- device codes ----------

  createCode(secret: string, userCode: string, machine: Machine & {agent: string}, now: number, ttlMs: number) {
    this.db
      .prepare('INSERT INTO device_codes VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)')
      .run(secretHash(secret), userCode, JSON.stringify(machine), now, now + ttlMs, 'pending');
  }

  codeBySecret(secret: string): DeviceCode | null {
    const row = this.db.prepare('SELECT * FROM device_codes WHERE id = ?').get(secretHash(secret));
    return row ? code(row) : null;
  }

  codeByUserCode(userCode: string): DeviceCode | null {
    const row = this.db.prepare('SELECT * FROM device_codes WHERE user_code = ?').get(userCode);
    return row ? code(row) : null;
  }

  polled(id: string, now: number) {
    this.db.prepare('UPDATE device_codes SET polled_at = ? WHERE id = ?').run(now, id);
  }

  /** Approves (for the approving person) or denies a pending code; false if it is no longer pending. */
  decide(userCode: string, approve: boolean, userId: string, now: number): boolean {
    return (
      this.db
        .prepare("UPDATE device_codes SET status = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
        .run(approve ? 'approved' : 'denied', userId, userCode, now).changes > 0
    );
  }

  /** Marks an approved code as used; false if it already was (one device per code). */
  useCode(id: string): boolean {
    return this.db.prepare("UPDATE device_codes SET status = 'used' WHERE id = ? AND status = 'approved'").run(id).changes > 0;
  }
}
