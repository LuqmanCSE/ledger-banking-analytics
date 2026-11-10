import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

// Minimal D1-compatible adapter so local and hosted versions use identical SQL.
export function createDatabase(filename=':memory:') {
  const sqlite=new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  if(!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customers'").get()) {
    sqlite.exec(readFileSync(new URL('../drizzle/0000_ledger.sql',import.meta.url),'utf8'));
  }
  const wrap=(sql,args=[])=>({
    bind(...values){return wrap(sql,values);},
    async all(){return {success:true,results:sqlite.prepare(sql).all(...args)};},
    async first(column){const row=sqlite.prepare(sql).get(...args)||null;return column&&row?row[column]:row;},
    async run(){const result=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};},
    _sql:sql,_args:args
  });
  return {prepare:wrap,async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>{const p=sqlite.prepare(s._sql);if(p.columns().length)return {success:true,results:p.all(...s._args)};const r=p.run(...s._args);return {success:true,results:[],meta:{changes:Number(r.changes)}};});sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}},close(){sqlite.close();},sqlite};
}
