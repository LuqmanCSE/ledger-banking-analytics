import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import audit from '../data/audit.json' with {type:'json'};
import {createDatabase} from '../scripts/database.mjs';
import {seedStep} from '../worker/bootstrap.js';
import {report,filters,parseCsv,validateRow,ingest,transactionList,exportCsv,toCsv} from '../worker/core.js';

let db;
before(async()=>{db=createDatabase();let s;do{s=await seedStep(db);}while(!s.ready);});
after(()=>db.close());
const all=()=>filters(new URLSearchParams());

test('source benchmark: balances, monthly activity and correct prior denominator',async()=>{
  const r=await report(db,all());
  assert.equal(r.snapshot.balance,audit.balance_minor);assert.equal(r.snapshot.clients,audit.customers);
  assert.equal(r.snapshot.inactive,audit.inactive_180);assert.equal(r.snapshot.pending_kyc,audit.pending_kyc);
  assert.equal(r.snapshot.negative_balances,audit.negative_balances);
  assert.equal(r.quality.total_transactions,audit.transactions);assert.equal(r.monthly.length,12);
  assert.equal(r.period.active,audit.july_active);assert.equal(r.period.previous_active,audit.june_active);
  assert.equal(r.period.returning,audit.july_returning);assert.equal(r.period.retention,audit.july_retention);
  assert.equal(r.monthly[0].retention,null);
  assert.equal(r.monthly.reduce((s,m)=>s+m.deposits,0),audit.deposits_minor);
  assert.equal(r.monthly.reduce((s,m)=>s+m.withdrawals,0),audit.withdrawals_minor);
});
test('retention respects branch/channel filters and month does not change snapshot balance',async()=>{
  const f=filters(new URLSearchParams({branch:'BR015',channel:'online',month:'2025-06'}));
  const r=await report(db,f);
  const expected=db.sqlite.prepare(`SELECT COUNT(DISTINCT t.customer_id) n FROM transactions t JOIN customers c USING(customer_id)
  WHERE c.branch_id='BR015' AND c.channel='online' AND substr(t.transaction_date,1,7)='2025-05'`).get().n;
  assert.equal(r.period.previous_active,expected);
  const other=await report(db,{...f,month:'2021-01'});
  assert.equal(other.snapshot.balance,r.snapshot.balance);
  assert.equal(r.period.retention,Math.round(100*r.period.returning/expected*100)/100);
});
test('CSV parser handles quotes, CRLF and BOM, rejects malformed or oversized input',()=>{
  const header='\uFEFFtransaction_id,customer_id,transaction_date,amount,transaction_type\r\n';
  const rows=parseCsv(header+'"ABC","CUST100000",2025-08-01,12.34,deposit\r\n');
  assert.equal(rows[0].amount,'12.34');
  assert.throws(()=>parseCsv(header+'"abc'),/Unclosed/);
  assert.throws(()=>parseCsv('wrong,headers\nx,y'),/headers/);
  assert.throws(()=>parseCsv('a'.repeat(1048577)),/1 MB/);
});
test('invalid dates, unknown clients, pre-opening dates and sign errors are rejected',()=>{
  const customer={account_open_date:'2022-01-01'},base={transaction_id:'TEST_1',customer_id:'CUST100000',transaction_date:'2025-08-01',amount:'12.34',transaction_type:'deposit'};
  assert.equal(validateRow(base,customer),null);
  assert.match(validateRow({...base,transaction_date:'2025-02-30'},customer),/valid/);
  assert.match(validateRow({...base,transaction_date:'2021-01-01'},customer),/opening/);
  assert.match(validateRow({...base,amount:'-5'},customer),/positive/);
  assert.match(validateRow({...base,amount:'0'},customer),/non-zero/);
  assert.match(validateRow(base,null),/Unknown/);
});
test('mixed upload persists accepted rows exactly once, updates balances, audits outcomes',async()=>{
  const old=db.sqlite.prepare("SELECT balance_minor FROM customers WHERE customer_id='CUST100000'").get().balance_minor;
  const row={transaction_id:'TEST_UPLOAD_01',customer_id:'CUST100000',transaction_date:'2025-08-01',amount:'12.34',transaction_type:'deposit'};
  const result=await ingest(db,[row,row,{...row,transaction_id:'TEST_BAD',customer_id:'UNKNOWN'}]);
  assert.equal(result.accepted,1);assert.equal(result.duplicates,1);assert.equal(result.rejected,1);
  assert.equal(db.sqlite.prepare("SELECT balance_minor FROM customers WHERE customer_id='CUST100000'").get().balance_minor,old+1234);
  assert.equal((await ingest(db,[row])).duplicates,1);
  const conflict=await ingest(db,[{...row,amount:'99'}]);assert.equal(conflict.rejected,1);
  const r=await report(db,all());assert.equal(r.quality.balance_mismatches,0);assert.equal(r.quality.total_transactions,audit.transactions+1);
});
test('duplicate-ID failure rolls the batch back, including balance triggers',async()=>{
  const old=db.sqlite.prepare("SELECT balance_minor FROM customers WHERE customer_id='CUST100000'").get().balance_minor;
  await assert.rejects(()=>db.batch([
    db.prepare("INSERT INTO transactions(transaction_id,customer_id,transaction_date,amount_minor,transaction_type,source) VALUES('ROLLBACK_1','CUST100000','2025-08-01',100,'deposit','upload')"),
    db.prepare("INSERT INTO transactions(transaction_id,customer_id,transaction_date,amount_minor,transaction_type,source) VALUES('ROLLBACK_1','CUST100000','2025-08-01',100,'deposit','upload')")
  ]));
  assert.equal(db.sqlite.prepare("SELECT balance_minor FROM customers WHERE customer_id='CUST100000'").get().balance_minor,old);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM transactions WHERE transaction_id='ROLLBACK_1'").get().n,0);
});
test('filtered transaction exports agree with ledger and monthly exports retain prior-month context',async()=>{
  const f=filters(new URLSearchParams({branch:'BR015',month:'2025-07',type:'withdrawal'}));
  const list=await transactionList(db,f);
  const csv=await exportCsv(db,f,'transactions');
  assert.equal(csv.split('\r\n').length-1,list.total);
  assert.ok(list.rows.every(r=>r.branch_id==='BR015'&&r.transaction_type==='withdrawal'&&r.transaction_date.startsWith('2025-07')));
  const monthly=await exportCsv(db,filters(new URLSearchParams({month:'2025-07'})),'monthly');assert.ok(monthly.endsWith('"' + audit.july_retention + '"'));
});
test('CSV output neutralizes spreadsheet formulas and preserves numeric negatives',()=>{
  const csv=toCsv(['a','b'],[['=HYPERLINK("x")','-123.45']]);assert.ok(csv.includes("'=HYPERLINK"));assert.ok(csv.includes('"-123.45"'));
});
test('filter whitelist rejects injection and invalid month values',()=>{
  assert.throws(()=>filters(new URLSearchParams({branch:"' OR 1=1--"})),/Invalid/);
  assert.throws(()=>filters(new URLSearchParams({month:'2025-99'})),/Invalid/);
});
test('seed is idempotent after completion and preserves added records',async()=>{
  const before=db.sqlite.prepare('SELECT COUNT(*) n FROM transactions').get().n;
  const result=await seedStep(db);assert.equal(result.ready,true);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM transactions').get().n,before);
});
