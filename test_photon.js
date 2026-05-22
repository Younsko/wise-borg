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
    console.log("Fetching active orders for photon_repeater...");
    const res = await fetchJson('https://api.warframe.market/v2/orders/item/photon_repeater');
    if (res.data && res.data.length > 0) {
      console.log("Total orders returned:", res.data.length);
      const ingameSells = res.data.filter(o => o.type === 'sell' && o.user.status === 'ingame');
      console.log("Total ingame sells:", ingameSells.length);
      ingameSells.forEach(o => {
        console.log(`Seller: ${o.user.ingameName}, Price: ${o.platinum}, Quantity: ${o.quantity}`);
      });
    } else {
      console.log("No data returned or empty array.");
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
