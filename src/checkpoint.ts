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
};

export class CheckpointStore {
  private items: Checkpoint[] = [];
  private nextId = 1;

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
    };
    this.items.push(cp);
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
      content = fs.readFileSync(file, 'utf8');
    } catch {
      content = null; // did not exist; rewinding should delete it
    }
    for (const cp of this.items) {
      if (!cp.files.has(file)) cp.files.set(file, content);
    }
  }

  /**
   * Restore to `id`: return the transcript as it was, put the files back, and
   * drop this checkpoint and everything after it.
   */
  restore(id: number): { turns: Turn[]; restored: string[]; removed: string[]; failed: string[] } | null {
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
    this.items = this.items.slice(0, index);
    return { turns, restored, removed, failed };
  }

  clear(): void {
    this.items = [];
  }
}

/** One line per checkpoint for the /rewind listing. */
export function formatList(items: Checkpoint[], cwd: string): string {
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
    .concat(cwd ? '' : '');
}
