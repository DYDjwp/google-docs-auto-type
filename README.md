# Auto Type

Auto Type is a Chrome extension that enters text into Google Docs at a configurable pace.

[Download the latest release](https://github.com/DYDjwp/google-docs-auto-type/releases/latest)

## Editions

| | iframe | Hybrid |
| --- | --- | --- |
| Input method | Google Docs input iframe | iframe with CDP fallback |
| Debugger permission | No | Required |

Choose iframe unless you specifically need CDP. Both editions are self-contained unpacked extensions.

## Installation

Requires Google Chrome 116 or later and an editable Google Docs document.

1. Download and extract either edition from [Releases](https://github.com/DYDjwp/google-docs-auto-type/releases).
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the folder containing `manifest.json`.
4. Open Google Docs and place the text cursor where typing should begin.

To install from source, select the `iframe/` or `hybrid/` directory. After updating an unpacked extension, reload it and refresh any open Google Docs tabs.

## Usage

1. Open Auto Type and paste your text.
2. Choose a speed or enable **Advanced mode** to customize typing.
3. Select **Start typing**. Use the popup, floating controls, or shortcuts to pause, resume, or stop.
4. Review the resulting document.

**Clear draft** removes saved popup text, not text already inserted into Google Docs.

## Features

- Adjustable typing speed, timing variation, punctuation delays, and random breaks.
- Optional typos, iframe typo correction, and longer pauses at word or sentence boundaries.
- Line breaks and configurable Enter key behavior.
- Optional keyboard lock, mouse lock, and floating controls.
- Best-effort background-tab typing and document-scoped session drafts.
- Configuration sharing through compact tokens and JSON backups.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Pause / Resume | Alt + Shift + P |
| Stop | Alt + Shift + X |

Use Option instead of Alt on macOS. Customize shortcuts at `chrome://extensions/shortcuts`. Chrome must be focused. The active document takes priority; ambiguous background tasks are not targeted.

## Limitations

Google Docs input relies on undocumented editor interfaces. Synthetic input may be ignored without an error, and background typing may be throttled. The optional iframe **Fix typo** feature cannot always confirm the temporary character was accepted and may delete the wrong character. CDP does not perform automatic Backspace correction. Keep backups, review the result, and leave Fix typo off for important documents.

## Privacy

Preferences are stored locally. Drafts are stored in browser session storage per tab and document. The extension does not send document text to a separate server or include analytics.

Uninstalling opens an optional [feedback page](https://dydjwp.github.io/google-docs-auto-type/uninstall). Only voluntarily submitted feedback is sent to a private Google Sheet. The page uses [flare-redact](https://github.com/flare-collection/flare-redact) for best-effort local redaction before submission; this does not guarantee anonymity. Avoid including personal information.

The Hybrid edition requires Chrome's sensitive debugger permission; review the permission prompt before installation.

## Development

Both editions use Manifest V3 and plain JavaScript, HTML, and CSS. No build step is required. Run regression tests with `node --test tests/*.cjs`.

The core implementation was written by AI under human direction and has not undergone a formal security audit. Contributions and independent review are welcome.

## Experimental caret support

This branch tests automatic caret detection and restoration through Google Docs' private Annotated Text API. It uses the original input behavior when the API is unavailable. The development build attempts early initialization with its own extension ID and preserves an existing integration flag. Google Docs may reject the ID. Reload the document after installing the development build, click inside the document, then use Advanced mode → Check caret support. Independent notifications can be configured in Advanced mode.

## License

[MIT License](LICENSE). Provided as is, without warranty. This project is not affiliated with or endorsed by Google.
