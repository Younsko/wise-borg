/* ==========================================================================
   WARFRAME DEAL SNIPER - PREMIUM DIGITAL FRONTEND (VANILLA JS)
   ========================================================================== */

// Application State
const state = {
  items: [],              // All tradable items for manual scan autocomplete
  deals: [],              // Currently spotted deals from server
  seenDealIds: new Set(), // Set of deal IDs we've already notified about
  selectedItem: null,     // Currently selected item for manual scan
  filters: {
    discount: 20,
    profit: 10,
    text: '',
    rank: 'all',
    rarity: 'all',        // 'all' | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
    category: 'all'       // 'all' | 'prime' | 'arme' | 'warframe' | 'mod' | 'accessoire'
  },
  sort: 'discount',       // 'discount' | 'margin' | 'recency'
  soundEnabled: false,
  desktopNotificationsEnabled: false,
  isAutoRefreshEnabled: true,
  pollInterval: 10,       // dynamic auto-refresh interval in seconds
  countdownTimeLeft: 10,  // seconds remaining until next fetch
  countdownIntervalId: null
};

// Web Audio API Synthesizer for notifications
// Synthesizes a futuristic Orokin "ding/chime" sound directly in code (no external MP3 needed!)
function playNotificationSound(rarity) {
  if (!state.soundEnabled) return;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    
    const ctx = new AudioContext();
    
    // Create nodes
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gainNode = ctx.createGain();
    const filterNode = ctx.createBiquadFilter();

    osc1.connect(filterNode);
    osc2.connect(filterNode);
    filterNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    // Filter settings (futuristic feel)
    filterNode.type = 'lowpass';
    filterNode.frequency.setValueAtTime(1200, ctx.currentTime);

    // Rarity determines pitches & volume
    let baseFreq = 880; // A5
    let volume = 0.15;
    
    if (rarity === 'epic') {
      baseFreq = 1046.5; // C6
      volume = 0.25;
    } else if (rarity === 'legendary') {
      baseFreq = 1318.5; // E6
      volume = 0.35;
    }

    // Oscillator 1 (Main tone)
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(baseFreq, ctx.currentTime);
    osc1.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, ctx.currentTime + 0.15);

    // Oscillator 2 (Metallic harmonic ring)
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(baseFreq * 2.01, ctx.currentTime);
    osc2.frequency.exponentialRampToValueAtTime(baseFreq * 2.5, ctx.currentTime + 0.12);

    // Volume envelope (quick attack, decaying chime ring)
    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);

    // Start & Stop
    osc1.start(ctx.currentTime);
    osc2.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.8);
    osc2.stop(ctx.currentTime + 0.8);
  } catch (e) {
    console.error('Failed to play synthesized sound:', e);
  }
}

// DOM Elements Mapping
const el = {
  // Connection and Status
  scannerPulse: document.getElementById('scannerPulse'),
  scannerStatusLabel: document.getElementById('scannerStatusLabel'),
  statRequests: document.getElementById('statRequests'),
  statQueue: document.getElementById('statQueue'),
  statCache: document.getElementById('statCache'),
  statDealsFound: document.getElementById('statDealsFound'),

  // Autocomplete Search Panel (Sidebar)
  itemSearchInput: document.getElementById('itemSearchInput'),
  btnManualScan: document.getElementById('btnManualScan'),
  autocompleteDropdown: document.getElementById('autocompleteDropdown'),

  // Sidebar controls
  filterDiscount: document.getElementById('filterDiscount'),
  valDiscount: document.getElementById('valDiscount'),
  filterProfit: document.getElementById('filterProfit'),
  valProfit: document.getElementById('valProfit'),
  filterInterval: document.getElementById('filterInterval'),
  valInterval: document.getElementById('valInterval'),
  filterRank: document.getElementById('filterRank'),
  toggleAutoRefresh: document.getElementById('toggleAutoRefresh'),
  toggleSound: document.getElementById('toggleSound'),
  toggleDesktop: document.getElementById('toggleDesktop'),

  // Top header elements
  filterText: document.getElementById('filterText'),
  toggleDesktopHeader: document.getElementById('toggleDesktopHeader'),
  desktopAlertText: document.getElementById('desktopAlertText'),
  sortSelect: document.getElementById('sortSelect'),
  sidebarSortSelect: document.getElementById('sidebarSortSelect'),

  // Dynamic Content Grid Slots
  dealsGrid: document.getElementById('dealsGrid'),
  featuredDealSection: document.getElementById('featuredDealSection'),
  emptyState: document.getElementById('emptyState'),

  // General Reset and trigger buttons
  btnResetFilters: document.getElementById('btnResetFilters'),
  btnClearDeals: document.getElementById('btnClearDeals'),
  btnManualRefresh: document.getElementById('btnManualRefresh'),
  countdownTimer: document.getElementById('countdownTimer'),

  // Collapsible toggle filter
  toggleFiltersCollapse: document.getElementById('toggleFiltersCollapse'),
  filtersContainer: document.getElementById('filtersContainer')
};

// Start or adjust the active deal polling schedule dynamically via second countdowns
function startCountdownTimer() {
  if (state.countdownIntervalId) {
    clearInterval(state.countdownIntervalId);
  }
  
  state.countdownIntervalId = setInterval(() => {
    if (!state.isAutoRefreshEnabled) {
      if (el.countdownTimer) {
        el.countdownTimer.textContent = '--';
      }
      return;
    }
    
    state.countdownTimeLeft--;
    if (state.countdownTimeLeft <= 0) {
      state.countdownTimeLeft = state.pollInterval;
      pollDeals();
      pollStatus();
    }
    
    if (el.countdownTimer) {
      el.countdownTimer.textContent = state.countdownTimeLeft;
    }
  }, 1000);
}

// Initialize Application
async function init() {
  setupEventListeners();
  
  // Load settings from localStorage
  const savedSound = localStorage.getItem('wiseBorg_soundEnabled');
  if (savedSound !== null) {
    state.soundEnabled = savedSound === 'true';
    if (el.toggleSound) el.toggleSound.checked = state.soundEnabled;
  }
  
  const savedDesktop = localStorage.getItem('wiseBorg_desktopNotifications');
  if (savedDesktop !== null) {
    const isEnabled = savedDesktop === 'true';
    syncDesktopNotifications(isEnabled);
    
    // Auto-disable if permission was revoked
    if (isEnabled && typeof Notification !== 'undefined') {
      if (Notification.permission !== 'granted') {
        syncDesktopNotifications(false);
      }
    }
  }

  await fetchItemsList();
  
  // Load initial dataset
  pollStatus();
  pollDeals();
  startCountdownTimer();
}

// Fetch Autocomplete Items list from server
async function fetchItemsList() {
  try {
    const res = await fetch('/api/items');
    state.items = await res.json();
    console.log(`Initialized frontend search registry with ${state.items.length} items.`);
  } catch (err) {
    console.error('Failed to load items list:', err);
  }
}

// Sync desktop notification settings across both header and sidebar controls
function syncDesktopNotifications(checked) {
  state.desktopNotificationsEnabled = checked;
  if (el.toggleDesktop) el.toggleDesktop.checked = checked;
  if (el.toggleDesktopHeader) el.toggleDesktopHeader.checked = checked;
  if (el.desktopAlertText) {
    el.desktopAlertText.textContent = checked ? "Alertes Activées" : "Alertes Désactivées";
  }
  localStorage.setItem('wiseBorg_desktopNotifications', checked ? 'true' : 'false');
}

// Synchronize Sorting selection dropdowns
function syncSort(val) {
  state.sort = val;
  if (el.sidebarSortSelect) el.sidebarSortSelect.value = val;
  if (el.sortSelect) el.sortSelect.value = val;
  renderDeals();
}

// Setup Event Listeners
function setupEventListeners() {
  // Autocomplete Search input
  if (el.itemSearchInput) el.itemSearchInput.addEventListener('input', handleSearchInput);
  
  // Close autocomplete dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (el.itemSearchInput && !el.itemSearchInput.contains(e.target) && el.autocompleteDropdown && !el.autocompleteDropdown.contains(e.target)) {
      el.autocompleteDropdown.classList.add('dropdown-hidden');
    }
  });

  // Manual Scan Trigger
  if (el.btnManualScan) el.btnManualScan.addEventListener('click', triggerManualScan);
  
  // Filters sliders & text inputs
  if (el.filterDiscount) {
    el.filterDiscount.addEventListener('input', (e) => {
      state.filters.discount = parseInt(e.target.value);
      if (el.valDiscount) el.valDiscount.textContent = `${state.filters.discount}%`;
      renderDeals();
    });
  }

  if (el.filterProfit) {
    el.filterProfit.addEventListener('input', (e) => {
      state.filters.profit = parseInt(e.target.value);
      if (el.valProfit) el.valProfit.innerHTML = `${state.filters.profit} <span>plat</span>`;
      renderDeals();
    });
  }

  if (el.filterInterval) {
    el.filterInterval.addEventListener('input', (e) => {
      state.pollInterval = parseInt(e.target.value);
      if (el.valInterval) el.valInterval.textContent = `Toutes les ${state.pollInterval} secondes`;
    });

    el.filterInterval.addEventListener('change', (e) => {
      state.pollInterval = parseInt(e.target.value);
      state.countdownTimeLeft = state.pollInterval;
      startCountdownTimer();
      console.log(`[Polling] Adjusted auto refresh delay to ${state.pollInterval}s.`);
    });
  }

  if (el.filterText) {
    el.filterText.addEventListener('input', (e) => {
      state.filters.text = e.target.value.toLowerCase().trim();
      renderDeals();
    });
  }

  if (el.filterRank) {
    el.filterRank.addEventListener('change', (e) => {
      state.filters.rank = e.target.value;
      renderDeals();
    });
  }

  // Toggle Auto refresh switch
  if (el.toggleAutoRefresh) {
    el.toggleAutoRefresh.addEventListener('change', (e) => {
      state.isAutoRefreshEnabled = e.target.checked;
      state.countdownTimeLeft = state.pollInterval;
      console.log(`[Polling] Auto refresh state toggled to: ${state.isAutoRefreshEnabled}`);
    });
  }

  // Double-sync Sort selects
  if (el.sidebarSortSelect) {
    el.sidebarSortSelect.addEventListener('change', (e) => {
      syncSort(e.target.value);
    });
  }
  if (el.sortSelect) {
    el.sortSelect.addEventListener('change', (e) => {
      syncSort(e.target.value);
    });
  }

  // Rarity pills selection trigger
  const pillsGrid = document.getElementById('rarityPillsGrid');
  if (pillsGrid) {
    pillsGrid.querySelectorAll('.rarity-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        pillsGrid.querySelectorAll('.rarity-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.filters.rarity = pill.getAttribute('data-rarity');
        renderDeals();
      });
    });
  }

  // Categories filter tags row trigger
  const categoriesRow = document.getElementById('categoriesRow');
  if (categoriesRow) {
    categoriesRow.querySelectorAll('.category-tag').forEach(tag => {
      tag.addEventListener('click', () => {
        categoriesRow.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
        tag.classList.add('active');
        state.filters.category = tag.getAttribute('data-category');
        renderDeals();
      });
    });
  }

  // Reset Filters Button
  if (el.btnResetFilters) {
    el.btnResetFilters.addEventListener('click', () => {
      state.filters.discount = 20;
      state.filters.profit = 10;
      state.filters.text = '';
      state.filters.rank = 'all';
      state.filters.rarity = 'all';
      state.filters.category = 'all';
      
      // Update UI components
      if (el.filterDiscount) el.filterDiscount.value = 20;
      if (el.valDiscount) el.valDiscount.textContent = '20%';
      if (el.filterProfit) el.filterProfit.value = 10;
      if (el.valProfit) el.valProfit.innerHTML = '10 <span>plat</span>';
      if (el.filterRank) el.filterRank.value = 'all';
      if (el.filterText) el.filterText.value = '';
      
      // Reset active tags
      if (pillsGrid) {
        pillsGrid.querySelectorAll('.rarity-pill').forEach(p => p.classList.remove('active'));
        const defaultPill = pillsGrid.querySelector('[data-rarity="all"]');
        if (defaultPill) defaultPill.classList.add('active');
      }
      if (categoriesRow) {
        categoriesRow.querySelectorAll('.category-tag').forEach(t => t.classList.remove('active'));
        const defaultTag = categoriesRow.querySelector('[data-category="all"]');
        if (defaultTag) defaultTag.classList.add('active');
      }
      
      renderDeals();
    });
  }

  // Clear list button
  if (el.btnClearDeals) {
    el.btnClearDeals.addEventListener('click', async () => {
      try {
        await fetch('/api/clear-deals', { method: 'POST' });
        state.deals = [];
        state.seenDealIds.clear();
        renderDeals();
      } catch (e) {
        console.error(e);
      }
    });
  }

  // Manual Refresh Deals button click
  if (el.btnManualRefresh) {
    el.btnManualRefresh.addEventListener('click', async () => {
      el.btnManualRefresh.classList.add('refreshing');
      playNotificationSound('uncommon');
      
      try {
        await pollDeals();
        await pollStatus();
        state.countdownTimeLeft = state.pollInterval;
      } catch (err) {
        console.error('Manual refresh failed:', err);
      } finally {
        setTimeout(() => {
          el.btnManualRefresh.classList.remove('refreshing');
        }, 800);
      }
    });
  }

  // Toggle Sound Alert
  if (el.toggleSound) {
    el.toggleSound.addEventListener('change', (e) => {
      state.soundEnabled = e.target.checked;
      localStorage.setItem('wiseBorg_soundEnabled', state.soundEnabled);
    });
  }

  // Double-sync Desktop alerts
  const handleDesktopChange = async (e) => {
    const checked = e.target.checked;
    
    if (checked) {
      if (typeof Notification === 'undefined') {
        alert('Votre navigateur ne supporte pas les notifications de bureau.');
        syncDesktopNotifications(false);
        return;
      }
      
      if (!window.isSecureContext) {
        alert('Les notifications requièrent un contexte sécurisé (HTTPS ou http://localhost).');
      }

      const requestPerm = () => {
        return new Promise((resolve) => {
          try {
            const promise = Notification.requestPermission(resolve);
            if (promise && typeof promise.then === 'function') {
              promise.then(resolve);
            }
          } catch (err) {
            resolve(Notification.permission);
          }
        });
      };

      if (Notification.permission === 'granted') {
        syncDesktopNotifications(true);
        showTestNotification();
      } else if (Notification.permission === 'default') {
        const permission = await requestPerm();
        if (permission === 'granted') {
          syncDesktopNotifications(true);
          showTestNotification();
        } else {
          syncDesktopNotifications(false);
          alert(`Permissions de notification : ${permission}.`);
        }
      } else {
        syncDesktopNotifications(false);
        alert('Notifications bloquées dans les paramètres de votre navigateur. Veuillez réactiver les autorisations.');
      }
    } else {
      syncDesktopNotifications(false);
    }
  };

  if (el.toggleDesktop) el.toggleDesktop.addEventListener('change', handleDesktopChange);
  if (el.toggleDesktopHeader) el.toggleDesktopHeader.addEventListener('change', handleDesktopChange);

  // Sidebar collapsible filters
  if (el.toggleFiltersCollapse) {
    el.toggleFiltersCollapse.addEventListener('click', () => {
      if (el.filtersContainer) {
        el.filtersContainer.classList.toggle('dropdown-hidden');
      }
      const chevron = el.toggleFiltersCollapse.querySelector('.chevron');
      if (chevron) {
        chevron.style.transform = chevron.style.transform === 'rotate(180deg)' ? 'rotate(0deg)' : 'rotate(180deg)';
      }
    });
  }
}

// Handle text search input for item autocomplete
function handleSearchInput(e) {
  const query = e.target.value.toLowerCase().trim();
  state.selectedItem = null;

  if (query.length < 2) {
    el.autocompleteDropdown.classList.add('dropdown-hidden');
    return;
  }

  // Filter top 10 matches
  const matches = state.items
    .filter(item => item.name.toLowerCase().includes(query))
    .slice(0, 10);

  if (matches.length === 0) {
    el.autocompleteDropdown.classList.add('dropdown-hidden');
    return;
  }

  el.autocompleteDropdown.innerHTML = '';
  matches.forEach(item => {
    const div = document.createElement('div');
    div.className = 'autocomplete-item';
    div.textContent = item.name;
    div.addEventListener('click', () => {
      el.itemSearchInput.value = item.name;
      state.selectedItem = item;
      el.autocompleteDropdown.classList.add('dropdown-hidden');
    });
    el.autocompleteDropdown.appendChild(div);
  });

  el.autocompleteDropdown.classList.remove('dropdown-hidden');
}

// Trigger Manual high-priority scan
async function triggerManualScan() {
  let slug = '';
  
  if (state.selectedItem) {
    slug = state.selectedItem.slug;
  } else {
    // If no explicit autocomplete click, search for exact text match
    const typedText = el.itemSearchInput.value.toLowerCase().trim();
    const matched = state.items.find(item => item.name.toLowerCase() === typedText);
    if (matched) {
      slug = matched.slug;
    } else {
      alert('Veuillez sélectionner un item valide dans la liste déroulante.');
      return;
    }
  }

  try {
    el.btnManualScan.disabled = true;
    el.btnManualScan.querySelector('.btn-text').textContent = 'SCAN...';
    el.itemSearchInput.disabled = true;
    
    // Add pulsing scanner effect to search field
    el.itemSearchInput.style.borderColor = 'var(--orokin-gold)';
    el.itemSearchInput.style.boxShadow = '0 0 10px var(--orokin-gold-glow)';

    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug })
    });
    
    const data = await res.json();
    console.log(data.message);

    // Flash success
    setTimeout(() => {
      el.btnManualScan.disabled = false;
      el.btnManualScan.querySelector('.btn-text').textContent = 'SCAN';
      el.itemSearchInput.disabled = false;
      el.itemSearchInput.value = '';
      el.itemSearchInput.style.borderColor = '';
      el.itemSearchInput.style.boxShadow = '';
      state.selectedItem = null;
    }, 1500);

  } catch (err) {
    console.error('Manual scan failed:', err);
    el.btnManualScan.disabled = false;
    el.btnManualScan.querySelector('.btn-text').textContent = 'SCAN';
    el.itemSearchInput.disabled = false;
  }
}

// Poll Server Status
async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();

    // Update headers and statistics counters
    if (el.statRequests) el.statRequests.textContent = status.requestsMade;
    if (el.statQueue) el.statQueue.textContent = status.queueLength;
    if (el.statCache) el.statCache.textContent = status.cacheSize;
    if (el.statDealsFound) el.statDealsFound.textContent = status.dealsFoundCount;

    // Rate Limit active banner changes
    if (status.rateLimited) {
      if (el.scannerPulse) el.scannerPulse.className = 'status-card-dot rate-limited';
      const sLeft = Math.ceil(status.cooldownMsLeft / 1000);
      if (el.scannerStatusLabel) {
        el.scannerStatusLabel.textContent = `PAUSE API (${sLeft}s)`;
        el.scannerStatusLabel.style.color = 'var(--danger-red)';
      }
    } else if (status.queueLength > 0) {
      if (el.scannerPulse) el.scannerPulse.className = 'status-card-dot syncing';
      if (el.scannerStatusLabel) {
        el.scannerStatusLabel.textContent = `SCAN EN COURS (${status.queueLength})`;
        el.scannerStatusLabel.style.color = '#ff9800';
      }
    } else {
      if (el.scannerPulse) el.scannerPulse.className = 'status-card-dot';
      if (el.scannerStatusLabel) {
        el.scannerStatusLabel.textContent = `ACTIF // À JOUR`;
        el.scannerStatusLabel.style.color = 'var(--tenno-teal)';
      }
    }
  } catch (e) {
    if (el.scannerPulse) el.scannerPulse.className = 'status-card-dot rate-limited';
    if (el.scannerStatusLabel) {
      el.scannerStatusLabel.textContent = 'ERREUR RESEAU';
      el.scannerStatusLabel.style.color = 'var(--danger-red)';
    }
  }
}

// Check if a deal matches the current user filters/settings
function matchesFilters(deal) {
  const passDiscount = deal.discount >= state.filters.discount;
  const passProfit = deal.margin >= state.filters.profit;
  
  const searchStr = state.filters.text;
  const passText = searchStr === '' || 
                   deal.name.toLowerCase().includes(searchStr) || 
                   (deal.variantName && deal.variantName.toLowerCase().includes(searchStr)) ||
                   (deal.user.ingameName && deal.user.ingameName.toLowerCase().includes(searchStr));
                   
  let passRank = true;
  if (deal.rank !== undefined && deal.rank !== null) {
    if (state.filters.rank === 'rank0') {
      passRank = deal.rank === 0;
    } else if (state.filters.rank === 'maxed') {
      const isMaxed = deal.maxRank > 0 ? (deal.rank === deal.maxRank) : [3, 5, 8, 10].includes(deal.rank);
      passRank = isMaxed;
    }
  }

  // Pill rarity check
  let passRarity = true;
  if (state.filters.rarity && state.filters.rarity !== 'all') {
    const dealRarity = getDealRarity(deal.discount);
    passRarity = dealRarity === state.filters.rarity;
  }

  // Category tags filter
  let passCategory = true;
  if (state.filters.category && state.filters.category !== 'all') {
    const nameLower = deal.name.toLowerCase();
    if (state.filters.category === 'prime') {
      passCategory = nameLower.includes('prime');
    } else if (state.filters.category === 'arme') {
      passCategory = nameLower.includes('vandal') || nameLower.includes('wraith') || nameLower.includes('prisma') || nameLower.includes('mara') || nameLower.includes('kuva') || nameLower.includes('tenet') || nameLower.includes('cobra') || nameLower.includes('velocitus') || nameLower.includes('lecta') || nameLower.includes('silva') || nameLower.includes('ankyr') || nameLower.includes('boeg') || nameLower.includes('bo ') || nameLower.includes('boltor') || nameLower.includes('burston') || nameLower.includes('cernos') || nameLower.includes('dakra') || nameLower.includes('fang') || nameLower.includes('glaive') || nameLower.includes('hikou') || nameLower.includes('karr') || nameLower.includes('knell') || nameLower.includes('latron') || nameLower.includes('lex') || nameLower.includes('marelok') || nameLower.includes('nikana') || nameLower.includes('orthos') || nameLower.includes('paris') || nameLower.includes('pyrana') || nameLower.includes('reaper') || nameLower.includes('scindo') || nameLower.includes('sicarus') || nameLower.includes('soma') || nameLower.includes('spira') || nameLower.includes('sybaris') || nameLower.includes('tiberon') || nameLower.includes('tigris') || nameLower.includes('vasto') || nameLower.includes('vectis') || nameLower.includes('cestra') || nameLower.includes('akboltor') || nameLower.includes('akbronco') || nameLower.includes('aklex') || nameLower.includes('akstiletto') || nameLower.includes('akvasto') || nameLower.includes('braton') || nameLower.includes('bronco') || nameLower.includes('destreza') || nameLower.includes('dual kamas') || nameLower.includes('euphona') || nameLower.includes('fragor') || nameLower.includes('galatine') || nameLower.includes('helios') || nameLower.includes('karyst') || nameLower.includes('kronen') || nameLower.includes('nami skyla') || nameLower.includes('nikondi') || nameLower.includes('panthera') || nameLower.includes('rubico') || nameLower.includes('sarpa') || nameLower.includes('spared') || nameLower.includes('stradavar') || nameLower.includes('tatsu') || nameLower.includes('tekko') || nameLower.includes('venka') || nameLower.includes('zakti') || nameLower.includes('zhuge');
    } else if (state.filters.category === 'warframe') {
      passCategory = (nameLower.includes('chassis') || nameLower.includes('systèmes') || nameLower.includes('neuroptiques') || nameLower.includes('systems') || nameLower.includes('neuroptics') || nameLower.includes('blueprint') || nameLower.includes('schéma')) &&
        (nameLower.includes('ash') || nameLower.includes('atlas') || nameLower.includes('banshee') || nameLower.includes('chroma') || nameLower.includes('ember') || nameLower.includes('equinox') || nameLower.includes('frost') || nameLower.includes('gara') || nameLower.includes('harrow') || nameLower.includes('hydroid') || nameLower.includes('inaros') || nameLower.includes('ivara') || nameLower.includes('khora') || nameLower.includes('limbo') || nameLower.includes('loki') || nameLower.includes('mag') || nameLower.includes('mesa') || nameLower.includes('mirage') || nameLower.includes('nekros') || nameLower.includes('nezha') || nameLower.includes('nidus') || nameLower.includes('nova') || nameLower.includes('nyx') || nameLower.includes('oberon') || nameLower.includes('octavia') || nameLower.includes('protea') || nameLower.includes('revenant') || nameLower.includes('rhino') || nameLower.includes('saryn') || nameLower.includes('titania') || nameLower.includes('trinity') || nameLower.includes('valkyr') || nameLower.includes('vauban') || nameLower.includes('volt') || nameLower.includes('wisp') || nameLower.includes('wukong') || nameLower.includes('xaku') || nameLower.includes('zephyr'));
    } else if (state.filters.category === 'mod') {
      passCategory = deal.subtype === 'mod' || nameLower.includes('rank') || nameLower.includes('rivens') || nameLower.includes('primé') || nameLower.includes('galvanisé') || nameLower.includes('transmuté');
    } else if (state.filters.category === 'accessoire') {
      passCategory = deal.subtype === 'arcane' || nameLower.includes('arcane') || nameLower.includes('empreinte') || nameLower.includes('imprint') || nameLower.includes('relic') || nameLower.includes('relique') || nameLower.includes('lentille') || nameLower.includes('lens');
    }
  }
                   
  return passDiscount && passProfit && passText && passRank && passRarity && passCategory;
}

// Show a browser/desktop notification for a newly spotted deal
function showDesktopNotification(deal) {
  if (!state.desktopNotificationsEnabled) return;
  if (typeof Notification === 'undefined') return;
  
  if (Notification.permission === 'granted') {
    const fullTitle = getItemFullTitle(deal);
    const rarity = getDealRarity(deal.discount).toUpperCase();
    const title = `🚨 [${rarity} DEAL] ${fullTitle}`;
    
    const body = `Prix: ${deal.price} Plat (Marché: ${deal.typicalPrice} Plat)\nBénéfice: +${deal.margin} Plat (-${deal.discount}%)\nVendeur: ${deal.user.ingameName} (${deal.user.reputation} ★)`;
    
    const imageUrl = deal.thumb 
      ? `https://warframe.market/static/assets/${deal.thumb}` 
      : 'https://warframe.market/static/assets/items/images/en/thumbs/general_item.png';
      
    try {
      const notification = new Notification(title, {
        body: body,
        icon: imageUrl,
        tag: deal.id, // prevents duplicates of same deal ID
        requireInteraction: false
      });
      
      notification.onclick = function(event) {
        event.preventDefault();
        
        // Auto-copy the trade whisper to the clipboard
        if (deal.copyWhisper) {
          navigator.clipboard.writeText(deal.copyWhisper).catch(err => {
            console.error('Failed to auto-copy whisper from notification click:', err);
          });
        }
        
        window.open(`https://warframe.market/items/${deal.slug}`, '_blank');
        notification.close();
      };
    } catch (e) {
      console.error('Failed to trigger desktop notification:', e);
    }
  }
}

// Show a simple test notification to confirm setup
function showTestNotification() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  
  try {
    const notification = new Notification("🤖 WISE BORG // Deal Sniper", {
      body: "Les alertes de bureau sont activées ! Vous serez notifié pour les opportunités correspondant à vos filtres.",
      icon: 'https://warframe.market/static/assets/items/images/en/thumbs/general_item.png',
      requireInteraction: false
    });
  } catch (e) {
    console.error('Failed to trigger test notification:', e);
  }
}

// Poll Deals
async function pollDeals() {
  try {
    const res = await fetch('/api/deals');
    const incomingDeals = await res.json();
    
    // Check if there are any brand new deals to alert about
    incomingDeals.forEach(deal => {
      if (!state.seenDealIds.has(deal.id)) {
        state.seenDealIds.add(deal.id);
        
        // Alert the user only if it matches their active control settings/filters
        if (matchesFilters(deal)) {
          const rarity = getDealRarity(deal.discount);
          
          // Sound chime
          if (rarity === 'rare' || rarity === 'epic' || rarity === 'legendary') {
            playNotificationSound(rarity);
          }
          
          // Desktop alert
          showDesktopNotification(deal);
        }
      }
    });

    state.deals = incomingDeals;
    renderDeals();
  } catch (err) {
    console.error('Failed to poll deals:', err);
  }
}

// Determine Deal Rarity Grade based on discount percentage
function getDealRarity(discount) {
  if (discount >= 60) return 'legendary';
  if (discount >= 40) return 'epic';
  if (discount >= 25) return 'rare';
  if (discount >= 15) return 'uncommon';
  return 'common';
}

// Build a clean, prominent variant/rank details string for the item title
function getItemFullTitle(deal) {
  let title = deal.name;
  if (deal.rank !== undefined && deal.rank !== null) {
    title += ` (RANK ${deal.rank})`;
  } else if (deal.subtype) {
    title += ` (${deal.subtype.toUpperCase()})`;
  } else if (deal.amberStars !== undefined && deal.amberStars !== null) {
    title += ` (${deal.amberStars}A/${deal.cyanStars}C)`;
  }
  return title;
}

// Render filtered and sorted deal cards with dynamic Spotlight featured top-card
function renderDeals() {
  // 1. Filter local list based on state controls
  const filtered = state.deals.filter(matchesFilters);

  // 2. Sort the filtered array
  filtered.sort((a, b) => {
    if (state.sort === 'discount') {
      if (b.discount !== a.discount) return b.discount - a.discount;
      return b.margin - a.margin; // tie-breaker
    } else if (state.sort === 'margin') {
      if (b.margin !== a.margin) return b.margin - a.margin;
      return b.discount - a.discount; // tie-breaker
    } else if (state.sort === 'recency') {
      return b.spottedAt - a.spottedAt;
    }
    return 0;
  });

  if (filtered.length === 0) {
    // Hide featured container and show full empty state
    if (el.featuredDealSection) el.featuredDealSection.style.display = 'none';
    el.emptyState.style.display = 'flex';
    
    // Wipe deals list grid clean
    const existingCards = el.dealsGrid.querySelectorAll('.compact-deal-card');
    existingCards.forEach(c => c.remove());
    return;
  }

  el.emptyState.style.display = 'none';

  // 3. Render Spotlight (featured #1 item in list)
  const featuredDeal = filtered[0];
  renderFeaturedDeal(featuredDeal);

  // 4. Render Grid items (all subsequent items: index 1 and onwards)
  const gridDeals = filtered.slice(1);
  renderGridDeals(gridDeals);
}

// Render the featured spotlight top card
function renderFeaturedDeal(deal) {
  const rarity = getDealRarity(deal.discount);
  const imageUrl = deal.thumb 
    ? `https://warframe.market/static/assets/${deal.thumb}` 
    : 'https://warframe.market/static/assets/items/images/en/thumbs/general_item.png';
  const fullTitle = getItemFullTitle(deal);
  const timeAgo = formatTimeAgo(deal.spottedAt);
  
  // Decide badge label title based on sort selection
  let badgeLabel = "⭐ MEILLEURE AFFAIRE";
  if (state.sort === 'recency') {
    badgeLabel = "⭐ OFFRE RÉCENTE";
  } else if (state.sort === 'margin') {
    badgeLabel = "⭐ PLUS GROS PROFIT";
  }
  
  const cardHtml = `
    <div class="featured-deal-card card-${rarity} sort-${state.sort}" data-id="${deal.id}">
      <span class="featured-badge-tag">${badgeLabel}</span>
      <div class="featured-card-layout">
        <!-- Showcase Image -->
        <div class="featured-left-image">
          <img class="featured-item-thumb" src="${imageUrl}" alt="${deal.name}" onerror="this.src='https://warframe.market/static/assets/items/images/en/thumbs/general_item.png'">
        </div>
        
        <!-- Showcase details columns -->
        <div class="featured-details">
          <div class="featured-top-metadata">
            <span class="featured-rarity-badge badge-${rarity}">${rarity.toUpperCase()} DEAL</span>
            ${deal.reqMasteryRank ? `<span class="compact-badge-mr">MR ${deal.reqMasteryRank}</span>` : ''}
            <span class="featured-spotted-time">${timeAgo}</span>
          </div>
          
          <h1 class="featured-title">${fullTitle}</h1>
          
          <div class="featured-seller-row">
            <span class="seller-dot"></span>
            <span class="seller-txt">Vendeur: <strong>${deal.user.ingameName}</strong></span>
            <span class="seller-reputation-gold">&#9733; ${deal.user.reputation}</span>
          </div>
          
          <!-- Key stats row -->
          <div class="featured-stats-row">
            <div class="featured-stat-box">
              <span class="feat-lbl">Remise</span>
              <span class="feat-val discount">-${deal.discount}%</span>
            </div>
            
            <div class="featured-stat-box">
              <span class="feat-lbl">Prix d'Achat</span>
              <span class="feat-val">${deal.price} <span class="plat-suffix">plat</span></span>
            </div>
            
            <div class="featured-stat-box">
              <span class="feat-lbl">Prix du Marché</span>
              <span class="feat-val">${deal.typicalPrice} <span class="plat-suffix">plat</span></span>
            </div>
            
            <div class="featured-stat-box">
              <span class="feat-lbl">Profit Estimé</span>
              <span class="feat-val profit">+${deal.margin} <span class="plat-suffix">plat</span></span>
            </div>
          </div>
          
          <!-- Fusion stars arcane guides -->
          ${deal.amberStars !== undefined ? `
            <div class="fusion-tip text-gold">
              Note: Étoiles d'Ambre: ${deal.amberStars} | Étoiles de Cyan: ${deal.cyanStars}
            </div>
          ` : ''}
        </div>
        
        <!-- Action Buttons -->
        <div class="featured-actions">
          <button class="btn-feat-primary btn-whisper-copy" data-whisper="${deal.copyWhisper.replace(/"/g, '&quot;')}">
            📋 COPIER LE WHISPER
          </button>
          <a class="btn-feat-secondary" href="https://warframe.market/items/${deal.slug}" target="_blank" rel="noopener">
            Voir la fiche item
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
          </a>
        </div>
      </div>
    </div>
  `;
  
  el.featuredDealSection.innerHTML = cardHtml;
  el.featuredDealSection.style.display = 'block';
  
  // Bind click elements
  const featuredCard = el.featuredDealSection.querySelector('.featured-deal-card');
  const whisperBtn = featuredCard.querySelector('.btn-whisper-copy');
  
  if (whisperBtn) {
    whisperBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const whisperText = whisperBtn.getAttribute('data-whisper');
      copyWhisper(event, whisperText, whisperBtn);
    });
  }
  
  // Card click auto-copies whisper and opens browser tab
  featuredCard.addEventListener('click', (event) => {
    if (event.target.closest('.btn-whisper-copy') || event.target.closest('.btn-feat-secondary')) return;
    const whisperText = whisperBtn.getAttribute('data-whisper');
    copyWhisper(null, whisperText, whisperBtn);
    window.open(`https://warframe.market/items/${deal.slug}`, '_blank', 'noopener');
  });
}

// Render Secondary deals grid with DOM Reconciliation
function renderGridDeals(dealsList) {
  const existingCards = el.dealsGrid.querySelectorAll('.compact-deal-card');
  const existingCardMap = new Map();
  existingCards.forEach(card => {
    const id = card.getAttribute('data-id');
    if (id) existingCardMap.set(id, card);
  });
  
  // Remove old grid elements
  existingCardMap.forEach((card, id) => {
    const found = dealsList.some(d => d.id === id);
    if (!found) card.remove();
  });
  
  dealsList.forEach(deal => {
    const rarity = getDealRarity(deal.discount);
    const imageUrl = deal.thumb 
      ? `https://warframe.market/static/assets/${deal.thumb}` 
      : 'https://warframe.market/static/assets/items/images/en/thumbs/general_item.png';
    const timeAgo = formatTimeAgo(deal.spottedAt);
    
    let card = existingCardMap.get(deal.id);
    if (card) {
      existingCardMap.delete(deal.id);
      
      // Update values in-place
      const timeEl = card.querySelector('.card-spotted-ago');
      if (timeEl) timeEl.textContent = timeAgo;
      
      const venteEl = card.querySelector('.c-val.vente');
      if (venteEl) venteEl.textContent = `${deal.price} plat`;
      
      const marketEl = card.querySelector('.c-val.marche');
      if (marketEl) marketEl.textContent = `${deal.typicalPrice} plat`;
      
      const marginEl = card.querySelector('.c-val.benefice');
      if (marginEl) marginEl.textContent = `+${deal.margin} plat`;
      
      const whisperBtn = card.querySelector('.btn-compact-copy');
      if (whisperBtn) {
        whisperBtn.setAttribute('data-whisper', deal.copyWhisper);
      }
      
      // Keep sorted order correctly aligned
      el.dealsGrid.appendChild(card);
    } else {
      card = document.createElement('div');
      card.className = `compact-deal-card card-${rarity}`;
      card.setAttribute('data-id', deal.id);
      
      card.innerHTML = `
        <div class="card-top-row">
          <span class="card-discount-tag">-${deal.discount}%</span>
          <span class="card-rarity-pill ${rarity}">${rarity}</span>
          <span class="card-spotted-ago">${timeAgo}</span>
        </div>
        
        <div class="card-image-box">
          <img src="${imageUrl}" alt="${deal.name}" onerror="this.src='https://warframe.market/static/assets/items/images/en/thumbs/general_item.png'">
        </div>
        
        <div class="card-title-group">
          <h3 class="card-item-name" title="${deal.name}">${deal.name}</h3>
          <span class="card-rank-details">
            ${deal.rank !== undefined && deal.rank !== null ? `Rank ${deal.rank}` : (deal.subtype ? deal.subtype : 'Objet')}
            ${deal.reqMasteryRank ? `&bull; <span class="compact-badge-mr">MR ${deal.reqMasteryRank}</span>` : ''}
          </span>
        </div>
        
        <div class="card-seller-tag">
          <span class="card-seller-dot"></span>
          <span class="card-seller-name" title="${deal.user.ingameName}">${deal.user.ingameName}</span>
          <span class="card-seller-rep">&#9733; ${deal.user.reputation}</span>
        </div>
        
        <div class="card-prices-grid">
          <div class="c-price-box">
            <span class="c-lbl">Achat</span>
            <span class="c-val vente">${deal.price} plat</span>
          </div>
          <div class="c-price-box">
            <span class="c-lbl">Marché</span>
            <span class="c-val marche">${deal.typicalPrice} plat</span>
          </div>
          <div class="c-price-box">
            <span class="c-lbl">Profit</span>
            <span class="c-val benefice">+${deal.margin} plat</span>
          </div>
        </div>
        
        <button class="btn-compact-copy" data-whisper="${deal.copyWhisper.replace(/"/g, '&quot;')}">
          Copier whisper
        </button>
      `;
      
      const whisperBtn = card.querySelector('.btn-compact-copy');
      if (whisperBtn) {
        whisperBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const whisperText = whisperBtn.getAttribute('data-whisper');
          copyWhisper(event, whisperText, whisperBtn);
        });
      }
      
      card.addEventListener('click', (event) => {
        if (event.target.closest('.btn-compact-copy')) return;
        const whisperText = whisperBtn.getAttribute('data-whisper');
        copyWhisper(null, whisperText, whisperBtn);
        window.open(`https://warframe.market/items/${deal.slug}`, '_blank', 'noopener');
      });
      
      el.dealsGrid.appendChild(card);
    }
  });
}

// Format relative spotted timestamps
function formatTimeAgo(timestamp) {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 10) return "À l'instant";
  if (diffSec < 60) return `Il y a ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  return `Il y a ${diffMin}m`;
}

// Copy trade whisper command to system clipboard & provide feedback
async function copyWhisper(event, whisperText, button) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  try {
    await navigator.clipboard.writeText(whisperText);
    
    // Add success transition classes
    button.classList.add('copied');
    const originalText = button.textContent;
    button.textContent = '📋 WHISPER COPIÉ !';

    // Play visual flash
    setTimeout(() => {
      button.classList.remove('copied');
      button.textContent = originalText;
    }, 1800);

  } catch (err) {
    console.error('Clipboard copy failed:', err);
    window.prompt("Copiez le whisper manuellement:", whisperText);
  }
}

// Load application
window.addEventListener('DOMContentLoaded', init);
