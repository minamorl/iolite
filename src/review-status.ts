import type { PipelineResult } from './types';

/** Only completed scrutiny can suppress retries or report a clean risk result. */
export function isReviewComplete(result: PipelineResult): boolean {
  const s = result.stats;
  return s.lensesRun.length > 0 && s.lensesFailed.length === 0 &&
    s.skepticsFailed.length === 0 && s.failedStages.length === 0;
}
