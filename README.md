# Auto Type

Auto Type is a Chrome extension for entering text into Google Docs at a configurable pace. It works with an editable document already open in the browser and uses Google Docs' internal text-input iframe to dispatch typing events.

The project is distributed in two editions. Both use the same interface and typing controls; the Hybrid edition adds Chrome DevTools Protocol (CDP) as an alternative input method.

**Unreleased development version: v1.0.3-dev.** The current stable download is [v1.0.2](../../releases/tag/v1.0.2). This branch has not been published as a Beta or Stable Release.

## Editions

| | iframe | Hybrid |
| --- | --- | --- |
| Input method | Google Docs iframe | iframe first; CDP fallback |
| Chrome debugger permission | Not required | Required |
| Directory | [`iframe/`](iframe/) | [`hybrid/`](hybrid/) |
| Latest stable package | `auto-type-1.0.2-iframe.zip` | `auto-type-1.0.2-hybrid.zip` |

The iframe edition is recommended unless CDP support is specifically needed. Chrome does not support requesting the `debugger` permission as an optional permission, so Hybrid is maintained as a separate extension package.

## Requirements

- Google Chrome 116 or newer.
- An editable Google Docs document.
- Developer mode enabled in Chrome to install from source or a release archive.

## Installation

1. Download an edition from [Releases](../../releases) and extract the ZIP archive.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the extracted directory containing `manifest.json`.
4. Open a Google Docs document with edit access and place the text cursor at the desired insertion point.

To install from a clone of this repository, load either the `iframe/` or `hybrid/` directory directly. No build step or third-party dependencies are required.

## Usage

1. Open Auto Type from the Chrome toolbar.
2. Paste the text to be entered.
3. Select **Slow**, **Medium**, or **Fast**, or enable **Advanced mode** to configure a custom rate and timing parameters.
4. Set any optional typing behaviors, then select **Start typing**.
5. Use the extension popup or floating controls to pause, resume, or stop the session.
6. To erase the saved text for the current document tab, click **Clear draft** beside the character counter. This does not delete text already inserted into Google Docs.

The extension attempts to preserve paragraph breaks, including consecutive blank lines. Verify the resulting document after a run, particularly when using background typing or advanced input settings.

## Keyboard shortcuts

- **Pause / Resume:** `Alt+Shift+P` (Option + Shift + P on macOS).
- **Cancel typing:** `Alt+Shift+X` (Option + Shift + X on macOS). This stops the task without deleting text already typed.
- Configure or reassign shortcuts at `chrome://extensions/shortcuts`. Some combinations may conflict with Chrome or the operating system.
- The command targets a typing task in the active Docs tab. When only one Docs task is running, it can also be controlled from another Chrome tab. When several tasks are running in background tabs with none in the foreground, the command is ignored rather than affecting the wrong document.
- These are Chrome-scoped shortcuts, not system-global shortcuts; Chrome must be focused.



## v1.0.3 development changes (unreleased)

- Fix typo correction now avoids Backspace when a task is paused, cancelled, or real input indicates the insertion point may have moved. A temporary typo can remain rather than risk deleting existing text; the task reports this explicitly.
- Cancelled partial corrections no longer advance the reported character progress.
- Close-tab events remove per-tab session drafts. When a draft cannot be saved on Start, the popup reclaims drafts from tabs that no longer exist and retries once. If saving still fails, typing will not start and the popup keeps the source text visible with recovery instructions.

## Known issue

- **Google Docs iframe input is not fully reliable:** Because it relies on an undocumented editor interface, Google Docs may occasionally ignore synthetic keyboard events without reporting an error (including during background typing). Verify that the document contains the expected text after each run.

## Features

- Three preset speeds and an advanced characters-per-minute setting.
- Adjustable timing variation, punctuation pauses, and random breaks.
- Optional uncorrected typos, corrected typos, and longer breaks at word or sentence boundaries.
- Support for line breaks, Backspace, and configurable Enter-event handling.
- Pause, resume, and stop controls; optional keyboard lock, floating controls, and keyboard shortcuts.
- Best-effort typing while another Chrome tab is active.

## Implementation

The iframe input path runs in the Google Docs page's JavaScript context and sends synthetic keyboard events to `docs-texteventtarget-iframe`. The popup injects the input bridge directly, without depending on the service worker to prepare each run. The extension service worker provides timing assistance to reduce background-tab timer throttling. If the receiver is temporarily unavailable, iframe mode retries up to three times, uses local timers as a fallback, and periodically probes the background connection (about every five seconds while pacing runs) to restore service-worker timing. Chrome may throttle the fallback's timers in background tabs; CDP mode requires the worker.

The Hybrid edition can use CDP if the iframe path reports a detectable failure, or when CDP is selected manually. A successful event dispatch does not prove that Google Docs accepted or saved the edit. Silent input failures cannot always be detected.

Google Docs' iframe input behavior is **undocumented and unsupported by Google**. Browser updates, document state, tab suspension, and editor focus may affect operation. This project is not affiliated with or endorsed by Google.

## Privacy and permissions

The extension operates on Google Docs pages and stores user preferences using `chrome.storage.local`. Entered text drafts are stored in `chrome.storage.session` per tab and cleared when the browser session ends. Text is not sent by the extension to a separate server. The project does not include analytics or external runtime libraries.

The Hybrid edition requires the sensitive `debugger` permission. Review the source and Chrome's permission prompt before installing it.

## Development

Both editions use Manifest V3 and plain JavaScript, HTML, and CSS. Each directory is a self-contained unpacked extension. Changes affecting shared behavior should be tested in both editions.

The core implementation of Auto Type was **written by AI under human direction**. The code has not undergone a formal security audit. Contributions and independent review are welcome.

## License and disclaimer

Released under the [MIT License](LICENSE). You may use, modify, and distribute the software under its terms, including retaining the copyright and permission notice.

**The software is provided "AS IS", without warranties of any kind.** To the extent permitted by law, the authors and copyright holders disclaim liability for damages arising from its use. The full legal terms are in [LICENSE](LICENSE). Use the extension at your own risk, keep backups of important documents, and follow applicable Google Docs and organizational policies.
