import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const notices=[];
for(const pkg of ['echarts','zrender','esbuild'])notices.push(pkg+'\n'+await readFile(path.join(root,'node_modules',pkg,pkg==='esbuild'?'LICENSE.md':'LICENSE'),'utf8'));
await writeFile(path.join(root,'reports/THIRD_PARTY_NOTICES.txt'),notices.join('\n\n--------------------\n\n'));
await mkdir(path.join(root,'dist/server'),{recursive:true});
await mkdir(path.join(root,'dist/.openai'),{recursive:true});
const reportFiles = [
  {file:'Ledger.pbix', format:'pbix', mime:'application/octet-stream'},
  {file:'Ledger.pbip.zip', format:'pbip', mime:'application/zip'}
];
let reportArtifact = null;
for (const candidate of reportFiles) {
  try {
    const bytes = await readFile(path.join(root,'reports',candidate.file));
    if (bytes.subarray(0,4).toString('hex') !== '504b0304') {
      throw new Error(candidate.file + ' is not a ZIP container.');
    }
    if (candidate.format === 'pbix' && !bytes.includes(Buffer.from('DataModel'))) {
      throw new Error('Ledger.pbix must be a Power BI Desktop report with an imported data model.');
    }
    reportArtifact = {...candidate, bytes};
    break;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await build({entryPoints:[path.join(root,'worker/index.js')],outfile:path.join(root,'dist/server/index.js'),bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,
  loader:{'.html':'text','.css':'text','.m':'text','.txt':'text'},plugins:[{
    name:'ledger-assets',setup(b){
      b.onLoad({filter:/(?:public[\\/]app\.js|echarts\.min\.js)$/},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));
      b.onResolve({filter:/^ledger:powerbi/},args=>({path:args.path,namespace:'ledger-artifact'}));
      b.onLoad({filter:/^ledger:powerbi$/,namespace:'ledger-artifact'},()=>{
        if (!reportArtifact) return {contents:'export default null;'};
        const {bytes,...metadata}=reportArtifact;
        return {contents:'import bytes from "ledger:powerbi-bytes"; export default {...'+JSON.stringify(metadata)+', bytes};'};
      });
      b.onLoad({filter:/^ledger:powerbi-bytes$/,namespace:'ledger-artifact'},()=>({contents:reportArtifact.bytes,loader:'binary'}));
    }
  }]});
try {
  await copyFile(path.join(root,'.openai/hosting.json'),path.join(root,'dist/.openai/hosting.json'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
console.log('Built Worker:',(await stat(path.join(root,'dist/server/index.js'))).size,'bytes');
