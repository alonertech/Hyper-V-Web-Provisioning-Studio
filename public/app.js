'use strict';

const $ = id => document.getElementById(id);
let config = null;
let currentJob = null;
let eventSource = null;
let lifecycleSource = null;
let inventoryTimer = null;
let lastInventory = null;
let lastSummary = null;

function log(message, level='info') {
  const row=document.createElement('div'); row.className=`line ${level}`;
  row.textContent=`[${new Date().toLocaleTimeString()}] ${message}`;
  $('console').appendChild(row); $('console').scrollTop=$('console').scrollHeight;
}
function setBusy(busy){
  document.querySelectorAll('#vmForm input,#vmForm select,#vmForm button,#modifyVmForm input,#modifyVmForm select,#modifyVmForm button,#createSwitchForm input,#createSwitchForm select,#createSwitchForm button,#modifySwitchForm input,#modifySwitchForm select,#modifySwitchForm button').forEach(el=>el.disabled=busy&&el.id!=='cancelBtn'&&!el.matches('#closeModifyVm,#cancelModifyVm'));
  $('preflightBtn').disabled=busy; $('saveTemplateBtn').disabled=busy; $('cancelBtn').disabled=!busy||!currentJob;
  $('refreshBtn').disabled=false;
}
function setJobState(state,id=''){ $('jobState').textContent=state; $('jobId').textContent=id||'No job'; }
function stateClass(state){return String(state||'').toLowerCase().replace(/[^a-z]+/g,'-');}
function fmtMemory(mb){if(mb==null||Number.isNaN(Number(mb)))return '—';return Number(mb)>=1024?`${(Number(mb)/1024).toFixed(1)} GB`:`${mb} MB`;}
function escapeHtml(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML;}
function csvToArray(v){return String(v||'').split(',').map(x=>x.trim()).filter(Boolean);}
function semiToArray(v){return String(v||'').split(';').map(x=>x.trim()).filter(Boolean);}

function activateTab(name){
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.toggle('active',p.id===`tab-${name}`));
  if(name==='switches')loadSwitches();
  if(name==='templates')loadTemplates();
  if(name==='policies')loadPolicies();
  if(name==='audit')loadAudit();
  if(name==='access')loadAccess();
  if(name==='dashboard'){loadSummary();loadJobs();}
}

document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>activateTab(b.dataset.tab)));

async function loadConfig(){
  const r=await fetch('/api/config',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Unable to load configuration.');
  config=d;
  $('targetMeta').textContent=`${d.targetLabel} · ${d.useSSL?'WinRM HTTPS':(d.localTarget?'Local PowerShell':'WinRM')} · ${d.authMode} authentication`;
  $('userMeta').textContent=`${d.user} · ${d.role} · Embedded Professional Store`;
  $('storagePath').value=d.defaultStoragePath||'C:\\Hyper-V\\VMs';
  const def=d.defaults||{};$('generation').value=String(def.generation??2);$('cpuCount').value=def.cpuCount??2;$('memoryMB').value=def.memoryMB??4096;$('diskSizeGB').value=def.diskSizeGB??60;$('diskType').value=def.diskType??'Dynamic';
  $('secureBoot').checked=def.secureBoot!==false;$('secureBootTemplate').value=def.secureBootTemplate??'MicrosoftWindows';$('enableVTPM').checked=Boolean(def.enableVTPM);$('vlanTagging').checked=Boolean(def.vlanTagging);$('vlanId').value=def.vlanId??1;$('rollbackOnFailure').checked=def.rollbackOnFailure!==false;
  $('browseFolderBtn').disabled=!d.localTarget;$('browseIsoBtn').disabled=!d.localTarget;if(!d.localTarget)$('switchHint').textContent='Remote target: paths are checked on the target host.';
  updateGenerationUI();updateFormUI();
}
function collectConfig(){
  return {vmName:$('vmName').value.trim(),generation:Number($('generation').value),cpuCount:Number($('cpuCount').value),memoryMB:Number($('memoryMB').value),diskSizeGB:Number($('diskSizeGB').value),diskType:$('diskType').value,vSwitch:$('vSwitch').value,vlanTagging:$('vlanTagging').checked,vlanId:Number($('vlanId').value),storagePath:$('storagePath').value.trim(),isoPath:$('isoPath').value.trim(),secureBoot:$('secureBoot').checked,secureBootTemplate:$('secureBootTemplate').value,enableVTPM:$('enableVTPM').checked,rollbackOnFailure:$('rollbackOnFailure').checked};
}
function updateGenerationUI(){const g=Number($('generation').value);const gen1=g===1;$('secureBoot').disabled=gen1;$('enableVTPM').disabled=gen1;if(gen1){$('secureBoot').checked=false;$('enableVTPM').checked=false;}}
function updateFormUI(){$('vlanWrap').style.opacity=$('vlanTagging').checked?'1':'.45';}

async function loadInventory(showErrors=true){
  try{
    const r=await fetch('/api/inventory',{cache:'no-store'});const d=await r.json();if(!r.ok||!d.success){const err=new Error(d.error||'Inventory request failed.');err.diagnostics=d.diagnostics;throw err;}
    lastInventory=d.data;const warnings=d.data?.Warnings||[];if(warnings.length&&showErrors)warnings.forEach(w=>log(`Inventory warning: ${w}`,'warn'));
    $('statusBadge').textContent='Target connected';$('statusBadge').className='status good';
    $('targetMeta').textContent=`${config?.targetLabel||d.data?.ComputerName||'Hyper-V target'} · ${config?.useSSL?'WinRM HTTPS':(config?.localTarget?'Local PowerShell':'WinRM')} · ${config?.authMode||'Integrated'}`;
    renderInventory(d.data);populateSwitches(d.data?.Switches||[]);loadSwitches();populateAdapters('createNetAdapter');populateAdapters('modifyNetAdapter');await loadSummary();
  }catch(e){
    $('statusBadge').textContent='Target unavailable';$('statusBadge').className='status bad';if(showErrors)log(`Inventory refresh failed: ${e.message}`,'error');
    if(showErrors&&e.diagnostics)(e.diagnostics.stderr||[]).forEach(x=>log(`PowerShell: ${x}`,'error'));
  }
}
function populateSwitches(switches){
  const select=$('vSwitch');const current=select.value;select.innerHTML='';
  if(!switches.length){const o=document.createElement('option');o.value='';o.textContent='No virtual switches found';select.appendChild(o);return;}
  for(const sw of switches){const o=document.createElement('option');o.value=sw.Name;o.textContent=`${sw.Name} · ${sw.SwitchType}`;select.appendChild(o);}if(switches.some(s=>s.Name===current))select.value=current;
}
function renderInventory(data){
  const rows=data?.VMs||[];$('vmCount').textContent=`${rows.length} VM${rows.length===1?'':'s'}`;const body=$('vmRows');body.innerHTML='';
  if(!rows.length){body.innerHTML='<tr><td colspan="9" class="empty">No virtual machines found on the target host.</td></tr>';return;}
  for(const vm of rows){const tr=document.createElement('tr');const ip=(vm.IPAddresses||[]).join(', ')||'—';const sw=(vm.Switches||[]).join(', ')||'—';const iso=vm.DVDPath?'Mounted':'—';tr.innerHTML=`<td><button class="link-button vm-name" data-name="${escapeHtml(vm.Name)}">${escapeHtml(vm.Name)}</button></td><td><span class="vm-state ${stateClass(vm.State)}">${escapeHtml(vm.State)}</span></td><td>Gen ${vm.Generation}</td><td>${vm.CPUCount}</td><td>${fmtMemory(vm.MemoryAssignedMB||vm.MemoryStartupMB)}</td><td class="small-cell">${escapeHtml(ip)}</td><td class="small-cell">${escapeHtml(sw)}</td><td>${iso==='Mounted'?'<span class="tag mounted">ISO</span>':'—'}</td><td class="action-cell"><button class="btn tiny console-action" data-name="${escapeHtml(vm.Name)}">Console</button><button class="btn tiny details-action" data-name="${escapeHtml(vm.Name)}">Details</button><button class="btn tiny modify-action" data-name="${escapeHtml(vm.Name)}">Modify</button><button class="btn tiny" data-op="Start" data-name="${escapeHtml(vm.Name)}">Start</button><button class="btn tiny" data-op="Shutdown" data-name="${escapeHtml(vm.Name)}">Shutdown</button><button class="btn tiny danger" data-op="TurnOff" data-name="${escapeHtml(vm.Name)}">TurnOff</button>${vm.DVDPath?`<button class="btn tiny" data-eject="${escapeHtml(vm.Name)}">Eject ISO</button>`:''}</td>`;body.appendChild(tr);}
  body.querySelectorAll('.console-action').forEach(b=>b.addEventListener('click',()=>openConsole(b.dataset.name)));body.querySelectorAll('.details-action,.vm-name').forEach(b=>b.addEventListener('click',()=>showDetails(b.dataset.name)));body.querySelectorAll('.modify-action').forEach(b=>b.addEventListener('click',()=>openModifyVm(b.dataset.name)));body.querySelectorAll('[data-op]').forEach(b=>b.addEventListener('click',()=>runVmAction(b.dataset.name,b.dataset.op)));body.querySelectorAll('[data-eject]').forEach(b=>b.addEventListener('click',()=>ejectIso(b.dataset.eject)));
}
function addSwitchToDropdown(sw){
  if(!sw?.name&&!sw?.Name)return;const item={Name:sw.Name||sw.name,SwitchType:sw.SwitchType||sw.type||'Unknown'};const switches=Array.isArray(lastInventory?.Switches)?[...lastInventory.Switches]:[];const i=switches.findIndex(x=>x.Name===item.Name);if(i>=0)switches[i]={...switches[i],...item};else switches.push(item);if(!lastInventory)lastInventory={VMs:[],Switches:switches,Adapters:[]};else lastInventory.Switches=switches;populateSwitches(switches);$('switchHint').textContent=`Virtual switch '${item.Name}' is now available on the target host.`;
}
function showDetails(name){const vm=(lastInventory?.VMs||[]).find(x=>x.Name===name);if(!vm)return;$('detailsTitle').textContent=vm.Name;$('detailsSubtitle').textContent=`${vm.State} · Generation ${vm.Generation}`;const cards=[['State',vm.State],['Generation',vm.Generation],['CPU',vm.CPUCount],['CPU usage',`${vm.CPUUsage}%`],['Assigned memory',fmtMemory(vm.MemoryAssignedMB)],['Startup memory',fmtMemory(vm.MemoryStartupMB)],['Memory mode','Static'],['Uptime',vm.Uptime||'—'],['IP addresses',(vm.IPAddresses||[]).join(', ')||'—'],['MAC addresses',(vm.MACAddresses||[]).join(', ')||'—'],['vSwitches',(vm.Switches||[]).join(', ')||'—'],['ISO',vm.DVDPath||'Not mounted'],['VM path',vm.Path],['Configuration version',vm.Version]];$('detailsBody').innerHTML=cards.map(([k,v])=>`<div class="detail"><div class="detail-key">${escapeHtml(k)}</div><div class="detail-value">${escapeHtml(v)}</div></div>`).join('');$('detailsModal').classList.remove('hidden');}
function closeDetails(){$('detailsModal').classList.add('hidden');}
async function openConsole(name){try{const r=await fetch(`/api/vms/${encodeURIComponent(name)}/console`,{method:'POST'});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||'Unable to open VM console.');log(d.message,'success');}catch(e){log(`VM console failed: ${e.message}`,'error');}}
async function ejectIso(name){if(!confirm(`Eject the ISO from '${name}'?`))return;try{setBusy(true);const r=await fetch(`/api/vms/${encodeURIComponent(name)}/eject-iso`,{method:'POST'});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||'Unable to eject ISO.');watchJob(d.job);}catch(e){setBusy(false);log(e.message,'error');}}
async function runVmAction(vmName,operation){if(!confirm(`${operation} VM '${vmName}'?`))return;try{setBusy(true);await submitJob('vm-action',{vmName,operation});}catch(e){setBusy(false);log(e.message,'error');}}

async function preflight(){try{setBusy(true);log('Starting target-host pre-flight validation...');const r=await fetch('/api/preflight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:collectConfig()})});const d=await r.json();if(!r.ok||!d.success){const err=new Error(d.error||'Pre-flight failed.');if(d.policyFailures)err.message+=` ${d.policyFailures.join(' ')}`;throw err;}log(`Pre-flight passed. Target path: ${d.data?.VmPath||'n/a'}. Installation ISO: ${d.data?.IsoPath?'Yes':'No'}. VM remains Off after provisioning.`,'success');$('policyHint').textContent=d.policies?.length?`Policies checked: ${d.policies.join(', ')}`:'No active policy blocks';$('policyHint').className=d.policies?.length?'pill good-pill':'pill';}catch(e){log(`Pre-flight failed: ${e.message}`,'error');}finally{setBusy(false);}}

function watchJob(job){
  currentJob=job;setJobState(job.state,job.id);if(eventSource)eventSource.close();eventSource=new EventSource(`/api/jobs/${encodeURIComponent(job.id)}/events`);
  eventSource.onmessage=evt=>{try{const event=JSON.parse(evt.data);if(event.type==='log')log(event.message,event.level||'info');if(event.type==='result'&&event.success&&currentJob?.type==='create-switch')addSwitchToDropdown(event.data);if(event.type==='result')setJobState(event.success?'completed':'failed',job.id);}catch{}};
  eventSource.addEventListener('end',evt=>{try{const end=JSON.parse(evt.data);setJobState(end.state,end.id);if(eventSource){eventSource.close();eventSource=null;}setBusy(false);currentJob=null;loadInventory(false);loadJobs();loadSummary();}catch{setBusy(false);currentJob=null;}});
  eventSource.onerror=()=>{if(!currentJob)return;fetch(`/api/jobs/${encodeURIComponent(currentJob.id)}`).then(r=>r.json()).then(d=>{if(d.job&&['completed','failed','cancelled'].includes(d.job.state)){setJobState(d.job.state,d.job.id);setBusy(false);currentJob=null;if(eventSource){eventSource.close();eventSource=null;}loadInventory(false);loadJobs();}}).catch(()=>{});};
}
async function submitJob(type,cfg){const r=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,config:cfg})});const d=await r.json();if(!r.ok||!d.success){let msg=d.error||'Job could not be started.';if(d.policyFailures)msg+=` ${d.policyFailures.join(' ')}`;throw new Error(msg);}watchJob(d.job);}
async function cancelJob(){if(!currentJob)return;$('cancelBtn').disabled=true;log('Sending cancellation request...','warn');try{const r=await fetch(`/api/jobs/${encodeURIComponent(currentJob.id)}/cancel`,{method:'POST'});const d=await r.json();log(d.message||d.error,d.success?'warn':'error');}catch(e){log(e.message,'error');}}

function populateAdapters(selectId){
  const s=$(selectId);if(!s)return;s.innerHTML='';
  const adapters=lastInventory?.Adapters||[];
  if(!adapters.length){s.innerHTML='<option value="">No adapters available</option>';return;}
  for(const a of adapters){const o=document.createElement('option');o.value=a.Name;o.textContent=`${a.Name} · ${a.Status||'Unknown'} · ${a.LinkSpeed||''}`;s.appendChild(o);}
}
function loadSwitches(){
  const body=$('switchRows');if(!body)return;
  const switches=lastInventory?.Switches||[],vms=lastInventory?.VMs||[];body.innerHTML='';
  $('switchCount').textContent=`${switches.length} switch${switches.length===1?'':'es'}`;
  $('modifySwitchName').innerHTML='<option value="">Select a switch</option>';
  if(!switches.length){body.innerHTML='<tr><td colspan="7" class="empty">No virtual switches found on the target host.</td></tr>';return;}
  for(const sw of switches){
    const connected=vms.filter(vm=>(vm.Switches||[]).includes(sw.Name)).length;
    const tr=document.createElement('tr');
    tr.innerHTML=`<td><button class="link-button" data-switch-select="${escapeHtml(sw.Name)}">${escapeHtml(sw.Name)}</button></td><td>${escapeHtml(sw.SwitchType||'')}</td><td class="small-cell">${escapeHtml(sw.NetAdapterName||'—')}</td><td>${sw.AllowManagementOS?'Yes':'No'}</td><td>${connected}</td><td class="small-cell">${escapeHtml(sw.Notes||'—')}</td><td><button class="btn tiny" data-switch-edit="${escapeHtml(sw.Name)}">Modify</button></td>`;
    body.appendChild(tr);
    const o=document.createElement('option');o.value=sw.Name;o.textContent=`${sw.Name} · ${sw.SwitchType}`;$('modifySwitchName').appendChild(o);
  }
  body.querySelectorAll('[data-switch-select],[data-switch-edit]').forEach(b=>b.addEventListener('click',()=>selectSwitchForEdit(b.dataset.switchSelect||b.dataset.switchEdit)));
}
function selectSwitchForEdit(name){
  const sw=(lastInventory?.Switches||[]).find(x=>x.Name===name);if(!sw)return;
  $('modifySwitchName').value=sw.Name;$('modifySwitchType').value=sw.SwitchType||'Internal';$('modifyNetAdapter').value=sw.NetAdapterName||'';$('modifyAllowManagementOS').checked=Boolean(sw.AllowManagementOS);$('modifySwitchNotes').value=sw.Notes||'';toggleModifySwitchAdapter();
  $('modifySwitchName').scrollIntoView({behavior:'smooth',block:'center'});
}
function toggleModifySwitchAdapter(){
  const external=$('modifySwitchType').value==='External';$('modifyAdapterWrap').style.display=external?'block':'none';$('modifyAllowManagementOS').disabled=!external||Boolean(currentJob);
}
function toggleCreateSwitchAdapter(){$('createAdapterWrap').style.display=$('createSwitchType').value==='External'?'block':'none';}
function openModifyVm(name){
  const vm=(lastInventory?.VMs||[]).find(x=>x.Name===name);if(!vm)return;
  $('modifyVmName').value=vm.Name;$('modifyVmTitle').textContent=`Modify VM · ${vm.Name}`;$('modifyVmSubtitle').textContent=`${vm.State} · Generation ${vm.Generation} · Current path: ${vm.Path}`;
  const diskSelect=$('modifyDiskPath');diskSelect.innerHTML='<option value="">No disk resize</option>';
  for(const d of (vm.Disks||[])){const o=document.createElement('option');o.value=d.Path;o.textContent=`${d.Path} · ${d.SizeGB!=null?d.SizeGB+' GB':'size unavailable'}`;diskSelect.appendChild(o);}
  $('modifyDiskSizeGB').value='';$('modifyStoragePath').value='';
  const net=$('modifyNetworkAdapter');net.innerHTML='<option value="">No network change</option>';
  for(const a of (vm.NetworkAdapters||[])){const o=document.createElement('option');o.value=a.Name;o.textContent=`${a.Name}${a.SwitchName?' · '+a.SwitchName:''}`;net.appendChild(o);}
  const sw=$('modifyVSwitch');sw.innerHTML='<option value="">Select switch</option>';for(const x of (lastInventory?.Switches||[])){const o=document.createElement('option');o.value=x.Name;o.textContent=`${x.Name} · ${x.SwitchType}`;sw.appendChild(o);}
  $('modifyVmCurrent').textContent=`Current storage: ${vm.Path}. Select one or more changes. Disk resize is expand-only; disk and storage changes require the VM to be Off.`;
  $('modifyVmModal').classList.remove('hidden');
}
function closeModifyVm(){$('modifyVmModal').classList.add('hidden');}
async function submitModifyVm(){
  const cfg={vmName:$('modifyVmName').value.trim(),diskPath:$('modifyDiskPath').value,destinationStoragePath:$('modifyStoragePath').value.trim(),networkAdapterName:$('modifyNetworkAdapter').value,vSwitch:$('modifyVSwitch').value};
  if($('modifyDiskSizeGB').value!=='')cfg.requestedDiskSizeGB=Number($('modifyDiskSizeGB').value);
  if(cfg.requestedDiskSizeGB!=null&&!cfg.diskPath)throw new Error('Select a virtual disk before entering a new disk size.');
  const hasDisk=cfg.requestedDiskSizeGB!=null,hasMove=Boolean(cfg.destinationStoragePath),hasNet=Boolean(cfg.networkAdapterName)||Boolean(cfg.vSwitch);
  if(!hasDisk&&!hasMove&&!hasNet)throw new Error('Select at least one VM change.');
  if(hasNet&&(!cfg.networkAdapterName||!cfg.vSwitch))throw new Error('Select both the network adapter and virtual switch.');
  if(hasDisk&&!confirm(`Expand disk '${cfg.diskPath}' to ${cfg.requestedDiskSizeGB} GB? The requested size must be larger than the current disk.`))return;
  if(hasMove&&!confirm(`Move all VM storage for '${cfg.vmName}' to '${cfg.destinationStoragePath}'? The VM must be Off.`))return;
  setBusy(true);closeModifyVm();await submitJob('modify-vm',cfg);activateTab('vms');
}
function auditDetailValue(v){
  if(Array.isArray(v))return v.map(x=>Array.isArray(x)?auditDetailValue(x):typeof x==='object'?JSON.stringify(x):String(x)).join(' · ');
  if(v&&typeof v==='object')return JSON.stringify(v,null,2);return String(v??'');
}
function jobDuration(j){
  if(!j?.startedAt)return 'Not started';
  const end=j.finishedAt?Date.parse(j.finishedAt):Date.now(),start=Date.parse(j.startedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return '—';
  const sec=Math.floor((end-start)/1000);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  return h?`${h}h ${m}m ${s}s`:m?`${m}m ${s}s`:`${s}s`;
}
function showAuditDetail(e){
  $('auditDetailTitle').textContent=e.jobLabel||'Audit event';$('auditDetailSubtitle').textContent=`${e.timestamp||''} · ${e.outcome||e.action||''}`;
  const pairs=[['Operation',e.jobLabel||e.action||''],['Actor',e.actor||''],['Target host',e.targetHost||'' ],['State / outcome',e.outcome||e.message||''],['Created',e.createdAt||''],['Started',e.startedAt||''],['Finished',e.finishedAt||''],['Duration',e.duration||''],['Job ID',e.jobId||'Not associated with a job'],['Details',auditDetailValue(e.jobDetails||[])],['Message',e.message||'']];
  $('auditDetailBody').innerHTML=pairs.filter(([k,v])=>v!==''&&v!=='[]').map(([k,v])=>`<div class="detail"><div class="detail-key">${escapeHtml(k)}</div><div class="detail-value">${escapeHtml(v)}</div></div>`).join('');$('auditDetailModal').classList.remove('hidden');
}
function closeAuditDetail(){$('auditDetailModal').classList.add('hidden');}
function showJobDetail(j){showAuditDetail({jobLabel:j.summary||j.type,actor:config?.user||'',targetHost:j.targetHost||config?.targetHost||'',outcome:j.state,message:j.message||'',jobId:j.id,jobDetails:j.details||[],timestamp:j.createdAt,createdAt:j.createdAt,startedAt:j.startedAt,finishedAt:j.finishedAt,duration:jobDuration(j)});}

async function saveTemplate(){
  const name=prompt('Template name:');if(!name)return;
  try{setBusy(true);const c=collectConfig();delete c.vmName;delete c.isoPath;const r=await fetch('/api/templates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,config:c})});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error||'Template could not be saved.');log(`Template '${name}' saved.`,'success');loadTemplates();}catch(e){log(e.message,'error');}finally{setBusy(false);}
}
async function loadTemplates(){try{const r=await fetch('/api/templates');const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);const body=$('templateRows');body.innerHTML='';if(!d.data.length){body.innerHTML='<tr><td colspan="7" class="empty">No templates saved.</td></tr>';return;}for(const t of d.data){const c=t.config||{};const tr=document.createElement('tr');tr.innerHTML=`<td>${escapeHtml(t.name)}</td><td>Gen ${c.generation}</td><td>${c.cpuCount}</td><td>${fmtMemory(c.memoryMB)}</td><td>${c.diskSizeGB} GB ${escapeHtml(c.diskType)}</td><td>${c.secureBoot?'Secure Boot':''}${c.enableVTPM?' + vTPM':''}</td><td><button class="btn tiny" data-apply="${escapeHtml(t.id)}">Apply</button><button class="btn tiny danger" data-delete="${escapeHtml(t.id)}">Delete</button></td>`;body.appendChild(tr);}body.querySelectorAll('[data-apply]').forEach(b=>b.addEventListener('click',()=>applyTemplate(b.dataset.apply)));body.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>deleteTemplate(b.dataset.delete)));}catch(e){$('templateRows').innerHTML=`<tr><td colspan="7" class="empty">${escapeHtml(e.message)}</td></tr>`;}}
async function applyTemplate(id){const t=(await (await fetch('/api/templates')).json()).data.find(x=>x.id===id);if(!t)return;activateTab('provision');const c=t.config;$('generation').value=String(c.generation);$('cpuCount').value=c.cpuCount;$('memoryMB').value=c.memoryMB;$('diskSizeGB').value=c.diskSizeGB;$('diskType').value=c.diskType;$('vSwitch').value=c.vSwitch||$('vSwitch').value;$('vlanTagging').checked=Boolean(c.vlanTagging);$('vlanId').value=c.vlanId||1;$('secureBoot').checked=Boolean(c.secureBoot);$('secureBootTemplate').value=c.secureBootTemplate||'MicrosoftWindows';$('enableVTPM').checked=Boolean(c.enableVTPM);$('rollbackOnFailure').checked=c.rollbackOnFailure!==false;updateGenerationUI();updateFormUI();log(`Template '${t.name}' applied to the provisioning form.`,'success');}
async function deleteTemplate(id){if(!confirm('Delete this template?'))return;try{const r=await fetch(`/api/templates/${encodeURIComponent(id)}`,{method:'DELETE'});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);log('Template deleted.','success');loadTemplates();}catch(e){log(e.message,'error');}}

async function loadPolicies(){try{const r=await fetch('/api/policies');const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);const body=$('policyRows');body.innerHTML='';if(!d.data.length){body.innerHTML='<tr><td colspan="7" class="empty">No policies configured.</td></tr>';return;}for(const p of d.data){const r=p.rules||{};const tr=document.createElement('tr');tr.innerHTML=`<td>${escapeHtml(p.name)}</td><td>${p.enabled?'<span class="tag enabled">Enabled</span>':'<span class="tag">Disabled</span>'}</td><td>${r.requireGeneration2?'Yes':'No'}</td><td>${r.requireSecureBoot?'Yes':'No'}</td><td>${r.requireVTPM?'Yes':'No'}</td><td>${r.minCpu||0} vCPU / ${fmtMemory(r.minMemoryMB||0)}</td><td><button class="btn tiny danger" data-delete-policy="${escapeHtml(p.id)}">Delete</button></td>`;body.appendChild(tr);}body.querySelectorAll('[data-delete-policy]').forEach(b=>b.addEventListener('click',()=>deletePolicy(b.dataset.deletePolicy)));}catch(e){$('policyRows').innerHTML=`<tr><td colspan="7" class="empty">${escapeHtml(e.message)}</td></tr>`;}}
async function deletePolicy(id){if(!confirm('Delete this policy?'))return;try{const r=await fetch(`/api/policies/${encodeURIComponent(id)}`,{method:'DELETE'});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);loadPolicies();loadSummary();}catch(e){log(e.message,'error');}}

async function loadAudit(){try{const r=await fetch('/api/audit?limit=200');const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);const body=$('auditRows');body.innerHTML='';if(!d.data.length){body.innerHTML='<tr><td colspan="7" class="empty">No audit events.</td></tr>';return;}for(const e of d.data){const tr=document.createElement('tr');const label=e.jobLabel||e.action||'Audit event';tr.innerHTML=`<td>${escapeHtml(e.timestamp)}</td><td>${escapeHtml(e.actor||'')}</td><td>${escapeHtml(e.action||'')}</td><td>${escapeHtml(e.targetHost||'')}</td><td><button class="link-button" data-audit-detail="${escapeHtml(e.id)}">${escapeHtml(label)}</button>${e.jobId?`<div class="small-cell mono">${escapeHtml(e.jobId)}</div>`:''}</td><td>${escapeHtml(e.outcome||e.message||'')}</td><td class="hash-cell">${escapeHtml(String(e.hash||'').slice(0,16))}...</td>`;body.appendChild(tr);}body.querySelectorAll('[data-audit-detail]').forEach(b=>b.addEventListener('click',()=>{const e=d.data.find(x=>x.id===b.dataset.auditDetail);if(e)showAuditDetail(e);}));}catch(e){$('auditRows').innerHTML=`<tr><td colspan="7" class="empty">${escapeHtml(e.message)}</td></tr>`;}}
async function verifyAudit(){try{const r=await fetch('/api/audit/verify');const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);$('auditStatus').textContent=d.data.valid?`Integrity OK · ${d.data.events} events · chain intact`:`Integrity failure at ${d.data.failedEventId}`;$('auditStatus').className=d.data.valid?'audit-status good-audit':'audit-status bad-audit';log(d.data.valid?'Audit integrity verification passed.':'Audit integrity verification failed.','success');loadSummary();}catch(e){$('auditStatus').textContent=e.message;$('auditStatus').className='audit-status bad-audit';log(e.message,'error');}}

async function loadAccess(){try{const me=await (await fetch('/api/rbac/me')).json();$('currentUser').textContent=me.data.username;$('currentRole').textContent=me.data.role;const r=await fetch('/api/rbac/users');const d=await r.json();const body=$('accessRows');body.innerHTML='';if(!r.ok||!d.success){body.innerHTML='<tr><td colspan="4" class="empty">Access mapping is restricted to administrators.</td></tr>';return;}if(!d.data.length){body.innerHTML='<tr><td colspan="4" class="empty">No explicit mappings. Unmapped users use the configured default role.</td></tr>';return;}for(const u of d.data){const tr=document.createElement('tr');tr.innerHTML=`<td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.role)}</td><td>${escapeHtml(u.updatedAt||'')}</td><td><button class="btn tiny danger" data-delete-user="${escapeHtml(u.id)}">Remove</button></td>`;body.appendChild(tr);}body.querySelectorAll('[data-delete-user]').forEach(b=>b.addEventListener('click',()=>deleteAccess(b.dataset.deleteUser)));}catch(e){$('accessRows').innerHTML=`<tr><td colspan="4" class="empty">${escapeHtml(e.message)}</td></tr>`;}}
async function deleteAccess(id){if(!confirm('Remove this role mapping?'))return;try{const r=await fetch(`/api/rbac/users/${encodeURIComponent(id)}`,{method:'DELETE'});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);loadAccess();}catch(e){log(e.message,'error');}}
async function saveAccess(){try{const r=await fetch('/api/rbac/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('accessUser').value.trim(),role:$('accessRole').value})});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);log(`Role mapping saved for '${d.data.username}'.`,'success');$('accessUser').value='';loadAccess();}catch(e){log(e.message,'error');}}

async function loadJobs(){try{const r=await fetch('/api/jobs/history?limit=30');const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);const body=$('jobHistoryRows');body.innerHTML='';if(!d.data.length){body.innerHTML='<tr><td colspan="5" class="empty">No job history.</td></tr>';return;}for(const j of d.data){const tr=document.createElement('tr');tr.innerHTML=`<td><button class="link-button" data-job-detail="${escapeHtml(j.id)}">${escapeHtml(j.summary||j.type)}</button><div class="small-cell mono">${escapeHtml(j.id)}</div></td><td><span class="vm-state ${stateClass(j.state)}">${escapeHtml(j.state)}</span></td><td>${escapeHtml(j.createdAt)}</td><td class="small-cell">${escapeHtml(j.message)}</td><td><button class="btn tiny" data-job-view="${escapeHtml(j.id)}">View</button></td>`;body.appendChild(tr);}body.querySelectorAll('[data-job-detail],[data-job-view]').forEach(b=>b.addEventListener('click',()=>{const j=d.data.find(x=>x.id===b.dataset.jobDetail||x.id===b.dataset.jobView);if(j)showJobDetail(j);}));}catch(e){$('jobHistoryRows').innerHTML=`<tr><td colspan="5" class="empty">${escapeHtml(e.message)}</td></tr>`;}}
async function loadSummary(){try{const r=await fetch('/api/professional/summary',{cache:'no-store'});const d=await r.json();if(!r.ok||!d.success)throw new Error(d.error);lastSummary=d.data;$('metricVms').textContent=d.data.vmCount;$('metricVmsSub').textContent=`${d.data.runningVmCount} running · ${d.data.offVmCount} off`;$('metricSwitches').textContent=d.data.switchCount;$('metricTemplates').textContent=d.data.templateCount;$('metricPolicies').textContent=d.data.enabledPolicyCount;$('metricJobs').textContent=d.data.jobHistoryCount;$('metricAudit').textContent=d.data.auditIntegrity.valid?'OK':'FAIL';$('metricAuditSub').textContent=d.data.auditIntegrity.valid?`${d.data.auditCount} events · SHA-256 chain`:'Audit chain integrity failure';const o=[['Target',d.data.targetLabel],['Transport',d.data.useSSL?'WinRM HTTPS':'WinRM HTTP / Local'],['Identity',d.data.user],['Role',d.data.role],['Data store','Embedded local store'],['Last inventory',lastInventory?'Just refreshed':'Not yet']];$('targetOverview').innerHTML=o.map(([k,v])=>`<div class="detail"><div class="detail-key">${escapeHtml(k)}</div><div class="detail-value">${escapeHtml(v)}</div></div>`).join('');$('policyHint').textContent=d.data.enabledPolicyCount?`${d.data.enabledPolicyCount} active policy(s)`:'No active policy blocks';}catch(e){}}

function setupLifecycle(){
  const key='hyperv-web-v3-client-id';let clientId=sessionStorage.getItem(key);if(!clientId){clientId=crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`;sessionStorage.setItem(key,clientId);}let byeSent=false;lifecycleSource=new EventSource(`/api/lifecycle?clientId=${encodeURIComponent(clientId)}`);lifecycleSource.onerror=()=>{};
  const notify=()=>{if(byeSent)return;byeSent=true;try{if(lifecycleSource)lifecycleSource.close();}catch{}const payload=JSON.stringify({clientId});try{const blob=new Blob([payload],{type:'application/json'});if(navigator.sendBeacon&&navigator.sendBeacon('/api/lifecycle/bye',blob))return;}catch{}try{fetch('/api/lifecycle/bye',{method:'POST',headers:{'Content-Type':'application/json'},body:payload,keepalive:true}).catch(()=>{});}catch{}};
  window.addEventListener('pagehide',notify,{once:true});window.addEventListener('beforeunload',notify,{once:true});
}

$('vmForm').addEventListener('submit',async e=>{e.preventDefault();try{setBusy(true);await submitJob('provision-vm',collectConfig());activateTab('vms');}catch(err){setBusy(false);log(err.message,'error');}});
$('preflightBtn').addEventListener('click',preflight);$('saveTemplateBtn').addEventListener('click',saveTemplate);$('cancelBtn').addEventListener('click',cancelJob);$('refreshBtn').addEventListener('click',()=>loadInventory(true));$('refreshDashboardBtn').addEventListener('click',()=>{loadInventory(true);loadJobs();loadSummary();});$('refreshJobsBtn').addEventListener('click',loadJobs);$('clearBtn').addEventListener('click',()=>$('console').innerHTML='');$('templatesRefresh').addEventListener('click',loadTemplates);$('policiesRefresh').addEventListener('click',loadPolicies);$('auditRefreshBtn').addEventListener('click',loadAudit);$('auditVerifyBtn').addEventListener('click',verifyAudit);$('accessRefresh').addEventListener('click',loadAccess);
$('browseFolderBtn').addEventListener('click',async()=>{try{const r=await fetch('/api/browse/folder');const d=await r.json();if(d.success&&d.path)$('storagePath').value=d.path;else if(d.error)log(d.error,'warn');}catch(e){log(e.message,'error');}});
$('browseIsoBtn').addEventListener('click',async()=>{try{const r=await fetch('/api/browse/iso');const d=await r.json();if(d.success&&d.path)$('isoPath').value=d.path;else if(d.error)log(d.error,'warn');}catch(e){log(e.message,'error');}});
$('closeDetails').addEventListener('click',closeDetails);$('closeModifyVm').addEventListener('click',closeModifyVm);$('cancelModifyVm').addEventListener('click',closeModifyVm);$('closeAuditDetail').addEventListener('click',closeAuditDetail);
$('modifyVmForm').addEventListener('submit',async e=>{e.preventDefault();try{await submitModifyVm();}catch(err){setBusy(false);log(err.message,'error');}});
$('createSwitchType').addEventListener('change',toggleCreateSwitchAdapter);$('modifySwitchType').addEventListener('change',toggleModifySwitchAdapter);
$('createSwitchForm').addEventListener('submit',async e=>{e.preventDefault();try{setBusy(true);await submitJob('create-switch',{name:$('createSwitchName').value.trim(),type:$('createSwitchType').value,adapter:$('createNetAdapter').value});e.target.reset();$('createSwitchType').value='Internal';toggleCreateSwitchAdapter();}catch(err){setBusy(false);log(err.message,'error');}});
$('modifySwitchForm').addEventListener('submit',async e=>{e.preventDefault();try{const name=$('modifySwitchName').value;if(!name)throw new Error('Select a switch to modify.');setBusy(true);await submitJob('modify-switch',{name,type:$('modifySwitchType').value,adapter:$('modifyNetAdapter').value,allowManagementOS:$('modifyAllowManagementOS').checked,notes:$('modifySwitchNotes').value.trim()});}catch(err){setBusy(false);log(err.message,'error');}});
$('refreshSwitchesBtn').addEventListener('click',async()=>{await loadInventory(true);loadSwitches();});
$('accessForm').addEventListener('submit',async e=>{e.preventDefault();await saveAccess();});

(async()=>{try{setupLifecycle();await loadConfig();toggleCreateSwitchAdapter();toggleModifySwitchAdapter();await loadInventory(true);await loadTemplates();await loadPolicies();await loadJobs();await loadSummary();log('Professional portal ready. Inventory will refresh every 15 seconds.','success');inventoryTimer=setInterval(()=>{if(!document.hidden&&!currentJob)loadInventory(false);},15000);}catch(e){$('statusBadge').textContent='Startup error';$('statusBadge').className='status bad';log(e.message,'error');}})();
