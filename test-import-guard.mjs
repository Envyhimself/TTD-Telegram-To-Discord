import { readFileSync } from 'fs';

// Regression guard: every CONSTANT referenced in the cron/run path of
// index.js must actually be imported from reliability.js. This catches the
// "ReferenceError: X is not defined" class of bug that once crashed every
// cron run AND every watchdog kick (lockShouldSkip, RUN_LOCK_TTL_SECONDS),
// silently freezing all three relays for 40+ minutes.
const indexSrc = readFileSync(new URL('./src/index.js', import.meta.url), 'utf8');
const reliabilitySrc = readFileSync(new URL('./src/reliability.js', import.meta.url), 'utf8');

// Collect the identifiers imported from reliability.js
const importMatch = indexSrc.match(/import\s*\{([\s\S]*?)\}\s*from\s*'\.\/reliability\.js'/);
if (!importMatch) throw new Error('No reliability.js import found in index.js');
const imported = new Set(importMatch[1].split(',').map(s => s.trim()).filter(Boolean));

// Collect all exported constant names from reliability.js
const exported = new Set(
  [...reliabilitySrc.matchAll(/export\s+const\s+([A-Z][A-Z0-9_]*)\s*=/g)].map(m => m[1])
);

// Every constant used inside index.js's function bodies that comes from
// reliability.js should be imported. Cross-reference: identifiers in the
// body that match an export but are NOT imported.
const body = indexSrc.split(importMatch[0])[1];
const bodyConsts = new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)].map(m => m[1]));

const missing = [...exported].filter(name => bodyConsts.has(name) && !imported.has(name));

if (missing.length) {
  console.error(`MISSING IMPORT in src/index.js: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('import-guard OK: all referenced reliability.js constants are imported');
