# Auto Type

Auto Type is a Chrome extension for entering text into Google Docs at a configurable pace. It works with an editable document already open in the browser and uses Google Docs' internal text-input iframe to dispatch typing events.

The project is distributed in two editions. Both use the same interface and typing controls; the Hybrid edition adds Chrome DevTools Protocol (CDP) as an alternative input method.

## Editions

| | iframe | Hybrid |
| --- | --- | --- |
| Input method | Google Docs iframe | iframe first; CDP fallback |
| Chrome debugger permission | Not required | Required |
| Directory | [`iframe/`](iframe/) | [`hybrid/`](hybrid/) |
| Release package | `auto-type-1.0.0-iframe.zip` | `auto-type-1.0.0-hybrid.zip` |

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

The extension attempts to preserve paragraph breaks, including consecutive blank lines. Verify the resulting document after a run, particularly when using background typing or advanced input settings.

## Features

- Three preset speeds and an advanced characters-per-minute setting.
- Adjustable timing variation, punctuation pauses, and random breaks.
- Optional uncorrected typos, corrected typos, and longer breaks at word or sentence boundaries.
- Support for line breaks, Backspace, and configurable Enter-event handling.
- Pause, resume, and stop controls; optional keyboard lock and floating controls.
- Best-effort typing while another Chrome tab is active.

## Implementation

The iframe input path runs in the Google Docs page's JavaScript context and sends synthetic keyboard events to `docs-texteventtarget-iframe`. The extension service worker provides timing assistance to reduce background-tab timer throttling.

The Hybrid edition can use CDP if the iframe path reports a detectable failure, or when CDP is selected manually. A successful event dispatch does not prove that Google Docs accepted or saved the edit. Silent input failures cannot always be detected.

Google Docs' iframe input behavior is **undocumented and unsupported by Google**. Browser updates, document state, tab suspension, and editor focus may affect operation. This project is not affiliated with or endorsed by Google.

## Privacy and permissions

The extension operates on Google Docs pages and stores user preferences using `chrome.storage.local`. Text provided for a session is held locally while the session runs and is not sent by the extension to a separate server. The project does not include analytics or external runtime libraries.

The Hybrid edition requires the sensitive `debugger` permission. Review the source and Chrome's permission prompt before installing it.

## Development

Both editions use Manifest V3 and plain JavaScript, HTML, and CSS. Each directory is a self-contained unpacked extension. Changes affecting shared behavior should be tested in both editions.

The core implementation of Auto Type was **written by AI under human direction**. The code has not undergone a formal security audit. Contributions and independent review are welcome.

## License and disclaimer

Released under the [MIT License](LICENSE). You may use, modify, and distribute the software under its terms, including retaining the copyright and permission notice.

**The software is provided "AS IS", without warranties of any kind.** To the extent permitted by law, the authors and copyright holders disclaim liability for damages arising from its use. The full legal terms are in [LICENSE](LICENSE). Use the extension at your own risk, keep backups of important documents, and follow applicable Google Docs and organizational policies.
