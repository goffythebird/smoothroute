/**
 * SmoothRoute — 1-Tap Phone G-Force Recorder & Smooth Map (Zero Login Needed)
 */

(function () {
  const G0 = 9.80665;

  const state = {
    templates: [],
    activeVehicleTemplateId: localStorage.getItem('sr_car_template') || 'tesla-model-y-lr',
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
    hasAutoCalibrated: false,
    isRecording: false,
    recordStartMs: 0,
    heartbeatTimer: null,
    recordedSamples: [],
    waveformHistory: [],
    liveCurrent: { gLon: 0, gLat: 0, gVert: 0, gTotal: 0, peakG: 0 },
    latestTransformed: { gLon: 0, gLat: 0, gVert: 0 },
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
    setTimeout(() => el.remove(), 3500);
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
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

  // --- Local 3-Axis Calibration Helper ---
  function computeLocalCalibration(samples) {
    let sumX = 0, sumY = 0, sumZ = 0;
    for (const s of samples) {
      sumX += Number(s.ax) || 0;
      sumY += Number(s.ay) || 0;
      sumZ += Number(s.az) || 0;
    }
    const n = Math.max(1, samples.length);
    const gx = sumX / n;
    const gy = sumY / n;
    const gz = sumZ / n;
    const mag = Math.hypot(gx, gy, gz) || G0;
    const eVert = [gx / mag, gy / mag, gz / mag];
    let refLat = Math.abs(eVert[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const dotLat = refLat[0] * eVert[0] + refLat[1] * eVert[1] + refLat[2] * eVert[2];
    let eLat = [
      refLat[0] - dotLat * eVert[0],
      refLat[1] - dotLat * eVert[1],
      refLat[2] - dotLat * eVert[2]
    ];
    const latMag = Math.hypot(eLat[0], eLat[1], eLat[2]) || 1;
    eLat = [eLat[0] / latMag, eLat[1] / latMag, eLat[2] / latMag];
    const eLon = [
      eVert[1] * eLat[2] - eVert[2] * eLat[1],
      eVert[2] * eLat[0] - eVert[0] * eLat[2],
      eVert[0] * eLat[1] - eVert[1] * eLat[0]
    ];
    const pitchDeg = Number((Math.atan2(gy, gz) * (180 / Math.PI)).toFixed(1));
    const rollDeg = Number((Math.atan2(-gx, Math.hypot(gy, gz)) * (180 / Math.PI)).toFixed(1));
    return {
      gravityBaseline: { gx, gy, gz, magnitude: mag },
      basis: { eLat, eLon, eVert },
      mountAngles: { pitchDeg, rollDeg }
    };
  }

  // --- OpenStreetMap ---
  function initMap() {
    const mapContainer = document.getElementById('routeMap');
    if (!mapContainer || typeof L === 'undefined') return;

    map = L.map('routeMap', {
      center: [39.8283, -98.5795],
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
      const smooth = pred.predictedSmoothnessScore ?? route.smoothnessScore;
      const routeColor = smooth >= 85 ? '#10b981' : smooth >= 65 ? '#f59e0b' : '#ef4444';

      const poly = L.polyline(latLngs, {
        color: routeColor,
        weight: idx === 0 ? 6 : 4,
        opacity: 0.9
      }).addTo(map);

      poly.bindPopup(`
        <div style="color:#0f172a; min-width:180px;">
          <strong>${route.name}</strong><br/>
          Smoothness: <strong>${smooth}/100</strong><br/>
          Body Wear: <strong>${pred.predictedBodyWearScore ?? route.bodyWearScore}/100</strong><br/>
          Peak Bump: <strong>${pred.predictedPeakVertG ?? route.peakVerticalG}G</strong>
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
          Peak: <strong>${h.peak_g}G</strong>
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
          No routes on map yet.<br/>
          Tap <strong>🔴 Record Drive</strong> to record a drive or search a Start &amp; Destination above.
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
              <span class="badge ${badgeCls}">Smoothness ${smoothScore}/100</span>
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

  function populateVehicleSelectors() {
    const activeCarSel = document.getElementById('activeCarSelect');
    if (!activeCarSel) return;
    activeCarSel.innerHTML = state.templates
      .map(
        (t) =>
          `<option value="${t.id}" ${t.id === state.activeVehicleTemplateId ? 'selected' : ''}>${t.year} ${t.make} ${t.model} — ${t.trim}</option>`
      )
      .join('');
  }

  // --- Live G-Ball & Waveform ---
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
    ctx.arc(bx, by, 10, 0, Math.PI * 2);
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

  function formatElapsed(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const sec = String(totalSec % 60).padStart(2, '0');
    return `${min}:${sec}`;
  }

  function pushLiveTelemetrySample(sample) {
    const gLon = Number((sample.gLon || 0).toFixed(4));
    const gLat = Number((sample.gLat || 0).toFixed(4));
    const gVert = Number((sample.gVert || 0).toFixed(4));
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

    const elapsedStr = formatElapsed(Date.now() - state.recordStartMs);
    document.getElementById('liveSampleCounter').textContent = `${elapsedStr} • ${state.recordedSamples.length} pts`;

    const btn = document.getElementById('btnOneTapRecord');
    if (btn && state.isRecording) {
      btn.textContent = `⏹️ TAP TO STOP & SAVE (${elapsedStr})`;
    }

    drawCockpitCanvases();
  }

  // --- 1-Tap Start / Stop Recording ---
  async function handleOneTapRecordToggle() {
    if (state.isRecording) {
      await stopAndSaveDrive();
      return;
    }

    // Request iOS 13+ Motion Permission if required
    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      try {
        const perm = await DeviceMotionEvent.requestPermission();
        if (perm !== 'granted') {
          showToast('Please allow Motion & Orientation access in Safari to record G-forces.', 'error');
          return;
        }
      } catch (err) {
        showToast(`Motion permission error: ${err.message}`, 'error');
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
    state.rawMotionBuffer = [];
    state.hasAutoCalibrated = false;
    state.liveCurrent = { gLon: 0, gLat: 0, gVert: 0, gTotal: 0, peakG: 0 };
    state.latestTransformed = { gLon: 0, gLat: 0, gVert: 0 };
    state.recordStartMs = Date.now();
    state.isRecording = true;

    const btn = document.getElementById('btnOneTapRecord');
    btn.className = 'btn btn-danger';
    btn.textContent = '⏹️ TAP TO STOP & SAVE (00:00)';
    document.getElementById('sensorStatusBadge').textContent = 'Recording Live...';

    window.addEventListener('devicemotion', handleDeviceMotion);

    // 5Hz heartbeat ensures steady sample stream even when phone is held steady
    state.heartbeatTimer = setInterval(() => {
      if (!state.isRecording) return;
      pushLiveTelemetrySample({
        timestampMs: Date.now(),
        lat: state.currentGps.lat,
        lng: state.currentGps.lng,
        gLon: state.latestTransformed.gLon,
        gLat: state.latestTransformed.gLat,
        gVert: state.latestTransformed.gVert,
        speedMph: state.currentGps.speedMph
      });
    }, 200);

    showToast('Recording started! Tap the red button anytime to Stop & Save.');
  }

  let lastMotionProcessedMs = 0;
  function handleDeviceMotion(event) {
    const now = Date.now();
    if (now - lastMotionProcessedMs < 60) return;
    lastMotionProcessedMs = now;

    const acc = event.accelerationIncludingGravity || event.acceleration;
    if (!acc) return;

    const ax = Number(acc.x) || 0;
    const ay = Number(acc.y) || 0;
    const az = Number(acc.z) || 0;

    state.rawMotionBuffer.push({ ax, ay, az });
    if (state.rawMotionBuffer.length > 20) state.rawMotionBuffer.shift();

    // Auto-zero mount orientation automatically from the first 3 readings
    if (!state.hasAutoCalibrated) {
      if (state.rawMotionBuffer.length >= 3) {
        state.calibration = computeLocalCalibration(state.rawMotionBuffer);
        state.hasAutoCalibrated = true;
        document.getElementById('mountCalibrationInfo').textContent =
          `Mount Auto-Zeroed (${state.calibration.mountAngles.pitchDeg}° tilt)`;
      } else {
        return; // Wait for initial 3 samples (~180ms) before emitting G-forces
      }
    } else {
      // Continuously adapt gravity baseline with a slow low-pass filter (handles setting phone in mount or road grade)
      const gb = state.calibration.gravityBaseline;
      const alpha = 0.965;
      gb.gx = alpha * gb.gx + (1 - alpha) * ax;
      gb.gy = alpha * gb.gy + (1 - alpha) * ay;
      gb.gz = alpha * gb.gz + (1 - alpha) * az;
    }

    const cal = state.calibration;
    const dx = ax - cal.gravityBaseline.gx;
    const dy = ay - cal.gravityBaseline.gy;
    const dz = az - cal.gravityBaseline.gz;

    const { eLat, eLon, eVert } = cal.basis;
    const gLon = (dx * eLon[0] + dy * eLon[1] + dz * eLon[2]) / G0;
    const gLat = (dx * eLat[0] + dy * eLat[1] + dz * eLat[2]) / G0;
    const gVert = (dx * eVert[0] + dy * eVert[1] + dz * eVert[2]) / G0;

    state.latestTransformed = { gLon, gLat, gVert };
  }

  function reZeroMount() {
    if (state.rawMotionBuffer.length > 0) {
      state.calibration = computeLocalCalibration(state.rawMotionBuffer);
      state.latestTransformed = { gLon: 0, gLat: 0, gVert: 0 };
      document.getElementById('mountCalibrationInfo').textContent =
        `Re-Zeroed (${state.calibration.mountAngles.pitchDeg}° tilt)`;
      showToast('Phone mount re-zeroed!');
    } else {
      showToast('Mount will auto-zero as soon as you start recording.');
    }
  }

  async function stopAndSaveDrive() {
    state.isRecording = false;
    window.removeEventListener('devicemotion', handleDeviceMotion);
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    if (state.geoWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(state.geoWatchId);
      state.geoWatchId = null;
    }

    const btn = document.getElementById('btnOneTapRecord');
    btn.disabled = true;
    btn.textContent = '⏳ Saving Drive...';

    // Guarantee at least 2 samples even if user double-tapped quickly
    if (state.recordedSamples.length < 2) {
      const now = Date.now();
      state.recordedSamples.push(
        { timestampMs: now - 200, gLon: 0, gLat: 0, gVert: 0, gTotal: 0, speedMph: 0 },
        { timestampMs: now, gLon: 0, gLat: 0, gVert: 0, gTotal: 0, speedMph: 0 }
      );
    }

    try {
      const customTitle = document.getElementById('tripTitleInput').value.trim();
      const tpl = state.templates.find((t) => t.id === state.activeVehicleTemplateId);
      const carShort = tpl ? `${tpl.make} ${tpl.model}` : 'Car';
      const title = customTitle || `${carShort} Drive (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;

      const res = await apiFetch('/api/trips', {
        method: 'POST',
        body: JSON.stringify({
          templateId: state.activeVehicleTemplateId,
          title,
          originName: 'Start',
          destinationName: 'End',
          driveMode: 'FSD Supervised',
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
          <div class="rm-item"><span class="rm-label">Duration</span><span class="rm-val">${a.durationSec}s</span></div>
        </div>
        <div style="font-size:0.82rem; color:var(--text-secondary);">
          ${a.fsdRecommendation}
          <div style="margin-top:0.5rem; display:flex; gap:0.4rem;">
            <a href="/api/trips/${res.trip.id}/export?format=csv" class="btn btn-outline btn-sm" target="_blank">⬇️ CSV</a>
            <a href="/api/trips/${res.trip.id}/export?format=gpx" class="btn btn-outline btn-sm" target="_blank">⬇️ GPX</a>
          </div>
        </div>
      `;

      document.getElementById('tripTitleInput').value = '';
      showToast('Drive saved!');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.className = 'btn btn-primary';
      btn.textContent = '🔴 TAP TO START RECORDING';
      document.getElementById('sensorStatusBadge').textContent = 'Ready — auto-calibrates mount on start';
    }
  }

  function renderTripsFeed() {
    const container = document.getElementById('tripsFeedContainer');
    if (!container) return;

    if (state.trips.length === 0) {
      container.innerHTML = `<div style="font-size:0.84rem; color:var(--text-secondary);">No drives recorded yet. Tap the big green button to record your first drive!</div>`;
      return;
    }

    container.innerHTML = state.trips
      .map(
        (t) => `
        <div style="padding:0.75rem; background:rgba(13,21,38,0.9); border:1px solid var(--border-subtle); border-radius:8px; display:flex; justify-content:space-between; align-items:center; gap:0.5rem; flex-wrap:wrap;">
          <div>
            <strong>${t.title}</strong>
            <div style="font-size:0.76rem; color:var(--text-secondary);">
              Smoothness: <strong>${t.smoothnessScore}/100</strong> • Peak Bump: <strong>${t.peakGVert}G</strong> • Body Wear: <strong>${t.bodyWearScore}/100</strong>
            </div>
          </div>
          <div style="display:flex; gap:0.35rem;">
            <a class="btn btn-outline btn-sm" href="/api/trips/${t.id}/export?format=csv" target="_blank">CSV</a>
            <a class="btn btn-outline btn-sm" href="/api/trips/${t.id}/export?format=gpx" target="_blank">GPX</a>
          </div>
        </div>
      `
      )
      .join('');
  }

  async function refreshAllData() {
    try {
      const [tplData, routesData, hazData, tripsData] = await Promise.all([
        apiFetch('/api/vehicles/templates'),
        apiFetch(`/api/routes?templateId=${state.activeVehicleTemplateId}`),
        apiFetch('/api/hazards'),
        apiFetch('/api/trips?limit=15')
      ]);

      state.templates = tplData.templates || [];
      state.routes = routesData.routes || [];
      state.hazards = hazData.hazards || [];
      state.trips = tripsData.trips || [];

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

    document.getElementById('activeCarSelect')?.addEventListener('change', (e) => {
      state.activeVehicleTemplateId = e.target.value;
      localStorage.setItem('sr_car_template', e.target.value);
      refreshAllData();
    });

    document.getElementById('btnOneTapRecord')?.addEventListener('click', handleOneTapRecordToggle);
    document.getElementById('btnCalibrateMount')?.addEventListener('click', reZeroMount);

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

    document.getElementById('btnPlanCustomRoute')?.addEventListener('click', async () => {
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
