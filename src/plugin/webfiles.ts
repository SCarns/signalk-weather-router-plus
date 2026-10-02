/**
 * The web app's files on disk: content hashes, and the re-dating that
 * makes browsers refetch them after an update (see refreshPublicFileDates).
 *
 * Extracted from index.ts (docs/plans/structural-cleanup.md, phase 2.3).
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The version tag the page's references carry (`?v=<tag>`). */
const V_TAG = /\?v=[0-9a-z]+/g;

/**
 * A short hash of the files under a directory (name and content), or
 * 'nofiles'. Version tags inside .html, .js and .css files are left out
 * of the hash, so tagging the files (tagPublicFiles) does not change it.
 */
export function filesHash(dir: string, exclude: string[] = []): string {
  const h = createHash('sha1');
  const walk = (d: string): void => {
    for (const f of fs.readdirSync(d).sort()) {
      const p = path.join(d, f);
      const rel = path.relative(dir, p);
      if (exclude.includes(rel)) continue;
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(?:html|js|css)$/.test(f)) h.update(rel).update(fs.readFileSync(p, 'utf8').replace(V_TAG, ''));
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
 * Write the version tag into the files on disk: index.html's script and
 * style tags and the ES modules' relative import specifiers get
 * `?v=<tag>` (an older tag is replaced). Signal K serves the web app
 * from `public/` as static files, untouched by the plugin's own `/ui`
 * route that tags the page as it is served, so the files themselves must
 * carry the tag or a browser keeps running old modules after an update
 * (brain, 2026-10-02: the new rp-layers.js on disk, the old one in the
 * page). Returns the number of files rewritten.
 */
export function tagPublicFiles(publicDir: string, tag: string): number {
  let n = 0;
  const rewrite = (file: string, from: RegExp, to: string): void => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const out = text.replace(from, to);
    if (out !== text) {
      fs.writeFileSync(file, out);
      n++;
    }
  };
  rewrite(
    path.join(publicDir, 'index.html'),
    /(<(?:script|link)[^>]+(?:src|href)=")((?:ol|rp-[a-z]+)\.(?:js|css))(?:\?v=[0-9a-z]+)?"/g,
    `$1$2?v=${tag}"`
  );
  for (const f of fs.readdirSync(publicDir)) {
    if (!/^rp-[a-z]+\.js$/.test(f)) continue;
    rewrite(path.join(publicDir, f), /^(\s*import\b[^'"\n]*['"]\.\/rp-[a-z]+\.js)(?:\?v=[0-9a-z]+)?(['"])/gm, `$1?v=${tag}$2`);
  }
  return n;
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
    const tagged = tagPublicFiles(pub, hash);
    walk(pub);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(stamp, hash);
    log(
      `web files changed since the last start (${hash}): tagged ${tagged} file(s) with ?v=${hash} and dated ${n} files now, so browsers refetch them`
    );
  } catch (err) {
    error(`could not re-date the web files: ${(err as Error).message}`);
  }
}
