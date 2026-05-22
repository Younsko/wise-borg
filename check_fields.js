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
    console.log("Fetching recent orders...");
    const res = await fetchJson('https://api.warframe.market/v2/orders/recent');
    if (res.data && res.data.length > 0) {
      console.log(`Fetched ${res.data.length} recent orders.`);
      const uniqueKeys = new Set();
      const uniqueSubtypes = new Set();
      
      res.data.forEach(order => {
        Object.keys(order).forEach(key => uniqueKeys.add(key));
        if (order.subtype) {
          uniqueSubtypes.add(order.subtype);
        }
      });
      
      console.log("All unique keys in orders:", Array.from(uniqueKeys));
      if (uniqueSubtypes.size > 0) {
        console.log("Found subtypes:", Array.from(uniqueSubtypes));
      } else {
        console.log("No 'subtype' field found in recent orders.");
      }
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
