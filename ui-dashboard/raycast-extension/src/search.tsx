import { ActionPanel, Action, List, Icon, showToast, Toast, Alert, confirmAlert } from "@raycast/api";
import { useState, useEffect, useRef } from "react";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execFileAsync = promisify(execFile);

interface SearchResult {
  path: string;
  name: string;
  type: string;
  score: number;
  preview: string;
}

const TYPE_ICONS: Record<string, Icon> = {
  pdf: Icon.Document,
  image: Icon.Image,
  video: Icon.Video,
};

const PROJECT_DIR = path.join(process.env.HOME || "~", "multimodal-search");
const PYTHON = path.join(PROJECT_DIR, "venv", "bin", "python3");
const SEARCHER = path.join(PROJECT_DIR, "api", "searcher.py");
const ENV_FILE = path.join(PROJECT_DIR, ".env");

async function loadApiKey(): Promise<string> {
  const fs = await import("fs");
  const content = fs.readFileSync(ENV_FILE, "utf-8");
  const match = content.match(/^GOOGLE_API_KEY=(.+)$/m);
  return match ? match[1].trim() : "";
}

async function runSearch(query: string, typeFilter?: string): Promise<SearchResult[]> {
  const apiKey = await loadApiKey();
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set in .env");

  const args = [SEARCHER];
  if (typeFilter) {
    args.push("--type", typeFilter);
  }
  args.push(query);

  const { stdout } = await execFileAsync(PYTHON, args, {
    env: { ...process.env, GOOGLE_API_KEY: apiKey },
    timeout: 30000,
  });

  return JSON.parse(stdout);
}

export default function Search() {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!searchText.trim()) {
      setResults([]);
      return;
    }

    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const res = await runSearch(searchText, typeFilter || undefined);
        setResults(res);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Search failed";
        showToast({ style: Toast.Style.Failure, title: "Search Error", message });
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, 500);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [searchText, typeFilter]);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search images, PDFs, videos..."
      onSearchTextChange={setSearchText}
      throttle
      searchBarAccessory={
        <List.Dropdown tooltip="Filter by type" onChange={setTypeFilter}>
          <List.Dropdown.Item title="All Types" value="" />
          <List.Dropdown.Item title="PDF" value="pdf" icon={Icon.Document} />
          <List.Dropdown.Item title="Image" value="image" icon={Icon.Image} />
          <List.Dropdown.Item title="Video" value="video" icon={Icon.Video} />
        </List.Dropdown>
      }
    >
      {results.length === 0 && !isLoading && searchText.trim() ? (
        <List.EmptyView title="No results found" description={`No matches for "${searchText}"`} />
      ) : (
        results.map((result, index) => (
          <List.Item
            key={result.path}
            icon={TYPE_ICONS[result.type] || Icon.Finder}
            title={result.name}
            subtitle={result.type.toUpperCase()}
            accessories={[{ text: `${Math.round(result.score * 100)}%` }]}
            actions={
              <ActionPanel>
                <Action.Open title="Open File" target={result.path} />
                <Action.ShowInFinder path={result.path} />
                <Action.CopyToClipboard
                  title="Copy Path"
                  content={result.path}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
                />
                <Action
                  title="Delete File"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["cmd"], key: "d" }}
                  onAction={async () => {
                    if (
                      await confirmAlert({
                        title: "Delete File",
                        message: `Are you sure you want to delete "${result.name}"?`,
                        primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
                      })
                    ) {
                      try {
                        await fs.promises.rename(result.path, path.join(process.env.HOME || "~", ".Trash", result.name));
                        setResults((prev) => prev.filter((r) => r.path !== result.path));
                        await showToast({ style: Toast.Style.Success, title: "Moved to Trash", message: result.name });
                      } catch (err: unknown) {
                        const message = err instanceof Error ? err.message : "Delete failed";
                        await showToast({ style: Toast.Style.Failure, title: "Delete Failed", message });
                      }
                    }
                  }}
                />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
