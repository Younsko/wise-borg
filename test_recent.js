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
      console.log("Total recent orders returned:", res.data.length);
      console.log("Sample recent order:", JSON.stringify(res.data[0], null, 2));
      
      const sellOrders = res.data.filter(o => o.type === 'sell');
      console.log("Sample sell recent order:", JSON.stringify(sellOrders[0], null, 2));
    } else {
      console.log("No data returned or empty array.");
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
