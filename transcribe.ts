#!/usr/bin/env node

import {GoogleGenAI} from '@google/genai';
import {readdir, readFile, writeFile, unlink} from 'node:fs/promises';
import {join, basename, extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pLimit from 'p-limit';

const execFileAsync = promisify(execFile);

const inputDir = process.argv[2] || './downloads';
const apiKey = process.env['GEMINI_API_KEY'];

if (!apiKey) {
  console.error('Set GEMINI_API_KEY environment variable before running.');
  process.exit(1);
}

const ai = new GoogleGenAI({apiKey});

const files = (await readdir(inputDir)).filter((f) =>
  ['.mp4', '.mov', '.webm', '.mkv'].includes(extname(f).toLowerCase()),
);

if (files.length === 0) {
  console.error(`No video files found in ${inputDir}`);
  process.exit(1);
}

console.log(`Found ${files.length} video(s) in ${inputDir}\n`);

const limit = pLimit(5);

const tasks = files.map((file, i) =>
  limit(async () => {
    const videoPath = join(inputDir, file);
    const txtPath = join(inputDir, basename(file, extname(file)) + '.txt');

    // Skip if already transcribed
    try {
      await readFile(txtPath);
      console.log(`[${i + 1}/${files.length}] "${file}" — already transcribed, skipping`);
      return;
    } catch {}

    // Extract audio to a temp file with an ASCII-safe name
    const tmpAudio = join(tmpdir(), `${randomUUID()}.mp3`);
    console.log(`[${i + 1}/${files.length}] "${file}" — extracting audio...`);
    await execFileAsync('ffmpeg', [
      '-i',
      videoPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-ab',
      '64k',
      '-ar',
      '22050',
      '-ac',
      '1',
      '-y',
      tmpAudio,
    ]);

    console.log(`[${i + 1}/${files.length}] "${file}" — uploading audio...`);
    let uploaded;
    try {
      uploaded = await ai.files.upload({
        file: tmpAudio,
        config: {mimeType: 'audio/mpeg', displayName: file},
      });
    } finally {
      await unlink(tmpAudio).catch(() => {});
    }

    // Wait for processing to complete
    let fileState = uploaded;
    while (fileState.state === 'PROCESSING') {
      await sleep(5000);
      fileState = await ai.files.get({name: fileState.name!});
    }

    if (fileState.state === 'FAILED') {
      console.log(`[${i + 1}/${files.length}] "${file}" ✗ Processing failed, skipping`);
      return;
    }

    console.log(`[${i + 1}/${files.length}] "${file}" — transcribing...`);

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {fileData: {fileUri: fileState.uri!, mimeType: 'audio/mpeg'}},
            {
              text: 'Transcribe all spoken words in this audio. Output ONLY the transcription text, nothing else. Keep the original language. If there are multiple speakers, start each speaker turn on a new line. If the line is too long, split it into multiple paragraphs in a logical way',
            },
          ],
        },
      ],
    });

    const transcription = response.text ?? '';
    await writeFile(txtPath, transcription, 'utf-8');
    console.log(`[${i + 1}/${files.length}] "${file}" ✓ saved (${transcription.length} chars)`);

    // Clean up the uploaded file
    try {
      await ai.files.delete({name: fileState.name!});
    } catch {}
  }),
);

await Promise.all(tasks);

console.log('\nDone!');

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
