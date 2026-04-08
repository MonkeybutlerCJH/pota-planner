/* POTA Planner — app.js */

// ---------------------------------------------------------------------------
// Map init
// ---------------------------------------------------------------------------
const map = L.map('map', { zoomControl: true }).setView([39.5, -98.35], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

function makeClusterGroup(color) {
  const hex = { green: '#4caf50', yellow: '#ffc107', grey: '#888888' }[color];
  return L.markerClusterGroup({
    chunkedLoading: true,
    iconCreateFunction(cluster) {
      const n = cluster.getChildCount();
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">
        <circle cx="17" cy="17" r="15" fill="${hex}" stroke="#1a1a1a" stroke-width="2" opacity="0.85"/>
        <text x="17" y="22" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#fff" font-weight="bold">${n}</text>
      </svg>`;
      return L.divIcon({ html: svg, className: '', iconSize: [34, 34], iconAnchor: [17, 17] });
    },
  });
}
const clusterGroups = {
  activated:   makeClusterGroup('green'),
  wishlist:    makeClusterGroup('yellow'),
  unactivated: makeClusterGroup('grey'),
};
function clusterGroupFor(cat) {
  return clusterGroups[cat] || clusterGroups.unactivated;
}
Object.values(clusterGroups).forEach(g => map.addLayer(g));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentPark = null;          // full park object currently shown in panel
let localParkRefs = new Set();   // references we have in local DB
let markersByRef = {};           // ref -> L.Marker
let markerCategoryByRef = {};    // ref -> 'activated'|'wishlist'|'unactivated'|'api'
const activeFilters = new Set(['activated', 'wishlist', 'unactivated']);

// ---------------------------------------------------------------------------
// Filter controls
// ---------------------------------------------------------------------------
function parkCategory(park) {
  if (park.activated) return 'activated';
  if (park.wishlist)  return 'wishlist';
  return 'unactivated';
}

function applyFilters() {
  Object.entries(markersByRef).forEach(([ref, marker]) => {
    const cat = markerCategoryByRef[ref] || 'unactivated';
    const group = clusterGroupFor(cat);
    const show = activeFilters.has(cat);
    if (show && !group.hasLayer(marker)) group.addLayer(marker);
    else if (!show && group.hasLayer(marker)) group.removeLayer(marker);
  });
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const f = btn.dataset.filter;
    if (activeFilters.has(f)) {
      activeFilters.delete(f);
      btn.classList.remove('active');
    } else {
      activeFilters.add(f);
      btn.classList.add('active');
    }
    applyFilters();
  });
});

// ---------------------------------------------------------------------------
// Marker icons
// ---------------------------------------------------------------------------
function makeIcon(color) {
  const colors = {
    green:  '#4caf50',
    yellow: '#ffc107',
    grey:   '#888888',
    blue:   '#4a9eff',
  };
  const hex = colors[color] || colors.grey;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
    <circle cx="9" cy="9" r="7" fill="${hex}" stroke="#1a1a1a" stroke-width="2"/>
  </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    popupAnchor: [0, -10],
  });
}

function markerColor(park) {
  if (park.activated) return 'green';
  if (park.wishlist)  return 'yellow';
  return 'grey';
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
const toastEl = document.createElement('div');
toastEl.id = 'toast';
document.body.appendChild(toastEl);

function showToast(msg, isError = false, duration = 2500) {
  toastEl.textContent = msg;
  toastEl.className = 'visible' + (isError ? ' error' : '');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.className = ''; }, duration);
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function api(path, options = {}) {
  try {
    const r = await fetch(path, options);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Load local DB markers on startup
// ---------------------------------------------------------------------------
async function loadLocalMarkers() {
  let parks;
  try {
    parks = await api('/api/parks');
  } catch (e) {
    showToast('Could not load local parks', true);
    return;
  }
  if (parks.length === 0) {
    showToast('No parks yet — import your activator CSV to get started', false, 5000);
  }
  parks.forEach(addOrUpdateMarker);
}

function addOrUpdateMarker(park) {
  if (!park.latitude || !park.longitude) return;

  localParkRefs.add(park.reference);
  markerCategoryByRef[park.reference] = parkCategory(park);

  if (markersByRef[park.reference]) {
    const marker = markersByRef[park.reference];
    marker.setIcon(makeIcon(markerColor(park)));
    // Re-apply filter visibility; remove from all groups first in case category changed
    Object.values(clusterGroups).forEach(g => { if (g.hasLayer(marker)) g.removeLayer(marker); });
    const cat = markerCategoryByRef[park.reference];
    if (activeFilters.has(cat)) clusterGroupFor(cat).addLayer(marker);
    return;
  }

  const marker = L.marker([park.latitude, park.longitude], {
    icon: makeIcon(markerColor(park)),
  });
  marker.on('click', () => onMarkerClick(park.reference, park));
  markersByRef[park.reference] = marker;
  const cat = markerCategoryByRef[park.reference];
  if (activeFilters.has(cat)) clusterGroupFor(cat).addLayer(marker);
}

// ---------------------------------------------------------------------------
// Marker click → open side panel
// ---------------------------------------------------------------------------
async function onMarkerClick(reference, parkData) {
  openPanel();
  setPanelLoading();

  let park = parkData;
  if (!localParkRefs.has(reference)) {
    // Blue marker — create stub, passing along name/coords we already have
    try {
      const stubData = {};
      if (parkData.name)      stubData.name      = parkData.name;
      if (parkData.latitude)  stubData.latitude  = parkData.latitude;
      if (parkData.longitude) stubData.longitude = parkData.longitude;
      await api(`/api/parks/${reference}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stubData),
      });
      localParkRefs.add(reference);
    } catch (e) { /* continue with what we have */ }
  }

  try {
    park = await api(`/api/parks/${reference}`);
  } catch (e) {
    showToast('Could not load park details', true);
    return;
  }

  currentPark = park;
  renderParkingPins(park);
  renderPanel(park);
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
function openPanel() {
  const panel = document.getElementById('side-panel');
  panel.addEventListener('transitionend', () => map.invalidateSize(), { once: true });
  panel.classList.remove('hidden');
}

function closePanel() {
  const panel = document.getElementById('side-panel');
  panel.addEventListener('transitionend', () => map.invalidateSize(), { once: true });
  panel.classList.add('hidden');
  currentPark = null;
  parkingLayer.clearLayers();
}

function setPanelLoading() {
  document.getElementById('panel-park-name').textContent = 'Loading…';
  document.getElementById('panel-reference').textContent = '';
  document.getElementById('badge-activated').classList.add('hidden');
  document.getElementById('badge-count').classList.add('hidden');
  document.getElementById('panel-body').innerHTML =
    '<div style="padding:24px 16px;color:var(--text-dim);display:flex;align-items:center;gap:8px">' +
    '<span class="spinner"></span>Loading park data…</div>';
}

document.getElementById('panel-close').addEventListener('click', closePanel);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!document.getElementById('lightbox').classList.contains('hidden')) {
      document.getElementById('lightbox').classList.add('hidden');
    } else if (!document.getElementById('modal-activation').classList.contains('hidden')) {
      document.getElementById('modal-activation').classList.add('hidden');
    } else if (!document.getElementById('modal-import').classList.contains('hidden')) {
      document.getElementById('modal-import').classList.add('hidden');
    } else {
      closePanel();
    }
  }
});

// ---------------------------------------------------------------------------
// Panel render — header + all sections
// ---------------------------------------------------------------------------
function renderPanel(park) {
  // --- Header ---
  document.getElementById('panel-park-name').textContent = park.name || park.reference;
  document.getElementById('panel-reference').textContent = park.reference;

  const potaLink = document.getElementById('panel-pota-link');
  potaLink.href = park.pota_url || `https://pota.app/#/park/${park.reference}`;

  const mapsLink = document.getElementById('panel-maps-link');
  if (park.latitude && park.longitude) {
    mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${park.latitude},${park.longitude}`;
    mapsLink.classList.remove('hidden');
  } else {
    mapsLink.classList.add('hidden');
  }

  const badgeActivated = document.getElementById('badge-activated');
  badgeActivated.classList.remove('hidden', 'badge-activated', 'badge-unactivated');
  if (park.activated) {
    badgeActivated.textContent = 'Activated';
    badgeActivated.classList.add('badge-activated');
  } else {
    badgeActivated.textContent = 'Unactivated';
    badgeActivated.classList.add('badge-unactivated');
  }
  badgeActivated.classList.remove('hidden');

  const badgeCount = document.getElementById('badge-count');
  if (park.activation_count > 0) {
    badgeCount.textContent = `${park.activation_count}×`;
    badgeCount.classList.remove('hidden');
  } else {
    badgeCount.classList.add('hidden');
  }

  document.getElementById('btn-wishlist').classList.toggle('active', !!park.wishlist);
  document.getElementById('btn-wishlist').onclick = () => toggleWishlist(park);

  // --- Body ---
  const body = document.getElementById('panel-body');
  body.innerHTML = '';
  body.appendChild(renderMediaSection(park));
  body.appendChild(renderNotesSection(park));
  body.appendChild(renderParkingSection(park));
  body.appendChild(renderActivationsSection(park));
}

// ---------------------------------------------------------------------------
// Media section (Step 12)
// ---------------------------------------------------------------------------
function renderMediaSection(park) {
  const sec = document.createElement('div');
  sec.className = 'panel-section';
  sec.innerHTML = '<h4>Photos &amp; Documents</h4>';

  const photos = (park.media || []).filter(m => m.file_type === 'photo');
  const pdfs   = (park.media || []).filter(m => m.file_type === 'pdf');
  const cover  = photos.find(p => p.is_cover);

  const cacheBust = `?t=${Date.now()}`;

  // Cover photo
  if (cover) {
    const img = document.createElement('img');
    img.className = 'cover-photo';
    img.src = `/${cover.file_path}${cacheBust}`;
    img.alt = cover.caption || 'Cover photo';
    img.addEventListener('click', () => openLightbox(`/${cover.file_path}${cacheBust}`));
    sec.appendChild(img);
  }

  // Thumbnail strip
  if (photos.length) {
    const strip = document.createElement('div');
    strip.className = 'thumb-strip';
    photos.forEach(photo => {
      const img = document.createElement('img');
      img.className = 'thumb' + (photo.is_cover ? ' is-cover' : '');
      img.src = `/${photo.file_path}${cacheBust}`;
      img.alt = photo.caption || '';
      img.title = photo.caption || '';
      img.addEventListener('click', () => openLightbox(`/${photo.file_path}${cacheBust}`));
      img.addEventListener('contextmenu', e => { e.preventDefault(); showPhotoMenu(e, photo, park); });
      strip.appendChild(img);
    });
    sec.appendChild(strip);
  }

  // PDF list
  if (pdfs.length) {
    const list = document.createElement('div');
    list.className = 'pdf-list';
    pdfs.forEach(pdf => {
      const item = document.createElement('div');
      item.className = 'pdf-item';
      item.innerHTML = `
        <a href="/${pdf.file_path}" target="_blank" rel="noopener">${pdf.file_path.split('/').pop()}</a>
        <span class="category-badge">${pdf.category || 'other'}</span>
        <button class="btn-delete-pdf" data-id="${pdf.id}" title="Delete">✕</button>`;
      list.appendChild(item);
    });
    list.querySelectorAll('.btn-delete-pdf').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this document?')) return;
        await api(`/api/media/${btn.dataset.id}`, { method: 'DELETE' });
        currentPark = await api(`/api/parks/${park.reference}`);
        renderPanel(currentPark);
      });
    });
    sec.appendChild(list);
  }

  // Upload row
  const uploadRow = document.createElement('div');
  uploadRow.className = 'upload-row';
  uploadRow.innerHTML = `
    <label style="margin:0"><button onclick="this.nextElementSibling.click()">+ Photo</button>
      <input type="file" accept="image/*" style="display:none"></label>
    <label style="margin:0"><button onclick="this.nextElementSibling.click()">+ PDF</button>
      <input type="file" accept=".pdf" style="display:none"></label>`;
  uploadRow.querySelectorAll('input[type=file]').forEach(input => {
    input.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', 'other');
      showToast('Uploading…', false, 10000);
      try {
        await fetch(`/api/parks/${park.reference}/media`, { method: 'POST', body: fd });
        showToast('Uploaded', false, 1500);
        currentPark = await api(`/api/parks/${park.reference}`);
        renderPanel(currentPark);
      } catch (err) {
        showToast('Upload failed: ' + err.message, true);
      }
      e.target.value = '';
    });
  });
  sec.appendChild(uploadRow);
  return sec;
}

function showPhotoMenu(e, photo, park) {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="cover">Set as cover</div>
    <div class="ctx-menu-item" data-action="rotate-cw">Rotate CW</div>
    <div class="ctx-menu-item" data-action="rotate-ccw">Rotate CCW</div>
    <div class="ctx-menu-item danger" data-action="delete">Delete</div>`;
  document.body.appendChild(menu);

  menu.querySelector('[data-action=cover]').addEventListener('click', async () => {
    menu.remove();
    await api(`/api/media/${photo.id}/cover`, { method: 'POST' });
    currentPark = await api(`/api/parks/${park.reference}`);
    renderPanel(currentPark);
  });
  menu.querySelector('[data-action=rotate-cw]').addEventListener('click', async () => {
    menu.remove();
    await api(`/api/media/${photo.id}/rotate`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ degrees: 90 }) });
    currentPark = await api(`/api/parks/${park.reference}`);
    renderPanel(currentPark);
  });
  menu.querySelector('[data-action=rotate-ccw]').addEventListener('click', async () => {
    menu.remove();
    await api(`/api/media/${photo.id}/rotate`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ degrees: 270 }) });
    currentPark = await api(`/api/parks/${park.reference}`);
    renderPanel(currentPark);
  });
  menu.querySelector('[data-action=delete]').addEventListener('click', async () => {
    menu.remove();
    if (!confirm('Delete this photo?')) return;
    await api(`/api/media/${photo.id}`, { method: 'DELETE' });
    currentPark = await api(`/api/parks/${park.reference}`);
    renderPanel(currentPark);
  });

  const dismiss = () => { menu.remove(); document.removeEventListener('click', dismiss); };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------
function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}
document.getElementById('lightbox-close').addEventListener('click', () =>
  document.getElementById('lightbox').classList.add('hidden'));
document.getElementById('lightbox-backdrop').addEventListener('click', () =>
  document.getElementById('lightbox').classList.add('hidden'));

// ---------------------------------------------------------------------------
// Notes section (Step 11)
// ---------------------------------------------------------------------------
const NOTE_FIELDS = [
  { key: 'bathroom_notes', label: 'Bathroom',          placeholder: 'Facilities available?' },
  { key: 'antenna_notes',  label: 'Antenna / Setup',   placeholder: 'Space, restrictions, directions…' },
  { key: 'noise_notes',    label: 'Noise Floor',       placeholder: 'Power lines, industrial, traffic…' },
  { key: 'cell_service',   label: 'Cell Service',      placeholder: 'Verizon good, AT&T none…' },
  { key: 'walk_distance',  label: 'Walk Distance',     placeholder: 'e.g. 200m from lot to clearing' },
  { key: 'special_rules',  label: 'Special Rules',     placeholder: 'Permits, seasonal closures…' },
  { key: 'general_notes',  label: 'General Notes',     placeholder: 'Anything else…', multiline: true },
];

function renderNotesSection(park) {
  const sec = document.createElement('div');
  sec.className = 'panel-section';
  sec.innerHTML = '<h4>Research Notes</h4>';

  NOTE_FIELDS.forEach(({ key, label, placeholder, multiline }) => {
    const wrap = document.createElement('div');
    wrap.className = 'note-field';

    const lbl = document.createElement('label');
    lbl.textContent = label;
    const ind = document.createElement('span');
    ind.className = 'save-indicator';
    ind.textContent = 'Saved';
    lbl.appendChild(ind);

    const val = document.createElement('div');
    val.className = 'note-value';
    val.contentEditable = 'true';
    val.dataset.placeholder = placeholder;
    val.dataset.key = key;
    if (multiline) val.style.minHeight = '64px';
    if (park[key]) val.textContent = park[key];

    let saveTimer = null;
    val.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveNote(park.reference, key, val, ind), 800);
    });
    val.addEventListener('keydown', e => {
      if (!multiline && e.key === 'Enter') { e.preventDefault(); val.blur(); }
    });
    val.addEventListener('blur', () => {
      clearTimeout(saveTimer);
      saveNote(park.reference, key, val, ind);
    });

    wrap.appendChild(lbl);
    wrap.appendChild(val);
    sec.appendChild(wrap);
  });

  return sec;
}

async function saveNote(reference, key, el, indicator) {
  const text = el.textContent.trim();
  try {
    await api(`/api/parks/${reference}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: text }),
    });
    indicator.classList.add('visible');
    setTimeout(() => indicator.classList.remove('visible'), 1500);
  } catch (e) {
    showToast('Save failed', true);
  }
}

// ---------------------------------------------------------------------------
// Parking location map pins
// ---------------------------------------------------------------------------
const parkingLayer = L.layerGroup().addTo(map);
const parkingMarkers = {};   // loc.id -> L.Marker

function makeParkingIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="9" fill="#ff8c00" stroke="#1a1a1a" stroke-width="2"/>
    <text x="11" y="15.5" text-anchor="middle" font-size="11" font-family="sans-serif" fill="#fff" font-weight="bold">P</text>
  </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -12] });
}

function renderParkingPins(park) {
  parkingLayer.clearLayers();
  Object.keys(parkingMarkers).forEach(k => delete parkingMarkers[k]);
  (park.parking_locations || []).forEach(loc => {
    const mapsUrl = `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
    const marker = L.marker([loc.latitude, loc.longitude], { icon: makeParkingIcon() });
    const coords = `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
    let popup = `<b style="color:#ff8c00">${loc.title || 'Parking'}</b><br>${coords}`;
    if (loc.notes) popup += `<br><span style="color:#ccc">${loc.notes}</span>`;
    popup += `<br><a href="${mapsUrl}" target="_blank">Google Maps ↗</a>`;
    marker.bindPopup(popup);
    parkingLayer.addLayer(marker);
    parkingMarkers[loc.id] = marker;
  });
}

function focusParkingPin(loc) {
  const marker = parkingMarkers[loc.id];
  if (!marker) return;
  map.flyTo([loc.latitude, loc.longitude], Math.max(map.getZoom(), 17), { duration: 0.6 });
  marker.openPopup();
}

// ---------------------------------------------------------------------------
// Parking locations section
// ---------------------------------------------------------------------------
function renderParkingSection(park) {
  const sec = document.createElement('div');
  sec.className = 'panel-section';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px';
  hdr.innerHTML = '<h4 style="margin:0">Parking Locations</h4>';
  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add';
  addBtn.style.fontSize = '12px';
  addBtn.addEventListener('click', () => openParkingForm());
  hdr.appendChild(addBtn);
  sec.appendChild(hdr);

  // Existing locations list
  const list = document.createElement('div');
  const locs = park.parking_locations || [];
  if (locs.length === 0) {
    list.innerHTML = '<p style="color:var(--text-dim);font-size:12px;margin:0 0 8px">No parking locations added yet.</p>';
  } else {
    locs.forEach(loc => list.appendChild(makeParkingLocItem(loc, park.reference)));
  }
  sec.appendChild(list);

  // Add form (hidden by default)
  const form = document.createElement('div');
  form.id = 'parking-add-form';
  form.className = 'parking-add-form hidden';
  form.innerHTML = `
    <input id="parking-title" type="text" placeholder="Title (e.g. Main Trailhead Lot)" style="width:100%;box-sizing:border-box;margin-bottom:6px">
    <div style="display:flex;gap:6px;margin-bottom:6px">
      <input id="parking-lat" type="number" step="any" placeholder="Latitude" style="flex:1;min-width:0">
      <input id="parking-lng" type="number" step="any" placeholder="Longitude" style="flex:1;min-width:0">
    </div>
    <textarea id="parking-notes" placeholder="Notes (access, surface, hours, fee…)" rows="3" style="width:100%;box-sizing:border-box;margin-bottom:6px;resize:vertical"></textarea>
    <div style="display:flex;gap:6px">
      <button class="btn-map-center" type="button" style="font-size:11px;flex:1">Use map center</button>
      <button class="btn-save-parking" type="button" style="font-size:11px;flex:1">Save</button>
      <button class="btn-cancel-parking" type="button" style="font-size:11px;flex:1">Cancel</button>
    </div>`;
  sec.appendChild(form);

  function openParkingForm(lat, lng) {
    form.classList.remove('hidden');
    if (lat != null && lng != null) {
      form.querySelector('#parking-lat').value = lat.toFixed(6);
      form.querySelector('#parking-lng').value = lng.toFixed(6);
    } else {
      const c = map.getCenter();
      form.querySelector('#parking-lat').value = c.lat.toFixed(6);
      form.querySelector('#parking-lng').value = c.lng.toFixed(6);
    }
    form.querySelector('#parking-title').focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  // Expose so the map right-click handler can call it
  sec._openParkingForm = openParkingForm;

  form.querySelector('.btn-map-center').addEventListener('click', () => {
    const c = map.getCenter();
    form.querySelector('#parking-lat').value = c.lat.toFixed(6);
    form.querySelector('#parking-lng').value = c.lng.toFixed(6);
  });

  form.querySelector('.btn-cancel-parking').addEventListener('click', () => {
    form.classList.add('hidden');
  });

  form.querySelector('.btn-save-parking').addEventListener('click', async () => {
    const lat = parseFloat(form.querySelector('#parking-lat').value);
    const lng = parseFloat(form.querySelector('#parking-lng').value);
    if (isNaN(lat) || isNaN(lng)) { showToast('Enter valid lat/lng', true); return; }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { showToast('Lat/lng out of range', true); return; }
    const title = form.querySelector('#parking-title').value.trim();
    const notes = form.querySelector('#parking-notes').value.trim();
    try {
      await api(`/api/parks/${park.reference}/parking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: lat, longitude: lng, title, notes }),
      });
      form.classList.add('hidden');
      currentPark = await api(`/api/parks/${park.reference}`);
      renderParkingPins(currentPark);
      renderPanel(currentPark);
    } catch (err) {
      showToast('Could not save parking location', true);
    }
  });

  return sec;
}

function makeParkingLocItem(loc, reference) {
  const item = document.createElement('div');
  item.className = 'parking-loc-item';
  item.style.flexDirection = 'column';

  const coords = `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
  const mapsUrl = `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;

  // --- Display row ---
  const display = document.createElement('div');
  display.className = 'parking-loc-display';
  display.title = 'Click to locate on map';
  display.innerHTML = `
    <div class="parking-loc-info">
      <div class="parking-loc-title">${loc.title || coords}</div>
      ${loc.title ? `<div class="parking-loc-coords">${coords}</div>` : ''}
      ${loc.notes ? `<div class="parking-loc-notes">${loc.notes}</div>` : ''}
    </div>
    <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
      <a href="${mapsUrl}" target="_blank" rel="noopener" style="font-size:11px;white-space:nowrap">Maps ↗</a>
      <button class="btn-edit-parking" title="Edit" style="font-size:11px">Edit</button>
      <button class="btn-delete-parking" title="Delete">✕</button>
    </div>`;

  display.querySelector('.parking-loc-info').addEventListener('click', () => focusParkingPin(loc));
  item.appendChild(display);

  // --- Edit form (hidden by default) ---
  const form = document.createElement('div');
  form.className = 'parking-add-form hidden';
  form.style.marginTop = '8px';
  form.innerHTML = `
    <input class="edit-title" type="text" placeholder="Title" value="${(loc.title || '').replace(/"/g, '&quot;')}" style="width:100%;box-sizing:border-box;margin-bottom:6px">
    <div style="display:flex;gap:6px;margin-bottom:6px">
      <input class="edit-lat" type="number" step="any" placeholder="Latitude" value="${loc.latitude}" style="flex:1;min-width:0">
      <input class="edit-lng" type="number" step="any" placeholder="Longitude" value="${loc.longitude}" style="flex:1;min-width:0">
    </div>
    <textarea class="edit-notes" rows="3" placeholder="Notes" style="width:100%;box-sizing:border-box;margin-bottom:6px;resize:vertical">${loc.notes || ''}</textarea>
    <div style="display:flex;gap:6px">
      <button class="btn-save-edit" type="button" style="font-size:11px;flex:1">Save</button>
      <button class="btn-cancel-edit" type="button" style="font-size:11px;flex:1">Cancel</button>
    </div>`;
  item.appendChild(form);

  display.querySelector('.btn-edit-parking').addEventListener('click', () => {
    display.classList.add('hidden');
    form.classList.remove('hidden');
    form.querySelector('.edit-title').focus();
  });

  form.querySelector('.btn-cancel-edit').addEventListener('click', () => {
    form.classList.add('hidden');
    display.classList.remove('hidden');
  });

  form.querySelector('.btn-save-edit').addEventListener('click', async () => {
    const lat = parseFloat(form.querySelector('.edit-lat').value);
    const lng = parseFloat(form.querySelector('.edit-lng').value);
    if (isNaN(lat) || isNaN(lng)) { showToast('Enter valid lat/lng', true); return; }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) { showToast('Lat/lng out of range', true); return; }
    try {
      await api(`/api/parking/${loc.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          latitude:  lat,
          longitude: lng,
          title:     form.querySelector('.edit-title').value.trim(),
          notes:     form.querySelector('.edit-notes').value.trim(),
        }),
      });
      currentPark = await api(`/api/parks/${reference}`);
      renderParkingPins(currentPark);
      renderPanel(currentPark);
    } catch (err) {
      showToast('Could not save changes', true);
    }
  });

  display.querySelector('.btn-delete-parking').addEventListener('click', async () => {
    if (!confirm('Remove this parking location?')) return;
    try {
      await api(`/api/parking/${loc.id}`, { method: 'DELETE' });
      currentPark = await api(`/api/parks/${reference}`);
      renderParkingPins(currentPark);
      renderPanel(currentPark);
    } catch (err) {
      showToast('Could not delete parking location', true);
    }
  });

  return item;
}

// ---------------------------------------------------------------------------
// Activation history section (Step 13)
// ---------------------------------------------------------------------------
function renderActivationsSection(park) {
  const sec = document.createElement('div');
  sec.className = 'panel-section';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px';
  header.innerHTML = '<h4 style="margin:0">Activation History</h4>';
  const logBtn = document.createElement('button');
  logBtn.textContent = 'Log Activation';
  logBtn.style.fontSize = '12px';
  logBtn.addEventListener('click', () => openActivationModal(park));
  header.appendChild(logBtn);
  sec.appendChild(header);

  const acts = park.activations || [];
  if (!acts.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'color:var(--text-dim);font-size:12px';
    empty.textContent = 'No activations logged yet.';
    sec.appendChild(empty);
  } else {
    acts.forEach(a => {
      const item = document.createElement('div');
      item.className = 'activation-item';
      const stars = a.would_return ? '★'.repeat(a.would_return) + '☆'.repeat(5 - a.would_return) : '';
      item.innerHTML = `
        <div class="activation-meta">
          <span class="activation-date">${a.activation_date || '—'}</span>
          <span class="activation-stars">${stars}</span>
        </div>
        <div style="display:flex;gap:12px">
          <span class="activation-bands">${a.bands_modes || ''}</span>
          <span class="activation-qso">${a.qso_count ? a.qso_count + ' QSOs' : ''}</span>
        </div>
        ${a.post_notes ? `<div class="activation-notes">${a.post_notes}</div>` : ''}`;
      sec.appendChild(item);
    });
  }
  return sec;
}

// ---------------------------------------------------------------------------
// Log activation modal (Step 13)
// ---------------------------------------------------------------------------
let _activationPark = null;

function openActivationModal(park) {
  _activationPark = park;
  const form = document.getElementById('form-activation');
  form.reset();
  // Default date to today
  form.activation_date.value = new Date().toISOString().slice(0, 10);
  // Reset stars
  document.querySelectorAll('#star-rating .star').forEach(s => s.classList.remove('lit'));
  form.would_return.value = '';
  document.getElementById('modal-activation').classList.remove('hidden');
}

document.getElementById('btn-activation-cancel').addEventListener('click', () =>
  document.getElementById('modal-activation').classList.add('hidden'));

// Star rating interaction
document.querySelectorAll('#star-rating .star').forEach(star => {
  star.addEventListener('click', () => {
    const val = parseInt(star.dataset.v);
    document.querySelector('#form-activation [name=would_return]').value = val;
    document.querySelectorAll('#star-rating .star').forEach(s =>
      s.classList.toggle('lit', parseInt(s.dataset.v) <= val));
  });
});

document.getElementById('form-activation').addEventListener('submit', async e => {
  e.preventDefault();
  if (!_activationPark) return;
  const fd = new FormData(e.target);
  const body = {
    activation_date:     fd.get('activation_date'),
    bands_modes:         fd.get('bands_modes'),
    qso_count:           parseInt(fd.get('qso_count')) || 0,
    cell_service_actual: fd.get('cell_service_actual'),
    would_return:        fd.get('would_return') ? parseInt(fd.get('would_return')) : null,
    post_notes:          fd.get('post_notes'),
  };
  try {
    await api(`/api/parks/${_activationPark.reference}/activations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    document.getElementById('modal-activation').classList.add('hidden');
    currentPark = await api(`/api/parks/${_activationPark.reference}`);
    renderPanel(currentPark);
  } catch (err) {
    showToast('Could not save activation', true);
  }
});

async function toggleWishlist(park) {
  const newVal = !park.wishlist;
  try {
    await api(`/api/parks/${park.reference}/wishlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wishlist: newVal }),
    });
    park.wishlist = newVal;
    document.getElementById('btn-wishlist').classList.toggle('active', newVal);
    // Update marker color and category
    if (markersByRef[park.reference]) {
      const marker = markersByRef[park.reference];
      marker.setIcon(makeIcon(markerColor(park)));
      markerCategoryByRef[park.reference] = parkCategory(park);
      Object.values(clusterGroups).forEach(g => { if (g.hasLayer(marker)) g.removeLayer(marker); });
      const cat = markerCategoryByRef[park.reference];
      if (activeFilters.has(cat)) clusterGroupFor(cat).addLayer(marker);
    }
  } catch (e) {
    showToast('Could not update wishlist', true);
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
let _searchDebounce = null;
const searchInput    = document.getElementById('search-input');
const searchDropdown = document.getElementById('search-dropdown');

searchInput.addEventListener('input', () => {
  clearTimeout(_searchDebounce);
  const q = searchInput.value.trim();
  if (!q) { searchDropdown.classList.add('hidden'); return; }
  _searchDebounce = setTimeout(() => runSearch(q), 300);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { searchDropdown.classList.add('hidden'); searchInput.blur(); }
});

document.addEventListener('click', e => {
  if (!e.target.closest('#search-wrapper')) searchDropdown.classList.add('hidden');
});

async function runSearch(q) {
  let results;
  try {
    results = await api(`/api/search?q=${encodeURIComponent(q)}`);
  } catch (e) {
    return;
  }

  searchDropdown.innerHTML = '';
  if (!results.length) {
    searchDropdown.innerHTML = '<div class="search-result" style="color:var(--text-dim)">No results</div>';
    searchDropdown.classList.remove('hidden');
    return;
  }

  results.forEach(park => {
    const item = document.createElement('div');
    item.className = 'search-result';
    item.innerHTML = `<div>${park.name || park.reference}</div><div class="ref">${park.reference}</div>`;
    item.addEventListener('click', () => selectSearchResult(park));
    searchDropdown.appendChild(item);
  });
  searchDropdown.classList.remove('hidden');
}

async function selectSearchResult(park) {
  searchDropdown.classList.add('hidden');
  searchInput.value = park.name || park.reference;

  // Fly map to park
  if (park.latitude && park.longitude) {
    map.setView([park.latitude, park.longitude], 13);
  }

  // Open panel (creates stub if needed)
  await onMarkerClick(park.reference, park);

  // Ensure a marker exists for this park
  if (!markersByRef[park.reference] && park.latitude && park.longitude) {
    localParkRefs.add(park.reference);
    addOrUpdateMarker(park);
  }
}

// ---------------------------------------------------------------------------
// Import CSV modal
// ---------------------------------------------------------------------------
document.getElementById('btn-import-csv').addEventListener('click', () => {
  document.getElementById('import-result').textContent = '';
  document.getElementById('import-file-input').value = '';
  document.getElementById('btn-import-cancel').textContent = 'Cancel';
  document.getElementById('modal-import').classList.remove('hidden');
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const resultEl = document.getElementById('import-result');
  const cancelBtn = document.getElementById('btn-import-cancel');
  resultEl.style.color = 'var(--green)';
  resultEl.innerHTML = '<span class="spinner"></span>Importing and fetching coordinates…';
  cancelBtn.disabled = true;

  const fd = new FormData();
  fd.append('file', file);

  try {
    const res = await fetch('/api/import/activations', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    resultEl.textContent = `Done — ${data.imported} parks imported, ${data.skipped} skipped.`;

    // Refresh markers with updated coordinates
    const parks = await api('/api/parks');
    parks.forEach(addOrUpdateMarker);

    // Swap Cancel → Done
    cancelBtn.textContent = 'Done';
    cancelBtn.disabled = false;
  } catch (err) {
    resultEl.style.color = 'var(--red)';
    resultEl.textContent = `Import failed: ${err.message}`;
    cancelBtn.disabled = false;
  }
});

document.getElementById('btn-import-cancel').addEventListener('click', () => {
  document.getElementById('modal-import').classList.add('hidden');
});

// ---------------------------------------------------------------------------
// Map right-click → add parking location
// ---------------------------------------------------------------------------
map.on('contextmenu', e => {
  document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
  if (!currentPark) return;

  const { x, y } = e.containerPoint;
  const mapEl = document.getElementById('map');
  const mapRect = mapEl.getBoundingClientRect();

  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = (mapRect.left + x) + 'px';
  menu.style.top  = (mapRect.top  + y) + 'px';
  menu.innerHTML = `<div class="ctx-menu-item" data-action="add-parking">Add parking here</div>`;
  document.body.appendChild(menu);

  menu.querySelector('[data-action=add-parking]').addEventListener('click', () => {
    menu.remove();
    // Find the parking add form and open it pre-filled with the clicked coords
    const formSection = document.querySelector('#parking-add-form');
    if (formSection && formSection._openParkingForm) {
      formSection._openParkingForm(e.latlng.lat, e.latlng.lng);
    } else if (formSection) {
      // Fallback: just fill the lat/lng fields and show
      formSection.classList.remove('hidden');
      const latEl = formSection.querySelector('#parking-lat');
      const lngEl = formSection.querySelector('#parking-lng');
      if (latEl) latEl.value = e.latlng.lat.toFixed(6);
      if (lngEl) lngEl.value = e.latlng.lng.toFixed(6);
      formSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });

  const dismiss = () => { menu.remove(); document.removeEventListener('click', dismiss); };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
});

// ---------------------------------------------------------------------------
// Dynamic POTA API markers on pan/zoom
// ---------------------------------------------------------------------------
let _allLocations = null;        // cached [{locationDesc, latitude, longitude}, ...]
const _fetchedLocations = new Set(); // location codes we've already fetched parks for
let _panDebounce = null;

// Pre-load all POTA locations once on startup (small payload, ~3700 entries)
async function loadPotaLocations() {
  try {
    _allLocations = await api('/api/pota/locations');
  } catch (e) {
    _allLocations = [];
    showToast('POTA API unavailable — showing local parks only', true, 4000);
  }
}

map.on('moveend', () => {
  clearTimeout(_panDebounce);
  _panDebounce = setTimeout(fetchApiMarkersForView, 500);
});

async function fetchApiMarkersForView() {
  if (!_allLocations || map.getZoom() < 7) return;

  const bounds = map.getBounds();
  const visibleLocations = _allLocations.filter(loc =>
    loc.latitude && loc.longitude &&
    bounds.contains([loc.latitude, loc.longitude])
  );

  for (const loc of visibleLocations) {
    const code = loc.locationDesc;
    if (!code || _fetchedLocations.has(code)) continue;
    _fetchedLocations.add(code);

    try {
      const parks = await api(`/api/pota/parks/location/${code}`);
      if (Array.isArray(parks)) parks.forEach(addApiMarker);
    } catch (e) {
      _fetchedLocations.delete(code); // allow retry on next pan
    }
  }
}

function addApiMarker(park) {
  if (!park.latitude || !park.longitude) return;
  if (localParkRefs.has(park.reference)) return;
  if (markersByRef[park.reference]) return;

  const marker = L.marker([park.latitude, park.longitude], {
    icon: makeIcon('blue'),
  });
  marker.on('click', () => onMarkerClick(park.reference, park));
  markersByRef[park.reference] = marker;
  markerCategoryByRef[park.reference] = 'unactivated';
  if (activeFilters.has('unactivated')) {
    clusterGroups.unactivated.addLayer(marker);
  }
}

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------
loadLocalMarkers();
loadPotaLocations();
