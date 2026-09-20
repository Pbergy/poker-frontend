const API_BASE = window.API_BASE || 'https://table-stakes-backend-vj1i-production.up.railway.app';
const WS_BASE = window.WS_BASE || API_BASE.replace(/^http/, 'ws');

const state = {
  token: localStorage.getItem('ts_token') || null,
  user: JSON.parse(localStorage.getItem('ts_user') || 'null'),
  roomId: null,
  room: null,
  ws: null,
  pollTimer: null,
  isReady: false,
  isSpectating: false
};

// ---------- sound effects (synthesized, no external audio files) ----------
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playSound(kind) {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);

    if (kind === 'deal') {
      osc.type = 'triangle'; osc.frequency.setValueAtTime(520, now);
      gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.start(now); osc.stop(now + 0.12);
    } else if (kind === 'chip') {
      osc.type = 'square'; osc.frequency.setValueAtTime(800, now);
      gain.gain.setValueAtTime(0.05, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.start(now); osc.stop(now + 0.06);
    } else if (kind === 'win') {
      [660, 880, 1100].forEach((freq, i) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine'; o.frequency.setValueAtTime(freq, now + i * 0.1);
        g.gain.setValueAtTime(0.07, now + i * 0.1); g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.25);
        o.start(now + i * 0.1); o.stop(now + i * 0.1 + 0.25);
      });
    }
  } catch (e) { /* audio not available/allowed yet — non-fatal */ }
}

// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) {
    localStorage.removeItem('ts_token');
    localStorage.removeItem('ts_user');
    localStorage.removeItem('ts_room');
    state.token = null; state.user = null;
    showView('auth');
    showToast('Your session expired — please log in again');
    throw new Error('Session expired');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $(`#view-${name}`).classList.remove('hidden');
}

function cardColor(card) {
  return (card.includes('♥') || card.includes('♦')) ? 'red' : '';
}

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 42%)`;
}

function avatarHtml(username) {
  const initial = (username || '?').charAt(0).toUpperCase();
  return `<div class="avatar" style="background:${avatarColor(username || '?')}">${initial}</div>`;
}

function renderCard(card, faceDown = false) {
  if (faceDown || card === '??') return `<div class="playing-card back"></div>`;
  const suit = card.slice(-1);
  const rank = card.slice(0, -1);
  return `<div class="playing-card ${cardColor(card)}">
    <span class="card-corner card-corner-top">${rank}<br>${suit}</span>
    <span class="card-suit-big">${suit}</span>
    <span class="card-corner card-corner-bottom">${rank}<br>${suit}</span>
  </div>`;
}

// ---------- auth ----------
$$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  $$('.tab-btn').forEach(b => b.classList.remove('active'));
  $$('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  $(`#form-${btn.dataset.tab}`).classList.add('active');
}));

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: { username: $('#login-username').value, password: $('#login-password').value }
    });
    onAuthed(data);
    if (data.depositNotification) showToast(data.depositNotification);
  } catch (err) { showToast(err.message); }
});

$('#form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: {
        username: $('#register-username').value,
        email: $('#register-email').value,
        password: $('#register-password').value
      }
    });
    showToast('Account created — log in to continue');
    $$('.tab-btn')[0].click();
  } catch (err) { showToast(err.message); }
});

function onAuthed(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('ts_token', state.token);
  localStorage.setItem('ts_user', JSON.stringify(state.user));
  enterLobby();
}

$('#btn-logout').addEventListener('click', () => {
  localStorage.removeItem('ts_token');
  localStorage.removeItem('ts_user');
  state.token = null; state.user = null;
  showView('auth');
});

// ---------- lobby ----------
function enterLobby() {
  $('#lobby-username').textContent = state.user.username;
  $('#lobby-avatar').innerHTML = avatarHtml(state.user.username);
  $('#lobby-admin-badge').classList.toggle('hidden', !state.user.is_admin);
  $('#btn-manage-chips').classList.toggle('hidden', !state.user.is_admin);
  showView('lobby');
  loadPublicRooms();
  ensureAdminRoomUI();
  loadInvitedRooms();
  refreshMyBalance();
}

async function refreshMyBalance() {
  try {
    const stats = await api('/api/players/me/stats');
    const badge = document.getElementById('lobby-balance');
    if (badge) badge.textContent = `${stats.balance} chips`;

    // is_admin is baked into the login token, so it only reflects reality as of whenever
    // you last logged in. If the account was promoted since then (e.g. via the
    // ADMIN_USERNAME bootstrap), resync it here instead of requiring a fresh login.
    if (stats.is_admin !== state.user.is_admin) {
      state.user.is_admin = stats.is_admin;
      localStorage.setItem('ts_user', JSON.stringify(state.user));
      $('#lobby-admin-badge').classList.toggle('hidden', !state.user.is_admin);
      $('#btn-manage-chips').classList.toggle('hidden', !state.user.is_admin);
      if (state.user.is_admin) ensureAdminRoomUI();
    }
  } catch (err) { /* non-fatal */ }
}

async function loadInvitedRooms() {
  try {
    const rooms = await api('/api/rooms/invited');
    let card = document.getElementById('invited-rooms-card');
    if (rooms.length === 0) { if (card) card.remove(); return; }
    if (!card) {
      card = document.createElement('div');
      card.id = 'invited-rooms-card';
      card.className = 'card';
      card.innerHTML = '<h2>Private Tables You\'re Invited To</h2><div id="invited-rooms-list"></div>';
      $('.lobby-grid').appendChild(card);
    }
    $('#invited-rooms-list').innerHTML = rooms.map(r => `
      <div class="room-row">
        <div><strong>${r.name}</strong><div class="room-meta">Code ${r.room_code}</div></div>
        <button class="btn-primary small" data-jointinvited="${r.id}">Join</button>
      </div>`).join('');
    card.querySelectorAll('[data-jointinvited]').forEach(b => b.addEventListener('click', () => joinRoomById(b.dataset.jointinvited)));
  } catch (err) { /* not fatal on lobby load */ }
}

async function loadPublicRooms() {
  try {
    const rooms = await api('/api/rooms');
    const list = $('#public-rooms-list');
    if (rooms.length === 0) { list.innerHTML = '<p class="muted">No public rooms yet.</p>'; return; }
    list.innerHTML = rooms.map(r => `
      <div class="room-row">
        <div>
          <div><strong>${r.name}</strong></div>
          <div class="room-meta">Code ${r.room_code} &middot; up to ${r.max_players} players</div>
        </div>
        <button class="btn-primary small" data-room="${r.id}">Join</button>
      </div>`).join('');
    list.querySelectorAll('button[data-room]').forEach(btn => {
      btn.addEventListener('click', () => joinRoomById(btn.dataset.room));
    });
  } catch (err) { showToast(err.message); }
}

function ensureAdminRoomUI() {
  if (!state.user.is_admin) return;
  if ($('#admin-room-card')) return;
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'admin-room-card';
  card.innerHTML = `
    <h2>Your Private Table</h2>
    <p class="hint">Invite-only &mdash; only people you add by username can join.</p>
    <div id="admin-room-info"><p class="muted">Loading&hellip;</p></div>
    <button id="btn-create-admin-room" class="btn-link">+ Create another private table</button>
  `;
  $('.lobby-grid').appendChild(card);
  $('#btn-create-admin-room').addEventListener('click', createAdminRoom);
  loadMyAdminRooms();
}

async function loadMyAdminRooms(isRetry = false) {
  try {
    const rooms = await api('/api/admin/rooms');
    const mine = rooms.filter(r => r.is_admin_room);
    const infoEl = $('#admin-room-info');
    if (!infoEl) return;
    if (mine.length === 0) { infoEl.innerHTML = '<p class="muted">Setting up your table&hellip;</p>'; return; }
    infoEl.innerHTML = mine.map(r => `
      <div class="room-row">
        <div><strong>${r.name}</strong><div class="room-meta">Code ${r.room_code}</div></div>
        <div style="display:flex; gap:6px;">
          <button class="btn-link" data-rename="${r.id}">Rename</button>
          <button class="btn-link" data-invite="${r.id}">Invite</button>
          <button class="btn-primary small" data-joinadmin="${r.id}">Join</button>
          <button class="btn-link" data-deleteroom="${r.id}" style="color:#ff9aa8;">Delete</button>
        </div>
      </div>`).join('');
    infoEl.querySelectorAll('[data-invite]').forEach(b => b.addEventListener('click', () => openInviteModal(b.dataset.invite)));
    infoEl.querySelectorAll('[data-joinadmin]').forEach(b => b.addEventListener('click', () => joinRoomById(b.dataset.joinadmin)));
    infoEl.querySelectorAll('[data-rename]').forEach(b => b.addEventListener('click', async () => {
      const current = mine.find(r => r.id === b.dataset.rename)?.name || '';
      const name = prompt('Rename this table:', current);
      if (name === null || !name.trim()) return;
      try {
        await api(`/api/admin/rooms/${b.dataset.rename}/rename`, { method: 'PATCH', body: { name: name.trim() } });
        loadMyAdminRooms();
      } catch (err) { showToast(err.message); }
    }));
    infoEl.querySelectorAll('[data-deleteroom]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this table? Everyone seated in it will be removed.')) return;
      await api(`/api/admin/rooms/${b.dataset.deleteroom}`, { method: 'DELETE' }).catch(err => showToast(err.message));
      loadMyAdminRooms();
    }));
  } catch (err) {
    // Don't let a transient failure make the private table look like it disappeared —
    // retry once automatically, and only then show a visible, actionable error.
    if (!isRetry) { setTimeout(() => loadMyAdminRooms(true), 1500); return; }
    const infoEl = $('#admin-room-info');
    if (infoEl) infoEl.innerHTML = `<p class="muted">Couldn't load your table &mdash; <button class="btn-link" id="retry-admin-rooms">retry</button></p>`;
    document.getElementById('retry-admin-rooms')?.addEventListener('click', () => loadMyAdminRooms());
  }
}

async function createAdminRoom() {
  const name = prompt('Name this table:', `${state.user.username}'s Table`);
  if (name === null) return; // cancelled
  try {
    const room = await api('/api/admin/rooms', { method: 'POST', body: { name: name.trim() || `${state.user.username}'s Table` } });
    showToast(`"${room.name}" created — code ${room.room_code}`);
    loadMyAdminRooms();
  } catch (err) { showToast(err.message); }
}

let inviteRoomId = null;
function openInviteModal(roomId) {
  inviteRoomId = roomId;
  $('#modal-invite').classList.remove('hidden');
  loadInvites();
}
$('#btn-close-invite').addEventListener('click', () => $('#modal-invite').classList.add('hidden'));

async function loadInvites() {
  try {
    const invites = await api(`/api/admin/rooms/${inviteRoomId}/invites`);
    $('#invite-list').innerHTML = invites.map(i => `
      <div class="invite-row">
        <span>${i.username} (${i.status})${i.chips != null ? ` &mdash; ${i.chips} chips` : ''}</span>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="number" class="give-chips-amount" data-user="${i.username}" placeholder="amount" min="0" style="width:70px; margin:0; padding:4px;">
          <button class="btn-link" data-give="${i.username}">Give</button>
          <button class="btn-link" data-take="${i.username}" style="color:#ff9aa8;">Take</button>
          ${i.chips != null ? `<button class="btn-link" data-kick="${i.username}" style="color:#ff9aa8;">Kick</button>` : ''}
          <button class="btn-link" data-revoke="${i.username}" style="color:#ff9aa8;">remove</button>
        </div>
      </div>`).join('') || '<p class="muted">No invites yet.</p>';
    $$('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/admin/rooms/${inviteRoomId}/invite/${b.dataset.revoke}`, { method: 'DELETE' });
      loadInvites();
    }));
    $$('[data-kick]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm(`Kick ${b.dataset.kick} from this table? Their chips there will be cashed out to their balance.`)) return;
      try {
        const result = await api(`/api/admin/rooms/${inviteRoomId}/kick`, { method: 'POST', body: { username: b.dataset.kick } });
        showToast(`Kicked ${b.dataset.kick}${result.cashedOut > 0 ? ` — cashed out ${result.cashedOut} chips` : ''}`);
        loadInvites();
      } catch (err) { showToast(err.message); }
    }));
    const doAdjust = async (username, sign) => {
      const input = document.querySelector(`.give-chips-amount[data-user="${username}"]`);
      const amount = Math.abs(Number(input.value)) * sign;
      if (!amount) return;
      try {
        await api(`/api/admin/rooms/${inviteRoomId}/give-chips`, { method: 'POST', body: { username, amount } });
        showToast(`${amount > 0 ? 'Gave' : 'Took'} ${Math.abs(amount)} chips ${amount > 0 ? 'to' : 'from'} ${username}`);
        loadInvites();
      } catch (err) { showToast(err.message); }
    };
    $$('[data-give]').forEach(b => b.addEventListener('click', () => doAdjust(b.dataset.give, 1)));
    $$('[data-take]').forEach(b => b.addEventListener('click', () => doAdjust(b.dataset.take, -1)));
  } catch (err) { showToast(err.message); }
}

$('#form-invite').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/api/admin/rooms/${inviteRoomId}/invite`, { method: 'POST', body: { username: $('#invite-username').value } });
    $('#invite-username').value = '';
    loadInvites();
  } catch (err) { showToast(err.message); }
});

$('#form-create-room').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const room = await api('/api/rooms', {
      method: 'POST',
      body: {
        name: $('#create-room-name').value,
        maxPlayers: Number($('#create-room-max').value),
        settings: {
          smallBlind: Number($('#create-room-sb').value),
          bigBlind: Number($('#create-room-bb').value)
        }
      }
    });
    await joinRoomById(room.id);
  } catch (err) { showToast(err.message); }
});

$('#form-join-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const code = $('#join-room-code').value.trim().toUpperCase();
    const room = await api(`/api/rooms/${code}`);
    await joinRoomById(room.id);
  } catch (err) { showToast(err.message); }
});

async function joinRoomById(roomId) {
  try {
    await api(`/api/rooms/${roomId}/join`, { method: 'POST' }).catch((e) => {
      // Already seated is fine, anything else surface to the user
      if (!/already|duplicate/i.test(e.message)) throw e;
    });
    enterTable(roomId);
  } catch (err) { showToast(err.message); }
}

// ---------- table ----------
async function enterTable(roomId) {
  state.roomId = roomId;
  localStorage.setItem('ts_room', roomId);
  showView('table');
  await refreshRoomHeader(roomId);
  connectWS(roomId);
  await refreshTable();
  loadChat(roomId);
  loadHandLog(roomId);
  loadHandHistory(roomId);
}

async function refreshRoomHeader(roomId) {
  try {
    const room = await api(`/api/rooms/id/${roomId}`).catch(() => null);
    $('#table-room-name').textContent = room ? room.name : 'Table';
    state.currentRoomIsAdminRoom = !!(room && room.is_admin_room);
    state.currentRoomMaxPlayers = room?.max_players || null;

    const players = await loadRoomPlayers();
    const mine = players.find(p => p.user_id === state.user.id);
    state.isSpectating = state.currentRoomIsAdminRoom && (!mine || !mine.wants_to_play);

    $('#btn-table-invite').classList.add('hidden');
    if (state.user.is_admin && room && room.is_admin_room) {
      $('#btn-table-invite').classList.remove('hidden');
      $('#btn-table-invite').onclick = () => openInviteModal(roomId);
    }

    // Only private (admin) tables have a play/spectate choice at all.
    $('#btn-join-hand').classList.toggle('hidden', !state.currentRoomIsAdminRoom || !state.isSpectating);
    $('#btn-spectate').classList.toggle('hidden', !state.currentRoomIsAdminRoom || state.isSpectating);
    $('#btn-ready').classList.toggle('hidden', state.isSpectating);
  } catch (e) { /* non-fatal */ }
}

$('#btn-join-hand').addEventListener('click', async () => {
  try {
    await api(`/api/rooms/${state.roomId}/play`, { method: 'POST', body: { playing: true } });
    await refreshRoomHeader(state.roomId);
    refreshTable();
  } catch (err) { showToast(err.message); }
});

$('#btn-spectate').addEventListener('click', async () => {
  try {
    await api(`/api/rooms/${state.roomId}/play`, { method: 'POST', body: { playing: false } });
    await refreshRoomHeader(state.roomId);
    refreshTable();
  } catch (err) { showToast(err.message); }
});

$('#btn-leave-table').addEventListener('click', async () => {
  state.leavingTable = true;
  if (state.ws) state.ws.close();
  if (state.pollTimer) clearInterval(state.pollTimer);

  // Private tables cash your chips back to your account balance on the way out —
  // otherwise they'd just be stranded at that table forever.
  if (state.currentRoomIsAdminRoom && !state.isSpectating) {
    try {
      const result = await api(`/api/rooms/${state.roomId}/leave`, { method: 'POST' });
      if (result.cashedOut > 0) showToast(`Cashed out ${result.cashedOut} chips to your balance`);
    } catch (err) { showToast(err.message); }
  }

  state.roomId = null;
  localStorage.removeItem('ts_room');
  showView('lobby');
  loadPublicRooms();
  refreshMyBalance();
});

$('#btn-ready').addEventListener('click', async () => {
  try {
    const nowReady = !state.isReady;
    const result = await api(`/api/rooms/${state.roomId}/ready`, { method: 'POST', body: { ready: nowReady } });
    state.isReady = result.ready;
    updateReadyButton();
    if (result.dealt) showToast('Everyone\'s in — dealing!');
  } catch (err) { showToast(err.message); }
});

function updateReadyButton() {
  const btn = $('#btn-ready');
  btn.textContent = state.isReady ? 'Cancel Ready' : "I'm Ready";
  btn.classList.toggle('btn-action', state.isReady);
}

function connectWS(roomId) {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  state.leavingTable = false;
  state.wsRetryDelay = 1000;

  const ws = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', userId: state.user.id, roomId }));
    state.wsRetryDelay = 1000;
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  });
  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'game_update') renderGameState(msg.data);
    else if (msg.type === 'chat') appendChatMessage(msg);
    else if (msg.type === 'ready_update') applyReadyUpdate(msg.players);
    else if (msg.type === 'presence') loadRoomPlayers().then(() => refreshTable());
    else if (msg.type === 'hand_complete') { loadHandLog(roomId); loadHandHistory(roomId); playSound('win'); }
    else if (msg.type === 'error') showToast(msg.message);
  });
  ws.addEventListener('close', (evt) => {
    // A bad/expired token will just fail the same way forever — don't keep retrying,
    // send the person back to login instead.
    if (evt.code === 4001 || evt.code === 4003) {
      showToast('Your session is no longer valid — please log in again');
      localStorage.removeItem('ts_token'); localStorage.removeItem('ts_user'); localStorage.removeItem('ts_room');
      state.token = null; state.user = null;
      showView('auth');
      return;
    }
    // Fall back to REST polling immediately, and keep trying to re-establish the socket
    // with backoff (capped at 10s) so a dropped connection heals itself automatically.
    if (!state.pollTimer) state.pollTimer = setInterval(refreshTable, 2500);
    if (!state.leavingTable && state.roomId === roomId) {
      setTimeout(() => { if (state.roomId === roomId) connectWS(roomId); }, state.wsRetryDelay);
      state.wsRetryDelay = Math.min(state.wsRetryDelay * 2, 10000);
    }
  });
}

async function refreshTable() {
  try {
    const gameRow = await api(`/api/game/rooms/${state.roomId}/state`);
    renderGameState(gameRow);
  } catch (err) { /* no active hand yet */ }
}

let lastRoomPlayers = [];
async function loadRoomPlayers() {
  lastRoomPlayers = await api(`/api/players/room/${state.roomId}`).catch(() => []);
  const mine = lastRoomPlayers.find(p => p.user_id === state.user.id);
  if (mine) { state.isReady = !!mine.is_ready; updateReadyButton(); }
  return lastRoomPlayers;
}

function applyReadyUpdate(players) {
  players.forEach(p => {
    const entry = lastRoomPlayers.find(rp => rp.user_id === p.user_id);
    if (entry) entry.is_ready = p.is_ready;
    if (p.user_id === state.user.id) { state.isReady = p.is_ready; updateReadyButton(); }
  });
  // Only meaningful while waiting for a hand — re-render idle seats if that's what's showing
  if ($('#action-bar').classList.contains('hidden') && $('#seats').querySelector('.seat')) {
    $('#seats').innerHTML = lastRoomPlayers.map((p, i) => renderIdleSeat(p, i, lastRoomPlayers.length)).join('');
  }
}

async function renderGameState(gameRow) {
  // The player list (usernames, idle chip counts) rarely changes mid-hand, so it's cached
  // and only refetched when actually stale — not on every single action broadcast.
  const players = lastRoomPlayers.length ? lastRoomPlayers : await loadRoomPlayers();
  const gs = gameRow && gameRow.game_state;

  if (!gs || gameRow.status === 'no_game') {
    const totalSeats = Math.max(players.length, state.currentRoomMaxPlayers || 0, 2);
    const seatHtml = [];
    for (let i = 0; i < totalSeats; i++) {
      seatHtml.push(players[i] ? renderIdleSeat(players[i], i, totalSeats) : renderEmptySeat(i, totalSeats));
    }
    $('#seats').innerHTML = seatHtml.join('');
    $('#community-cards').innerHTML = '';
    $('#pot-display').innerHTML = '<span class="chip-icon"></span> Pot: 0';
    $('#table-pot-badge').innerHTML = '<span class="chip-icon"></span> Pot: 0';
    $('#action-bar').classList.add('hidden');
    state.lastHandNumber = null;
    return;
  }

  if (gs.handNumber !== state.lastHandNumber) {
    if (state.lastHandNumber !== undefined && state.lastHandNumber !== null) playSound('deal');
    state.lastHandNumber = gs.handNumber;
  }

  $('#community-cards').innerHTML = gs.community.map(c => renderCard(c)).join('');
  const potNow = gs.pot + gs.players.reduce((s, p) => s + p.committed, 0);
  $('#pot-display').innerHTML = `<span class="chip-icon"></span> Pot: ${potNow}`;
  $('#table-pot-badge').innerHTML = `<span class="chip-icon"></span> Pot: ${potNow}`;

  const seatsHtml = gs.players.map((p, i) => {
    const angle = (2 * Math.PI * i) / gs.players.length - Math.PI / 2;
    const x = 50 + 42 * Math.cos(angle);
    const y = 50 + 40 * Math.sin(angle);
    const isDealer = i === gs.dealerPos;
    const isActing = i === gs.currentTurnPos && gs.stage !== 'complete';
    const showFaceUp = p.id === state.user.id || gs.stage === 'complete' || gs.stage === 'showdown';
    const won = (gs.potBreakdown || []).some(pb => pb.winners.some(w => w.id === p.id));

    const username = p.id === state.user.id ? 'You' : (players.find(rp => rp.user_id === p.id)?.username || 'Player');

    return `<div class="seat ${p.folded ? 'folded' : ''} ${isActing ? 'acting' : ''}" style="left:${x}%; top:${y}%;">
      <div class="seat-card">
        ${isDealer ? '<div class="dealer-chip">D</div>' : ''}
        ${avatarHtml(username)}
        <div class="seat-name">${username}</div>
        <div class="seat-chips"><span class="chip-icon"></span>${p.chips} chips</div>
        ${p.committed ? `<div class="seat-bet">Bet ${p.committed}</div>` : ''}
        <div class="seat-cards">${p.holeCards.map(c => renderCard(c, !showFaceUp && c !== '??' ? false : c === '??')).join('')}</div>
        ${won ? '<div class="win-banner">WINS</div>' : ''}
        ${adminChipControlsHtml(username)}
      </div>
    </div>`;
  }).join('');
  $('#seats').innerHTML = seatsHtml;

  if (gs.stage === 'complete') {
    setTimeout(() => { if (state.roomId) refreshTable(); }, 4000);
  }

  updateActionBar(gs);
}

function seatPosition(i, total) {
  const angle = (2 * Math.PI * i) / total - Math.PI / 2;
  return { x: 50 + 42 * Math.cos(angle), y: 50 + 40 * Math.sin(angle) };
}

// Compact inline give/take controls shown on a seat when the viewer is the admin of this
// private table — lets chips be adjusted mid-hand without leaving the table view.
function adminChipControlsHtml(username) {
  if (!state.user.is_admin || !state.currentRoomIsAdminRoom || username === state.user.username || username === 'You') return '';
  return `<div class="seat-admin-controls">
    <button class="chip-adjust-btn" data-chip-adjust="${username}" data-sign="1">+</button>
    <button class="chip-adjust-btn" data-chip-adjust="${username}" data-sign="-1">&minus;</button>
  </div>`;
}

// One delegated listener handles every seat's +/- buttons, since seats are re-rendered often.
$('#seats').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-chip-adjust]');
  if (!btn) return;
  const username = btn.dataset.chipAdjust;
  const sign = Number(btn.dataset.sign);
  const raw = prompt(`${sign > 0 ? 'Give' : 'Take'} how many chips ${sign > 0 ? 'to' : 'from'} ${username}?`);
  const amount = Math.abs(Number(raw)) * sign;
  if (!raw || !amount) return;
  try {
    await api(`/api/admin/rooms/${state.roomId}/give-chips`, { method: 'POST', body: { username, amount } });
    showToast(`${amount > 0 ? 'Gave' : 'Took'} ${Math.abs(amount)} chips ${amount > 0 ? 'to' : 'from'} ${username}`);
    refreshTable();
  } catch (err) { showToast(err.message); }
});

function renderEmptySeat(i, total) {
  const { x, y } = seatPosition(i, total);
  return `<div class="seat empty-seat" style="left:${x}%; top:${y}%;">
    <div class="seat-card">
      <div class="empty-seat-label">Empty Seat</div>
    </div>
  </div>`;
}

function renderIdleSeat(p, i, total) {
  const { x, y } = seatPosition(i, total);
  return `<div class="seat ${p.is_ready ? 'ready' : ''}" style="left:${x}%; top:${y}%;">
    <div class="seat-card">
      ${avatarHtml(p.username)}
      <div class="seat-name">${p.username}</div>
      <div class="seat-chips"><span class="chip-icon"></span>${p.chips} chips</div>
      <div class="seat-ready-badge">${p.is_ready ? '&#10003; Ready' : 'Waiting&hellip;'}</div>
      ${adminChipControlsHtml(p.username)}
    </div>
  </div>`;
}

function updateActionBar(gs) {
  const myPos = gs.players.findIndex(p => p.id === state.user.id);
  const isMyTurn = myPos !== -1 && myPos === gs.currentTurnPos && gs.stage !== 'complete';
  $('#action-bar').classList.toggle('hidden', !isMyTurn);
  if (state.turnTimerInterval) { clearInterval(state.turnTimerInterval); state.turnTimerInterval = null; }
  if (!isMyTurn) return;

  if (gs.turnStartedAt) {
    const TURN_LIMIT_S = 45;
    const tick = () => {
      const remaining = Math.max(0, TURN_LIMIT_S - Math.floor((Date.now() - gs.turnStartedAt) / 1000));
      $('#my-turn-indicator').textContent = `Your turn — ${remaining}s`;
      if (remaining === 0 && state.turnTimerInterval) clearInterval(state.turnTimerInterval);
    };
    tick();
    state.turnTimerInterval = setInterval(tick, 1000);
  }

  const me = gs.players[myPos];
  const toCall = gs.currentBet - me.committed;
  $('#btn-check').classList.toggle('hidden', toCall > 0);
  $('#btn-call').classList.toggle('hidden', toCall <= 0);
  $('#btn-call').textContent = `Call ${toCall}`;

  const maxRaise = me.chips + me.committed;
  const minRaise = Math.min(gs.currentBet + gs.bigBlind, maxRaise);
  $('#raise-slider').min = minRaise;
  $('#raise-slider').max = maxRaise;
  $('#raise-slider').value = minRaise;
  $('#raise-amount').value = minRaise;
}

$('#raise-slider').addEventListener('input', () => { $('#raise-amount').value = $('#raise-slider').value; });
$('#raise-amount').addEventListener('input', () => { $('#raise-slider').value = $('#raise-amount').value; });

function sendAction(type, amount) {
  playSound('chip');
  const payload = { type: 'action', userId: state.user.id, roomId: state.roomId, payload: { type, amount } };
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
  } else {
    api(`/api/game/rooms/${state.roomId}/action`, { method: 'POST', body: { type, amount } })
      .then(renderGameState).catch(err => showToast(err.message));
  }
}

$('#btn-fold').addEventListener('click', () => sendAction('fold'));
$('#btn-check').addEventListener('click', () => sendAction('check'));
$('#btn-call').addEventListener('click', () => sendAction('call'));
$('#btn-raise').addEventListener('click', () => sendAction('raise', Number($('#raise-amount').value)));

// ---------- chat / log / history panels ----------
$$('.panel-tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.panel-tab').forEach(t => t.classList.remove('active'));
  $$('.panel-body').forEach(b => b.classList.remove('active'));
  tab.classList.add('active');
  $(`#panel-${tab.dataset.panel}`).classList.add('active');
}));

function appendChatMessage(msg) {
  const el = $('#chat-messages');
  const div = document.createElement('div');
  div.innerHTML = `<span class="chat-user">${msg.username || 'player'}:</span> ${escapeHtml(msg.message)}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

async function loadChat(roomId) {
  try {
    const messages = await api(`/api/rooms/${roomId}/chat`);
    $('#chat-messages').innerHTML = '';
    messages.forEach(appendChatMessage);
  } catch (err) { /* ignore */ }
}

$('#form-chat').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  if (!input.value.trim()) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'chat', userId: state.user.id, roomId: state.roomId, payload: { message: input.value } }));
  }
  input.value = '';
});

async function loadHandLog(roomId) {
  try {
    const log = await api(`/api/game/rooms/${roomId}/log`);
    $('#hand-log').innerHTML = log.map(l => `<div>${l.message}</div>`).join('');
  } catch (err) { /* ignore */ }
}

async function loadHandHistory(roomId) {
  try {
    const hands = await api(`/api/game/rooms/${roomId}/history`);
    $('#hand-history').innerHTML = hands.map(h => {
      const winners = (h.results.pots || []).flatMap(p => p.winners.map(w => `${w.username} +${w.payout}${w.handCategory ? ` (${w.handCategory})` : ''}`));
      return `<div><strong>Hand #${h.hand_number}</strong> — pot ${h.pot_amount}, rake ${h.rake_amount}<br>${winners.join(', ')}</div>`;
    }).join('') || '<p class="muted">No hands played yet.</p>';
  } catch (err) { /* ignore */ }
}

// ---------- manage chips (admin, account-wide) ----------
$('#btn-manage-chips').addEventListener('click', () => {
  $('#modal-manage-chips').classList.remove('hidden');
  loadManageChips();
});
$('#btn-close-manage-chips').addEventListener('click', () => $('#modal-manage-chips').classList.add('hidden'));

async function loadManageChips() {
  try {
    const users = await api('/api/admin/users');
    $('#manage-chips-list').innerHTML = users.map(u => `
      <div class="invite-row">
        <span>${u.username}${u.is_admin ? ' (admin)' : ''} &mdash; ${u.balance} chips</span>
        <div style="display:flex; gap:6px; align-items:center;">
          <input type="number" class="manage-chips-amount" data-user="${u.username}" placeholder="amount" min="0" style="width:80px; margin:0; padding:4px;">
          <button class="btn-link" data-manage-give="${u.username}">Give</button>
          <button class="btn-link" data-manage-take="${u.username}" style="color:#ff9aa8;">Take</button>
        </div>
      </div>`).join('');

    const doAdjust = async (username, sign) => {
      const input = document.querySelector(`.manage-chips-amount[data-user="${username}"]`);
      const amount = Math.abs(Number(input.value)) * sign;
      if (!amount) return;
      try {
        await api(`/api/admin/users/${username}/give-chips`, { method: 'POST', body: { amount } });
        showToast(`${amount > 0 ? 'Gave' : 'Took'} ${Math.abs(amount)} chips ${amount > 0 ? 'to' : 'from'} ${username}`);
        loadManageChips();
      } catch (err) { showToast(err.message); }
    };
    $$('[data-manage-give]').forEach(b => b.addEventListener('click', () => doAdjust(b.dataset.manageGive, 1)));
    $$('[data-manage-take]').forEach(b => b.addEventListener('click', () => doAdjust(b.dataset.manageTake, -1)));
  } catch (err) { showToast(err.message); }
}

// ---------- leaderboard ----------
$('#btn-leaderboard').addEventListener('click', async () => {
  try {
    const rows = await api('/api/players/leaderboard');
    $('#leaderboard-list').innerHTML = rows.map((r, i) => `
      <div>${i + 1}. <strong>${r.username}</strong> &mdash; ${r.netResult >= 0 ? '+' : ''}${r.netResult} chips (${r.handsWon} wins)</div>
    `).join('') || '<p class="muted">No hands played yet.</p>';
    $('#modal-leaderboard').classList.remove('hidden');
  } catch (err) { showToast(err.message); }
});
$('#btn-close-leaderboard').addEventListener('click', () => $('#modal-leaderboard').classList.add('hidden'));

// ---------- stats modal ----------
$('#btn-my-history').addEventListener('click', async () => {
  try {
    const stats = await api('/api/players/me/stats');
    $('#stats-body').innerHTML = `
      <p>Current balance: <strong>${stats.balance} chips</strong></p>
      <p>Hands won: <strong>${stats.hands_won}</strong></p>
      <p>Hands lost: <strong>${stats.hands_lost}</strong></p>
      <p>Net result: <strong>${stats.net_result >= 0 ? '+' : ''}${stats.net_result} chips</strong></p>
    `;
    $('#modal-stats').classList.remove('hidden');
  } catch (err) { showToast(err.message); }
});
$('#btn-close-stats').addEventListener('click', () => $('#modal-stats').classList.add('hidden'));

$('#btn-landing-enter').addEventListener('click', () => showView('auth'));

// ---------- boot ----------
if (state.token && state.user) {
  enterLobby();
  const savedRoom = localStorage.getItem('ts_room');
  if (savedRoom) enterTable(savedRoom);
} else {
  showView('landing');
}
