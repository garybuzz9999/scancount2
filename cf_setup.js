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
    // Maybe already exists - list and find
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
  
  // Save namespace ID for worker deploy
  fs.writeFileSync('kv_namespace_id.txt', nsId);
  
  // 2. Upload products in bulk batches of 10000
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
      if(r.success) {
        success = true;
        break;
      }
      console.log(`Retry ${attempt+1}:`, JSON.stringify(r.errors));
      await sleep(2000);
    }
    
    done += chunk.length;
    console.log(`✅ ${done} / ${products.length}`);
    await sleep(200);
  }
  
  // 3. Deploy Worker
  console.log('Deploying worker...');
  const workerCode = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const ean = url.pathname.slice(1).trim();
    if(!ean) return new Response('EAN required', {status: 400});
    
    const data = await env.BARCODES.get(ean);
    if(!data) return new Response(JSON.stringify({found: false}), {
      headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}
    });
    
    const product = JSON.parse(data);
    return new Response(JSON.stringify({found: true, ...product}), {
      headers: {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}
    });
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
    console.log('✅ Worker deployed!');
    console.log('URL: https://scancount-barcode.' + ACCOUNT.slice(0,8) + '.workers.dev');
  } else {
    console.log('Worker error:', JSON.stringify(wData.errors));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
