# NarrativeTailor Chrome Extension (GenAI)

This version uses the Google GenAI JS SDK loaded via CDN.

Install:
1. Extract the folder.
2. Open Chrome -> chrome://extensions -> Developer mode -> Load unpacked -> select the folder.
3. In the popup, paste your Gemini API key, upload docs, enter Company + Product, click Generate.

Notes:
- The extension loads the GenAI SDK from https://esm.run. Ensure your Chrome allows network requests to that host.
- The SDK will call Google's GenAI endpoints using your API key. Keep your key secure.
