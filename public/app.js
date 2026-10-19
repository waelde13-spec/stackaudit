const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

let state = null; // { report, costs: {id: n}, manual: [{id,name,cost}] }

// ---------- scanning ----------
$('#scan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('#store').value.trim();
  if (!url) return;
  showError('');
  $('#scan-btn').disabled = true;
  show('loading');
  const stopTicker = runTicker();
  try {
    const res = await fetch('/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scan failed');
    stopTicker();
    render(data);
    show('report');
    try { history.replaceState(null, '', `?store=${encodeURIComponent(data.store)}`); } catch {}
  } catch (err) {
    stopTicker();
    show('hero');
    showError(err.message);
  } finally {
    $('#scan-btn').disabled = false;
  }
});

$('#rescan').addEventListener('click', () => {
  show('hero');
  $('#store').value = '';
  $('#store').focus();
  try { history.replaceState(null, '', location.pathname); } catch {}
});

function show(id) {
  for (const s of ['hero', 'loading', 'report']) $('#' + s).hidden = s !== id;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showError(msg) { const el = $('#scan-error'); el.textContent = msg; el.hidden = !msg; }

function runTicker() {
  const steps = [...document.querySelectorAll('[data-step]')];
  steps.forEach((s) => s.classList.remove('on', 'done'));
  let i = 0;
  steps[0].classList.add('on');
  const t = setInterval(() => {
    if (i < steps.length - 1) { steps[i].classList.replace('on', 'done'); steps[++i].classList.add('on'); }
  }, 2500);
  return () => clearInterval(t);
}

// ---------- report ----------
function render(report) {
  state = { report, costs: Object.fromEntries(report.apps.map((a) => [a.id, a.defaultCost])), manual: [] };
  $('#r-store').textContent = report.store;
  $('#r-apps').textContent = report.summary.appsDetected + (report.summary.unidentifiedEmbeds ? ` +${report.summary.unidentifiedEmbeds}` : '');
  $('#r-default').textContent = report.summary.defaultAppCost;
  const score = report.summary.score;
  $('#r-score').textContent = score;
  const dial = $('#dial');
  dial.style.setProperty('--pct', score);
  dial.style.setProperty('--dial-color', score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--warn)' : 'var(--bad)');

  renderFindings(report);
  renderHosts(report.scripts.thirdPartyHosts);
  renderBill();
  $('#lead-msg').textContent = '';
}

// Which apps are flagged depends on the merchant's real prices: in a duplicate group
// we assume they keep the one they pay most for, so savings are never overstated.
function computeRemovable() {
  const { report, costs } = state;
  const set = new Set();
  for (const f of report.findings) {
    if (f.type === 'duplicate') {
      [...f.apps].sort((a, b) => (costs[b] ?? 0) - (costs[a] ?? 0)).slice(1).forEach((id) => set.add(id));
    } else {
      (f.removable || []).forEach((id) => set.add(id));
    }
  }
  return set;
}

function renderBill() {
  const { report, costs, manual } = state;
  const cut = computeRemovable();
  const rows = report.apps.map((a) => `
    <tr data-app="${esc(a.id)}" class="${cut.has(a.id) ? 'cuttable' : ''}">
      <td><span class="app-name">${esc(a.name)}</span><span class="flag cut"${cut.has(a.id) ? '' : ' hidden'}>cuttable</span>${a.free ? '<span class="flag free">free</span>' : ''}
        <span class="app-meta">${a.confidence === 'high' ? 'detected' : 'likely'} · ${esc(a.evidence)}</span></td>
      <td>${esc(a.categoryLabel)}</td>
      <td class="num"><input type="number" min="0" step="1" data-cost="${esc(a.id)}" value="${costs[a.id]}" aria-label="Monthly cost of ${esc(a.name)}"></td>
    </tr>`);
  for (const m of manual) rows.push(`
    <tr>
      <td><span class="app-name">${esc(m.name)}</span><span class="app-meta">added by you <button class="remove" data-remove="${m.id}" aria-label="Remove ${esc(m.name)}">×</button></span></td>
      <td>—</td>
      <td class="num"><input type="number" min="0" step="1" data-cost="${m.id}" value="${m.cost}" aria-label="Monthly cost of ${esc(m.name)}"></td>
    </tr>`);
  $('#bill-rows').innerHTML = rows.join('') || '<tr><td colspan="3" class="empty">No known apps found on the storefront. Add the ones you pay for below.</td></tr>';
  updateTotals();
}

$('#bill-rows').addEventListener('input', (e) => {
  const id = e.target.dataset.cost;
  if (!id) return;
  const v = Math.max(0, Number(e.target.value) || 0);
  const m = state.manual.find((x) => x.id === id);
  if (m) m.cost = v; else state.costs[id] = v;
  updateTotals();
});
$('#bill-rows').addEventListener('click', (e) => {
  const id = e.target.dataset.remove;
  if (!id) return;
  state.manual = state.manual.filter((m) => m.id !== id);
  renderBill();
});
$('#add-app').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#add-name').value.trim();
  if (!name || !state) return;
  state.manual.push({ id: 'm' + Date.now(), name, cost: Math.max(0, Number($('#add-cost').value) || 0) });
  $('#add-name').value = ''; $('#add-cost').value = '';
  renderBill();
});

function totals() {
  const { costs, manual } = state;
  const removable = computeRemovable();
  const total = Object.values(costs).reduce((s, n) => s + n, 0) + manual.reduce((s, m) => s + m.cost, 0);
  const cut = [...removable].reduce((s, id) => s + (costs[id] || 0), 0);
  return { total, cut, removable };
}
function updateTotals() {
  const { total, cut, removable } = totals();
  for (const row of document.querySelectorAll('#bill-rows tr[data-app]')) {
    const on = removable.has(row.dataset.app);
    row.classList.toggle('cuttable', on);
    row.querySelector('.flag.cut').hidden = !on;
  }
  $('#bill-total').textContent = money(total);
  $('#bill-cut').textContent = money(cut);
  $('#r-savings').textContent = money(cut);
  $('#r-yearly').textContent = money(cut * 12);
}

function renderFindings(report) {
  const names = Object.fromEntries(report.apps.map((a) => [a.id, a.name]));
  const html = report.findings.map((f) => {
    let extra = '';
    if (f.urls?.length) extra = `<ul>${f.urls.slice(0, 6).map((u) => `<li><code>${esc(u)}</code></li>`).join('')}</ul>`;
    if (f.extensions?.length) extra = `<ul>${f.extensions.slice(0, 8).map((x) => `<li><code>${esc(x.folder)}</code></li>`).join('')}</ul>`;
    const cuts = f.type === 'duplicate' ? [] : (f.removable || []).map((id) => names[id]).filter(Boolean);
    const cutLine = cuts.length ? `<p><strong>Candidate to cut:</strong> ${cuts.map(esc).join(', ')}</p>` : '';
    return `<article class="finding ${f.severity}">
      <span class="sev">${esc(f.severity)} · ${esc(f.type)}</span>
      <h4>${esc(f.title)}</h4>
      <p>${esc(f.detail)}</p>${cutLine}${extra}
    </article>`;
  });
  $('#findings').innerHTML = html.join('') || '<p class="empty">Nothing obvious to cut — your stack looks lean. Add any apps we couldn\'t see to double-check the bill.</p>';
}

function renderHosts(hosts) {
  $('#r-hosts').textContent = hosts.length;
  $('#host-list').innerHTML = hosts.map((h) => `<li>${esc(h)}</li>`).join('') || '<li>None found</li>';
}

// ---------- lead capture ----------
$('#lead-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#lead-email').value.trim();
  const msg = $('#lead-msg');
  try {
    const res = await fetch('/api/lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, store: state?.report.store, savings: state ? totals().cut : 0 }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    msg.textContent = 'Done — check your inbox shortly.';
    $('#lead-form').reset();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// Static preview build: open straight onto a sample report.
if (window.__PRELOAD) {
  render(window.__PRELOAD.report);
  $('#notice').textContent = window.__PRELOAD.notice;
  $('#notice').hidden = false;
  for (const s of ['hero', 'loading', 'report']) $('#' + s).hidden = s !== 'report';
} else {
  // Allow sharing links like /?store=example.com
  const pre = new URLSearchParams(location.search).get('store');
  if (pre) { $('#store').value = pre; $('#scan-form').requestSubmit(); }
}
