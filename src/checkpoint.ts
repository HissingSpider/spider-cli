import fs from 'node:fs';
import path from 'node:path';
import type { Turn } from './providers/types.ts';

/**
 * A point the session can be rewound to.
 *
 * `turns` is the transcript as it stood *before* the user's message, so
 * restoring drops that exchange entirely. `files` holds the original contents of
 * every file mutated after this point, so rewinding undoes the edits too —
 * without that, rewinding the conversation while leaving the working tree
 * changed produces a state that never actually existed.
 */
export type Checkpoint = {
  id: number;
  label: string;
  at: Date;
  turns: Turn[];
  /** path -> contents before the first mutation, or null if it did not exist. */
  files: Map<string, string | null>;
  /** Files too large to copy; restore reports these rather than pretending. */
  unbacked: Set<string>;
};

/**
 * Caps. Every checkpoint holds the pre-edit contents of each file touched
 * after it, so an unbounded store grows with (turns x file size): 200 turns
 * editing one 200 KB file retained 40 MB. A session is not worth a leak, and
 * nobody rewinds fifty turns.
 */
const MAX_CHECKPOINTS = 50;
/** A file bigger than this is not worth holding a copy of per checkpoint. */
const MAX_BACKUP_BYTES = 2_000_000;
/** Ceiling on everything the store retains, across all checkpoints. */
const MAX_TOTAL_BYTES = 32_000_000;

export class CheckpointStore {
  private items: Checkpoint[] = [];
  private nextId = 1;
  private bytes = 0;
  /** Checkpoints dropped to stay inside the caps, so /rewind can say so. */
  private evicted = 0;

  get droppedCount(): number {
    return this.evicted;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  /** Drop the oldest checkpoints until both caps are satisfied. */
  private evict(): void {
    while (
      this.items.length > MAX_CHECKPOINTS ||
      (this.bytes > MAX_TOTAL_BYTES && this.items.length > 1)
    ) {
      const oldest = this.items.shift();
      if (!oldest) break;
      for (const [, content] of oldest.files) this.bytes -= content?.length ?? 0;
      this.evicted++;
    }
  }

  get length(): number {
    return this.items.length;
  }

  list(): Checkpoint[] {
    return this.items;
  }

  /** Snapshot the transcript before `label` is acted on. */
  record(label: string, turns: Turn[]): Checkpoint {
    const cp: Checkpoint = {
      id: this.nextId++,
      label: label.replace(/\s+/g, ' ').trim(),
      at: new Date(),
      turns: structuredClone(turns),
      files: new Map(),
      unbacked: new Set(),
    };
    this.items.push(cp);
    this.evict();
    return cp;
  }

  /**
   * Back up a file before it is modified. Recorded against every live
   * checkpoint that has not already captured it, since rewinding to any of them
   * must undo this edit. Only the first backup per checkpoint is kept — that is
   * the content as of that checkpoint.
   */
  backup(file: string): void {
    if (!this.items.length) return;

    let content: string | null = null;
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_BACKUP_BYTES) {
        // Recorded as unbackable so restore reports it rather than silently
        // leaving a file that rewinding claims to have reverted.
        for (const cp of this.items) {
          if (!cp.files.has(file)) cp.unbacked.add(file);
        }
        return;
      }
      content = fs.readFileSync(file, 'utf8');
    } catch {
      content = null; // did not exist; rewinding should delete it
    }

    for (const cp of this.items) {
      if (!cp.files.has(file) && !cp.unbacked.has(file)) {
        cp.files.set(file, content);
        this.bytes += content?.length ?? 0;
      }
    }
    this.evict();
  }

  /**
   * Restore to `id`: return the transcript as it was, put the files back, and
   * drop this checkpoint and everything after it.
   */
  restore(id: number): {
    turns: Turn[];
    restored: string[];
    removed: string[];
    failed: string[];
    unbacked: string[];
  } | null {
    const index = this.items.findIndex((c) => c.id === id);
    if (index === -1) return null;
    const cp = this.items[index];

    const restored: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];

    for (const [file, content] of cp.files) {
      try {
        if (content === null) {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            removed.push(file);
          }
        } else {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, content);
          restored.push(file);
        }
      } catch {
        failed.push(file);
      }
    }

    const turns = structuredClone(cp.turns);
    for (const dropped of this.items.slice(index)) {
      for (const [, content] of dropped.files) this.bytes -= content?.length ?? 0;
    }
    this.items = this.items.slice(0, index);
    return { turns, restored, removed, failed, unbacked: [...cp.unbacked] };
  }

  clear(): void {
    this.items = [];
    this.bytes = 0;
  }
}

/** One line per checkpoint for the /rewind listing. */
export function formatList(items: Checkpoint[], cwd: string, dropped = 0): string {
  if (!items.length) return 'No checkpoints yet — they are created when you send a message.';
  return items
    .map((c) => {
      const time = c.at.toTimeString().slice(0, 5);
      const touched = c.files.size;
      const label = c.label.length > 60 ? c.label.slice(0, 57) + '...' : c.label;
      const files = touched
        ? '  (' + touched + ' file' + (touched === 1 ? '' : 's') + ' changed since)'
        : '';
      return '  ' + String(c.id).padStart(2) + '  ' + time + '  ' + label + files;
    })
    .join('\n')
    .concat('\n\nRestore with /rewind <number>. Files changed since that point are reverted.')
    .concat(
      dropped
        ? '\n' +
            dropped +
            ' older checkpoint' +
            (dropped === 1 ? '' : 's') +
            ' dropped to bound memory.'
        : '',
    )
    .concat(cwd ? '' : '');
}
