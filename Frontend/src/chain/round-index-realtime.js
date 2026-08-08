import { isSocialConfigured, supabase } from '../social/config.js';

const listeners = new Set();
let channel = null;

const publish = (payload) => {
  for (const listener of listeners) {
    try { listener(payload); } catch (error) { console.warn('round index realtime listener failed', error); }
  }
};

const ensureChannel = () => {
  if (!isSocialConfigured || !supabase || channel || !listeners.size) return;
  channel = supabase
    .channel('protocol:round-index:v1')
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'mine_rounds',
    }, publish)
    .subscribe((status, error) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('round index realtime unavailable; polling remains active', error?.message || error || status);
      }
    });
};

export function subscribeRoundIndexChanges(listener) {
  if (typeof listener !== 'function') throw new TypeError('Round index realtime listener must be a function');
  listeners.add(listener);
  ensureChannel();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && channel && supabase) {
      const stale = channel;
      channel = null;
      void supabase.removeChannel(stale);
    }
  };
}

