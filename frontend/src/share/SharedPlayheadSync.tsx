/**
 * Lands an applied share's playhead (store `share.pending.time`). The fire's
 * timeline domain arrives with its data, possibly after the share applies, so
 * the time waits until the domain reaches it — and is re-applied if a later
 * domain update clamps it away. The user's own intent wins: pressing play or
 * moving the playhead drops it, and it gives up after 30 s. (Shared links do
 * the same for their `t` param in App's UrlStateSync.)
 */
import { useEffect } from 'react';
import { useStore, type AppState } from '../state/store';

const PATIENCE_MS = 30_000;

function step(s: AppState, prev: AppState): void {
  const p = s.share.pending;
  if (!p || p.time == null) return;
  if (s.view.mode !== 'fire' || s.view.corneaId !== p.corneaId) return;
  const { settleShared, setTime } = s.actions;
  if (s.time.playing || Date.now() - p.at > PATIENCE_MS) {
    settleShared('time');
    return;
  }
  // A playhead move nothing else explains (no new domain, no new "now") is
  // the user scrubbing.
  const moved =
    s.time.currentTime !== prev.time.currentTime
    && s.time.domain === prev.time.domain
    && s.time.now === prev.time.now;
  if (moved && s.time.currentTime !== p.time) {
    settleShared('time');
    return;
  }
  const [d0, d1] = s.time.domain;
  if (p.time >= d0 && p.time <= d1 && s.time.currentTime !== p.time) setTime(p.time);
}

export function SharedPlayheadSync() {
  useEffect(() => {
    step(useStore.getState(), useStore.getState());
    const unsub = useStore.subscribe(step);
    // the patience deadline passes without a store change
    const t = setInterval(() => step(useStore.getState(), useStore.getState()), 5_000);
    return () => {
      clearInterval(t);
      unsub();
    };
  }, []);
  return null;
}
