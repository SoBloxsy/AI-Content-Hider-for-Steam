const https = require('https');
const fs = require('fs');
const path = require('path');

const TARGET_COUNT = 100;
const OUTPUT_FILE = path.join(__dirname, 'seed_disclosures.json');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          Cookie: 'birthtime=283993201; mature_content=1; wants_mature_content=1',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchUrl(res.headers.location));
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

async function collectAppIds() {
  const queryTerms = [
    'AI',
    'Artificial Intelligence',
    'Generated',
    'ChatGPT',
    'DeepL',
    'Machine Translation',
    'Diffusion',
    'Midjourney',
    'Voiceover',
    'Copilot',
  ];

  const appIds = new Set();
  console.log('Querying Steam search for candidate AppIDs...');

  for (const term of queryTerms) {
    if (appIds.size >= 400) break;
    try {
      const url = `https://store.steampowered.com/search/?term=${encodeURIComponent(term)}&category1=998`;
      const html = await fetchUrl(url);
      const matches = [...html.matchAll(/href="https:\/\/store\.steampowered\.com\/app\/(\d+)/g)];
      for (const m of matches) {
        appIds.add(m[1]);
      }
      console.log(`Term "${term}": total pool is now ${appIds.size} AppIDs`);
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      console.error(`Error querying term ${term}:`, e.message);
    }
  }

  return [...appIds];
}

function extractAiDisclosure(html) {
  const headingIdx = html.indexOf('AI Generated Content Disclosure');
  if (headingIdx === -1) return null;

  const slice = html.substring(headingIdx, headingIdx + 1500);
  const match = slice.match(/<i>([\s\S]*?)<\/i>/i);
  if (match) {
    return match[1]
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }
  return null;
}

async function run() {
  const candidateIds = await collectAppIds();
  console.log(`\nTesting ${candidateIds.length} candidate AppIDs for AI disclosures...`);

  const results = [];
  const CONCURRENCY = 5;
  let index = 0;

  async function worker() {
    while (index < candidateIds.length && results.length < TARGET_COUNT) {
      const appId = candidateIds[index++];
      try {
        const storeUrl = `https://store.steampowered.com/app/${appId}/?l=english`;
        const html = await fetchUrl(storeUrl);
        const disclosure = extractAiDisclosure(html);

        if (disclosure) {
          const titleMatch = html.match(/<div class="apphub_AppName">([^<]+)<\/div>/);
          const title = titleMatch ? titleMatch[1].trim() : `App ${appId}`;

          results.push({
            appId,
            title,
            disclosure,
          });
          console.log(`[${results.length}/${TARGET_COUNT}] Found AI disclosure for: "${title}" (${appId})`);
        }
      } catch (err) {
        // Continue silently on error/timeout
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\nFinished! Found ${results.length} games with verified AI disclosures.`);
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');
}

run();
