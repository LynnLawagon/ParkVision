// Own each monitoring run so Stop cancels pending captures/results/publications.
// A previous run finishing must never stop or publish on behalf of a new run.
export function createFrameMonitor(wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  let active = null;
  return {
    get running() { return active !== null; },
    stop() {
      const previous = active;
      active = null;
      previous?.onStop?.();
    },
    async start(options) {
      if (active) return;
      const run = options;
      active = run;
      const current = () => active === run;
      try {
        await run.prepare?.();
        while (current() && run.shouldContinue()) {
          const frame = await run.capture();
          if (!current() || !run.shouldContinue()) break;
          const result = await run.analyze(frame);
          if (!current() || !run.shouldContinue()) break;
          if (result?.canPublish && result.results.some(item => !item.requiresReview)) await run.publish?.(result);
          if (!current()) break;
          await wait(2000);
        }
      } catch (error) {
        if (current()) run.onError(error);
      } finally {
        if (current()) { active = null; run.onStop(); }
      }
    },
  };
}
