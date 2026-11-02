'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let token = '';
  let reports = [];
  let bans = [];
  let toastTimer;

  function notify(message) {
    $('adminToast').textContent = message;
    $('adminToast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('adminToast').classList.remove('show'), 2800);
  }
  function date(value) {
    try { return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
    catch { return value || '-'; }
  }
  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request gagal (${response.status})`);
    return data;
  }
  async function load() {
    $('reportList').innerHTML = '<div class="empty-state">Memuat laporan...</div>';
    try {
      const data = await request('/api/admin/reports');
      reports = data.reports || [];
      bans = data.bans || [];
      render();
      $('loginPanel').classList.add('hidden');
      $('adminContent').classList.remove('hidden');
    } catch (error) {
      $('loginPanel').classList.remove('hidden');
      $('loginError').textContent = error.message;
      $('adminContent').classList.add('hidden');
      throw error;
    }
  }
  function render() {
    const open = reports.filter((report) => report.status === 'open').length;
    $('openCount').textContent = String(open);
    $('banCount').textContent = String(bans.length);
    const filter = $('statusFilter').value;
    const filtered = reports.filter((report) => filter === 'all' || report.status === filter);
    const list = $('reportList');
    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Belum ada laporan untuk filter ini.';
      list.appendChild(empty);
    }
    filtered.forEach((report) => {
      const card = document.createElement('article');
      card.className = 'report-card';
      const top = document.createElement('div'); top.className = 'report-card-top';
      const reason = document.createElement('strong'); reason.className = 'report-reason'; reason.textContent = report.reason;
      const badge = document.createElement('span'); badge.className = `status-badge ${report.status}`; badge.textContent = report.status;
      top.append(reason, badge);
      const meta = document.createElement('div'); meta.className = 'report-meta'; meta.textContent = `Dibuat ${date(report.createdAt)}${report.updatedAt ? ` · Diperbarui ${date(report.updatedAt)}` : ''}`;
      const ids = document.createElement('div'); ids.className = 'report-ids'; ids.textContent = `Pelapor: ${report.reporterId}  |  Terlapor: ${report.reportedId}`;
      card.append(top, meta, ids);
      if (report.comment) { const comment = document.createElement('div'); comment.className = 'report-comment'; comment.textContent = report.comment; card.appendChild(comment); }
      const actions = document.createElement('div'); actions.className = 'report-actions';
      if (report.status !== 'reviewed') actions.appendChild(action('Tandai ditinjau', () => updateStatus(report.id, 'reviewed')));
      if (report.status !== 'resolved') actions.appendChild(action('Selesaikan', () => updateStatus(report.id, 'resolved')));
      const banButton = action('Blokir ID terlapor', () => banUser(report.reportedId)); banButton.classList.add('ban-action'); actions.appendChild(banButton);
      card.appendChild(actions);
      list.appendChild(card);
    });
    const banList = $('banList'); banList.replaceChildren();
    if (!bans.length) { const empty = document.createElement('div'); empty.className = 'empty-state'; empty.textContent = 'Belum ada ID yang diblokir oleh admin.'; banList.appendChild(empty); }
    bans.forEach((ban) => {
      const card = document.createElement('div'); card.className = 'ban-card';
      const details = document.createElement('div'); const id = document.createElement('strong'); id.textContent = ban.userId; const reason = document.createElement('span'); reason.textContent = `${ban.reason} · ${date(ban.createdAt)}`; details.append(id, reason);
      const button = action('Cabut blokir', () => unbanUser(ban.userId)); card.append(details, button); banList.appendChild(card);
    });
  }
  function action(label, callback) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', () => callback().catch((error) => notify(error.message)));
    return button;
  }
  async function updateStatus(id, status) { await request(`/api/admin/reports/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); notify('Status laporan diperbarui.'); }
  async function banUser(userId) {
    if (!window.confirm('Blokir ID ini dari Gomi?')) return;
    await request('/api/admin/bans', { method: 'POST', body: JSON.stringify({ userId, reason: 'Diblokir oleh moderator Gomi' }) });
    await load(); notify('ID pengguna diblokir.');
  }
  async function unbanUser(userId) {
    if (!window.confirm('Cabut blokir untuk ID ini?')) return;
    await request(`/api/admin/bans/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    await load(); notify('Blokir dicabut.');
  }
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault(); token = $('adminToken').value.trim();
    try { await load(); } catch { /* Error is shown in the login panel. */ }
  });
  $('refreshBtn').addEventListener('click', () => load().then(() => notify('Data diperbarui.')).catch((error) => notify(error.message)));
  $('logoutBtn').addEventListener('click', () => { token = ''; $('adminToken').value = ''; $('adminContent').classList.add('hidden'); $('loginPanel').classList.remove('hidden'); });
  $('statusFilter').addEventListener('change', render);
})();
