import hashlib
import io
import pathlib
import shutil
import tarfile
import tempfile
import unittest
from gpu_runtime import install, validate_manifest, PartReader


class DownloadTests(unittest.TestCase):
    def fixture(self, name='woodshed-processor/woodshed-processor'):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w:gz') as archive:
            info = tarfile.TarInfo(name)
            info.size, info.mode = 7, 0o755
            archive.addfile(info, io.BytesIO(b'runtime'))
        raw = data.getvalue()
        chunks = [raw[:len(raw)//2], raw[len(raw)//2:]]
        parts = [{'name': f'woodshed-cuda-linux-x64-1.5.1.part{i:03}', 'size': len(chunk),
                  'sha256': hashlib.sha256(chunk).hexdigest()} for i, chunk in enumerate(chunks)]
        manifest = {'schema': 1, 'version': '1.5.1', 'platform': 'linux', 'unpackedBytes': 7, 'parts': parts}
        return manifest, dict(zip([p['name'] for p in parts], chunks))

    def test_verified_install_and_cross_release_cache(self):
        manifest, chunks = self.fixture()
        requests = []
        def fetch(url, path, size, progress):
            requests.append(url)
            path.write_bytes(chunks[url.rsplit('/', 1)[-1]])
        with tempfile.TemporaryDirectory() as directory:
            executable = install(manifest, directory, lambda _: None, fetch, verify=lambda _: None)
            self.assertEqual(executable.read_bytes(), b'runtime')
            self.assertEqual(len(requests), 2)
            manifest['version'] = '1.5.2'
            for part in manifest['parts']: part['name'] = part['name'].replace('1.5.1', '1.5.2')
            self.assertEqual(install(manifest, directory, lambda _: None, fetch), executable)
            self.assertEqual(len(requests), 2)

    def test_corrupt_download_is_not_installed(self):
        manifest, _ = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'checksum'):
                install(manifest, directory, lambda _: None,
                        lambda url, path, size, progress: path.write_bytes(b'corrupt'))
            self.assertFalse(list(pathlib.Path(directory).rglob('complete.json')))

    def test_interrupted_download_reuses_verified_parts(self):
        manifest, chunks = self.fixture()
        requests = []
        interrupted = True
        def fetch(url, path, size, progress):
            name = url.rsplit('/', 1)[-1]
            requests.append(name)
            if interrupted and name.endswith('001'): raise OSError('offline')
            path.write_bytes(chunks[name])
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(OSError): install(manifest, directory, lambda _: None, fetch)
            interrupted = False
            install(manifest, directory, lambda _: None, fetch, verify=lambda _: None)
            self.assertEqual(requests.count(manifest['parts'][0]['name']), 1)

    def test_archive_cannot_escape_installation(self):
        manifest, chunks = self.fixture('../../escaped')
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(tarfile.FilterError):
                install(manifest, directory, lambda _: None,
                        lambda url, path, size, progress: path.write_bytes(chunks[url.rsplit('/', 1)[-1]]))
            self.assertFalse(list(pathlib.Path(directory).rglob('complete.json')))

    def test_manifest_rejects_paths_urls_and_duplicate_parts(self):
        manifest, _ = self.fixture()
        for name in ('../runtime', 'https://example.com/runtime', '/tmp/runtime'):
            manifest['parts'][0]['name'] = name
            with self.assertRaises(ValueError): validate_manifest(manifest)


if __name__ == '__main__': unittest.main()
