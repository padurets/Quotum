import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {linuxPackageMetadata, releaseDateFromEpoch, rpmFileList, validateLinuxPackageMetadata} from './linux-metadata.mjs';

const app = JSON.parse(readFileSync(new URL('./tauri.conf.json', import.meta.url), 'utf8'));
const version = '1.2.3', date = '2024-02-29';
const metadata = linuxPackageMetadata(app, version, date);
const desktopPath = 'usr/share/applications/quotum.desktop';
const metainfoPath = 'usr/share/metainfo/com.padurets.quotum.appdata.xml';
const imageName = 'Quotum-1.2.3-x86_64.AppImage';

test('the package exposes one desktop application, its launcher and public catalogue screenshot', () => {
  assert.equal(metadata.desktopId, 'quotum.desktop');
  assert.equal(metadata.desktopPath, desktopPath);
  assert.equal(metadata.metainfoPath, metainfoPath);
  assert.equal(metadata.appImageName, imageName);
  assert.match(metadata.desktop, /^\[Desktop Entry\]\nType=Application\nName=Quotum\n/);
  assert.ok(metadata.desktop.includes(`\nComment=${app.bundle.shortDescription}\n`));
  assert.match(metadata.desktop, /^Exec=quotum-desktop\nIcon=quotum$/m);
  const {metainfo} = metadata;
  assert.match(metainfo, /^<\?xml version="1.0" encoding="UTF-8"\?>\s*<component type="desktop-application">/);
  assert.match(metainfo, /<\/component>\s*$/);
  assert.doesNotMatch(metainfo, /xmlns/);
  for (const item of [
    '<id>com.padurets.quotum</id>', '<name>Quotum</name>', '<launchable type="desktop-id">quotum.desktop</launchable>',
    '<metadata_license>CC0-1.0</metadata_license>', '<project_license>MIT</project_license>',
    '<url type="homepage">https://github.com/padurets/Quotum</url>',
    '<url type="bugtracker">https://github.com/padurets/Quotum/issues</url>', '<content_rating type="oars-1.1" />',
    `<developer_name>${app.bundle.publisher}</developer_name>`, `<summary>${app.bundle.shortDescription}</summary>`,
    `<p>${app.bundle.longDescription}</p>`,
  ]) assert.ok(metainfo.includes(item), item);
  assert.match(metainfo, /<description>\s*<p>[^<]+<\/p>\s*<\/description>/);
  assert.match(metainfo, /<releases>\s*<release version="1\.2\.3" date="2024-02-29"\/>\s*<\/releases>/);
  assert.match(metainfo, /<screenshots>\s*<screenshot type="default">\s*<caption>[^<]+<\/caption>\s*<image>https:\/\/raw\.githubusercontent\.com\/padurets\/Quotum\/main\/docs\/desktop\.png<\/image>\s*<\/screenshot>\s*<\/screenshots>/);
});

test('RPM owns the metainfo and launcher files and leaves shared directories to the system', () => {
  const resources = ['%attr(4755,root,root) "/usr/share/quotum/electron/chrome-sandbox"'];
  const files = rpmFileList(metadata, resources).trimEnd().split('\n');
  assert.ok(files.includes(`/${desktopPath}`));
  assert.deepEqual(files.filter(file => file.includes('/usr/share/metainfo')), [`/${metainfoPath}`]);
  assert.ok(files.includes(resources[0]));
});

test('XML text is escaped and catalogue descriptions stay valid in XML and the desktop entry', () => {
  const example = structuredClone(app);
  example.bundle.longDescription = 'Uses <clients> & their "developer\'s" tools.';
  assert.ok(linuxPackageMetadata(example, version, date).metainfo
    .includes('<p>Uses &lt;clients&gt; &amp; their &quot;developer&apos;s&quot; tools.</p>'));
  for (const badSummary of [' ', 'Two\nlines', 'A\ttab', 'https://example.org', 'Bad\u0000text', 'Bad\uD800text']) {
    example.bundle.shortDescription = badSummary;
    assert.throws(() => linuxPackageMetadata(example, version, date), /catalogue text/);
  }
});

test('release dates use whole UTC epoch seconds and reject impossible dates or versions', () => {
  assert.equal(releaseDateFromEpoch('0'), '1970-01-01');
  assert.equal(releaseDateFromEpoch('1709251199'), date);
  assert.equal(releaseDateFromEpoch('1709251200'), '2024-03-01');
  for (const epoch of ['', '-1', 'NaN', '123.5', '8640000000000001']) {
    assert.throws(() => releaseDateFromEpoch(epoch), /Unix timestamp/);
  }
  for (const value of [undefined, '', '2023-02-29', '2024-02-30', '2024-01-01T00:00:00Z']) {
    assert.throws(() => linuxPackageMetadata(app, version, value), /release date/);
  }
  for (const value of ['', '1.2.3/other', '1.2.3"><release']) {
    assert.throws(() => linuxPackageMetadata(app, value, date), /package version/);
  }
});

test('staging validates the installed desktop entry, the root launcher, metainfo and AppImage name', () => {
  const files = new Map([['quotum.desktop', metadata.desktop], [desktopPath, metadata.desktop], [metainfoPath, metadata.metainfo]]);
  const validate = (name = imageName) => validateLinuxPackageMetadata(metadata, name, file => files.get(file));
  validate();
  for (const badName of ['quotum-desktop-1.2.3-linux-x64.AppImage', 'Quotum_1.2.3_amd64.AppImage']) {
    assert.throws(() => validate(badName), /AppImage name/);
  }
  for (const [original, changed] of [
    ['<component type=', '<component xmlns="urn:example" type='], ['<summary>', '<broken>'],
    ['<image>https:', '<image>http:'], ['<image>https:', '<image>\nhttps:'],
    ['<id>com.padurets.quotum', '<id>org.example.other'], ['>quotum.desktop<', '>other.desktop<'],
    [date, '2023-02-29'],
  ]) {
    files.set(metainfoPath, metadata.metainfo.replace(original, changed));
    assert.throws(validate, /com\.padurets\.quotum\.appdata\.xml/);
  }
  files.set(metainfoPath, metadata.metainfo);
  for (const file of files.keys()) {
    const broken = new Map(files);
    broken.delete(file);
    assert.throws(() => validateLinuxPackageMetadata(metadata, imageName, path => broken.get(path)), /package metadata/);
  }
});
