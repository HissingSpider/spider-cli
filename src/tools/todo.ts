import type { ToolImpl } from './index.ts';

/**
 * The todo list.
 *
 * A twenty-step task rendered as an undifferentiated wall of tool calls is
 * unreadable — you cannot tell what is left, what was skipped, or whether the
 * agent has quietly lost the plot. Writing the plan down and keeping it visible
 * is what makes long work legible, and it keeps the model honest about what it
 * has actually finished.
 *
 * State lives in the tool rather than the transcript so the UI can render the
 * current list without parsing anything back out of the history.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type Todo = { content: string; status: TodoStatus };

let todos: Todo[] = [];
const listeners = new Set<(t: Todo[]) => void>();

export function getTodos(): Todo[] {
  return todos;
}

export function setTodos(next: Todo[]): void {
  todos = next;
  for (const fn of listeners) fn(todos);
}

export function onTodosChanged(fn: (t: Todo[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearTodos(): void {
  setTodos([]);
}

/** Read a string field off a value that came from untrusted JSON. */
function field(item: unknown, key: string): string {
  if (typeof item === 'object' && item !== null && key in item) {
    return String((item as Record<string, unknown>)[key] ?? '');
  }
  return '';
}

function normalize(raw: unknown): Todo[] | string {
  if (!Array.isArray(raw)) return 'todos must be an array.';
  const out: Todo[] = [];
  for (const item of raw) {
    const content = field(item, 'content').trim();
    const status = field(item, 'status') || 'pending';
    if (!content) return 'every todo needs a non-empty content field.';
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      return `unknown status "${status}" — use pending, in_progress or completed.`;
    }
    out.push({ content, status: status as TodoStatus });
  }
  const active = out.filter((t) => t.status === 'in_progress');
  if (active.length > 1) return 'only one todo may be in_progress at a time.';
  return out;
}

export const todoTool: ToolImpl = {
  spec: {
    name: 'todo_write',
    description: [
      'Record and update a task list for the work in progress.',
      'Use it for anything with three or more distinct steps, or when the user gives you',
      'a list of things to do. Write the whole list every time — it replaces the previous one.',
      'Mark exactly one item in_progress while you work on it, and mark it completed as soon',
      'as it is actually done, not in a batch at the end.',
      'Skip it for single-step work, where it is pure overhead.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete list, replacing whatever was there before.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The task, in imperative form' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
              },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
  },

  async run(input) {
    const result = normalize(input.todos);
    if (typeof result === 'string') return { output: 'Rejected: ' + result, isError: true };
    setTodos(result);
    const done = result.filter((t) => t.status === 'completed').length;
    return {
      output: `Todo list updated — ${done}/${result.length} complete.`,
      isError: false,
    };
  },
};
