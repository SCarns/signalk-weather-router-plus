/**
 * The errors the routing engine raises, one hierarchy. Callers decide by
 * class or `code`, never by matching the message text; `fatal` says that
 * no fallback (another skeleton, a wider window, routing legs one by one)
 * can help.
 */

export type EngineErrorCode =
  /** The caller's `shouldCancel` answered true. */
  | 'cancelled'
  /** The isochrone search failed (bad input, point on land, front went empty). */
  | 'route'
  /** The search made no progress towards the destination for several stages. */
  | 'boxed_in'
  /** No branch crossed every via; the caller may retry without automatic vias. */
  | 'vias_not_crossed'
  /** The coarse A* skeleton found no path. */
  | 'skeleton'
  /** The water-grid A* found no path inside its window, or ran out of expansions. */
  | 'grid_astar'
  /** No corridor could be planned on the water grid. */
  | 'corridor';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: EngineErrorCode,
    readonly fatal = false
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown wherever a `shouldCancel` callback answers true. */
export class RouteCancelled extends EngineError {
  constructor() {
    super('route computation cancelled', 'cancelled', true);
  }
}

export class RouteError extends EngineError {
  constructor(message: string, code: EngineErrorCode = 'route') {
    super(message, code);
  }
}

/** No branch went through every via (thrown so callers can retry without automatic vias). */
export class ViasNotCrossedError extends RouteError {
  constructor(message: string) {
    super(message, 'vias_not_crossed');
  }
}

/** The coarse-grid skeleton A* (astar.ts) found no path; `partialPath` is how far it got. */
export class AstarError extends EngineError {
  constructor(
    message: string,
    readonly partialPath: { lon: number; lat: number }[] = []
  ) {
    super(message, 'skeleton');
  }
}

/** The water-grid A* (gridastar.ts) failed; `exhausted`: the whole window was searched. */
export class GridAstarError extends EngineError {
  constructor(
    message: string,
    readonly exhausted: boolean,
    readonly expanded: number
  ) {
    super(message, 'grid_astar');
  }
}

/** Corridor planning failed; `fatal`: a fallback skeleton cannot help either (e.g. a route point on land). */
export class CorridorError extends EngineError {
  constructor(message: string, fatal = false) {
    super(message, 'corridor', fatal);
  }
}
