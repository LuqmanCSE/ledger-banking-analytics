import html from '../public/index.html';
import styles from '../public/styles.css';
import client from '../public/app.js';
import echarts from '../node_modules/echarts/dist/echarts.min.js';
import powerQuery from '../reports/PowerQuery.m';
import notices from '../reports/THIRD_PARTY_NOTICES.txt';
import audit from '../data/audit.json' with {type:'json'};
import powerBiReport from 'ledger:powerbi';
import {filters,report,transactionList,parseCsv,ingest,exportCsv,toCsv} from './core.js';
import {seedStatus,seedStep} from './bootstrap.js';

const headers={'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json'}});
const asset=(body,type)=>new Response(body,{headers:{...headers,'Content-Type':type,'Cache-Control':'no-cache'}});
const sampleCsv = toCsv(['transaction_id','customer_id','transaction_date','amount','transaction_type'],[
  ['DEMO_UPLOAD_001','CUST100000','2025-08-01','2500.25','deposit'],
  ['DEMO_UPLOAD_002','CUST100001','2025-08-01','-750.00','withdrawal'],
  ['DEMO_REJECT_001','UNKNOWN_CLIENT','2025-08-01','100.00','deposit'],
  ['DEMO_REJECT_002','CUST100000','2025-02-30','100.00','deposit']
]);

async function body(request) {
  if(!request.headers.get('content-type')?.includes('application/json'))throw new Error('Send application/json.');
  if(Number(request.headers.get('content-length')||0)>1200000)throw new Error('Request exceeds the 1 MB upload limit.');
  const reader=request.body?.getReader();let size=0;const chunks=[];
  if(!reader)throw new Error('Missing request body.');
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1200000){await reader.cancel();throw new Error('Request exceeds the 1 MB upload limit.');}chunks.push(value);}
  const merged=new Uint8Array(size);let offset=0;for(const x of chunks){merged.set(x,offset);offset+=x.length;}
  return JSON.parse(new TextDecoder().decode(merged));
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url),path=url.pathname;
    try {
      if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed.'},405);
      if(request.method==='POST') {
        const origin=request.headers.get('origin');
        if(origin&&origin!==url.origin)return json({error:'Cross-origin writes are not allowed.'},403);
      }
      if(path==='/'&&request.method==='GET')return asset(html,'text/html; charset=utf-8');
      if(path==='/styles.css')return asset(styles,'text/css; charset=utf-8');
      if(path==='/app.js')return asset(client,'text/javascript; charset=utf-8');
      if(path==='/echarts.js')return asset(echarts,'text/javascript; charset=utf-8');
      if(path==='/notices.txt')return asset(notices,'text/plain; charset=utf-8');
      if(!path.startsWith('/api/'))return json({error:'Not found.'},404);
      if(!env.DB)return json({error:'Reporting database is not configured.'},503);
      const db=env.DB;
      const publicDemo = env.PUBLIC_DEMO === '1';
      if (publicDemo && request.method === 'POST' && path !== '/api/validate') {
        return json({error:'The public ledger accepts validation previews only.'},403);
      }
      if(path==='/api/setup'&&request.method==='POST')return json(await seedStep(db));
      const state = await seedStatus(db);
      if(path==='/api/status') {
        return json({...state, public_demo: publicDemo});
      }
      if(!state.ready)return json({error:'Initialize the synthetic dataset first.'},409);
      const f=filters(url.searchParams);
      if(path==='/api/dashboard'&&request.method==='GET')return json(await report(db,f));
      if(path==='/api/transactions'&&request.method==='GET')return json(await transactionList(db,f,url.searchParams.get('page')));
      if (path === '/api/validate' && request.method === 'POST') {
        const data = await body(request);
        return json(await ingest(db, parseCsv(data.csv), 'upload', {preview:true}));
      }
      if(path==='/api/transactions'&&request.method==='POST') {
        const data=await body(request);
        const result=await ingest(db,data.csv!==undefined?parseCsv(data.csv):data.transactions,'upload');
        return json(result);
      }
      if(path==='/api/simulate'&&request.method==='POST') {
        const data=await body(request);const count=Math.min(10,Math.max(1,Number.parseInt(data.count,10)||3));
        const {results:customers}=await db.prepare('SELECT customer_id FROM customers ORDER BY customer_id').all();
        // One fixed next-day demo clock avoids misleading advancement into real time.
        const date='2025-08-01';
        const rows=Array.from({length:count},()=>{const deposit=Math.random()>.4;return {
          transaction_id:'SIM_'+crypto.randomUUID(),customer_id:customers[Math.floor(Math.random()*customers.length)].customer_id,
          transaction_date:date,amount:String((deposit?1:-1)*(100+Math.floor(Math.random()*9900))),transaction_type:deposit?'deposit':'withdrawal'};});
        return json(await ingest(db,rows,'simulated'));
      }
      if(path==='/api/audit')return json(audit);
      if(path==='/api/export') {
        const kind=url.searchParams.get('kind')||'transactions';
        const csv=await exportCsv(db,f,kind);
        return new Response(csv,{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="ledger-${kind}-${f.month||'all-periods'}.csv"`}});
      }
      if(path==='/api/template') {
        const csv=toCsv(['transaction_id','customer_id','transaction_date','amount','transaction_type'],[['UPLOAD_EXAMPLE_001','CUST100000','2025-08-01','2500.00','deposit'],['UPLOAD_EXAMPLE_002','CUST100001','2025-08-01','-750.00','withdrawal']]);
        return new Response(csv,{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="transaction-template.csv"'}});
      }
      if(path==='/api/sample')return asset(sampleCsv,'text/csv; charset=utf-8');
      if(path==='/api/powerquery')return new Response(powerQuery,{headers:{...headers,'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="Ledger-PowerQuery.m"'}});
      if(path==='/api/powerbi')return json(powerBiReport ?
        {available:true,format:powerBiReport.format,filename:powerBiReport.file,as_of:audit.as_of} :
        {available:false,message:'Reporting CSVs and the Power Query connection script are available.'});
      if(path==='/api/powerbi/download'&&request.method==='GET') {
        if (!powerBiReport) return json({error:'Power BI artifact unavailable.'},404);
        return new Response(powerBiReport.bytes,{headers:{...headers,
          'Content-Type':powerBiReport.mime,'Content-Disposition':`attachment; filename="${powerBiReport.file}"`}});
      }
      return json({error:'Not found.'},404);
    } catch(error) {
      const message=String(error.message||error);
      console.error('Request failed:',path,message);
      if(/UNIQUE constraint/.test(message))return json({error:'A concurrent request used the same transaction ID. No rows from this batch were committed. Retry the same upload.'},409);
      if(/SQLITE|D1_|no such|constraint|database|syntax error/i.test(message))return json({error:'The database operation failed. Your batch was not partially committed. Please retry.'},500);
      return json({error:message.slice(0,250)},400);
    }
  }
};
