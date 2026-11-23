/** The files installed in all three Linux packages, named relative to the AppDir. */
const desktopId = 'quotum.desktop';

export function releaseDateFromEpoch(seconds) {
  const time = new Date(Number(seconds) * 1000);
  if (!/^\d+$/.test(seconds) || !Number.isFinite(time.getTime()) || time.getUTCFullYear() > 9999) {
    throw new Error('Expected a Unix timestamp in seconds for the AppStream release date');
  }
  return time.toISOString().slice(0, 10);
}

function xmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

export function linuxPackageMetadata(app, version, releaseDate) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid package version');
  const date = new Date(`${releaseDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate) || !Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 10) !== releaseDate) throw new Error('Invalid AppStream release date');
  const {identifier, productName, bundle} = app;
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(identifier)) throw new Error('Invalid AppStream component ID');
  for (const field of [productName, bundle.publisher, bundle.shortDescription, bundle.longDescription]) {
    if (!field.trim() || !field.isWellFormed() || /[\x00-\x1f\uFFFE\uFFFF]|https?:\/\//i.test(field)) {
      throw new Error('Invalid desktop catalogue text');
    }
  }
  if (!/^https:\/\/[^\s<>]+$/.test(bundle.homepage)) throw new Error('Expected an HTTPS project homepage');
  const desktopPath = `usr/share/applications/${desktopId}`;
  const metainfoPath = `usr/share/metainfo/${identifier}.appdata.xml`;
  const desktop = `[Desktop Entry]
Type=Application
Name=${productName}
Comment=${bundle.shortDescription}
Exec=quotum-desktop
Icon=quotum
Terminal=false
Categories=Development;
StartupWMClass=quotum
`;
  const metainfo = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${identifier}</id>
  <name>${xmlText(productName)}</name>
  <summary>${xmlText(bundle.shortDescription)}</summary>
  <developer_name>${xmlText(bundle.publisher)}</developer_name>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <description>
    <p>${xmlText(bundle.longDescription)}</p>
  </description>
  <launchable type="desktop-id">${desktopId}</launchable>
  <url type="homepage">${xmlText(bundle.homepage)}</url>
  <url type="bugtracker">${xmlText(bundle.homepage)}/issues</url>
  <screenshots>
    <screenshot type="default">
      <caption>Subscription limits and weekly trends on one machine</caption>
      <image>https://raw.githubusercontent.com/padurets/Quotum/main/docs/desktop.png</image>
    </screenshot>
  </screenshots>
  <content_rating type="oars-1.1" />
  <releases><release version="${version}" date="${releaseDate}"/></releases>
</component>
`;
  return {
    desktopId, desktopPath, metainfoPath, desktop, metainfo,
    appImageName: `Quotum-${version}-x86_64.AppImage`,
  };
}

// Check the staged bytes (including the AppDir's root launcher) against the
// release manifest. Linux smoke independently parses the extracted package.
export function validateLinuxPackageMetadata(expected, appImageName, readText) {
  if (appImageName !== expected.appImageName) throw new Error(`Unexpected AppImage name: ${appImageName}`);
  for (const [file, content] of [[expected.desktopId, expected.desktop], [expected.desktopPath, expected.desktop],
    [expected.metainfoPath, expected.metainfo]]) {
    if (readText(file) !== content) throw new Error(`Unexpected Linux package metadata in ${file}`);
  }
}

export function rpmFileList(metadata, resourceFiles) {
  return `%files
%defattr(-,root,root,-)
/usr/bin/quotum-desktop
/usr/bin/quotum-node
/${metadata.desktopPath}
/${metadata.metainfoPath}
/usr/share/icons/hicolor/128x128/apps/quotum.png
%dir /usr/share/quotum
${resourceFiles.join('\n')}
`;
}
