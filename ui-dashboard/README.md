# `ui-dashboard`

This folder contains the user-facing dashboard layer and desktop-adjacent UI integrations.

## Contents

- `search_panel.js`: the injected dashboard/search UI that runs inside Atlas.
- `search_panel.css`: styling for the dashboard, graph mode, modals, and controls.
- `raycast-extension/`: Raycast UI integration.
- `mac-app/`: packaged macOS launcher assets.

## Role In The Project

- This is the main frontend/UI area of the repo.
- Any dashboard behavior or user interaction code outside the Python API should generally live here.
