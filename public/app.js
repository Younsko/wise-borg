/* ==========================================================================
   WARFRAME DEAL SNIPER - FRONTEND BEHAVIOR (VANILLA JS)
   ========================================================================== */

// Application State
const state = {
  items: [],              // All tradable items for autocomplete
  deals: [],              // Currently spotted deals from server
  seenDealIds: new Set(), // Set of deal IDs we've already notified about
  selectedItem: null,     // Currently selected item for manual scan
  filters: {
    discount: 20,
    profit: 3,
    text: '',
    rank: 'all'
  },
  sort: 'discount',       // 'discount' | 'margin' | 'recency'
  soundEnabled: false,
  desktopNotificationsEnabled: false,
  isScanning: false,
  pollInterval: 10,       // dynamic auto-refresh interval in seconds
  dealsIntervalId: null   // active interval timer ID
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

// DOM Elements
const el = {
  scannerPulse: document.getElementById('scannerPulse'),
  scannerStatusLabel: document.getElementById('scannerStatusLabel'),
  statRequests: document.getElementById('statRequests'),
  statQueue: document.getElementById('statQueue'),
  statCache: document.getElementById('statCache'),
  statDealsFound: document.getElementById('statDealsFound'),
  itemSearchInput: document.getElementById('itemSearchInput'),
  btnManualScan: document.getElementById('btnManualScan'),
  autocompleteDropdown: document.getElementById('autocompleteDropdown'),
  filterDiscount: document.getElementById('filterDiscount'),
  valDiscount: document.getElementById('valDiscount'),
  filterProfit: document.getElementById('filterProfit'),
  valProfit: document.getElementById('valProfit'),
  filterInterval: document.getElementById('filterInterval'),
  valInterval: document.getElementById('valInterval'),
  filterText: document.getElementById('filterText'),
  filterRank: document.getElementById('filterRank'),
  btnClearDeals: document.getElementById('btnClearDeals'),
  btnManualRefresh: document.getElementById('btnManualRefresh'),
  toggleSound: document.getElementById('toggleSound'),
  toggleDesktop: document.getElementById('toggleDesktop'),
  dealsCount: document.getElementById('dealsCount'),
  dealsGrid: document.getElementById('dealsGrid'),
  emptyState: document.getElementById('emptyState'),
  sortBtns: document.querySelectorAll('.sort-btn')
};

// Start or adjust the active deal polling schedule dynamically
function startDealsPolling() {
  if (state.dealsIntervalId) {
    clearInterval(state.dealsIntervalId);
  }
  state.dealsIntervalId = setInterval(pollDeals, state.pollInterval * 1000);
}

// Initialize Application
async function init() {
  setupEventListeners();
  
  // Load settings from localStorage
  const savedSound = localStorage.getItem('wiseBorg_soundEnabled');
  if (savedSound !== null) {
    state.soundEnabled = savedSound === 'true';
    el.toggleSound.checked = state.soundEnabled;
  }
  
  const savedDesktop = localStorage.getItem('wiseBorg_desktopNotifications');
  if (savedDesktop !== null) {
    state.desktopNotificationsEnabled = savedDesktop === 'true';
    el.toggleDesktop.checked = state.desktopNotificationsEnabled;
    
    // Auto-disable and uncheck if permission was revoked or denied
    if (state.desktopNotificationsEnabled && typeof Notification !== 'undefined') {
      if (Notification.permission !== 'granted') {
        state.desktopNotificationsEnabled = false;
        el.toggleDesktop.checked = false;
        localStorage.setItem('wiseBorg_desktopNotifications', 'false');
      }
    }
  }

  await fetchItemsList();
  
  // Start polling loops
  pollStatus();
  pollDeals();
  setInterval(pollStatus, 2000);
  startDealsPolling();
}

// Fetch Autocomplete Items manifest from server
async function fetchItemsList() {
  try {
    const res = await fetch('/api/items');
    state.items = await res.json();
    console.log(`Initialized frontend search registry with ${state.items.length} items.`);
  } catch (err) {
    console.error('Failed to load items list:', err);
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Autocomplete Search input
  el.itemSearchInput.addEventListener('input', handleSearchInput);
  
  // Close autocomplete dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!el.itemSearchInput.contains(e.target) && !el.autocompleteDropdown.contains(e.target)) {
      el.autocompleteDropdown.classList.add('dropdown-hidden');
    }
  });

  // Manual Scan Trigger
  el.btnManualScan.addEventListener('click', triggerManualScan);
  
  // Filters sliders & text inputs
  el.filterDiscount.addEventListener('input', (e) => {
    state.filters.discount = parseInt(e.target.value);
    el.valDiscount.textContent = `${state.filters.discount}%`;
    renderDeals();
  });

  el.filterProfit.addEventListener('input', (e) => {
    state.filters.profit = parseInt(e.target.value);
    el.valProfit.innerHTML = `${state.filters.profit} <span>Plat</span>`;
    renderDeals();
  });

  el.filterInterval.addEventListener('input', (e) => {
    state.pollInterval = parseInt(e.target.value);
    el.valInterval.textContent = `${state.pollInterval}s`;
  });

  el.filterInterval.addEventListener('change', (e) => {
    state.pollInterval = parseInt(e.target.value);
    el.valInterval.textContent = `${state.pollInterval}s`;
    startDealsPolling();
    console.log(`[Polling] Adjusted deals poll interval to ${state.pollInterval}s.`);
  });

  el.filterText.addEventListener('input', (e) => {
    state.filters.text = e.target.value.toLowerCase().trim();
    renderDeals();
  });

  el.filterRank.addEventListener('change', (e) => {
    state.filters.rank = e.target.value;
    renderDeals();
  });

  // Clear list
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

  // Manual Refresh Deals button click
  if (el.btnManualRefresh) {
    el.btnManualRefresh.addEventListener('click', async () => {
      // Add visual refreshing state
      el.btnManualRefresh.classList.add('refreshing');
      
      // Play a quick chime to show click register
      playNotificationSound('uncommon');
      
      try {
        await pollDeals();
        await pollStatus();
      } catch (err) {
        console.error('Manual refresh failed:', err);
      } finally {
        // Leave the refreshing icon spinning for at least 800ms for visual feel
        setTimeout(() => {
          el.btnManualRefresh.classList.remove('refreshing');
        }, 800);
      }
    });
  }

  // Toggle Sound alert
  el.toggleSound.addEventListener('change', (e) => {
    state.soundEnabled = e.target.checked;
    localStorage.setItem('wiseBorg_soundEnabled', state.soundEnabled);
  });

  // Toggle Desktop Notifications
  el.toggleDesktop.addEventListener('change', async (e) => {
    if (e.target.checked) {
      console.log("[Notifications] Toggle checked. Current permission:", typeof Notification !== 'undefined' ? Notification.permission : 'undefined');
      console.log("[Notifications] Context is secure:", window.isSecureContext);

      if (typeof Notification === 'undefined') {
        alert('Votre navigateur ne supporte pas les notifications de bureau (ou l\'origin n\'est pas sécurisée).');
        e.target.checked = false;
        state.desktopNotificationsEnabled = false;
        return;
      }
      
      // Safety check for secure origin
      if (!window.isSecureContext) {
        alert('Les notifications requièrent un contexte sécurisé (HTTPS ou http://localhost). Si vous utilisez 127.0.0.1, merci d\'ouvrir plutôt : http://localhost:3001');
      }

      // Safe cross-browser request function
      const requestPerm = () => {
        return new Promise((resolve) => {
          try {
            // Some browsers require callback syntax, others return Promise
            const promise = Notification.requestPermission(resolve);
            if (promise && typeof promise.then === 'function') {
              promise.then(resolve);
            }
          } catch (err) {
            console.error('[Notifications] Safe request permission failed:', err);
            resolve(Notification.permission);
          }
        });
      };

      if (Notification.permission === 'granted') {
        state.desktopNotificationsEnabled = true;
        showTestNotification();
      } else if (Notification.permission === 'default') {
        console.log('[Notifications] Requesting permission...');
        const permission = await requestPerm();
        console.log('[Notifications] Permission response:', permission);
        
        if (permission === 'granted') {
          state.desktopNotificationsEnabled = true;
          showTestNotification();
        } else {
          e.target.checked = false;
          state.desktopNotificationsEnabled = false;
          alert(`Permissions de notification : ${permission}.`);
        }
      } else {
        // Permission is 'denied'
        e.target.checked = false;
        state.desktopNotificationsEnabled = false;
        alert('Notifications bloquées ou refusées dans les paramètres de votre navigateur. Veuillez cliquer sur l\'icône de cadenas 🔒 à gauche de l\'URL pour réactiver "Autoriser".');
      }
    } else {
      state.desktopNotificationsEnabled = false;
      console.log('[Notifications] Toggle unchecked.');
    }
    
    localStorage.setItem('wiseBorg_desktopNotifications', state.desktopNotificationsEnabled);
  });

  // Sorting Tabs
  el.sortBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      el.sortBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.sort = btn.getAttribute('data-sort');
      renderDeals();
    });
  });
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
    el.itemSearchInput.style.borderColor = 'var(--tenno-teal)';
    el.itemSearchInput.style.boxShadow = 'var(--glow-teal)';

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
      el.btnManualScan.querySelector('.btn-text').textContent = 'SCANNER';
      el.itemSearchInput.disabled = false;
      el.itemSearchInput.value = '';
      el.itemSearchInput.style.borderColor = '';
      el.itemSearchInput.style.boxShadow = '';
      state.selectedItem = null;
    }, 1500);

  } catch (err) {
    console.error('Manual scan failed:', err);
    el.btnManualScan.disabled = false;
    el.btnManualScan.querySelector('.btn-text').textContent = 'SCANNER';
    el.itemSearchInput.disabled = false;
  }
}

// Poll Server Status
async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();

    // Update headers and statistics counters
    el.statRequests.textContent = status.requestsMade;
    el.statQueue.textContent = status.queueLength;
    el.statCache.textContent = status.cacheSize;
    el.statDealsFound.textContent = status.dealsFoundCount;

    // Rate Limit active banner changes
    if (status.rateLimited) {
      el.scannerPulse.className = 'status-pulse rate-limited';
      const sLeft = Math.ceil(status.cooldownMsLeft / 1000);
      el.scannerStatusLabel.textContent = `PAUSE API (${sLeft}s)`;
      el.scannerStatusLabel.style.color = 'var(--danger-red)';
    } else if (status.queueLength > 0) {
      el.scannerPulse.className = 'status-pulse syncing';
      el.scannerStatusLabel.textContent = `SCAN EN COURS (${status.queueLength})`;
      el.scannerStatusLabel.style.color = '#ff9800';
    } else {
      el.scannerPulse.className = 'status-pulse';
      el.scannerStatusLabel.textContent = `ACTIF // À JOUR`;
      el.scannerStatusLabel.style.color = 'var(--tenno-teal)';
    }
  } catch (e) {
    el.scannerPulse.className = 'status-pulse rate-limited';
    el.scannerStatusLabel.textContent = 'ERREUR RESEAU';
    el.scannerStatusLabel.style.color = 'var(--danger-red)';
  }
}

// Check if a deal matches the current user filters/settings
function matchesFilters(deal) {
  const passDiscount = deal.discount >= state.filters.discount;
  const passProfit = deal.margin >= state.filters.profit;
  
  const searchStr = state.filters.text;
  const passText = searchStr === '' || 
                   deal.name.toLowerCase().includes(searchStr) || 
                   (deal.variantName && deal.variantName.toLowerCase().includes(searchStr));
                   
  let passRank = true;
  if (deal.rank !== undefined && deal.rank !== null) {
    if (state.filters.rank === 'rank0') {
      passRank = deal.rank === 0;
    } else if (state.filters.rank === 'maxed') {
      const isMaxed = deal.maxRank > 0 ? (deal.rank === deal.maxRank) : [3, 5, 8, 10].includes(deal.rank);
      passRank = isMaxed;
    }
  }
                   
  return passDiscount && passProfit && passText && passRank;
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

// Render filtered and sorted deal cards to the UI Grid with DOM Reconciliation (Flicker-Free)
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

  // Update count badge
  el.dealsCount.textContent = filtered.length;

  // DOM Reconciliation logic to eliminate layout jumps & image reloads
  const existingCards = el.dealsGrid.querySelectorAll('.deal-card');
  const existingCardMap = new Map();
  existingCards.forEach(card => {
    const id = card.getAttribute('data-id');
    if (id) existingCardMap.set(id, card);
  });

  if (filtered.length === 0) {
    // Remove all old cards
    existingCards.forEach(card => card.remove());
    el.emptyState.style.display = 'flex';
    return;
  }

  el.emptyState.style.display = 'none';

  // Build and update cards in the correct sorted order
  filtered.forEach(deal => {
    const rarity = getDealRarity(deal.discount);
    const imageUrl = deal.thumb 
      ? `https://warframe.market/static/assets/${deal.thumb}` 
      : 'https://warframe.market/static/assets/items/images/en/thumbs/general_item.png';
      
    const fullTitle = getItemFullTitle(deal);
    const timeAgo = formatTimeAgo(deal.spottedAt);
    
    // Check if card already exists
    let card = existingCardMap.get(deal.id);
    
    if (card) {
      // Card exists! Update dynamic elements in-place to avoid flicker
      existingCardMap.delete(deal.id);
      
      // Update dynamic elements
      const timeEl = card.querySelector('.spotted-time');
      if (timeEl) timeEl.textContent = timeAgo;
      
      const priceValEl = card.querySelector('.stat-row-price-sale');
      if (priceValEl) priceValEl.innerHTML = `${deal.price} <span class="plat-suffix">plat</span>`;
      
      const marketValEl = card.querySelector('.stat-row-price-market');
      if (marketValEl) marketValEl.innerHTML = `${deal.typicalPrice} <span class="plat-suffix">plat</span>`;
      
      const marginValEl = card.querySelector('.stat-row-price-margin');
      if (marginValEl) marginValEl.innerHTML = `+${deal.margin} <span class="plat-suffix">plat</span>`;
      
      const discountValEl = card.querySelector('.discount-badge-val');
      if (discountValEl) discountValEl.textContent = `-${deal.discount}%`;
      
      const titleEl = card.querySelector('.item-title');
      if (titleEl) titleEl.textContent = fullTitle;
      
      const whisperBtn = card.querySelector('.btn-whisper-copy');
      if (whisperBtn) {
        whisperBtn.setAttribute('data-whisper', deal.copyWhisper);
      }
      
      // Update Mastery Rank badge dynamically in-place
      let headerLeftEl = card.querySelector('.header-left-group');
      if (!headerLeftEl) {
        // Fallback: if old HTML structure exists in DOM, wrap rarity tag
        const rarityTag = card.querySelector('.deal-rarity-tag');
        if (rarityTag) {
          headerLeftEl = document.createElement('div');
          headerLeftEl.className = 'header-left-group';
          rarityTag.parentNode.insertBefore(headerLeftEl, rarityTag);
          headerLeftEl.appendChild(rarityTag);
        }
      }
      if (headerLeftEl) {
        let mrBadge = headerLeftEl.querySelector('.badge-mr');
        if (deal.reqMasteryRank) {
          if (mrBadge) {
            mrBadge.textContent = `MR ${deal.reqMasteryRank}`;
          } else {
            mrBadge = document.createElement('span');
            mrBadge.className = 'badge-mr';
            mrBadge.textContent = `MR ${deal.reqMasteryRank}`;
            headerLeftEl.appendChild(mrBadge);
          }
        } else if (mrBadge) {
          mrBadge.remove();
        }
      }
      
      // Ensure it is styled properly if rarity changed
      card.className = `deal-card card-${rarity}`;
      
      // Append it to container (this moves it to the correct sorted order automatically!)
      el.dealsGrid.appendChild(card);
    } else {
      // Create a brand new card as an anchor tag
      card = document.createElement('a');
      card.href = `https://warframe.market/items/${deal.slug}`;
      card.target = '_blank';
      card.rel = 'noopener';
      card.className = `deal-card card-${rarity}`;
      card.setAttribute('data-id', deal.id);
      
      // Construct beautiful HTML
      card.innerHTML = `
        <div class="card-border-top"></div>
        <div class="card-layout">
          <!-- Left Part: Large Image & Seller badge -->
          <div class="card-left">
            <div class="image-wrapper">
              <img class="item-image" src="${imageUrl}" alt="${deal.name}" onerror="this.src='https://warframe.market/static/assets/items/images/en/thumbs/secura_dual_cestra.3d47a4ec6675ff774bb0da9b16c53e0e.128x128.png'">
              <span class="discount-badge-val">-${deal.discount}%</span>
            </div>
            <div class="seller-info">
              <span class="seller-status-dot dot-ingame"></span>
              <span class="seller-name" title="${deal.user.ingameName}">${deal.user.ingameName}</span>
              <span class="seller-rep" title="Reputation">&#9733; ${deal.user.reputation}</span>
            </div>
          </div>
          
          <!-- Right Part: Header & Stats Column -->
          <div class="card-right">
            <div class="card-header-row">
              <div class="header-left-group">
                <span class="deal-rarity-tag tag-${rarity}">${rarity.toUpperCase()} DEAL</span>
                ${deal.reqMasteryRank ? `<span class="badge-mr">MR ${deal.reqMasteryRank}</span>` : ''}
              </div>
              <span class="spotted-time text-muted">${timeAgo}</span>
            </div>
            
            <h3 class="item-title">${fullTitle}</h3>
            
            <div class="stats-column">
              <div class="stat-row">
                <span class="stat-label">Prix Vente</span>
                <span class="stat-value text-green stat-row-price-sale">${deal.price} <span class="plat-suffix">plat</span></span>
              </div>
              <div class="stat-row">
                <span class="stat-label">Prix Marché</span>
                <span class="stat-value stat-row-price-market">${deal.typicalPrice} <span class="plat-suffix">plat</span></span>
              </div>
              <div class="stat-row">
                <span class="stat-label">Bénéfice</span>
                <span class="stat-value text-gold stat-row-price-margin">+${deal.margin} <span class="plat-suffix">plat</span></span>
              </div>
            </div>
          </div>
        </div>
        <button class="btn-whisper-copy" data-whisper="${deal.copyWhisper.replace(/"/g, '&quot;')}">
          📋 COPY WHISPER
        </button>
      `;
      
      // Setup event listener directly on the whisper button
      const whisperBtn = card.querySelector('.btn-whisper-copy');
      if (whisperBtn) {
        whisperBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const whisperText = whisperBtn.getAttribute('data-whisper');
          copyWhisper(event, whisperText, whisperBtn);
        });
      }
      
      el.dealsGrid.appendChild(card);
    }
  });

  // Remove any leftover cards that are no longer in the filtered deals list
  existingCardMap.forEach(card => card.remove());
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
    button.textContent = '📋 WHISPER COPIÉ !';

    // Play visual flash
    setTimeout(() => {
      button.classList.remove('copied');
      button.textContent = '📋 COPY WHISPER';
    }, 2000);

  } catch (err) {
    console.error('Clipboard copy failed:', err);
    // Fallback prompt in case browser blocks clipboard API
    window.prompt("Copiez le whisper manuellement:", whisperText);
  }
}

// Load application
window.addEventListener('DOMContentLoaded', init);
