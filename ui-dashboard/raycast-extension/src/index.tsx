import { execFile } from "child_process";
import { showHUD, showToast, Toast } from "@raycast/api";
import path from "path";
import fs from "fs";

const PROJECT_DIR = path.join(process.env.HOME || "~", "multimodal-search");
const PYTHON = path.join(PROJECT_DIR, "venv", "bin", "python3");
const INDEXER = path.join(PROJECT_DIR, "api", "indexer.py");
const ENV_FILE = path.join(PROJECT_DIR, ".env");

function loadApiKey(): string {
  const content = fs.readFileSync(ENV_FILE, "utf-8");
  const match = content.match(/^GOOGLE_API_KEY=(.+)$/m);
  return match ? match[1].trim() : "";
}

export default async function Index() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    await showToast({ style: Toast.Style.Failure, title: "GOOGLE_API_KEY not set in .env" });
    return;
  }

  await showHUD("Indexing started in background...");

  execFile(PYTHON, [INDEXER], {
    env: { ...process.env, GOOGLE_API_KEY: apiKey },
  }, async (error) => {
    if (error) {
      await showToast({ style: Toast.Style.Failure, title: "Indexing failed", message: error.message });
    }
  });
}
