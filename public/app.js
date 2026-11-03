'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const icon = (name, className = '') => {
    const paths = {
      spark: '<path d="m12 3 1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7L12 3Z"/>',
      refresh: '<path d="M20 7v5h-5M4 17v-5h5M5.5 9a7 7 0 0 1 11.8-2L20 12M4 12l2.7 5a7 7 0 0 0 11.8-2"/>',
      arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
      mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"/>',
      micOff: '<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5.1 2.1M15 9V5a3 3 0 0 0-5.8-1M5 11a7 7 0 0 0 12 4.9M12 18v4M8 22h8"/>',
      camera: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
      cameraOff: '<path d="m3 3 18 18M10 6h6a2 2 0 0 1 2 2v1l3-2v10l-3-2v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2"/>',
      chat: '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-6.5A7.5 7.5 0 1 1 20 11.5Z"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    };
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || paths.spark}</svg>`;
  };
  const state = {
    userId: null, socket: null, localStream: null, peerConnection: null,
    remoteUserId: null, pairId: null, initiator: false, pendingCandidates: [],
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    started: false, waiting: false, cameraEnabled: true, microphoneEnabled: true,
    toastTimer: null
  };

  const countries = {
    ID: 'Indonesia', MY: 'Malaysia', SG: 'Singapura', TH: 'Thailand', PH: 'Filipina', VN: 'Vietnam',
    JP: 'Jepang', KR: 'Korea Selatan', IN: 'India', AU: 'Australia', US: 'Amerika Serikat',
    GB: 'Inggris', DE: 'Jerman', FR: 'Prancis', BR: 'Brasil', TR: 'Turki'
  };

  function getUserId() {
    let id = localStorage.getItem('gomi_user_id');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      id = crypto.randomUUID();
      localStorage.setItem('gomi_user_id', id);
    }
    return id;
  }

  function toast(message) {
    const element = $('toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
  }

  function setStatus(title, message, mode = 'idle') {
    $('matchStatusTitle').textContent = title;
    $('matchStatusText').textContent = message;
    $('matchStatus').className = `match-status ${mode}`;
  }

  function setRemoteStatus(text, connected = false) {
    $('remoteStatus').lastElementChild.textContent = text;
    $('remoteStatus').classList.toggle('connected', connected);
  }

  function setConnectedControls(connected) {
    $('nextBtn').disabled = !state.started;
    $('muteBtn').disabled = !state.localStream;
    $('cameraBtn').disabled = !state.localStream;
    $('chatBtn').disabled = !connected;
    $('stopBtn').disabled = !state.started;
    $('reportBtn').disabled = !connected;
    $('blockBtn').disabled = !connected;
  }

  function addChatMessage(message, mine) {
    const container = $('chatMessages');
    const empty = container.querySelector('.chat-empty');
    if (empty) empty.remove();
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${mine ? 'mine' : 'theirs'}`;
    bubble.textContent = message;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  }

  function clearChat() {
    $('chatMessages').innerHTML = '<div class="chat-empty">Sapa teman ngobrolmu</div>';
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error('Konfigurasi tidak tersedia');
      const config = await response.json();
      if (Array.isArray(config.iceServers) && config.iceServers.length) state.iceServers = config.iceServers;
    } catch (error) {
      console.warn(error);
    }
  }

  function createSocketAdapter() {
    const listeners = new Map();
    const socket = {
      connected: false,
      connecting: null,
      on(event, callback) {
        const items = listeners.get(event) || [];
        items.push({ callback, once: false });
        listeners.set(event, items);
        return socket;
      },
      once(event, callback) {
        const items = listeners.get(event) || [];
        items.push({ callback, once: true });
        listeners.set(event, items);
        return socket;
      },
      emit(event, data = {}) {
        if (ws.readyState !== WebSocket.OPEN) return false;
        try { ws.send(JSON.stringify({ event, data })); return true; }
        catch { return false; }
      },
      close() { ws.close(); }
    };
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws?userId=${encodeURIComponent(state.userId)}`);
    const dispatch = (event, data) => {
      const items = listeners.get(event) || [];
      const remaining = [];
      for (const item of items) {
        try { item.callback(data); } catch (error) { console.error(error); }
        if (!item.once) remaining.push(item);
      }
      listeners.set(event, remaining);
    };
    socket.connecting = new Promise((resolve, reject) => {
      let settled = false;
      const rejectConnection = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      ws.addEventListener('open', () => {
        socket.connected = true;
        if (!settled) { settled = true; resolve(); }
        dispatch('connect');
      });
      ws.addEventListener('message', (message) => {
        try {
          const packet = JSON.parse(message.data);
          if (packet && typeof packet.event === 'string') dispatch(packet.event, packet.data);
        } catch (error) { console.warn('Pesan server tidak valid:', error); }
      });
      ws.addEventListener('error', () => {
        const error = new Error('Tidak dapat terhubung ke server Gomi.');
        dispatch('connect_error', error);
        rejectConnection(error);
      });
      ws.addEventListener('close', () => {
        socket.connected = false;
        socket.connecting = null;
        rejectConnection(new Error('Koneksi ke server ditutup.'));
        dispatch('disconnect');
      });
      setTimeout(() => rejectConnection(new Error('Server belum merespons.')), 12_000);
    });
    return socket;
  }

  function ensureSocket() {
    if (state.socket && state.socket.connected) return Promise.resolve();
    if (state.socket && state.socket.connecting) return state.socket.connecting;
    state.socket = createSocketAdapter();
    bindSocketEvents(state.socket);
    return state.socket.connecting;
  }

  function bindSocketEvents(socket) {
    socket.on('match:waiting', () => {
      state.waiting = true;
      state.remoteUserId = null;
      setStatus('Sedang mencari teman...', 'Jangan tutup halaman ini. Kami sedang mencocokkanmu.', 'waiting');
      $('startBtn').disabled = false;
      $('startBtn').innerHTML = `${icon('refresh', 'button-icon')}<span>Cari ulang</span>${icon('arrow', 'button-arrow')}`;
      $('connectionText').textContent = 'Menunggu pengguna lain untuk terhubung';
      setRemoteStatus('Mencari teman');
      setConnectedControls(false);
    });

    socket.on('match:found', async (match) => {
      state.waiting = false;
      state.remoteUserId = match.partnerId;
      state.pairId = match.pairId;
      state.initiator = Boolean(match.initiator);
      state.pendingCandidates = [];
      state.startingMatch = false;
      $('remotePlaceholder').classList.remove('hidden');
      $('remoteTitle').textContent = 'Menghubungkan video...';
      $('remoteSubtitle').textContent = match.partnerCountry ? `Teman dari ${countries[match.partnerCountry] || match.partnerCountry}` : 'Teman baru';
      $('remoteLabel').textContent = `TEMAN · ${countries[match.partnerCountry] || match.partnerCountry || 'BARU'}`.toUpperCase();
      setStatus('Kamu sudah menemukan teman!', 'Ucapkan halo dan mulai obrolan yang menyenangkan.', 'connected');
      setRemoteStatus('Terhubung', true);
      $('startBtn').disabled = false;
      $('startBtn').innerHTML = `${icon('spark', 'button-icon')}<span>Mulai ngobrol</span>${icon('arrow', 'button-arrow')}`;
      $('connectionText').textContent = 'Peer ditemukan · Menyiapkan video';
      clearChat();
      setConnectedControls(true);
      try {
        await createPeerConnection();
        if (state.initiator) {
          const offer = await state.peerConnection.createOffer();
          await state.peerConnection.setLocalDescription(offer);
          socket.emit('peer:signal', { description: state.peerConnection.localDescription });
        }
      } catch (error) {
        console.error(error);
        toast('Gagal menyiapkan video. Coba cari teman lagi.');
        nextMatch();
      }
    });

    socket.on('peer:signal', async (payload) => {
      if (!state.peerConnection) return;
      try {
        if (payload.description) {
          await state.peerConnection.setRemoteDescription(payload.description);
          for (const candidate of state.pendingCandidates) await state.peerConnection.addIceCandidate(candidate);
          state.pendingCandidates = [];
          if (payload.description.type === 'offer') {
            const answer = await state.peerConnection.createAnswer();
            await state.peerConnection.setLocalDescription(answer);
            socket.emit('peer:signal', { description: state.peerConnection.localDescription });
          }
        } else if (payload.candidate) {
          if (state.peerConnection.remoteDescription) await state.peerConnection.addIceCandidate(payload.candidate);
          else state.pendingCandidates.push(payload.candidate);
        }
      } catch (error) {
        console.warn('WebRTC signaling error:', error);
      }
    });

    socket.on('peer:left', ({ reason } = {}) => {
      cleanupPeer();
      const message = reason === 'reported' ? 'Sesi berakhir setelah laporan dikirim.' : 'Teman ngobrol meninggalkan sesi.';
      setStatus('Obrolan selesai', `${message} Kamu bisa mencari teman baru.`, 'idle');
      $('remoteTitle').textContent = 'Teman ngobrol akan muncul di sini';
      $('remoteSubtitle').textContent = 'Tekan “Cari teman lain” untuk terhubung kembali';
      $('remoteLabel').textContent = 'TEMAN BARU';
      $('remotePlaceholder').classList.remove('hidden');
      setRemoteStatus('Belum terhubung');
      $('connectionText').textContent = 'Sesi selesai';
      setConnectedControls(false);
      $('startBtn').disabled = false;
    });

    socket.on('match:stopped', () => {
      state.waiting = false;
      setStatus('Kamu sedang offline', 'Tekan mulai kapan saja untuk mencari teman.', 'idle');
    });
    socket.on('chat:message', ({ message }) => addChatMessage(message, false));
    socket.on('chat:sent', ({ message }) => addChatMessage(message, true));
    socket.on('safety:reported', () => {
      closeModal('reportModal');
      cleanupPeer();
      toast('Laporan diterima. Terima kasih telah menjaga komunitas.');
      state.remoteUserId = null;
      setStatus('Laporan terkirim', 'Pengguna ini telah diblokir untukmu.', 'idle');
      setConnectedControls(false);
    });
    socket.on('safety:blocked', () => {
      cleanupPeer();
      state.remoteUserId = null;
      setStatus('Pengguna diblokir', 'Kamu tidak akan dipasangkan kembali dengan pengguna ini.', 'idle');
      setConnectedControls(false);
      toast('Pengguna berhasil diblokir.');
    });
    socket.on('connect_error', (error) => {
      if (error.message.includes('diblokir')) {
        toast('Sesi ini diblokir dari Gomi.');
        $('startBtn').disabled = true;
      } else toast('Koneksi ke server terputus. Periksa jaringanmu.');
    });
    socket.on('disconnect', () => {
      if (state.started) {
        cleanupPeer();
        state.waiting = false;
        setStatus('Koneksi terputus', 'Periksa internet lalu tekan mulai lagi.', 'idle');
        setConnectedControls(false);
      }
    });
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Browser ini tidak mendukung kamera. Gunakan browser modern melalui HTTPS.');
    }
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
    });
    $('localVideo').srcObject = state.localStream;
    $('localPlaceholder').classList.add('hidden');
    state.started = true;
    state.cameraEnabled = true;
    state.microphoneEnabled = true;
    updateMediaButtons();
    setConnectedControls(false);
    $('connectionText').textContent = 'Kamera dan mikrofon aktif';
    $('permissionHelpBtn').classList.add('hidden');
    $('localVideo').play().catch(() => {});
  }

  async function createPeerConnection() {
    if (state.peerConnection) state.peerConnection.close();
    const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });
    state.peerConnection = pc;
    state.pendingCandidates = [];
    const remoteStream = new MediaStream();
    $('remoteVideo').srcObject = remoteStream;
    if (state.localStream) state.localStream.getTracks().forEach((track) => pc.addTrack(track, state.localStream));
    pc.ontrack = (event) => {
      const stream = event.streams && event.streams[0];
      if (stream) stream.getTracks().forEach((track) => { if (!remoteStream.getTracks().some((t) => t.id === track.id)) remoteStream.addTrack(track); });
      else if (!remoteStream.getTracks().some((t) => t.id === event.track.id)) remoteStream.addTrack(event.track);
      $('remoteVideo').srcObject = remoteStream;
      $('remoteVideo').play().catch(() => {});
      $('remotePlaceholder').classList.add('hidden');
      $('connectionText').textContent = 'Video peer-to-peer aktif';
    };
    pc.onicecandidate = (event) => {
      if (event.candidate && state.socket) state.socket.emit('peer:signal', { candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (!state.peerConnection || state.peerConnection !== pc) return;
      if (pc.connectionState === 'connected') {
        $('connectionText').textContent = 'Video dan audio terhubung';
        setRemoteStatus('Terhubung', true);
      } else if (['failed', 'closed'].includes(pc.connectionState)) {
        setRemoteStatus('Koneksi bermasalah');
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') toast('Jalur video gagal. TURN server mungkin diperlukan.');
    };
  }

  function cleanupPeer() {
    if (state.peerConnection) {
      state.peerConnection.ontrack = null;
      state.peerConnection.onicecandidate = null;
      state.peerConnection.close();
    }
    state.peerConnection = null;
    state.remoteUserId = null;
    state.pairId = null;
    state.pendingCandidates = [];
    $('remoteVideo').srcObject = null;
    $('remotePlaceholder').classList.remove('hidden');
  }

  async function findMatch() {
    if (state.startingMatch) return;
    state.startingMatch = true;
    try {
      if (!state.localStream) await startCamera();
      await ensureSocket();
      cleanupPeer();
      clearChat();
      state.started = true;
      state.waiting = true;
      $('startBtn').disabled = true;
      $('startBtn').innerHTML = '<span class="spinner"></span><span>Mencari...</span>';
      setStatus('Menyiapkan pencarian...', 'Menghubungkanmu dengan komunitas Gomi.', 'waiting');
      setRemoteStatus('Mencari teman');
      setConnectedControls(false);
      state.socket.emit('match:find', { country: $('myCountry').value, desiredCountry: $('desiredCountry').value });
    } catch (error) {
      console.error(error);
      state.startingMatch = false;
      $('startBtn').disabled = false;
      if (error && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
        $('permissionHelpBtn').classList.remove('hidden');
        setStatus('Izin kamera diblokir', 'Izinkan Kamera dan Mikrofon di pengaturan browser atau Android, lalu coba lagi.', 'error');
        toast('Browser atau Android belum mengizinkan kamera/mikrofon.');
      } else if (error && error.name === 'NotFoundError') {
        setStatus('Kamera atau mikrofon tidak ditemukan', 'Pastikan perangkat memiliki kamera dan mikrofon yang aktif.', 'error');
        toast('Perangkat kamera atau mikrofon tidak ditemukan.');
      } else if (error && error.name === 'NotReadableError') {
        setStatus('Kamera sedang digunakan', 'Tutup aplikasi lain yang sedang memakai kamera, lalu coba lagi.', 'error');
        toast('Kamera sedang dipakai aplikasi lain.');
      } else if (error && error.name === 'OverconstrainedError') {
        setStatus('Pengaturan kamera tidak cocok', 'Coba gunakan kamera lain atau mulai ulang browser.', 'error');
        toast('Browser tidak dapat memakai konfigurasi kamera ini.');
      } else {
        setStatus('Koneksi belum siap', error.message || 'Periksa koneksi internet dan coba lagi.', 'error');
        toast(error.message || 'Tidak dapat memulai sesi.');
      }
    }
  }

  function nextMatch() {
    if (!state.socket || !state.socket.connected) return findMatch();
    cleanupPeer();
    clearChat();
    state.waiting = true;
    state.startingMatch = false;
    $('chatDrawer').classList.remove('open');
    $('chatDrawer').setAttribute('aria-hidden', 'true');
    $('remoteTitle').textContent = 'Mencari teman baru...';
    $('remoteSubtitle').textContent = 'Satu momen lagi';
    $('remotePlaceholder').classList.remove('hidden');
    setConnectedControls(false);
    state.socket.emit('match:find', { country: $('myCountry').value, desiredCountry: $('desiredCountry').value });
  }

  function stopSession() {
    if (state.socket) state.socket.emit('match:stop');
    cleanupPeer();
    if (state.localStream) state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
    state.started = false;
    state.waiting = false;
    state.startingMatch = false;
    $('localVideo').srcObject = null;
    $('localPlaceholder').classList.remove('hidden');
    $('startBtn').disabled = false;
    $('startBtn').innerHTML = `${icon('spark', 'button-icon')}<span>Mulai ngobrol</span>${icon('arrow', 'button-arrow')}`;
    setConnectedControls(false);
    updateMediaButtons();
    setStatus('Kamu sedang offline', 'Tekan mulai kapan saja untuk mencari teman.', 'idle');
    setRemoteStatus('Belum terhubung');
    $('connectionText').textContent = 'Kamera dan mikrofon belum diaktifkan';
  }

  function updateMediaButtons() {
    $('muteBtn').classList.toggle('active', !state.microphoneEnabled);
    $('muteBtn').innerHTML = `${icon(state.microphoneEnabled ? 'mic' : 'micOff', 'utility-icon')}<span>${state.microphoneEnabled ? 'Mute' : 'Unmute'}</span>`;
    $('cameraBtn').classList.toggle('active', !state.cameraEnabled);
    $('cameraBtn').innerHTML = `${icon(state.cameraEnabled ? 'camera' : 'cameraOff', 'utility-icon')}<span>${state.cameraEnabled ? 'Kamera' : 'Video off'}</span>`;
  }

  function toggleMicrophone() {
    if (!state.localStream) return;
    state.microphoneEnabled = !state.microphoneEnabled;
    state.localStream.getAudioTracks().forEach((track) => { track.enabled = state.microphoneEnabled; });
    updateMediaButtons();
  }

  function toggleCamera() {
    if (!state.localStream) return;
    state.cameraEnabled = !state.cameraEnabled;
    state.localStream.getVideoTracks().forEach((track) => { track.enabled = state.cameraEnabled; });
    $('localPlaceholder').classList.toggle('camera-off', state.cameraEnabled);
    $('localPlaceholder').classList.toggle('hidden', state.cameraEnabled);
    updateMediaButtons();
  }

  function showModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  function bindUI() {
    const birthDate = $('birthDate');
    const today = new Date();
    birthDate.max = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const updateAgeGate = () => {
      const value = birthDate.value;
      let adult = false;
      if (value) {
        const [year, month, day] = value.split('-').map(Number);
        const now = new Date();
        let age = now.getFullYear() - year;
        if (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)) age -= 1;
        adult = age >= 18 && new Date(year, month - 1, day) <= now;
        $('ageError').textContent = adult ? 'Tanggal lahir diperiksa secara lokal dan tidak dikirim ke server.' : 'Maaf, Gomi hanya tersedia untuk pengguna berusia 18 tahun ke atas.';
        $('ageError').classList.toggle('error', !adult);
      } else {
        $('ageError').textContent = 'Tanggal lahir diperiksa secara lokal dan tidak dikirim ke server.';
        $('ageError').classList.remove('error');
      }
      $('ageContinue').disabled = !(adult && $('ageCheck').checked);
    };
    birthDate.addEventListener('change', updateAgeGate);
    $('ageCheck').addEventListener('change', updateAgeGate);
    $('ageContinue').addEventListener('click', () => {
      if (!$('ageCheck').checked) return;
      sessionStorage.setItem('gomi_age_confirmed', 'yes');
      closeModal('ageModal');
    });
    if (sessionStorage.getItem('gomi_age_confirmed') === 'yes') closeModal('ageModal');

    $('startBtn').addEventListener('click', () => {
      if (state.waiting) { nextMatch(); return; }
      findMatch();
    });
    $('nextBtn').addEventListener('click', nextMatch);
    $('muteBtn').addEventListener('click', toggleMicrophone);
    $('cameraBtn').addEventListener('click', toggleCamera);
    $('stopBtn').addEventListener('click', stopSession);
    $('permissionHelpBtn').addEventListener('click', () => showModal('permissionHelpModal'));
    $('closePermissionHelpBtn').addEventListener('click', () => closeModal('permissionHelpModal'));
    $('permissionHelpDone').addEventListener('click', () => closeModal('permissionHelpModal'));
    $('permissionHelpModal').addEventListener('click', (event) => { if (event.target === $('permissionHelpModal')) closeModal('permissionHelpModal'); });
    $('chatBtn').addEventListener('click', () => {
      $('chatDrawer').classList.add('open');
      $('chatDrawer').setAttribute('aria-hidden', 'false');
      $('chatInput').focus();
    });
    $('closeChatBtn').addEventListener('click', () => {
      $('chatDrawer').classList.remove('open');
      $('chatDrawer').setAttribute('aria-hidden', 'true');
    });
    $('chatForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const message = $('chatInput').value.trim();
      if (!message || !state.remoteUserId || !state.socket) return;
      state.socket.emit('chat:send', { message });
      $('chatInput').value = '';
    });
    $('reportBtn').addEventListener('click', () => showModal('reportModal'));
    $('closeReportBtn').addEventListener('click', () => closeModal('reportModal'));
    $('reportForm').addEventListener('submit', (event) => {
      event.preventDefault();
      if (!state.remoteUserId || !state.socket) return;
      state.socket.emit('safety:report', { userId: state.remoteUserId, reason: $('reportReason').value, comment: $('reportComment').value });
      $('reportBtn').disabled = true;
    });
    $('blockBtn').addEventListener('click', () => {
      if (!state.remoteUserId || !state.socket) return;
      if (window.confirm('Blokir teman ini? Kamu tidak akan dipasangkan dengannya lagi.')) {
        state.socket.emit('safety:block', { userId: state.remoteUserId });
        $('blockBtn').disabled = true;
      }
    });
    const showGuidelines = () => showModal('guidelinesModal');
    $('guidelinesBtn').addEventListener('click', showGuidelines);
    $('footerGuidelines').addEventListener('click', showGuidelines);
    $('closeGuidelinesBtn').addEventListener('click', () => closeModal('guidelinesModal'));
    $('guidelinesOk').addEventListener('click', () => closeModal('guidelinesModal'));
    $('guidelinesModal').addEventListener('click', (event) => { if (event.target === $('guidelinesModal')) closeModal('guidelinesModal'); });
    $('reportModal').addEventListener('click', (event) => { if (event.target === $('reportModal')) closeModal('reportModal'); });
    $('myCountry').addEventListener('change', () => {
      if (state.waiting && state.socket) nextMatch();
    });
    $('desiredCountry').addEventListener('change', () => {
      if (state.waiting && state.socket) nextMatch();
    });
    window.addEventListener('beforeunload', () => {
      if (state.socket) state.socket.emit('match:stop');
      if (state.localStream) state.localStream.getTracks().forEach((track) => track.stop());
    });
  }

  async function init() {
    state.userId = getUserId();
    bindUI();
    await loadConfig();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
