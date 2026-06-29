# `Multimodal Search.app`

This is the checked-in macOS application bundle used to launch the project from Finder, Dock, or Spotlight.

## Structure

- `Contents/`: standard macOS app bundle contents.

## Notes

- The bundle ultimately starts the Python launcher in `api/launch.py`.
- Most code changes should happen in the backend or UI source folders, not inside the bundle.
