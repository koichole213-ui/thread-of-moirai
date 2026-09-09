"""Package only runtime files, never user attachments or test storage."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))['version']
files = [root / name for name in ['index.js', 'manifest.json', 'style.css', 'README.md']]
for folder in ['src', 'ui', 'vendor/st-theater']:
    files.extend(path for path in (root / folder).rglob('*') if path.is_file())
target = root / 'dist' / f'thread-of-moirai-{version}.zip'
target.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(files):
        archive.write(path, 'thread-of-moirai/' + path.relative_to(root).as_posix())
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert all(not any(part in name for part in ['attachments', 'tests/', 'ui-preview/']) for name in archive.namelist())
print(f'{target.name}: {len(files)} runtime files, archive verified')
