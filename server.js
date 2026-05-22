const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Path to cache the items manifest locally
const ITEMS_CACHE_PATH = path.join(__dirname, 'items_cache.json');
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Global state
let itemById = {};     // id -> item info
let itemBySlug = {};   // slug -> item info
let itemList = [];     // Array for autocomplete search
let typicalPriceCache = {}; // slug -> { typicalPrice, updatedAt }
let historicalStatsCache = {}; // slug -> { historicalMedian, updatedAt }
let itemMaxRanks = {}; // slug -> maxRank (e.g. 5, 10)
let deals = [];        // Array of spotted deals: [ { id, item, price, typicalPrice, discount, margin, user, copyWhisper, spottedAt } ]
let apiStats = {
  requestsMade: 0,
  queueLength: 0,
  cacheSize: 0,
  dealsFoundCount: 0,
  status: 'Starting...',
  rateLimitedUntil: 0
};

const PRICES_CACHE_PATH = path.join(__dirname, 'typical_price_cache.json');

function loadTypicalPriceCache() {
  try {
    if (fs.existsSync(PRICES_CACHE_PATH)) {
      const data = fs.readFileSync(PRICES_CACHE_PATH, 'utf-8');
      typicalPriceCache = JSON.parse(data);
      
      // Clean up extremely old entries (older than 24 hours) upon loading to keep the file clean
      const now = Date.now();
      const keys = Object.keys(typicalPriceCache);
      let removed = 0;
      keys.forEach(key => {
        if (!typicalPriceCache[key].updatedAt || (now - typicalPriceCache[key].updatedAt) > 24 * 60 * 60 * 1000) {
          delete typicalPriceCache[key];
          removed++;
        }
      });
      console.log(`[Cache Load] Loaded ${Object.keys(typicalPriceCache).length} typical prices from disk. Cleaned up ${removed} expired entries.`);
      apiStats.cacheSize = Object.keys(typicalPriceCache).length;
    }
  } catch (err) {
    console.error('[Cache Load Error] Failed to read typical_price_cache.json:', err.message);
  }
}

let saveTimeout = null;
function saveTypicalPriceCacheDebounced() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    fs.writeFile(PRICES_CACHE_PATH, JSON.stringify(typicalPriceCache, null, 2), 'utf-8', (err) => {
      if (err) {
        console.error('[Cache Save Error] Failed to write typical_price_cache.json:', err.message);
      } else {
        console.log(`[Cache Save] Synced ${Object.keys(typicalPriceCache).length} typical prices to disk.`);
      }
    });
  }, 2000); // Save at most once every 2 seconds
}

// Queue for typical price calculations (WFM rate limit is 3 requests/sec)
// We will process at 2 requests per second (500ms intervals) to be safe
let priceQueue = [];
let isProcessingQueue = false;

// Express setup
app.use(express.json());

// Optional Basic Authentication for private cloud hosting (Render, Railway, etc.)
// Active only if SECURITY_USER and SECURITY_PASS environment variables are defined.
app.use((req, res, next) => {
  const securityUser = process.env.SECURITY_USER;
  const securityPass = process.env.SECURITY_PASS;

  if (securityUser && securityPass) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Wise Borg Sniper Private Area"');
      return res.status(401).send('Authentication required.');
    }

    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const user = auth[0];
    const pass = auth[1];

    if (user === securityUser && pass === securityPass) {
      return next();
    } else {
      res.setHeader('WWW-Authenticate', 'Basic realm="Wise Borg Sniper Private Area"');
      return res.status(401).send('Invalid credentials.');
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Helper to make HTTPS requests to WFM API v2
function wfmRequest(urlPath) {
  apiStats.requestsMade++;
  return new Promise((resolve, reject) => {
    // If we are currently rate-limited, fail fast
    if (Date.now() < apiStats.rateLimitedUntil) {
      return reject(new Error('Rate limit cooldown active'));
    }

    const options = {
      hostname: 'api.warframe.market',
      port: 443,
      path: urlPath,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        'Platform': 'pc',
        'Crossplay': 'true'
      }
    };

    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          console.warn('WFM API returned 429 Too Many Requests. Cooling down for 10s...');
          apiStats.rateLimitedUntil = Date.now() + 10000; // 10s cooldown
          return reject(new Error('Rate limited (429)'));
        }
        if (res.statusCode >= 400) {
          return reject(new Error(`API Error: ${res.statusCode}`));
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

// 1. Fetch & Store Items Manifest (with local file fallback caching)
async function initItemsManifest() {
  try {
    let useCached = false;
    if (fs.existsSync(ITEMS_CACHE_PATH)) {
      const stats = fs.statSync(ITEMS_CACHE_PATH);
      const isExpired = (Date.now() - stats.mtimeMs) > CACHE_EXPIRY_MS;
      if (!isExpired) {
        useCached = true;
      }
    }

    let itemsData;
    if (useCached) {
      console.log('Loading items list from local file cache...');
      itemsData = JSON.parse(fs.readFileSync(ITEMS_CACHE_PATH, 'utf-8'));
    } else {
      console.log('Fetching fresh items list from Warframe.market API...');
      apiStats.status = 'Fetching items list...';
      const res = await wfmRequest('/v2/items');
      itemsData = res.data;
      fs.writeFileSync(ITEMS_CACHE_PATH, JSON.stringify(itemsData), 'utf-8');
      console.log('Successfully fetched and cached items list.');
    }

    itemById = {};
    itemBySlug = {};
    itemList = [];

    itemsData.forEach(item => {
      const info = {
        id: item.id,
        slug: item.slug,
        name: item.i18n.en.name,
        thumb: item.i18n.en.thumb,
        icon: item.i18n.en.icon
      };
      itemById[item.id] = info;
      itemBySlug[item.slug] = info;
      itemList.push({
        id: item.id,
        slug: item.slug,
        name: item.i18n.en.name
      });
    });

    console.log(`Loaded ${itemList.length} items into search database.`);
    apiStats.status = 'Active';
  } catch (err) {
    console.error('Failed to initialize items manifest:', err.message);
    if (fs.existsSync(ITEMS_CACHE_PATH)) {
      console.log('Falling back to expired local items cache...');
      const itemsData = JSON.parse(fs.readFileSync(ITEMS_CACHE_PATH, 'utf-8'));
      itemsData.forEach(item => {
        const info = {
          id: item.id,
          slug: item.slug,
          name: item.i18n.en.name,
          thumb: item.i18n.en.thumb,
          icon: item.i18n.en.icon
        };
        itemById[item.id] = info;
        itemBySlug[item.slug] = info;
        itemList.push({
          id: item.id,
          slug: item.slug,
          name: item.i18n.en.name
        });
      });
      console.log(`Loaded ${itemList.length} items from expired cache fallback.`);
      apiStats.status = 'Active (Offline Cache)';
    } else {
      apiStats.status = 'Initialization Failed';
    }
  }
}

// Helper: Calculate median of an array of numbers
function calculateMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// Helper: Construct a composite key based on item attributes
function getOrderKey(slug, order) {
  let key = slug;
  if (order.rank !== undefined && order.rank !== null) {
    key += '_r' + order.rank;
  }
  if (order.subtype) {
    key += '_s' + order.subtype;
  }
  if (order.amberStars !== undefined && order.amberStars !== null) {
    key += '_a' + order.amberStars;
  }
  if (order.cyanStars !== undefined && order.cyanStars !== null) {
    key += '_c' + order.cyanStars;
  }
  return key;
}

// Helper: Formats the item variant display name and the whisper name
function getVariantDetails(slug, order, itemName) {
  let displaySuffix = '';
  let whisperSuffix = '';
  
  if (order.rank !== undefined && order.rank !== null) {
    displaySuffix = ` (Rank ${order.rank})`;
    whisperSuffix = ` (Rank ${order.rank})`;
  } else if (order.subtype) {
    // Make sure subtype starts with uppercase or is lowercase depending on what WFM uses
    // Relics are "intact" / "radiant", weapon parts are "blueprint" / "crafted", veiled rivens "unrevealed"
    const sub = order.subtype.toLowerCase();
    displaySuffix = ` (${sub})`;
    whisperSuffix = ` (${sub})`;
  } else if (order.amberStars !== undefined && order.amberStars !== null) {
    const amber = order.amberStars;
    const cyan = order.cyanStars || 0;
    displaySuffix = ` (${amber} Amber, ${cyan} Cyan)`;
    whisperSuffix = ` (${amber} Amber, ${cyan} Cyan)`;
  }
  
  return {
    variantName: itemName + displaySuffix,
    whisperItemName: itemName + whisperSuffix
  };
}

// Helper: Fetch historical trade closed median price from WFM V1 Statistics API
async function getHistoricalMedian(slug) {
  const cached = historicalStatsCache[slug];
  const ONE_DAY = 24 * 60 * 60 * 1000;
  if (cached && (Date.now() - cached.updatedAt) < ONE_DAY) {
    return cached.historicalMedian;
  }

  try {
    console.log(`[Historical Stats] Fetching statistics for slug: ${slug}`);
    const statsRes = await wfmRequest(`/v1/items/${slug}/statistics`);
    if (statsRes && statsRes.payload && statsRes.payload.statistics_closed) {
      const stats90 = statsRes.payload.statistics_closed['90days'];
      if (stats90 && stats90.length > 0) {
        const latestStat = stats90[stats90.length - 1];
        const historicalMedian = latestStat.median;
        historicalStatsCache[slug] = {
          historicalMedian,
          updatedAt: Date.now()
        };
        console.log(`[Historical Stats] Cached historical median for ${slug}: ${historicalMedian} plat.`);
        return historicalMedian;
      }
    }
  } catch (err) {
    console.error(`[Historical Stats Error] Failed to fetch stats for ${slug}:`, err.message);
  }
  return null;
}

// 2. Worker to process price calculation queue
async function processPriceQueue() {
  if (priceQueue.length === 0) {
    isProcessingQueue = false;
    apiStats.queueLength = 0;
    return;
  }

  isProcessingQueue = true;
  apiStats.queueLength = priceQueue.length;

  // Respect rate-limit cooldown
  if (Date.now() < apiStats.rateLimitedUntil) {
    setTimeout(processPriceQueue, 1000);
    return;
  }

  const task = priceQueue.shift();
  const { slug, sourceOrder, isManual } = task;

  // Pre-emptively fetch and cache Mastery Rank in the background if not already cached
  if (itemBySlug[slug] && itemBySlug[slug].reqMasteryRank === undefined) {
    itemBySlug[slug].reqMasteryRank = null; // placeholder to prevent duplicate fetch
    if (itemById[itemBySlug[slug].id]) {
      itemById[itemBySlug[slug].id].reqMasteryRank = null;
    }
    wfmRequest(`/v2/items/${slug}`).then(itemDetail => {
      if (itemDetail && itemDetail.data) {
        const mr = itemDetail.data.reqMasteryRank || null;
        itemBySlug[slug].reqMasteryRank = mr;
        if (itemById[itemBySlug[slug].id]) {
          itemById[itemBySlug[slug].id].reqMasteryRank = mr;
        }
        console.log(`[Queue Mastery] Cached MR ${mr} for ${slug}`);
      }
    }).catch(err => {
      console.error(`[Queue Mastery Error] Failed to fetch MR for ${slug}:`, err.message);
    });
  }

  // Check if typical price cache is already populated and fresh (< 15 mins) for this specific variant
  const sourceKey = sourceOrder ? getOrderKey(slug, sourceOrder) : slug;
  const cached = typicalPriceCache[sourceKey];
  if (cached && (Date.now() - cached.updatedAt) < 15 * 60 * 1000 && !isManual) {
    // Already cached and fresh, re-evaluate the source order if provided
    if (sourceOrder) {
      evaluateOrder(sourceOrder, cached.typicalPrice);
    }
    setTimeout(processPriceQueue, 500); // 500ms between requests (2 req/s)
    return;
  }

  try {
    console.log(`[Queue] Fetching orders for slug: ${slug} (${isManual ? 'Manual Scan' : 'Background Scan'})`);
    const res = await wfmRequest(`/v2/orders/item/${slug}`);
    
    if (res.data) {
      // Filter for all visible SELL orders
      const allSellOrders = res.data.filter(o => 
        o.type === 'sell' && 
        o.visible === true && 
        o.user
      );

      if (allSellOrders.length > 0) {
        // Check if this item is a variant item (mods, arcanes, ayatan sculptures)
        const hasRankOrSubtype = allSellOrders.some(o => 
          (o.rank !== undefined && o.rank !== null) || 
          o.subtype || 
          (o.amberStars !== undefined && o.amberStars !== null)
        );

        // Dynamically compute and store the max rank of this item if it has ranks
        let maxRank = 0;
        allSellOrders.forEach(order => {
          if (order.rank !== undefined && order.rank !== null && order.rank > maxRank) {
            maxRank = order.rank;
          }
        });
        if (maxRank > 0) {
          itemMaxRanks[slug] = maxRank;
        }

        // Fetch historical statistics if the item is rank-less
        let historicalMedian = null;
        if (!hasRankOrSubtype) {
          historicalMedian = await getHistoricalMedian(slug);
        }

        // Group active and offline sell orders by variant composite keys
        const activeOrdersByVariant = {};
        const offlineOrdersByVariant = {};

        allSellOrders.forEach(order => {
          const vKey = getOrderKey(slug, order);
          const status = order.user.status;

          if (status === 'ingame' || status === 'online') {
            if (!activeOrdersByVariant[vKey]) {
              activeOrdersByVariant[vKey] = [];
            }
            activeOrdersByVariant[vKey].push(order);
          } else if (status === 'offline') {
            if (!offlineOrdersByVariant[vKey]) {
              offlineOrdersByVariant[vKey] = [];
            }
            offlineOrdersByVariant[vKey].push(order);
          }
        });

        // Loop through all unique variant keys found in our orders (both active and offline)
        const allKeys = new Set([...Object.keys(activeOrdersByVariant), ...Object.keys(offlineOrdersByVariant)]);

        // 1. Compute Rank 0 typical price first (if applicable) to act as a safety cap for intermediate ranks
        const rank0Key = slug + '_r0';
        let rank0Typical = 0;

        if (maxRank > 0 && allKeys.has(rank0Key)) {
          const activeOrders = activeOrdersByVariant[rank0Key] || [];
          const offlineOrders = offlineOrdersByVariant[rank0Key] || [];
          
          activeOrders.sort((a, b) => a.platinum - b.platinum);
          offlineOrders.sort((a, b) => a.platinum - b.platinum);
          
          const activeLowest = activeOrders.slice(0, 5).map(o => o.platinum);
          const activeMedian = calculateMedian(activeLowest);
          const offlineLowest = offlineOrders.slice(0, 10).map(o => o.platinum);
          const offlineMedian = calculateMedian(offlineLowest);
          
          rank0Typical = activeMedian;
          if (rank0Typical === 0 && offlineMedian > 0) {
            rank0Typical = offlineMedian;
          }
          
          // Apply standard Caps 1 & 2 to the Rank 0 variant first
          if (rank0Typical > 0) {
            if (offlineMedian > 0 && rank0Typical > 1.5 * offlineMedian) {
              rank0Typical = Math.min(rank0Typical, Math.max(1, Math.round(offlineMedian * 1.3)));
            }
            if (historicalMedian > 0 && rank0Typical > 1.5 * historicalMedian) {
              rank0Typical = Math.min(rank0Typical, Math.max(1, Math.round(historicalMedian * 1.3)));
            }
          }
        }

        // 2. Loop and calculate typical price for all variants
        for (const vKey of allKeys) {
          const activeOrders = activeOrdersByVariant[vKey] || [];
          const offlineOrders = offlineOrdersByVariant[vKey] || [];

          // Sort by price ascending
          activeOrders.sort((a, b) => a.platinum - b.platinum);
          offlineOrders.sort((a, b) => a.platinum - b.platinum);

          // Compute active typical price: median of lowest 5 active (ingame + online) listings
          const activeLowest = activeOrders.slice(0, 5).map(o => o.platinum);
          const activeMedian = calculateMedian(activeLowest);

          // Compute offline typical price: median of lowest 10 offline listings
          const offlineLowest = offlineOrders.slice(0, 10).map(o => o.platinum);
          const offlineMedian = calculateMedian(offlineLowest);

          // Compute absolute minimum offline price
          const minOfflinePrice = offlineOrders.length > 0 ? offlineOrders[0].platinum : null;

          let typicalPrice = activeMedian;

          // If there are no active sellers, fallback to offline median
          if (typicalPrice === 0 && offlineMedian > 0) {
            typicalPrice = offlineMedian;
          }

          // Intelligent Capping Controls to avoid false positives!
          if (typicalPrice > 0) {
            // Cap 1: Offline Safety Floor (applies to all items including mods/arcanes at their specific rank)
            if (offlineMedian > 0 && typicalPrice > 1.5 * offlineMedian) {
              const capped = Math.max(1, Math.round(offlineMedian * 1.3));
              console.log(`[Intelligent Cap] Variant ${vKey} active online median (${typicalPrice}) is > 1.5x of offline median (${offlineMedian}). Capping typical to ${capped} plat.`);
              typicalPrice = Math.min(typicalPrice, capped);
            }

            // Cap 2: Historical Closed Trades Stats (applies only to rank-less items)
            if (!hasRankOrSubtype && historicalMedian > 0 && typicalPrice > 1.5 * historicalMedian) {
              const capped = Math.max(1, Math.round(historicalMedian * 1.3));
              console.log(`[Intelligent Cap] Item ${slug} active online median (${typicalPrice}) is > 1.5x of historical trade median (${historicalMedian}). Capping typical to ${capped} plat.`);
              typicalPrice = Math.min(typicalPrice, capped);
            }

            // Cap 3: Intermediate Rank Capping (for 0 < rank < maxRank mods and arcanes)
            const rankMatch = vKey.match(/_r(\d+)$/);
            if (rankMatch) {
              const rankVal = parseInt(rankMatch[1]);
              const isDefinitelyIntermediate = [1, 2, 4, 6, 7, 9].includes(rankVal) || (rankVal > 0 && rankVal < maxRank);
              if (isDefinitelyIntermediate && rank0Typical > 0) {
                console.log(`[Intelligent Cap] Variant ${vKey} is determined to be an intermediate rank. Capping its typical price at Rank 0 typical price (${rank0Typical} plat) to protect against low-liquidity inflation.`);
                typicalPrice = Math.min(typicalPrice, rank0Typical);
              }
            }
          }

          if (typicalPrice > 0) {
            typicalPriceCache[vKey] = {
              typicalPrice,
              offlineMedian: offlineMedian > 0 ? offlineMedian : null,
              minOfflinePrice: minOfflinePrice !== null ? minOfflinePrice : null,
              updatedAt: Date.now()
            };
          }
        }

        apiStats.cacheSize = Object.keys(typicalPriceCache).length;
        saveTypicalPriceCacheDebounced();

        // 2. Evaluate the source order if there is one
        if (sourceOrder) {
          const sourceKey = getOrderKey(slug, sourceOrder);
          const cacheEntry = typicalPriceCache[sourceKey];
          if (cacheEntry && cacheEntry.typicalPrice !== null) {
            evaluateOrder(sourceOrder, cacheEntry.typicalPrice, cacheEntry.offlineMedian);
          }
        }

        // 3. Scan ALL sell orders we just fetched to evaluate for hidden deals!
        // We only scan sell orders from players ONLINE IN GAME
        allSellOrders.forEach(order => {
          if (order.user.status === 'ingame') {
            const vKey = getOrderKey(slug, order);
            const cacheEntry = typicalPriceCache[vKey];
            if (cacheEntry && cacheEntry.typicalPrice !== null) {
              evaluateOrder({
                id: order.id,
                type: 'sell',
                platinum: order.platinum,
                itemId: sourceOrder ? sourceOrder.itemId : (itemBySlug[slug] ? itemBySlug[slug].id : order.itemId),
                user: order.user,
                rank: order.rank,
                subtype: order.subtype,
                amberStars: order.amberStars,
                cyanStars: order.cyanStars
              }, cacheEntry.typicalPrice, cacheEntry.offlineMedian);
            }
          }
        });
      }
    }
  } catch (err) {
    console.error(`[Queue Error] Failed to compute typical price for ${slug}:`, err.message);
  }

  // Next task after 500ms
  setTimeout(processPriceQueue, 500);
}

// Queue helper
function queuePriceCalculation(slug, sourceOrder = null, isManual = false) {
  const existingIndex = priceQueue.findIndex(t => t.slug === slug);
  if (existingIndex !== -1) {
    if (isManual) {
      // Move to front!
      const [task] = priceQueue.splice(existingIndex, 1);
      task.isManual = true;
      if (sourceOrder) task.sourceOrder = sourceOrder;
      priceQueue.unshift(task);
    }
  } else {
    if (isManual) {
      // manual scans are placed at the FRONT of the queue for instant results
      priceQueue.unshift({ slug, sourceOrder, isManual });
    } else {
      priceQueue.push({ slug, sourceOrder, isManual });
    }
  }
  apiStats.queueLength = priceQueue.length;

  if (!isProcessingQueue) {
    processPriceQueue();
  }
}

// 3. Evaluates if an order is a sniper deal
function evaluateOrder(order, typicalPrice = null, offlineMedian = null) {
  // We only care about sell orders
  if (order.type !== 'sell') return;

  const itemInfo = itemById[order.itemId];
  if (!itemInfo) return;

  // Deferred Mastery Rank fetch if not cached yet
  if (itemInfo.reqMasteryRank === undefined) {
    itemInfo.reqMasteryRank = null; // placeholder to prevent duplicate fetches
    if (itemBySlug[itemInfo.slug]) {
      itemBySlug[itemInfo.slug].reqMasteryRank = null;
    }
    wfmRequest(`/v2/items/${itemInfo.slug}`).then(itemDetail => {
      if (itemDetail && itemDetail.data) {
        const mr = itemDetail.data.reqMasteryRank || null;
        itemInfo.reqMasteryRank = mr;
        if (itemBySlug[itemInfo.slug]) {
          itemBySlug[itemInfo.slug].reqMasteryRank = mr;
        }
        // Update any matching deals in place
        deals.forEach(deal => {
          if (deal.itemId === order.itemId) {
            deal.reqMasteryRank = mr;
          }
        });
        console.log(`[Deferred Mastery] Retrieved and cached MR ${mr} for ${itemInfo.slug}`);
      }
    }).catch(err => {
      console.error(`[Deferred Mastery Error] Failed to fetch MR for ${itemInfo.slug}:`, err.message);
    });
  }

  const price = order.platinum;

  // Resolve typical prices and offline bounds from the cache for 100% robustness and consistency
  const vKey = getOrderKey(itemInfo.slug, order);
  const cacheEntry = typicalPriceCache[vKey];
  if (!cacheEntry || cacheEntry.typicalPrice === null) return;

  const resolvedTypicalPrice = cacheEntry.typicalPrice;
  const resolvedOfflineMedian = cacheEntry.offlineMedian;
  const resolvedMinOfflinePrice = cacheEntry.minOfflinePrice;

  // A deal is when the price is lower than typicalPrice
  if (price >= resolvedTypicalPrice) return;

  // Safety filter: The online price must be strictly less than the typical offline price (offline median)
  // to protect against deals that are more expensive than normal offline listings.
  if (resolvedOfflineMedian > 0 && price >= resolvedOfflineMedian) {
    return;
  }

  // Strict offline check: if a player lists it for cheaper or equal offline, it is NOT a deal!
  if (resolvedMinOfflinePrice !== null && price >= resolvedMinOfflinePrice) {
    return;
  }

  const margin = resolvedTypicalPrice - price;
  const discount = Math.round((margin / resolvedTypicalPrice) * 100);

  // Thresholds for a sniper deal:
  // - Minimum 20% discount
  // - Minimum 3 platinum profit
  if (discount >= 20 && margin >= 3) {
    const { variantName, whisperItemName } = getVariantDetails(itemInfo.slug, order, itemInfo.name);

    // Construct Copy-Paste Whisper
    const whisper = `/w ${order.user.ingameName} Hi! I want to buy: ${whisperItemName} for ${price} platinum. (warframe.market)`;

    // Arcane fusion arbitrage calculation has been removed per user feedback (highly volatile and misleading prices)
    let arcaneFusionArbitrage = null;

    // Check if we already have this exact order deal
    const existingIndex = deals.findIndex(d => d.id === order.id);

    const maxRank = itemMaxRanks[itemInfo.slug] || 0;

    const dealObj = {
      id: order.id,
      itemId: order.itemId,
      slug: itemInfo.slug,
      name: itemInfo.name,
      thumb: itemInfo.thumb,
      price,
      typicalPrice: resolvedTypicalPrice,
      discount,
      margin,
      user: {
        ingameName: order.user.ingameName,
        reputation: order.user.reputation || 0,
        status: order.user.status
      },
      rank: order.rank,
      maxRank,
      subtype: order.subtype,
      amberStars: order.amberStars,
      cyanStars: order.cyanStars,
      variantName: variantName,
      copyWhisper: whisper,
      arcaneFusionArbitrage,
      spottedAt: Date.now(),
      reqMasteryRank: itemInfo.reqMasteryRank
    };

    if (existingIndex !== -1) {
      // Update existing deal
      deals[existingIndex] = dealObj;
    } else {
      // Add new deal
      deals.push(dealObj);
      apiStats.dealsFoundCount++;
      console.log(`[DEAL SNIPED] ${variantName} for ${price} plat! Typical: ${resolvedTypicalPrice} plat (Discount: ${discount}%, Margin: +${margin} plat, Min Offline: ${resolvedMinOfflinePrice || 'N/A'}, Offline Median: ${resolvedOfflineMedian || 'N/A'}) by ${order.user.ingameName}`);
    }
  }
}

// 4. Background Scan - Poll Recent Orders
async function scanRecentOrders() {
  if (Date.now() < apiStats.rateLimitedUntil) {
    console.log('[Scanner] Skipping recent orders poll due to active rate-limit cooldown...');
    return;
  }

  try {
    console.log('[Scanner] Checking recent orders feed...');
    const res = await wfmRequest('/v2/orders/recent');
    
    if (res.data && res.data.length > 0) {
      console.log(`[Scanner] Received ${res.data.length} recent orders.`);
      let ingameSells = 0;

      res.data.forEach(order => {
        // We only care about visible sell orders from players ONLINE IN GAME
        if (
          order.type === 'sell' && 
          order.visible === true && 
          order.user && 
          order.user.status === 'ingame'
        ) {
          ingameSells++;
          const itemInfo = itemById[order.itemId];
          if (itemInfo) {
            const vKey = getOrderKey(itemInfo.slug, order);
            const cached = typicalPriceCache[vKey];
            if (cached && (Date.now() - cached.updatedAt) < 30 * 60 * 1000) {
              // We have a fresh cached price! Evaluate instantly.
              evaluateOrder(order, cached.typicalPrice);
            } else {
              // No typical price or it is expired. Queue it up.
              queuePriceCalculation(itemInfo.slug, order);
            }
          }
        }
      });
      console.log(`[Scanner] Processed ${ingameSells} online-in-game sell orders from feed.`);
    }
  } catch (err) {
    console.error('[Scanner Error] Failed to scan recent orders:', err.message);
  }
}

// 5. Cleanup task: Expire old deals and verify active deals against actual WFM status
async function cleanupDeals() {
  const now = Date.now();
  
  // 1. Filter out deals older than 15 minutes
  const prevCount = deals.length;
  deals = deals.filter(deal => (now - deal.spottedAt) < 15 * 60 * 1000);
  
  if (deals.length !== prevCount) {
    console.log(`[Cleanup] Expired ${prevCount - deals.length} older deal listings.`);
  }

  // 2. Periodically clean up items in cache older than 12 hours to save memory
  const cacheKeys = Object.keys(typicalPriceCache);
  let cacheDeletedCount = 0;
  cacheKeys.forEach(slug => {
    if ((now - typicalPriceCache[slug].updatedAt) > 12 * 60 * 60 * 1000) {
      delete typicalPriceCache[slug];
      cacheDeletedCount++;
    }
  });
  apiStats.cacheSize = Object.keys(typicalPriceCache).length;
  if (cacheDeletedCount > 0) {
    saveTypicalPriceCacheDebounced();
  }
}

// API Endpoints
app.get('/api/items', (req, res) => {
  res.json(itemList);
});

app.get('/api/deals', (req, res) => {
  // Sort deals by discount percentage descending, then margin descending
  const sortedDeals = [...deals].sort((a, b) => {
    if (b.discount !== a.discount) return b.discount - a.discount;
    return b.margin - a.margin;
  });
  res.json(sortedDeals);
});

app.get('/api/status', (req, res) => {
  res.json({
    ...apiStats,
    rateLimited: Date.now() < apiStats.rateLimitedUntil,
    cooldownMsLeft: Math.max(0, apiStats.rateLimitedUntil - Date.now())
  });
});

app.post('/api/scan', (req, res) => {
  const { slug } = req.body;
  if (!slug) {
    return res.status(400).json({ error: 'Slug is required' });
  }

  const itemInfo = itemBySlug[slug];
  if (!itemInfo) {
    return res.status(404).json({ error: 'Item not found in database' });
  }

  // Enqueue manual high-priority price calculation
  queuePriceCalculation(slug, null, true);
  res.json({ message: `High priority scan for ${itemInfo.name} queued successfully.` });
});

// Manual typical price delete/reset endpoint
app.post('/api/clear-deals', (req, res) => {
  deals = [];
  res.json({ message: 'Active deals cleared.' });
});

// Default to serve index.html for any frontend routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialization
async function startServer() {
  console.log('=============================================');
  console.log('      WARFRAME MARKET DEAL SNIPER SERVER     ');
  console.log('=============================================');
  
  await initItemsManifest();
  loadTypicalPriceCache();

  let currentPort = PORT;
  function startListening(port) {
    const server = app.listen(port, () => {
      console.log(`Server is running at http://localhost:${port}`);
      global.activeExpressPort = port;
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${port} is already in use. Retrying on port ${port + 1}...`);
        startListening(port + 1);
      } else {
        console.error('Server failed to start:', err);
      }
    });
  }
  startListening(currentPort);

  // Run first background scan immediately
  scanRecentOrders();

  // Schedule background jobs
  setInterval(scanRecentOrders, 60 * 1000); // Scan recent orders every 60s
  setInterval(cleanupDeals, 5 * 60 * 1000);  // Cleanup stale deals every 5 mins
}

startServer();
