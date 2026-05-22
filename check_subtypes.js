const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Platform': 'pc',
        'Crossplay': 'true'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    // First, let's fetch all items to map item IDs to names
    const itemsRes = await fetchJson('https://api.warframe.market/v2/items');
    const itemById = {};
    itemsRes.data.forEach(item => {
      itemById[item.id] = item.i18n.en.name;
    });

    console.log("Fetching recent orders...");
    const res = await fetchJson('https://api.warframe.market/v2/orders/recent');
    if (res.data && res.data.length > 0) {
      const ordersWithSubtype = res.data.filter(o => o.subtype);
      console.log(`Found ${ordersWithSubtype.length} orders with subtype.`);
      ordersWithSubtype.slice(0, 10).forEach(order => {
        console.log(`Item Name: ${itemById[order.itemId] || order.itemId}`);
        console.log(`Order:`, JSON.stringify(order, null, 2));
      });
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
