import fs from 'node:fs';
import 'node:child_process';
import path from 'node:path';
import 'node:os';
import { setTimeout } from 'node:timers/promises';

/**
 * Client constants. The first group mirrors the Jenkins client's
 * RemoteClientDefaults and RemoteLockSession (lockable-resources-plugin
 * 82532cd) so that this action behaves like a remote lock() in Jenkins.
 */
const API_BASE_PATH = '/lockable-resources/remote/v1';
const POLL_INTERVAL_MS = 3_000;
/** Sent as heartbeatIntervalSeconds; the server validates it but uses its own constant. */
const HEARTBEAT_INTERVAL_SECONDS = 10;
const REQUEST_TIMEOUT_MS = 5_000;
/** Release retries: 3 s apart, 20 attempts (about 60 s), the same budget as polling. */
const RELEASE_RETRY_INTERVAL_MS = 3_000;
/** How often the main step prints that it is still waiting. */
const WAIT_LOG_INTERVAL_MS = 60_000;
/** How often the daemon checks for a stop request and that its job is still running. */
const DAEMON_TICK_MS = 250;
/**
 * Test hook: scales the client's own intervals (poll, heartbeat, release retry,
 * wait log) down so the integration tests run in seconds. Values outside
 * (0, 1] are ignored, so it can only make the client faster, never slower than
 * the server's STALE threshold allows.
 */
const TIME_SCALE_ENV = 'LOCKABLE_RESOURCES_TEST_TIME_SCALE';
function timingFromEnv(env) {
    const raw = Number(env[TIME_SCALE_ENV]);
    const scale = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 1;
    return {
        pollIntervalMs: Math.round(POLL_INTERVAL_MS * scale),
        heartbeatIntervalMs: Math.round(HEARTBEAT_INTERVAL_SECONDS * 1000 * scale),
        releaseRetryIntervalMs: Math.round(RELEASE_RETRY_INTERVAL_MS * scale),
        waitLogIntervalMs: Math.round(WAIT_LOG_INTERVAL_MS * scale)
    };
}
timingFromEnv({});

function errorMessage(e) {
    return e instanceof Error ? e.message : String(e);
}
function isoTime(ms) {
    return new Date(ms).toISOString();
}

/**
 * Thin HTTP client for the remote lock API (the Jenkins client's
 * RemoteApiClient). Node's fetch, Basic authentication with an API token
 * (no CSRF crumb needed), a 5 s timeout per request.
 */
const KNOWN_STATES = new Set([
    'QUEUED',
    'ACQUIRED',
    'SKIPPED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'STALE'
]);
class RemoteApiError extends Error {
    status;
    errorCode;
    constructor(message, 
    /** HTTP status, or -1 when no response arrived (network failure, timeout). */
    status, errorCode, options) {
        super(message, options);
        this.status = status;
        this.errorCode = errorCode;
        this.name = 'RemoteApiError';
    }
    /** Worth retrying: no response, a server error, or rate limiting. */
    get transient() {
        return (this.status < 0 ||
            this.status >= 500 ||
            this.status === 429 ||
            this.status === 408);
    }
}
const MAX_LOGGED_BODY_CHARS = 512;
class RemoteApiClient {
    connection;
    fetchImpl;
    timeoutMs;
    authorization;
    constructor(connection, options = {}) {
        this.connection = connection;
        this.fetchImpl = options.fetch ?? fetch;
        this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
        this.authorization =
            'Basic ' +
                Buffer.from(`${connection.username}:${connection.token}`).toString('base64');
    }
    /** POST /acquire/ and return the accepted lockId. */
    async acquire(body, signal) {
        const path = '/acquire/';
        const { status, json } = await this.send('POST', path, body, signal);
        const lockId = extractLockId(json);
        if (!lockId) {
            throw new RemoteApiError(`Remote acquire response did not contain lockId (HTTP ${status})`, status, 'INVALID_RESPONSE');
        }
        return lockId;
    }
    /** GET /acquire/{lockId}/ */
    async status(lockId, signal) {
        const path = `/acquire/${encodeURIComponent(lockId)}/`;
        const { json } = await this.send('GET', path, undefined, signal);
        const result = {
            lockId: extractLockId(json) ?? lockId,
            state: toState(json.state)
        };
        if (typeof json.errorCode === 'string' && json.errorCode) {
            result.errorCode = json.errorCode;
        }
        if (typeof json.message === 'string' && json.message) {
            result.message = json.message;
        }
        if (Array.isArray(json.resources)) {
            result.resources = json.resources.map((r) => String(r));
        }
        if (isPlainObject(json.lockEnvVars)) {
            const vars = {};
            for (const [k, v] of Object.entries(json.lockEnvVars)) {
                vars[k] = v === null || v === undefined ? '' : String(v);
            }
            result.lockEnvVars = vars;
        }
        return result;
    }
    /** POST /lease/{lockId}/heartbeat */
    async heartbeat(lockId, signal) {
        await this.send('POST', `/lease/${encodeURIComponent(lockId)}/heartbeat`, undefined, signal);
    }
    /** POST /lease/{lockId}/release (idempotent; also withdraws a QUEUED request). */
    async release(lockId, signal) {
        await this.send('POST', `/lease/${encodeURIComponent(lockId)}/release`, undefined, signal);
    }
    async send(method, path, body, signal) {
        const url = this.connection.serverUrl + API_BASE_PATH + path;
        const headers = {
            Accept: 'application/json',
            Authorization: this.authorization
        };
        let payload;
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const timeout = AbortSignal.timeout(this.timeoutMs);
        let response;
        let text;
        try {
            response = await this.fetchImpl(url, {
                method,
                headers,
                body: payload ?? (method === 'POST' ? '' : undefined),
                // Never follow a redirect with the credentials (and fetch would turn
                // a redirected POST into a GET); report it instead.
                redirect: 'manual',
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout
            });
            text = await response.text();
        }
        catch (e) {
            const reason = timeout.aborted
                ? `timed out after ${this.timeoutMs} ms`
                : describeFetchError(e);
            throw new RemoteApiError(`Remote API communication failure: ${method} ${path} (${reason})`, -1, undefined, { cause: e });
        }
        const status = response.status;
        if (status >= 300) {
            throw httpError(method, path, status, text, response.headers);
        }
        if (!text) {
            return { status, json: {} };
        }
        try {
            const parsed = JSON.parse(text);
            return { status, json: isPlainObject(parsed) ? parsed : {} };
        }
        catch {
            throw new RemoteApiError(`Remote response is not valid JSON for ${method} ${path} (HTTP ${status}): ${abbreviate(text)}`, status, 'INVALID_JSON');
        }
    }
}
function httpError(method, path, status, text, headers) {
    let errorCode;
    let remoteMessage;
    try {
        const parsed = JSON.parse(text);
        if (isPlainObject(parsed)) {
            const code = parsed.errorCode ?? parsed.code;
            if (typeof code === 'string' && code)
                errorCode = code;
            if (typeof parsed.message === 'string' && parsed.message) {
                remoteMessage = abbreviate(parsed.message);
            }
        }
    }
    catch {
        // Not JSON (an HTML error page from Jenkins or a proxy).
    }
    let message = `Remote API request failed: ${method} ${path} returned HTTP ${status}`;
    const details = [];
    if (errorCode)
        details.push(`errorCode=${errorCode}`);
    if (remoteMessage)
        details.push(`message=${remoteMessage}`);
    if (details.length > 0)
        message += ` (${details.join(', ')})`;
    message += hint(status, errorCode, headers);
    return new RemoteApiError(message, status, errorCode);
}
function hint(status, errorCode, headers) {
    if (status >= 300 && status < 400) {
        const location = headers.get('location');
        return `. The server redirected${location ? ` to ${location}` : ''}; set server-url to the final URL (scheme, host and context path).`;
    }
    if (status === 401) {
        return '. Check username and token (use a Jenkins API token, not a password).';
    }
    if (status === 403 && errorCode === undefined) {
        return '. The user needs the Lockable Resources/RemoteUse permission, and the token must be an API token (a password is rejected by the CSRF crumb check).';
    }
    if (status === 404 && errorCode === undefined) {
        return '. Verify server-url (including the context path) and that the remote API is enabled.';
    }
    if (errorCode === 'UNKNOWN_RESOURCE' ||
        errorCode === 'UNKNOWN_LABEL' ||
        errorCode === 'UNKNOWN_GROUP') {
        return '. Verify that the resource or label exists and is exposed by exposeLabel.';
    }
    return '';
}
function describeFetchError(e) {
    if (e instanceof Error && e.cause instanceof Error) {
        return `${e.message}: ${e.cause.message}`;
    }
    return errorMessage(e);
}
function extractLockId(json) {
    for (const key of ['lockId', 'requestId', 'leaseId']) {
        const value = json[key];
        if (typeof value === 'string' && value)
            return value;
    }
    return undefined;
}
function toState(value) {
    if (typeof value !== 'string')
        return 'UNKNOWN';
    const upper = value.trim().toUpperCase();
    return KNOWN_STATES.has(upper) ? upper : 'UNKNOWN';
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function abbreviate(text) {
    const oneLine = text.replace(/[\r\n]+/g, ' ');
    return oneLine.length <= MAX_LOGGED_BODY_CHARS
        ? oneLine
        : `${oneLine.slice(0, MAX_LOGGED_BODY_CHARS)}...(truncated, total=${oneLine.length} chars)`;
}

/**
 * State shared between main, the heartbeat daemon, the release sub-action and
 * post (PLAN §4.5). core.saveState only reaches the same action's post, and the
 * release sub-action is a different action, so main writes one file per lock
 * under $RUNNER_TEMP/lockable-resources/. The token is never written anywhere.
 */
/** Stages in which the daemon should keep sending heartbeats. */
const ACTIVE_STAGES = new Set(['enqueued', 'held']);
let tmpCounter = 0;
/**
 * Write via a temporary file and rename, so readers never see half a file.
 * With `createDir: false` a missing directory is an error (ENOENT) instead of
 * being created.
 */
function writeJsonAtomic(file, data, options = {}) {
    if (options.createDir !== false) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    for (let attempt = 1;; attempt++) {
        try {
            fs.renameSync(tmp, file);
            return;
        }
        catch (e) {
            // Windows refuses to replace a file another process has open.
            const code = e.code;
            if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY')) {
                fs.rmSync(tmp, { force: true });
                throw e;
            }
            sleepSync(20 * attempt);
        }
    }
}
/** undefined when the file does not exist or cannot be parsed. */
function readJson(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function readLockState(file) {
    const state = readJson(file);
    return state && state.version === 1 && state.lockId ? state : undefined;
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Starting and stopping the heartbeat daemon (PLAN §4.3).
 *
 * The daemon is a detached Node process so it outlives the main step. It
 * inherits the environment (including RUNNER_TRACKING_ID, which is how the
 * runner finds and terminates orphan processes at the end of the job) except
 * the INPUT_* and STATE_* variables; the token goes in an environment variable,
 * never on the command line where `ps` would show it.
 *
 * Stopping is cooperative: the caller writes a stop file and waits for the
 * daemon to record stoppedAt. Once it has, no further heartbeat is sent. A
 * signal is only a fallback, and only after checking that the PID still
 * belongs to the daemon (PIDs are reused).
 */
const DAEMON_ENV = {
    serverUrl: 'LRRC_DAEMON_SERVER_URL',
    username: 'LRRC_DAEMON_USERNAME',
    token: 'LRRC_DAEMON_TOKEN',
    lockId: 'LRRC_DAEMON_LOCK_ID',
    stateFile: 'LRRC_DAEMON_STATE_FILE',
    statusFile: 'LRRC_DAEMON_STATUS_FILE',
    logFile: 'LRRC_DAEMON_LOG_FILE',
    stopFile: 'LRRC_DAEMON_STOP_FILE'
};

/**
 * The heartbeat daemon's loop (PLAN §4.3, §6).
 *
 * - The first heartbeat goes out at once, then one every 10 s (fixed delay,
 *   like the Jenkins client).
 * - A failed heartbeat is recorded and the loop goes on: the server keeps the
 *   lock, and STALE only follows if heartbeats stay missing for 60 s.
 * - HTTP 410 (LOCK_STALE / LOCK_NOT_FOUND) ends the loop: there is no way back
 *   from STALE, so sending more would be pointless.
 * - It stops when asked (stop file or signal), and on its own when the lock's
 *   state file says the lock is no longer active or has disappeared (the
 *   runner empties RUNNER_TEMP at the end of the job), so it can never keep a
 *   lease alive after its job.
 */
const MAX_WARNINGS = 20;
async function runHeartbeatDaemon(cfg, deps) {
    const { clock } = deps;
    const status = {
        pid: deps.pid,
        lockId: cfg.lockId,
        startedAt: clock.now(),
        attempts: 0,
        okCount: 0,
        failCount: 0,
        warnings: []
    };
    const log = (level, message) => {
        try {
            fs.appendFileSync(cfg.logFile, `${isoTime(clock.now())} ${level} ${message}\n`);
        }
        catch {
            // Logging must never stop the heartbeats.
        }
    };
    const warn = (message) => {
        log('WARN', message);
        if (status.warnings[status.warnings.length - 1] !== message) {
            status.warnings.push(message);
            if (status.warnings.length > MAX_WARNINGS)
                status.warnings.shift();
        }
    };
    const save = () => {
        try {
            // Never create the directory: the lock step made it, and once it is
            // gone the job's temp dir has been removed. Recreating it would leave
            // files behind (and break a cleanup running at that moment).
            writeJsonAtomic(cfg.statusFile, status, { createDir: false });
        }
        catch (e) {
            log('WARN', `could not write ${cfg.statusFile}: ${errorMessage(e)}`);
        }
    };
    const stopper = new AbortController();
    let stopReason;
    const requestStop = (reason) => {
        if (stopReason === undefined) {
            stopReason = reason;
            stopper.abort();
        }
    };
    const onSignal = () => requestStop('signal');
    if (deps.signal?.aborted)
        requestStop('signal');
    deps.signal?.addEventListener('abort', onSignal);
    const grace = cfg.missingStateGraceMs ?? 2_000;
    let stateMissingSince;
    const checkStop = () => {
        if (fs.existsSync(cfg.stopFile)) {
            let reason = '';
            try {
                reason = fs.readFileSync(cfg.stopFile, 'utf8').trim();
            }
            catch {
                // The request is what matters, not its reason.
            }
            return `stop requested${reason ? ` (${reason})` : ''}`;
        }
        if (!fs.existsSync(cfg.stateFile)) {
            stateMissingSince ??= clock.now();
            return clock.now() - stateMissingSince >= grace
                ? 'state file removed (job finished)'
                : undefined;
        }
        stateMissingSince = undefined;
        const state = readLockState(cfg.stateFile);
        if (state && !ACTIVE_STAGES.has(state.stage)) {
            return `lock is ${state.stage}`;
        }
        return undefined;
    };
    // Checked on a timer as well, so a stop request also cuts short a
    // heartbeat that is in flight.
    const watcher = setInterval(() => {
        const reason = checkStop();
        if (reason)
            requestStop(reason);
    }, cfg.tickMs);
    save();
    log('INFO', `started: pid=${deps.pid} lockId=${cfg.lockId} interval=${cfg.intervalMs}ms`);
    let consecutiveFailures = 0;
    try {
        let next = clock.now();
        while (stopReason === undefined) {
            const early = checkStop();
            if (early) {
                requestStop(early);
                break;
            }
            const wait = next - clock.now();
            if (wait > 0) {
                try {
                    await clock.sleep(Math.min(wait, cfg.tickMs), stopper.signal);
                }
                catch {
                    break;
                }
                continue;
            }
            status.attempts++;
            status.lastAttemptAt = clock.now();
            try {
                await deps.api.heartbeat(cfg.lockId, stopper.signal);
                status.okCount++;
                status.lastOkAt = clock.now();
                if (consecutiveFailures > 0) {
                    log('INFO', `heartbeat recovered after ${consecutiveFailures} failure(s)`);
                }
                consecutiveFailures = 0;
            }
            catch (e) {
                if (stopReason !== undefined)
                    break;
                if (e instanceof RemoteApiError && e.status === 410) {
                    status.terminal = e.errorCode ?? 'LOCK_NOT_FOUND';
                    status.terminalAt = clock.now();
                    warn(`The server answered HTTP 410 (${status.terminal}) to a heartbeat for lock ${cfg.lockId}; no more heartbeats are sent.`);
                    requestStop(`server answered ${status.terminal}`);
                    break;
                }
                status.failCount++;
                consecutiveFailures++;
                status.lastError = errorMessage(e);
                warn(`Heartbeat for lock ${cfg.lockId} failed: ${status.lastError}`);
            }
            save();
            next = clock.now() + cfg.intervalMs;
        }
    }
    finally {
        clearInterval(watcher);
        deps.signal?.removeEventListener('abort', onSignal);
        status.stoppedAt = clock.now();
        status.stopReason = stopReason ?? 'unknown';
        save();
        log('INFO', `stopped: ${status.stopReason} (sent ${status.okCount}, failed ${status.failCount})`);
    }
    return status;
}

/**
 * Acquire state machine (the acquiring half of the Jenkins client's
 * RemoteLockSession): enqueue, retry while the server is paused (503),
 * poll until the request leaves QUEUED. The clock and the HTTP client are
 * injected so the tests can drive every branch.
 */
const systemClock = {
    now: () => Date.now(),
    sleep: async (ms, signal) => {
        await setTimeout(ms, undefined, { signal });
    }
};

/**
 * The heartbeat daemon process, started detached by the lock step. All of its
 * configuration arrives in LRRC_DAEMON_* environment variables.
 */
const env = process.env;
const read = (name) => env[name] ?? '';
const config = {
    serverUrl: read(DAEMON_ENV.serverUrl),
    username: read(DAEMON_ENV.username),
    token: read(DAEMON_ENV.token),
    lockId: read(DAEMON_ENV.lockId),
    stateFile: read(DAEMON_ENV.stateFile),
    statusFile: read(DAEMON_ENV.statusFile),
    logFile: read(DAEMON_ENV.logFile),
    stopFile: read(DAEMON_ENV.stopFile)
};
delete env[DAEMON_ENV.token];
if (Object.values(config).some((v) => v === '')) {
    process.stderr.write('heartbeat daemon: missing LRRC_DAEMON_* configuration\n');
    process.exit(2);
}
const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());
// Detached, but ignore a hang-up anyway: only a stop request or the job's end
// should end the heartbeats.
process.on('SIGHUP', () => undefined);
try {
    await runHeartbeatDaemon({
        lockId: config.lockId,
        stateFile: config.stateFile,
        statusFile: config.statusFile,
        logFile: config.logFile,
        stopFile: config.stopFile,
        intervalMs: timingFromEnv(env).heartbeatIntervalMs,
        tickMs: DAEMON_TICK_MS
    }, {
        api: new RemoteApiClient({
            serverUrl: config.serverUrl,
            username: config.username,
            token: config.token
        }),
        clock: systemClock,
        pid: process.pid,
        signal: controller.signal
    });
    process.exit(0);
}
catch (e) {
    try {
        fs.appendFileSync(config.logFile, `${isoTime(Date.now())} ERROR daemon crashed: ${errorMessage(e)}\n`);
    }
    catch {
        // Nothing else to do.
    }
    process.exit(1);
}
