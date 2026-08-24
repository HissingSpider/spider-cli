import fs from 'node:fs';
import path from 'node:path';

/**
 * Write a file so a reader never sees it half-written.
 *
 * The state files here — OAuth tokens, the trust store, settings, session
 * transcripts — are all read back with a `try { JSON.parse } catch { return
 * default }`. That is the right thing to do with a corrupt file, but it means
 * an interrupted write does not fail loudly: it silently reverts to defaults,
 * so a ctrl+c at the wrong moment quietly logs you out of an MCP server or
 * drops your allow rules.
 *
 * Writing to a sibling temp file and renaming makes the swap atomic on POSIX,
 * so the file on disk is always either the old contents or the new ones.
 */
export function writeFileAtomic(file: string, data: string, options: { mode?: number } = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  // Same directory, so the rename cannot cross a filesystem boundary.
  const temp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
  try {
    fs.writeFileSync(temp, data, options.mode === undefined ? undefined : { mode: options.mode });
    if (options.mode !== undefined) fs.chmodSync(temp, options.mode);
    fs.renameSync(temp, file);
  } catch (err) {
    // Never leave the temp file behind on a failed write.
    try {
      fs.unlinkSync(temp);
    } catch {
      /* it may not exist */
    }
    throw err;
  }
}
