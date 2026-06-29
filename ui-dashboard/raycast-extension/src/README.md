# `src`

This folder contains the TypeScript source for the Raycast extension UI.

## Files

- `index.tsx`: entrypoint for Raycast indexing actions.
- `search.tsx`: live search UI and result actions inside Raycast.

## Role In The Project

- This is the source layer for the Raycast frontend.
- It shells out to the Python backend in `api/` rather than reimplementing search logic in TypeScript.
