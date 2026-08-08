/** A lossless wake signal: events received while work is running wake the next iteration. */
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

