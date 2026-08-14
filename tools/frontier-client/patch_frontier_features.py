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


DEFAULT_CLIENT_BUILD = 3467658

# These switches are deliberately narrow. Each one corresponds to a server
# surface implemented and regression-tested by EveJS-Frontier. Do not turn the
# rest of frontier.beta into a blanket "everything enabled" patch: most of
# those switches protect client RPCs that the emulator does not yet implement.
MODULE_PATCHES = {
    "frontier/beta.pyc": (
        "FRONTIER_BETA_HIDE_SKILLS",
        "FRONTIER_BETA_HIDE_MAPVIEW_MARKERS",
        "FRONTIER_BETA_DISABLE_SAFE_LOGOFF",
        "FRONTIER_BETA_HIDE_HUD_SYSTEM_INFO_PANEL",
        "FRONTIER_BETA_HIDE_HUD_ROUTE_PANEL",
        "FRONTIER_BETA_HIDE_HUD_SEARCH_PANEL",
    ),
    "frontier/shell/common/const.pyc": (
        "HIDE_SHELL_IMPLANT_SYSTEM",
        "HIDE_SHELL_REIGNMENT_SYSTEM",
    ),
}

BUILD_PROFILES = {
    3467658: {
        "frontier/beta.pyc": {
            "source_member_sha256": "45e3d2487c0a37382c0dec8bdd9792a8c21b2685b24ab4bc1408ce354358eb8d",
            "source_code_sha256": "407cc5255d786655c80aae942db7e73e29bcf00cce34b601236eb71b652eb89b",
            "patched_member_sha256": "ada85572bc7e63d1a7a855cb61f3ae3403ed5727ad29b1c08e543c5d22be1557",
            "patched_code_sha256": "78e6d5f09ef3145b15fad1e195bd76754aa97478b9f9a361332ec68c8d92ab1f",
        },
        "frontier/shell/common/const.pyc": {
            "source_member_sha256": "6bf15cc8a8aa138de48f0f49e4449eb3550791a0802a94e88f6d788f1abd84c6",
            "source_code_sha256": "a340924d86ae5ecc207e823ed1ee7db1cd4f8454c493ffa047b0fe90739cf9ae",
            "patched_member_sha256": "d1d72aae7b651969a29a6f70d8d9c4cc3c4a0d3399ee04a1f1f060008036c559",
            "patched_code_sha256": "d117e6d617d5dc83af9bc413cf9f3c1ed65123a0464f0b028d573138a0168b13",
        },
    },
}


class FeaturePatchError(RuntimeError):
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
        raise FeaturePatchError(
            "Frontier feature patch requires Python 3.12 to preserve client bytecode."
        )


def resolve_build_profile(client_build):
    profile = BUILD_PROFILES.get(client_build)
    if profile is None:
        raise FeaturePatchError(
            f"No exact Frontier feature patch profile is available for build {client_build}."
        )
    return profile


def load_modules(archive_path):
    modules = {}
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            for module_name in MODULE_PATCHES:
                matches = [
                    entry for entry in archive.infolist()
                    if entry.filename == module_name
                ]
                if len(matches) != 1:
                    raise FeaturePatchError(
                        f"Expected one {module_name} entry, found {len(matches)}."
                    )
                member = archive.read(matches[0])
                if len(member) < 16 or member[:4] != importlib.util.MAGIC_NUMBER:
                    raise FeaturePatchError(
                        f"Unexpected Python bytecode header in {module_name}."
                    )
                try:
                    code = marshal.loads(member[16:])
                except (EOFError, TypeError, ValueError) as error:
                    raise FeaturePatchError(
                        f"Could not decode {module_name}: {error}"
                    ) from error
                modules[module_name] = (member, code)
    except (OSError, KeyError, zipfile.BadZipFile) as error:
        raise FeaturePatchError(
            f"Could not read Frontier feature modules from {archive_path}: {error}"
        ) from error
    return modules


def find_assignments(code, names):
    instructions = list(dis.get_instructions(code))
    assignments = {}
    for index, instruction in enumerate(instructions):
        if instruction.opname != "STORE_NAME" or instruction.argval not in names:
            continue
        if instruction.argval in assignments or index == 0:
            raise FeaturePatchError(
                f"Could not identify a unique assignment for {instruction.argval}."
            )
        load_instruction = instructions[index - 1]
        if load_instruction.opname != "LOAD_CONST" or not isinstance(
            load_instruction.argval, bool
        ):
            raise FeaturePatchError(
                f"{instruction.argval} is not assigned from a boolean constant."
            )
        assignments[instruction.argval] = load_instruction
    missing = sorted(set(names).difference(assignments))
    if missing:
        raise FeaturePatchError(
            f"Missing Frontier feature assignments: {', '.join(missing)}."
        )
    return assignments


def inspect_module_state(module_name, member, code, profile):
    assignments = find_assignments(code, MODULE_PATCHES[module_name])
    values = {instruction.argval for instruction in assignments.values()}
    member_digest = sha256_bytes(member)
    code_digest = code_sha256(code)
    if (
        values == {True}
        and member_digest == profile["source_member_sha256"]
        and code_digest == profile["source_code_sha256"]
    ):
        return "source"
    if (
        values == {False}
        and member_digest == profile["patched_member_sha256"]
        and code_digest == profile["patched_code_sha256"]
    ):
        return "patched"
    raise FeaturePatchError(
        f"{module_name} is not the supported source or patched module "
        f"(values={sorted(values)!r}, member_sha256={member_digest}, "
        f"code_sha256={code_digest})."
    )


def inspect_states(modules, build_profile):
    states = {
        module_name: inspect_module_state(
            module_name,
            member,
            code,
            build_profile[module_name],
        )
        for module_name, (member, code) in modules.items()
    }
    unique_states = set(states.values())
    if unique_states == {"source"}:
        return "source", states
    if unique_states == {"patched"}:
        return "patched", states
    return "partial", states


def build_patched_member(module_name, member, code, profile):
    assignments = find_assignments(code, MODULE_PATCHES[module_name])
    if any(instruction.argval is not True for instruction in assignments.values()):
        raise FeaturePatchError(f"{module_name} is not in the source-disabled state.")

    constants = list(code.co_consts)
    false_index = next(
        (index for index, value in enumerate(constants) if value is False),
        None,
    )
    if false_index is None:
        false_index = len(constants)
        constants.append(False)
    if false_index >= 256:
        raise FeaturePatchError(f"{module_name} needs an extended constant operand.")

    bytecode = bytearray(code.co_code)
    for name, instruction in assignments.items():
        if instruction.arg is None or instruction.arg >= 256:
            raise FeaturePatchError(f"Unexpected LOAD_CONST operand for {name}.")
        if (
            bytecode[instruction.offset] != instruction.opcode
            or bytecode[instruction.offset + 1] != instruction.arg
        ):
            raise FeaturePatchError(f"Bytecode changed while patching {name}.")
        bytecode[instruction.offset + 1] = false_index

    patched_code = code.replace(
        co_code=bytes(bytecode),
        co_consts=tuple(constants),
    )
    patched_member = member[:16] + marshal.dumps(patched_code)
    if code_sha256(patched_code) != profile["patched_code_sha256"]:
        raise FeaturePatchError(f"Patched {module_name} code did not match.")
    if sha256_bytes(patched_member) != profile["patched_member_sha256"]:
        raise FeaturePatchError(f"Patched {module_name} member did not match.")
    return patched_member


def rewrite_archive(archive_path, patched_members):
    temporary_path = archive_path.with_name(
        f".{archive_path.name}.features-{os.getpid()}.tmp"
    )
    try:
        found = {module_name: 0 for module_name in patched_members}
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", message="Duplicate name:.*")
            with zipfile.ZipFile(archive_path, "r") as source:
                with zipfile.ZipFile(temporary_path, "w", allowZip64=True) as target:
                    target.comment = source.comment
                    for entry in source.infolist():
                        payload = source.read(entry)
                        if entry.filename in patched_members:
                            payload = patched_members[entry.filename]
                            found[entry.filename] += 1
                        target.writestr(entry, payload)
        invalid = [name for name, count in found.items() if count != 1]
        if invalid:
            raise FeaturePatchError(
                "Could not replace exact Frontier feature members: "
                + ", ".join(invalid)
            )
        shutil.copystat(archive_path, temporary_path)
        with temporary_path.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary_path, archive_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(
        description="Enable tested Frontier UI and gameplay surfaces in staged code.ccp."
    )
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--build", type=int, default=DEFAULT_CLIENT_BUILD)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    require_python_312()
    build_profile = resolve_build_profile(args.build)
    archive_path = args.archive.expanduser().resolve()
    modules = load_modules(archive_path)
    state, states = inspect_states(modules, build_profile)
    if args.check:
        print(state)
        return 0

    patched_members = {}
    for module_name, module_state in states.items():
        if module_state != "source":
            continue
        member, code = modules[module_name]
        patched_members[module_name] = build_patched_member(
            module_name,
            member,
            code,
            build_profile[module_name],
        )
    if patched_members:
        rewrite_archive(archive_path, patched_members)

    patched_state, _patched_states = inspect_states(
        load_modules(archive_path),
        build_profile,
    )
    if patched_state != "patched":
        raise FeaturePatchError("Frontier feature patch verification failed.")
    print("patched")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FeaturePatchError as error:
        print(f"[evejs-frontier] {error}", file=sys.stderr)
        raise SystemExit(1)
