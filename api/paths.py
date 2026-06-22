from pathlib import Path


API_DIR = Path(__file__).resolve().parent
ROOT_DIR = API_DIR.parent
UI_DASHBOARD_DIR = ROOT_DIR / "ui-dashboard"
SEARCH_INDEX_DATA_DIR = ROOT_DIR / "search-index-data"
CHROMA_DB_DIR = ROOT_DIR / "chroma-db"

ENV_FILE = ROOT_DIR / ".env"
ATLAS_DATA_FILE = SEARCH_INDEX_DATA_DIR / "atlas_data.parquet"
CLUSTER_META_FILE = SEARCH_INDEX_DATA_DIR / "cluster_meta.json"
MANIFEST_FILE = SEARCH_INDEX_DATA_DIR / "manifest.json"
RATE_STATE_FILE = SEARCH_INDEX_DATA_DIR / "rate_state.json"
ATLAS_CACHE_DIR = SEARCH_INDEX_DATA_DIR / ".cache"
UMAP_CACHE_FILE = SEARCH_INDEX_DATA_DIR / ".umap_cache.json"


def ensure_runtime_dirs() -> None:
    SEARCH_INDEX_DATA_DIR.mkdir(parents=True, exist_ok=True)
    CHROMA_DB_DIR.mkdir(parents=True, exist_ok=True)
    ATLAS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
