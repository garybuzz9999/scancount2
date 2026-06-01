const fetch = require('node-fetch');
const fs = require('fs');
const TOKEN = process.env.CF_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT;
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function main() {
  // 1. Create KV namespace
  console.log('Creating KV namespace...');
  let kv = await api('POST', '/storage/kv/namespaces', { title: 'BARCODES' });
  
  let nsId;
  if(kv.success) {
    nsId = kv.result.id;
    console.log('KV created:', nsId);
  } else {
    console.log('KV error:', JSON.stringify(kv.errors));
    const list = await api('GET', '/storage/kv/namespaces');
    const existing = list.result?.find(n => n.title === 'BARCODES');
    if(existing) {
      nsId = existing.id;
      console.log('Using existing KV:', nsId);
    } else {
      throw new Error('Cannot create or find KV namespace');
    }
  }
  
  fs.writeFileSync('kv_namespace_id.txt', nsId);
  
  // 2. Upload products
  const products = JSON.parse(fs.readFileSync('products.json', 'utf8'));
  console.log(`Uploading ${products.length} products...`);
  
  const BATCH = 5000;
  let done = 0;
  
  for(let i = 0; i < products.length; i += BATCH) {
    const chunk = products.slice(i, i + BATCH).map(p => ({
      key: p.ean,
      value: JSON.stringify({ title: p.title, unit: p.unit })
    }));
    
    let success = false;
    for(let attempt = 0; attempt < 3; attempt++) {
      const r = await api('PUT', `/storage/kv/namespaces/${nsId}/bulk`, chunk);
      if(r.success) { success = true; break; }
      console.log(`Retry ${attempt+1}:`, JSON.stringify(r.errors));
      await sleep(2000);
    }
    
    done += chunk.length;
    console.log(`✅ ${done} / ${products.length}`);
    await sleep(200);
  }
  
  // 3. Deploy Worker з Listex парсингом
  console.log('Deploying worker...');
  const workerCode = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ean = url.pathname.slice(1).trim();

    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    };

    if (!ean || ean.length < 4) {
      return new Response(JSON.stringify({ found: false }), { headers });
    }

    // 1. Основна KV база (41к товарів)
    const kvVal = await env.BARCODES.get(ean);
    if (kvVal) {
      const data = JSON.parse(kvVal);
      return new Response(JSON.stringify({ found: true, ...data, source: 'kv' }), { headers });
    }

    // 2. KV кеш Listex (раніше знайдені)
    const cached = await env.BARCODES.get('lx_' + ean);
    if (cached) {
      const data = JSON.parse(cached);
      return new Response(JSON.stringify({ found: true, ...data, source: 'cache' }), { headers });
    }

    // 3. Парсимо Listex
    try {
      const res = await fetch('https://listex.info/uk/search?barcode=' + ean, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'uk-UA,uk;q=0.9'
        },
        signal: AbortSignal.timeout(6000)
      });

      if (res.ok) {
        const html = await res.text();

        let title = '';

        // og:title
        const ogMatch = html.match(/property="og:title"[^>]+content="([^"]+)"/i)
                     || html.match(/content="([^"]+)"[^>]+property="og:title"/i);
        if (ogMatch) {
          title = ogMatch[1].replace(/\\s+на Listex\\.info.*/i, '').replace(/\\s*\\|.*$/, '').trim();
        }

        // h1
        if (!title || title.length < 3) {
          const h1 = html.match(/<h1[^>]*>([^<]+)<\\/h1>/i);
          if (h1) title = h1[1].trim();
        }

        const is404 = html.includes('СТОРІНКА НЕ ЗНАЙДЕНА') || html.includes('Нічого не знайдено');

        if (title && title.length > 3 && !is404) {
          let unit = 'шт';
          const t = title.toLowerCase();
          if (/\\d\\s*кг|kg/.test(t)) unit = 'кг';
          else if (/\\d\\s*г\\b/.test(t)) unit = 'г';
          else if (/\\d\\s*л\\b/.test(t)) unit = 'л';
          else if (/\\d\\s*мл|ml/.test(t)) unit = 'мл';

          // Кешуємо на 30 днів
          await env.BARCODES.put('lx_' + ean, JSON.stringify({ title, unit }), {
            expirationTtl: 60 * 60 * 24 * 30
          });

          return new Response(JSON.stringify({ found: true, title, unit, source: 'listex' }), { headers });
        }
      }
    } catch(e) {
      // Listex недоступний
    }

    // 4. Не знайдено
    return new Response(JSON.stringify({ found: false, ean }), { headers });
  }
};`;

  const metadata = {
    main_module: 'worker.js',
    bindings: [{
      type: 'kv_namespace',
      name: 'BARCODES',
      namespace_id: nsId
    }],
    compatibility_date: '2024-01-01'
  };

  const form = new (require('form-data'))();
  form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json', filename: 'metadata.json' });
  form.append('worker.js', workerCode, { contentType: 'application/javascript+module', filename: 'worker.js' });

  const wRes = await fetch(`${BASE}/workers/scripts/scancount-barcode`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${TOKEN}`, ...form.getHeaders() },
    body: form
  });
  const wData = await wRes.json();
  
  if(wData.success) {
    console.log('✅ Worker deployed з Listex парсингом!');
  } else {
    console.log('Worker error:', JSON.stringify(wData.errors));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
