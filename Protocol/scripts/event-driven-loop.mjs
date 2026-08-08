/** A lossless wake signal: events received while work is running wake the next iteration. */
export const WORKER_HEARTBEAT_TYPE = 'myne-worker-heartbeat-v1';

const HEARTBEAT_PHASES = new Set(['tick-start', 'tick-complete', 'tick-error']);

export function createWorkerHeartbeat(worker, phase, outcome = null, at = Date.now()) {
  if (typeof worker !== 'string' || !worker) throw new TypeError('Worker name is required');
  if (!HEARTBEAT_PHASES.has(phase)) throw new TypeError('Worker heartbeat phase is invalid');
  if (!Number.isFinite(at) || at < 0) throw new TypeError('Worker heartbeat time is invalid');
  const normalizedOutcome = outcome == null ? null : String(outcome).slice(0, 160);
  return {
    type: WORKER_HEARTBEAT_TYPE,
    worker,
    phase,
    outcome: normalizedOutcome,
    at,
  };
}

/** Best-effort local IPC only; heartbeat failure must never alter worker transactions. */
export function emitWorkerHeartbeat(worker, phase, outcome = null) {
  const message = createWorkerHeartbeat(worker, phase, outcome);
  if (typeof process.send !== 'function' || process.connected === false) return message;
  try {
    process.send(message, () => {});
  } catch {
    // The supervisor may have closed IPC during shutdown. Worker logic remains authoritative.
  }
  return message;
}

export function recordWorkerHeartbeat(status, message, {
  expectedWorker,
  receivedAt = Date.now(),
} = {}) {
  if (!status || typeof status !== 'object') return false;
  if (message?.type !== WORKER_HEARTBEAT_TYPE) return false;
  if (message.worker !== expectedWorker || !HEARTBEAT_PHASES.has(message.phase)) return false;
  if (!Number.isFinite(receivedAt) || receivedAt < 0) return false;
  status.lastHeartbeatAt = receivedAt;
  status.lastHeartbeatPhase = message.phase;
  status.lastOutcome = message.outcome == null ? null : String(message.outcome).slice(0, 160);
  if (message.phase === 'tick-complete') status.lastCompletedAt = receivedAt;
  if (message.phase === 'tick-error') status.lastErrorAt = receivedAt;
  return true;
}

export function workerHeartbeatFresh(status, {
  now = Date.now(),
  maxAgeMs,
} = {}) {
  if (!status?.running || !Number.isFinite(status.lastHeartbeatAt)) return false;
  if (!Number.isFinite(now) || !Number.isInteger(maxAgeMs) || maxAgeMs <= 0) return false;
  const age = now - status.lastHeartbeatAt;
  return age >= 0 && age <= maxAgeMs;
}

export function createWakeSignal({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = false;
  let waiter = null;

  const signal = () => {
    pending = true;
    if (waiter) waiter();
  };

  const wait = async (timeoutMs) => {
    if (pending) {
      pending = false;
      return 'event';
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        waiter = null;
        if (reason === 'event') pending = false;
        resolve(reason);
      };
      const timer = setTimer(() => finish('timeout'), timeoutMs);
      waiter = () => finish('event');
    });
  };

  return { signal, wait };
}

/**
 * Bound one worker cycle so a stalled RPC, database request or confirmation cannot leave a
 * supervised child alive-but-useless forever. Production callers terminate from `onTimeout`;
 * their parent supervisor then starts a clean process which resumes from the durable cursor.
 */
export async function runWorkerTick({
  worker,
  timeoutMs,
  task,
  onTimeout,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof worker !== 'string' || !worker) throw new TypeError('Worker name is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Worker timeout must be positive');
  if (typeof task !== 'function') throw new TypeError('Worker task is required');
  if (typeof onTimeout !== 'function') throw new TypeError('Worker timeout handler is required');

  let completed = false;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimer(() => {
      if (completed) return;
      const error = new Error(`${worker} tick exceeded ${timeoutMs}ms`);
      error.code = 'WORKER_TICK_TIMEOUT';
      try {
        onTimeout(error);
      } catch (handlerError) {
        reject(handlerError);
        return;
      }
      reject(error);
    }, timeoutMs);
    timer?.unref?.();
  });

  try {
    return await Promise.race([Promise.resolve().then(task), timeout]);
  } finally {
    completed = true;
    if (timer !== null) clearTimer(timer);
  }
}

/**
 * Wake a worker as soon as Helius/Solana confirms any successful transaction mentioning MYNE.
 * Delayed follow-ups close the small race where a downstream worker depends on an index row that
 * another event-driven process is still committing.
 */
export async function attachProgramWake({
  connection, programId, wake, commitment = 'confirmed', followUpDelays = [],
}) {
  return connection.onLogs(programId, ({ err }) => {
    if (err) return;
    wake.signal();
    for (const delay of followUpDelays) setTimeout(() => wake.signal(), delay);
  }, commitment);
}
