# Auto Type — Hybrid edition

This build of Auto Type uses the Google Docs input iframe by default and can fall back to Chrome DevTools Protocol (CDP). It requires Chrome's `debugger` permission at installation.

## Development version 1.0.3

This branch adds an Advanced Mode Mouse lock and includes safe interruption handling for typo correction, closed-tab draft cleanup, and a draft-quota recovery path. It has not been published as a Release.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this directory.
3. Open a Google Docs document with edit permission and place the cursor where text should be entered.
4. Open the extension, paste text, configure the typing settings, and select **Start typing**.
5. To clear saved popup text for the current document tab, use **Clear draft** next to the character count.

## Keyboard shortcuts

- **Alt/Option + Shift + P** — toggle pause / resume.
- **Alt/Option + Shift + X** — cancel the current task (does not undo text already inserted).
- Customize shortcuts at `chrome://extensions/shortcuts`. Chrome or operating-system shortcut conflicts may prevent defaults from being assigned.
- If you are typing in multiple documents, the focused document's task takes priority. If exactly one document is typing, shortcuts also work from another tab. If multiple background tasks are active, the shortcut is ignored to avoid stopping the wrong task.
- Shortcuts work only while Chrome has focus; they do not work globally in other apps.

## Advanced Mouse lock

Enable **Advanced mode → During typing → Mouse lock** to ignore accidental mouse clicks, dragging, selection, and wheel scrolling in Google Docs while a task runs. It does not freeze the system cursor or require Pointer Lock API permissions. The floating Pause / Stop controls remain clickable. Mouse interactions work normally while paused and after Stop, completion, or error. Chrome keyboard shortcuts remain available.

This is best-effort interception of trusted page events; Google Docs may handle some events earlier or in inaccessible frames. Verify the final document and use pause before deliberately changing the cursor.

## Input behavior

- Characters are sent as synthetic input events through Google Docs' input iframe.
- Enter and Backspace are handled as key events; consecutive line breaks are supported.
- The extension attempts to continue when the document is in a background tab, subject to Chrome and Google Docs limitations.
- A dispatched event may not be accepted by Google Docs. Check the final document content.

## CDP fallback

The extension may attach Chrome's debugger interface following a detectable iframe error or when CDP is explicitly selected. Chrome does not allow the debugger permission to be declared optional. A silent failure of the iframe handler may not trigger a fallback.

## Documentation and license

See the [project README](../README.md) for settings, privacy information, limitations, and the AI-development disclosure. Distributed under the [MIT License](LICENSE), including its warranty and liability disclaimer.
