import {createHash, timingSafeEqual} from 'node:crypto';
import {userInfo} from 'node:os';
import type {FastifyInstance} from 'fastify';
import {newSecret, secretHint, validName} from './domain/auth.js';
import type {Hub} from './api.js';
import {setSession} from './session.js';
import type {Directory, User} from './store/directory.js';

/**
 * The hub the desktop app carries (docs/architecture.md, "Desktop app"): one person, who
 * never signs in. The app's window enters with the key of this start of the hub; the
 * app's agent delivers with the token of this start. Both are new on every start, so
 * whatever an earlier start handed out opens nothing any more.
 */

const EMAIL = 'local@quotum.invalid';
/** The machine token the app's agent uses, one row that gets a new secret on every start. */
export const APP_TOKEN = 'Quotum app';
/** As long as the database lives, in effect: the window may stay open for weeks. The next start ends it anyway. */
const SESSION_TTL_MS = 10 * 365 * 86_400_000;

/** The person of this machine, by the name the system knows them by. */
function systemName(): string {
  try {
    const name = userInfo().username.trim().slice(0, 80);
    return validName(name) ? name : 'me';
  } catch {
    return 'me';
  }
}

/**
 * Makes the database ready for this start: its one person (created on the first start, the
 * same ever after, so the history and the keys of their subscriptions stay theirs), the
 * app's token with this start's secret, and no session left from an earlier start.
 */
export function bootstrapLocal(directory: Directory, token: string, now: number, name = systemName()): User {
  return directory.transaction(() => {
    const count = directory.userCount();
    if (count > 1) throw new Error('the local mode needs a database of one person');
    // '!' is no password hash: nobody can sign in as this person.
    const user = count === 0 ? directory.createUser(EMAIL, name, '!', now) : directory.soleUser()!;
    const existing = directory.tokens(user.id).find(t => t.name === APP_TOKEN);
    if (existing) directory.setToken(existing.id, token, secretHint(token));
    else directory.createToken(token, secretHint(token), user.id, APP_TOKEN, now);
    directory.deleteSessions(user.id);
    return user;
  });
}

const digest = (value: string) => createHash('sha256').update(value).digest();
/** Compared in constant time, whatever the lengths. */
const sameSecret = (given: string, expected: string) => timingSafeEqual(digest(given), digest(expected));

/**
 * `GET /local?key=…`: the app's window enters. The right key gets a session that lasts
 * while the window does (the cookie is not kept on disk); any other request only goes to
 * the board, which then asks to open it from the app.
 */
export function localRoutes(app: FastifyInstance, hub: Hub, key: string) {
  app.get<{Querystring: {key?: unknown}}>('/local', (request, reply) => {
    const given = request.query.key;
    const user = hub.directory.soleUser();
    if (user && typeof given === 'string' && sameSecret(given, key)) {
      const secret = newSecret('qt_s');
      hub.directory.createSession(secret, user.id, Date.now(), SESSION_TTL_MS);
      setSession(request, reply, secret, {persistent: false});
    }
    return reply.redirect('/', 303);
  });
}
