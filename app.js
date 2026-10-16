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

  // --------------------------------------------------
  // Камера и отображение результата
  // --------------------------------------------------

  function setCameraStatus(message, isError = false) {
    cameraStatus.textContent = message;
    cameraStatus.style.color = isError ? '#ffb7b7' : '';
  }

  function showResult(kind, heading, message, host = '', actions = false) {
    resultCard.classList.remove('success', 'error', 'pending');

    if (kind === 'success') resultCard.classList.add('success');
    if (kind === 'error') resultCard.classList.add('error');
    if (kind === 'pending') resultCard.classList.add('pending');

    resultSymbol.textContent =
      kind === 'success' ? '✓' :
      kind === 'error' ? '!' :
      kind === 'pending' ? '…' : 'i';

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

    authPillText.textContent =
      mode === 'logged-in' ? 'Вход выполнен' :
      mode === 'otp' ? 'Нужен код' :
      'Не выполнен вход';

    authStatus.textContent = message || (
      isAuthenticated
        ? 'Вход сохранён. При сканировании будет отправлен запрос для этого аккаунта.'
        : mode === 'otp'
          ? 'МИРЭА запросила дополнительный код подтверждения.'
          : 'Для автоматической отметки сначала выполни вход.'
    );
  }

  // --------------------------------------------------
  // Проверка QR-ссылки
  // --------------------------------------------------

  function validateUrl(raw) {
    const input = String(raw || '').trim();

    if (!input) {
      return {
        ok: false,
        message: 'Сначала отсканируй QR-код или вставь ссылку.'
      };
    }

    if (input.length > 2048) {
      return {
        ok: false,
        message: 'Ссылка слишком длинная и отклонена.'
      };
    }

    let url;

    try {
      url = new URL(input);
    } catch {
      return {
        ok: false,
        message: 'QR считан, но содержимое не является корректным URL.'
      };
    }

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    ) {
      return {
        ok: false,
        message: 'Разрешены только HTTPS-ссылки на стандартном порту.'
      };
    }

    const host = url.hostname.toLowerCase();

    if (!ALLOWED_HOSTS.has(host)) {
      return {
        ok: false,
        message: `Домен ${host || 'не определён'} не входит в список разрешённых адресов МИРЭА.`
      };
    }

    const tokens = url.searchParams.getAll('token');

    if (tokens.length !== 1 || !tokens[0].trim()) {
      return {
        ok: false,
        message: 'Ссылка должна содержать ровно один непустой параметр token.'
      };
    }

    return {
      ok: true,
      url: url.href,
      host
    };
  }

  // --------------------------------------------------
  // HTTP-запросы к серверу
  // --------------------------------------------------

  async function apiRequest(path, payload = null) {
    const options = {
      method: payload === null ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json'
      }
    };

    if (payload !== null) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(payload);
    }

    let response;

    try {
      response = await fetch(path, options);
    } catch (error) {
      console.error('Network request failed:', path, error);

      throw new Error(
        'Не удалось связаться с сервером. Проверь подключение и адрес сайта.'
      );
    }

    let body;

    try {
      body = await response.json();
    } catch {
      console.error(
        'Invalid JSON response:',
        path,
        response.status
      );

      throw new Error(
        `Сервер вернул ответ в непонятном формате (HTTP ${response.status}).`
      );
    }

    if (
      !response.ok &&
      response.status !== 401 &&
      response.status !== 202
    ) {
      const message =
        body.detail ||
        body.message ||
        `Ошибка сервера (${response.status}).`;

      console.error('API request failed:', {
        path,
        status: response.status,
        message
      });

      throw new Error(`HTTP ${response.status}: ${message}`);
    }

    return { response, body };
  }

  // --------------------------------------------------
  // Проверка сохранённой авторизации
  // --------------------------------------------------

  async function refreshAuthStatus() {
    try {
      const { response, body } = await apiRequest('/api/me');

      if (!response.ok) {
        setAuthView(
          'logged-out',
          `Не удалось проверить вход. HTTP ${response.status}.`
        );

        return false;
      }

      if (body.authenticated) {
        setAuthView(
          'logged-in',
          body.message || 'Вход сохранён на сервере.'
        );

        return true;
      }

      setAuthView(
        'logged-out',
        body.message || 'Сохранённая сессия не найдена. Выполни вход.'
      );

      return false;
    } catch (error) {
      setAuthView(
        'logged-out',
        `Ошибка проверки входа: ${error.message}`
      );

      return false;
    }
  }

  function extractSessionExpired(message) {
    const text = String(message || '').toLowerCase();

    return [
      'сессия истекла',
      'перелогин',
      'needs_auth',
      'unauthorized',
      'не авториз',
      'войдите заново'
    ].some((term) => text.includes(term));
  }

  // --------------------------------------------------
  // Отметка посещаемости
  // --------------------------------------------------

  async function submitAttendance(raw) {
    const outcome = validateUrl(raw);

    if (!outcome.ok) {
      verifiedUrl = '';

      showResult(
        'error',
        'QR не прошёл проверку',
        outcome.message
      );

      return;
    }

    verifiedUrl = outcome.url;
    urlInput.value = outcome.url;

    if (!isAuthenticated) {
      showResult(
        'pending',
        'QR прочитан — нужен вход',
        'Войди в свой аккаунт выше. После успешного входа приложение отправит этот QR для личной отметки.',
        outcome.host,
        true
      );

      return;
    }

    const now = Date.now();

    if (attendanceInFlight) {
      return;
    }

    if (
      lastAttempt.url === outcome.url &&
      now - lastAttempt.at < 10000
    ) {
      showResult(
        'pending',
        'Запрос уже отправлялся',
        'Этот QR уже отправлялся в последние 10 секунд. Подожди, прежде чем пробовать снова.',
        outcome.host,
        true
      );

      return;
    }

    attendanceInFlight = true;
    lastAttempt = {
      url: outcome.url,
      at: now
    };

    showResult(
      'pending',
      'Отправляю запрос…',
      'Отправляю запрос на личную отметку от имени сохранённой сессии МИРЭА.',
      outcome.host,
      true
    );

    $('validate-url').disabled = true;

    try {
      const { response, body } = await apiRequest(
        '/api/attendance',
        { qr_data: outcome.url }
      );

      if (response.status === 401) {
        setAuthView(
          'logged-out',
          body.detail || body.message || 'Сессия не найдена. Войди заново.'
        );

        showResult(
          'error',
          'Требуется повторный вход',
          body.detail || body.message || 'Сервер не обнаружил действующую сессию.',
          outcome.host,
          true
        );

        return;
      }

      if (body.success === true) {
        showResult(
          'success',
          'Сервер подтвердил отметку',
          body.message || 'МИРЭА вернула успешный результат.',
          outcome.host,
          true
        );

      } else {
        const message =
          body.message ||
          body.detail ||
          'МИРЭА не подтвердила действие.';

        console.error('Attendance was not confirmed:', {
          status: response.status,
          success: body.success,
          message,
          host: body.host
        });

        showResult(
          'error',
          'Отметка не подтверждена',
          `HTTP ${response.status}: ${message}`,
          outcome.host,
          true
        );

        if (extractSessionExpired(message)) {
          setAuthView(
            'logged-out',
            'Возможно, сессия МИРЭА истекла. Войди заново.'
          );
        }
      }

    } catch (error) {
      console.error('Attendance request failed:', error);

      showResult(
        'error',
        'Не удалось выполнить запрос',
        error.message || 'Проверь подключение и попробуй снова.',
        outcome.host,
        true
      );

    } finally {
      attendanceInFlight = false;
      $('validate-url').disabled = false;
    }
  }

  // --------------------------------------------------
  // Распознавание QR на сервере
  // --------------------------------------------------

  async function decodeImageBlob(blob) {
    let response;

    try {
      response = await fetch('/api/decode-qr', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Accept': 'application/json'
        },
        body: blob
      });
    } catch {
      throw new Error('Не удалось связаться с сервером распознавания QR.');
    }

    let body;

    try {
      body = await response.json();
    } catch {
      throw new Error(
        `Сервер распознавания вернул непонятный ответ (HTTP ${response.status}).`
      );
    }

    if (!response.ok) {
      throw new Error(
        body.detail ||
        body.message ||
        `Ошибка распознавания (HTTP ${response.status}).`
      );
    }

    return body.text || '';
  }

  // --------------------------------------------------
  // Сканирование камеры
  // --------------------------------------------------

  async function scanCameraFrame() {
    if (
      !isScanning ||
      decodeBusy ||
      !videoEl.videoWidth ||
      !videoEl.videoHeight
    ) {
      if (isScanning) {
        scanTimer = setTimeout(scanCameraFrame, 650);
      }

      return;
    }

    decodeBusy = true;

    try {
      const scale = Math.min(
        1,
        960 / videoEl.videoWidth,
        720 / videoEl.videoHeight
      );

      frameCanvas.width = Math.max(
        1,
        Math.round(videoEl.videoWidth * scale)
      );

      frameCanvas.height = Math.max(
        1,
        Math.round(videoEl.videoHeight * scale)
      );

      const ctx = frameCanvas.getContext('2d', {
        alpha: false
      });

      ctx.drawImage(
        videoEl,
        0,
        0,
        frameCanvas.width,
        frameCanvas.height
      );

      const blob = await new Promise((resolve) => {
        frameCanvas.toBlob(
          resolve,
          'image/jpeg',
          0.58
        );
      });

      if (blob && isScanning) {
        const text = await decodeImageBlob(blob);

        if (text && isScanning && !scanHandled) {
          scanHandled = true;

          urlInput.value = text;

          if (navigator.vibrate) {
            navigator.vibrate(70);
          }

          await stopCamera({ quiet: true });
          await submitAttendance(text);

          setCameraStatus(
            'QR-код считан. Чтобы отсканировать следующий, снова включи камеру.'
          );

          return;
        }
      }

    } catch (error) {
      console.error('Camera frame decode failed:', error);

      if (
        String(error.message || '').includes('связаться с сервером')
      ) {
        setCameraStatus(
          'Нет связи с сервером распознавания. Проверь интернет.',
          true
        );
      }

    } finally {
      decodeBusy = false;
    }

    if (isScanning) {
      scanTimer = setTimeout(scanCameraFrame, 850);
    }
  }

  async function startCamera() {
    if (isStarting || isScanning) return;

    if (!window.isSecureContext) {
      setCameraStatus(
        'Камера работает только через HTTPS или localhost.',
        true
      );

      return;
    }

    if (
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setCameraStatus(
        'Браузер не предоставляет доступ к камере. Выбери изображение QR.',
        true
      );

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

      setCameraStatus(
        'Камера работает. Наведи её на QR-код занятия.'
      );

      scanTimer = setTimeout(scanCameraFrame, 350);

    } catch (error) {
      console.error('Camera startup failed:', error);

      const message = String(error && (error.message || error));

      setCameraStatus(
        message.toLowerCase().includes('permission') ||
        message.toLowerCase().includes('denied')
          ? 'Доступ к камере запрещён. Разреши камеру в настройках браузера.'
          : `Не удалось запустить камеру: ${message.slice(0, 150)}`,
        true
      );

      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
      }

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
    if (scanTimer) {
      clearTimeout(scanTimer);
    }

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

    if (!options.quiet) {
      setCameraStatus('Камера остановлена.');
    }
  }

  // --------------------------------------------------
  // Вход в аккаунт
  // --------------------------------------------------

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const username = $('username-input').value.trim();
    const password = $('password-input').value;

    if (!username || !password) return;

    loginButton.disabled = true;

    authStatus.textContent =
      'Отправляю запрос на вход через МИРЭА…';

    try {
      const { response, body } = await apiRequest(
        '/api/login',
        { username, password }
      );

      $('password-input').value = '';

      console.log('Login response:', {
        status: response.status,
        authenticated: body.authenticated,
        challenge_required: body.challenge_required,
        message: body.message || body.detail || ''
      });

      if (response.status === 202 || body.challenge_required) {
        setAuthView(
          'otp',
          body.message || 'Введи код подтверждения.'
        );

        $('otp-input').focus();

      } else if (
        response.ok &&
        body.authenticated === true
      ) {
        setAuthView(
          'logged-in',
          body.message || 'Вход успешно выполнен.'
        );

        await submitPendingUrl();

      } else {
        const message =
          body.message ||
          body.detail ||
          'Сервер не подтвердил вход.';

        setAuthView(
          'logged-out',
          `Ошибка входа (HTTP ${response.status}): ${message}`
        );

        console.error('MIREA login failed:', {
          status: response.status,
          authenticated: body.authenticated,
          message
        });
      }

    } catch (error) {
      $('password-input').value = '';

      setAuthView(
        'logged-out',
        `Ошибка входа: ${error.message}`
      );

      console.error('Login request failed:', error);

    } finally {
      loginButton.disabled = false;
    }
  });

  // --------------------------------------------------
  // Двухфакторная авторизация
  // --------------------------------------------------

  otpForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const code = $('otp-input').value.trim();

    if (!code) return;

    otpButton.disabled = true;
    authStatus.textContent = 'Проверяю код…';

    try {
      const { response, body } = await apiRequest(
        '/api/2fa',
        { code }
      );

      $('otp-input').value = '';

      console.log('2FA response:', {
        status: response.status,
        authenticated: body.authenticated,
        challenge_required: body.challenge_required,
        message: body.message || body.detail || ''
      });

      if (response.status === 202 || body.challenge_required) {
        setAuthView(
          'otp',
          body.message || 'Потребовался ещё один шаг подтверждения.'
        );

      } else if (
        response.ok &&
        body.authenticated === true
      ) {
        setAuthView(
          'logged-in',
          body.message || 'Вход успешно выполнен.'
        );

        await submitPendingUrl();

      } else {
        const message =
          body.message ||
          body.detail ||
          'МИРЭА не подтвердила вход.';

        setAuthView(
          'logged-out',
          `Ошибка подтверждения (HTTP ${response.status}): ${message}`
        );

        console.error('MIREA 2FA failed:', {
          status: response.status,
          authenticated: body.authenticated,
          message
        });
      }

    } catch (error) {
      $('otp-input').value = '';

      setAuthView(
        'otp',
        `Ошибка проверки кода: ${error.message}`
      );

      console.error('2FA request failed:', error);

    } finally {
      otpButton.disabled = false;
    }
  });

  async function submitPendingUrl() {
    if (verifiedUrl) {
      await submitAttendance(verifiedUrl);
    }
  }

  // --------------------------------------------------
  // Выход из аккаунта
  // --------------------------------------------------

  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;

    try {
      await apiRequest('/api/logout', {});

      setAuthView('logged-out', 'Выход выполнен.');

      showResult(
        'info',
        'Выход выполнен',
        'Сессия приложения удалена. После следующего входа QR нужно отправить заново.'
      );

    } catch (error) {
      authStatus.textContent =
        `Не удалось выйти: ${error.message}`;

      console.error('Logout failed:', error);

    } finally {
      logoutButton.disabled = false;
    }
  });

  // --------------------------------------------------
  // Управление камерой и ручной ввод
  // --------------------------------------------------

  startButton.addEventListener('click', startCamera);

  stopButton.addEventListener('click', () => {
    stopCamera();
  });

  $('validate-url').addEventListener('click', () => {
    submitAttendance(urlInput.value);
  });

  $('paste-url').addEventListener('click', async () => {
    try {
      if (
        !navigator.clipboard ||
        !navigator.clipboard.readText
      ) {
        throw new Error('clipboard-unavailable');
      }

      const pasted = await navigator.clipboard.readText();

      if (!pasted) {
        showResult(
          'info',
          'Буфер обмена пуст',
          'Скопируй ссылку в другом приложении и нажми «Вставить» ещё раз.'
        );

        return;
      }

      urlInput.value = pasted.trim();

      await submitAttendance(urlInput.value);

    } catch {
      showResult(
        'info',
        'Вставь ссылку вручную',
        'Нажми и удерживай поле ввода, затем выбери «Вставить».'
      );

      urlInput.focus();
    }
  });

  urlInput.addEventListener('input', () => {
    verifiedUrl = '';
    resultActions.hidden = true;
  });

  // --------------------------------------------------
  // Копирование ссылки
  // --------------------------------------------------

  copyButton.addEventListener('click', async () => {
    if (!verifiedUrl) return;

    try {
      await navigator.clipboard.writeText(verifiedUrl);

      showResult(
        'success',
        'Ссылка скопирована',
        'Ссылка сохранена в буфере обмена.',
        new URL(verifiedUrl).hostname,
        true
      );

    } catch {
      urlInput.focus();
      urlInput.select();

      showResult(
        'info',
        'Скопируй ссылку вручную',
        'Выдели текст в поле ввода и используй команду «Копировать».',
        new URL(verifiedUrl).hostname,
        true
      );
    }
  });

  // --------------------------------------------------
  // Поделиться ссылкой
  // --------------------------------------------------

  shareButton.addEventListener('click', async () => {
    if (!verifiedUrl) return;

    if (!navigator.share) {
      try {
        await navigator.clipboard.writeText(verifiedUrl);

        showResult(
          'success',
          'Ссылка скопирована',
          'Системное меню недоступно, поэтому ссылка скопирована.',
          new URL(verifiedUrl).hostname,
          true
        );

      } catch {
        showResult(
          'info',
          'Поделиться не удалось',
          'Скопируй ссылку вручную.'
        );
      }

      return;
    }

    try {
      await navigator.share({
        title: 'Ссылка MIREA',
        text: 'Ссылка, считанная из QR-кода',
        url: verifiedUrl
      });

    } catch (error) {
      if (error && error.name !== 'AbortError') {
        showResult(
          'info',
          'Поделиться не удалось',
          'Попробуй скопировать ссылку вручную.'
        );
      }
    }
  });

  // --------------------------------------------------
  // Открыть исходную ссылку QR
  // --------------------------------------------------

  openButton.addEventListener('click', () => {
    if (verifiedUrl) {
      window.open(
        verifiedUrl,
        '_blank',
        'noopener,noreferrer'
      );
    }
  });

  // --------------------------------------------------
  // Распознавание QR из изображения
  // --------------------------------------------------

  fileInput.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];

    if (!file) return;

    if (isScanning || cameraStream) {
      await stopCamera({ quiet: true });
    }

    setCameraStatus('Проверяю изображение QR…');

    try {
      let imageBitmap;

      if (window.createImageBitmap) {
        imageBitmap = await createImageBitmap(file);

      } else {
        imageBitmap = await new Promise((resolve, reject) => {
          const image = new Image();
          const objectUrl = URL.createObjectURL(file);

          image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
          };

          image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Не удалось открыть изображение.'));
          };

          image.src = objectUrl;
        });
      }

      const originalWidth =
        imageBitmap.width || imageBitmap.naturalWidth;

      const originalHeight =
        imageBitmap.height || imageBitmap.naturalHeight;

      const scale = Math.min(
        1,
        1600 / originalWidth,
        1600 / originalHeight
      );

      frameCanvas.width = Math.max(
        1,
        Math.round(originalWidth * scale)
      );

      frameCanvas.height = Math.max(
        1,
        Math.round(originalHeight * scale)
      );

      frameCanvas
        .getContext('2d', { alpha: false })
        .drawImage(
          imageBitmap,
          0,
          0,
          frameCanvas.width,
          frameCanvas.height
        );

      if (typeof imageBitmap.close === 'function') {
        imageBitmap.close();
      }

      const blob = await new Promise((resolve) => {
        frameCanvas.toBlob(
          resolve,
          'image/jpeg',
          0.82
        );
      });

      if (!blob) {
        throw new Error('Не удалось обработать изображение.');
      }

      const text = await decodeImageBlob(blob);

      if (!text) {
        showResult(
          'error',
          'QR-код не найден',
          'Выбери чёткое изображение, на котором QR-код полностью виден.'
        );

        setCameraStatus(
          'Не удалось считать QR из этого изображения.',
          true
        );

      } else {
        urlInput.value = text;

        await submitAttendance(text);

        setCameraStatus(
          'QR-код на изображении считан и обработан.'
        );
      }

    } catch (error) {
      console.error('Image QR processing failed:', error);

      showResult(
        'error',
        'Не удалось прочитать изображение',
        error.message || 'Проверь изображение и подключение к серверу.'
      );

      setCameraStatus(
        `Ошибка обработки изображения: ${error.message || 'неизвестная ошибка'}`,
        true
      );

    } finally {
      fileInput.value = '';
    }
  });

  // --------------------------------------------------
  // Завершение работы камеры и запуск приложения
  // --------------------------------------------------

  window.addEventListener('pagehide', () => {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
    }
  });

  if (
    'serviceWorker' in navigator &&
    (
      location.protocol === 'https:' ||
      location.hostname === 'localhost'
    )
  ) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./sw.js')
        .catch((error) => {
          console.error('Service worker registration failed:', error);
        });
    });
  }

  refreshAuthStatus();

})();
