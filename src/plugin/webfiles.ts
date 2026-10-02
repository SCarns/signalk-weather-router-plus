/**
 * The web app's files on disk: content hashes, and the re-dating that
 * makes browsers refetch them after an update (see refreshPublicFileDates).
 *
 * Extracted from index.ts (docs/plans/structural-cleanup.md, phase 2.3).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A short hash of the files under a directory (name and content), or 'nofiles'. */
export function filesHash(dir: string, exclude: string[] = []): string {
  const h = createHash('sha1');
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      const rel = path.relative(dir, p);
      if (exclude.includes(rel)) continue;
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(rel).update(fs.readFileSync(p));
    }
  };
  try {
    walk(dir);
  } catch {
    return 'nofiles';
  }
  return h.digest('hex').slice(0, 8);
}

/** The panel's files (public/plotterext), for its cache-busting URL. */
export function panelFilesHash(publicDir: string): string {
  return filesHash(path.join(publicDir, 'plotterext'));
}

/**
 * Files installed by npm carry npm's fixed date (26 Oct 1985), which the
 * server sends as Last-Modified, with no ETag. A browser that already has
 * a file then asks "modified since 1985?", is told "no", and keeps its old
 * copy after an update, for the web app's page, the configuration panel's
 * script and the plotter panel alike, until the URL changes. So on the
 * first start after the files changed (by their content), set their dates
 * to now, and the next conditional request gets the new file.
 *
 * The web app's own scripts and stylesheet are versioned (`?v=<tag>`) when
 * index.html is served (plugin/api.ts servePublic): the tag changes with
 * the files, so a plain reload never runs the old scripts. Nothing on disk
 * is rewritten.
 */
export function refreshPublicFileDates(publicDir: string, dataDir: string, log: (m: string) => void, error: (m: string) => void): void {
  const pub = publicDir;
  const stamp = path.join(dataDir, 'public-files.hash');
  const hash = filesHash(pub);
  let previous: string;
  try {
    previous = fs.readFileSync(stamp, 'utf8').trim();
  } catch {
    previous = '';
  }
  if (hash === previous) return;
  const now = new Date();
  let n = 0;
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else {
        fs.utimesSync(p, now, now);
        n++;
      }
    }
  };
  try {
    walk(pub);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stamp, hash);
    log(`web files changed since the last start (${hash}): dated ${n} files now, so browsers refetch them`);
  } catch (err) {
    error(`could not re-date the web files: ${(err as Error).message}`);
  }
}
