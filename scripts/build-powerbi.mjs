import {mkdir, writeFile} from 'node:fs/promises';
import {createDatabase} from './database.mjs';
import {seedStep} from '../worker/bootstrap.js';
import {report, filters} from '../worker/core.js';

const db = createDatabase();
let ledger;
try {
  while (!(await seedStep(db)).ready) { /* Load the generated baseline. */ }
  ledger = await report(db, filters(new URLSearchParams()));
} finally {
  db.close();
}

const root = new URL('../outputs/powerbi/', import.meta.url);
const schema = 'https://developer.microsoft.com/json-schemas/fabric/item/';
const page = '50a071c98dbb4c9c9200';
const reportDir = 'Ledger.Report/';
const modelDir = 'Ledger.SemanticModel/';
const definition = reportDir + 'definition/';
const pageDir = definition + 'pages/' + page + '/';

async function write(name, value) {
  const file = new URL(name, root);
  await mkdir(new URL('.', file), {recursive:true});
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

function table(name, columns, rows, measures) {
  const types = {string:'text', int64:'number', double:'number'};
  const fields = columns.map(([name, type]) => '#"' + name + '" = ' + types[type]).join(', ');
  const values = rows.map(row => '{' + row.map(value => JSON.stringify(value)).join(', ') + '}').join(',\n');
  const integerTypes = columns.filter(([,type]) => type === 'int64').map(([name]) => '{'+JSON.stringify(name)+', Int64.Type}');
  return {
    name,
    columns: columns.map(([name,dataType]) => ({name,dataType,sourceColumn:name,summarizeBy:'none'})),
    measures: measures.map(([name,expression,formatString]) => ({name,expression,formatString})),
    partitions: [{name,mode:'import',source:{type:'m',expression:[
      'let',
      '    Source = #table(type table [' + fields + '], {',
      values,
      '    }),',
      '    Typed = Table.TransformColumnTypes(Source, {' + integerTypes.join(', ') + '})',
      'in',
      '    Typed'
    ]}}]
  };
}

const money = '"₹"#,0;-"₹"#,0';
const monthly = table('Monthly activity', [
  ['Month','string'],['Deposits INR','double'],['Withdrawals INR','double'],
  ['Net flow INR','double'],['Active clients','int64'],['Prior active','int64'],['Returning','int64']
], ledger.monthly.map(row => [row.month,row.deposits/100,row.withdrawals/100,row.net/100,row.active,row.previous_active,row.returning]), [
  ['Deposits', 'SUM(\'Monthly activity\'[Deposits INR])', money],
  ['Withdrawals', 'SUM(\'Monthly activity\'[Withdrawals INR])', money],
  ['Net cash flow', 'SUM(\'Monthly activity\'[Net flow INR])', money],
  ['Active clients (month)', 'IF(HASONEVALUE(\'Monthly activity\'[Month]), SUM(\'Monthly activity\'[Active clients]))', '#,0'],
  ['Activity retention', 'IF(HASONEVALUE(\'Monthly activity\'[Month]), DIVIDE(SUM(\'Monthly activity\'[Returning]), SUM(\'Monthly activity\'[Prior active])))', '0.00%']
]);
const branch = table('Client snapshot', [
  ['Branch','string'],['Clients','int64'],['Balance INR','double']
], ledger.branches.map(row => [row.branch_id,row.clients,row.balance/100]), [
  ['Client balance','SUM(\'Client snapshot\'[Balance INR])',money],
  ['Client count','SUM(\'Client snapshot\'[Clients])','#,0']
]);

await write('Ledger.pbip', {
  $schema:'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
  version:'1.0',artifacts:[{report:{path:'Ledger.Report'}}],settings:{enableAutoRecovery:true}
});
for (const [folder,type,logicalId] of [
  [reportDir,'Report','31b7953b-1b45-49eb-9da0-70fdb85cab17'],
  [modelDir,'SemanticModel','571f5474-31d8-48a3-a8cf-5971cb20b1e6']
]) {
  await write(folder+'.platform', {
    $schema:'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
    metadata:{type,displayName:'Ledger',description:'Synthetic banking analytics baseline'},
    config:{version:'2.0',logicalId}
  });
}
await write(reportDir+'definition.pbir', {
  $schema:schema+'report/definitionProperties/2.0.0/schema.json',
  version:'4.0',datasetReference:{byPath:{path:'../Ledger.SemanticModel'}}
});
await write(modelDir+'definition.pbism', {version:'1.0',settings:{}});
await write(modelDir+'model.bim', {
  name:'Ledger',compatibilityLevel:1600,model:{
    culture:'en-US',sourceQueryCulture:'en-US',defaultPowerBIDataSourceVersion:'powerBI_V3',
    tables:[monthly,branch],
    annotations:[{name:'PBI_QueryOrder',value:JSON.stringify([monthly.name,branch.name])},{name:'__PBI_TimeIntelligenceEnabled',value:'0'}]
  }
});
await write(definition+'version.json', {$schema:schema+'report/definition/versionMetadata/1.0.0/schema.json',version:'2.0.0'});
await write(definition+'report.json', {
  $schema:schema+'report/definition/report/3.1.0/schema.json',
  themeCollection:{baseTheme:{name:'CY25SU12',reportVersionAtImport:{visual:'2.5.0',report:'3.1.0',page:'2.3.0'},type:'SharedResources'}},
  resourcePackages:[{name:'SharedResources',type:'SharedResources',items:[{name:'CY25SU12',path:'BaseThemes/CY25SU12.json',type:'BaseTheme'}]}]
});
await write(definition+'pages/pages.json', {
  $schema:schema+'report/definition/pagesMetadata/1.0.0/schema.json',pageOrder:[page],activePageName:page
});
await write(pageDir+'page.json', {
  $schema:schema+'report/definition/page/2.0.0/schema.json',
  name:page,displayName:'Ledger | Synthetic banking overview',displayOption:'FitToPage',width:1280,height:720
});

function field(table, name, kind='Measure') {
  return {field:{[kind]:{Expression:{SourceRef:{Entity:table}},Property:name}},queryRef:table+'.'+name,nativeQueryRef:name};
}
let visualCount = 0;
async function visual(visualType, title, x, y, width, height, roles, sort) {
  const z = ++visualCount * 1000;
  const name = z.toString(16).padStart(20,'0');
  const queryState = Object.fromEntries(Object.entries(roles).map(([role, projections]) => [role, {projections}]));
  const query = {queryState};
  if (sort) query.sortDefinition = {sort:[{field:sort.field,direction:'Ascending'}],isDefaultSort:true};
  await write(pageDir+'visuals/'+name+'/visual.json', {
    $schema:schema+'report/definition/visualContainer/2.0.0/schema.json',
    name,position:{x,y,z,height,width,tabOrder:z},
    visual:{visualType,query,visualContainerObjects:{title:[{properties:{
      show:{expr:{Literal:{Value:'true'}}},
      text:{expr:{Literal:{Value:"'"+title.replaceAll("'","''")+"'"}}}
    }}]}}
  });
}
const month = field(monthly.name,'Month','Column');
await visual('cardVisual','Total client balance · INR',24,20,380,105,{Data:[field(branch.name,'Client balance')]});
await visual('cardVisual','Total clients',420,20,300,105,{Data:[field(branch.name,'Client count')]});
await visual('cardVisual','12-month net cash flow · INR',736,20,520,105,{Data:[field(monthly.name,'Net cash flow')]});
await visual('lineChart','Monthly deposits and withdrawals · INR',24,145,700,300,{
  Category:[{...month,active:true}],Y:[field(monthly.name,'Deposits'),field(monthly.name,'Withdrawals')]
},month);
await visual('clusteredBarChart','Client balance by branch · INR',744,145,512,550,{
  Category:[{...field(branch.name,'Branch','Column'),active:true}],Y:[field(branch.name,'Client balance')]
});
await visual('lineChart','Month-to-month activity retention',24,465,700,230,{
  Category:[{...month,active:true}],Y:[field(monthly.name,'Activity retention')]
},month);
console.log('Generated outputs/powerbi/Ledger.pbip from the same SQL used by Ledger.');
