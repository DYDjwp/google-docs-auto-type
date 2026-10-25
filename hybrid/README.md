# Auto Type — Hybrid edition

This build of Auto Type uses the Google Docs input iframe by default and can fall back to Chrome DevTools Protocol (CDP). It requires Chrome's `debugger` permission at installation.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this directory.
3. Open a Google Docs document with edit permission and place the cursor where text should be entered.
4. Open the extension, paste text, configure the typing settings, and select **Start typing**.

## Input behavior

- Characters are sent as synthetic input events through Google Docs' input iframe.
- Enter and Backspace are handled as key events; consecutive line breaks are supported.
- The extension attempts to continue when the document is in a background tab, subject to Chrome and Google Docs limitations.
- A dispatched event may not be accepted by Google Docs. Check the final document content.

## CDP fallback

The extension may attach Chrome's debugger interface following a detectable iframe error or when CDP is explicitly selected. Chrome does not allow the debugger permission to be declared optional. A silent failure of the iframe handler may not trigger a fallback.

## Documentation and license

See the [project README](../README.md) for settings, privacy information, limitations, and the AI-development disclosure. Distributed under the [MIT License](LICENSE), including its warranty and liability disclaimer.
