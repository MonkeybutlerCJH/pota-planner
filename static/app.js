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
// Panel render (header + stub body — expanded in later steps)
// ---------------------------------------------------------------------------
function renderPanel(park) {
  // Header
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

  const btnWishlist = document.getElementById('btn-wishlist');
  btnWishlist.classList.toggle('active', !!park.wishlist);
  btnWishlist.onclick = () => toggleWishlist(park);

  // Body placeholder — populated fully in steps 10-13
  document.getElementById('panel-body').innerHTML =
    `<div style="padding:20px;color:var(--text-dim);font-size:13px;">
       Park data loaded. Full panel coming soon.
     </div>`;
}

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
