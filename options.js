'use strict';

/* ------------------------------------------------------------ storage --- */

function getJobs() {
  return new Promise((res) =>
    chrome.storage.local.get('tracked_jobs', (r) => res((r && r.tracked_jobs) || {}))
  );
}
function setJobs(jobs) {
  return new Promise((res) => chrome.storage.local.set({ tracked_jobs: jobs }, res));
}
function getSettings() {
  return new Promise((res) =>
    chrome.storage.local.get('settings', (r) => res((r && r.settings) || {}))
  );
}
function setSettings(settings) {
  return new Promise((res) => chrome.storage.local.set({ settings }, res));
}

/* --------------------------------------------------------------- tabs --- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) =>
      p.classList.toggle('active', p.id === 'tab-' + name)
    );
  });
});

/* --------------------------------------------------------------- jobs --- */

const countEl = document.getElementById('job-count');
const bodyEl = document.getElementById('jobs-body');
const emptyEl = document.getElementById('empty');
const tableWrap = document.querySelector('.table-wrap');
const pushAllBtn = document.getElementById('push-all');
const clearAllBtn = document.getElementById('clear-all');
const pushStatus = document.getElementById('push-status');

function td(text) {
  const c = document.createElement('td');
  c.textContent = text || '—';
  return c;
}

function formatTs(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function renderRow(job) {
  const tr = document.createElement('tr');
  tr.dataset.jobId = job.job_id || '';

  const tdTitle = document.createElement('td');
  const titleDiv = document.createElement('div');
  titleDiv.className = 'job-title';
  titleDiv.textContent = job.title || '(no title)';
  const idDiv = document.createElement('div');
  idDiv.className = 'job-id';
  idDiv.textContent = job.job_id || '';
  tdTitle.append(titleDiv, idDiv);

  const tdCompany = td(job.company);
  const tdType = td(job.employment_type);
  const tdLoc = td(job.locations);
  const tdPosted = td(job.date_posted);
  tdPosted.className = 'nowrap';
  const tdSaved = td(formatTs(job.scraped_at));
  tdSaved.className = 'nowrap';

  const tdApply = document.createElement('td');
  if (job.apply_url && /^https?:\/\//i.test(job.apply_url)) {
    const a = document.createElement('a');
    a.className = 'apply-link';
    a.href = job.apply_url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = 'Open';
    tdApply.appendChild(a);
  } else {
    tdApply.textContent = '—';
  }

  const tdDel = document.createElement('td');
  const delBtn = document.createElement('button');
  delBtn.className = 'row-del';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => deleteJob(job.job_id));
  tdDel.appendChild(delBtn);

  tr.append(tdTitle, tdCompany, tdType, tdLoc, tdPosted, tdSaved, tdApply, tdDel);
  return tr;
}

async function renderJobs() {
  const jobs = await getJobs();
  const ids = Object.keys(jobs);
  // newest first by save time
  ids.sort((a, b) =>
    String(jobs[b].scraped_at || '').localeCompare(String(jobs[a].scraped_at || ''))
  );

  countEl.textContent = String(ids.length);
  bodyEl.textContent = '';
  emptyEl.hidden = ids.length !== 0;
  tableWrap.style.display = ids.length ? '' : 'none';
  pushAllBtn.disabled = ids.length === 0;
  clearAllBtn.disabled = ids.length === 0;

  for (const id of ids) bodyEl.appendChild(renderRow(jobs[id]));
}

async function deleteJob(id) {
  const jobs = await getJobs();
  delete jobs[id];
  await setJobs(jobs);
  // re-render handled by storage.onChanged
}

clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Remove all tracked jobs? This cannot be undone.')) return;
  await setJobs({});
});

/* --------------------------------------------------------- push to DB --- */

function showPush(msg, isError) {
  pushStatus.hidden = false;
  pushStatus.textContent = msg;
  pushStatus.classList.toggle('error', !!isError);
}

async function pushAll() {
  const settings = await getSettings();
  const jobs = await getJobs();
  const ids = Object.keys(jobs);

  if (ids.length === 0) return showPush('No jobs to push.', true);
  if (!settings.endpoint_url) {
    return showPush('Set an API endpoint URL in Settings first.', true);
  }

  const payloadJobs = ids.map((id) => jobs[id]);
  const headers = { 'Content-Type': 'application/json' };
  if (settings.secret) headers['x-secret'] = settings.secret;

  const body = { jobs: payloadJobs };
  if (settings.user_id) {
    const uid = parseInt(settings.user_id, 10);
    if (Number.isFinite(uid) && uid > 0) body.user_id = uid;
  }

  pushAllBtn.disabled = true;
  showPush('Pushing ' + ids.length + ' job(s)…', false);

  try {
    // NOTE: the droplet backend must allow this cross-origin request
    // (respond with Access-Control-Allow-Origin and handle OPTIONS preflight).
    const resp = await fetch(settings.endpoint_url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    });

    let data = null;
    try {
      data = await resp.json();
    } catch (e) {
      /* response was not JSON */
    }

    if (!resp.ok) {
      const detail = data && (data.error || data.message) ? ' — ' + (data.error || data.message) : '';
      return showPush('Push failed (HTTP ' + resp.status + ')' + detail, true);
    }

    // Backend response: { results: [{ job_id, canonical_job_id, status, user_job }] }
    //   status: "inserted" | "skipped_existing_id" | "skipped_matched_by_content" | "error"
    //   user_job: "created" | "already_existed" | "not_configured"
    let inserted = [];
    let skippedById = [];
    let skippedByMatch = [];
    let userJobsCreated = 0;
    let userJobsExisted = 0;
    const errors = [];
    if (data && Array.isArray(data.results)) {
      for (const r of data.results) {
        if (!r) continue;
        if (r.status === 'inserted' || r.status === 'updated') inserted.push(r.job_id);
        else if (r.status === 'skipped_existing_id') skippedById.push(r.job_id);
        else if (r.status === 'skipped_matched_by_content') skippedByMatch.push(r.job_id);
        else if (r.status === 'skipped') skippedById.push(r.job_id); // tolerate older servers
        else if (r.status === 'error') errors.push(r);
        if (r.user_job === 'created') userJobsCreated++;
        else if (r.user_job === 'already_existed') userJobsExisted++;
      }
    } else {
      // OK response without per-row results: assume everything went in.
      inserted = ids.slice();
    }

    // Anything that made it to the DB (whether newly inserted or already
    // there) is removed from the local list — keeping it adds clutter and
    // the user_jobs entry now tracks the user's interest server-side.
    const toRemove = [...inserted, ...skippedById, ...skippedByMatch];
    if (toRemove.length) {
      const fresh = await getJobs();
      for (const id of toRemove) delete fresh[id];
      await setJobs(fresh);
    }

    const lines = [];
    lines.push(inserted.length + ' inserted, removed from the list.');
    if (skippedById.length) lines.push(skippedById.length + ' already in DB (same job_id) — removed from list.');
    if (skippedByMatch.length) lines.push(skippedByMatch.length + ' already in DB (same role + company under a different id) — removed from list.');
    if (body.user_id) {
      lines.push('User ' + body.user_id + ' marked as "Awaiting" on ' + userJobsCreated + ' job(s) (' + userJobsExisted + ' already had a row).');
    }
    if (errors.length) {
      lines.push(errors.length + ' failed:');
      for (const e of errors) lines.push('• ' + (e.job_id || '?') + ': ' + (e.error || 'error'));
    }
    showPush(lines.join('\n'), errors.length > 0);
  } catch (err) {
    showPush('Couldn’t reach the endpoint: ' + (err && err.message ? err.message : String(err)), true);
  } finally {
    pushAllBtn.disabled = false;
  }
}

pushAllBtn.addEventListener('click', pushAll);

/* ----------------------------------------------------------- settings --- */

const SETTING_FIELDS = ['endpoint_url', 'secret', 'user_id'];
const settingsForm = document.getElementById('settings-form');
const settingsSaved = document.getElementById('settings-saved');

async function loadSettings() {
  const s = await getSettings();
  for (const f of SETTING_FIELDS) {
    const el = document.getElementById(f);
    if (el) el.value = s[f] || '';
  }
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = {};
  for (const f of SETTING_FIELDS) {
    const el = document.getElementById(f);
    s[f] = el ? el.value.trim() : '';
  }
  await setSettings(s);
  settingsSaved.hidden = false;
  setTimeout(() => (settingsSaved.hidden = true), 1800);
});

/* --------------------------------------------------------------- init --- */

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.tracked_jobs) renderJobs();
});

renderJobs();
loadSettings();
