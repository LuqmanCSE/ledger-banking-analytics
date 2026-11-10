export const FIELDS = ['transaction_id','customer_id','transaction_date','amount','transaction_type'];

export function filters(params) {
  const f = {};
  for (const k of ['branch','channel','account','month','source','type']) f[k] = params.get(k) || '';
  if (f.branch && !/^BR\d{3}$/.test(f.branch)) throw new Error('Invalid branch filter.');
  if (f.channel && !['online','branch'].includes(f.channel)) throw new Error('Invalid channel filter.');
  if (f.account && !['savings','current'].includes(f.account)) throw new Error('Invalid account filter.');
  if (f.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(f.month)) throw new Error('Invalid month filter.');
  if (f.source && !['baseline','upload','simulated'].includes(f.source)) throw new Error('Invalid source filter.');
  if (f.type && !['deposit','withdrawal'].includes(f.type)) throw new Error('Invalid transaction type.');
  return f;
}

export function segment(f) {
  const clauses = [], args = [];
  for (const [k, col] of [['branch','branch_id'],['channel','channel'],['account','account_type']]) {
    if (f[k]) { clauses.push(`c.${col}=?`); args.push(f[k]); }
  }
  return { where:clauses.length ? clauses.join(' AND ') : '1=1', args };
}

export const MONTHLY_SQL = (where) => `
WITH RECURSIVE months(month) AS (
  SELECT substr(MIN(transaction_date),1,7) FROM transactions HAVING COUNT(*)>0
  UNION ALL
  SELECT strftime('%Y-%m',date(month||'-01','+1 month')) FROM months
  WHERE month < (SELECT substr(MAX(transaction_date),1,7) FROM transactions)
), filtered AS (
  SELECT t.* FROM transactions t JOIN customers c USING(customer_id) WHERE ${where}
), active AS (
  SELECT DISTINCT customer_id,substr(transaction_date,1,7) month FROM filtered
), counts AS (SELECT month,COUNT(*) active FROM active GROUP BY month),
overlap AS (
  SELECT a.month,COUNT(*) retained FROM active a JOIN active p
  ON a.customer_id=p.customer_id AND p.month=strftime('%Y-%m',date(a.month||'-01','-1 month'))
  GROUP BY a.month
), flows AS (
  SELECT substr(transaction_date,1,7) month,
  SUM(CASE WHEN amount_minor>0 THEN amount_minor ELSE 0 END) deposits,
  -SUM(CASE WHEN amount_minor<0 THEN amount_minor ELSE 0 END) withdrawals,
  SUM(amount_minor) net,COUNT(*) transactions FROM filtered GROUP BY month
)
SELECT m.month,COALESCE(f.deposits,0) deposits,COALESCE(f.withdrawals,0) withdrawals,
COALESCE(f.net,0) net,COALESCE(f.transactions,0) transactions,
COALESCE(n.active,0) active,COALESCE(p.active,0) previous_active,
COALESCE(o.retained,0) AS "returning",
CASE WHEN COALESCE(p.active,0)=0 THEN NULL
ELSE ROUND(100.0*COALESCE(o.retained,0)/p.active,2) END retention
FROM months m LEFT JOIN flows f ON f.month=m.month LEFT JOIN counts n ON n.month=m.month
LEFT JOIN counts p ON p.month=strftime('%Y-%m',date(m.month||'-01','-1 month'))
LEFT JOIN overlap o ON o.month=m.month ORDER BY m.month`;

export async function report(db, f) {
  const {where,args} = segment(f);
  const statements = [
    db.prepare(`SELECT COUNT(*) clients,COALESCE(SUM(c.balance_minor),0) balance,
      COALESCE(SUM(c.kyc_status='pending'),0) pending_kyc,
      COALESCE(SUM(c.balance_minor<0),0) negative_balances,
      COALESCE(SUM(julianday((SELECT MAX(transaction_date) FROM transactions))-julianday(c.last_txn_date)>=180),0) inactive,
      (SELECT MAX(transaction_date) FROM transactions) as_of,
      (SELECT MAX(received_at) FROM transactions WHERE source<>'baseline') last_received,
      (SELECT COUNT(*) FROM transactions WHERE source='simulated') simulated,
      (SELECT COUNT(*) FROM transactions WHERE source='upload') uploaded
      FROM customers c WHERE ${where}`).bind(...args),
    db.prepare(MONTHLY_SQL(where)).bind(...args),
    db.prepare(`SELECT c.branch_id,COUNT(*) clients,SUM(c.balance_minor) balance,
      ROUND(100.0*SUM(c.balance_minor)/NULLIF(SUM(SUM(c.balance_minor)) OVER(),0),2) share
      FROM customers c WHERE ${where} GROUP BY c.branch_id ORDER BY balance DESC`).bind(...args),
    db.prepare(`SELECT c.channel,COUNT(*) clients,SUM(c.balance_minor) balance FROM customers c WHERE ${where} GROUP BY c.channel`).bind(...args),
    db.prepare(`SELECT (SELECT COUNT(*) FROM transactions) total_transactions,
      (SELECT COUNT(*) FROM transactions t LEFT JOIN customers c USING(customer_id) WHERE c.customer_id IS NULL) orphans,
      (SELECT COUNT(*) FROM customers c WHERE c.balance_minor<>c.initial_minor+COALESCE((SELECT SUM(t.amount_minor) FROM transactions t WHERE t.customer_id=c.customer_id),0)) balance_mismatches,
      (SELECT COUNT(*) FROM transactions t JOIN customers c USING(customer_id) WHERE t.transaction_date<c.account_open_date) before_open,
      (SELECT COUNT(*) FROM transactions WHERE (amount_minor>0 AND transaction_type<>'deposit') OR (amount_minor<0 AND transaction_type<>'withdrawal')) sign_mismatches`),
    db.prepare('SELECT * FROM ingestion_runs ORDER BY created_at DESC,id DESC LIMIT 8'),
    db.prepare('SELECT DISTINCT branch_id FROM customers ORDER BY branch_id'),
  ];
  const results = await db.batch(statements);
  const monthly = results[1].results;
  const month = f.month || monthly.at(-1)?.month || '2025-07';
  return { snapshot:results[0].results[0], monthly, selected_month:month,
    period:monthly.find(r=>r.month===month) || {month,deposits:0,withdrawals:0,net:0,active:0,previous_active:0,returning:0,retention:null,transactions:0},
    branches:results[2].results, channels:results[3].results,
    quality:results[4].results[0], runs:results[5].results,
    branch_options:results[6].results.map(r=>r.branch_id), fetched_at:new Date().toISOString(), filters:f };
}

export function transactionWhere(f) {
  const s = segment(f), clauses=[s.where], args=[...s.args];
  if(f.month) {clauses.push("substr(t.transaction_date,1,7)=?");args.push(f.month);}
  if(f.source) {clauses.push('t.source=?');args.push(f.source);}
  if(f.type) {clauses.push('t.transaction_type=?');args.push(f.type);}
  return {where:clauses.join(' AND '),args};
}

export async function transactionList(db,f,page=1) {
  const {where,args}=transactionWhere(f);
  const n=Math.max(1,Math.min(10000,Number.parseInt(page,10)||1));
  const r=await db.batch([
    db.prepare(`SELECT COUNT(*) total FROM transactions t JOIN customers c USING(customer_id) WHERE ${where}`).bind(...args),
    db.prepare(`SELECT t.transaction_id,t.customer_id,t.transaction_date,t.amount_minor,t.transaction_type,t.source,c.branch_id
      FROM transactions t JOIN customers c USING(customer_id) WHERE ${where}
      ORDER BY t.transaction_date DESC,t.received_at DESC,t.transaction_id DESC LIMIT 20 OFFSET ?`).bind(...args,(n-1)*20)
  ]);
  return {total:r[0].results[0].total,page:n,rows:r[1].results};
}

export function parseCsv(text) {
  if(typeof text!=='string'||new TextEncoder().encode(text).length>1048576) throw new Error('CSV must be under 1 MB.');
  const rows=[]; let row=[],field='',quoted=false,closed=false;
  text=text.replace(/^\uFEFF/,'');
  for(let i=0;i<text.length;i++) {
    const ch=text[i];
    if(quoted) { if(ch==='"') {if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}} else field+=ch; }
    else if(ch==='"') {if(field||closed) throw new Error('Malformed CSV quoting.');quoted=true;}
    else if(ch===','){row.push(field);field='';closed=false;}
    else if(ch==='\n'||ch==='\r') {if(ch==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field='';closed=false;}
    else {if(closed)throw new Error('Unexpected text after a quoted CSV field.');field+=ch;}
    if(field.length>500)throw new Error('A CSV field exceeds 500 characters.');
    if(rows.length>501)throw new Error('Upload at most 500 transaction rows at a time.');
  }
  if(quoted)throw new Error('Unclosed CSV quote.');
  row.push(field);if(row.some(v=>v.trim()))rows.push(row);
  if(!rows.length)throw new Error('The CSV is empty.');
  const headers=rows.shift().map(x=>x.trim());
  if(headers.length!==FIELDS.length||new Set(headers).size!==FIELDS.length||FIELDS.some(k=>!headers.includes(k)))throw new Error('CSV headers must be: '+FIELDS.join(', '));
  if(!rows.length||rows.length>500)throw new Error('Provide 1–500 transaction rows.');
  return rows.map((r,i)=>{
    if(r.length!==headers.length)throw new Error(`CSV row ${i+2} has ${r.length} columns; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((k,j)=>[k,r[j].trim()]));
  });
}

export function validateRow(row,customer) {
  if(!row||typeof row!=='object')return 'Expected a transaction object.';
  for(const k of ['transaction_id','customer_id']) if(!/^[A-Za-z0-9_-]{1,64}$/.test(String(row[k]||'')))return `Invalid ${k}; use 1–64 letters, numbers, underscores or hyphens.`;
  if(!customer)return 'Unknown customer ID.';
  const date=String(row.transaction_date||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)return 'Date must be a valid YYYY-MM-DD date.';
  if(date<customer.account_open_date)return 'Transaction is before account opening.';
  if(date<'2021-01-01'||date>new Date().toISOString().slice(0,10))return 'Date must be between 2021-01-01 and today.';
  const amount=String(row.amount??'');
  if(!/^-?\d{1,9}(\.\d{1,2})?$/.test(amount)||Number(amount)===0)return 'Amount must be non-zero with at most two decimal places (maximum 999,999,999.99).';
  const minor=Math.round(Number(amount)*100);
  if(!['deposit','withdrawal'].includes(row.transaction_type))return 'Type must be deposit or withdrawal.';
  if((minor>0)!==(row.transaction_type==='deposit'))return 'Deposits must be positive; withdrawals must be negative.';
  return null;
}

export async function ingest(db, rows, source='upload', {preview=false}={}) {
  if(!Array.isArray(rows)||!rows.length||rows.length>500)throw new Error('Provide 1–500 transaction rows.');
  const customerRows=await db.prepare('SELECT customer_id,account_open_date FROM customers').all();
  const customers=new Map(customerRows.results.map(r=>[r.customer_id,r]));
  const existing=await db.prepare('SELECT transaction_id,customer_id,transaction_date,amount_minor,transaction_type FROM transactions WHERE transaction_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(rows.map(r=>String(r?.transaction_id||'')))).all();
  const ids=new Map(existing.results.map(r=>[r.transaction_id,r]));
  const valid=[],errors=[];let duplicates=0;
  for(let i=0;i<rows.length;i++) {
    const r=rows[i],reason=validateRow(r,customers.get(r?.customer_id));
    if(reason){errors.push({row:i+2,transaction_id:String(r?.transaction_id||'').slice(0,64),reason});continue;}
    const canonical={transaction_id:r.transaction_id,customer_id:r.customer_id,transaction_date:r.transaction_date,amount_minor:Math.round(Number(r.amount)*100),transaction_type:r.transaction_type};
    if(ids.has(r.transaction_id)) {
      const old=ids.get(r.transaction_id);
      if(['customer_id','transaction_date','amount_minor','transaction_type'].every(k=>old[k]===canonical[k]))duplicates++;
      else errors.push({row:i+2,transaction_id:r.transaction_id,reason:'Transaction ID exists with different data.'});
      continue;
    }
    ids.set(r.transaction_id,canonical);
    valid.push([canonical.transaction_id,canonical.customer_id,canonical.transaction_date,canonical.amount_minor,canonical.transaction_type,source]);
  }
  const outcome = {accepted: valid.length, rejected: errors.length, duplicates, errors};
  if (preview) return {...outcome, preview: true};
  const runId=crypto.randomUUID();
  // A single transactional batch persists accepted rows, trigger-updated balances, and the audit log.
  // Concurrent duplicate IDs fail the whole batch; callers may safely retry the same IDs.
  const statements=[];
  if(valid.length)statements.push(db.prepare(`INSERT INTO transactions(transaction_id,customer_id,transaction_date,amount_minor,transaction_type,source)
    SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]'),json_extract(value,'$[5]') FROM json_each(?)`).bind(JSON.stringify(valid)));
  statements.push(db.prepare('INSERT INTO ingestion_runs(id,source,accepted,rejected,duplicates) VALUES(?,?,?,?,?)').bind(runId,source,valid.length,errors.length,duplicates));
  await db.batch(statements);
  return {id:runId,...outcome};
}

export function csvCell(value) {
  let s=String(value??'');
  if(/^[=+@\t\r]/.test(s)||(/^\s*-/.test(s)&&!/^[-]?\d+(\.\d+)?$/.test(s)))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
}
export function toCsv(headers,rows) {return '\uFEFF'+[headers,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n');}

export async function exportCsv(db,f,kind) {
  if(kind==='transactions') {
    const {where,args}=transactionWhere(f);
    const r=await db.prepare(`SELECT t.*,c.branch_id FROM transactions t JOIN customers c USING(customer_id) WHERE ${where} ORDER BY t.transaction_date,t.transaction_id LIMIT 100001`).bind(...args).all();
    if(r.results.length>100000)throw new Error('Export exceeds 100,000 rows. Narrow the filters.');
    return toCsv([...FIELDS,'branch_id','source'],r.results.map(t=>[t.transaction_id,t.customer_id,t.transaction_date,(t.amount_minor/100).toFixed(2),t.transaction_type,t.branch_id,t.source]));
  }
  if(kind==='customers') {
    const {where,args}=segment(f);
    const r=await db.prepare(`SELECT c.* FROM customers c WHERE ${where} ORDER BY customer_id`).bind(...args).all();
    const cols=['customer_id','branch_id','age','gender','income_bracket','channel','account_type','kyc_status','account_open_date','initial_deposit','current_balance','last_txn_date'];
    return toCsv(cols,r.results.map(c=>[c.customer_id,c.branch_id,c.age,c.gender,c.income_bracket,c.channel,c.account_type,c.kyc_status,c.account_open_date,(c.initial_minor/100).toFixed(2),(c.balance_minor/100).toFixed(2),c.last_txn_date]));
  }
  if(kind==='monthly') {
    const {where,args}=segment(f);const r=await db.prepare(MONTHLY_SQL(where)).bind(...args).all();
    const rows=f.month?r.results.filter(m=>m.month===f.month):r.results;
    return toCsv(['month','deposits','withdrawals','net_flow','transaction_count','active_clients','prior_month_active','returning_clients','retention_pct'],rows.map(m=>[m.month,(m.deposits/100).toFixed(2),(m.withdrawals/100).toFixed(2),(m.net/100).toFixed(2),m.transactions,m.active,m.previous_active,m.returning,m.retention]));
  }
  throw new Error('Unknown export type.');
}
