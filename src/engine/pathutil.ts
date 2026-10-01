/**
 * Greedy string pulling shared by the water-grid smoother (gridastar.ts)
 * and the raster re-trace (corridor.ts fineTrace): from each anchor, jump
 * to the farthest later node that `canJump(i, j)` allows (range and line
 * of sight, as the caller defines them); the next node is the fallback.
 */
export function stringPull<T>(path: T[], canJump: (i: number, j: number) => boolean): T[] {
  if (path.length <= 2) return path.slice();
  const out: T[] = [path[0]];
  let i = 0;
  while (i < path.length - 1) {
    let best = i + 1;
    for (let j = path.length - 1; j > i + 1; j--) {
      if (canJump(i, j)) {
        best = j;
        break;
      }
    }
    out.push(path[best]);
    i = best;
  }
  return out;
}
