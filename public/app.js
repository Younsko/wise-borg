/* ==========================================================================
   WARDEALS - Warframe Sniper Premium Frontend Logic (Vanilla JS)
   ========================================================================== */

// Application State
const state = {
  items: [],              // All tradable items for manual autocomplete
  deals: [],              // Currently spotted deals from server
  seenDealIds: new Set(), // Set of deal IDs we've already notified about
  selectedItem: null,     // Currently selected item for manual scan
  watchlist: JSON.parse(localStorage.getItem('wardeals_watchlist') || '[]'), // Watchlist objects: [ { name, slug } ]
  filters: {
    discount: 10,
    profit: 2,
    text: '',
    rank: 'all',
    rarity: 'all',        // 'all' | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
    category: 'all',      // 'all' | 'prime' | 'arme' | 'warframe' | 'mod' | 'accessoire'
    sellerName: '',
    masquerVus: false
  },
  sort: 'recency',        // default to 'recency' for nouveaux
  soundEnabled: true,
  desktopNotificationsEnabled: true,
  isAutoRefreshEnabled: true,
  pollInterval: 10,       // dynamic auto-refresh interval in seconds
  countdownTimeLeft: 10,  // seconds remaining until next fetch
  countdownIntervalId: null
};

// Web Audio API Synthesizer for notifications (Metallic futuristic sound)
function playNotificationSound(rarity) {
  if (!state.soundEnabled) return;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    
    const ctx = new AudioContext();
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gainNode = ctx.createGain();
    const filterNode = ctx.createBiquadFilter();

    osc1.connect(filterNode);
    osc2.connect(filterNode);
    filterNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    filterNode.type = 'lowpass';
    filterNode.frequency.setValueAtTime(1400, ctx.currentTime);

    let baseFreq = 880; 
    let volume = 0.15;
    
    if (rarity === 'epic') {
      baseFreq = 1046.5; 
      volume = 0.22;
    } else if (rarity === 'legendary') {
      baseFreq = 1318.5; 
      volume = 0.32;
    }

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(baseFreq, ctx.currentTime);
    osc1.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, ctx.currentTime + 0.15);

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(baseFreq * 2.01, ctx.currentTime);
    osc2.frequency.exponentialRampToValueAtTime(baseFreq * 2.5, ctx.currentTime + 0.12);

    gainNode.gain.setValueAtTime(0, ctx.currentTime);
    gainNode.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);

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
  // Connection and Status (Top Header Metrics Bar)
  statRequests: document.getElementById('statRequests'),
  statDealsFound: document.getElementById('statDealsFound'),
  statAvgProfit: document.getElementById('statAvgProfit'),
  statPotentialGain: document.getElementById('statPotentialGain'),

  // Autocomplete Search Panel (Sidebar)
  itemSearchInput: document.getElementById('itemSearchInput'),
  btnManualScan: document.getElementById('btnManualScan'),
  autocompleteDropdown: document.getElementById('autocompleteDropdown'),

  // Sidebar Controls
  filterDiscount: document.getElementById('filterDiscount'),
  valDiscount: document.getElementById('valDiscount'),
  filterProfit: document.getElementById('filterProfit'),
  valProfit: document.getElementById('valProfit'),
  filterInterval: document.getElementById('filterInterval'),
  valInterval: document.getElementById('valInterval'),
  filterRank: document.getElementById('filterRank'),
  toggleAutoRefresh: document.getElementById('toggleAutoRefresh'),
  toggleMasquerVus: document.getElementById('toggleMasquerVus'),
  sellerSearchInput: document.getElementById('sellerSearchInput'),

  // Moved Sidebar Audio Toggles
  toggleSound: document.getElementById('toggleSound'),
  toggleDesktop: document.getElementById('toggleDesktop'),

  // Search Sync
  filterText: document.getElementById('filterText'),
  liveSearchInput: document.getElementById('liveSearchInput'),

  // Preset Navigation
  presetTabs: document.getElementById('presetTabs'),
  sortSelect: document.getElementById('sortSelect'),

  // Dynamic Content Containers
  dealsGrid: document.getElementById('dealsGrid'),
  featuredDealsContainer: document.getElementById('featuredDealsContainer'),
  featuredTitle: document.getElementById('featuredTitle'),
  featuredDesc: document.getElementById('featuredDesc'),
  emptyState: document.getElementById('emptyState'),

  // Footer bar metadata
  lastUpdatedLabel: document.getElementById('lastUpdatedLabel'),

  // Reset and Triggers
  btnResetFilters: document.getElementById('btnResetFilters'),
  btnClearDeals: document.getElementById('btnClearDeals'),
  btnManualRefresh: document.getElementById('btnManualRefresh')
};

// Start or adjust the active deal polling schedule dynamically
function startCountdownTimer() {
  if (state.countdownIntervalId) {
    clearInterval(state.countdownIntervalId);
  }
  
  state.countdownIntervalId = setInterval(() => {
    if (!state.isAutoRefreshEnabled) return;
    
    state.countdownTimeLeft--;
    if (state.countdownTimeLeft <= 0) {
      state.countdownTimeLeft = state.pollInterval;
      pollDeals();
      pollStatus();
    }
  }, 1000);
}

// Initialize Application
async function init() {
  setupEventListeners();
  setupWatchlistAndTheme();
  
  // Load settings from localStorage
  const savedSound = localStorage.getItem('wardeals_soundEnabled');
  if (savedSound !== null) {
    state.soundEnabled = savedSound === 'true';
    if (el.toggleSound) el.toggleSound.checked = state.soundEnabled;
  }
  
  const savedDesktop = localStorage.getItem('wardeals_desktopNotifications');
  if (savedDesktop !== null) {
    const isEnabled = savedDesktop === 'true';
    state.desktopNotificationsEnabled = isEnabled;
    if (el.toggleDesktop) el.toggleDesktop.checked = isEnabled;
  }

  await fetchItemsList();
  
  // Load initial dataset
  pollStatus();
  pollDeals();
  startCountdownTimer();

  // Keyboard shortcut Ctrl+K focus search
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (el.liveSearchInput) el.liveSearchInput.focus();
    }
  });

  // Dynamic status updates
  setInterval(() => {
    if (el.lastUpdatedLabel) {
      const randSec = Math.floor(Math.random() * 3) + 1;
      el.lastUpdatedLabel.textContent = `il y a ${randSec} s`;
    }
  }, 3000);
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

// Synchronize Sorting selection dropdowns and presets
function syncSort(val) {
  state.sort = val;
  if (el.sortSelect) el.sortSelect.value = val;
  
  // Sync active presets tab styles
  if (el.presetTabs) {
    el.presetTabs.querySelectorAll('.preset-tab').forEach(tab => {
      const tabType = tab.getAttribute('data-tab');
      if (tabType === val) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });
  }

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
  
  // Double-synchronized Search inputs
  if (el.liveSearchInput) {
    el.liveSearchInput.addEventListener('input', (e) => {
      state.filters.text = e.target.value.toLowerCase().trim();
      if (el.filterText) el.filterText.value = e.target.value;
      renderDeals();
    });
  }
  if (el.filterText) {
    el.filterText.addEventListener('input', (e) => {
      state.filters.text = e.target.value.toLowerCase().trim();
      if (el.liveSearchInput) el.liveSearchInput.value = e.target.value;
      renderDeals();
    });
  }

  // Sliders
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
      if (el.valProfit) el.valProfit.textContent = `${state.filters.profit}`;
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
    });
  }

  // Double-sync Sort selects
  if (el.sortSelect) {
    el.sortSelect.addEventListener('change', (e) => {
      syncSort(e.target.value);
    });
  }

  // Quick Navigation Presets tabs
  if (el.presetTabs) {
    el.presetTabs.querySelectorAll('.preset-tab').forEach(tab => {
      const tabType = tab.getAttribute('data-tab');
      if (tabType) {
        tab.addEventListener('click', () => {
          syncSort(tabType);
        });
      }
    });
  }

  // Circular letter rarity filter grid triggers
  const pillsGrid = document.getElementById('rarityPillsGrid');
  if (pillsGrid) {
    pillsGrid.querySelectorAll('.rarity-letter').forEach(pill => {
      pill.addEventListener('click', () => {
        pillsGrid.querySelectorAll('.rarity-letter').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.filters.rarity = pill.getAttribute('data-rarity');
        renderDeals();
      });
    });
  }

  // Nom de vendeur filter
  if (el.sellerSearchInput) {
    el.sellerSearchInput.addEventListener('input', (e) => {
      state.filters.sellerName = e.target.value.toLowerCase().trim();
      renderDeals();
    });
  }

  // Masquer deja vus checkbox trigger
  if (el.toggleMasquerVus) {
    el.toggleMasquerVus.addEventListener('change', (e) => {
      state.filters.masquerVus = e.target.checked;
      renderDeals();
    });
  }

  // Reset Filters Button
  if (el.btnResetFilters) {
    el.btnResetFilters.addEventListener('click', () => {
      state.filters.discount = 10;
      state.filters.profit = 2;
      state.filters.text = '';
      state.filters.rank = 'all';
      state.filters.rarity = 'all';
      state.filters.sellerName = '';
      state.filters.masquerVus = false;
      
      // Update UI components
      if (el.filterDiscount) el.filterDiscount.value = 10;
      if (el.valDiscount) el.valDiscount.textContent = '10%';
      if (el.filterProfit) el.filterProfit.value = 2;
      if (el.valProfit) el.valProfit.textContent = '2';
      if (el.filterRank) el.filterRank.value = 'all';
      if (el.filterText) el.filterText.value = '';
      if (el.liveSearchInput) el.liveSearchInput.value = '';
      if (el.sellerSearchInput) el.sellerSearchInput.value = '';
      if (el.toggleMasquerVus) el.toggleMasquerVus.checked = false;
      
      // Reset active buttons
      if (pillsGrid) {
        pillsGrid.querySelectorAll('.rarity-letter').forEach(p => p.classList.remove('active'));
        const defaultPill = pillsGrid.querySelector('[data-rarity="all"]');
        if (defaultPill) defaultPill.classList.add('active');
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

  // Moved Sidebar Alert triggers
  if (el.toggleSound) {
    el.toggleSound.addEventListener('change', (e) => {
      state.soundEnabled = e.target.checked;
      localStorage.setItem('wardeals_soundEnabled', state.soundEnabled);
    });
  }

  if (el.toggleDesktop) {
    el.toggleDesktop.addEventListener('change', async (e) => {
      const checked = e.target.checked;
      if (checked) {
        if (typeof Notification === 'undefined') {
          alert('Notifications non supportées.');
          el.toggleDesktop.checked = false;
          return;
        }
        if (Notification.permission !== 'granted') {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            el.toggleDesktop.checked = false;
            return;
          }
        }
        showTestNotification();
      }
      state.desktopNotificationsEnabled = checked;
      localStorage.setItem('wardeals_desktopNotifications', checked ? 'true' : 'false');
    });
  }
}

// setup Watchlist and Light Mode theme logic
function setupWatchlistAndTheme() {
  // Theme load
  const savedTheme = localStorage.getItem('wardeals_theme');
  if (savedTheme === 'light') {
    document.body.classList.add('light-theme');
    updateThemeToggleUI(true);
  }
  
  const btnThemeToggle = document.getElementById('btnThemeToggle');
  if (btnThemeToggle) {
    btnThemeToggle.addEventListener('click', () => {
      const isLight = document.body.classList.toggle('light-theme');
      localStorage.setItem('wardeals_theme', isLight ? 'light' : 'dark');
      updateThemeToggleUI(isLight);
    });
  }



  // Watchlist modal toggles
  const watchlistModal = document.getElementById('watchlistModal');
  const btnOpenWatchlist = document.getElementById('btnOpenWatchlist');
  const btnCloseWatchlist = document.getElementById('btnCloseWatchlist');

  if (btnOpenWatchlist && watchlistModal) {
    btnOpenWatchlist.addEventListener('click', (e) => {
      e.preventDefault();
      watchlistModal.classList.remove('modal-hidden');
    });
  }

  if (btnCloseWatchlist && watchlistModal) {
    btnCloseWatchlist.addEventListener('click', () => {
      watchlistModal.classList.add('modal-hidden');
    });
    watchlistModal.addEventListener('click', (e) => {
      if (e.target === watchlistModal) {
        watchlistModal.classList.add('modal-hidden');
      }
    });
  }

  // Watchlist tag renderer
  renderWatchlistTags();

  // Watchlist Input Autocomplete
  const watchlistInput = document.getElementById('watchlistInput');
  const watchlistAutocomplete = document.getElementById('watchlistAutocomplete');
  let selectedWatchlistItem = null;

  if (watchlistInput && watchlistAutocomplete) {
    watchlistInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      selectedWatchlistItem = null;

      if (query.length < 2) {
        watchlistAutocomplete.classList.add('dropdown-hidden');
        return;
      }

      const matches = state.items
        .filter(item => item.name.toLowerCase().includes(query))
        .slice(0, 10);

      if (matches.length === 0) {
        watchlistAutocomplete.classList.add('dropdown-hidden');
        return;
      }

      watchlistAutocomplete.innerHTML = '';
      matches.forEach(item => {
        const div = document.createElement('div');
        div.className = 'autocomplete-item';
        div.textContent = item.name;
        div.addEventListener('click', () => {
          watchlistInput.value = item.name;
          selectedWatchlistItem = item;
          watchlistAutocomplete.classList.add('dropdown-hidden');
        });
        watchlistAutocomplete.appendChild(div);
      });

      watchlistAutocomplete.classList.remove('dropdown-hidden');
    });
  }

  // Watchlist Add button click
  const btnAddWatchlist = document.getElementById('btnAddWatchlist');
  if (btnAddWatchlist) {
    btnAddWatchlist.addEventListener('click', () => {
      let itemToAdd = null;
      if (selectedWatchlistItem) {
        itemToAdd = selectedWatchlistItem;
      } else {
        const typedText = watchlistInput.value.toLowerCase().trim();
        const matched = state.items.find(item => item.name.toLowerCase() === typedText);
        if (matched) {
          itemToAdd = matched;
        }
      }

      if (!itemToAdd) {
        alert("Veuillez sélectionner un item valide.");
        return;
      }

      if (state.watchlist.some(w => w.slug === itemToAdd.slug)) {
        alert("Cet item figure déjà dans votre liste.");
        return;
      }

      state.watchlist.push(itemToAdd);
      localStorage.setItem('wardeals_watchlist', JSON.stringify(state.watchlist));
      watchlistInput.value = '';
      selectedWatchlistItem = null;
      renderWatchlistTags();
      renderDeals();
    });
  }
}

// Render active Watchlist Tags inside Modal
function renderWatchlistTags() {
  const listContainer = document.getElementById('watchlistItemsList');
  if (!listContainer) return;
  listContainer.innerHTML = '';
  
  if (state.watchlist.length === 0) {
    listContainer.innerHTML = '<span style="font-size:11px; color:#5d718a; padding:6px 0;">Aucun objet dans votre watchlist.</span>';
    return;
  }
  
  state.watchlist.forEach(item => {
    const tag = document.createElement('div');
    tag.className = 'watchlist-tag';
    tag.innerHTML = `
      <span>${item.name}</span>
      <button class="btn-delete-tag" data-slug="${item.slug}">&times;</button>
    `;
    
    tag.querySelector('.btn-delete-tag').addEventListener('click', () => {
      state.watchlist = state.watchlist.filter(w => w.slug !== item.slug);
      localStorage.setItem('wardeals_watchlist', JSON.stringify(state.watchlist));
      renderWatchlistTags();
      renderDeals();
    });
    
    listContainer.appendChild(tag);
  });
}

// Update Theme UI button icons
function updateThemeToggleUI(isLight) {
  const btn = document.getElementById('btnThemeToggle');
  if (!btn) return;
  const darkIcon = btn.querySelector('.theme-icon-sombre');
  const lightIcon = btn.querySelector('.theme-icon-clair');
  
  if (isLight) {
    if (darkIcon) darkIcon.style.display = 'none';
    if (lightIcon) lightIcon.style.display = 'inline-block';
  } else {
    if (darkIcon) darkIcon.style.display = 'inline-block';
    if (lightIcon) lightIcon.style.display = 'none';
  }
}

// User-defined search logic filter validations
function matchesFilters(deal) {
  const nameLower = deal.name.toLowerCase();
  
  // 1. Min Discount validation
  const passDiscount = deal.discount >= state.filters.discount;
  
  // 2. Min Profit validation
  const passProfit = deal.margin >= state.filters.profit;
  
  // 3. Rarity mapping validation
  const dealRarity = getDealRarity(deal.discount);
  const passRarity = state.filters.rarity === 'all' || dealRarity === state.filters.rarity;
  
  // 4. Text and pseudo search
  let passText = true;
  if (state.filters.text) {
    const q = state.filters.text;
    passText = nameLower.includes(q) || 
               (deal.user && deal.user.ingameName.toLowerCase().includes(q)) ||
               (deal.subtype && deal.subtype.toLowerCase().includes(q));
  }

  // 5. Rank specifications filter
  let passRank = true;
  if (state.filters.rank !== 'all' && deal.rank !== undefined && deal.rank !== null) {
    if (state.filters.rank === 'rank0') {
      passRank = deal.rank === 0;
    } else if (state.filters.rank === 'maxed') {
      passRank = (deal.maxRank !== undefined && deal.rank === deal.maxRank) || deal.rank >= 5;
    }
  }

  // 6. Seller name search
  let passSeller = true;
  if (state.filters.sellerName) {
    passSeller = deal.user.ingameName.toLowerCase().includes(state.filters.sellerName);
  }

  // 7. Masquer deja vus
  let passSeen = true;
  if (state.filters.masquerVus) {
    passSeen = !state.seenDealIds.has(deal.id) || state.deals.slice(0, 2).some(d => d.id === deal.id);
  }
                   
  return passDiscount && passProfit && passRarity && passText && passRank && passSeller && passSeen;
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
        tag: deal.id,
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
    const notification = new Notification("🤖 WARDEALS // Warframe Sniper", {
      body: "Les alertes de bureau sont activées ! Vous serez notifié pour les opportunités correspondant à vos filtres.",
      icon: 'https://warframe.market/static/assets/items/images/en/thumbs/general_item.png',
      requireInteraction: false
    });
  } catch (e) {
    console.error('Failed to trigger test notification:', e);
  }
}

// Poll Server Status
async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();

    // Direct binding updates
    if (el.statRequests) el.statRequests.innerHTML = `${status.requestsMade} <span class="h-suffix">/ min</span>`;
  } catch (err) {
    console.error('Failed to poll status:', err);
  }
}

// Update potential margins metrics dynamically
function updateLiveMetrics() {
  const filteredDeals = state.deals.filter(matchesFilters);
  let avgProfit = 0;
  let potentialGain = 0;
  
  if (filteredDeals.length > 0) {
    const totalProfit = filteredDeals.reduce((sum, d) => sum + d.margin, 0);
    avgProfit = Math.round((totalProfit / filteredDeals.length) * 10) / 10;
    potentialGain = totalProfit;
  }
  
  if (el.statAvgProfit) {
    el.statAvgProfit.innerHTML = `+${avgProfit.toLocaleString('fr-FR')} <span class="h-suffix">plats</span>`;
  }
  if (el.statPotentialGain) {
    el.statPotentialGain.innerHTML = `${potentialGain.toLocaleString('fr-FR')} <span class="h-suffix">plats</span>`;
  }
  if (el.statDealsFound) {
    el.statDealsFound.innerHTML = `${filteredDeals.length} <span class="h-suffix">en temps réel</span>`;
  }
}

// Update titles based on navigation presets
function updateFeaturedHeader() {
  if (!el.featuredTitle || !el.featuredDesc) return;
  if (state.sort === 'recency') {
    el.featuredTitle.textContent = "🔥 NOUVEAUX DÉTECTÉS";
    el.featuredDesc.textContent = "Les offres les plus récentes repérées en temps réel";
  } else if (state.sort === 'margin') {
    el.featuredTitle.textContent = "💸 MEILLEURES MARGES";
    el.featuredDesc.textContent = "Les opportunités avec les profits en platines les plus gigantesques";
  } else {
    el.featuredTitle.textContent = "💎 MEILLEURES AFFAIRES";
    el.featuredDesc.textContent = "Les objets vendus avec le plus gros pourcentage de remise du marché";
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

// Render filtered and sorted deal cards with dynamic Spotlight featured top-cards
function renderDeals() {
  const filtered = state.deals.filter(matchesFilters);

  filtered.sort((a, b) => {
    if (state.sort === 'discount') {
      if (b.discount !== a.discount) return b.discount - a.discount;
      return b.margin - a.margin; 
    } else if (state.sort === 'margin') {
      if (b.margin !== a.margin) return b.margin - a.margin;
      return b.discount - a.discount; 
    } else if (state.sort === 'recency') {
      return b.spottedAt - a.spottedAt;
    }
    return 0;
  });

  updateLiveMetrics();
  updateFeaturedHeader();

  if (filtered.length === 0) {
    if (el.featuredDealsContainer) el.featuredDealsContainer.innerHTML = '';
    el.emptyState.style.display = 'flex';
    
    // Wipe deals list grid clean
    const existingCards = el.dealsGrid.querySelectorAll('.compact-deal-card');
    existingCards.forEach(c => c.remove());
    return;
  }

  el.emptyState.style.display = 'none';

  // 3. Render Spotlight (featured top 2 items side-by-side)
  const featuredList = filtered.slice(0, 2);
  renderFeaturedDeals(featuredList);

  // 4. Render Grid items (all subsequent items: index 2 and onwards)
  const gridDeals = filtered.slice(2);
  renderGridDeals(gridDeals);
}

// Render the featured spotlight top cards side-by-side
function renderFeaturedDeals(deals) {
  if (!el.featuredDealsContainer) return;
  el.featuredDealsContainer.innerHTML = '';
  
  deals.forEach((deal) => {
    const rarity = getDealRarity(deal.discount);
    const imageUrl = deal.thumb 
      ? `https://warframe.market/static/assets/${deal.thumb}` 
      : 'https://warframe.market/static/assets/items/images/en/thumbs/general_item.png';
    const fullTitle = getItemFullTitle(deal);
    const timeAgo = formatTimeAgo(deal.spottedAt);
    
    let badgeLabel = "⭐ NOUVEAU";
    if (state.sort === 'discount') {
      badgeLabel = "⭐ MEILLEURE AFFAIRE";
    } else if (state.sort === 'margin') {
      badgeLabel = "⭐ TOP PROFIT";
    }
    
    const cardHtml = `
      <div class="featured-deal-card card-${rarity} sort-${state.sort}" data-id="${deal.id}">
        <span class="featured-badge-tag">${badgeLabel}</span>
        <span class="featured-discount-tag">-${deal.discount}%</span>
        
        <div class="featured-card-layout">
          <!-- Showcase Image Left -->
          <div class="featured-left-image">
            <img class="featured-item-thumb" src="${imageUrl}" alt="${deal.name}" onerror="this.src='https://warframe.market/static/assets/items/images/en/thumbs/general_item.png'">
          </div>
          
          <!-- Details Middle -->
          <div class="featured-details">
            <h2 class="featured-title" title="${fullTitle}">${fullTitle}</h2>
            <div class="featured-rarity-badge badge-${rarity}">${rarity.toUpperCase()}</div>
            
            <div class="featured-seller-row">
              <span class="seller-dot"></span>
              <span class="seller-txt">${deal.user.ingameName}</span>
              <span class="seller-reputation-gold">&#9733; ${deal.user.reputation}</span>
              <span class="featured-spotted-time">&bull; ${timeAgo}</span>
            </div>
            
            <div class="featured-price-breakdown">
              <div class="price-elem">
                <span class="pr-lbl">PRIX ACHAT</span>
                <span class="pr-val">${deal.price} <span class="plat-suffix">plat</span></span>
              </div>
              <div class="price-elem">
                <span class="pr-lbl">PRIX MARCHÉ</span>
                <span class="pr-val">${deal.typicalPrice} <span class="plat-suffix">plat</span></span>
              </div>
            </div>
          </div>
          
          <!-- Profit Accent & Action Right -->
          <div class="featured-profit-action">
            <div class="featured-profit-box">
              <span class="prof-lbl">PROFIT ESTIMÉ</span>
              <span class="prof-val">+${deal.margin} <span class="plat-suffix">plat</span></span>
            </div>
            
            <button class="btn-feat-primary btn-whisper-copy" data-whisper="${deal.copyWhisper.replace(/"/g, '&quot;')}">
              COPIER LE WHISPER
            </button>
          </div>
        </div>
      </div>
    `;
    
    el.featuredDealsContainer.insertAdjacentHTML('beforeend', cardHtml);
  });
  
  // Bind click elements
  el.featuredDealsContainer.querySelectorAll('.featured-deal-card').forEach(featuredCard => {
    const dealId = featuredCard.getAttribute('data-id');
    const deal = state.deals.find(d => d.id === dealId);
    if (!deal) return;
    
    const whisperBtn = featuredCard.querySelector('.btn-feat-primary');
    
    if (whisperBtn) {
      whisperBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const whisperText = whisperBtn.getAttribute('data-whisper');
        copyWhisper(event, whisperText, whisperBtn);
      });
    }
    
    featuredCard.addEventListener('click', (event) => {
      if (event.target.closest('.btn-feat-primary')) return;
      const whisperText = whisperBtn.getAttribute('data-whisper');
      copyWhisper(null, whisperText, whisperBtn);
      window.open(`https://warframe.market/items/${deal.slug}`, '_blank', 'noopener');
    });
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
      
      el.dealsGrid.appendChild(card);
    } else {
      card = document.createElement('div');
      card.className = `compact-deal-card card-${rarity}`;
      card.setAttribute('data-id', deal.id);
      
      card.innerHTML = `
        <div class="card-top-row">
          <span class="card-discount-tag">-${deal.discount}%</span>
          <span class="card-rarity-pill ${rarity}">${rarity.toUpperCase()}</span>
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
  if (diffSec < 5) return "à l'instant";
  if (diffSec < 60) return `il y a ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  return `il y a ${diffMin}m`;
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
          // If watchlist is populated, only notify when the item is inside the watchlist!
          let shouldAlert = true;
          if (state.watchlist.length > 0) {
            shouldAlert = state.watchlist.some(w => w.name.toLowerCase() === deal.name.toLowerCase());
          }

          if (shouldAlert) {
            const rarity = getDealRarity(deal.discount);
            if (rarity === 'rare' || rarity === 'epic' || rarity === 'legendary') {
              playNotificationSound(rarity);
            }
            showDesktopNotification(deal);
          }
        }
      }
    });

    state.deals = incomingDeals;
    renderDeals();
  } catch (err) {
    console.error('Failed to poll deals:', err);
  }
}

// Trigger Manual high-priority scan
async function triggerManualScan() {
  let slug = '';
  
  if (state.selectedItem) {
    slug = state.selectedItem.slug;
  } else {
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
    el.btnManualScan.textContent = 'SCAN...';
    el.itemSearchInput.disabled = true;
    
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug })
    });
    
    const data = await res.json();
    console.log(data.message);

    setTimeout(() => {
      el.btnManualScan.disabled = false;
      el.btnManualScan.textContent = 'SCAN';
      el.itemSearchInput.disabled = false;
      el.itemSearchInput.value = '';
      state.selectedItem = null;
    }, 1500);
  } catch (e) {
    console.error('Failed manual scan:', e);
    el.btnManualScan.disabled = false;
    el.btnManualScan.textContent = 'SCAN';
    el.itemSearchInput.disabled = false;
  }
}

// Autocomplete filter matching
function handleSearchInput(e) {
  const query = e.target.value.toLowerCase().trim();
  state.selectedItem = null;

  if (query.length < 2) {
    el.autocompleteDropdown.classList.add('dropdown-hidden');
    return;
  }

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

// Copy trade whisper command to system clipboard & provide feedback
async function copyWhisper(event, whisperText, button) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  try {
    await navigator.clipboard.writeText(whisperText);
    
    button.classList.add('copied');
    const originalText = button.textContent;
    button.textContent = '📋 WHISPER COPIÉ !';

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
