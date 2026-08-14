#!/usr/bin/env python3

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
DEFAULT_STAGE = Path.home() / "Library/Application Support/evejs-frontier/macos/staged-client/current"
DEFAULT_CA = REPO_ROOT / "server/certs/xmpp-ca-cert.pem"
DEFAULT_LEAF = REPO_ROOT / "server/certs/xmpp-dev-cert.pem"
LEGACY_PATCH_MANIFEST = SCRIPT_DIR / "blue-so.patch.json"
ENTITLEMENTS = SCRIPT_DIR / "exefile-entitlements.plist"
DOCKING_PATCHER = SCRIPT_DIR / "patch_frontier_docking.py"
FEATURE_PATCHER = SCRIPT_DIR / "patch_frontier_features.py"
FEATURE_PATCH_BUILDS = {3467658}
FRONTIER_FEATURES = [
    "safe-logoff",
    "skills",
    "shell-implants",
    "shell-reignment",
    "map-markers",
    "hud-system-info",
    "hud-route",
    "hud-search",
]
MANIFEST_NAMES = {
    "root:/bin64/packages/certifi/cacert.pem",
    "root:/bin64/blue.so",
    "root:/bin64/cacert.pem",
    "root:/bin64/exefile",
    "root:/code.ccp",
}


class PatchError(RuntimeError):
    pass


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_checked(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise PatchError(f"Command failed: {' '.join(command)}\n{detail}")
    return result


def resolve_python_312():
    candidates = [
        os.environ.get("EVEJS_FRONTIER_PYTHON312"),
        shutil.which("python3.12"),
        "/opt/homebrew/bin/python3.12",
        "/usr/local/bin/python3.12",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        result = subprocess.run(
            [candidate, "-S", "-c", "import sys; print(sys.version_info[:2])"],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0 and result.stdout.strip() == "(3, 12)":
            return candidate
    raise PatchError(
        "Python 3.12 is required to patch the Frontier client code archive."
    )


def resolve_patch_manifest(stage_build):
    build_manifest = SCRIPT_DIR / f"blue-so.{stage_build}.patch.json"
    candidates = [build_manifest, LEGACY_PATCH_MANIFEST]
    for candidate in candidates:
        if not candidate.is_file():
            continue
        manifest = load_json(candidate)
        if int(manifest.get("build", 0)) == stage_build:
            return manifest
    raise PatchError(
        f"No exact blue.so patch manifest is available for Frontier build {stage_build}."
    )


def inspect_docking_patch(code_archive, stage_build):
    result = run_checked(
        [
            resolve_python_312(),
            "-S",
            str(DOCKING_PATCHER),
            "--archive",
            str(code_archive),
            "--build",
            str(stage_build),
            "--check",
        ]
    )
    state = result.stdout.strip().splitlines()[-1]
    if state not in {"source", "patched"}:
        raise PatchError(f"Unexpected station docking patch state: {state}")
    return state


def apply_docking_patch(code_archive, stage_build):
    run_checked(
        [
            resolve_python_312(),
            "-S",
            str(DOCKING_PATCHER),
            "--archive",
            str(code_archive),
            "--build",
            str(stage_build),
        ]
    )


def inspect_feature_patch(code_archive, stage_build):
    if stage_build not in FEATURE_PATCH_BUILDS:
        return "not-configured"
    result = run_checked(
        [
            resolve_python_312(),
            "-S",
            str(FEATURE_PATCHER),
            "--archive",
            str(code_archive),
            "--build",
            str(stage_build),
            "--check",
        ]
    )
    state = result.stdout.strip().splitlines()[-1]
    if state not in {"source", "patched", "partial"}:
        raise PatchError(f"Unexpected Frontier feature patch state: {state}")
    return state


def apply_feature_patch(code_archive, stage_build):
    if stage_build not in FEATURE_PATCH_BUILDS:
        return
    run_checked(
        [
            resolve_python_312(),
            "-S",
            str(FEATURE_PATCHER),
            "--archive",
            str(code_archive),
            "--build",
            str(stage_build),
        ]
    )


def codesign_is_valid(path):
    result = subprocess.run(
        ["codesign", "--verify", "--verbose=2", str(path)],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def exefile_has_library_entitlement(path):
    result = subprocess.run(
        ["codesign", "-d", "--entitlements", ":-", str(path)],
        capture_output=True,
        text=True,
    )
    output = f"{result.stdout}\n{result.stderr}"
    return (
        result.returncode == 0
        and "com.apple.security.cs.allow-unsigned-executable-memory" in output
        and "com.apple.security.cs.disable-library-validation" in output
    )


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PatchError(f"Could not read JSON file {path}: {error}") from error


def read_build_number(start_ini):
    match = re.search(
        r"(?im)^\s*build\s*=\s*(\d+)",
        start_ini.read_text(encoding="utf-8", errors="replace"),
    )
    if not match:
        raise PatchError(f"Could not read the build number from {start_ini}")
    return int(match.group(1))


def common_ini_uses_placebo(common_ini):
    return bool(
        re.search(
            r"(?im)^\s*cryptoPack\s*=\s*Placebo\s*$",
            common_ini.read_text(encoding="utf-8", errors="replace"),
        )
    )


def read_fat_slices(path):
    data = path.read_bytes()
    if len(data) < 8:
        raise PatchError(f"Mach-O is too small: {path}")
    magic, count = struct.unpack_from(">II", data, 0)
    if magic != 0xCAFEBABE or count != 2:
        raise PatchError(f"Expected a two-slice FAT Mach-O: {path}")

    architecture_names = {
        0x01000007: "x86_64",
        0x0100000C: "arm64",
    }
    slices = {}
    for index in range(count):
        cpu_type, _subtype, offset, size, align = struct.unpack_from(
            ">IIIII", data, 8 + index * 20
        )
        arch = architecture_names.get(cpu_type)
        if arch is None:
            raise PatchError(f"Unsupported Mach-O CPU type 0x{cpu_type:08x}")
        slices[arch] = {
            "offset": offset,
            "size": size,
            "align": 1 << align,
        }
    return slices


def inspect_blue(path, patch_manifest, stage_build):
    expected_build = int(patch_manifest["build"])
    if stage_build != expected_build:
        raise PatchError(
            f"Staged build {stage_build} does not match patch build {expected_build}."
        )

    slices = read_fat_slices(path)
    source_slices = {
        entry["arch"]: entry for entry in patch_manifest["source"]["slices"]
    }
    for arch, expected in source_slices.items():
        actual = slices.get(arch)
        if actual is None or actual["offset"] != int(expected["offset"]):
            raise PatchError(f"Unexpected {arch} slice layout in {path}")

    data = path.read_bytes()
    states = []
    for patch in patch_manifest["patches"]:
        slice_offset = slices[patch["arch"]]["offset"]
        absolute = slice_offset + int(patch["offset"])
        before = bytes.fromhex(patch["beforeHex"])
        after = bytes.fromhex(patch["afterHex"])
        actual = data[absolute : absolute + len(before)]
        if actual == before:
            states.append("source")
        elif actual == after:
            states.append("patched")
        else:
            raise PatchError(
                f"Unexpected {patch['arch']} bytes at 0x{absolute:x}: {actual.hex()}"
            )

    if all(state == "source" for state in states):
        source = patch_manifest["source"]
        if len(data) != int(source["size"]) or sha256_file(path) != source["sha256"]:
            raise PatchError("blue.so has source instructions but is not the exact supported build.")
        return "source"
    if all(state == "patched" for state in states):
        return "patched"
    raise PatchError("blue.so contains a partial manifest-verification patch.")


def apply_blue_patch(path, patch_manifest):
    slices = read_fat_slices(path)
    with path.open("r+b") as handle:
        for patch in patch_manifest["patches"]:
            absolute = slices[patch["arch"]]["offset"] + int(patch["offset"])
            before = bytes.fromhex(patch["beforeHex"])
            after = bytes.fromhex(patch["afterHex"])
            handle.seek(absolute)
            actual = handle.read(len(before))
            if actual != before:
                raise PatchError(
                    f"blue.so changed during patching at 0x{absolute:x}: {actual.hex()}"
                )
            handle.seek(absolute)
            handle.write(after)
        handle.flush()
        os.fsync(handle.fileno())

    target = patch_manifest["targetUnsigned"]
    if path.stat().st_size != int(target["size"]) or sha256_file(path) != target["sha256"]:
        raise PatchError("Unsigned patched blue.so does not match the recorded target hash.")


def normalized_pem_text(path):
    text = path.read_text(encoding="ascii").replace("\r\n", "\n").strip()
    if not text.startswith("-----BEGIN CERTIFICATE-----"):
        raise PatchError(f"Expected a PEM certificate: {path}")
    return text


def bundle_contains_ca(bundle_path, ca_text):
    bundle_text = bundle_path.read_text(encoding="ascii").replace("\r\n", "\n")
    return ca_text in bundle_text


def append_ca(bundle_path, ca_text):
    if bundle_contains_ca(bundle_path, ca_text):
        return False
    with bundle_path.open("ab") as handle:
        if bundle_path.stat().st_size > 0:
            handle.write(b"\n")
        handle.write(ca_text.encode("ascii"))
        handle.write(b"\n")
        handle.flush()
        os.fsync(handle.fileno())
    return True


def parse_manifest(path):
    data = bytearray(path.read_bytes())
    if len(data) < 8:
        raise PatchError(f"manifest.dat is too small: {path}")
    version, entry_count = struct.unpack_from("<II", data, 0)
    if version != 4:
        raise PatchError(f"Unsupported manifest.dat version {version}")

    offset = 8
    entries = {}
    for index in range(entry_count):
        if offset + 8 > len(data):
            raise PatchError(f"manifest.dat ended before entry {index}")
        flags, name_len = struct.unpack_from("<II", data, offset)
        offset += 8
        if name_len <= 0 or name_len > 4096 or offset + name_len > len(data):
            raise PatchError(f"Invalid manifest path length at entry {index}")
        name = bytes(data[offset : offset + name_len]).decode("utf-8")
        offset += name_len
        if flags == 0:
            if offset + 4 > len(data):
                raise PatchError(f"Missing digest length at manifest entry {index}")
            digest_len = struct.unpack_from("<I", data, offset)[0]
            offset += 4
            if digest_len != 32 or offset + digest_len > len(data):
                raise PatchError(f"Invalid digest at manifest entry {index}")
            entries[name] = (offset, digest_len)
            offset += digest_len
    return data, entries, offset


def manifest_local_path(build_root, name):
    if not name.startswith("root:/"):
        raise PatchError(f"Unsupported targeted manifest path: {name}")
    return build_root / name[len("root:/") :]


def assert_manifest_entries(manifest_path):
    _data, entries, _trailer_offset = parse_manifest(manifest_path)
    missing = sorted(MANIFEST_NAMES.difference(entries))
    if missing:
        raise PatchError(f"Missing required manifest entries: {', '.join(missing)}")


def manifest_hashes_match(manifest_path, build_root):
    data, entries, _trailer_offset = parse_manifest(manifest_path)
    for name in MANIFEST_NAMES:
        digest_offset, digest_len = entries[name]
        local_path = manifest_local_path(build_root, name)
        digest = hashlib.sha256(local_path.read_bytes()).digest()
        if data[digest_offset : digest_offset + digest_len] != digest:
            return False
    return True


def refresh_manifest_hashes(manifest_path, build_root):
    data, entries, trailer_offset = parse_manifest(manifest_path)
    trailer = bytes(data[trailer_offset:])
    updated = 0
    for name in MANIFEST_NAMES:
        digest_offset, digest_len = entries[name]
        local_path = manifest_local_path(build_root, name)
        if not local_path.is_file():
            raise PatchError(f"Manifest target is missing: {local_path}")
        digest = hashlib.sha256(local_path.read_bytes()).digest()
        if data[digest_offset : digest_offset + digest_len] != digest:
            data[digest_offset : digest_offset + digest_len] = digest
            updated += 1
    if bytes(data[trailer_offset:]) != trailer:
        raise PatchError("Manifest signature trailer changed unexpectedly.")
    with manifest_path.open("r+b") as handle:
        handle.write(data)
        handle.truncate()
        handle.flush()
        os.fsync(handle.fileno())
    return updated


def certificate_fingerprint(ca_path):
    result = run_checked(
        ["openssl", "x509", "-in", str(ca_path), "-noout", "-fingerprint", "-sha256"]
    )
    output = result.stdout.strip()
    if "=" not in output:
        raise PatchError(f"Could not read certificate fingerprint from {ca_path}")
    return output.split("=", 1)[1]


def verify_ca_bundles(bundle_paths, leaf_path):
    for bundle_path in bundle_paths:
        run_checked(
            ["openssl", "verify", "-CAfile", str(bundle_path), str(leaf_path)]
        )


def make_backup(stage_root, paths):
    timestamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = stage_root / ".evejs-backups" / f"frontier-client-{timestamp}"
    suffix = 1
    while backup_root.exists():
        backup_root = stage_root / ".evejs-backups" / f"frontier-client-{timestamp}-{suffix}"
        suffix += 1
    for path in paths:
        relative = path.relative_to(stage_root)
        destination = backup_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    return backup_root


def restore_backup(stage_root, backup_root, paths):
    for path in paths:
        source = backup_root / path.relative_to(stage_root)
        if source.exists():
            shutil.copy2(source, path)


def update_stage_metadata(
    marker_path,
    backup_root,
    blue_path,
    code_archive,
    fingerprint,
    stage_build,
):
    marker = load_json(marker_path)
    marker.update(
        {
            "blueSoSha256": sha256_file(blue_path),
            "blueSoPatchState": "manifest-verifier-patched",
            "blueSoPatchBuild": stage_build,
            "codeCcpSha256": sha256_file(code_archive),
            "stationDockingPatchState": "enabled",
            "stationDockingPatchBuild": stage_build,
            "frontierFeaturePatchState": (
                "enabled" if stage_build in FEATURE_PATCH_BUILDS else "not-configured"
            ),
            "frontierFeaturePatchBuild": stage_build,
            "frontierFeaturesEnabled": (
                FRONTIER_FEATURES if stage_build in FEATURE_PATCH_BUILDS else []
            ),
            "xmppCaFingerprintSha256": fingerprint,
            "xmppTrustBundles": [
                "bin64/cacert.pem",
                "bin64/packages/certifi/cacert.pem",
            ],
            "manifestHashesRefreshed": True,
            "nestedCodeSignature": "ad-hoc-with-library-validation-disabled",
            "clientPatchBackup": str(backup_root),
            "clientPatchTimestamp": datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0)
            .isoformat(),
        }
    )
    temporary = marker_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, marker_path)


def validate_prepatch_metadata(stage_metadata, paths, stage_build):
    expected_blue_hash = str(stage_metadata.get("blueSoSha256", "")).lower()
    if not expected_blue_hash:
        raise PatchError("Stage metadata is missing the blue.so source hash.")
    if expected_blue_hash != sha256_file(paths["blue"]):
        raise PatchError(
            "Staged blue.so does not match the hash recorded in stage metadata."
        )

    expected_code_hash = str(stage_metadata.get("codeCcpSha256", "")).lower()
    if not expected_code_hash:
        if stage_build in FEATURE_PATCH_BUILDS:
            raise PatchError(
                "Stage metadata is missing the code.ccp source hash; restage this "
                "build before applying the exact Frontier feature patch."
            )
        return
    if expected_code_hash != sha256_file(paths["code"]):
        raise PatchError(
            "Staged code.ccp does not match the hash recorded in stage metadata."
        )


def stage_metadata_failures(stage_metadata, paths, stage_build, fingerprint):
    failures = []
    expected_features = FRONTIER_FEATURES if stage_build in FEATURE_PATCH_BUILDS else []
    expected_feature_state = (
        "enabled" if stage_build in FEATURE_PATCH_BUILDS else "not-configured"
    )

    if str(stage_metadata.get("blueSoSha256", "")).lower() != sha256_file(paths["blue"]):
        failures.append("blue.so marker hash")
    if stage_metadata.get("blueSoPatchState") != "manifest-verifier-patched":
        failures.append("blue.so marker state")
    if int(stage_metadata.get("blueSoPatchBuild", 0)) != stage_build:
        failures.append("blue.so marker build")
    if str(stage_metadata.get("codeCcpSha256", "")).lower() != sha256_file(paths["code"]):
        failures.append("code.ccp marker hash")
    if stage_metadata.get("stationDockingPatchState") != "enabled":
        failures.append("docking marker state")
    if int(stage_metadata.get("stationDockingPatchBuild", 0)) != stage_build:
        failures.append("docking marker build")
    feature_marker_present = any(
        key in stage_metadata
        for key in (
            "frontierFeaturePatchState",
            "frontierFeaturePatchBuild",
            "frontierFeaturesEnabled",
        )
    )
    if stage_build in FEATURE_PATCH_BUILDS or feature_marker_present:
        if stage_metadata.get("frontierFeaturePatchState") != expected_feature_state:
            failures.append("feature marker state")
        if int(stage_metadata.get("frontierFeaturePatchBuild", 0)) != stage_build:
            failures.append("feature marker build")
        if stage_metadata.get("frontierFeaturesEnabled") != expected_features:
            failures.append("feature marker list")
    if stage_metadata.get("xmppCaFingerprintSha256") != fingerprint:
        failures.append("CA fingerprint marker")
    if stage_metadata.get("manifestHashesRefreshed") is not True:
        failures.append("manifest marker")
    if stage_metadata.get("bootCryptoPack") != "Placebo":
        failures.append("crypto marker")
    if stage_metadata.get("resFilesMode") != "symlink":
        failures.append("ResFiles marker")
    return failures


def resolve_stage_paths(stage_argument):
    stage_root = stage_argument.expanduser().resolve()
    marker = stage_root / ".evejs-frontier-stage.json"
    app = stage_root / "SharedCache/stillness/EVE.app"
    build_root = app / "Contents/Resources/build"
    paths = {
        "stage": stage_root,
        "marker": marker,
        "app": app,
        "build": build_root,
        "manifest": build_root / "manifest.dat",
        "blue": build_root / "bin64/blue.so",
        "exefile": build_root / "bin64/exefile",
        "code": build_root / "code.ccp",
        "bundle": build_root / "bin64/cacert.pem",
        "certifi_bundle": build_root / "bin64/packages/certifi/cacert.pem",
        "start_ini": build_root / "start.ini",
        "common_ini": build_root / "common.ini",
        "resfiles": stage_root / "SharedCache/ResFiles",
    }
    missing = [str(path) for key, path in paths.items() if key != "stage" and not path.exists()]
    if missing:
        raise PatchError(f"Staged client is incomplete; missing: {', '.join(missing)}")
    return paths


def main():
    parser = argparse.ArgumentParser(
        description="Patch the isolated macOS Frontier client for EveJS XMPP trust."
    )
    parser.add_argument("--staged-root", type=Path, default=DEFAULT_STAGE)
    parser.add_argument("--ca", type=Path, default=DEFAULT_CA)
    parser.add_argument("--leaf", type=Path, default=DEFAULT_LEAF)
    parser.add_argument("--check", action="store_true")
    parser.add_argument(
        "--preflight",
        action="store_true",
        help="Verify recorded stage hashes and isolation without changing files.",
    )
    args = parser.parse_args()

    if args.check and args.preflight:
        raise PatchError("Choose either --check or --preflight, not both.")

    paths = resolve_stage_paths(args.staged_root)
    stage_metadata = load_json(paths["marker"])
    stage_build = read_build_number(paths["start_ini"])
    if int(stage_metadata.get("build", 0)) != stage_build:
        raise PatchError("Stage metadata and start.ini build numbers do not agree.")
    if args.preflight:
        validate_prepatch_metadata(stage_metadata, paths, stage_build)
        if not common_ini_uses_placebo(paths["common_ini"]):
            raise PatchError("Staged common.ini is not configured for Placebo crypto.")
        if not paths["resfiles"].is_symlink():
            raise PatchError("Staged ResFiles is not an isolated symlink.")
        print(
            f"[evejs-frontier] Stage integrity preflight passed for build {stage_build}."
        )
        return 0
    if not args.check:
        validate_prepatch_metadata(stage_metadata, paths, stage_build)
        if not common_ini_uses_placebo(paths["common_ini"]):
            raise PatchError("Staged common.ini is not configured for Placebo crypto.")
        if not paths["resfiles"].is_symlink():
            raise PatchError("Staged ResFiles is not an isolated symlink.")
    patch_manifest = resolve_patch_manifest(stage_build)
    assert_manifest_entries(paths["manifest"])
    ca_path = args.ca.expanduser().resolve()
    leaf_path = args.leaf.expanduser().resolve()
    ca_text = normalized_pem_text(ca_path)
    normalized_pem_text(leaf_path)
    fingerprint = certificate_fingerprint(ca_path)
    blue_state = inspect_blue(paths["blue"], patch_manifest, stage_build)
    docking_state = inspect_docking_patch(paths["code"], stage_build)
    feature_state = inspect_feature_patch(paths["code"], stage_build)
    bundle_paths = [paths["bundle"], paths["certifi_bundle"]]
    bundles_trusted = all(bundle_contains_ca(path, ca_text) for path in bundle_paths)

    if args.check:
        manifest_current = manifest_hashes_match(paths["manifest"], paths["build"])
        signatures_valid = (
            codesign_is_valid(paths["blue"])
            and codesign_is_valid(paths["exefile"])
        )
        entitlements_valid = exefile_has_library_entitlement(paths["exefile"])
        crypto_valid = common_ini_uses_placebo(paths["common_ini"])
        resfiles_valid = paths["resfiles"].is_symlink()
        metadata_failures = stage_metadata_failures(
            stage_metadata,
            paths,
            stage_build,
            fingerprint,
        )
        print(f"[evejs-frontier] Build: {stage_build}")
        print(f"[evejs-frontier] blue.so: {blue_state}")
        print(f"[evejs-frontier] Station docking: {docking_state}")
        print(f"[evejs-frontier] Frontier features: {feature_state}")
        print(f"[evejs-frontier] XMPP CA in both bundles: {'yes' if bundles_trusted else 'no'}")
        print(
            "[evejs-frontier] Manifest hashes current: "
            f"{'yes' if manifest_current else 'no'}"
        )
        print(
            "[evejs-frontier] Nested code signatures valid: "
            f"{'yes' if signatures_valid else 'no'}"
        )
        print(
            "[evejs-frontier] exefile entitlements valid: "
            f"{'yes' if entitlements_valid else 'no'}"
        )
        print(
            "[evejs-frontier] Placebo boot crypto configured: "
            f"{'yes' if crypto_valid else 'no'}"
        )
        print(
            "[evejs-frontier] ResFiles isolated symlink: "
            f"{'yes' if resfiles_valid else 'no'}"
        )
        failures = []
        if blue_state != "patched":
            failures.append("blue.so")
        if docking_state != "patched":
            failures.append("station docking")
        if stage_build in FEATURE_PATCH_BUILDS and feature_state != "patched":
            failures.append("Frontier features")
        if not bundles_trusted:
            failures.append("embedded CA bundles")
        if not manifest_current:
            failures.append("manifest hashes")
        if not signatures_valid:
            failures.append("nested signatures")
        if not entitlements_valid:
            failures.append("exefile entitlements")
        if not crypto_valid:
            failures.append("Placebo boot crypto")
        if not resfiles_valid:
            failures.append("ResFiles symlink")
        failures.extend(metadata_failures)
        if failures:
            raise PatchError(
                "Staged client verification failed: " + ", ".join(failures)
            )
        verify_ca_bundles(bundle_paths, leaf_path)
        return 0

    touched_paths = [
        paths["blue"],
        paths["exefile"],
        paths["code"],
        paths["bundle"],
        paths["certifi_bundle"],
        paths["manifest"],
        paths["marker"],
    ]
    backup_root = make_backup(paths["stage"], touched_paths)

    try:
        for bundle_path in bundle_paths:
            append_ca(bundle_path, ca_text)

        if blue_state == "source":
            apply_blue_patch(paths["blue"], patch_manifest)

        if docking_state == "source":
            apply_docking_patch(paths["code"], stage_build)

        if stage_build in FEATURE_PATCH_BUILDS and feature_state != "patched":
            apply_feature_patch(paths["code"], stage_build)

        needs_signing = (
            blue_state == "source"
            or not codesign_is_valid(paths["blue"])
            or not codesign_is_valid(paths["exefile"])
            or not exefile_has_library_entitlement(paths["exefile"])
        )
        if needs_signing:
            run_checked(
                [
                    "codesign",
                    "--force",
                    "--sign",
                    "-",
                    "--timestamp=none",
                    "--preserve-metadata=identifier,entitlements,flags,runtime",
                    str(paths["blue"]),
                ]
            )
            run_checked(
                [
                    "codesign",
                    "--force",
                    "--sign",
                    "-",
                    "--timestamp=none",
                    "--options",
                    "runtime",
                    "--entitlements",
                    str(ENTITLEMENTS),
                    str(paths["exefile"]),
                ]
            )

        updated_entries = refresh_manifest_hashes(paths["manifest"], paths["build"])

        if inspect_blue(paths["blue"], patch_manifest, stage_build) != "patched":
            raise PatchError("blue.so patch verification failed after signing.")
        if inspect_docking_patch(paths["code"], stage_build) != "patched":
            raise PatchError("Station docking patch verification failed.")
        if (
            stage_build in FEATURE_PATCH_BUILDS
            and inspect_feature_patch(paths["code"], stage_build) != "patched"
        ):
            raise PatchError("Frontier feature patch verification failed.")
        if not codesign_is_valid(paths["blue"]) or not codesign_is_valid(paths["exefile"]):
            raise PatchError("Nested code-signature verification failed.")
        if not exefile_has_library_entitlement(paths["exefile"]):
            raise PatchError("exefile is missing the library-validation entitlement.")
        verify_ca_bundles(bundle_paths, leaf_path)
        if not manifest_hashes_match(paths["manifest"], paths["build"]):
            raise PatchError("One or more refreshed manifest hashes do not match.")

        update_stage_metadata(
            paths["marker"],
            backup_root,
            paths["blue"],
            paths["code"],
            fingerprint,
            stage_build,
        )
    except Exception:
        restore_backup(paths["stage"], backup_root, touched_paths)
        raise

    print(f"[evejs-frontier] Backup: {backup_root}")
    print(f"[evejs-frontier] blue.so: manifest verifier patched for build {stage_build}")
    print("[evejs-frontier] Station docking: enabled in staged code.ccp")
    if stage_build in FEATURE_PATCH_BUILDS:
        print("[evejs-frontier] Tested Frontier features: enabled in staged code.ccp")
    print(f"[evejs-frontier] XMPP CA: trusted in both embedded bundles ({fingerprint})")
    print(f"[evejs-frontier] Manifest hashes refreshed: {updated_entries}")
    print("[evejs-frontier] Nested code signatures: valid")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PatchError as error:
        print(f"[evejs-frontier] {error}", file=sys.stderr)
        raise SystemExit(1)
