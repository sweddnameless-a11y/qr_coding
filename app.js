(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const urlInput = $('url-input');
  const readerEl = $('reader');
  const videoEl = $('camera-video');
  const frameCanvas = document.createElement('canvas');
  const placeholder = $('camera-placeholder');
  const cameraStatus = $('camera-status');
  const startButton = $('start-camera');
  const stopButton = $('stop-camera');
  const fileInput = $('qr-file');
  const resultCard = $('result-card');
  const resultSymbol = $('result-symbol');
  const resultHeading = $('result-heading');
  const resultMessage = $('result-message');
  const resultHost = $('result-host');
  const resultActions = $('result-actions');
  const copyButton = $('copy-url');
  const shareButton = $('share-url');
  const openButton = $('open-url');
  const authPill = $('auth-pill');
  const authPillText = $('auth-pill-text');
  const loginPanel = $('login-panel');
  const otpPanel = $('otp-panel');
  const signedInPanel = $('signed-in-panel');
  const authStatus = $('auth-status');
  const loginForm = $('login-form');
  const otpForm = $('otp-form');
  const loginButton = $('login-button');
  const otpButton = $('otp-button');
  const logoutButton = $('logout-button');

  const ALLOWED_HOSTS = new Set([
    'pulse.mirea.ru',
    'attendance-app.mirea.ru',
    'attendance.mirea.ru',
    'att.mirea.ru'
  ]);
  let cameraStream = null;
  let scanTimer = null;
  let decodeBusy = false;
  let isStarting = false;
  let isScanning = false;
  let scanHandled = false;
  let verifiedUrl = '';
  let isAuthenticated = false;
  let attendanceInFlight = false;
  let lastAttempt = { url: '', at: 0 };

  function setCameraStatus(message, isError = false) {
    cameraStatus.textContent = message;
    cameraStatus.style.color = isError ? '#ffb7b7' : '';
  }

  function showResult(kind, heading, message, host = '', actions = false) {
    resultCard.classList.remove('success', 'error', 'pending');
    if (kind === 'success') resultCard.classList.add('success');
    if (kind === 'error') resultCard.classList.add('error');
    if (kind === 'pending') resultCard.classList.add('pending');
    resultSymbol.textContent = kind === 'success' ? '✓' : kind === 'error' ? '!' : kind === 'pending' ? '…' : 'i';
    resultHeading.textContent = heading;
    resultMessage.textContent = message;
    resultHost.textContent = host;
    resultHost.hidden = !host;
    resultActions.hidden = !actions || !verifiedUrl;
  }

  function setAuthView(mode, message = '') {
    loginPanel.hidden = mode !== 'logged-out';
    otpPanel.hidden = mode !== 'otp';
    signedInPanel.hidden = mode !== 'logged-in';
    isAuthenticated = mode === 'logged-in';
    authPill.classList.toggle('signed-in', isAuthenticated);
    authPillText.textContent = mode === 'logged-in' ? 'Вход выполнен' : mode === 'otp' ? 'Нужен код' : 'Не выполнен вход';
    authStatus.textContent = message || (isAuthenticated
      ? 'Вход сохранён. При сканировании будет отправлен запрос для этого аккаунта.'
      : mode === 'otp'
        ? 'МИРЭА запросила дополнительный код подтверждения.'
        : 'Для автоматической отметки сначала выполни вход.');
  }

  function validateUrl(raw) {
    const input = String(raw || '').trim();
    if (!input) return { ok: false, message: 'Сначала отсканируй QR-код или вставь ссылку.' };
    if (input.length > 2048) return { ok: false, message: 'Ссылка слишком длинная и отклонена.' };
    let url;
    try { url = new URL(input); }
    catch { return { ok: false, message: 'QR считан, но содержимое не является корректным URL.' }; }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
      return { ok: false, message: 'Разрешены только безопасные HTTPS-ссылки на стандартном порту.' };
    }
    const host = url.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) {
      return { ok: false, message: `Домен ${host || 'не определён'} не входит в список разрешённых адресов МИРЭА.` };
    }
    const tokens = url.searchParams.getAll('token');
    if (tokens.length !== 1 || !tokens[0].trim()) {
      return { ok: false, message: 'Ссылка должна содержать ровно один непустой параметр token.' };
    }
    return { ok: true, url: url.href, host };
  }

  async function apiRequest(path, payload = null) {
    const options = {
      method: payload === null ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    };
    if (payload !== null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(path, options);
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Сервер вернул ответ в непонятном формате.'); }
    if (!response.ok && response.status !== 401 && response.status !== 202) {
      throw new Error(body.detail || body.message || `Ошибка сервера (${response.status}).`);
    }
    return { response, body };
  }

  async function refreshAuthStatus() {
    try {
      const { body } = await apiRequest('/api/me');
      if (body.authenticated) {
        setAuthView('logged-in', body.message || 'Вход сохранён на сервере.');
        return true;
      }
    } catch (error) {
      setAuthView('logged-out', `Не удалось проверить сохранённый вход: ${error.message}`);
      return false;
    }
    setAuthView('logged-out');
    return false;
  }

  function extractSessionExpired(message) {
    const text = String(message || '').toLowerCase();
    return ['сессия истекла', 'перелогин', 'needs_auth', 'unauthorized', 'не авториз'].some((term) => text.includes(term));
  }

  async function submitAttendance(raw) {
    const outcome = validateUrl(raw);
    if (!outcome.ok) {
      verifiedUrl = '';
      showResult('error', 'QR не прошёл проверку', outcome.message);
      return;
    }
    verifiedUrl = outcome.url;
    urlInput.value = outcome.url;
    if (!isAuthenticated) {
      showResult('pending', 'QR прочитан — нужен вход', 'Войди в свой аккаунт выше. После успешного входа приложение автоматически отправит этот QR для личной отметки.', outcome.host, true);
      return;
    }
    const now = Date.now();
    if (attendanceInFlight) return;
    if (lastAttempt.url === outcome.url && now - lastAttempt.at < 10000) {
      showResult('pending', 'Запрос уже отправлялся', 'Не отправляю тот же QR повторно в течение 10 секунд, чтобы случайно не создать дублирующий запрос.', outcome.host, true);
      return;
    }
    attendanceInFlight = true;
    lastAttempt = { url: outcome.url, at: now };
    showResult('pending', 'Отправляю запрос…', 'Отправляю запрос на личную отметку от имени твоей сохранённой сессии МИРЭА.', outcome.host, true);
    $('validate-url').disabled = true;
    try {
      const { body } = await apiRequest('/api/attendance', { qr_data: outcome.url });
      if (body.detail && !body.success && !body.message) {
        showResult('error', 'Нужен повторный вход', body.detail, outcome.host, true);
        setAuthView('logged-out', body.detail);
      } else if (body.success) {
        showResult('success', 'Сервер подтвердил отметку', body.message || 'МИРЭА вернула успешный результат.', outcome.host, true);
      } else {
        showResult('error', 'Отметка не подтверждена', body.message || body.detail || 'МИРЭА не подтвердила действие.', outcome.host, true);
        if (extractSessionExpired(body.message || body.detail)) {
          setAuthView('logged-out', 'Сессия МИРЭА истекла. Войди заново.');
        }
      }
    } catch (error) {
      showResult('error', 'Не удалось выполнить запрос', error.message || 'Проверь подключение и попробуй снова.', outcome.host, true);
    } finally {
      attendanceInFlight = false;
      $('validate-url').disabled = false;
    }
  }

  async function decodeImageBlob(blob) {
    const response = await fetch('/api/decode-qr', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'Accept': 'application/json' },
      body: blob
    });
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Сервер распознавания QR вернул непонятный ответ.'); }
    if (!response.ok) throw new Error(body.detail || body.message || 'Не удалось распознать QR.');
    return body.text || '';
  }

  async function scanCameraFrame() {
    if (!isScanning || decodeBusy || !videoEl.videoWidth || !videoEl.videoHeight) {
      if (isScanning) scanTimer = setTimeout(scanCameraFrame, 650);
      return;
    }
    decodeBusy = true;
    try {
      const scale = Math.min(1, 960 / videoEl.videoWidth, 720 / videoEl.videoHeight);
      frameCanvas.width = Math.max(1, Math.round(videoEl.videoWidth * scale));
      frameCanvas.height = Math.max(1, Math.round(videoEl.videoHeight * scale));
      const ctx = frameCanvas.getContext('2d', { alpha: false });
      ctx.drawImage(videoEl, 0, 0, frameCanvas.width, frameCanvas.height);
      const blob = await new Promise((resolve) => frameCanvas.toBlob(resolve, 'image/jpeg', 0.58));
      if (blob && isScanning) {
        const text = await decodeImageBlob(blob);
        if (text && isScanning && !scanHandled) {
          scanHandled = true;
          urlInput.value = text;
          if (navigator.vibrate) navigator.vibrate(70);
          await stopCamera({ quiet: true });
          await submitAttendance(text);
          setCameraStatus('QR-код считан. Чтобы отсканировать следующий, снова включи камеру.');
          return;
        }
      }
    } catch (error) {
      // A few unreadable video frames are normal; only surface repeated network errors.
      if (String(error.message || '').includes('Failed to fetch')) {
        setCameraStatus('Нет связи с сервером распознавания. Проверь интернет.', true);
      }
    } finally {
      decodeBusy = false;
    }
    if (isScanning) scanTimer = setTimeout(scanCameraFrame, 850);
  }

  async function startCamera() {
    if (isStarting || isScanning) return;
    if (!window.isSecureContext) {
      setCameraStatus('Камера работает только на HTTPS (или localhost). Открой приложение на HTTPS-хостинге.', true);
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraStatus('Этот браузер не предоставляет доступ к камере. Обнови Safari/Chrome или выбери изображение QR.', true);
      return;
    }
    isStarting = true;
    startButton.disabled = true;
    setCameraStatus('Запрашиваю доступ к камере…');
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      videoEl.srcObject = cameraStream;
      videoEl.hidden = false;
      await videoEl.play();
      isScanning = true;
      scanHandled = false;
      placeholder.hidden = true;
      stopButton.disabled = false;
      setCameraStatus('Камера работает. Наведи её на QR-код занятия.');
      scanTimer = setTimeout(scanCameraFrame, 350);
    } catch (error) {
      const message = String(error && (error.message || error));
      setCameraStatus(message.toLowerCase().includes('permission') || message.toLowerCase().includes('denied')
        ? 'Доступ к камере запрещён. Разреши камеру для этого сайта в настройках браузера.'
        : `Не удалось запустить камеру: ${message.slice(0, 150)}`, true);
      if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
      videoEl.srcObject = null;
      isScanning = false;
      placeholder.hidden = false;
    } finally {
      isStarting = false;
      startButton.disabled = false;
    }
  }

  async function stopCamera(options = {}) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    isScanning = false;
    isStarting = false;
    decodeBusy = false;
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    videoEl.srcObject = null;
    startButton.disabled = false;
    stopButton.disabled = true;
    placeholder.hidden = false;
    if (!options.quiet) setCameraStatus('Камера остановлена.');
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('username-input').value.trim();
    const password = $('password-input').value;
    if (!username || !password) return;
    loginButton.disabled = true;
    authStatus.textContent = 'Отправляю запрос на вход через МИРЭА…';
    try {
      const { response, body } = await apiRequest('/api/login', { username, password });
      $('password-input').value = '';
      if (response.status === 202 || body.challenge_required) {
        setAuthView('otp', body.message || 'Введи код подтверждения.');
        $('otp-input').focus();
      } else if (body.authenticated) {
        setAuthView('logged-in', body.message || 'Вход успешно выполнен.');
        await submitPendingUrl();
      } else {
        setAuthView('logged-out', body.message || 'Вход не выполнен.');
      }
    } catch (error) {
      $('password-input').value = '';
      setAuthView('logged-out', error.message || 'Не удалось выполнить вход.');
    } finally {
      loginButton.disabled = false;
    }
  });

  otpForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = $('otp-input').value.trim();
    if (!code) return;
    otpButton.disabled = true;
    authStatus.textContent = 'Проверяю код…';
    try {
      const { response, body } = await apiRequest('/api/2fa', { code });
      $('otp-input').value = '';
      if (response.status === 202 || body.challenge_required) {
        setAuthView('otp', body.message || 'Потребовался ещё один шаг подтверждения.');
      } else if (body.authenticated) {
        setAuthView('logged-in', body.message || 'Вход успешно выполнен.');
        await submitPendingUrl();
      } else {
        setAuthView('logged-out', body.message || body.detail || 'Вход не выполнен. Попробуй снова.');
      }
    } catch (error) {
      $('otp-input').value = '';
      setAuthView('logged-out', error.message || 'Код не принят или время входа истекло.');
    } finally {
      otpButton.disabled = false;
    }
  });

  async function submitPendingUrl() {
    if (verifiedUrl) await submitAttendance(verifiedUrl);
  }

  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await apiRequest('/api/logout', {});
      setAuthView('logged-out', 'Выход выполнен.');
      showResult('info', 'Выход выполнен', 'Сессия приложения удалена. QR-код нужно будет отправить после следующего входа.');
    } catch (error) {
      authStatus.textContent = `Не удалось выйти: ${error.message}`;
    } finally { logoutButton.disabled = false; }
  });

  startButton.addEventListener('click', startCamera);
  stopButton.addEventListener('click', () => stopCamera());
  $('validate-url').addEventListener('click', () => submitAttendance(urlInput.value));
  $('paste-url').addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('clipboard-unavailable');
      const pasted = await navigator.clipboard.readText();
      if (!pasted) { showResult('info', 'Буфер обмена пуст', 'Скопируй ссылку в другом приложении, затем нажми «Вставить» ещё раз.'); return; }
      urlInput.value = pasted.trim();
      await submitAttendance(urlInput.value);
    } catch (_) {
      showResult('info', 'Вставь ссылку вручную', 'Нажми и удерживай поле ввода, затем выбери «Вставить».');
      urlInput.focus();
    }
  });
  urlInput.addEventListener('input', () => {
    verifiedUrl = '';
    resultActions.hidden = true;
  });
  copyButton.addEventListener('click', async () => {
    if (!verifiedUrl) return;
    try {
      await navigator.clipboard.writeText(verifiedUrl);
      showResult('success', 'Ссылка скопирована', 'Ссылка сохранена в буфере обмена.', new URL(verifiedUrl).hostname, true);
    } catch (_) {
      urlInput.focus(); urlInput.select();
      showResult('info', 'Скопируй ссылку вручную', 'Выдели текст в поле ввода и используй команду «Копировать».', new URL(verifiedUrl).hostname, true);
    }
  });
  shareButton.addEventListener('click', async () => {
    if (!verifiedUrl) return;
    if (!navigator.share) {
      try { await navigator.clipboard.writeText(verifiedUrl); showResult('success', 'Ссылка скопирована', 'Системное меню недоступно, поэтому ссылка скопирована.', new URL(verifiedUrl).hostname, true); }
      catch (_) { showResult('info', 'Поделиться не удалось', 'Скопируй ссылку вручную.'); }
      return;
    }
    try { await navigator.share({ title: 'Ссылка MIREA', text: 'Ссылка, считанная из QR-кода', url: verifiedUrl }); }
    catch (error) { if (error && error.name !== 'AbortError') showResult('info', 'Поделиться не удалось', 'Попробуй скопировать ссылку вручную.'); }
  });
  openButton.addEventListener('click', () => { if (verifiedUrl) window.open(verifiedUrl, '_blank', 'noopener,noreferrer'); });

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (isScanning || cameraStream) await stopCamera({ quiet: true });
    setCameraStatus('Проверяю изображение QR…');
    try {
      let imageBitmap;
      if (window.createImageBitmap) {
        imageBitmap = await createImageBitmap(file);
      } else {
        imageBitmap = await new Promise((resolve, reject) => {
          const image = new Image();
          const url = URL.createObjectURL(file);
          image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
          image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image decode failed')); };
          image.src = url;
        });
      }
      const originalWidth = imageBitmap.width || imageBitmap.naturalWidth;
      const originalHeight = imageBitmap.height || imageBitmap.naturalHeight;
      const scale = Math.min(1, 1600 / originalWidth, 1600 / originalHeight);
      frameCanvas.width = Math.max(1, Math.round(originalWidth * scale));
      frameCanvas.height = Math.max(1, Math.round(originalHeight * scale));
      frameCanvas.getContext('2d', { alpha: false }).drawImage(imageBitmap, 0, 0, frameCanvas.width, frameCanvas.height);
      if (typeof imageBitmap.close === 'function') imageBitmap.close();
      const blob = await new Promise((resolve) => frameCanvas.toBlob(resolve, 'image/jpeg', 0.82));
      if (!blob) throw new Error('cannot encode image');
      const text = await decodeImageBlob(blob);
      if (!text) {
        showResult('error', 'QR-код не найден', 'Выбери чёткое изображение, на котором QR-код полностью виден.');
        setCameraStatus('Не удалось считать QR из этого изображения.', true);
      } else {
        urlInput.value = text;
        await submitAttendance(text);
        setCameraStatus('QR-код на изображении считан и обработан.');
      }
    } catch (error) {
      showResult('error', 'Не удалось прочитать изображение', 'Проверь изображение и подключение к серверу, затем попробуй ещё раз.');
      setCameraStatus('Не удалось обработать изображение QR.', true);
    } finally {
      fileInput.value = '';
    }
  });

  window.addEventListener('pagehide', () => {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
  refreshAuthStatus();
})();
