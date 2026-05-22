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

async function testItem(slug) {
  try {
    console.log(`\n--- Active orders for ${slug} ---`);
    const res = await fetchJson(`https://api.warframe.market/v2/orders/item/${slug}`);
    if (res.data && res.data.length > 0) {
      console.log("Total orders:", res.data.length);
      const sellOrders = res.data.filter(o => o.type === 'sell' && o.user.status === 'ingame');
      console.log("Total ingame sell orders:", sellOrders.length);
      if (sellOrders.length > 0) {
        console.log("Sample sell order fields:", Object.keys(sellOrders[0]));
        console.log("Sample sell order values:", JSON.stringify(sellOrders[0], null, 2));
      }
    }
  } catch (err) {
    console.error(`Error for ${slug}:`, err.message);
  }
}

async function main() {
  await testItem('blind_rage');
  await testItem('arcane_energize');
  await testItem('ayatan_anasa_sculpture');
}

main();
