import http from 'node:http';
import {mkdirSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase} from './database.mjs';
import {datasetVersion} from '../worker/bootstrap.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
mkdirSync(path.join(root,'.local'),{recursive:true});
const databaseName = datasetVersion + '.sqlite';
const db=createDatabase(path.join(root,'.local',databaseName));
const port=Number(process.env.PORT||8787);
let buildTime=0,worker;
async function currentWorker(){const stamp=statSync(path.join(root,'dist/server/index.js')).mtimeMs;if(stamp!==buildTime){worker=(await import('../dist/server/index.js?build='+stamp)).default;buildTime=stamp;}return worker;}
const server=http.createServer(async(req,res)=>{
  try {
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>1200000){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Request exceeds upload limit.'}));return;}chunks.push(chunk);}
    const url='http://'+(req.headers.host||'127.0.0.1:'+port)+req.url;
    const request=new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});
    const response=await (await currentWorker()).fetch(request,{DB:db,PUBLIC_DEMO:process.env.PUBLIC_DEMO});
    res.writeHead(response.status,Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){console.error(e);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Local server failed.'}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`Ledger local preview: http://127.0.0.1:${port}\nPersistent database: .local/${databaseName}\nCtrl+C stops the server.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
