import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

export function loadDotEnv(): void {
  const candidates = [resolve(process.cwd(), '.env')];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) {
      continue;
    }

    const content = readFileSync(envPath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) {
        continue;
      }

      const [key, ...rest] = line.split('=');
      const value = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
      if (key && !process.env[key.trim()]) {
        process.env[key.trim()] = value;
      }
    }
  }
}
