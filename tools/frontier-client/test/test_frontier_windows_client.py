from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parent
CLIENT_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(CLIENT_DIR))

import frontier_windows_client as windows_client  # noqa: E402


PATCH_OFFSET = 0x450
BEFORE = bytes.fromhex("0f95c0")
AFTER = bytes.fromhex("b00190")
CONTEXT_BEFORE = bytes.fromhex("1020304050607080")
CONTEXT_AFTER = bytes.fromhex("90a0b0c0d0e0f001")


def make_pe_source() -> bytes:
    data = bytearray(b"\0" * 0x620)
    data[:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x80)
    data[0x80:0x84] = b"PE\0\0"
    file_header = 0x84
    struct.pack_into("<HHIIIHH", data, file_header, 0x8664, 1, 0, 0, 0, 0xF0, 0x2022)
    optional = file_header + 20
    struct.pack_into("<H", data, optional, 0x20B)
    struct.pack_into("<Q", data, optional + 24, 0x180000000)
    struct.pack_into("<II", data, optional + 32, 0x1000, 0x200)
    struct.pack_into("<II", data, optional + 56, 0x2000, 0x400)
    struct.pack_into("<I", data, optional + 108, 16)
    security_directory = optional + 112 + 4 * 8
    struct.pack_into("<II", data, security_directory, 0x600, 0x20)
    section = optional + 0xF0
    data[section : section + 8] = b".text\0\0\0"
    struct.pack_into("<IIII", data, section + 8, 0x200, 0x1000, 0x200, 0x400)
    struct.pack_into("<I", data, section + 36, 0x60000020)
    data[0x400:0x600] = b"\x90" * 0x200
    data[PATCH_OFFSET - len(CONTEXT_BEFORE) : PATCH_OFFSET] = CONTEXT_BEFORE
    data[PATCH_OFFSET : PATCH_OFFSET + len(BEFORE)] = BEFORE
    data[
        PATCH_OFFSET + len(BEFORE) : PATCH_OFFSET + len(BEFORE) + len(CONTEXT_AFTER)
    ] = CONTEXT_AFTER
    struct.pack_into("<IHH", data, 0x600, 0x20, 0x0200, 0x0002)
    data[0x608:0x620] = bytes(range(0x18))
    return bytes(data)


def make_profile(source: bytes) -> dict:
    provisional = {
        "format": windows_client.PE_PROFILE_FORMAT,
        "build": 9999999,
        "name": "blue.pyd",
        "source": {
            "size": len(source),
            "sha256": hashlib.sha256(source).hexdigest(),
            "authenticode": {
                "securityDirectoryOffsetHex": "0x600",
                "securityDirectorySizeHex": "0x20",
            },
        },
        "target": {
            "size": 0,
            "sha256": "",
            "peChecksumHex": "0x0",
        },
        "patches": [
            {
                "fileOffset": PATCH_OFFSET,
                "fileOffsetHex": "0x450",
                "beforeHex": BEFORE.hex(),
                "afterHex": AFTER.hex(),
                "contextBeforeHex": CONTEXT_BEFORE.hex(),
                "contextAfterHex": CONTEXT_AFTER.hex(),
            }
        ],
        "manifestTargets": [
            "root:\\code.ccp",
            "root:/bin64/packages/certifi\\cacert.pem",
            "root:/bin64\\blue.pyd",
            "root:/bin64\\cacert.pem",
            "root:/bin64\\exefile.exe",
        ],
    }
    output = bytearray(source)
    output[PATCH_OFFSET : PATCH_OFFSET + len(AFTER)] = AFTER
    output = output[:0x600]
    layout = windows_client.parse_pe_layout(output)
    struct.pack_into("<II", output, layout["securityDirectoryOffset"], 0, 0)
    checksum = windows_client.calculate_pe_checksum(output, layout["checksumOffset"])
    struct.pack_into("<I", output, layout["checksumOffset"], checksum)
    provisional["target"] = {
        "size": len(output),
        "sha256": hashlib.sha256(output).hexdigest(),
        "peChecksumHex": f"0x{checksum:x}",
    }
    return provisional


def manifest_bytes(entries: list[tuple[int, str, bytes | None]], trailer=b"signed-trailer") -> bytes:
    output = bytearray(struct.pack("<II", 4, len(entries)))
    for flags, name, digest in entries:
        encoded = name.encode("utf-8")
        output.extend(struct.pack("<II", flags, len(encoded)))
        output.extend(encoded)
        if flags == 0:
            assert digest is not None and len(digest) == 32
            output.extend(struct.pack("<I", 32))
            output.extend(digest)
    output.extend(trailer)
    return bytes(output)


def pem(der: bytes) -> bytes:
    encoded = base64.b64encode(der)
    return b"-----BEGIN CERTIFICATE-----\n" + encoded + b"\n-----END CERTIFICATE-----\n"


class PePatchTests(unittest.TestCase):
    def setUp(self):
        self.source = make_pe_source()
        self.profile = make_profile(self.source)

    def test_exact_source_target_partial_and_unknown_states(self):
        self.assertEqual(windows_client.inspect_blue_bytes(self.source, self.profile), "source")
        target = windows_client.build_blue_target(self.source, self.profile)
        self.assertEqual(windows_client.inspect_blue_bytes(target, self.profile), "target")

        partial = bytearray(target)
        partial[0x500] ^= 1
        self.assertEqual(windows_client.inspect_blue_bytes(bytes(partial), self.profile), "partial")

        unknown = bytearray(self.source)
        unknown[PATCH_OFFSET : PATCH_OFFSET + len(BEFORE)] = b"\xCC" * len(BEFORE)
        self.assertEqual(windows_client.inspect_blue_bytes(bytes(unknown), self.profile), "unknown")

    def test_atomic_patch_is_idempotent_and_validates_checksum(self):
        with tempfile.TemporaryDirectory(prefix="frontier pe path with spaces ") as raw:
            path = Path(raw) / "blue.pyd"
            path.write_bytes(self.source)
            self.assertEqual(windows_client.patch_blue_atomic(path, self.profile), "target")
            first_hash = windows_client.sha256_file(path)
            self.assertEqual(windows_client.patch_blue_atomic(path, self.profile), "target")
            self.assertEqual(windows_client.sha256_file(path), first_hash)
            layout = windows_client.parse_pe_layout(path.read_bytes())
            self.assertEqual(layout["securityFileOffset"], 0)
            self.assertEqual(layout["securitySize"], 0)
            self.assertEqual(
                windows_client.read_u32(path.read_bytes(), layout["checksumOffset"]),
                windows_client.calculate_pe_checksum(path.read_bytes(), layout["checksumOffset"]),
            )

    def test_security_overlay_must_be_exact_eof_certificate(self):
        malformed = bytearray(self.source)
        malformed.extend(b"unexpected")
        malformed_profile = make_profile(self.source)
        malformed_profile["source"]["size"] = len(malformed)
        malformed_profile["source"]["sha256"] = hashlib.sha256(malformed).hexdigest()
        with self.assertRaises(windows_client.FrontierWindowsError):
            windows_client.inspect_blue_bytes(bytes(malformed), malformed_profile)


class ManifestTests(unittest.TestCase):
    def test_refresh_changes_only_target_digests_and_preserves_trailer(self):
        with tempfile.TemporaryDirectory(prefix="frontier manifest ") as raw:
            root = Path(raw)
            targets = {
                "root:\\code.ccp": root / "code.ccp",
                "root:/bin64/packages/certifi\\cacert.pem": root / "bin64/packages/certifi/cacert.pem",
                "root:/bin64\\blue.pyd": root / "bin64/blue.pyd",
                "root:/bin64\\cacert.pem": root / "bin64/cacert.pem",
                "root:/bin64\\exefile.exe": root / "bin64/exefile.exe",
            }
            for index, path in enumerate(targets.values()):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"payload-{index}".encode())
            entries = [(0, name, b"\0" * 32) for name in targets]
            entries.append((1, "lib:root:/code.ccp", None))
            trailer = b"\x00signature-trailer\xff"
            manifest_path = root / "manifest.dat"
            manifest_path.write_bytes(manifest_bytes(entries, trailer))
            profile = {"manifestTargets": list(targets)}

            before = manifest_path.read_bytes()
            report = windows_client.refresh_manifest_atomic(manifest_path, root, profile)
            after = manifest_path.read_bytes()
            parsed_before = windows_client.parse_manifest(before)
            parsed_after = windows_client.parse_manifest(after)
            self.assertEqual(parsed_after["trailer"], trailer)
            self.assertEqual(parsed_before["trailer"], parsed_after["trailer"])
            self.assertEqual(len(report["changedEntries"]), len(targets))
            self.assertTrue(windows_client.manifest_hashes_match(manifest_path, root, profile))

    def test_duplicates_path_escapes_and_unknown_flags_fail(self):
        digest = b"\0" * 32
        with self.assertRaises(windows_client.FrontierWindowsError):
            windows_client.parse_manifest(
                manifest_bytes([(0, "root:/same", digest), (0, "root:\\same", digest)])
            )
        with self.assertRaises(windows_client.FrontierWindowsError):
            windows_client.parse_manifest(
                manifest_bytes(
                    [
                        (0, "root:/bin64/cacert.pem", digest),
                        (0, "ROOT:/BIN64/CACERT.PEM", digest),
                    ]
                )
            )
        with self.assertRaises(windows_client.FrontierWindowsError):
            windows_client.parse_manifest(manifest_bytes([(0, "root:/../escape", digest)]))
        with self.assertRaises(windows_client.FrontierWindowsError):
            windows_client.parse_manifest(manifest_bytes([(2, "root:/file", None)]))

    def test_profile_manifest_targets_reject_windows_path_collisions(self):
        digest = b"\0" * 32
        manifest = windows_client.parse_manifest(
            manifest_bytes([(0, "root:/bin64/cacert.pem", digest)])
        )
        profile = {
            "manifestTargets": [
                "root:/bin64/cacert.pem",
                "ROOT:\\BIN64\\CACERT.PEM",
            ]
        }
        with self.assertRaisesRegex(
            windows_client.FrontierWindowsError, "duplicate manifest targets"
        ):
            windows_client.manifest_targets(profile, Path("."), manifest)


class CertificateAndTransactionTests(unittest.TestCase):
    def test_ca_append_is_exactly_once(self):
        with tempfile.TemporaryDirectory(prefix="frontier ca ") as raw:
            bundle = Path(raw) / "cacert.pem"
            bundle.write_bytes(pem(b"other-certificate"))
            ca_der = b"evejs-ca-certificate"
            ca_pem = pem(ca_der)
            self.assertTrue(windows_client.append_ca_atomic(bundle, ca_pem, ca_der))
            self.assertFalse(windows_client.append_ca_atomic(bundle, ca_pem, ca_der))
            self.assertEqual(windows_client.ca_count_in_bundle(bundle, ca_der), 1)
            bundle.write_bytes(bundle.read_bytes() + ca_pem)
            with self.assertRaises(windows_client.FrontierWindowsError):
                windows_client.append_ca_atomic(bundle, ca_pem, ca_der)

    def test_backup_restore_verifies_original_hashes(self):
        with tempfile.TemporaryDirectory(prefix="frontier rollback ") as raw:
            root = Path(raw)
            files = [root / "blue.pyd", root / "nested/code.ccp"]
            for index, path in enumerate(files):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"original-{index}".encode())
            backup, hashes = windows_client.backup_transaction_files(root, files)
            for path in files:
                path.write_bytes(b"mutated")
            windows_client.restore_transaction_files(root, backup, files, hashes)
            for path in files:
                relative = path.relative_to(root).as_posix()
                self.assertEqual(windows_client.sha256_file(path), hashes[relative])

    def test_backup_rejects_preexisting_reparse_base_before_content_io(self):
        with tempfile.TemporaryDirectory(prefix="frontier backup base guard ") as raw:
            root = Path(raw)
            source = root / "blue.pyd"
            source.write_bytes(b"blue")
            backup_base = root / ".evejs-backups"
            backup_base.mkdir()
            real_is_reparse = windows_client.is_reparse_point

            def simulated_reparse(path):
                return Path(path) == backup_base or real_is_reparse(path)

            with mock.patch.object(
                windows_client, "is_reparse_point", side_effect=simulated_reparse
            ), mock.patch.object(windows_client, "sha256_file") as hash_file, mock.patch.object(
                windows_client.shutil, "copy2"
            ) as copy_file:
                with self.assertRaisesRegex(
                    windows_client.FrontierWindowsError, "reparse point"
                ):
                    windows_client.backup_transaction_files(root, [source])
                hash_file.assert_not_called()
                copy_file.assert_not_called()

    def test_restore_rejects_reparse_backup_root_before_content_io(self):
        with tempfile.TemporaryDirectory(prefix="frontier backup root guard ") as raw:
            root = Path(raw)
            destination = root / "blue.pyd"
            destination.write_bytes(b"mutated")
            backup_root = root / ".evejs-backups" / "frontier-client-fixture"
            backup_root.mkdir(parents=True)
            (backup_root / "blue.pyd").write_bytes(b"original")
            expected = {
                "blue.pyd": hashlib.sha256(b"original").hexdigest(),
            }
            real_is_reparse = windows_client.is_reparse_point

            def simulated_reparse(path):
                return Path(path) == backup_root or real_is_reparse(path)

            with mock.patch.object(
                windows_client, "is_reparse_point", side_effect=simulated_reparse
            ), mock.patch.object(windows_client, "sha256_file") as hash_file, mock.patch.object(
                windows_client, "copy_file_atomic"
            ) as copy_file:
                with self.assertRaisesRegex(
                    windows_client.FrontierWindowsError, "reparse point"
                ):
                    windows_client.restore_transaction_files(
                        root, backup_root, [destination], expected
                    )
                hash_file.assert_not_called()
                copy_file.assert_not_called()

    def test_verify_backup_preflights_every_file_before_hashing(self):
        with tempfile.TemporaryDirectory(prefix="frontier backup file guard ") as raw:
            root = Path(raw)
            transaction_paths = [root / "blue.pyd", root / "nested" / "code.ccp"]
            backup_root = root / ".evejs-backups" / "frontier-client-fixture"
            for index, path in enumerate(transaction_paths):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"current-{index}".encode())
                backup_path = backup_root / path.relative_to(root)
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                backup_path.write_bytes(f"original-{index}".encode())
            redirected = backup_root / transaction_paths[-1].relative_to(root)
            marker = {
                "clientPatchBackup": str(backup_root),
                "prePatchHashes": {
                    path.relative_to(root).as_posix(): hashlib.sha256(
                        f"original-{index}".encode()
                    ).hexdigest()
                    for index, path in enumerate(transaction_paths)
                },
            }
            real_is_reparse = windows_client.is_reparse_point

            def simulated_reparse(path):
                return Path(path) == redirected or real_is_reparse(path)

            with mock.patch.object(
                windows_client, "is_reparse_point", side_effect=simulated_reparse
            ), mock.patch.object(windows_client, "sha256_file") as hash_file:
                with self.assertRaisesRegex(
                    windows_client.FrontierWindowsError, "reparse point"
                ):
                    windows_client.verify_backup(root, marker, transaction_paths)
                hash_file.assert_not_called()

    def test_stage_marker_requires_exact_build_containment(self):
        with tempfile.TemporaryDirectory(prefix="frontier marker ") as raw:
            root = Path(raw)
            staging_base = root / "staged-client"
            stage = staging_base / "3474408"
            source = root / "retail" / "stillness"
            stage.mkdir(parents=True)
            source.mkdir(parents=True)
            marker = {
                "format": windows_client.STAGE_FORMAT,
                "platform": "windows",
                "build": 3474408,
                "stagePath": str(stage),
                "stagingBase": str(staging_base),
                "sourceRoot": str(source),
                "nativeBlue": "blue.pyd",
            }
            marker_path = stage / windows_client.STAGE_MARKER_NAME
            marker_path.write_text(json.dumps(marker), encoding="utf-8")
            windows_client.load_stage(stage)
            marker["stagePath"] = str(root / "somewhere-else")
            marker_path.write_text(json.dumps(marker), encoding="utf-8")
            with self.assertRaises(windows_client.FrontierWindowsError):
                windows_client.load_stage(stage)

    def test_protected_file_rejects_a_reparse_ancestor(self):
        with tempfile.TemporaryDirectory(prefix="frontier reparse guard ") as raw:
            root = Path(raw)
            protected = root / "bin64" / "blue.pyd"
            protected.parent.mkdir()
            protected.write_bytes(b"blue")
            real_is_reparse = windows_client.is_reparse_point

            def simulated_reparse(path):
                return path == protected.parent or real_is_reparse(path)

            with mock.patch.object(
                windows_client, "is_reparse_point", side_effect=simulated_reparse
            ):
                with self.assertRaises(windows_client.FrontierWindowsError):
                    windows_client.assert_no_reparse_ancestors(root, protected)

    def test_retail_hash_evidence_requires_every_protected_official_file(self):
        marker = {
            "nativeBlue": "blue.pyd",
            "retailHashesBefore": {"bin64/blue.pyd": "0" * 64},
        }
        with self.assertRaises(windows_client.FrontierWindowsError):
            windows_client.retail_hashes(marker)


class ResFilesVerificationTests(unittest.TestCase):
    def test_copy_is_bound_to_official_cache_and_complete_index(self):
        with tempfile.TemporaryDirectory(prefix="frontier resfiles path with spaces ") as raw:
            root = Path(raw)
            source = root / "retail" / "stillness"
            official_resfiles = source.parent / "ResFiles"
            stage = root / "staged-client" / "3474408"
            copied_resfiles = stage / "ResFiles"
            for directory in (source, official_resfiles, copied_resfiles):
                directory.mkdir(parents=True)
            index_text = "res:/fixture,aa/aabbccddeeff,0123456789abcdef0123456789abcdef,3,2\n"
            (source / "resfileindex.txt").write_text(index_text, encoding="utf-8")
            (stage / "resfileindex.txt").write_text(index_text, encoding="utf-8")
            indexed_file = copied_resfiles / "aa" / "aabbccddeeff"
            indexed_file.parent.mkdir()
            indexed_file.write_bytes(b"abc")
            marker = {
                "sourceRoot": str(source),
                "nativeBlue": "blue.pyd",
                "resFiles": {
                    "mode": "copy",
                    "path": str(copied_resfiles),
                    "sourceTarget": str(official_resfiles),
                },
            }
            paths = windows_client.stage_paths(stage, marker)
            report = windows_client.verify_resfiles(stage, marker, paths)
            self.assertEqual(report["entries"], 1)
            self.assertEqual(report["indexedBytes"], 3)

            unrelated = root / "unrelated-cache"
            unrelated.mkdir()
            marker["resFiles"]["sourceTarget"] = str(unrelated)
            with self.assertRaisesRegex(
                windows_client.FrontierWindowsError, "independently discovered official cache"
            ):
                windows_client.verify_resfiles(stage, marker, paths)
            marker["resFiles"]["sourceTarget"] = str(official_resfiles)

            real_is_reparse = windows_client.is_reparse_point

            def simulated_reparse(path):
                return Path(path) == indexed_file.parent or real_is_reparse(path)

            with mock.patch.object(
                windows_client, "is_reparse_point", side_effect=simulated_reparse
            ):
                with self.assertRaisesRegex(
                    windows_client.FrontierWindowsError, "contains a reparse point"
                ):
                    windows_client.verify_resfiles(stage, marker, paths)

            indexed_file.unlink()
            with self.assertRaisesRegex(
                windows_client.FrontierWindowsError, "missing or redirected"
            ):
                windows_client.verify_resfiles(stage, marker, paths)


if __name__ == "__main__":
    unittest.main()
