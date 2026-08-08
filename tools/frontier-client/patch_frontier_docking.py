#!/usr/bin/env python3

import argparse
import dis
import hashlib
import importlib.util
import json
import marshal
import os
from pathlib import Path
import shutil
import sys
import types
import warnings
import zipfile


MODULE_NAME = "menucheckers/celestialCheckers.pyc"
DEFAULT_CLIENT_BUILD = 3450341
BUILD_PROFILES = {
    3450341: {
        "source_member_sha256": "cbdd5ede870cc365456144fe1ddade1994f4c01ece2f6e10db40dadd0854e6e2",
        "source_code_sha256": "e19c523167bf7b386b38b2c8fb164ef1c6037b64e996d3229aaff3351f2bdce6",
        "patched_code_sha256": "d8ee0139955f8083422793ecda6b942b487b17d6e7f51496178e03410ce110a7",
    },
    3455996: {
        "source_member_sha256": "514b3bf1861b02cef2f385f2930afe8cd2a9670e95c583f039badc2124ea3c4a",
        "source_code_sha256": "e3c370a25dd8f37665638d280194da4df13745d13eea1fb24fd319638f32b5a0",
        "patched_code_sha256": "68b0b9b70dfbd563f2633c78bd59aa02be55e2a1464d75a56b91df1e9c52deb2",
    },
}


class DockingPatchError(RuntimeError):
    pass


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def normalize_constant(value):
    if isinstance(value, types.CodeType):
        return ["code", code_signature(value)]
    if isinstance(value, tuple):
        return ["tuple", [normalize_constant(item) for item in value]]
    if isinstance(value, frozenset):
        normalized = [normalize_constant(item) for item in value]
        return ["frozenset", sorted(normalized, key=repr)]
    if isinstance(value, bytes):
        return ["bytes", value.hex()]
    if value is Ellipsis:
        return ["ellipsis"]
    return [type(value).__name__, repr(value)]


def code_signature(code):
    return [
        code.co_argcount,
        code.co_posonlyargcount,
        code.co_kwonlyargcount,
        code.co_nlocals,
        code.co_stacksize,
        code.co_flags,
        code.co_code.hex(),
        normalize_constant(code.co_consts),
        list(code.co_names),
        list(code.co_varnames),
        list(code.co_freevars),
        list(code.co_cellvars),
        code.co_filename,
        code.co_name,
        code.co_qualname,
        code.co_firstlineno,
        code.co_linetable.hex(),
        code.co_exceptiontable.hex(),
    ]


def code_sha256(code):
    payload = json.dumps(
        code_signature(code),
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("ascii")
    return sha256_bytes(payload)


def require_python_312():
    if sys.version_info[:2] != (3, 12):
        raise DockingPatchError(
            "Frontier docking patch requires Python 3.12 to preserve client bytecode."
        )


def load_module(archive_path):
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            matches = [entry for entry in archive.infolist() if entry.filename == MODULE_NAME]
            if len(matches) != 1:
                raise DockingPatchError(
                    f"Expected one {MODULE_NAME} entry, found {len(matches)}."
                )
            member = archive.read(matches[0])
    except (OSError, KeyError, zipfile.BadZipFile) as error:
        raise DockingPatchError(
            f"Could not read {MODULE_NAME} from {archive_path}: {error}"
        ) from error

    if len(member) < 16 or member[:4] != importlib.util.MAGIC_NUMBER:
        raise DockingPatchError(f"Unexpected Python bytecode header in {MODULE_NAME}.")
    try:
        code = marshal.loads(member[16:])
    except (EOFError, TypeError, ValueError) as error:
        raise DockingPatchError(f"Could not decode {MODULE_NAME}: {error}") from error
    return member, code


def find_docking_constant(code):
    instructions = list(dis.get_instructions(code))
    matches = [
        index
        for index, instruction in enumerate(instructions)
        if instruction.opname == "STORE_NAME"
        and instruction.argval == "DOCKING_DISABLED"
    ]
    if len(matches) != 1 or matches[0] == 0:
        raise DockingPatchError(
            "Could not identify the unique DOCKING_DISABLED assignment."
        )
    load_instruction = instructions[matches[0] - 1]
    if load_instruction.opname != "LOAD_CONST":
        raise DockingPatchError("DOCKING_DISABLED is not assigned from a constant.")
    return load_instruction


def resolve_build_profile(client_build):
    profile = BUILD_PROFILES.get(client_build)
    if profile is None:
        raise DockingPatchError(
            f"No exact station docking patch profile is available for build {client_build}."
        )
    return profile


def inspect_state(member, code, profile):
    instruction = find_docking_constant(code)
    member_digest = sha256_bytes(member)
    code_digest = code_sha256(code)
    if (
        instruction.argval is True
        and member_digest == profile["source_member_sha256"]
        and code_digest == profile["source_code_sha256"]
    ):
        return "source"
    if instruction.argval is False and code_digest == profile["patched_code_sha256"]:
        return "patched"
    raise DockingPatchError(
        "celestialCheckers.pyc is not the supported source or patched build "
        f"(value={instruction.argval!r}, member_sha256={member_digest}, "
        f"code_sha256={code_digest})."
    )


def build_patched_member(member, code, profile):
    instruction = find_docking_constant(code)
    if instruction.argval is not True:
        raise DockingPatchError("Station docking is not in the source-disabled state.")

    constants = list(code.co_consts)
    constant_index = int(instruction.arg)
    if constants[constant_index] is not True:
        raise DockingPatchError("DOCKING_DISABLED constant index changed unexpectedly.")
    constants[constant_index] = False
    patched_code = code.replace(co_consts=tuple(constants))
    patched_member = member[:16] + marshal.dumps(patched_code)
    if code_sha256(patched_code) != profile["patched_code_sha256"]:
        raise DockingPatchError("Patched celestialCheckers.pyc code did not match.")
    return patched_member


def rewrite_archive(archive_path, patched_member):
    temporary_path = archive_path.with_name(
        f".{archive_path.name}.docking-{os.getpid()}.tmp"
    )
    try:
        found = 0
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="Duplicate name:.*")
            with zipfile.ZipFile(archive_path, "r") as source:
                with zipfile.ZipFile(temporary_path, "w", allowZip64=True) as target:
                    target.comment = source.comment
                    for entry in source.infolist():
                        payload = source.read(entry)
                        if entry.filename == MODULE_NAME:
                            payload = patched_member
                            found += 1
                        target.writestr(entry, payload)
        if found != 1:
            raise DockingPatchError(
                f"Expected one {MODULE_NAME} entry while rebuilding code.ccp."
            )
        shutil.copystat(archive_path, temporary_path)
        with temporary_path.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary_path, archive_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(
        description="Enable station docking in the staged Frontier client."
    )
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--build", type=int, default=DEFAULT_CLIENT_BUILD)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    require_python_312()
    profile = resolve_build_profile(args.build)
    archive_path = args.archive.expanduser().resolve()
    member, code = load_module(archive_path)
    state = inspect_state(member, code, profile)
    if args.check:
        print(state)
        return 0
    if state == "source":
        rewrite_archive(archive_path, build_patched_member(member, code, profile))
    patched_member, patched_code = load_module(archive_path)
    if inspect_state(patched_member, patched_code, profile) != "patched":
        raise DockingPatchError("Station docking patch verification failed.")
    print("patched")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DockingPatchError as error:
        print(f"[evejs-frontier] {error}", file=sys.stderr)
        raise SystemExit(1)
