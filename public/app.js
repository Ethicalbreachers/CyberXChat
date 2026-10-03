// ============ LOAD FIREBASE CONFIG FROM VERCEL ENV ============
let db, firebaseReady = false;
let ADMIN_USER = 'admin', ADMIN_PASS = 'admin123';

async function initFirebase() {
  try {
    const r = await fetch('/api/config');
    const cfg = await r.json();
    if (!cfg.firebase || !cfg.firebase.apiKey) {
      // fallback local config for dev
      cfg.firebase = {
        apiKey: "YOUR_API_KEY",
        authDomain: "YOUR_PROJECT.firebaseapp.com",
        databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
        projectId: "YOUR_PROJECT",
        storageBucket: "YOUR_PROJECT.appspot.com",
        messagingSenderId: "000000",
        appId: "1:0000:web:xxxx"
      };
    }
    firebase.initializeApp(cfg.firebase);
    db = firebase.database();
    firebaseReady = true;
  } catch (e) {
    console.error('Firebase init failed', e);
    toast('Firebase config missing. Check /api/config');
  }
}

// ============ UTILITIES ============
const $ = (id) => document.getElementById(id);
const now = () => Date.now();
const uid = () => Math.random().toString(36).slice(2) + now().toString(36);
const sha = async (str) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
};
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2500);
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}
function showView(id) {
  document.querySelectorAll('#mainScreen .view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString();
}

// ============ STATE ============
let me = null;                    // { uid, username, name, bio, avatar, email }
let currentPeer = null;
let unsubMessages = null;
let typingTimer = null;
let onlineRef = null;
const accounts = {};              // uid -> account object (for multi-account)

// ============ AUTH ============
async function register(name, username, email, password) {
  if (!email.endsWith('@gmail.com')) return toast('Only Gmail allowed');
  username = username.toLowerCase().replace(/[^a-z0-9_]/g,'');
  if (!username) return toast('Invalid username');

  const snapUser = await db.ref('usernames/' + username).get();
  if (snapUser.exists()) return toast('Username taken');
  const snapEmail = await db.ref('emails/' + email.replace(/\./g,',')).get();
  if (snapEmail.exists()) return toast('Email already registered');

  const newUid = 'u_' + uid();
  const passHash = await sha(password);
  const user = {
    uid: newUid, name, username, email, bio: '', avatar: '',
    password: passHash, createdAt: now(),
    hideOnline: false, lastSeen: now(), online: true,
    emoji: ''
  };
  await db.ref('users/' + newUid).set(user);
  await db.ref('usernames/' + username).set(newUid);
  await db.ref('emails/' + email.replace(/\./g,','), ).set(newUid);
  return user;
}

async function login(identifier, password) {
  let userUid = null;
  if (identifier.includes('@')) {
    if (!identifier.endsWith('@gmail.com')) return toast('Only Gmail allowed');
    const s = await db.ref('emails/' + identifier.replace(/\./g,',')).get();
    userUid = s.val();
  } else {
    const s = await db.ref('usernames/' + identifier.toLowerCase()).get();
    userUid = s.val();
  }
  if (!userUid) return toast('Account not found');
  const u = (await db.ref('users/' + userUid).get()).val();
  const passHash = await sha(password);
  if (u.password !== passHash) return toast('Wrong password');
  return u;
}

// ============ SESSION ============
function saveSession(user) {
  accounts[user.uid] = user;
  let active = JSON.parse(localStorage.getItem('activeAccounts') || '[]');
  if (!active.includes(user.uid)) active.push(user.uid);
  localStorage.setItem('activeAccounts', JSON.stringify(active));
  localStorage.setItem('currentUid', user.uid);
  localStorage.setItem('acc_' + user.uid, JSON.stringify(user));
}
function loadAccounts() {
  const active = JSON.parse(localStorage.getItem('activeAccounts') || '[]');
  active.forEach(u => {
    const a = localStorage.getItem('acc_' + u);
    if (a) accounts[u] = JSON.parse(a);
  });
}

// ============ ENTER APP ============
async function enterApp(user) {
  me = user;
  saveSession(user);
  showScreen('mainScreen');
  startPresence();
  watchMyUser();
  watchUsers();
  watchChats();
  watchDevices();
  toast('Welcome ' + user.name);
}

// ============ PRESENCE ============
function startPresence() {
  const myRef = db.ref('users/' + me.uid);
  const connectedRef = db.ref('.info/connected');
  connectedRef.on('value', (snap) => {
    if (snap.val() === true) {
      myRef.child('online').set(true);
      myRef.child('online').onDisconnect().set(false);
      myRef.child('lastSeen').onDisconnect().set(now());
    }
  });
}

function watchMyUser() {
  db.ref('users/' + me.uid).on('value', (s) => {
    const u = s.val();
    if (!u) return;
    me = Object.assign(me, u);
    $('myAvatar').src = u.avatar || 'https://via.placeholder.com/100';
    $('editName').value = u.name || '';
    $('editUsername').value = u.username || '';
    $('editBio').value = u.bio || '';
    $('hideOnline').checked = !!u.hideOnline;
  });
}

// ============ USERS LIST ============
function watchUsers() {
  db.ref('users').on('value', (snap) => {
    const users = snap.val() || {};
    // check admin ban
    const bannedSnap = db.ref('banned');
    bannedSnap.once('value').then(b => {
      const banned = b.val() || {};
      const list = $('usersList');
      list.innerHTML = '';
      Object.values(users).forEach(u => {
        if (u.uid === me.uid) return;
        if (banned[u.uid]) return;
        const div = document.createElement('div');
        div.className = 'user-item';
        div.innerHTML = `
          <img src="${u.avatar || 'https://via.placeholder.com/48'}" />
          <div class="user-meta">
            <strong>${u.emoji || ''}${u.name}</strong>
            <small>@${u.username} • ${u.online && !u.hideOnline ? '🟢 online' : 'offline'}</small>
          </div>
          <div class="item-actions">
            <button data-uid="${u.uid}" class="chat-btn">Chat</button>
            <button data-uid="${u.uid}" class="req-btn req">Request</button>
          </div>`;
        div.querySelector('img').onclick = () => openUserProfile(u.uid);
        div.querySelector('.chat-btn').onclick = (e) => {
          e.stopPropagation(); startChatWith(u.uid);
        };
        div.querySelector('.req-btn').onclick = (e) => {
          e.stopPropagation(); sendFriendRequest(u.uid);
        };
        list.appendChild(div);
      });
    });
  });
}

// ============ FRIEND REQUEST ============
async function sendFriendRequest(toUid) {
  const myReq = { from: me.uid, to: toUid, at: now(), status: 'pending' };
  await db.ref('requests/' + toUid + '/' + me.uid).set(myReq);
  toast('Request sent');
}

// ============ CHAT SESSIONS ============
function chatKey(a, b) { return [a, b].sort().join('_'); }

async function startChatWith(peerUid) {
  const peer = (await db.ref('users/' + peerUid).get()).val();
  if (!peer) return toast('User not found');
  const key = chatKey(me.uid, peerUid);
  await db.ref('chats/' + key + '/members').set({ [me.uid]: true, [peerUid]: true });
  openChat(peer, key);
}

function watchChats() {
  db.ref('chats').on('value', (snap) => {
    const all = snap.val() || {};
    const myChats = [];
    Object.entries(all).forEach(([key, c]) => {
      if (c.members && c.members[me.uid]) myChats.push({ key, data: c });
    });
    renderChatsList(myChats);
    // total unread
    let total = 0;
    myChats.forEach(c => {
      const un = c.data.unread && c.data.unread[me.uid] ? c.data.unread[me.uid] : 0;
      total += un;
    });
    const b = $('totalChatCount');
    b.textContent = total;
    b.style.display = total > 0 ? 'inline-block' : 'none';
  });
}

async function renderChatsList(myChats) {
  const list = $('chatsList');
  list.innerHTML = '';
  for (const c of myChats) {
    const peerUid = Object.keys(c.data.members).find(x => x !== me.uid);
    const peer = (await db.ref('users/' + peerUid).get()).val();
    if (!peer) continue;
    const un = c.data.unread && c.data.unread[me.uid] ? c.data.unread[me.uid] : 0;
    const last = c.data.lastMessage || {};
    const div = document.createElement('div');
    div.className = 'chat-item';
    div.innerHTML = `
      <img src="${peer.avatar || 'https://via.placeholder.com/48'}" />
      <div class="user-meta">
        <strong>${peer.emoji || ''}${peer.name} ${un ? `<span class="unread-dot">${un}</span>`: ''}</strong>
        <small>${last.text ? last.text.slice(0,28) : 'No messages'}</small>
        <small>@${peer.username} • ${peer.online && !peer.hideOnline ? '🟢 online' : 'offline'}</small>
      </div>`;
    div.onclick = () => openChat(peer, c.key);
    list.appendChild(div);
  }
}

// ============ OPEN CHAT ============
function openChat(peer, key) {
  currentPeer = peer;
  $('chatPeerName').textContent = (peer.emoji||'') + peer.name;
  $('chatPeerImg').src = peer.avatar || 'https://via.placeholder.com/40';
  updatePeerStatus(peer.uid);
  showView('chatView');
  // clear unread
  db.ref('chats/' + key + '/unread/' + me.uid).set(0);

  if (unsubMessages) unsubMessages();
  unsubMessages = db.ref('chats/' + key + '/messages').on('value', (snap) => {
    const msgs = snap.val() || {};
    const list = $('messagesList');
    list.innerHTML = '';
    Object.entries(msgs).forEach(([mid, m]) => {
      if (m.deletedFor && m.deletedFor[me.uid]) return;
      const isMe = m.from === me.uid;
      const div = document.createElement('div');
      div.className = 'msg ' + (isMe ? 'me' : 'them');
      div.innerHTML = `${m.text}<span class="time">${fmtTime(m.at)}</span>${isMe ? `<button class="unsend" data-mid="${mid}">×</button>` : ''}`;
      if (isMe) {
        div.querySelector('.unsend').onclick = () => unsendMessage(key, mid);
      }
      list.appendChild(div);
    });
    list.scrollTop = list.scrollHeight;
  });

  // peer presence
  watchPeerPresence(peer.uid);
}

function watchPeerPresence(peerUid) {
  const ref = db.ref('users/' + peerUid);
  const cb = (s) => {
    const u = s.val();
    if (!u) return;
    const st = u.hideOnline ? 'offline' : (u.online ? 'online' : 'last seen ' + fmtDate(u.lastSeen));
    $('chatPeerStatus').textContent = st + (u.typing ? ' • typing...' : '');
  };
  ref.on('value', cb);
}

async function updatePeerStatus(peerUid) {
  const u = (await db.ref('users/' + peerUid).get()).val();
  if (!u) return;
  $('chatPeerStatus').textContent = u.hideOnline ? 'offline' : (u.online ? 'online' : 'last seen ' + fmtDate(u.lastSeen));
}

// ============ SEND MESSAGE ============
$('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const txt = $('msgInput').value.trim();
  if (!txt || !currentPeer) return;
  const key = chatKey(me.uid, currentPeer.uid);
  const mid = 'm_' + uid();
  await db.ref('chats/' + key + '/messages/' + mid).set({
    mid, from: me.uid, to: currentPeer.uid, text: txt, at: now()
  });
  await db.ref('chats/' + key + '/lastMessage').set({ text: txt, at: now(), from: me.uid });
  const un = (await db.ref('chats/' + key + '/unread/' + currentPeer.uid).get()).val() || 0;
  await db.ref('chats/' + key + '/unread/' + currentPeer.uid).set(un + 1);
  $('msgInput').value = '';

  // typing
  db.ref('users/' + me.uid + '/typing').set(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => db.ref('users/' + me.uid + '/typing').set(false), 1500);
});

// ============ UNSEND ============
async function unsendMessage(key, mid) {
  await db.ref('chats/' + key + '/messages/' + mid).remove();
  toast('Unsent');
}

// ============ CLEAR CHAT (for everyone) ============
$('clearChatBtn').onclick = async () => {
  if (!currentPeer) return;
  const key = chatKey(me.uid, currentPeer.uid);
  await db.ref('chats/' + key + '/messages').remove();
  toast('Chat cleared for everyone');
  $('chatMenu').classList.add('hidden');
};

// ============ PROFILE EDIT ============
$('avatarInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = async () => {
    await db.ref('users/' + me.uid + '/avatar').set(reader.result);
    toast('Avatar updated');
  };
  reader.readAsDataURL(f);
});

$('saveProfile').onclick = async () => {
  const newName = $('editName').value.trim();
  const newUsername = $('editUsername').value.trim().toLowerCase();
  const newBio = $('editBio').value.trim();
  if (!newName || !newUsername) return toast('Name & username required');
  if (newUsername !== me.username) {
    const s = await db.ref('usernames/' + newUsername).get();
    if (s.exists()) return toast('Username taken');
    await db.ref('usernames/' + me.username).remove();
    await db.ref('usernames/' + newUsername).set(me.uid);
    await db.ref('users/' + me.uid + '/username').set(newUsername);
  }
  await db.ref('users/' + me.uid).update({ name: newName, bio: newBio });
  toast('Profile saved');
};

// ============ SETTINGS ============
$('hideOnline').onchange = (e) => {
  db.ref('users/' + me.uid + '/hideOnline').set(e.target.checked);
};

$('changePwBtn').onclick = async () => {
  const oldPw = prompt('Current password:');
  if (!oldPw) return;
  const oldHash = await sha(oldPw);
  if (oldHash !== me.password) return toast('Wrong password');
  const newPw = prompt('New password:');
  if (!newPw) return;
  const h = await sha(newPw);
  await db.ref('users/' + me.uid + '/password').set(h);
  toast('Password updated');
};

$('addAccountBtn').onclick = () => {
  showScreen('authScreen');
};

$('logoutBtn').onclick = async () => {
  await db.ref('users/' + me.uid + '/online').set(false);
  await db.ref('users/' + me.uid + '/lastSeen').set(now());
  let active = JSON.parse(localStorage.getItem('activeAccounts') || '[]');
  active = active.filter(x => x !== me.uid);
  localStorage.setItem('activeAccounts', JSON.stringify(active));
  localStorage.removeItem('acc_' + me.uid);
  localStorage.removeItem('currentUid');
  delete accounts[me.uid];
  location.reload();
};

$('deleteAccountBtn').onclick = async () => {
  if (!confirm('Permanently delete account? This cannot be undone.')) return;
  await db.ref('usernames/' + me.username).remove();
  await db.ref('emails/' + me.email.replace(/\./g,',')).remove();
  await db.ref('users/' + me.uid).remove();
  let active = JSON.parse(localStorage.getItem('activeAccounts') || '[]');
  active = active.filter(x => x !== me.uid);
  localStorage.setItem('activeAccounts', JSON.stringify(active));
  localStorage.removeItem('acc_' + me.uid);
  location.reload();
};

// ============ DEVICES ============
function watchDevices() {
  db.ref('sessions/' + me.uid).on('value', (s) => {
    const d = s.val() || {};
    const list = $('devicesList');
    list.innerHTML = '';
    Object.values(d).forEach(dev => {
      const el = document.createElement('div');
      el.className = 'device-item';
      el.textContent = `${dev.ua || 'Unknown'} — logged in at ${fmtDate(dev.at)}`;
      list.appendChild(el);
    });
  });
}
// log current session
(function logSession() {
  const sid = 's_' + uid();
  const ua = navigator.userAgent;
  setTimeout(() => {
    if (me) db.ref('sessions/' + me.uid + '/' + sid).set({ ua, at: now() });
  }, 500);
  window._sid = sid;
})();

// ============ USER PROFILE VIEW ============
async function openUserProfile(uid) {
  const u = (await db.ref('users/' + uid).get()).val();
  if (!u) return toast('User not found');
  $('upAvatar').src = u.avatar || 'https://via.placeholder.com/100';
  $('upName').textContent = (u.emoji||'') + u.name;
  $('upUsername').textContent = '@' + u.username;
  $('upBio').textContent = u.bio || '';
  $('upStatus').textContent = u.online && !u.hideOnline ? '🟢 online' : 'last seen ' + fmtDate(u.lastSeen);
  $('upStartChat').onclick = () => startChatWith(uid);
  showView('userProfileView');
}
$('backFromProfile').onclick = () => showView('usersView');

// ============ HEADER NAV ============
$('chatTabBtn').onclick = () => {
  $('appTitle').textContent = 'Chats';
  showView('chatsView');
};
$('profileBtn').onclick = () => {
  $('appTitle').textContent = 'My Profile';
  showView('profileView');
};
$('settingsBtn').onclick = () => {
  $('appTitle').textContent = 'Settings';
  showView('settingsView');
};
$('backFromChat').onclick = () => {
  if (unsubMessages) unsubMessages();
  $('appTitle').textContent = 'Chats';
  showView('chatsView');
};

// menu
$('chatMenuBtn').onclick = () => $('chatMenu').classList.toggle('hidden');

// ============ AUTH UI ============
$('loginTab').onclick = () => {
  $('loginTab').classList.add('active'); $('registerTab').classList.remove('active');
  $('loginForm').classList.add('active'); $('registerForm').classList.remove('active'); $('forgotForm').classList.remove('active');
};
$('registerTab').onclick = () => {
  $('registerTab').classList.add('active'); $('loginTab').classList.remove('active');
  $('registerForm').classList.add('active'); $('loginForm').classList.remove('active'); $('forgotForm').classList.remove('active');
};
$('forgotLink').onclick = (e) => {
  e.preventDefault();
  $('loginForm').classList.remove('active'); $('registerForm').classList.remove('active'); $('forgotForm').classList.add('active');
};
$('backLogin').onclick = (e) => {
  e.preventDefault();
  $('forgotForm').classList.remove('active'); $('loginForm').classList.add('active');
};

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!firebaseReady) return toast('Firebase not ready');
  const id = $('loginEmail').value.trim();
  const pw = $('loginPassword').value;
  try {
    const u = await login(id, pw);
    if (u) enterApp(u);
  } catch (err) { toast(err.message || 'Login failed'); }
});

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!firebaseReady) return toast('Firebase not ready');
  try {
    const u = await register(
      $('regName').value.trim(),
      $('regUsername').value.trim(),
      $('regEmail').value.trim(),
      $('regPassword').value
    );
    if (u) enterApp(u);
  } catch (err) { toast(err.message || 'Register failed'); }
});

$('forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('forgotEmail').value.trim();
  if (!email.endsWith('@gmail.com')) return toast('Only Gmail allowed');
  const s = await db.ref('emails/' + email.replace(/\./g,',')).get();
  if (!s.exists()) return toast('Email not registered');
  const newPw = prompt('Enter new password:');
  if (!newPw) return;
  const h = await sha(newPw);
  await db.ref('users/' + s.val() + '/password').set(h);
  toast('Password reset. Please login.');
  $('forgotForm').classList.remove('active');
  $('loginForm').classList.add('active');
});

// ============ BOOT ============
(async function boot() {
  await initFirebase();
  loadAccounts();
  const currentUid = localStorage.getItem('currentUid');
  if (currentUid && accounts[currentUid]) {
    const u = (await db.ref('users/' + currentUid).get()).val();
    if (u) enterApp(u);
    else showScreen('authScreen');
  } else {
    showScreen('authScreen');
  }
})();
