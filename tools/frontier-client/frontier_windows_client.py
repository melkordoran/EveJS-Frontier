#!/usr/bin/env python3

from __future__ import annotations

import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import struct
import subprocess
import sys
import uuid


SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
STAGE_MARKER_NAME = ".evejs-frontier-stage.json"
STAGE_FORMAT = "evejs-frontier-stage-v2"
PE_PROFILE_FORMAT = "evejs-frontier-windows-pe-patch-v1"
DEFAULT_CA = REPO_ROOT / "server/certs/xmpp-ca-cert.pem"
DEFAULT_XMPP_LEAF = REPO_ROOT / "server/certs/xmpp-dev-cert.pem"
DEFAULT_GATEWAY_LEAF = (
    REPO_ROOT / "server/src/_secondary/express/certs/gateway-dev-cert.pem"
)
CERTIFICATE_VERIFIER = SCRIPT_DIR / "verify-frontier-certificates.mjs"
DOCKING_PATCHER = SCRIPT_DIR / "patch_frontier_docking.py"
FEATURE_PATCHER = SCRIPT_DIR / "patch_frontier_features.py"
PEM_CERTIFICATE_RE = re.compile(
    rb"-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\r\n]+?)\s+"
    rb"-----END CERTIFICATE-----",
    re.MULTILINE,
)


class FrontierWindowsError(RuntimeError):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FrontierWindowsError(f"Could not read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise FrontierWindowsError(f"Expected a JSON object in {path}.")
    return value


def write_json_atomic(path: Path, value: dict) -> None:
    payload = (json.dumps(value, indent=2) + "\n").encode("utf-8")
    write_bytes_atomic(path, payload)


def write_bytes_atomic(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}")
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if temporary.read_bytes() != data:
            raise FrontierWindowsError(f"Temporary file verification failed: {temporary}")
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def copy_file_atomic(source: Path, destination: Path) -> None:
    data = source.read_bytes()
    write_bytes_atomic(destination, data)
    shutil.copystat(source, destination, follow_symlinks=False)


def normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.abspath(os.fspath(path)))


def is_within(path: Path, root: Path) -> bool:
    try:
        return os.path.commonpath([normalized_path(path), normalized_path(root)]) == normalized_path(root)
    except ValueError:
        return False


def safe_relative_path(root: Path, relative: str) -> Path:
    normalized = relative.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if pure.is_absolute() or not pure.parts:
        raise FrontierWindowsError(f"Unsafe relative path: {relative!r}")
    if any(part in {"", ".", ".."} or ":" in part for part in pure.parts):
        raise FrontierWindowsError(f"Unsafe relative path: {relative!r}")
    candidate = root.joinpath(*pure.parts)
    if not is_within(candidate, root):
        raise FrontierWindowsError(f"Path escapes its root: {relative!r}")
    return candidate


def parse_hex_int(value, label: str) -> int:
    try:
        return int(str(value), 0)
    except (TypeError, ValueError) as error:
        raise FrontierWindowsError(f"Invalid {label}: {value!r}") from error


def resolve_profile(build: int, native_blue_name: str, explicit: Path | None = None) -> tuple[Path, dict]:
    if explicit is not None:
        profile_path = explicit.resolve()
    else:
        stem = "blue-pyd" if native_blue_name.lower() == "blue.pyd" else "blue-dll"
        profile_path = SCRIPT_DIR / f"{stem}.{build}.patch.json"
    if not profile_path.is_file():
        raise FrontierWindowsError(
            f"No exact Windows {native_blue_name} profile exists for Frontier build {build}: "
            f"{profile_path}"
        )
    profile = read_json(profile_path)
    if profile.get("format") != PE_PROFILE_FORMAT:
        raise FrontierWindowsError(f"Unrecognized PE patch profile format: {profile_path}")
    if int(profile.get("build", 0)) != build:
        raise FrontierWindowsError(
            f"Patch profile build {profile.get('build')} does not match staged build {build}."
        )
    if str(profile.get("name", "")).lower() != native_blue_name.lower():
        raise FrontierWindowsError(
            f"Patch profile targets {profile.get('name')}, not {native_blue_name}."
        )
    return profile_path, profile


def read_u16(data: bytes | bytearray, offset: int) -> int:
    if offset < 0 or offset + 2 > len(data):
        raise FrontierWindowsError("PE header field is outside the file.")
    return struct.unpack_from("<H", data, offset)[0]


def read_u32(data: bytes | bytearray, offset: int) -> int:
    if offset < 0 or offset + 4 > len(data):
        raise FrontierWindowsError("PE header field is outside the file.")
    return struct.unpack_from("<I", data, offset)[0]


def parse_pe_layout(data: bytes | bytearray) -> dict:
    if len(data) < 0x100 or bytes(data[:2]) != b"MZ":
        raise FrontierWindowsError("Native blue file is not an MZ/PE image.")
    pe_offset = read_u32(data, 0x3C)
    if pe_offset <= 0 or pe_offset + 24 > len(data):
        raise FrontierWindowsError("PE header offset is invalid.")
    if bytes(data[pe_offset : pe_offset + 4]) != b"PE\0\0":
        raise FrontierWindowsError("PE signature is invalid.")
    file_header = pe_offset + 4
    machine = read_u16(data, file_header)
    section_count = read_u16(data, file_header + 2)
    optional_size = read_u16(data, file_header + 16)
    optional = file_header + 20
    if optional + optional_size > len(data):
        raise FrontierWindowsError("PE optional header is truncated.")
    magic = read_u16(data, optional)
    if magic == 0x20B:
        data_directory = optional + 112
        number_of_directories_offset = optional + 108
        pe_format = "PE32+"
    elif magic == 0x10B:
        data_directory = optional + 96
        number_of_directories_offset = optional + 92
        pe_format = "PE32"
    else:
        raise FrontierWindowsError(f"Unsupported PE optional-header magic 0x{magic:04x}.")
    if read_u32(data, number_of_directories_offset) < 5:
        raise FrontierWindowsError("PE has no Authenticode security directory slot.")
    checksum_offset = optional + 64
    security_directory_offset = data_directory + 4 * 8
    if security_directory_offset + 8 > optional + optional_size:
        raise FrontierWindowsError("PE security-directory slot is outside the optional header.")
    section_table = optional + optional_size
    if section_count <= 0 or section_table + section_count * 40 > len(data):
        raise FrontierWindowsError("PE section table is invalid.")
    maximum_raw_end = 0
    sections = []
    for index in range(section_count):
        entry = section_table + index * 40
        name = bytes(data[entry : entry + 8]).rstrip(b"\0").decode("ascii", "replace")
        raw_size = read_u32(data, entry + 16)
        raw_offset = read_u32(data, entry + 20)
        raw_end = raw_offset + raw_size
        if raw_end > len(data):
            raise FrontierWindowsError(f"PE section {name!r} extends beyond the file.")
        maximum_raw_end = max(maximum_raw_end, raw_end)
        sections.append({"name": name, "rawOffset": raw_offset, "rawSize": raw_size})
    return {
        "checksumOffset": checksum_offset,
        "machine": machine,
        "maximumSectionRawEnd": maximum_raw_end,
        "optionalMagic": magic,
        "peFormat": pe_format,
        "securityDirectoryOffset": security_directory_offset,
        "securityFileOffset": read_u32(data, security_directory_offset),
        "securitySize": read_u32(data, security_directory_offset + 4),
        "sections": sections,
    }


def validate_certificate_overlay(data: bytes | bytearray, layout: dict) -> list[dict]:
    offset = layout["securityFileOffset"]
    size = layout["securitySize"]
    if offset <= 0 or size < 8:
        raise FrontierWindowsError("Expected a non-empty Authenticode security directory.")
    if offset % 8 != 0:
        raise FrontierWindowsError("Authenticode certificate overlay is not 8-byte aligned.")
    if offset < layout["maximumSectionRawEnd"]:
        raise FrontierWindowsError("Authenticode overlay overlaps PE section data.")
    if offset + size != len(data):
        raise FrontierWindowsError(
            "Authenticode security directory is not the complete end-of-file overlay."
        )
    entries = []
    cursor = offset
    end = offset + size
    while cursor < end:
        if cursor + 8 > end:
            raise FrontierWindowsError("Truncated WIN_CERTIFICATE header.")
        length, revision, certificate_type = struct.unpack_from("<IHH", data, cursor)
        if length < 8:
            raise FrontierWindowsError("Invalid WIN_CERTIFICATE length.")
        aligned_length = (length + 7) & ~7
        if cursor + aligned_length > end:
            raise FrontierWindowsError("WIN_CERTIFICATE extends beyond the security directory.")
        if revision not in {0x0100, 0x0200} or certificate_type != 0x0002:
            raise FrontierWindowsError(
                "Unsupported Authenticode certificate revision or certificate type."
            )
        entries.append(
            {
                "offset": cursor,
                "length": length,
                "alignedLength": aligned_length,
                "revision": revision,
                "type": certificate_type,
            }
        )
        cursor += aligned_length
    if cursor != end or not entries:
        raise FrontierWindowsError("Authenticode certificate overlay is malformed.")
    return entries


def calculate_pe_checksum(data: bytes | bytearray, checksum_offset: int) -> int:
    payload = bytearray(data)
    if checksum_offset < 0 or checksum_offset + 4 > len(payload):
        raise FrontierWindowsError("PE checksum field is outside the file.")
    payload[checksum_offset : checksum_offset + 4] = b"\0\0\0\0"
    total = 0
    for offset in range(0, len(payload), 2):
        word = payload[offset]
        if offset + 1 < len(payload):
            word |= payload[offset + 1] << 8
        total = (total + word) & 0xFFFFFFFF
        total = (total & 0xFFFF) + (total >> 16)
    total = (total & 0xFFFF) + (total >> 16)
    total += total >> 16
    return (total & 0xFFFF) + len(payload)


def patch_bytes_match(data: bytes | bytearray, patch: dict, key: str) -> bool:
    offset = int(patch["fileOffset"])
    expected = bytes.fromhex(str(patch[key]))
    return bytes(data[offset : offset + len(expected)]) == expected


def validate_patch_context(data: bytes | bytearray, patch: dict) -> None:
    offset = int(patch["fileOffset"])
    before_context = bytes.fromhex(str(patch["contextBeforeHex"]))
    after_context = bytes.fromhex(str(patch["contextAfterHex"]))
    patch_size = len(bytes.fromhex(str(patch["beforeHex"])))
    if bytes(data[offset - len(before_context) : offset]) != before_context:
        raise FrontierWindowsError(
            f"Native blue context-before mismatch at {patch.get('fileOffsetHex')}."
        )
    if bytes(data[offset + patch_size : offset + patch_size + len(after_context)]) != after_context:
        raise FrontierWindowsError(
            f"Native blue context-after mismatch at {patch.get('fileOffsetHex')}."
        )


def inspect_blue_bytes(data: bytes, profile: dict) -> str:
    digest = sha256_bytes(data)
    source = profile["source"]
    target = profile["target"]
    patches = list(profile.get("patches", []))
    if not patches:
        raise FrontierWindowsError("PE patch profile contains no patches.")
    if len(data) == int(source["size"]) and digest == str(source["sha256"]).lower():
        layout = parse_pe_layout(data)
        if layout["machine"] != 0x8664 or layout["peFormat"] != "PE32+":
            raise FrontierWindowsError("Exact source is not an AMD64 PE32+ image.")
        expected_security = source["authenticode"]
        if layout["securityFileOffset"] != parse_hex_int(
            expected_security["securityDirectoryOffsetHex"], "security offset"
        ) or layout["securitySize"] != parse_hex_int(
            expected_security["securityDirectorySizeHex"], "security size"
        ):
            raise FrontierWindowsError("Source Authenticode directory does not match the profile.")
        validate_certificate_overlay(data, layout)
        for patch in patches:
            validate_patch_context(data, patch)
            if not patch_bytes_match(data, patch, "beforeHex"):
                raise FrontierWindowsError(
                    f"Source instruction mismatch at {patch.get('fileOffsetHex')}."
                )
        return "source"
    if len(data) == int(target["size"]) and digest == str(target["sha256"]).lower():
        layout = parse_pe_layout(data)
        if layout["machine"] != 0x8664 or layout["peFormat"] != "PE32+":
            raise FrontierWindowsError("Exact target is not an AMD64 PE32+ image.")
        if layout["securityFileOffset"] != 0 or layout["securitySize"] != 0:
            raise FrontierWindowsError("Exact target still has an Authenticode security directory.")
        expected_checksum = parse_hex_int(target["peChecksumHex"], "target checksum")
        actual_checksum = read_u32(data, layout["checksumOffset"])
        calculated_checksum = calculate_pe_checksum(data, layout["checksumOffset"])
        if actual_checksum != expected_checksum or calculated_checksum != expected_checksum:
            raise FrontierWindowsError("Exact target PE checksum is invalid.")
        for patch in patches:
            validate_patch_context(data, patch)
            if not patch_bytes_match(data, patch, "afterHex"):
                raise FrontierWindowsError(
                    f"Target instruction mismatch at {patch.get('fileOffsetHex')}."
                )
        return "target"
    patch_states = []
    for patch in patches:
        try:
            validate_patch_context(data, patch)
        except FrontierWindowsError:
            patch_states.append("unknown")
            continue
        if patch_bytes_match(data, patch, "beforeHex"):
            patch_states.append("source")
        elif patch_bytes_match(data, patch, "afterHex"):
            patch_states.append("target")
        else:
            patch_states.append("unknown")
    if "target" in patch_states or len(set(patch_states)) > 1:
        return "partial"
    return "unknown"


def inspect_blue(path: Path, profile: dict) -> str:
    if not path.is_file():
        raise FrontierWindowsError(f"Native blue file is missing: {path}")
    return inspect_blue_bytes(path.read_bytes(), profile)


def build_blue_target(source_data: bytes, profile: dict) -> bytes:
    if inspect_blue_bytes(source_data, profile) != "source":
        raise FrontierWindowsError("Native blue file is not the exact supported source.")
    layout = parse_pe_layout(source_data)
    validate_certificate_overlay(source_data, layout)
    output = bytearray(source_data)
    for patch in profile["patches"]:
        offset = int(patch["fileOffset"])
        before = bytes.fromhex(str(patch["beforeHex"]))
        after = bytes.fromhex(str(patch["afterHex"]))
        if len(before) != len(after):
            raise FrontierWindowsError("PE patch changes instruction length.")
        if bytes(output[offset : offset + len(before)]) != before:
            raise FrontierWindowsError(
                f"PE patch precondition changed at {patch.get('fileOffsetHex')}."
            )
        output[offset : offset + len(after)] = after
    output = output[: layout["securityFileOffset"]]
    truncated_layout = parse_pe_layout(output)
    struct.pack_into("<II", output, truncated_layout["securityDirectoryOffset"], 0, 0)
    checksum = calculate_pe_checksum(output, truncated_layout["checksumOffset"])
    struct.pack_into("<I", output, truncated_layout["checksumOffset"], checksum)
    result = bytes(output)
    if inspect_blue_bytes(result, profile) != "target":
        raise FrontierWindowsError("Derived native blue target failed full target validation.")
    return result


def patch_blue_atomic(path: Path, profile: dict) -> str:
    source_data = path.read_bytes()
    state = inspect_blue_bytes(source_data, profile)
    if state == "target":
        return state
    if state != "source":
        raise FrontierWindowsError(f"Native blue patch state is {state}; refusing mutation.")
    target_data = build_blue_target(source_data, profile)
    write_bytes_atomic(path, target_data)
    if inspect_blue(path, profile) != "target":
        raise FrontierWindowsError("Native blue atomic replacement did not verify.")
    return "target"


def normalize_manifest_name(name: str) -> str:
    normalized = name.replace("\\", "/")
    match = re.fullmatch(r"(?i)(root|app|bin):/(.+)", normalized)
    if not match:
        raise FrontierWindowsError(f"Unsupported manifest path: {name!r}")
    scheme = match.group(1).lower()
    relative = match.group(2)
    pure = PurePosixPath(relative)
    if pure.is_absolute() or not pure.parts:
        raise FrontierWindowsError(f"Invalid manifest path: {name!r}")
    if any(part in {"", ".", ".."} or ":" in part for part in pure.parts):
        raise FrontierWindowsError(f"Manifest path escapes the build root: {name!r}")
    return f"{scheme}:/{'/'.join(pure.parts)}"


def manifest_windows_collision_key(normalized_name: str) -> str:
    """Return a separator-normalized manifest name using Windows case semantics."""
    return normalized_name.casefold()


def manifest_relative_path(name: str) -> str:
    normalized = normalize_manifest_name(name)
    prefix = "root:/"
    if not normalized.startswith(prefix):
        raise FrontierWindowsError(f"Unsupported targeted manifest path: {name!r}")
    return normalized[len(prefix) :]


def parse_manifest(data: bytes) -> dict:
    if len(data) < 8:
        raise FrontierWindowsError("manifest.dat is too small.")
    version, count = struct.unpack_from("<II", data, 0)
    if version != 4:
        raise FrontierWindowsError(f"Unsupported manifest.dat version {version}.")
    if count <= 0 or count > 100000:
        raise FrontierWindowsError(f"Invalid manifest entry count {count}.")
    cursor = 8
    entries = {}
    normalized_names = {}
    ordered = []
    for index in range(count):
        if cursor + 8 > len(data):
            raise FrontierWindowsError(f"manifest.dat ended before entry {index}.")
        flags, name_length = struct.unpack_from("<II", data, cursor)
        cursor += 8
        if name_length <= 0 or name_length > 4096 or cursor + name_length > len(data):
            raise FrontierWindowsError(f"Invalid manifest path length at entry {index}.")
        try:
            name = data[cursor : cursor + name_length].decode("utf-8", "strict")
        except UnicodeDecodeError as error:
            raise FrontierWindowsError(f"Invalid UTF-8 manifest path at entry {index}.") from error
        cursor += name_length
        if name in entries:
            raise FrontierWindowsError(f"Duplicate manifest path: {name!r}")
        if flags == 0:
            normalized = normalize_manifest_name(name)
        elif flags == 1:
            alias_match = re.fullmatch(r"(?i)(lib|bin|app|root):(.+)", name.replace("\\", "/"))
            if not alias_match:
                raise FrontierWindowsError(f"Invalid manifest alias entry: {name!r}")
            normalized = (
                f"{alias_match.group(1).lower()}:"
                f"{normalize_manifest_name(alias_match.group(2))}"
            )
        else:
            raise FrontierWindowsError(
                f"Unsupported manifest field type {flags} at entry {index}."
            )
        collision_key = manifest_windows_collision_key(normalized)
        if collision_key in normalized_names:
            raise FrontierWindowsError(
                f"Duplicate normalized manifest path: {name!r} and "
                f"{normalized_names[collision_key]!r}"
            )
        digest_offset = None
        digest_length = None
        if flags == 0:
            if cursor + 4 > len(data):
                raise FrontierWindowsError(f"Missing digest length at manifest entry {index}.")
            digest_length = struct.unpack_from("<I", data, cursor)[0]
            cursor += 4
            if digest_length != 32 or cursor + digest_length > len(data):
                raise FrontierWindowsError(f"Invalid digest at manifest entry {index}.")
            digest_offset = cursor
            cursor += digest_length
        entry = {
            "digestLength": digest_length,
            "digestOffset": digest_offset,
            "flags": flags,
            "name": name,
            "normalized": normalized,
        }
        entries[name] = entry
        normalized_names[collision_key] = name
        ordered.append(entry)
    if cursor > len(data):
        raise FrontierWindowsError("manifest.dat entry table extends beyond the file.")
    return {
        "entries": entries,
        "entryCount": count,
        "ordered": ordered,
        "trailer": data[cursor:],
        "trailerOffset": cursor,
        "version": version,
    }


def manifest_targets(profile: dict, stage_root: Path, manifest: dict) -> list[tuple[dict, Path]]:
    target_names = list(profile.get("manifestTargets", []))
    if not target_names:
        raise FrontierWindowsError("PE profile contains no manifest targets.")
    target_keys = [
        manifest_windows_collision_key(normalize_manifest_name(name)) for name in target_names
    ]
    if len(target_keys) != len(set(target_keys)):
        raise FrontierWindowsError("PE profile contains duplicate manifest targets.")
    targets = []
    for name in target_names:
        entry = manifest["entries"].get(name)
        if entry is None:
            raise FrontierWindowsError(f"Required exact manifest entry is missing: {name!r}")
        if entry["flags"] != 0 or entry["digestLength"] != 32:
            raise FrontierWindowsError(f"Manifest target has no supported SHA-256 digest: {name!r}")
        local_path = safe_relative_path(stage_root, manifest_relative_path(entry["name"]))
        if not local_path.is_file():
            raise FrontierWindowsError(f"Manifest target file is missing: {local_path}")
        targets.append((entry, local_path))
    return targets


def manifest_hashes_match(path: Path, stage_root: Path, profile: dict) -> bool:
    data = path.read_bytes()
    manifest = parse_manifest(data)
    for entry, local_path in manifest_targets(profile, stage_root, manifest):
        expected = hashlib.sha256(local_path.read_bytes()).digest()
        offset = entry["digestOffset"]
        if data[offset : offset + 32] != expected:
            return False
    return True


def refresh_manifest_atomic(path: Path, stage_root: Path, profile: dict) -> dict:
    original = path.read_bytes()
    manifest = parse_manifest(original)
    output = bytearray(original)
    changed_spans = []
    for entry, local_path in manifest_targets(profile, stage_root, manifest):
        digest = hashlib.sha256(local_path.read_bytes()).digest()
        offset = entry["digestOffset"]
        if output[offset : offset + 32] != digest:
            output[offset : offset + 32] = digest
            changed_spans.append((offset, offset + 32, entry["name"]))
    trailer_offset = manifest["trailerOffset"]
    if bytes(output[trailer_offset:]) != manifest["trailer"]:
        raise FrontierWindowsError("manifest.dat trailer changed unexpectedly.")
    allowed_indexes = {
        index
        for start, end, _name in changed_spans
        for index in range(start, end)
    }
    actual_changed = {
        index for index, (before, after) in enumerate(zip(original, output)) if before != after
    }
    if not actual_changed.issubset(allowed_indexes):
        raise FrontierWindowsError("manifest.dat changed outside intended digest spans.")
    write_bytes_atomic(path, bytes(output))
    if path.read_bytes()[trailer_offset:] != manifest["trailer"]:
        raise FrontierWindowsError("manifest.dat trailer was not preserved after replacement.")
    if not manifest_hashes_match(path, stage_root, profile):
        raise FrontierWindowsError("manifest.dat target digests do not verify after replacement.")
    return {
        "changedEntries": [name for _start, _end, name in changed_spans],
        "trailerOffset": trailer_offset,
        "trailerSha256": sha256_bytes(manifest["trailer"]),
    }


def pem_certificate_ders(data: bytes, label: str) -> list[bytes]:
    certificates = []
    for match in PEM_CERTIFICATE_RE.finditer(data):
        compact = re.sub(rb"\s+", b"", match.group(1))
        try:
            certificates.append(base64.b64decode(compact, validate=True))
        except ValueError as error:
            raise FrontierWindowsError(f"Invalid PEM certificate in {label}.") from error
    return certificates


def read_ca(path: Path) -> tuple[bytes, bytes, str]:
    if not path.is_file():
        raise FrontierWindowsError(f"EveJS CA certificate is missing: {path}")
    raw = path.read_bytes().replace(b"\r\n", b"\n").strip()
    ders = pem_certificate_ders(raw, str(path))
    if len(ders) != 1:
        raise FrontierWindowsError(f"Expected exactly one certificate in EveJS CA file: {path}")
    pem = raw + b"\n"
    return pem, ders[0], sha256_bytes(ders[0])


def ca_count_in_bundle(bundle_path: Path, ca_der: bytes) -> int:
    if not bundle_path.is_file():
        raise FrontierWindowsError(f"Staged CA bundle is missing: {bundle_path}")
    return sum(
        certificate == ca_der
        for certificate in pem_certificate_ders(bundle_path.read_bytes(), str(bundle_path))
    )


def append_ca_atomic(bundle_path: Path, ca_pem: bytes, ca_der: bytes) -> bool:
    original = bundle_path.read_bytes()
    count = ca_count_in_bundle(bundle_path, ca_der)
    if count > 1:
        raise FrontierWindowsError(
            f"EveJS CA appears {count} times in staged bundle {bundle_path}; refusing mutation."
        )
    if count == 1:
        return False
    separator = b"" if not original or original.endswith((b"\n", b"\r")) else b"\n"
    output = original + separator + ca_pem
    write_bytes_atomic(bundle_path, output)
    if ca_count_in_bundle(bundle_path, ca_der) != 1:
        raise FrontierWindowsError(f"Could not append the EveJS CA exactly once to {bundle_path}.")
    return True


def resolve_node(explicit: Path | None = None) -> Path:
    candidates = [
        explicit,
        Path(os.environ["EVEJS_FRONTIER_NODE"]) if os.environ.get("EVEJS_FRONTIER_NODE") else None,
        Path(shutil.which("node")) if shutil.which("node") else None,
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "nodejs/node.exe",
    ]
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        package_root = Path(local_app_data) / "Microsoft/WinGet/Packages"
        if package_root.is_dir():
            candidates.extend(
                sorted(
                    package_root.glob("OpenJS.NodeJS.LTS_*/node-*-win-x64/node.exe"),
                    reverse=True,
                )
            )
    for candidate in candidates:
        if candidate and candidate.is_file():
            return candidate.resolve()
    raise FrontierWindowsError("Node.js 24 LTS was not found for certificate verification.")


def verify_certificate_chain(
    node: Path,
    ca_path: Path,
    xmpp_leaf: Path,
    gateway_leaf: Path,
    bundles: list[Path],
) -> dict:
    command = [
        str(node),
        str(CERTIFICATE_VERIFIER),
        "--ca",
        str(ca_path),
        "--xmpp-leaf",
        str(xmpp_leaf),
        "--gateway-leaf",
        str(gateway_leaf),
    ]
    for bundle in bundles:
        command.extend(["--bundle", str(bundle)])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise FrontierWindowsError(f"Certificate-chain verification failed: {detail}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    try:
        report = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError) as error:
        raise FrontierWindowsError("Certificate verifier returned invalid output.") from error
    if report.get("valid") is not True:
        raise FrontierWindowsError("Certificate verifier did not report a valid chain.")
    return report


def run_python_patcher(script: Path, archive: Path, build: int, check: bool) -> str:
    if sys.version_info[:2] != (3, 12):
        raise FrontierWindowsError("Python 3.12 exactly is required for code.ccp patching.")
    command = [
        sys.executable,
        "-B",
        str(script),
        "--archive",
        str(archive),
        "--build",
        str(build),
    ]
    if check:
        command.append("--check")
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise FrontierWindowsError(f"{script.name} failed: {detail}")
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise FrontierWindowsError(f"{script.name} returned no patch state.")
    return lines[-1]


def code_patch_states(archive: Path, build: int) -> dict:
    docking = run_python_patcher(DOCKING_PATCHER, archive, build, check=True)
    features = run_python_patcher(FEATURE_PATCHER, archive, build, check=True)
    if docking not in {"source", "patched"}:
        raise FrontierWindowsError(f"Unexpected station-docking state: {docking}")
    if features not in {"source", "patched", "partial"}:
        raise FrontierWindowsError(f"Unexpected Frontier-feature state: {features}")
    return {"docking": docking, "features": features}


def patch_code_archive(archive: Path, build: int) -> dict:
    states = code_patch_states(archive, build)
    if states["features"] == "partial":
        raise FrontierWindowsError("code.ccp contains a partial Frontier feature patch.")
    if states["docking"] == "source":
        run_python_patcher(DOCKING_PATCHER, archive, build, check=False)
    if states["features"] == "source":
        run_python_patcher(FEATURE_PATCHER, archive, build, check=False)
    patched = code_patch_states(archive, build)
    if patched != {"docking": "patched", "features": "patched"}:
        raise FrontierWindowsError(f"code.ccp did not reach the exact patched state: {patched}")
    return patched


def load_stage(stage_root: Path) -> tuple[Path, dict]:
    stage_root = stage_root.resolve()
    marker_path = stage_root / STAGE_MARKER_NAME
    if not marker_path.is_file():
        raise FrontierWindowsError(f"Stage marker is missing: {marker_path}")
    marker = read_json(marker_path)
    if marker.get("format") != STAGE_FORMAT or marker.get("platform") != "windows":
        raise FrontierWindowsError(f"Unrecognized Windows Frontier stage marker: {marker_path}")
    try:
        build = int(marker["build"])
    except (KeyError, TypeError, ValueError) as error:
        raise FrontierWindowsError("Stage marker has no valid numeric build.") from error
    if build <= 0 or stage_root.name != str(build):
        raise FrontierWindowsError("Stage directory is not the marker-owned build-numbered path.")
    marker_stage = Path(str(marker.get("stagePath", "")))
    staging_base = Path(str(marker.get("stagingBase", "")))
    if normalized_path(marker_stage) != normalized_path(stage_root):
        raise FrontierWindowsError("Stage marker path does not match its directory.")
    if normalized_path(stage_root.parent) != normalized_path(staging_base):
        raise FrontierWindowsError("Stage is not directly contained in its recorded staging base.")
    if not is_within(stage_root, staging_base):
        raise FrontierWindowsError("Stage path escapes its recorded staging base.")
    source_root = Path(str(marker.get("sourceRoot", "")))
    if not source_root.is_dir() or is_within(source_root, staging_base):
        raise FrontierWindowsError("Stage marker sourceRoot is invalid or points into staging.")
    native_name = str(marker.get("nativeBlue", ""))
    if native_name.lower() not in {"blue.dll", "blue.pyd"}:
        raise FrontierWindowsError("Stage marker nativeBlue name is invalid.")
    return marker_path, marker


def stage_paths(stage_root: Path, marker: dict) -> dict[str, Path]:
    return {
        "blue": stage_root / "bin64" / str(marker["nativeBlue"]),
        "code": stage_root / "code.ccp",
        "manifest": stage_root / "manifest.dat",
        "bundleMain": stage_root / "bin64/cacert.pem",
        "bundleCertifi": stage_root / "bin64/packages/certifi/cacert.pem",
        "exefile": stage_root / "bin64/exefile.exe",
        "startIni": stage_root / "start.ini",
        "commonIni": stage_root / "common.ini",
        "resIndex": stage_root / "resfileindex.txt",
        "marker": stage_root / STAGE_MARKER_NAME,
        "resFiles": stage_root / "ResFiles",
    }


def verify_placebo(common_ini: Path) -> None:
    if not common_ini.is_file():
        raise FrontierWindowsError(f"Placebo boot overlay is missing: {common_ini}")
    text = common_ini.read_text(encoding="utf-8", errors="replace")
    values = re.findall(r"(?im)^\s*cryptoPack\s*=\s*([^;\r\n]+?)\s*$", text)
    if len(values) != 1 or values[0].strip().lower() != "placebo":
        raise FrontierWindowsError("Stage common.ini must set cryptoPack=Placebo exactly once.")


def is_reparse_point(path: Path) -> bool:
    stat_result = os.lstat(path)
    attributes = getattr(stat_result, "st_file_attributes", 0)
    reparse_flag = getattr(stat_result, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return stat.S_ISLNK(stat_result.st_mode) or bool(attributes & reparse_flag)


def assert_no_reparse_ancestors(root: Path, path: Path, *, allow_leaf: bool = False) -> None:
    root = Path(os.path.abspath(root))
    path = Path(os.path.abspath(path))
    if not is_within(path, root):
        raise FrontierWindowsError(f"Protected path is outside the stage: {path}")
    try:
        relative = path.relative_to(root)
    except ValueError as error:
        raise FrontierWindowsError(f"Protected path is outside the stage: {path}") from error
    current = root
    components = (Path(), *relative.parts)
    for index, component in enumerate(components):
        if index > 0:
            current = current / component
        is_leaf = normalized_path(current) == normalized_path(path)
        try:
            reparse = is_reparse_point(current)
        except FileNotFoundError as error:
            raise FrontierWindowsError(f"Protected stage path is missing: {current}") from error
        if reparse and not (allow_leaf and is_leaf):
            raise FrontierWindowsError(
                f"Protected stage path traverses an unexpected reparse point: {current}"
            )


def assert_protected_stage_paths(stage_root: Path, paths: dict[str, Path]) -> None:
    for key in (
        "blue",
        "code",
        "manifest",
        "bundleMain",
        "bundleCertifi",
        "exefile",
        "startIni",
        "commonIni",
        "resIndex",
        "marker",
    ):
        assert_no_reparse_ancestors(stage_root, paths[key])
    assert_no_reparse_ancestors(stage_root, paths["resFiles"], allow_leaf=True)


def discover_official_resfiles(source_root: Path) -> Path:
    """Mirror client discovery's nearest-ancestor ResFiles lookup without marker hints."""
    current = Path(os.path.abspath(source_root))
    for _ in range(9):
        candidate = current / "ResFiles"
        if candidate.is_dir():
            return candidate.resolve(strict=True)
        parent = current.parent
        if parent == current:
            break
        current = parent
    raise FrontierWindowsError(
        f"Could not independently resolve the official shared ResFiles tree for {source_root}"
    )


def assert_no_reparse_tree(root: Path) -> None:
    """Fail closed if a copy-mode resource tree contains any reparse point."""
    if is_reparse_point(root):
        raise FrontierWindowsError(f"Resource copy root is a reparse point: {root}")

    def raise_walk_error(error: OSError) -> None:
        raise error

    try:
        for directory, directories, filenames in os.walk(
            root, topdown=True, followlinks=False, onerror=raise_walk_error
        ):
            parent = Path(directory)
            for name in (*directories, *filenames):
                candidate = parent / name
                if is_reparse_point(candidate):
                    raise FrontierWindowsError(
                        f"Copy-mode ResFiles contains a reparse point: {candidate}"
                    )
    except OSError as error:
        raise FrontierWindowsError(
            f"Could not enumerate copy-mode ResFiles safely: {error}"
        ) from error


def verify_resource_index(index_path: Path, resfiles_root: Path) -> dict:
    """Require every resource-index cache object to exist at its exact unpacked size."""
    try:
        lines = index_path.read_text(encoding="utf-8", errors="strict").splitlines()
    except (OSError, UnicodeError) as error:
        raise FrontierWindowsError(f"Could not read Frontier resource index: {error}") from error
    logical_paths: set[str] = set()
    cache_paths: set[str] = set()
    total_bytes = 0
    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line:
            continue
        fields = line.split(",")
        if len(fields) != 5:
            raise FrontierWindowsError(
                f"Malformed resource index line {line_number}: expected 5 fields."
            )
        logical_path, cache_path, source_hash, unpacked_text, packed_text = fields
        if not logical_path.startswith("res:/") or logical_path in logical_paths:
            raise FrontierWindowsError(
                f"Malformed or duplicate resource index path at line {line_number}."
            )
        if not re.fullmatch(r"[0-9a-fA-F]{2}/[0-9a-fA-F_]+", cache_path):
            raise FrontierWindowsError(
                f"Malformed resource cache path at line {line_number}: {cache_path!r}"
            )
        if not re.fullmatch(r"[0-9a-fA-F]{32}", source_hash):
            raise FrontierWindowsError(
                f"Malformed resource hash at line {line_number}: {source_hash!r}"
            )
        try:
            unpacked_size = int(unpacked_text, 10)
            packed_size = int(packed_text, 10)
        except ValueError as error:
            raise FrontierWindowsError(
                f"Malformed resource size at line {line_number}."
            ) from error
        if unpacked_size < 0 or packed_size < 0:
            raise FrontierWindowsError(
                f"Negative resource size at line {line_number}."
            )
        physical_path = safe_relative_path(resfiles_root, cache_path)
        if not physical_path.is_file() or is_reparse_point(physical_path):
            raise FrontierWindowsError(
                f"Indexed Frontier resource is missing or redirected: "
                f"{logical_path} -> {physical_path}"
            )
        actual_size = physical_path.stat().st_size
        if actual_size != unpacked_size:
            raise FrontierWindowsError(
                f"Indexed Frontier resource size mismatch: {logical_path} "
                f"(expected {unpacked_size}, found {actual_size})"
            )
        logical_paths.add(logical_path)
        cache_paths.add(cache_path.casefold())
        total_bytes += actual_size
    if not logical_paths:
        raise FrontierWindowsError("Frontier resource index is empty.")
    return {
        "entries": len(logical_paths),
        "uniqueCacheFiles": len(cache_paths),
        "indexedBytes": total_bytes,
    }


def verify_resfiles(stage_root: Path, marker: dict, paths: dict[str, Path]) -> dict:
    details = marker.get("resFiles")
    if not isinstance(details, dict):
        raise FrontierWindowsError("Stage marker has no ResFiles metadata.")
    mode = details.get("mode")
    resfiles_path = paths["resFiles"]
    if not resfiles_path.is_dir():
        raise FrontierWindowsError(f"Staged ResFiles is missing: {resfiles_path}")
    if normalized_path(Path(str(details.get("path", "")))) != normalized_path(resfiles_path):
        raise FrontierWindowsError("ResFiles marker path does not match the stage.")
    source_root = Path(str(marker.get("sourceRoot", "")))
    source_index = source_root / "resfileindex.txt"
    if not source_index.is_file():
        raise FrontierWindowsError("Official client resource index is missing.")
    if not paths["resIndex"].is_file() or is_reparse_point(paths["resIndex"]):
        raise FrontierWindowsError("Staged resource index is missing or redirected.")
    if sha256_file(source_index) != sha256_file(paths["resIndex"]):
        raise FrontierWindowsError("Staged resource index differs from the official client.")
    official_target = discover_official_resfiles(source_root)
    if mode == "junction":
        target = Path(str(details.get("target", "")))
        if not target.is_dir() or not is_reparse_point(resfiles_path):
            raise FrontierWindowsError("Staged ResFiles junction or its target is invalid.")
        try:
            marker_is_official = os.path.samefile(target, official_target)
            same = os.path.samefile(resfiles_path, official_target)
        except OSError:
            marker_is_official = False
            same = False
        if not marker_is_official:
            raise FrontierWindowsError(
                "ResFiles marker target is not the independently discovered official cache."
            )
        if not same:
            raise FrontierWindowsError(
                "Staged ResFiles junction does not resolve to the official cache."
            )
        index_report = verify_resource_index(paths["resIndex"], resfiles_path)
        return {
            "mode": mode,
            "target": str(official_target),
            "resourceIndexSha256": sha256_file(paths["resIndex"]),
            **index_report,
        }
    if mode == "copy":
        source_target = Path(str(details.get("sourceTarget", "")))
        if not source_target.is_dir():
            raise FrontierWindowsError("Copy-mode ResFiles source target is invalid.")
        try:
            source_is_official = os.path.samefile(source_target, official_target)
        except OSError:
            source_is_official = False
        if not source_is_official:
            raise FrontierWindowsError(
                "Copy-mode ResFiles source is not the independently discovered official cache."
            )
        assert_no_reparse_tree(resfiles_path)
        index_report = verify_resource_index(paths["resIndex"], resfiles_path)
        return {
            "mode": mode,
            "sourceTarget": str(official_target),
            "target": str(resfiles_path),
            "resourceIndexSha256": sha256_file(paths["resIndex"]),
            **index_report,
        }
    raise FrontierWindowsError(f"Unsupported ResFiles stage mode: {mode!r}")


def verify_start_ini(path: Path, build: int) -> None:
    text = path.read_text(encoding="utf-8", errors="replace")
    build_match = re.search(r"(?im)^\s*build\s*=\s*(\d+)\s*$", text)
    app_match = re.search(r"(?im)^\s*appname\s*=\s*([^\r\n]+?)\s*$", text)
    if not build_match or int(build_match.group(1)) != build:
        raise FrontierWindowsError("Stage start.ini build does not match the marker.")
    if not app_match or app_match.group(1).strip().upper() != "FRONTIER":
        raise FrontierWindowsError("Stage start.ini is not an EVE Frontier client.")


def retail_hashes(marker: dict) -> dict[str, str]:
    values = marker.get("retailHashesBefore")
    if not isinstance(values, dict) or not values:
        raise FrontierWindowsError("Stage marker has no retail before-hash evidence.")
    normalized = {}
    for relative, digest in values.items():
        if not re.fullmatch(r"[0-9a-fA-F]{64}", str(digest)):
            raise FrontierWindowsError(f"Invalid retail hash for {relative!r}.")
        normalized[str(relative)] = str(digest).lower()
    native_blue = str(marker.get("nativeBlue", ""))
    if native_blue.lower() not in {"blue.dll", "blue.pyd"}:
        raise FrontierWindowsError("Stage marker has no valid native-blue name.")
    required = {
        f"bin64/{native_blue}",
        "code.ccp",
        "manifest.dat",
        "bin64/cacert.pem",
        "bin64/packages/certifi/cacert.pem",
        "bin64/exefile.exe",
        "start.ini",
    }
    missing = sorted(required.difference(normalized))
    if missing:
        raise FrontierWindowsError(
            "Stage marker omits required official-client hashes: " + ", ".join(missing)
        )
    return normalized


def verify_unpatched_stage_sources(
    stage_root: Path, marker: dict, paths: dict[str, Path], profile: dict
) -> None:
    if marker.get("patchState") != "unpatched":
        raise FrontierWindowsError("Incomplete stage has an unsupported patchState marker.")
    before = retail_hashes(marker)
    original = marker.get("originalHashes")
    if not isinstance(original, dict):
        raise FrontierWindowsError("Stage marker has no original staged-file hashes.")
    for relative, expected in before.items():
        if str(original.get(relative, "")).lower() != expected:
            raise FrontierWindowsError(f"Stage original hash metadata mismatch: {relative}")
        staged_path = safe_relative_path(stage_root, relative)
        assert_no_reparse_ancestors(stage_root, staged_path)
        if not staged_path.is_file() or sha256_file(staged_path) != expected:
            raise FrontierWindowsError(f"Unpatched staged source hash mismatch: {relative}")
    if inspect_blue(paths["blue"], profile) != "source":
        raise FrontierWindowsError("Unpatched stage native blue is not the exact source.")
    source_code_states = code_patch_states(paths["code"], int(marker["build"]))
    if source_code_states != {"docking": "source", "features": "source"}:
        raise FrontierWindowsError(
            f"Unpatched stage code.ccp is not the exact source: {source_code_states}"
        )
    if not manifest_hashes_match(paths["manifest"], stage_root, profile):
        raise FrontierWindowsError("Unpatched staged manifest digests do not match source files.")


def verify_retail_unchanged(marker: dict) -> dict[str, str]:
    source_root = Path(str(marker["sourceRoot"]))
    before = retail_hashes(marker)
    after = {}
    failures = []
    for relative, expected in before.items():
        path = safe_relative_path(source_root, relative)
        if not path.is_file():
            failures.append(f"missing:{relative}")
            continue
        actual = sha256_file(path)
        after[relative] = actual
        if actual != expected:
            failures.append(f"changed:{relative}")
    if failures:
        raise FrontierWindowsError(
            "Official Frontier client hash preservation failed: " + ", ".join(failures)
        )
    return after


def checked_backup_base(stage_root: Path, *, require_exists: bool) -> Path:
    """Return the physical backup base after rejecting every redirected ancestor."""
    stage_root = Path(os.path.abspath(stage_root))
    if not os.path.lexists(stage_root):
        raise FrontierWindowsError(f"Stage root is missing: {stage_root}")
    assert_no_reparse_ancestors(stage_root, stage_root)
    if not stage_root.is_dir():
        raise FrontierWindowsError(f"Stage root is not a directory: {stage_root}")

    backup_base = stage_root / ".evejs-backups"
    if not os.path.lexists(backup_base):
        if require_exists:
            raise FrontierWindowsError(f"Stage backup base is missing: {backup_base}")
        return backup_base
    assert_no_reparse_ancestors(stage_root, backup_base)
    if not backup_base.is_dir():
        raise FrontierWindowsError(f"Stage backup base is not a directory: {backup_base}")
    return backup_base


def checked_backup_root(stage_root: Path, backup_root: Path) -> tuple[Path, Path]:
    """Validate an existing, direct child backup root without following reparses first."""
    stage_root = Path(os.path.abspath(stage_root))
    backup_base = checked_backup_base(stage_root, require_exists=True)
    backup_root = Path(os.path.abspath(backup_root))
    if normalized_path(backup_root.parent) != normalized_path(backup_base):
        raise FrontierWindowsError(
            f"Stage patch backup is not directly contained in .evejs-backups: {backup_root}"
        )
    if not os.path.lexists(backup_root):
        raise FrontierWindowsError(f"Stage patch backup is missing: {backup_root}")
    assert_no_reparse_ancestors(stage_root, backup_root)
    if not backup_root.is_dir():
        raise FrontierWindowsError(f"Stage patch backup is not a directory: {backup_root}")
    return backup_base, backup_root


def checked_backup_files(
    stage_root: Path, backup_root: Path, backup_files: list[Path]
) -> list[Path]:
    """Validate all backup files and ancestors before any file content is read."""
    stage_root = Path(os.path.abspath(stage_root))
    _, backup_root = checked_backup_root(stage_root, backup_root)
    checked = []
    for backup_file in backup_files:
        backup_file = Path(os.path.abspath(backup_file))
        if not is_within(backup_file, backup_root) or normalized_path(
            backup_file
        ) == normalized_path(backup_root):
            raise FrontierWindowsError(
                f"Backup file is outside its transaction root: {backup_file}"
            )
        if not os.path.lexists(backup_file):
            raise FrontierWindowsError(f"Backup file is missing: {backup_file}")
        assert_no_reparse_ancestors(stage_root, backup_file)
        if not backup_file.is_file():
            raise FrontierWindowsError(f"Backup path is not a file: {backup_file}")
        checked.append(backup_file)
    return checked


def backup_transaction_files(stage_root: Path, paths: list[Path]) -> tuple[Path, dict[str, str]]:
    stage_root = Path(os.path.abspath(stage_root))
    inputs = []
    for path in paths:
        path = Path(os.path.abspath(path))
        if not is_within(path, stage_root):
            raise FrontierWindowsError(f"Transaction input is outside the stage: {path}")
        assert_no_reparse_ancestors(stage_root, path)
        if not path.is_file():
            raise FrontierWindowsError(f"Transaction input is missing: {path}")
        inputs.append((path, path.relative_to(stage_root)))

    backup_base = checked_backup_base(stage_root, require_exists=False)
    if not os.path.lexists(backup_base):
        backup_base.mkdir()
    backup_base = checked_backup_base(stage_root, require_exists=True)
    timestamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_root = backup_base / f"frontier-client-{timestamp}"
    suffix = 1
    while os.path.lexists(backup_root):
        assert_no_reparse_ancestors(stage_root, backup_root)
        if not backup_root.is_dir():
            raise FrontierWindowsError(
                f"Unexpected non-directory backup transaction path: {backup_root}"
            )
        backup_root = backup_base / f"frontier-client-{timestamp}-{suffix}"
        suffix += 1
    backup_root.mkdir(parents=True)
    _, backup_root = checked_backup_root(stage_root, backup_root)

    destinations = []
    for path, relative in inputs:
        destination = backup_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        assert_no_reparse_ancestors(stage_root, destination.parent)
        if os.path.lexists(destination):
            raise FrontierWindowsError(f"Backup destination already exists: {destination}")
        destinations.append((path, relative, destination))

    # Hash every validated source before the first backup-file content write.
    hashes = {
        relative.as_posix(): sha256_file(path) for path, relative, _ in destinations
    }
    for path, relative, destination in destinations:
        shutil.copy2(path, destination)
        assert_no_reparse_ancestors(stage_root, destination)
        if sha256_file(destination) != hashes[relative.as_posix()]:
            raise FrontierWindowsError(f"Backup verification failed: {destination}")
    return backup_root, hashes


def restore_transaction_files(
    stage_root: Path,
    backup_root: Path,
    paths: list[Path],
    expected_hashes: dict[str, str],
) -> None:
    stage_root = Path(os.path.abspath(stage_root))
    backup_root = Path(os.path.abspath(backup_root))
    restore_plan = []
    backup_files = []
    for path in paths:
        path = Path(os.path.abspath(path))
        if not is_within(path, stage_root):
            raise FrontierWindowsError(f"Rollback destination is outside the stage: {path}")
        assert_no_reparse_ancestors(stage_root, path)
        relative = path.relative_to(stage_root)
        expected = str(expected_hashes.get(relative.as_posix(), "")).lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise FrontierWindowsError(f"Rollback hash evidence is invalid: {relative.as_posix()}")
        source = backup_root / relative
        restore_plan.append((path, relative, source, expected))
        backup_files.append(source)

    checked_backup_files(stage_root, backup_root, backup_files)
    for _, relative, source, expected in restore_plan:
        if sha256_file(source) != expected:
            raise FrontierWindowsError(f"Backup hash mismatch before rollback: {relative.as_posix()}")

    failures = []
    for path, relative, source, expected in restore_plan:
        try:
            copy_file_atomic(source, path)
            if sha256_file(path) != expected:
                raise FrontierWindowsError(f"Restored hash mismatch: {path}")
        except Exception as error:  # Preserve every rollback failure for the caller.
            failures.append(str(error))
    if failures:
        raise FrontierWindowsError("Rollback verification failed: " + "; ".join(failures))


def verify_backup(stage_root: Path, marker: dict, transaction_paths: list[Path]) -> dict:
    raw_backup = marker.get("clientPatchBackup")
    hashes = marker.get("prePatchHashes")
    if not raw_backup or not isinstance(hashes, dict):
        raise FrontierWindowsError("Stage marker has no verified patch backup evidence.")
    stage_root = Path(os.path.abspath(stage_root))
    backup_root = Path(str(raw_backup))
    if not backup_root.is_absolute():
        raise FrontierWindowsError("Stage patch backup path is not absolute.")
    backup_root = Path(os.path.abspath(backup_root))
    backup_plan = []
    for path in transaction_paths:
        path = Path(os.path.abspath(path))
        if not is_within(path, stage_root):
            raise FrontierWindowsError(f"Transaction path is outside the stage: {path}")
        relative = path.relative_to(stage_root).as_posix()
        backup_path = backup_root / Path(relative)
        expected = str(hashes.get(relative, "")).lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise FrontierWindowsError(f"Stage patch backup is incomplete: {relative}")
        backup_plan.append((relative, backup_path, expected))

    checked_backup_files(
        stage_root, backup_root, [backup_path for _, backup_path, _ in backup_plan]
    )
    checked = {}
    for relative, backup_path, expected in backup_plan:
        actual = sha256_file(backup_path)
        if actual != expected:
            raise FrontierWindowsError(f"Stage patch backup hash mismatch: {relative}")
        checked[relative] = actual
    return checked


def transaction_paths(paths: dict[str, Path]) -> list[Path]:
    return [
        paths["blue"],
        paths["code"],
        paths["bundleMain"],
        paths["bundleCertifi"],
        paths["manifest"],
        paths["marker"],
    ]


def check_stage(
    stage_root: Path,
    profile_path: Path | None = None,
    node_path: Path | None = None,
    ca_path: Path = DEFAULT_CA,
    xmpp_leaf: Path = DEFAULT_XMPP_LEAF,
    gateway_leaf: Path = DEFAULT_GATEWAY_LEAF,
) -> dict:
    stage_root = stage_root.resolve()
    marker_path, marker = load_stage(stage_root)
    build = int(marker["build"])
    paths = stage_paths(stage_root, marker)
    assert_protected_stage_paths(stage_root, paths)
    for key in ("blue", "code", "manifest", "bundleMain", "bundleCertifi", "exefile", "startIni"):
        if not paths[key].is_file():
            raise FrontierWindowsError(f"Staged required file is missing: {paths[key]}")
        if is_reparse_point(paths[key]):
            raise FrontierWindowsError(f"Staged protected file is an unexpected reparse point: {paths[key]}")
    resolved_profile_path, profile = resolve_profile(
        build, str(marker["nativeBlue"]), profile_path
    )
    blue_state = inspect_blue(paths["blue"], profile)
    if blue_state != "target":
        raise FrontierWindowsError(f"Native blue patch state is {blue_state}, not target.")
    code_states = code_patch_states(paths["code"], build)
    if code_states != {"docking": "patched", "features": "patched"}:
        raise FrontierWindowsError(f"code.ccp patch state is not fully enabled: {code_states}")
    verify_placebo(paths["commonIni"])
    verify_start_ini(paths["startIni"], build)
    resfiles = verify_resfiles(stage_root, marker, paths)
    if not manifest_hashes_match(paths["manifest"], stage_root, profile):
        raise FrontierWindowsError("Staged manifest target digests are stale.")
    parsed_manifest = parse_manifest(paths["manifest"].read_bytes())
    ca_pem, ca_der, ca_fingerprint = read_ca(ca_path)
    del ca_pem
    for bundle in (paths["bundleMain"], paths["bundleCertifi"]):
        count = ca_count_in_bundle(bundle, ca_der)
        if count != 1:
            raise FrontierWindowsError(f"EveJS CA count in {bundle} is {count}, not one.")
    certificate_report = verify_certificate_chain(
        resolve_node(node_path),
        ca_path,
        xmpp_leaf,
        gateway_leaf,
        [paths["bundleMain"], paths["bundleCertifi"]],
    )
    if certificate_report.get("caFingerprintSha256") != ca_fingerprint:
        raise FrontierWindowsError("Certificate verifier CA fingerprint disagrees with the PEM file.")
    retail_after = verify_retail_unchanged(marker)
    if marker.get("patchState") != "complete":
        raise FrontierWindowsError("Stage marker does not record a complete patch transaction.")
    if int(marker.get("nativeBluePatchBuild", 0)) != build:
        raise FrontierWindowsError("Stage marker native-blue patch build is wrong.")
    if Path(str(marker.get("nativeBluePatchProfile", ""))).name != resolved_profile_path.name:
        raise FrontierWindowsError("Stage marker native-blue patch profile is wrong.")
    if str(marker.get("caFingerprintSha256", "")).lower() != ca_fingerprint:
        raise FrontierWindowsError("Stage marker CA fingerprint is wrong.")
    trailer_hash = sha256_bytes(parsed_manifest["trailer"])
    if str(marker.get("manifestTrailerSha256", "")).lower() != trailer_hash:
        raise FrontierWindowsError("Stage marker manifest trailer hash is wrong.")
    file_hashes = marker.get("currentHashes")
    if not isinstance(file_hashes, dict):
        raise FrontierWindowsError("Stage marker has no current file hashes.")
    for path in transaction_paths(paths)[:-1]:
        relative = path.relative_to(stage_root).as_posix()
        if str(file_hashes.get(relative, "")).lower() != sha256_file(path):
            raise FrontierWindowsError(f"Stage marker current hash mismatch: {relative}")
    backup_hashes = verify_backup(stage_root, marker, transaction_paths(paths))
    retail_exefile = retail_hashes(marker).get("bin64/exefile.exe")
    if retail_exefile and sha256_file(paths["exefile"]) != retail_exefile:
        raise FrontierWindowsError("Staged exefile.exe differs from the signed retail executable.")
    return {
        "backup": str(marker["clientPatchBackup"]),
        "backupFiles": len(backup_hashes),
        "blueSha256": sha256_file(paths["blue"]),
        "blueState": blue_state,
        "build": build,
        "caFingerprintSha256": ca_fingerprint,
        "certificateChainsValid": True,
        "codeCcpSha256": sha256_file(paths["code"]),
        "codeStates": code_states,
        "exefileSha256": sha256_file(paths["exefile"]),
        "manifestSha256": sha256_file(paths["manifest"]),
        "manifestTrailerSha256": trailer_hash,
        "nativeBlue": str(marker["nativeBlue"]),
        "profile": str(resolved_profile_path),
        "resFiles": resfiles,
        "retailHashes": retail_after,
        "stage": str(stage_root),
        "valid": True,
    }


def patch_stage(
    stage_root: Path,
    profile_path: Path | None = None,
    node_path: Path | None = None,
    ca_path: Path = DEFAULT_CA,
    xmpp_leaf: Path = DEFAULT_XMPP_LEAF,
    gateway_leaf: Path = DEFAULT_GATEWAY_LEAF,
) -> dict:
    stage_root = stage_root.resolve()
    marker_path, marker = load_stage(stage_root)
    if marker.get("patchState") == "complete":
        return check_stage(
            stage_root,
            profile_path=profile_path,
            node_path=node_path,
            ca_path=ca_path,
            xmpp_leaf=xmpp_leaf,
            gateway_leaf=gateway_leaf,
        )
    build = int(marker["build"])
    paths = stage_paths(stage_root, marker)
    assert_protected_stage_paths(stage_root, paths)
    resolved_profile_path, profile = resolve_profile(
        build, str(marker["nativeBlue"]), profile_path
    )
    verify_retail_unchanged(marker)
    verify_placebo(paths["commonIni"])
    verify_start_ini(paths["startIni"], build)
    verify_resfiles(stage_root, marker, paths)
    verify_unpatched_stage_sources(stage_root, marker, paths, profile)
    touched = transaction_paths(paths)
    backup_root, prepatch_hashes = backup_transaction_files(stage_root, touched)
    try:
        patch_blue_atomic(paths["blue"], profile)
        code_states = patch_code_archive(paths["code"], build)
        ca_pem, ca_der, ca_fingerprint = read_ca(ca_path)
        append_ca_atomic(paths["bundleMain"], ca_pem, ca_der)
        append_ca_atomic(paths["bundleCertifi"], ca_pem, ca_der)
        manifest_report = refresh_manifest_atomic(paths["manifest"], stage_root, profile)
        certificate_report = verify_certificate_chain(
            resolve_node(node_path),
            ca_path,
            xmpp_leaf,
            gateway_leaf,
            [paths["bundleMain"], paths["bundleCertifi"]],
        )
        retail_after = verify_retail_unchanged(marker)
        current_hashes = {
            path.relative_to(stage_root).as_posix(): sha256_file(path)
            for path in [
                *touched[:-1],
                paths["exefile"],
                paths["startIni"],
                paths["commonIni"],
            ]
        }
        marker.update(
            {
                "caFingerprintSha256": ca_fingerprint,
                "certificateChains": certificate_report,
                "clientPatchBackup": str(backup_root),
                "codeCcpPatchBuild": build,
                "currentHashes": current_hashes,
                "frontierFeaturePatchState": code_states["features"],
                "fileStates": {
                    "nativeBlue": "exact-target",
                    "codeCcp": "exact-patched",
                    "manifest": "target-digests-refreshed",
                    "caBundles": "evejs-ca-appended-once",
                    "exefile": "authenticode-retail",
                },
                "manifestHashesRefreshed": True,
                "manifestTargets": list(profile["manifestTargets"]),
                "manifestTrailerSha256": manifest_report["trailerSha256"],
                "nativeBluePatchBuild": build,
                "nativeBluePatchProfile": str(resolved_profile_path),
                "nativeBluePatchState": "manifest-verifier-patched",
                "patchState": "complete",
                "patchTimestamp": datetime.datetime.now(datetime.timezone.utc)
                .replace(microsecond=0)
                .isoformat(),
                "prePatchHashes": prepatch_hashes,
                "retailHashesAfterPatch": retail_after,
                "stationDockingPatchState": code_states["docking"],
            }
        )
        write_json_atomic(marker_path, marker)
        report = check_stage(
            stage_root,
            profile_path=resolved_profile_path,
            node_path=node_path,
            ca_path=ca_path,
            xmpp_leaf=xmpp_leaf,
            gateway_leaf=gateway_leaf,
        )
        report["manifestChangedEntries"] = manifest_report["changedEntries"]
        return report
    except Exception as error:
        try:
            restore_transaction_files(
                stage_root, backup_root, touched, prepatch_hashes
            )
        except Exception as rollback_error:
            raise FrontierWindowsError(
                f"Patch transaction failed ({error}); rollback also failed "
                f"({rollback_error}). Backup retained at {backup_root}"
            ) from rollback_error
        raise FrontierWindowsError(
            f"Patch transaction failed and was fully rolled back. "
            f"Backup retained at {backup_root}: {error}"
        ) from error


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Strict Windows EVE Frontier stage and native-blue patch verifier."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    for name in ("patch", "check"):
        command = subparsers.add_parser(name)
        command.add_argument("--staged-root", type=Path, required=True)
        command.add_argument("--profile", type=Path)
        command.add_argument("--node", type=Path)
        command.add_argument("--ca", type=Path, default=DEFAULT_CA)
        command.add_argument("--xmpp-leaf", type=Path, default=DEFAULT_XMPP_LEAF)
        command.add_argument("--gateway-leaf", type=Path, default=DEFAULT_GATEWAY_LEAF)
    status = subparsers.add_parser("blue-status")
    status.add_argument("--path", type=Path, required=True)
    status.add_argument("--profile", type=Path, required=True)
    mutate = subparsers.add_parser("blue-patch")
    mutate.add_argument("--path", type=Path, required=True)
    mutate.add_argument("--profile", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command in {"patch", "check"}:
            function = patch_stage if args.command == "patch" else check_stage
            report = function(
                args.staged_root,
                profile_path=args.profile,
                node_path=args.node,
                ca_path=args.ca,
                xmpp_leaf=args.xmpp_leaf,
                gateway_leaf=args.gateway_leaf,
            )
            print(json.dumps(report, sort_keys=True))
            return 0
        profile = read_json(args.profile)
        if profile.get("format") != PE_PROFILE_FORMAT:
            raise FrontierWindowsError("Unrecognized PE patch profile.")
        if args.command == "blue-status":
            report = {
                "path": str(args.path.resolve()),
                "sha256": sha256_file(args.path),
                "state": inspect_blue(args.path, profile),
            }
        else:
            state = patch_blue_atomic(args.path, profile)
            report = {
                "path": str(args.path.resolve()),
                "sha256": sha256_file(args.path),
                "state": state,
            }
        print(json.dumps(report, sort_keys=True))
        return 0
    except FrontierWindowsError as error:
        print(f"[evejs-frontier] {error}", file=sys.stderr)
        return 2
    except Exception as error:
        print(f"[evejs-frontier] Unexpected failure: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
