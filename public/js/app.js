/**
 * SmoothRoute — Clean, Real-Data Car & Phone G-Force Tracker & Smooth Route Finder
 */

(function () {
  const G0 = 9.80665;

  const state = {
    token: localStorage.getItem('sr_token') || null,
    user: null,
    templates: [],
    vehicles: [],
    activeVehicleTemplateId: 'tesla-model-y-lr',
    activeVehicleId: null,
    routes: [],
    hazards: [],
    trips: [],
    calibration: {
      gravityBaseline: { gx: 0, gy: 9.215, gz: 3.354, magnitude: 9.8066 },
      basis: {
        eLat: [1, 0, 0],
        eLon: [0, 0.342, -0.9397],
        eVert: [0, 0.9397, 0.342]
      },
      mountAngles: { pitchDeg: 70.0, rollDeg: 0.0 }
    },
    isRecordingPhone: false,
    recordedSamples: [],
    waveformHistory: [],
    gBallTrail: [],
    liveCurrent: { gLon: 0, gLat: 0, gVert: 0, gTotal: 0, peakG: 0 },
    rawMotionBuffer: [],
    geoWatchId: null,
    currentGps: { lat: null, lng: null, speedMph: 0 }
  };

  let map = null;
  let mapRouteLayers = [];
  let mapHazardLayers = [];

  function showToast(msg, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    if (type === 'error') el.style.borderLeftColor = '#ef4444';
    else if (type === 'warn') el.style.borderLeftColor = '#f59e0b';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  async function apiFetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function switchTab(tabName) {
    document.querySelectorAll('.nav-tab, .mobile-nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (tabName === 'planner' && map) {
      setTimeout(() => {
        map.invalidateSize();
        renderMapRoutesAndHazards();
      }, 80);
    }
  }

  // --- OpenStreetMap Initialization ---
  function initMap() {
    const mapContainer = document.getElementById('routeMap');
    if (!mapContainer || typeof L === 'undefined') return;

    map = L.map('routeMap', {
      center: [39.8283, -98.5795], // US center until GPS or routes load
      zoom: 4,
      zoomControl: true
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);
  }

  function renderMapRoutesAndHazards() {
    if (!map || typeof L === 'undefined') return;

    mapRouteLayers.forEach((l) => map.removeLayer(l));
    mapHazardLayers.forEach((l) => map.removeLayer(l));
    mapRouteLayers = [];
    mapHazardLayers = [];

    const allCoords = [];

    state.routes.forEach((route, idx) => {
      const wps = Array.isArray(route.waypoints) ? route.waypoints : [];
      if (wps.length < 2) return;

      const latLngs = wps.map((p) => [p[0], p[1]]);
      latLngs.forEach((ll) => allCoords.push(ll));

      const pred = route.vehiclePrediction || {};
      const fsdScore = pred.predictedFsdScore ?? route.fsdComfortScore;
      const routeColor = fsdScore >= 85 ? '#10b981' : fsdScore >= 65 ? '#f59e0b' : '#ef4444';

      const poly = L.polyline(latLngs, {
        color: routeColor,
        weight: idx === 0 ? 6 : 4,
        opacity: 0.9
      }).addTo(map);

      poly.bindPopup(`
        <div style="color:#0f172a; min-width:190px;">
          <strong>${route.name}</strong><br/>
          Smoothness: <strong>${pred.predictedSmoothnessScore ?? route.smoothnessScore}/100</strong><br/>
          Body Wear: <strong>${pred.predictedBodyWearScore ?? route.bodyWearScore}/100</strong><br/>
          Peak Vertical G: <strong>${pred.predictedPeakVertG ?? route.peakVerticalG}G</strong><br/>
          ${route.distanceMiles} mi • ${route.estimatedMinutes} min
        </div>
      `);
      mapRouteLayers.push(poly);
    });

    state.hazards.forEach((h) => {
      if (typeof h.lat !== 'number' || typeof h.lng !== 'number') return;
      allCoords.push([h.lat, h.lng]);
      const color = h.severity === 'severe' ? '#ef4444' : h.severity === 'high' ? '#f97316' : '#eab308';
      const marker = L.circleMarker([h.lat, h.lng], {
        radius: 7,
        fillColor: color,
        color: '#ffffff',
        weight: 2,
        fillOpacity: 0.9
      }).addTo(map);

      marker.bindPopup(`
        <div style="color:#0f172a;">
          <strong>⚠️ ${h.label}</strong><br/>
          Peak: <strong>${h.peak_g}G</strong> (Vertical: ${h.vertical_g}G)
        </div>
      `);
      mapHazardLayers.push(marker);
    });

    if (allCoords.length >= 2) {
      map.fitBounds(allCoords, { padding: [32, 32] });
    } else if (state.currentGps.lat && state.currentGps.lng) {
      map.setView([state.currentGps.lat, state.currentGps.lng], 13);
    }
  }

  function renderRoutesList() {
    const container = document.getElementById('routeCardsContainer');
    if (!container) return;

    if (state.routes.length === 0) {
      container.innerHTML = `
        <div style="padding:1rem; color:var(--text-secondary); font-size:0.86rem; text-align:center; border:1px dashed var(--border-subtle); border-radius:10px;">
          No routes recorded yet.<br/>
          Search a Start &amp; Destination above or record a drive on the <strong>Track Drive</strong> tab.
        </div>
      `;
      return;
    }

    container.innerHTML = state.routes
      .map((r, idx) => {
        const pred = r.vehiclePrediction || {};
        const smoothScore = pred.predictedSmoothnessScore ?? r.smoothnessScore;
        const bodyWear = pred.predictedBodyWearScore ?? r.bodyWearScore;
        const peakVert = pred.predictedPeakVertG ?? r.peakVerticalG;
        const badgeCls = smoothScore >= 85 ? 'badge-splus' : smoothScore >= 65 ? 'badge-warn' : 'badge-danger';

        return `
          <div class="route-card ${idx === 0 ? 'recommended' : ''}" data-route-id="${r.id}">
            <div class="route-badge-row">
              <span class="badge ${badgeCls}">${idx === 0 ? '★ Smoothest Option • ' : ''}Smoothness ${smoothScore}/100</span>
              <span style="font-size:0.78rem; color:var(--text-secondary);">${r.distanceMiles} mi • ${r.estimatedMinutes} min</span>
            </div>
            <div style="font-weight:700; font-size:0.95rem; margin-bottom:0.25rem;">${r.name}</div>
            <div class="route-metrics-strip">
              <div class="rm-item"><span class="rm-label">Smoothness</span><span class="rm-val">${smoothScore}/100</span></div>
              <div class="rm-item"><span class="rm-label">Body Wear</span><span class="rm-val">${bodyWear}/100</span></div>
              <div class="rm-item"><span class="rm-label">Peak Bump</span><span class="rm-val">${peakVert}G</span></div>
              <div class="rm-item"><span class="rm-label">FSD Score</span><span class="rm-val">${pred.predictedFsdScore ?? r.fsdComfortScore}/100</span></div>
            </div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('.route-card').forEach((card) => {
      card.addEventListener('click', () => {
        const routeId = Number(card.dataset.routeId);
        const r = state.routes.find((rt) => rt.id === routeId);
        if (r && map && Array.isArray(r.waypoints) && r.waypoints.length >= 2) {
          map.fitBounds(r.waypoints.map((p) => [p[0], p[1]]), { padding: [40, 40] });
        }
      });
    });
  }

  // --- Populate Car Selectors ---
  function populateVehicleSelectors() {
    const activeCarSel = document.getElementById('activeCarSelect');
    const garageTplSel = document.getElementById('garageTemplateSelect');
    const suCarSel = document.getElementById('suCarTemplate');

    const tplOptions = state.templates
      .map((t) => `<option value="${t.id}">${t.year} ${t.make} ${t.model} (${t.trim})</option>`)
      .join('');

    if (garageTplSel) garageTplSel.innerHTML = tplOptions;
    if (suCarSel) suCarSel.innerHTML = tplOptions;

    if (activeCarSel) {
      let html = '';
      if (state.vehicles.length > 0) {
        html += `<optgroup label="My Saved Cars">`;
        state.vehicles.forEach((v) => {
          html += `<option value="user:${v.id}" ${v.isPrimary ? 'selected' : ''}>★ ${v.nickname || `${v.year} ${v.make} ${v.model}`}</option>`;
        });
        html += `</optgroup>`;
      }
      html += `<optgroup label="Car Models">`;
      state.templates.forEach((t) => {
        const sel = state.vehicles.length === 0 && t.id === state.activeVehicleTemplateId ? 'selected' : '';
        html += `<option value="${t.id}" ${sel}>${t.year} ${t.make} ${t.model} — ${t.trim}</option>`;
      });
      html += `</optgroup>`;
      activeCarSel.innerHTML = html;
    }

    renderGarageList();
  }

  function renderGarageList() {
    const container = document.getElementById('userGarageList');
    if (!container) return;

    if (!state.user || state.vehicles.length === 0) {
      container.innerHTML = `<div style="font-size:0.82rem; color:var(--text-secondary);">Sign in to save your personal cars permanently, or pick any car model on the Track Drive screen.</div>`;
      return;
    }

    container.innerHTML = state.vehicles
      .map(
        (v) => `
        <div style="padding:0.7rem; background:rgba(13,21,38,0.9); border:1px solid ${v.isPrimary ? 'var(--accent-emerald)' : 'var(--border-subtle)'}; border-radius:8px; display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
          <div>
            <strong>${v.year} ${v.make} ${v.model}</strong>
            <div style="font-size:0.75rem; color:var(--text-secondary);">${v.trim} • Damping κ=${v.suspensionDampingFactor}x</div>
          </div>
          <button class="btn btn-outline btn-sm btn-delete-car" data-id="${v.id}" style="color:#f87171;">Remove</button>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('.btn-delete-car').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const data = await apiFetch(`/api/vehicles/${btn.dataset.id}`, { method: 'DELETE' });
          state.vehicles = data.vehicles;
          populateVehicleSelectors();
          showToast('Removed car.');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  }

  // --- Live G-Ball & Waveform Drawing ---
  function drawCockpitCanvases() {
    drawGBall();
    drawWaveform();
  }

  function drawGBall() {
    const canvas = document.getElementById('gBallCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxRadius = w / 2 - 16;

    ctx.clearRect(0, 0, w, h);

    [0.25, 0.5, 0.75].forEach((g) => {
      const rad = g * maxRadius;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText(`${g}G`, cx + 4, cy - rad + 11);
    });

    ctx.beginPath();
    ctx.moveTo(cx, 10);
    ctx.lineTo(cx, h - 10);
    ctx.moveTo(10, cy);
    ctx.lineTo(w - 10, cy);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
    ctx.stroke();

    const { gLon, gLat, gVert, gTotal } = state.liveCurrent;
    const bx = cx + Math.max(-0.95, Math.min(0.95, gLat)) * maxRadius;
    const by = cy - Math.max(-0.95, Math.min(0.95, gLon)) * maxRadius;
    const ballColor = gTotal >= 0.5 || Math.abs(gVert) >= 0.4 ? '#ef4444' : gTotal >= 0.25 ? '#f59e0b' : '#10b981';

    ctx.beginPath();
    ctx.arc(bx, by, 9, 0, Math.PI * 2);
    ctx.fillStyle = ballColor;
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawWaveform() {
    const canvas = document.getElementById('waveformCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const midY = h / 2;
    const scaleY = (h / 2 - 14) / 0.8;

    ctx.clearRect(0, 0, w, h);

    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.stroke();

    const pts = state.waveformHistory;
    if (pts.length < 2) return;

    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = (i / 119) * w;
      const val = Math.max(-0.85, Math.min(0.85, p.gVert || 0));
      const y = midY - val * scaleY;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }

  function pushLiveTelemetrySample(sample) {
    const gLon = Number(sample.gLon.toFixed(4));
    const gLat = Number(sample.gLat.toFixed(4));
    const gVert = Number(sample.gVert.toFixed(4));
    const gTotal = Number(Math.hypot(gLon, gLat, gVert).toFixed(4));
    const peakG = Math.max(state.liveCurrent.peakG, gTotal);

    state.liveCurrent = { gLon, gLat, gVert, gTotal, peakG };

    const fullPoint = {
      timestampMs: sample.timestampMs || Date.now(),
      lat: sample.lat ?? state.currentGps.lat ?? undefined,
      lng: sample.lng ?? state.currentGps.lng ?? undefined,
      gLon,
      gLat,
      gVert,
      gTotal,
      speedMph: sample.speedMph ?? state.currentGps.speedMph ?? 0,
      fsdActive: true
    };

    state.recordedSamples.push(fullPoint);
    state.waveformHistory.push(fullPoint);
    if (state.waveformHistory.length > 120) state.waveformHistory.shift();

    document.getElementById('liveGVert').textContent = `${gVert >= 0 ? '+' : ''}${gVert.toFixed(2)}G`;
    document.getElementById('liveGLon').textContent = `${gLon >= 0 ? '+' : ''}${gLon.toFixed(2)}G`;
    document.getElementById('liveGLat').textContent = `${gLat >= 0 ? '+' : ''}${gLat.toFixed(2)}G`;
    document.getElementById('livePeakG').textContent = `${peakG.toFixed(2)}G`;
    document.getElementById('liveSampleCounter').textContent = `${state.recordedSamples.length} samples`;

    drawCockpitCanvases();
  }

  // --- Real Phone Sensor Recording ---
  async function toggleRealPhoneSensors() {
    const btnPhone = document.getElementById('btnStartPhoneSensors');
    const btnSave = document.getElementById('btnStopAndSaveTrip');
    const statusBadge = document.getElementById('sensorStatusBadge');

    if (state.isRecordingPhone) {
      window.removeEventListener('devicemotion', handleDeviceMotion);
      if (state.geoWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(state.geoWatchId);
        state.geoWatchId = null;
      }
      state.isRecordingPhone = false;
      btnPhone.textContent = '▶️ Resume Drive Recording';
      statusBadge.textContent = `Paused (${state.recordedSamples.length} pts)`;
      return;
    }

    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      try {
        const perm = await DeviceMotionEvent.requestPermission();
        if (perm !== 'granted') {
          showToast('Motion sensor permission was denied.', 'error');
          return;
        }
      } catch (err) {
        showToast(`Sensor permission error: ${err.message}`, 'error');
        return;
      }
    }

    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').catch(() => {});
    }

    if ('geolocation' in navigator) {
      state.geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          state.currentGps.lat = pos.coords.latitude;
          state.currentGps.lng = pos.coords.longitude;
          if (typeof pos.coords.speed === 'number' && pos.coords.speed >= 0) {
            state.currentGps.speedMph = pos.coords.speed * 2.23694;
          }
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 1000 }
      );
    }

    state.recordedSamples = [];
    state.waveformHistory = [];
    state.liveCurrent = { gLon: 0, gLat: 0, gVert: 0, gTotal: 0, peakG: 0 };
    state.isRecordingPhone = true;
    btnPhone.textContent = '⏸️ Pause Recording';
    btnSave.disabled = false;
    statusBadge.textContent = 'Recording Live G-Forces';

    window.addEventListener('devicemotion', handleDeviceMotion);
    showToast('Recording phone G-forces and GPS!');
  }

  let lastMotionProcessedMs = 0;
  function handleDeviceMotion(event) {
    const now = Date.now();
    if (now - lastMotionProcessedMs < 80) return;
    lastMotionProcessedMs = now;

    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc) return;

    const ax = Number(acc.x) || 0;
    const ay = Number(acc.y) || 0;
    const az = Number(acc.z) || 0;

    state.rawMotionBuffer.push({ ax, ay, az });
    if (state.rawMotionBuffer.length > 20) state.rawMotionBuffer.shift();

    const cal = state.calibration;
    const dx = ax - cal.gravityBaseline.gx;
    const dy = ay - cal.gravityBaseline.gy;
    const dz = az - cal.gravityBaseline.gz;

    const { eLat, eLon, eVert } = cal.basis;
    const gLon = (dx * eLon[0] + dy * eLon[1] + dz * eLon[2]) / G0;
    const gLat = (dx * eLat[0] + dy * eLat[1] + dz * eLat[2]) / G0;
    const gVert = (dx * eVert[0] + dy * eVert[1] + dz * eVert[2]) / G0;

    pushLiveTelemetrySample({
      timestampMs: now,
      lat: state.currentGps.lat,
      lng: state.currentGps.lng,
      gLon,
      gLat,
      gVert,
      speedMph: state.currentGps.speedMph
    });
  }

  async function calibratePhoneMount() {
    if (state.rawMotionBuffer.length === 0) {
      showToast('Start recording or move phone slightly so accelerometer is active, then tap Zero Phone Mount.', 'warn');
    }
    try {
      const samples =
        state.rawMotionBuffer.length > 0
          ? state.rawMotionBuffer
          : [{ ax: 0, ay: 9.215, az: 3.354 }];
      const res = await apiFetch('/api/trips/calibrate', {
        method: 'POST',
        body: JSON.stringify({ samples })
      });
      state.calibration = res.calibration;
      document.getElementById('mountCalibrationInfo').textContent =
        `Calibrated (${res.calibration.mountAngles.pitchDeg}° pitch, ${res.calibration.mountAngles.rollDeg}° roll)`;
      showToast('Phone mount zeroed!');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function finishAndSaveTrip() {
    if (state.isRecordingPhone) {
      window.removeEventListener('devicemotion', handleDeviceMotion);
      if (state.geoWatchId !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(state.geoWatchId);
        state.geoWatchId = null;
      }
      state.isRecordingPhone = false;
      document.getElementById('btnStartPhoneSensors').textContent = '▶️ Start Drive Recording';
    }

    if (state.recordedSamples.length < 2) {
      showToast('Not enough motion samples recorded yet.', 'warn');
      return;
    }

    try {
      const title = document.getElementById('tripTitleInput').value.trim() || `Drive on ${new Date().toLocaleDateString()}`;
      const driveMode = document.getElementById('tripDriveModeSelect').value || 'FSD Supervised';

      const res = await apiFetch('/api/trips', {
        method: 'POST',
        body: JSON.stringify({
          vehicleId: state.activeVehicleId,
          templateId: state.activeVehicleTemplateId,
          title,
          originName: 'Recorded Start',
          destinationName: 'Recorded End',
          driveMode,
          publishAsRoute: true,
          autoPublishHazards: true,
          samples: state.recordedSamples
        })
      });

      const a = res.analysis;
      const reportCard = document.getElementById('latestTripReportCard');
      if (reportCard) reportCard.style.display = 'block';
      document.getElementById('reportFsdGradeBadge').textContent = `Smoothness ${a.smoothnessScore}/100`;
      document.getElementById('latestTripReportBody').innerHTML = `
        <div class="route-metrics-strip">
          <div class="rm-item"><span class="rm-label">Smoothness</span><span class="rm-val">${a.smoothnessScore}/100</span></div>
          <div class="rm-item"><span class="rm-label">Body Wear</span><span class="rm-val">${a.bodyWearScore}/100 (${a.bodyWearGrade})</span></div>
          <div class="rm-item"><span class="rm-label">Peak Bump G</span><span class="rm-val">${a.peakGVert}G</span></div>
          <div class="rm-item"><span class="rm-label">FSD Comfort</span><span class="rm-val">${a.fsdComfortScore}/100</span></div>
        </div>
        <div style="font-size:0.82rem; color:var(--text-secondary);">
          ${a.fsdRecommendation}
          <div style="margin-top:0.5rem;">
            <a href="/api/trips/${res.trip.id}/export?format=csv" class="btn btn-outline btn-sm" target="_blank">⬇️ Download CSV</a>
            <a href="/api/trips/${res.trip.id}/export?format=gpx" class="btn btn-outline btn-sm" target="_blank">⬇️ Download GPX</a>
          </div>
        </div>
      `;

      state.recordedSamples = [];
      document.getElementById('btnStopAndSaveTrip').disabled = true;
      document.getElementById('sensorStatusBadge').textContent = 'Saved';
      showToast('Drive saved!');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // --- Trips Feed ---
  function renderTripsFeed() {
    const container = document.getElementById('tripsFeedContainer');
    if (!container) return;

    if (state.trips.length === 0) {
      container.innerHTML = `<div style="font-size:0.82rem; color:var(--text-secondary);">No recorded drives yet.</div>`;
      return;
    }

    container.innerHTML = state.trips
      .map(
        (t) => `
        <div style="padding:0.75rem; background:rgba(13,21,38,0.9); border:1px solid var(--border-subtle); border-radius:8px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>${t.title}</strong>
            <span class="badge badge-splus">Smoothness ${t.smoothnessScore}/100</span>
          </div>
          <div style="font-size:0.76rem; color:var(--text-secondary); margin:0.25rem 0;">
            ${t.vehicleLabel} • Peak Bump: ${t.peakGVert}G • Body Wear: ${t.bodyWearScore}/100
          </div>
          <div style="display:flex; gap:0.4rem; margin-top:0.4rem;">
            <a class="btn btn-outline btn-sm" href="/api/trips/${t.id}/export?format=csv" target="_blank">CSV</a>
            <a class="btn btn-outline btn-sm" href="/api/trips/${t.id}/export?format=gpx" target="_blank">GPX</a>
          </div>
        </div>
      `
      )
      .join('');
  }

  function updateAuthUI() {
    const headerBtn = document.getElementById('headerAuthBtn');
    const statusBadge = document.getElementById('accountStatusBadge');
    const formsWrap = document.getElementById('authFormsWrapper');
    const profileWrap = document.getElementById('loggedInProfileWrapper');

    if (state.user) {
      if (headerBtn) headerBtn.textContent = `👤 ${state.user.displayName}`;
      if (statusBadge) {
        statusBadge.textContent = 'Signed In';
        statusBadge.className = 'badge badge-splus';
      }
      if (formsWrap) formsWrap.style.display = 'none';
      if (profileWrap) {
        profileWrap.style.display = 'flex';
        document.getElementById('profileDisplayName').textContent = state.user.displayName;
        document.getElementById('profileEmailLine').textContent = `@${state.user.username} • ${state.user.email}`;
      }
    } else {
      if (headerBtn) headerBtn.textContent = 'Sign Up / Log In';
      if (statusBadge) {
        statusBadge.textContent = 'Not Signed In';
        statusBadge.className = 'badge badge-info';
      }
      if (formsWrap) formsWrap.style.display = 'block';
      if (profileWrap) profileWrap.style.display = 'none';
    }
  }

  async function refreshAllData() {
    try {
      const [tplData, routesData, hazData, tripsData] = await Promise.all([
        apiFetch('/api/vehicles/templates'),
        apiFetch(`/api/routes?templateId=${state.activeVehicleTemplateId}`),
        apiFetch('/api/hazards'),
        apiFetch('/api/trips?limit=20')
      ]);

      state.templates = tplData.templates || [];
      state.routes = routesData.routes || [];
      state.hazards = hazData.hazards || [];
      state.trips = tripsData.trips || [];

      if (state.token) {
        try {
          const meData = await apiFetch('/api/auth/me');
          state.user = meData.user;
          state.vehicles = meData.user.vehicles || [];
          if (meData.user.calibration) state.calibration = meData.user.calibration;
        } catch {
          state.token = null;
          state.user = null;
          localStorage.removeItem('sr_token');
        }
      }

      updateAuthUI();
      populateVehicleSelectors();
      renderRoutesList();
      renderTripsFeed();
      renderMapRoutesAndHazards();
    } catch (err) {
      console.error('Load error:', err);
    }
  }

  function bindEvents() {
    document.querySelectorAll('.nav-tab, .mobile-nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.getElementById('headerAuthBtn')?.addEventListener('click', () => switchTab('account'));

    document.getElementById('activeCarSelect')?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val.startsWith('user:')) {
        state.activeVehicleId = Number(val.slice(5));
      } else {
        state.activeVehicleTemplateId = val;
        state.activeVehicleId = null;
      }
    });

    document.getElementById('btnStartPhoneSensors')?.addEventListener('click', toggleRealPhoneSensors);
    document.getElementById('btnCalibrateMount')?.addEventListener('click', calibratePhoneMount);
    document.getElementById('btnStopAndSaveTrip')?.addEventListener('click', finishAndSaveTrip);

    document.getElementById('btnCenterMyGps')?.addEventListener('click', () => {
      if (!('geolocation' in navigator)) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.currentGps.lat = pos.coords.latitude;
          state.currentGps.lng = pos.coords.longitude;
          if (map) map.setView([pos.coords.latitude, pos.coords.longitude], 14);
        },
        () => showToast('Enable location permissions to center on your GPS.', 'warn')
      );
    });

    document.getElementById('btnUseMyLocationOrigin')?.addEventListener('click', () => {
      if (!('geolocation' in navigator)) return;
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude.toFixed(5);
          const lng = pos.coords.longitude.toFixed(5);
          state.currentGps.lat = pos.coords.latitude;
          state.currentGps.lng = pos.coords.longitude;
          try {
            const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
            const d = await r.json();
            const label = d.address
              ? [d.address.road, d.address.city || d.address.town || d.address.suburb, d.address.state].filter(Boolean).join(', ')
              : `${lat}, ${lng}`;
            document.getElementById('customOriginInput').value = label || `${lat}, ${lng}`;
          } catch {
            document.getElementById('customOriginInput').value = `${lat}, ${lng}`;
          }
        },
        () => showToast('Could not read GPS location.', 'warn')
      );
    });

    async function handlePlanCustomRoute() {
      const originQuery = document.getElementById('customOriginInput')?.value.trim();
      const destinationQuery = document.getElementById('customDestInput')?.value.trim();
      if (!originQuery || !destinationQuery) {
        showToast('Enter both a Start Location and Destination.', 'warn');
        return;
      }
      const btn = document.getElementById('btnPlanCustomRoute');
      const prevText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Finding Route...';
      try {
        const data = await apiFetch('/api/routes/custom-plan', {
          method: 'POST',
          body: JSON.stringify({
            originQuery,
            destinationQuery,
            mode: 'fsd_smooth',
            vehicleId: state.activeVehicleId,
            templateId: state.activeVehicleTemplateId,
            saveToPublic: false
          })
        });
        state.routes = data.rankedRoutes || [];
        renderRoutesList();
        renderMapRoutesAndHazards();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = prevText;
      }
    }

    document.getElementById('btnPlanCustomRoute')?.addEventListener('click', handlePlanCustomRoute);

    // Account Sign Up / Log In
    document.getElementById('btnShowSignupForm')?.addEventListener('click', () => {
      document.getElementById('signupForm').style.display = 'flex';
      document.getElementById('loginForm').style.display = 'none';
    });
    document.getElementById('btnShowLoginForm')?.addEventListener('click', () => {
      document.getElementById('signupForm').style.display = 'none';
      document.getElementById('loginForm').style.display = 'flex';
    });

    document.getElementById('signupForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await apiFetch('/api/auth/signup', {
          method: 'POST',
          body: JSON.stringify({
            displayName: document.getElementById('suDisplayName').value,
            username: document.getElementById('suUsername').value,
            email: document.getElementById('suEmail').value,
            password: document.getElementById('suPassword').value,
            vehicleTemplateId: document.getElementById('suCarTemplate').value
          })
        });
        state.token = data.token;
        localStorage.setItem('sr_token', data.token);
        state.user = data.user;
        state.vehicles = data.user.vehicles || [];
        updateAuthUI();
        populateVehicleSelectors();
        showToast(`Account created for ${data.user.displayName}!`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            identifier: document.getElementById('liIdentifier').value,
            password: document.getElementById('liPassword').value
          })
        });
        state.token = data.token;
        localStorage.setItem('sr_token', data.token);
        state.user = data.user;
        state.vehicles = data.user.vehicles || [];
        updateAuthUI();
        populateVehicleSelectors();
        showToast(`Signed in as ${data.user.displayName}!`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('btnAddGarageVehicle')?.addEventListener('click', async () => {
      const tplId = document.getElementById('garageTemplateSelect').value;
      if (!state.token) {
        state.activeVehicleTemplateId = tplId;
        populateVehicleSelectors();
        showToast('Selected car model! Sign up to save cars to your account.');
        return;
      }
      try {
        const res = await apiFetch('/api/vehicles', {
          method: 'POST',
          body: JSON.stringify({ templateId: tplId, isPrimary: true })
        });
        state.vehicles = res.vehicles;
        populateVehicleSelectors();
        showToast('Added car to your garage!');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    document.getElementById('btnLogout')?.addEventListener('click', async () => {
      await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
      state.token = null;
      state.user = null;
      state.vehicles = [];
      localStorage.removeItem('sr_token');
      updateAuthUI();
      populateVehicleSelectors();
      showToast('Logged out.');
    });
  }

  window.addEventListener('DOMContentLoaded', async () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
    initMap();
    bindEvents();
    drawCockpitCanvases();
    await refreshAllData();
  });
})();
