#!/usr/bin/env node

import {chromium} from 'playwright';
import {createWriteStream, existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import pLimit from 'p-limit';

interface VimeoDownload {
  type: string;
  width?: number;
  height?: number;
  link?: string;
}

interface VimeoItem {
  video?: {
    uri?: string;
    name?: string;
    metadata?: {
      connections?: {
        versions?: {
          current_uri?: string;
        };
      };
    };
  };
}

interface VimeoItemsResponse {
  data: VimeoItem[];
  paging?: {
    next?: string | null;
  };
}

const folderUrl = process.argv[2];
const outputDir = process.argv[3] || './downloads';

if (!folderUrl) {
  console.error('Usage: download-vimeo-folder <vimeo-review-url> [output-dir]');
  process.exit(1);
}

await mkdir(outputDir, {recursive: true});

console.log('Launching browser to discover video list...');
const browser = await chromium.launch({headless: true});
const page = await browser.newPage();

// Collect folder items (video metadata) and per-video download links
let itemsData = null as VimeoItemsResponse | null;
const downloadsByVideoId = new Map<string, VimeoDownload[]>();
let authToken = null as string | null;

page.on('request', (request) => {
  const url = request.url();
  if (url.includes('api.vimeo.com')) {
    const auth = request.headers()['authorization'];
    if (auth) authToken = auth;
  }
});

page.on('response', async (response) => {
  const url = response.url();
  if (response.status() !== 200) return;

  try {
    // Capture the /items response (folder listing with video names)
    if (url.includes('/items') && url.includes('api.vimeo.com')) {
      const json = await response.json();
      itemsData = json as VimeoItemsResponse;
    }

    // Capture /downloads responses (per-video download links)
    const downloadsMatch = url.match(/\/videos\/(\d+)\/versions\/\d+\/downloads/);
    if (downloadsMatch) {
      const videoId = downloadsMatch[1]!;
      const json = await response.json();
      downloadsByVideoId.set(videoId, json.download || []);
    }
  } catch {}
});

await page.goto(folderUrl, {waitUntil: 'networkidle', timeout: 60000});
// Give extra time for lazy-loaded API responses
await page.waitForTimeout(5000);

// If there are more pages of items, paginate
if (itemsData && authToken && itemsData.paging?.next) {
  console.log('Fetching additional pages...');
  let nextUrl = itemsData.paging.next;
  while (nextUrl) {
    const fullUrl = nextUrl.startsWith('http') ? nextUrl : `https://api.vimeo.com${nextUrl}`;
    const resp = await fetch(fullUrl, {
      headers: {Authorization: authToken, Accept: 'application/json'},
    });
    if (!resp.ok) break;
    const json = await resp.json();
    if (json.data) itemsData.data.push(...json.data);
    nextUrl = json.paging?.next || null;
  }
}

await browser.close();

if (!itemsData?.data?.length) {
  console.error('Failed to discover videos. Make sure the URL is a valid Vimeo review page.');
  process.exit(1);
}

// Build the video list from items
const videos: Array<{videoId: string; name: string}> = [];
for (const item of itemsData.data) {
  const video = item.video;
  if (!video) continue;
  const videoId = video.uri?.split('/').pop();
  if (!videoId) continue;
  const name = video.name || `video_${videoId}`;
  videos.push({videoId, name});
}

console.log(`Found ${videos.length} video(s)\n`);

// For any videos whose downloads weren't captured yet, fetch them
const reviewIdMatch = folderUrl.match(/reviews\/([a-f0-9-]+)/);
const reviewId = reviewIdMatch?.[1];

for (const v of videos) {
  if (!downloadsByVideoId.has(v.videoId) && authToken && reviewId) {
    // We need the version ID; look it up from the item data
    const item = itemsData.data.find((i: VimeoItem) => i.video?.uri?.endsWith(`/${v.videoId}`));
    const versionUri = item?.video?.metadata?.connections?.versions?.current_uri;
    const versionId = versionUri?.split('/').pop();
    if (versionId) {
      try {
        const resp = await fetch(
          `https://api.vimeo.com/videos/${v.videoId}/versions/${versionId}/downloads?review_id=${reviewId}`,
          {headers: {Authorization: authToken, Accept: 'application/json'}},
        );
        if (resp.ok) {
          const json = await resp.json();
          downloadsByVideoId.set(v.videoId, json.download || []);
        }
      } catch {}
    }
  }
}

// Download videos (5 in parallel)
let downloaded = 0;
const limit = pLimit(5);

const downloadTasks = videos.map((v, i) =>
  limit(async () => {
    const {videoId, name} = v;
    const downloads = downloadsByVideoId.get(videoId) || [];

    // Pick the highest resolution
    const best = downloads
      .filter((d) => d.type === 'video/mp4')
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    if (!best?.link) {
      console.log(`[${i + 1}/${videos.length}] "${name}" — no download link, skipping`);
      return;
    }

    const filename = sanitize(name) + '.mp4';
    const filepath = join(outputDir, filename);

    if (existsSync(filepath)) {
      console.log(`[${i + 1}/${videos.length}] "${name}" — already exists, skipping`);
      downloaded++;
      return;
    }

    console.log(
      `[${i + 1}/${videos.length}] "${name}" (${best.width}x${best.height}) — downloading...`,
    );

    const resp = await fetch(best.link);
    if (!resp.ok) {
      console.log(`[${i + 1}/${videos.length}] "${name}" ✗ Download failed (${resp.status})`);
      return;
    }

    await pipeline(Readable.fromWeb(resp.body! as any), createWriteStream(filepath));

    const sizeMB = existsSync(filepath)
      ? ((await import('node:fs')).statSync(filepath).size / 1048576).toFixed(1)
      : '?';
    console.log(`[${i + 1}/${videos.length}] "${name}" ✓ done (${sizeMB} MB)`);
    downloaded++;
  }),
);

await Promise.all(downloadTasks);

console.log(`\nDone! Downloaded ${downloaded} video(s) to ${outputDir}`);

function sanitize(name: string) {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
