// ABOUTME: Reactive clock for live Meeting Mode elapsed-time surfaces.
// ABOUTME: Keeps active capture timers moving without polling completed rows.

import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

const MEETING_DURATION_TICK_MS = 1_000;

export function createMeetingDurationClock(
  active: Accessor<boolean>,
): Accessor<number> {
  const [now, setNow] = createSignal(Date.now());

  createEffect(() => {
    if (!active()) return;

    setNow(Date.now());
    const timer = setInterval(
      () => setNow(Date.now()),
      MEETING_DURATION_TICK_MS,
    );
    onCleanup(() => clearInterval(timer));
  });

  return now;
}
