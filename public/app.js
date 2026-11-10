'use strict';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=new Intl.NumberFormat('en-IN');
const money=minor=>'₹'+new Intl.NumberFormat('en-IN',{maximumFractionDigits:2}).format(minor/100);
const compact=minor=>'₹'+new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(minor/100);
const monthName=m=>new Date(m+'-02T00:00:00Z').toLocaleDateString('en-GB',{month:'short',year:'numeric',timeZone:'UTC'});
const dateName=d=>d?new Date(d+'T00:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'—';
const state={publicDemo:false,view:'overview',report:null,page:1,total:0,charts:{},csv:null,live:false,liveTimer:null,pollTimer:null,busy:false,request:0};
const titles={overview:['Overview','Banking overview','Explore client balances, cash movement, and engagement across your reporting ledger.'],transactions:['Transactions','Transaction ledger','Review individual records by branch, month, source, and transaction type.'],quality:['Data & quality','Data quality','Import transactions, review validation results, and track reporting health.'],reports:['Report center','Report center','Export reporting data for further analysis or use it in Power BI.']};
async function api(path,options={}){const response=await fetch(path,options);let data;try{data=await response.json();}catch{throw new Error('The server returned an unexpected response.');}if(!response.ok)throw new Error(data.error||'The request failed.');return data;}
const post=(path,data={})=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
function params({allMonths=false,transaction=false}={}){const p=new URLSearchParams();for(const k of ['branch','channel','account','month']){const value=$('filter-'+k).value;if(value&&!(k==='month'&&allMonths))p.set(k,value);}if(transaction&&!allMonths&&!p.has('month')&&state.report)p.set('month',state.report.selected_month);if(transaction&&state.view==='transactions'){if($('transaction-source').value)p.set('source',$('transaction-source').value);if($('transaction-type').value)p.set('type',$('transaction-type').value);}return p;}
let toastTimer;
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function error(text){$('error-banner').textContent=text;$('error-banner').hidden=!text;}
async function download(kind,{allMonths=kind==='monthly',transaction=kind==='transactions'}={}){try{const p=params({allMonths,transaction});p.set('kind',kind);const response=await fetch('/api/export?'+p);if(!response.ok){const data=await response.json();throw new Error(data.error||'Export failed.');}const blob=await response.blob(),a=document.createElement('a'),u=URL.createObjectURL(blob);a.href=u;a.download='ledger-'+kind+'-'+(p.get('month')||'all-periods')+'.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),1000);toast('Your CSV export is ready.');}catch(e){error(e.message);}}
function setView(view){if(!titles[view])return;state.view=view;document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!=='view-'+view);document.querySelectorAll('[data-view]').forEach(el=>{el.classList.toggle('active',el.dataset.view===view);el.setAttribute('aria-current',el.dataset.view===view?'page':'false');});$('breadcrumb-current').textContent=titles[view][0];$('page-title').textContent=titles[view][1];$('page-subtitle').textContent=titles[view][2];if(view==='transactions')loadTransactions();if(view==='overview')requestAnimationFrame(()=>Object.values(state.charts).forEach(c=>c.resize()));history.replaceState(null,'','#'+view);}
function chart(id){if(!window.echarts)return null;if(!state.charts[id])state.charts[id]=echarts.init($(id),null,{renderer:'svg'});return state.charts[id];}
function drawCharts(r) {
  if (!window.echarts) {
    error('The chart library could not load. Reporting data and exports remain available.');
    return;
  }

  const selected = r.monthly.findIndex(row => row.month === r.selected_month);
  const end = selected < 0 ? r.monthly.length : selected + 1;
  const months = r.monthly.slice(Math.max(0, end - 12), end);
  const blue = '#187aba';
  const gray = '#646e7a';
  const animationDuration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250;
  const textStyle = {fontFamily: 'Segoe UI, Arial, sans-serif'};
  const axisLabel = {fontSize: 10, color: '#535961'};
  const splitLine = {lineStyle: {color: '#e4e6e9'}};
  const valueFormatter = value => compact(value);

  chart('flow-chart').setOption({
    animationDuration, textStyle,
    tooltip: {trigger: 'axis', valueFormatter},
    grid: {left: 61, right: 22, top: 22, bottom: 38},
    xAxis: {
      type: 'category', boundaryGap: false, data: months.map(row => monthName(row.month)),
      axisLine: {lineStyle: {color: '#b9bec4'}}, axisTick: {show: false},
      axisLabel: {...axisLabel, formatter: label => label.replace(' ', '\n')}
    },
    yAxis: {type: 'value', axisLabel: {...axisLabel, formatter: valueFormatter}, splitLine},
    series: [
      {name: 'Deposits', type: 'line', showSymbol: false, data: months.map(row => row.deposits), lineStyle: {width: 2.5, color: blue}, itemStyle: {color: blue}},
      {name: 'Withdrawals', type: 'line', showSymbol: false, data: months.map(row => row.withdrawals), lineStyle: {width: 2, color: gray, type: 'dashed'}, itemStyle: {color: gray}}
    ]
  }, true);
  $('chart-period').textContent = months.length ? monthName(months[0].month) + ' – ' + monthName(months.at(-1).month) : 'No activity';

  const branches = r.branches.slice(0, 5).reverse();
  chart('branch-chart').setOption({
    animationDuration, textStyle,
    tooltip: {trigger: 'axis', axisPointer: {type: 'shadow'}, valueFormatter},
    grid: {left: 62, right: 70, top: 24, bottom: 32},
    xAxis: {type: 'value', axisLabel: {...axisLabel, formatter: valueFormatter}, splitLine},
    yAxis: {type: 'category', data: branches.map(row => row.branch_id), axisLabel, axisTick: {show: false}, axisLine: {show: false}},
    series: [{
      name: 'Balance', type: 'bar', barWidth: 17,
      data: branches.map((row, index) => ({value: row.balance, itemStyle: {color: index === branches.length - 1 ? blue : '#a9b6c1'}})),
      label: {show: true, position: 'right', color: '#424951', fontSize: 10, formatter: item => valueFormatter(item.value)}
    }]
  }, true);

  const sum = r.channels.reduce((total, row) => total + row.clients, 0);
  const channels = r.channels.map(row => ({
    name: row.channel === 'online' ? 'Online' : 'Branch',
    value: row.clients,
    itemStyle: {color: row.channel === 'online' ? blue : '#a9b6c1'}
  }));
  chart('channel-chart').setOption({
    animationDuration, textStyle,
    tooltip: {trigger: 'item', valueFormatter: value => number.format(value) + ' clients'},
    title: {text: number.format(sum), subtext: 'total clients', left: 'center', top: '35%', textStyle: {fontSize: 25, fontWeight: 500, color: '#111214'}, subtextStyle: {color: '#535961'}, itemGap: 5},
    series: [{type: 'pie', radius: ['65%', '82%'], label: {show: false}, itemStyle: {borderColor: '#fff', borderWidth: 3}, data: channels}]
  }, true);
  $('channel-legend').innerHTML = channels.map(channel =>
    '<div class="channel-key"><div><span class="legend-dot" style="background:' + channel.itemStyle.color + '"></span>' +
    channel.name + '</div><strong>' + number.format(channel.value) + '</strong><small>' +
    (sum ? (100 * channel.value / sum).toFixed(1) : '0') + '% of clients</small></div>'
  ).join('');
}
function render(r){const s=r.snapshot,p=r.period;state.report=r;$('snapshot-date').textContent='AS OF '+dateName(s.as_of).toUpperCase();$('kpi-balance').textContent=compact(s.balance);$('kpi-balance').title=money(s.balance);$('kpi-clients').textContent=number.format(s.clients);$('kpi-inactive').textContent=number.format(s.inactive)+' inactive';$('kpi-net').textContent=(p.net<0?'−':'')+compact(Math.abs(p.net));$('kpi-net').title=money(p.net);$('flow-state').textContent=p.net>=0?'Net inflow':'Net outflow';$('flow-state').className='tag '+(p.net>=0?'green':'amber');document.querySelectorAll('.period-label').forEach(el=>el.textContent=monthName(p.month));$('kpi-retention').textContent=p.retention===null?'—':p.retention.toFixed(2)+'%';$('retention-detail').textContent=number.format(p.returning)+' returning / '+number.format(p.previous_active)+' prior active';$('freshness').textContent='Checked '+new Date(r.fetched_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});$('flow-caption').textContent='Activity through '+dateName(s.as_of)+' · '+number.format(s.simulated)+' simulated records added';const top=r.branches.slice(0,5).reduce((a,b)=>a+b.balance,0);$('concentration').textContent=s.balance?'Top 5 hold '+(100*top/s.balance).toFixed(1)+'% of selected client balances':'No balances in this segment';
  const priorSelection=$('filter-month').value;$('filter-month').innerHTML='<option value="">Latest available</option>'+[...r.monthly].reverse().map(m=>'<option value="'+esc(m.month)+'">'+monthName(m.month)+'</option>').join('');if(priorSelection&&!r.monthly.some(m=>m.month===priorSelection))$('filter-month').append(new Option(monthName(priorSelection),priorSelection));$('filter-month').value=priorSelection;
  const priorBranch=$('filter-branch').value;$('filter-branch').innerHTML='<option value="">All branches</option>'+r.branch_options.map(b=>'<option>'+esc(b)+'</option>').join('');$('filter-branch').value=priorBranch;
  const idx=r.monthly.findIndex(m=>m.month===r.selected_month),rows=r.monthly.slice(Math.max(0,(idx<0?r.monthly.length:idx+1)-5),idx<0?r.monthly.length:idx+1).reverse();$('engagement-body').innerHTML=rows.map(m=>'<tr><td>'+monthName(m.month)+'</td><td>'+number.format(m.active)+'</td><td>'+number.format(m.returning)+'</td><td>'+(m.retention===null?'—':m.retention.toFixed(2)+'% <span class="retention-track"><span style="width:'+Math.min(100,m.retention)+'%"></span></span>')+'</td></tr>').join('');
  const checks=[['Client references',r.quality.orphans],['Balance reconciliation',r.quality.balance_mismatches],['Account-opening dates',r.quality.before_open],['Amount / type consistency',r.quality.sign_mismatches]];const good=checks.every(c=>c[1]===0);$('health-badge').textContent=good?'Checks passed':'Review needed';$('health-badge').className='tag '+(good?'green':'amber');$('health-checks').innerHTML=checks.map(([name,count])=>'<div class="health-row"><span><span class="health-check-icon">'+(count===0?'✓':'!')+'</span>'+name+'</span><span class="tag '+(count===0?'green':'amber')+'">'+(count===0?'Passed':count+' issues')+'</span></div>').join('');$('review-items').textContent=number.format(s.negative_balances)+' negative balances · '+number.format(s.pending_kyc)+' pending KYC labels in the selected segment.';
  $('run-body').innerHTML=r.runs.length?r.runs.map(run=>'<tr><td>'+esc(new Date(run.created_at).toLocaleString())+'</td><td><span class="tag '+(run.source==='simulated'?'amber':'blue')+'">'+esc(run.source)+'</span></td><td>'+run.accepted+'</td><td>'+run.rejected+'</td><td>'+run.duplicates+'</td></tr>').join(''):'<tr><td colspan="5" class="empty-row">No new imports yet. The historical baseline is ready.</td></tr>';
  const asof=new Date(s.as_of+"T00:00:00Z"), lastDay=new Date(Date.UTC(asof.getUTCFullYear(),asof.getUTCMonth()+1,0)).getUTCDate(); const partial=r.selected_month===s.as_of.slice(0,7)&&asof.getUTCDate()<lastDay; $("period-warning").hidden=!partial; $("period-warning").textContent="Partial month: activity is recorded only through "+dateName(s.as_of)+". Avoid comparing its retention or flows with completed months."; drawCharts(r);
}
async function loadReport(){const req=++state.request;try{const r=await api('/api/dashboard?'+params());if(req!==state.request)return;error('');render(r);if(state.view==='transactions')await loadTransactions();}catch(e){if(req===state.request){error(e.message);$('freshness').textContent='Refresh failed · previous data retained';}}}
let txRequest=0;
async function loadTransactions(){const req=++txRequest;try{const p=params({transaction:true});p.set('page',state.page);const r=await api('/api/transactions?'+p);if(req!==txRequest)return;state.total=r.total;$('transaction-total').textContent=number.format(r.total)+' records match your filters';$('transaction-body').innerHTML=r.rows.length?r.rows.map(t=>'<tr><td title="'+esc(t.transaction_id)+'">'+esc(t.transaction_id)+'</td><td>'+esc(t.customer_id)+'</td><td>'+esc(t.branch_id)+'</td><td>'+dateName(t.transaction_date)+'</td><td><span class="tag '+(t.amount_minor>0?'green':'neutral')+'">'+esc(t.transaction_type)+'</span></td><td class="'+(t.amount_minor>0?'positive':'negative')+'">'+(t.amount_minor>0?'+':'−')+money(Math.abs(t.amount_minor))+'</td><td><span class="tag '+(t.source==='simulated'?'amber':t.source==='upload'?'blue':'neutral')+'">'+esc(t.source)+'</span></td></tr>').join(''):'<tr><td colspan="7" class="empty-row">No transactions match these filters.</td></tr>';$('page-info').textContent='Page '+state.page+' of '+Math.max(1,Math.ceil(r.total/20))+' · 20 records per page';$('prev-page').disabled=state.page<=1;$('next-page').disabled=state.page*20>=r.total;}catch(e){error(e.message);}}
function setUploadCsv(text, label) {
  state.csv = text;
  $('file-name').textContent = label;
  $('upload-submit').disabled = false;
  $('upload-result').replaceChildren();
  error('');
}
function selectFile(file){if(!file)return;if(file.size>1048576){error('Choose a CSV under 1 MB.');return;}if(!file.name.toLowerCase().endsWith('.csv')){error('Choose a .csv file.');return;}file.text().then(text=>{setUploadCsv(text,file.name+' · '+(file.size/1024).toFixed(1)+' KB');});}
async function upload() {
  if (!state.csv) return;
  const submit = $('upload-submit');
  submit.disabled = true;
  submit.textContent = 'Validating…';
  try {
    const result = await post(state.publicDemo ? '/api/validate' : '/api/transactions', {csv:state.csv});
    const acceptedLabel = result.preview ? ' would be accepted' : ' accepted';
    $('upload-result').innerHTML =
      '<div class="import-summary"><span class="tag green">' + result.accepted + acceptedLabel +
      '</span><span class="tag amber">' + result.rejected + ' rejected</span><span class="tag neutral">' +
      result.duplicates + ' duplicates skipped</span></div>' +
      (result.errors.length ? '<div class="import-errors">' + result.errors.map(row =>
        '<p><strong>Row ' + row.row + '</strong> ' + esc(row.transaction_id) + ': ' + esc(row.reason) + '</p>'
      ).join('') + '</div>' : '');
    if (result.preview) {
      toast('Validation preview complete.');
    } else {
      toast(result.accepted + ' transaction(s) imported.');
      await loadReport();
    }
  } catch (e) {
    error(e.message);
  } finally {
    submit.disabled = false;
    submit.textContent = state.publicDemo ? 'Validate sample' : 'Validate & import';
  }
}
function stopLive(message){state.live=false;clearTimeout(state.liveTimer);$('live-toggle').classList.remove('live-on');$('live-toggle').setAttribute('aria-pressed','false');$('live-label').textContent='Start live demo';if(message)toast(message);}
async function liveTick(){if(!state.live)return;try{await post('/api/simulate',{count:3});await loadReport();if(state.live)state.liveTimer=setTimeout(liveTick,5000);}catch(e){stopLive();error('Live simulation stopped: '+e.message);}}
function toggleLive(){if(state.live){stopLive('Simulation paused. Previously added records remain in the ledger.');return;}state.live=true;$('live-toggle').classList.add('live-on');$('live-toggle').setAttribute('aria-pressed','true');$('live-label').textContent='Pause live demo';toast('Demo feed started: 3 simulated records every 5 seconds, dated 1 Aug 2025.');liveTick();}
async function loadPowerBiStatus() {
  const status = await api('/api/powerbi');
  const label = $('powerbi-status');
  const detail = $('powerbi-detail');
  if (!status.available) {
    label.textContent = 'CSV and Power Query available';
    detail.textContent = 'Use either download to build a report in Power BI Desktop.';
    return;
  }
  $('powerbi-download-label').textContent = status.format === 'pbix' ? 'Download Power BI report (.pbix)' : 'Download Power BI project (.zip)';
  $('powerbi-download').hidden = false;
  label.textContent = 'Synthetic baseline snapshot';
  detail.textContent = 'Data through ' + dateName(status.as_of) + '. Includes all branches.';
}

async function boot() {
  clearInterval(state.pollTimer);
  $('retry-load').hidden = true;
  try {
    let status = await api('/api/status');
    state.publicDemo = status.public_demo;
    if (state.publicDemo) {
      $('live-toggle').hidden = true;
      $('upload-description').textContent = 'Preview how a batch is classified. Try the fictional sample or supply a synthetic CSV.';
      $('upload-submit').textContent = 'Validate sample';
      if (!status.ready) throw new Error('The deployment needs its synthetic database seeded.');
    }
    while (!status.ready) {
      $('loading-message').textContent = 'Loading synthetic transactions: ' + number.format(status.loaded) + ' / ' + number.format(status.total);
      $('loading-progress').style.width = (status.loaded / status.total * 100) + '%';
      status = await post('/api/setup');
    }
    $('loading-message').textContent = 'Reconciling your management reports…';
    $('loading-progress').style.width = '100%';
    render(await api('/api/dashboard'));
    $('loading-overlay').hidden = true;
    setView(location.hash.slice(1) || 'overview');
    loadPowerBiStatus().catch(() => {
      $('powerbi-status').textContent = 'Report status unavailable';
    });
    if (!state.publicDemo) {
      state.pollTimer = setInterval(() => {
        if (!document.hidden && !state.live) loadReport();
      }, 15000);
    }
  } catch (e) {
    $('loading-message').textContent = e.message;
    $('retry-load').hidden = false;
  }
}
document.querySelectorAll('[data-view]').forEach(el=>el.addEventListener('click',()=>setView(el.dataset.view)));
document.querySelectorAll('[data-download]').forEach(el=>el.addEventListener('click',()=>download(el.dataset.download)));
document.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',()=>$(el.dataset.close).close()));
for(const k of ['branch','channel','account','month'])$('filter-'+k).addEventListener('change',()=>{state.page=1;loadReport();});
$('reset-filters').addEventListener('click',()=>{for(const k of ['branch','channel','account','month'])$('filter-'+k).value='';state.page=1;loadReport();});
$('export-open').addEventListener('click',()=>$('export-dialog').showModal());$('powerbi-guide').addEventListener('click',()=>$('guide-dialog').showModal());$('engagement-export').addEventListener('click',()=>download('monthly'));$('transactions-download').addEventListener('click',()=>download('transactions'));
for(const id of ['transaction-source','transaction-type'])$(id).addEventListener('change',()=>{state.page=1;loadTransactions();});
$('prev-page').addEventListener('click',()=>{if(state.page>1){state.page--;loadTransactions();}});$('next-page').addEventListener('click',()=>{if(state.page*20<state.total){state.page++;loadTransactions();}});
$('csv-file').addEventListener('change',e=>selectFile(e.target.files[0]));$('dropzone').addEventListener('dragover',e=>{e.preventDefault();$('dropzone').classList.add('dragover');});$('dropzone').addEventListener('dragleave',()=>$('dropzone').classList.remove('dragover'));$('dropzone').addEventListener('drop',e=>{e.preventDefault();$('dropzone').classList.remove('dragover');selectFile(e.dataTransfer.files[0]);});$('upload-submit').addEventListener('click',upload);$('live-toggle').addEventListener('click',toggleLive);$('retry-load').addEventListener('click',boot);
$('sample-upload').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/sample');
    if (!response.ok) throw new Error('Could not load the sample batch.');
    $('csv-file').value = '';
    setUploadCsv(await response.text(), 'Synthetic sample · 4 rows');
  } catch (e) {
    error(e.message);
  }
});
window.addEventListener('resize',()=>Object.values(state.charts).forEach(c=>c.resize()));window.addEventListener('pagehide',()=>{stopLive();clearInterval(state.pollTimer);});
boot();
document.getElementById('full-history-download').addEventListener('click',()=>download('transactions',{allMonths:true,transaction:true}));
