const fs = require('fs');

const data = JSON.parse(fs.readFileSync('items_cache.json', 'utf-8'));
const ayatans = data.filter(item => item.i18n.en.name.toLowerCase().includes('ayatan'));
console.log(`Found ${ayatans.length} Ayatan items in cache.`);
ayatans.forEach(item => {
  console.log(`ID: ${item.id}, Name: ${item.i18n.en.name}, Slug: ${item.slug}`);
});
