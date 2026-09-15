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

function renderCard(card, faceDown = false) {
  if (faceDown || card === '??') return `<div class="playing-card back"></div>`;
  return `<div class="playing-card ${cardColor(card)}">${card}</div>`;
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
  $('#lobby-admin-badge').classList.toggle('hidden', !state.user.is_admin);
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

async function loadMyAdminRooms() {
  try {
    const rooms = await api('/api/admin/rooms');
    const mine = rooms.filter(r => r.is_admin_room);
    const infoEl = $('#admin-room-info');
    if (!infoEl) return;
    if (mine.length === 0) { infoEl.innerHTML = ''; return; }
    infoEl.innerHTML = mine.map(r => `
      <div class="room-row">
        <div><strong>${r.name}</strong><div class="room-meta">Code ${r.room_code}</div></div>
        <div style="display:flex; gap:6px;">
          <button class="btn-link" data-invite="${r.id}">Invite</button>
          <button class="btn-primary small" data-joinadmin="${r.id}">Join</button>
          <button class="btn-link" data-deleteroom="${r.id}" style="color:#ff9aa8;">Delete</button>
        </div>
      </div>`).join('');
    infoEl.querySelectorAll('[data-invite]').forEach(b => b.addEventListener('click', () => openInviteModal(b.dataset.invite)));
    infoEl.querySelectorAll('[data-joinadmin]').forEach(b => b.addEventListener('click', () => joinRoomById(b.dataset.joinadmin)));
    infoEl.querySelectorAll('[data-deleteroom]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete this table? Everyone seated in it will be removed.')) return;
      await api(`/api/admin/rooms/${b.dataset.deleteroom}`, { method: 'DELETE' }).catch(err => showToast(err.message));
      loadMyAdminRooms();
    }));
  } catch (err) { /* not fatal on lobby load */ }
}

async function createAdminRoom() {
  try {
    const room = await api('/api/admin/rooms', { method: 'POST', body: { name: `${state.user.username}'s Table` } });
    showToast(`Private table created — code ${room.room_code}`);
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
          <input type="number" class="give-chips-amount" data-user="${i.username}" placeholder="amount" style="width:70px; margin:0; padding:4px;">
          <button class="btn-link" data-give="${i.username}">Give</button>
          <button class="btn-link" data-revoke="${i.username}" style="color:#ff9aa8;">remove</button>
        </div>
      </div>`).join('') || '<p class="muted">No invites yet.</p>';
    $$('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/admin/rooms/${inviteRoomId}/invite/${b.dataset.revoke}`, { method: 'DELETE' });
      loadInvites();
    }));
    $$('[data-give]').forEach(b => b.addEventListener('click', async () => {
      const input = document.querySelector(`.give-chips-amount[data-user="${b.dataset.give}"]`);
      const amount = Number(input.value);
      if (!amount) return;
      try {
        await api(`/api/admin/rooms/${inviteRoomId}/give-chips`, { method: 'POST', body: { username: b.dataset.give, amount } });
        showToast(`Gave ${amount} chips to ${b.dataset.give}`);
        loadInvites();
      } catch (err) { showToast(err.message); }
    }));
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
    state.isSpectating = !!(room && room.is_admin_room && room.creator_id === state.user.id);

    $('#btn-table-invite').classList.add('hidden');
    if (state.user.is_admin && room && room.is_admin_room) {
      $('#btn-table-invite').classList.remove('hidden');
      $('#btn-table-invite').onclick = () => openInviteModal(roomId);
    }

    // The admin spectates their own private table — no ready button, never dealt in.
    $('#btn-ready').classList.toggle('hidden', state.isSpectating);
  } catch (e) { /* non-fatal */ }
}

$('#btn-leave-table').addEventListener('click', () => {
  state.leavingTable = true;
  if (state.ws) state.ws.close();
  if (state.pollTimer) clearInterval(state.pollTimer);
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

  const ws = new WebSocket(WS_BASE);
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
  ws.addEventListener('close', () => {
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
    $('#seats').innerHTML = players.map((p, i) => renderIdleSeat(p, i, players.length)).join('');
    $('#community-cards').innerHTML = '';
    $('#pot-display').textContent = 'Pot: 0';
    $('#table-pot-badge').textContent = 'Pot: 0';
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
  $('#pot-display').textContent = `Pot: ${potNow}`;
  $('#table-pot-badge').textContent = `Pot: ${potNow}`;

  const seatsHtml = gs.players.map((p, i) => {
    const angle = (2 * Math.PI * i) / gs.players.length - Math.PI / 2;
    const x = 50 + 42 * Math.cos(angle);
    const y = 50 + 40 * Math.sin(angle);
    const isDealer = i === gs.dealerPos;
    const isActing = i === gs.currentTurnPos && gs.stage !== 'complete';
    const showFaceUp = p.id === state.user.id || gs.stage === 'complete' || gs.stage === 'showdown';
    const won = (gs.potBreakdown || []).some(pb => pb.winners.some(w => w.id === p.id));

    return `<div class="seat ${p.folded ? 'folded' : ''} ${isActing ? 'acting' : ''}" style="left:${x}%; top:${y}%;">
      <div class="seat-card">
        ${isDealer ? '<div class="dealer-chip">D</div>' : ''}
        <div class="seat-name">${p.id === state.user.id ? 'You' : (players.find(rp => rp.user_id === p.id)?.username || 'Player')}</div>
        <div class="seat-chips">${p.chips} chips</div>
        ${p.committed ? `<div class="seat-bet">Bet ${p.committed}</div>` : ''}
        <div class="seat-cards">${p.holeCards.map(c => renderCard(c, !showFaceUp && c !== '??' ? false : c === '??')).join('')}</div>
        ${won ? '<div class="win-banner">WINS</div>' : ''}
      </div>
    </div>`;
  }).join('');
  $('#seats').innerHTML = seatsHtml;

  if (gs.stage === 'complete') {
    setTimeout(() => { if (state.roomId) refreshTable(); }, 4000);
  }

  updateActionBar(gs);
}

function renderIdleSeat(p, i, total) {
  const angle = (2 * Math.PI * i) / total - Math.PI / 2;
  const x = 50 + 42 * Math.cos(angle);
  const y = 50 + 40 * Math.sin(angle);
  return `<div class="seat ${p.is_ready ? 'ready' : ''}" style="left:${x}%; top:${y}%;">
    <div class="seat-card">
      <div class="seat-name">${p.username}</div>
      <div class="seat-chips">${p.chips} chips</div>
      <div class="seat-ready-badge">${p.is_ready ? '&#10003; Ready' : 'Waiting&hellip;'}</div>
    </div>
  </div>`;
}

function updateActionBar(gs) {
  const myPos = gs.players.findIndex(p => p.id === state.user.id);
  const isMyTurn = myPos !== -1 && myPos === gs.currentTurnPos && gs.stage !== 'complete';
  $('#action-bar').classList.toggle('hidden', !isMyTurn);
  if (!isMyTurn) return;

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

// ---------- boot ----------
if (state.token && state.user) {
  enterLobby();
  const savedRoom = localStorage.getItem('ts_room');
  if (savedRoom) enterTable(savedRoom);
} else {
  showView('auth');
}
