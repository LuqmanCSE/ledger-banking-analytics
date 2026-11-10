import {mkdir, writeFile} from 'node:fs/promises';
import {seedBatch, seedTotal} from '../worker/bootstrap.js';

const statements = [];
for (let cursor = 0; cursor < seedTotal;) {
  const batch = seedBatch(cursor);
  for (const [sql, args] of batch.statements) {
    const bindings = args.map(value => "'" + value.replaceAll("'", "''") + "'");
    statements.push(sql.replace(/\?/g, () => bindings.shift()) + ';');
  }
  cursor = batch.end;
}
await mkdir(new URL('../outputs/', import.meta.url), {recursive:true});
await writeFile(new URL('../outputs/seed-d1.sql', import.meta.url), statements.join('\n\n') + '\n');
console.log('Generated outputs/seed-d1.sql from the synthetic baseline.');
