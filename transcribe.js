#!/usr/bin/env node

import { GoogleGenAI } from "@google/genai";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const inputDir = process.argv[2] || "./downloads";
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error("Set GEMINI_API_KEY environment variable before running.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const files = (await readdir(inputDir)).filter((f) =>
  [".mp4", ".mov", ".webm", ".mkv"].includes(extname(f).toLowerCase()),
);

if (files.length === 0) {
  console.error(`No video files found in ${inputDir}`);
  process.exit(1);
}

console.log(`Found ${files.length} video(s) in ${inputDir}\n`);

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const videoPath = join(inputDir, file);
  const txtPath = join(inputDir, basename(file, extname(file)) + ".txt");

  // Skip if already transcribed
  try {
    await readFile(txtPath);
    console.log(
      `[${i + 1}/${files.length}] "${file}" — already transcribed, skipping`,
    );
    continue;
  } catch {}

  // Extract audio to a temp file with an ASCII-safe name
  const tmpAudio = join(tmpdir(), `${randomUUID()}.mp3`);
  console.log(`[${i + 1}/${files.length}] "${file}" — extracting audio...`);
  await execFileAsync("ffmpeg", [
    "-i",
    videoPath,
    "-vn",
    "-acodec",
    "libmp3lame",
    "-ab",
    "64k",
    "-ar",
    "22050",
    "-ac",
    "1",
    "-y",
    tmpAudio,
  ]);

  console.log(`  Uploading audio...`);
  let uploaded;
  try {
    uploaded = await ai.files.upload({
      file: tmpAudio,
      config: { mimeType: "audio/mpeg", displayName: file },
    });
  } finally {
    await unlink(tmpAudio).catch(() => {});
  }

  // Wait for processing to complete
  let fileState = uploaded;
  while (fileState.state === "PROCESSING") {
    console.log(`  Processing...`);
    await sleep(5000);
    fileState = await ai.files.get({ name: fileState.name });
  }

  if (fileState.state === "FAILED") {
    console.log(`  ✗ Processing failed, skipping`);
    continue;
  }

  console.log(`  Transcribing...`);

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: fileState.uri, mimeType: "audio/mpeg" } },
          {
            text: "Transcribe all spoken words in this audio. Output ONLY the transcription text, nothing else. Keep the original language. If there are multiple speakers, start each speaker turn on a new line.",
          },
        ],
      },
    ],
  });

  const transcription = response.text;
  await writeFile(txtPath, transcription, "utf-8");
  console.log(
    `  ✓ Saved to ${basename(txtPath)} (${transcription.length} chars)\n`,
  );

  // Clean up the uploaded file
  try {
    await ai.files.delete({ name: fileState.name });
  } catch {}
}

console.log("Done!");

function mimeTypeFor(filename) {
  const ext = extname(filename).toLowerCase();
  const map = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
  };
  return map[ext] || "video/mp4";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
