/**
 * Reads the office-lines override (`<userData>/office-lines.json`) for the
 * renderer's break-spot small talk. Validation lives in
 * shared/officeLinesPayload; this file only finds and reads the file. A missing,
 * oversized or broken file yields null, which means "use the built-in lines".
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  OFFICE_LINES_FILE, MAX_FILE_BYTES, parseOfficeLinesText, type OfficeLinesOverride
} from '../shared/officeLinesPayload';

export function officeLinesPath(userDataDir: string): string {
  return join(userDataDir, OFFICE_LINES_FILE);
}

export function loadOfficeLines(userDataDir: string): OfficeLinesOverride | null {
  const file = officeLinesPath(userDataDir);
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return parseOfficeLinesText(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
