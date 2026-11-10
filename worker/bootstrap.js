import seed from '../data/seed.json' with {type:'json'};

export const datasetVersion = seed.version;
export const seedTotal = seed.transactions.length;

export async function seedStatus(db) {
  const state = await db.prepare(`SELECT
    (SELECT value FROM metadata WHERE key='seed_cursor') AS cursor,
    (SELECT value FROM metadata WHERE key='dataset_version') AS version`).first();
  const loaded = Number(state?.cursor || 0);
  if ((loaded || state?.version) && state?.version !== datasetVersion) {
    throw new Error('This database contains another dataset. Use a separate Ledger synthetic database.');
  }
  return {ready: loaded >= seedTotal, loaded, total: seedTotal};
}

export function seedBatch(cursor) {
  const end = Math.min(cursor + 500, seedTotal);
  const statements = [];
  if (cursor === 0) {
    // The NOT NULL constraint makes a legacy or mismatched database fail before any rows are inserted.
    statements.push([`INSERT INTO metadata(key,value)
      SELECT 'dataset_version', CASE WHEN
        (EXISTS(SELECT 1 FROM customers) OR EXISTS(SELECT 1 FROM metadata WHERE key='dataset_version'))
        AND COALESCE((SELECT value FROM metadata WHERE key='dataset_version'),'')<>?
      THEN NULL ELSE ? END WHERE 1
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [datasetVersion, datasetVersion]]);
    statements.push([`INSERT OR IGNORE INTO customers(customer_id,branch_id,age,gender,income_bracket,channel,account_type,kyc_status,account_open_date,initial_minor,balance_minor)
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]'),json_extract(value,'$[6]'),json_extract(value,'$[7]'),json_extract(value,'$[8]'),json_extract(value,'$[9]'),json_extract(value,'$[9]') FROM json_each(?)`, [JSON.stringify(seed.customers)]]);
  }
  statements.push([`INSERT OR IGNORE INTO transactions(transaction_id,customer_id,transaction_date,amount_minor,transaction_type,source)
    SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]') FROM json_each(?)`, [JSON.stringify(seed.transactions.slice(cursor, end))]]);
  statements.push(["INSERT INTO metadata(key,value) VALUES('seed_cursor',?) ON CONFLICT(key) DO UPDATE SET value=MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER))", [String(end)]]);
  return {end, statements};
}

export async function seedStep(db) {
  const status = await seedStatus(db);
  if (status.ready) return status;
  const {end, statements} = seedBatch(status.loaded);
  await db.batch(statements.map(([sql, args]) => db.prepare(sql).bind(...args)));
  return {ready: end === seedTotal, loaded: end, total: seedTotal};
}
