import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createDatabase} from '../scripts/database.mjs';
import {seedStep} from '../worker/bootstrap.js';
import worker from '../dist/server/index.js';
import audit from '../data/audit.json' with {type:'json'};
let db;
before(async()=>{db=createDatabase();let s;do{s=await seedStep(db);}while(!s.ready);});
after(()=>db.close());
const request=(path,options={})=>worker.fetch(new Request('http://localhost'+path,options),{DB:db});
test('HTTP report returns expected metrics and protects response types',async()=>{
  const response=await request('/api/dashboard');assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/json');
  assert.equal((await response.json()).period.retention,audit.july_retention);
  assert.ok((await request('/')).headers.get('content-security-policy').includes("default-src 'self'"));
});
test('HTTP writes reject cross-origin requests and wrong content type',async()=>{
  assert.equal((await request('/api/transactions',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await request('/api/transactions',{method:'POST',body:'{}'})).status,400);
});
test('HTTP CSV upload and retry are idempotent and the downloadable CSV contains the record',async()=>{
  const csv='transaction_id,customer_id,transaction_date,amount,transaction_type\nHTTP_TEST,CUST100000,2025-08-01,1.25,deposit';
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv})};
  const first=await request('/api/transactions',options);assert.equal(first.status,200);assert.equal((await first.json()).accepted,1);
  assert.equal((await (await request('/api/transactions',options)).json()).duplicates,1);
  const exportResponse=await request('/api/export?kind=transactions&source=upload');
  assert.ok(exportResponse.headers.get('content-disposition').includes('attachment'));
  assert.match(await exportResponse.text(),/HTTP_TEST/);
});
test('HTTP simulator produces labelled records and leaves ledger reconciled',async()=>{
  const r=await request('/api/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"count":3}'});
  assert.equal((await r.json()).accepted,3);
  const rows=(await (await request('/api/transactions?source=simulated')).json()).rows;
  assert.equal(rows.length,3);assert.ok(rows.every(r=>r.source==='simulated'&&r.transaction_date==='2025-08-01'));
  const quality=(await (await request('/api/dashboard')).json()).quality;
  assert.equal(quality.balance_mismatches,0);
});
test('public validation classifies rows without mutating the ledger or its audit history',async()=>{
  const fetchPublic = (path, options) => worker.fetch(new Request('http://localhost'+path, options),{DB:db,PUBLIC_DEMO:'1'});
  const csv='transaction_id,customer_id,transaction_date,amount,transaction_type\nPREVIEW_TEST,CUST100000,2025-08-01,1.25,deposit\nPREVIEW_BAD,UNKNOWN,2025-08-01,10,deposit';
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv})};
  for (const path of ['/api/transactions','/api/simulate','/api/setup']) {
    assert.equal((await fetchPublic(path,options)).status,403);
  }
  const before = db.sqlite.prepare('SELECT COUNT(*) count FROM ingestion_runs').get().count;
  const result = await (await fetchPublic('/api/validate',options)).json();
  assert.equal(result.preview,true);
  assert.equal(result.accepted,1);
  assert.equal(result.rejected,1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) count FROM transactions WHERE transaction_id='PREVIEW_TEST'").get().count,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) count FROM ingestion_runs').get().count,before);
});
test('Power BI availability matches the build and the download uses its real format',async()=>{
  const reportDirectory = new URL('../reports/',import.meta.url);
  const expectedFormat = existsSync(new URL('Ledger.pbix',reportDirectory)) ? 'pbix' :
    existsSync(new URL('Ledger.pbip.zip',reportDirectory)) ? 'pbip' : null;
  const status = await (await request('/api/powerbi')).json();
  const download = await request('/api/powerbi/download');
  assert.equal(status.available,Boolean(expectedFormat));
  if (expectedFormat) {
    assert.equal(status.format,expectedFormat);
    assert.equal(status.as_of,audit.as_of);
    assert.equal(download.status,200);
    assert.match(download.headers.get('content-disposition'),/attachment; filename="Ledger\.(pbix|pbip\.zip)"/);
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0,4).toString('hex'),'504b0304');
  } else {
    assert.equal(download.status,404);
  }
  const script=await request('/api/powerquery');assert.match(await script.text(),/Csv.Document/);
});
