"""Split a verified CUDA processor into release assets below GitHub's limit."""
import hashlib
import gzip
import json
import pathlib
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


class PartsWriter:
    def __init__(self, folder, prefix, limit=512 * 1024**2):
        self.folder, self.prefix, self.limit = folder, prefix, limit
        self.file = None
        self.parts = []
        self.size = 0
        self.hash = None

    def write(self, data):
        length = len(data)
        while data:
            if self.file is None:
                self.name = f'{self.prefix}.part{len(self.parts):03}'
                self.file = (self.folder / self.name).open('wb')
                self.size, self.hash = 0, hashlib.sha256()
            chunk, data = data[:self.limit-self.size], data[self.limit-self.size:]
            self.file.write(chunk)
            self.hash.update(chunk)
            self.size += len(chunk)
            if self.size == self.limit: self.close_part()
        return length

    def close_part(self):
        if self.file:
            self.file.close()
            self.parts.append({'name': self.name, 'size': self.size, 'sha256': self.hash.hexdigest()})
            self.file = None


def main():
    (ROOT / 'build').mkdir(exist_ok=True)
    if sys.platform == 'darwin':
        (ROOT / 'build/gpu-runtime.json').write_text('{}\n')
        return
    version = json.loads((ROOT / 'package.json').read_text())['version']
    prefix = f'woodshed-cuda-{sys.platform}-x64-{version}'
    folder = ROOT / 'release'
    folder.mkdir(exist_ok=True)
    processor = ROOT / 'build/processor/woodshed-processor'
    writer = PartsWriter(folder, prefix)
    with gzip.GzipFile(fileobj=writer, mode='wb', filename='', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w|') as archive:
        archive.add(processor, arcname='woodshed-processor')
    writer.close_part()
    manifest = {'schema': 1, 'version': version, 'platform': sys.platform,
                'parts': writer.parts,
                'unpackedBytes': sum(p.stat().st_size for p in processor.rglob('*') if p.is_file() and not p.is_symlink())}
    content = json.dumps(manifest, indent=2) + '\n'
    (ROOT / 'build/gpu-runtime.json').write_text(content)
    (folder / f'{prefix}.json').write_text(content)
    print(f'CUDA runtime: {len(writer.parts)} verified parts, {sum(p["size"] for p in writer.parts)} bytes')


if __name__ == '__main__': main()
