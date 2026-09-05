import { convex } from './auth.js';
import { anyApi as api } from 'convex/server';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mb = bytes => (bytes / 1e6).toLocaleString(undefined, {maximumFractionDigits:1});
const date = value => new Date(value).toLocaleString();
let cursor = null, email = '', selected = null;
const paginationOpts = cursor => ({cursor,numItems:25});
async function mutate(name, args, status, after) {
  status.textContent = 'Saving…';
  try { await convex.mutation(api.admin[name],args); status.textContent='Saved.'; await after?.(); }
  catch(e) { status.textContent=e.message; }
}
export async function renderAdmin() {
  cursor=null;
  const root=document.getElementById('admin-root');
  root.innerHTML='<p class="hint">Loading administration…</p>';
  try {
    const overview=await convex.query(api.admin.overview,{});
    root.innerHTML=`<div class="admin-summary"><div><span class="hint">Cloud storage, including pending uploads</span><h2>${mb(overview.usedBytes)} / ${mb(overview.appBytes)} MB</h2></div><div><span class="hint">Default per account</span><h2>${mb(overview.userBytes)} MB</h2></div></div>
    <details class="settings-section"><summary>Change storage policy</summary><form id="admin-policy" class="admin-form"><label>Default account limit (MB)<input name="user" type="number" min="0" step="0.001" required value="${overview.userBytes/1e6}"></label><label>Base app ceiling (MB), plus paid capacity<input name="app" type="number" min="0" step="0.001" required value="${overview.baseAppBytes/1e6}"></label><label>Reason<input name="reason" required minlength="3" maxlength="500"></label><button class="btn-primary">Save policy</button><p role="status"></p></form><p class="hint">Lowering a limit pauses new uploads when usage exceeds it. Existing files are preserved. Per-account overrides take precedence over the default.</p></details>
    <div class="admin-columns"><div><form id="admin-search" class="admin-search"><input name="email" type="search" placeholder="Find by exact email" aria-label="Find account by exact email" value="${esc(email)}"><button class="btn-ghost">Search</button><button type="button" id="admin-reset" class="btn-ghost">All users</button></form><div id="admin-accounts"></div><button id="admin-next" class="btn-ghost">Next page</button></div><div id="admin-account"><p class="hint">Select an account to manage access, storage, devices, and jobs.</p></div></div><details class="settings-section"><summary>Audit history</summary><div id="admin-history"></div><button id="admin-history-more" class="btn-ghost">Load more</button></details>`;
    const policy=root.querySelector('#admin-policy');
    policy.onsubmit=event=>{event.preventDefault();const d=new FormData(policy);mutate('updatePolicy',{userBytes:Math.round(Number(d.get('user'))*1e6),appBytes:Math.round(Number(d.get('app'))*1e6),reason:d.get('reason')},policy.querySelector('[role=status]'),renderAdmin);};
    root.querySelector('#admin-search').onsubmit=e=>{e.preventDefault();email=new FormData(e.currentTarget).get('email').trim();cursor=null;loadAccounts();};
    root.querySelector('#admin-reset').onclick=()=>{email='';cursor=null;root.querySelector('[name=email]').value='';loadAccounts();};
    root.querySelector('#admin-next').onclick=()=>loadAccounts();
    let historyCursor=null;
    const loadHistory=async()=>{
      try {
        const result=await convex.query(api.admin.history,{paginationOpts:paginationOpts(historyCursor)});
        const target=root.querySelector('#admin-history');
        for(const row of result.page){const item=document.createElement('p');item.className='audit-item';item.textContent=`${date(row.at)} · ${row.action} · ${row.targetId} · ${row.reason} (by ${row.actorId})`;target.append(item);}
        if(!result.page.length&&!historyCursor)target.textContent='No admin changes yet.';
        historyCursor=result.continueCursor;root.querySelector('#admin-history-more').hidden=result.isDone;
      }catch(e){root.querySelector('#admin-history').textContent=e.message;}
    };
    root.querySelector('#admin-history-more').onclick=loadHistory;
    await Promise.all([loadAccounts(),loadHistory()]);
    if(selected)await loadAccount(selected);
  } catch(e){root.textContent=e.message;}
}
async function loadAccounts() {
  const target=document.getElementById('admin-accounts');
  try {
    const result=await convex.query(api.admin.accounts,{paginationOpts:paginationOpts(cursor),...(email?{email}:{})});
    target.innerHTML=result.page.map(u=>`<button class="admin-user" data-id="${esc(u.id)}"><strong>${esc(u.name||u.email||'Unnamed account')}${u.admin?' · Admin':''}</strong><span>${esc(u.email)}</span><span>${esc(u.status.replace('_',' '))} · ${mb(u.usedBytes)} / ${mb(u.limitBytes)} MB</span></button>`).join('')||'<p class="hint">No accounts found.</p>';
    target.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>loadAccount(b.dataset.id));
    cursor=result.continueCursor;document.getElementById('admin-next').hidden=result.isDone;
  }catch(e){target.textContent=e.message;}
}
async function loadAccount(id) {
  selected=id;const target=document.getElementById('admin-account');
  try{
    const u=await convex.query(api.admin.account,{id});
    if(selected!==id)return;
    target.innerHTML=`<div class="settings-section"><h2>${esc(u.name||'Account')}</h2><p>${esc(u.email)} ${u.emailVerified?'· Verified':''}</p><p class="hint">Joined ${esc(date(u.createdAt))}</p><p class="hint">${mb(u.usedBytes)} MB stored · effective limit ${mb(u.limitBytes)} MB</p>
    <form class="admin-form" id="admin-edit"><label>Account access<select name="status" ${u.admin?'disabled':''}>${[['active','Active'],['export_only','Export only — playback and export'],['suspended','Suspended — block access']].map(([value,label])=>`<option value="${value}" ${u.status===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Storage override (MB)<input name="limit" type="number" min="0" step="0.001" placeholder="Use app default" value="${u.byteLimit===null?'':u.byteLimit/1e6}"></label><p class="hint">Leave blank to use the default. Zero blocks new uploads. The app-wide ceiling always applies.</p><label>Private admin notes<textarea name="notes" maxlength="4000">${esc(u.notes)}</textarea></label><label>Reason for change<input name="reason" minlength="3" maxlength="500" required></label><button class="btn-primary">Save account</button><p role="status"></p></form></div>
    <div class="settings-section"><h3>Connected computers</h3>${u.devices.map(d=>`<div class="admin-item"><span>${esc(d.name)} ${d.revoked?'· Revoked':''}</span>${!d.revoked?`<button class="btn-ghost" data-revoke="${esc(d.id)}">Revoke</button>`:''}</div>`).join('')||'<p class="hint">No paired computers.</p>'}</div>
    <div class="settings-section"><h3>Recent processing jobs</h3>${u.jobs.map(j=>`<div class="admin-item"><div>${esc(j.label)}<p class="hint">${esc(j.status)} · ${esc(j.stage)}</p>${j.error?`<p class="hint">${esc(j.error)}</p>`:''}</div>${['queued','running'].includes(j.status)?`<button class="btn-ghost" data-cancel="${esc(j.id)}">Cancel</button>`:''}</div>`).join('')||'<p class="hint">No jobs.</p>'}</div><p id="admin-action-status" role="status"></p>`;
    const form=target.querySelector('#admin-edit');
    form.onsubmit=e=>{e.preventDefault();const d=new FormData(form);mutate('updateAccount',{id,status:d.get('status')||u.status,byteLimit:d.get('limit')===''?null:Math.round(Number(d.get('limit'))*1e6),notes:d.get('notes'),reason:d.get('reason')},form.querySelector('[role=status]'),()=>loadAccount(id));};
    const operation=(name,recordId)=>{const reason=window.prompt('Reason for this admin action:');if(reason===null)return;mutate(name,{id:recordId,reason},target.querySelector('#admin-action-status'),()=>loadAccount(id));};
    target.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=()=>operation('revokeDevice',b.dataset.revoke));
    target.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=()=>operation('cancelJob',b.dataset.cancel));
  }catch(e){target.textContent=e.message;}
}
