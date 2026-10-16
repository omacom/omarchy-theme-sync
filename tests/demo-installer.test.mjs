import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const project = fileURLToPath(new URL('../', import.meta.url));
const demo = readFileSync(join(project, 'demo/index.html'), 'utf8');
const payload = "<img src=data:,not-an-image onerror='document.documentElement.dataset.reviewXss=1'>";
const maliciousKey = 'z_bad), red); color:red;" >' + payload;

function extract(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing helper boundary: ${start}`);
  return source.slice(from, to);
}

const swatches = extract(demo, '  const KNOWN =', '  function setStatus(');
const gallery = extract(demo, '  function setGalleryStatus(', '\n  buildGallery();');

function domFixture(themes = [], api = { canSetTheme: async () => ({ allowed: false }) }) {
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.className = '';
      this.children = [];
      this.style = {};
      this.text = '';
      this.listeners = new Map();
    }
    set innerHTML(value) { assert.fail('Theme renderers must not parse HTML'); }
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map((child) => child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    replaceChildren(...children) { this.text = ''; this.children = [...children]; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
  }
  const nodes = Object.fromEntries(['count', 'swatches', 'gallery', 'galleryStatus'].map((id) => [id, new Element('div')]));
  const escaped = [];
  const functions = runInNewContext(swatches + gallery + '\n({ paintSwatches, buildGallery, KNOWN })', {
    document: {
      createElement: (tag) => new Element(tag),
      getElementById: (id) => nodes[id],
      querySelectorAll: (selector) => {
        assert.equal(selector, '.card');
        return nodes.gallery.children;
      },
    },
    CSS: { escape: (name) => { escaped.push(name); return `escaped-${escaped.length - 1}`; } },
    fetch: async () => ({ json: async () => themes }),
    window: { omarchy: api },
    location: { protocol: 'http:', origin: 'http://localhost:8080' },
  });
  return { ...functions, nodes, escaped };
}

test('swatches use literal text, escaped CSS names, existing classes, ordering and fallbacks', () => {
  const fixture = domFixture();
  const colors = { zebra: payload, background: '', alpha: '#abcdef', accent: '#123456', [maliciousKey]: payload };
  fixture.paintSwatches(colors);
  const cards = fixture.nodes.swatches.children;
  const labels = cards.map((card) => card.children[1].children[0].textContent);
  assert.deepEqual(labels, ['accent', 'background', ...['zebra', 'alpha', maliciousKey].sort((a, b) => a.localeCompare(b))]);
  assert.equal(fixture.nodes.count.textContent, String(labels.length));
  assert.deepEqual(fixture.escaped, labels.map((key) => '--omarchy-' + key.replace(/_/g, '-')));
  for (const [index, card] of cards.entries()) {
    assert.equal(card.tagName, 'div');
    assert.equal(card.className, 'sw');
    assert.deepEqual(card.children.map((child) => [child.tagName, child.className]), [['div', 'chip'], ['div', 'meta']]);
    assert.equal(card.children[0].style.backgroundColor, `var(escaped-${index}, var(--bg-light))`);
    const spans = card.children[1].children;
    assert.deepEqual(spans.map((span) => [span.tagName, span.className]), [['span', 'k'], ['span', 'v']]);
    assert.equal(spans[1].textContent, colors[labels[index]] || 'unset');
    assert.ok(spans.every((span) => span.children.length === 0));
  }
  fixture.paintSwatches({});
  assert.deepEqual(fixture.nodes.swatches.children.map((card) => card.children[1].children[0].textContent), Array.from(fixture.KNOWN));
  assert.ok(fixture.nodes.swatches.children.every((card) => card.children[1].children[1].textContent === 'unset'));
  fixture.paintSwatches({ accent: '#123456' });
  assert.equal(fixture.nodes.swatches.children.length, 1);
});

test('gallery constructs the existing card structure without parsing metadata as HTML', async () => {
  const theme = { name: payload, tone: payload, color: 'blue', thumb: 'data:,bad"' + payload,
    colors: { blue: '#333333', accent: payload, background: '#111111', red: '' } };
  const fixture = domFixture([theme]);
  await fixture.buildGallery();
  const [card] = fixture.nodes.gallery.children;
  assert.equal(card.tagName, 'button');
  assert.equal(card.className, 'card');
  assert.equal(card.type, 'button');
  assert.equal(card.disabled, true);
  assert.deepEqual(card.children.map((child) => child.className), ['shot', 'info']);
  assert.equal(card.children[0].style.backgroundImage, `url(${JSON.stringify(theme.thumb)})`);
  const info = card.children[1].children;
  assert.deepEqual(info.map((child) => child.className), ['nm', 'tone', 'strip', 'apply']);
  assert.equal(info[0].textContent, payload);
  assert.equal(info[1].textContent, payload + ' / blue');
  assert.equal(info[3].textContent, 'Install and apply');
  assert.deepEqual(info[2].children.map((child) => [child.tagName, child.style.backgroundColor]),
    [['i', '#111111'], ['i', payload], ['i', '#333333']]);
  assert.match(fixture.nodes.galleryStatus.textContent, /Localhost writes are disabled by default/);
  await fixture.buildGallery();
  assert.equal(fixture.nodes.gallery.children.length, 1);
});

for (const existing of [false, true]) {
  test(`gallery can apply a ${existing ? 'previously installed' : 'newly installed'} theme without reinstalling it`, async () => {
    const calls = [];
    const theme = { name: 'Review', colors: { accent: '#123456' } };
    const fixture = domFixture([theme], {
      canSetTheme: async () => ({ allowed: true }),
      installTheme: async (spec) => {
        calls.push(['install', spec.name]);
        return existing ? { ok: false, name: 'review', error: 'theme already exists; use setTheme' } : { ok: true, name: 'review' };
      },
      setTheme: async (name) => { calls.push(['set', name]); return { ok: true, name: 'review' }; },
    });
    await fixture.buildGallery();
    const [card] = fixture.nodes.gallery.children;
    const label = card.children[1].children[3];
    await card.listeners.get('click')();
    assert.equal(label.textContent, 'Apply existing');
    assert.equal(card.disabled, false);
    await card.listeners.get('click')();
    await card.listeners.get('click')();
    assert.deepEqual(calls, [['install', 'Review'], ['set', 'Review'], ['set', 'Review']]);
    assert.match(fixture.nodes.galleryStatus.textContent, /Requested review/);
  });
}

test('an unrelated gallery installation failure does not enable an existing-theme action', async () => {
  let installs = 0;
  const fixture = domFixture([{ name: 'Review', colors: {} }], {
    canSetTheme: async () => ({ allowed: true }),
    installTheme: async () => { installs++; return { ok: false, error: 'background is not a JPEG or PNG' }; },
    setTheme: async () => assert.fail('failed installation must not trigger an apply'),
  });
  await fixture.buildGallery();
  const [card] = fixture.nodes.gallery.children;
  await card.listeners.get('click')();
  await card.listeners.get('click')();
  assert.equal(installs, 2);
  assert.equal(card.children[1].children[3].textContent, 'Install and apply');
});

test('all demo server instructions bind loopback and serve only demo from the project root', () => {
  const commands = Array.from(demo.matchAll(/python3 -m http\.server[^\n<'"]*/g), (match) => match[0]);
  assert.ok(commands.length > 0);
  for (const command of commands) assert.equal(command, 'python3 -m http.server 8080 --bind 127.0.0.1 --directory demo');
  assert.match(demo, /explicitly allow this exact origin/);
});

function temporaryEnvironment(t, launchers = []) {
  const root = mkdtempSync(join(tmpdir(), 'omarchy-demo-installer-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  // The installer treats a browser as installed only when its launcher is on
  // PATH, so the stubs below are what makes a browser "present" here.
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of launchers) writeFileSync(join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  return { root, bin, env: {
    PATH: [bin, process.env.PATH].join(delimiter),
    HOME: root,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: root,
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + join(root, 'no-session-bus'),
  } };
}

const proxy = '--proxy-server=socks5://127.0.0.1:9050';
const existing = ['/existing/one', '/existing/two'];
const extensionId = 'ppnnomfimbfcofidkfmghapellfbgklc';

// Every case runs against three installed browsers: Chromium, whose flags file
// does not exist yet, Brave Origin, whose flags file Omarchy has already written,
// and Edge, whose flags file is named after the packaging (microsoft-edge-stable)
// rather than the profile directory, so the pairing has to be pinned. Every other
// browser listed in install.sh has neither a profile root nor a launcher here, so
// it must stay out of both the manifests and the flags files.
const installedBrowsers = [
  ['chromium', 'chromium-flags.conf'],
  [join('BraveSoftware', 'Brave-Origin'), 'brave-origin-flags.conf'],
  ['microsoft-edge', 'microsoft-edge-stable-flags.conf'],
];
for (const [name, initial, kept, paths] of [
  ['missing flags', () => null, '', []],
  ['unterminated final proxy flag', () => '# keep this comment\n' + proxy, '# keep this comment\n' + proxy + '\n', []],
  ['unterminated existing extension list', () => '--lang=en-US\n--load-extension=' + existing.join(','), '--lang=en-US\n', existing],
  ['unterminated flag after an extension list', () => '--load-extension=' + existing.join(',') + '\n' + proxy, proxy + '\n', existing],
  ['duplicate own extension entries', (extension) => '--load-extension=' + [existing[0], extension, extension, existing[1]].join(','), '', existing],
  ['only the own extension', (extension) => '--load-extension=' + extension, '', []],
]) {
  test(`installer preserves ${name} through repeated install/uninstall`, (t) => {
    const { root, env } = temporaryEnvironment(t, ['chromium', 'brave-origin', 'microsoft-edge-stable']);
    const extension = join(root, 'extension');
    mkdirSync(extension);
    writeFileSync(join(extension, 'manifest.json'), '{}');
    const host = join(root, 'host-must-not-run');
    writeFileSync(host, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    mkdirSync(env.XDG_CONFIG_HOME);
    const unrelated = join(env.XDG_CONFIG_HOME, 'unrelated.conf');
    writeFileSync(unrelated, 'unchanged');
    for (const [dir] of installedBrowsers) mkdirSync(join(env.XDG_CONFIG_HOME, dir), { recursive: true });
    const flags = installedBrowsers.map(([, file]) => join(env.XDG_CONFIG_HOME, file));
    const before = initial(extension);
    const seed = (contents) => {
      for (const file of flags) {
        if (contents === null) rmSync(file, { force: true });
        else writeFileSync(file, contents);
      }
    };
    seed(before);
    const run = (uninstall = false) => execFileSync('/bin/bash', [join(project, 'install.sh'), ...(uninstall ? ['--uninstall'] : [])], {
      cwd: root,
      env: { ...env, OMARCHY_THEME_HOST_BIN: host, OMARCHY_THEME_EXTENSION_DIR: extension },
      encoding: 'utf8',
      timeout: 10000,
    });
    const uninstalled = kept + (paths.length ? '--load-extension=' + paths.join(',') + '\n' : '');
    const readAll = () => flags.map((file) => (existsSync(file) ? readFileSync(file, 'utf8') : null));
    const every = (value) => installedBrowsers.map(() => value);
    run(true);
    if (before === null) {
      assert.deepEqual(readAll(), every(null));
    } else {
      assert.deepEqual(readAll(), every(uninstalled));
    }
    seed(before);
    for (let i = 0; i < 2; i++) {
      run();
      const expected = kept + '--load-extension=' + [...paths, extension].join(',') + '\n';
      assert.deepEqual(readAll(), every(expected));
    }
    for (const [dir] of installedBrowsers) {
      const manifest = join(env.XDG_CONFIG_HOME, dir, 'NativeMessagingHosts', 'com.omarchy.theme.json');
      assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')).allowed_origins, [`chrome-extension://${extensionId}/`]);
    }
    for (let i = 0; i < 2; i++) {
      run(true);
      assert.deepEqual(readAll(), every(uninstalled));
      assert.deepEqual(every(false), installedBrowsers.map(([dir]) => existsSync(join(env.XDG_CONFIG_HOME, dir, 'NativeMessagingHosts', 'com.omarchy.theme.json'))));
    }
    assert.equal(readFileSync(unrelated, 'utf8'), 'unchanged');
    assert.deepEqual(readdirSync(env.XDG_CONFIG_HOME).sort(), [
      'BraveSoftware',
      'brave-origin-flags.conf',
      'chromium',
      'chromium-flags.conf',
      'microsoft-edge',
      'microsoft-edge-stable-flags.conf',
      'unrelated.conf',
    ]);
  });
}

test('installer configures a browser only once it is installed and has been run', (t) => {
  const { root, env, bin } = temporaryEnvironment(t, ['chromium']);
  const extension = join(root, 'extension');
  mkdirSync(extension);
  writeFileSync(join(extension, 'manifest.json'), '{}');
  const host = join(root, 'host-must-not-run');
  writeFileSync(host, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  mkdirSync(join(env.XDG_CONFIG_HOME, 'chromium'), { recursive: true });
  const braveRoot = join(env.XDG_CONFIG_HOME, 'BraveSoftware', 'Brave-Browser');
  // Omarchy's own copy-url and yt-dlp installers mkdir -p every browser profile
  // root, so a profile directory on its own must not count as an installed Brave.
  mkdirSync(braveRoot, { recursive: true });
  const braveFlags = join(env.XDG_CONFIG_HOME, 'brave-flags.conf');
  const untouched = '--password-store=gnome-libsecret\n';
  writeFileSync(braveFlags, untouched);
  const run = (uninstall = false) => execFileSync('/bin/bash', [join(project, 'install.sh'), ...(uninstall ? ['--uninstall'] : [])], {
    cwd: root,
    env: { ...env, OMARCHY_THEME_HOST_BIN: host, OMARCHY_THEME_EXTENSION_DIR: extension },
    encoding: 'utf8',
    timeout: 10000,
  });

  run();
  assert.ok(readFileSync(join(env.XDG_CONFIG_HOME, 'chromium-flags.conf'), 'utf8').includes('--load-extension=' + extension));
  assert.equal(readFileSync(braveFlags, 'utf8'), untouched);
  assert.equal(existsSync(join(braveRoot, 'NativeMessagingHosts', 'com.omarchy.theme.json')), false);

  // Brave gets installed for real: the launcher appears, and the next run picks
  // the browser up without anyone touching the installer.
  writeFileSync(join(bin, 'brave'), '#!/bin/sh\n', { mode: 0o755 });
  run();
  assert.ok(readFileSync(braveFlags, 'utf8').includes('--load-extension=' + extension));
  assert.equal(existsSync(join(braveRoot, 'NativeMessagingHosts', 'com.omarchy.theme.json')), true);

  // The profile is gone but the flags file is not: uninstall still has to drop the
  // path, or Brave would fail on a directory that no longer exists.
  rmSync(join(env.XDG_CONFIG_HOME, 'BraveSoftware'), { recursive: true, force: true });
  run(true);
  assert.equal(readFileSync(braveFlags, 'utf8'), untouched);
});

const chromium = ['chromium', 'chromium-browser', 'google-chrome'].flatMap((name) =>
  (process.env.PATH || '').split(delimiter).map((directory) => join(directory, name))).find((file) => {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
});

test('Chromium keeps palette and gallery payloads inert through unchanged DOM helpers', {
  skip: chromium ? false : 'Chromium is not installed; dependency-free DOM safety tests still run',
  timeout: 60000,
}, (t) => {
  const { root, env } = temporaryEnvironment(t);
  const content = readFileSync(join(project, 'extension/content.js'), 'utf8');
  const api = readFileSync(join(project, 'extension/page-api.js'), 'utf8');
  const apply = extract(content, 'function apply(palette) {', '// Two sources,');
  const colors = extract(api, '  function colors() {', '  Object.defineProperty(');
  const data = JSON.stringify({ payload, maliciousKey }).replaceAll('<', '\\u003c');
  const page = join(root, 'xss.html');
  writeFileSync(page, `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'">
<style>:root { --bg-light: #28302b; }</style></head><body>
<div id="count"></div><div id="swatches"></div><div id="gallery"></div><div id="galleryStatus"></div>
<script>
const data = ${data};
const VAR_PREFIX = '--omarchy-';
const CHANGE_EVENT = 'omarchythemechange';
let applied = null;
${apply}
${colors}
${swatches}
${gallery}
function check(ok, message) { if (!ok) throw new Error(message); }
(async () => {
  apply({ colors: { background: '#101913', accent: '#123456', review: data.payload } });
  check(colors().review === data.payload, 'CSS/API round trip changed the payload');
  paintSwatches(colors());
  check(document.querySelector('#swatches .v').textContent === '#123456', 'Known ordering changed');
  const chip = document.querySelector('#swatches .chip');
  check(getComputedStyle(chip).backgroundColor === 'rgb(18, 52, 86)', 'Live color missing');
  document.documentElement.style.setProperty('--omarchy-accent', '#654321');
  check(getComputedStyle(chip).backgroundColor === 'rgb(101, 67, 33)', 'Live retint broken');
  check([...document.querySelectorAll('#swatches .v')].some((el) => el.textContent === data.payload), 'Payload not rendered literally');
  check(!document.querySelector('#swatches img'), 'Palette created an image');
  apply({ colors: {} });
  paintSwatches({});
  check(document.querySelectorAll('#swatches .sw').length === KNOWN.length, 'Fallback keys changed');
  check(getComputedStyle(document.querySelector('#swatches .chip')).backgroundColor === 'rgb(40, 48, 43)', 'Fallback color changed');
  paintSwatches({ [data.maliciousKey]: data.payload });
  check(document.querySelector('#swatches .k').textContent === data.maliciousKey, 'Key not rendered literally');
  check(document.querySelector('#swatches .chip').style.length === 1, 'Key escaped its CSS property');
  window.fetch = async () => ({ json: async () => [{
    name: data.payload, tone: data.payload, color: data.payload,
    thumb: 'data:,bad"' + data.payload, colors: { background: '#123456', accent: data.payload },
  }] });
  await buildGallery();
  check(document.querySelector('#gallery .nm').textContent === data.payload, 'Gallery name not literal');
  check(getComputedStyle(document.querySelector('#gallery .strip i')).backgroundColor === 'rgb(18, 52, 86)', 'Gallery color changed');
  check(!document.querySelector('#swatches img, #gallery img, #swatches [onerror], #gallery [onerror]'), 'Payload created active markup');
  // A separate positive control proves inline error handlers actually run here.
  const control = document.createElement('div');
  control.innerHTML = data.payload.replace('reviewXss', 'controlXss');
  document.body.appendChild(control);
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(document.documentElement.dataset.controlXss === '1', 'Positive control did not execute');
  check(!document.documentElement.dataset.reviewXss, 'Theme payload executed');
  document.documentElement.dataset.result = 'passed';
})().catch((error) => { document.documentElement.dataset.error = error.message; });
</script></body></html>`);
  const result = spawnSync(chromium, [
    '--headless', '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-default-apps', '--disable-sync', '--disable-breakpad', '--no-first-run',
    '--no-default-browser-check', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
    '--password-store=basic', '--disable-gpu', '--dump-dom', '--virtual-time-budget=2000',
    '--user-data-dir=' + join(root, 'browser-profile'), pathToFileURL(page).href,
  ], { cwd: root, env, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const htmlTag = result.stdout.match(/<html\b[^>]*>/)?.[0] || '';
  assert.match(htmlTag, /data-control-xss="1"/);
  assert.match(htmlTag, /data-result="passed"/);
  assert.doesNotMatch(htmlTag, /data-review-xss=/);
});
