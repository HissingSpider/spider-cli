/**
 * Helpers for caught values.
 *
 * Under `strict`, a catch binding is `unknown`, which is correct — anything can
 * be thrown — but it makes the common `err.message` unusable. Annotating the
 * binding `any` silences that by giving up type safety on every field access.
 * These narrow instead, so a thrown string or a null still produces something
 * printable rather than "undefined" or a second exception inside the handler.
 */

function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return typeof value === 'object' && value !== null && key in value;
}

/** A printable message for anything that can be thrown. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (hasKey(error, 'message')) {
    const message = error.message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

/** The `code` an errno or HTTP-shaped error carries, if any. */
export function errorCode(error: unknown): string | number | undefined {
  if (hasKey(error, 'code')) {
    const code = error.code;
    if (typeof code === 'string' || typeof code === 'number') return code;
  }
  return undefined;
}

/** A named string field, for the stdout/stderr that exec attaches to failures. */
export function errorText(error: unknown, key: string): string {
  if (hasKey(error, key)) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return '';
}

/** True when a fetch or spawn was aborted rather than failing on its own. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  if (hasKey(error, 'name') && error.name === 'AbortError') return true;
  return errorCode(error) === 'ABORT_ERR';
}

/** Narrowing helpers for values read off untyped stream payloads. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
