import * as fs from 'node:fs';
import * as path from 'node:path';
import { DECODED_DIR } from '../data/decoded';
import { REGIONAL_DIR } from '../data/regionaldecode';
import { COARSE_DIR } from './meshcoarse';

/**
 * The data directory's subdirectories that hold only what the plugin
 * downloads or works out again by itself: the forecast, current and
 * sea-level downloads, the decoded runs, the meshes' rough cuts and the
 * rendered tiles. Together they are gigabytes, rewritten with every
 * forecast run, and stale by the time a backup of them is restored.
 *
 * Not here: settings.json, prefs.json (the Setup choices with security
 * off), jobs and polars (the user's own), and the coastline and
 * downloaded meshes. Those change rarely, so a backup holds them once,
 * and a boat offshore cannot download them again.
 */
export const CACHE_DIRS = [
  DECODED_DIR,
  'ecmwf',
  'rtofs',
  'smoc',
  'sealevel',
  REGIONAL_DIR,
  COARSE_DIR,
  'overlay-tiles',
  'overlay-land',
] as const;

export const CACHEDIR_TAG_FILE = 'CACHEDIR.TAG';

/** What a tag must start with to count: exactly these 43 bytes. */
export const CACHEDIR_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';

/**
 * Cache directory tag (https://bford.info/cachedir/). Kopia skips the
 * directory holding it by default; restic, Borg and GNU tar do with
 * --exclude-caches. Only the signature at its start is read.
 */
export const CACHEDIR_TAG =
  `${CACHEDIR_SIGNATURE}\n` +
  '# This file is a cache directory tag created by signalk-weather-router-plus.\n' +
  '# Everything here is downloaded or rebuilt by the plugin; backups can skip it.\n' +
  '# For information about cache directory tags, see https://bford.info/cachedir/\n';

/**
 * Tags each of CACHE_DIRS below `dataDir`, creating the directory when it
 * is not there yet (the clients create theirs on first use, after a backup
 * may already have run). A tag already there is kept when it starts with
 * the signature, and written again when not: backup tools ignore a tag
 * without it. The pruners only remove entries named like their runs, so
 * the tag stays.
 * Returns the problems, one per directory that could not be tagged.
 */
export function tagCacheDirs(dataDir: string): string[] {
  const problems: string[] = [];
  for (const name of CACHE_DIRS) {
    const dir = path.join(dataDir, name);
    const tag = path.join(dir, CACHEDIR_TAG_FILE);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!hasSignature(tag)) fs.writeFileSync(tag, CACHEDIR_TAG);
    } catch (err) {
      problems.push(`${tag}: ${(err as Error).message}`);
    }
  }
  return problems;
}

/** A readable file at `tag` that starts with the signature. */
function hasSignature(tag: string): boolean {
  try {
    return fs.readFileSync(tag, 'utf8').startsWith(CACHEDIR_SIGNATURE);
  } catch {
    return false; // absent, or not a file: writing it reports why
  }
}
