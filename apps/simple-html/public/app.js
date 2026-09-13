const API_BASE = window.API_BASE || 'https://table-stakes-backend-vj1i-production.up.railway.app';
const WS_BASE = window.WS_BASE || API_BASE.replace(/^http/, 'ws');

const state = {
  token: localStorage.getItem('ts_token') || null,
  user: JSON.parse(localStorage.getItem('ts_user') || 'null'),
  roomId: null,
  room: null,
  ws: null,
  pollTimer: null
};

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
    <p class="hint">Invite-only room only people you add can join.</p>
    <button id="btn-create-admin-room" class="btn-primary">Create Private Table</button>
    <div id="admin-room-info"></div>
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
        </div>
      </div>`).join('');
    infoEl.querySelectorAll('[data-invite]').forEach(b => b.addEventListener('click', () => openInviteModal(b.dataset.invite)));
    infoEl.querySelectorAll('[data-joinadmin]').forEach(b => b.addEventListener('click', () => joinRoomById(b.dataset.joinadmin)));
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
      <div class="invite-row"><span>${i.username} (${i.status})</span>
      <button class="btn-link" data-revoke="${i.username}">remove</button></div>`).join('') || '<p class="muted">No invites yet.</p>';
    $$('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
      await api(`/api/admin/rooms/${inviteRoomId}/invite/${b.dataset.revoke}`, { method: 'DELETE' });
      loadInvites();
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
          bigBlind: Number($('#create-room-bb').value),
          startingChips: Number($('#create-room-chips').value)
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
  showView('table');
  const room = await api(`/api/rooms/${(await api(`/api/players/room/${roomId}`).catch(() => []))[0]?.room_id || roomId}`).catch(() => null);
  await refreshRoomHeader(roomId);
  connectWS(roomId);
  await refreshTable();
  loadChat(roomId);
  loadHandLog(roomId);
  loadHandHistory(roomId);
}

async function refreshRoomHeader(roomId) {
  try {
    const rooms = await api('/api/admin/rooms').catch(() => []);
    const found = rooms.find(r => r.id === roomId);
    $('#table-room-name').textContent = found ? found.name : 'Table';
  } catch (e) { /* non-fatal */ }
}

$('#btn-leave-table').addEventListener('click', () => {
  if (state.ws) state.ws.close();
  if (state.pollTimer) clearInterval(state.pollTimer);
  showView('lobby');
  loadPublicRooms();
});

$('#btn-deal').addEventListener('click', async () => {
  try {
    await api(`/api/game/rooms/${state.roomId}/deal`, { method: 'POST' });
    refreshTable();
  } catch (err) { showToast(err.message); }
});

function connectWS(roomId) {
  if (state.ws) state.ws.close();
  const ws = new WebSocket(WS_BASE);
  state.ws = ws;
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', userId: state.user.id, roomId }));
  });
  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'game_update') renderGameState(msg.data);
    else if (msg.type === 'chat') appendChatMessage(msg);
    else if (msg.type === 'hand_complete') { loadHandLog(roomId); loadHandHistory(roomId); }
    else if (msg.type === 'error') showToast(msg.message);
  });
  ws.addEventListener('close', () => {
    // Fall back to polling if the socket drops
    if (!state.pollTimer) state.pollTimer = setInterval(refreshTable, 2500);
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
  return lastRoomPlayers;
}

async function renderGameState(gameRow) {
  const players = await loadRoomPlayers();
  const gs = gameRow && gameRow.game_state;

  if (!gs || gameRow.status === 'no_game') {
    $('#seats').innerHTML = players.map((p, i) => renderIdleSeat(p, i, players.length)).join('');
    $('#community-cards').innerHTML = '';
    $('#pot-display').textContent = 'Pot: 0';
    $('#table-pot-badge').textContent = 'Pot: 0';
    $('#action-bar').classList.add('hidden');
    return;
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

  updateActionBar(gs);
}

function renderIdleSeat(p, i, total) {
  const angle = (2 * Math.PI * i) / total - Math.PI / 2;
  const x = 50 + 42 * Math.cos(angle);
  const y = 50 + 40 * Math.sin(angle);
  return `<div class="seat" style="left:${x}%; top:${y}%;">
    <div class="seat-card">
      <div class="seat-name">${p.username}</div>
      <div class="seat-chips">${p.chips} chips</div>
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
      <p>Hands won: <strong>${stats.hands_won}</strong></p>
      <p>Hands lost: <strong>${stats.hands_lost}</strong></p>
      <p>Net result: <strong>${stats.net_result >= 0 ? '+' : ''}${stats.net_result} chips</strong></p>
    `;
    $('#modal-stats').classList.remove('hidden');
  } catch (err) { showToast(err.message); }
});
$('#btn-close-stats').addEventListener('click', () => $('#modal-stats').classList.add('hidden'));

// ---------- boot ----------
if (state.token && state.user) enterLobby(); else showView('auth');
