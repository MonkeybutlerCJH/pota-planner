/* POTA Planner — app.js */

// ---------------------------------------------------------------------------
// Map init
// ---------------------------------------------------------------------------
const map = L.map('map', { zoomControl: true }).setView([39.5, -98.35], 5);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  maxZoom: 19,
}).addTo(map);

const clusterGroup = L.markerClusterGroup({ chunkedLoading: true });
map.addLayer(clusterGroup);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentPark = null;          // full park object currently shown in panel
let localParkRefs = new Set();   // references we have in local DB
let markersByRef = {};           // ref -> L.Marker

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
  parks.forEach(addOrUpdateMarker);
}

function addOrUpdateMarker(park) {
  if (!park.latitude || !park.longitude) return;

  localParkRefs.add(park.reference);

  if (markersByRef[park.reference]) {
    markersByRef[park.reference].setIcon(makeIcon(markerColor(park)));
    return;
  }

  const marker = L.marker([park.latitude, park.longitude], {
    icon: makeIcon(markerColor(park)),
  });
  marker.on('click', () => onMarkerClick(park.reference, park));
  markersByRef[park.reference] = marker;
  clusterGroup.addLayer(marker);
}

// ---------------------------------------------------------------------------
// Marker click → open side panel
// ---------------------------------------------------------------------------
async function onMarkerClick(reference, parkData) {
  openPanel();
  setPanelLoading();

  let park = parkData;
  if (!localParkRefs.has(reference)) {
    // Blue marker — create stub from POTA data
    try {
      await api(`/api/parks/${reference}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
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
  renderPanel(park);
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
function openPanel() {
  document.getElementById('side-panel').classList.remove('hidden');
  map.invalidateSize();
}

function closePanel() {
  document.getElementById('side-panel').classList.add('hidden');
  currentPark = null;
  map.invalidateSize();
}

function setPanelLoading() {
  document.getElementById('panel-park-name').textContent = 'Loading…';
  document.getElementById('panel-reference').textContent = '';
  document.getElementById('panel-body').innerHTML = '<div style="padding:20px;color:var(--text-dim)"><span class="spinner"></span>Loading park data…</div>';
}

document.getElementById('panel-close').addEventListener('click', closePanel);

// ---------------------------------------------------------------------------
// Panel render — header + all sections
// ---------------------------------------------------------------------------
function renderPanel(park) {
  // --- Header ---
  document.getElementById('panel-park-name').textContent = park.name || park.reference;
  document.getElementById('panel-reference').textContent = park.reference;

  const potaLink = document.getElementById('panel-pota-link');
  potaLink.href = park.pota_url || `https://pota.app/#/park/${park.reference}`;

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

  // Cover photo
  if (cover) {
    const img = document.createElement('img');
    img.className = 'cover-photo';
    img.src = `/${cover.file_path}`;
    img.alt = cover.caption || 'Cover photo';
    img.addEventListener('click', () => openLightbox(`/${cover.file_path}`));
    sec.appendChild(img);
  }

  // Thumbnail strip
  if (photos.length) {
    const strip = document.createElement('div');
    strip.className = 'thumb-strip';
    photos.forEach(photo => {
      const img = document.createElement('img');
      img.className = 'thumb' + (photo.is_cover ? ' is-cover' : '');
      img.src = `/${photo.file_path}`;
      img.alt = photo.caption || '';
      img.title = photo.caption || '';
      img.addEventListener('click', () => openLightbox(`/${photo.file_path}`));
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
      try {
        await fetch(`/api/parks/${park.reference}/media`, { method: 'POST', body: fd });
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
    <div class="ctx-menu-item danger" data-action="delete">Delete</div>`;
  document.body.appendChild(menu);

  menu.querySelector('[data-action=cover]').addEventListener('click', async () => {
    menu.remove();
    await api(`/api/media/${photo.id}/cover`, { method: 'POST' });
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
  { key: 'parking_notes',  label: 'Parking',          placeholder: 'Lot size, surface, hours…' },
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
// Parking locations section
// ---------------------------------------------------------------------------
function renderParkingSection(park) {
  const sec = document.createElement('div');
  sec.className = 'panel-section';
  sec.innerHTML = '<h4>Parking Locations</h4>';

  const locs = park.parking_locations || [];
  if (locs.length) {
    locs.forEach(loc => {
      const item = document.createElement('div');
      item.className = 'parking-loc-item';
      const mapsUrl = `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`;
      item.innerHTML = `
        <span style="flex:1">${loc.description || `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`}</span>
        <a href="${mapsUrl}" target="_blank" rel="noopener">Google Maps ↗</a>`;
      sec.appendChild(item);
    });
  } else {
    sec.innerHTML += '<p style="color:var(--text-dim);font-size:12px">No parking locations added yet.</p>';
  }

  return sec;
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
    // Update marker color
    if (markersByRef[park.reference]) {
      markersByRef[park.reference].setIcon(makeIcon(markerColor(park)));
    }
  } catch (e) {
    showToast('Could not update wishlist', true);
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
    } catch (e) { /* silently ignore — POTA API may be unreachable */ }
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
  clusterGroup.addLayer(marker);
}

// ---------------------------------------------------------------------------
// Initial load
// ---------------------------------------------------------------------------
loadLocalMarkers();
loadPotaLocations();
