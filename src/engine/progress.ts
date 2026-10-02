/**
 * The one progress-callback shape of the engine: `(stage, totalStages,
 * message)`. Code without stages (corridor planning, the multi-leg
 * driver) reports `(0, 0, message)`.
 */
export type ProgressFn = (stage: number, totalStages: number, message: string) => void;
