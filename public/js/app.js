/**
 * SmoothRoute — Frontend Application (PWA, Map, G-Force Sensor Cockpit, FSD Smooth Router)
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
    corridor: 'sf-palo-alto',
    mode: 'fsd_smooth',
    routes: [],
    hazards: [],
    trips: [],
    benchmarks: [],
    calibration: {
      gravityBaseline: { gx: 0, gy: 9.215, gz: 3.354, magnitude: 9.8066 },
      basis: {
        eLat: [1, 0, 0],
        eLon: [0, 0.342, -0.9397],
        eVert: [0, 0.9397, 0.342]
      },
      mountAngles: { pitchDeg: 70.0, rollDeg: 0.0 }
    },
    // Live Recording / Simulator State
    isRecordingPhone: false,
    isSimulating: false,
    simTimer: null,
    recordedSamples: [],
    waveformHistory: [], // last 160 points
    gBallTrail: [],      // last 25 points
    liveCurrent: { gLon: 0, gLat: 0, gVert: 0, gTotal: 0, peakG: 0, jerk: 0, vdvIntegral: 0, vdv: 0 },
    rawMotionBuffer: [],
    geoWatchId: null,
    currentGps: { lat: 37.624, lng: -122.432, speedMph: 62 },
    pendingImpulse: null
  };

  let map = null;
  let mapRouteLayers = [];
  let mapHazardLayers = [];

  // --- Utility: Toast Notification ---
  function showToast(msg, type = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    if (type === 'error') el.style.borderLeftColor = '#ef4444';
    else if (type === 'warn') el.style.borderLeftColor = '#f59e0b';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 4200);
  }

  // --- Utility: API Fetch Helper ---
  async function apiFetch(url, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (state.token) {
      headers.Authorization = `Bearer ${state.token}`;
    }
    const res = await fetch(url, {
      ...options,
      headers
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  // --- Tab Navigation ---
  function switchTab(tabName) {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
    if (tabName === 'planner' && map) {
      setTimeout(() => map.invalidateSize(), 80);
    }
  }

  // --- Active Car Helper ---
  function getActiveCarObject() {
    if (state.user && state.vehicles.length > 0) {
      const found =
        state.vehicles.find((v) => v.id === Number(state.activeVehicleId)) ||
        state.vehicles.find((v) => v.isPrimary) ||
        state.vehicles[0];
      if (found) return found;
    }
    return (
      state.templates.find((t) => t.id === state.activeVehicleTemplateId) ||
      state.templates[0] || {
        make: 'Tesla',
        model: 'Model Y',
        year: 2025,
        trim: 'Long Range AWD',
        suspensionDampingFactor: 1.06
      }
    );
  }

  function updateHeaderCarUI() {
    const car = getActiveCarObject();
    const factor = Number(car.suspensionDampingFactor || 1.0).toFixed(2);
    const label = `${car.year || 2025} ${car.make} ${car.model}`;
    const headerCarText = document.getElementById('headerCarText');
    if (headerCarText) {
      headerCarText.textContent = `${label} (κ=${factor}x)`;
    }
    const statFactor = document.getElementById('statActiveCarFactor');
    const statSub = document.getElementById('statActiveCarSub');
    if (statFactor) statFactor.textContent = `${factor}x`;
    if (statSub) statSub.textContent = `${label}`;
  }

  // --- Map Initialization & Rendering ---
  function initMap() {
    const mapContainer = document.getElementById('routeMap');
    if (!mapContainer || typeof L === 'undefined') return;

    map = L.map('routeMap', {
      center: [37.55, -122.30],
      zoom: 10,
      zoomControl: true
    });

    L.tileLayer('/api/tiles/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
  }

  function getGForceColor(gVert) {
    if (gVert <= 0.08) return '#10b981'; // Emerald smooth
    if (gVert <= 0.16) return '#f59e0b'; // Amber moderate
    return '#ef4444';                    // Red high G
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
      const routeColor =
        fsdScore >= 85 ? '#10b981' : fsdScore >= 65 ? '#f59e0b' : '#ef4444';

      const weight = idx === 0 ? 7 : 4.5;
      const opacity = idx === 0 ? 0.95 : 0.72;

      const poly = L.polyline(latLngs, {
        color: routeColor,
        weight,
        opacity,
        dashArray: fsdScore < 60 ? '8, 6' : null
      }).addTo(map);

      poly.bindPopup(`
        <div style="color:#0f172a; min-width:210px;">
          <div style="font-weight:800; font-size:0.92rem; margin-bottom:4px;">${route.name}</div>
          <div style="font-size:0.78rem; margin-bottom:6px;">${route.highwaySummary || ''}</div>
          <div style="font-size:0.8rem;">
            <strong>FSD Comfort:</strong> ${fsdScore}/100 (${route.fsdGrade})<br/>
            <strong>Body Wear:</strong> ${pred.predictedBodyWearScore ?? route.bodyWearScore}/100<br/>
            <strong>Predicted Peak Vert G:</strong> ${pred.predictedPeakVertG ?? route.peakVerticalG}G<br/>
            <strong>Distance / Time:</strong> ${route.distanceMiles} mi • ${route.estimatedMinutes} min
          </div>
        </div>
      `);

      mapRouteLayers.push(poly);
    });

    state.hazards.forEach((h) => {
      if (typeof h.lat !== 'number' || typeof h.lng !== 'number') return;
      const color = h.severity === 'severe' ? '#ef4444' : h.severity === 'high' ? '#f97316' : '#eab308';
      const marker = L.circleMarker([h.lat, h.lng], {
        radius: h.severity === 'severe' ? 9 : 7,
        fillColor: color,
        color: '#ffffff',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9
      }).addTo(map);

      marker.bindPopup(`
        <div style="color:#0f172a; max-width:230px;">
          <div style="font-weight:800; color:#b91c1c;">⚠️ ${h.label}</div>
          <div style="font-size:0.76rem; margin:4px 0;">${h.road_name || ''}</div>
          <div style="font-size:0.78rem;">${h.description || ''}</div>
          <div style="font-size:0.76rem; margin-top:5px;">
            <strong>Peak G:</strong> ${h.peak_g}G (Vert: ${h.vertical_g}G) • <strong>Confirmed:</strong> ${h.confirmations}x
          </div>
        </div>
      `);
      mapHazardLayers.push(marker);
    });

    if (allCoords.length >= 2) {
      map.fitBounds(allCoords, { padding: [32, 32] });
    }
  }

  // --- Render Route Comparison Cards & Hazards ---
  function renderRouteComparisonUI(comparisonData) {
    const routes = comparisonData.rankedRoutes || state.routes || [];
    state.routes = routes;

    const container = document.getElementById('routeCardsContainer');
    const callout = document.getElementById('fsdSavingsCallout');
    const modeBadge = document.getElementById('comparisonSummaryBadge');
    const statMode = document.getElementById('statRoutingMode');

    const modeLabels = {
      fsd_smooth: 'FSD Smooth Priority',
      low_body_wear: 'Spine & Body Protection',
      balanced: 'Balanced Mode',
      fastest: 'Fastest ETA'
    };
    if (modeBadge) modeBadge.textContent = modeLabels[state.mode] || 'FSD Smooth';
    if (statMode) statMode.textContent = (modeLabels[state.mode] || 'FSD Smooth').split(' ')[0] + ' ' + ((modeLabels[state.mode] || '').split(' ')[1] || '');

    if (callout && routes.length >= 2) {
      const best = routes[0];
      const worst = routes[routes.length - 1];
      const bestPred = best.vehiclePrediction || {};
      const worstPred = worst.vehiclePrediction || {};
      const wearSaved = Math.max(
        0,
        Math.round(
          (((worstPred.predictedBodyWearScore || worst.bodyWearScore) -
            (bestPred.predictedBodyWearScore || best.bodyWearScore)) /
            Math.max(1, worstPred.predictedBodyWearScore || worst.bodyWearScore)) *
            100
        )
      );
      const timeDiff = Number((best.estimatedMinutes - worst.estimatedMinutes).toFixed(1));
      const timePhrase =
        timeDiff <= 0
          ? `${Math.abs(timeDiff)} min faster`
          : `only +${timeDiff} min travel time`;

      callout.innerHTML = `
        <strong>⚡ Tesla FSD &amp; Biomechanical Recommendation for ${bestPred.vehicleName || 'Your Car'}:</strong><br/>
        Taking <strong>${best.name}</strong> instead of <em>${worst.name}</em> reduces cumulative human spine &amp; body wear by <strong>${wearSaved}%</strong> (Peak Vertical Shock drops from <strong>${worstPred.predictedPeakVertG || worst.peakVerticalG}G</strong> to <strong>${bestPred.predictedPeakVertG || best.peakVerticalG}G</strong>) for ${timePhrase}.
      `;
    } else if (callout && routes.length === 1) {
      callout.innerHTML = `Showing 1 public route in this corridor. Record a new drive in the Cockpit tab to add more crowd-sourced paths!`;
    }

    if (!container) return;
    container.innerHTML = routes
      .map((r, idx) => {
        const pred = r.vehiclePrediction || {};
        const fsdScore = pred.predictedFsdScore ?? r.fsdComfortScore;
        const smoothScore = pred.predictedSmoothnessScore ?? r.smoothnessScore;
        const bodyWear = pred.predictedBodyWearScore ?? r.bodyWearScore;
        const peakVert = pred.predictedPeakVertG ?? r.peakVerticalG;
        const rmsVert = pred.predictedRmsVertG ?? r.avgVerticalG;

        const gradeClass =
          fsdScore >= 85 ? 'badge-splus' : fsdScore >= 65 ? 'badge-warn' : 'badge-danger';

        return `
          <div class="route-card ${idx === 0 ? 'recommended' : ''}" data-route-id="${r.id}">
            <div class="route-badge-row">
              <div style="display:flex; gap:0.4rem; align-items:center; flex-wrap:wrap;">
                ${idx === 0 ? '<span class="badge badge-splus">★ #1 RECOMMENDED ROUTE</span>' : `<span class="badge badge-info">#${idx + 1} Option</span>`}
                <span class="badge ${gradeClass}">${r.fsdGrade} • ${fsdScore}/100 FSD</span>
              </div>
              <span style="font-size:0.78rem; color:var(--text-secondary); font-weight:600;">
                ${r.distanceMiles} mi • ${r.estimatedMinutes} min
              </span>
            </div>

            <div style="font-size:1rem; font-weight:800; margin-bottom:0.2rem;">${r.name}</div>
            <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.5rem;">
              ${r.highwaySummary || `${r.originName} → ${r.destinationName}`} • Surface: <strong>${r.surfaceType}</strong>
            </div>

            <div class="route-metrics-strip">
              <div class="rm-item">
                <span class="rm-label">Smoothness</span>
                <span class="rm-val" style="color:${smoothScore >= 85 ? '#34d399' : smoothScore >= 65 ? '#fbbf24' : '#f87171'};">${smoothScore}/100</span>
              </div>
              <div class="rm-item">
                <span class="rm-label">Body Wear</span>
                <span class="rm-val" style="color:${bodyWear <= 20 ? '#34d399' : bodyWear <= 50 ? '#fbbf24' : '#f87171'};">${bodyWear}/100</span>
              </div>
              <div class="rm-item">
                <span class="rm-label">Car Peak G</span>
                <span class="rm-val">${peakVert}G</span>
              </div>
              <div class="rm-item">
                <span class="rm-label">Avg Vert G</span>
                <span class="rm-val">${rmsVert}G</span>
              </div>
            </div>

            <p style="font-size:0.79rem; color:var(--text-secondary); margin-bottom:0.7rem;">
              ${r.fsdNotes || ''}
            </p>

            <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; flex-wrap:wrap;">
              <span style="font-size:0.73rem; color:var(--text-muted);">
                📡 ${r.sampleTripsCount} drives • 👍 <span id="upvoteCount-${r.id}">${r.upvotes}</span> verified smooth votes
              </span>
              <div style="display:flex; gap:0.4rem;">
                <button class="btn btn-outline btn-sm btn-upvote-route" data-id="${r.id}">👍 Verify Smooth (${r.upvotes})</button>
                <button class="btn btn-cyan btn-sm btn-sim-this-route" data-id="${r.id}">📡 Test in Cockpit</button>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    // Attach listeners
    container.querySelectorAll('.btn-upvote-route').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const routeId = btn.dataset.id;
        try {
          const res = await apiFetch(`/api/routes/${routeId}/upvote`, { method: 'POST' });
          btn.textContent = `👍 Verify Smooth (${res.route.upvotes})`;
          showToast('Upvoted route smoothness!');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('.btn-sim-this-route').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const routeId = Number(btn.dataset.id);
        const targetRoute = state.routes.find((rt) => rt.id === routeId);
        if (targetRoute) {
          document.getElementById('tripTitleInput').value = `${targetRoute.name} Telemetry Run`;
          document.getElementById('tripOriginInput').value = targetRoute.originName;
          document.getElementById('tripDestInput').value = targetRoute.destinationName;
          const simSel = document.getElementById('simRouteSelect');
          if (simSel) {
            if (targetRoute.smoothnessScore >= 85) simSel.value = 'smooth_i280';
            else if (targetRoute.slug.includes('ca85')) simSel.value = 'concrete_ca85';
            else if (targetRoute.slug.includes('183')) simSel.value = 'construction_us183';
            else simSel.value = 'rough_us101';
          }
          switchTab('cockpit');
          showToast(`Loaded "${targetRoute.name}" into Phone G-Force Cockpit!`);
        }
      });
    });

    container.querySelectorAll('.route-card').forEach((card) => {
      card.addEventListener('click', () => {
        const routeId = Number(card.dataset.routeId);
        const r = state.routes.find((rt) => rt.id === routeId);
        if (r && map && Array.isArray(r.waypoints) && r.waypoints.length >= 2) {
          map.fitBounds(
            r.waypoints.map((p) => [p[0], p[1]]),
            { padding: [45, 45] }
          );
        }
      });
    });
  }

  function renderHazardsList() {
    const container = document.getElementById('hazardsListContainer');
    if (!container) return;

    container.innerHTML = state.hazards
      .slice(0, 6)
      .map((h) => {
        const badgeCls =
          h.severity === 'severe' ? 'badge-danger' : h.severity === 'high' ? 'badge-warn' : 'badge-info';
        return `
          <div style="background:rgba(11,18,34,0.85); border:1px solid var(--border-subtle); border-radius:8px; padding:0.65rem; cursor:pointer;" class="hazard-item-card" data-lat="${h.lat}" data-lng="${h.lng}">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:0.4rem; margin-bottom:0.25rem;">
              <span class="badge ${badgeCls}">${h.peak_g}G Peak</span>
              <button class="btn btn-outline btn-sm btn-confirm-hazard" data-id="${h.id}" style="padding:0.15rem 0.45rem; font-size:0.68rem;">
                ✓ Confirm (${h.confirmations})
              </button>
            </div>
            <div style="font-weight:700; font-size:0.8rem;">${h.label}</div>
            <div style="font-size:0.72rem; color:var(--text-secondary);">${h.road_name || ''} • ${h.vehicle_label || ''}</div>
          </div>
        `;
      })
      .join('');

    container.querySelectorAll('.hazard-item-card').forEach((card) => {
      card.addEventListener('click', () => {
        const lat = Number(card.dataset.lat);
        const lng = Number(card.dataset.lng);
        if (map && !Number.isNaN(lat) && !Number.isNaN(lng)) {
          map.setView([lat, lng], 13);
        }
      });
    });

    container.querySelectorAll('.btn-confirm-hazard').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        try {
          const res = await apiFetch(`/api/hazards/${id}/confirm`, { method: 'POST' });
          btn.textContent = `✓ Confirm (${res.hazard.confirmations})`;
          showToast('Confirmed road G-force hazard!');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  }

  // --- Load & Compare Routes from API ---
  async function loadRouteComparison() {
    try {
      const corridorEl = document.getElementById('corridorSelect');
      const modeEl = document.getElementById('optimizationModeSelect');
      const vehEl = document.getElementById('plannerVehicleSelect');

      if (corridorEl) state.corridor = corridorEl.value;
      if (modeEl) state.mode = modeEl.value;

      let vehicleId = null;
      let templateId = state.activeVehicleTemplateId;
      if (vehEl && vehEl.value) {
        if (vehEl.value.startsWith('user:')) {
          vehicleId = Number(vehEl.value.slice(5));
          state.activeVehicleId = vehicleId;
        } else {
          templateId = vehEl.value;
          state.activeVehicleTemplateId = templateId;
          state.activeVehicleId = null;
        }
      }

      updateHeaderCarUI();

      const data = await apiFetch('/api/routes/compare', {
        method: 'POST',
        body: JSON.stringify({
          corridorGroup: state.corridor,
          mode: state.mode,
          vehicleId,
          templateId
        })
      });

      renderRouteComparisonUI(data);
      renderMapRoutesAndHazards();
    } catch (err) {
      showToast(`Failed to compare routes: ${err.message}`, 'error');
    }
  }

  // --- Populate Vehicle Dropdowns & Garage UI ---
  function populateVehicleSelectors() {
    const plannerSel = document.getElementById('plannerVehicleSelect');
    const garageTplSel = document.getElementById('garageTemplateSelect');
    const suCarSel = document.getElementById('suCarTemplate');

    if (garageTplSel) {
      garageTplSel.innerHTML = state.templates
        .map(
          (t) =>
            `<option value="${t.id}">${t.year} ${t.make} ${t.model} — ${t.trim} (κ=${t.suspensionDampingFactor}x)</option>`
        )
        .join('');
    }

    if (suCarSel) {
      suCarSel.innerHTML = state.templates
        .map(
          (t) =>
            `<option value="${t.id}" ${t.id === 'tesla-model-y-lr' ? 'selected' : ''}>${t.year} ${t.make} ${t.model} (${t.trim})</option>`
        )
        .join('');
    }

    if (plannerSel) {
      let html = '';
      if (state.vehicles.length > 0) {
        html += `<optgroup label="My Garage Vehicles">`;
        state.vehicles.forEach((v) => {
          const sel = v.isPrimary ? 'selected' : '';
          html += `<option value="user:${v.id}" ${sel}>★ ${v.nickname || `${v.year} ${v.make} ${v.model}`} (κ=${v.suspensionDampingFactor}x)</option>`;
        });
        html += `</optgroup>`;
      }
      html += `<optgroup label="Pre-Calibrated Vehicle Catalog">`;
      state.templates.forEach((t) => {
        const sel = state.vehicles.length === 0 && t.id === state.activeVehicleTemplateId ? 'selected' : '';
        html += `<option value="${t.id}" ${sel}>${t.year} ${t.make} ${t.model} — ${t.trim} (κ=${t.suspensionDampingFactor}x)</option>`;
      });
      html += `</optgroup>`;
      plannerSel.innerHTML = html;
    }

    renderGarageList();
    updateHeaderCarUI();
  }

  function renderGarageList() {
    const container = document.getElementById('userGarageList');
    if (!container) return;

    if (!state.user || state.vehicles.length === 0) {
      const activeTpl = getActiveCarObject();
      container.innerHTML = `
        <div style="padding:0.9rem; background:rgba(16,185,129,0.08); border:1px solid rgba(16,185,129,0.3); border-radius:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>Active Preview Profile: ${activeTpl.year || 2025} ${activeTpl.make} ${activeTpl.model}</strong>
            <span class="badge badge-splus">κ = ${activeTpl.suspensionDampingFactor || 1.06}x</span>
          </div>
          <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.25rem;">
            ${activeTpl.trim || ''} • ${activeTpl.suspensionLabel || 'Standard Damping'}
          </div>
          <div style="font-size:0.76rem; color:#7dd3fc; margin-top:0.4rem;">
            Sign up or log in to save multiple custom cars in your personal garage!
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = state.vehicles
      .map(
        (v) => `
        <div style="padding:0.9rem; background:rgba(13,21,38,0.9); border:1px solid ${v.isPrimary ? 'var(--accent-emerald)' : 'var(--border-subtle)'}; border-radius:10px; display:flex; justify-content:space-between; align-items:center; gap:0.75rem; flex-wrap:wrap;">
          <div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <strong style="font-size:0.95rem;">${v.nickname || `${v.year} ${v.make} ${v.model}`}</strong>
              ${v.isPrimary ? '<span class="badge badge-splus">Active Primary Car</span>' : ''}
              <span class="badge badge-info">κ = ${v.suspensionDampingFactor}x</span>
            </div>
            <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:0.2rem;">
              ${v.year} ${v.make} ${v.model} (${v.trim}) • ${v.wheelDiameterInches}" wheels • ${v.fsdHardware || 'FSD Ready'}
            </div>
          </div>
          <div style="display:flex; gap:0.4rem;">
            ${!v.isPrimary ? `<button class="btn btn-outline btn-sm btn-set-primary-car" data-id="${v.id}">Set Primary</button>` : ''}
            <button class="btn btn-outline btn-sm btn-delete-car" data-id="${v.id}" style="color:#f87171;">Remove</button>
          </div>
        </div>
      `
      )
      .join('');

    container.querySelectorAll('.btn-set-primary-car').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const data = await apiFetch(`/api/vehicles/${btn.dataset.id}/primary`, { method: 'PUT' });
          state.vehicles = data.vehicles;
          state.activeVehicleId = Number(btn.dataset.id);
          populateVehicleSelectors();
          loadRouteComparison();
          showToast('Updated active primary car!');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    container.querySelectorAll('.btn-delete-car').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const data = await apiFetch(`/api/vehicles/${btn.dataset.id}`, { method: 'DELETE' });
          state.vehicles = data.vehicles;
          populateVehicleSelectors();
          showToast('Removed vehicle from garage.');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  }

  function renderBenchmarksTable() {
    const tbody = document.getElementById('vehicleBenchmarkTbody');
    if (!tbody) return;
    tbody.innerHTML = state.benchmarks
      .map((b) => {
        const pred = b.benchmarkOnStandardRoad || {};
        return `
          <tr>
            <td>
              <div style="font-weight:700;">${b.year} ${b.make} ${b.model}</div>
              <div style="font-size:0.73rem; color:var(--text-secondary);">${b.trim}</div>
            </td>
            <td>
              <div>${b.suspensionLabel}</div>
              <div style="font-size:0.72rem; color:var(--text-secondary);">${b.wheelDiameterInches}" wheels / ${b.tireSidewallRatio}-series tire</div>
            </td>
            <td><span class="badge ${b.suspensionDampingFactor <= 0.9 ? 'badge-splus' : b.suspensionDampingFactor <= 1.1 ? 'badge-info' : 'badge-warn'}">${b.suspensionDampingFactor}x</span></td>
            <td style="font-weight:700;">${pred.predictedPeakVertG}G</td>
            <td><span style="color:${pred.predictedBodyWearScore <= 35 ? '#34d399' : pred.predictedBodyWearScore <= 55 ? '#fbbf24' : '#f87171'}; font-weight:700;">${pred.predictedBodyWearScore}/100</span></td>
            <td><strong>${pred.predictedFsdScore}/100</strong></td>
          </tr>
        `;
      })
      .join('');
  }

  // --- COCKPIT CANVAS: 2D G-Ball & 3-Axis Waveform Oscilloscope ---
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
    const maxRadius = w / 2 - 18; // represents 1.0G

    ctx.clearRect(0, 0, w, h);

    // Threshold rings: 0.25G, 0.50G, 0.75G, 1.0G
    const rings = [
      { g: 0.25, color: 'rgba(16, 185, 129, 0.28)' },
      { g: 0.5, color: 'rgba(245, 158, 11, 0.28)' },
      { g: 0.75, color: 'rgba(239, 68, 68, 0.28)' },
      { g: 1.0, color: 'rgba(148, 163, 184, 0.2)' }
    ];

    rings.forEach((r) => {
      const rad = r.g * maxRadius;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText(`${r.g}G`, cx + 4, cy - rad + 11);
    });

    // Crosshairs
    ctx.beginPath();
    ctx.moveTo(cx, 12);
    ctx.lineTo(cx, h - 12);
    ctx.moveTo(12, cy);
    ctx.lineTo(w - 12, cy);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.stroke();

    // Draw trailing G history
    state.gBallTrail.forEach((pt, idx) => {
      const alpha = ((idx + 1) / state.gBallTrail.length) * 0.45;
      const px = cx + Math.max(-1, Math.min(1, pt.gLat)) * maxRadius;
      const py = cy - Math.max(-1, Math.min(1, pt.gLon)) * maxRadius;
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(56, 189, 248, ${alpha})`;
      ctx.fill();
    });

    // Current G vector ball
    const { gLon, gLat, gVert, gTotal } = state.liveCurrent;
    const bx = cx + Math.max(-0.95, Math.min(0.95, gLat)) * maxRadius;
    const by = cy - Math.max(-0.95, Math.min(0.95, gLon)) * maxRadius;

    // Vertical shock halo around G-ball
    const vertRadius = 10 + Math.min(28, Math.abs(gVert) * 36);
    const ballColor =
      gTotal >= 0.55 || Math.abs(gVert) >= 0.45
        ? '#ef4444'
        : gTotal >= 0.28 || Math.abs(gVert) >= 0.22
        ? '#f59e0b'
        : '#10b981';

    ctx.beginPath();
    ctx.arc(bx, by, vertRadius, 0, Math.PI * 2);
    ctx.fillStyle = ballColor + '33';
    ctx.fill();

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
    const scaleY = (h / 2 - 16) / 0.9; // +-0.9G full scale

    ctx.clearRect(0, 0, w, h);

    // Grid lines for +0.5G, 0G, -0.5G
    [-0.5, 0, 0.5].forEach((gVal) => {
      const y = midY - gVal * scaleY;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.strokeStyle = gVal === 0 ? 'rgba(148,163,184,0.35)' : 'rgba(239,68,68,0.2)';
      ctx.setLineDash(gVal === 0 ? [] : [5, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText(`${gVal > 0 ? '+' : ''}${gVal}G`, 6, y - 4);
    });

    const pts = state.waveformHistory;
    if (pts.length < 2) return;

    const plotChannel = (key, color, lineWidth = 2) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = (i / 159) * w;
        const val = Math.max(-0.95, Math.min(0.95, p[key] || 0));
        const y = midY - val * scaleY;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    };

    plotChannel('gLat', '#a78bfa', 1.6);
    plotChannel('gLon', '#38bdf8', 1.8);
    plotChannel('gVert', '#10b981', 2.4);
  }

  function pushLiveTelemetrySample(sample) {
    const prev = state.recordedSamples[state.recordedSamples.length - 1];
    const dt = prev ? Math.max(0.05, (sample.timestampMs - prev.timestampMs) / 1000) : 0.1;

    const gLon = Number(sample.gLon.toFixed(4));
    const gLat = Number(sample.gLat.toFixed(4));
    const gVert = Number(sample.gVert.toFixed(4));
    const gTotal = Number(Math.hypot(gLon, gLat, gVert).toFixed(4));

    let jerk = 0;
    if (prev) {
      jerk = Math.hypot(gLon - prev.gLon, gLat - prev.gLat, gVert - prev.gVert) / Math.max(0.08, dt);
    }

    const aw = Math.hypot(1.4 * gLon * G0, 1.4 * gLat * G0, gVert * G0);
    state.liveCurrent.vdvIntegral += Math.pow(aw, 4) * dt;
    const vdv = Math.pow(state.liveCurrent.vdvIntegral, 0.25);
    const peakG = Math.max(state.liveCurrent.peakG, gTotal);

    state.liveCurrent = {
      gLon,
      gLat,
      gVert,
      gTotal,
      peakG,
      jerk,
      vdvIntegral: state.liveCurrent.vdvIntegral,
      vdv
    };

    const fullPoint = {
      timestampMs: sample.timestampMs || Date.now(),
      lat: sample.lat ?? state.currentGps.lat,
      lng: sample.lng ?? state.currentGps.lng,
      gLon,
      gLat,
      gVert,
      gTotal,
      speedMph: sample.speedMph ?? state.currentGps.speedMph,
      fsdActive: true
    };

    state.recordedSamples.push(fullPoint);
    state.waveformHistory.push(fullPoint);
    if (state.waveformHistory.length > 160) state.waveformHistory.shift();

    state.gBallTrail.push({ gLon, gLat });
    if (state.gBallTrail.length > 25) state.gBallTrail.shift();

    // Update numeric HUD readouts
    document.getElementById('liveGVert').textContent = `${gVert >= 0 ? '+' : ''}${gVert.toFixed(2)}G`;
    document.getElementById('liveGLon').textContent = `${gLon >= 0 ? '+' : ''}${gLon.toFixed(2)}G`;
    document.getElementById('liveGLat').textContent = `${gLat >= 0 ? '+' : ''}${gLat.toFixed(2)}G`;
    document.getElementById('livePeakG').textContent = `${peakG.toFixed(2)}G`;
    document.getElementById('liveJerk').textContent = `${jerk.toFixed(1)} G/s`;
    document.getElementById('liveVdv').textContent = vdv.toFixed(2);

    drawCockpitCanvases();
  }

  // --- Interactive Physics Drive Telemetry Simulator ---
  function toggleSimulatedDrive() {
    const btnSim = document.getElementById('btnToggleSimDrive');
    const btnSave = document.getElementById('btnStopAndSaveTrip');
    const statusBadge = document.getElementById('sensorStatusBadge');

    if (state.isSimulating) {
      clearInterval(state.simTimer);
      state.simTimer = null;
      state.isSimulating = false;
      btnSim.textContent = '▶️ Resume Simulated FSD Drive';
      statusBadge.textContent = `Paused (${state.recordedSamples.length} pts)`;
      return;
    }

    // Reset if starting fresh
    if (state.recordedSamples.length === 0) {
      state.liveCurrent = { gLon: 0, gLat: 0, gVert: 0, gTotal: 0, peakG: 0, jerk: 0, vdvIntegral: 0, vdv: 0 };
      state.waveformHistory = [];
      state.gBallTrail = [];
    }

    state.isSimulating = true;
    btnSim.textContent = '⏸️ Pause Simulator';
    btnSave.disabled = false;
    statusBadge.textContent = 'Recording Live Telemetry (10Hz)';

    const car = getActiveCarObject();
    const carFactor = Number(car.suspensionDampingFactor || 1.0);
    let step = state.recordedSamples.length;

    state.simTimer = setInterval(() => {
      step++;
      const profile = document.getElementById('simRouteSelect')?.value || 'smooth_i280';

      let baseVert = 0.035 * Math.sin(step * 0.45) + (Math.random() - 0.5) * 0.03;
      let baseLon = 0.04 * Math.cos(step * 0.15);
      let baseLat = 0.07 * Math.sin(step * 0.12);
      let speed = 64;

      if (profile === 'rough_us101') {
        baseVert = 0.14 * Math.sin(step * 0.8) + (Math.random() - 0.5) * 0.12;
        if (step % 28 === 0) baseVert = 0.58; // periodic sunken bridge joint
        if (step % 45 === 0) baseLon = -0.44; // merge hard brake
        speed = 56;
      } else if (profile === 'concrete_ca85') {
        baseVert = 0.16 * Math.sin(step * 1.45) + (Math.random() - 0.5) * 0.06;
        if (step % 22 === 0) baseVert = 0.42;
        speed = 62;
      } else if (profile === 'construction_us183') {
        baseVert = 0.19 * Math.sin(step * 0.9) + (Math.random() - 0.5) * 0.16;
        if (step % 18 === 0) baseVert = 0.72; // steel trench plate
        baseLat = 0.22 * Math.sin(step * 0.25);
        speed = 46;
      }

      // Apply user-injected live hazard impulse if clicked
      if (state.pendingImpulse) {
        baseVert += state.pendingImpulse.gVert || 0;
        baseLon += state.pendingImpulse.gLon || 0;
        baseLat += state.pendingImpulse.gLat || 0;
        state.pendingImpulse = null;
      }

      // Scale road input by car's suspension damping factor
      const gVert = baseVert * carFactor;
      const gLon = baseLon;
      const gLat = baseLat * (car.lateralRollFactor || 1.0);

      // Advance simulated GPS along corridor
      state.currentGps.lat -= 0.00045;
      state.currentGps.lng += 0.00038;
      state.currentGps.speedMph = speed;

      pushLiveTelemetrySample({
        timestampMs: Date.now(),
        lat: state.currentGps.lat,
        lng: state.currentGps.lng,
        gLon,
        gLat,
        gVert,
        speedMph: speed
      });
    }, 100);
  }

  // --- Real Phone Accelerometer & GPS Sensor Recording ---
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
      btnPhone.textContent = '📱 Start Real Phone Sensor Recording';
      statusBadge.textContent = `Phone Stopped (${state.recordedSamples.length} pts)`;
      return;
    }

    // Request iOS 13+ DeviceMotion permission if required
    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      try {
        const perm = await DeviceMotionEvent.requestPermission();
        if (perm !== 'granted') {
          showToast('Accelerometer permission was denied by browser.', 'error');
          return;
        }
      } catch (err) {
        showToast(`Sensor permission error: ${err.message}`, 'error');
        return;
      }
    }

    // Request Screen WakeLock so phone screen stays awake on dash mount
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
    state.liveCurrent = { gLon: 0, gLat: 0, gVert: 0, gTotal: 0, peakG: 0, jerk: 0, vdvIntegral: 0, vdv: 0 };
    state.isRecordingPhone = true;
    btnPhone.textContent = '⏹️ Pause Phone Sensor Stream';
    btnSave.disabled = false;
    statusBadge.textContent = 'Phone Sensors Active';

    window.addEventListener('devicemotion', handleDeviceMotion);
    showToast('Phone 3-axis accelerometer & GPS tracking active!');
  }

  let lastMotionProcessedMs = 0;
  function handleDeviceMotion(event) {
    const now = Date.now();
    if (now - lastMotionProcessedMs < 80) return; // ~12.5 Hz downsample
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
    try {
      const samples =
        state.rawMotionBuffer.length > 0
          ? state.rawMotionBuffer
          : [{ ax: 0.05, ay: 9.18, az: 3.44 }];
      const res = await apiFetch('/api/trips/calibrate', {
        method: 'POST',
        body: JSON.stringify({ samples })
      });
      state.calibration = res.calibration;
      document.getElementById('mountCalibrationInfo').textContent =
        `Mount Calibration: ${res.calibration.mountAngles.pitchDeg}° pitch, ${res.calibration.mountAngles.rollDeg}° roll (Zeroed)`;
      showToast(res.message);
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // --- Finish & Save Recorded Trip ---
  async function finishAndSaveTrip() {
    if (state.isSimulating) {
      clearInterval(state.simTimer);
      state.simTimer = null;
      state.isSimulating = false;
      document.getElementById('btnToggleSimDrive').textContent = '▶️ Start Simulated FSD Drive';
    }
    if (state.isRecordingPhone) {
      window.removeEventListener('devicemotion', handleDeviceMotion);
      state.isRecordingPhone = false;
      document.getElementById('btnStartPhoneSensors').textContent = '📱 Start Real Phone Sensor Recording';
    }

    if (state.recordedSamples.length < 3) {
      showToast('Record at least a few seconds of telemetry before saving.', 'warn');
      return;
    }

    try {
      const title = document.getElementById('tripTitleInput').value || 'Recorded G-Force Drive';
      const originName = document.getElementById('tripOriginInput').value || 'Origin';
      const destinationName = document.getElementById('tripDestInput').value || 'Destination';
      const driveMode = document.getElementById('tripDriveModeSelect').value || 'FSD Supervised';
      const publishAsRoute = document.getElementById('tripPublishRouteCheck').value === 'true';

      const res = await apiFetch('/api/trips', {
        method: 'POST',
        body: JSON.stringify({
          vehicleId: state.activeVehicleId,
          templateId: state.activeVehicleTemplateId,
          title,
          originName,
          destinationName,
          corridorGroup: state.corridor === 'all' ? 'sf-palo-alto' : state.corridor,
          driveMode,
          publishAsRoute,
          autoPublishHazards: true,
          samples: state.recordedSamples
        })
      });

      const a = res.analysis;
      const reportBadge = document.getElementById('reportFsdGradeBadge');
      if (reportBadge) {
        reportBadge.textContent = `${a.fsdGrade} (${a.fsdComfortScore}/100)`;
        reportBadge.className = `badge ${a.fsdComfortScore >= 85 ? 'badge-splus' : a.fsdComfortScore >= 65 ? 'badge-warn' : 'badge-danger'}`;
      }

      const reportBody = document.getElementById('latestTripReportBody');
      if (reportBody) {
        reportBody.innerHTML = `
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:0.75rem; margin-bottom:0.85rem;">
            <div class="readout-box">
              <div class="r-label">Smoothness Score</div>
              <div class="r-val" style="color:#10b981;">${a.smoothnessScore}/100</div>
            </div>
            <div class="readout-box">
              <div class="r-label">FSD Comfort Score</div>
              <div class="r-val" style="color:#38bdf8;">${a.fsdComfortScore}/100</div>
            </div>
            <div class="readout-box">
              <div class="r-label">Body Wear Index</div>
              <div class="r-val" style="color:#f59e0b;">${a.bodyWearScore}/100 (${a.bodyWearGrade})</div>
            </div>
            <div class="readout-box">
              <div class="r-label">ISO-2631 VDV Dose</div>
              <div class="r-val">${a.vibrationDoseValueVdv} m/s¹·⁷⁵</div>
            </div>
            <div class="readout-box">
              <div class="r-label">Peak Vertical Shock</div>
              <div class="r-val">${a.peakGVert}G</div>
            </div>
            <div class="readout-box">
              <div class="r-label">Spine Micro-Shocks</div>
              <div class="r-val">${a.spineMicroShocksCount} events</div>
            </div>
          </div>
          <div style="padding:0.75rem; background:rgba(16,185,129,0.1); border-radius:8px; border:1px solid rgba(16,185,129,0.3);">
            <strong>FSD &amp; Body Wear Assessment:</strong> ${a.fsdRecommendation}<br/>
            <span style="font-size:0.78rem; color:var(--text-secondary);">
              Auto-mapped <strong>${(res.detectedHazards || []).length}</strong> high-G road hazards to the public map.
              <a href="/api/trips/${res.trip.id}/export?format=csv" style="color:#38bdf8; margin-left:8px;" target="_blank">⬇️ Export CSV</a>
              <a href="/api/trips/${res.trip.id}/export?format=gpx" style="color:#38bdf8; margin-left:8px;" target="_blank">⬇️ Export GPX</a>
            </span>
          </div>
        `;
      }

      state.recordedSamples = [];
      document.getElementById('btnStopAndSaveTrip').disabled = true;
      showToast('Trip saved, biomechanics analyzed & public map updated!');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // --- Trips Feed & Export ---
  async function loadTripsFeed(mineOnly = false) {
    try {
      const data = await apiFetch(`/api/trips?mine=${mineOnly ? '1' : '0'}&limit=20`);
      state.trips = data.trips || [];
      const container = document.getElementById('tripsFeedContainer');
      if (!container) return;

      if (state.trips.length === 0) {
        container.innerHTML = `<div style="color:var(--text-secondary); font-size:0.85rem;">No trips recorded yet. Use the Phone G-Force Cockpit to record your first trip!</div>`;
        return;
      }

      container.innerHTML = state.trips
        .map((t) => {
          const badgeCls =
            t.fsdComfortScore >= 85 ? 'badge-splus' : t.fsdComfortScore >= 65 ? 'badge-warn' : 'badge-danger';
          return `
            <div style="background:rgba(13,21,38,0.9); border:1px solid var(--border-subtle); border-radius:10px; padding:0.9rem;">
              <div style="display:flex; justify-content:space-between; align-items:center; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.3rem;">
                <strong>${t.title}</strong>
                <span class="badge ${badgeCls}">${t.fsdGrade} • ${t.fsdComfortScore}/100</span>
              </div>
              <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.55rem;">
                Driver: <strong>${t.driverName}</strong> • Car: <strong>${t.vehicleLabel}</strong> (κ=${t.suspensionDampingFactor}x) • Mode: ${t.driveMode}
              </div>
              <div class="route-metrics-strip" style="margin:0.45rem 0;">
                <div class="rm-item"><span class="rm-label">Smoothness</span><span class="rm-val">${t.smoothnessScore}/100</span></div>
                <div class="rm-item"><span class="rm-label">Body Wear</span><span class="rm-val">${t.bodyWearScore}/100</span></div>
                <div class="rm-item"><span class="rm-label">Peak Vert G</span><span class="rm-val">${t.peakGVert}G</span></div>
                <div class="rm-item"><span class="rm-label">VDV Dose</span><span class="rm-val">${t.vibrationDoseValueVdv}</span></div>
              </div>
              <div style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:0.5rem;">${t.notes || t.fsdRecommendation || ''}</div>
              <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
                <a class="btn btn-outline btn-sm" href="/api/trips/${t.id}/export?format=csv" target="_blank">⬇️ CSV</a>
                <a class="btn btn-outline btn-sm" href="/api/trips/${t.id}/export?format=gpx" target="_blank">⬇️ GPX</a>
                <a class="btn btn-outline btn-sm" href="/api/trips/${t.id}/export?format=json" target="_blank">⬇️ JSON</a>
              </div>
            </div>
          `;
        })
        .join('');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // --- Auth & Account UI ---
  function updateAuthUI() {
    const headerBtn = document.getElementById('headerAuthBtn');
    const statusBadge = document.getElementById('accountStatusBadge');
    const formsWrap = document.getElementById('authFormsWrapper');
    const profileWrap = document.getElementById('loggedInProfileWrapper');

    if (state.user) {
      if (headerBtn) headerBtn.textContent = `👤 ${state.user.displayName}`;
      if (statusBadge) {
        statusBadge.textContent = 'Authenticated Driver';
        statusBadge.className = 'badge badge-splus';
      }
      if (formsWrap) formsWrap.style.display = 'none';
      if (profileWrap) {
        profileWrap.style.display = 'flex';
        document.getElementById('profileDisplayName').textContent = state.user.displayName;
        document.getElementById('profileEmailLine').textContent = `@${state.user.username} • ${state.user.email}`;
        document.getElementById('profModeSelect').value = state.user.driverModePreference || 'fsd_smooth';
      }
    } else {
      if (headerBtn) headerBtn.textContent = 'Sign Up / Log In';
      if (statusBadge) {
        statusBadge.textContent = 'Guest Mode';
        statusBadge.className = 'badge badge-info';
      }
      if (formsWrap) formsWrap.style.display = 'block';
      if (profileWrap) profileWrap.style.display = 'none';
    }
  }

  async function refreshAllData() {
    try {
      const [tplData, summaryData, hazData] = await Promise.all([
        apiFetch('/api/vehicles/templates'),
        apiFetch('/api/analytics/summary'),
        apiFetch('/api/hazards')
      ]);

      state.templates = tplData.templates || [];
      state.benchmarks = summaryData.vehicleBenchmarks || [];
      state.hazards = hazData.hazards || [];

      if (summaryData.totals) {
        document.getElementById('statPublicRoutes').textContent = summaryData.totals.totalPublicRoutes;
        document.getElementById('statCommunityDrives').textContent = `${summaryData.totals.totalCommunityDrives}+ Crowd-Sourced Drives`;
        document.getElementById('statHazards').textContent = summaryData.totals.totalHazardsMapped;
      }

      if (state.token) {
        try {
          const meData = await apiFetch('/api/auth/me');
          state.user = meData.user;
          state.vehicles = meData.user.vehicles || [];
          if (meData.user.calibration) {
            state.calibration = meData.user.calibration;
          }
        } catch {
          state.token = null;
          state.user = null;
          localStorage.removeItem('sr_token');
        }
      }

      updateAuthUI();
      populateVehicleSelectors();
      renderBenchmarksTable();
      renderHazardsList();
      await loadRouteComparison();
      await loadTripsFeed(false);
    } catch (err) {
      console.error('Initialization error:', err);
    }
  }

  // --- Wire Event Listeners ---
  function bindEvents() {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.getElementById('headerCarBadge')?.addEventListener('click', () => switchTab('garage'));
    document.getElementById('headerAuthBtn')?.addEventListener('click', () => switchTab('community'));

    document.getElementById('corridorSelect')?.addEventListener('change', loadRouteComparison);
    document.getElementById('optimizationModeSelect')?.addEventListener('change', loadRouteComparison);
    document.getElementById('plannerVehicleSelect')?.addEventListener('change', loadRouteComparison);
    document.getElementById('btnCompareRoutes')?.addEventListener('click', loadRouteComparison);

    document.getElementById('btnFitMapBounds')?.addEventListener('click', () => {
      renderMapRoutesAndHazards();
    });
    document.getElementById('btnGoRecordFromMap')?.addEventListener('click', () => switchTab('cockpit'));

    document.getElementById('btnToggleMapTheme')?.addEventListener('click', (e) => {
      const mapEl = document.getElementById('routeMap');
      if (!mapEl) return;
      const isDark = mapEl.classList.toggle('map-dark-tiles');
      e.currentTarget.textContent = isDark ? '☀️ Daylight Map' : '🌙 Tesla Dark Map';
    });

    async function handlePlanCustomRoute() {
      const originQuery = document.getElementById('customOriginInput')?.value.trim();
      const destinationQuery = document.getElementById('customDestInput')?.value.trim();
      if (!originQuery || !destinationQuery) {
        showToast('Enter both a Custom Origin and Custom Destination (e.g. San Jose, CA to San Francisco, CA).', 'warn');
        return;
      }
      const btn = document.getElementById('btnPlanCustomRoute');
      const prevText = btn ? btn.textContent : '';
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Calculating Smooth Routes...';
      }
      try {
        const data = await apiFetch('/api/routes/custom-plan', {
          method: 'POST',
          body: JSON.stringify({
            originQuery,
            destinationQuery,
            mode: state.mode,
            vehicleId: state.activeVehicleId,
            templateId: state.activeVehicleTemplateId,
            saveToPublic: true
          })
        });
        renderRouteComparisonUI(data);
        renderMapRoutesAndHazards();
        showToast(`Calculated ${data.rankedRoutes.length} routes from ${originQuery} to ${destinationQuery}!`);
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = prevText;
        }
      }
    }

    document.getElementById('btnPlanCustomRoute')?.addEventListener('click', handlePlanCustomRoute);
    ['customOriginInput', 'customDestInput'].forEach((id) => {
      document.getElementById(id)?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handlePlanCustomRoute();
        }
      });
    });

    // Hazard Modal
    const hazardModal = document.getElementById('hazardModal');
    document.getElementById('btnOpenHazardModal')?.addEventListener('click', () => {
      hazardModal?.classList.add('open');
    });
    document.getElementById('btnCloseHazardModal')?.addEventListener('click', () => {
      hazardModal?.classList.remove('open');
    });

    document.getElementById('reportHazardForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const car = getActiveCarObject();
        await apiFetch('/api/hazards', {
          method: 'POST',
          body: JSON.stringify({
            label: document.getElementById('hazLabel').value,
            type: document.getElementById('hazType').value,
            severity: document.getElementById('hazSeverity').value,
            roadName: document.getElementById('hazRoadName').value,
            peakG: Number(document.getElementById('hazPeakG').value),
            verticalG: Number(document.getElementById('hazPeakG').value) * 0.92,
            lat: Number(document.getElementById('hazLat').value),
            lng: Number(document.getElementById('hazLng').value),
            description: document.getElementById('hazDesc').value,
            vehicleLabel: `${car.year || 2025} ${car.make} ${car.model}`
          })
        });
        hazardModal?.classList.remove('open');
        showToast('Hazard added to public G-force map!');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Cockpit Controls
    document.getElementById('btnToggleSimDrive')?.addEventListener('click', toggleSimulatedDrive);
    document.getElementById('btnStartPhoneSensors')?.addEventListener('click', toggleRealPhoneSensors);
    document.getElementById('btnCalibrateMount')?.addEventListener('click', calibratePhoneMount);
    document.getElementById('btnStopAndSaveTrip')?.addEventListener('click', finishAndSaveTrip);

    document.getElementById('btnInjectPothole')?.addEventListener('click', () => {
      state.pendingImpulse = { gVert: 0.68, gLon: -0.18, gLat: 0.05 };
      if (!state.isSimulating) {
        pushLiveTelemetrySample({
          timestampMs: Date.now(),
          gVert: 0.68,
          gLon: -0.18,
          gLat: 0.05
        });
      }
      showToast('Injected 0.68G Pothole Vertical Shock!', 'warn');
    });

    document.getElementById('btnInjectJoint')?.addEventListener('click', () => {
      state.pendingImpulse = { gVert: 0.38, gLon: -0.06, gLat: 0.02 };
      if (!state.isSimulating) {
        pushLiveTelemetrySample({
          timestampMs: Date.now(),
          gVert: 0.38,
          gLon: -0.06,
          gLat: 0.02
        });
      }
      showToast('Injected 0.38G Expansion Joint Bounce!');
    });

    document.getElementById('btnInjectBrake')?.addEventListener('click', () => {
      state.pendingImpulse = { gVert: 0.14, gLon: -0.52, gLat: 0.03 };
      if (!state.isSimulating) {
        pushLiveTelemetrySample({
          timestampMs: Date.now(),
          gVert: 0.14,
          gLon: -0.52,
          gLat: 0.03
        });
      }
      showToast('Injected -0.52G FSD Hard Braking Event!', 'warn');
    });

    document.getElementById('btnInjectCurve')?.addEventListener('click', () => {
      state.pendingImpulse = { gVert: 0.08, gLon: -0.08, gLat: 0.44 };
      if (!state.isSimulating) {
        pushLiveTelemetrySample({
          timestampMs: Date.now(),
          gVert: 0.08,
          gLon: -0.08,
          gLat: 0.44
        });
      }
      showToast('Injected 0.44G High Lateral-G Curve!');
    });

    // Garage Add Car
    document.getElementById('btnAddGarageVehicle')?.addEventListener('click', async () => {
      const tplId = document.getElementById('garageTemplateSelect').value;
      const nickname = document.getElementById('garageNicknameInput').value;
      const susp = document.getElementById('garageSuspSelect').value;
      const wheel = document.getElementById('garageWheelInput').value;

      if (!state.token) {
        state.activeVehicleTemplateId = tplId;
        populateVehicleSelectors();
        loadRouteComparison();
        showToast('Switched active car profile! Sign up to save multiple cars permanently.');
        return;
      }

      try {
        const res = await apiFetch('/api/vehicles', {
          method: 'POST',
          body: JSON.stringify({
            templateId: tplId,
            nickname: nickname || undefined,
            suspensionType: susp || undefined,
            wheelDiameterInches: wheel ? Number(wheel) : undefined,
            isPrimary: true
          })
        });
        state.vehicles = res.vehicles;
        state.activeVehicleId = res.vehicle.id;
        populateVehicleSelectors();
        loadRouteComparison();
        showToast(`Added ${res.vehicle.nickname} to your garage!`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Auth Forms Toggle
    document.getElementById('btnShowSignupForm')?.addEventListener('click', () => {
      document.getElementById('signupForm').style.display = 'flex';
      document.getElementById('loginForm').style.display = 'none';
    });
    document.getElementById('btnShowLoginForm')?.addEventListener('click', () => {
      document.getElementById('signupForm').style.display = 'none';
      document.getElementById('loginForm').style.display = 'flex';
    });

    // Sign Up Submit
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
            vehicleTemplateId: document.getElementById('suCarTemplate').value,
            driverModePreference: document.getElementById('suDriverMode').value,
            bodySensitivity: document.getElementById('suSensitivity').value,
            fsdDriver: true
          })
        });
        state.token = data.token;
        localStorage.setItem('sr_token', data.token);
        state.user = data.user;
        state.vehicles = data.user.vehicles || [];
        updateAuthUI();
        populateVehicleSelectors();
        loadRouteComparison();
        showToast(`Welcome to SmoothRoute, ${data.user.displayName}!`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Log In Submit
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
        loadRouteComparison();
        showToast(`Welcome back, ${data.user.displayName}!`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Save Profile Preferences
    document.getElementById('btnSaveProfilePrefs')?.addEventListener('click', async () => {
      try {
        const mode = document.getElementById('profModeSelect').value;
        const data = await apiFetch('/api/auth/profile', {
          method: 'PUT',
          body: JSON.stringify({ driverModePreference: mode })
        });
        state.user = data.user;
        document.getElementById('optimizationModeSelect').value = mode;
        loadRouteComparison();
        showToast('Saved driver route optimization preferences!');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Logout
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

    // Filter Trips
    document.getElementById('btnFilterAllTrips')?.addEventListener('click', () => loadTripsFeed(false));
    document.getElementById('btnFilterMyTrips')?.addEventListener('click', () => loadTripsFeed(true));
  }

  // --- Boot Application ---
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
