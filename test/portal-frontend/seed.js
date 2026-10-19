// Puts the test objects in the two Garage buckets through the API of S3-Browser (PUT /s3).
const { request } = require('playwright');
const BASE = process.env.BASE;

const md = `# Quarterly report\n\nThe numbers of **Q3 2026**, by region.\n\n| Region | Orders | Revenue |\n| --- | ---: | ---: |\n| North | 1,204 | 48,310 |\n| South | 987 | 39,072 |\n\n\`\`\`sql\nSELECT region, count() FROM orders GROUP BY region;\n\`\`\`\n\n> Figures are provisional.\n`;
const csv = 'date,region,orders,revenue\n' + Array.from({ length: 120 }, (_, i) => `2026-09-${String(1 + (i % 30)).padStart(2, '0')},${['North', 'South', 'East', 'West'][i % 4]},${100 + (i * 37) % 400},${(4000 + (i * 911) % 9000).toFixed(2)}`).join('\n') + '\n';
const json = JSON.stringify({ service: 'ingest', version: 3, replicas: 2, limits: { cpu: '500m', memory: '256Mi' }, regions: ['eu-west', 'us-east'], enabled: true, notes: null }, null, 2);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1d2b44"/><circle cx="420" cy="150" r="90" fill="#356fe6"/><rect x="80" y="220" width="300" height="60" rx="12" fill="#93b4ff"/></svg>';
const go = 'package main\n\nimport "fmt"\n\n// main prints a greeting.\nfunc main() {\n\tfmt.Println("hello, bucket")\n}\n';

const objects = {
  'garage-main': {
    'reports/2026/q3/summary.md': md,
    'reports/2026/q3/orders.csv': csv,
    'reports/2026/q2/summary.md': md.replace('Q3', 'Q2'),
    'reports/2026/q1/summary.md': md.replace('Q3', 'Q1'),
    'reports/2025/annual.md': md.replace('Quarterly', 'Annual'),
    'config/ingest.json': json,
    'config/app.yaml': 'service: ingest\nreplicas: 2\nlimits:\n  cpu: 500m\n',
    'images/banner.svg': svg,
    'src/main.go': go,
    'logs/2026-10-18.log': Array.from({ length: 200 }, (_, i) => `2026-10-18T10:${String(i % 60).padStart(2, '0')}:00Z INFO request ${i} served in ${(i * 7) % 90} ms`).join('\n'),
    'archive/deep/level-3/level-4/level-5/notes.md': '# Deep notes\n\nA file five folders down.\n',
    'README.md': '# Main bucket\n\nTest data of the portal interface.\n',
    'big/blob-6mb.bin': 'x'.repeat(6 * 1024 * 1024),
  },
  'garage-archive': {
    'backups/2026-10-01.tar': 'backup'.repeat(20000),
    'backups/2026-10-08.tar': 'backup'.repeat(26000),
    'exports/users.csv': 'id,name\n1,Ada\n2,Grace\n',
  }
};

(async () => {
  const api = await request.newContext({ baseURL: BASE });
  for (const [instance, files] of Object.entries(objects)) {
    for (const [key, body] of Object.entries(files)) {
      const type = key.endsWith('.svg') ? 'image/svg+xml' : key.endsWith('.json') ? 'application/json' : key.endsWith('.md') ? 'text/markdown' : key.endsWith('.csv') ? 'text/csv' : 'application/octet-stream';
      const res = await api.put(`s3?instance=${encodeURIComponent(instance)}&key=${encodeURIComponent(key)}`, { data: Buffer.from(body), headers: { 'Content-Type': type } });
      if (!res.ok()) throw new Error(`${instance}/${key}: ${res.status()} ${await res.text()}`);
    }
  }
  console.log('seeded');
  await api.dispose();
})().catch(e => { console.error(e); process.exit(1); });
