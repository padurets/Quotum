import {readHistory, ReadError, type HistoryQuery} from './historyRead.js';
import {PeriodReader,periodRoutes} from './periodRead.js';
import {Attention} from './attention.js';
import {STATUS_CODES} from 'node:http';
import type {Socket} from 'node:net';
import {Readable} from 'node:stream';
import Fastify, {type FastifyInstance, type FastifyReply, type FastifyRequest} from 'fastify';
import staticFiles from '@fastify/static';
import {config, serviceName, version} from './config.js';
import type {Ingest} from './ingest.js';
import {HistoryTiles} from './history.js';
import type {Pairing} from './pairing.js';
import type {ResetFeed} from './resets.js';
import type {Store} from './store/store.js';
import type {Board, Directory, User} from './store/directory.js';
import {CSP, currentUser, Limiter, sameSite} from './session.js';
import type {Setup} from './setup.js';
import {Events} from './events.js';
import {Projection} from './projection.js';
import {accountRoutes} from './routes/account.js';
import {eventRoutes} from './routes/events.js';
import {agentRoutes} from './routes/agents.js';
import {localRoutes} from './local.js';
import {credentialRoutes} from './routes/credentials.js';
import {Credentials, startSecrets, type SecretInputs} from './secrets/index.js';
import type {HubSources} from './hubSources.js';
import {currencyRoutes} from './routes/currencies.js';
import {linkRoutes} from './routes/links.js';
import {sourceKeyRoutes} from './routes/sourceKeys.js';
import {dataFilterRoutes} from './routes/dataFilters.js';
import {BoardAdditions} from './additions.js';
import {additionRoutes} from './routes/additions.js';
import {DeviceOnboarding} from './deviceOnboarding.js';
import {responseCompression} from './compression.js';
import {projectColorsOf,type ProjectColors} from './projectColors.js';
import {projectColorRoutes} from './routes/projectColors.js';

/**
 * `local`: the desktop app's hub, with the key its window enters with (see local.ts); null
 * on a server. `events`: what open dashboards hear, made here when not given.
 */
export type Hub = {store: Store; directory: Directory; resets: ResetFeed; ingest: Ingest; pairing: Pairing; setup: Setup; local: {key: string} | null; events?: Events; projectColors?:ProjectColors; credentials?: Credentials; additions?:BoardAdditions; deviceOnboarding?:DeviceOnboarding; hubSources?:HubSources; secretSnapshot?: Pick<SecretInputs, 'storageAtStart' | 'wasFileAtStart'>};

/** Route helpers shared by the route modules. */
export type Guards = {
  user(request: FastifyRequest, reply: FastifyReply): User | null;
  board(request: FastifyRequest, reply: FastifyReply, boardId: string | undefined): {user: User; board: Board} | null;
};

/** Explicit composition for synthetic demo routes; ordinary startup supplies none. */
export type ExtendHub = (app: FastifyInstance, hub: Hub, guards: Guards) => void | Promise<void>;

/** Errors of the framework itself (malformed JSON, a body too large…) in the hub's `{error}` shape. */
function errorCode(status: number, path: string): string {
  if (status === 413) return /\/project-colors(?:\/reset)?(?:\?|$)/.test(path) ? 'project_colors_limit' : /\/filters(?:\?|$)/.test(path) ? 'filters_limit' : /\/period\/sessions(?:\?|$)/.test(path) ? 'history_limit' : 'too_large';
  if (status >= 500) return 'internal_error';
  return path.startsWith('/v1/ingest') ? 'invalid_batch' : path.startsWith('/v1/activity') ? 'invalid_activity' : 'invalid_request';
}

/**
 * A request that never got as far as the hub's handlers (it took too long to arrive, its
 * headers were too large or it was not HTTP), answered in the hub's `{error}` shape
 * rather than the framework's, and its connection closed.
 */
function clientError(error: NodeJS.ErrnoException, socket: Socket & {_httpMessage?: {headersSent: boolean} | null}) {
  // A connection the other side reset has nothing left to answer.
  if (error.code === 'ECONNRESET' || socket.destroyed) return;
  const [status, code] =
    error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
      ? [408, 'request_timeout']
      : error.code === 'HPE_HEADER_OVERFLOW'
        ? [431, 'headers_too_large']
        : [400, 'invalid_request'];
  const body = JSON.stringify({error: code});
  // As Node does: an answer already on its way is cut short rather than spliced with this one.
  if (socket.writable && !socket._httpMessage?.headersSent) {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  }
  socket.destroy(error);
}

/**
 * The HTTP surface. People sign in and read their boards under `/api`; agents talk to
 * `/v1` (device codes, check-ins, ingest). Everything else is the single-page client.
 * The desktop app's hub (`local`) has one person who never signs in: the window enters
 * at `/local`, and what is about accounts, sharing and connecting is not there.
 */
export async function buildApp(hub: Hub, extend?: ExtendHub) {
  hub.projectColors??=hub.events?.projectColors??projectColorsOf(hub);
  hub = {...hub, credentials: hub.credentials ?? new Credentials(hub.store, null, startSecrets(hub.store.db, {current: null, previous: null, reset: null, storageAtStart: null, wasFileAtStart: false}))};
  const {store, directory} = hub;
  const projection = new Projection(hub);
  const additions = new BoardAdditions(store, directory, hub.credentials!);
  hub.additions = additions;
  hub.deviceOnboarding = new DeviceOnboarding(store, directory, additions);
  const {requestTimeoutMs, checkMs} = config.http;
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: config.http.trustProxy,
    requestTimeout: requestTimeoutMs,
    // Once the headers are in, Node holds a request to the longer of its two limits (the headers' is 60 seconds by default).
    http: {headersTimeout: requestTimeoutMs, connectionsCheckingInterval: checkMs},
    clientErrorHandler: clientError,
    // Bad URLs and overlong parameters fail before a route's error boundary.
    frameworkErrors(error, _request, reply) {
      const status = (error as {statusCode?: number}).statusCode ?? 400;
      return (reply as FastifyReply).code(status >= 500 ? 500 : 400).send({error: status >= 500 ? 'internal_error' : 'invalid_request'});
    },
  });
  await responseCompression(app, !!hub.local);
  const hosts = new Set<string>(config.http.hosts);
  const anyHost = hosts.has('*');
  const history = new HistoryTiles(store);
  const events = hub.events ?? new Events(hub);
  const periods = new PeriodReader(hub,history,events);
  events.onHistory = (source, since, scopes, work) => {history.touch(source, since, scopes,work);periods.touch(source,since,scopes,work);};
  events.onClientHistory=(user,since,device)=>{history.touchClient(user,since,device);periods.touchClient(user,since,device);};
  events.attach();
  hub.credentials!.setObserver(events);
  hub.hubSources?.setObserver(events);

  app.addHook('onRequest', async (request, reply) => {
    // The health check answers any host: a container asks it at 127.0.0.1 whatever the hub's own address.
    if (!anyHost && !hosts.has(request.hostname.toLowerCase()) && request.url !== '/health') return reply.code(403).send({error: 'forbidden_host'});
    if (request.method === 'GET' || request.method === 'HEAD') return;
    const path = request.url.split('?')[0];
    const api = path.startsWith('/api/');
    const allowed = (request.method === 'POST' && (api || path.startsWith('/v1/'))) || ((request.method === 'DELETE' || request.method === 'PUT') && api);
    if (!allowed) return reply.code(405).send({error: 'method_not_allowed'});
    // Cookie-authenticated changes are accepted only from pages of this hub.
    const origin = request.headers.origin;
    if (api && origin && !sameSite(origin, request)) return reply.code(403).send({error: 'forbidden_origin'});
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const immutable = request.url.startsWith('/assets/') && reply.statusCode >= 200 && reply.statusCode < 300;
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', immutable ? 'public,max-age=31536000,immutable' : 'no-store')
      .header('Content-Security-Policy', CSP);
    return payload;
  });

  app.setErrorHandler((error: {statusCode?: number}, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) console.error(JSON.stringify({event: 'error', url: request.url.split('?')[0], message: String((error as Error).message)}));
    return reply.code(status).send({error: errorCode(status, request.url)});
  });

  const guards: Guards = {
    user(request, reply) {
      const user = currentUser(request, directory);
      if (!user) void reply.code(401).send({error: 'unauthorized'});
      return user;
    },
    board(request, reply, boardId) {
      const user = guards.user(request, reply);
      if (!user) return null;
      const boards = directory.boards(user.id);
      const board = boardId ? boards.find(b => b.id === boardId) : boards[0];
      if (!board) {
        void reply.code(404).send({error: 'board_not_found'});
        return null;
      }
      return {user, board};
    },
  };

  app.get('/health', () => ({status: 'ok', service: serviceName, version}));
  // With the resets the trackers reported as far back as the chart can be moved: over the history kept.
  app.get('/api/resets', () => projection.hubPart(Date.now()).value);

  // The board as a stream's `snapshot` gives it (spec/dashboard-v1.md), once: for whatever
  // reads a board at a moment rather than following it.
  const pendingOverviews=new WeakMap<FastifyRequest,{user:string;board:string;work:string;revision:number;authority:string}>();
  const readOverview=(user:string,board:string)=>{
    const now=Date.now(),roster=projection.roster(board,now),snapshot=projection.snapshot(user,board,now,roster);
    return snapshot?{...snapshot,projectColors:hub.projectColors!.context(board,roster,now).envelope}:null;
  };
  app.get<{Querystring: {board?: string}}>('/api/overview',{onSend(request,reply,payload,done){
    const captured=pendingOverviews.get(request);if(!captured)return done(null,payload);
    const user=currentUser(request,directory),member=user?.id===captured.user&&directory.membership(captured.board,user.id);
    const current=member?hub.projectColors!.context(captured.board).envelope:null;
    if(member&&current!.revision===captured.revision&&current!.authority===captured.authority&&store.workKey(captured.board)===captured.work)return done(null,payload);
    // Compression may have prepared a stream, but no response bytes have left yet.
    if(payload instanceof Readable)payload.destroy();
    reply.removeHeader('content-encoding').removeHeader('content-length');
    if(!user){reply.code(401);return done(null,JSON.stringify({error:'unauthorized'}));}
    if(!member){reply.code(404);return done(null,JSON.stringify({error:'board_not_found'}));}
    return done(null,JSON.stringify(readOverview(user.id,captured.board)));
  }}, (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    const snapshot = readOverview(access.user.id,access.board.id);
    if(snapshot)pendingOverviews.set(request,{user:access.user.id,board:access.board.id,work:snapshot.workAuthority,revision:snapshot.projectColors.revision,authority:snapshot.projectColors.authority});
    hub.ingest.forecasts.save();
    return snapshot;
  });

  app.get<{Querystring: HistoryQuery & {board?:string}}>('/api/history', (request, reply) => {
    const access = guards.board(request, reply, request.query.board);
    if (!access) return reply;
    try {return reply.type('application/json').send(readHistory(hub, history, events, access.board.id, access.user.id, request.query));}
    catch(error) {if(error instanceof ReadError)return reply.code(error.statusCode).send({error:error.code});throw error;}
  });

  if (hub.local) {
    const attention = new Attention(store, Date.now());
    hub.ingest.attention = attention;
    attention.onEvents = changes => events.attention(changes);
    hub.resets.onAttention = (provider, status, ok, now) => attention.announcement(provider, status, ok, now);
  }
  // Open streams and held polls would keep the server from closing: they end first.
  app.addHook('preClose', async () => events.close());
  eventRoutes(app, directory, events, guards, !!hub.local);
  periodRoutes(app,guards,periods);
  accountRoutes(app, hub, guards);
  dataFilterRoutes(app,hub,guards);
  projectColorRoutes(app,hub,guards);
  sourceKeyRoutes(app,hub,guards);
  currencyRoutes(app,hub,guards);
  linkRoutes(app,hub,guards);
  await extend?.(app, hub, guards);
  const verificationAttempts=new Limiter(10,60_000);
  await app.register(async scope => credentialRoutes(scope, hub.credentials!, guards, verificationAttempts, additions, directory));
  await app.register(async scope => additionRoutes(scope, hub, guards, additions, verificationAttempts));
  agentRoutes(app, hub);
  if (hub.local) localRoutes(app, hub, hub.local.key);

  await app.register(staticFiles, {root: config.clientRoot, index: 'index.html'});
  // Client-side pages (/device, /invite/…) are served by the same single-page client.
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0];
    const page = request.method === 'GET' && !path.startsWith('/api/') && !path.startsWith('/v1/') && !path.includes('.');
    return page ? reply.sendFile('index.html') : reply.code(404).send({error: 'not_found'});
  });
  return app;
}
