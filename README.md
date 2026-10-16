# Omarchy Theme Sync

Use your Omarchy desktop colors on the web.

Omarchy Theme Sync is a Chromium extension that shares your current theme with
websites through CSS variables and a small JavaScript API. Change your desktop
theme, and pages that use these colors update without a reload.

It does not automatically restyle every website. Each site chooses how to use
the colors.

## Install

You need an Omarchy desktop and a supported Chromium-based browser such as Chromium,
Brave, or Microsoft Edge. There is no build step and no npm install. The installer
runs as your normal user, without `sudo`.

1. Open your browser at least once so its profile exists.
2. Clone the project and run the installer:

```bash
git clone https://github.com/omacom/omarchy-theme-sync.git
cd omarchy-theme-sync
./install.sh
```

3. Fully quit and restart the browser.
4. Open your browser’s extensions page and check for **Omarchy Theme Sync**:
   - Chromium: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`

   In Edge, enable **Developer mode** if it is not already enabled.

Keep the project folder in place. The browser loads the extension and its local
helper directly from this folder.

The runtime needs Bash, jq, inotify-tools, util-linux, and GNU coreutils with
`mv --no-copy` support. These tools are normally available on Omarchy. Python 3
is only needed for the demo. Node.js 22 or newer is only needed for tests.

Automatic setup writes `--load-extension` to the flags file for each installed
Chromium-based browser it detects. It supports Chromium, Brave, Microsoft Edge,
Vivaldi, Opera, and Helium. Brave and Microsoft Edge have been tested; the other
listed browsers should work through the same mechanism but have not been tested.
Firefox is not supported yet.

Google Chrome 137 and newer ignore `--load-extension`, so Chrome users must load
`extension/` manually from `chrome://extensions` with Developer mode enabled.

## Use Colors in CSS

The extension adds CSS variables to the page's `<html>` element:

```css
.card {
  background: var(--omarchy-background, #101913);
  color: var(--omarchy-foreground, #a1af9c);
  border: 1px solid var(--omarchy-accent, #4a9a68);
}
```

Always include a fallback color. Your site should still work when the extension
is not installed.

Color names come from the theme's `colors.toml` file. Underscores become hyphens:
`bright_green` becomes `--omarchy-bright-green`.

The `<html>` element also gets `data-omarchy-theme` and `data-omarchy-mode`
attributes for the theme name and light or dark mode.

## Use the JavaScript API

Check for `window.omarchy` before using it:

```js
const api = window.omarchy;

if (api) {
  console.log(api.theme);           // Theme name
  console.log(api.mode);            // "light" or "dark"
  console.log(api.color('accent')); // One color
  console.log(api.colors());        // All colors

  const stop = api.onChange((colors) => {
    console.log('Theme colors updated:', colors);
  });

  // Call stop() when your component or view is removed.
}
```

The palette arrives asynchronously. Initial reads can be empty; `onChange`
also fires when the first palette arrives.

## Try the Demo

From the project folder, run:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory demo
```

Open [http://localhost:8080](http://localhost:8080). In another terminal, switch
to a theme you have installed:

```bash
omarchy-theme-set "Tokyo Night"
```

The demo updates its colors without reloading. The server only listens on your
machine and only serves the `demo/` folder.

Localhost is **read-only by default**. To test the demo's theme buttons, uncomment
the exact `http://localhost:8080` entry in `THEME_WRITE_ORIGINS` in
[`extension/background.js`](extension/background.js), then reload the extension
at `chrome://extensions`. Reload the demo page too, so it reconnects. Disable this
entry when you finish development.

Do not allow every localhost port. Any app or HTML preview served from an allowed
origin gets the same permission to change your desktop theme.

## Apply or Install Themes

Reading colors is available to every page where the extension runs. Changing the
desktop theme is only allowed from a top-level `https://omarchy.org` page by
default. Embedded frames cannot write.

On an allowed page, check permission before showing theme controls. Run examples
with `await` in the browser console or a JavaScript module:

```js
const api = window.omarchy;

if (api && (await api.canSetTheme()).allowed) {
  const result = await api.setTheme('Tokyo Night');
  if (!result.ok) console.error(result.error);
}
```

To install a new palette from an allowed page:

```js
const result = await window.omarchy.installTheme({
  name: 'My Web Theme',
  colors: {
    background: '#101913',
    foreground: '#a1af9c',
    accent: '#4a9a68',
  },
});

if (!result.ok) console.error(result.error);
```

- Colors must be six-digit hex strings such as `#4a9a68`.
- `background`, `foreground`, and `accent` are required.
- Existing themes are never overwritten. Use `setTheme(name)` to apply them.
- An optional `backgroundUrl` must be a direct HTTPS image on an allowed wallpaper host. The bundled gallery has working examples.
- `{ ok: true }` means the request was accepted, not that the desktop has finished updating. Listen for `onChange` to see the result.

New themes are stored in `~/.config/omarchy/themes/<slug>/`. Gallery cards switch
to **Apply existing** after installation or an existing-name error.

## Security and Privacy

Every page where the extension runs can read your theme name and palette. Custom
colors can help identify you across sites. There is no per-site read opt-in yet.

An allowed write origin can change your theme without a confirmation prompt.
Only add origins you trust.

The extension limits downloads to a trusted wallpaper host, rejects redirects,
and caps image size and download time. The local helper validates requests,
protects existing themes, and limits installation rate and storage use.

See [Security Notes](docs/security.md) for the exact permissions, limits, and
remaining trust assumptions.

## Development

The project uses plain JavaScript and Bash. No bundler or package installation
is required.

| Path | Purpose |
| --- | --- |
| `extension/` | Chromium extension and page API |
| `bin/omarchy-browser-theme-host` | Local helper that reads and applies themes |
| `demo/` | Live demo and example palettes |
| `install.sh` | Browser registration and removal |
| `tests/` | Security and behavior regression tests |

Run the tests from the project folder:

```bash
node --test tests/*.test.mjs
```

Tests use temporary profiles and stub desktop commands. They do not change your
real theme or browser profile. The browser DOM test uses headless Chromium and
skips if Chromium is unavailable. The other tests still run.

After changing extension code, reload it at `chrome://extensions`. Reloading also
restarts the connection to the local helper. Reload any open test pages afterward.

## Troubleshooting

- **The installer says no browser profile was found:** Open your browser once, then run `./install.sh` again.
- **The extension is missing:** Fully quit and restart the browser, then check its extensions page. Google Chrome is the one exception — see the browser table under [Install](#install).
- **The palette is empty:** Confirm Omarchy has an active theme, then reload the extension.
- **Local demo buttons are disabled:** This is the default. Follow the exact-origin opt-in in [Try the Demo](#try-the-demo).
- **You want to move the project folder:** Uninstall from the old location first. Move it, then run the installer from the new location.

## Uninstall

Run this before deleting or moving the project folder:

```bash
./install.sh --uninstall
```

Restart the browser. This removes the browser registration, not themes you
previously installed or the helper's rate-limit state.

## License

[MIT](LICENSE). Externally hosted wallpapers are not covered by this license;
check the rights for those images before reusing them.

The extension icon uses the square logo from the
[official Omarchy brand assets](https://omarchy.org/brand). The logo is not covered
by this project's MIT license.
